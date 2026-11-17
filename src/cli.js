#!/usr/bin/env node
'use strict';
process.noDeprecation = true; // 屏蔽依赖库的 punycode 弃用告警
/**
 * yuque-export —— 语雀公开文档导出为 Markdown / Word / PDF
 *
 * 默认只导出你指定的那一篇，不会遍历它所在的知识库。
 * 需要整本时才加 --book。
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, safeName, uniquePath } = require('./fsutil');
const {
  parseUrl, fetchContext, fetchDocBody, cleanLakeSource, downloadImages,
} = require('./client');
const { markdownToHtml, htmlToDocx, htmlToPdf } = require('./convert');

const VERSION = require('../package.json').version;

const MIN_NODE_MAJOR = 18;

/** 低于最低版本时给出可读提示，而不是 "fetch is not defined" */
function assertNode() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return;
  console.error(
    `\n需要 Node.js ${MIN_NODE_MAJOR} 或更高版本，当前为 ${process.version}。\n` +
    '  原因：使用全局 fetch 与 marked@15。\n' +
    '  升级：https://nodejs.org/zh-cn/download  ' +
    '或  nvm install 22 && nvm use 22\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    out: 'output', pdf: false, keepHtml: false, token: null, url: null,
    book: false, limit: 0, mdOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '--pdf') o.pdf = true;
    else if (a === '--keep-html') o.keepHtml = true;
    else if (a === '-t' || a === '--token') o.token = argv[++i];
    else if (a === '--book') o.book = true;
    else if (a === '--md-only') o.mdOnly = true;
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 0;
    else if (!a.startsWith('-')) o.url = a;
  }
  return o;
}

function help() {
  console.log(`
yuque-export v${VERSION} —— 语雀公开文档导出为 Markdown / Word / PDF

用法：
  yuque-export "<语雀文档URL>" [选项]

默认只导出这一篇文档，不会遍历它所在的知识库。

选项：
  -o, --out <dir>     输出目录（默认 ./output）
  --pdf               同时生成 PDF（需本机有 Chrome/Edge/Chromium）
  --md-only           只导出 Markdown 与图片，不生成 Word/PDF
  --keep-html         保留中间 HTML
  -t, --token <值>    私有文档所需的语雀 cookie（_yuque_session）
  --book              导出整本知识库（默认关闭）
  --limit <n>         配合 --book，最多导出前 n 篇
  -h, --help          显示帮助
  -v, --version       显示版本号

示例：
  yuque-export "https://www.yuque.com/user/book/doc"
  yuque-export "https://www.yuque.com/user/book/doc" --pdf -o ./notes
  yuque-export "https://www.yuque.com/user/book" --book --limit 5
`);
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

/** 依赖自举：从 zip 安装时没有 node_modules，首次运行自动补齐 */
function ensureDeps() {
  const root = path.resolve(__dirname, '..');
  const missing = ['marked', 'html-to-docx'].filter(
    (m) => !fs.existsSync(path.join(root, 'node_modules', m))
  );
  if (!missing.length) return;
  log('0/3', `首次运行，安装依赖（${missing.join(', ')}）...`);
  const r = require('child_process').spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: root, shell: true, stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`依赖安装失败，请手动执行：cd "${root}" && npm install`);
  }
}

/** 导出单篇：下载正文+图片，写 md，转 docx/pdf */
async function exportDoc(ctx, docSlug, docTitle, outDir, opts, stepLabel) {
  const referer = `https://www.yuque.com/${ctx.bookSlug}/${docSlug}`;
  const body = await fetchDocBody(
    { bookId: ctx.bookId, docSlug, docTitle }, opts.token, referer
  );
  const md = cleanLakeSource(body.markdown);
  const imgs = await downloadImages(md, ctx.docId || docSlug, referer, opts.token, path.join(outDir, 'img'));

  const title = safeName(body.title || docTitle || 'untitled');
  const mdPath = uniquePath(outDir, title + '.md');
  fs.writeFileSync(mdPath, imgs.markdown, 'utf8');
  log(stepLabel, `md   : ${path.basename(mdPath)}`);

  if (imgs.count) log(stepLabel, `图片 : ${imgs.count} 张已下载` + (imgs.failed.length ? `，${imgs.failed.length} 张失败` : ''));
  imgs.failed.slice(0, 3).forEach((f) => console.warn('        ! ' + f));

  if (opts.mdOnly) return mdPath;

  const base = mdPath.replace(/\.md$/, '');
  const { html, inlined } = markdownToHtml(imgs.markdown, outDir);
  if (opts.keepHtml) fs.writeFileSync(base + '.html', html, 'utf8');

  const docxPath = base + '.docx';
  const size = await htmlToDocx(html, path.basename(base), docxPath);
  log(stepLabel, `docx : ${path.basename(docxPath)} (${Math.round(size / 1024)}KB, 内嵌图片 ${inlined} 张)`);

  if (opts.pdf) {
    const r = htmlToPdf(html, base + '.pdf', outDir);
    log(stepLabel, r.ok ? `pdf  : ${path.basename(base)}.pdf` : `pdf  : 跳过（${r.reason}）`);
  }
  return docxPath;
}

async function main() {
  assertNode();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) return console.log(VERSION);
  // 显式 -h/--help 视为正常退出（exit 0），没给 URL 才是用法错误（exit 1）
  if (opts.help) { help(); process.exit(0); }
  if (!opts.url) { help(); process.exit(1); }

  const parts = parseUrl(opts.url);
  const outDir = path.resolve(opts.out);
  await ensureDir(outDir);
  ensureDeps();

  if (!opts.book) {
    if (!parts.docSlug) {
      throw new Error('这是一个知识库链接。若要整本导出请加 --book；否则请给出具体文档链接。');
    }
    log('1/2', `读取文档：${parts.docSlug}`);
    const ctx = await fetchContext(parts.canonical, opts.token);
    if (!ctx.docSlug) throw new Error('页面中未找到文档信息，可能是知识库首页；单篇导出请使用具体文档链接。');
    ctx.docId = ctx.docId || ctx.docSlug;
    log('2/2', `生成文件到 ${outDir}`);
    await exportDoc(ctx, ctx.docSlug, ctx.docTitle, outDir, opts, '  →');
    console.log('\n完成。');
    return;
  }

  // 整本模式（显式 --book 才会走这里）
  log('1/3', `读取知识库：${parts.login}/${parts.bookSlug}`);
  let ctx;
  try {
    ctx = await fetchContext(parts.canonical, opts.token);
  } catch (e) {
    throw new Error(
      '读取知识库失败：' + e.message +
      '\n提示：部分语雀知识库的首页不公开，请改用库内任意一篇公开文档的链接加 --book。'
    );
  }
  if (!ctx.toc.length) throw new Error('未读取到目录。该知识库可能不公开，请用 -t 传入 cookie。');

  const docs = ctx.toc.filter((t) => t.type === 'DOC' && t.visible !== false && t.url);
  const list = opts.limit > 0 ? docs.slice(0, opts.limit) : docs;
  const bookDir = path.join(outDir, safeName(ctx.bookName || parts.bookSlug));
  await ensureDir(bookDir);

  log('2/3', `目录 ${docs.length} 篇` + (opts.limit ? `，本次处理前 ${list.length} 篇` : ''));

  const index = [];
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const label = `  (${i + 1}/${list.length})`;
    try {
      const body = await fetchDocBody({ bookId: ctx.bookId, docSlug: item.url, docTitle: item.title }, opts.token, `${parts.canonical}/${item.url}`);
      const md = cleanLakeSource(body.markdown);
      const imgs = await downloadImages(md, item.uuid || item.url, `${parts.canonical}/${item.url}`, opts.token, path.join(bookDir, 'img'));
      const mdPath = uniquePath(bookDir, safeName(body.title || item.title) + '.md');
      fs.writeFileSync(mdPath, imgs.markdown, 'utf8');
      log('   ', `${label} ${path.basename(mdPath)}`);

      if (!opts.mdOnly) {
        const base = mdPath.replace(/\.md$/, '');
        const { html } = markdownToHtml(imgs.markdown, bookDir);
        await htmlToDocx(html, path.basename(base), base + '.docx');
        if (opts.pdf) htmlToPdf(html, base + '.pdf', bookDir);
      }
      index.push({ title: body.title || item.title, file: path.basename(mdPath) });
      ok++;
    } catch (e) {
      const hint = /HTTP 40[134]/.test(e.message) ? '（该篇未公开，需登录权限；可加 -t 传 cookie）' : '';
      console.warn(`    ${label} 跳过：${e.message}${hint}`);
    }
  }

  const indexMd = ['# ' + (ctx.bookName || parts.bookSlug), '', ...index.map((x) => `- [${x.title}](${encodeURI(x.file)})`)].join('\n') + '\n';
  fs.writeFileSync(path.join(bookDir, 'index.md'), indexMd, 'utf8');

  log('3/3', `完成 ${ok}/${list.length} 篇 → ${bookDir}`);
}

main().catch((e) => {
  console.error('\n失败：' + e.message);
  if (/HTTP 40[13]/.test(e.message)) console.error('提示：该文档可能需要登录，请用 -t 传入语雀 cookie。');
  process.exit(1);
});
