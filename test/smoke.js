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
  parseUrl, docUrl, isPrivateHost, isPrivateIp, assertPublicTarget, collectImageUrls,
  cleanLakeSource, downloadImages, urls2name, looksLikeImage,
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

/** 本地 Mock：/ok*.png 正常、/bad.png 500、/huge.png 声明超大、/stream-huge.png 无声明流式超大、/loop 302 自环、其余 302 */
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
    if (req.url === '/stream-huge.png') {
      // 不声明 content-length，让体积上限只能靠流式读取拦截
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const total = 21 * 1024 * 1024;
      const timer = setInterval(() => {
        sent += chunk.length;
        if (sent >= total || res.destroyed) {
          clearInterval(timer);
          return res.destroyed ? undefined : res.end();
        }
        res.write(chunk);
      }, 1);
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (req.url === '/evil-icns.png') {
      // ICNS 魔数 + image/* content-type：伪装成图片的恶意格式
      res.writeHead(200, { 'content-type': 'image/x-icns', 'content-length': PNG.length });
      return res.end(Buffer.concat([Buffer.from('icns\x00\x00\x00\x10'), PNG]));
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

  await t('图片魔数白名单（防下游解析器死循环）', () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    assert.ok(looksLikeImage(png), 'PNG 应通过');
    assert.ok(looksLikeImage(Buffer.from('BM\x46\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00')), 'BMP 应通过');
    assert.ok(looksLikeImage(Buffer.from('\xff\xd8\xff\xe0' + '0'.repeat(9), 'latin1')), 'JPEG 应通过');
    assert.ok(looksLikeImage(Buffer.from('GIF89a' + '0'.repeat(7))), 'GIF 应通过');
    assert.ok(looksLikeImage(Buffer.from('RIFF0000WEBP' + '0'.repeat(4))), 'WebP 应通过');
    assert.ok(looksLikeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">...</svg>')), 'SVG 应通过');
    const icns = Buffer.concat([Buffer.from('icns\x00\x00\x00\x10'), png]);
    assert.ok(!looksLikeImage(icns), 'ICNS 应被拒绝');
    const heif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
    assert.ok(!looksLikeImage(heif), 'HEIF 应被拒绝');
    assert.ok(!looksLikeImage(Buffer.from('<script>alert(1)</script>')), '非图片 HTML 应被拒绝');
    assert.ok(!looksLikeImage(Buffer.alloc(8)), '过短数据应被拒绝');
  });

  await t('内网 IP 网段识别（含 IPv6 与 CGNAT）', () => {
    assert.ok(isPrivateIp('127.0.0.1'));
    assert.ok(isPrivateIp('10.1.2.3'));
    assert.ok(isPrivateIp('192.168.0.1'));
    assert.ok(isPrivateIp('172.16.0.1'));
    assert.ok(isPrivateIp('172.31.255.255'));
    assert.ok(isPrivateIp('169.254.1.1'));
    assert.ok(isPrivateIp('100.64.0.1'), 'CGNAT 100.64/10 属保留段');
    assert.ok(isPrivateIp('::1'));
    assert.ok(isPrivateIp('fd00::1234'), 'IPv6 unique local');
    assert.ok(isPrivateIp('fe80::1'), 'IPv6 link local');
    assert.ok(!isPrivateIp('8.8.8.8'));
    assert.ok(!isPrivateIp('172.32.0.1'), '172.32 已超出 172.16/12');
    assert.ok(!isPrivateIp('2001:db8::1'));
  });

  await t('assertPublicTarget 拒绝内网与非 http 协议', async () => {
    // 本测试显式关闭放行开关，走生产校验路径
    process.env.YUQUE_EXPORT_ALLOW_PRIVATE = '0';
    try {
      await assert.rejects(() => assertPublicTarget('http://127.0.0.1:9999/x'), /拒绝访问内网地址/);
      await assert.rejects(() => assertPublicTarget('http://10.0.0.1/x'), /拒绝访问内网地址/);
      await assert.rejects(() => assertPublicTarget('http://192.168.1.1/x'), /拒绝访问内网地址/);
      await assert.rejects(() => assertPublicTarget('ftp://example.com/x'), /不支持的协议/);
    } finally {
      process.env.YUQUE_EXPORT_ALLOW_PRIVATE = '1';
    }
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

  await t('白名单过滤覆盖不带引号的属性与 javascript: 变体', () => {
    const { html } = markdownToHtml(
      '<img src=x.png onerror=alert(1)>\n\n<a href=javascript:alert(2)>点我</a>\n\n<iframe src="//evil.com"></iframe>',
      process.cwd()
    );
    assert.ok(!/onerror/i.test(html), '不带引号的 onerror 应被清除');
    assert.ok(!/javascript:/i.test(html), '不带引号的 javascript: 应被清除');
    assert.ok(!/<iframe/i.test(html), 'iframe 应被整体移除');
    assert.ok(!/evil\.com/i.test(html), 'iframe 内容不应残留');
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

    await t('无 content-length 的流式超限被中断', async () => {
      const dir = tmpDir('stream');
      const r = await downloadImages(`![x](${base}/stream-huge.png)`, 'd', '', null, dir);
      assert.strictEqual(r.count, 0);
      assert.ok(/体积超限/.test(r.failed[0] || ''), '应流式拦截体积超限：' + r.failed[0]);
    });

    await t('重定向循环被中止', async () => {
      const dir = tmpDir('loop');
      const r = await downloadImages(`![x](${base}/loop)`, 'd', '', null, dir);
      assert.strictEqual(r.count, 0);
      assert.ok(/重定向超过/.test(r.failed[0] || ''), '应中止重定向循环：' + r.failed[0]);
    });

    await t('伪装成图片的恶意格式（ICNS）被魔数校验拒绝', async () => {
      const dir = tmpDir('icns');
      const r = await downloadImages(`![x](${base}/evil-icns.png)`, 'd', '', null, dir);
      assert.strictEqual(r.count, 0, '不应下载成功');
      assert.ok(/魔数校验失败/.test(r.failed[0] || ''), '应因魔数白名单失败：' + r.failed[0]);
      assert.ok(r.markdown.includes(`${base}/evil-icns.png`), '失败后保留原始 URL');
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
