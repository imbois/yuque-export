'use strict';
/**
 * 语雀公开内容客户端 —— 不依赖任何第三方语雀 SDK
 *
 * 取数原理：
 *  1. 请求文档页 HTML，页面内嵌 `decodeURIComponent("...")` 形式的 appData，
 *     其中含 book.id / doc.slug / doc.title / 目录树。
 *  2. 用 book.id + doc.slug 调 /api/docs/{slug}?mode=markdown 取正文（sourcecode）。
 *  3. 正文中的图片按 CDN 地址下载到本地，改写为相对路径。
 *
 * 只按需请求：单篇文档模式不会触碰目录树，也不会请求其他文档。
 */

const { join } = require('path');
const { createHash } = require('crypto');
const { ensureDir, writeFile, safeName } = require('./fsutil');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOST = 'https://www.yuque.com';

/** 单张图片体积上限（防止文档里塞超大文件把磁盘/内存打满） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT = 30000;

/** 严格判断语雀域名：yuque.com 及其子域，拒绝 evilyuque.com 这类伪造 */
function isYuqueHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'yuque.com' || h.endsWith('.yuque.com');
}

/** 内网/回环地址判定：文档内容不可信，避免被用来探测本机与内网 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^(fc|fd|fe80)/.test(h)) return true;
  return false;
}

/** 测试用途：本地 Mock 服务器需要放行回环地址 */
function allowPrivate() {
  return process.env.YUQUE_EXPORT_ALLOW_PRIVATE === '1';
}

function headers(cookie, referer) {
  const h = { 'user-agent': UA, accept: '*/*' };
  if (referer) h.referer = referer;
  if (cookie) {
    h.cookie = /_yuque_session|_yuque/.test(cookie) ? cookie : `_yuque_session=${cookie}`;
  }
  return h;
}

async function getText(url, cookie, referer, timeout = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { headers: headers(cookie, referer), signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 解析页面内嵌的 appData JSON */
function parseAppData(html) {
  const m = /decodeURIComponent\("(.+?)"\)\);/m.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}

/** 拆分语雀 URL：/login/book[/doc] */
function parseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL 格式不正确：' + raw);
  }
  if (!isYuqueHost(u.hostname)) {
    throw new Error('仅支持 yuque.com 域名：' + u.hostname);
  }
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2) throw new Error('URL 需至少包含 “用户名/知识库名”：' + raw);
  const clean = (s) => s.replace(/[?#].*$/, '');
  return {
    login: seg[0],
    bookSlug: seg[1],
    docSlug: seg[2] ? clean(seg[2]) : null,
    canonical: `${HOST}/${seg[0]}/${seg[1]}${seg[2] ? '/' + clean(seg[2]) : ''}`,
  };
}

/** 构造规范的文档地址（login/book/doc），用作 Referer */
function docUrl(login, bookSlug, docSlug) {
  const parts = [login, bookSlug, docSlug]
    .filter(Boolean)
    .map((s) => String(s).replace(/^\/+|\/+$/g, ''));
  return `${HOST}/${parts.join('/')}`;
}

/** 取页面 appData（含 book / doc 元信息与目录树） */
async function fetchContext(url, cookie) {
  const html = await getText(url, cookie, HOST + '/');
  const data = parseAppData(html);
  if (!data) {
    throw new Error(
      '无法解析页面数据。该文档可能不是公开的，或链接无效；私有文档请用 -t 传入语雀 cookie。'
    );
  }
  const book = data.book || {};
  const doc = data.doc || {};
  return {
    bookId: book.id,
    bookName: book.name || '',
    bookSlug: book.slug || '',
    toc: book.toc || [],
    docId: doc.id,
    docSlug: doc.slug || '',
    docTitle: doc.title || '',
    imageDomains: data.space?.imageServiceDomains || data.imageServiceDomains || [],
  };
}

/** 取单篇正文 markdown（sourcecode） */
async function fetchDocBody({ bookId, docSlug, docTitle }, cookie, referer) {
  const qs = new URLSearchParams({
    book_id: String(bookId),
    merge_dynamic_data: 'false',
    mode: 'markdown',
  });
  const url = `${HOST}/api/docs/${docSlug}?${qs}`;
  const text = await getText(url, cookie, referer || `${HOST}/`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('正文接口返回非 JSON，可能触发了风控或需要登录：' + url);
  }
  const d = json.data || {};
  const md = d.sourcecode || d.body || '';
  if (!md) throw new Error('正文为空（文档可能需要登录访问，或内容为特殊挂件）。');
  return { title: d.title || docTitle, markdown: md };
}

/** 清洗 lake 源码：去掉会干扰排版的 inline 标签 */
function cleanLakeSource(md) {
  return md
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/<span[^>]*style="[^"]*"[^>]*>/gi, '<span>')
    .replace(/<span>\s*<\/span>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 markdown 中收集图片地址（`![](...)` 与 `<img src>`） */
function collectImageUrls(markdown) {
  const urls = [];
  const seen = new Set();
  const push = (src) => {
    let u = String(src || '').trim().replace(/^<|>$/g, '');
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  };
  for (const m of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) push(m[2]);
  for (const m of markdown.matchAll(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi)) push(m[2]);
  return urls;
}

/** 下载单张图片，返回 buffer；失败抛错 */
async function fetchImage(url, cookie, referer) {
  const host = new URL(url).hostname;
  if (isPrivateHost(host) && !allowPrivate()) {
    throw new Error('拒绝访问内网地址');
  }
  const toYuque = isYuqueHost(host);
  const res = await fetch(url, {
    // 安全边界：cookie/referer 只发给 yuque.com 系域名，
    // 防止文档内嵌的第三方图片地址把用户的登录态带出去
    headers: headers(toYuque ? cookie : null, toYuque ? referer : null),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error(`体积超限 ${(len / 1048576).toFixed(1)}MB`);
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  // 常见 CDN 会返回 octet-stream；只要不是明确的 HTML/文本，就按图片处理
  if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
    throw new Error('非图片类型 ' + ct);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('空响应');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('体积超限');
  return buf;
}

/**
 * 下载正文图片，并把链接改写为本地相对路径。
 *
 * 关键行为：**先下载，成功后才改写链接**。下载失败的图片保留原始 URL，
 * 保证 Markdown 里不会出现指向不存在文件的死链。
 */
async function downloadImages(markdown, docId, referer, cookie, imgRoot) {
  const dirId = safeName(String(docId || 'doc'), 'doc').slice(0, 64) || 'doc';
  const targetDir = join(imgRoot, dirId);
  const relDir = `./img/${dirId}`;

  const urls = collectImageUrls(markdown);
  if (!urls.length) return { markdown, dir: null, count: 0, failed: [] };

  // 文件名带 URL 短哈希，避免不同 CDN 的同名图片互相覆盖
  const nameOf = new Map();
  const used = new Set();
  urls.forEach((u, i) => {
    let name = urls2name(u, i);
    if (used.has(name)) name = name.replace(/(\.[^.]+)$/, `-${i}$1`);
    used.add(name);
    nameOf.set(u, name);
  });

  const failed = [];
  const okUrls = new Set();
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const buf = await fetchImage(url, cookie, referer);
        await ensureDir(targetDir);
        await writeFile(join(targetDir, nameOf.get(url)), buf);
        okUrls.add(url);
      } catch (e) {
        failed.push(`${url} (${e.message})`);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  const key = (src) => {
    const u = String(src).trim().replace(/^<|>$/g, '');
    return u.startsWith('//') ? 'https:' + u : u;
  };
  const rel = (u) => `${relDir}/${nameOf.get(u)}`;

  let out = markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => {
    const u = key(src);
    return okUrls.has(u) ? `![${alt}](${rel(u)})` : m;
  });
  out = out.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi, (m, pre, src, post) => {
    const u = key(src);
    return okUrls.has(u) ? `<img${pre}src="${rel(u)}"${post}>` : m;
  });

  return { markdown: out, dir: targetDir, count: okUrls.size, failed };
}

/** 由 URL 生成安全、可读、唯一的文件名 */
function urls2name(url, idx) {
  let base = `image-${idx}`;
  try {
    const p = new URL(url).pathname;
    base = decodeURIComponent(p.split('/').pop() || '') || base;
  } catch {
    /* 落到默认名 */
  }
  base = base.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  if (base.length > 60) base = base.slice(0, 60);
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += '.png';
  const ext = /(\.[^.]+)$/.exec(base)[0];
  let stem = base.slice(0, base.length - ext.length) || 'image';
  // Windows 保留设备名（CON/NUL/COM1...）不能作为文件名，加下划线规避
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
  // 短哈希：同一目录下不同来源的同名图片不会互相覆盖
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  return `${stem}-${hash}${ext}`;
}

module.exports = {
  HOST,
  parseUrl,
  docUrl,
  isYuqueHost,
  isPrivateHost,
  collectImageUrls,
  fetchContext,
  fetchDocBody,
  cleanLakeSource,
  downloadImages,
  urls2name,
};
