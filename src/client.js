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
const { ensureDir, writeFile } = require('./fsutil');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOST = 'https://www.yuque.com';

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
  if (!/yuque\.com$/.test(u.hostname)) {
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

/** 下载正文中的图片，改写为相对路径（默认 ./img/{docId}/） */
async function downloadImages(markdown, docId, referer, cookie, imgRoot) {
  const seen = new Map();
  const tasks = [];
  const targetDir = `${imgRoot}/${docId}`;

  const collect = (raw) => {
    let url = raw.trim().replace(/^<|>$/g, '');
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  };

  const rewrite = (url) => {
    if (!seen.has(url)) {
      const name = urls2name(url, seen.size);
      seen.set(url, name);
      tasks.push({ url, name });
    }
    return `./img/${docId}/${seen.get(url)}`;
  };

  let out = markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => {
    const u = collect(src);
    if (!u) return m;
    return `![${alt}](${rewrite(u)})`;
  });
  out = out.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi, (m, pre, src, post) => {
    const u = collect(src);
    if (!u) return m;
    return `<img${pre}src="${rewrite(u)}"${post}>`;
  });

  if (!tasks.length) return { markdown: out, dir: null, count: 0, failed: [] };

  const failed = [];
  const limit = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      try {
        // 安全边界：cookie/referer 只发给 yuque.com 系域名，
        // 防止文档内嵌的第三方图片地址把用户的登录态带出去
        const toYuque = /^https?:\/\/([^/]+\.)?yuque\.com\//i.test(t.url);
        const res = await fetch(t.url, {
          headers: headers(toYuque ? cookie : null, toYuque ? referer : null),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(String(res.status));
        const buf = Buffer.from(await res.arrayBuffer());
        await ensureDir(targetDir);
        await writeFile(join(targetDir, t.name), buf);
      } catch (e) {
        failed.push(`${t.url} (${e.message})`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));

  return { markdown: out, dir: targetDir, count: tasks.length - failed.length, failed };
}

function urls2name(url, idx) {
  try {
    const p = new URL(url).pathname;
    let base = decodeURIComponent(p.split('/').pop() || '');
    base = base.replace(/[\\/:*?"<>|]/g, '_');
    if (!base || base.length > 80) base = `image-${idx}`;
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += '.png';
    // Windows 保留设备名（con/aux/nul/com1...）无法作为文件名
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) base = '_' + base;
    return base;
  } catch {
    return `image-${idx}.png`;
  }
}

module.exports = {
  HOST,
  parseUrl,
  fetchContext,
  fetchDocBody,
  cleanLakeSource,
  downloadImages,
  urls2name,
};
