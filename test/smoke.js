'use strict';
/**
 * 离线冒烟测试：不访问网络，只验证纯函数与模块可加载性。
 * 用途：CI 在各 Node 版本上跑，确认语法/API 兼容性没问题。
 * 运行：node test/smoke.js
 */
const assert = require('assert');
const { parseUrl, cleanLakeSource, urls2name } = require('../src/client');
const { markdownToHtml } = require('../src/convert');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

console.log(`Node ${process.version}`);

t('单篇 URL 解析', () => {
  const r = parseUrl('https://www.yuque.com/user/book/doc123abc');
  assert.strictEqual(r.login, 'user');
  assert.strictEqual(r.bookSlug, 'book');
  assert.strictEqual(r.docSlug, 'doc123abc');
});

t('知识库 URL 解析（无 docSlug）', () => {
  const r = parseUrl('https://www.yuque.com/user/book');
  assert.ok(!r.docSlug, 'docSlug 应为空');
  assert.strictEqual(r.bookSlug, 'book');
});

t('URL 带查询参数与锚点', () => {
  const r = parseUrl('https://www.yuque.com/user/book/doc123abc?singleDoc#');
  assert.strictEqual(r.docSlug, 'doc123abc');
});

t('非语雀域名应报错', () => {
  assert.throws(() => parseUrl('https://example.com/a/b'), /仅支持 yuque\.com/);
});

t('缺少知识库段应报错', () => {
  assert.throws(() => parseUrl('https://www.yuque.com/user'), /至少包含/);
});

t('清洗 font 标签', () => {
  const out = cleanLakeSource('<font color="red">警告</font>\n\n\n\n正文');
  assert.strictEqual(out, '警告\n\n正文');
});

t('markdown 转 HTML 含标题层级', () => {
  const { html } = markdownToHtml('# 标题\n\n正文 **加粗**', process.cwd());
  assert.ok(/<h1/i.test(html), '应有 h1');
  assert.ok(/<strong>|加粗/.test(html), '应保留强调');
});

t('urls2name 可导出', () => {
  assert.strictEqual(typeof urls2name, 'function');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
