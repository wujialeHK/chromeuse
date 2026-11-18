# chromeuse playbook — 操作深度手册

> SKILL.md 是浓缩主干（决策树 / 纪律），本文件是深度版：完整命令、完整示例、边界细则。同一事实只在一处维护——操作细节归本文件，指南 4.2 只留方案级摘要 + 指针。
> 行数预算：≤600 行（V20261117005 批B/R3 由 575 扩限；selftest #4 守门）。

## §通用深度

### §使用模式总览（四场景闭环）

- **场景① 探索**（新应用/新路径）：视觉优先逐步确认——MCP `take_screenshot`/`take_snapshot` + `click`/`fill` 一步步走通，每步视觉确认（→ §排障总纲）；应用识别特征先查 `webapps/`。
- **场景② 演示复现**：人类演示 → `record -v` 录制 → `events-summary`/`diff-video` 结构化预处理 → 蒸馏产出 flow 草案 + webapp 知识 + 坑清单（协议见 references/distill.md）。
- **场景③ 固化 flow**：蒸馏产物落 `webapps/<app>/flows/*.flow.json`（语义定位/条件 wait/0AI 回放）——`flow validate` schema 过 → `flow replay` 纯 CDP Input 真实事件回放（→ §flow 回放守则）。
- **场景④ 回放自诊断**：失败即停出结构化报告（candidates/rejected/**diagnosis 分诊**）→ self-heal retry ≤1（交互修复该步→更新 flow）→ 二次失败交人工演示兜底（回流场景②）。
- 闭环：①探索产出理解 → ②演示产出事件流 → ③蒸馏产出 flow → ④回放失败回流②/③——四场景全部映射既有命令与协议，不新增机制。

### §临时 config 实例（`--config`：多环境切换 / 跨平台测试，V20261117005 批B/R3）

- 一行切换：`node tools/cdp.js --config tmpdata/desktop.jsonc probe --json`——flag 位置无关（`--config x <cmd>` ≡ `<cmd> --config x`，也认 `--config=x`），整份实例生效（`environment`/`mcp.browserUrl`/`bin` 全换），相对路径按**当前 cwd** 解析，仅本进程有效（不改 `config.jsonc`；`--async` 作业子进程经 `CHROMEUSE_CONFIG_PATH` 自动继承）。
- 典型场景：①同一台机器在 NAS 实例与桌面实例间来回验（临时实例改 `environment`+`browserUrl`+`bin`）；②跨平台语义测试（Linux 上跑 `environment: windows` 实例 = PATH/exe 探测按 Windows 规则，启动一行「不一致」warn 属正常用法）；③后续 R2 `browser-up` 的 launch 场景将以「临时 config 写 chrome 三键 + browserUrl」驱动拉起（批C 落地后补此处指针）。
- 与 `--url` 分界：`--url` 只覆盖 browserUrl 单值（优先级最高）；`--config` 换整套实例。fail-fast：文件不存在/坏 JSONC → exit 1（不回落主实例）。机制 → mechanisms §25；装机口径 → install.md §0「多环境切换」。

### 多标签管理

- `list_pages` 列出全部标签 → `select_page` 切换；`new_page` 开新页，`close_page` 关闭（完成确认需 renderer，冻结期会卡）。预期管理：部分业务系统（如示例ERP OS）的模块在**页内打开**——点击图标后 URL 不变、无新标签页，"操作必然出新 tab"的断言不成立（查 webapps/ 识别特征确认）。
- **开页/取 pageId 首选 `openTab`（`snippets/tab-helper.js`）**——推荐所有会话使用：一步完成「前置快照差分+并发锁+新页 id 解析」，替代「手写 `new_page` 再 `list_pages` 校准」旧模式；跨步骤引用用 `findTabs` 现查、操作前校验用 `assertTab`；边界与并发语义见下节。
- **页签生命周期成规（S3+S5；工具面已由 tab-helper v3 承载，此处为纪律面）**：①会话内维护 url→pageId 映射（`openTab` 返回即登记），**closeTab 后立即作废**对应条目；②发现**同 URL 双页签** → 立即关一只（留先开者）再继续——重复页签是「点错页/采错页」事故的温床（10-13 会话三组重复实证）；③多页签并行采集模板=`Promise.allSettled` + 各自 openTab→采集→closeTab 闭环，**同域客服类页面禁并行**（jdcs.jd.com 多页签并存互踢会话，单页签复用）；④`new_page`/点击入口报错后一律 `list_pages` 复核再判死活（慢站超时≠失败，页可能已开——上节同款纪律的操作面重申）。
- **并行采集每 worker 独立页签（F10，2026-10-21 他方实测；2026-10-23 再证）**：多 worker 并发采集 = 各自 `openTab` 拿独立页签（独立 targetId）；**同一页签被多方并发驱动 = target 被导航/关闭竞态**（症状 `Inspected target navigated or closed` / `Not attached to an active page`；实证 4 worker 经 `--reuse` 复用一页 → 140 篇中 21 篇失败，改各自 new_page 后 140/140；**2026-10-23 补充品牌批 4 路并行 48/48 零失败·约 7 分钟再证**）；单页签复用仅限**串行**任务（如 §页签生命周期 ③ 的同域客服类）；跨会话互斥锁只保 **pageId 获取**（tab-helper v3），**不保「同一页签被多方并发驱动」**。

### §页签礼仪（2026-10-09 用户裁定）

- **专属页签**：agent 用浏览器必须 `new_page`（或 `openTab`）开自己的专属页签。
- **绝不复用 / 导航 / 刷新用户已开的页签**（含 `navigate` 到用户页签）——共享浏览器已有页签=用户在场，动它=污染用户现场。
- **任务结束必须关掉自己开的所有页签**，还原浏览器状态（`closeTab` 闭环；异常路径也要关）。
- 实现：`snippets/tab-helper.js` 的 `openTab` / `closeTab` / `assertTab`；并发与锁语义 → §多标签管理。**与 §视口三态策略配套**：已有页签=用户在场，永不 emulate 视口。
- **CLI 侧 agent 页签治理（C8 #123，`cdp.js new/close`）**：`new` 开的页签登记 `tmpdata/tab-registry/agent-tabs.json`（`targets` 文本打 `[cu]`；about:blank 设 title 前缀 `cu-`），命令末尾顺带回收「登记且空闲 >10min」的 agent 页签（config `tabs` 可调，单次上限 5）；**未登记页签=用户页签永不回收**，回收绝不 activateTarget/bringToFront。收工仍以显式 `close` 为准——回收是兜底不是替代（flow 自建页签/MCP tab-helper 路径不登记，永不回收）。

### 人机接力 handoff（2FA/支付/审批交还用户，C2 #128）
- **何时用**：需要用户在本页签完成 2FA/支付/审批/captcha 时，`cdp.js handoff --reason "2FA 验证码" [--target 页]` 即返 `⚠⚠⚠ HUMAN REQUIRED` 横幅——把横幅（含 `touch "<signalPath>"` 全文命令行）醒目转述给用户；工具永不替用户置前页签（用户自己切）。
- **续跑时序（两段式）**：用户会话说「好了」→ agent 执行横幅里的 `touch "<signalPath>"`；`cdp.js handoff --wait <id>` 必须放**后台 shell 轮询自转**（2s 感知信号，confirmed exit 0 / 超时 E_TIMEOUT exit 1，循环内零模型参与）——严禁前台跑 --wait 挂住回合；用户消息与 --wait 完成任一先到即推进（信号文件存在性=唯一事实，天然幂等）。
- 状态查询 `--status [<id>]`，放弃用 `--cancel <id>`，超时页签保留不关；契约 → mechanisms §23。

### pageId 与坐标换算（工具层实测，2026-09-07/08）

- **pageId 显式传参**：`take_screenshot` / `take_snapshot` 必须显式带 `pageId`（`list_pages` / `new_page` 输出取）——不传不会跟随 `new_page` 的 `[selected]` 标记，报错或作用在错误标签页。
- **pageId = 共享浏览器全局递增序号，不可预测、不可记忆（2026-10-14 用户裁定+实测落地，v3 含并发锁）**：序号全局单调递增、关页不回收——用户与 agent 共用浏览器，用户开过又关的页消耗序号（新开页 id 可能从 3 直跳 6）；「记忆的历史 pageId」必漂移。修复=**跨会话互斥锁 + 前置快照差集**：①锁（v3）=专用锁页（title `__chromeuse_newpage_lock__` 空白页）上的 window 变量 CAS——页面 JS 单线程 ⇒ 检查+写入原子（实测双并发恰一个赢家），串行化「快照→new_page→解析」全序列，持锁窗口仅几百 ms、30s 死锁过期、超时降级无锁执行；②差集=快照后新出现 id=候选集（单候选直取；多候选按 url 唯一→`[selected]` 证据链，均不唯一**不猜**——对齐「候选>1 诚实红」纪律）。锁只协调「同用 helper 的调用者」（用户手动/绕过者不在锁域）——与差集互补分层（锁=防极紧交叉，差集=无协调也安全）、**跨步骤引用按 URL/title 现查**（不信任记忆）、**报错后（超时/No page found）先 `list_pages` 复核**（慢站超时≠失败，页面可能已创建）。工具：`snippets/tab-helper.js`（parsePages/findTabs/openTab/closeTab/assertTab，编排侧片段，v3 含锁，E2E 含 Promise.all 并发与锁竞争全场景）——**开页/引用/校验的首选路径（推荐所有 agent 会话使用，勿手写 new_page→list_pages 校准）**。
- **截图像素 ≠ 视口 CSS 像素**：截图按物理像素输出（DPR 缩放）。本容器 1280×560 @ DPR 1.5 → 截图 1920 宽。凡坐标兜底（`click_at` 等）**必须用 CSS 坐标**：从截图量到的像素 ÷ DPR 回算后再传；DPR 查询 `evaluate_script("()=>window.devicePixelRatio",{waitForStableDom:false})`。
- 坐标换算（截图像素 ÷ DPR = CSS 坐标）是坐标类故障排查清单第一项；但"点不中"的优先排查项是文本匹配歧义与主线程冻结（专题二，V202609080010 勘误），DPR 仅低先验。

### §MCP 交互模式纪律（熔断/落盘/先探后换，2026-10-14 护腰复盘批 D1+D2+D3）

MCP 交互模式（编排侧直接调 chrome-devtools 工具，非 flow 回放）的止损三纪律——flow 引擎侧已有等价机制（retry≤1 / 假绿闸门），本节补 MCP 模式的空缺：

- **D1 操作级循环熔断（= SKILL 红线 #10）**：同一目标（点中某按钮 / 提取某数据 / 打开某面板）**连续 3 次不同策略**未果 → 强制止损。止损动作 = ①报告已试路径清单（每条：策略 / 报错 / 截图）②降级处理（换通道取证 / 转人工入口 / 交用户决策）。严禁第 4 次。「不同策略」判据 = 定位方式或通道**实质变化**（换锚点 / 换原语 / 换通道算不同；**同法重跑不算**）。实证：京造客服「转人工」7 轮换选择器循环，用户 23:18:07 打断——若第 3 轮熔断可省 4 轮。
- **D2 大采集阶段性落盘**：长会话大采集（>20 条数据或多页翻页）每阶段把已采摘要落 `tmpdata/`（json/md 均可）——防上下文压缩后明细丢失只能整段重采；落盘粒度 = 单页/单批次，含采集时间与页码，命名带会话标识。
- **D3 提取失败「先探后换」**：evaluate / 提取返回空（`[]`/null/空串）→ **先跑结构探针**（读容器选择器 / 子元素结构 / 文本样本 5~10 条）确认 DOM 形态，再**定向**换提取法（换锚点 / 换层级 / 换 frame）；**禁同法重跑**——空结果 + 同法 = DOM 里根本没有目标，重跑必然还空；先证明「元素在哪」再取「元素内容」。与 D1 联动：先探后换的每次「换」计入熔断计数（3 换即止损）。
- **反爬/验证码处置（= SKILL 红线 #12，严禁硬刷）**：遇滑块 / 验证码 / 「环境异常」/「请在微信客户端打开」类拦截 → ①截图取证（禁猜）②**最多一次**点「去验证」或完成验证（A7 实证一次即放行）③仍未过 = 转人工 + 如实报告。严禁连续硬刷 / 换 UA / 换 IP 反复试探（同 D1：第 4 次 = 违令）。出口 IP 语义：数据中心 IP 访问 `mp.weixin.qq.com` 文章页会**全量弹验证码**（A10）——改真实浏览器出口或转人工，不要在数据中心 IP 上刷过。

### §操作路径红线（细则）——模拟人类双红线路径层（V202609100001）

- **机制**：点击 ≠ 导航——点击承载选中态、上下文参数、后端预取回发（前端把状态写进服务端会话），goto 只做页面加载；「点应用等效打开某 URL」在 URL 层面成立、业务层面不成立。
- **取证法**：怀疑等价时用**网络域对比**——`list_network_requests` 分别采「点击路径」与「直达路径」的请求序列，差异请求即点击写入的隐藏业务上下文；序列一致才可谈等价（仍受下条判定法约束）。
- **案例卡（2026-09-10 库存锁定 landing 漂移）**：sales-order-inventory-lock.flow.json 步骤 3 goto 直达应用 URL，步骤 8 双击「销售订单」后落**业务地图 landing（应用首页）**而非订单表单——步骤 9 等「库存锁定」底栏 60s 超时；同 flow 旧实录（走门户桌面点击链）三连过直达表单。症状一句话：**直达 URL 跳过了门户点击链承载的组织/域选中态与后端上下文写入，应用 landing 随会话漂移**。
- **等价判定法（可执行规则）**：唯一安全的 goto 替换 = 录制事件流中该步**本来就是 navigate** 且其前无同点 click；凡录制流中有 click 在先的导航，回放一律回放 click（不得改写为 goto/直达 URL）。
- **与「不得跳步」的概念区分**：跳步 = 前置 UI 状态缺失（菜单没开就点菜单项，归 §前置操作条件域）；抄近道 = 路径业务语义丢失（换导航方式绕过点击，归本节域）。两者症状都是"后续走不下去"，归因时先问"动作序列是否与录制一致"再问"前置状态是否满足"。
- **例外条款**：用户显式声明的测试场景（漏洞测试 / 越权验证 / 直达对照取证）可 goto/直达，但必须**例外留痕**（flow 步骤 desc 注明"测试场景例外"或会话说明）。
- **电商调研域内豁免（D4，2026-10-14 用户裁定）**：同任务内「搜索商品 → 结果列表 → 批量点击进入 → 查看 → 回退 → 再进入」循环场景，当**点击效果与 URL 直达等价**（列表点击仅做导航、无加购/选中态等业务写入——可用网络域对比验证）时，为效率可豁免 goto 直达禁令：直达商品详情 URL 替代「回退→再点击」往返（10-13 会话 19 次直达未触发风控实证）。**边界**：仅限查看型循环；首入口（首页→搜索→结果列表）仍走完整人类路径；加购/下单/领券等有业务写语义的操作**绝不豁免**；判定不确定时回退默认红线。

### §交互原语可靠性（V202609100001）——双红线操作层细则

**可靠性排序**（降序；与 红线 #1 事件可信性、SKILL §一 步骤 4 闸门语义配套使用）：

| 优先级 | 原语 | 理由 | 实证 |
|--------|------|------|------|
| 首选 | 鼠标点击（click / dblclick） | 事件链最短、无焦点/状态前置依赖——直达目标元素 | 各应用通用稳定 |
| 次之 | 键盘 Enter / 组合键 | 受焦点位置、composition（IME）状态、应用自定义 keydown 拦截影响——同一按键跨语境行为不同 | ChatGPT 输入框 Enter ×2 不发送（改点发送按钮 ✓）；示例ERP winui 桌面 Enter 依赖内部状态机 |
| 禁止 | JS 合成（dispatchEvent） | isTrusted=false，系统监听链不认 | 示例ERP填单价后金额恒 0 |

**降级/换形原则**：键盘原语无效时**换鼠标点击等效元素**（Enter 发送 → 点发送按钮）；**不做自动降级**——一次原语失败即显性化（截图 + 闸门确认），由操作者决定换形：明确性优于便利（自动循环换形会把"原语失效"掩盖成"慢一点成功"，破坏断裂点定位）。

**应用差异实例**：同为 Enter——ChatGPT 输入框不发送（keydown 拦截/焦点态）、示例ERP表单内 Enter 触发确认、winui 桌面 Enter 走内部状态机；winui 桌面"双击无效、单击有效"与左侧栏"模块项需双击"并存——**原语有效性逐应用逐场景实测登记 webapp.md，不跨应用外推**。

**交叉引用**：合成禁止的根 = §事件可信性红线（细则）；失败后的闸门确认 = SKILL §一 通用操作循环步骤 4。

### §拟人化六条（2026-10-09 用户裁定全量）

**总则**：chromeuse 抓数据 / 逛电商**一律模拟人类 UI 操作**，**禁止接口直查**——**JSONP / fetch 后台 API / cookie 重放**三种手段都不得用来替代 UI 采集。与 SKILL 红线 #1（事件层 `isTrusted`）、#2（路径层业务语义）合称**拟人化三层**：事件可信 / 路径拟人 / 数据通道拟人。**边界区分**：专题一「Cookie 重放接口」是页面冻结时的**只读取证**手段（读网络域 / 回放只读请求取数），与本总则「禁用接口直查替代 UI 抓数据」不冲突——**取证可用，采集不可**。

六条硬纪律（2026-10-09 同日二级强化，用户严厉纠正；每条都是踩坑后立的）：

1. **① 出问题第一动作=截图看画面**（弹窗 / 遮挡 / 加载态）——严禁不看画面瞎猜选择器、瞎换方案。**视觉优先是元规则**：先看清现场，再谈定位与归因。
2. **② 交互优先真实鼠标点击**（事件链最短，通常都 OK），键盘次之——键盘受焦点 / composition / 应用 keydown 拦截影响；原语可靠性排序与降级原则 → §交互原语可靠性。
3. **③ 严禁 URL 直达导航代替站内操作**——搜索结果页 / 商品页都算：真人从首页搜索框输入+点搜索按钮进，哪有直接敲 URL 的；`goto` 仅限首次打开站点首页（例外与豁免 → §操作路径红线：用户显式测试场景、电商查看型循环 D4）。
4. **④ 只读 DOM 探查可用**——`evaluate_script` 读已渲染内容（读值 / 列索引 / 滚动定位 / DOM 探查）合法，仍须 `waitForStableDom:false`；写操作 / 合成事件仍禁（红线 #1）。
5. **⑤ 弹窗处理（同日二级纠正）**：页面弹窗 / 遮罩必须用鼠标点击 × 或「关闭 / 知道了」按钮关闭——**Escape / 键盘不可靠（实测不生效）**；且关闭后必须**视觉确认弹窗真消失了**才能继续下一步——严禁操作未确认完成就连做后续步骤（**每步验证是闸门**；实测未确认连做 3 步全军覆没）。
6. **⑥ 弹窗 × 定位法（v202610090001 落地）**：弹窗点不中直接调 `snippets/popup-close-scanner.js`（锚点→容器→右上角网格扫描→`click_at` 中心坐标；验证=`rect 归零(0×0)`）；**目测坐标必偏（实测偏差 64px）**，坐标点击只允许来自 DOM 实测 rect。细则 → §专题三深度。

> 迁移说明：本节全量承接 conventions 记忆「浏览器操作拟人化（2026-10-09 用户裁定，同日二级强化）」条目，记忆侧只留指针；两处冲突以本节为准。

### §LLM 目标引用边界

- **边界**：运行期 LLM 基于本次观察选目标——只能引用观察到的节点引用（index/uid/text+container），不得凭推测直产 selector/坐标/JS 交执行（结构性防线已定：target-resolver 四层链+flow-engine P0-2 白名单，本节为条款成文，不新增红线编号）。**wait 纪律（同批并入）**：wait ms 值须来自录制事件流实测间隔（uiAppear 消费规则→distill.md），禁 AI 凭空估计。**相邻事件等待决策树**（<500ms 直连/可定位→wait text|cond.element 就绪即走/无文本容器→clamp(实测,500,3000)/无锚点→wait ms+desc）与**素材→target 生成规则**（aria.name 首选/dynamicCls 强制 aria/domPath ③层兜底/testid desc/同文本多义 container）→ distill.md 对应两节（V20261113001）。
- **豁免①**：作者离线声明的 domPath/point ③④层合法（flow schema 合法兜底层不可禁）。**豁免②**：evaluate_script 只读合法（显式关联红线 #1：仅限只读+waitForStableDom:false；不做只读语义深验证——图灵完备 JS 上不可判定，威胁模型为内部误用非对抗代码）。
- **落点**：蒸馏产物每步定位证据来源（录制事件流引用/观察引用/作者声明）标注走蒸馏报告/证据包外部映射文件——不进 flow schema、不进回放执行链。

### §时区配置：日志/落盘命名时间戳（任务A）

**机制**：所有「文件命名 + 人类可读显示」时间戳单源 `lib/time.js`，环境变量 `CHROMEUSE_TZ_OFFSET` 配置偏移（**分钟数，默认 480 = UTC+8**；合法域 ±840，非法/缺省回退默认）——容器 TZ=UTC 下也能稳定输出本地化时间戳，零依赖（不做 Intl 时区反查）。

**两个出口**：落盘命名（`recording-`/`net-`/`screenshot-`/`videodiff-`/`beacon-`/`flow-fail-`/`replay-`/step 截图/日志归档 `chromeuse.<stamp>.log`）走 `formatStamp()` → `yyyy-MM-dd_HH-mm-ss`；显示字段（日志行、事件流落盘头 `startedAt`/`stoppedAt`、录屏 `index.json` 头、各类报告 `capturedAt`/`generatedAt` 等）走 `isoLocal()` → `yyyy-MM-ddTHH:mm:ss.sss±HH:mm`（ISO 带偏移，`new Date()` 可直接解析，消费方零改动）。

**边界（数据字段不动）**：录屏/事件双时钟 `tArrive`（Node 毫秒）/`tMeta`（CDP 秒）、事件 `tRecv`/`t`、各类时长 ms 保持原值原语义——机器对照字段是绝对时刻、无时区语义，diff-video 对照不受本配置影响。

### §视口与多分辨率兼容（V202609100002）

**机制**：flow `_meta.viewport: {width, height}` 声明录制/验证时的 CSS 视口（schema 校验有限正数，selftest #23）——回放前引擎 `Emulation.setDeviceMetricsOverride` 对齐（`deviceScaleFactor:0`=保持环境真实 DPR，语义是**环境对齐**而非设备模拟），`--target` 模式结束自动 `clearDeviceMetricsOverride` 清残（自建 tab 无残留）；**goto 重申纪律**：emulate 施加于 goto 前会被导航重置——引擎在每 goto 后校验 `innerWidth` 偏差 >2px 自动重施加并告警。多设备自适应（不写死分辨率）走地板语义 `_meta.viewportMin`（宽度）/`_meta.viewportMinHeight`（高度，V202610190002）——三态细则见 §flow 回放守则·视口三态策略。

**已知限制**：① `screen.*` 类断点/逻辑不受 CSS 视口对齐影响（screen.width 是物理屏）；② 对齐后视觉截图为全幅，**人工 Selkies 所见仍是物理窗口**——对照时注意两套视野；③ 窄视口下改直达 URL 绕布局已被操作路径红线证伪（业务语义丢失，见 §操作路径红线）。

**用户指引**：多设备/多分辨率模式**无需统一分辨率**——flow 声明录制时视口，回放自动对齐；`record` **不对齐**（证据保真——录制的是真实操作环境，回放才对齐声明几何）；X1 拒因读法：`L4:命中测试未命中` 配 rect 0×0 或越界 → 先查视口（`session.viewport`/失败报告 `targetState.viewport`+`viewportAligned`）再查定位器。

### 弹窗处理（handle_dialog）

- **浏览器原生** dialog（alert / confirm / prompt）会阻塞页面：出现"页面无响应"先想到有未处理的 dialog → `handle_dialog` 处置（accept 或 dismiss）。
- **DOM 层业务弹窗**（应用自绘验证框等）不是原生 dialog，`handle_dialog` 管不到：`take_snapshot` 里能看到「确认」按钮 uid，直接 click。业务弹窗常挂在应用 iframe 层（非表单 iframe），a11y 快照跨 iframe 仍可见。

### iframe 结构

- 典型层级：门户 → 应用 iframe → 表单 iframe（id 形如 `iframe<FormId>0`）；chrome-devtools MCP 的 uid 已**跨 iframe 解析**，无需手动换算坐标或逐层切入。
- **例外（2026-09-10 实测）**：下拉菜单点开后 a11y 树只有空 `menu` 节点、子菜单项不暴露——uid 解析对菜单子项失效。兜底：同源 iframe 用 `contentDocument` 穿透读菜单项 rect，逐级累加 iframe 偏移换算顶层 CSS 坐标 `click_at`（示例ERP OS「库存锁定」菜单实测一次命中；菜单关闭态 rect 0×0 是正常测量，先点开下拉再读）。
- snapshot 超时优先怀疑"深 iframe + 重主线程"叠加，而不是 iframe 本身；处置走专题一。
- **click(uid) 交互性检查**：MCP 对"非可交互元素"（如 winui 桌面图标）会拒绝点击（"did not become interactive"）——换 click_at 坐标、键盘流或找等价可交互入口（面板内同功能图标实测可 uid 点击）。

### 宽表格（几十列网格）

- 别滚动找列！切行表/表单区的**标签页**（如"数量""设置""概述"），表单字段直接 `fill`，比网格滚动定位稳得多。例：销售订单的"结算方式"（保存必填）不在概览列，藏在「概述」标签 → 「财务维」分组 → 下拉框。

### 虚拟化网格取证纪律（react-data-grid 等 windowing 表格，2026-11-04 L61-C6）

- **识别**：`.react-grid-Cell/.react-grid-HeaderCell` 类名或「行数远小于 totalRows」=windowing 表格（离屏行列不渲染，非空值/非缺列）——只读读数用 `cdp.js extract --kind grid`。
- **①判空纪律**：DOM 读数为空串 ≠ 值为空——离屏未渲染≠空值，判空必须先滚动至可视复读+截图佐证（滚前空+滚后有=虚拟化；滚前后皆空=真空值；滚动复读用 `cdp.js grid locate/scroll-to`）。
- **②定位纪律**：DOM 顺序 ≠ 视觉列序——按「列头文字+行号」定位而非 nth-child（列序以 HeaderCell 视觉位置重排；`cdp.js grid locate --col <列头> --row <N>` 已按此实现）。
- **空白单元格坐标兜底**：无文本单元格用坐标命中，逐级 `frameElement` 累加得顶层 CSS 坐标（click_at 边界见 §专题一）。
- **③大数据集全量**：翻页/取全量走「记录操作→重新执行查询」，`「获取全部记录」无效`。

### 键盘流（press_key）

| 按键 | 场景 |
|------|------|
| `Enter` | 选中行上触发默认数据操作；网格内确认输入 |
| `Tab` | 网格内切格（新增行后目标列自动聚焦可直接 type_text+Enter） |
| `Ctrl+S` | 保存单据（弹"请选择 XX"类提示 = 有隐藏必填项） |
| `Ctrl+C` / `Ctrl+V` | 跨页查数：复制单号 → 切目标列表 → 粘贴筛选（50 条秒变 3 条） |

### 图标按钮的 hover 文本（悬浮才显示，V202609120002 实测）
- **现象**：图标类按钮/菜单项（winui 开始菜单、工具条、图标面板）**hover 悬浮时才注入文本**——非悬浮态 DOM 里无文本，文本定位与枚举探测全部扑空（示例ERP 开始菜单「域管理」项实测：静止态 innerText 为空，mouseMoved 悬停后文案才出现并可达）。
- **手法（悬浮文本排查四步法，V202609120005 用户建议算法化）**：
  ① **截图全览**——先截图看画面全貌，圈定可能出现悬浮文本的区域（图标群/面板/菜单栏）；
  ② **特征过滤**——按目标按钮特征（位置/分组/尺寸/图标语义）对区域内元素做 DOM 枚举过滤，把候选缩到个位数；
  ③ **逐个悬停探测**——对候选逐个 `Input.dispatchMouseEvent mouseMoved`（DOM rect 中心）→ 每次悬停后探测文本是否出现并匹配目标（hover 才注入文本，静止态探测必扑空）；
  ④ **命中点击**——文本匹配目标的候选直接点击；候选在面板可视区外先 `mouseWheel` 滚入可视区再悬停。对比滚动盲扫：候选过滤后通常 1~3 次悬停即命中，避免全面板碰运气式探测。
- **关联坑**：菜单面板有可视区边界，**可视区外的坐标直接点击无效**（点到面板外的底层窗口）——先在面板内 `mouseWheel` 滚动把目标滚入可视区，再悬停探测、点击。判定方法：探测到坐标但点击无反应时，截图看坐标是否落在面板矩形外。

### 事件可信性红线（细则）

- 根因：此类系统靠监听**真实键鼠事件**触发后端逻辑（如改单价 → 请求后端重算金额 → 刷新记录）。JS 合成事件 `isTrusted=false`，监听链不认——实测填了单价但销售金额恒为 0，且**无任何报错**，极难排查。
- 正确姿势：一切业务写操作走 MCP 原生工具（`click` / `fill` / `type_text` / `press_key` / `upload_file`）——CDP 注入的 Input 事件可信度高，系统正常响应。
- `evaluate_script` 只读豁免：读单元格值 / 列索引 / 滚动定位 / DOM 探查 / `document.readyState` 探针（只读也传 `waitForStableDom: false`，跳过 3s DOM 稳定等待）。
- 测试目标 = 模拟人类：JS 走通的路径不代表人类可用；被测系统最终由人类使用。

### 右键菜单 uiAppear 触发面（spec 定稿，V202609130010）

右键弹出的**自定义菜单**（页面 contextmenu preventDefault + 自绘 menu div）的 UI 变迁捕获定稿——recorder 侧第四触发面：

- **触发面定义**：`contextmenu` 事件（真实 isTrusted 右键，passive+capture 只读采集、不 preventDefault 不 stopPropagation）作为 uiAppear 第四触发面（click / dblclick / keydown(Enter) / contextmenu），与 click 同构调用双时刻采样（t1=700ms / t2=1800ms，自 contextmenu 时刻起算，累积并集 t2 后单发射）——连击各自排布不取消 pending、**无去抖**（与 click 一致；Enter 的 300ms 去抖不适用）。
- **采样窗口保证**：自定义菜单两种典型渲染模式均落窗——① 处理器内同步插 DOM（远早于 t1）；② 异步取数后渲染（t1 未现 t2 兜住——双时刻采样累积并集的意义所在）。**>1800ms 的慢渲染不在保证范围**（与 click 触发面同一边界；采样 t1 自适应是 uiAppear 全局 backlog 项，不为本面单开）。
- **原生菜单天然抑制**：页面未 preventDefault 时浏览器原生菜单不入页面 DOM → t1/t2 采样差集为空 → 空 diff 不发射（既有语义，零新增逻辑）——裸页右键不会产生伪 uiAppear。
- **关联方式 = 时间轴邻近性**（不强求事件配对）：同帧强关联——uiAppear 的 `triggerSeq` = 同帧 contextmenu 事件 seq、`triggerType:'contextmenu'`；跨帧场景（菜单渲染进 iframe 等）靠时间邻近（uiAppear.t − contextmenu.t ≤ ~1.8s）+ 触发点坐标邻近（triggerPoint 透传供容器加权排序）。蒸馏时按 triggerSeq/时序把菜单 items 归到对应右键步骤。
- **前置能力链至此全齐**（右键批注入口，TODO-chromeuse2.0.md §三 的 1.0 前置）：rightClick 回放原语（V202609130002）+ 录制侧 mousedown/mouseup button 位面（V202609130007）+ contextmenu 事件采集（V202609100001）+ 本条 uiAppear 触发面（V202609130010）。

### 人类操作录屏学习管线（v46 收编）

从录屏反推操作步骤（操作类视频必须走抽帧 + 视觉；口播类才走"音频→whisper→LLM"）：

```bash
# 1. 装工具（apt 裸连常卡死，务必走代理；代理值读 config proxy.httpProxy 登记值）
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
  apt-get install -y --no-install-recommends ffmpeg

# 2. 场景变化抽帧（UI 操作是局部变化，scene 分数低：阈值用 0.04；0.15 只抽到 5 帧不够用；
#    实测 11 分钟 120fps 录屏 → 82 帧）
ffmpeg -i 录屏.mp4 -vf "select='gt(scene,0.04)',showinfo" -vsync vfr -q:v 4 frames/s_%04d.jpg \
  2>&1 | grep -o "pts_time:[0-9.]*" > frames/timestamps.txt

# 3. 帧↔时间戳对照表 → 多模态 agent 按时间线分批逐帧分析（每批 ≤25 帧；单批 >35 帧易超时挂死）→ 拼装操作时间线
```

**§新功能开发（平台层规则，2026-11-17 #136）**：新功能默认 Linux 实现——平台无关逻辑（CDP/DOM/算法/flow）直接写 `lib/` 单实现；二进制调用/进程管理（spawn/kill/探针）/浏览器发现与默认连接值/环境路由（beacon/提示文案）一律走 `lib/platform`，禁裸 `process.platform`（→ SKILL.md §0.4 + mechanisms §24）。

## §专题一深度：重型 SPA -32001 与冻结取证

### 网络域取证全命令（冻结期可用）

```text
1. list_network_requests                      # 全量请求列表（URL/方法/状态/类型），可按资源类型过滤
2. get_network_request { requestId }          # 单条详情：请求 payload + 响应体
   # ERP 类系统是 API 驱动的：doAfterInit / buttonOK 等回发的 payload 就是页面参数铁证，
   # 比在冻结页面上点选取证硬得多
3. Cookie 重放：从请求头取 Cookie → curl 直接打接口；
   或 playwright-core connectOverCDP 后用 context.request 拿结构化数据
```

- 架构依据：Network 域数据在浏览器进程/网络服务侧缓冲，不经 renderer 主线程（归属表见 facts.md；冻结期实测登记【冻结期 Network 域可用性实测】）；取到的接口参数也可用于"轻载重放"：新标签页打开轻路由 / 请求拦截拦掉大 chunk。

### initScript beacon 完整示例（绕开冻结期取数）

原理：`navigate_page` 的 `initScript` 底层是 CDP `Page.addScriptToEvaluateOnNewDocument`——**注册**不经主线程，执行在下次导航时；钩子把数据 `fetch` beacon 到本地 HTTP 服务，之后从服务端读，完全不依赖冻结页面的 evaluate。

```bash
# 本地收数服务（另开终端；python3 临时凑合即可）
python3 - <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        print(self.rfile.read(n).decode('utf-8'), flush=True)
        self.send_response(204); self.end_headers()
HTTPServer(('127.0.0.1', 9999), H).serve_forever()
EOF
```

```js
// navigate_page 调用参数
{
  url: "https://目标页",
  initScript: `
    window.__beacon = (k, v) => fetch('http://127.0.0.1:9999/beacon', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ k, v })
    }).catch(() => {});
    addEventListener('load', () => __beacon('readyState', document.readyState));
    // 冻结归因：长任务在发生时就把归因 beacon 出来（而不是事后查不了）
    new PerformanceObserver(l => __beacon('longtask', l.getEntries().map(e => e.duration)))
      .observe({ entryTypes: ['longtask'] });
  `
}
```

> noProxy 纪律：beacon 目标 `127.0.0.1` 必须绕代理（config `proxy.noProxy` 空值时的强制下限已保证）。

### 坐标兜底 click_at 适用边界

- 需启动参数 `--experimentalVision`（config mcpDefaults.experimentalVision 已登记 true）；底层 `Input.dispatchMouseEvent`。
- 边界：输入事件分发比 JS 执行 / a11y 遍历**更快恢复**（renderer 在长任务间隙仍能处理输入微任务队列），所以主线程"半冻结"时 click_at 可能还能动；但 `Input.dispatchMouseEvent` 也走 renderer——**完全冻结时 click_at 同样可能超时**。click_at 超时 ≠ 通道坏了，是冻结加深的信号：转等待 / 杀进程，别加大力度点。
- 配合 `take_screenshot`（通常最后失效，但不保证——硬阻塞实测也 -32001）+ 视觉模型读坐标；`click_at` 前先截图确认目标位置。

### Playwright MCP 并存守则 —— 状态：未启用（gate：【Playwright MCP 并存实测（事件竞争+超时调优）】）

- 定位：**不是替换，是互补通道**——`--cdp-endpoint` 连同一 CDP 实例，Chromium 原生支持多客户端。
- 核心收益（重 SPA 下）：`--timeout-action` / `--timeout-navigation` / `--timeout-settle` / `--cdp-timeout` 四层超时可配；`browser_snapshot({ depth })` 限制 a11y 树深度（chrome-devtools MCP 无 depth 参数）。
- 已知坑：事件重复（两客户端同收 target 事件）、tab 关闭竞争（约定"谁开谁关"）、两套 uid/ref 体系不通用、Runtime.evaluate 在同一 renderer 上排队（不冲突）。
- 解除 gate 条件（【Playwright MCP 并存实测（事件竞争+超时调优）】）：并存 30 分钟无事件重复 / tab 竞争案例 + depth 降级在重页面有效。**`playwright.status` 翻转 enabled 须与 config 模板、本文件与 install.md 的"未启用"标记串同一推广原子完成**（selftest #10 机检）。

## §专题二深度：元素可见但点不中（V202609080010 勘误版）

> **根因勘误**：本节此前定性"DPR 1.5 布局断裂致幽灵菜单"——**该结论已被用户实证推翻**（默认状态、原生 DPR 1.5、无任何 emulate 下，人工可点击应用按钮与所有 ERP 按钮，从未遇到不可点菜单）。历史证据链重审：0×0 rect 测量时机=菜单**关闭态**（display:none 下 0×0 是正常态）；elementFromPoint 穿透测量时**无菜单打开**（该点本就是列表页内容）；emulate 1.0"修复"未经对照验证（点击走 Input 域真实事件，本就可能通过）。**修正后归因**：flow 路径**文本匹配歧义**（"销售送货单"同文名多义命中列表页而非表单路径）+ **主线程长任务冻结**（-32001，通道分级管理）——与 DPR 无关。

### 历史案例存档（示例ERP OS「销售订单库存锁定」下拉，2026-09-07 实测）

- 症状记录：菜单项可见但 CDP 点击/双击/键盘无响应、a11y 空节点、外部点击不收起——当时测得菜单项 rect 0×0（现知为关闭态测量）。
- 处置演进：当时按 DPR 假说 emulate 1.0 后回放通过（后经重审认定"修复"未证实）；V202609080010 起撤销默认 emulate，回放原生 DPR 运行，实测通过（见 webapps/erp_demo_test/flows）。

### 社区案例索引（保留——坐标类问题真实存在，缩放换算纪律不变）

| 类别 | 案例 |
|------|------|
| DPR/缩放坐标类 | Puppeteer #11548（scale 下鼠标事件错位，上游 crbug.com/1393360 未修）、#5307（zoom 未计入点击坐标）、#4456（设备模拟截图与鼠标错位）、Playwright #19044（系统缩放点击错位） |
| iframe+DPR | Puppeteer #7849（跨域 iframe boundingBox 偏移）、#7900（OOPIF 可点击点）、chrome-devtools-mcp #1251（iframe 内行为不一致） |
| 菜单卡中间态 | MDN（后台 iframe rAF 节流暂停）、Bootstrap #14778（transition 未完成即移除 open 类）、shadcn-ui #5350（dropdown 对 body pointer-events:none 未重置） |

> 上表佐证的是"DPR/缩放下的**坐标换算**问题"（截图像素≠CSS 像素纪律由此而来，facts 工具层实测 #2）；不是"DPR 导致菜单布局归零"的证据。

### DPR 立场（V202609080010 定稿）

- **录制/回放均在原生 DPR 下运行，不做 emulate**：浏览器保持默认界面（人类与 AI 同视野）；CDP Input 坐标为 CSS 坐标，语义不随 DPR 变化。
- **确认 DPR 的正确动作**：读 `window.devicePixelRatio` **记录参考**（flow 回放结果 / 事件流头 session.dpr），不修改不告警。
- **emulate 降级为可选工具**（默认不启用）：仅显式使用时生效——flow `emulate` 原语 / MCP emulate 工具 / `Emulation.setDeviceMetricsOverride`。使用注意：①施加于 goto 前会被导航重置（每次 goto 后重申）；②有视口缩小副作用（1280 CSS 视口 1:1 化只占 1920 显示器 2/3）；③自建标签自关即无残留，`--target` 模式用完须恢复原 DPR 或 `clearDeviceMetricsOverride`；④emulate 后悬浮层/菜单可能收起位移——重新定位再点。

## §专题三深度：营销弹窗「关闭按钮」定位与点击（V202610090001 定稿）

**背景**（2026-10-09 淘宝 PC 首页「9.9 元超值好物精选」弹窗实测）：关闭 × 为纯视觉 div——`take_snapshot` 无节点（默认按 interestingOnly 过滤「无名称无描述叶子」）、class 关键词候选被一屏几十个商品卡「不感兴趣 ×」淹没（截断前 12 个即被挤爆）、截图目测坐标偏差 64px 落空。最终以「锚点→容器→右上角网格扫描」法一次命中。

**成品**：`snippets/popup-close-scanner.js`（主脚本 + 验证探针 + 头注释用法）。四步：

1. **填参**：`ANCHOR`=弹窗内唯一文本（如「去抢购」）；容器尺寸带默认 `400~1100 × ≥250`（窄弹窗调小 `W_MIN`）。
2. **扫描**：主脚本 → `evaluate_script`（只读，`waitForStableDom:false`）。看 `suggestedClick`：应为带 close 类名、`hitCount≥2`、40px 级尺寸者，其 `center` 即关闭按钮中心。
3. **点击**：`click_at(center)` 真实鼠标（**不用目测坐标**）。候选存疑按 `score`/`inContainer` 人工挑；`CONTAINER_NOT_FOUND` 调尺寸带或换锚点；必要时调大 `REGION_W/REGION_H`、`EDGE=0` 重跑。
4. **验证（闸门，未确认不得继续）**：复跑主脚本报 `ANCHOR_NOT_FOUND`=已关；或验证探针 `rect 归零(0×0) / 元素消失`=成功。仍在=失败：查点击点是否被透明层拦截/事件绑父级，重测 rect 重点一次（≤1 轮），仍失败留证上报。

**机制备注**（chrome-devtools-mcp 1.10.1 / Puppeteer 25.11.0 源码核实）：
- `take_snapshot` 默认 `interestingOnly` 过滤无名称叶子 → 纯视觉 × 缺失；`verbose:true` 不过滤可带出（本案例未实测，待补）。
- `evaluate_script` args 传 uid 时，单 frame 场景执行上下文自动切到元素所在 iframe → **跨 iframe 弹窗可复用本脚本思路**。
- `take_snapshot`/`evaluate_script` 均支持 filePath 落盘防截断；`click(uid)` 走 Locator（要求元素可交互）。

**纪律教训（本案例付出代价的三条）**：
1. 弹窗关闭必须**鼠标点 ×**（Escape/键盘不可靠，实测不生效）；2. 关闭后**视觉确认**（截图/DOM rect 归零）才算完成，未确认连做后续步骤=全军覆没；3. 目测坐标必偏——坐标点击只允许来自 DOM 实测 rect（网格扫描），且点击后必须验证闭环。

### popup-guard：replay 路径广告/推广弹窗拦截（V202610150003，popup-guard P1）

**问题**：纯序列 flow 无弹窗防护——促销弹层遮蔽目标时定位/断言即挂（2026-10-15 淘宝「9.9 元超值好物精选」弹层 y≈220 恰未遮 y=116 搜索按钮才侥幸通过）。**A 路线 = DOM 层 MutationObserver 守卫（李跳跳式直译）**：guard 脚本预埋（`Page.addScriptToEvaluateOnNewDocument`，先于页面 JS）+ 已加载页即时执行一次 → 命中规则 `remove`/`hide`，拦截先于渲染完成（广告不闪现）。

| 用法 | 说明 |
|------|------|
| `flow replay <file> --popup-guard [--popup-rules <file>]` | 回放期自动挂/摘守卫（**默认关**——不加旗标零改动）；摘要=拦截条数+规则 id 归并（成功/失败路径都输出） |
| `cdp.js popup-guard scan --target <页>` | 只读扫描：当前页命中规则 + 候选节点（ruleId/action/tag/cls/text/rect/zIndex），零动作取证 |
| `cdp.js popup-guard test --target <页> [--seconds 60]` | dry-run（只记录不动作）→ 输出「将拦截清单」；**新规则上线前的误杀检验门槛** |
| `cdp.js popup-guard on\|off --target <页>` | 页侧守卫开关（on **仅页内生效**：刷新/导航后失效——故不注册新文档脚本，进程退出不留注册残留；跨导航请用 replay 旗标） |

**规则库双层语义（2026-10-15 用户裁定，实现单源 `lib/popup-guard.js loadRules`）**：webapp **无** `webapps/<app>/popup-rules.jsonc` → 用全局 `config/popup-rules.jsonc`（宽松基线）；webapp **有** → **以 webapp 配置整体为准（不与全局合并）**——高发站（淘宝/天猫）单独收紧：`next-overlay-backdrop` 遮罩族 / 9.9 促销弹层文本 / 中央促销浮层特征。规则形态 `{id, match:{anyOf:[{selector}|{textContains}|{rect:{minW,minH},zIndexMin}]}, action:remove|hide, scope:"host[:port][/pathPrefix]", evidence:true}`；`anyOf` 任一 entry 命中即规则命中（单 entry 多键=与）；`scope` 复用 matchers 分段锚定语义（缺省/非法 = 不生效——宁少勿滥）。

**纪律**：①**只做 DOM 清理**——guard 不合成点击/事件（**点 × 不进 replay 路径**，合成点击属灰区；交互模式点 × 用 §专题三 的 `popup-close-scanner.js`）；网络层 Fetch 拦截（B 路线）属 P3 未实现。②**保守匹配 + scope 收窄双保险**：全局基线一律 `hide` 起步（不 remove；误杀可从 DOM 直读——被隐藏节点带 `data-cu-pg-hidden="<ruleId>"`），弹窗 DOM 迭代快、回填由 `window.__cu_pg_log` 证据驱动。③**还原现场（共享浏览器是用户资产）**：replay 注入必须配对清理（finally：页侧 `observer.disconnect()`+清窗口变量 → `Page.removeScriptToEvaluateOnNewDocument`；异常路径同样走到）。④规则文件坏 → fail-soft 不注入并告警（宁可不拦，也不误用规则）。

## §逃生舱：raw CDP 工具层（tools/cdp.js）与看门狗守则

### 子命令速查（逃生舱纪律；完整旗标 → `node tools/cdp.js <cmd> --help`，分组 → SKILL.md §1.2）

- **probe / doctor / doctor-forensics**：probe 三通道各 5s 独立超时（MCP 探针要等 60s）；doctor 活时巡检、通道不可达即 die 无产物；doctor-forensics 死时取证、通道全死也照常落盘（用法 → §失效分型取证协议 v1）。
- **targets**：HTTP `/json/list` 列标签（纯 HTTP，不占 WS）；会话治理数据底座（【G5 会话隔离（多 agent 共享浏览器 target 治理）】）。
- **net**：Network 域采集窗口 + body/payload 拉取；**【冻结期 Network 域可用性实测】工具**；全量落 `tmpdata/events/net-*.json`；`--har <path>` 同步导出 HAR 1.2（凭据按 §16 redact 规则替换为引用 `<redacted:NAME>`）。
- **screenshot**：独立短超时截图——MCP 层 60s 挂死时 5s 快速失败转等待纪律。
- **watch**：轻探针+截图**双死持续 ≥120s**（实测自愈 20s 的 6× 余量，R32）才判冻结；输出判定+恢复命令，**绝不自动杀**；exit 0/2/1。
- **exec**：万能口；页面级命令必须 `--target`（Browser./Target. 级免）；**破坏性类别（close/navigate/Browser.close/Storage）自担风险**。
- **beacon**：零依赖收 POST；页面侧 URL：NAS `http://opencode:9999` / 桌面 `http://127.0.0.1:9999`（v2 修正：旧 playbook 示例写 127.0.0.1 在 NAS 指向浏览器容器自身，是文档 bug）。
- **flow / record 系列**：flow 引擎与录制层（§flow 回放守则 / references/distill.md）；`flow replay` 也默认带 `-v`（事件流管断言/录屏管现场——两者都要）；手动测试/问题复现必须 record -v 双流。面板开关/图标滚入/渲染状态等视觉事实只能看录屏判断，事件流文本无法判断——截图只截中间态会误导，问题验证看最新录屏帧（用户裁定 2026-09-17，2026-09-18 二次修正）（见 §前置操作条件·视觉兜底）。分层录制两档（V202609170005 全档，实弹 tmpdata/rec-live 三档全过）：缺省 **semantic 档**=关键事件+语义采集（click/dblclick/contextmenu/mouse 序列/drag/input/change/keydown（组合键全录+非打印白名单+Enter/Tab）/scroll/navigate/uiAppear/paste/copy/cut）；`--full-input` opt-in **full 档**追加 wheel（200ms 累计节流）/focusin/focusout/auxclick/F1-F12 keydown——full 档事件=取证原料，蒸馏默认不映射 flow。**剪贴板脱敏 `--clipboard-policy` 三档**：`text` 默认（内容截 200 入流+len 原始全长）｜`masked`（恒 *** 保留 len）｜`meta`（仅 len 内容零入流）；password 目标恒 ***（红线 7，优先于档位）；每个剪贴板事件带 `policy` 元字段（防误当全量）；优先级 CLI > config `recorder.clipboardPolicy` > 默认。paste 实测可达路径 = 真实 Ctrl+V（原生粘贴编辑命令，isTrusted=true）；`Input.insertText` 只产 input 不产 paste。完整旗标 → `cdp.js record --help` / `cdp.js flow --help`。
- **popup-guard / locator / evidence-pack**：规则与四态、证据包用法 → §专题三深度·popup-guard / §元素捕获方法论 / §验收回放证据包（完整旗标 → 各 `--help`）。

**截图通道环境事实（2026-10-22 实测，证据 `tmpdata/realshot-fix/diag{,-2,-3}-result.json`）**：raw CDP `Page.captureScreenshot` 在**后台页签**会超时（30s 级）甚至返回**旧帧**（同页同位置：后台 30015ms 超时 / `Page.bringToFront` 后 592ms 正确；后台 clip 第二次返回 y=0 旧画面而页面实际在 y=665）——**截图前必须 `Page.bringToFront`**（`lib/screenshot.js` 已内置；`scroll-shot` 自 V202610220003 内置，`--no-foreground` 可显式放弃并告警）；并行多页签截图时每个页签各自置前。

### §元素捕获方法论（locator 工具，V202610190001）

**现状**：flow 六层定位（text/role/near/grid/domPath/point）+ X1 四层闸门（rect/offsetParent/visibility/elementFromPoint）在**多候选歧义**时诚实红不猜；收窄手段各有局限——domPath 是所在文档内路径（跨 frame 需先 frame）、container text 可能解析到元素自身、point 随布局漂移。**元素捕获歧义先用 locator probe/suggest，不要盲试多轮。**

| 四态 | 命令 | 用途 |
|------|------|------|
| probe | `cdp.js locator probe --text "现货锁定" [--match exact] [--container '<json>'] [--target <页>] [--json]` | 跨同源 iframe 列候选：framePath/tag/rect/visible/offsetParentOk/hitOk/area/cssPath + 唯一性结论（不可见项也如实列出供诊断） |
| suggest | `cdp.js locator suggest --text X [--match exact] ...` | **递归收窄**：多候选→策略一=共同祖先链（父→祖父）逐级构造 container（**domPath 优先**，文本为空/过长才 text）重算，唯一即止；策略二=共同祖先无区分度（如候选分属不同子树、共同祖先仅 body/html）时**逐候选祖先链扫描**（每个候选的父/祖父各试 container，容器内只剩 1 可点即收窄）；跨 frame/无共同祖先如实报，不伪造 |
| verify | `cdp.js locator verify --target-json '{"text":"X","container":{...}}' [--ms 3000] [--no-screenshot]` | 解析 best→高亮（Overlay+CSS outline）→截图 `tmpdata/events/locator-<stamp>.png`；读图确认定位是否正确 |
| pick | `cdp.js locator pick [--seconds 60] [--no-block]` | 注入一次性 capture-phase 点击拾取器（DevTools select element 式）；拾取即自摘，默认拦截业务动作；输出三层描述符+唯一性复算+建议 target JSON |

**递归收窄原则**：多候选→取可点候选的共同祖先，最近的先试；每级**优先 `container:{domPath}`**（cssPath 精确到 nth-of-type、同文档唯一；2026-10-19 实弹教训：祖先 text 可能取到 `<script>` 源码→container-not-found），text 形态仅兜底；唯一即停（逐级 tried 记录在输出）。共同祖先无区分度（body/html 级）→ **策略二逐候选祖先链扫描**。全部不唯一→如实报 multi，改 exact / 兄弟唯一文本 / role，**不赌排序**。**⚠ domPath 属性选择器引号纪律（2026-10-19 实弹）**：属性值含点号/空格时**必须加引号**——`[app-id=gongqi.df.sales]` 会被解析为 `[app-id=gongqi.df]`+`.sales`（querySelectorAll 语法错误→候选 0 静默失败），正确形态 `[app-id='gongqi.df.sales']`；flow domPath 与 locator probe/verify 同受此约束（写 target 前先 probe 验证选择器可解析）。**高亮视觉确认习惯**：verify 截图必须读图看框是否落在目标上，再决定是否写 target；候选>1 时框的是排序 best，唯一性结论以 probe/suggest 为准。**拾取器**：pick 默认 preventDefault+stopPropagation（不触发业务），超时/拾取后自动摘监听；`--no-block` 允许业务动作。**跨 frame**：framePath 标注 `main>iframeName>…`；text 定位跨同源 frame 扫描；**container 在候选所在文档内解析（同 frame 生效——2026-10-19 flow 实测 `ul.dropdown-menu > li:nth-of-type(2)` 收窄成功）**；跨 frame 分布的多候选无法用单一 container 收窄；domPath target 是所在文档内路径，flow 需先 `frame` 进入该链再用。

### 本地调试实例拉起（browser-up / --auto-launch，V20261117008 批C2/R2）

**场景**：裸机 Linux / Windows 桌面端（无容器 keep-alive）需要自己拉起带调试端口的 Chromium。前置 = config `chrome` 三键（launchCommand/debugPort/userDataDir；齐备性由 selftest #8 机检）。手动：`node tools/cdp.js browser-up`（幂等——端口已就绪=复用；默认常驻，登录态留在独立 profile）→ 后续命令照常走 browserUrl；`browser-up --status` 查状态 / `browser-up --stop` 关停（默认常驻是设计，登录态复用）。用户数据目录必须独立非默认。

**临时实例组合（R2+R3）**：`node tools/cdp.js --config tmpdata/win-debug.jsonc browser-up` → `node tools/cdp.js --config tmpdata/win-debug.jsonc probe`（整份实例切换：chrome 三键+browserUrl 一起换，仅本进程有效）。

**自动保障**：任意连接命令加 `--auto-launch`（全局 flag，位置无关）→ 连接前若 browserUrl 主机是 127.0.0.1/localhost 就先幂等 ensure（已就绪=一行日志复用；失败即 die）；主机非本地自动跳过并 warn（不误启本地实例连远端）。组合式 `--config x --auto-launch targets` 天然生效。

**与 browser-restart 的区别**：`browser-up`=OS 级进程启动（从「没有调试实例」到「有」）；`browser-restart`=CDP 级重启（Browser.close → 依赖容器 keep-alive 自动拉起，治 DevTools 域损伤）。容器环境用 restart，无 keep-alive 环境用 up。机制 → mechanisms §26；Windows 复验项 → TODO。

### 使用纪律

- **一次性短连接**：连→取→断，不与 MCP 长驻会话竞争；net 采集窗口内避免 MCP 重操作（R30）。**永不自动开/关 tab**——回放/录制需要 tab 时自开自关。
- 每命令独立超时默认 5000ms（`--timeout` 覆盖）——对冲 MCP 客户端 60s 提档后的报错变慢（【MCP timeout 提档副作用观察】）。
- 双端并发：**record / flow replay 默认无互斥**（2026-10-19 用户裁定：锁只保留在「打开页签并获取 pageId」层=tab-helper 锁页 window-CAS，V202610140003，独立一层）；`--lock` = 可选显式互斥（`.chromeuse.lock`，owner+PID+heartbeat 5s 续约、15s 无心跳视为 stale 可抢占；兼容旧脚本语义）。**多客户端共连干扰风险由纪律兜底**（V202609130003 归因：chromeuse 与 chrome-devtools MCP 共用 9222 是架构现状——避免同期双长动作、record 伴跑 replay 前先确认无 MCP 重操作）；其余秒级只读命令靠 probe/targets 自检 + 纪律（【双端并发调度机制化 gate】）。
- **redflags（本周期明文不做）**：① 不迁移 raw CDP 全栈（chrome-devtools MCP 主力不动）；② 不引入 stealth 系（veilbrowser/nodriver/stealth-browser-mcp——反检测是伪需求，条件翻转走【chrome-cdp-skill 并列安装 gate】扩展）；③ 不打 Viz 补丁、不自编译 Chromium；④ 逃生舱不引任何 npm 包（Node ≥22 内置 WebSocket + fetch + http）；⑤ 看门狗 v1 不自动杀进程（自愈型冻结实测存在，误杀丢取证现场比等待贵）；⑥ 不做常驻 daemon（一次性短连接已覆盖，除非【G5 会话隔离（多 agent 共享浏览器 target 治理）】/【双端并发调度机制化 gate】演进证明必要）；⑦ flow 引擎不做输入形态自动降级（click 失败自动试 Enter 等）——失败即停+报告是知识沉淀原料；输入形态等价性是业务语义判断归蒸馏期不归运行时（V202609100001）。

### 失效分型取证协议 v1（doctor-forensics，V202609300001）

> 来源：reports/CDP失效分型取证协议-oracle-20260930.md（交付物 1/2/3/5）。解决三个缺口：①通道全死时 doctor 快速 die 无产物（forensics 相反——通道死本身=A/B 层判定原料，照常落盘）；②分型判定靠人脑拼装（judgeLayers 代码化，恒 advisory）；③M 层（MCP 客户端层）无独立对照入口——**"重启浏览器才能恢复"与"MCP 长驻半开死亡"完全兼容**（gateway `proxy_read_timeout 1h` 掐空闲 WS + Puppeteer 不检测半开），浏览器/sidecar 重启都会强制 MCP 重连把 M 层故障"治好"并被误归因；cdp.js 短连接每次新进程天然免疫——独立通道对照是唯一判据。

**一键取证**：`cd /app/coding-started-projects/projects/opencode-started/opencode/root/.config/opencode/skills/chromeuse && node tools/cdp.js doctor-forensics --target <失效页url子串> --symptom "<来源/目标页/错误码>"`（flags：`--timeout 3000` `--max-targets 3` `--no-control-tab` `--no-front` `--out` `--url`）。输出 stdout 分型摘要 + `tmpdata/cdp-forensics/forensics-<时间戳>.json`（`chromeuse-cdp-forensics/1`：env/http/ws/targets/probeMatrix/controlTab/screencastEvidence/layerVerdicts/verdictSummary/nextSteps/raw）。红线：探针全单发不重试（取证要原始信号）；主 target 才 bringToFront（`--no-front` 全关）；对照 tab 唯一豁免（S3 有探针死才触发，about:blank background:true 自开自关）；判定恒 advisory 不自动恢复；exit 0=取证完成与判定无关，**绝无 exit 2**（冻结判定是 watch 的职责）。

**八层分型速查**（层序=判别顺序，从外到内）：

| 层 | 含义 | 判别信号 |
|----|------|---------|
| **M** | MCP 客户端层（长驻半开） | MCP 工具全 -32001/挂死 + **同一时刻** cdp.js probe 三通道全绿 |
| **A1** | HTTP 面（sidecar/网络） | targets/probe ① conn/timeout（sidecar 自愈窗 30-60s）；HTTP 502/504=sidecar 活上游死→B |
| **A2** | WS 面 | HTTP ok 但 WS 握手 conn/握手即断（Host 改写/webSocketDebuggerUrl 回写异常） |
| **B** | 浏览器进程层 | HTTP 502/504（上游死）；或 HTTP/WS 活但 Target.getTargets 挂（handler 不动）；per-target 全 -32601=域损伤签名 |
| **C** | renderer 持续冻结 | 全页/单页 evaluate+截图双死持续 >120s（watch 收敛判定，取证时刻不与 F 瞬时二选一） |
| **D** | 合成器/截图通道 | evaluate ✓ + 截图 ✗；controlTab 三分：对照可截=单 tab/冷启动、对照也死=全局 |
| **E** | target/会话堆积 | total>12 / pages>6 / service_worker>4 / attached>2 / wsLatency.avg>500ms（初始阈值待失效样本校准）——独立叠加维度不抢叶子分型 |
| **F** | 单页主线程忙 | 仅特定页 evaluate 慢/死、其他页全绿——**"CDP 整体失效"最高频误判源**，换 tab 即可继续 |
| **G** | 页面侧元素级死亡 | 通道全绿 + Input 真派发 + 业务零反应 + 零请求零报错——非 CDP 失效，**重启浏览器无济于事** |

**runbook（下次失效的 5 分钟动作序列）**——原则：只读取证优先；探针全带超时；**绝不先重启、绝不连续重击**（超时后重击只会让请求在冻结 renderer 上排队；两次尝试间隔 ≥10s）：

- **Step 0｜T+0 停手固证（≤30s）**：停一切浏览器操作。一句话记症状三元组：**症状来源（MCP 工具/cdp.js/flow replay）+ 目标页 + 错误码原文**（-32001/-32601/conn/timeout/ECONNREFUSED…）——此产物进 `--symptom`，直接决定 M 层能否判定。
- **Step 1｜T+0.5 一键取证（≤2min，核心）**：跑上面 doctor-forensics 命令。通道全死也照常落盘。按 layerVerdicts 走 Step 2 分支。
- **Step 2｜T+2.5 分支处置（≤1min，除观测类）**：
  - **2a 判 M**：不碰浏览器。取证留档后提**低成本恢复**：`docker compose restart opencode`（重置 MCP 长连接，不杀任何浏览器 tab）。记录失效前浏览器空闲时长（验证 1h proxy_read_timeout 假设）。
  - **2b 判 A1**：等 60s（cdp-watch 自愈窗）→ 复跑取证。恢复=自愈记录归档；仍死 → Step 4 批准线 1️⃣。
  - **2c 判 A2/B**：复跑取证一次（新 WS 连接，排除单连接损伤）。仍死 → B 确认：域损伤 -32601 签名 → 提议 browser-restart（批准线 2️⃣）；进程死（502）60s 未自愈 → keep-alive 疑失效，走容器重启（批准线 3️⃣）。
  - **2d 判 F**：通道没坏。等 ≥10s 复跑轻探针（20s 自愈型常见）；或起 `watch --target <失效页> --interval 10 --window 120 --max-seconds 150` 后台观测，**期间换健康 target 继续任务**。watch exit 2 才升级 C。
  - **2e 判 C**：起 watch（同上参数）到 exit：自愈→归档；exit 2（双死 120s）→ 批准线 2️⃣/3️⃣。
  - **2f 判 D**：读 controlTab 三分：新 tab 冷启动→等 ~5min（BACKOFF 硬帽），期间用 `exec 'Page.captureSnapshot'` 拿 DOM 证据继续非视觉任务；单 tab 停滞→换 tab；全局→取证已齐走重启线。
  - **2g 判 E**：读 targets 列表→只关 agent 自建僵尸 tab（用户 tab 绝不自动关）→复跑取证看变化。仍退化→批准线 1️⃣ 试探→2️⃣。
  - **2h 判 G**：不是 CDP 失效——转 module 即席取证协议（net 采集/console Log 域/单会话监听器盘点），不进重启线。
- **Step 3｜T+5 汇总落账**：forensics JSON 路径 + watch 时间线 + 症状三元组 → 分型结论 → 登记 TODO.md INBOX（一行式）。恢复后复跑取证存"恢复后"对照态（差分证据）。

**分型 → 恢复动作映射**（自动=只读探测/等待/换 target/关 agent 自建 tab；半自动=agent 提议+用户确认后执行；人工=用户批准线）：

| 分型 | 自动（agent 立即可做） | 半自动（用户确认后） | 人工（批准线，按成本升序） |
|------|----------------------|--------------------|--------------------------|
| M | cdp.js 独立通道继续任务（绕开 MCP）；留档 | — | `docker compose restart opencode`（不杀浏览器 tab，首选） |
| A1 | 等 60s 重探 | — | gateway restart（不杀 tab） |
| A2 | 新开连接重试一次 | — | gateway restart |
| B 进程死 | 等待 keep-alive 拉起（~2s）+60s 探活 | — | `docker restart chrome-browser` |
| B 域损伤 -32601 | — | `browser-restart`（需确认无重要 tab 现场） | 容器重启（无效时） |
| C 自愈型 | 等 20s + 轻探针复检 | — | — |
| C 不可恢复 | — | browser-restart（确认现场后） | 容器重启 |
| D 新 tab 冷启动 | 退避 + 换既有 tab + 等 ~5min 硬帽 | — | 5min 后仍死→重启线 |
| D 单 tab 停滞 | 换 tab；`Page.captureSnapshot` 替代 | — | — |
| D 全局截图死 | DOM 快照取证；不依赖视觉则继续 | browser-restart（取证落盘后） | 容器重启 |
| E 堆积 | 列清单+告警；只关 agent 自建登记 tab；复测 | — | — |
| F | 换健康 target 继续；≥10s 间隔轻探针不重击 | — | — |
| G | 即席取证（net/console/监听器盘点）；**任何浏览器重启无济于事** | — | 应用/环境侧修复 |

**重启批准线三级分层（进入前三个前置：①forensics 已落盘；②对应自愈窗已等——20s 轻探针/120s watch 双死/5min 冷启动；③用户已批准。docker 操作全部归用户在 NAS 宿主执行）**：

1. 1️⃣ **低成本**：`docker compose restart chrome-browser-gateway`（coding-envs 项目，**务必精确到服务名**）——只重启 nginx sidecar，**不杀浏览器 tab**；治 A 层与强制 MCP 重连（治 M）。
2. 2️⃣ **中成本**：`node tools/cdp.js browser-restart`——Browser.close 优雅关闭→keep-alive 拉起→域级深检→tab 清单。爆炸半径=**整浏览器所有 tab**；治 B 域损伤/-32601；需用户确认无未保存现场。
3. 3️⃣ **高成本**：`docker restart chrome-browser`——连 Selkies 桌面会话一起杀。仅 1️⃣2️⃣ 无效或容器级故障。

**重启后须知**：域级深检 30s 宽限可能仍 -32601（幂等重跑 browser-restart 可补检）；首批新 tab 截图可能冷启动停滞 ~5min；ERP 回归前先人工浏览确认桌面正常（标签卫生纪律③）。

### flow 回放守则（G10 探索-固化-回放模式）

- flow 文件（`chromeuse-flow/1`）规格见架构文档附录 A1：18 原语（计数真源=`lib/flow-engine.js` ACTIONS.length；V202609170002 新增 drag，见 §flow 回放守则 drag 条；V20261113008 新增 eval/set/cond/loop 表达力族，见 mechanisms §22）+ 定位描述符四层回退链（**① 语义 text+role（含 tspan 子片消歧与 X1 四层可见性闸门）→ ② grid-context 表头语义序列有序子集匹配+行号+列名（`{grid:{headers,row,col}}`）→ ③ DOM 路径（`{domPath:"css"}`）→ ④ 坐标兜底 point**）+ `{{var}}` 插值 + 条件文法（wait/assert 共用：`text|element|value|count|url|network|absent|hidden`——V202609110001 新增两键：`absent`=目标不存在（!exists）；`hidden`=存在但不可见（exists && !visible，**严格语义**：target 不存在时恒 false 防 false-success）；wait 简写 `urlContains` 表单状态锚定；cond element 已接 buildLocateExpr.ok——V202609090001 顺修）；实现单源 `lib/target-resolver.js`（纯函数 selftest #23 机检）；存放 `webapps/<app>/flows/*.flow.json`（实值不入库——凭据走 `--var` 注入，selftest #18b 机检禁词）。
- **tag/strictTag 类型提示（V202609110001，仅 text 层生效）**：target 可带 `tag`（raw 标签名，字符串或数组，如 `"button"` / `["button","li"]`）——默认**软评分**：tagName 不在列表内的候选降权排后**不排除**（tagMiss 排序键追加在 fragment 之后，tag 未声明时零影响；命中闸门逻辑不变）；`strictTag: true` 升级**硬约束**（作者显式契约）：不匹配候选直接排除——改版时 fail 显性化告知契约破坏，不静默换候选。
- **kind 语义层（引擎隐式软评分，恒软不硬）**：click（含 `dbl:true`）/rightClick/type（带 target）/select 四路径的 text 层定位，引擎按 action 自动推导期望元素类型（activate/textinput/selectcontrol）参与软评分——tag 对照 tags、role 产物对照 roles、onclick/tabindex/contenteditable 对照 attrs（任一命中即 0 分），不匹配候选**降权排后不排除**（kindMiss 排序键位次 fragment→tagMiss→kindMiss→nearZero→面积；未注入时键恒 0 与旧链等价）。**显式压制隐式（单一控制方）**：target 已声明 `tag` 或 `role` 即该步不注入——作者已表达类型意图，引擎不叠加隐式期望；`_meta.kind: false`（flow 级，对齐 `_meta.hitTest` 先例）或 CLI `--no-kind` 紧急回滚。cond（element/absent/hidden）与 assert/wait/scroll/key/goto 不注入（断言语义与元素类型无关）；near 层保持纯距离不评分；select 的选项二次定位不注入。attempts 诊断带 `kindMiss` 计数——定位翻红时可直读几条候选因类型不符被降权。存量 flow 零改动自动受益（作者无感知，无需声明任何字段）。
- **container 容器收窄（ora-5 步骤 2，硬收窄无全局回退）**：target 内嵌 `container` 修饰字段（单独 container 不构成锚点；**步骤级 container 字段被 P0-2 拒收**），三形态恰居其一：`{text, match?}`（推荐默认——最优匹配取**最近结构祖先或自身**：tr/li/table/ul/section 等标签 + [role=row|rowgroup|group|region|dialog|menu|menubar|tablist|tabpanel|form|table|grid|list|listbox|tree|treegroup]，≤8 层）/ `{role}` / `{domPath}`（文档序首个）。声明后语义层①（text+role）与 near 锚点/pool 收窄容器内收集（scopeEl.contains 过滤；grid/domPath/point 不动——target 同带 domPath 时 text-in-container 失败照常落 domPath 兜底）；容器定位不过 gate4（容器是范围不是点击落点）。**容器内无候选绝不静默回退全局**（改写作者意图 = 点错元素）：容器未找到 → fail 附 `container-not-found`（容器文本漂移/未渲染嫌疑）；容器内 0 候选且容器外 N 条 → 附「容器外候选 N 条」（收窄生效但目标不在其中，target-changed 嫌疑）；多容器匹配取排序首个 + attempts `containersMatched` 计数（歧义显性化，不静默联合）；attempts 与 TARGET_NOT_FOUND 带 `container` 五元组 {form, found, matched, scopedFound, outsideCount}。cond（element/absent/hidden）同走 buildLocateExpr 一处生效——`absent + container` = 「容器内不存在」精确断言（容器外有不算）。**何时写**：同文本多义（侧栏/Tab/列表行同文名）写 container 钉住区域；span/button 类型歧义靠引擎 kind 软评分自动消解，无需声明。跨 frame 容器不支持（contains 天然同文档）。
- **批三四原语（V202609300016，oracle §3.3 落地，全部 opt-in——不写字段引擎行为逐字节不变）**：①`click.gate: <ms>`——dispatch 前**与点击完全相同的描述符**循环定位至 ok 或超时（clickTarget 单点提升=同源机制保证；500ms 轮询走 sleepFn、预算裁剪 min(gate, 步超时)+log.info 显性化；超时 TARGET_NOT_FOUND「gate 闸门超时」）——「点谁等谁」引擎化，消灭 wait 与 click 两次解析选不同元素的裂缝；手写等价物（闸门步+点击步同描述符）继续合法；gate 失败即出步不外层重击（gate 自带内循环等待）。②`cond.element.stable: {ms, polls}`——目标连续 polls 次轮询 rect 相等（±1px 四维）才算真——动画收尾/重布局完成的直接观察，替代魔法数盲等；⚠ 边界：页侧轮询在单次 evaluate 内同步执行，rAF/timer 驱动动画的帧钟不推进（跨求值重入才是帧推进主观察面，页内循环主要覆盖布局抖动/同步重排族；根治需 cdp-core awaitPromise 另立批次）；大 DOM 忙等有主线程代价，opt-in 天然限流；ms 1-10000 / polls 1-10 校验，absent/hidden 拒收 stable。③`target.unique: true`——过闸候选 >1 → `TARGET_NOT_FOUND(ambiguous)` 诚实红附候选全量（tag/text/rect/frame，封顶 8 条、attempts 记真实总数）——把「排序赌赢」变契约保证，与 container 收窄正交可叠加；⚠ 仅 text 层生效（role/near/grid/domPath 层声明会被忽略——作者勿跨层依赖）**〔批 5a V20261113007 起已演进：unique/nth 推广至 role 层、操作类步骤 uniqueDefault 默认开（三级逃逸）、新增 TARGET_AMBIGUOUS 细分码——现行为以 mechanisms §21 为准〕**。④`effect.cond` 数组形态 anyOf——任一单元达成即真（短路求值、单元异常按未达成不传染；centerClick 的 effect 预检同享语义）；多 network 单元串行窗口叠加会粗化轮询粒度（effDeadline clamp 防睡穿步超时）。
- **契约批机检（V202609300017，lintContracts 纯函数单源导出——selftest #74 消费；advisory 不改判成功、不进 `flow validate`；日常 authoring 走独立 `flow lint <file>` 子命令——V202610130003）**：**M1 闸门-点击同描述符 lint**（铁律①）——click/rightClick 步向前扫闸门窗口须同描述符（豁免通道：`gate` 字段=机制保证/desc 标「状态闸门」且与点击目标不同名/同身份点击链连续共享前置闸门；ms 盲等 settle 步不切断窗口）；**M2 歧义文本登记检查**（铁律②兼纪律⑥）——webapp.md ambiguousTexts 清单内文本作 target/cond.element 且无 container/unique → 红（`wait.text` 状态闸门=合法代理信号不查）；**M3 盲等证据 lint**（铁律③兼纪律⑦）——`wait ms` 步 desc 须带证据引用（日期/V 版本/diag-引用/实测/实证/用户裁定等）；存量违例=**冻结基线棘轮**（M1 15 条/M2 4 条逐条精确相等〔批 5a V20261113007 复核实际 M1 22/M2 5，以 tmpdata/impl-b5a/lint-postbaseline.json 冻结清单为准〕，新增即红、修复可缩减——delivery#21「单据」未按口径收窄=已标注真实债务）；**M5 候选扩散 advisory**（引擎侧）——locate ok 且 best 与次优候选跨 frame → log.warn+失败报告顶层 `ambiguityRisk`（「排序可能赌错」在定位成功但后续失败场景立即可见）。⚠ 新写 flow 约定：状态闸门步 desc 显式带「状态闸门」字样（M1 豁免通道）；盲等 desc 带证据引用；ambiguousTexts 内文本作 target 恒配 container 或 unique。
- **MCP uid 翻译规则**：uid 是 chrome-devtools-mcp 快照临时分配的，raw CDP 回放没有 uid——AI 写 flow **必须**把 uid 翻译成语义定位器再落盘（优先 text 精确 → 网格上下文 → domPath；坐标仅最后兜底）。
- `click` 原语 `dbl: true` = 双击（侧栏菜单类目标实测必需）——**X3 两段完整序列**：clickCount:1 一对 → 100ms → clickCount:2 一对（Chromium dblclick 检测依赖第一对；重试整体重发两段）；`flow validate` 只做 schema 校验（零连接）；`flow replay` 回放：**纯 CDP Input 域真实事件**（isTrusted=true 红线合规），每步独立超时（默认 5s，goto/wait 15s），原生 DPR 运行不 emulate（V202609080010）；`--no-hit-test` 关 X1 四层命中闸门（默认开）、`--post-verify` 开 X4 点击后复核（实验默认关，对应 `_meta.hitTest`/`_meta.postVerify`）。
- **drag 原语（V202609170002）**：`{action:'drag', target:<拖源描述符>, to:<放置目标>}`——`to` 两形态**严格二选一**：`{x,y}` 绝对坐标（CSS 视口 px，DPR 无关）或 `{target:第二描述符}`（回放定位后取中心）；x/y 与 target 混用 schema 拒收。**路线 A（纯鼠标序列 + buttons:1 按住段）**：hover(buttons:0) → pressed(left,buttons:1)@源中心 → 5 段插值 mousemove（每条硬带 `button:'left'+buttons:1`）→ released(落点,buttons:0)。**依据**：tmpdata/drag-live 实验 G3 两连过实证——按住段 move 带 `buttons:1` 即走完整原生拖拽管线（dragstart 执行/页面自产 payload/chromium x-drag-id 全真，isTrusted 红线全真实事件）；G3b 反证：按住段缺位掩码全链退化为普通 mousemove（dragstart 不触发）。轨迹参数 DRAG_TRACE（5 段/90ms 节距/80ms 按住起手）取 G3 实证值为起点——实验证节奏/步数非因子，取值仅为贴近真实手感与轨迹取证密度。**收尾语义**：released 后 dragend 即终点——release 被拖拽管线消费、DOM mouseup 不出现，**回放断言勿锚 mouseup**。withKind 不注入（拖源类型语义多样——div/li/自定义拖柄均有，v1 观察）。拖动期取证：轨迹中段 2 个 elementFromPoint 只读探针 → 步骤返回值 `dragPathProbe`（诊断字段，fail-soft）。**录制侧聚合边界（标记驱动）**：`events-summary` 蒸馏管线 aggregateDrags 以 dragstart→drop 双标记齐为聚合前提（V202609130007 已落流的强信号；元规则=事件标记>阈值），区间（此前最近 button:0 mousedown 起，同 tab）内鼠标序列折叠为一条合成 drag 事件——from/to 各带 point+target 描述符、path 轨迹按 6px 抖动阈值滤除、dispPx 总位移留标定（【drag 阈值标定】条目）；蒸馏按 distill 协议 1:1 映射 drag 步骤。⚠ types 采集时机边界（实弹 2026-09-17 实证）：recorder dragstart 监听在 capture 相、早于页面 handler 的 setData——dragstart 侧 types 常为空，**types 以 dropTypes 为准**（drop 侧实测带 `chromium/x-drag-id`=真原生管线证据）；不影响聚合（标记驱动，types 非判据）。**无标记不猜**：纯轨迹推断聚合不做；取消拖拽（dragstart 无 drop）不聚合（事件先落流不丢）；跨 tab 不配对。路线 B（Input.dispatchDragEvent 独立注入）不实施：无 dragstart/无源元素/payload 落调用方手里，与录制标记聚合不闭环——留档实验报告备查。真实复杂 web 应用（ERP）上路线 A 是否同样通待实弹复核（实验报告开放项）。
- 未指定 `--target` 时**自建标签执行、结束自关**（谁开谁关）；`--keep-tab` 保留现场排障。
- 失败即停：stdout 人读摘要（尝试/候选/现场/截图 + X1 被拒候选 top-N 拒因 + X4 hitMiss 标注）+ 结构化报告落 `tmpdata/flow-fail/`（步骤号 stepNo + 当时 URL + 候选元素列表 + urlTrail 轨迹 + **diagnosis 失败分诊**（V202609110001，TARGET_NOT_FOUND 类触发）：锚点回探（wait 锚点仍在→嫌疑当步目标/已消失→upstream-broken）+ readyState 轻探针（环境冻结）+ 拒因聚合（L4 拒因→遮罩/前置、0 候选→文本漂移）——纯 advisory「疑似」措辞不自动修复，探测失败≠没有证据、probesFailed:true 时 confidence 强制降 low）。**self-heal 协议**：读报告 → 交互通道修复该步 → 更新 flow → retry **≤1**，二次失败交人工（架构裁定，不写自动重试）。**任务优先降级——flow 失效时的探索伴跑兜底（2026-09-21 用户裁定）**：flow replay 失败且 self-heal retry ≤1 用尽（或失败报告 diagnosis 已明示结构性失效——应用改版定位符整体漂移/环境回归，retry 无意义）时，**任务优先：不恋战修复 flow，立即切「record 伴跑的探索模式」继续完成任务**——⚠ 触发前先排除网络抖动/瞬断类偶然故障（超时重试一次或轻探针确认环境稳定）：偶然故障不构成降级依据，误降级会平白丢弃已固化的 flow 资产——起录（`record`，`-v` 双流随行）→ AI 手动驱动完成剩余流程 → 需要感知就看最新录屏帧/抽帧（视觉事实只能看录屏判断，事件流文本无法判断）。**边界三条**：①探索不豁免红线——模拟人类双红线（isTrusted/不 goto 抄近道）照守，探索操作就是下一版 flow 的示范素材，路径越保真蒸馏修复越可用；②**验收/回归类任务不适用本降级**——回放失败本身就是验收结论，降级硬做=制造假证据，只报告不重录；③降级是任务层兜底不是 flow 层修复——flow 修复仍走蒸馏协议（新事件流 vs 旧 flow 逐拍对齐，红线 #9）。**收尾报告四要素**（任务结束随结果一并向用户汇报）：失效步骤与根因初判（文本漂移/应用改版/环境回归/冻结，引失败报告 diagnosis）＋flow 是否建议修复＋证据位置（事件流/录屏/失败报告路径）＋修复参考（新录制事件流可对照旧 flow 逐拍 diff）。缘起案例：2026-09-21 chatgpt.com 改版定位符整体漂移致 gpt-single-chat.flow.json 断链，oracle 辩论任务按本精神手工 CDP 绕行完成但未起 record 伴跑，事后修复缺对照素材成本高——本条目即该缺口补齐（应用级记录 webapps/chatgpt/TODO.md GPT-001）。
- **失败处理顺序=视觉优先（2026-09-30 用户裁定，排障总纲元规则一的回放失败落地）**：回放失败后第一动作=**读 flow-fail 终态截图/视频末帧**（`tmpdata/flow-fail/*.png`、`tmpdata/video/replay-*/` 末帧），确认页面实际状态（弹窗/遮挡/空数据/走到哪步）**之后再做任何结构化分析**（日志/失败报告 JSON/引擎源码/flow 改动）——一次视觉确认可排除大批可能性，结构化分析建立在错误前提上最费时。实锤案例（V202609300011/012）：终验首轮失败截图已含 WARN「请选择销售订单」+空网格一眼可见，agent 先做五层结构化分析并在错误假设（禁用窗）上改闸门白跑一轮（用户裁定点名「视觉兜底在哪里」）。⚠ 配套注意：失败报告 deepInteract.overlays 只查通用覆盖层三选择器（.modal/.mloading/.layui-layer-shade），应用级弹窗（.gongqi-warn 等）不在其中——**overlays=0 ≠ 页面无异常**，弹窗类信号以截图/视频末帧为准（可见弹窗 advisory 增强→TODO ①区）。
- 编写纪律：非幂等/业务写步骤必须前置显式 `wait`（文本出现）+ 后置 `assert`；快乐路径陷阱（弹窗/加载慢）靠 `timeoutMs` 兜底；知识漂移用 `_meta.baseKnowledgeVersion` 绑定 webapp.md 知识版本。路径纪律：触发类步骤（发送/提交/确认/打开）蒸馏与编写时优先 click 原语，**点击类步骤不得用 goto 等价替换**（见 §操作路径红线——点击承载业务语义，直达会跳过），直达 URL 仅当录制流中该步为纯导航；录制流中 enter 触发的触发类步骤可改写等价鼠标入口（等价判定与 §操作路径红线「等价判定法」同构：同业务动作不同 UI 入口）；编辑类（网格内 Tab 切格/Enter 确认单元格/Ctrl+S）保留键盘原语；业务语义承载不同者不得换形（V202609100001）。
- 视口纪律（V202609100002）：`_meta.viewport` 语义与对齐细节见 §视口与多分辨率兼容；蒸馏时从录制 session 头如实抄录（见 distill.md）。
- **视口三态策略（2026-09-28 用户裁定+同日方案 B 动态化）**：默认**纯跟随**（无声明不 emulate，原生分辨率）；`_meta.viewportMin: N`（数字=最小布局宽度，如 winui 双击路径依赖 ≥1920 宽声明 1920）=**地板语义**——用户不在场时 emulate 到 max(N, 实际宽)（**永不缩小**；override height:0=高度恒跟随实际；实际已 ≥N 纯跟随不施加），用户在场（既有页签 ≥1，排除本次自建/--target 标签）**永不 emulate** 只告警（实际 <N 打 advisory——布局依赖 flow 可能诚实失败），探测失败 fail-soft 保守托底，goto 后重申只托底（实际 <min-2 才重施加）；与旧 `_meta.viewport`（录制视口单值对齐——存量 flow 语义不变）同声明时 **viewportMin 胜出**。`viewportPlan`/`viewportMinPlan` 纯函数 selftest #65 机检。
- **视口高度地板（V202610190002，INBOX 2026-09-30「矮窗口高度地板」）**：`_meta.viewportMinHeight: N`（数字=最小布局高度地板——矮窗口（1705×664 实测）下底栏下拉菜单开在表单文档视口外、`elementFromPoint` null 致 effect 永假族声明，如 700/900）=高度维度同三态语义——不在场托底 max(N, 实际高)（**永不缩小**；宽度未声明时 override 用 `width:0` 跟随实际，0=禁用该维 override 同 dsf:0 先例；实际高已 ≥N 纯跟随不施加）、用户在场**永不 emulate** 只告警（越界维打 advisory），presence/实测读不到 fail-soft 保守托底，goto 后同样重申只托底（实际 <minH-2 才重施加）。与 `viewportMin` 宽度地板**独立可只声明其一**——**未声明 = 高度行为与现状完全一致**（零回归）；两维同声明则联合托底（各维独立取需托底维 min / 达标维 0）。现场诊断=失败报告 `targetState.viewportPlan`（declared/actual/below/mode）。纯函数 `viewportMinPlan`（vmin,vminH 扩展）selftest #79 机检（#65 为宽度维存量）。
- **状态性点击三明治纪律（2026-09-18 面板死循环定稿，依据 reports/面板死循环根因分析与稳态方案-oracle-20260918.md）**：①「闸门→有界盲等→闸门」——状态性点击的前置条件有闸门、效果有闸门，盲等只出现在两闸门之间且 desc 必须带证据引用；盲等不足=下游闸门诚实红（安全方向），过剩=浪费常数时间（成本方向），没有路径通向"错误地继续"；②「一次性点域」——点域/选中态切换类动作只做一次、效果由后续闸门判定：点域后 text 层常见双可见候选（选中项大+头部标签小，面积升序偏小候选），对已选中态重复点域会误点头部标签，补击一律先过闸门；③「toggle 安全惯用法」——弹出面板/菜单入口点击前加 `wait cond {hidden:{text:面板内标志文本}}` 关闸门（存在但不可见=收起态，recon 实证关态 DOM 仍有该文本 rect:null），点击后加 `wait text` 开闸门——无论入口是 toggle 还是幂等开，两种语义下行为一致正确（暖标签/补击场景强制前置关闸门；入口 toggle 语义探针结论未归档不悬置设计）。
- **蒸馏 scroll 副作用甄别（2026-09-18 用户裁定）**：recorder 会把系统自动滚动录成 scroll 事件——点击域/树/菜单类元素后短窗口内同容器的 scroll 事件应识别为点击的附带自动操作，**不生成手动 scroll 步骤**（实证：示例ERP面板点「物料域」后面板自动滚动到该域 APP 区被误录为人类 scroll，蒸馏成手动 scroll 步骤后与自动滚动叠加过滚把图标推出可视区，且滚后 0.1s 即点击会在平滑滚动飞行中撕碎 click 事件——mousedown 落在目标上、内容移走、click 不合成、handler 静默，「面板图标对 raw Input 不响应」的历史口径即被该竞态污染）。
- **防复发纪律九条（2026-09-18 失败数据合议定稿，unanimous；详单→reports/失败数据合议分析-council-20260918.md）**：原则——①**点谁等谁**（wait 与操作同链同目标：wait text 带 container 走 buildLocateExpr 全链路已引擎化；代理信号只做状态证明且 desc 显式标注「状态闸门」）；②**同名必唯一**（跨容器同名文本（本应用登记见 webapp.md ambiguousTexts）必须 container 硬收窄+exact 到唯一可见候选，候选>1 诚实红，禁止赌排序——排序在容器间无语义）；③**动作必验效**（每步声明并验证状态增量：元素/网络/URL；时间盲等永不充当效果证明）。操作——④**动画窗必 settle**（盲等被闸门夹住）；⑤**scroll 副作用删除**（见上条蒸馏甄别）；⑥**container 硬收窄全覆盖**（仅声明式参数，禁私有定位补丁）；⑦**盲等三明治 ≤12s** 且被效果锚夹住（desc 带证据引用）。审计——⑧**过闸 <100ms 记假绿嫌疑**（引擎 [audit] fast-pass 已上线：条件类 wait 秒过=「文本早已存在于错误目标」签名，回放后扫 completed[].audit 人工复核；V202609180003 扩展到 assert 效果断言——速通=旧状态残留假绿，b2f1b 5ms 实证）；⑨**无演示依据不成步**（提取段 28+ 教训：无人类演示录制不得猜写步骤，交演示补录）。机检排期：①②⑥⑦ 已由 V202609300017 lintContracts 落地 selftest #74（M1 闸门-点击同描述符 lint/M2 歧义文本登记含⑥合流/M3 盲等证据=⑦ desc 面——见 §flow 回放守则「契约批机检」条），⑨ 属评审纪律暂无机检。
- **标签卫生与运行节奏（2026-09-18 oracle 归因批，网络类症状主因缓解）**：①**同 profile 多 ERP 标签并存=会话互踢/资源竞争主因**——实弹天然对照：4 标签累积期回放点击链 5.2s/步 vs 清场后 222ms/步（差 23 倍），「网络连接」弹窗正是被踢会话的外部性（落在用户长活标签上，人工单标签从不遇到）；**2026-09-30 E1 刻意实验确认（V202609300015，三臂同 flow 对照）**：基线 1 标签 264~531ms/步 → 4 标签并存 5271~5521ms/步（10~20 倍劣化）→ 清理后恢复轮 258~535ms/步**立即复原**；wait 轮询步骤全程 ~1.2s 不受影响=劣化集中在交互定位/派发链（会话互踢特征，排除服务端疲劳累积）；②纪律：**回放/清理全程 ERP 标签数 ≤2（用户长活标签+当前自建标签）**；失败标签取证三件套（fail 报告+终态截图+录屏）看完即关；同日多轮验证首跑 --keep-tab 后续 --target 复用同一自建标签；**两轮回放间隔 ≥2 分钟**（goto 全量重载 winui 会话重建有服务端成本，8 分钟 9 次门户重载+域更新恢复期=压测行为）；③域级更新重启后首跑前先人工浏览确认桌面/模块正常再上回放；④效果断言组合拳：异步业务动作后先 `wait hidden` 旧状态锚（如提取表单标题）再 `assert` 新状态文本——防断言命中「将拆未拆」残留（引擎侧 assert text 已轮询化+V2 漏斗，M4 速通审计覆盖 assert）。

### 自签 HTTPS 验证管线（V20261112001；--insecure = 连接级忽略证书，断连即回退；wait --expr 等应用级就绪）

```bash
TID=$(node tools/cdp.js new about:blank | sed -n 's/.*targetId=\([^ ]*\).*/\1/p')
node tools/cdp.js goto --insecure --target $TID https://<自签主机>/
node tools/cdp.js wait --expr 'document.querySelectorAll("canvas").length>=1' --target $TID
node tools/cdp.js screenshot --target $TID --out /tmp/x.png   # 读数命令不带旗标（零证书校验）
node tools/cdp.js close $TID
```
WS/持续子资源整场覆盖 → `flow replay --insecure <file>`；文本锚变体 → `wait --text "加载完成"`。环境注记：3020 自签已被浏览器容器信任（非冷靶），验证旗标须用冷自签 fixture。

## §排障总纲：视觉优先与分层归因（V202609100001）

> 本节是既有排障簇的**入口伞**：假绿取证 → §前置操作条件与假绿治理；帧对照操作 → §视觉兜底三步；录制零事件 → §采集失效症状指纹。此处只做归因框架，不重写细则。

**视觉优先操作序**（出问题的前三步）：

1. **截图看现状 / `-v` 帧对照看过程**——页面实际状态第一（元素在不在 / 面板开没开 / 走到哪一步 / 有无报错弹层），一次视觉确认可排除大批可能性；
2. `events-summary` / 失败报告 / 采样日志做结构化分析——**结构化分析建立在错误前提上最费时**（对着"以为发生"的假象查代码 = 双倍浪费）；
3. 范围收窄后才进代码层排查。

**分层归因表**（四层 × 两种时期的排查序；**顺序不绝对，按情况调整**——已有证据指向某层时直接跳层）：

| 层 | 运营期序 | 开发期序 | 典型指纹 | 核对动作 |
|----|----------|----------|----------|----------|
| 偶发（网络/临时） | 1 | — | 重试即过、无规律 | 同操作原样重试一次 |
| flow.json / 知识漂移 | 2 | 2 | X1 拒因文本变化、候选命中但 UI 不符、landing 与录制不一致 | 对照录制事件流、webapp last-verified |
| chromeuse 代码 | 3 | 1 | CHANGELOG 近改后出现、哨兵/闸门告警、批退避路径触发 | 查 CHANGELOG/VERSION 近条目 → 源码 |
| 其他（环境/浏览器/应用自身） | 4 | 3 | probe 三通道异常、多应用同症、域 -32601 类 | probe / §环境速查 / 交应用方 |

**术语判定**：**运营期** = webapp/flow 蒸馏成熟、日常业务使用中；**开发期** ≈ CHANGELOG 当日或近期有 chromeuse 代码条目（本 skill 自身验证中）——开发期代码嫌疑提前为第一顺位（改动后行为变化最常见）。

## §前置操作条件与假绿治理（V202609090001，council 定稿）

**前置操作条件第一假设**（用户原话精神——回放点击"无反应"时的排查序）：

1. **点击无反应 → 第一假设是前置操作条件未满足**：上游菜单/面板没打开、前序步骤被静默跳过、组织/域未选中——不先怀疑定位器（文本匹配得上 ≠ 面板开着）。
2. **截图验证菜单/面板是否真的显示**：日志 ✓ 只代表事件已 dispatch，不算证据；关键状态变迁步骤后必须 screenshot 或 assert 复核（假绿的根源就是"✓ 但没发生"）。
3. **对照 uiAppear 知识找断裂点**：录制期的 uiAppear 事件标出了每次点击引发的 UI 变迁——回放断链时对照找"哪个前置变迁没有发生"。
4. **修复优先补前置而非改定位**：补 `wait text`（等上游菜单出现）/补前置步骤（先点开 buttonmenu/面板），而不是把定位器改硬（坐标/多层 domPath 硬点在前置缺失时同样无效）。
5. **纪律**：flow 不得跳步；**日志全绿 ≠ 生效**——关键状态变迁步骤后必须 assert/screenshot 复核（X4 post 复核 `--post-verify` 可作实验性辅助）。

**收单断言通用律（V202609130001，chatgpt 三轮假绿事故沉淀）**：提交类操作（发送/提交/保存/下单）的收单断言必须用**效果断言**（URL 迁移/计数增量/状态回归），**存在性断言可被历史内容满足**——会话页旧消息节点、既有会话 URL、历史列表行都能让 element/存在性检查秒过，断的是「页面上有」不是「本轮产生了」。实例：`wait element assistant` 节点在零发送时被上一轮回复满足（chatgpt 单轮 flow 9/9 全绿但消息从未发出）；对照效果断言 `wait cond url contains "/c/"`（乐观会话创建=消息已提交）才能真正证伪「按钮 ✓ 但没发出去」。配套：type 原语写后读断言（P0-1）、click 可选焦点断言 `focusAssert`（P0-3）、wait 超时终态取证 `terminalState`（P1-1c）——引擎侧防线见 `lib/flow-engine.js` V202609130001。

**确认失败分诊序（当步闸门失败，V202609100001）**——闸门确认失败的后续动作序：把假绿发现从「后续连锁失败」提前到「当步拦截」（= 元规则一「视觉优先」在闸门场景的操作化）。四分支路由到既有节，不重写细则：

| 分支 | 判据（截图视觉判断） | 动作 |
|------|------|------|
| 弹窗/遮罩 | 弹层/遮罩挡住目标 | 处置（× 关闭/handle_dialog/点确认）后重试原动作 |
| 页面变迁非预期 | 画面与预期流程不符（landing 漂移/跳到别的页面） | 停止推进；对照录制事件流/uiAppear 重识别当前状态（→ 本节排查序 3） |
| 页面无变化 | 目标原位未动、无任何反应 | 转前置操作条件第一假设排查（→ 本节排查序 1） |
| 报错提示 | 有文案 | 读文案分诊：校验类（必填/格式）= 补数据重试；系统/权限类 = 留证上报 |

分诊纪律：**分诊前不重试原动作**（盲目重试会把弹窗类可自愈异常误判为定位失败）。

**可见性三层判定**（假绿治理的防线分层，实现单源 `lib/target-resolver.js`）：

| 层 | 机制 | 位置 | 成本 |
|----|------|------|------|
| ① 廉价前置 | visRect：rect<1 + 自身 display/visibility（+ offsetParent O(1) 判任意深度 display:none） | 全部候选收集时 | 每元素 1-2 次样式读 |
| ② 精过滤 | X1 四层闸门（rect/offsetParent/visibility/elementFromPoint 主判定，三段容忍保 tspan） | 仅 text/role 锚点层（near pool 严禁——性能红线） | 每候选 1 次 elementFromPoint |
| ③ click 前命中闸 | X4 容忍式复核（ensureHittable：point 只查非 null；其余 gone 判成功/covered 拒/hitMiss 标注） | centerClick/select opt/scroll target dispatch 前 | 1 次 evaluate（8s 预算，异常放行） |

wait text 走 X2 两级漏斗（innerText 快路径 + 过闸判真——幽灵模板文本不再假绿）；assert text 保持单级语义。

**Y1 运维条目（浏览器恢复）**：标准执行方式 = **`node tools/cdp.js browser-restart`**（V202609100002 产品化子命令：Browser.close 优雅关闭 → keep-alive 拉起 → 探活轮询 → tab 清单；2026-09-10 实测全链路 ~10s，ExitType:Normal 无恢复气泡；Y3 跨仓旗标 TODO 引用保留）；⚠ 环境差异：keep-alive 自动重启为 NAS chrome-browser 容器（wrapped-chromium）特有——无自动重启机制的环境（如 Windows 桌面端）close 后需手动重启浏览器再重试探活；爆炸半径=整浏览器（所有 tab 全关，录制/回放/人工现场全灭）——仅在确认无 precious 现场时使用。

**Y2 证伪记录（2026-09-09）**：「崩溃恢复气泡（infobar）遮挡页面元素导致点击偏移」假设不成立——气泡属 browser Views 层（浏览器窗口 chrome），不占据页内 viewport 坐标、不参与 elementFromPoint 命中测试。恢复期面板打不开优先怀疑 winui handler 未接线（前置操作条件①），不要归因气泡遮挡。

### 视觉兜底：录屏对照三步（V202609090002，`-v` 显式开启制）

参数语义（用户裁定）：`record` / `flow replay` 默认**纯事件+输入监听**（零录屏开销、零新增 CDP 命令，页侧 recorder.js 一行不碰）；`-v`（= `--video`）显式开启 `Page.startScreencast` 帧流兜底（每 target 一路，落 `tmpdata/video/<session>/`，index.json = chromeuse-video/1 双时钟 tArrive/tMeta；replay 落 `tmpdata/video/replay-<ts>/`）。`--video-width 960` / `--video-quality 60` / `--video-interval 1000` 仅 -v 时生效（无 -v 静默忽略）。**分辨率口径（2026-09-18 用户裁定）**：默认 960 宽压缩档对人工回看/蒸馏取证字体不可辨——**蒸馏录制与验收取证一律显式 `--video-width 1920 --video-quality 80` 高清档**（1920 视口实测字体可辨；事件流识别不受分辨率影响，此口径为视觉取证面）。**帧率参数（帧率 v1）**：抽帧率 `--every-nth <n>`（默认 6 = 每 N 个合成器帧取 1，上限 fps ≈ 合成器 fps/N ≈ 10fps，静止零帧；`--every-nth 1` = 旧全速收帧；⚠ 默认自全速收紧为 6——录制产物帧数下降属预期，diff-video/evidence-pack 事后按 index.json 取帧、与采集率解耦不受影响；v2 事件驱动两档制（巡航/升档）见 reports/录制侧演进分析-oracle-20260917.md 题 2）。**cast 伴跑 replay 须 `--no-foreground`**（2026-11-13 实证：默认前台保障与 flow replay 并发会吞点击/焦点等待超时；cast 自然到时才落 mp4，SIGTERM 不 finalize）。

排查三步（假绿/前置问题发生后的视觉取证序）：

1. **events-summary 结构化真相**：`node tools/cdp.js events-summary <recording>.json`——类型/帧分布先定断裂点（结构化优先，不先看图）。
2. **diff-video 对照报告**：`node tools/cdp.js diff-video <recording>.json`——每个 click/dblclick/uiAppear/navigate → 前后最近帧（路径+Δt，按 tab 分列），报告 chromeuse-videodiff/1 落 `tmpdata/videodiff/`；外部 mp4 用 `--video-file <mp4> --t0 <iso>`（bin/ffprobe 取时长，对齐误差 ±2s 级）；`--mp4` 可把帧序列合成 mp4（-framerate 2）。
3. **疑点帧 observer ≤25 帧/批**：把对照报告指向的疑点帧交视觉分析（单批 ≤25 帧，>35 帧易超时挂死——人类演示录屏学习管线同纪律）。

`-v` 使用时机三场景：

1. **人类演示录制必带**（演示不可重现 = 证据价值最高；distill.md 演示协议首要落点）；
2. **假绿/前置问题 `flow replay -v` 重跑**（回放全程帧流 + 失败报告对照，直接看「日志 ✓ 但画面没发生」的断裂瞬间）；
3. **偶发 flaky 布控 `--every-nth 30`**（降帧率省盘长时布控≈上限 2fps，复现时帧流即现场）。反例：确定性流程再录、纯事件审计**不带** `-v`（帧流是成本不是收益——默认关）。

### 排查升级路径：内建帧流 → 调参重录 → 外部 mp4（V202609100001，用户裁定递进策略）

**递进策略**：日常排查保持默认参数（1fps/960 够用——事件对齐排查是主用场景）；遇到**小字看不清 / 1 秒内快速变化**时，**当场用调参命令重录**，而不是常态开高清：

```bash
node tools/cdp.js record -v --video-width 1920 --video-quality 80 --every-nth 2
```

（体积约增 2-3 倍，tmpdata 可承受。）

**-v vs 外部 mp4 分工表**：

| 场景 | 用哪个 |
|---|---|
| 事件↔画面精确对照（首选） | **-v 内建帧流**（实测 37/37、46/46 事件精确对齐，时间戳原生） |
| 小字细节 / 精确 UI 状态 | 调参重录 -v 或外部 mp4（全分辨率） |
| 1 秒内快速变化（转瞬菜单/动画） | 调参 `--every-nth 2` 重录（提高抽取密度≈上限 30fps） |
| 页面外因素（浏览器气泡/下载条） | **外部 mp4**（帧流拍不到 chrome 层） |
| 鼠标光标轨迹 | **外部 mp4**（帧流无光标） |

实战佐证：两次三方对照（2026-09-09/2026-09-10）——内建帧流 37/37 与 46/46 事件精确对齐；外部 mp4 提供光标轨迹与高画质细节，两者互补而非替代。

### 采集失效症状指纹与排查四步（V202609090003）

**症状**：人工演示明明操作了（录屏 mp4 有点击），但录制事件流里对应操作 0 条（或持续零增长）。排查序：

1. **查落盘头**：recording JSON 的 `session.injectLost:true`？（哨兵 3 连败标记——该 tab 采集确认持续失效）`wsDown:true`？（WS 断开退场——数据止于断点）`targets[].pendingInject`？（注入未完成即停）
2. **查通道计数**：采样日志/`events-summary` 的 ch 分布（`binding` vs `beacon`）——双零=采集失效（注入没了）；单通道零=通道级故障（如 https 混合内容拦 beacon→binding 应在）；`ch` 字段 V202609090003 起才有（旧流无通道标记无法断案，如实标注）。
3. **查状态迁移日志**：log/chromeuse.log 搜 `哨兵：`（OK→SUSPECT→LOST 迁移、自愈成败、`renderer-swapped re-attach` 重附挂）——静默失效在治理后必有状态迁移痕迹；无痕迹=哨兵未跑（--no-sentinel？）或失效发生在哨兵首探前。
4. **查哨兵告警**：`✗✗ 哨兵重注入 3 次未恢复` / `连续 N 次自愈失败` 告警——出现即该 tab 采集确认不可自愈，需人工（重启浏览器/换 profile）。

**gamma 边界目录（已知不覆盖场景，录制前对照）**：OOPIF（跨域 iframe 独立 target，不注入——事件盲区）；严格 CSP 页（页面注入被拒——CDP binding 通道不受 CSP 影响但 evaluate 注入可能失败→pendingInject 交哨兵）；bfcache 冻结页（前进后退缓存中的文档不产事件）；bindingCalled 持续零告警但事件有（=beacon 通道故障、binding 正常——反向不影响采集，如实记录）。

### 验收回放证据包（evidence-pack，V202609170003）

一次验收分散多段录制（段间午饭等）时，把各段产物按**绝对时间戳**归一到统一时间轴产出索引式证据包——**失败时也拿得出完整证据链**（ora-2 价值定位）：

- 命令：`node tools/cdp.js evidence-pack <recording-*.json|父目录|录屏会话目录>... [--gap-seconds 300] [--out 目录] [--title 标题]`；输出 `tmpdata/evidence/evidence-pack-<stamp>/`：`timeline.json`（chromeuse-evidence-pack/1：各段起止/相对偏移/事件分布/关键帧索引/damaged 损坏段登记）+ `README.md`（段清单/中断清单/文件索引/生成命令与环境——取证自足，脱离会话也能读懂）。
- **索引式（v1 边界）**：视频/事件流原位引用不复制不转码；输入三形态 = recording-*.json 列表 / 父目录非递归自动发现 / 录屏会话目录（index.json 按 session.id 反查事件流）。
- 段间中断：相邻段间隔 > 阈值（默认 300s，`--gap-seconds` 可调）在 `timeline.gaps` 标 `interruption`（如午饭），不静默拼接；会话时间交叠标 `overlap` 如实呈现。
- 关键帧：显著事件（click/dblclick/uiAppear/navigate，与 diff-video 同口径）× 该 tab 帧池最近前后帧**路径引用**（每段上限 20）；对齐基准 = 事件 tRecv ↔ 帧 tArrive 同钟毫秒（旧流缺 tRecv 回退 t 并标 tRef），段起止 = session.startedAt/stoppedAt 绝对时刻（旧 Z 结尾串兼容）。
- 损坏段（JSON 损坏/格式不符/缺 session 头）登记 `timeline.damaged` 不中断打包——证据链完整性优先，全部损坏才响亮失败；段 `injectLost`/`wsDown` 可信度标记带 ⚠ 透传（取证先看这两位再信事件数）。
- 后续分析：单段全量对照走 `diff-video`；疑点帧交 observer ≤25 帧/批。

## §环境速查（NAS / 桌面差异一行表）

| 项 | NAS 容器 | 桌面 Windows |
|----|----------|--------------|
| browserUrl | `http://chrome-browser:9224`（coding-envs 服务名，经 nginx sidecar） | `http://127.0.0.1:9222`（本机 Chrome 直连） |
| Chrome 管理 | coding-envs compose（chrome-browser 容器） | 本机 chrome.exe + 9222 + `C:\chrome-debug`（Chrome 136+ 必须非默认 user-data-dir） |
| opencode.jsonc 真身 | 部署机卷 `opencode/root/.config/opencode/opencode.jsonc`（容器内 /root/...） | `%USERPROFILE%\.config\opencode\opencode.jsonc` |
| npx 写法 | `["npx", "-y", ...]` | `["cmd", "/c", "npx", "-y", ...]` |
| npm 预热 | 容器内 + 代理（config proxy.httpProxy 登记值） | `$env:HTTPS_PROXY=<登记值>` 后再 npx |
| restart | `docker compose restart opencode`（用户/空闲期） | 重启 opencode 进程 |
| 安装模式 | `--link` 推荐（【install 跨平台链接形态实测】前先在容器内验证 symlink 识别） | copy 默认（junction 悬空隐蔽，R12） |
