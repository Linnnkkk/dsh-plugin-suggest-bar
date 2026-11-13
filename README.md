# dsh-plugin-suggest-bar —— 输入框上方「建议」栏

回合结束后，用一次异步小调用预测用户接下来可能说的话（**最多 3 条，卡上可循环切换**），显示在输入框上方；点「采用」填入输入框、「发送」直接发出、✕ 本回合不再弹。模型没把握时输出 `NONE`，本回合不出卡。两段式体验（回复先到手、建议异步补弹）在**所有 dsh 会话**的补齐实现（对自带建议能力的会话，默认跳过）。

![回合结束，输入框上方出现下一句建议](assets/screenshot-1.png)

![设置页可选 provider、模型与思考档位](assets/screenshot-2.png)

## 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | host 侧：监听 `session/event`（turn/end→fire-and-forget 生成；turn/start→作废旧建议）、注册表（落盘 suggestions.json）、三条 HTTP 路由、config.json 读写 |
| `client.js` | 浏览器侧：`conversation.input.dock` 槽渲染建议卡（打字折叠/清空展开）、`settings.section` 槽渲染设置面板、700ms 轮询 |
| `cordis.patch.yml` | bundle 行 + **首启种子配置**（此后以 config.json 为准） |
| `package.json` | `dsh.bundle` / `dsh.client` 声明、peer 依赖 |
| `config.json` | **运行配置**（首启自动从种子生成；设置面板改的就是它） |

## 架构（两段式）

```
回合结束(turn/end completed)
  → host: 有界辅助 LLM 调用（输入=最近几轮对话，含前 3 条用户消息；助手回复去噪后按预算截取 / 输出 1–3 行各≤120字，`NONE`=不出卡 / 思考档位：设置里测过就直接用，否则按模型能力自动取最省一档，兜底 off→low→不传）
  → 按行解析成 1–3 条 → 存注册表（会话id → {turn, texts[]}），500ms 防抖落盘 suggestions.json（最多 200 个会话）
  → 浏览器每 700ms POST /api/suggest-bar 读取
  → 输入框上方渲染建议卡（跑动中/打字中/已关闭 → 折叠）
用户发消息(turn/start)
  → 旧建议立即作废 + 中止在途生成
```

## 生成路由

- 路由候选：**config.json 配置的 provider+model 优先**（在设置面板里选），失败回退**继承会话当前路由**
- `skipProviders`（默认 `[claude-code]`）：会话主模型属于这些 provider 时不生成（这些会话通常自带原生建议，避免双份）

## 路由（connection.fetch）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/suggest-bar` | POST `{sessionId}` | 读当前建议（回合运行中返回 null） |
| `/api/suggest-bar/config` | POST（空体=读，带字段=合并写） | 设置面板读写 config.json |
| `/api/suggest-bar/options` | POST | 枚举 `llm.listProviders()`/`listModels()`（设置下拉） |

## 设置（dsh 设置页 → 「建议栏」节）

provider（下拉识别）/ 模型（下拉联动）/ 标签文案 / **思考档位**（自动探测 ｜ off ｜ low ｜ 不传，旁边有「测试」按钮：真发一次极短请求，依次试 off / low / 不传，把该模型能用的档位写进配置，只需测一次）/ 跳过的 provider / **生成时机**（每次都生成 ｜ 仅对话在前台时，切走不生成、回来自动补一次）/ 总超时 / 输出 token 上限 / 每条建议最大字符数 / 启用 / 调试日志。**改动下一回合生效**（每回合现读 config.json）。

**去噪前缀**（`stripLinePrefixes`，手改 config.json）：助手回复里以这些字符串开头的行，在拼输入前丢掉。默认 `[]`，即不丢任何行。如果你的记忆或上下文系统会在回复中插入引用标记行，把那一行开头的固定字符串填进来，就能省下输入预算。

## 已知特性与限制

- 生成延迟取决于设置面板所选的 provider/模型；生成在回合结束后异步进行，不阻塞主对话
- 建议持久化在插件目录 `suggestions.json`，host 重启后恢复（刻意不写会话日志——自定义事件类型会让宿主事件校验拒载整本日志）
- 打字时建议卡折叠（0.35s 动画），清空草稿自动展开；✕ 只对本回合生效

## 排障

设置面板打开「调试日志」→ 复现一轮 → 看插件目录的 `debug.log`（`dbg()` 同时写 stdout 和该文件；DSH 的 stdout 走 supervisord 管道，读不到，所以落盘）。全链路探针（事件→转录→路由→每次尝试的耗时/失败原因→解析出的条数与文本）都在。收工后记得关回去。

## 版本

- v0.4.1 修 `@deepseek-ai/dsh-llm` 的 peer 范围：原 `>=0.2.0-rc.2` 按 semver 预发布规则只匹配 0.2.0-rc.2，装到 0.2.1/0.2.2 的预发布宿主上会被解析成旧版本；改为显式 `||` 分支覆盖 0.2.x
- v0.4.0 自管 config.json + settings.section 设置面板 + provider/模型下拉识别；标签默认「建议」（动态下发，零硬编码）
- v0.3.0 dock 槽流式布局 + 主题自适应卡片（主题变量/底角方半径/折叠动画）
- v0.2.x volatile 配置实验（表单在这台 0.2.2 上不出现，已弃用）
- v0.1.x 首版：overlay 槽 + 手动绝对定位（渲染异常，已弃用）
