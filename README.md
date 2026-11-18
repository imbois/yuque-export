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
cd ~/.workbuddy/skills/yuque-export && npm install
```

> 从源码/技能目录运行时**需要先 `npm install`**（`npm i -g` 和 `npx` 会自动装好依赖）。
> CLI 检测到缺依赖时会提示这一句，但不会替你执行安装。

## 用法

```bash
# 单篇，出 Word + PDF
yuque-export "https://www.yuque.com/user/book/doc" --pdf

# 只要 Markdown 和图片
yuque-export "https://www.yuque.com/user/book/doc" --md-only -o ./notes

# 私有文档（浏览器 cookie 里的 _yuque_session）
yuque-export "https://www.yuque.com/user/book/doc" -t "<cookie值>"
# 更推荐：用环境变量，避免 cookie 留在 shell 历史里
YUQUE_COOKIE="<cookie值>" yuque-export "https://www.yuque.com/user/book/doc"

# 整本知识库（默认不会遍历，必须显式 --book）
yuque-export "https://www.yuque.com/user/book/任一公开文档" --book --limit 10
```

| 参数 | 说明 |
|---|---|
| `-o, --out <dir>` | 输出目录，默认 `./output` |
| `--pdf` | 同时生成 PDF（用本机 Chrome/Edge/Chromium 无头打印） |
| `--md-only` | 只导出 Markdown + 图片 |
| `--keep-html` | 保留中间 HTML |
| `-t, --token <值>` | 私有文档需要的语雀 cookie；也可用环境变量 `YUQUE_COOKIE` |
| `--book` | 整本导出（默认关闭） |
| `--limit <n>` | 配合 `--book`，只导出前 n 篇（正整数） |
| `--report [路径]` | 导出结束后写 JSON 结果报告，默认写到输出目录的 `yuque-export-report.json` |
| `-h, --help` | 帮助 |

### 退出码与结果报告（脚本 / Agent 判断用）

| 退出码 | 含义 |
|---|---|
| `0` | 全部成功 |
| `1` | 导出失败：网络 / 权限 / 要求的产物未生成（如 `--pdf` 但本机没有浏览器）。重试可能有用 |
| `2` | 用法或参数错误：URL 不合法、`--limit` 非法、知识库链接未加 `--book` 等。重试无意义 |

`--report` 输出的 JSON 里，顶层 `summary` 给出 `total / succeeded / failed / warnings`，
每个 `items[]` 条目带 `url`、`title`、`ok`、`files`（md/docx/pdf/html 相对路径）、
`images`（下载成功与失败清单）和 `warnings`。判断规则：

- 图片下载失败只记入 `warnings`（Markdown 保留原始链接），**不算失败**；
- `--pdf` 要求了但没生成，**算失败**（退出码 1）；
- Agent / 定时任务请以 `exit code` + 报告文件为准，不要解析终端文本。

## 输出结构

```
output/
├── 文档标题.md      Markdown（图片为相对路径）
├── 文档标题.docx    Word（图片已内嵌）
├── 文档标题.pdf     加了 --pdf 才有
└── img/<docId>/     下载到的图片，文件名形如 logo-3f2a9c1d.png
```

图片名带 URL 短哈希，不同 CDN 上同名的图片不会互相覆盖；下载失败的图片**不会被改写**，
Markdown 里保留原始链接并在终端给出警告——宁可链接是远程的，也不给你一个死链。

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

## 安全性

文档内容属于外部输入，因此做了这些边界限制：

| 风险 | 处理方式 |
|---|---|
| 登录态泄露 | cookie / Referer **只发给 `*.yuque.com`**，第三方图片域名只带通用 UA |
| 读取本机其他文件 | 内嵌图片路径必须落在输出目录内，`../` 越界引用一律跳过；路径检查后再用 `realpath` 确认**符号链接的真实目标**仍在目录内 |
| 借文档探测内网 | 拒绝下载 `localhost` / `10.x` / `172.16-31.x` / `192.168.x` / 链路本地地址；**重定向逐跳复检**，并校验 DNS 解析后的 IP |
| 资源耗尽 | 单张图片 20MB 上限（下载时流式中断；本地文件与 `data:` 内联图片按体积先拦截），30 秒超时 |
| 恶意格式图片 | 只接受 PNG / JPEG / GIF / WebP / BMP / SVG 的**魔数**，拒绝 ICNS、HEIF、JXL 等（防止下游解析器死循环）；网络下载、本地相对路径、文档自带的 `data:` 三条入口走同一套校验 |
| 下游二次请求 | 下载失败的远程图片在生成 HTML 前移除：`html-to-docx` 与打印 PDF 的浏览器都会**自行请求** `<img src="https://…">`，留着等于绕开上述全部校验。原始链接仍保留在 `.md` 里 |
| 打印时执行脚本 | 用 `sanitize-html` 白名单过滤原始 HTML（`<script>` / `<iframe>` / `on*` / `javascript:` 均被清除），PDF 以 `--disable-javascript` 打印 |
| 文件名异常 | 过滤非法字符、避开 Windows 保留设备名（CON/NUL/COM1） |

范围内说明：本工具为**本地命令行程序**，不做服务端部署，因此不涉及 CSRF、鉴权绕过等 Web 攻击面。

### 依赖安全说明（npm audit）

`npm audit --omit=dev` 可能报告 1 个 moderate（`sanitize-html` 相关公告）。这是**为兼容 Node 18 的已知妥协**，说明如下：

- `sanitize-html` 2.17.2 起依赖 ESM-only 的 `htmlparser2@10+`，2.17.6 起更要求 Node ≥ 22.12；本项目锁定 **2.17.1**（最后一个 CJS 版本）以维持 `engines: >=18.4`
- 公告涉及的攻击向量在本项目的配置下**不可达**：`action` / `formaction` / `poster` / `background` / `meta` / `svg` / `textarea` 均不在允许标签与属性白名单内，会被直接剥离
- 输出汇点不执行脚本：docx 由 `html-to-docx` 解析为 OOXML，PDF 打印时 `--disable-javascript`
- 若你的环境只使用 Node ≥ 22.12，可自行升级 `sanitize-html@2.18+` 消除该告警，功能不受影响


## 已知限制

- 语雀的**画板 / 思维导图 / 数据表**是挂件，导出后会变成链接或空白；
- 匿名只适用于**公开文档**；私有/企业库需自带 cookie，并遵守所属组织的数据规定；
- 部分知识库首页不公开，整本导出请用库内任一公开文档链接作入口；
- 请遵守原作者版权，不要将他人文档二次公开发布。

## 常见问题

**Q：报 `HTTP 401` / `找不到正文`？**
该文档不是公开的。用 `-t` 传 cookie，或找作者要权限。

**Q：图片在 Word 里没显示？**
看 `img/<docId>/` 是否有对应文件。需要鉴权的 CDN 图片会下载失败（终端会打印是哪几张），Markdown 里**保留原始链接**；
但 Word/PDF 中该图会被移除 —— `html-to-docx` 与打印 PDF 的浏览器会**自行请求**图片 URL，留着等于绕过下载侧的 SSRF 与格式校验。

**Q：为什么不直接用 pandoc？**
可以，但 pandoc 出 PDF 要装 LaTeX 并配中文字体。本方案零额外系统依赖。

## 目录结构

```
yuque-export/
├── SKILL.md          Agent 技能描述（触发词、用法、排障）
├── RELEASING.md      发布流程（SemVer、标签触发、OIDC 排障）
├── src/
│   ├── cli.js        命令行入口
│   ├── client.js     语雀接口客户端（无第三方 SDK）
│   ├── convert.js    md → html → docx/pdf
│   └── fsutil.js     文件工具（命名安全化、路径边界）
├── test/
│   └── smoke.js      33 项离线测试（含本地 Mock HTTP 下载链路）
├── .github/workflows/
│   ├── ci.yml        测试矩阵（push main / PR）
│   └── publish.yml   v* 标签发布（OIDC）
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
