/**
 * HTML 导出生成器
 * 生成现代风格的聊天记录 HTML 页面
 * 支持图片/视频内联显示、搜索、主题切换
 */

export interface HtmlExportMessage {
  timestamp: number
  sender: string
  senderName: string
  type: number
  content: string | null
  rawContent: string
  isSend: boolean
  chatRecords?: HtmlChatRecord[]
}

export interface HtmlChatRecord {
  sender: string
  senderDisplayName: string
  timestamp: number
  formattedTime: string
  type: string
  datatype: number
  content: string
  senderAvatar?: string
  fileExt?: string
  fileSize?: number
}

export interface HtmlMember {
  id: string
  name: string
  avatar?: string
}

export interface HtmlExportData {
  meta: {
    sessionId: string
    sessionName: string
    isGroup: boolean
    exportTime: number
    messageCount: number
    dateRange: { start: number; end: number } | null
  }
  members: HtmlMember[]
  messages: HtmlExportMessage[]
}

export class HtmlExportGenerator {
  /**
   * 生成完整的单文件 HTML（内联 CSS + JS + 数据）
   */
  static generateHtmlWithData(exportData: HtmlExportData): string {
    const escapedSessionName = this.escapeHtml(exportData.meta.sessionName)
    const dateRangeText = exportData.meta.dateRange
      ? `${new Date(exportData.meta.dateRange.start * 1000).toLocaleDateString('zh-CN')} - ${new Date(exportData.meta.dateRange.end * 1000).toLocaleDateString('zh-CN')}`
      : ''

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedSessionName} - 聊天记录</title>
  <style>${this.generateCss()}</style>
</head>
<body>
  <div class="app">
    <header class="chat-header">
      <div class="header-left">
        <div class="header-avatar">${escapedSessionName.charAt(0)}</div>
        <div class="header-info">
          <h1>${escapedSessionName}</h1>
          <span class="header-meta">${exportData.messages.length} 条消息${dateRangeText ? ' · ' + dateRangeText : ''}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn" id="themeToggle" title="切换主题">🌓</button>
        <button class="icon-btn" id="searchToggle" title="搜索">🔍</button>
      </div>
    </header>

    <div class="search-bar" id="searchBar">
      <input type="text" id="searchInput" placeholder="搜索消息内容或发送者..." />
      <span id="searchCount"></span>
      <button id="clearSearch">✕</button>
    </div>

    <div class="chat-body" id="chatBody">
      <div id="messagesContainer"></div>
      <div class="loading-indicator" id="loadingIndicator">加载中...</div>
    </div>

    <footer class="chat-footer">
      由 <strong>CipherTalk</strong> 导出 · ${new Date(exportData.meta.exportTime).toLocaleString('zh-CN')}
    </footer>
  </div>

  <!-- 图片预览层 -->
  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" id="lightboxClose">✕</button>
    <img id="lightboxImg" />
  </div>

  <script>window.CHAT_DATA = ${JSON.stringify(exportData)};</script>
  <script>${this.generateJs()}</script>
</body>
</html>`
  }

  /**
   * 生成 CSS 样式
   */
  static generateCss(): string {
    return `
:root {
  --bg: #f0f2f5;
  --chat-bg: #efeae2;
  --header-bg: #075e54;
  --header-text: #fff;
  --bubble-recv: #ffffff;
  --bubble-send: #d9fdd3;
  --text: #111b21;
  --text-secondary: #667781;
  --text-time: #667781;
  --border: #e9edef;
  --search-bg: #f0f2f5;
  --system-bg: rgba(0,0,0,0.04);
  --system-text: #667781;
  --shadow: rgba(0,0,0,0.08);
  --link: #027eb5;
  --media-bg: #e4e4e4;
}

[data-theme="dark"] {
  --bg: #0b141a;
  --chat-bg: #0b141a;
  --header-bg: #1f2c34;
  --header-text: #e9edef;
  --bubble-recv: #202c33;
  --bubble-send: #005c4b;
  --text: #e9edef;
  --text-secondary: #8696a0;
  --text-time: #8696a0;
  --border: #222d34;
  --search-bg: #111b21;
  --system-bg: rgba(255,255,255,0.05);
  --system-text: #8696a0;
  --shadow: rgba(0,0,0,0.3);
  --link: #53bdeb;
  --media-bg: #1a2a33;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

.app {
  max-width: 900px;
  margin: 0 auto;
  height: 100vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 0 40px var(--shadow);
}

/* 头部 */
.chat-header {
  background: var(--header-bg);
  color: var(--header-text);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.header-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255,255,255,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  flex-shrink: 0;
}

.header-info {
  min-width: 0;
}

.header-info h1 {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-meta {
  font-size: 12px;
  opacity: 0.8;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  background: none;
  border: none;
  color: var(--header-text);
  font-size: 18px;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: background 0.2s;
  line-height: 1;
}

.icon-btn:hover {
  background: rgba(255,255,255,0.15);
}

/* 搜索栏 */
.search-bar {
  background: var(--header-bg);
  padding: 0 16px 10px;
  display: none;
  align-items: center;
  gap: 8px;
}

.search-bar.active {
  display: flex;
}

.search-bar input {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: rgba(255,255,255,0.15);
  color: var(--header-text);
  font-size: 14px;
  outline: none;
}

.search-bar input::placeholder {
  color: rgba(255,255,255,0.5);
}

#searchCount {
  color: rgba(255,255,255,0.7);
  font-size: 12px;
  white-space: nowrap;
}

#clearSearch {
  background: none;
  border: none;
  color: rgba(255,255,255,0.7);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
}

/* 聊天体 */
.chat-body {
  flex: 1;
  overflow-y: auto;
  background: var(--chat-bg);
  padding: 8px 0;
}

.chat-body::-webkit-scrollbar { width: 6px; }
.chat-body::-webkit-scrollbar-track { background: transparent; }
.chat-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 3px; }

/* 日期分割线 */
.date-divider {
  text-align: center;
  padding: 12px 0 8px;
}

.date-divider span {
  background: var(--system-bg);
  color: var(--system-text);
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
}

/* 系统消息 */
.system-msg {
  text-align: center;
  padding: 4px 60px;
  margin: 2px 0;
}

.system-msg span {
  background: var(--system-bg);
  color: var(--system-text);
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 12px;
  display: inline-block;
  max-width: 100%;
  word-break: break-word;
}

/* 消息行 */
.msg-row {
  display: flex;
  padding: 1px 10px;
  align-items: flex-end;
  gap: 6px;
}

.msg-row.sent {
  flex-direction: row-reverse;
}

/* 头像 */
.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  overflow: hidden;
  background: #dfe5e7;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  align-self: flex-start;
  margin-top: 2px;
}

.msg-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.msg-avatar.c0 { background: #25d366; }
.msg-avatar.c1 { background: #128c7e; }
.msg-avatar.c2 { background: #075e54; }
.msg-avatar.c3 { background: #34b7f1; }
.msg-avatar.c4 { background: #00a884; }
.msg-avatar.c5 { background: #7c5cbf; }
.msg-avatar.c6 { background: #e67e22; }
.msg-avatar.c7 { background: #e74c3c; }

/* 气泡 */
.msg-bubble {
  max-width: 65%;
  min-width: 80px;
}

.msg-sender {
  font-size: 12px;
  color: var(--link);
  font-weight: 500;
  margin-bottom: 1px;
  padding: 0 4px;
}

.bubble-body {
  background: var(--bubble-recv);
  padding: 6px 8px 4px;
  border-radius: 8px;
  position: relative;
  box-shadow: 0 1px 1px var(--shadow);
  word-break: break-word;
  white-space: pre-wrap;
  font-size: 14px;
}

.msg-row.sent .bubble-body {
  background: var(--bubble-send);
}

.msg-text {
  line-height: 1.4;
}

.msg-time {
  font-size: 11px;
  color: var(--text-time);
  text-align: right;
  margin-top: 2px;
  white-space: nowrap;
}

/* 媒体样式 */
.msg-image {
  cursor: pointer;
  border-radius: 6px;
  max-width: 300px;
  max-height: 300px;
  display: block;
  object-fit: contain;
  background: var(--media-bg);
}

.msg-image.broken {
  width: 200px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--media-bg);
  color: var(--text-secondary);
  font-size: 12px;
  border-radius: 6px;
}

.msg-video {
  max-width: 320px;
  max-height: 240px;
  border-radius: 6px;
  background: #000;
}

/* 表情包 */
.msg-emoji {
  max-width: 120px;
  max-height: 120px;
  display: block;
  cursor: pointer;
}

/* 语音播放器 */
.msg-voice {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-voice audio {
  height: 32px;
  max-width: 240px;
}

.msg-voice .voice-text {
  font-size: 12px;
  color: var(--secondary-text);
  opacity: 0.8;
}

/* 文件链接 */
.msg-file {
  display: inline-block;
  padding: 6px 12px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-color);
  text-decoration: none;
  font-size: 13px;
}
.msg-file:hover { opacity: 0.8; }

/* 聊天记录引用 */
.chat-records {
  margin-top: 4px;
  padding: 6px 8px;
  background: rgba(0,0,0,0.04);
  border-radius: 6px;
  border-left: 3px solid var(--link);
  font-size: 13px;
}

[data-theme="dark"] .chat-records {
  background: rgba(255,255,255,0.05);
}

.chat-records .cr-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--link);
  margin-bottom: 4px;
}

.cr-item {
  padding: 3px 0;
  border-bottom: 1px solid rgba(0,0,0,0.05);
}

.cr-item:last-child { border-bottom: none; }

.cr-item .cr-sender {
  font-weight: 600;
  font-size: 12px;
}

.cr-item .cr-time {
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: 6px;
}

.cr-item .cr-content {
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 1px;
}

/* 底部 */
.chat-footer {
  background: var(--bg);
  text-align: center;
  padding: 10px;
  font-size: 12px;
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* 加载指示器 */
.loading-indicator {
  text-align: center;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 13px;
  display: none;
}

.loading-indicator.active { display: block; }

/* 图片预览 */
.lightbox {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.9);
  z-index: 1000;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}

.lightbox.active {
  display: flex;
}

.lightbox img {
  max-width: 95vw;
  max-height: 95vh;
  object-fit: contain;
  border-radius: 4px;
}

.lightbox-close {
  position: absolute;
  top: 16px;
  right: 20px;
  background: none;
  border: none;
  color: #fff;
  font-size: 28px;
  cursor: pointer;
  z-index: 1001;
  opacity: 0.7;
}

.lightbox-close:hover { opacity: 1; }

/* 响应式 */
@media (max-width: 600px) {
  .msg-bubble { max-width: 80%; }
  .msg-image { max-width: 220px; }
  .msg-video { max-width: 260px; }
  .msg-emoji { max-width: 100px; }
}
`
  }

  /**
   * 生成 JavaScript 逻辑
   */
  static generateJs(): string {
    return `
(function() {
  const data = window.CHAT_DATA;
  const messages = data.messages;
  const members = {};
  data.members.forEach(m => { members[m.id] = m; });

  const chatBody = document.getElementById('chatBody');
  const container = document.getElementById('messagesContainer');
  const loadingEl = document.getElementById('loadingIndicator');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');

  let filteredMessages = messages;
  let loadedCount = 0;
  const BATCH = 50;
  let isLoading = false;

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
  });

  // 搜索
  const searchBar = document.getElementById('searchBar');
  const searchInput = document.getElementById('searchInput');
  const searchCount = document.getElementById('searchCount');

  document.getElementById('searchToggle').addEventListener('click', () => {
    searchBar.classList.toggle('active');
    if (searchBar.classList.contains('active')) searchInput.focus();
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 300);
  });

  document.getElementById('clearSearch').addEventListener('click', () => {
    searchInput.value = '';
    doSearch();
  });

  function doSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      filteredMessages = messages;
      searchCount.textContent = '';
    } else {
      filteredMessages = messages.filter(m => {
        if (m.content && m.content.toLowerCase().includes(q)) return true;
        const mem = members[m.sender];
        if (mem && mem.name.toLowerCase().includes(q)) return true;
        if (m.senderName && m.senderName.toLowerCase().includes(q)) return true;
        return false;
      });
      searchCount.textContent = filteredMessages.length + ' 条结果';
    }
    loadedCount = 0;
    container.innerHTML = '';
    loadMore();
  }

  // 图片灯箱
  lightbox.addEventListener('click', () => lightbox.classList.remove('active'));
  document.getElementById('lightboxClose').addEventListener('click', (e) => {
    e.stopPropagation();
    lightbox.classList.remove('active');
  });

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.add('active');
  }

  // 媒体加载失败处理
  function imgError(el, label) {
    var div = document.createElement('div');
    div.className = 'msg-image broken';
    div.textContent = label;
    el.replaceWith(div);
  }

  // 颜色分配
  function avatarColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
    return 'c' + (Math.abs(hash) % 8);
  }

  // HTML 转义
  function esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // 格式化时间
  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return h + ':' + m;
  }

  function fmtDate(ts) {
    const d = new Date(ts * 1000);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日' +
      ' 星期' + '日一二三四五六'[d.getDay()];
  }

  // 渲染消息内容（处理图片/视频路径）
  function renderContent(msg) {
    const content = msg.content;
    if (!content) return '<em style="opacity:0.5">无内容</em>';

    // 图片消息：[图片] images/xxx.jpg
    const imgMatch = content.match(/^\\[图片\\]\\s+(.+)$/);
    if (imgMatch) {
      const src = imgMatch[1];
      return '<img class="msg-image" src="' + esc(src) + '" loading="lazy" onclick="window.__lightbox(this.src)" onerror="window.__imgError(this)">';
    }
    // 仅 [图片] 无路径
    if (content === '[图片]') return '<div class="msg-image broken">📷 图片</div>';

    // 视频消息：[视频] videos/xxx.mp4
    const vidMatch = content.match(/^\\[视频\\]\\s+(.+)$/);
    if (vidMatch) {
      const src = vidMatch[1];
      return '<video class="msg-video" controls preload="metadata" src="' + esc(src) + '"></video>';
    }
    if (content === '[视频]') return '<div class="msg-image broken">🎥 视频</div>';

    // 动画表情：[动画表情] emojis/xxx.gif
    const emojiMatch = content.match(/^\\[动画表情\\]\\s+(.+)$/);
    if (emojiMatch) {
      const src = emojiMatch[1];
      return '<img class="msg-emoji" src="' + esc(src) + '" loading="lazy" onclick="window.__lightbox(this.src)" onerror="window.__imgError(this)">';
    }
    if (content === '[动画表情]') return '<div class="msg-image broken">😀 表情</div>';

    // 语音消息：[语音消息] voices/xxx.wav [转写文字]
    const voiceMatch = content.match(/^\\[语音消息\\]\\s+(voices\\/[^\\s]+)(?:\\s+([\\s\\S]+))?$/);
    if (voiceMatch) {
      const src = voiceMatch[1];
      const transcript = voiceMatch[2] || '';
      let html = '<div class="msg-voice">';
      html += '<audio controls preload="metadata" src="' + esc(src) + '"></audio>';
      if (transcript) html += '<div class="voice-text">' + esc(transcript) + '</div>';
      html += '</div>';
      return html;
    }
    if (content === '[语音消息]') return '<div class="msg-image broken">🎙️ 语音</div>';

    // 文件消息：[文件] files/xxx.pdf 原始文件名
    const fileMatch = content.match(/^\[文件\]\s+(files\/[^\s]+)\s*(.*)$/);
    if (fileMatch) {
      const src = fileMatch[1];
      const name = fileMatch[2] || src.replace(/^files\/\d+_/, '');
      return '<a class="msg-file" href="' + esc(src) + '" target="_blank">📎 ' + esc(name) + '</a>';
    }

    return '<span class="msg-text">' + esc(content) + '</span>';
  }

  // 渲染聊天记录引用
  function renderChatRecords(records) {
    if (!records || records.length === 0) return '';
    let html = '<div class="chat-records"><div class="cr-title">📋 聊天记录</div>';
    for (const r of records) {
      html += '<div class="cr-item">';
      html += '<span class="cr-sender">' + esc(r.senderDisplayName) + '</span>';
      if (r.formattedTime) html += '<span class="cr-time">' + esc(r.formattedTime) + '</span>';
      html += '<div class="cr-content">' + esc(r.content) + '</div></div>';
    }
    return html + '</div>';
  }

  // 渲染单条消息
  function renderMsg(msg, prevMsg) {
    let html = '';

    // 日期分割线
    if (!prevMsg || fmtDate(msg.timestamp) !== fmtDate(prevMsg.timestamp)) {
      html += '<div class="date-divider"><span>' + fmtDate(msg.timestamp) + '</span></div>';
    }

    // 系统消息
    if (msg.type === 10000 || msg.type === 266287972401) {
      html += '<div class="system-msg"><span>' + esc(msg.content || '') + '</span></div>';
      return html;
    }

    const mem = members[msg.sender];
    const name = mem ? mem.name : (msg.senderName || msg.sender);
    const avatar = mem && mem.avatar ? mem.avatar : null;
    const isGroup = data.meta.isGroup;
    const isSend = msg.isSend;

    html += '<div class="msg-row' + (isSend ? ' sent' : '') + '">';

    // 头像
    html += '<div class="msg-avatar ' + avatarColor(msg.sender) + '">';
    if (avatar) {
      html += '<img src="' + esc(avatar) + '" onerror="this.style.display=\\'none\\';this.parentElement.textContent=\\'' + esc(name.charAt(0)) + '\\'"/>';
    } else {
      html += esc(name.charAt(0));
    }
    html += '</div>';

    // 气泡
    html += '<div class="msg-bubble">';
    if (isGroup && !isSend) {
      html += '<div class="msg-sender">' + esc(name) + '</div>';
    }
    html += '<div class="bubble-body">';
    html += renderContent(msg);
    if (msg.chatRecords) html += renderChatRecords(msg.chatRecords);
    html += '<div class="msg-time">' + fmtTime(msg.timestamp) + '</div>';
    html += '</div></div></div>';

    return html;
  }

  // 按批次加载
  function loadMore() {
    if (isLoading || loadedCount >= filteredMessages.length) {
      loadingEl.classList.remove('active');
      return;
    }
    isLoading = true;
    loadingEl.classList.add('active');

    requestAnimationFrame(() => {
      const end = Math.min(loadedCount + BATCH, filteredMessages.length);
      let html = '';
      for (let i = loadedCount; i < end; i++) {
        const prev = i > 0 ? filteredMessages[i - 1] : null;
        html += renderMsg(filteredMessages[i], prev);
      }
      container.insertAdjacentHTML('beforeend', html);
      loadedCount = end;
      isLoading = false;

      if (loadedCount >= filteredMessages.length) {
        loadingEl.classList.remove('active');
      }
    });
  }

  // 滚动加载
  chatBody.addEventListener('scroll', () => {
    if (chatBody.scrollTop + chatBody.clientHeight >= chatBody.scrollHeight - 300) {
      loadMore();
    }
  });

  // 全局函数
  window.__lightbox = openLightbox;
  window.__imgError = imgError;

  // 初始加载
  loadMore();
})();
`
  }

  /**
   * 生成数据 JS 文件（兼容旧接口）
   */
  static generateDataJs(exportData: HtmlExportData): string {
    return `window.CHAT_DATA = ${JSON.stringify(exportData)};`
  }

  /**
   * 生成数据 JSON 文件
   */
  static generateDataJson(exportData: HtmlExportData): string {
    return JSON.stringify(exportData, null, 2)
  }

  /**
   * HTML 转义
   */
  private static escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }
    return text.replace(/[&<>"']/g, m => map[m])
  }
}
