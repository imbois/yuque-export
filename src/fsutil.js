'use strict';
const fs = require('fs');
const path = require('path');

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function writeFile(file, data) {
  await fs.promises.writeFile(file, data);
}

/** 文件名安全化：去掉非法字符、压缩空白、限长 */
function safeName(name, fallback = 'untitled') {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  if (!s) s = fallback;
  const ext = path.extname(s);
  const base = s.slice(0, s.length - ext.length).slice(0, 80);
  return base + ext;
}

/** 同名文件去重：a.md / a-2.md */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let p = path.join(dir, fileName);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return p;
}

module.exports = { ensureDir, writeFile, safeName, uniquePath };
