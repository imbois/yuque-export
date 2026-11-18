# Changelog

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

## 2.0.0 — 2026-11-17

首个公开版本。完全自研的语雀公开内容客户端（不依赖第三方语雀 SDK）：

- 解析页面 `appData` 取 `book.id` / `doc.slug`，调 `/api/docs/{slug}?mode=markdown` 取正文
- 默认只导出指定单篇，**不遍历**所在知识库；整本导出需显式 `--book`
- 图片下载并内嵌进 docx（单文件可转发），可选调用本机 Chrome/Edge/Chromium 打印 PDF
- docx 使用 Word 内置 Heading 样式，导回语雀/飞书时大纲层级保留
