# chromeuse distill —— 事件流蒸馏协议（会话内 LLM 批处理，零脚本零 API）

> 定位：把录制事件流（chromeuse-events/1）蒸馏成三件产出——**flow 草案 + webapps 知识草案 + 坑清单**。蒸馏是离线批处理（读完整事件流总结，规避 G10 逐步往返瓶颈）；深度语义化归本协议，确定性预处理已由 `cdp.js events-summary` 完成（层 1 规则代码）。

## 输入

- 事件流：`tmpdata/events/recording-*.json`（先跑 `node tools/cdp.js events-summary <file>` 看预处理摘要）。
- **定位素材**：`tmpdata/events/locate-materials-*.jsonl`（与事件流同 session 时间戳；V202609220002 起六型动作白名单 click/dblclick/contextmenu/input/change/paste 自动落盘，形状=`aria{role,name}`/`domPath`/`id`/`testid`/`text`/`dynamicCls`；素材不进事件流，蒸馏时按 `seq`/时刻与事件对齐）——生成规则见下节。
- **人类演示录制命令默认带 `-v`**（V202609090002）：`node tools/cdp.js record -v --duration …`——演示不可重现 = 证据价值最高场景，录屏兜底首要落点；帧流落 `tmpdata/video/<session>/`（index.json = chromeuse-video/1），蒸馏前跑 `node tools/cdp.js diff-video <recording>.json` 生成事件↔帧对照报告（落 tmpdata/videodiff/），按帧补足事件流看不到的视觉真相（菜单开合/动画中间态/误点）。
- 可选关键帧截图：录制期间人工截取的目标状态图（辅助理解业务语境，非必需）。
- 关联应用知识：`webapps/<app>/webapp.md`（识别特征/matchers、已知坑——蒸馏产物要与之对齐，不重复收录）+ `webapps/<app>/TODO.md`（应用级台账，坑条目查重与打标去向）。

## 素材→target 生成规则（V20261113001，录制→蒸馏定位链 V1）

素材是录制期的定位原料（字段见 `lib/record.js:68-77`）。生成 flow target 时按素材条件择一，命中即止：

| 素材条件 | 生成动作 |
|---|---|
| `aria.name` 非空 | **text 层首选** `{text: aria.name}`；role 可作 tag 修饰（`{text, tag: aria.role}`）——七级回退得到的人类语义名，回放期最稳 |
| `dynamicCls: true` | **强制优先 aria 锚点**（text/role）；domPath 仅兜底——动态类站点整代重排时 stable path 也会漂移 |
| `domPath` 且 aria.name 为空 | **③层兜底直接抄作** `{domPath: '<css>'}`（稳定 id 锚点截断/动态类滤除已由录制侧完成） |
| `testid` 存在 | flow 无 testid 层 → **desc 注记** `testid=…` + 候选进 webapp.md；不硬造 target 字段（真要 testid 层=后续评估） |
| 同文本多义（侧栏/Tab/列表行同文名） | **container 收窄** `{text, container: {text|role|domPath}}`（三形态恰居其一，硬收窄无全局回退）——素材 domPath/aria 可作容器选材依据 |

> **操作类步骤 default unique:true**（V20261113006 #126 步3，批 1 边界指针兑现）：点击/右键/输入/下拉/滚动/拖拽的 target 生成时**默认 `unique:true`**（引擎 `_meta.uniqueDefault` 缺省即开、按操作类自动注入——显式写与不写等价，写=自文档）；确实只能多值按序取 → 写 `nth: N`（0 基，与 CLI `--nth` 同名同基；**与 unique 互斥**，二者只能取其一），禁止靠五键排序赌；单步确需关闸门 → 步骤级 `unique:false` 显式逃逸（或 target.unique:false）。回放多命中 → 诚实红附候选清单（TARGET_AMBIGUOUS），人工复核描述符/改 nth——比静默换目标好。unique 契约与 role 层 aria name 细则见 playbook §flow 回放守则。

## 相邻事件等待决策树（V20261113001，整合 uiAppear 最强规则+锚点优先级五级）

对相邻两条语义事件（前序动作 → 下一动作）择一，命中即止（勿叠加多个 wait）：

1. **间隔 <500ms** → **直连**：不插 wait 步（下一动作紧接；插 ms 拖慢并掩盖真实竞态）。
2. **下一事件目标可定位**（素材 aria.name/domPath 命中，或 uiAppear items 与下一 click 目标文本匹配——「等你要点的那个」）→ 插 **wait text** 或 **cond.element** 就绪判据，就绪即走，不写固定 ms。
3. **uiAppear 无文本容器**（items 均无有效文本）→ `wait ms = clamp(前序点击→下一事件实测间隔, 500, 3000)`（M3 纪律：ms 须来自实测）。
4. **无任何锚点**（初始化/跨域 iframe 盲区/无 uiAppear）→ `wait ms`=实测间隔 + **desc 证据注记**（无锚点场景最诚实的表达，不追求消灭）。

- **ms 一律取录制实测间隔**（禁 AI 凭空估计）；分支 1 的「直连」≠ 删除业务就绪断言——业务效果仍由 `assert` 表达。
- 与 uiAppear 节的关系：分支 2 吸收「最强规则」，分支 3 吸收无文本容器规则；`triggerType:'load'`/repeat toggle 仍按 uiAppear 节处理。

## 控制流表达力（V20261113008 #127：eval / set / cond / loop）

录制流天然线性；仅当演示包含**显式分支/重复**（按页面状态点不同按钮、逐行勾选）才用新原语，其余保持线性（flow 的确定性/可回放/证据链是差异化——不做通用脚本语言）：

| 原语 | 形状 | 蒸馏/编写要点 |
|---|---|---|
| `eval` | `{action:'eval', expr:'只读JS', var:'变量名'}` | 从页面读值（如 `document.querySelector('#x').textContent`）；表达式内引用变量用 `__vars.name`（**禁 `{{}}` 拼接**）；禁 process/require/fs/child_process/module 与 eval()/Function()/import()；预算缺省 3s（上限 10s） |
| `set` | `{action:'set', var:'名', value: 字面量}` | 字符串/对象内 `{{var}}` 在步骤执行时插值；只赋值不计算（算术/读页面用 eval + `__vars`） |
| `cond` | `{action:'cond', when:{cond\|expr\|var,equals?}, jump:{to:'label'\|skip:N}}` | 分支=跳步；`label` 全原语通用且唯一；后退跳步=循环式（全 flow 重复执行上限 50）；禁从循环体外跳入重复体 |
| `loop` | `{action:'loop', times:N 或 over:'数组变量', count:M, itemVar?, indexVar?}` | 重复**后续 M 步**；times 1~50；over 每遍写 itemVar/indexVar（0 基）；超硬上限=`LOOP_LIMIT_EXCEEDED` 诚实红 |

- 质量清单追加：分支/循环步骤必须在 desc 写**演示依据**（哪个页面状态触发/为什么重复）；循环体必须含效果断言或退出条件（lint M6 对 times>10 与后退跳步 advisory）；禁止把线性录制流改写为循环（只有演示确实重复才落 loop）。原语计数唯一真源=`lib/flow-engine.js` ACTIONS.length。

## 输出（三件产物）

1. **flow 草案**（chromeuse-flow/1）：可回放动作序列。目标描述符优先 text 精确匹配（回放期四层回退兜底）；**同文本多义（侧栏/Tab/列表行同文名）→ 写 `container` 容器收窄钉住区域**（三形态 `{text,match?}`/`{role}`/`{domPath}` 恰居其一，硬收窄无全局回退——细则见 playbook §flow 回放守则）；**span/button 类型歧义 → 引擎 kind 软评分自动消解，无需声明任何字段**；每个业务写步骤前置 `wait text`（就绪标志）后置 `assert`（业务效果）；`_meta.dpr` 如实记录录制环境**实际值**（V202609080010 起录制/回放均不 emulate DPR——仅记录参考，不加 emulate 步骤）；`_meta.viewport` 从录制 session 头如实抄录（record 侧已采集 iw/ih/dpr/sw/sh——V202609100002），不改不猜；具体值一律 `{{var}}` 占位或断言代替（会话状态漂移裁定）。**等待锚点优先级（V202609110001）**：业务可观察状态（就绪文本/UI 元素，可用 cond `absent`/`hidden` 表达"消失/隐藏"类就绪）> 稳定 UI 状态 > 关键 network 请求 > URL > 固定 ms（最后 fallback——无锚点初始化场景最诚实的表达，不追求消灭）。
2. **webapps 知识草案**：菜单路径、字段映射、业务步骤描述——按三分类规范判断去向：通用手法 → playbook；应用专属可复用 → `webapps/<app>/webapp.md`（带 last-verified）；业务领域知识 → `tmpdata/<项目>-经验回传.md`（不入库）。
3. **坑清单 → webapps/<app>/TODO.md INBOX**（V202609080008 两级 TODO）：应用级观察一律进 `webapps/<app>/TODO.md` INBOX 追加（只追加不编号）；**AI 打标规则**——默认 `app-only`，仅当升级判定双轴同时成立才标 `candidate-通用` 并附一句判据（双轴：① 根因机制不引用本应用专有资产 ② 解法可复制不依赖应用专属路径）；**候选≠升级**：升级另需触发器（第二个 app 撞同坑 / 人工确认），AI 永不自动升级；已确认根因与通用解法 → webapp.md 已知坑 / playbook 专题。

**通用性评分指令（V202609080012，蒸馏时逐坑执行，写入条目「通用性判定」行）**：

| 轴 | 2 分 | 1 分 | 0 分 |
|----|------|------|------|
| ① 根因 | 通用 web 机制（同文名歧义 / 时序竞态 / 主线程冻结 / 命中劫持），不涉及任何应用专有资产 | 混合：通用机制 × 应用特定触发条件 | 根因点名应用专有资产（如 `dsform-*.js` 插件实现） |
| ② 解法 | 可跨应用复制（精确定位器 / 通道分级 / 网格上下文），不依赖应用专属路径 | 解法思路通用但参数绑定应用节奏（如固定等 10s） | 解法依赖应用专属入口 / 专有资产改动 |

- 判定：**双轴各 ≥2 分 → `candidate-通用`**（附一句判据）；任一轴 <2 → `app-only`。
- 候选≠升级：升级另需唯二触发器（第二 app 撞同机制坑 / 人工推广流程显式确认），且升级 = skill TODO 编号条目 + 双向链接行（`已升级→skill TODO-NNN (date)`）。

## 质量清单（蒸馏产出必须逐项确认）

- [ ] **业务意图确认**：每个 flow 步骤有 `desc` 说明业务含义（不是机械坐标/文本堆砌）；分支路径（弹窗/失败重试）标注出现条件。
- [ ] **凭据脱敏复核**：蒸馏产物（flow/webapps/坑清单）二次扫描——不得含账号/密码/token/真实业务敏感值；事件流里 password 字段已是 `***`，但用户名/单号等半敏感值也要 `{{var}}` 化。
- [ ] **人机确认环节**：蒸馏结果展示给人类校对（业务路径对不对、步骤全不全、断言合不合理）→ 确认后才入库（webapp 推广流程：编号条目 + CHANGELOG + bump + 提交）。
- [ ] **回放验证**：flow 草案入库前 `node tools/cdp.js flow validate` schema 过 + `flow replay` 至少 1 次跑通（self-heal 协议 retry ≤1）。
- [ ] **终态复核（V202609090001 假绿治理）**：回放完成后必须 screenshot 或人工观察确认**目标终态**并记入 flow verified 注记（日志全绿 ≠ 生效——X1/X4 已把定位层假绿转红，但业务侧效果仍须终态证据）；被假绿污染的 verified 基线：重跑 + 人工复核后 bump `_meta.baseKnowledgeVersion`。
- [ ] **定位证据来源标注（→ playbook §LLM 目标引用边界）**：每步标注定位证据来源（录制事件流引用/观察引用/作者声明）——落蒸馏报告/证据包外部映射文件，不进 flow schema、不进回放执行链。
- [ ] **wait ms 值来源**：wait ms 值须来自录制事件流实测间隔（uiAppear 消费规则的观测间隔），禁 AI 凭空估计。
- [ ] **唯一性闸门**：操作类步骤默认受 unique 闸门（引擎注入；显式 `unique:true` 自文档）；多值仅按序取第 N 个 → `nth: N`（0 基，与 unique 互斥）；刻意关闸门 → 步骤级 `unique:false` + desc 说明理由。
- [ ] **宽布局依赖声明 viewportMin（V202609280001 三态视口策略）**：flow 依赖宽布局（winui 双击 ≥1920 族）时声明 `_meta.viewportMin: N`（最小布局宽度地板）而非依赖录制视口单值——多设备访问下自适应（不在场托底 max(N,实际宽) 永不缩小/在场不 emulate 只告警），细则见 playbook §flow 回放守则视口三态策略。

## T3 口述 fallback 分支

无录制条件（浏览器不可注入 / 临时环境）时：人类口述步骤 → AI 按步骤**交互探索复现**（MCP 工具，非回放）→ 复现路径整理为 flow 草案 → 同样过质量清单。缺点是慢且易踩坑（文本匹配歧义/主线程冻结类），仅作兜底。

## uiAppear 消费（V202609080017，council A⁺ 定稿）

事件形状：`{ triggerSeq, triggerType: 'click'|'dblclick'|'enter'|'contextmenu'|'load', settled: bool, baseline?: 'missing', containers: [{sig, role, rect, text, repeat, items: [{tag, text, cls, rect}]}] }`。逐条消费规则：

1. **最强规则（"等你要点的那个"）**：triggerSeq=S 的 uiAppear，若 items 含 ≥2 字非空文本，优先取与 S 之后**下一次 click 目标文本匹配**的项，在该 click 前插 `wait text`；无匹配项则取首项插 `wait text`。
2. **无文本容器**（items 均无有效文本）：在触发点击与下一事件之间插 `wait ms`，ms = clamp(触发点击→下一事件的观测间隔, 500, 3000)。
3. **容器与 items 进 desc 不进 cond**（人类可读的现场注记；cond 只用 wait text/ms 表达）。
4. **triggerType:'load'**（iframe 首采样）：下一个作用于该 frame 的事件前插 `wait ms`（观测间隔 clamp 同上）。
5. **repeat:true**（seenEver 命中 = 该容器曾出现过）：desc 注记 toggle 语义（再次点击可能是收起，wait 策略相应降权）。
6. **两采样点空集**（有 click/dblclick/enter 触发但无 uiAppear 跟随）：记坑清单候选（点击未产生 UI 变迁——无效点击/吞事件/纯业务态变化）。
7. **跨域 iframe 盲区已知限制**：跨域 iframe 采样不到（注入走 CDP 会话仅同进程 frame；OOPIF 不占 target），该区域的状态变迁无 uiAppear 覆盖——蒸馏时如实标注未覆盖。

质量清单追加项：

- [ ] **uiAppear 消费完备**：每个 uiAppear 均被某步骤消费（wait / desc 注记）或标注丢弃原因（如 repeat toggle 降权、容器无意义）。

## 键盘/剪贴板/分层扩展事件消费（ora-20260917 题1：录放闭环 + 取证完备）

事件类型枚举扩展（chromeuse-events/1 不 bump，全部可选字段、旧流零感知）：

1. **keydown 扩展**：字段 `key` + 修饰位面平铺布尔 `ctrl/alt/meta/shift` + 物理键码 `code`。录制白名单 = 组合键全录（ctrl/alt/meta 任一；Shift 单独不录——打印字符走 input）+ Enter/Tab + 非打印键（Escape/Arrow×4/PageUp/PageDown/Home/End/ContextMenu）；单字符/纯修饰键/Backspace/Delete 不录（input/change 值语义覆盖）。蒸馏映射：组合键 → flow `key` 步骤 `'Control+s'` 语法（回放侧 parseKeyModifiers 已就绪，主键小写即可）；非打印键 → `'Escape'`/`'ArrowDown'` 等字面量直用（回放侧 KEY_CODES 全就绪——录放闭环）。
2. **paste/copy/cut**：字段 `text`（脱敏后内容，截 200）+ `len`（原始全长——"粘了多少"独立取证信号）+ `policy`（脱敏档位元字段 text/masked/meta——非 text 档下 text 不可作内容依据）+ paste 另带 `files`（类型名 only）。蒸馏映射：paste → `type` 步骤 + desc 注记「粘贴」（长文本/Excel 多行回放建议 insertText 原语，逐键 type 不现实）；copy/cut → desc 取证注记（flow 无 copy 原语，不硬造）；password 目标恒 `***`。
3. **full 档事件（opt-in，录制 `--full-input`）**：wheel/focusin/focusout/auxclick/F1-F12——取证原料，默认不映射 flow（同鼠标序列"原料不消费"先例）；落盘头 `session.inputProfile`/`session.clipboardPolicy` 在非默认档时标注采集档位，蒸馏如实注记。

## 分批纪律

- 事件流 >100KB（约 >800 事件）必须分段蒸馏：按 **(tab, navigate)** 二元组切段（V202609080013 全标签页录制后，navigate 必须先按 `tab` 归组再各自切段），每段独立产出 flow 片段，最后人工拼接。
- **多 tab 语义（V202609080013）**：事件双标 `tab`（tab-N 别名，按 attach 顺序分配；**关了重开 = 新别名**，正确语义）+ `targetId`（跨导航稳定标识，去重/归属用）；**每个 tab 独立成 flow**（flow-engine 回放单 tab，**不加 tab 原语——明确不改**）；跨 tab 演示在 flow 里用 `goto`+desc 表达（回放端等价于导航到目标 tab 的 URL，不做 tab 切换语义）。
- 单次会话蒸馏输入控制在上下文预算内：先用 events-summary 的类型/帧分布定位关键段，不整文件硬读。
- 蒸馏产出同样遵守文档守门（SKILL ≤320 / playbook ≤400 / webapp.md ≤150）——超预算时优先精简而不是扩张。

## scroll 副作用甄别与容器注意力（2026-09-18 用户裁定，红线级）

- **scroll 副作用甄别**：点击域类元素（分组/标签/树节点）后短窗口内同容器的 scroll 事件=系统自动滚动的副作用（程序化滚动同样触发 scroll 事件），**不蒸馏为 scroll 步骤**——人类手动滚动必有额外输入操作（滚轮/按住拖滚动条/方向键/点击滚动条），无输入前驱的 scroll 一律按副作用折叠。实证：应用面板点「物料域」后面板自动滚动到该域 APP 区（diag-Q 误判案例——误蒸馏手动 scroll 步骤埋多域滚动语义判定深坑）。
- **弹出容器注意力规则**：点击触发弹窗/面板/下拉/lookup 后，用户注意力集中到该容器——**后续操作优先 container 收窄到该容器内定位**（容器内无候选报错不回退全局，天然防桌面同名歧义与多实例）；实证：应用面板点物料域后的销售管理点击应 container 收窄到面板容器（桌面同名图标需双击且同域多实例）。
