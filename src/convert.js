'use strict';
/** Markdown → 带样式 HTML → Word(.docx)，可选 PDF（本机 Chromium 系浏览器无头打印） */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

/** 把 HTML 中的本地相对图片转 base64，确保 docx 单文件内嵌 */
function inlineImages(html, baseDir) {
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  };
  let count = 0;
  const out = html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi, (m, pre, src, post) => {
    if (/^(https?:|data:)/i.test(src)) return m;
    const rel = decodeURIComponent(src.replace(/^\.\//, '').split('#')[0].split('?')[0]);
    const abs = path.resolve(baseDir, rel);
    if (!fs.existsSync(abs)) return m;
    const mime = MIME[path.extname(abs).toLowerCase()] || 'image/png';
    count++;
    return `<img${pre}src="data:${mime};base64,${fs.readFileSync(abs).toString('base64')}"${post}>`;
  });
  return { html: out, count };
}

/** @returns {{html: string, inlined: number}} */
function markdownToHtml(markdown, baseDir) {
  const { marked } = require('marked');
  const body = marked.parse(markdown, { gfm: true });
  const { html, count } = inlineImages(body, baseDir);
  return {
    html: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`,
    inlined: count,
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

function htmlToPdf(html, outPath, baseDir) {
  const exe = browserPath();
  if (!exe) return { ok: false, reason: '未找到 Chrome/Edge/Chromium' };
  const tmp = path.join(baseDir, '.yuque-export-print.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const url = 'file:///' + tmp.replace(/\\/g, '/');
  spawnSync(exe, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${outPath}`, url], { stdio: 'ignore' });
  try { fs.unlinkSync(tmp); } catch {}
  return fs.existsSync(outPath) ? { ok: true } : { ok: false, reason: 'PDF 生成失败' };
}

module.exports = { markdownToHtml, htmlToDocx, htmlToPdf, browserPath, CSS };
