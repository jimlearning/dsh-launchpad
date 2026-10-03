# dsh-launchpad · 发射台 — 工程架构与技术手册

> 面向 AI Agent 与维护者的完整技术文档。读这一篇即可安全地修改本工程。
> 产品规划与决策推演见 [PLAN.md](./PLAN.md)；本文讲**实现**。

## 0. 六十秒速览

- **是什么**：DeepSeek Harness（DSH）插件。GUI 左上面板栏（`sidebar.panellist`，order 20）注册 🚀 图标，主面板提供：收藏导航、面板内阅读（网页正文提取）、选区↔AI 伴读、可热加载的扩展工具框架、一句话 Forge（AI 造小工具/造扩展）、站点笔记本。
- **形态**：单 npm 包，双 half——host（cordis 插件，Node 进程内）+ client（web 面板，浏览器内）。esbuild 打包成 `lib/index.js` + `lib/client.js`。
- **数据**：`<DSH_HOME>/storages/dsh-launchpad/`（JSON/Markdown/HTML 开放文件，无数据库）。
- **兼容**：DSH 0.2.0-rc.2（其余版本未验证）。
- **验证**：`npm test`（48 单测）、`npm run test:e2e`（Forge 31 断言）、`scripts/itest.sh`（隔离 DSH_HOME 真机启动）。

## 1. DSH 插件模型速成（改本工程前必懂）

1. **插件 = cordis 插件树的一行**。每个 bundle 包的 `cordis.patch.yml` 用 `- insert: - id/name` 插行；行 id 全栈唯一（重复 insert → 下次启动直接崩）。安装：`dsh plugin --profile <p> add file:<路径>`，把包**复制**进 profile node_modules 并把包名 reconcile 进 `dsh.profile.bundles`（bundle 层是**启动时快照**，加新 bundle 必须重启宿主）。
2. **host half**：默认导出 Service 类（或导出 `apply`），loader 以 `(ctx, config)` 构造。`static inject` 声明依赖的宿主服务（tools/llm/agentDefaultModel/timer/webServer/systemPrompt…）。`ctx.effect` 注册清理。
3. **client half**：`lib/client.js` 是 `window.__ModuleLoader__.load({id, factory})` CJS 包裹，导出 `inject`（要注入的客户端服务名）+ `apply(ctx)`。`package.json` 的 `dsh.client.inject` 声明需要的官方 client 包。react/@deepseek-ai/* 全部 external（宿主提供）。
4. **slot 协议**：client 往 slot 注册组件。本工程用 `main`（keyed，中央面板）、`sidebar.panellist`（list，左上图标）、以及自建 session 作用域子 slot `launchpad.chat`（内嵌宿主原生会话）。只碰 `replaceRisk: none` 的座位，**绝不 shadow 官方 UI**。
5. **Remote（typert）**：host 的 `TypertRemoteService` 子类把类方法暴露成 RPC。客户端 `ctx.remote.$mount(描述符)` 后 `ctx.remote.<ns>.<method>(...)` 调用，返回 `{ok, value|error}`。**⚠️ 网关按 host 方法签名元数推导描述符——client 描述符与调用的元数必须三方一致**（见 §10 坑 1，`tests/remote-arity.test.mjs` 静态守门）。
6. **Agent 工具**：`ctx.tools.register(defineTool(...))` 注册模型可调工具。本会话工具表是**会话开始时快照**，热注册的工具只有新会话/子代理可见。
7. **file: 副本不更新**：改代码后必须 `pnpm remove <pkg> && pnpm add file:<新tgz>`（或删副本重装），否则跑的是旧代码（本机实测坑）。

## 2. 仓库地图

```
dsh-launchpad/
├── package.json          # dsh.bundle/client.inject/compatibility + peerDeps（全 optional）
├── cordis.patch.yml      # bundle patch：插入 id=dsh-launchpad 行
├── dsh.plugin.json
├── build.mjs             # esbuild 双 bundle（模板源自 qiaomu-rss-dsh）
├── PLAN.md               # 产品规划与决策（v2）
├── AGENTS.md             # 本文
├── src/
│   ├── shared/           # 【纯】host/client/agent 三方唯一契约
│   │   ├── protocol.js   #   枚举/默认值/id/URL 归一/模板渲染/manifest 校验/路径白名单
│   │   └── templates.js  #   提示词：伴读上下文包裹、Forge 任务、material-card 系统提示
│   ├── host/             # 【Node 进程】除标注外全部纯 Node（无 @deepseek-ai import，可单测）
│   │   ├── index.js      # 入口：default export LaunchpadService
│   │   ├── service.js    # 【非纯】Remote 编排中枢（40+ 方法），唯一的 cordis 组装点
│   │   ├── store.js      # data.json 原子写 + .bak 备份 + 损坏自愈
│   │   ├── fslayout.js   # 目录布局/ensureLayout 幂等自愈/recoveryScan 恢复扫描
│   │   ├── sitefiles.js  # 站点目录文件操作（页面缓存/运行记录/双通道写）
│   │   ├── chat-context.js # 伴读上下文 per-session 存取
│   │   ├── materials.js  # MaterialBundle 构建（page/selection/site）
│   │   ├── reader.js     # 【纯】抓取：SSRF 防护/手动重定向/liveOk 判定
│   │   ├── extract.js    # 【纯】正文提取（JSON-LD>og>meta>title；密度打分选块）
│   │   ├── sanitize.js   # 【纯】HTML 白名单消毒 + htmlToMarkdown/Text
│   │   ├── crawl.js      # 【纯】站点抓取三策略（recent-posts/toc/shallow）
│   │   ├── extensions.js # 【纯】ExtensionRegistry：播种/扫描/热加载/CRUD
│   │   ├── ai.js         # 【非纯】LLM 直出（material-card），支持 cardModel 覆盖
│   │   ├── forge.js      # 【纯】ToolWatcher：tools/ 目录监视（publish 兜底通道）
│   │   ├── tools.js      # 【非纯】10 个 launchpad_* Agent 工具（defineTool）
│   │   └── routes.js     # 【纯】/api/launchpad/* 静态伺服 + 路径防护 + MIME
│   └── client/           # 【浏览器】React（宿主 external），零 npm 依赖
│       ├── index.jsx     # 入口：Remote 描述符 + slot 注册 + api Proxy + api._chat 挂载
│       ├── Panel.jsx     # 骨架：标题/五视图 tab/设置弹层/全局 ForgeBar/state 单一数据源
│       ├── styles.css    # 设计系统：--dsw-alias-* 宿主令牌 + .dlp-root 作用域令牌 + light-dark()
│       ├── views/        # NavView/ReaderView/NotebookView/ExtensionsView/ToolsView
│       ├── components/   # ui.jsx（设计原语）/runner.jsx（扩展运行编排）/ToolFrame.jsx
│       └── companion/    # chat-bridge.js（专属工作区+编程式投递，lead 所有）
│                         # chat.js（会话管理器）/Companion.jsx（伴读侧栏）
│                         # NativeConversation.jsx（宿主会话内嵌，qiaomu 范式）
│                         # selection.js（text-quote 选区锚定）
├── extensions/           # 12 个内置扩展种子（打包进 npm 包，首启播种到数据目录）
├── tests/                # node:test，48 用例全离线（含 remote-arity 契约守门）
└── scripts/
    ├── verify-package.mjs  # 打包门禁
    ├── itest.sh            # 隔离 DSH_HOME 真机启动 + 探活
    └── forge-e2e.mjs       # Forge 全链路 e2e（src 复制+桩 @deepseek-ai，跑真实 service）
```

## 3. 运行时架构与数据流

```
┌─ 浏览器（client half）────────────────────────────────────────┐
│ Panel（listState 单一数据源 + refresh）                        │
│  ├─ Nav/Reader/Notebook/Extensions/Tools 五视图                │
│  ├─ ForgeBar → prepareForge → chat.sendPrompt ────────────┐   │
│  ├─ ReaderView ─ api.openUrl ──────────────┐              │   │
│  ├─ runner.jsx ─ api.runExtension ────────┐│              │   │
│  └─ Companion ─ api._chat.openChat ──┐    ││              │   │
│      └ bindContext（systemPrompt 注入）│    ││              │   │
└───────│──────────────────────────────│────││──────────────│───┘
        │ Remote RPC（typert）          │    ││              │
┌───────▼──────────────────────────────│────││──────────────│───┐
│ LaunchpadService（Node host half）   │    ││              │   │
│  openUrl → reader.fetchAndExtract ───┼────┼│──► 外网       │   │
│  runExtension ─► materials/ai/crawl ─┼────┼│              │   │
│  bindContext ─► companionContexts ───┼────▼│──► systemPrompt 每次调用注入 │
│  prepareForge/publishTool ◄──────────┼─────┼──────────────┘   │
│  ExtensionRegistry ⇄ extensions/    │    │  Agent（伴读/Forge 会话）│
│  ToolWatcher ⇄ tools/        ◄──────┼────┴── 写产物/调 launchpad_* │
│  routes：/api/launchpad/{tool,card} ──► iframe 伺服            │
│  store ⇄ data.json（原子写+.bak）                              │
└────────────────────────────────────────────────────────────────┘
```

三条关键通路（改动前务必理解）：

1. **材料通路**：网页 → `reader.fetchAndExtract`（SSRF/重定向/截断）→ `extract`（元数据+正文块）→ `sanitize` → 缓存到 `sites/<id>/cache/` + 返回面板渲染。选区 → `materials.selectionBundle` → `bindContext` → 写入 `companionContexts[sessionId]` → host 的 `systemPrompt.context` 回调在**每次模型调用**时把 `<launchpad_context>` 注入该会话系统提示。**材料永远不进消息流、不伪造用户消息**，且带防注入声明。
2. **伴读会话通路**：`api._chat.ensureWorkspace()` 自建/自愈专属工作区「🚀 发射台」（修复 qiaomu 会话污染他区的问题）→ `openChat` = `sessions.create/retain` + `uiSession.bindingSource` → `inputActions.setDraft/submit`（**每一步能力嗅探**，失败抛中文错误，UI 降级为"复制提示词手动发"）。站点↔会话映射存 `sites[siteId].chatSessionId`。
3. **Forge 通路**：`prepareForge` 生成自包含任务提示词（产物目录+publish 协议写死在 prompt 里，任何会话可接手）→ agent 开发 → **双通道上架**：主通道 agent 调 `launchpad_publish_tool`；兜底通道 `ToolWatcher` 监视 `tools/<id>/` 目录状态（forging/failed/missing→ready；manifest 消失→missing）。扩展同理：`launchpad_save_extension` 写入 `extensions/<id>/` 即热加载。

## 4. 数据模型与文件布局（韧性规则是契约，不是实现细节）

`data.json`（权威索引；原子写 tmp+rename；写前滚 `.bak`；损坏 → .bak → 空态逐级自愈）：

```
settings  { openLinksIn, chatSendMode, bigTaskSendMode, aiAssist, cardModel,
            updateCheck, allowPrivateNetworks, workspaceId, locale }
groups[]  { id, name, order }
items[]   { id, kind: link|panel|tool, title, url, icon, toolId?, groupId,
            order, pinned, siteId, createdAt, lastOpenedAt }
sites{}   siteId → { baseUrl, title, iconUrl, chatSessionId, ... }
tools{}   toolId → { title, icon, status: forging|ready|failed|missing,
                     sessionId, entry, oneLiner, error, ... }
extensions{} extId → { enabled, source }   # 定义本体在 extensions/<id>/（文件权威）
companionContexts{} sessionId → { text, updatedAt }  # LRU 200
crawlJobs{} jobId → { siteId, strategy, status, pages[], ... }
```

目录（`<DSH_HOME>/storages/dsh-launchpad/`）：

```
workspace/        # 「🚀 发射台」专属工作区（agent cwd；AGENTS.md 工作公约，自动重建）
sites/<st_*>/     # site.json(权威) cache/(可删) notebook/(权威) digests/ cards/ runs/
extensions/<id>/  # extension.json + prompt.md + .seedhash（播种指纹）
tools/<tl_*>/     # index.html + manifest.json（Forge 产物）
assets/favicons/  # 可删重建
tmp/              # 可删
```

韧性五条：①权威/可重建分层（cache/tmp/favicons 随便删）；②启动自愈（ensureLayout 幂等补齐、workspaceId 失效重建、crawlJobs 中断标记 failed）；③恢复扫描 `recoverIndex`（data.json 全丢也能从 site.json/manifest.json/extension.json 重建索引）；④悬空指针 UI 降级（产物缺失显示"重新生成"）；⑤前向兼容（未知字段保留、version 渐进迁移）。

## 5. 扩展系统（本工程的心脏）

扩展 = `extensions/<id>/` 下的 `extension.json` + `prompt.md`。**文件是权威**，data.json 只存 `enabled` 覆盖。

```jsonc
// extension.json schema v1（protocol.validateExtensionManifest 校验，未知字段保留）
{
  "id": "weekly-digest", "name": "最近一周动态", "icon": "📅", "version": 1,
  "source": "builtin|user|agent",       // 决定升级策略（见下）
  "scopes": ["site|page|selection"],     // 出现在哪个上下文的工具轨
  "kind": "chat-task|material-card|local-tool|direct-action",
  "materials": { "crawl": {"strategy": "recent-posts", "sinceDays": 7, "limit": 20}, "maxChars": 24000 },
  "prompt": "prompt.md",                 // 模板变量 {{material.*}} {{selection.quote}} {{date}} {{siteId}}
  "output": { "saveAs": "digests/{{date}}.md", "pin": true, "openAfter": true }
}
```

四种 kind 的执行（`service.runExtension` 是唯一入口，target 经 `validateRunTarget`）：

| kind | 行为 | 内置示例 |
|---|---|---|
| `chat-task` | 构建 MaterialBundle → 渲染 prompt → 返回给 client → 伴读会话 bindContext + （直发/填草稿，按 scope 分设） | 周报、学习路径、总结、追问、选区解释/翻译 |
| `material-card` | host 直接 `ai.complete`（可用 `settings.cardModel` 覆盖模型）→ 写产物文件（`writeSiteOutputFile`：notebook/digests/cards 三前缀）→ 返回路径 | 分享卡、双语卡、思维导图、闪卡 |
| `local-tool` | 返回 toolId + bundle → client 开 ToolFrame（iframe）postMessage 注入 | （预留给交互式产物） |
| `direct-action` | host 直接执行 `action`（当前：`append-highlight`），无 LLM | 选区记笔记 |

- **热加载**：`ExtensionRegistry` fs.watch（失败降级 4s 轮询）→ 300ms 防抖重扫；坏 manifest 条目标 `valid:false`，绝不 throw。
- **播种/升级**：首启把包内 `extensions/` 种子复制到数据目录并写 `.seedhash`；官方升级时若用户未改（哈希匹配）则覆盖，改过则保留。
- **迭代三通路**：面板「✨ 一句话新增扩展」（Forge）、任意会话 `launchpad_save_extension`、手工编辑文件。

## 6. Remote API（namespace `launchpad`；host 签名 ↔ client 描述符元数严格一致）

零参（client 必须 `method(name, false)` 且 0 参调用）：`listState health exportData recoverIndex getWorkspaceInfo listExtensions listTools`
一参（传 `{}` 兜底）：导航 `addItem updateItem removeItem reorderItems pinItem touchOpened addGroup renameGroup removeGroup saveSettings importData`；阅读 `openUrl getCachedPage checkLive startCrawl crawlStatus`；伴读 `saveWorkspaceId bindContext getCompanionSession setCompanionSession`；扩展 `setExtensionEnabled saveExtension removeExtension runExtension listExtensionRuns`；笔记本 `listNotebook readSiteFile writeSiteFile appendHighlight getProgress setProgress`；Forge `prepareForge publishTool reportForge removeTool retryTool`。

**加方法 checklist**：①service 加方法 ②加入 `const names` 导出名单 ③index.jsx 描述符（注意元数！）④跑 `tests/remote-arity.test.mjs`。

## 7. Agent 工具（`tools.js`，10 个；新会话可见）

`launchpad_list_items / add_item / remove_item / list_tools / publish_tool / report_forge / save_extension / remove_extension / run_extension / add_note`。要点：manifest/target 参数是 **JSON 字符串**（工具内 `JSON.parse` 并给中文报错）；`run_extension` 对 chat-task 返回完整 prompt（agent 可自己执行）；`add_note` 走 `writeSiteFile`（notebook 限定）。

## 8. 客户端结构

- `index.jsx`（lead 所有）：Remote 描述符、`main`/`sidebar.panellist`/`launchpad.chat` 三个 slot 注册、`api` Proxy（`api.<m>(params)`；`_chat` 挂真实桥）。**改它=改契约，先读 §10 坑 1**。
- `Panel.jsx`：`listState` 单一数据源 + `refresh()`；视图 keep-alive（hidden 切换，不丢阅读进度与会话）；ForgeBar 流程 `ensureWorkspace → openChat → prepareForge → sendPrompt → 切视图`；forging 中 5s 轮询。
- `runner.jsx`：四种 kind 的完整编排；site 级先 `startCrawl` 轮询 `crawlStatus`（进度回调）再带 `crawlJobId` 运行。
- `Companion.jsx` + `chat.js`：会话管理器——工作区自愈重试、按站点会话复用、**绑定串行队列 + bindKey（`url|quote` 指纹）去重**（扩展下发的 instruction 不会被随后的自动重绑覆盖，防竞态关键设计）。
- 样式：`styles.css` 全量 `--dsw-alias-*` 宿主令牌；`.dlp-root` 作用域令牌（圆角/阴影/遮罩/焦点环/品牌渐变）；硬编码色一律 `light-dark()` 双主题。类名 `dlp-` 前缀。
- iframe 铁律：生成工具/卡片 `sandbox="allow-scripts"`（无 same-origin）；原页 iframe 仅 `liveOk` 可切（host 读 X-Frame-Options/CSP frame-ancestors 判定）。

## 9. 阅读器栈（reader/extract/sanitize/crawl）

- **SSRF**：仅 http/https；`dns.lookup` 校验（可 `lookupImpl` 注入）拒绝 RFC1918/loopback/link-local/CGNAT/组播/IPv6 等价段/`localhost/*.local/*.internal`；手动跟随重定向 ≤5 跳**每跳重校验**；全链 20s；4MB 流式截断；`allowPrivateNetworks` 设置可放行。
- **提取**：元数据 JSON-LD > og/twitter > meta > title（后缀仅在匹配 og:site_name 时剥离）；正文候选按 (段落文本+总文本×0.2)×(1−链接密度) 打分，article/main ×1.2，<200 字降级 body。
- **消毒**：自写容错微型解析器（未闭合/隐含闭合/rawtext/实体）；标签+属性双白名单；危险元素（script/style/iframe/form/svg…）连子树剔除；`java\tscript:` 类绕过防护；`htmlToMarkdown` 供 AI 材料。
- **crawl**：recent-posts（feed 发现→sitemap→shallow 三级兜底，sinceDays 过滤）；toc（同源+路径前缀+保序去重）；shallow（首页+一级链接）。单页失败跳过；`truncated` 标记。
- **liveOk**：XFO DENY/SAMEORIGIN → false；CSP frame-ancestors 非 `*` → false；网络错误 → false。

## 10. 踩坑录（每个都付过学费）

1. **Remote 元数三方一致**：网关按 **host 方法签名**推导描述符。client 描述符多报参 → `unexpected "request"`；少报 → `expected N business argument(s)`。改任何一端后跑 `node --test tests/remote-arity.test.mjs`（静态比对 service 签名/导出名单、index.jsx 描述符/NOARG）。
2. **file: 副本不更新**：重打包后必须 `pnpm remove dsh-launchpad && pnpm add file:<新tgz>`（在 profile 目录下用系统 pnpm 即可；bundle 注册不受影响）。`dsh plugin add` 对同名依赖会 "Already up to date" 不刷新。
3. **写盘双通道**：`writeSiteFile`（Remote/Agent 工具面）只允许 `notebook/`；扩展产物落盘走内部 `writeSiteOutputFile`（notebook/digests/cards）。不要把内部通道暴露成 Remote。
4. **X-Frame-Options 是常态**：GitHub 等大站禁 iframe——阅读模式（正文提取）才是主通路；选区交互也只可能在阅读模式（跨域 iframe 无法捕获选区）。
5. **uiSession.inputActions 版本敏感**：全部能力嗅探 + 中文错误 + 降级（复制 prompt 引导手发）。
6. **工具表快照**：新注册的 agent 工具对进行中的会话不可见——测工具请开新会话或派子代理探针。
7. **asar 解析**：app 内 @deepseek-ai 包在 app.asar 里，普通 node 的 ESM 解析不进去；验证用 `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeek Harness" script.mjs` + `createRequire('/…/app.asar/dsh/package.json')`。e2e 走"复制 src + 桩 @deepseek-ai"路线（`scripts/forge-e2e.mjs`）。
8. **GitHub 直连**：本机无代理时 github.com 超时是环境问题，不是 reader bug（curl 复现即可鉴别）。
9. **面板内链接默认导航 = 窗口劫持炸弹**：阅读 DOM 没有 `<base>`，相对 `href` 会被解析到面板自身 URL；桌面端面板是 `dsh-app:` 协议，未拦截的点击（含 target=_blank）会劫持整个窗口（全屏无法关闭的蒙层，v0.1.4 事故）。铁律：`.dlp-reader` 内所有点击 `preventDefault`，用 `new URL(raw, 文章URL)` 解析，仅 http(s) 开新 tab，其余协议只阻断。

## 11. 测试与验证阶梯（从便宜到决定性）

| 层 | 命令 | 覆盖 |
|---|---|---|
| 单元 | `npm test`（48） | 全部纯模块 + remote-arity 契约 + 路由安全 + 扩展注册表 + reader 栈 |
| Forge e2e | `npm run test:e2e`（31 断言） | 真实 service：Forge 状态机/ToolWatcher/扩展注册运行/10 个 agent 工具 |
| 打包门禁 | `node scripts/verify-package.mjs` | lib 新鲜度/bundle 握手/12 内置扩展合法 |
| 真机隔离启动 | `scripts/itest.sh [port]` | 独立 DSH_HOME 装包 → `dsh web` → `/api/launchpad/health` 探活（重启安全性判据） |
| 活体探针 | 开新会话问 agent「调用 launchpad_list_tools」 | 热注册/工具面真实可用性 |
| patch 校验 | `ELECTRON_RUN_AS_NODE` + `composeEntries`（见 §10.7） | bundle patch 合成合法性 |

改动工作流：改码 → `npm run build` → `npm test && npm run test:e2e` → bump version → `npm pack` → `cd ~/.dsh/profiles/desktop && pnpm remove dsh-launchpad && pnpm add file:<新tgz>` → 重启宿主验证。

## 12. 路线图（接口已预留）

favicon 抓取（assets/favicons 已建）、中英 i18n（locale 服务已注入）、更新检查（settings.updateCheck 已留）、闪卡复习 UI（flashcards.json 已由扩展产出）、local-tool 类内置扩展（kind 通路已通）、站点基址自定义（siteBaseOf 现为 origin/github 特判）。
