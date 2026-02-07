// 聊天会话
export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  displayName?: string
  avatarUrl?: string
}

// 联系人
export interface Contact {
  id: number
  username: string
  localType: number
  alias: string
  remark: string
  nickName: string
  bigHeadUrl: string
  smallHeadUrl: string
}

// 通讯录联系人（用于导出）
export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

// 消息
export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number  // 排序序列号，用于精确去重
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  imageMd5?: string
  imageDatName?: string
  emojiCdnUrl?: string
  emojiMd5?: string
  voiceDuration?: number  // 语音时长（秒）
  // 引用消息
  quotedContent?: string
  quotedSender?: string
  quotedImageMd5?: string
  // 视频相关
  videoMd5?: string
  rawContent?: string
  productId?: string
  // 文件消息相关
  fileName?: string       // 文件名
  fileSize?: number       // 文件大小（字节）
  fileExt?: string        // 文件扩展名
  fileMd5?: string        // 文件 MD5
  chatRecordList?: ChatRecordItem[] // 聊天记录列表 (Type 19)
  // 转账消息
  transferPayerUsername?: string    // 转账付款方 wxid
  transferReceiverUsername?: string // 转账收款方 wxid
}

export interface ChatRecordItem {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  // 媒体信息
  dataurl?: string      // 原始地址
  datathumburl?: string // 缩略图地址
  datacdnurl?: string   // CDN地址
  qaeskey?: string      // AES Key (通常在 recorditem 中是 qaeskey 或 aeskey)
  aeskey?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  thumbheadurl?: string // 视频/图片缩略图
  duration?: number     // 语音/视频时长
}

// 分析数据
export interface AnalyticsData {
  totalMessages: number
  totalDays: number
  myMessages: number
  otherMessages: number
  messagesByType: Record<number, number>
  messagesByHour: number[]
  messagesByDay: number[]
}
