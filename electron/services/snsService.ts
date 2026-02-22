import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import crypto from 'crypto'
import { chatService } from './chatService'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { WasmService } from './wasmService'
import { Isaac64 } from './isaac64'

export interface SnsLivePhoto {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
}

export interface SnsMedia {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    thumbKey?: string  // 缩略图的解密密钥（可能和原图不同）
    encIdx?: string
    livePhoto?: SnsLivePhoto
}

export interface SnsShareInfo {
    title: string
    description: string
    contentUrl: string
    thumbUrl: string
    thumbKey?: string
    thumbToken?: string
    appName?: string
    type?: number
}

export interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: SnsMedia[]
    shareInfo?: SnsShareInfo
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
    rawXml?: string
}

const fixSnsUrl = (url: string, token?: string, isVideo: boolean = false) => {
    if (!url) return url

    // 解码HTML实体
    let fixedUrl = url.replace(/&amp;/g, '&')

    // HTTP → HTTPS
    fixedUrl = fixedUrl.replace('http://', 'https://')

    // 图片：/150 → /0 获取原图（视频不需要）
    if (!isVideo) {
        fixedUrl = fixedUrl.replace(/\/150($|\?)/, '/0$1')
    }

    // 如果URL中已经包含token，直接返回，不要重复添加
    if (fixedUrl.includes('token=')) {
        return fixedUrl
    }

    // 如果没有token参数，且提供了token，则添加
    if (token && token.trim().length > 0) {
        if (isVideo) {
            // 视频：token必须放在参数最前面
            const urlParts = fixedUrl.split('?')
            const baseUrl = urlParts[0]
            const existingParams = urlParts[1] ? `&${urlParts[1]}` : ''
            return `${baseUrl}?token=${token}&idx=1${existingParams}`
        } else {
            // 图片：token追加到末尾
            const connector = fixedUrl.includes('?') ? '&' : '?'
            return `${fixedUrl}${connector}token=${token}&idx=1`
        }
    }

    return fixedUrl
}

const detectImageMime = (buf: Buffer, fallback: string = 'image/jpeg') => {
    if (!buf || buf.length < 4) return fallback
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'
    if (buf.length >= 6) {
        const sig = buf.subarray(0, 6).toString('ascii')
        if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
    }
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
    if (buf.length > 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'
    if (fallback.includes('video') || fallback.includes('mp4')) return 'video/mp4'
    return fallback
}

export const isVideoUrl = (url: string) => {
    if (!url) return false
    if (url.includes('vweixinthumb')) return false
    return url.includes('snsvideodownload') || url.includes('video') || url.includes('.mp4')
}

// 从XML中提取视频密钥
const extractVideoKey = (xml: string): string | undefined => {
    if (!xml) return undefined
    const match = xml.match(/<enc\s+key="(\d+)"/i)
    return match ? match[1] : undefined
}

// 从XML中提取分享信息
// type=3：链接/公众号文章/音乐等
// type=28：视频号 finderFeed
const extractShareInfo = (xml: string): SnsShareInfo | undefined => {
    if (!xml) return undefined;

    const contentObjMatch = xml.match(/<ContentObject>([\s\S]*?)<\/ContentObject>/i);
    if (!contentObjMatch) return undefined;

    const contentXml = contentObjMatch[1];
    const typeMatch = contentXml.match(/<type>(\d+)<\/type>/i);
    const shareType = typeMatch ? parseInt(typeMatch[1], 10) : undefined;

    const unescapeXml = (str: string) =>
        str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

    // ==================== type=28: 视频号 ====================
    if (shareType === 28) {
        const finderMatch = contentXml.match(/<finderFeed>([\s\S]*?)<\/finderFeed>/i);
        if (!finderMatch) return undefined;
        const finderXml = finderMatch[1];

        const nicknameMatch = finderXml.match(/<nickname>([\s\S]*?)<\/nickname>/i);
        const descMatch = finderXml.match(/<desc>([\s\S]*?)<\/desc>/i);
        const avatarMatch = finderXml.match(/<avatar>([\s\S]*?)<\/avatar>/i);

        // 封面图：从 finderFeed 内部的 mediaList 取 thumbUrl 或 coverUrl
        let thumbUrl = '';
        let videoUrl = '';
        const finderMediaMatch = finderXml.match(/<mediaList>([\s\S]*?)<\/mediaList>/i);
        if (finderMediaMatch) {
            const mediaXml = finderMediaMatch[1];
            const coverUrlMatch = mediaXml.match(/<coverUrl>([\s\S]*?)<\/coverUrl>/i);
            const thumbUrlMatch = mediaXml.match(/<thumbUrl>([\s\S]*?)<\/thumbUrl>/i);
            const urlMatch = mediaXml.match(/<url>([\s\S]*?)<\/url>/i);
            if (coverUrlMatch && coverUrlMatch[1].trim()) {
                thumbUrl = unescapeXml(coverUrlMatch[1]);
            } else if (thumbUrlMatch && thumbUrlMatch[1].trim()) {
                thumbUrl = unescapeXml(thumbUrlMatch[1]);
            }
            if (urlMatch && urlMatch[1].trim()) {
                videoUrl = unescapeXml(urlMatch[1]);
            }
        }

        // 若没有封面图，取视频号头像作为兜底
        if (!thumbUrl && avatarMatch && avatarMatch[1].trim()) {
            thumbUrl = unescapeXml(avatarMatch[1]);
        }

        return {
            title: nicknameMatch ? unescapeXml(nicknameMatch[1]) : '视频号',
            description: descMatch ? unescapeXml(descMatch[1]) : '',
            contentUrl: videoUrl,
            thumbUrl,
            appName: '视频号',
            type: shareType
        };
    }

    // ==================== type=3: 链接/公众号/音乐 ====================
    if (shareType !== 3) return undefined;

    const titleMatch = contentXml.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch) return undefined;

    const descMatch = contentXml.match(/<description>([\s\S]*?)<\/description>/i);
    const urlMatch = contentXml.match(/<contentUrl>([\s\S]*?)<\/contentUrl>/i);

    let thumbUrl = '';
    let thumbKey: string | undefined;
    let thumbToken: string | undefined;

    // 1. 优先 <thumburl>
    const thumbUrlTag = contentXml.match(/<thumburl[^>]*>([\s\S]*?)<\/thumburl>/i);
    if (thumbUrlTag && thumbUrlTag[1].trim()) {
        thumbUrl = unescapeXml(thumbUrlTag[1]);
    } else {
        // 2. <thumb> 节点（ContentObject 内 或 整个 xml 内）
        let thumbMatch = contentXml.match(/<thumb([^>]*)>([\s\S]*?)<\/thumb>/i);
        if (!thumbMatch) {
            thumbMatch = xml.match(/<thumb([^>]*)>([\s\S]*?)<\/thumb>/i);
        }
        if (thumbMatch && thumbMatch[2].trim()) {
            thumbUrl = unescapeXml(thumbMatch[2]);
            const keyM = thumbMatch[1].match(/key="([^"]+)"/i);
            const tokM = thumbMatch[1].match(/token="([^"]+)"/i);
            if (keyM) thumbKey = keyM[1];
            if (tokM) thumbToken = tokM[1];
        } else {
            // 3. cover_pic_image_url
            const coverMatch = xml.match(/<cover_pic_image_url>([\s\S]*?)<\/cover_pic_image_url>/i);
            if (coverMatch && coverMatch[1].trim()) {
                thumbUrl = unescapeXml(coverMatch[1]);
            }
        }
    }

    // appName
    let appName: string | undefined;
    const appInfoMatch = xml.match(/<appInfo>([\s\S]*?)<\/appInfo>/i);
    if (appInfoMatch) {
        const nameMatch = appInfoMatch[1].match(/<appName>([\s\S]*?)<\/appName>/i);
        if (nameMatch) appName = nameMatch[1];
    }

    // 公众号来源名称（无 appName 时使用）
    let sourceName: string | undefined;
    const sourceNickMatch = xml.match(/<sourceNickName>([\s\S]*?)<\/sourceNickName>/i);
    if (sourceNickMatch && sourceNickMatch[1].trim()) {
        sourceName = unescapeXml(sourceNickMatch[1]);
    }

    return {
        title: unescapeXml(titleMatch[1]),
        description: descMatch ? unescapeXml(descMatch[1]) : '',
        contentUrl: urlMatch ? unescapeXml(urlMatch[1]) : '',
        thumbUrl,
        thumbKey,
        thumbToken,
        appName: appName ? unescapeXml(appName) : (sourceName ?? undefined),
        type: shareType
    };
}


class SnsService {
    private configService: ConfigService
    private imageCache = new Map<string, string>()
    private snsDb: Database.Database | null = null

    constructor() {
        this.configService = new ConfigService()
    }

    /**
     * 获取解密后的数据库目录
     */
    private getDecryptedDbDir(): string {
        const cachePath = this.configService.get('cachePath')
        if (cachePath) return cachePath

        // 开发环境使用文档目录
        if (process.env.VITE_DEV_SERVER_URL) {
            const documentsPath = app.getPath('documents')
            return join(documentsPath, 'CipherTalkData')
        }

        // 生产环境
        const exePath = app.getPath('exe')
        const installDir = dirname(exePath)

        // 检查是否安装在 C 盘
        const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')

        if (isOnCDrive) {
            const documentsPath = app.getPath('documents')
            return join(documentsPath, 'CipherTalkData')
        }

        return join(installDir, 'CipherTalkData')
    }

    /**
     * 清理账号目录名
     */
    private cleanAccountDirName(dirName: string): string {
        const trimmed = dirName.trim()
        if (!trimmed) return trimmed

        // wxid_ 开头的标准格式: wxid_xxx_yyyy -> wxid_xxx
        if (trimmed.toLowerCase().startsWith('wxid_')) {
            const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
            if (match) return match[1]
            return trimmed
        }

        // 自定义微信号格式: xxx_yyyy (4位后缀) -> xxx
        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
        if (suffixMatch) return suffixMatch[1]

        return trimmed
    }

    /**
     * 查找账号对应的实际目录名
     */
    private findAccountDir(baseDir: string, wxid: string): string | null {
        if (!existsSync(baseDir)) return null

        const cleanedWxid = this.cleanAccountDirName(wxid)

        // 1. 直接匹配原始 wxid
        const directPath = join(baseDir, wxid)
        if (existsSync(directPath)) {
            return wxid
        }

        // 2. 直接匹配清理后的 wxid
        if (cleanedWxid !== wxid) {
            const cleanedPath = join(baseDir, cleanedWxid)
            if (existsSync(cleanedPath)) {
                return cleanedWxid
            }
        }

        // 3. 遍历目录查找匹配
        try {
            const entries = require('fs').readdirSync(baseDir)
            for (const entry of entries) {
                const entryPath = join(baseDir, entry)
                const stat = require('fs').statSync(entryPath)
                if (!stat.isDirectory()) continue

                const cleanedEntry = this.cleanAccountDirName(entry)
                if (cleanedEntry === cleanedWxid || cleanedEntry === wxid) {
                    return entry
                }
            }
        } catch (e) {
            console.error('[SnsService] 遍历目录失败:', e)
        }

        return null
    }

    /**
     * 打开 SNS 数据库（解密后的）
     */
    private openSnsDatabase(): boolean {
        if (this.snsDb) return true

        try {
            const wxid = this.configService.get('myWxid')

            if (!wxid) {
                console.error('[SnsService] wxid 未配置')
                return false
            }

            // 获取解密后的数据库目录
            const baseDir = this.getDecryptedDbDir()
            const accountDir = this.findAccountDir(baseDir, wxid)

            if (!accountDir) {
                console.error('[SnsService] 未找到账号目录:', wxid)
                return false
            }

            const snsDbPath = join(baseDir, accountDir, 'sns.db')

            if (!existsSync(snsDbPath)) {
                console.error('[SnsService] SNS 数据库不存在:', snsDbPath)
                return false
            }

            // 打开解密后的数据库（不需要密钥）
            this.snsDb = new Database(snsDbPath, { readonly: true })

            // 测试连接并查看表结构
            const testResult = this.snsDb.prepare('SELECT COUNT(*) as count FROM SnsTimeLine').get() as { count: number }
            console.log(`[SnsService] 数据库打开成功，SnsTimeLine 表共有 ${testResult.count} 条记录`)

            // 查看所有表
            const tables = this.snsDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            console.log('[SnsService] 数据库中的所有表:', tables.map((t: any) => t.name).join(', '))

            // 查看表结构
            const tableInfo = this.snsDb.prepare('PRAGMA table_info(SnsTimeLine)').all()
            console.log('[SnsService] SnsTimeLine 表结构:', tableInfo)

            // 查看一些样本数据的字段
            const sampleRows = this.snsDb.prepare('SELECT tid, user_name, LENGTH(content) as content_len FROM SnsTimeLine LIMIT 5').all()
            console.log('[SnsService] 样本数据:', sampleRows)

            return true
        } catch (error) {
            console.error('[SnsService] 打开 SNS 数据库失败:', error)
            this.snsDb = null
            return false
        }
    }

    /**
     * 从 XML 中解析点赞信息
     */
    private parseLikesFromXml(xml: string): string[] {
        if (!xml) return []

        const likes: string[] = []
        try {
            // 方式1: 查找 <LikeUserList> 标签
            let likeListMatch = xml.match(/<LikeUserList>([\s\S]*?)<\/LikeUserList>/i)

            // 方式2: 如果没找到，尝试查找 <likeUserList>（小写）
            if (!likeListMatch) {
                likeListMatch = xml.match(/<likeUserList>([\s\S]*?)<\/likeUserList>/i)
            }

            // 方式3: 尝试查找 <likeList>
            if (!likeListMatch) {
                likeListMatch = xml.match(/<likeList>([\s\S]*?)<\/likeList>/i)
            }

            if (!likeListMatch) return likes

            const likeListXml = likeListMatch[1]

            // 提取所有 <LikeUser> 或 <likeUser> 标签
            const likeUserRegex = /<(?:LikeUser|likeUser)>([\s\S]*?)<\/(?:LikeUser|likeUser)>/gi
            let likeUserMatch

            while ((likeUserMatch = likeUserRegex.exec(likeListXml)) !== null) {
                const likeUserXml = likeUserMatch[1]

                // 提取昵称（可能是 nickname 或 nickName）
                let nicknameMatch = likeUserXml.match(/<nickname>([^<]*)<\/nickname>/i)
                if (!nicknameMatch) {
                    nicknameMatch = likeUserXml.match(/<nickName>([^<]*)<\/nickName>/i)
                }

                if (nicknameMatch) {
                    likes.push(nicknameMatch[1].trim())
                }
            }
        } catch (error) {
            console.error('[SnsService] 解析点赞失败:', error)
        }

        return likes
    }

    /**
     * 从 XML 中解析评论信息
     */
    private parseCommentsFromXml(xml: string): { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[] {
        if (!xml) return []

        const comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[] = []
        try {
            // 方式1: 查找 <CommentUserList> 标签
            let commentListMatch = xml.match(/<CommentUserList>([\s\S]*?)<\/CommentUserList>/i)

            // 方式2: 如果没找到，尝试查找 <commentUserList>（小写）
            if (!commentListMatch) {
                commentListMatch = xml.match(/<commentUserList>([\s\S]*?)<\/commentUserList>/i)
            }

            // 方式3: 尝试查找 <commentList>
            if (!commentListMatch) {
                commentListMatch = xml.match(/<commentList>([\s\S]*?)<\/commentList>/i)
            }

            if (!commentListMatch) return comments

            const commentListXml = commentListMatch[1]

            // 提取所有 <CommentUser> 或 <commentUser> 或 <comment> 标签
            const commentUserRegex = /<(?:CommentUser|commentUser|comment)>([\s\S]*?)<\/(?:CommentUser|commentUser|comment)>/gi
            let commentUserMatch

            while ((commentUserMatch = commentUserRegex.exec(commentListXml)) !== null) {
                const commentUserXml = commentUserMatch[1]

                // 提取评论 ID（可能是 cmtid, commentId, id）
                let idMatch = commentUserXml.match(/<(?:cmtid|commentId|id)>([^<]*)<\/(?:cmtid|commentId|id)>/i)

                // 提取昵称（可能是 nickname 或 nickName）
                let nicknameMatch = commentUserXml.match(/<nickname>([^<]*)<\/nickname>/i)
                if (!nicknameMatch) {
                    nicknameMatch = commentUserXml.match(/<nickName>([^<]*)<\/nickName>/i)
                }

                // 提取评论内容
                const contentMatch = commentUserXml.match(/<content>([^<]*)<\/content>/i)

                // 提取回复的评论 ID（如果是回复）
                const refCommentIdMatch = commentUserXml.match(/<(?:refCommentId|replyCommentId)>([^<]*)<\/(?:refCommentId|replyCommentId)>/i)

                // 提取被回复者昵称
                let refNicknameMatch = commentUserXml.match(/<(?:refNickname|refNickName|replyNickname)>([^<]*)<\/(?:refNickname|refNickName|replyNickname)>/i)

                if (nicknameMatch && contentMatch) {
                    comments.push({
                        id: idMatch ? idMatch[1].trim() : `comment_${Date.now()}_${Math.random()}`,
                        nickname: nicknameMatch[1].trim(),
                        content: contentMatch[1].trim(),
                        refCommentId: refCommentIdMatch ? refCommentIdMatch[1].trim() : '',
                        refNickname: refNicknameMatch ? refNicknameMatch[1].trim() : undefined
                    })
                }
            }
        } catch (error) {
            console.error('[SnsService] 解析评论失败:', error)
        }

        return comments
    }

    /**
     * 从 XML 中解析媒体信息
     */
    private parseMediaFromXml(xml: string): { media: SnsMedia[]; videoKey?: string } {
        if (!xml) return { media: [] }

        const media: SnsMedia[] = []
        let videoKey: string | undefined

        try {
            // 提取视频密钥 <enc key="123456" />
            const encMatch = xml.match(/<enc\s+key="(\d+)"/i)
            if (encMatch) {
                videoKey = encMatch[1]
            }

            // 提取所有 <media> 标签
            const mediaRegex = /<media>([\s\S]*?)<\/media>/gi
            let mediaMatch

            while ((mediaMatch = mediaRegex.exec(xml)) !== null) {
                const mediaXml = mediaMatch[1]

                // 提取 URL（可能在属性中）
                const urlMatch = mediaXml.match(/<url[^>]*>([^<]+)<\/url>/i)
                const urlTagMatch = mediaXml.match(/<url([^>]*)>/i)

                // 提取 thumb（可能在属性中）
                const thumbMatch = mediaXml.match(/<thumb[^>]*>([^<]+)<\/thumb>/i)
                const thumbTagMatch = mediaXml.match(/<thumb([^>]*)>/i)

                // 从 url 标签的属性中提取 token, key, md5, enc_idx
                let urlToken: string | undefined
                let urlKey: string | undefined
                let urlMd5: string | undefined
                let urlEncIdx: string | undefined

                if (urlTagMatch && urlTagMatch[1]) {
                    const attrs = urlTagMatch[1]
                    const tokenMatch = attrs.match(/token="([^"]+)"/i)
                    const keyMatch = attrs.match(/key="([^"]+)"/i)
                    const md5Match = attrs.match(/md5="([^"]+)"/i)
                    const encIdxMatch = attrs.match(/enc_idx="([^"]+)"/i)

                    if (tokenMatch) urlToken = tokenMatch[1]
                    if (keyMatch) urlKey = keyMatch[1]
                    if (md5Match) urlMd5 = md5Match[1]
                    if (encIdxMatch) urlEncIdx = encIdxMatch[1]
                }

                // 从 thumb 标签的属性中提取 token, key
                let thumbToken: string | undefined
                let thumbKey: string | undefined
                let thumbEncIdx: string | undefined

                if (thumbTagMatch && thumbTagMatch[1]) {
                    const attrs = thumbTagMatch[1]
                    const tokenMatch = attrs.match(/token="([^"]+)"/i)
                    const keyMatch = attrs.match(/key="([^"]+)"/i)
                    const encIdxMatch = attrs.match(/enc_idx="([^"]+)"/i)

                    if (tokenMatch) thumbToken = tokenMatch[1]
                    if (keyMatch) thumbKey = keyMatch[1]
                    if (encIdxMatch) thumbEncIdx = encIdxMatch[1]
                }

                const mediaItem: SnsMedia = {
                    url: urlMatch ? urlMatch[1].trim() : '',
                    thumb: thumbMatch ? thumbMatch[1].trim() : '',
                    token: urlToken || thumbToken,
                    key: urlKey || thumbKey,  // 原图的 key
                    thumbKey: thumbKey,  // 缩略图的 key（可能和原图不同）
                    md5: urlMd5,
                    encIdx: urlEncIdx || thumbEncIdx
                }

                // 检查是否有实况照片 <livePhoto>
                const livePhotoMatch = mediaXml.match(/<livePhoto>([\s\S]*?)<\/livePhoto>/i)
                if (livePhotoMatch) {
                    const livePhotoXml = livePhotoMatch[1]

                    const lpUrlMatch = livePhotoXml.match(/<url[^>]*>([^<]+)<\/url>/i)
                    const lpUrlTagMatch = livePhotoXml.match(/<url([^>]*)>/i)
                    const lpThumbMatch = livePhotoXml.match(/<thumb[^>]*>([^<]+)<\/thumb>/i)
                    const lpThumbTagMatch = livePhotoXml.match(/<thumb([^>]*)>/i)

                    let lpUrlToken: string | undefined
                    let lpUrlKey: string | undefined
                    let lpUrlMd5: string | undefined
                    let lpUrlEncIdx: string | undefined

                    if (lpUrlTagMatch && lpUrlTagMatch[1]) {
                        const attrs = lpUrlTagMatch[1]
                        const tokenMatch = attrs.match(/token="([^"]+)"/i)
                        const keyMatch = attrs.match(/key="([^"]+)"/i)
                        const md5Match = attrs.match(/md5="([^"]+)"/i)
                        const encIdxMatch = attrs.match(/enc_idx="([^"]+)"/i)

                        if (tokenMatch) lpUrlToken = tokenMatch[1]
                        if (keyMatch) lpUrlKey = keyMatch[1]
                        if (md5Match) lpUrlMd5 = md5Match[1]
                        if (encIdxMatch) lpUrlEncIdx = encIdxMatch[1]
                    }

                    let lpThumbToken: string | undefined
                    let lpThumbKey: string | undefined

                    if (lpThumbTagMatch && lpThumbTagMatch[1]) {
                        const attrs = lpThumbTagMatch[1]
                        const tokenMatch = attrs.match(/token="([^"]+)"/i)
                        const keyMatch = attrs.match(/key="([^"]+)"/i)

                        if (tokenMatch) lpThumbToken = tokenMatch[1]
                        if (keyMatch) lpThumbKey = keyMatch[1]
                    }

                    mediaItem.livePhoto = {
                        url: lpUrlMatch ? lpUrlMatch[1].trim() : '',
                        thumb: lpThumbMatch ? lpThumbMatch[1].trim() : '',
                        token: lpUrlToken || lpThumbToken,
                        key: lpUrlKey || lpThumbKey,
                        md5: lpUrlMd5,
                        encIdx: lpUrlEncIdx
                    }
                }

                media.push(mediaItem)
            }
        } catch (error) {
            console.error('[SnsService] 解析 XML 失败:', error)
        }

        return { media, videoKey }
    }

    private getSnsCacheDir(): string {
        const cachePath = this.configService.getCacheBasePath()
        const snsCacheDir = join(cachePath, 'sns_cache')
        if (!existsSync(snsCacheDir)) {
            mkdirSync(snsCacheDir, { recursive: true })
        }
        return snsCacheDir
    }

    private getCacheFilePath(url: string): string {
        const hash = crypto.createHash('md5').update(url).digest('hex')
        const ext = isVideoUrl(url) ? '.mp4' : '.jpg'
        return join(this.getSnsCacheDir(), `${hash}${ext}`)
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        // 优先尝试使用 DLL 实时读取（推荐）
        try {
            const dllResult = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)

            if (dllResult.success && dllResult.timeline) {
                // DLL 返回的数据已经包含了点赞和评论，直接使用
                const enrichedTimeline = await Promise.all(dllResult.timeline.map(async (post: any) => {
                    // 获取头像
                    const avatarInfo = await chatService.getContactAvatar(post.username)

                    // 从 rawXml 中提取视频密钥
                    const videoKey = extractVideoKey(post.rawXml || '')

                    // 修正媒体 URL
                    const fixedMedia = (post.media || []).map((m: any) => {
                        const isMediaVideo = isVideoUrl(m.url)

                        return {
                            url: fixSnsUrl(m.url, m.token, isMediaVideo),
                            thumb: fixSnsUrl(m.thumb, m.token, false),
                            md5: m.md5,
                            token: m.token,
                            key: isMediaVideo ? (videoKey || m.key) : m.key,
                            thumbKey: m.thumbKey,
                            encIdx: m.encIdx,
                            livePhoto: m.livePhoto ? {
                                url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token, true),
                                thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token, false),
                                token: m.livePhoto.token,
                                key: videoKey || m.livePhoto.key || m.key,
                                md5: m.livePhoto.md5,
                                encIdx: m.livePhoto.encIdx
                            } : undefined
                        }
                    })

                    return {
                        ...post,
                        avatarUrl: avatarInfo?.avatarUrl,
                        media: fixedMedia,
                        shareInfo: extractShareInfo(post.rawXml || '')
                    }
                }))

                return { success: true, timeline: enrichedTimeline }
            }
        } catch (dllError) {
            console.warn('[SnsService] DLL 读取失败，尝试使用解密后的数据库:', dllError)
        }

        // 回退：使用解密后的数据库（数据可能不是最新的）
        if (!this.openSnsDatabase()) {
            return { success: false, error: 'SNS 数据库打开失败，请先在设置中解密数据库' }
        }

        try {
            // 先查询总记录数，用于调试
            const countStmt = this.snsDb!.prepare('SELECT COUNT(*) as total FROM SnsTimeLine')
            const countResult = countStmt.get() as { total: number }
            console.log(`[SnsService] 数据库总记录数: ${countResult.total}`)

            // 构建 SQL 查询
            // 注意：表名是 SnsTimeLine，字段是 tid, user_name, content
            let sql = 'SELECT tid, user_name, content FROM SnsTimeLine WHERE 1=1'
            const params: any[] = []

            // 用户名过滤
            if (usernames && usernames.length > 0) {
                sql += ` AND user_name IN (${usernames.map(() => '?').join(',')})`
                params.push(...usernames)
            }

            // 关键词过滤
            if (keyword) {
                sql += ' AND content LIKE ?'
                params.push(`%${keyword}%`)
            }

            // 时间范围过滤（需要从 XML 中提取 createTime）
            // 暂时跳过时间过滤，因为时间在 XML 中

            // 排序和分页（按 tid 降序，tid 越大越新）
            sql += ' ORDER BY tid DESC LIMIT ? OFFSET ?'
            params.push(limit, offset)

            console.log(`[SnsService] SQL 查询: ${sql}`)
            console.log(`[SnsService] 参数: limit=${limit}, offset=${offset}, usernames=${usernames?.length || 0}, keyword=${keyword || 'none'}`)

            const stmt = this.snsDb!.prepare(sql)
            const rows = stmt.all(...params) as any[]

            console.log(`[SnsService] 查询返回 ${rows.length} 条记录`)

            // 检查第一条记录的内容
            if (rows.length > 0) {
                const firstRow = rows[0]
                console.log(`[SnsService] 第一条记录: tid=${firstRow.tid}, user_name=${firstRow.user_name}, content长度=${firstRow.content?.length || 0}`)

                // 检查 content 是否为空
                const emptyContentCount = rows.filter(r => !r.content || r.content.trim().length === 0).length
                if (emptyContentCount > 0) {
                    console.warn(`[SnsService] 警告: ${emptyContentCount} 条记录的 content 字段为空`)
                }
            }

            // 解析每条记录
            const timeline: SnsPost[] = await Promise.all(rows.map(async (row) => {
                const contact = await chatService.getContact(row.user_name)
                const avatarInfo = await chatService.getContactAvatar(row.user_name)

                // 解析 XML 获取媒体信息和其他字段
                const xmlContent = row.content || ''
                const { media, videoKey } = this.parseMediaFromXml(xmlContent)

                // 从 XML 中提取基本信息
                let createTime = 0
                let contentDesc = ''
                let snsId = String(row.tid)
                let type = 1 // 默认类型

                // 提取 createTime
                const createTimeMatch = xmlContent.match(/<createTime>(\d+)<\/createTime>/i)
                if (createTimeMatch) {
                    createTime = parseInt(createTimeMatch[1])
                }

                // 提取 id
                const idMatch = xmlContent.match(/<id>(\d+)<\/id>/i)
                if (idMatch) {
                    snsId = idMatch[1]
                }

                // 提取 contentDesc
                const contentDescMatch = xmlContent.match(/<contentDesc(?:\s+[^>]*)?>([^<]*)<\/contentDesc>/i)
                if (contentDescMatch) {
                    contentDesc = contentDescMatch[1].trim()
                }

                // 提取 type
                const typeMatch = xmlContent.match(/<type>(\d+)<\/type>/i)
                if (typeMatch) {
                    type = parseInt(typeMatch[1])
                }

                // 判断是否为视频动态
                const isVideoPost = type === 15

                // 修正媒体 URL
                const fixedMedia = media.map((m) => {
                    const isMediaVideo = isVideoUrl(m.url)

                    return {
                        url: fixSnsUrl(m.url, m.token, isMediaVideo),
                        thumb: fixSnsUrl(m.thumb, m.token, false),
                        md5: m.md5,
                        token: m.token,
                        // 视频用 XML 的 key，图片用 media 的 key
                        key: isMediaVideo ? (videoKey || m.key) : m.key,
                        encIdx: m.encIdx,
                        livePhoto: m.livePhoto ? {
                            url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token, true),
                            thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token, false),
                            token: m.livePhoto.token,
                            // 实况照片的视频部分用 XML 的 key
                            key: videoKey || m.livePhoto.key || m.key,
                            md5: m.livePhoto.md5,
                            encIdx: m.livePhoto.encIdx
                        } : undefined
                    }
                })

                // 提取点赞和评论
                const likes = this.parseLikesFromXml(xmlContent)
                const comments = this.parseCommentsFromXml(xmlContent)

                // 临时调试：打印第一条动态的 XML 看看结构
                if (offset === 0 && rows.indexOf(row) === 0) {
                    console.log('[SnsService] 第一条动态的 XML 片段（点赞评论部分）:')
                    const likeMatch = xmlContent.match(/<LikeUserList>[\s\S]*?<\/LikeUserList>/i)
                    const commentMatch = xmlContent.match(/<CommentUserList>[\s\S]*?<\/CommentUserList>/i)
                    if (likeMatch) console.log('点赞:', likeMatch[0].substring(0, 500))
                    if (commentMatch) console.log('评论:', commentMatch[0].substring(0, 500))
                    console.log('解析结果 - 点赞:', likes)
                    console.log('解析结果 - 评论:', comments)
                }

                return {
                    id: snsId,
                    username: row.user_name,
                    nickname: contact?.remark || contact?.nickName || contact?.alias || row.user_name,
                    avatarUrl: avatarInfo?.avatarUrl,
                    createTime,
                    contentDesc,
                    type,
                    media: fixedMedia,
                    shareInfo: extractShareInfo(xmlContent),
                    likes,
                    comments,
                    rawXml: xmlContent
                }
            }))

            return { success: true, timeline }
        } catch (error: any) {
            console.error('[SnsService] 查询 SNS 数据失败:', error)
            return { success: false, error: error.message }
        }
    }

    async proxyImage(url: string, key?: string | number): Promise<{ success: boolean; dataUrl?: string; videoPath?: string; localPath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }

        const result = await this.fetchAndDecryptImage(url, key)
        if (result.success) {
            // 视频返回文件路径
            if (result.contentType?.startsWith('video/')) {
                return { success: true, videoPath: result.cachePath }
            }
            // 图片也返回文件路径，而不是 base64
            if (result.cachePath && existsSync(result.cachePath)) {
                return { success: true, localPath: result.cachePath }
            }
            // 回退：如果没有缓存路径，返回 base64
            if (result.data && result.contentType) {
                const dataUrl = `data:${result.contentType};base64,${result.data.toString('base64')}`
                return { success: true, dataUrl }
            }
        }
        return { success: false, error: result.error }
    }

    async downloadImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        return this.fetchAndDecryptImage(url, key)
    }

    private async fetchAndDecryptImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }

        const isVideo = isVideoUrl(url)
        const cachePath = this.getCacheFilePath(url)

        // 1. 检查缓存（优先返回本地文件）
        if (existsSync(cachePath)) {
            try {
                if (isVideo) {
                    return { success: true, cachePath, contentType: 'video/mp4' }
                }
                const data = await readFile(cachePath)
                const contentType = detectImageMime(data)
                return { success: true, data, contentType, cachePath }
            } catch (e) {
                console.warn(`[SnsService] 读取缓存失败: ${cachePath}`, e)
            }
        }

        // 视频：流式下载到临时文件
        if (isVideo) {
            return new Promise(async (resolve) => {
                const tmpPath = join(require('os').tmpdir(), `sns_video_${Date.now()}_${Math.random().toString(36).slice(2)}.enc`)

                try {
                    const https = require('https')
                    const urlObj = new URL(url)
                    const fs = require('fs')
                    const fileStream = fs.createWriteStream(tmpPath)

                    const options = {
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'MicroMessenger Client',
                            'Accept': '*/*',
                            'Connection': 'keep-alive'
                        },
                        rejectUnauthorized: false
                    }

                    const req = https.request(options, (res: any) => {
                        if (res.statusCode !== 200 && res.statusCode !== 206) {
                            fileStream.close()
                            fs.unlink(tmpPath, () => { })
                            resolve({ success: false, error: `HTTP ${res.statusCode}` })
                            return
                        }

                        res.pipe(fileStream)

                        fileStream.on('finish', async () => {
                            fileStream.close()

                            try {
                                const encryptedBuffer = await readFile(tmpPath)
                                const raw = encryptedBuffer

                                // 视频只解密前128KB
                                if (key && String(key).trim().length > 0) {
                                    try {
                                        const keyText = String(key).trim()
                                        let keystream: Buffer

                                        try {
                                            const wasmService = WasmService.getInstance()
                                            // 只需要前 128KB (131072 bytes) 用于解密头部
                                            keystream = await wasmService.getKeystream(keyText, 131072)
                                        } catch (wasmErr) {
                                            // 打包漏带 wasm 或 wasm 初始化异常时，回退到纯 TS ISAAC64
                                            const isaac = new Isaac64(keyText)

                                            // 对齐到 8 字节，然后 reverse
                                            const alignSize = Math.ceil(131072 / 8) * 8
                                            const alignedKeystream = isaac.generateKeystreamBE(alignSize)
                                            const reversed = Buffer.from(alignedKeystream)
                                            reversed.reverse()
                                            keystream = reversed.subarray(0, 131072)
                                        }

                                        const decryptLen = Math.min(keystream.length, raw.length)

                                        // XOR 解密
                                        for (let i = 0; i < decryptLen; i++) {
                                            raw[i] ^= keystream[i]
                                        }

                                        // 验证 MP4 签名 ('ftyp' at offset 4)
                                        const ftyp = raw.subarray(4, 8).toString('ascii')
                                        if (ftyp !== 'ftyp') {
                                            console.warn('[SnsService] 视频解密后签名验证失败，ftyp:', ftyp)
                                        }
                                    } catch (err) {
                                        console.error(`[SnsService] 视频解密出错: ${err}`)
                                    }
                                }

                                await writeFile(cachePath, raw)
                                try { await import('fs/promises').then(fs => fs.unlink(tmpPath)) } catch (e) { }

                                resolve({ success: true, data: raw, contentType: 'video/mp4', cachePath })
                            } catch (e: any) {
                                console.error(`[SnsService] 视频处理失败:`, e)
                                resolve({ success: false, error: e.message })
                            }
                        })
                    })

                    req.on('error', (e: any) => {
                        fs.unlink(tmpPath, () => { })
                        resolve({ success: false, error: e.message })
                    })

                    req.end()
                } catch (e: any) {
                    resolve({ success: false, error: e.message })
                }
            })
        }

        // 图片：内存下载并解密
        return new Promise((resolve) => {
            try {
                const https = require('https')
                const zlib = require('zlib')
                const urlObj = new URL(url)

                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'MicroMessenger Client',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive'
                    },
                    rejectUnauthorized: false
                }

                const req = https.request(options, (res: any) => {
                    if (res.statusCode !== 200 && res.statusCode !== 206) {
                        resolve({ success: false, error: `HTTP ${res.statusCode}` })
                        return
                    }

                    const chunks: Buffer[] = []
                    let stream = res

                    // 解压gzip/br
                    const encoding = res.headers['content-encoding']
                    if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip())
                    else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
                    else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())

                    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
                    stream.on('end', async () => {
                        const raw = Buffer.concat(chunks)
                        const xEnc = String(res.headers['x-enc'] || '').trim()

                        let decoded = raw

                        // 图片逻辑
                        const shouldDecrypt = (xEnc === '1' || !!key) && key !== undefined && key !== null && String(key).trim().length > 0
                        if (shouldDecrypt) {
                            try {
                                const keyStr = String(key).trim()
                                if (/^\d+$/.test(keyStr)) {
                                    let keystream: Buffer

                                    try {
                                        // 优先使用 WASM 版本的 Isaac64 解密图片
                                        // 修正逻辑：使用带 reverse 且修正了 8字节对齐偏移的 getKeystream
                                        const wasmService = WasmService.getInstance()
                                        keystream = await wasmService.getKeystream(keyStr, raw.length)
                                    } catch (wasmErr) {
                                        // Fallback：使用纯 TypeScript 的 Isaac64
                                        const isaac = new Isaac64(keyStr)

                                        // 需要对齐到 8 字节边界，然后 reverse，和 WASM 版本保持一致
                                        const alignSize = Math.ceil(raw.length / 8) * 8
                                        const alignedKeystream = isaac.generateKeystreamBE(alignSize)

                                        // Reverse 整个 buffer
                                        const reversed = Buffer.from(alignedKeystream)
                                        reversed.reverse()

                                        // 取前 raw.length 字节
                                        keystream = reversed.subarray(0, raw.length)
                                    }

                                    const decrypted = Buffer.allocUnsafe(raw.length)
                                    for (let i = 0; i < raw.length; i++) {
                                        decrypted[i] = raw[i] ^ keystream[i]
                                    }

                                    decoded = decrypted

                                    // 验证解密结果
                                    const mime = detectImageMime(decoded)
                                    if (!mime.startsWith('image/')) {
                                        console.warn('[SnsService] ✗ 图片解密失败，文件头:', decoded.subarray(0, 8).toString('hex'))
                                    }
                                }
                            } catch (e) {
                                console.error('[SnsService] 图片解密失败:', e)
                            }
                        }

                        try {
                            await writeFile(cachePath, decoded)
                        } catch (e) {
                            console.warn(`[SnsService] 写入缓存失败: ${cachePath}`, e)
                        }

                        const contentType = detectImageMime(decoded, (res.headers['content-type'] || 'image/jpeg') as string)
                        resolve({ success: true, data: decoded, contentType, cachePath })
                    })
                    stream.on('error', (e: any) => resolve({ success: false, error: e.message }))
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }
}

export const snsService = new SnsService()
