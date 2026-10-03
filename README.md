# dsh-launchpad 🚀 发射台

**你的个人工具宇宙** —— DeepSeek Harness 左上角的收藏导航 + 面板内阅读 + 选区伴读 + 可迭代扩展 + 一句话 Forge。

## ✨ 功能

| | |
|---|---|
| 🧭 **导航** | 卡片式收藏网格：网址、内部面板、AI 生成的小工具。分组/搜索/拖拽/置顶，点击即在面板内打开 |
| 📖 **阅读** | 收藏的网址在面板内以阅读模式打开（正文提取+消毒，不怕 X-Frame-Options）；支持原页嵌入与浏览器打开 |
| 💬 **伴读** | 选中任何内容即可与 AI 对话（解释/翻译/举例/记笔记）；伴读会话集中在插件专属的「🚀 发射台」工作区，不污染你的工程列表 |
| 🧩 **扩展** | 站点/页面/选区三级扩展工具：最近一周动态、学习路径、全文总结、双语卡片、出题自测、思维导图、分享卡片……每个扩展就是一个文件夹，热加载，AI 与你都能持续新增迭代 |
| 🛠 **Forge** | 顶部输入框一句话造工具/造扩展：自动建会话 → Agent 开发 → 产物自动上架为面板卡片 |
| 🗂 **笔记本** | 每个站点一份 notebook：学习路线图（可勾选进度）、笔记、高亮、周报、卡片，全部是开放的 Markdown/JSON/HTML 文件 |

## 安装

```bash
dsh plugin --profile desktop add "file:<本仓库绝对路径>"
# 或打包后：dsh plugin --profile desktop add <dsh-launchpad.tgz>
```

重启 DSH（桌面端完全退出重开 / web 端重启 `dsh web`），左上角即出现 🚀 发射台（位于插件、计划任务之下）。

> 兼容：DSH **0.2.0-rc.2**（其余版本未验证）。

## 数据与隐私

全部数据存于 `<DSH_HOME>/storages/dsh-launchpad/`（收藏、站点缓存、笔记本、扩展、工具），JSON/Markdown 开放格式，删除缓存目录不影响功能（详见 PLAN.md 韧性规则）。网页抓取经 SSRF 防护（仅 http/https、默认禁内网）。伴读上下文经 systemPrompt 注入，材料带防注入声明。

## 开发

```bash
npm install
npm run build        # lib/index.js + lib/client.js
npm test             # 单元测试
node scripts/verify-package.mjs   # 打包门禁
scripts/itest.sh     # 隔离环境集成验证（独立 DSH_HOME + 端口 19777）
```

架构与规划：见 [PLAN.md](./PLAN.md)。

## License

MIT
