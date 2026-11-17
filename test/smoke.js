'use strict';
/**
 * 离线测试：不访问真实语雀，用本地 Mock HTTP 服务器覆盖图片下载链路。
 * 运行：node test/smoke.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 生产默认拒绝内网地址；测试需要访问本机回环地址，显式放行
process.env.YUQUE_EXPORT_ALLOW_PRIVATE = '1';

const {
  parseUrl, docUrl, isPrivateHost, collectImageUrls, cleanLakeSource, downloadImages, urls2name,
} = require('../src/client');
const { markdownToHtml, htmlToDocx } = require('../src/convert');
const { safeName, isInside } = require('../src/fsutil');

let passed = 0;
let failed = 0;

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `yq-${tag}-`));
}

/** 本地 Mock：/ok*.png 正常、/bad.png 500、/huge.png 声明超大体积、其余 302 */
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/bad.png') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('boom');
    }
    if (req.url === '/huge.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': 21 * 1024 * 1024 });
      return res.end(PNG);
    }
    if (req.url.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    res.writeHead(302, { location: '/ok.png' });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  console.log(`Node ${process.version}`);

  // ---------- URL 解析 ----------
  await t('单篇 URL 解析', () => {
    const r = parseUrl('https://www.yuque.com/user/book/doc123abc');
    assert.strictEqual(r.login, 'user');
    assert.strictEqual(r.bookSlug, 'book');
    assert.strictEqual(r.docSlug, 'doc123abc');
  });

  await t('知识库 URL 解析（无 docSlug）', () => {
    const r = parseUrl('https://www.yuque.com/user/book');
    assert.ok(!r.docSlug, 'docSlug 应为空');
  });

  await t('URL 带查询参数与锚点', () => {
    const r = parseUrl('https://www.yuque.com/user/book/doc123abc?singleDoc#');
    assert.strictEqual(r.docSlug, 'doc123abc');
  });

  await t('伪造域名应被拒绝（evilyuque.com）', () => {
    assert.throws(() => parseUrl('https://evilyuque.com/user/book/doc'), /仅支持 yuque\.com/);
  });

  await t('缺少知识库段应报错', () => {
    assert.throws(() => parseUrl('https://www.yuque.com/user'), /至少包含/);
  });

  await t('docUrl 按 login/book/doc 拼装', () => {
    assert.strictEqual(docUrl('user', 'book', 'doc2'), 'https://www.yuque.com/user/book/doc2');
  });

  await t('内网地址识别', () => {
    assert.ok(isPrivateHost('127.0.0.1'));
    assert.ok(isPrivateHost('192.168.1.10'));
    assert.ok(isPrivateHost('10.0.0.5'));
    assert.ok(isPrivateHost('localhost'));
    assert.ok(!isPrivateHost('cdn.nlark.com'));
  });

  // ---------- 文本处理 ----------
  await t('清洗 font 标签', () => {
    assert.strictEqual(cleanLakeSource('<font color="red">警告</font>\n\n\n\n正文'), '警告\n\n正文');
  });

  await t('收集图片地址（md 与 html 混排）', () => {
    const md = '![a](https://x.com/1.png)\n\n<img src="https://x.com/2.png">\n\n![b](./local.png)';
    assert.deepStrictEqual(collectImageUrls(md), ['https://x.com/1.png', 'https://x.com/2.png']);
  });

  await t('同名图片生成不同文件名', () => {
    const a = urls2name('https://cdn-a.example.com/logo.png', 0);
    const b = urls2name('https://cdn-b.example.com/logo.png', 1);
    assert.notStrictEqual(a, b, '不同 URL 不应得到同一文件名');
    assert.ok(a.endsWith('.png') && b.endsWith('.png'));
  });

  await t('文件名避开 Windows 保留名', () => {
    assert.ok(safeName('CON').startsWith('_'));
    assert.ok(urls2name('https://x.com/con.png', 0).startsWith('_'));
  });

  await t('isInside 阻挡越界路径', () => {
    const base = path.join(os.tmpdir(), 'yq-base');
    assert.ok(isInside(base, path.join(base, 'img', 'a.png')));
    assert.ok(!isInside(base, path.join(base, '..', 'secret.txt')));
  });

  // ---------- 转换 ----------
  await t('markdown 转 HTML 含标题层级', () => {
    const { html } = markdownToHtml('# 标题\n\n正文 **加粗**', process.cwd());
    assert.ok(/<h1/i.test(html), '应有 h1');
  });

  await t('原始 HTML 中的 script 与事件属性被清除', () => {
    const { html } = markdownToHtml(
      '正文\n\n<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)">',
      process.cwd()
    );
    assert.ok(!/script/i.test(html), '不应残留 script');
    assert.ok(!/onerror/i.test(html), '不应残留事件属性');
  });

  await t('越界图片引用不被内嵌', () => {
    const base = tmpDir('inside');
    const name = `secret-${Date.now()}.txt`;
    const outside = path.join(base, '..', name);
    fs.writeFileSync(outside, 'TOP-SECRET-CONTENT');
    const { html, skipped } = markdownToHtml(`![x](../${name})\n\n<img src="../${name}">`, base);
    assert.strictEqual(skipped, 2, '两张越界图片都应被跳过');
    assert.ok(!html.includes('TOP-SECRET-CONTENT'), '不应把目录外文件内容读进文档');
    fs.unlinkSync(outside);
  });

  await t('生成 docx（离线）', async () => {
    const dir = tmpDir('docx');
    const { html } = markdownToHtml('# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |', dir);
    const out = path.join(dir, 'out.docx');
    const size = await htmlToDocx(html, 'out', out);
    assert.ok(size > 1000, 'docx 应有实际内容');
    assert.ok(fs.existsSync(out));
  });

  // ---------- 图片下载链路（本地 Mock） ----------
  const { server, base } = await startServer();
  try {
    await t('下载成功改写链接，失败保留原始 URL', async () => {
      const dir = tmpDir('img');
      const md = [
        `![ok](${base}/ok.png)`,
        `![bad](${base}/bad.png)`,
        `<img src="${base}/redirect.png">`,
      ].join('\n\n');
      const r = await downloadImages(md, 'doc1', 'https://www.yuque.com/u/b/d', null, dir);

      assert.strictEqual(r.count, 2, '成功 2 张（含 302 重定向）');
      assert.strictEqual(r.failed.length, 1);
      assert.ok(/\.\/img\/doc1\/ok-[0-9a-f]{8}\.png/.test(r.markdown), '成功图片应改为本地相对路径');
      assert.ok(r.markdown.includes(`${base}/bad.png`), '失败图片应保留原始链接');
    });

    await t('声明超大体积的图片被拒绝', async () => {
      const dir = tmpDir('huge');
      const r = await downloadImages(`![x](${base}/huge.png)`, 'd', '', null, dir);
      assert.strictEqual(r.count, 0);
      assert.ok(/体积超限/.test(r.failed[0] || ''), '应因体积超限失败：' + r.failed[0]);
    });

    await t('非图片 content-type 被拒绝', async () => {
      const dir = tmpDir('ct');
      const r = await downloadImages(`![x](${base}/bad.png)`, 'd', '', null, dir);
      assert.strictEqual(r.count, 0);
    });
  } finally {
    server.close();
  }

  await t('全部图片失败时 Markdown 保持原样', async () => {
    const dir = tmpDir('allfail');
    const md = '![x](https://127.0.0.1:1/none.png)';
    const r = await downloadImages(md, 'd2', '', null, dir);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.markdown, md);
  });

  console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : ''}`);
})();
