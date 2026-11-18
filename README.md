# chromeuse — Agent 确定性浏览器执行内核

> **chromeuse 是面向内网/私有重 Web 应用的 Agent 确定性浏览器执行内核——上层任意 Agent 负责 planning/reasoning，chromeuse 以 CDP/DOM/采集多通道负责确定性执行、完整取证与操作手册沉淀，使 flash 级模型+手册 ≈ 旗舰模型裸操浏览器。**
> （定位章程 2026-09-12 用户拍板；完整依据见 `reports/项目战略规划评审报告-20260912.md` 与 `reports/定位终审补充报告-GPT对抗辩论与执行内核命题-20260912.md`）

## 定位与路线

**三面资产结构**：

- **执行面**：`tools/cdp.js` raw CDP 工具层 + flow 引擎——确定性执行（CDP Input 域真实事件回放）+ 多通道采集（截图/网络域/事件流/uiAppear 状态变迁）。
- **认知面**：通用操作手册（SKILL.md + references/，跨应用可迁移）+ `webapps/` 私域应用手册（垂直知识：识别特征 + 专属操作手法 + 入库 flow）。
- **证据面**：取证报告（reports/）+ 验收回放包（事件流+视频流+关键帧+README 对齐成包）+ 失败取证链——**失败时也拿得出完整证据链**，这是比"回放成功"更抗模型进化的核心价值（taihe-extension.jar 事件实证）。

**经济路线（三档降级）**：旗舰模型解释执行（长尾/新应用冷启动，按 token 计费最高）→ 人类演示/AI 蒸馏编译为 flow（付一次）→ 已固化流程 0AI 缓存命中盲操（近乎免费）。手册的经济作用 = 把"解释执行"任务持续降档为"编译/缓存"。

**项目路线**：

| 阶段 | 定位 | 状态 |
|------|------|------|
| **1.0 内核** | 通用操作手册 + 操作工具 + 私域应用手册 + 证据资产；限定域 = 内网/私有重 Web 应用 | **进行中（当前）** |
| **2.0 接口契约产品化** | 把已有能力固化为**接口契约**，让上层 AI 稳定调用——开发链路闭环（AI 写码→部署→chromeuse 验证→取证→回修）中的内核契约产品化；产品定义预裁 AI 全栈 Debugger | 触发器改活：原条件 ∨ 用户兴趣自发回升（2-3 周时间盒兜底）；见 TODO-chromeuse2.0.md |
| **3.0 愿景档案** | OS 级愿景（个人粒度不可达） | 档案柜留档 |

**分层斩杀窗口**（分层窗口取代单一窗口；内网层有"结构复杂度 + 内网不可达"双重防护，是 chromeuse 的主场防区）：

| 层 | 商品化窗口 | 说明 |
|----|-----------|------|
| 简单开放 web | 12-24 月（已在进行） | Agent Mode 平台内置 + 价格锚下探；1.0 刻意降权此层 |
| 有源码自有 webapp | 24-48 月 | record/replay/recovery/audit 被统一平台吸收的中间层 |
| 内网无源码重 ERP | **36-60+ 月** | **chromeuse 主场**：托管 CUA 物理盲区 + 结构复杂度双重防护 |

载体形态：一个面向 AI agent（opencode / openclaw）的浏览器自动化 skill。它把个人开发者在使用 chrome-devtools MCP / raw CDP 驱动真实浏览器时踩过的坑沉淀为：一套分通道的操作方法论、一个零依赖的 raw CDP 工具层、一条"人类演示 → 事件录制 → 蒸馏 → flow 回放"的自动化管线，以及可版本化维护的 web 应用专属经验库。

## 功能特性

- **操作手册（SKILL.md + references/）**：**cdp 主通道、MCP fallback** 的使用说明主干——维护约定与文件地图、按场景分组的命令速查、通用操作循环、CDP 通道分级速查（renderer 冻结时哪些通道还活着）、红线与恢复纪律、重型 SPA / 元素可见点不中 / 营销弹窗三大专题决策树、排障入口路由、安装配置排障。
- **raw CDP 工具层（tools/cdp.js，49 子命令；`commands.meta.json` 单源生成 SUB_HELP 与 SKILL §1.2）**：覆盖诊断入口 / 交互 / 页面生命周期 / 感知 / 视口与设备模拟 / 捕获 / 自动化 / 录制 / 取证后处理 / 识别与预处理 / 逃生舱与运维；**49 命令按场景分组 → SKILL.md §1.2，完整旗标 → `node tools/cdp.js <cmd> --help`**。每命令独立超时、一次性短连接，与 MCP 长驻会话互不干扰。**2026-11 能力补强批新增**：统一 `--json` 信封（chromeuse-cli/1+20 错误码）/交互后生效判据 `--expect-*`（四态 phase）/引用句柄 `@eN`/快照分级 `--find/--diff/--frames`/结构化抽取 `extract`/批量断言 `assert`/结构化审计 `audit`/产物配额 `artifacts`/长任务作业 `--async`+`job`/输出脱敏 redact——契约详情 → `references/mechanisms.md` §1~§16。
- **flow 引擎（chromeuse-flow/1）**：18 原语（计数真源=`lib/flow-engine.js` ACTIONS.length：goto/wait/probe/emulate/click/rightClick/drag/type/key/select/scroll/assert/screenshot/frame + V2 表达力 eval/set/cond/loop）+ `{{var}}` 插值（运行期可变：set/eval）+ 四层定位回退（text→role→near→grid→domPath→point）+ **纯 CDP Input 域真实事件回放**（`isTrusted=true`，业务写操作不碰 `Runtime.evaluate` 合成事件）；失败产出结构化报告（定位尝试、候选清单、终态截图、URL 轨迹）支撑 self-heal。
- **人类演示录制 → 蒸馏 → 回放**：全标签页多 target 录制（自动附挂、tab 别名、独立错误隔离），页面侧采集八类事件（含 **uiAppear 状态变迁捕获**——点击后弹出了什么、菜单项清单、稳定时长），经蒸馏协议（人机确认）固化为 flow 与 web 应用知识。
- **应用识别（matchers）**：`host[:port][/pathPrefix]` 分段锚定 + 约束度打分，多套部署 = 同一 slug 多条 urlPatterns；用户断言两级（会话绑定 / 记忆化）；flow 回放带应用安全阀，防错应用执行。
- **弹窗防护（popup-guard，V202610150003）**：回放期广告/推广弹窗拦截（李跳跳式 DOM 层 MutationObserver 守卫）——`flow replay --popup-guard` 在首步前预埋守卫（命中规则 `remove`/`hide`，**不做合成点击**；默认关），规则库双层（`webapps/<app>/popup-rules.jsonc` 有配置=整体为准 / 无=全局 `config/popup-rules.jsonc` 宽松基线）、`scope` 复用 matchers 分段锚定；上线前用 `cdp.js popup-guard test --target <页>` dry-run 检验误杀（只记录不动作）、`scan` 只读取证候选弹窗；拦截留痕 `window.__cu_pg_log` 归并进回放摘要（成功/失败路径都输出），finally 配对还原共享浏览器现场（移除脚本注册 + 页侧 observer.disconnect）。
- **元素捕获（locator，V202610190001）**：`cdp.js locator probe|suggest|verify|pick` 把「候选歧义反复试错」做成确定性工具——**probe** 跨同源 iframe 列候选（framePath/tag/rect/visible/offsetParentOk/hitOk/area/cssPath + 唯一性结论）；**suggest** 递归收窄（多候选→共同祖先链逐级构造 `container:{text|domPath}` 重算，唯一即止；跨 frame/无共同祖先如实报）；**verify** 解析 best→高亮（Overlay+CSS outline）→截图 `tmpdata/events/locator-<stamp>.png` 供读图确认；**pick** 注入一次性点击拾取器（DevTools select element 式，拾取即自摘）→ 三层描述符+唯一性复算+建议 target JSON。语义对齐 target-resolver 的 X1 闸门/container 文法（只读为主，pick 注入监听是唯一写）。
- **openclaw 执行端适配**：无 omo-slim 编排的单模型 agent 同样可用——CLI 直调模板、白名单 flow 纪律、审计要求、远程执行安全边界。
- **统一日志（lib/log.js）**：全部脚本共用一个日志出口，`log/chromeuse.log` 按日自动轮转归档（`chromeuse.<yyyyMMddTHHmmss>.log`），日志失败不影响主流程。

## 技术架构

- **语言与依赖**：Node.js ≥ 22（内置 WebSocket / fetch），**零第三方依赖**，无需 `npm install`。
- **平台**：Linux（NAS Docker 容器）与 Windows 桌面端两套环境，差异只在连接层配置（`config.jsonc` 机器实例），操作方法完全同构。
- **agent 适配**：opencode（skill 注入 + cdp 命令主通道 + MCP fallback）与 openclaw（CLI 直调）双端同一套 tools/。
- **连接方式**：直连 Chromium CDP（`--remote-debugging-port`）；chrome-devtools MCP / Playwright MCP 可用的场景均适用，本 skill 是它们的操作方法论 + 超时/冻结时的逃生舱。

```text
agent（opencode/openclaw）
  ├─ cdp 命令（主通道）→ tools/cdp.js + lib/（交互 / 感知 / flow 回放 / 录制 / 看门狗）
  └─ MCP（fallback/强项）→ chrome-devtools MCP（陌生控件 / 网络面板 / console 缓冲）

两者均经 CDP（:9222/:9224）→ Chromium（真实浏览器实例）
```

**核心原则**：感知/交互/验证分层兜底——截图走合成器线程、网络域走浏览器进程侧，renderer 主线程冻结时取证通道依然可用；业务写操作一律 Input 域真实事件；失败先取证再动手，看门狗只检测建议、绝不自动杀进程。

## 快速开始

环境要求：Node.js ≥ 22；一个开了远程调试端口的 Chromium（本机或容器内网）。

```bash
# 1) 安装（源目录 = 本仓库 opencode/root/.config/opencode/skills/chromeuse/）
node install.js                 # copy 安装（Windows 桌面端推荐）
node install.js --link          # 链接安装（NAS / 开发者推荐：源改即生效）
node install.js --init-config auto   # 2) 实例化本机配置 config.jsonc（linux|windows|auto）
node selftest.js                # 3) 结构自检（90+ 组断言，应 ALL PASS；实现拆分于 selftest/ 目录，此为习惯入口）

# 4) 冒烟：探测浏览器（默认 browserUrl 读 config.jsonc，可 --url 覆盖）
node tools/cdp.js probe
node tools/cdp.js targets

# 5) cdp 主通道冒烟：感知（只读）→ 截图 → 交互（真实 Input 域）
node tools/cdp.js a11y --depth 3
node tools/cdp.js screenshot
node tools/cdp.js click --text "提交订单" --nth 1   # 示例：多候选必须显式 --nth
```

- 配置为"四层真源"模型：模板（git 共享推荐值）→ 实例（`config.jsonc`，机器本地，改值即用）→ 展示层（selftest 机检一致）→ 运行层（agent 的 MCP 配置，本安装器永不触碰）。
- opencode 侧将 skill 安装到 `~/.config/opencode/skills/chromeuse` 并新开会话即自动注入；openclaw 侧直接按 `references/openclaw.md` 的 CLI 模板执行。日常操作优先 `node tools/cdp.js ...`（命令面见 SKILL.md §1.2），MCP 仅作 fallback 与强项互补。
- 录制一个流程试试：`node tools/cdp.js record --duration 300000` → 人工操作浏览器 → `record-stop` → 按 `references/distill.md` 蒸馏成 flow → `node tools/cdp.js flow replay <file>`。

## 目录结构

```text
chromeuse/
├── SKILL.md                  # skill 主入口：维护约定 / 文件地图 / 命令速查 / 操作循环 / 通道分级 / 红线 / 专题决策树
├── references/               # 深度文档：install（安装配置）/ playbook（操作守则）/ facts（技术事实）/ distill（蒸馏协议）/ openclaw（执行端手册）
├── tools/
│   ├── cdp.js                # raw CDP 工具层 CLI（49 子命令；命令面见 SKILL.md §1.2）
│   └── recorder.js           # 页面侧注入录制资产（纯前端 IIFE）
├── lib/                      # 引擎与编排（零依赖 CJS）
│   ├── cdp-core.js           #   WebSocket 客户端 + 每命令独立超时
│   ├── flow-engine.js        #   chromeuse-flow/1 校验 + Input 域回放执行器
│   ├── target-resolver.js    #   四层定位链 + 条件文法（纯函数可单测）
│   ├── drive.js / page.js    #   Input 域交互 / 页面生命周期命令实现
│   ├── perceive.js           #   a11y / css 感知命令（只读）
│   ├── scroll-shot.js / cast.js  # 长图分段拼接 / 一次性录屏
│   ├── record.js / collector.js / events.js   # 录制编排 / 收数服务 / 确定性预处理
│   ├── matchers.js           #   应用识别（分段锚定 + 约束度打分）
│   ├── popup-guard.js        #   弹窗拦截规则层（guard 脚本生成器 + 双层规则库 + 留痕归并）
│   ├── locator.js            #   元素捕获/验证/拾取（跨 iframe 候选收集 + 递归收窄 + 高亮截图 + 点击拾取）
│   ├── log.js                #   统一日志（按日轮转）
│   └── paths.js / lock.js / config.js / jsonc.js
├── snippets/                # 编排侧片段（粘贴到 Code Mode 用）：tab-helper v3 页签助手（openTab=快照差集+锁页 CAS 互斥+新页 id 解析 / findTabs / assertTab）、eval-helper v1.0（unwrapEval 包装文本解析 / waitUntil 条件轮询 / findClickable 空恒[]）
├── webapps/<app>/            # web 应用专属经验：webapp.md（识别特征+操作手法）/ flows/（入库 flow）/ TODO.md / selftest.js（webapp 专属断言，selftest 自动发现）/ popup-rules.jsonc（弹窗拦截规则，可选）
├── config/popup-rules.jsonc  # popup-guard 全局规则库（宽松基线；webapp 无自己的 popup-rules.jsonc 时生效）
├── config-template-*.jsonc   # 配置模板（linux / windows）
├── install.js                 # 安装器
├── selftest.js / selftest/    # 结构自检：selftest.js 为入口 wrapper；main.js（通用组 + webapp 专属断言自动发现）+ common.js（共享断言框架）；webapp 专属断言在各 webapps/<app>/selftest.js
├── TODO.md / CHANGELOG.md / VERSION.md   # 待办与进度台账（唯一活台账，完成即删）/ 批次史 / 版本真源
└── log/ tmpdata/             # 运行态目录（gitignored）
```

> 目录树仅列关键文件，全集以 `git ls-files` 为准。

**webapp 专属断言约定**：webapp 专属的 selftest 断言统一写进该 webapp 自己目录的 `webapps/<app>/selftest.js`（自包含、不污染 selftest/ 主目录）——导出无参函数（helper 从 `../../selftest/common` 解构），`selftest/main.js` 自动发现 webapps/ 各子目录的 selftest.js 并在 #18 flow 校验组尾部统一调用，新建即纳入、无需改 main；断言编号沿用所属组号（CHANGELOG/报告稳定参照，不许重排）；某 webapp 失效删改其 selftest.js 即可，通用断言不受影响。写法参照 `webapps/erp_demo_test/selftest.js`。

## 已解决问题摘录

chromeuse 的每个能力都来自真实踩坑，勘误史完整保留在 CHANGELOG 与 git 历史中：

- **重型 SPA 全线 `-32001` 超时**：根因是 opencode MCP 客户端默认超时仅 5000ms（源码证实），叠加 renderer 主线程被长任务占死。解法 = 按条目调大超时 + **CDP 通道分级取证**（截图/网络域不经主线程）+ 冻结看门狗，替代"换工具"的死路。
- **"DPR 幽灵菜单"误诊勘误**：曾被归因于 DPR≠1 布局断裂，后经用户实证推翻——原生 DPR 1.5 下人工全可点，0×0 rect 实为菜单关闭态的正常测量。修正后归因 = **文本匹配歧义 + 主线程冻结**，并撤销一切默认 DPR emulate。这条勘误史本身是 skill 方法论的一部分：结论要过对照实验再固化。
- **文本匹配歧义治理**：同文名多义（侧栏/Tab/列表行）、SVG tspan 子片误命中 → tspan 子片消歧降权 + grid 表头上下文定位器（有序子集匹配）。
- **录制数据丢失系列**：HTTPS 页面 sendBeacon 被混合内容策略静默拦截 → `Runtime.addBinding` 会话级注册 + bindingCalled 回程直喂管道，sendBeacon 降级为 http 页面通道，双通道去重幂等；seq 跨整页导航撞键 → 文档代际 docId 四元去重键；isolated world 二次注入致事件成对重复 → 只认主世界 context；关 tab 漏听 browser 级 `Target.targetDestroyed` → 补听并收敛幂等清理。
- **"假绿"治理**：停止路径落盘排在一系列 await 之后，任一挂起 = 事件全丢 → 落盘提前为第一步（同步写）+ 每 15s 采样计数可见性（事件数/按 tab/beacon 批次）。
- **可见性误判**：祖先 `display:none` 下元素 rect 被过渡动画保留非零 → visRect 祖先链检查（offsetParent O(1) 快捷）+ 近零尺寸候选降权，0×0/1×N 动画中间态不再被面积升序选中。
- **uiAppear 状态变迁捕获**：点击触发弹层后"弹出了什么"此前是盲区 → lastStable 基线 + 双时刻采样（700/1800ms）+ 容器门与配额纪律，蒸馏出"点击→菜单项清单→等待时长"的状态知识。
- **pageId 全局序号不可记忆（2026-10-14 护腰复盘批）**：共享浏览器下 pageId 是全浏览器全局递增序号（用户开/关页任意消耗、跳号实证）——"记忆的 id"必漂移，多会话并发 new_page 还有交叉窗口 → tab-helper v3：**锁页 window 变量 CAS 互斥**（页面 JS 单线程=检查+写入原子，实测双并发恰一个赢家）+ 前置快照差集（多候选证据链、不唯一不猜）+ findTabs 现查 + assertTab 校验；SKILL「开页与多标签（首选路径）」立规范。
- **evaluate 包装文本零解析致 TypeError（同批）**：`evaluate_script` 返回的是 fence 包装的「JSON 字符串的 JSON」，裸 String 操作取下标恒 truthy、空值防御整体失效（单会话 4 次同根因）→ eval-helper v1.0（unwrapEval 双重 parse / waitUntil 轮询替代盲等 / findClickable 空恒 items:[]）+ 机检 #76。
- **电商搜索 flow 边界（2026-10-15）**：京东首页改版（React 搜索栏，经典 input#key 废弃）新锚固化；**淘宝搜索=新 tab 打开结果页**（按钮/Enter 皆然）——flow 引擎单 tab 模型下原 tab 无收单信号，收单=编排层 targets/findTabs 查新页签（webapp.md 已记操作面）；jd 9/9+视觉验证、taobao 7/7+编排层收单双实弹。

## 项目目的

chromeuse 是个人开发者在自动化操作浏览器过程中踩坑与解法的沉淀，开源到 GitHub 是为了分享交流，也期待社区给出更好的思路——无论是定位策略、录制蒸馏协议，还是 agent 驱动浏览器的工程化范式。

## 许可证

[MIT](https://opensource.org/licenses/MIT)。可以自由使用、修改与分发；issue 随缘回复（个人开发者，时间有限，见谅）。
