---
name: chromeuse
description: 凡 agent 要实操驱动浏览器时必读的操作手册（不限于已发现问题）：以 tools/cdp.js 的 raw CDP 命令为主通道（click/type/key/goto/a11y/css/scroll-shot/cast/flow 等 40+ 子命令），MCP 工具作 fallback 与强项互补（navigate_page/take_snapshot/click/fill/take_screenshot/evaluate_script/list_network_requests 等工具；take_snapshot 发现陌生控件、网络面板、console 缓冲）；涵盖自动化测试、数据抓取、CDP 连接与配置（NAS 容器 / Windows 桌面端两套环境）；含快速上手、按场景分组的命令速查、通用操作循环、通道分级、红线与恢复纪律、安装配置排障与已知问题专题（专题一：重型 SPA -32001 超时与页面冻结取证）。纯概念讨论、不调用浏览器工具时无需加载。
---

# chromeuse — 浏览器自动化操作手册

> 命名致敬 computer-use（浏览器操作域的同名概念），与 OpenAI 的同名产品无任何关联。

## 〇 文件地图、维护约定与使用时机

### 0.1 维护约定（改命令/文档前先读）

- **命令说明唯一准源 = `commands.meta.json`**：`tools/cdp.js` 的 `SUB_HELP`（`node tools/cdp.js <cmd> --help` 即原文）与 §1.2 每命令一行式都由 `node scripts/build-help.js` 从 meta 生成——命令名、旗标、语义、边界改 meta；深度细节不进 §1.2，以 `--help` 为准。
- **改命令的落点**：①改实现 → ②改 `commands.meta.json`（usage/summary/detail/flags/group/jsonAllowed；§1.2 想要更短一行可给可选 `title`）→ ③跑 `node scripts/build-help.js`（重生成 cdp.js `SUB_HELP` + SKILL §1.2，幂等；**直改 SUB_HELP 块会被 #95 的 `--check` 抓漂移**）→ ④`helpMain` 主帮助/子命令路由等手写面按需同步 → ⑤若属快速上手命令，同步 README「快速开始」/ `references/install.md` §0 → ⑥ selftest #95（meta.flags 双端同源 + build `--check` 零漂移）→ ⑦ bump 版本。
- **改文档的落点**：新命令/新旗标 → `commands.meta.json`（build 投影到 §1.2；手写深度说明进 SUB_HELP detail 或 playbook）；新风险/纪律 → §三（编号顺延，旧号不改）；新专题 → §四 末尾 append `### 专题N` 编号顺延（模板见 §五，深度进 playbook）；新排障症状 → §六 路由表；技术事实/实测数字 → `references/facts.md`；安装/配置 → `references/install.md`。
- **信息保全红线**：重构/精简不得丢事实、数字、警告与指针；同一事实只留单一归属地，其余位置放交叉指针。深度长文一律进 playbook 或 SUB_HELP，SKILL 只留一行式 + 指针。
- **同步点**：文件地图（§0.2）增删文件时同步 README 目录树；§1.2 组段与 SUB_HELP 由 `commands.meta.json` 单源生成（同批跑 build；selftest #95 机检 `--check` 零漂移）。
- **行数守门（分区计数，2026-10-31 用户裁定）**：主干（§〇~§三+§六）≤300 行、专题区（§四~§五）≤200 行（selftest #4 分段断言）；超限先指针化/拆专题，不得靠删事实压行。

### 0.2 文件地图（何时读哪个文件）

| 文件 | 内容 | 何时读 |
|------|------|--------|
| SKILL.md（本文件） | 使用说明主干：维护约定 / 文件地图 / 命令速查 / 操作循环 / 通道分级 / 红线 / 专题决策树 | 触发本 skill 先读这里 → §1.1 通道路由 → §1.2 命令速查或专题路由 |
| references/playbook.md | 通用操作深度版 + 各专题深度版 + §逃生舱/§flow 回放（含视口三态地板：宽度 `_meta.viewportMin` / 高度 `_meta.viewportMinHeight`） | 需要完整命令 / 示例 / 细则时 |
| references/mechanisms.md | CLI 机制契约：输出信封 `chromeuse-cli/1`（失败字段/去重/stdout 单文档纪律）+ 20 错误码表 + 三失败出口（die/return EXIT_ERR/throw）+ golden 双套 | 消费 `--json` 失败信封 / 按 `code` 判读失败 / 改失败出口时 |
| references/facts.md | 技术事实表（超时链路 / CDP 域进程归属 / 工具层实测事实 / 来源链接） | 排障怀疑「为什么卡」时 |
| references/install.md | 安装步骤 + 两环境 MCP 配置片段 + 工具层 Node≥22 要求 + 验证清单 | 装机、改配置、配置类排障 |
| references/distill.md | 事件流→flow/webapps/坑清单的蒸馏协议（质量清单+人机确认） | 录制完成后蒸馏入库时 |
| references/openclaw.md | openclaw 执行端手册（判定树三档/CLI 直调/白名单/安全边界） | openclaw 端执行浏览器任务时 |
| snippets/popup-close-scanner.js | 营销弹窗/遮罩「关闭按钮」定位扫描器（只读；锚点→容器→右上角网格扫描→候选中心坐标供 click_at；附验证探针） | 弹窗 × 点不中 / a11y 无节点 / 目测坐标落空时（专题三） |
| lib/popup-guard.js + config/popup-rules.jsonc + webapps/\<app\>/popup-rules.jsonc | 广告/推广弹窗拦截规则层（popup-guard，V202610150003）：guard 脚本生成器（MutationObserver 预埋，命中 remove/hide，留痕 `window.__cu_pg_log`）+ 双层规则库（webapp 有配置=整体为准 / 无=全局兜底，scope 复用 matchers） | **flow replay 期弹窗防护**（`--popup-guard`）/ 规则误杀检验（`cdp.js popup-guard test`）（专题三·popup-guard） |
| lib/locator.js + `cdp.js locator` | 元素捕获工具（V202610190001）：probe 列候选 / suggest 递归收窄 / verify 高亮截图 / pick 点击拾取；**元素捕获歧义先用 locator probe/suggest，不要盲试多轮**（命令一行式与深度 → §1.2 感知 / playbook §元素捕获方法论） | 同文名多义 / 多层 iframe 定位拿不准 / flow target 写作前验证（专题二） |
| snippets/tab-helper.js | 共享浏览器页签助手 v3（编排侧片段）：parsePages/findTabs/openTab/closeTab/assertTab——**跨会话互斥锁**（锁页 window-CAS 串行化 new_page 序列，页面 JS 单线程=检查+写入原子，超时降级）+新开页=**前置快照差集**+返回值解析（多候选按 url/[selected] 证据链，不唯一不猜）、跨步骤按 URL/title 现查、操作前身份校验 | 共享浏览器开页/跨步骤引用 pageId/报错后校准/并发场景（2026-10-14 护腰会话复盘批） |
| snippets/eval-helper.js | evaluate 返回值解析/条件等待/可点元素查找助手 v1.0（编排侧片段）：unwrapEval（剥 fence+双重 parse，null 安全——根治包装文本裸操作 TypeError）/waitUntil（页面侧 setTimeout 间隔轮询，替代盲等 sleep）/findClickable（空恒 items:[]，面积升序，CSS 视口坐标）+ find→click→verify 三段模板 + chatgptDoneProbe（完成判别多信号探针） | 一切 evaluate_script 返回值消费/等条件/找元素（2026-10-15 护腰复盘批 S1+S2+S6） |
| lib/drive.js + lib/page.js | 交互/页面生命周期命令实现（click/type/key/hover/drag/upload/dialog/viewport/emulate/goto/new/close/select/eval；命令面见 §1.2） | 改交互/页面命令实现时 |
| lib/perceive.js | 感知命令实现（a11y/css；只读零页面副作用；命令面见 §1.2 感知） | 改感知命令实现时 |
| lib/snapshot-diff.js | a11y 快照分级纯函数/IO（--find/--diff/--cursor/--out；身份键/基线/游标；机制见 mechanisms §15） | 改快照 diff/检索/分页时 |
| lib/scroll-shot.js + `cdp.js scroll-shot` | 长图分段拼接实现（命令面/旗标见 §1.2 捕获；深度细节见 SUB_HELP） | 长图任务排障 / 改切段算法时 |
| lib/cast.js + `cdp.js cast` | 一次性录屏实现（命令面见 §1.2 捕获；深度细节见 SUB_HELP） | 录屏任务排障 / 改 fps 归一时 |
| tools/cdp.js + lib/ | raw CDP 逃生舱 CLI（probe/exec/targets/net/screenshot/beacon/watch/flow/record/diff-video/evidence-pack 等）+ flow 引擎（X1 命中闸门/X4 点击前复核防假绿，--no-hit-test 可关）+ 录制编排（默认全标签页多 target；采集失效自愈：10s 哨兵探针/renderer 替换重注入/WS 有界重连，--no-sentinel 可关；页面侧采集九类事件含 uiAppear 状态变迁与 contextmenu 右键；`-v` 录屏兜底默认关——帧流落 tmpdata/video/，diff-video 出事件↔帧对照报告；evidence-pack 把多段录制按绝对时间戳归一成索引式证据包——段间中断显式标记，失败时也拿得出完整证据链）；**exec --params-file <path> 避 PowerShell/CMD 引号吞噬** | MCP 通道不够用时；确定性回放；看门狗；假绿视觉取证；验收证据链打包 |
| bin/ffmpeg + bin/ffprobe | 7.0.2 静态构建（gitignored；缺失时从 /root/tools/bin/ 同步或 johnvansickle 下载） | **浏览器测试有录屏/视频分析需要时直接用**（抽帧：`bin/ffmpeg -i 视频 -vf fps=1 前缀%03d.png`；元信息：`bin/ffprobe 视频`）；也可用宿主持久副本 /root/tools/bin/ |
| config.jsonc | 本机生效推荐值（机器实例，gitignored，改值即用） | **查本机生效值读 config.jsonc；没有先 `node install.js --init-config auto`（win32 上 auto=windows 模板，browserUrl=127.0.0.1:9222）** |
| config-template-*.jsonc | 推荐值模板（linux / windows，git 共享） | 实例缺失时对照；改推荐值走模板 + 推广流程 |
| webapps/\<app\>/webapp.md | 各 web 应用专属操作经验（首部 matchers 识别块 + 带 last-verified；目录统一入口文件） | **操作任何 web 应用前先查识别特征**（URL / 标题 / UI 命中即读该文件） |
| webapps/wechat.md | 微信长截图懒加载专项笔记（占位图 `data-src` 强制赋值 / `naturalWidth>1` 判据 / GIF 1.8s / 并行禁共享 tab） | 采集公众号长图、长截图出现整段空白时（应用入口仍见 `webapps/wechat-mp/webapp.md`） |
| webapps/\<app\>/TODO.md | 应用级问题台账（INBOX 只追加 + GQ-NNN 式结构化条目 + 升级状态行） | 应用专属问题登记 / 查重 / 蒸馏打标时（两级 TODO 下级） |
| webapps/\<app\>/selftest.config.jsonc | flow 测试参与策略（R4/V20261117011，2026-11-17 用户裁定）：`{selftest:{excludeApp?,excludeFlows?,reason}}`——排除 ≠ 删除（资产保留、显式 replay/lint 仍可用），缺省不建=全参与；`excludeApp` 连该 app 的 selftest.js 模块一并跳过；守门=#140（解析/schema/清单一致性/reason 非空） | 临时测试库/已死 flow 免于自动测试噪声（删文件即恢复） |
| TODO.md / CHANGELOG.md / VERSION.md | 问题台账（顶部 INBOX 只追加）/ 版本史 / 版本真源 | 报告新问题前查重；推广流程时 |

### 0.3 环境自判

**环境自判**：NAS 容器 = 存在 `/app/coding-started-projects/projects/opencode-started`；桌面端 = win32 平台 + 本机 Chrome 调试口 9222。两环境差异只在连接层（browserUrl 等，见 config.jsonc），操作方法完全同构。
- **临时切换另一份环境实例**：`node tools/cdp.js --config <path> <cmd>`（全局 flag、位置无关；整份 config 实例生效：environment/browserUrl/bin 全换，相对路径按 cwd 解析，仅本进程有效）——机制见 mechanisms §25 / 用法见 install.md §0。

### 0.4 平台层规则（`lib/platform/`，selftest #136 机检）

- 平台无关代码（CDP 协议 / DOM / 算法 / flow）直接写 `lib/` 单实现，不做平台分支。
- 凡触及**二进制调用、进程管理（spawn/kill/探针）、浏览器发现与连接默认值、环境路由（beacon/提示文案）**一律经 `lib/platform`（`require('./platform')()` 单例）：新契约方法先写 `lib/platform/linux.js`，Windows 需要时在 `windows.js` 覆写并登记 `OVERRIDES`。
- **禁令**：`lib/`（`lib/platform/` 自身除外）与 `tools/` 禁裸 `process.platform`；`install.js`（部署域）与 `selftest/`（测试层）豁免。机制与已迁移面 → `references/mechanisms.md` §24。
- **本地调试实例（无容器 keep-alive 的裸机 Linux / Windows 桌面端）**：`node tools/cdp.js browser-up` 幂等拉起（端口已就绪=复用；`--stop` 关停 / `--status` 查询），连接命令加 `--auto-launch` 连接前自动保障（仅 browserUrl 主机为 127.0.0.1/localhost）；与 `browser-restart` 分工：**up=OS 级进程启动 / restart=CDP 级重启（依赖容器 keep-alive）**。代理按需在命令上给 `--proxy <url>`（Chromium `--proxy-server`；优先级 CLI > env `CHROMEUSE_BROWSER_PROXY` > config.proxy.httpProxy；config 保持空串常态；仅影响被拉起实例，已有实例需先 `--stop`）。机制 → mechanisms §26，场景 → playbook §本地调试实例拉起。

## 一 快速上手（cdp 主通道、MCP fallback）

### 1.1 通道结论与任务路由

**通道选择结论（2026-10-31 用户裁定）**：**cdp 为主通道、MCP 只作 fallback**——日常交互优先 `node tools/cdp.js click/type/key/hover/wait`（Input 域真实事件，无 MCP 的 uid 漂移/-32001 长超时）；MCP 保留其强项：`take_snapshot` 的 a11y 树用于**发现陌生控件**、网络面板语义化读取、`list_console_messages` 自带 console 缓冲。通道互相兜底而非二选一；MCP 全挂时按 §二 表下行降级到 cdp（`list_pages` 失效=Target 类仍可用，`screenshot`/`probe` 先行）。

| 任务 | 首选（cdp 主通道） | §1.2 组 | 兜底 / MCP 强项 |
|------|------------------|---------|-----------------|
| 日常点击 / 输入 / 按键 / 悬停 / 拖拽 / 上传 | `cdp.js click/type/key/hover/drag/upload` | → §1.2 交互 | MCP `click/fill/type_text/press_key`（uid 快照） |
| 陌生控件发现 / 整树感知 | `cdp.js a11y`（紧凑行 + `--depth` 裁剪） | → §1.2 感知 | `take_snapshot`（全树；冻结时 ❌ -32001） |
| 截图 / 长图 / 录屏 | `cdp.js screenshot/scroll-shot/cast` | → §1.2 捕获 | `take_screenshot`（通常最后失效） |
| console / 网络取证 | `cdp.js console/net` | → §1.2 诊断入口 | `list_console_messages`（自带缓冲）/ `list_network_requests` |
| 页签管理 | `cdp.js new/close/select/targets` | → §1.2 页面生命周期 | `new_page/list_pages/close_page`（Target 类冻结期可用） |
| 页面导航 / 求值 | `cdp.js goto/eval` | → §1.2 页面生命周期 | `navigate_page/evaluate_script` |
| 视口 / UA / 媒体模拟 | `cdp.js viewport/emulate`（会话级，自动还原） | → §1.2 视口与设备模拟 | MCP `emulate/resize_page`（长驻会话） |
| 原生 JS 弹窗 | `cdp.js dialog`（后台预埋监听） | → §1.2 交互 | `handle_dialog` |
| flow 校验 / 回放 / lint | `cdp.js flow validate/replay/lint` | → §1.2 自动化 | —（确定性回放无 MCP 对等物） |
| 录制 / 停止 | `cdp.js record/record-stop` | → §1.2 录制 | —（MCP 无多 target 录制） |
| 事件流×录屏对照 / 验收证据包 | `cdp.js diff-video/evidence-pack` | → §1.2 取证后处理 | —（纯本地聚合） |
| 应用识别 / 事件流预处理 / Recorder 转换 | `cdp.js identify/events-summary/recorder-convert` | → §1.2 识别与预处理 | —（matchers 单源） |
| 万能 CDP 口 / 收数 / 弹窗拦截 / 浏览器重启 | `cdp.js exec/beacon/popup-guard/browser-restart` | → §1.2 逃生舱与运维 | —（逃生舱专用） |
| 冻结诊断 / 通道全挂 | `cdp.js probe/watch/doctor-forensics` | → §1.2 诊断入口 | §二 通道分级表 |
| 交互后确认生效 / 批量验收 | `click/type --expect-*`（四态 phase）/ `assert`（多条断言，失败不中断出明细） | → §1.2 交互/感知 | —（生效判据 cdp 独有） |
| 稳定引用操作（先看后点） | `a11y --ref` 产 @eN → `click/type/hover --ref @eN`（失效报 E_REF_STALE 不猜） | → §1.2 感知→交互 | — |
| 巨树找单元素 / 只看变化 / iframe 整树 | `a11y --find/--diff/--frames`（万节点 --find 565B；--diff 只回变化行） | → §1.2 感知 | `take_snapshot`（全量重，冻结期 ❌） |
| 表格 / 链接 / JSON-LD 抽取 | `extract --kind text|table|links|json`（只读，免写 eval） | → §1.2 感知 | `evaluate_script`（手写 JS） |
| 长任务防超时 / 作业管理 | `cast/scroll-shot/record/flow replay --async`（秒回 jobId）+ `job list/status/cancel`（partial 保留） | → §1.2 运维 | —（须显式 --target） |
| 产物盘点清理 / 操作审计 | `artifacts report/prune/pin`（prune 默认 dry-run；证据类永不删）/ `audit tail/stats` | → §1.2 诊断入口 | —（白名单审计无敏感值） |

### 1.2 命令速查（按场景分组）

> 日常交互、批量 UI 测试、排错取 console 首选 cdp 命令；每命令只留一行式（由 `commands.meta.json` 生成）；完整旗标/边界/退出码 → `node tools/cdp.js <cmd> --help`（SUB_HELP 同源生成物）；操作细则 → references/playbook.md 对应节。
> 输出契约（`--json`，13 命令放行：probe/targets/locator/console/a11y/css/click/type/goto/screenshot/flow/wait/handoff）：stdout 单 JSON 文档——成功 `{envelope,ok:true,elapsedMs,data,warnings?}`，失败 `{envelope,ok:false,code,message,retryable,hint,elapsedMs,data}`（报告型失败 data=诊断/旧报告对象；`E_HIT_BLOCKED` 另有顶层 `evidence`）；其余 35 命令遇 `--json` 统一 E_USAGE 拒绝且不执行；20 码表/三失败出口/逐命令 data 定义 → references/mechanisms.md §8。不加 `--json` 时输出与旧版逐字节一致。`--expect-*` 生效判据（四态 phase/exit 语义）→ references/mechanisms.md §9；定位细分码/evidence/extract/assert 语义 → §12；输出脱敏（redact 三同源/`--no-redact`）→ §16。

#### 诊断入口（先确认通道活着）
- `cdp.js probe [--target 选择器] [--out 截图路径] [--timeout ms] [--json]` — 三通道各 5s 独立超时（Browser.getVersion → Runtime.evaluate(readyState) → Page.captureScreenshot），输出存活报告（浏览器进程可达即 exit 0；chrome://newtab 类不出帧页自动跳过通道③）
- `cdp.js console [--listen 3000] [--json] [--out file] [--target 页] [--timeout ms]` — console 监听取证（先 --listen 再复现；--listen 0 读缓存；落 tmpdata/events）
- `cdp.js doctor [--url <browserUrl>] [--timeout ms=5000]` — CDP 通道健康一次性诊断（V202609130003，chromeuse-cdp-doctor/1 JSON）：browser 版本（browser.advisory=低于 MCP 已知降级线 94 时提示走 cdp.js 主通道，非失败）/targets 全列表摘要（数量+type/url/attached——target 堆积可见）/wsLatency 3 次 Target.getTargets 往返校样/screenshotProbe 首个 page 型 target 试拍（bringToFront 前置单次不重试，有标签置前副作用）/multiClientHint 多客户端共用 9222 现状提示（chromeuse 短连接 × chrome-devtools MCP 长驻共存是架构现状）
- `cdp.js doctor-forensics [--target 选择器] [--symptom "来源/目标页/错误码原文"] [--timeout ms=3000] [--max-targets 3] [--no-control-tab] [--no-front] [--out file] [--url <browserUrl>]` — CDP 失效分型取证（V202609300001，chromeuse-cdp-forensics/1）：S0 环境+S1 HTTP 面+S2 WS/browser 级（SystemInfo.getProcessInfo fail-soft 记 unknown）+S3 per-target 矩阵（attach 2s/单发 3s；主 target bringToFront 前置，--no-front 全关）+S4 对照 tab（条件触发：S3 有探针死——about:blank background:true 自开自关，--no-control-tab 可关）+S5 judgeLayers 八层分型 M/A1/A2/B/C/D/E/F/G（恒 advisory，不自动恢复）
- `cdp.js audit tail [n=20] | cdp.js audit stats [--days 7]` — 结构化审计查询（V202611030004 B3 N3）：落 tmpdata/audit/yyyy-mm-dd.jsonl（按 CHROMEUSE_TZ_OFFSET 时区按天切分，gitignored；CHROMEUSE_AUDIT=0 关闭）
- `cdp.js artifacts report | cdp.js artifacts prune [--apply] [--yes] | cdp.js artifacts pin <path...> | cdp.js artifacts pin --remove <path...> | cdp.js artifacts pin --list` — 产物配额/保留期/pin（V202611030005 B3 N2）：report=按类别列文件数/占用/最旧 + 覆盖全部登记目录（video/cast/scroll-shot/downloads/a11y-baseline/flow-checkpoints/log/events/flow-fail/evidence/cdp-forensics/replay-verdict/videodiff/audit/refs/jobs/locks，每项必出现含 0 文件）
- `cdp.js job list | cdp.js job status <jobId> | cdp.js job cancel <jobId>` — 长任务作业模型（V20261104002 B7 N6）：cast/scroll-shot/record/flow replay 加 --async 即作业化（**须显式 --target**；--async 不支持 --json），主进程立即返回 `jobId=… status=running stateFile=…`
- `cdp.js net [--filter url子串] [--duration ms=5000] [--get requestId] [--out file] [--har path] [--no-redact]` — 采集窗口内记录请求并拉取 body/payload（全量落 tmpdata/events/net-*.json）
- `cdp.js watch [--interval 10] [--window 120] [--max-seconds N] [--target 选择器]` — 循环 probe

#### 交互（真实 Input 域事件）
- `cdp.js click --text <文本>|--selector <cssPath>|--point "x,y"（或 --x,y "x,y" / --x N --y M）|--ref @eN [--match exact|contains] [--nth N] [--dbl] [--no-scroll] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms=10000] [--json]` — 真实鼠标点击（文本/CSS/坐标/@eN 引用；X1 四层闸门；多候选不猜；--expect-* 四态判据）
- `cdp.js click-at <x,y> [--dbl] [--target 页] [--timeout ms]` — 坐标直点（真实 Input 域鼠标事件；双击=clickCount 1→2 间隔 60ms，蓝本 clickat 手法）。坐标是视口 CSS 像素（含 iframe 偏移由 locator 计算，手喂坐标自行换算）
- `cdp.js type --text <值> [--into-text <文本>|--into-selector <cssPath>|--into-point "x,y"|--ref @eN] [--match exact|contains] [--nth N] [--append] [--echo-text] [--no-redact] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms] [--json]` — 真实键盘输入（默认清空后 insertText；输入值默认不回显；--expect-* 同 click 四态）
- `cdp.js key <Enter|Tab|Esc|Backspace|Delete|Space|ArrowUp/Down/Left/Right|Home|End|PageUp|PageDown|F1~F12|字母|数字|标点> [--times N=1] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页]` — 真实按键（Input.dispatchKeyEvent keyDown/keyUp，键码表单源 lib/drive.js KEY_TABLE；text 规则：字符键=字符、Enter=\r、Space=空格、导航/功能键无 text）
- `cdp.js hover --text <文本>|--selector <cssPath>|--point "x,y"|--ref @eN [--match exact|contains] [--nth N] [--no-scroll] [--target 页]` — 真实鼠标悬停（单发 Input.dispatchMouseEvent mouseMoved；同 click 的定位/多候选不猜/视口外滚入规则；用于展开 hover 菜单/浮层）
- `cdp.js drag --from-text <文本>|--from-selector <cssPath>|--from-point "x,y"（或 --from-x,y / --from-x N --from-y M） --to-text <文本>|--to-selector <cssPath>|--to-point "x,y"（或 --to-x,y / --to-x N --to-y M） [--steps 5] [--hold 80] [--gap 90] [--nth N] [--to-nth N] [--no-scroll] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms]` — 真实鼠标拖拽（Input 域：mouseMoved(buttons:0)→mousePressed(left,buttons:1)→N 段插值 mouseMoved(left,buttons:1)→mouseReleased(buttons:0)；坐标=CSS 视口 px，附 screenX/Y 忠实映射）。轨迹参数复用 flow-engine drag 原语已实证值（G3 报告 §5.6：5 段/90ms 段间/80ms hold；planDragPath 单源）——--steps 1~50（默认 5，防网站对速度敏感）、--hold/--gap 0~5000ms。两端各三选一（文本/CSS/坐标），多候选不猜需 --nth/--to-nth
- `cdp.js upload <file>[,<file>...] [--file <path>] [--into-text <文本>|--into-selector <cssPath>|--into-point "x,y"] [--match exact|contains] [--nth N] [--no-scroll] [--browser-path] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms]` — 向 file input 注入文件（DOM.setFileInputFiles——CDP 官方文件注入通道，不是 DOM 合成事件，红线一不涉及）：支持多文件（逗号分隔/多个位置参数/--file；去重），路径按进程 cwd 解析为绝对路径并校验存在/普通文件/可读。⚠ **files 路径由浏览器进程解析**：客户端与浏览器文件系统隔离时 Chrome 不报错——静默创建 0 字节 File（只有名字）
- `cdp.js wait --text <文本> | --expr <JS 表达式> [--match exact|contains] [--interval 700] [--timeout 30000] [--target 页] [--json]` — 轮询等待文本或 JS 表达式为真（--text 跨同源 iframe；--expr 主 frame；节距默认 700ms、总超时 30s 上限 600000ms）
- `cdp.js dialog [--auto accept|dismiss|cancel] [--text <prompt答复>] [--wait ms] [--target 页] [--timeout ms]` — 原生 JS dialog（alert/confirm/prompt/beforeunload）一次性监听/处置：Page.enable → 听 Page.javascriptDialogOpening → 按 --auto 发 Page.handleJavaScriptDialog（cancel=dismiss 别名），窗口内首个事件后退出。**CDP 无「查询当前挂起对话框」API**：①无 --wait/--auto=400ms 短观察窗（仅捕获窗口内新开 dialog，监听前已打开的不会回放），失败 exit 1 并说明限制

#### 页面生命周期
- `cdp.js goto <url> [--target 页] [--insecure] [--timeout ms=30000] [--allow-challenge] [--challenge-wait-ms ms=15000] [--json]` — 页面导航（协议白名单 + loadEvent/readyState 双信号 + 主 frame 提交闸门防假完成）
- `cdp.js new [url] [--background] [--insecure] [--timeout ms] [--allow-challenge] [--challenge-wait-ms ms=15000]` — 新开页签（Target.createTarget；缺省 about:blank，URL 同一协议白名单）
- `cdp.js close <targetId> | --all-but <保留 targetId> | --match <url/title 关键字> [--yes] [--timeout ms]` — 关闭页签（Target.closeTarget，仅 page 型）：<targetId> 支持完整 id 或唯一前缀（多前缀不猜=列候选 exit 1）
- `cdp.js select <targetId> [--timeout ms]` — 激活页签（Target.activateTarget；id 或唯一前缀，多前缀不猜列候选 exit 1）
- `cdp.js eval --file <path> | cdp.js eval <expression> [--target 页] [--timeout ms]` — 页面求值（Runtime.evaluate returnByValue:true + awaitPromise:true + userGesture:false）：--file 读文件内容作 expression（**避 shell 引号地狱**，多行/引号/反引号安全）
- `cdp.js targets [--json] [--url] [--timeout ms]` — 默认 HTTP /json/list 纯 HTTP 无需 WS

#### 感知（只读，零 Input / 零页面副作用）
- `cdp.js a11y [--text <文本>|--selector <css>] [--match exact|contains] [--depth N=8] [--max-nodes 2000] [--timeout ms=10000] [--nth N] [--mark-js] [--group] [--ref [--max-refs N=50] [--locator]] [--json] [--target 页]` — a11y 树快照（体积控制/超时必返/--ref 引用表/--find·--diff·--cursor/降噪三件/--group 语义分组）
- `cdp.js css --text <文本>|--selector <css> [--match exact|contains] [--computed] [--matched] [--timeout ms=5000] [--nth N] [--json] [--target 页]` — 元素样式感知（--computed 默认；--matched 规则来源；--json=chromeuse-css/1）
- `cdp.js locator probe|suggest|verify|pick [--text X] [--match exact|contains] [--role R] [--dom-path CSS] [--container '<json>'] [--js-listeners] [--cursor-pointer] [--target <pageId|url子串|title子串>] [--json]` — 元素捕获/定位验证（probe/suggest/verify/pick；跨同源 iframe；歧义不盲试）
- `cdp.js extract --kind text|table|attr|links|json|grid [--selector <css>] [--attr <name>] [--col <列头文字> --row <N>] [--match exact|contains] [--limit 100] [--target 页] [--timeout ms]` — 结构化抽取（只读；跨同源 iframe；零合成事件/零导航）：text=可见文本（省略 --selector 默认 document.body 全文）/ table=表格首行表头映射为对象数组 / attr=匹配元素的 --attr 属性值（须 --attr）/ links=a[href] 去重（绝对 href+文本+title）/ json=JSON-LD 与内嵌 script[type="application/json"]（数组展开一层，解析失败计 errors）/ grid=虚拟化网格读数（react-data-grid v6 `.react-grid-*`/v7 `.rdg-*`：列头视觉序+visibleRows/totalRows；--col/--row 成对读指定单元格；不滚动——离屏未渲染≠空值，先 grid locate/scroll-to 复读）

#### 虚拟化网格（读数走 extract --kind grid；本组有滚动副作用）
- `cdp.js grid locate --col <列头文字> --row <N> [--selector <css>] [--keep-scroll] [--match exact|contains] [--target 页] [--timeout ms] | cdp.js grid scroll-to --row <N> [--col <列头文字>] [--selector <css>] [--restore-scroll] [--match exact|contains] [--target 页] [--timeout ms]` — 虚拟化网格定位/滚动（滚动渲染后复读；locate 默认还原滚动）

#### 视口与设备模拟（命令级自动还原）
- `cdp.js viewport [WxH] [--dpr N] [--reset] [--target 页] [--timeout ms]` — 视口覆盖（Emulation.setDeviceMetricsOverride；WxH 形如 1000x700，--dpr 1~4）
- `cdp.js emulate --ua <ua>|--media print|screen [--reset] [--target 页] [--timeout ms]` — UA/媒体模拟（Emulation.setUserAgentOverride / setEmulatedMedia；media 仅 print|screen）

#### 捕获（截图 / 长图 / 录屏）
- `cdp.js scroll-shot [--target 选择器] [--out-dir 目录] [--name 前缀] [--viewport WxH] [--viewport-max-chunk] [--dpr 1~4] [--format png|jpeg] [--quality 0~100] [--max-chunk 4600] [--max-chunk-unit px|css] [--overlap 0] [--no-format-fallback] [--img-promote|--no-img-promote] [--img-settle 1800] [--blank-check|--no-blank-check] [--blank-min-px 800] [--blank-threshold 247] [--blank-strict] [--snap-cuts|--no-snap-cuts] [--snap-window 180] [--snap-px] [--no-foreground] [--settle 200] [--timeout 30000] [--prewarm-samples 20] [--image-timeout 5000] [--keep-slices] [--dry-run]` — 长文/长页长图分段拼接（V202610210002/3/4 + F15，chromeuse-scroll-shot/1）：①图片懒加载（**--img-promote 默认开，--no-img-promote 关**）：预热前遍历 document.images，按 data-src→data-original→data-lazy-src→data-actualsrc→data-backsrc 取真源，仅当 src 仍是占位/空时做**纯属性赋值** img.src=值（不 dispatchEvent/不合成点击，打标 data-cu-promoted="1"），**先只读统计候选再赋值**，等待循环内可补做一轮
- `cdp.js cast --duration <s> [--out <path.mp4>] [--every-nth 1~30] [--quality 0~100] [--max-width 0~3840] [--no-foreground] [--target 页] [--timeout ms]` — 一次性录屏（startScreencast→ffmpeg 合成 mp4；fps 按实际帧/真实跨度归一；帧数<2 失败）
- `cdp.js screenshot [--target 选择器] [--out 路径] [--timeout ms=5000] [--dpr 1~4] [--viewport WxH] [--format png|jpeg] [--quality 0~100] [--annotate] [--json]` — 独立短超时截图（默认 tmpdata/events；显式 Emulation 后还原；失败走降级链）

#### 自动化（flow 校验 / 回放 / lint）
- `cdp.js flow validate|replay|lint <file.flow.json> [--var k=v] [--var-json '{"k":"v"}'] [--target 选择器] [--keep-tab] [--lock] [--insecure] [--no-hit-test] [--post-verify] [--no-kind] [--allow-challenge] [--challenge-wait-ms ms=15000] [--json]` — flow 校验/回放/lint（四层定位+真实 Input；--lock 互斥；失败落 flow-fail/）
- `cdp.js assert [--count <css>=<n>] [--text <文本>] [--no-console-error] [--url <pattern>] [--attr <css>@<name>=<value>] [--fail-fast] [--target 页] [--timeout ms]` — 批量断言（可多条重复旗标；只读）：count=命中数精确等于 / text=可见文本出现（复用 R1 的 TEXT_EXISTS_V2_SRC 两级漏斗与 buildProbeExpr）/ attr=任一匹配元素的属性值精确等于 / url=当前 location.href 匹配正则（/re/flags 或裸正则；**本命令的 --url 是断言模式，不是 browserUrl——浏览器地址走 config**）/ no-console-error=已有 console 历史（listen 0 缓存回放，Chrome 153 实测）无 exception/error
- `cdp.js handoff --reason "<人需完成的事>" [--target 页] [--timeout-ms ms=600000] [--signal <path>] | cdp.js handoff --wait <id> | cdp.js handoff --status [<id>] | cdp.js handoff --cancel <id>` — 人机接力 handoff（start/--wait/--status/--cancel；touch 信号续跑，页签永不置前）

#### 录制
- `cdp.js record [--duration ms] [--out file] [--target 选择器(单页降级)] [-v] [--lock] [--no-sentinel] [--full-input] [--clipboard-policy <text|masked|meta>] [-v 时: --video-width 960 --video-quality 60 --video-interval 1000]` — 默认全标签页录制（V202609080013）：Target.setAutoAttach 自动附挂全部存量/新增标签页，每 target 分配 tab-N 别名+独立错误隔离，事件双标 tab+targetId（V202609090003 起另带 ch=binding|beacon 回传通道标记），关 tab 不丢已录事件（pagehide 终刷）
- `cdp.js record-stop` — 对运行中的 record 发 POST /__stop 优雅停止并落盘

#### 取证后处理
- `cdp.js diff-video <recording-*.json> [--video-file <mp4>] [--t0 <iso>] [--mp4] [--out file]` — 事件流×录屏帧对照报告（chromeuse-videodiff/1 落 tmpdata/videodiff/）：每个 click/dblclick/uiAppear/navigate 事件 → 前后最近帧（路径+Δt，按 tab 分列）
- `cdp.js evidence-pack <recording-*.json|目录>... [--gap-seconds 300] [--out 目录] [--title 标题]` — 验收回放证据包（V202609170003，chromeuse-evidence-pack/1 落 tmpdata/evidence/evidence-pack-<时间戳>/）：多段录制产物（事件流 chromeuse-events/1 + 录屏帧流 chromeuse-video/1）按绝对时间戳归一到统一时间轴（timeline.json：各段起止/相对偏移/事件与帧统计/关键帧索引/损坏段登记）

#### 识别与预处理
- `cdp.js identify [--url <url>] [--target 选择器] [--assert-app <slug>] [--note 备注]` — 应用识别（matchers 分段锚定+约束度打分，用户断言优先）
- `cdp.js events-summary <recording-*.json> [--out file]` — 确定性预处理：噪声过滤/IME 折叠/类型分布统计
- `cdp.js recorder-convert <DevTools导出.json> [--out flow.json]` — T2 兜底转换器：DevTools Recorder JSON → flow 草案（不可映射步骤出 warning）

#### 逃生舱与运维
- `cdp.js exec <method> [paramsJSON | --params-file <path>] [--target 选择器] [--insecure] [--timeout ms]` — ⚠ 破坏性命令类别（Target.close*/Page.navigate/Browser.close/Storage.* 等）务必明确 --target 并自担风险
- `cdp.js beacon [--host 0.0.0.0] [--port 9999] [--dump 目录]` — 零依赖收 POST
- `cdp.js popup-guard scan|test|on|off --target <pageId|url子串|title子串> [--rules <file>] [--app <slug>] [--seconds 60] [--timeout ms]` — 广告/推广弹窗拦截（MutationObserver 守卫；scan/test/on/off；零合成/零网络拦截）
- `cdp.js browser-restart [--url <browserUrl>] [--timeout ms=30000]` — 优雅重启浏览器（Y1 治本产品化，V202609100002）：Browser.close（ExitType:Normal 无恢复气泡）→ keep-alive 自动拉起（NAS chrome-browser 容器特有）→ 探活轮询 → 域级深检 → tab 清单
- `cdp.js browser-up [--timeout ms=20000] [--proxy <url>] | cdp.js browser-up --stop | cdp.js browser-up --status` — OS 级拉起调试实例（批C2/R2）：校验 chrome 三键 → 发现浏览器可执行 → 幂等探测（端口已就绪=复用现有实例）→ spawn 常驻（独立 user-data-dir）→ 等 /json/version 就绪 → state 落盘；--stop 显式关停（进程组信号 → 兜底 CDP Browser.close）/ --status 只读查询
### 1.3 通用操作循环（五步）

**前置：识别目标应用**（五步，V202609080009）：

1. **提 URL**：取当前页 `location.href`（`node tools/cdp.js identify` 可代跑识别）；
2. **遍历 matchers**：各 `webapps/<app>/webapp.md` 首部 jsonc 的 `matchers.urlPatterns`（分段锚定 `host[:port][/pathPrefix]`，约束度最高胜出）；用户断言（会话级绑定 / `tmpdata/url-assertions.jsonl`）优先级最高；
3. **路由**：单命中 → **直载该 webapp.md 再动手**（专属操作手法优先级高于本通用循环）；多命中（同约束度）→ 问用户一次并会话内记住；零命中 → 问用户，并登记 TODO INBOX（候选新应用，事后蒸馏升格 webapps/ 目录）；
4. **标题二重确认**：URL 命中但页面标题与 webapp「识别特征」节不符 → 警告并重问（防同框架多系统误载经验）；
5. **断言登记**：用户给出确定性答案 → 会话级绑定（默认零持久化）；用户同意记忆化 → 追加 `tmpdata/url-assertions.jsonl`（推广时批量泛化入 matchers，一个 [doc] bump）。

**开页与多标签（首选路径）**：开新页/取 pageId **首选 `openTab`**（`snippets/tab-helper.js`——前置快照差分+跨会话并发锁+新页 id 解析一步到位；**勿手写 new_page 后紧跟 list_pages 校准的旧模式**）；跨步骤引用 pageId 用 `findTabs` 现查（不信任记忆中的 id）、跨步骤操作前用 `assertTab` 校验身份（细则与边界 → `references/playbook.md` §pageId 与坐标换算）。**并行采集=每 worker 各自 `openTab` 独立页签**；并发共用一个页签会撞 navigate/close 竞态（`Inspected target navigated or closed` 等），单页签只在串行任务里复用（F10 → playbook §多标签管理）。

**五步循环**（v45 旧循环「一律先 snapshot」的通道分级升级版）：

1. **截图看状态**：新页面 / 操作后先 `cdp.js screenshot`（或 MCP `take_screenshot`；合成器线程，**通常最后失效**——ChatGPT 实测硬阻塞时截图也 -32001）——确认页面活着、大致布局；
2. **感知拿定位**：轻页面 `cdp.js a11y` 或 MCP `take_snapshot`（a11y 树与 uid）；**重页面先做轻探针**（见下）再决定；
3. **真实交互**：`cdp.js click/type/key/hover/drag`（文本/CSS/坐标，多候选不猜需 `--nth`）或 MCP `click(uid)` / `fill(uid, 值)` / `fill_form` / `type_text` / `press_key`——一律真实键鼠事件（红线见 三）；**uid 是 chrome-devtools-mcp 快照临时分配的，raw CDP 回放没有 uid——AI 写 flow 必须把 uid 翻译成语义定位器再落盘**（text 精确 / grid 表头上下文 / domPath，见 references/playbook.md §flow 回放守则）；
4. **验证是闸门，不是建议**：下一动作前必须确认目标状态已达成——菜单/面板已弹出、事件已触发、业务侧已生效；
   盲走下一步会把单点失败传染成连锁失败，断裂点无法定位；
   **交互原语可靠性优先级**：鼠标点击（首选，事件链最短）→ 键盘 Enter/组合键（次之，受焦点 / composition 状态 / 应用自定义 keydown 拦截影响）→ JS 合成（禁止，见 红线 #1）——键盘无效换鼠标点击等效元素，不做自动降级（细则 → playbook §交互原语可靠性）；
   反馈未达成时的处理：先截图视觉判断异常（弹窗 / 遮挡 / 加载态），排除操作问题后再归因；
   手段：`wait_for(目标文字)` 或再 `take_screenshot`；业务写操作要验证业务侧效果（如金额联动、状态机推进），不只看 UI 回显；
5. **失败转取证域**：`cdp.js console/net` 或 MCP `list_console_messages` / `list_network_requests`（浏览器进程侧，冻结期也可用）。

**轻探针**（判定 renderer 主线程是否存活）：

```bash
node tools/cdp.js eval "document.readyState"
```

> MCP 等价：`evaluate_script("() => document.readyState", { waitForStableDom: false })`（只读）。

- 通（返回 complete / interactive）→ 主线程可用，正常 snapshot / 交互；偶发超时重试一次即可；
- 不通（-32001）→ 主线程冻结 → 转 **§二 通道分级** 与 **§四 专题一**，严禁连续重击。

### 1.4 MCP 工具速查（七类；fallback 与强项；opencode 中工具名带 `chrome-devtools_` 前缀）

| 类别 | 工具 | 要点 |
|------|------|------|
| 导航/标签 | `new_page` `navigate_page` `list_pages` `select_page` `close_page` `resize_page` | `navigate_page` 可带 `initScript` 预埋钩子；`timeout` 参数可调；**开新页/取 pageId 首选 `openTab`（tab-helper，见上「开页与多标签」）** |
| 感知 | `take_snapshot` | a11y 树 + uid；重页面易 -32001（专题一） |
| 交互 | `click` `fill` `fill_form` `type_text` `press_key` `hover` `drag` `upload_file` | 全部按 uid；`click` 有 `dblClick` 参数 |
| 验证 | `take_screenshot` `wait_for` | 截图通常最后失效、优先但不保证（见 facts 工具层实测） |
| 调试 | `list_console_messages` `list_network_requests`（+ 各自 `get_*`） | 浏览器进程侧，冻结期可用 |
| 弹窗/模拟 | `handle_dialog` `emulate` `performance_*` `lighthouse_audit` | 原生 dialog 用 `handle_dialog`；DOM 层业务弹窗直接点「确认」uid |
| 兜底 | `evaluate_script` | **只读** + `waitForStableDom: false`；禁合成业务事件（红线见 三） |

## 二 通道分级速查

**通道选择结论见 §1.1**（cdp 主通道、MCP fallback；任务路由也在 §1.1）。本表只列 **renderer 主线程冻结时**各通道的可用性，供降级决策。

| 通道 | 底层 | renderer 主线程冻结时 |
|------|------|----------------------|
| `take_screenshot` | `Page.captureScreenshot` → 合成器线程 | ✅ 通常可用，但**最后失效**（硬阻塞时也 -32001） |
| `list_network_requests` / `get_network_request` | Network 域 → 浏览器进程侧缓冲 | ✅ 可用（架构推断；实测见【冻结期 Network 域可用性实测】） |
| `performance_*` / `list_pages`（Target 类） | 浏览器进程 | ✅ 可用 |
| `navigate_page` 的 `initScript` 注册 | `Page.addScriptToEvaluateOnNewDocument`（仅注册） | ✅ 注册可用（执行在下次导航） |
| `evaluate_script` | `Runtime.evaluate` → renderer | ❌ -32001 |
| `take_snapshot` | `Accessibility.getFullAXTree` → renderer | ❌ -32001 |
| `navigate_page` / `close_page` 的完成确认 | 需 renderer 响应 | ⚠️ 发起可、确认卡 |

原理与逐域证据 → references/facts.md。截图通道的边界实证（ChatGPT 硬阻塞时截图/轻探针同报 -32001、等待 ~20s 自愈）→ facts.md「工具层实测事实」。

## 三 红线与恢复纪律

1. **事件可信性红线**：业务写操作（点击 / 输入 / 选择 / 勾选）**严禁** `evaluate_script` + `dispatchEvent` 合成事件——`isTrusted=false`，系统监听链不认（实测填了单价但金额恒 0、无任何报错，极难排查）。交互一律走真实输入通道（`cdp.js click/type/key/hover` 的 Input 域事件，或 MCP 原生工具）；`evaluate_script` 仅限只读（读值 / 列索引 / 滚动定位 / DOM 探查），且只读也传 `waitForStableDom: false`。
2. **操作路径红线**：浏览器操作以**模拟人类**为准——点击 / 输入一步步推进业务流程；**禁抄近道**：发现「点击应用等效打开某 URL」不得改 goto 直达——点击背后有业务逻辑处理（选中态 / 上下文写入 / 后端预取），直达会跳过、后续流程走不下去（2026-09-10 库存锁定 landing 漂移实证）。
   **flow 导航首选完整人类操作路径（应用面板→APP→模块→功能）；goto 直达仅限门户入口 / 登录页 / 用户显式要求（flow desc 注明，机检 selftest #58）——2026-09-17 用户裁定**。goto 另仅用于录制流中真实为导航的步骤；例外 = 用户显式声明的测试场景（漏洞测试等）。细则 → references/playbook.md §操作路径红线（与 #1 合称**模拟人类双红线**：#1 事件层 isTrusted / #2 路径层业务语义）；输入形态按可靠性优先级取用（鼠标点击 > 键盘 > JS 合成禁止——细则 → playbook §交互原语可靠性）。
3. **引用字段禁手打**：lookup / 物料 / 客户 / 币种等引用字段走下拉选择（双击单元格 → 点 ▼ → 选列表项）；手打触发"引用的数据不存在"类校验弹窗。
4. **禁连续重击**：超时后反复 `close_page` / reload / snapshot 只会让请求在冻结的 renderer 上排队更多。两次尝试间隔 ≥10s，先轻探针再决定。
5. **restart 归属**：`docker compose restart opencode` / 桌面端重启 opencode 会杀掉所有运行中会话——归属用户或空闲期执行，**agent 不得在任务中自杀式 restart**。
6. **CDP 端口禁映射宿主**：9222 / 9224 无认证，连上即全权控制浏览器；只允许容器内网 / 本机可达。
7. **杀进程恢复**：冻结不可恢复时，记录现场（截图 + 网络域证据）→ 重启浏览器实例 / 专用 profile → 重放操作；不要在死页面上恋战。
8. **凭据禁入 skill**：账号 / 密码 / token 不写入 webapps/、config 实例与本 skill 任何文件。

9. **人类演示步骤保真红线（2026-09-17 用户裁定，最高严肃级）**：蒸馏/改造 flow **严禁跳过、合并、重排人类演示步骤**——每一步都有领域语义（实证：应用面板点「物料域」=过滤并加载该域应用列表，跳过→面板应用不显示→误点桌面同名图标（桌面需双击/同域多实例歧义）→流程卡死）；改造必须对照原始录制事件流逐步逐拍对齐，吃不准的步骤宁多勿少；**rect 0 尺寸/隐藏元素候选直接排除只点可见元素（视觉铁律，无可讨论）**；
10. **操作级循环熔断红线（2026-10-14 护腰复盘批 D1）**：MCP 交互模式下同一目标**连续 3 次不同策略**未果 → **强制止损**——报告已试路径（策略/报错/截图）+ 降级处理（换通道取证/转人工入口/交用户决策），**严禁发起第 4 次尝试**（实证：2026-10-13 京造客服「转人工」7 轮无效尝试最终由用户打断；flow 引擎早有 retry≤1 等价物，MCP 交互模式此前零熔断）。配套：提取失败先探后换、大采集阶段性落盘（细则 → playbook §MCP 交互模式纪律）。**与 #12 同源**：反爬拦截的「严禁硬刷」正是本熔断在风控场景的落地。
11. **登录态失效处置纪律（2026-10-15 用户裁定；2026-10-19 补充「已填充先试点登录」）**：遇到登录墙/需登录态场景（登录页跳转/登录按钮/账号异常提示）→ **按序处置，不跳步**：①**刷新一次**（reload 或重新 goto）观察登录态是否恢复（实证存在渲染问题/半加载态**假性掉登录**，刷新即恢复）；②刷新后仍在登录页 → **检查用户名/密码是否已填充**（只判非空**不读值**）——已填 → **先尝试点击登录**（真实鼠标事件；实证 2026-10-19 一次点击即进桌面·无需人工介入）；③点登录仍失败 / 表单未填充 → 截图取证 + 报告用户等人工登录（凭据禁入 skill，红线 8），**登录完成前不得继续业务步骤**；严禁反复绕路试探或对无登录态页面硬跑流程出假绿。
12. **反爬/验证码处置纪律（2026-10-21 竞品采集复盘批 A7/A10）**：遇滑块 / 验证码 / 「环境异常」/ 「请在微信客户端打开」类拦截 → **按序**处置，不跳步：①**截图取证**看实际拦截形态（禁猜）；②**最多一次**点「去验证」或完成验证（实证 A7 一次即放行）；③仍未过 → **转人工**并如实报告（已试动作 / 拦截文案 / 截图），拦截未解除前不得继续业务步骤。**严禁硬刷**——不连续重试、不换 UA、不换 IP 反复试探（与 #10 熔断同源：同法重跑不算新策略，第 4 次 = 违令）。**出口 IP 语义**：数据中心 IP 访问 `mp.weixin.qq.com` 文章页会**全量弹验证码**（A10）——改「真实浏览器出口」或转人工，不要试图在数据中心 IP 上刷过（细则 → playbook §MCP 交互模式纪律）。
13. **拟人化总则（2026-10-09 用户裁定）**：抓数据 / 逛电商**一律模拟人类 UI 操作，禁接口直查**——**JSONP / fetch 后台 API / cookie 重放**三种手段都不得用来替代 UI 采集。与 #1（事件层 `isTrusted`）、#2（路径层业务语义）合称**拟人化三层**（事件可信 / 路径拟人 / 数据通道拟人）。**边界区分**：专题一「Cookie 重放接口」是页面冻结时的**只读取证**手段（读网络域 / 回放只读请求取数），与本总则「禁用接口直查替代 UI 抓数据」不冲突——**取证可用，采集不可**。六条硬纪律全量与实证 → references/playbook.md §拟人化六条。

**附（不编号引用）·LLM 目标引用边界**：运行期 LLM 选目标只能引用观察到的节点引用（index/uid/text+container），不得凭推测直产 selector/坐标/JS 交执行——豁免与细则 → references/playbook.md §LLM 目标引用边界。

## 四 专题决策树

### 专题一：重型 SPA / -32001（浓缩决策树）

**症状**：`take_snapshot` / `evaluate_script` / `navigate_page` / `close_page` 报 `MCP error -32001 Request timed out`，而 `take_screenshot` 正常 → renderer 主线程被长任务占死（重 bundle、多 iframe、上千节点 DOM 的后台系统典型）。

```
1. 轻探针 evaluate_script("()=>document.readyState",{waitForStableDom:false})
   ├─ 通 → 主线程活着：正常 snapshot / 交互（偶发超时重试一次）
   └─ 不通（-32001）→ 冻结确认，转 2（此后每步间隔 ≥10s）
2. 取证优先走网络域（不经主线程）：
   list_network_requests → get_network_request 抓 payload / 响应体；Cookie 重放接口
   （ERP 类 API 驱动系统，数据在请求里往往比页面里全；全命令见 playbook §专题一）
3. 需要页面结构 / 交互：
   ├─ 等 10~30s → 重轻探针 → 通则恢复 snapshot
   ├─ 截图 + `cdp.js click-at <x,y>` 坐标兜底（MCP 等价 click_at(x,y)，需 --experimentalVision；适用边界见 playbook）
   └─ 需要页面数据 → navigate_page initScript 预埋 beacon → 本地 HTTP 服务（完整示例见 playbook）
4. 全部失效 → 判定不可恢复：留存证据 → 重启浏览器实例 / profile → 重放（纪律见 三.7）
```

**纪律**：任何一步失败不连续重击；冻结期宝贵的是"取证"不是"硬操作"。

深度版（网络域全命令 / beacon 完整示例 / click_at 边界 / Playwright 并存守则）→ references/playbook.md §专题一；超时链路与 CDP 归属原理 → references/facts.md。

### 专题二：元素可见但点不中（浓缩决策树，V202609080010 勘误版）

**症状**：元素**肉眼可见**（截图里有、文字正常）但 click/双击/键盘全无响应，或 take_snapshot 里对应节点为空——"看得见点不中"。典型：下拉菜单项、悬浮层、iframe 内网格。

```
1. 文本匹配歧义排查（高先验，实测最常见）：目标文字同文名多义（侧栏/Tab/列表行/表单路径）？
   └─ 收窄 target：match:exact / frame 限定 / 网格上下文定位器（V202609080011）；flow 回放失败优先怀疑这条
   └─ **先用 `cdp.js locator probe/suggest` 列候选+递归收窄，不盲试多轮**（verify 高亮截图做视觉确认；pick 点击拾取）
2. 主线程冻结排查（高先验）：轻探针 evaluate_script("()=>document.readyState",{waitForStableDom:false})
   └─ 不通（-32001）→ 走 §四 专题一通道分级（截图/网络域先行）
3. 只读诊断（禁写禁点击）：逐层 elementFromPoint + 递归 getBoundingClientRect
   ├─ rect 0×0 → 先确认元素是否处于关闭/隐藏态：display:none 下 0×0 是正常测量（历史"幽灵菜单"误测教训），
   │  先点触发器展开目标再测；展开后仍 0×0 → 布局坍缩，留证上报
   └─ 命中层非目标（穿透到画布/遮罩）→ 命中被劫持，查浮层/网格容器
4. DPR 低先验排查项：evaluate_script 读 devicePixelRatio **记录参考即可**（坐标为 CSS 坐标与 DPR 无关；
   只有截图像素换算才 ÷DPR）。前两步排除后仍坐标类异常才怀疑 DPR；确需归一 → emulate 是**可选工具**
   （flow emulate 原语 / MCP emulate 工具，默认不启用），用完恢复原样（自建标签自关即无残留；--target
   模式显式恢复），emulate 施加于 goto 前会被导航重置
5. 收尾：现象+环境追加 webapps/<app>/TODO.md INBOX（打标规则见 references/distill.md）
```

**要点**（V202609080010 根因勘误）：历史"DPR 1.5 幽灵菜单"结论被用户实证推翻——原生 DPR 1.5 下人工全可点，从未遇到不可点菜单；0×0 rect 实为菜单**关闭态**的正常测量，emulate"修复"未经对照验证。坐标类故障优先排查**文本匹配歧义**与**主线程冻结**，DPR 降为低先验项（截图像素≠CSS 像素的换算事实保留，见 facts 工具层实测 #2）。

### 专题三：营销弹窗/遮罩「关闭按钮」点不中（浓缩决策树，V202610090001）

**症状**：页面被营销弹窗（淘宝 9.9 弹窗类）或遮罩阻断；右上角 × 肉眼可见但 `click(uid)` 无 uid 可点、`take_snapshot` 无节点、截图目测坐标 `click_at` 落空。根因：× 是**纯视觉 div**（无名称无描述叶子 → a11y 快照被 interestingOnly 过滤），且 class 关键词易被同类（商品卡"不感兴趣"×）淹没。

```
1. 弹窗关闭按钮 = 目标时，直接上扫描器（免逐层猜）：
   snippets/popup-close-scanner.js 主脚本 → evaluate_script（只读）
   ├─ 填参：ANCHOR=弹窗内唯一文本（如「去抢购」）；容器尺寸带默认 400~1100×≥250
   ├─ 返回 suggestedClick.center → click_at(center) 真实鼠标点击（禁目测坐标：实测偏差 64px）
   └─ ANCHOR_NOT_FOUND=已关/CONTAINER_NOT_FOUND=调尺寸带或换锚点
2. 点击后验证（闸门，未确认不得继续）：复跑主脚本 ANCHOR_NOT_FOUND，或验证探针 rect 归零(0×0)=成功
   └─ 仍在：查点击点 elementFromPoint 是否被透明层拦截 / 事件绑在父级，重测 rect 重点一次（≤1 轮）
3. 关闭操作未视觉确认前，严禁继续后续步骤（实测教训：Escape 不生效 + 未确认连做 3 步全军覆没）
```

**要点**（V202610090001 淘宝实测验证）：a11y 树常无 × 节点（verbose:true 或可带出，未实测）；class 候选必须**作用域限定弹窗容器内 + 全量不截断**（否则被商品卡同类淹没）；容器定位判据=从锚点向上「宽 400-1100 且高 >250、非全屏层」；网格扫描区=容器右上角 right-3/top+3 起 120×96px 步长 12px。跨 iframe 弹窗可复用（evaluate_script 单 frame 场景自动切上下文）。

**replay 路径（V202610150003 新增 popup-guard）**：上面是 **MCP 交互模式**的「点 ×」能力；**flow 回放期**的弹窗防护走 `flow replay --popup-guard`——DOM 层 MutationObserver 守卫（预埋 `Page.addScriptToEvaluateOnNewDocument` + 已加载页即时执行一次，命中规则 `remove`/`hide`，不做合成点击），规则库双层（webapp 有 `popup-rules.jsonc`=整体为准 / 无=全局兜底）、拦截留痕读 `window.__cu_pg_log` 输出摘要；默认关、finally 配对还原现场。误杀检验门槛=`node tools/cdp.js popup-guard test --target <页>`（dry-run 只记不动）。用法与纪律 → playbook §专题三深度·popup-guard。

## 五 新专题模板（append 规则）

新问题 = 在 §四 末尾 append `### 专题N`（编号顺延：专题四、五……），不动主干。每专题 ≤60 行浓缩决策树，深度一律进 playbook 对应专题节；配套 TODO 条目 + CHANGELOG 记录。模板：

```markdown
### 专题 N：<一句话症状>
症状/触发条件：
决策树：
1. …（≤6 步，首步必须是廉价/永活通道）
深度 → references/playbook.md §专题 N；台账 → TODO-XXX
```

## 六 排障入口路由表

**排障总纲**（浓缩版，深度 → references/playbook.md §排障总纲）：

- **元规则一·视觉优先**：出问题第一动作 = 截图 / `-v` 帧对照看页面**实际状态**，再进结构化分析——一次视觉确认可排除大批可能性（元素在不在 / 面板开没开 / 走到哪一步 / 有无报错弹层），范围收窄后再查日志代码；结构化分析建立在错误前提上最费时。
- **元规则二·分层归因**：运营期（webapp / flow 蒸馏成熟）偶发 → flow.json / 知识漂移 → chromeuse 代码 → 其他（环境/浏览器/应用自身）；开发期（chromeuse 开发验证中）代码提前为第一嫌疑；**顺序不绝对**——已有证据指向某层时直接跳层。
- 路由表最后一行即本总纲的最常见入口（日志✓画面✗）。

| 症状 | 先查 | 再查 |
|------|------|------|
| MCP 工具全不可用 / `list_pages` 失败 | references/install.md §3 验证清单 | install.md 对应环境节（§1 NAS / §2 桌面端） |
| 部分工具 -32001、截图正常 | §四 专题一 | playbook §专题一 / facts.md |
| 长图整段空白 / 图片未加载 | §1.2 捕获（scroll-shot：`--img-promote` 默认开 + `naturalWidth>1` 判据） | `cdp.js scroll-shot --help`（F13/F15 细节）+ `webapps/wechat.md` 懒加载专项 |
| 截图/录屏失败（screenshot-fail 报告 / cast 帧数<2 / 无 mp4） | 报告与清单路径：`tmpdata/events/`（screenshot-fail）/ `tmpdata/cast/`（帧+清单） | facts 工具层实测 / SUB_HELP（`cdp.js screenshot --help`、`cdp.js cast --help`） |
| 元素可见但点击无响应 / a11y 空节点 | §四 专题二（先查文本歧义/主线程冻结，DPR 低先验） | playbook §专题二深度 |
| 同文名多候选 / 多层 iframe 定位拿不准 / flow target 写作前 | `cdp.js locator probe` 列候选 → `suggest` 递归收窄 → `verify` 高亮截图确认 | `cdp.js locator pick` 点击拾取直接得建议 target；方法 → playbook §元素捕获方法论 |
| 营销弹窗/遮罩阻断页面，× 无 uid / 目测坐标点不中 | §四 专题三 → `snippets/popup-close-scanner.js` 直接扫（锚点→容器→右上角网格） | playbook §专题三深度（机制/参数/验证闭环） |
| 电商促销弹窗在 **flow replay** 期遮蔽目标（定位/断言挂） | `flow replay --popup-guard`（DOM 层守卫 + 双层规则库；留痕 `__cu_pg_log` 摘要） | 上线前误杀检验 `cdp.js popup-guard test --target <页>`；规则与纪律 → playbook §专题三深度·popup-guard |
| flow replay 失败 | 失败报告 tmpdata/flow-fail/flow-fail-*.json（attempts/candidates/截图） | playbook §flow 回放守则（self-heal retry≤1；retry 用尽或结构性失效→任务优先降级：record 伴跑探索完成+收尾报告失效原因） |
| cdp.js 报错（Node 版本/连接/超时） | install.md §0 工具层运行要求（Node≥22） | playbook §逃生舱使用纪律 / facts 工具层实测 |
| CDP 通道整体失效（MCP 全挂/疑似浏览器坏了，不知道该不该重启） | 一键取证：`node tools/cdp.js doctor-forensics --symptom "<来源/目标页/错误码>"`（通道全死也落盘+八层分型 advisory） | playbook §逃生舱·失效分型取证协议 v1（runbook+分型→恢复映射+重启批准线三级：gateway restart 不杀 tab < browser-restart < 容器重启） |
| 配置改了不生效 | 改的是运行层真身吗（install.md §0 红字） | restart 了吗（restart 归属纪律） |
| `--check` 报 drift | 装机侧是否被手改 | 重装；源侧改动是否该走推广流程 |
| config.jsonc 相关报错 | 漏跑 `--init-config`？手改坏了？ | selftest.js #16 的逐键提示；schema 不一致查 CHANGELOG |
| 操作/回放「成功」但后续连锁失败（日志✓画面✗） | 排障总纲元规则（视觉优先+分层归因） | 前置操作条件第一假设 → playbook §排障总纲归因表 |
| 应用页面上操作反常 | webapps/ 识别特征与已知坑 | TODO.md INBOX 查重后追加 |
