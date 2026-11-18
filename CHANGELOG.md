# Changelog

## 2.0.3 — 2026-11-18

导出结果的准确反馈——让脚本与 AI Agent 不再解析终端文本就能判断结果。

### 新增

- **退出码契约**：`0` 全部成功；`1` 导出失败（网络 / 权限 / 要求的产物未生成）；`2` 用法或参数错误（URL 不合法、`--limit` 非法、知识库链接未加 `--book`）。**行为变化**：整本模式部分失败不再静默返回 0；"没给 URL"从 1 改为 2
- **`--report [路径]`**：导出结束写一份 JSON 结果报告（默认 `输出目录/yuque-export-report.json`）：顶层 `summary.total/succeeded/failed/warnings`，每个 `items[]` 条目含 `url`、`title`、`ok`、`files`（md/docx/pdf/html 相对路径）、`images`（成功与失败清单）与 `warnings`
- 整本模式每篇失败会给出失败原因汇总，结尾输出「成功 X，失败 Y」

### 修复

- **整本模式的 PDF 结果不再被忽略**：此前 `--pdf` 失败连返回值都不接，静默丢失；现在计入失败与报告
- **`--pdf` 要求了但未生成 → 退出码 1**（行为变化）：本机没有 Chrome/Edge 时不再只打一行"跳过"，无人值守任务能正确感知

### 判断规则

- 图片下载失败只计入 `warnings`（Markdown 保留原始链接），不算失败
- 要求的 PDF 未生成算失败

### 其他

- `cli.js` 改为 `require.main` 守卫启动，可被测试/工具复用
- 测试扩到 **38 项**（新增 `--report` 解析、UsageError、buildReport 汇总、退出码契约子进程验证）

## 2.0.2 — 2026-11-18

无 CLI 行为变更，本版本是发布基础设施版本：

- **自动化发布**：新增 `.github/workflows/publish.yml`，推送 `v*` 标签时经 npm Trusted Publishing（OIDC）自动发布；普通 push main 只跑测试，不触发发布。发布前校验：标签版本与 `package.json` 一致、标签提交在 main 上、`repository.url` 与仓库一致、版本未存在于 npm
- 仓库内**零密钥**：不使用任何长期 npm Token，OIDC 换取短时凭证，发布自动附带 provenance
- 新增 `RELEASING.md`（发布流程、失败排查、Trusted Publisher 恢复）
- README：修正「图片在 Word 里没显示」的说明，与实际行为一致（下载失败的远程图不再进入 Word/PDF）

## 2.0.1 — 2026-11-17

发布前代码审查（code review）整改版本。**无 API 变更**，全部为行为修正与加固。

### 修复

- **图片下载失败仍改写链接**：改为「先下载、成功后才改写」，失败的图片在 Markdown/Word 中保留原始 URL，与 README 描述一致
- **同名图片互相覆盖**：图片文件名追加 URL 短哈希（`logo-3f2a9c1d.png`），不同 CDN 的同名图片不再冲突
- **`--book` 的 Referer 拼接错误**：整本导出时 Referer 会误拼成 `…/doc1/doc2`，且单篇模式缺少用户名段；现统一由 `login/book/doc` 构造
- **PDF 误报成功**：先删除同名旧文件，再检查子进程 `status`/`error`，改用 `pathToFileURL()`，并用 `try/finally` 清理中间 HTML
- **`--book` 忽略 `--keep-html`**：单篇与整本流程现在一致
- **`--limit` 非法值**：`-1`、`abc`、`0` 现在直接报错，不再静默变成"全部导出"
- **域名校验不严**：`/yuque\.com$/` 会放过 `evilyuque.com`，改为精确匹配 `yuque.com` 及其子域
- **Windows 保留文件名**：文档标题与图片名都会避开 `CON`/`NUL`/`COM1` 等设备名，并去掉结尾的空格与点号

### 安全加固

- **目录穿越**：内嵌图片路径必须位于输出目录内，Markdown 中 `../../` 形式的引用会被跳过，不再读取本机任意文件
- **SSRF 与资源耗尽**：拒绝访问 `localhost`/内网/链路本地地址；单张图片 20MB 上限、30 秒超时；校验 `content-type` 与空响应
- **打印时执行脚本**：生成 HTML 前清除 `<script>` / `<iframe>` / `on*` 事件属性，PDF 以 `--disable-javascript` 打印
- **cookie 暴露面**：新增 `YUQUE_COOKIE` 环境变量，避免 cookie 留在 shell 历史与进程参数中

### 变更

- **移除 CLI 的自动 `npm install`**：全局安装时可能误判依赖缺失并污染安装目录；现在只给出可执行的安装提示
- **测试从 8 项扩到 20 项**：新增本地 Mock HTTP 服务器覆盖下载成功/失败/超限/非图片类型、越界引用拦截、XSS 清洗、离线 docx 生成等
- CI 由 `npm install` 改为 `npm ci`

### 第二轮审查整改（2026-11-18，同为 2.0.1）

- **重定向绕过 SSRF 校验**：图片/页面请求改为 `redirect: 'manual'` 手动逐跳跟随（上限 5 跳），每一跳重新做协议、内网主机名与 **DNS 解析后 IP** 校验，重定向循环直接中止；跨域跳转一律剥离 cookie/referer
- **正则 sanitize 换为白名单库**：`sanitizeHtml` 由正则黑名单改为 [`sanitize-html`](https://github.com/apostrophecms/sanitize-html) 白名单过滤，覆盖不带引号的事件属性、`javascript:` 变体等正则覆盖不了的情况（新增依赖，**锁定 2.17.1**）
- **CI：修复 Node 18 失败**：sanitize-html 自 2.17.2 起依赖 ESM-only 的 htmlparser2@10+（2.17.6+ 更要求 Node ≥ 22.12），Node 18 不支持 `require(ESM)` 导致 CI 挂掉；锁定最后一个 CJS 兼容版 sanitize-html@2.17.1（htmlparser2@^8，纯 CJS）以维持 `engines: >=18.4` 承诺。本地已用 Node 18.20.8 实测 25 项测试与端到端导出全过
- **图片体积流式限读**：不再先读完整个响应体再判断，边读边检查 20MB 上限并中断连接，无 `content-length` 的恶意响应同样被拦截
- **同步 package-lock.json**：lock 顶层版本号已与 package.json 一致（2.0.1）
- 测试扩到 25 项（新增内网 IP 网段/IPv6、重定向循环、流式超限、无引号属性过滤等）

### 发布前依赖安全评估（2026-11-18）

针对 `npm audit --omit=dev` 的两个告警：

- **image-size（High，经 html-to-docx 传递）→ 已实质封堵**：html-to-docx 的 dist **内嵌**了 image-size v1 的解析器，仅 `overrides` 升级外部依赖只能清告警、修不了真实路径。因此在下载侧新增**图片魔数白名单**（仅 PNG/JPEG/GIF/WebP/BMP/SVG），ICNS/HEIF/JXL 一律拒绝；源 Markdown 自带的 `data:` 图片同样校验。另加 `overrides: image-size@^2.0.3` 清掉独立依赖告警
- **sanitize-html（Moderate）→ 保留 2.17.1 的兼容性妥协**：公告向量（`action`/`formaction`/`poster`/`background`/`meta`/`svg`/`textarea`）不在本项目白名单内，不可达；输出汇点（docx 解析、`--disable-javascript` 打印）不执行脚本。README 增补“依赖安全说明”记录取舍
- 测试扩到 **27 项**（新增魔数白名单单测与 ICNS 伪装下载拦截）

### 第三轮审查整改：内嵌图片入口统一校验（2026-11-18，同为 2.0.1）

前一轮的魔数白名单只覆盖了「网络下载」和「data: 头部 512 字节」，另有两条入口漏检，本轮补齐：

- **本地相对路径图片**：`inlineImages()` 原先 `readFileSync` 后直接转 base64，既不验魔数也不看体积。现在与下载侧共用 `inspectImage()`（≤20MB + 魔数白名单），MIME 也改由魔数推导 —— `a.png` 实际是 JPEG 时按 `image/jpeg` 标注
- **`data:` 图片不限体积**：改为先按 base64 字符数折算解码后体积（不为超大字符串分配 buffer），再判魔数；超限直接移除该 `<img>`
- **符号链接绕过目录边界**：`isInside()` 只看字面路径，`out/pkg -> D:\secrets` 这类链接仍能读到目录外文件。现在路径检查通过后再用 `realpath` 复核真实目标；基准目录本身也做 `realpath`，避免 macOS `/var → /private/var` 把合法文件误判成越界
- 不合格图片统一从输出中移除并计入 `skipped`，CLI 提示改为「下载失败，或未通过越界/格式/体积校验」
- **远程图片被下游二次请求（实测确认）**：`html-to-docx` 会自己发起 http/https 请求取图（本地起服务打点，收到 2 次请求），打印 PDF 的浏览器同理。下载失败的 `<img src="https://…">` 因此能绕过 SSRF 与魔数校验——现在生成 HTML 前直接移除，原始链接仍保留在 `.md` 中
- 测试扩到 **33 项**（新增远程图二次请求、本地伪装图片、MIME 取自魔数、本地超大图片、`data:` 超限与魔数、目录符号链接越界）

## 2.0.0 — 2026-11-17

首个公开版本。完全自研的语雀公开内容客户端（不依赖第三方语雀 SDK）：

- 解析页面 `appData` 取 `book.id` / `doc.slug`，调 `/api/docs/{slug}?mode=markdown` 取正文
- 默认只导出指定单篇，**不遍历**所在知识库；整本导出需显式 `--book`
- 图片下载并内嵌进 docx（单文件可转发），可选调用本机 Chrome/Edge/Chromium 打印 PDF
- docx 使用 Word 内置 Heading 样式，导回语雀/飞书时大纲层级保留
