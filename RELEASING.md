# 发布流程

本仓库的 npm 发布**只由 Git 标签触发**，且使用 npm Trusted Publishing（OIDC）——仓库里没有任何 npm Token，也没有需要轮换的密钥。

```
改代码 → push main → CI 跑测试（不发布）
       → npm version patch → push main + push 标签 vX.Y.Z
       → Publish 工作流：校验 → 测试 → 打包检查 → OIDC 发布 → 回查 npm
```

## 1. 日常提交

```bash
git add -A
git commit -m "fix: ..."
git push origin main
```

`push main` 只触发 `.github/workflows/ci.yml`（Node 18/20/22/24 + Win/Mac 矩阵、33 项测试、CLI 检查、`npm pack --dry-run`），**不会**发布。发布工作流只监听 `v*` 标签。

## 2. 选择版本号（SemVer）

| 变更类型 | 命令 | 例子 |
|---|---|---|
| 修 bug、安全加固（兼容） | `npm version patch` | 2.0.1 → 2.0.2 |
| 新增兼容功能 | `npm version minor` | 2.0.1 → 2.1.0 |
| 不兼容变更（改 CLI 参数、提 Node 下限等） | `npm version major` | 2.0.1 → 3.0.0 |

`npm version` 会自动改 `package.json`、同步 `package-lock.json`、提交一次并**本地**打上 `vX.Y.Z` 标签（默认前缀 `v`，与工作流匹配）。

## 3. 发布一个版本（patch 示例）

```bash
# 1) 确认工作区干净、main 最新
git status
git pull --ff-only origin main

# 2) 提升版本：生成 commit + 本地标签
npm version patch -m "chore(release): v%s"

# 3) 先推提交，让 CI 跑起来
git push origin main

# 4) CI 绿了再推标签（这一步才真正触发发布）
git push origin v2.0.2
```

第 3、4 步分开是刻意的：如果 CI 挂了，标签还没推出去，删掉本地标签重来即可（`git tag -d v2.0.2`），不会留下一个失败的发布记录。

> 标签必须在 `main` 上：工作流会校验 `git merge-base --is-ancestor <tag> origin/main`，从特性分支打标签会被拒绝。

## 4. 查看发布状态

- 工作流：GitHub → Actions → **Publish**
- npm：<https://www.npmjs.com/package/yuque-export>
- 命令行：

```bash
npm view yuque-export version        # latest 指向的版本
npm dist-tag ls yuque-export
npm view yuque-export@2.0.2 dist.integrity
```

Trusted Publishing 会自动附带 **provenance**（构建来源证明），可在 npm 页面看到 "Built and signed on GitHub Actions"，用 `npm audit signatures` 可校验。

## 5. 发布失败怎么排查

工作流分两段，先看是哪一段红的：

**`verify` 失败**（还没碰到 npm，随便改随便重跑）

| 报错 | 原因 | 处理 |
|---|---|---|
| `标签 vX 与 package.json 版本 Y 不一致` | 标签打错或忘记 `npm version` | `git tag -d vX`，改好后重打 |
| `标签所在提交不在 main 上` | 从分支打的标签 | 合并到 main 后重新打标签 |
| `repository.url 必须与 GitHub 仓库一致` | 改了仓库名/地址 | 修 `package.json` 的 `repository.url` |
| `yuque-export@X 已存在于 npm` | 版本号没提升 | 见下文第 6 节 |
| 测试/打包检查失败 | 代码问题 | 本地 `npm test` 复现 |

**`publish` 失败**

| 报错 | 原因 | 处理 |
|---|---|---|
| `ENEEDAUTH` / `Unable to authenticate` | Trusted Publisher 配置与工作流不匹配 | 见第 8 节，逐字核对仓库名、workflow 文件名、是否勾选 direct publish |
| `403 ... not authorized to publish` | npm 端没允许 `npm publish`（只允许 staged publish） | npm 包设置里勾选允许直接发布 |
| `npm CLI 版本过低` | 运行环境 npm < 11.5.1 | 工作流里已有 `npm install -g npm@11`，一般不会出现 |
| 「复核发布结果」步骤报 `404 No match found for version X` | npm publish 已成功，但 registry 处理新版本有几分钟延迟——**误报失败，不是发布失败** | 新版工作流已内置 20 次 × 15 秒重试；旧日志遇到时先用 `npm view yuque-export@X version` 核实，查得到就忽略红叉。**不要 Re-run**（重复发布只会再失败一次） |
| `E409` / 版本冲突 | 同一版本被并发或重复发布 | 提升版本号 |

失败后修好可以直接在 Actions 页面点 **Re-run jobs**（标签没变，OIDC 身份也不变）；也可以删标签重推。**不要**用 `npm publish --force` 之类的绕过手段——npm 本身也不允许覆盖已发布版本。

## 6. 版本已经存在于 npm 怎么办

**永远不要**试图覆盖已发布版本（registry 也不允许）。正确做法是提升版本号：

```bash
npm version patch        # 2.0.2 → 2.0.3
git push origin main
git push origin v2.0.3
```

如果只是标签打错、代码没问题，而该版本**尚未**发布：删掉远端标签重新打。

```bash
git push origin :refs/tags/v2.0.3   # 删远端标签
git tag -d v2.0.3
npm version patch                   # 得到新版本号
```

## 7. 已发布版本的安全修复

补丁版本直接发，不必等下一个功能版本，也不必改已发布的内容：

```bash
git switch -c fix/security-xxx main
# 改代码 + 补测试
npm test
git commit -am "fix(security): ..."
git switch main && git merge --no-ff fix/security-xxx
npm version patch -m "chore(release): v%s"
git push origin main
git push origin v2.0.2
```

如果问题严重，先在 GitHub 发 Security Advisory 再发版；`CHANGELOG.md` 里写清受影响的版本区间和缓解方式。

## 8. Trusted Publisher 失效时如何恢复

先判断是"配置漂移"还是"权限被回收"：

1. 打开 <https://www.npmjs.com/package/yuque-export/access>（或用 `npm owner ls yuque-export` 确认自己仍是 owner）。
2. 在 **Trusted Publisher** 区块核对四个字段，必须**逐字**匹配：
   - Organization or user：`imbois`
   - Repository：`yuque-export`
   - Workflow filename：`publish.yml`（只写文件名，带 `.yml`）
   - Environment name：留空（除非工作流里声明了 `environment:`，两处必须一致）
3. 确认 **Allowed actions** 里勾选了 `npm publish`（只勾 staged publish 时，`npm publish` 会 403）。
4. 删掉旧的 Trusted Publisher 重新添加一次最省事——npm 保存时不校验，写错了只有发布时才报错。

改仓库名、改工作流文件名、把仓库转为私有都会让授权失效，需要同步更新这里。**不要**为了图快改回长期 Token：一旦引入了 token，就多了一个需要轮换的密钥。

## 9. 首次配置（只需做一次）

1. 打开 <https://www.npmjs.com/package/yuque-export/access> → Trusted Publisher → 选 **GitHub Actions**。
2. 按第 8 节的四个字段填写，勾选允许 `npm publish`，保存。
3. 不需要在 GitHub 里加任何 secret，也不需要 `NPM_TOKEN`。

## 附：版本历史中的一个例外

`v2.0.1` 的标签指向 `3486c2d`，而 npm 上的 2.0.1 实际由 `bf44cc4`（多 5 个提交，含 sanitize-html 锁版与安全加固）构建——当时是手动 `npm publish`，标签没有跟着走。该版本无法重新发布，因此不回改历史；**从下一个版本起，标签就是发布源**，工作流会强制两者一致。

如需让历史标签也对齐（会重写已推送的标签，协作者需要重新 fetch）：

```bash
git tag -f v2.0.1 bf44cc4
git push origin :refs/tags/v2.0.1
git push origin v2.0.1
```
