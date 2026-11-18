# chromeuse facts — 技术事实表

> 只记事实（默认值 / 实测表现 / 来源），不记推荐值（推荐值唯一真源 = config 模板/实例，定性引用见 playbook/SKILL）。

## 超时链路：-32001 打在哪一侧

```text
opencode (MCP 客户端，timeout 默认 5000ms，按 MCP 条目可配)
   │  请求级超时 → -32001 在客户端侧产生（MCP JSON-RPC 自定义错误码）
   ▼
chrome-devtools-mcp (MCP server)
   │  工具 handler：waitForStableDom 稳定等待 3000ms×multiplier；stableDomFor 100ms；
   │  navigationTimeout 3000ms×multiplier；expectNavigationIn 100ms
   ▼
Puppeteer protocolTimeout：默认 180s（协议级兜底，重冻结时轮不到它生效——客户端先超时）
   ▼
Chrome CDP ──▶ renderer 主线程（被长任务占死 = 一切需主线程协作的命令排队）
```

- 重页面一个 snapshot 本可能 10~30s 返回（或主线程喘息后返回），但客户端默认 5s 先报 -32001——这是"连 `document.title` 都超时"的叠加成因（主线程长任务 + 5s 客户端超时）。
- 推论：调大客户端 timeout 是单一最高杠杆；代价是真死锁时报错变慢，须配合轻探针纪律（SKILL.md 专题一）。
- chrome-devtools-mcp 未暴露 per-tool timeout 给 MCP 客户端；上游相关 issue #786 / #116 / #1921 均为 Open，无针对重页面缓解的 PR 被合并（截至 2026-09）。

## CDP 域进程归属表（通道分级的架构依据）

| 域 / 方法 | 进程侧 | 需 renderer 主线程 | 实测表现 |
|-----------|--------|--------------------|----------|
| `Page.captureScreenshot` | 合成器线程 | ❌（合成器独立于主线程绘制） | 冻结期 7+ 次全成功 |
| `Network.getResponseBody` / `getRequestPostData` | 浏览器进程/网络服务 | ❌（网络层数据在 browser 侧缓存） | **架构推断冻结期可用、实测见【冻结期 Network 域可用性实测】** |
| `Performance.getMetrics` / `Target.getTargets` | 浏览器进程 | ❌ | 可用 |
| `Page.addScriptToEvaluateOnNewDocument` | 浏览器进程（仅注册） | ❌（执行在下次导航时） | 可用（initScript 参数） |
| `Runtime.evaluate`（evaluate_script） | renderer | ✅ 必须主线程空闲 | -32001 |
| `Accessibility.getFullAXTree`（take_snapshot） | renderer | ✅ 必须主线程空闲 | -32001 |
| `DOMSnapshot.getSnapshot` | renderer | ✅ | 必须主线程 |
| `Page.navigate` / `Target.closeTarget` | 发起在浏览器侧，**完成确认需 renderer** | ⚠️ 部分 | -32001 |
| `Input.dispatchMouseEvent`（click_at） | 浏览器→renderer | ⚠️ 分发快于 evaluate/遍历恢复 | 完全冻结时也可能超时 |

**已证实**：截图能活 = 合成器线程独立；snapshot / evaluate 必死 = renderer 主线程被长任务阻塞。DevTools 里页面卡死时网络面板照样刷新，同一机制。

## 截图失败归因与 fromSurface 双路径（外部知识摘录，2026-09-19 落）

> 来源：用户与 GPT 讨论「Chrome截图失败原因解答」（2026-09-17，chatgpt.com 会话 6aac2192-82b8-83ee-be2a-300f417824bb），2026-09-19 翻查摘录。核心警告：**不要把「截图失败」直接等同于「合成器冻结」**——截图依赖完整视觉输出链路（Renderer→Paint→Compositor→GPU/Surface→CDP 传输），任一环异常都可致败。

- **fromSurface 双路径**：`Page.captureScreenshot` 的 `fromSurface:true`（默认，从 Surface 合成输出取图）与 `false`（从 View 路径取图）是**两条不同截图路径**，行为可分化。`true 败/false 成` = 有价值诊断信号（路径分化）；两者皆败 = 更底层异常（渲染输出不可用/资源状态）。降级须由诊断逻辑裁决（allowFallback），**不可无条件切换**。
- **页面隐藏态**：Chromium 源码注明——页面完全隐藏时 Surface snapshot 可能因 Surface 从未呈现而**停滞**。与已定因的「Chrome 只可靠截活动标签（多标签 race，V202609130003 librarian 研究）」相互印证；排查时检查目标 Tab 前后台 + 截图前后有无 Tab 切换/浏览器重启。
- **captureBeyondViewport:true**：超大页整页截图带来位图内存/绘制编码/WS 传输三重压力——自动化勿默认整页截图。
- **失败时诊断矩阵**（GPT 建议的判别组合）：截图失败同时记录 Runtime.evaluate 成败、`Page.getLayoutMetrics` 成败、fromSurface 双路径结果、页面可见状态、参数与耗时。判读：runtime 通而截图败 = 截图路径异常；runtime 也败 = 更广泛阻塞；fromSurface 分化 = 路径兼容性问题。
- **策略优先级（GPT 排序）**：①截图超时+诊断（防无限卡）②Target/页面状态检查（连接/隐藏页）③fromSurface 降级尝试 ④Tracing+浏览器日志 ⑤浏览器恢复（明确需要才做，避免误重启）。
- **chromeuse 已对照**：①②已落地（screenshotHardened 超时+bringToFront 前置+重试、doctor screenshotProbe 前兆探测，V202609130003）；screencast 帧流与截图是不同原语、底层视觉输出异常时两者同受影响（勿互当降级）。**新增量候选**：fromSurface:false 降级路径 + 失败时诊断矩阵（TODO INBOX 2026-09-19 登记）。

## chrome-devtools-mcp 内部缓解参数（源码证实）

| 参数 | 行为 | 局限 |
|------|------|------|
| `evaluate_script` 的 `waitForStableDom: false` | 跳过 3s DOM 稳定等待（MutationObserver） | 主线程本身阻塞时救不了 |
| `navigate_page` 的 `initScript` | 预埋钩子（= `Page.addScriptToEvaluateOnNewDocument`） | 执行要等下次导航 |
| `--experimentalVision` → `click_at(x,y)` | 坐标兜底（Input 域） | 完全冻结时同样超时 |
| `take_snapshot` 的 `verbose` | 全量/精简 a11y 节点 | **无 depth 参数**（Playwright MCP 有） |

## Playwright MCP 四层超时对照（方案二依据；当前未启用，gate 见【Playwright MCP 并存实测（事件竞争+超时调优）】）

| 维度 | chrome-devtools-mcp | Playwright MCP |
|------|---------------------|----------------|
| action 超时 | 无 per-tool 超时 | `--timeout-action`（默认 5000ms） |
| navigation 超时 | 仅 navigate_page 的 timeout 参数 | `--timeout-navigation`（默认 60000ms） |
| settle 等待 | 固定 3s 稳定窗口 | `--timeout-settle`（默认 500ms） |
| CDP 连接超时 | 无 | `--cdp-timeout`（默认 30000ms） |
| 快照深度 | 无 depth 参数 | `browser_snapshot({ depth })` |

快照实现差异：两者底层同为 `Accessibility.getFullAXTree`，Playwright 加自有裁剪逻辑支持 depth 限制——重页面上降级更优雅，但**同样受主线程拖累**，换工具不解决根因。

## 工具层实测事实（2026-09-07/08，NAS chrome-browser:9224）

| # | 事实 | 细节 |
|---|------|------|
| 1 | **pageId 必须显式传** | `take_screenshot` / `take_snapshot` 不传 `pageId` 时不跟随 `new_page` 输出的 `[selected]`——报错或作用在错误标签页。每次调用显式带 `pageId`（`list_pages` / `new_page` 输出里取） |
| 2 | **截图像素 ≠ 视口 CSS 像素** | 截图按物理像素输出（DPR 缩放）：本容器 1280×560 @ DPR 1.5 → 截图 1920 宽。`click_at(x,y)` / 一切坐标兜底**必须用 CSS 坐标**（截图像素 ÷ DPR 回算）。注（V202609080010）：DPR 缩放换算事实保留；"DPR 幽灵菜单"因果已撤销——DPR 降为低先验排查项（SKILL.md 专题二勘误版） |
| 3 | **ChatGPT 页冻结时间线（截图通道边界实证）** | 硬阻塞时 `take_screenshot` 与轻探针 `evaluate_script(readyState)` **同时 -32001**（合成器通道也失效——截图并非恒可用）→ 不做任何操作等待 ~20s → 轻探针自行恢复。两条教训：①截图"通常最后失效"但非保证；②存在**自愈型冻结**——等待 20s 是纪律不是消极（看门狗 watch 的 120s 判定窗 = 此实测的 6× 余量） |
| 4 | **flatten 会话的 Page 域陷阱（S1 spike）** | 经 browser 端点 + `Target.attachToTarget(flatten)` 的多路复用会话：`Page.addScriptToEvaluateOnNewDocument` **必须先 `Page.enable`**，否则命令成功返回 identifier 但脚本被静默忽略（2026-09-08 Chrome 151 实测；Runtime 域同理需 enable 才有 executionContext 事件）。同会话实测：initScript 对**运行期新挂同源 iframe 自动覆盖**，无需逐帧补注入 |

## 后台 tab 节流四格对照（2026-11-04，清理批 C3；全报告=tmpdata/c3/report.md）

- **等待/采集通道无后台退化**：wait 命中/evaluate/console 推送（p50 1ms 级）/CDP 轮询/工具与 raw 截图（后台 5/5 成功，raw 不置前帧龄 105~258ms）全正常（Chrome 153 轻页；重页面/被遮挡窗口未覆盖）。
- **页面自身定时器被 Chrome 钳制=四格唯一差异源**：后台 `setInterval(200ms)`→~1000ms、rAF 完全停摆、`setTimeout(4000)` 落 1s 栅格（4067~4986ms）——「后台等待变慢」的真相是页面定时器，非工具通道；等待预算按 1s 栅格设定。
- `Page.bringToFront` 生效 7~36ms（ensureForeground「置前后立即复核」写法成立）；focus emulation/`Page.setWebLifecycleState` 均无效不立项。
- **方法论**：共享浏览器做对照实验必须逐拍记录 visibilityState+污染过滤（外部操作干扰会中途翻转可见性，污染样本作废重采）。
- V202610220003「后台 30s 超时/旧帧」在 153+轻页**未复现**（不能断言缺陷消失，边界如实）。

## DOMDebugger.getEventListeners 命令级监听器查询（2026-09-17，Chrome 151，E2 深挖机制验证）

| # | 事实 | 细节 |
|---|------|------|
| 5 | **命令级查询与 exec 属性探测覆盖互补：addEventListener 只能靠命令级查** | 查询语义：`DOMDebugger.getEventListeners` 按"直接挂载对象"返回监听器——元素自身 addEventListener 在元素上可查；父容器/document 委托**查 target 元素为空、查容器/document 才有**（委托不落在 target 上，实测语义正确）。exec 属性探测（枚举 on* 内容属性 + for-in 原型链 on* 处理函数属性）对全部 addEventListener 形态恒为盲，仅 inline onclick 属性可查（onAttrs/onHandlerProps 双现）。使用要点：①**只收 `objectId`**（`Runtime.evaluate` returnByValue:false 或 `DOM.resolveNode` 获得；直传 `nodeId` 报 -32602 Invalid parameters）；②**无需 DOM.enable/Runtime.enable 即可查**（实测未 enable 直查成功）；③listener 结构 `{type,useCapture,passive,once,scriptId,lineNumber,columnNumber,backendNodeId}`，**lineNumber 为 0 基**（编辑器行号−1），handler/originalHandler 本环境实测为 null（要函数体另走 `Debugger.getScriptSource(scriptId)`），inline onclick 的 handler 带**独立 scriptId**（与页面主脚本区分，可判绑定来源）；④`depth:-1` 一次查整棵子树（depth:0/1 只查自身/一层；document 委托在 html 子树结果中不出现——document 在 html 之上）；⑤取节点两路径等价：`DOM.getDocument+querySelector` 与 `Runtime.evaluate→DOM.requestNode` 所得 nodeId 一致。四形态合成页全量数据与报告：`tmpdata/e2-live/`（gitignored：e2-synth-page.html / e2-cdp-listeners.js / e2-cdp-listeners-result.json / e2-report.md） |


> **⚠ objectId 会话边界坑（2026-09-19 实证）**：`Runtime.evaluate`（returnByValue:false）所得 objectId **必须在同一 CDP 会话内消费**——跨进程复用（每次 `cdp.js exec` 独立连接）会让 getEventListeners 静默返回**假 0 条**（document 活性对照也 0 即为伪信号；页面 JS 明显活跃时 document 直查=0 即可判定手法失效）。正确姿势=单会话脚本（连接→evaluate→查询→断开一气呵成，复用 tmpdata/erp-listeners-probe.js 双通道互证范式：jQuery._data 缓存直读 + 同会话命令级查询交叉验证）。
> **真实场景补证（2026-09-17，tmpdata/e2-live/real/）**：登录达成（126 桌面图标）后实测——桌面图标自身 12 条监听器（11 条 jQuery v1.12.4 绑定 exec 全盲+1 业务 click）；面板图标 DIV.app-item 为 inline onclick=menuClick（exec 可见，与桌面图标异族）；行为 A/B：flow 同款 80ms hold 点击全链到 document、免疫未复现——「CDP Input 免疫」绑定层归因排除，最强候选=winui 事件接线时序（os-login 首击 ~T+15-20s 接线滞后窗口同源观察）。

## 跨 iframe 元素 recon：indexOf===0 陷阱（2026-09-18 踩坑）

- **现象**：跨 iframe 收集元素时用 `iframeName.indexOf(target) === 0` 判「目标串是 iframe 名前缀」——iframe 的 `name` 实际带 `iframe` 前缀，目标片段不在第 0 位，判据恒 false，recon 静默漏帧。
- **正确口径**：用 `indexOf(target) >= 0`（包含语义）或**完整前缀**（含 `iframe` 前缀整体比较，如 `name.indexOf('iframeForm') === 0`）。写判据前先打印实际 `frame.name` 再定锚，勿凭印象拼前缀。
- 关联：`locator probe` 的 framePath 采集（V202610190001）已按完整 frame 链输出，可作为跨 frame recon 的现成数据源。

## 跨平台行尾口径（Windows CRLF，2026-10-28 检出实证）

- **逐行解析一律 `split(/\r?\n/)`**：`split('\n')` 在 CRLF 文件下每行留尾随 `\r`——行数不变（计数类断言不报警），但行首/行尾结构判断会静默失真。
- **行首/行尾结构匹配一律带 `\r?`**（正则）或**先归一再切**（`src.replace(/\r\n/g, '\n')`）：如 `indexOf('\n  }\n}')` 这类整串切片在 CRLF 下恒 -1，切片退化成「到文件尾」，断言变假阴性。
- `split('\n')` 仅允许「取首行当错误消息」类容错场景（如 `(r.stderr || '').split('\n')[0]`），**不得**用于结构断言/逐行解析。
- 依据：2026-10-28 Windows 端检出——`lib/matchers.js` 的 jsonc 围栏正则（开围栏后紧跟 `\n`）在 CRLF 的 webapp.md 上恒不命中 → `extractMatchersMd` 恒 null（回放安全阀静默失效）；selftest 同类切片断言同时假阴性。修复口径=本三条（ISSUE-1 批）。

## 多 agent 协作事实（orchestrator 工作流，2026-09-17 ~ 2026-10-28）

- **并发 fixer 期间 commit 必须精确路径 add**：`git add -A` 会卷入并发任务正在写的文件（2026-09-17 d4da71c 把 fix-17 的 facts.md 卷入——内容本要入库、仅归属混杂）。收尾清扫才用 `add -A`。
- **oracle/council 无文件写权限**：产出只存在回复文本，由 orchestrator 代落盘；给只读 agent 派产出任务须写明落盘责任方，否则 fixer 按路径读不到。
- **council 是综合席**：先并行派三议员，再 revive council 综合；不把 council 当单一议员用。
- **TODO.md.bak 只追加不改写**（历史规则）：**2026-10-28 台账三件套重构后该文件废止**——git 历史替代归档（`git log -p -- TODO.md`），本条仅存档。

## 来源链接

- opencode：`packages/core/src/v1/config/mcp.ts`（timeout 默认 5000ms、按 MCP 条目可配——-32001 真凶，源码证实）
- chrome-devtools-mcp：`src/utils/WaitForHelper.ts`（180s protocolTimeout / 3s 稳定等待）、`src/tools/script.ts`（waitForStableDom）、`src/tools/pages.ts`（initScript）、`docs/configuration.md`（--experimentalVision 等）
- CDP 协议文档：https://chromedevtools.github.io/devtools-protocol/tot/
- 截图失败归因/fromSurface（用户-GPT 讨论摘录，2026-09-17）：chatgpt.com 会话 `6aac2192-82b8-83ee-be2a-300f417824bb`「Chrome截图失败原因解答」
- Chromium 合成器线程架构：https://www.chromium.org/developers/design-documents/compositor-thread-architecture/
- Playwright：connectOverCDP 文档、playwright-mcp README（CLI options）
- 调研底稿（现集中于 `opencode/root/.config/opencode/skills/chromeuse/reports/` 知识库）：`reports/report_20260907_001_chrome-devtools-mcp-heavy-spa-timeout-research.md`（CDP 架构/源码级分析）、`report_20260907_003_浏览器自动化方案分析报告.md`（方案全景 + 选型判断）
