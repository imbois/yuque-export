'use strict';
const fs = require('fs');
const path = require('path');

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function writeFile(file, data) {
  await fs.promises.writeFile(file, data);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i;

/** 文件名安全化：去掉非法字符、压缩空白、限长、避开 Windows 保留名 */
function safeName(name, fallback = 'untitled') {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    // Windows 不接受结尾的空格与点
    .replace(/[. ]+$/, '');
  if (!s) s = fallback;
  const ext = path.extname(s);
  let base = s.slice(0, s.length - ext.length).slice(0, 80).replace(/[. ]+$/, '');
  if (!base) base = fallback;
  // CON / NUL / COM1 这类保留设备名在 Windows 上无法创建
  if (WIN_RESERVED.test(base + ext) || WIN_RESERVED.test(base)) base = '_' + base;
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

/**
 * 目标路径是否仍在基准目录内。
 * 用于阻止 Markdown 里的 `../../` 之类引用读到输出目录之外的文件。
 */
function isInside(baseDir, target) {
  const base = path.resolve(baseDir);
  const abs = path.resolve(target);
  const rel = path.relative(base, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { ensureDir, writeFile, safeName, uniquePath, isInside };
