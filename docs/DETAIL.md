# DSH 会话状态悬浮窗（dsh-notify-traffic）

同时跑 3–10 个会话时，你不需要逐个窗口点开才知道哪个在等你。

悬浮窗是一个**系统级置顶窗口**：DSH 最小化、切到别的应用、换桌面空间，它都还在最前面。四色状态灯汇总所有会话，**审批与提问能直接在窗内处理**，完成与阻塞各有一次轻量语音提醒。默认安静：只在有事时出现。

## 功能

- **四色状态灯**：🔴 待处理（审批/提问）· 🔴 出错 · 🟡 运行中 · 🟢 刚完成 · ⚪ 空闲
  - 同一个红色由图标与文案区分「等你」和「出错」，不靠颜色猜测
  - 出错闪动 1.2s 后转静态红，最多闪 10 分钟；开启「减少动态效果」时直接静态并显示 `!`
- **窗内处理阻塞**：审批卡片直接给「允许一次 / 拒绝」，提问卡片直接选项作答，点击即提交
- **系统级置顶**：`NSWindow.level = .floating`，`collectionBehavior` 含 `canJoinAllSpaces` 与 `fullScreenAuxiliary`
  - DSH 最小化后仍然悬浮在所有应用之上
  - 窗口可拖动，位置自动记住；高度随内容自适应
- **声音提醒**：完成、审批、提问、出错各有一次语音播报
  - 3 秒内多个完成合并为一句（「3 个任务完成」）
  - 阻塞与出错抢占播放（400ms 短窗口），不等合并
  - 静默时段只压完成音，阻塞仍然会响
  - DSH 处于前台时默认不播完成音
- **三种形态**：卡片 · 胶囊条 · 单灯，圆点与按钮都能切换
- **窗口内设置**：标题栏齿轮直接打开设置，不用回 DSH 主界面
- **会话过多不失控**：最多显示 8 行，其余折叠计数；空闲超时的灰色会话自动移出

## 使用

窗口是一个无边框的苹果风格浮层：左上角三个圆点，右上角齿轮与收起按钮，标题栏中段按住可拖动。

| 操作 | 位置 |
| --- | --- |
| 关闭悬浮窗 | 红点（退出窗口进程，下次启用插件或重启 DSH 回来） |
| 收起为胶囊 | 黄点，或标题栏右侧 `—` |
| 展开为卡片 | 绿点，或胶囊右侧 `⤢` |
| 收成单灯 | 胶囊右侧 `◦`；点单灯回到胶囊 |
| 打开设置 | 标题栏右侧齿轮（在窗口内切到设置视图，`←` 返回） |
| 移动窗口 | 按住标题栏中间空白处拖动；位置自动记住 |
| 处理审批 | 卡片上的「允许一次」或「拒绝」 |
| 回答提问 | 点选项后点「提交」 |
| 标记出错已读 | 出错行上的「知道了」 |
| 打开会话 | 点列表里的会话行：DSH 被拉到前台并切到该会话 |

## 设置

**两个入口**：窗口标题栏的齿轮（窗口内设置视图），以及 **设置 → 会话悬浮窗**（DSH 设置面板里的独立区块）。两边读写同一份配置。改动会先立即生效，同时写回当前 profile 的插件配置。

| 分组 | 项 |
| --- | --- |
| 悬浮窗位置 | 系统窗口 / 页面内 / 两者都开 / 关闭 |
| 初始形态 | 卡片 / 胶囊 / 单灯 |
| 声音 | 总开关、审批、提问、出错、完成、仅失焦播完成音、静音时段、音量、合并窗口 |
| 节奏 | 绿灯保持、空闲移出、列表上限、审批等待上限、出错闪动上限 |

「悬浮窗位置」换成「系统窗口」时，胶囊条/卡片会出现在屏幕右上角；换回「页面内」则回到 DSH 界面内。

## 架构

```
DSH 宿主（Node 子进程）                      系统级窗口（独立原生进程）
├─ agent/status · agent/error                ├─ AppKit 无边框透明窗口
│  └─ 四色状态派生（lib/state.js）            │   level=.floating
├─ approval/request · user-questions/request │   canJoinAllSpaces
│  └─ 抢占瀑布，等窗口决定                    ├─ WKWebView 加载同源页面
├─ 声音决策（lib/sound.js）                   │   /notify-traffic/overlay
├─ /notify-traffic/* 数据面                   └─ 轮询 /state、POST /answer
└─ spawn / kill bin/ntf-overlay（单实例锁）

浏览器（Web 界面）
└─ settings.section 「会话悬浮窗」 ← 读写 /notify-traffic/config
└─ shell.overlay 帧浮层（仅「页面内 / 两者都开」时渲染）
```

**为什么需要独立原生进程**：DSH 的宿主插件跑在 `ELECTRON_RUN_AS_NODE` 的 Node 子进程里（不是 Electron 主进程），拿不到 `BrowserWindow`。要做到「DSH 最小化后仍悬浮在所有应用之上」，只能由插件 spawn 一个自己的 AppKit 窗口进程，数据走回环 HTTP。

**为什么审批在宿主侧答**：内置审批的待处理对象没有任何 RPC，审批只能由持有瀑布链的一端结算。宿主 `prepend` 抢占后由窗口经 HTTP 下决定，同一 `requestId` 只生效一次。

**单实例**：`bin/ntf-overlay` 用 `flock` 自锁；插件重载导致重复 spawn 时，后起的实例直接退出，系统里永远只有一个窗口。窗口生命周期由 `ctx.effect` 成对管理，禁用插件即退出。

## 构建

`bin/ntf-overlay` 已预编译（macOS arm64）。换机器或换架构时删掉它，插件会在首次启动时用 `swiftc` 现场编译一次（需要 Xcode 命令行工具）。

```bash
swiftc -O -o bin/ntf-overlay bin/overlay.swift
```

## 发布

发版由 `.github/workflows/publish.yml` 承担，推 `v*` tag 触发。首选 **OIDC trusted publishing**（不需要任何 token，产物带 provenance），失败回退 `NPM_TOKEN`。

### 配置 trusted publisher 必须用 Safari

在 npm 网页上配置 trusted publisher（或任何需要 `sudo` 二次验证的操作）时，**必须用 Safari 打开 npmjs.com**。Chrome / Edge / Firefox 会卡在第二因素验证，无法完成。

原因不是浏览器兼容性，而是**认证器绑定的问题**：

- 这台 Mac 上 passkey / 平台认证器只落在 **iCloud 钥匙串**里，对应的只有 Safari 能调起系统 Passkey 面板
- Chrome 走自己的 WebAuthn 通道，拿不到 iCloud 那枚凭据，`sudo` 模式的第二因素因此走不完
- 表现是：页面停在「验证身份」不报错，或者报一个与凭据无关的通用失败，看不出根因

排查顺序：

1. 先确认是不是这个原因 —— 换 Safari 重试同一操作，能过就是它
2. Safari 里如果也没有凭据，说明这台机器的 iCloud 钥匙串没有同步到该 passkey，需要先在 Safari 里录入
3. 实在过不去，走 token 兜底：在 npm 生成 granular access token，配到仓库 secrets 的 `NPM_TOKEN`，CI 会用 `npm publish --access public`（无 provenance）

> CI 里 `Publish via OIDC` 那步是 `continue-on-error: true`，OIDC 失败不会中断流程，会自动落到 `NPM_TOKEN` 分支。所以「发版成功了但没有 provenance 徽章」= OIDC 没走通，不是发布失败。

### 发版前本地自检

```bash
node flow.mjs check      # 语法 + npm pack 内容检查（对齐 CI）
node flow.mjs status     # 版本 / git 状态 / 最近 tag
node flow.mjs release patch
git push --follow-tags
```

工作流在 `workflows/dsh-plugin-release/`。

## 边界

- 系统窗口只在 macOS 上构建（Windows 需要另写一个 Win32/WPF 版本，接口相同：轮询 `/state`、POST `/answer`）。
- 声音使用窗口内 WebKit 的语音合成，音色取决于系统安装的语音。
- 审批超时（默认 120 秒）后交回会话内处理，不会替你做决定。
- 页面内浮层与系统窗口共用同一份数据面，两种形态可以随时切换。

## 验收对照

| PRD | 结果 |
| --- | --- |
| ① 三种形态 | 卡片 / 胶囊条 / 单灯 |
| ⑤ 审批即时变实心红 + 出卡片；窗内批准后红消失 | 请求到达即置 `red-block`，`/answer` 后立即重算 |
| ⑦ 3 秒内 3 个完成只播一次 | 合并为「3 个任务完成」 |
| ⑧ 顺序到达分别播；阻塞抢占 | 阻塞 400ms、完成 3s |
| ⑨ 静默时段只压完成音 | 完成静默，审批/提问/出错照常 |
| ⑬ 禁用插件不留窗口进程；DSH 退出即消失 | `ctx.effect` 清理 + `flock` 单实例；实测禁用后进程归零 |
| ⑭ 空闲 CPU | 1 次/秒 HTTP 轮询 + 1s store tick，无轮询渲染 |
| 追加：系统级置顶 | `layer=3`；实测 DSH 最小化后窗口仍在 |
| 追加：点会话进 DSH | 5 次点击 → 5 次登记 → 5 次 Client 切换回执，闭环通过 |
| 追加：设置项 | 设置 → 会话悬浮窗，写回 profile 配置 |
