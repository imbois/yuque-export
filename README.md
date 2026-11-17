# yuque-export

把**语雀公开文档**一键导出为 **Markdown / Word / PDF**，图片真正内嵌，单个文件即可转发给同事。

[![npm](https://img.shields.io/npm/v/yuque-export.svg)](https://www.npmjs.com/package/yuque-export)
[![GitHub](https://img.shields.io/github/stars/imbois/yuque-export?style=social)](https://github.com/imbois/yuque-export)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.4-brightgreen)](https://nodejs.org)

## 为什么需要它

- 语雀官方导出 Word / PDF 需要会员；
- 语雀导出的 Markdown 里图片是**网络链接/相对路径**，发给别人容易裂；
- 把纯 Markdown 导回语雀，图片会丢。

这个工具直接对接语雀公开接口，自己完成 **取正文 → 下载图片 → 内嵌 → 生成 docx / PDF**，
不依赖任何第三方语雀 SDK。导出的 docx 使用 Word 内置标题样式（Heading1-6），
再导回语雀或飞书时**大纲层级能保留**。

## 安装

```bash
# 全局命令行
npm i -g yuque-export

# 或免安装直接用
npx yuque-export "https://www.yuque.com/user/book/doc"
```

作为 AI Agent 技能（WorkBuddy / Claude Code / OpenClaw 等）：把仓库地址发给 Agent，
说「安装这个 Skill」；也可以手动放进技能目录：

```bash
git clone https://github.com/imbois/yuque-export.git ~/.workbuddy/skills/yuque-export
```

## 用法

```bash
# 单篇，出 Word + PDF
yuque-export "https://www.yuque.com/user/book/doc" --pdf

# 只要 Markdown 和图片
yuque-export "https://www.yuque.com/user/book/doc" --md-only -o ./notes

# 私有文档（浏览器 cookie 里的 _yuque_session）
yuque-export "https://www.yuque.com/user/book/doc" -t "<cookie值>"

# 整本知识库（默认不会遍历，必须显式 --book）
yuque-export "https://www.yuque.com/user/book/任一公开文档" --book --limit 10
```

| 参数 | 说明 |
|---|---|
| `-o, --out <dir>` | 输出目录，默认 `./output` |
| `--pdf` | 同时生成 PDF（用本机 Chrome/Edge/Chromium 无头打印） |
| `--md-only` | 只导出 Markdown + 图片 |
| `--keep-html` | 保留中间 HTML |
| `-t, --token <值>` | 私有文档需要的语雀 cookie |
| `--book` | 整本导出（默认关闭） |
| `--limit <n>` | 配合 `--book`，只导出前 n 篇 |
| `-h, --help` | 帮助 |

## 输出结构

```
output/
├── 文档标题.md      Markdown（图片为相对路径）
├── 文档标题.docx    Word（图片已内嵌）
├── 文档标题.pdf     加了 --pdf 才有
└── img/<docId>/     下载到的原始图片
```

## 工作原理

1. 请求文档页 HTML，解析页面内嵌的 `decodeURIComponent(...)` 数据，取出 `book.id`、`doc.slug`；
2. 调 `/api/docs/<slug>?book_id=<bookId>&mode=markdown` 取正文（`sourcecode` 字段）；
3. 清洗 `font` 等内联标签，把图片下载到 `img/<docId>/` 并把链接改成相对路径；
4. Markdown → HTML → docx（`html-to-docx`），可选调用本机浏览器打印 PDF。

> **为什么还需要 book_id？** 语雀取正文的接口签名是 `/api/docs/{slug}?book_id=xxx`，
> 缺少 `book_id` 会返回 200 但正文为空。它是"文档属于哪个库"的标识，
> **不代表要遍历目录**——遍历只在 `--book` 时按目录树进行。

## 环境要求

- **Node.js >= 18.4**（硬性下限，低于此会直接给出提示并退出）
- 生成 PDF 需要本机有 Chrome / Edge / Chromium（没有则自动跳过，只出 docx）

### 为什么下限是 18（而不是 16）

| 依赖项 | 要求 | 说明 |
|---|---|---|
| 全局 `fetch` | Node >= 18 | 不引入 `node-fetch` / `undici`，保持零冗余依赖 |
| `marked@15` | Node >= 18 | 更新的 Markdown 解析（GFM 表格、代码块更准） |
| `html-to-docx` | 无声明 | 实际在 18+ 全绿 |

**不支持 Node 16 及更低的理由**：Node 16 已于 2023-09 停止维护，Node 18/20 也已 EOL，
主流 Agent 运行时（WorkBuddy、Claude Code 等）内置的都是 18/20/22。
若要兼容 16，需要额外引入 fetch polyfill 并把 `marked` 降到 v9，对输出的表格/代码块质量是净损失，
因此选择"明确拒绝"而不是"假装支持"。CI 在 18 / 20 / 22 / 24 四个大版本上验证。

## 已知限制

- 语雀的**画板 / 思维导图 / 数据表**是挂件，导出后会变成链接或空白；
- 匿名只适用于**公开文档**；私有/企业库需自带 cookie，并遵守所属组织的数据规定；
- 部分知识库首页不公开，整本导出请用库内任一公开文档链接作入口；
- 请遵守原作者版权，不要将他人文档二次公开发布。

## 常见问题

**Q：报 `HTTP 401` / `找不到正文`？**
该文档不是公开的。用 `-t` 传 cookie，或找作者要权限。

**Q：图片在 Word 里没显示？**
看 `img/<docId>/` 是否有对应文件。失败的多为需要鉴权的 CDN 图片，md 里会保留原始链接。

**Q：为什么不直接用 pandoc？**
可以，但 pandoc 出 PDF 要装 LaTeX 并配中文字体。本方案零额外系统依赖。

## 目录结构

```
yuque-export/
├── SKILL.md          Agent 技能描述（触发词、用法、排障）
├── src/
│   ├── cli.js        命令行入口
│   ├── client.js     语雀接口客户端（无第三方 SDK）
│   ├── convert.js    md → html → docx/pdf
│   └── fsutil.js     文件工具
├── package.json
├── README.md
└── LICENSE
```

## 支持与打赏

如果这个工具帮你省了时间：

- ⭐ Star 这个仓库
- ☕ 通过 GitHub Sponsors 或爱发电支持我
- 🐛 提 Issue / PR 一起改进

## License

MIT
