'use strict';
/** Markdown → 带样式 HTML → Word(.docx)，可选 PDF（本机 Chromium 系浏览器无头打印） */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { isInside } = require('./fsutil');

const CSS = `
body{font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif;font-size:12pt;line-height:1.75;color:#1f2328}
h1{font-size:22pt;border-bottom:2px solid #d0d7de;padding-bottom:8px}
h2{font-size:18pt;border-bottom:1px solid #d0d7de;padding-bottom:6px;margin-top:26px}
h3{font-size:15pt;margin-top:20px}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;white-space:pre-wrap;word-break:break-all}
code{font-family:Consolas,Menlo,monospace;font-size:10pt;background:#f6f8fa;padding:2px 4px;border-radius:4px}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f6f8fa}
img{max-width:88%;border:1px solid #e1e4e8;border-radius:4px;margin:8px 0}
blockquote{border-left:4px solid #d0d7de;margin:12px 0;padding:4px 14px;color:#57606a;background:#f6f8fa}
a{color:#0969da;text-decoration:none;word-break:break-all}
hr{border:none;border-top:1px solid #d0d7de;margin:20px 0}
`;

function browserPath() {
  const cands = [];
  if (process.platform === 'win32') {
    cands.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    cands.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    );
  }
  return cands.find((p) => fs.existsSync(p)) || null;
}

/**
 * 过滤 Markdown 中的原始 HTML：语雀正文可能夹带 <script> / <iframe> /
 * on* 事件属性，生成 HTML 后会交给浏览器打印，必须在之前清掉。
 *
 * 用 sanitize-html 做白名单过滤（正则黑名单覆盖不了不带引号的事件属性等变体）：
 * 只保留 Markdown 渲染需要的标签，属性只放行 src/href 等极少数，方案白名单限定。
 */
const sanitizeHtmlLib = require('sanitize-html');

const SANITIZE_OPTS = {
  allowedTags: [
    ...sanitizeHtmlLib.defaults.allowedTags,
    'img', // 官方默认白名单刻意不含 img，必须显式放行
    'input', // GFM 任务列表的 checkbox
  ],
  allowedAttributes: {
    img: ['src', 'alt', 'title', 'width', 'height'],
    a: ['href', 'name', 'target', 'rel'],
    input: ['type', 'checked', 'disabled'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'], // inlineImages 产出的 base64 图需要 data:
  },
  allowProtocolRelative: false,
};

function sanitizeHtml(html) {
  return sanitizeHtmlLib(html, SANITIZE_OPTS);
}

/**
 * 把 HTML 中的本地相对图片转 base64，确保 docx 单文件内嵌。
 * 只允许读取输出目录内的文件，避免 `../../` 引用把本机其他文件塞进文档。
 */
function inlineImages(html, baseDir) {
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  };
  let count = 0;
  let skipped = 0;
  const out = html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi, (m, pre, src, post) => {
    if (/^(https?:|data:)/i.test(src)) return m;
    let rel;
    try {
      rel = decodeURIComponent(src.replace(/^\.\//, '').split('#')[0].split('?')[0]);
    } catch {
      return m;
    }
    const abs = path.resolve(baseDir, rel);
    if (!isInside(baseDir, abs)) {
      skipped++;
      return m;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return m;
    const mime = MIME[path.extname(abs).toLowerCase()] || 'image/png';
    count++;
    return `<img${pre}src="data:${mime};base64,${fs.readFileSync(abs).toString('base64')}"${post}>`;
  });
  return { html: out, count, skipped };
}

/** @returns {{html: string, inlined: number, skipped: number}} */
function markdownToHtml(markdown, baseDir) {
  const { marked } = require('marked');
  const body = sanitizeHtml(marked.parse(markdown, { gfm: true }));
  const { html, count, skipped } = inlineImages(body, baseDir);
  return {
    html: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`,
    inlined: count,
    skipped,
  };
}

async function htmlToDocx(html, title, outPath) {
  const HTMLtoDOCX = require('html-to-docx');
  const buf = await HTMLtoDOCX(html, null, {
    orientation: 'portrait',
    margins: { top: 1000, right: 1000, bottom: 1000, left: 1000 },
    font: 'Microsoft YaHei',
    fontSize: 22,
    title,
  }, {});
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

/**
 * 用本机 Chromium 系浏览器无头打印 PDF。
 * 注意：先删掉同名旧文件，避免上一次的产物让本次失败被误判为成功。
 */
function htmlToPdf(html, outPath, baseDir) {
  const exe = browserPath();
  if (!exe) return { ok: false, reason: '未找到 Chrome/Edge/Chromium' };

  const tmp = path.join(baseDir, '.yuque-export-print.html');
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    const r = spawnSync(
      exe,
      [
        '--headless', '--disable-gpu', '--disable-javascript',
        '--no-pdf-header-footer', `--print-to-pdf=${outPath}`,
        pathToFileURL(tmp).href,
      ],
      { stdio: 'ignore', timeout: 120000 }
    );
    if (r.error) return { ok: false, reason: r.error.message };
    if (r.status !== 0) return { ok: false, reason: `浏览器退出码 ${r.status}` };
    if (!fs.existsSync(outPath)) return { ok: false, reason: 'PDF 未生成' };
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
  }
}

module.exports = { markdownToHtml, htmlToDocx, htmlToPdf, sanitizeHtml, browserPath, CSS };
