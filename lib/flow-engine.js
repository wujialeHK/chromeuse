'use strict';
/*
 * chromeuse lib/flow-engine.js —— flow schema 校验 + {{var}} 插值 + 四层定位回退 + 回放执行器
 * 规格 = reports/report_20260908_008_chromeuse-最优架构-v3.md 附录 A1（flow schema）/ A3（失败报告）。
 * 红线一合规：定位/断言只走只读 Runtime.evaluate（跨同源 iframe 递归，绝对坐标 = 各层 iframe rect 累加）；
 * 点击/输入/滚轮一律 CDP Input 域真实事件（dispatchMouseEvent/dispatchKeyEvent/insertText），严禁 evaluate 合成业务事件。
 * 每步独立超时；失败即停产出结构化失败报告（self-heal retry≤1 由协议层负责）；
 * TARGET_NOT_FOUND 类失败附 diagnosis 失败分诊（V202609110001：锚点回探/readyState 轻探针/拒因聚合——纯 advisory）。
 * P0 wait 同链（2026-09-18 失败根治引擎批一，五方合议 unanimous）：wait text+container 走 buildLocateExpr 全链路
 *   （四层定位+X1 闸门+候选排序+X4 命中复核——wait 与 click 同链同目标）；无 container 保持 TEXT_EXISTS_V2
 *   简化路径（存量 flow 零破坏——语法糖升级而非替换）。M4 过闸耗时审计：条件类 wait <100ms 过闸记假绿嫌疑
 *   （[audit] fast-pass，纯 advisory——oracle §6.2/纪律⑧）。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const log = require('./log');
const time = require('./time');
const challenge = require('./challenge'); // C4（#124）：goto 步后置 bot challenge 检查单源

const ACTIONS = ['goto', 'wait', 'probe', 'emulate', 'click', 'rightClick', 'drag', 'type', 'key', 'select', 'scroll', 'assert', 'screenshot', 'frame',
  // C5' flow 表达力 V2（#127，V20261113008）：只读求值 / 变量赋值 / 条件跳步 / 受控循环——
  // 四原语均为**可选增量**：存量 flow 不写新字段/新 action 时执行模型逐字节不变。
  'eval', 'set', 'cond', 'loop'];
const DEFAULT_TIMEOUT = { goto: 15000, wait: 15000 };
/** C5' V2 常量（#127）：循环硬上限与 eval 预算——防「flow 变通用脚本语言」（L159 诚实边界：
 *  保 lint/证据链/确定性）。全 flow 重复执行次数（loop 重复 + cond 后退跳步）共享同一预算；
 *  loop.times/over 长度单循环 ≤50；eval 表达式默认 3s、上限 10s（对齐 effect.timeoutMs 先例）。 */
const MAX_LOOP_ITERATIONS = 50;
const MAX_LOOP_BODY = 200;          // loop.count 单次体长上限（结构护栏，非业务语义）
const EVAL_TIMEOUT_DEFAULT_MS = 3000;
const EVAL_TIMEOUT_MAX_MS = 10000;
const VAR_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** type 重试退避+预算裁剪（V202609290001，2026-09-29 实弹）：
 *  inventory-lock 每次重试 centerClick 重击 ≈5s×3 吃满步预算（STEP_TIMEOUT 16005ms）。退避 =
 *  attempt# × 2500ms 封顶 10s；退避前核对剩余步预算 ≥ 退避 + TYPE_RETRY_RESERVE_MS（一次重试的
 *  最低开销预留：insertText + 写后读 probe 的 3000ms CDP 超时 + 定位/点击余量），不足则 break 直接出
 *  TYPE_VERIFY_FAILED——不许睡穿步超时。（同期 diag-liliao 的 len:0 后确诊为写后读探针帧盲假阴性，
 *  见 buildInsertVerifyExpr / V202609290002——本退避仍对真失败重试有效。） */
const TYPE_RETRY_BACKOFF_MS = 2500;
const TYPE_RETRY_BACKOFF_CAP_MS = 10000;
const TYPE_RETRY_RESERVE_MS = 3500;
/** click 步有界重试退避+预算裁剪（V202609300002）：click 步级可选 retry（默认 1=不重试，存量零改动）；
 *  下拉族配 2-3——首击被瞬态吸收（刚清场的覆盖层/接线滞后）时重发。退避 = attempt# × 600ms 封顶 3s
 *  （小步距——click 重试成本低：重定位+重 dispatch，无需 type 的 2.5s 大步距）；预算裁剪同 type 范式：
 *  剩余步预算 < 退避 + CLICK_RETRY_RESERVE_MS（一次重试的最低开销预留：定位+X4 复核+dispatch）则放弃
 *  重试直接抛最后一次错误，不许睡穿步超时。纪律：重试与效果闸门配对（flow 层 menu-open gate 负责效果
 *  判定）——引擎不盲目加时。 */
const CLICK_RETRY_BACKOFF_MS = 600;
const CLICK_RETRY_BACKOFF_CAP_MS = 3000;
const CLICK_RETRY_RESERVE_MS = 2500;
/** move→press 悬停安定间隙（V202609300004，最小修复）：mouseClick 的 mouseMoved 与 mousePressed 之间
 *  零间隙（80ms hold 只在 press↔release）——winui 同族组件依赖 hover 先被处理（mouseover 事件/悬浮态）
 *  才认后续 mousedown。实弹对照：inventory-lock 现货锁定下拉三连败（r1/r2/r3 引擎点击静默无效→
 *  EFFECT_NOT_ACHIEVED）vs 同期手动裸 CDP 同参数点击（move→press ≥50ms 间隙）七连开全部成功；
 *  与 V202609090004 桌面图标族「零间隔连发无效」教训同构（当时只修 press↔release hold，漏了 move→press）。
 *  单击/dbl/rightClick 共用同一 moved 派发点——单点插入三路径同受益（rightClick button 参数化同函数）。 */
const MOUSE_MOVE_SETTLE_MS = 50;
/** P0-2 字段白名单（V202609130001）：每原语合法字段清单——validateFlow 对未知字段严格校验，不再静默忽略。
 *  背景（gpt-debate-r1 事故）：2500 字辩论稿误写进 click 步骤的 text 字段（click 不消费 text），
 *  旧校验静默放行 → 三轮 replay 全部发送 vars 默认值「请只回复：OK」（典型假绿链：生成期 ✓ 但内容错）。
 *  字段清单按各 case 校验/消费反推；click.focusAssert 为 P0-3 opt-in 焦点断言字段。 */
const ACTION_FIELDS = {
  goto: ['action', 'url', 'desc', 'timeoutMs'],
  // wait.container（2026-09-18 引擎批一 P0 wait 同链）：可选收窄修饰，仅与 text 同用——有 container 走
  // buildLocateExpr 全链路（四层定位+X1 闸门+候选排序+X4 命中复核），无 container 走 TEXT_EXISTS_V2 兼容路径
  wait: ['action', 'ms', 'text', 'urlContains', 'cond', 'container', 'desc', 'timeoutMs'],
  probe: ['action', 'desc', 'timeoutMs'],
  emulate: ['action', 'dpr', 'desc', 'timeoutMs'],
  click: ['action', 'target', 'dbl', 'focusAssert', 'retry', 'gate', 'effect', 'unique', 'desc', 'timeoutMs'], // gate=原语一目标本体闸门（V202609300016，oracle 报告 §3.3——opt-in：dispatch 前循环定位同 target 至 ok 或超时）；unique=#126 步骤级 uniqueDefault 覆盖（false=本步不闸门）
  // rightClick（V202609130002）字段集 = click 裁剪：只留实际消费的 target——
  // 无 dbl（双右键非标准手势，contextmenu 恒单击触发）、无 focusAssert（右键不迁移焦点，断言必假红）
  rightClick: ['action', 'target', 'unique', 'desc', 'timeoutMs'],
  // drag（V202609170002）字段集：target=拖源描述符 + to=放置目标（{x,y} 绝对坐标 或 {target:第二描述符} 二选一，严格互斥）——
  // 无 dbl/focusAssert（拖拽非点击手势）；withKind 不注入（拖源类型语义多样，v1 观察）
  drag: ['action', 'target', 'to', 'unique', 'desc', 'timeoutMs'],
  type: ['action', 'text', 'target', 'unique', 'desc', 'timeoutMs'],
  key: ['action', 'key', 'desc', 'timeoutMs'],
  select: ['action', 'target', 'value', 'unique', 'desc', 'timeoutMs'],
  scroll: ['action', 'dx', 'dy', 'target', 'unique', 'desc', 'timeoutMs'],
  assert: ['action', 'text', 'target', 'cond', 'desc', 'timeoutMs'],
  screenshot: ['action', 'name', 'desc', 'timeoutMs'],
  frame: ['action', 'path', 'desc', 'timeoutMs'],
  // #127 V2：eval=只读 JS 表达式求值（expr；var=结果落变量）；set=变量赋值（var+value，
  // value 支持 {{var}} 插值）；cond=条件跳步（when 三形态 + jump{to|skip}）；loop=受控循环
  // （重复后续 count 步 times 次或遍历 over 数组）。label 为全原语通用可选字段（跳转目标）。
  eval: ['action', 'expr', 'var', 'desc', 'timeoutMs'],
  set: ['action', 'var', 'value', 'desc', 'timeoutMs'],
  cond: ['action', 'when', 'jump', 'desc', 'timeoutMs'],
  loop: ['action', 'times', 'over', 'count', 'itemVar', 'indexVar', 'desc', 'timeoutMs'],
};
const KEY_CODES = {
  Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Esc: [27, 'Escape'],
  Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
  ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
const MODIFIERS = { Control: [17, 'Control'], Ctrl: [17, 'Control'], Shift: [16, 'Shift'], Alt: [18, 'Alt'], Meta: [91, 'Meta'], Command: [91, 'Meta'] };

/** CDP Input.dispatchKeyEvent modifiers 位掩码（CDP 规范：Alt=1/Ctrl=2/Meta=4/Shift=8） */
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** drag 原语轨迹参数（V202609170002；起点=实验报告 tmpdata/drag-live/实验报告.md §5.6 G3 实证参数）：
 *  SEGMENTS=按住段插值段数（G3 用 5 段；G3c 证单段长位移也过——多段仅为轨迹取证密度，非因子）、
 *  MOVE_GAP_MS=段间节距（G3 用 90ms；G3a 证零延迟连发也过——节奏非因子，取值只为贴近真实手感）、
 *  HOLD_MS=press 后按住起手间隔（rightClick 80ms 惯例同源）、
 *  PROBE_AT=elementFromPoint 拖动期取证探针所在段号（1-2 次，轨迹中点诊断 dragPathProbe——最小实现）。
 *  硬约束只有一条（G3b 反证）：按住段每条 mouseMoved 必须 button:'left'+buttons:1。 */
const DRAG_TRACE = require('./drive').DRAG_TRACE; // 单源：CLI drag 与 flow drag 共用同一已实证轨迹参数（G3；planDragPath 同源）

/* ── M4 过闸耗时审计（2026-09-18 失败根治引擎批一，oracle §6.2 M4 / 合议纪律⑧）──
 * 条件类 wait（text/urlContains/cond——闸门语义）<100ms 过闸 = 假绿嫌疑：「文本早已存在于错误目标上」
 * 四个实锤（38ms/25ms/18ms/13ms）的共同签名。盲等（ms 型）不参与——耗时≈声明常数，无审计信息量。
 * 纯函数 Node 侧可直接单测（selftest #59）；返回嫌疑标记串或 null。纯 advisory 不改判成功：
 * 合法快速渲染 8~23ms 实测存在（oracle 复核口径），嫌疑标记只驱动人工复核（清单见 selftest #60）。 */
const M4_FAST_PASS_MS = 100; // 过闸耗时嫌疑阈值（<100ms 记假绿嫌疑）
function m4FastPass(step, ms) {
  // V202609180003 扩展到 assert：效果断言（text/cond）<100ms 通过 = 可能命中旧状态残留文本——
  // 实弹 b2f1b 步骤 35 以 5ms「过」实为假绿（命中尚未拆除的提取表单自身行文本，同步骤另跑 4ms 真红——无判别力）。
  // 盲等与 target 形断言不参与（元素在场类检查快速通过合理）。
  if (!step || (step.action !== 'wait' && step.action !== 'assert')) return null;
  if (!Number.isFinite(ms) || ms >= M4_FAST_PASS_MS) return null;
  if (step.text === undefined && step.urlContains === undefined && step.cond === undefined) return null; // 盲等不参与——耗时≈声明常数无信息量
  return 'fast-pass';
}

/** click 有界重试退避/预算纯函数（V202609300002）：attempt 从 1 起、remainMs=剩余步预算（ms）。
 *  返回 { backoff, skip }——backoff=本次退避毫秒（600×attempt 封顶 3000）；skip=true=预算不足
 *  （remainMs < backoff+CLICK_RETRY_RESERVE_MS）须放弃重试直接失败（不睡穿步超时，type 同款纪律）。
 *  Node 侧可直接单测（selftest #67）。 */
function clickRetryBackoff(attempt, remainMs) {
  const a = Math.max(1, Number(attempt) || 1);
  const backoff = Math.min(CLICK_RETRY_BACKOFF_MS * a, CLICK_RETRY_BACKOFF_CAP_MS);
  const skip = !(Number.isFinite(remainMs) && remainMs >= backoff + CLICK_RETRY_RESERVE_MS);
  return { backoff, skip };
}

/* ── 契约批机检 lintContracts（V202609300017，oracle 失败数据报告 §六 Q5「三条铁律+机检」§6.2 M1/M2/M3；
 *  council 统一路线第 4 条「契约批：Action Contract 契约化，铁律①②③与审计⑧入 selftest」——Action Contract
 *  不另列条目，作为机检骨架落在铁律①②③的静态 lint 实现。纯函数：只读 flow JSON，零 CDP 依赖。）──
 *  M1 闸门-点击同描述符 lint（铁律①「点谁等谁」）：每个 click/rightClick 步——本步 gate 字段豁免
 *    （原语一 V202609300016 已引擎化=同描述符机制保证）；否则向前扫描闸门窗口：跳过 ms 盲等/probe/
 *    screenshot/scroll/emulate（三明治的 settle 步不切断闸门链），遇操作/导航步（goto/frame/key/click/
 *    rightClick/drag/type/select）切断。窗口内任一 wait 与点击目标同描述符即合规——同描述符判定：
 *    ①双方 domPath 锚定：domPath 字符串相等；②text 锚定：值+match 相等，且 container 深等或「闸门收窄」
 *    （闸门有 container 而点击无——闸门已锚定到同一本体的更窄实例；反向不合规：闸门宽点击窄=锚定对象
 *    可能不同）。desc 标「状态闸门」的 wait 豁免（铁律①：代理信号只做状态证明），但其文本不得与点击
 *    目标同名（同名=实为目标闸门却未对齐描述符，仍违例）。
 *  M2 歧义文本登记检查（铁律②「同名必唯一」）：opts.ambiguousTexts 清单（调用方从 webapp.md ambiguousTexts
 *    解析传入——引擎层保持应用无关）内的文本作为 target/cond.element 且无 container/unique → 违例；
 *    wait.text 不查（状态闸门是铁律①的合法代理信号形态）。
 *  M3 盲等证据 lint（铁律③「动作必验效」·盲等永不充当效果证明）：wait ms 步 desc 缺证据引用
 *    （日期/diag 引用/V 版本号/用户裁定/实测/演示/录制/对照/取证/fallback 等）→ 违例。
 *  语义哲学：返回违例清单（advisory inventory）——不进 validateFlow（存量 flow 零误伤硬约束：validateFlow
 *  仍只管 schema）、不改判回放。selftest 消费口径：M2/M3 存量全量断言零违例；M1 存量违例=冻结基线棘轮
 *  （历史依赖 X1 命中测试/id 稳定性/人类节奏的已论证形态，新增违例即红）。审计⑧（M4）已引擎化另线：
 *  m4FastPass/M4_FAST_PASS_MS（V202609180003）+ selftest #59 + playbook 纪律⑧；M5 引擎侧：
 *  Runner.noteAmbiguityRisk（ambiguityRisk advisory → 失败报告）。 */
const LINT_BOUNDARY_ACTIONS = ['goto', 'frame', 'key', 'click', 'rightClick', 'drag', 'type', 'select'];
const LINT_EVID_RE = /(20\d{2}[-./]\d{1,2})|(\bdiag[-A-Za-z]?\d)|(\bV\d{6,})|(\b[FML]\d{1,2}\b)|用户裁定|实测|实证|演示|录制|参照|对照|取证|fallback|webapp\.md|playbook|报告|分析/;
/** #130 M7：表达式敏感关键词静态扫描（advisory；大小写不敏感，命中词本身随告警输出）。 */
const LINT_SECRET_RE = /\b(password|passwd|pwd|secret|token|cookie|authorization|api[_-]?key)\b/i;
function lintTextValue(t) { // target/wait 的 text → 纯文本值（兄弟键字符串或 {value,match} 对象形态）
  if (t === undefined || t === null) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && typeof t.value === 'string') return t.value;
  return null;
}
function lintTextMatch(t, host) { // match 归一（normTextDesc 同优先级：对象形态显式 > 兄弟键 > 缺省 contains）
  if (t && typeof t === 'object' && t.match !== undefined) return String(t.match);
  if (typeof t === 'string' && host && typeof host === 'object' && host.match !== undefined) return String(host.match);
  return 'contains';
}
function lintContracts(flow, opts) {
  const warns = [];
  if (!flow || !Array.isArray(flow.steps)) return warns;
  const amb = Array.isArray(opts && opts.ambiguousTexts) ? opts.ambiguousTexts : [];
  const steps = flow.steps;
  // #127 M6：label 表（cond 后退跳步识别用；标签唯一性由 validateFlow 守门）
  const labels = new Map();
  steps.forEach((s, i) => { if (s && typeof s === 'object' && typeof s.label === 'string') labels.set(s.label, i); });
  const identOf = (d) => { // 定位身份（比较用）：{ v:文本值, m:match, c:container 序列化, d:domPath }
    if (!d || typeof d !== 'object') return null;
    const v = lintTextValue(d.text);
    return { v, m: v !== null ? lintTextMatch(d.text, d) : null,
      c: d.container !== undefined ? JSON.stringify(d.container) : null,
      d: typeof d.domPath === 'string' ? d.domPath : null };
  };
  const sameIdent = (g, t) => { // 闸门身份 vs 点击身份：domPath 双方在场须相等；text 身份相等 + 闸门收窄视为已锚定
    if (!g || !t) return false;
    if (g.d !== null || t.d !== null) return g.d !== null && t.d !== null && g.d === t.d;
    if (g.v === null || t.v === null || g.v !== t.v || g.m !== t.m) return false;
    if (g.c === null) return t.c === null; // 闸门无收窄：点击也不得收窄（收窄后锚定实例可能不同）
    return t.c === null || g.c === t.c;    // 闸门收窄：点击无收窄（已锚定更窄实例）或同收窄
  };
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const desc = String(s.desc || '');
    /* M1（铁律①点谁等谁）：操作步前置闸门同描述符检查 */
    if (s.action === 'click' || s.action === 'rightClick') {
      if (s.gate === undefined) { // 本步 gate 字段=原语一豁免（引擎化同描述符保证）
        const tIdent = identOf(s.target);
        let ok = false, stateGate = null; // null=窗口内无状态闸门 / 'ok'=不同名豁免 / 'same-name'=同名红线
        for (let j = i - 1; j >= 0 && !ok; j--) {
          const p = steps[j];
          if (!p || typeof p !== 'object') continue;
          if (LINT_BOUNDARY_ACTIONS.includes(p.action)) {
            // 同身份点击链连续（如「选中→双击打开」同描述符两步）共享同一前置闸门——不作边界切断；
            // 异身份操作步/导航步照常切断（闸门链语义随操作边界失效）
            if ((p.action === 'click' || p.action === 'rightClick') && sameIdent(identOf(p.target), tIdent)) continue;
            break;
          }
          if (p.action !== 'wait') continue; // probe/screenshot/scroll/emulate/ms 盲等：不切断不匹配
          let gIdent = null;
          if (p.text !== undefined) gIdent = { v: lintTextValue(p.text), m: lintTextMatch(p.text, p), c: p.container !== undefined ? JSON.stringify(p.container) : null, d: null };
          else if (p.cond && p.cond.element) gIdent = identOf(p.cond.element);
          if (gIdent && sameIdent(gIdent, tIdent)) { ok = true; break; } // hidden/absent/url/count 等 cond 非身份闸门：跳过继续扫
          if (String(p.desc || '').includes('状态闸门')) {
            const gv = gIdent ? gIdent.v : null;
            const tv = tIdent ? (tIdent.d !== null ? tIdent.d : tIdent.v) : null;
            if (gv !== null && tv !== null && gv === tv) stateGate = 'same-name'; // 同名压过先见的不同名豁免
            else if (stateGate === null) stateGate = 'ok';
          }
        }
        if (!ok && stateGate !== 'ok') {
          warns.push({ rule: 'M1', step: i, msg: stateGate === 'same-name'
            ? '状态闸门文本与点击目标同名（铁律①：同名须同描述符目标闸门或本步 gate 字段——状态闸门只做状态证明）'
            : '点击无同描述符前置闸门（铁律①点谁等谁：本步 gate 字段，或前置窗口内 wait 同 text值+match+container（或 domPath；闸门收窄=已锚定本体）；desc 标「状态闸门」可豁免但不得与目标同名）' });
        }
      }
    }
    /* M2（铁律②同名必唯一）：歧义文本清单内文本作 target/cond.element 须 container/unique 收窄 */
    for (const d of [s.target, s.cond && s.cond.element]) {
      const v = lintTextValue(d && d.text);
      if (v !== null && amb.includes(v) && d.container === undefined && d.unique === undefined) {
        warns.push({ rule: 'M2', step: i, msg: `文本「${v}」∈ ambiguousTexts 清单但描述符无 container/unique（铁律②同名必唯一——container 硬收窄+exact 到唯一可见候选，禁止赌排序）` });
      }
    }
    /* M3（铁律③动作必验效）：盲等 desc 证据引用检查（时间盲等永不充当效果证明） */
    if (s.action === 'wait' && s.ms !== undefined && !LINT_EVID_RE.test(desc)) {
      warns.push({ rule: 'M3', step: i, msg: `盲等 ${s.ms}ms desc 缺证据引用（铁律③：盲等只出现在两闸门之间且 desc 必须带证据——日期/diag-/V 版本/用户裁定/实测等）` });
    }
    /* M7（#130 eval/cond 表达式敏感关键词静态扫描，advisory）：表达式可能包含凭据字面值/敏感变量名，
     * 回放报告虽已对 eval 返回值脱敏（§16），但表达式原文本身仍会落 flow JSON/日志——发现即提示人工复核。
     * 纯静态、不改判回放；关键词命中是 advisory 不是硬失败。 */
    if (s.action === 'eval' && typeof s.expr === 'string') {
      const hit = s.expr.match(LINT_SECRET_RE);
      if (hit) warns.push({ rule: 'M7', step: i, msg: `eval.expr 含敏感关键词「${hit[0]}」（#130：表达式原文会落 flow JSON/日志；凭据走 --var/占位符，勿写进表达式——回放报告仅对 eval 返回值脱敏）` });
    }
    if (s.action === 'cond' && s.when && typeof s.when.expr === 'string') {
      const hit = s.when.expr.match(LINT_SECRET_RE);
      if (hit) warns.push({ rule: 'M7', step: i, msg: `cond.when.expr 含敏感关键词「${hit[0]}」（#130：表达式原文会落 flow JSON/日志；凭据走 --var/占位符，勿写进表达式）` });
    }
    /* M6（#127 受控循环高迭代警告）：flow 保确定性/证据链，循环是受控原语不是通用脚本——
     * 高次数与后退跳步（循环式 cond）均 advisory 提示；硬上限由引擎 LOOP_LIMIT_EXCEEDED 兜底。 */
    if (s.action === 'loop' && Number.isInteger(s.times) && s.times > 10) {
      warns.push({ rule: 'M6', step: i, msg: `loop.times=${s.times} > 10（高迭代警告：全 flow 重复执行硬上限 50；长循环建议配效果断言/降次数——flow 非通用脚本语言）` });
    }
    if (s.action === 'cond' && s.jump && typeof s.jump.to === 'string') {
      const target = labels.get(s.jump.to);
      if (target !== undefined && target <= i) {
        warns.push({ rule: 'M6', step: i, msg: `cond 后退跳步 → label ${JSON.stringify(s.jump.to)}（steps[${target}]，循环式）：全 flow 重复执行硬上限 50——请确认退出条件与效果断言` });
      }
    }
  });
  return warns;
}

/** 纯函数：key 字符串修饰键前缀解析 → { mask, mods, name, valid }（'Control+A'→mask 2；单键 mask 0 行为零改动）。
 *  Node 侧可直接单测（selftest #33）；mods 保留书写顺序（先按后抬），未知 token 归入主键。 */
function parseKeyModifiers(keySpec) {
  const parts = String(keySpec).split('+').map((s) => s.trim()).filter(Boolean);
  const mods = [], baseKeys = [];
  for (const p of parts) (MODIFIERS[p] ? mods : baseKeys).push(p);
  let mask = 0;
  for (const md of mods) mask |= MODIFIER_BITS[MODIFIERS[md][1]];
  return { mask, mods, name: baseKeys[0] || null, valid: baseKeys.length === 1 };
}

/* ── schema 校验（附录 A1）── 定位/条件文法实现单源 = lib/target-resolver.js（V202609080011） ── */
const { buildLocateExpr, TEXT_EXISTS_SRC, TEXT_EXISTS_V2_SRC, buildVerifyExpr, validTarget, validContainer, validateCond, kindExpectations, waitLocateSpec } = require('./target-resolver');

/* ── kind 语义层注入（ora-5 设计步骤 1）：按 action 查 kindExpectations，复制 target 写 __kind（页侧零 action 知识）──
 * 抑制规则内聚此单点（显式压制隐式，单一控制方）：target.tag 或 target.role 已声明 → 不注入——作者已表达类型意图，
 * 双重惩罚扭曲确定性。_meta.kind===false（flow 级总开关，对齐 _meta.hitTest 先例）全 flow 不注入；
 * 不提供步骤级关闭（YAGNI：显式声明 tag 即天然豁免该步骤）。恒软不硬：无 strictKind。
 * 注入路径仅四条：click（dbl:true 同路径）/ rightClick / type 带 target / select；cond（element/absent/hidden）
 * 与 assert/wait/scroll/key/goto 不注入（无 action 语义）；drag 不注入（V202609170002：拖源类型语义多样，v1 观察）。
 * 返回浅拷贝——不改写 flow 原对象。 */
function withKind(target, action, meta) {
  if (!target || typeof target !== 'object') return target;
  if (meta && meta.kind === false) return target;
  if (target.tag !== undefined || target.role !== undefined) return target;
  const k = kindExpectations(action);
  if (!k) return target;
  return Object.assign({}, target, { __kind: k });
}

/* ── 步 2：操作类步骤唯一性闸门默认开（V20261113006 #126；报告 §2.7.3-1/§2.7.4 步 2）──
 * 语义：flow `_meta.uniqueDefault`（缺省 true）下，操作类原语（click/rightClick/type/select/scroll/drag）
 * 的元素 target 默认注入 `unique:true`——多命中从「五键排序静默取第一」变「诚实红+候选清单」。
 * 抑制优先级（显式 > 隐式，单点收口）：①target.nth（索引消歧=已显式接受多命中，且 nth 与 unique 互斥）
 * ②target.unique 显式声明（true/false 原样保留）③步骤级 `unique`（true=强制开，false=本步逃逸）
 * ④`_meta.uniqueDefault:false` 全局还原。assert/wait/probe 等存在性步骤不闸门（多命中天然宽容）；
 * 非元素锚点层（domPath/grid/point/near-only）不在 unique 判定层，注入无意义——不注入。
 * 返回浅拷贝（不改写 flow 原对象）；与 withKind 正交（kind 依 action，unique 不依赖 kind）。 */
const UNIQUE_OPS = ['click', 'rightClick', 'type', 'select', 'scroll', 'drag'];
function withUnique(step, meta) {
  if (!step || typeof step !== 'object' || !UNIQUE_OPS.includes(step.action)) return step;
  const t = step.target;
  if (!t || typeof t !== 'object') return step;
  if (t.nth !== undefined || t.unique !== undefined) return step; // 显式契约/索引消歧已表达意图
  if (t.text === undefined && t.role === undefined) return step;  // unique 只在 text/role 层判定
  const on = step.unique !== undefined ? step.unique === true : !(meta && meta.uniqueDefault === false);
  if (!on) return step;
  return Object.assign({}, step, { target: Object.assign({}, t, { unique: true }) });
}

/** 存量 flow 唯一性闸门影响清单（#126 步2 预检；纯函数 advisory inventory——不参与回放/lint 判定）：
 *  返回 uniqueDefault 生效下会被闸门的步骤（操作类 + text/role 锚点 + 无显式 unique/nth/步骤级 unique）。
 *  用途=落地前全量预检（暗雷变明红清单入批报告）+ selftest 存量棘轮；domPath/grid/point 不在判定层不列。 */
function uniqueGateInventory(flow) {
  const out = [];
  if (!flow || !Array.isArray(flow.steps)) return out;
  if (flow._meta && flow._meta.uniqueDefault === false) return out;
  flow.steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !UNIQUE_OPS.includes(s.action)) return;
    const t = s.target;
    if (!t || typeof t !== 'object' || t.unique !== undefined || t.nth !== undefined) return;
    if (s.unique === false) return;
    if (t.text === undefined && t.role === undefined) return;
    out.push({ step: i, action: s.action, anchor: t.text !== undefined ? 'text' : 'role', desc: s.desc || '' });
  });
  return out;
}

/** target 非法时的精确提示（#126；validTarget 只回布尔——冲突原因在此单点解释，DX 用）：
 *  nth 与 unique 互斥/nth 值域/name 需 role 且不得与 text 同用。无已知冲突返回空串（走原笼统消息）。 */
function targetHint(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return '';
  if (t.nth !== undefined && t.unique !== undefined) return '（nth 与 unique 互斥：一个要消歧、一个要唯一，二选一）';
  if (t.nth !== undefined && (!Number.isInteger(t.nth) || t.nth < 0)) return '（nth 须为非负整数——0 基索引，与 CLI --nth 同基）';
  if (t.nth !== undefined && t.text === undefined && t.role === undefined) return '（nth 仅适用于 text/role 锚点——domPath/grid/point 无候选序语义）';
  if (t.name !== undefined && t.role === undefined) return '（name 须与 role 同用——role 层 aria 可及名组合锚）';
  if (t.name !== undefined && t.text !== undefined) return '（name 不得与 text 同用——text 层权威优先会静默忽略 name）';
  if (t.name !== undefined && typeof t.name === 'string' && !t.name.trim()) return '（name 须为非空字符串或 {value,match} 对象）';
  return '';
}

/* ── C5' flow 表达力 V2（#127，V20261113008）：eval / set / cond / loop 纯函数层 ──
 * 设计边界（报告 §② L159 V2）：eval 走现有 Runtime.evaluate 只读基建（对齐 `wait --expr` 先例），
 * 目标是「让 flow 覆盖长尾」而非通用脚本语言——无变量算术原语（需用 eval + __vars 计算）、
 * 无 I/O/网络写入口（只读纪律契约）、循环硬上限 50（防死循环）。
 * 变量作用域 = `{{var}}` 插值在**步骤执行时**求值（存量 flow 的启动时插值结果逐字节等价）：
 * eval.var / set.var 写入 Runner.vars，后续步骤 target/text/cond/set.value 均可引用；
 * eval.when.expr 内引用变量走注入参数 `__vars.name`（不做字符串拼接——避免转义地狱）。 */

/** 剥离 JS 表达式里的字符串/模板/注释（沙箱静态检查前置；不解析正则字面量——宁可漏剥不误剥）。 */
function stripJsLiterals(expr) {
  let out = '', i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i], nx = expr[i + 1];
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < n) { if (expr[i] === '\\') { i += 2; continue; } if (expr[i] === q) { i++; break; } i++; }
      out += ' '; continue;
    }
    if (ch === '`') {
      i++;
      while (i < n) { if (expr[i] === '\\') { i += 2; continue; } if (expr[i] === '`') { i++; break; } i++; }
      out += ' '; continue;
    }
    if (ch === '/' && nx === '/') { while (i < n && expr[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { i += 2; while (i < n && !(expr[i] === '*' && expr[i + 1] === '/')) i++; i += 2; continue; }
    out += ch; i++;
  }
  return out;
}

/** eval/cond.expr 只读沙箱静态拒绝（返回违规 token 或 null）：
 *  底线=无 process/require/fs/child_process/module（Node 能力面）与动态代码（eval/Function/import()）。
 *  这是**策略闸门**不是能力沙箱——页面上下文本就没有 Node 全局，静态拒绝把误用变诚实红。 */
const EVAL_DENY_RE = /\b(process|require|child_process|module|fs|Deno|Bun)\b|\beval\s*\(|\bFunction\s*\(|\bimport\s*\(/;
function evalSandboxViolation(expr) {
  // __vars.<name> 是变量作用域引用（可合法叫 fs/process/module），先归一剔除再查全局名
  const code = stripJsLiterals(String(expr)).replace(/__vars\.[A-Za-z_$][A-Za-z0-9_$]*/g, '__vars');
  const m = EVAL_DENY_RE.exec(code);
  return m ? m[0] : null;
}

/** eval 表达式包装：注入 __vars（变量作用域只读快照）+ 预算内求值。
 *  `return (expr)` 限制为**表达式**（与 wait --expr 同口径）；异步表达式由 awaitPromise 承接。 */
function buildEvalExpr(expr, vars) {
  let varsJson = '{}';
  try { varsJson = JSON.stringify(vars || {}); } catch { varsJson = '{}'; } // 循环引用/不可序列化：降级空表（eval 本身仍可读页面）
  return `(function(__vars){ return (${expr}); })(${varsJson})`;
}

/** cond.when 的变量比较单源（Node 侧）：equals/notEquals 对对象走 JSON 比较、原始值走 ===。
 *  变量必须已定义（拼错变量名→VAR_MISSING 诚实红，不静默当 false）。 */
function condVarMatch(when, vars) {
  const name = String(when.var);
  if (!Object.prototype.hasOwnProperty.call(vars || {}, name)) {
    throw flowErr('VAR_MISSING', `cond 引用未定义变量：${name}（变量须由 flow.vars/--var 或前序 set/eval 提供）`);
  }
  const v = vars[name];
  const cmp = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object')
    ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  if (Object.prototype.hasOwnProperty.call(when, 'equals')) return cmp(v, when.equals);
  if (Object.prototype.hasOwnProperty.call(when, 'notEquals')) return !cmp(v, when.notEquals);
  return !!v;
}

/** eval 预算裁剪（步级 timeoutMs 缺省 3000、上限 10000；与步超时各自独立，CDP evaluate 自带超时）。 */
function evalBudgetOf(step) {
  const ms = Number.isInteger(step && step.timeoutMs) ? step.timeoutMs : EVAL_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(1, ms), EVAL_TIMEOUT_MAX_MS);
}

/** 步骤执行时插值（#127）：通用字段走原 interpolate（存量语义零改动），
 *  eval.expr / cond.when.expr 保持原文（变量在 JS 内用 __vars.name 引用；校验期已拒绝 {{}}）。 */
function interpolateStep(step, vars, missing) {
  const out = interpolate(step, vars, missing);
  if (step && step.action === 'eval' && step.expr !== undefined) out.expr = step.expr;
  if (step && step.action === 'cond' && step.when && typeof step.when === 'object' && step.when.expr !== undefined) {
    out.when = Object.assign({}, out.when, { expr: step.when.expr });
  }
  return out;
}

/** 收集一段 JSON 里全部 {{var}} 引用名（启动期 fail-fast 用；顺带覆盖 set.value/target/cond 等）。 */
function collectVarRefs(value, out) {
  if (typeof value === 'string') {
    const re = /\{\{\s*([^\s{}]+)\s*\}\}/g;
    let m;
    while ((m = re.exec(value))) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectVarRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectVarRefs(value[k], out);
  }
  return out;
}

/** 步骤结果摘要（#127：completed 条目 value 字段——eval/set 证据链；截断防大对象灌爆 verdict）。
 *  #130：opts.redact=true 时先过 §16 redact.text（eval 返回值自动脱敏再落报告——completedSteps/
 *  失败报告/告警值统一出口；vars 内的值保持原样供后续步骤消费，脱敏只在报告层）。 */
function summarizeStepValue(v, opts) {
  try {
    const j = typeof v === 'string' ? v : JSON.stringify(v);
    if (j === undefined) return null;
    const out = j.length > 500 ? j.slice(0, 500) + '…（截断）' : j;
    return (opts && opts.redact) ? require('./redact').text(out) : out;
  } catch { return null; }
}

/** loop 帧变量写入（#127）：indexVar=当前遍序号（0 基，times/over 同语义）；itemVar=over 当前项。 */
function applyLoopVars(vars, frame) {
  if (!vars || !frame) return;
  if (frame.indexVar) vars[frame.indexVar] = frame.iter;
  if (frame.items) vars[frame.itemVar] = frame.items[frame.iter];
}

function validateFlow(flow) {
  const errors = [];
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return ['flow 根必须是对象'];
  const m = flow._meta || {};
  if (m.format !== 'chromeuse-flow/1') errors.push(`_meta.format 须为 "chromeuse-flow/1"（got ${JSON.stringify(m.format)}）`);
  if (typeof m.app !== 'string' || !m.app) errors.push('_meta.app 缺失（应用 slug，对应 webapps/<app>/webapp.md）');
  if (typeof m.title !== 'string' || !m.title) errors.push('_meta.title 缺失');
  if (typeof m.dpr !== 'number') errors.push('_meta.dpr 缺失或非数字（录制环境实际值记录参考——回放不 emulate，V202609080010）');
  if (m.viewport !== undefined) { // V202609100002：viewport schema（存在时 width/height 须有限正数——回放对齐用）
    const v = m.viewport;
    if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push('_meta.viewport 须为对象 {width, height}');
    else {
      if (!Number.isFinite(v.width) || v.width <= 0) errors.push(`_meta.viewport.width 须为有限正数（got ${JSON.stringify(v.width)}）`);
      if (!Number.isFinite(v.height) || v.height <= 0) errors.push(`_meta.viewport.height 须为有限正数（got ${JSON.stringify(v.height)}）`);
    }
  }
  if (m.viewportMin !== undefined) { // V202609280001 方案 B：viewportMin 三态视口策略（最小布局宽度地板，可选字段——缺省零误伤）
    if (!Number.isFinite(m.viewportMin) || m.viewportMin <= 0 || m.viewportMin > 4096) {
      errors.push(`_meta.viewportMin 须为有限正数且 ≤4096（最小布局宽度地板——flow 依赖宽布局时声明，如 winui 双击路径声明 1920；got ${JSON.stringify(m.viewportMin)}）`);
    }
  }
  if (m.viewportMinHeight !== undefined) { // V202610190002：viewportMinHeight 三态视口策略高度维度（最小布局高度地板，可选字段——缺省零误伤；与 viewportMin 宽度地板独立可只声明其一）
    if (!Number.isFinite(m.viewportMinHeight) || m.viewportMinHeight <= 0 || m.viewportMinHeight > 4096) {
      errors.push(`_meta.viewportMinHeight 须为有限正数且 ≤4096（最小布局高度地板——矮窗口下底栏下拉等依赖足高文档视口的 flow 声明，如 900；与 viewportMin 宽度地板独立、可只声明其一；got ${JSON.stringify(m.viewportMinHeight)}）`);
    }
  }
  if (m.allowChallenge !== undefined && typeof m.allowChallenge !== 'boolean') {
    errors.push(`_meta.allowChallenge 须为布尔（got ${JSON.stringify(m.allowChallenge)}）`);
  }
  if (m.uniqueDefault !== undefined && typeof m.uniqueDefault !== 'boolean') {
    errors.push(`_meta.uniqueDefault 须为布尔（操作类步骤唯一性闸门默认值——缺省 true；false=全局还原旧行为；got ${JSON.stringify(m.uniqueDefault)}）`);
  }
  if (m.challengeWaitMs !== undefined && (!Number.isInteger(m.challengeWaitMs) || m.challengeWaitMs < 0 || m.challengeWaitMs > 60000)) {
    errors.push(`_meta.challengeWaitMs 须为 0~60000 整数毫秒（got ${JSON.stringify(m.challengeWaitMs)}）`);
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) errors.push('steps 须为非空数组');
  // #127 V2 预扫：label 表（跳步目标唯一性）+ loop 重复体区间（结构复核在步骤循环后单点做）
  const labelIndex = new Map();
  const loopSpans = [];
  (flow.steps || []).forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    if (s.label !== undefined) {
      if (typeof s.label !== 'string' || !s.label.trim()) errors.push(`steps[${i}].label 须为非空字符串（跳步目标标签）`);
      else if (labelIndex.has(s.label)) errors.push(`steps[${i}].label 重复：${JSON.stringify(s.label)}（跳步目标须唯一，先出现于 steps[${labelIndex.get(s.label)}]）`);
      else labelIndex.set(s.label, i);
    }
    if (s.action === 'loop' && Number.isInteger(s.count) && s.count >= 1) loopSpans.push({ i, start: i + 1, end: i + s.count });
  });
  (flow.steps || []).forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`steps[${i}] 须为对象`); return; }
    if (!ACTIONS.includes(s.action)) { errors.push(`steps[${i}].action 非法：${JSON.stringify(s.action)}（${ACTIONS.length} 原语：${ACTIONS.join('/')}）`); return; }
    const label = `steps[${i}]（${s.action}${s.desc ? '：' + s.desc : ''}）`;
    const need = (cond, msg) => { if (!cond) errors.push(`${label} ${msg}`); };
    // P0-2 未知字段严格校验（本案事故拦截器）：click 不消费 text 之类的字段挪位/action 写错在此前置拦截
    // #127：label 为全原语通用可选字段（跳步目标），不逐原语登记在 ACTION_FIELDS。
    const whitelist = ACTION_FIELDS[s.action] || [];
    const extra = Object.keys(s).filter((k) => k !== 'label' && !whitelist.includes(k));
    if (extra.length) errors.push(`${label} 含非法字段：${extra.join('、')}（${s.action} 原语不消费——疑似 action 写错或字段挪位）`);
    if (s.unique !== undefined && typeof s.unique !== 'boolean') {
      errors.push(`${label} unique 须为布尔（步骤级 uniqueDefault 覆盖：false=本步不闸门；#126）`);
    }
    switch (s.action) {
      case 'goto': need(typeof s.url === 'string' && !!s.url, '缺 url'); break;
      case 'wait': {
        if (s.cond !== undefined) {
          if (Array.isArray(s.cond)) { // V202609300019 wait cond anyOf 数组形态——对齐 checkCond 运行时（L711 分支）与 effect.cond 校验先例（V202609300016）：非空数组+逐单元 validateCond，嵌套数组由单元校验自然红
            need(s.cond.length > 0, 'cond 非法：anyOf 数组须非空');
            s.cond.forEach((c, ci) => { const eCi = validateCond(c); if (eCi) need(false, `cond[${ci}] 非法：${eCi}`); });
          } else { const condErr = validateCond(s.cond); need(!condErr, `cond 非法：${condErr}`); }
        }
        // P0 wait 同链（2026-09-18 引擎批一）字段校验：container 只与 text 同用（收窄语义仅支持 text 锚点，
        // 裸 container/配 ms/urlContains/cond 一律拒收）；形态经 validContainer 单源校验（三形态恰居其一）。
        // 无 container 时 text 只认字符串——对象形态 {value,match} 须与 container 同用（简化路径 TEXT_EXISTS_V2
        // 只做 contains，静默降级 match 是 fix-16 同款事故面，校验期拦截）。
        if (s.container !== undefined) {
          const textFormOk = (typeof s.text === 'string' && !!s.text.trim())
            || !!(s.text && typeof s.text === 'object' && !Array.isArray(s.text) && typeof s.text.value === 'string' && !!s.text.value.trim());
          need(textFormOk, 'container 须与 text 同用（wait 同链收窄仅支持 text 锚点：字符串或 {value, match?} 对象形态）');
          need(validContainer(s.container), 'container 形态非法（{text,match?}/{role}/{domPath} 恰居其一——validContainer 单源校验）');
        } else if (s.text !== undefined && typeof s.text !== 'string') {
          need(false, 'text 对象形态（{value,match}）须与 container 同用——无 container 走 TEXT_EXISTS_V2 简化路径只认字符串（防 match 静默降级 contains）');
        }
        need(s.ms !== undefined || s.text !== undefined || typeof s.urlContains === 'string' || s.cond !== undefined,
          '缺 ms / text / urlContains / cond（其一）');
        if (s.urlContains !== undefined) need(typeof s.urlContains === 'string', 'urlContains 须为字符串');
        break;
      }
      case 'emulate': need(typeof s.dpr === 'number', '缺数字 dpr'); break;
      case 'click': need(validTarget(s.target), '缺合法 target 描述符' + targetHint(s.target)); if (s.dbl !== undefined) need(typeof s.dbl === 'boolean', 'dbl 须为布尔（true=双击）');
        if (s.gate !== undefined) need(Number.isInteger(s.gate) && s.gate >= 1, 'gate 须为正整数毫秒（V202609300016 原语一目标本体闸门：dispatch 前循环定位同 target 至 ok 或超时；实际预算受步预算裁剪不睡穿）');
        if (s.retry !== undefined) need(Number.isInteger(s.retry) && s.retry >= 1 && s.retry <= 3, 'retry 须为 1-3 整数（默认 1=不重试；下拉族配 2-3——重试须与效果闸门配对，引擎不盲目加时）');
        if (s.effect !== undefined) { // V202609300003 效果感知重试：{cond, timeoutMs?}——gate-verify-retry 三明治引擎化
          const eff = s.effect;
          if (!eff || typeof eff !== 'object' || Array.isArray(eff)) need(false, 'effect 须为对象 {cond, timeoutMs?}（cond 同 wait cond 语义；timeoutMs 缺省 3000、上限 10000）');
          else {
            // V202609300016 原语三增量 anyOf：cond 支持数组形态（任一 cond 达成即真，oracle 报告 §3.3）——
            // 单元逐个走 validateCond 单键文法（非空数组；嵌套数组/非法单元校验期红）。单 cond 原形态零改动。
            if (Array.isArray(eff.cond)) {
              if (!eff.cond.length) need(false, 'effect.cond 数组形态须非空（anyOf 任一达成即真——空数组恒假无意义）');
              eff.cond.forEach((c, ci) => { const errCi = validateCond(c); if (errCi) need(false, `effect.cond[${ci}] 非法：${errCi}`); });
            } else {
              const effCondErr = validateCond(eff.cond);
              need(!effCondErr, `effect.cond 非法：${effCondErr}`);
            }
            if (eff.timeoutMs !== undefined) need(Number.isInteger(eff.timeoutMs) && eff.timeoutMs >= 1 && eff.timeoutMs <= 10000, 'effect.timeoutMs 须为 1-10000 整数（缺省 3000——效果轮询窗口，吃步预算受裁剪）');
          }
        }
        break;
      case 'rightClick': need(validTarget(s.target), '缺合法 target 描述符' + targetHint(s.target)); break;
      case 'drag': {
        // drag（V202609170002）文法：target=拖源描述符；to=放置目标，两形态严格二选一——
        // {x,y} 绝对坐标（CSS 视口 px）或 {target:第二描述符}（回放定位后取中心）；x/y 与 target 混用拒收
        need(validTarget(s.target), '缺合法 target 描述符（拖源）' + targetHint(s.target));
        const to = s.to;
        if (!to || typeof to !== 'object' || Array.isArray(to)) {
          need(false, '缺合法 to（放置目标：{x,y} 绝对坐标 或 {target:第二描述符}）');
        } else if (to.target !== undefined) {
          need(validTarget(to.target) && to.x === undefined && to.y === undefined, 'to.target 须为合法描述符且不得与 x/y 混用（两形态严格二选一）' + targetHint(to.target));
        } else {
          need(Number.isFinite(to.x) && Number.isFinite(to.y), 'to 须为 {x,y}（有限数字）或 {target:第二描述符}（二选一）');
        }
        break;
      }
      case 'type': need(typeof s.text === 'string', '缺 text'); if (s.target !== undefined) need(validTarget(s.target), 'target 描述符非法' + targetHint(s.target)); break;
      case 'key': need(typeof s.key === 'string' && !!s.key, '缺 key（如 Enter / Control+S）'); break;
      case 'select': need(validTarget(s.target), '缺 target' + targetHint(s.target)); need(s.value !== undefined, '缺 value'); break;
      case 'scroll': need(s.dx !== undefined || s.dy !== undefined || validTarget(s.target), '缺 dx/dy 或 target' + targetHint(s.target)); break;
      case 'assert': {
        if (s.cond !== undefined) {
          if (Array.isArray(s.cond)) { // V202609300019 assert cond anyOf 数组形态（同 wait case 语义）
            need(s.cond.length > 0, 'cond 非法：anyOf 数组须非空');
            s.cond.forEach((c, ci) => { const eCi = validateCond(c); if (eCi) need(false, `cond[${ci}] 非法：${eCi}`); });
          } else { const e = validateCond(s.cond); need(!e, `cond 非法：${e}`); }
        }
        need(typeof s.text === 'string' || validTarget(s.target) || s.cond !== undefined, '缺 text / target / cond（其一）' + targetHint(s.target));
        break;
      }
      case 'screenshot': case 'probe': break;
      case 'frame': need(Array.isArray(s.path) && s.path.length > 0 && s.path.every((x) => typeof x === 'string'), '缺 path（iframe 名称/id 字符串数组）'); break;
      /* ── #127 V2 四原语 schema ── */
      case 'eval': {
        need(typeof s.expr === 'string' && !!s.expr.trim(), '缺 expr（只读 JS 表达式——与 wait --expr 同口径）');
        if (typeof s.expr === 'string') {
          need(!/\{\{/.test(s.expr), 'expr 不得含 {{var}} 插值——表达式内引用变量请用注入参数 __vars.name');
          const bad = evalSandboxViolation(s.expr);
          need(!bad, `expr 触发只读沙箱拒绝：${bad}（禁 process/require/fs/child_process/module 与 eval/Function/import()——只读纪律）`);
        }
        if (s.var !== undefined) need(typeof s.var === 'string' && VAR_NAME_RE.test(s.var), `var 须为合法变量名（got ${JSON.stringify(s.var)}）`);
        break;
      }
      case 'set': {
        need(typeof s.var === 'string' && VAR_NAME_RE.test(s.var), `var 须为合法变量名（got ${JSON.stringify(s.var)}）`);
        need(Object.prototype.hasOwnProperty.call(s, 'value'), '缺 value（赋值字面量；字符串支持 {{var}} 插值，对象/数组递归插值）');
        break;
      }
      case 'cond': {
        const w = s.when;
        if (!w || typeof w !== 'object' || Array.isArray(w)) need(false, '缺 when（{cond}|{expr}|{var, equals?|notEquals?} 三形态恰居其一）');
        else {
          const forms = ['cond', 'expr', 'var'].filter((k) => w[k] !== undefined);
          need(forms.length === 1, `when 须恰居其一：cond / expr / var（got ${JSON.stringify(forms)}）`);
          const wExtra = Object.keys(w).filter((k) => !['cond', 'expr', 'var', 'equals', 'notEquals'].includes(k));
          need(wExtra.length === 0, `when 含非法字段：${wExtra.join('、')}`);
          if (w.cond !== undefined) {
            if (Array.isArray(w.cond)) { // 与 wait/assert cond 数组形态同语义（anyOf 任一达成即真）
              need(w.cond.length > 0, 'when.cond 数组形态须非空');
              w.cond.forEach((c, ci) => { const eCi = validateCond(c); need(!eCi, `when.cond[${ci}] 非法：${eCi}`); });
            } else { const e = validateCond(w.cond); need(!e, `when.cond 非法：${e}`); }
          }
          if (w.expr !== undefined) {
            need(typeof w.expr === 'string' && !!w.expr.trim(), 'when.expr 须为非空字符串');
            if (typeof w.expr === 'string') {
              need(!/\{\{/.test(w.expr), 'when.expr 不得含 {{var}} 插值——引用变量用 __vars.name');
              const bad = evalSandboxViolation(w.expr);
              need(!bad, `when.expr 触发只读沙箱拒绝：${bad}`);
            }
          }
          if (w.var !== undefined) {
            need(typeof w.var === 'string' && VAR_NAME_RE.test(w.var), 'when.var 须为合法变量名');
            need(!(w.equals !== undefined && w.notEquals !== undefined), 'when.equals 与 notEquals 互斥（二选一）');
          } else {
            need(w.equals === undefined && w.notEquals === undefined, 'when.equals/notEquals 仅与 when.var 同用');
          }
        }
        const j = s.jump;
        if (!j || typeof j !== 'object' || Array.isArray(j)) need(false, '缺 jump（{to:"label"} 或 {skip:N} 恰居其一）');
        else {
          const hasTo = j.to !== undefined, hasSkip = j.skip !== undefined;
          need(hasTo !== hasSkip, 'jump 须恰居其一：to（标签）/ skip（跳过后续 N 步）');
          const jExtra = Object.keys(j).filter((k) => !['to', 'skip'].includes(k));
          need(jExtra.length === 0, `jump 含非法字段：${jExtra.join('、')}`);
          if (hasTo) need(typeof j.to === 'string' && !!j.to.trim(), 'jump.to 须为非空标签字符串');
          if (hasSkip) need(Number.isInteger(j.skip) && j.skip >= 1 && j.skip <= 1000, 'jump.skip 须为 1-1000 整数（正向跳过后续步骤数）');
        }
        break;
      }
      case 'loop': {
        const hasTimes = s.times !== undefined, hasOver = s.over !== undefined;
        need(hasTimes !== hasOver, 'loop 须恰居其一：times（重复次数）/ over（遍历变量数组）');
        if (hasTimes) need(Number.isInteger(s.times) && s.times >= 1 && s.times <= MAX_LOOP_ITERATIONS, `times 须为 1-${MAX_LOOP_ITERATIONS} 整数（循环硬上限，防死循环）`);
        if (hasOver) {
          need(typeof s.over === 'string' && VAR_NAME_RE.test(s.over), 'over 须为变量名（数组）');
          need(typeof s.itemVar === 'string' && VAR_NAME_RE.test(s.itemVar), 'over 形态须给 itemVar（当前项变量名）');
        }
        if (s.itemVar !== undefined) need(typeof s.itemVar === 'string' && VAR_NAME_RE.test(s.itemVar), 'itemVar 须为合法变量名');
        if (s.indexVar !== undefined) need(typeof s.indexVar === 'string' && VAR_NAME_RE.test(s.indexVar), 'indexVar 须为合法变量名');
        need(Number.isInteger(s.count) && s.count >= 1 && s.count <= MAX_LOOP_BODY, `count 须为 1-${MAX_LOOP_BODY} 整数（重复的后续步骤数）`);
        if (Number.isInteger(s.count) && s.count >= 1) {
          need(i + s.count <= (flow.steps || []).length, `count 越过 steps 末尾（steps[${i}] 重复体 ${s.count} 步 > 剩余 ${(flow.steps || []).length - i - 1} 步）`);
        }
        break;
      }
    }
    if (s.timeoutMs !== undefined && !Number.isFinite(s.timeoutMs)) errors.push(`${label} timeoutMs 须为数字`);
  });
  /* #127 V2 结构复核（依赖全量 label 表/loop 区间，故在步骤循环后单点）：
   * ①cond.jump.to 必须引用存在的 label；②不得从循环体外跳入重复体（循环帧未建立，语义不明）；
   * ③loop 重复体只允许严格嵌套，不允许交叠（执行帧语义不明）。 */
  (flow.steps || []).forEach((s, i) => {
    if (!s || typeof s !== 'object' || s.action !== 'cond' || !s.jump || typeof s.jump !== 'object') return;
    if (s.jump.to === undefined) return;
    const to = s.jump.to;
    if (typeof to !== 'string' || !to.trim()) return; // 形态错误已在上方报过
    if (!labelIndex.has(to)) {
      errors.push(`steps[${i}] cond.jump.to 引用不存在的 label：${JSON.stringify(to)}（现有 labels：${[...labelIndex.keys()].join('/') || '无'}）`);
      return;
    }
    const tIdx = labelIndex.get(to);
    for (const sp of loopSpans) {
      const jIn = i >= sp.start && i <= sp.end;
      const tIn = tIdx >= sp.start && tIdx <= sp.end;
      if (tIn && !jIn) errors.push(`steps[${i}] cond 不得跳入循环体：label ${JSON.stringify(to)} 在 steps[${sp.i}] loop 的重复体内（循环帧未建立——请把跳步起点放进同体，或改用 jump.skip）`);
    }
  });
  for (const a of loopSpans) {
    for (const b of loopSpans) {
      if (a === b) continue;
      const aInB = a.i > b.i && a.i <= b.end;
      if (aInB && a.end > b.end) errors.push(`steps[${a.i}] loop 跨出 steps[${b.i}] loop 的重复体（循环体只允许严格嵌套）`);
    }
  }
  return errors;
}

/* ── {{var}} 插值（未定义变量记入 missing，调用方 fail-fast） ── */
function interpolate(value, vars, missing) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([^\s{}]+)\s*\}\}/g, (orig, k) => {
      if (vars && Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k]);
      missing.push(k);
      return orig;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = interpolate(value[k], vars, missing);
    return out;
  }
  return value;
}

/* ── 执行器 ── */
function flowErr(code, message, extra) { const e = new Error(message); e.code = code; if (extra) Object.assign(e, extra); return e; }
const sleep = time.sleep; // 通用延迟单源 lib/time.js
async function withTimeout(promise, ms, label) {
  const t = new Promise((_, rej) => { const timer = setTimeout(() => rej(flowErr('STEP_TIMEOUT', `步骤超时（${ms}ms）：${label}`)), ms); promise.catch(() => {}).finally(() => clearTimeout(timer)); });
  return Promise.race([promise, t]);
}

/** type 写后读探针表达式（V202609290002，帧遍历化）：insertText 后逐文档核对 document.activeElement
 *  的 value/innerText 是否包含 needle——top + 递归 iframe/frame（跨域/读不到 try/catch 跳过），
 *  任一文档命中 → 'ok'；未命中 → 每文档一段诊断（path:标签#id len:N:前40字符，' | ' 连接）。
 *  背景（2026-09-29 --keep-tab 帧遍历探针实锤）：layui 弹层 iframe 内输入框持焦时顶层
 *  document.activeElement 是 IFRAME 元素、value 恒空 → 旧顶层写死探针恒 len:0 假阴性
 *  （TYPE_VERIFY_FAILED 误报「文本未落」，实际 insertText 一直正常落入）——「V2 焦点 churn 45s
 *  自愈」悬案真根因。写法镜像 target-resolver buildCondExpr 的 docsWalk（querySelectorAll('iframe,frame')
 *  + contentDocument try/catch）；深度上限 4 个文档（top+3 层 iframe，防病态嵌套——docsWalk 本身无帽）。 */
function buildInsertVerifyExpr(needle) {
  const N = JSON.stringify(String(needle));
  return `(function(){
  var NEEDLE = ${N}, MAX_DEPTH = 4, diag = [];
  function iframeLabel(f){ try { if (f.id) return f.id; var n = f.getAttribute ? f.getAttribute('name') : null; if (n) return n; } catch(e) {} return 'iframe'; }
  function readVal(el){ try { return (el.value !== undefined && el.value !== null) ? String(el.value) : String(el.innerText || ''); } catch(e) { return ''; } }
  function seg(el, path){
    if (!el) return path + ':null len:0:';
    var tag = '?'; try { tag = String(el.tagName || '?').toUpperCase(); } catch(e) {}
    var idp = ''; try { if (el.id) idp = '#' + el.id; } catch(e) {}
    var v = readVal(el);
    return path + ':' + tag + idp + ' len:' + v.length + ':' + v.slice(0, 40);
  }
  function walk(doc, path, depth){
    var el = null;
    try { el = doc.activeElement; } catch(e) { diag.push(path + ':（读取异常）'); return false; }
    if (el) { try { if (readVal(el).indexOf(NEEDLE) !== -1) return true; } catch(e) {} }
    diag.push(seg(el, path));
    if (depth + 1 >= MAX_DEPTH) return false;
    var fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
    for (var i = 0; i < fr.length; i++) {
      var inner = null; try { inner = fr[i].contentDocument; } catch(e) {}
      if (inner && walk(inner, '//' + iframeLabel(fr[i]), depth + 1)) return true;
    }
    return false;
  }
  if (walk(document, 'top', 0)) return 'ok';
  return diag.join(' | ');
})()`;
}

/** 深交互取证快照表达式（V202609300002，obs-4 实证族）：失败报告 buildFailReport 专用——只读 evaluate
 *  一次（~10ms），采集三段通用信息：①TOP 文档通用覆盖层可见态计数（.modal/.mloading/.layui-layer-shade
 *  ——通用库类，应用专属类名不进引擎层）②最近一次点击绝对坐标的 TOP elementFromPoint 命中链摘要（≤6 级，
 *  与 X4 跨文档复核同款链式描述；lastClickXY=null 时输出 null）③各同源文档 ul.dropdown-menu 计数（通用
 *  组件类）。单段异常只记 *Err 摘要字段，全 fail-soft 不阻塞报告落盘。写法镜像 target-resolver docsWalk。 */
function buildDeepInteractExpr(lastClickXY) {
  const px = (lastClickXY && Number.isFinite(lastClickXY.x)) ? Math.round(lastClickXY.x) : null;
  const py = (lastClickXY && Number.isFinite(lastClickXY.y)) ? Math.round(lastClickXY.y) : null;
  return `(function(){
    const out = {};
    /* V202609300014 docs 走查单例（提顶）：overlays 跨文档化 + dropdownMenus 复用——原 overlays 只查 TOP
     * document，数不到同源 iframe 内弹窗（实锤：示例ERP WARN=.modal 挂 app 文档，终验五轮 overlays=0 假象
     * 而 WARN 常驻可见——「overlays=0≠无异常」的结构性根因）。走查内部全 try 守护 fail-soft。 */
    const docs = [];
    (function walk(doc, fp) {
      docs.push({ doc: doc, fp: fp });
      let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch (e) {}
      for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch (e) {}
        if (inner) walk(inner, fp + '>' + (f.name || f.id || String(f.tagName).toLowerCase())); }
    })(document, 'main');
    try {
      const sels = ['.modal', '.mloading', '.layui-layer-shade'];
      const overlays = {}; const perDoc = docs.map(function (p) { return { doc: p.fp, sels: {} }; });
      const vis = function (el) {
        let r = null; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
        let st = null; try { st = el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { st = null; }
        return !!r && r.width > 0 && r.height > 0 && (!st || (st.display !== 'none' && st.visibility !== 'hidden'));
      };
      for (const s of sels) {
        let n = 0;
        docs.forEach(function (p, i) {
          let hits = 0; try { hits = Array.prototype.filter.call(p.doc.querySelectorAll(s), vis).length; } catch (e) { return; }
          if (hits > 0) { perDoc[i].sels[s] = hits; n += hits; }
        });
        overlays[s] = n;
      }
      out.overlays = overlays;
      out.overlaysByDoc = perDoc.filter(function (d) { return Object.keys(d.sels).length > 0; });
    } catch (e) { out.overlaysErr = String((e && e.message) || e).slice(0, 80); }
    try {
      const px = ${JSON.stringify(px)}, py = ${JSON.stringify(py)};
      if (px === null || py === null) { out.lastClickHitChain = null; }
      else {
        let e0 = null; try { e0 = document.elementFromPoint(px, py); } catch (err) { e0 = null; }
        const chain = []; let n = e0, hops = 0;
        while (n && hops < 6) {
          hops++;
          let cls = ''; try { cls = typeof n.className === 'string' ? n.className : ''; } catch (err) {}
          chain.push(String(n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : ''));
          n = n.parentElement;
        }
        out.lastClickHitChain = chain.length ? chain : null;
      }
    } catch (e) { out.lastClickHitChainErr = String((e && e.message) || e).slice(0, 80); }
    try {
      out.dropdownMenus = docs.map(function (p) {
        let n = 0; try { n = p.doc.querySelectorAll('ul.dropdown-menu').length; } catch (e) { n = -1; }
        return { doc: p.fp, count: n };
      });
    } catch (e) { out.dropdownMenusErr = String((e && e.message) || e).slice(0, 80); }
    return JSON.stringify(out);
  })()`;
}

class Runner {
  constructor(client, sessionId, opts) {
    this.client = client; this.sessionId = sessionId; this.framePath = null; this.stepTimeout = 5000;
    // sleep 接缝（V202609290001，参照 lib/screenshot.js opts.sleepFn 范式）：selftest 注入快速档位，
    // 生产默认真实 sleep——消费点：type 重试退避 / click 重试与效果轮询退避（V202609300003）/
    // gate 轮询节距（V202609300016 原语一）。
    this.sleepFn = (opts && typeof opts.sleepFn === 'function') ? opts.sleepFn : sleep;
    this.hitTest = true;    // X1 总开关（默认开）：flow _meta.hitTest===false 或 CLI --no-hit-test 关
    this.postVerify = false; // X4 post 复核（实验开关默认关）：flow _meta.postVerify===true 或 CLI --post-verify 开
    this.postWarnings = []; // post 复核发现（实验性，仅告警不失败）
    this.waitAnchor = null; // Q2 分诊器锚点（V202609110001）：最近一次成功 wait 的状态快照——失败报告锚点回探用
    this.stepIdx = -1;      // 当前步骤号（runFlow 循环回填；锚点快照记录用）
    this.flowMeta = {};     // flow._meta 引用（kind 语义层总开关 _meta.kind 读取）——runFlow 回填真值
    this.challengeOpt = null; // C4（#124）：bot challenge 检查选项（runFlow 回填；null=不检查——单测直连 Runner 零干扰）
    this.viewportAdvisory = null; // V202610130003 件1 click 前置视口校验（advisory only）：最近一次 centerClick 的越界记录——EFFECT_NOT_ACHIEVED 消息/失败报告 viewportDiagnostics 消费
    this.vars = {}; // #127 V2：运行期变量作用域（runFlow 回填 flow.vars + --var；eval.var/set.var 写入，后续步骤插值/cond 引用）
  }
  /** Q2 分诊器锚点（V202609110001）：wait 成功时记录 {stepIdx, text|urlNeedle, url, timestamp}。
   *  url 读取 fail-soft（冻结期读不到留空，绝不影响 wait 本身成功）。 */
  async recordAnchor(what) {
    const a = Object.assign({ stepIdx: this.stepIdx, url: null, timestamp: Date.now() }, what);
    try { a.url = await this.ev('location.href', 1500); } catch { /* fail-soft：现场不可读留空 */ }
    this.waitAnchor = a;
    return a;
  }
  async ev(expr, timeoutMs, opts) { return require('./cdp-core').evaluate(this.client, this.sessionId, expr, timeoutMs || 5000, opts); } // V202610130003 件2：opts 透传（awaitPromise——stable 页侧轮询专用；缺省 undefined=存量零改动）
  /** C4（#124）：goto 步后置 challenge 检查——默认阻断（诚实红 CHALLENGE_DETECTED），allowChallenge 仅告警。
   *  fail-soft：检测面不可读时如实告警不误拦（漏报边界见 lib/challenge.js 头）；requestedUrl 仅作
   *  非 http(s) 快速跳过（file:/data:/about: 零 CDP 开销，护存量 fixture 流）。 */
  async challengeGate(requestedUrl) {
    const opt = this.challengeOpt;
    if (!opt) return null;
    let res;
    try { res = await challenge.check(this.client, this.sessionId, Object.assign({}, opt, { url: requestedUrl })); }
    catch (e) { log.warn('challenge', `检测面异常（fail-soft 不误拦）：${e.message}`); return null; }
    if (res.error) { log.warn('challenge', `检测面不可用（${res.error}）——本步不做 challenge 判定（如实边界）`); return res; }
    if (res.skipped) return res;
    if (res.cleared) { log.info('challenge', challenge.formatCleared(res)); return res; }
    if (!res.detected) return res;
    res.allowed = !!opt.allowChallenge;
    const msg = res.allowed ? challenge.formatAllowed(res) : challenge.formatBlock(res);
    try { require('./audit').record({ cmd: 'flow', action: res.allowed ? 'challenge.allowed' : 'challenge.blocked', code: res.allowed ? null : 'E_POLICY_DENIED', targetUrl: res.url }); } catch { /* 审计旁路 */ }
    if (res.allowed) { log.warn('challenge', msg); this.postWarnings.push(msg); return res; }
    throw flowErr('CHALLENGE_DETECTED', msg, { challenge: challenge.summary(res) });
  }
  async locate(target) {
    const spec = Object.assign({}, target);
    if (this.framePath) spec.__framePath = this.framePath;
    if (this.hitTest === false) spec.__hitTest = false; // X1 总开关透传进定位表达式
    const r = await this.ev(buildLocateExpr(spec), 8000);
    if (!r || typeof r !== 'object') throw flowErr('CDP_ERROR', `定位返回异常：${JSON.stringify(r).slice(0, 200)}`);
    return r;
  }
  async requireLocated(target) {
    const r = await this.locate(target);
    if (!r.ok) this.throwLocateFailure(r, target);
    this.noteAmbiguityRisk(r); // V202609300017 M5 候选扩散诊断（ok 路径 advisory——跨 frame 次优候选挂 ambiguityRisk）
    return r;
  }
  /** 定位失败统一出口（#126 起 requireLocated/gateWait 共用——gate 遇确定性失败（ambiguous/nth 越界）
   *  立即诚实红，不空转到 gate 预算耗尽）：ambiguous→TARGET_AMBIGUOUS（#126 步4 细分码），nth 越界→
   *  TARGET_NOT_FOUND+候选清单，其余→TARGET_NOT_FOUND+拒因/container 诊断。 */
  throwLocateFailure(r, target) {
    // V202609300016 原语四 unique（唯一性契约）：ambiguous 返回=「找到太多」而非「未找到」——诚实红
    // 不赌排序（排序救不了身份问题），错误附全部候选 tag/text/rect/frame 清单（页侧 buildLocateExpr
    // text/role 层排序后 spec.unique===true && hits.length>1 产出），供作者收窄 container/加 tag 契约。
    // #126 步4：细分码升独立 TARGET_AMBIGUOUS（对齐 CLI E_AMBIGUOUS 口径——消费方免 parse 文本；
    // 失败报告 error.kind 仍归 target 族）。历史 TARGET_NOT_FOUND+ambiguous 附加字段保留（兼容）。
    if (r.ambiguous && Array.isArray(r.ambiguousCandidates) && r.ambiguousCandidates.length) {
      throw flowErr('TARGET_AMBIGUOUS', `唯一性契约（unique:true）违例：过闸候选 ${r.ambiguousCandidates.length} 个>1（ambiguous——诚实红不赌排序）：${r.ambiguousCandidates.map((x) => `<${x.tag}>"${String(x.text || '').slice(0, 16)}" rect=${JSON.stringify(x.rect)} @${x.frame}`).join('；')}——处置：container 硬收窄 / 显式 nth:N 选第 N 个（0 基，与 unique 互斥）`,
        { attempts: r.attempts, candidates: r.candidates, rejected: r.rejected || [], ambiguous: true, ambiguousCandidates: r.ambiguousCandidates });
    }
    // #126 步1：nth 越界诚实红（复用 TARGET_NOT_FOUND 族）+ 候选清单（tag/text/rect/frame）——
    // CLI 侧候选序（locator 可点优先→exact→面积）与 flow 侧排序链（text 层五键/role 层文档序）不同源，
    // 清单供模型自校对「第 N 个」到底是谁；不静默回退第 0 个。
    if (r.nthOutOfRange) {
      throw flowErr('TARGET_NOT_FOUND', `nth 越界：nth=${r.nth} 但过闸候选仅 ${r.nthTotal} 个（0 基索引；unique/nth 互斥）——候选清单（tag/text/rect/frame，顺序=本层候选序）：${(r.nthCandidates || []).map((x) => `<${x.tag}>"${String(x.text || '').slice(0, 16)}" rect=${JSON.stringify(x.rect)} @${x.frame}`).join('；')}`,
        { attempts: r.attempts, candidates: r.candidates, rejected: r.rejected || [], nthOutOfRange: true, nth: r.nth, nthTotal: r.nthTotal, nthCandidates: r.nthCandidates || [] });
    }
    // 定位失败低频告警（target-resolver 为纯表达式组装器、Node 侧无失败点——在消费点记录 text spec + 候选数）
    const specText = (target && (target.text && target.text.value || target.text)) || JSON.stringify(target).slice(0, 80);
    log.warn('locate', `四层定位全部未命中：text=${JSON.stringify(String(specText).slice(0, 60))} 候选=${(r.candidates || []).length}`);
    // X1：被四层闸门拒候选 top-N 诊断附错误信息（tag/rect/拒因）——假绿转红时可直读拒因
    const rejNote = (r.rejected && r.rejected.length)
      ? `；四层闸门拒 ${r.rejected.length}${r.rejected.length >= 8 ? '+' : ''} 候选（${r.rejected.slice(0, 4).map((x) => `<${x.tag}>"${String(x.text || '').slice(0, 16)}"rect=${JSON.stringify(x.rect)} ${x.rej}`).join('；')}）`
      : '';
    // container 硬收窄诊断（ora-5 设计步骤 2 §4.6）：TARGET_NOT_FOUND 附 container 五元组——
    // found=0 → container-not-found（容器文本漂移/容器未渲染嫌疑）；容器内 0 候选且容器外 N 条 →
    // 收窄生效但目标不在其中（"容器外候选 N 条"，target-changed 嫌疑）。纯 advisory 不改判失败。
    let contNote = '';
    if (r.container) {
      const cd = r.container;
      contNote = cd.found
        ? `；container(${cd.form}) 找到=${cd.matched} 容器内=${cd.scopedFound} 容器外=${cd.outsideCount}${(cd.scopedFound === 0 && cd.outsideCount > 0) ? `——容器内无候选、容器外候选 ${cd.outsideCount} 条（硬收窄无全局回退）` : ''}`
        : `；container(${cd.form}) 未找到（container-not-found，matched=0）——容器文本漂移/容器未渲染嫌疑`;
    }
    throw flowErr('TARGET_NOT_FOUND', `四层定位全部未命中（${JSON.stringify(target).slice(0, 120)}）${rejNote}${contNote}`,
      Object.assign({ attempts: r.attempts, candidates: r.candidates, rejected: r.rejected || [] }, r.container ? { container: r.container } : {}));
  }
  async textExists(text, timeoutMs) { return this.ev(`(function(){ return (${TEXT_EXISTS_SRC})( ${JSON.stringify(String(text))} ); })()`, timeoutMs); }
  /** X2 两级漏斗（仅 wait text 无 container 时使用；assert text 走原单级 textExists）：一级 innerText 快路径零增量，二级过闸判真。
   *  带 container 的 wait text 不走本方法——textLocateWait 同链全链路（2026-09-18 引擎批一）。 */
  async textExistsWait(text, timeoutMs) { return this.ev(`(function(){ return (${TEXT_EXISTS_V2_SRC})( ${JSON.stringify(String(text))} ); })()`, timeoutMs); }
  /** P0 wait 同链（2026-09-18 失败根治引擎批一，五方合议 unanimous）：wait text+container 轮询 buildLocateExpr
   *  全链路——等的就是「将要操作的那一个」（与 click 同 text/container 描述符，消灭「wait 过的是 A、click 点的是 B」
   *  的两次独立解析裂缝），每轮 X1 四层闸门过滤 + X4 命中复核双确认。判定语义（与 click 的分叉点）：
   *  - locate 未 ok / X4 'blocked'（可见但中心命中偏离——动画/遮罩窗）/ X4 'success'（gone——两次解析间目标移除）
   *    均视为**未就绪继续轮询**：wait 语义要求目标**稳定在场**，不可复用 click 的 gone 判成功语义；
   *  - locate ok 且 X4 'pass'（pass-hit/pass-error——复核异常放行同 X4 fail-soft 哲学）→ 成功并记锚点；
   *  超时 → ASSERT_FAILED，错误信息附最后一次定位诊断（拒因/容器五元组——简化路径超时只报「文本未出现」，
   *  同链路径带定位现场，翻红即可分诊）。无 container 的 wait text 不进本方法（存量 flow 零破坏）。 */
  async textLocateWait(text, container, timeoutMs) {
    const norm = waitLocateSpec(text, container);
    const target = norm ? norm.spec : { text, container }; // 归一单源（waitLocateSpec）；null 回退原值纯防御（校验层已拦截）
    const textValue = norm ? norm.textValue : String((text && text.value !== undefined) ? text.value : text);
    const deadline = Date.now() + timeoutMs;
    let lastDiag = '';
    while (Date.now() < deadline) {
      let located = null, locateErr = null;
      try { located = await this.locate(target); } catch (e) { locateErr = e; }
      if (located && located.ok && located.best) {
        let verdict = 'pass-error'; // X4 复核异常放行（页面导航中等瞬态——不阻塞等待）
        try { verdict = await this.ensureHittable(located.best); }
        catch (e) { verdict = 'blocked'; lastDiag = String((e && e.message) || e).slice(0, 200); } // covered：可见但中心命中偏离——未就绪
        if (verdict === 'pass') { this.noteAmbiguityRisk(located); await this.recordAnchor({ text: textValue }); return true; }
        if (verdict === 'success') lastDiag = 'X4 复核 gone（两次解析间目标移除/移动——瞬态，继续轮询等稳定在场）';
      } else if (located) {
        // 定位未 ok：收集拒因/容器诊断供超时错误信息（拼法对齐 requireLocated 的 advisory 口径）
        const rej = (located.rejected && located.rejected.length)
          ? `；四层闸门拒 ${located.rejected.length} 候选（${located.rejected.slice(0, 4).map((x) => `<${x.tag}>"${String(x.text || '').slice(0, 16)}" ${x.rej}`).join('；')}）` : '';
        const cd = located.container;
        const cont = cd ? (cd.found
          ? `；container(${cd.form}) 容器内=${cd.scopedFound} 容器外=${cd.outsideCount}`
          : `；container(${cd.form}) 未找到（container-not-found——容器文本漂移/容器未渲染嫌疑）`) : '';
        lastDiag = `候选=${(located.candidates || []).length}${rej}${cont}`;
      } else if (locateErr) {
        lastDiag = `定位求值异常：${String((locateErr && locateErr.message) || locateErr).slice(0, 120)}`;
      }
      await sleep(500); // 轮询节距对齐 waitCond/legacy wait text
    }
    throw flowErr('ASSERT_FAILED', `等待目标本体未就绪（${timeoutMs}ms）：text=${JSON.stringify(textValue)}${lastDiag ? `（${lastDiag}）` : ''}`);
  }
  /** 原语一 gate（V202609300016，oracle 失败数据根因报告 §3.3「目标本体闸门」）：dispatch 前循环定位
   *  target 至 ok 或超时——「点谁等谁」引擎化：wait 闸门与 click 是两次独立解析、可能选不同元素
   *  （裂缝③），gate 用与点击完全相同的描述符（调用方传入 withKind 产物）单一解析面。500ms 轮询节距
   *  对齐 waitCond/textLocateWait；单轮定位未 ok 不抛错继续轮询（诊断滚动更新——拒因/容器五元组口径
   *  同 requireLocated），超时才 TARGET_NOT_FOUND。语法糖非新语义：手写等价物（wait cond.element
   *  同描述符闸门步+点击步）继续合法。轮询 sleep 走 this.sleepFn（V202609290001 接缝，selftest 快速档位）。 */
  async gateWait(target, ms) {
    const deadline = Date.now() + ms;
    let lastDiag = '';
    for (;;) {
      let located = null, locateErr = null;
      try { located = await this.locate(target); } catch (e) { locateErr = e; }
      if (located && located.ok) return located;
      // #126：ambiguous / nth 越界是确定性失败（DOM 不变化时等下去不会好转）——立即诚实红，不空转 gate 预算
      if (located && (located.ambiguous || located.nthOutOfRange)) this.throwLocateFailure(located, target);
      if (located) {
        const rej = (located.rejected && located.rejected.length)
          ? `；四层闸门拒 ${located.rejected.length} 候选（${located.rejected.slice(0, 4).map((x) => `<${x.tag}>"${String(x.text || '').slice(0, 16)}" ${x.rej}`).join('；')}）` : '';
        const cd = located.container;
        const cont = cd ? (cd.found
          ? `；container(${cd.form}) 容器内=${cd.scopedFound} 容器外=${cd.outsideCount}`
          : `；container(${cd.form}) 未找到（container-not-found——容器文本漂移/容器未渲染嫌疑）`) : '';
        lastDiag = `候选=${(located.candidates || []).length}${rej}${cont}`;
      } else if (locateErr) {
        lastDiag = `定位求值异常：${String((locateErr && locateErr.message) || locateErr).slice(0, 120)}`;
      }
      if (Date.now() >= deadline) break; // 至少完整一轮定位后才判超时（不空转）
      await this.sleepFn(Math.min(500, deadline - Date.now()));
    }
    throw flowErr('TARGET_NOT_FOUND', `gate 闸门超时（${ms}ms）：目标本体未就绪（${JSON.stringify(target).slice(0, 120)}）${lastDiag ? `（${lastDiag}）` : ''}`);
  }
  /** M5 候选扩散诊断（V202609300017，oracle 失败数据报告 §6.2 M5/§四——铁律②「同名必唯一」机检引擎侧）：
   *  locate ok 时若 best 与次优候选（candidates[1]）跨 frame（排序赌注高危形态——跨文档同名候选的
   *  fragment/面积排序无语义，tspan 抢占族结构信号），记 advisory 标记（不改判成功、不抛错——
   *  X4 pass-error 容忍哲学同源）；挂 this.ambiguityRisk 供失败报告 buildFailReport 消费。
   *  无扩散/候选 ≤1 时清旧标记（ok 路径内判定）；定位未 ok（抛 TARGET_NOT_FOUND）不清除——失败报告
   *  读到的正是该步最近一次成功定位的扩散状态（定位成功但后续 X4/派发失败时，「排序赌赢可能赌错」
   *  立即可见）。容器祖先比对页侧候选
   *  未采集（item 无 parent 链），本实现只覆盖 frame 维度——容器收窄正确性由 M1/M2 静态机检兜。
   *  消费点：requireLocated（click/rightClick/select/scroll/drag/assert target 全覆盖）与
   *  textLocateWait（wait 同链成功路径）。 */
  noteAmbiguityRisk(r) {
    try {
      const c = r && r.candidates;
      const risky = !!(r && r.ok && r.best && Array.isArray(c) && c.length > 1 && c[1] && c[1].frame !== r.best.frame);
      if (risky) {
        this.ambiguityRisk = { strategy: r.strategy, best: { tag: r.best.tag, text: r.best.text, rect: r.best.rect, frame: r.best.frame }, runnerUp: { tag: c[1].tag, text: c[1].text, rect: c[1].rect, frame: c[1].frame } };
        log.warn('locate', `候选扩散（ambiguityRisk advisory）：best@${r.best.frame} 与次优@${c[1].frame} 跨 frame（排序赌注高危——建议 container 收窄或 unique:true，铁律②）`);
      } else {
        this.ambiguityRisk = null;
      }
    } catch { /* 诊断失败绝不阻塞定位主路径（fail-soft） */ }
  }
  /** V202610130003 件1 click 前置视口校验（advisory only——INBOX 2026-10-11 天猫实证：500×579 窄视口下
   *  按钮 rect x=720 超视口宽，点击报笼统 "did not become interactive"；快速判别法=elementFromPoint null +
   *  innerWidth/innerHeight 对照 rect。与 09-30 矮窗口（高度维度）同族——视口不足两轴皆可发）。
   *  时机=centerClick 定位成功拿到 best rect 后（dispatch 前）；坐标空间：best.rect=absRect 顶层视口累加
   *  坐标（target-resolver frame-offset 逐级累加），与顶层 window.innerWidth/innerHeight 同空间直接可比。
   *  ⚠ 硬约束：只 advisory+诊断——不改点击派发行为、不自动 scroll、不自动 resize（防污染用户现场，与
   *  视口三态策略「在场纯跟随」语义一致）。读取 fail-soft（视口读不到静默跳过，绝不影响点击）；
   *  越界记录挂 this.viewportAdvisory（EFFECT_NOT_ACHIEVED 消息/失败报告 viewportDiagnostics 消费），
   *  未越界/读不到清 null（不携带陈旧现场）。 */
  async noteViewportAdvisory(rc, cx, cy) {
    try {
      const vpj = await this.ev('JSON.stringify({iw:window.innerWidth,ih:window.innerHeight})', 1500);
      const vp = typeof vpj === 'string' ? JSON.parse(vpj) : null;
      if (!vp || !Number.isFinite(vp.iw) || !Number.isFinite(vp.ih)) { this.viewportAdvisory = null; return; }
      const axes = [];
      if (rc.x < 0) axes.push('x<0 左越界');
      if (rc.y < 0) axes.push('y<0 上越界');
      if (rc.x + rc.w > vp.iw) axes.push('x+w>iw 右越界');
      if (rc.y + rc.h > vp.ih) axes.push('y+h>ih 下越界');
      if (!axes.length) { this.viewportAdvisory = null; return; }
      this.viewportAdvisory = { rect: { x: rc.x, y: rc.y, w: rc.w, h: rc.h }, center: { x: cx, y: cy }, iw: vp.iw, ih: vp.ih, axes };
      log.warn('click', `元素可能落在视口外（advisory）：元素 rect(${rc.x},${rc.y},${rc.w},${rc.h}) vs 视口(${vp.iw}×${vp.ih})，中心(${cx},${cy})，越界：${axes.join('/')}——点击可能落在视口外——先滚动使元素入视口或 resize_page 临时加宽再操作`);
    } catch { this.viewportAdvisory = null; /* 视口读取 fail-soft：绝不影响点击 */ }
  }
  /** X4 容忍式命中复核（dispatch 前；预算与 locate 对齐 8s——冻结期别让验证先炸成 STEP_TIMEOUT）。
   *  返回 'pass-hit'|'gone'|'pass-error'|'covered'|'blocked-cross-doc'；evaluate 抛错（页面导航中等瞬态）→ 'pass-error' 放行不阻塞。
   *  V202609300002：buildVerifyExpr 的 'blocked-cross-doc|<命中链摘要>' 在此拆包——判定返回新值，
   *  摘要挂 this._crossDocDetail 供 ensureHittable 错误消息消费（单步单线程语义，无并发覆写面）。
   *  V202609300005：'gone|<诊断>' 同款拆包——诊断串挂 this._goneDetail（ensureHittable 的 gone→success
   *  跳过派发路径 log.info 消费，假 gone 立即可见）。 */
  async verifyHit(best) {
    try {
      await sleep(100); // renderer 缓冲
      const v = await this.ev(buildVerifyExpr(best), 8000);
      if (typeof v === 'string' && v.indexOf('blocked-cross-doc') === 0) {
        this._crossDocDetail = v.slice('blocked-cross-doc'.length + 1) || '';
        return 'blocked-cross-doc';
      }
      if (typeof v === 'string' && v.indexOf('gone|') === 0) { // V202609300005 带诊断 gone 拆包
        this._goneDetail = v.slice('gone|'.length) || '';
        return 'gone';
      }
      this._crossDocDetail = null;
      this._goneDetail = null;
      return ['pass-hit', 'gone', 'pass-error', 'covered'].includes(v) ? v : 'pass-error'; // 未知返回放行
    } catch { return 'pass-error'; }
  }
  /** X4 总闸入口：point 策略只要求 elementFromPoint 非 null；其余策略走容忍式复核。
   *  返回 'pass'（放行 dispatch）| 'success'（判成功跳过 dispatch——best 已移除）| 抛 TARGET_NOT_FOUND（blocked） */
  async ensureHittable(best) {
    if (best.hitOK === false) { // X1 闸门明示拒绝（防御——正常不会出现在候选里）
      throw flowErr('TARGET_NOT_FOUND', `命中闸门明示拒绝：best.hitOK=false（${JSON.stringify(best).slice(0, 120)}）`, { hitMiss: true });
    }
    const cx = best.rect.x + Math.floor(best.rect.w / 2), cy = best.rect.y + Math.floor(best.rect.h / 2);
    if (best.strategy === 'point') { // 策略分叉：point 无元素实体，只要求 elementFromPoint 非 null
      let hitTag = null;
      try { hitTag = await this.ev(`(function(){ var e = document.elementFromPoint(${cx}, ${cy}); return e ? String(e.tagName).toLowerCase() : null; })()`, 8000); } catch { return 'pass'; }
      if (hitTag === null) {
        log.warn('click', `X4 point 命中复核：elementFromPoint(${cx},${cy}) 为 null（坐标无接收元素）`);
        throw flowErr('TARGET_NOT_FOUND', `point 命中复核：elementFromPoint(${cx},${cy}) 为 null（坐标无接收元素）`, { hitMiss: true });
      }
      return 'pass';
    }
    const v = await this.verifyHit(best);
    if (v === 'blocked-cross-doc') { // V202609300002 跨文档遮挡（父文档覆盖层/兄弟 iframe——X4 同文档局部语义盲区已补）：
      // 「✓ 但没发生」假绿变可归因红。示例文案（DIV.modal…）只进 desc/日志，代码逻辑仅消费通用类名判定。
      const detail = this._crossDocDetail || '（命中链摘要缺失）';
      log.warn('click', `X4 跨文档遮挡复核 blocked-cross-doc：命中链=${detail}`);
      throw flowErr('TARGET_NOT_FOUND', `命中复核未通过（blocked-cross-doc）：目标被父文档覆盖层/兄弟 iframe 遮挡——同文档命中测试通过但点击物理落点被上层文档吸收（X4 局部语义盲区已补）：命中链=${detail}（如 DIV.modal.gongqi-warn…即父文档全屏弹层/遮罩，先清场再重试）`, { hitMiss: true, crossDoc: true, best: { tag: best.tag, text: best.text, rect: best.rect, frame: best.frame } });
    }
    if (v === 'blocked') {
      log.warn('click', `X4 命中复核 blocked：best 仍在原位但 elementFromPoint 命中无关元素（text=${JSON.stringify(String(best.text || '').slice(0, 24))}）`);
      throw flowErr('TARGET_NOT_FOUND', `命中复核未通过（hitMiss）：目标仍在原位但中心命中测试为 null/html/body/无关元素——前置操作条件未满足或定位漂移`, { hitMiss: true, best: { tag: best.tag, text: best.text, rect: best.rect, frame: best.frame } });
    }
    if (v === 'gone') { // best 已移除/移动 → 判成功（点击已产生效果，如点了会关菜单的项）
      // V202609300005 假 gone 可观测性：重找 ±6px 失败的诊断串随行打日志（重找候选数/最近Δpx/两侧 rect）——
      // 深度 iframe 底栏按钮曾恒误判 gone→静默跳派发（coords-probe 实证 lastClickXY=null），下次立刻可见
      log.info('click', `X4 复核 gone（重找 ±6px 匹配失败→判成功跳过派发）：${this._goneDetail || '（无诊断）'}`);
      return 'success';
    }
    return 'pass'; // pass-hit / pass-error → 放行
  }
  /** 条件文法求值（单次）：network 走 Network 域缓冲，其余走只读页面表达式。
   *  V202609300016 原语三增量 anyOf：cond 数组形态=任一 cond 达成即真（oracle 报告 §3.3
   *  「effect: {anyOf: [...]}」）——单元顺序短路求值（首真即返回）；单元求值异常按未达成处理
   *  （达成判定只认「确证为真」，异常不传染其他单元——X4 pass-error 容忍哲学同源）。仅 effect 路径
   *  可达：wait/assert 的 cond 经 validateCond 单键文法校验，数组形态校验期即红（不破线性文法）。
   *  ⚠ network 单元在数组内的求值窗口=本调用 timeoutMs（效果轮询路径=min(3000, 剩余)），多 network
   *  单元串行窗口叠加受 effDeadline clamp 保护（不睡穿步超时）。 */
  async checkCond(cond, timeoutMs) {
    if (Array.isArray(cond)) {
      for (const c of cond) {
        try { if (await this.checkCond(c, timeoutMs)) return true; } catch { /* 单元异常=未达成（不传染） */ }
      }
      return false;
    }
    if (cond.network !== undefined) return this.checkNetwork(cond.network, timeoutMs);
    // V202610130003 件2：stable 页侧轮询 IIFE 已 async 化（帧间 setTimeout 让出主线程）——求值必须
    // awaitPromise:true 才能拿到 resolved 值；非 stable cond 不传 opts（CDP awaitPromise:false 存量零改动）。
    const awaitOpts = (cond && cond.element && cond.element.stable !== undefined) ? { awaitPromise: true } : undefined;
    const r = await this.ev(require('./target-resolver').buildCondExpr(cond), timeoutMs || 3000, awaitOpts);
    return r === true;
  }
  /** network 条件：enable Network 域收集窗口内请求，满足 urlIncludes（可选 method/minCount）即真 */
  async checkNetwork(spec, timeoutMs) {
    const cfg = typeof spec === 'string' ? { urlIncludes: spec } : spec;
    const minCount = Number.isFinite(cfg.minCount) ? cfg.minCount : 1;
    await this.client.send('Network.enable', {}, { sessionId: this.sessionId });
    const seen = [];
    const off = this.client.onEvent(({ sessionId: sid, method, params }) => {
      if (sid !== this.sessionId || method !== 'Network.requestWillBeSent') return;
      const req = params.request || {};
      if (req.url && req.url.includes(cfg.urlIncludes) && (!cfg.method || req.method === cfg.method)) seen.push(req.url);
    });
    try {
      const deadline = Date.now() + (timeoutMs || 3000);
      while (Date.now() < deadline) {
        if (seen.length >= minCount) return true;
        await sleep(200);
      }
      return seen.length >= minCount;
    } finally { off(); }
  }
  async waitCond(cond, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.checkCond(cond, 3000)) return true; } catch { /* 冻结轮询重试 */ }
      await sleep(500);
    }
    const err = flowErr('ASSERT_FAILED', `等待条件未满足（${timeoutMs}ms）：${JSON.stringify(cond).slice(0, 120)}`);
    // P1-1c（V202609130001）wait 超时路径终态取证：抛错前挂 captureTerminalState——
    // stop 滞留/乐观会话迁移/消息计数等现场并入失败报告 report.terminalState（全 fail-soft，不掩盖原失败）
    try { err.terminalState = await this.captureTerminalState(); } catch { /* 取证失败不掩盖原失败 */ }
    throw err;
  }

  /** P1-1c wait 超时终态取证：读 stop-button rect+computed visibility+aria-label、输入框 value 长度、
   *  user/assistant 消息计数、URL（是否 WEB: 乐观前缀）。选择器为 chatgpt 形态、页面缺元素时字段照实记录
   *  （present:false / 计数 0——对其他应用无害）。全部只读 evaluate，单次往返。 */
  async captureTerminalState() {
    const state = {};
    try {
      const j = await this.ev(`(function(){
        var out = {};
        var stop = document.querySelector('button[data-testid=stop-button]');
        if (stop) { var r = stop.getBoundingClientRect(); var vis = ''; try { vis = getComputedStyle(stop).visibility; } catch(e) {}
          out.stopButton = { present: true, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, visibility: vis, ariaLabel: stop.getAttribute('aria-label') || null }; }
        else out.stopButton = { present: false };
        var comp = document.querySelector('div#prompt-textarea[contenteditable=true], textarea#prompt-textarea');
        var cv = null; if (comp) { try { cv = (comp.value !== undefined && comp.value !== null) ? String(comp.value) : String(comp.innerText || ''); } catch(e) { cv = null; } }
        out.composer = { present: !!comp, valueLength: cv === null ? null : cv.length };
        try { out.messages = { user: document.querySelectorAll('[data-message-author-role=user]').length, assistant: document.querySelectorAll('[data-message-author-role=assistant]').length }; } catch(e) { out.messages = null; }
        out.url = String(location.href);
        return JSON.stringify(out);
      })()`, 2000);
      if (j) Object.assign(state, JSON.parse(j));
    } catch (e) { state.note = `终态取证失败（fail-soft）：${String((e && e.message) || e).slice(0, 80)}`; }
    return state;
  }
  async mouseClick(x, y, clickCount, button) {
    // V202609300002 深交互取证：记录最近一次点击绝对坐标（失败报告 buildFailReport 读 runner.lastClickXY，
    // 对该坐标做 TOP elementFromPoint 命中链快照——「零响应」变可归因的核心线索）。覆盖 click/rightClick/select。
    this.lastClickXY = { x: Math.round(x), y: Math.round(y) };
    // V202609100002 H1 修正：screenX/screenY 忠实映射——CSS 视口坐标 → 屏幕坐标。
    // 公式：screenX = window.screenX + x；screenY = window.screenY + (outerHeight - innerHeight) + y
    // （视口顶缘的屏幕 Y = window.screenY + 浏览器 UI 高度）。旧实现硬编码 screenY=y+120 是 F1 嫌疑根因：
    // 窄视口/低屏下 +120 把 winui 弹层定位推出可见区（"面板不弹出"）。zoom 页 outerHeight 不可靠时
    // 该映射仍优于固定 120（真实 screenX/Y 分量保留）。evaluate 失败（冻结期）回退旧值 y+120——fail-soft。
    // Runner 级缓存：一次回放仅算一次（窗口位置回放期不变）；select/scroll 等旁路 mouseClick 同享。
    if (this._screenOffset === undefined) {
      try {
        const off = await this.ev('(function(){ return [window.screenX || 0, window.screenY || 0, (window.outerHeight - window.innerHeight) || 0]; })()', 1500);
        this._screenOffset = Array.isArray(off) ? off : null;
      } catch { this._screenOffset = null; }
    }
    // V202609130002 rightClick 按键参数化：button==='right' 时 CDP button:'right'、buttons 位掩码 2
    // （CDP 规范鼠标键位：left=1/right=2/middle=4）——screenX/screenY 映射/mouseMoved 前置/hold 间隔/
    // 两段双击等基础设施全复用（left 路径零改动）。Chromium 输入管线在右键 mouseReleased 之后自动派发
    // contextmenu（isTrusted=true 的受信事件——非 evaluate 合成，红线一不破）：合成序列天然触发目标页
    // 右键菜单，录制侧 contextmenu 采集（V202609100001）→ 回放 rightClick 的 round-trip 就此闭环。
    // 双右键非标准手势：cc===2 两段双击分支保留左键语义，rightClick 恒走单击路径。
    const btn = button === 'right' ? 'right' : 'left';
    const btnMask = button === 'right' ? 2 : 1;
    const off = this._screenOffset;
    const base = { x, y, button: btn, buttons: btnMask, pointerType: 'mouse',
      screenX: off ? off[0] + x : x,
      screenY: off ? off[1] + off[2] + y : y + 120 };
    const cc = clickCount || 1;
    const so = { sessionId: this.sessionId, timeoutMs: this.stepTimeout };
    await this.client.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base, { buttons: 0 }), so);
    // V202609300004 move→press 悬停安定间隙：hover 先被处理（mouseover/悬浮态）组件才认后续 mousedown——
    // 零间隙连发在下拉族三连败 vs 裸 CDP ≥50ms 间隙七连开实锤（V202609090004 press↔release hold
    // 教训的 move→press 补全）；单击/dbl 两段序列/rightClick 均经此单点，三路径同受益。
    await sleep(MOUSE_MOVE_SETTLE_MS);
    // V202609090004 hold 间隔：pressed↔released 之间 ~80ms（模拟真实点击的物理按压时长）——
    // 零间隔连发在 winui 桌面图标上实测无效（人工 hold 点击有效，桌面双击路径对照实验），疑似 winui
    // 依赖 mousedown→mouseup 的时间差判定。CDP 语义仍为完整 click（press+release 同坐标）。
    if (cc === 2) {
      // X3 两段完整双击序列（V202609090001，council 定稿）：clickCount:1 一对 → 80~120ms 间隔 → clickCount:2
      // 一对，坐标同源——Chromium dblclick 检测依赖第一对事件，单发 clickCount:2 会被当普通单击。
      // 重试协议：dbl 步骤重试必须整体重发两段序列（self-heal 整步重跑天然满足；无只补第二段的路径）
      await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mousePressed', clickCount: 1 }), so);
      await sleep(80);
      await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseReleased', clickCount: 1, buttons: 0 }), so);
      await sleep(100);
      await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mousePressed', clickCount: 2 }), so);
      await sleep(80);
      await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseReleased', clickCount: 2, buttons: 0 }), so);
      return;
    }
    await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mousePressed', clickCount: cc }), so);
    await sleep(80);
    await this.client.send('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseReleased', clickCount: cc, buttons: 0 }), so);
  }
  /**
   * drag 原语（V202609170002，路线 A：纯鼠标序列 + buttons:1 按住段）。
   * 依据 tmpdata/drag-live/实验报告.md §5.6 G3 两连过实证：mousedown(buttons:1) → 按住段多段
   * mousemove(buttons:1，首段过阈值即触发 dragstart) → mouseup(buttons:0) 走完整原生拖拽管线
   * （dragstart 执行、页面自产 payload、chromium/x-drag-id 全真；isTrusted 红线全真实事件）。
   * 路线 B（Input.dispatchDragEvent 独立注入）不实施——无 dragstart/无源元素（"凭空拖拽"），
   * payload 落调用方手里，与录制侧 dragstart 标记聚合（lib/events.js aggregateDrags）不闭环，留档备查。
   * 序列：hover moved(buttons:0) → pressed(left,buttons:1)@源中心 → HOLD_MS → SEGMENTS 段插值
   * moved(left,buttons:1)（段间 MOVE_GAP_MS）→ released(left,buttons:0)@落点。
   * ⚠ 收尾语义（实验报告 §7.5）：released 后 dragend 即终点——release 被拖拽管线消费，DOM mouseup
   * 不会出现，回放断言勿锚 mouseup。坐标 = CSS 视口 px（DPR 无关，实验报告 DPR 1.5 实测零失真）。
   * 拖动期取证：PROBE_AT 段号处 elementFromPoint 只读探针（1-2 次，fail-soft），结果 dragPathProbe。
   * withKind 不注入（拖源类型语义多样——div/li/img/自定义拖柄均有，隐式 activate 期望反而扭曲排序，v1 观察）。
   * 返回 { from:{x,y}, to:{x,y}, dragPathProbe:[{seg,x,y,hit}] }。
   */
  async dragGesture(s) {
    // 拖源定位 + X4 命中复核（rightClick 同款基础设施；成功判定只有 'pass'——
    // 'success'（best 已消失）对 drag 是硬失败：源都不在了拖拽无从发起）
    const sr = await this.requireLocated(s.target);
    const srcRect = sr.best.rect;
    const sx = srcRect.x + Math.floor(srcRect.w / 2), sy = srcRect.y + Math.floor(srcRect.h / 2);
    const sv = await this.ensureHittable(sr.best);
    if (sv !== 'pass') {
      throw flowErr('TARGET_NOT_FOUND', `drag 拖源命中复核未通过（${sv}）——拖源已消失/不可达，拖拽无从发起`, { hitMiss: true });
    }
    // 放置目标解析：{target:描述符} → 定位取中心（同走 X4）；{x,y} → 绝对坐标直用
    let tx, ty;
    if (s.to.target !== undefined) {
      const dr = await this.requireLocated(s.to.target);
      const dRect = dr.best.rect;
      tx = dRect.x + Math.floor(dRect.w / 2); ty = dRect.y + Math.floor(dRect.h / 2);
      const dv = await this.ensureHittable(dr.best);
      if (dv !== 'pass') {
        throw flowErr('TARGET_NOT_FOUND', `drag 放置目标命中复核未通过（${dv}）——放置目标已消失/不可达`, { hitMiss: true });
      }
    } else { tx = s.to.x; ty = s.to.y; }
    // screenX/screenY 忠实映射（mouseClick 同款公式；Runner 级 _screenOffset 缓存共享——select/scroll/rightClick 同源）
    if (this._screenOffset === undefined) {
      try {
        const off = await this.ev('(function(){ return [window.screenX || 0, window.screenY || 0, (window.outerHeight - window.innerHeight) || 0]; })()', 1500);
        this._screenOffset = Array.isArray(off) ? off : null;
      } catch { this._screenOffset = null; }
    }
    const off = this._screenOffset;
    const screen = (x, y) => ({ screenX: off ? off[0] + x : x, screenY: off ? off[1] + off[2] + y : y + 120 });
    const so = { sessionId: this.sessionId, timeoutMs: this.stepTimeout };
    const moveParams = (x, y) => Object.assign({ type: 'mouseMoved', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, screen(x, y));
    // hover 归位（button:'none'+buttons:0——mouseClick 前置 moved 同款）→ 按下（press 的 buttons 字段可省，G3e 过——显式带 1 自文档化）
    await this.client.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: sx, y: sy, button: 'none', buttons: 0, clickCount: 1, pointerType: 'mouse' }, screen(sx, sy)), so);
    await this.client.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, screen(sx, sy)), so);
    await sleep(DRAG_TRACE.HOLD_MS);
    // 按住段：SEGMENTS 段线性插值（planDragPath 单源——与 CLI drag 同函数），每条 mouseMoved 硬带 button:'left'+buttons:1（G3b 反证：缺位掩码全链退化普通 mousemove）
    const dragPathProbe = [];
    const trace = require('./drive').planDragPath({ x: sx, y: sy }, { x: tx, y: ty }, { steps: DRAG_TRACE.SEGMENTS });
    for (const pt of trace.points) {
      const x = pt.x;
      const y = pt.y;
      const i = pt.seg;
      await this.client.send('Input.dispatchMouseEvent', moveParams(x, y), so);
      if (DRAG_TRACE.PROBE_AT.includes(i)) { // 拖动期取证：轨迹中点 elementFromPoint 只读探针（fail-soft，诊断不阻塞）
        let hit = null;
        try {
          // /*dragProbe*/ 前缀标记：与四层定位表达式（X1 gate4 同用 elementFromPoint）在 fake ev/日志过滤里消歧
          hit = await this.ev(`/*dragProbe*/(function(){ var e = document.elementFromPoint(${x}, ${y}); return e ? (String(e.tagName).toLowerCase() + '|' + String(e.id || '')) : null; })()`, 2000);
        } catch { hit = null; } // 冻结期/跨域等取不到 → 记 null（取证失败也是证据形态）
        dragPathProbe.push({ seg: i, x, y, hit: hit === undefined ? null : hit });
      }
      if (i < DRAG_TRACE.SEGMENTS) await sleep(DRAG_TRACE.MOVE_GAP_MS);
    }
    // 收尾：落点 mouseReleased buttons:0（此后 dragend 即终点——DOM mouseup 被管线消费不再出现）
    await this.client.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, screen(tx, ty)), so);
    return { from: { x: sx, y: sy }, to: { x: tx, y: ty }, dragPathProbe };
  }
  async centerClick(target, clickCount, focusAssert, button, effectCond) {
    const r = await this.requireLocated(target);
    const rc = r.best.rect;
    const cx = rc.x + Math.floor(rc.w / 2), cy = rc.y + Math.floor(rc.h / 2);
    await this.noteViewportAdvisory(rc, cx, cy); // V202610130003 件1 前置视口校验（advisory only——不改派发行为，超视口仅 log.warn+挂 viewportAdvisory）
    // X4 容忍式命中复核（dispatch 前；point 策略分叉见 ensureHittable）
    const verdict = await this.ensureHittable(r.best);
    if (verdict === 'success') {
      // V202609300005 effect 守卫（存量暗雷终修）：'gone'→跳过派发的语义以**效果**为唯一权威——
      // 实弹 coords-probe 实证：深度 iframe 底栏按钮恒误判 gone（lastClickXY=null=从未派发）→ 步 ✓ 假绿。
      // 配 effect 的步：单次预检 effectCond——已达成→点击确已完成（合法跳过）；未达成→不跳过照常派发
      // （rect 为 locate 刚算的新鲜坐标；目标真消失则派发后 effect 轮询给诚实红，由 click case 的
      // effect-retry 接管）。无 effect 的步：存量跳过行为零改动（自移除目标族既有语义）。预检只单次求值，
      // 不做轮询——轮询仍归 click case 统一走。rightClick/type/select 调用不传 effectCond=零改动。
      if (effectCond) {
        let achieved = false;
        try { achieved = (await this.checkCond(effectCond, 3000)) === true; } catch { achieved = false; } // 预检异常=按未达成处理（保守派发）
        if (achieved) { log.info('click', `X4 复核 gone→跳过派发（effect 预检已达成——点击确已完成，合法跳过）`); return r; }
        log.info('click', `X4 复核 gone 但 effect 预检未达成——不跳过照常派发（假 gone 嫌疑：深度 iframe 坐标空间误判族；派发坐标=locate 新鲜 rect）`);
      }
      return r; // 判成功跳过 dispatch（best 已移除——点击已产生效果，如点了会关菜单的项）
    }
    await this.mouseClick(cx, cy, clickCount, button);
    // X4 post 复核（实验开关默认关：_meta.postVerify===true / CLI --post-verify）：点击后 best 仍在原位 → 可能未生效（假绿信号，仅告警不失败）
    if (this.postVerify) {
      try {
        const v2 = await this.verifyHit(r.best);
        if (v2 === 'covered') {
          const msg = `post 复核：点击后元素仍在原位且命中测试偏离（可能未生效——实验性 postVerify）`;
          this.postWarnings.push(`步骤点击 ${String(r.best.text || r.best.tag).slice(0, 24)}：${msg}`);
          log.warn('click', msg);
        }
       } catch { /* post 尽力而为 */ }
    }
    // P0-3 可选焦点断言（opt-in：click 步骤显式 focusAssert:true 才启用——示例ERP命令型 click 不适用，不能默认开）：
    // dispatch 完成 sleep 120 后读 document.activeElement 的 id||tagName，与定位结果 best.id||best.tag 比对，
    // 不符 → CLICK_FOCUS_FAILED（点击落空/焦点被别处抢走的显性红灯，替代「✓ 但没聚焦」假绿）
    if (focusAssert) {
      await sleep(120);
      const got = await this.ev(`(function(){ var e = document.activeElement; return e ? (String(e.id || '') + '|' + String(e.tagName || '').toLowerCase()) : null; })()`, 2000);
      const parts = String(got || '|').split('|');
      const wantId = r.best.id || '', wantTag = String(r.best.tag || '').toLowerCase();
      const ok = wantId ? parts[0] === wantId : parts[1] === wantTag;
      if (!ok) throw flowErr('CLICK_FOCUS_FAILED', `点击后焦点断言失败：activeElement=${got || '（读不到）'} 期望 ${wantId ? '#' + wantId : '<' + wantTag + '>'}`);
    }
    return r;
  }
  /** type 重试「已聚焦跳过重击」廉价判据（V202609290001，fail-soft）：
   *  只读 document.activeElement 与 target 描述符中可廉价核对的字段——id（精确）→ domPath（CSS 选择器
   *  matches，与定位侧 querySelector 语义同源）→ tag（含数组形态），优先级同 P0-3 焦点断言语义。
   *  三者皆缺（如纯 text / grid / point 定位）或 framePath 在位（activeElement 跨 frame 不可信）→ 'unknown'：
   *  调用方按未聚焦处理（保持存量行为，绝不为此做昂贵定位或跨 frame 探测）。
   *  返回 'yes' 才跳过 centerClick；'no'/'unknown'/异常一律照旧点击（保守方向，宁多击不漏击）。
   *  iframe 目标说明（V202609290002）：目标在 iframe 内时顶层 activeElement 是 IFRAME 元素，id/domPath/tag
   *  比对必落 'no' → 照旧 centerClick（保守正确，帧感知聚焦优化留待有实测需求再做）。 */
  async isTargetFocused(target) {
    if (this.framePath) return 'unknown';
    const wantId = target && target.id !== undefined ? String(target.id) : '';
    const wantPath = target && target.domPath !== undefined ? String(target.domPath) : '';
    const wantTags = target && target.tag !== undefined
      ? [].concat(target.tag).map((t) => String(t).toLowerCase()) : [];
    if (!wantId && !wantPath && !wantTags.length) return 'unknown';
    try {
      const r = await this.ev(`(function(){
        var el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return 'no';
        var wantId = ${JSON.stringify(wantId)}, wantPath = ${JSON.stringify(wantPath)}, wantTags = ${JSON.stringify(wantTags)};
        if (wantId) return (String(el.id || '') === wantId) ? 'yes' : 'no';
        if (wantPath) { try { return el.matches(wantPath) ? 'yes' : 'no'; } catch (e) { return 'unknown'; } }
        if (wantTags.length) return (wantTags.indexOf(String(el.tagName || '').toLowerCase()) !== -1) ? 'yes' : 'no';
        return 'unknown';
      })()`, 2000);
      return (r === 'yes' || r === 'no') ? r : 'unknown';
    } catch { return 'unknown'; }
  }
  /**
   * 【可选工具，默认不启用——V202609080010 立场反转】emulate DPR（Emulation.setDeviceMetricsOverride）。
   * 仅 flow 显式含 emulate 步骤时才走这里；回放启动不再自动施加（实测推翻 DPR 幽灵菜单因果，
   * 且 emulate 有视口缩小副作用——用户实测页面缩到 2/3）。用完须恢复（自建标签自关即无残留；
   * --target 模式请显式恢复原 DPR 或 clearDeviceMetricsOverride）。
   */
  async applyDpr(dpr) {
    const m = await this.client.send('Page.getLayoutMetrics', {}, { sessionId: this.sessionId });
    const vp = m.cssLayoutViewport || {};
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width: vp.clientWidth || 0, height: vp.clientHeight || 0, deviceScaleFactor: dpr, mobile: false,
    }, { sessionId: this.sessionId });
  }
  async dispatchKey(keySpec) {
    const { mask, mods, name, valid } = parseKeyModifiers(keySpec);
    if (!valid) throw flowErr('FLOW_INVALID', `key 格式非法：${keySpec}（支持 修饰键+主键，如 Control+S）`);
    const known = KEY_CODES[name];
    const isChar = name.length === 1 && /[a-zA-Z0-9]/.test(name);
    const vk = known ? known[0] : (isChar ? name.toUpperCase().charCodeAt(0) : 0);
    const codeName = known ? known[1] : (isChar && /[a-z]/i.test(name) ? 'Key' + name.toUpperCase() : '');
    // modifiers 位掩码单点注入：本组合键的全事件（修饰键按下/抬起 + 主键 keydown/keyup）一律携带，
    // 组合键（Control+A 等）借此生效；单键 mask=0 = CDP 默认值，行为零改动（快赢 V202609120001）
    const send = (params) => this.client.send('Input.dispatchKeyEvent', Object.assign({ modifiers: mask }, params), { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
    for (const md of mods) await send({ type: 'rawKeyDown', key: MODIFIERS[md][1], windowsVirtualKeyCode: MODIFIERS[md][0], code: MODIFIERS[md][1] });
    const shifted = mods.includes('Shift');
    const textVal = isChar ? (shifted ? name.toUpperCase() : name.toLowerCase()) : (name === 'Enter' ? '\r' : undefined);
    if (known || isChar) {
      await send(textVal !== undefined
        ? { type: 'keyDown', key: name, text: textVal, unmodifiedText: textVal, windowsVirtualKeyCode: vk, code: codeName }
        : { type: 'rawKeyDown', key: name, windowsVirtualKeyCode: vk, code: codeName });
      await send({ type: 'keyUp', key: name, windowsVirtualKeyCode: vk, code: codeName });
    } else {
      await send({ type: 'keyDown', key: name, windowsVirtualKeyCode: name.charCodeAt(0), text: name });
      await send({ type: 'keyUp', key: name, windowsVirtualKeyCode: name.charCodeAt(0) });
    }
    for (let i = mods.length - 1; i >= 0; i--) await send({ type: 'keyUp', key: MODIFIERS[mods[i]][1], windowsVirtualKeyCode: MODIFIERS[mods[i]][0], code: MODIFIERS[mods[i]][1] });
  }
  /** #127 V2 cond 条件求值（单次，不轮询）：when 三形态——cond 走 checkCond（与 wait/assert 同文法）、
   *  expr 走只读 Runtime.evaluate（__vars 注入变量作用域）、var 走 Node 侧变量比较。
   *  异常/未定义变量一律诚实红（不静默当 false——分支静默走错比红更贵）。 */
  async evalWhen(when, budgetMs) {
    if (!when || typeof when !== 'object') throw flowErr('FLOW_INVALID', 'cond.when 缺失/非法');
    const budget = Math.min(Math.max(1, Number.isFinite(budgetMs) ? budgetMs : EVAL_TIMEOUT_DEFAULT_MS), EVAL_TIMEOUT_MAX_MS);
    if (when.cond !== undefined) return (await this.checkCond(when.cond, budget)) === true;
    if (when.expr !== undefined) {
      const bad = evalSandboxViolation(when.expr);
      if (bad) throw flowErr('E_POLICY_DENIED', `cond.when.expr 触发只读沙箱拒绝：${bad}（禁 process/require/fs/child_process/module 与 eval/Function/import()）`);
      try { return !!(await this.ev(buildEvalExpr(when.expr, this.vars), budget, { awaitPromise: true })); }
      catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        if (e && (e.code === 'STEP_TIMEOUT' || /超时|timed out/i.test(msg))) throw flowErr('EVAL_TIMEOUT', `cond.when.expr 求值超时（${budget}ms 预算）：${msg}`);
        throw flowErr('EVAL_FAILED', `cond.when.expr 求值失败：${msg}`);
      }
    }
    if (when.var !== undefined) return condVarMatch(when, this.vars);
    throw flowErr('FLOW_INVALID', 'cond.when 须恰居其一：cond / expr / var');
  }
  async step(s, timeoutMs) {
    this.stepTimeout = timeoutMs;
    // #126 步2：操作类步骤唯一性闸门默认开（单点注入在此——所有 target 消费路径（含 drag/scroll）同源；
    // 显式 target.unique / target.nth / 步骤级 unique 优先，浅拷贝不改 flow 原对象）
    s = withUnique(s, this.flowMeta);
    switch (s.action) {
      case 'goto': {
        await this.client.send('Page.navigate', { url: s.url }, { sessionId: this.sessionId });
        const deadline = Date.now() + timeoutMs;
        let readyRs = null; // 就绪后的 readyState；challenge 闸门放循环外（不得被「冻结轮询重试」catch 吞掉）
        while (Date.now() < deadline) {
          await sleep(300);
          try {
            const rs = await this.ev('document.readyState', 2000);
            if (rs === 'complete' || rs === 'interactive') {
              // V202609100002 F2 视口对齐重申：emulate 施加于 goto 前会被导航重置（playbook 自家登记）——
              // 每 goto 后廉价校验 innerWidth 与声明 width 偏差 >2px 时重施加 override（1 次 evaluate 开销）
              if (this.viewport) {
                try {
                  const iw = await this.ev('window.innerWidth', 1500);
                  // V202609280001 floor 重申分支（viewportMin 地板语义）：只托底不缩放——实际宽 <min-2 才重施加
                  if (this.viewportFloor && Number.isFinite(iw) && iw < this.viewport.width - 2) {
                    await this.client.send('Emulation.setDeviceMetricsOverride',
                      { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 0, mobile: false },
                      { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
                    log.warn('flow', `视口地板重申：goto 后实际 innerWidth=${iw} < min ${this.viewport.width}（floor 只托底不缩放）——已重施加 override`);
                  } else if (!this.viewportFloor && Number.isFinite(iw) && Math.abs(iw - this.viewport.width) > 2) {
                    await this.client.send('Emulation.setDeviceMetricsOverride',
                      { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 0, mobile: false },
                      { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
                    log.warn('flow', `视口对齐重申：goto 后实际 innerWidth=${iw} 偏离声明 ${this.viewport.width}（>2px）——已重施加 override`);
                  }
                  // V202610190002 高度地板重申（_meta.viewportMinHeight 声明时 viewport.height>0；与宽度维度独立判定）：
                  // 高度维度只托底不缩放——实际高 <minH-2 才重施加（宽度-only flow viewport.height=0 恒跳过，零回归）
                  if (this.viewportFloor && this.viewport.height > 0) {
                    try {
                      const ih = await this.ev('window.innerHeight', 1500);
                      if (Number.isFinite(ih) && ih < this.viewport.height - 2) {
                        await this.client.send('Emulation.setDeviceMetricsOverride',
                          { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 0, mobile: false },
                          { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
                        log.warn('flow', `视口高度地板重申：goto 后实际 innerHeight=${ih} < min ${this.viewport.height}（floor 只托底不缩放）——已重施加 override`);
                      }
                    } catch (e) { log.warn('flow', `视口高度地板校验失败（fail-soft，不阻塞 goto）：${e.message}`); }
                  }
                } catch (e) { log.warn('flow', `视口对齐校验失败（fail-soft，不阻塞 goto）：${e.message}`); }
              }
              readyRs = rs;
              break;
            }
          } catch { /* 冻结轮询重试 */ }
        }
        if (!readyRs) throw flowErr('NAV_FAILED', `导航后 readyState 未就绪（${timeoutMs}ms）：${s.url}`);
        await this.challengeGate(s.url); // C4（#124）：导航就绪后 challenge 后置检查（循环外——阻断异常不得被重试 catch 吞）
        return readyRs;
      }
      case 'wait':
        if (s.text !== undefined) {
          // P0 wait 同链（2026-09-18 失败根治引擎批一）分流点：带 container 修饰 → buildLocateExpr 全链路
          // （语法糖升级而非替换）；无 container → TEXT_EXISTS_V2 两级漏斗原路径（存量 flow 零破坏）
          if (s.container !== undefined) return this.textLocateWait(s.text, s.container, timeoutMs);
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (await this.textExistsWait(s.text, 2000)) { await this.recordAnchor({ text: s.text }); return true; } // X2 两级漏斗（幽灵模板文本不再假绿）+ Q2 锚点快照
            await sleep(500);
          }
          throw flowErr('ASSERT_FAILED', `等待文本未出现（${timeoutMs}ms）：${s.text}`);
        }
        if (s.urlContains !== undefined) {
          const r = await this.waitCond({ url: { contains: s.urlContains } }, timeoutMs); // 表单状态锚定（含 iframe 遍历）
          await this.recordAnchor({ urlNeedle: s.urlContains }); // Q2：url 型 wait 成功也记锚点
          return r;
        }
        if (s.cond !== undefined) {
          const r = await this.waitCond(s.cond, timeoutMs);
          if (s.cond.url !== undefined) await this.recordAnchor({ urlNeedle: s.cond.url.contains }); // Q2：cond.url 成功记锚点
          return r;
        }
        await sleep(s.ms || 0);
        return true;
      case 'probe': {
        const rs = await this.ev('document.readyState', Math.min(timeoutMs, 3000));
        if (rs !== 'complete' && rs !== 'interactive') throw flowErr('STEP_TIMEOUT', `轻探针未就绪：readyState=${JSON.stringify(rs)}`);
        return rs;
      }
      case 'emulate': await this.applyDpr(s.dpr); return s.dpr; // 可选工具：仅显式步骤时施加
      case 'click': {
        // V202609300002 click 步有界重试（type 步 ：775-800 范式同款：有界次数+退避+步预算裁剪不睡穿）：
        // retry 默认 1（不重试——存量 flow 行为零改动）；下拉族配 2-3。重试对象=centerClick 抛错（定位瞬态
        // 失败/X4 复核 blocked 等）。
        // V202609300003 效果感知重试（gate-verify-retry 三明治引擎化）：步级可选 effect={cond, timeoutMs?}——
        // 派发成功（X4 过）后用现有 cond 求值路径（checkCond）轮询 effect.cond 至 effect.timeoutMs（缺省 3000，
        // 上限 10000，窗口吃步预算受裁剪）：达成→步成功；未达→共用 retry 预算（clickRetryBackoff 退避→重击
        // →再验效果）。效果未达 ≠ 派发失败：错误类型分开——最后一次失败若为派发异常仍走原 TARGET_NOT_FOUND
        // 路径；派发全成而效果始终未达 → EFFECT_NOT_ACHIEVED（消息含 cond 求值状态摘要——点击被应用静默吞
        // （禁用窗/guard）或效果锚漂移嫌疑）。实弹依据：inventory-lock 步骤 16 闸门后 0.5s 即点击，AllowEdit
        // 解锁命令在途→Guard A 静默吞击→菜单不创建（失败报告 deepInteract 三证据定性，V202609300003）。
        const attempts = Math.max(1, Math.min(Number.isInteger(s.retry) ? s.retry : 1, 3));
        const deadline = Date.now() + timeoutMs;
        // V202609300016 原语一 gate：opt-in 步级 gate=<正整数ms>——dispatch 前用与点击完全相同的
        // target 描述符循环定位至 ok 或超时。kind 注入单点提升（clickTarget 一次 withKind、gate 与
        // centerClick 共享同一产物——「完全相同描述符」的机制保证；withKind 幂等纯函数，无 gate 时
        // 提升零行为变化）。「语法糖非新语义」：手写等价物（wait cond.element 同描述符闸门步+点击步）
        // 继续合法。预算=min(声明 gate, 步预算)——不睡穿步超时（type/click retry 同款纪律），裁剪时
        // log.info 显性化。
        const clickTarget = withKind(s.target, 'click', this.flowMeta);
        if (s.gate !== undefined) {
          const gateBudget = Math.min(s.gate, timeoutMs);
          if (gateBudget < s.gate) log.info('click', `gate ${s.gate}ms 超过步预算——按 ${gateBudget}ms 裁剪（不睡穿步超时）`);
          await this.gateWait(clickTarget, gateBudget);
        }
        const effTimeout = (s.effect && Number.isInteger(s.effect.timeoutMs)) ? s.effect.timeoutMs : 3000;
        let lastErr = null;
        let effSummary = null; // effect.cond 求值状态摘要（累计跨重试，EFFECT_NOT_ACHIEVED 消息用）
        let effEvals = 0, effLastError = null;
        let realDispatch = 0; // V202609300014 真实派发计数（mouseClick 派发即替换 lastClickXY 引用——身份比对；attempts 是尝试数，含 gone 跳过/合法跳过）
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const preXY = this.lastClickXY; // V202609300014 派发计数：centerClick 前快照（派发=引用被 mouseClick 替换）
            const r = await this.centerClick(clickTarget, s.dbl ? 2 : 1, !!s.focusAssert, undefined, s.effect ? s.effect.cond : undefined); // dbl:true=双击（self-heal 实测补实现）；focusAssert:true=P0-3 点击后焦点断言（opt-in）；clickTarget=withKind kind 注入产物（V202609300016 提升单点：gate 与 centerClick 共享同一描述符）；effectCond 传入=centerClick 的 'gone' 跳过派发受 effect 预检守卫（V202609300005）
            if (this.lastClickXY && this.lastClickXY !== preXY) realDispatch++;
            if (!s.effect) return r.strategy;
            // 效果轮询：窗口=min(effect.timeoutMs, 剩余步预算)——轮询+节距吃步预算，永不睡穿步超时
            const effDeadline = Math.min(Date.now() + effTimeout, deadline);
            let achieved = false;
            while (Date.now() < effDeadline) {
              effEvals++;
              try {
                if (await this.checkCond(s.effect.cond, Math.min(3000, Math.max(1, effDeadline - Date.now())))) { achieved = true; break; }
                effLastError = null;
              } catch (e) { effLastError = e; } // 冻结轮询重试（waitCond 同款哲学）
              if (effDeadline - Date.now() <= 500) break; // 剩余不足一轮节距
              await this.sleepFn(Math.min(500, effDeadline - Date.now()));
            }
            effSummary = `effect.cond 求值 ${effEvals} 次，最后结果=${effLastError ? '异常(' + String((effLastError && effLastError.message) || effLastError).slice(0, 80) + ')' : 'false'}`;
            if (achieved) return r.strategy;
            if (attempt >= attempts) break; // 次数用尽 → EFFECT_NOT_ACHIEVED
            const remainEff = deadline - Date.now();
            const planEff = clickRetryBackoff(attempt, remainEff);
            if (planEff.skip) { log.info('click', `第 ${attempt}/${attempts} 次点击效果未达（${effSummary}）——步预算不足（剩余 ${remainEff}ms < 退避 ${planEff.backoff}ms+重试预留 ${CLICK_RETRY_RESERVE_MS}ms）：跳过重击直接失败，避免睡穿步超时`); break; }
            log.info('click', `第 ${attempt}/${attempts} 次点击效果未达（${effSummary}）——退避 ${planEff.backoff}ms 后重击再验`);
            await this.sleepFn(planEff.backoff);
          } catch (e) {
            lastErr = e;
            if (attempt >= attempts) break;
            const remain = deadline - Date.now();
            const plan = clickRetryBackoff(attempt, remain);
            if (plan.skip) { log.info('click', `第 ${attempt}/${attempts} 次尝试失败（${e.code || 'ERR'}）——步预算不足（剩余 ${remain}ms < 退避 ${plan.backoff}ms+重试预留 ${CLICK_RETRY_RESERVE_MS}ms）：跳过重试直接失败，避免睡穿步超时`); break; }
            log.info('click', `第 ${attempt}/${attempts} 次尝试失败（${e.code || 'ERR'}：${String((e && e.message) || e).slice(0, 80)}）——退避 ${plan.backoff}ms 后重试`);
            await this.sleepFn(plan.backoff);
          }
        }
        if (s.effect && !lastErr) { // 派发全成而效果始终未达——与派发失败错误类型分开（派发失败走 lastErr 原路径）
          /* V202609300014 消息可观测性：报真实派发数+末次坐标+0 派发分叉——实锤教训：终验 933 轮消息文本
           * 「2 次派发」被读作"未派发另案"，而 targetState.lastClickXY=(828,858) 真派发在案，误导归因半小时。
           * V202610130003 件1 失败诊断增强：最近一次 centerClick 的视口越界 advisory 在位时，消息显式追加
           * 「元素坐标 vs 视口尺寸」对照（rect 中心/越界轴）——替代笼统 "did not become interactive" 归因面。 */
          const xyNote = this.lastClickXY ? `，末次派发 @${this.lastClickXY.x},${this.lastClickXY.y}` : '';
          const vpa = this.viewportAdvisory;
          const vpNote = vpa ? `；⚠ 元素 rect(${vpa.rect.x},${vpa.rect.y},${vpa.rect.w},${vpa.rect.h}) vs 视口(${vpa.iw}×${vpa.ih})，中心(${vpa.center.x},${vpa.center.y})，越界轴：${vpa.axes.join('/')}——点击可能落在视口外` : '';
          const causeNote = realDispatch === 0
            ? '引擎 0 真实派发（gone 跳过路径——读 X4 复核 gone 日志诊断）'
            : '点击已真实派发但效果未现（应用侧吞击嫌疑：禁用窗/guard/业务前置，弹窗阻断看终态截图与 overlaysByDoc；或效果锚漂移——末次坐标另见 targetState.lastClickXY）';
          throw flowErr('EFFECT_NOT_ACHIEVED', `点击效果未达成（真实派发 ${realDispatch}/${attempts} 次${xyNote}${vpNote}；${effSummary || '（无求值记录）'}）——${causeNote}，建议读失败报告 deepInteract 现场`);
        }
        throw lastErr;
      }
      // rightClick（V202609130002）：复用 click 全部基础设施（四层定位/X4 命中复核/中心坐标/焦点逻辑），
      // 仅按键参数不同（mousePressed/mouseReleased button:'right'、buttons 位掩码 2）——Chromium 于右键
      // mouseup 后自动派发 contextmenu（isTrusted=true），右键菜单场景录制↔回放 round-trip 闭环；恒单击
      case 'rightClick': return (await this.centerClick(withKind(s.target, 'rightClick', this.flowMeta), 1, false, 'right')).strategy;
      // drag（V202609170002）：路线 A 纯鼠标序列+buttons:1 按住段（G3 两连过实证，见 dragGesture 注释）——
      // withKind 不注入（拖源类型语义多样，v1 观察）；dragPathProbe=拖动期 elementFromPoint 取证诊断
      case 'drag': return this.dragGesture(s);
      case 'type': {
        // P0-1 写后读断言（V202609130001）：insertText 后 probe document.activeElement（insertText 真实落点，
        // 非 s.target——焦点漂移时两者可能不一致）的 value/innerText 是否**包含** text 首 20 字符
        // （千字级全等在 ProseMirror normal form 下不可靠，用 contains）。失败重聚焦重试 3 次，全败 → TYPE_VERIFY_FAILED。
        // V202609290002 真根因定案（2026-09-29 --keep-tab 帧遍历探针实锤）：旧探针顶层 document 写死——
        //   弹层 iframe（layui-layer-iframe5）内输入框持焦时，顶层 activeElement 是 IFRAME 元素、value 恒空
        //   → 恒 len:0 假阴性（TYPE_VERIFY_FAILED 误报「文本未落」，实际 insertText 一直正常落入；09-13
        //   P0-1 上线后 iframe 内 type 再未通过）。修复=探针帧遍历化：buildInsertVerifyExpr 逐文档
        //   activeElement contains（跨域跳过，任一命中即 ok，未命中给逐文档诊断）。
        // V202609290001 保留（仍有效硬化，churn 表述随根因定案作废）：
        //   ①已聚焦跳过重击（顶层持焦时少一次无谓点击）②失败退避+预算裁剪（防重击 ≈5s×attempt 吃满
        //   步超时——inventory-lock STEP_TIMEOUT 16005ms 实证；退避 2500×attempt#、帽 10s，预算不足
        //   直接 break 出 TYPE_VERIFY_FAILED 携 lastSeen，不许睡穿 STEP_TIMEOUT）。仅 target 路径生效，
        //   无 target（先 click 聚焦形态）行为不变。
        const text = String(s.text);
        const needle = text.slice(0, 20);
        const deadline = Date.now() + this.stepTimeout;
        let lastSeen = null;
        let budgetShort = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (s.target) { // type 带 target 才注入（无 target=先 click 聚焦形态，kind 只约束定位不约束已聚焦元素）
            const focused = await this.isTargetFocused(s.target); // 廉价 activeElement 探针（fail-soft；iframe 目标恒 'unknown'，见其注释）
            if (focused === 'yes') {
              log.info('type', `attempt ${attempt}/3：目标已持焦（activeElement 命中 target 描述符）——跳过 centerClick 直接 insertText（避免无谓重击扰动输入焦点）`);
            } else {
              await this.centerClick(withKind(s.target, 'type', this.flowMeta));
            }
          }
          await this.client.send('Input.insertText', { text }, { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
          let ok = false;
          try {
            lastSeen = await this.ev(buildInsertVerifyExpr(needle), 3000); // 帧遍历写后读（V202609290002）
            ok = lastSeen === 'ok';
          } catch (e) { lastSeen = `probe 异常：${String((e && e.message) || e).slice(0, 60)}`; }
          if (ok) return text.length;
          if (attempt < 3) {
            const backoff = Math.min(TYPE_RETRY_BACKOFF_MS * attempt, TYPE_RETRY_BACKOFF_CAP_MS);
            const remain = deadline - Date.now();
            if (remain < backoff + TYPE_RETRY_RESERVE_MS) {
              budgetShort = true;
              log.info('type', `写后读断言失败（第 ${attempt} 次；lastSeen=${String(lastSeen).slice(0, 160)}）——步预算不足（剩余 ${remain}ms < 退避 ${backoff}ms+重试预留 ${TYPE_RETRY_RESERVE_MS}ms）：跳过退避直接出 TYPE_VERIFY_FAILED，避免睡穿 STEP_TIMEOUT`);
              break;
            }
            log.info('type', `写后读断言失败（第 ${attempt} 次；lastSeen=${String(lastSeen).slice(0, 160)}）——退避 ${backoff}ms 后重试（重试前重查 activeElement 决定是否重击）`);
            await this.sleepFn(backoff);
          }
        }
        throw flowErr('TYPE_VERIFY_FAILED', `type 写后读断言${budgetShort ? '（步预算不足，提前放弃重试）' : ' 3 次未过'}：各文档 document.activeElement 均未包含目标文本首 ${needle.length} 字符（最后探值=${String(lastSeen).slice(0, 300)}）——焦点漂移/输入框未聚焦嫌疑`);
      }
      case 'key': await this.dispatchKey(s.key); return s.key;
      case 'select': {
        await this.centerClick(withKind(s.target, 'select', this.flowMeta)); // 目标定位注入 selectcontrol；下方选项二次定位不注入（自定义下拉 tag 形态未知，误降权风险大于收益——设计 §3.5）
        await sleep(400);
        const opt = await this.requireLocated({ text: String(s.value) });
        const ov = await this.ensureHittable(opt.best); // X4 同闸：select 的 opt 点击
        if (ov === 'blocked') throw flowErr('TARGET_NOT_FOUND', `select 选项命中复核未通过（hitMiss）`, { hitMiss: true });
        if (ov === 'pass') {
          const rc = opt.best.rect;
          await this.mouseClick(rc.x + Math.floor(rc.w / 2), rc.y + Math.floor(rc.h / 2));
        } // ov === 'success'：选项已消失 → 判成功跳过点击
        return opt.best.text;
      }
      case 'scroll': {
        let x = 400, y = 300;
        if (s.target) {
          const r = await this.requireLocated(s.target);
          const sv = await this.ensureHittable(r.best); // X4 同闸：scroll target
          if (sv === 'blocked') throw flowErr('TARGET_NOT_FOUND', `scroll 目标命中复核未通过（hitMiss）`, { hitMiss: true });
          if (sv === 'pass') { x = r.best.rect.x + r.best.rect.w / 2; y = r.best.rect.y + r.best.rect.h / 2; }
        }
        await this.client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: s.dx || 0, deltaY: s.dy || 0, pointerType: 'mouse' }, { sessionId: this.sessionId, timeoutMs: this.stepTimeout });
        return { x, y };
      }
      case 'assert': {
        if (s.text !== undefined) {
          // V202609180003 assert text 轮询化（oracle 归因批，三个缺陷一次修）：
          // ①单发检查与异步业务效果竞速——实弹步骤 35 以 4ms 假红（确认→提取表单拆除→明细网格刷新的服务端
          //   往返空窗内查询），声明的 timeoutMs 此前根本不被本分支消费（3000 只是 evaluate 的 CDP 超时）；
          // ②原 TEXT_EXISTS_SRC 是 V1 单级检查（无 gate4），0×0/隐藏文本也算命中——b2f1b 同步骤 5ms「过」
          //   实为假绿（命中尚未拆除的提取表单自身行文本），同一步骤一侧假绿一侧真红=无判别力；
          // ③修复=对齐 wait text：轮询循环 + textExistsWait（V2 两级漏斗），deadline=timeoutMs，超时才红。
          //   语义=「效果断言在窗口内最终为真」——不掩盖失败，只不再与渲染/网络竞速。
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (await this.textExistsWait(s.text, Math.min(2000, deadline - Date.now()))) return s.text;
            await sleep(400);
          }
          throw flowErr('ASSERT_FAILED', `断言失败：页面无文本「${s.text}」（${timeoutMs}ms 轮询窗口耗尽）`);
        }
        if (s.cond !== undefined) {
          if (!(await this.checkCond(s.cond, 5000))) throw flowErr('ASSERT_FAILED', `断言失败：条件未满足 ${JSON.stringify(s.cond).slice(0, 120)}`);
          return Object.keys(s.cond)[0];
        }
        return (await this.requireLocated(s.target)).strategy;
      }
      case 'screenshot': {
        const data = await require('./cdp-core').screenshot(this.client, this.sessionId, { timeoutMs });
        // 文件命名时间戳单源 lib/time.js（配置时区，默认 UTC+8）
        const name = `${String(s.name || 'step')}-${time.formatStamp()}.png`.replace(/[^\w.-]/g, '_');
        const file = path.join(paths.EVENTS_DIR, name);
        paths.ensureDir(paths.EVENTS_DIR);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return file;
      }
      case 'frame': this.framePath = s.path; return s.path;
      /* ── #127 V2 四原语（执行语义；跳步/循环调度在 runFlow 游标层） ── */
      case 'eval': {
        // 只读 JS 表达式求值：静态沙箱闸门（validateFlow 同一纯函数；直连 Runner 亦守门）+ 预算裁剪。
        // 返回 undefined/unserializable 统一记 null（变量可消费、证据可落盘）。
        const expr = String(s.expr);
        const bad = evalSandboxViolation(expr);
        if (bad) throw flowErr('E_POLICY_DENIED', `eval 只读沙箱拒绝：${bad}（禁 process/require/fs/child_process/module 与 eval/Function/import()——只读纪律）`);
        const budget = evalBudgetOf(s);
        let value;
        try { value = await this.ev(buildEvalExpr(expr, this.vars), budget, { awaitPromise: true }); }
        catch (e) {
          const msg = String((e && e.message) || e).slice(0, 200);
          if (e && (e.code === 'STEP_TIMEOUT' || /超时|timed out/i.test(msg))) throw flowErr('EVAL_TIMEOUT', `eval 表达式超时（${budget}ms 预算）：${msg}`);
          throw flowErr('EVAL_FAILED', `eval 表达式求值失败：${msg}`);
        }
        const normalized = value === undefined ? null : value;
        if (value === undefined) log.warn('eval', `eval 返回 undefined/unserializable——按 null 记入（var=${s.var || '（未命名，仅取证）'}）`);
        if (s.var !== undefined) this.vars[s.var] = normalized;
        return normalized;
      }
      case 'set': {
        if (!Object.prototype.hasOwnProperty.call(s, 'value')) throw flowErr('FLOW_INVALID', 'set 缺 value');
        this.vars[s.var] = s.value; // 插值已在 runFlow 步骤执行时完成（字符串 {{var}}/对象递归）
        return s.value;
      }
      case 'cond': {
        // 只求值不跳转：调度器消费 {hit, jump}（Runner 保持无游标职责，可单测）
        const hit = await this.evalWhen(s.when, evalBudgetOf(s));
        return { hit, jump: s.jump };
      }
      case 'loop': {
        // 只解析循环规格：重复体执行/帧记账在 runFlow 游标层（Runner 不持有步骤表）
        let times = s.times;
        let items = null;
        if (s.over !== undefined) {
          const v = this.vars[s.over];
          if (!Array.isArray(v)) throw flowErr('FLOW_INVALID', `loop.over 变量 ${JSON.stringify(s.over)} 不是数组（got ${v === undefined ? '未定义' : typeof v}）——先用 set/eval 赋值数组`);
          if (v.length > MAX_LOOP_ITERATIONS) throw flowErr('LOOP_LIMIT_EXCEEDED', `loop.over 数组 ${v.length} 项 > 硬上限 ${MAX_LOOP_ITERATIONS}（受控循环纪律——分批或降规模）`);
          items = v;
          times = v.length;
        }
        if (!Number.isInteger(times) || times < 1) throw flowErr('FLOW_INVALID', `loop.times 非法：${JSON.stringify(times)}`);
        return { times, items, count: s.count, itemVar: s.itemVar, indexVar: s.indexVar };
      }
      default: throw flowErr('FLOW_INVALID', `未支持的原语：${s.action}`);
    }
  }
}

/* ── Q2 失败分诊器（Evidence Aggregator，V202609110001）：TARGET_NOT_FOUND 类失败的三路取证 ──
 * ① 锚点回探：最近一次成功 wait 的锚点（runner.waitAnchor）仍在当前页面 → 嫌疑集中当步目标；已消失 → upstream-broken 嫌疑
 * ② readyState 轻探针（2000ms 短超时，fail-soft）：区分环境冻结（renderer 无响应）
 * ③ 拒因聚合：rejected 中 L4（命中测试未中）类拒因 n 条 → 遮罩/前置条件嫌疑；候选 0 条 → 目标不存在/文本漂移嫌疑
 * 铁律：探测失败 ≠ 没有证据——probeStatus 各探测独立记录 ok/absent/timeout；probesFailed:true 时 confidence 强制降 low；
 * advice 一律「疑似」措辞；纯 advisory 不自动修复不重试（失败即停/redflag⑦ 哲学不破）。 */
async function diagnoseFailure(runner, err) {
  const evidence = [];
  const probeStatus = {};
  let probesFailed = false;

  // ② readyState 轻探针（2000ms 短超时，fail-soft）
  try {
    const rs = await runner.ev('document.readyState', 2000);
    probeStatus.readyStateProbe = 'ok';
    evidence.push(`页面 readyState=${JSON.stringify(rs)}（renderer 可响应）`);
  } catch {
    probeStatus.readyStateProbe = 'timeout';
    probesFailed = true;
    evidence.push('readyState 轻探针超时（renderer 无响应）——环境冻结嫌疑');
  }

  // ① 锚点回探（TEXT_EXISTS / location.href 短超时 2000ms，fail-soft try/catch）
  const anchor = runner && runner.waitAnchor;
  if (anchor) {
    let verdict = 'timeout';
    try {
      if (anchor.text !== undefined) {
        verdict = (await runner.textExists(anchor.text, 2000)) ? 'ok' : 'absent';
      } else if (anchor.urlNeedle !== undefined) {
        const cur = await runner.ev('location.href', 2000);
        verdict = String(cur || '').indexOf(anchor.urlNeedle) !== -1 ? 'ok' : 'absent';
      }
    } catch { verdict = 'timeout'; }
    probeStatus.anchorProbe = verdict;
    const anchorDesc = String(anchor.text !== undefined ? anchor.text : anchor.urlNeedle).slice(0, 24);
    if (verdict === 'ok') evidence.push(`锚点「${anchorDesc}」（步骤 ${anchor.stepIdx + 1}）仍在当前页面——嫌疑集中当步目标`);
    else if (verdict === 'absent') evidence.push(`锚点「${anchorDesc}」（步骤 ${anchor.stepIdx + 1}）已不在当前页面——上游断链嫌疑`);
    else { probesFailed = true; evidence.push(`锚点回探超时（锚点=步骤 ${(anchor.stepIdx || 0) + 1}）`); }
  } else {
    evidence.push('无 wait 锚点记录（失败发生于首个 wait 成功之前，锚点回探跳过）');
  }

  // ③ 拒因聚合
  const rejected = Array.isArray(err.rejected) ? err.rejected : [];
  const l4Count = rejected.filter((r) => String((r && r.rej) || '').indexOf('L4:') === 0).length;
  const candCount = Array.isArray(err.candidates) ? err.candidates.length : 0;
  if (l4Count > 0) evidence.push(`${l4Count} 条候选被命中测试拒（L4 拒因）——遮罩/前置条件嫌疑`);
  if (candCount === 0) evidence.push('目标文本产生 0 条候选——目标不存在/文本漂移嫌疑');
  if (err.hitMiss) evidence.push('X4 命中复核未通过（hitMiss）——目标仍在原位但中心命中无关元素');
  // container 硬收窄拒因分支（ora-5 设计步骤 2 §4.6）：not-found → 容器漂移嫌疑（upstream-broken 同族）；
  // 容器内 0 候选且容器外 N 条 → 目标不在声明容器内（target-changed 嫌疑）。纯 advisory 不改判失败。
  if (err.container) {
    if (!err.container.found) evidence.push(`container 未找到（form=${err.container.form}）——容器文本漂移/容器未渲染嫌疑（upstream-broken 同族）`);
    else if (err.container.scopedFound === 0 && err.container.outsideCount > 0) evidence.push(`容器内 0 候选、容器外 ${err.container.outsideCount} 条——目标不在声明容器内的嫌疑（target-changed）`);
  }

  // 判定（优先级：env-frozen > upstream-broken > ambiguity（遮罩/前置）> target-changed（文本漂移））
  let likely, confidence;
  if (probeStatus.readyStateProbe === 'timeout') { likely = 'env-frozen'; confidence = 'high'; }
  else if (probeStatus.anchorProbe === 'absent') { likely = 'upstream-broken'; confidence = 'high'; }
  else if (l4Count > 0 || err.hitMiss) { likely = 'ambiguity'; confidence = 'medium'; }
  else if (probeStatus.anchorProbe === 'ok') { likely = 'target-changed'; confidence = candCount === 0 ? 'high' : 'medium'; }
  else { likely = candCount === 0 ? 'target-changed' : 'ambiguity'; confidence = 'low'; }
  if (probesFailed) confidence = 'low'; // 铁律：探测失败 → confidence 强制降 low（证据不完整不冒充高置信）

  const adviceMap = {
    'env-frozen': '疑似环境冻结（renderer 无响应）——用 probe/watch 确认自愈后再重试，勿加大点击力度',
    'upstream-broken': '疑似上游断链（前序 wait 锚点已消失）——回看锚点步骤之后的页面变迁，补前置步骤/wait，勿先改定位器',
    'target-changed': '疑似目标已变化（文本漂移/元素移除）——对照录制事件流与 webapp.md 复核当步定位器',
    'ambiguity': '疑似遮罩/前置条件未满足（候选在但命中测试不过）——先截图确认面板/弹层状态，补前置而非改定位器',
  };
  return {
    likely,
    confidence,
    evidence,
    probeStatus,
    probesFailed,
    advice: adviceMap[likely] || '疑似定位层失败——读失败报告候选/拒因后按 §排障总纲分诊',
  };
}

/** P1-2（V202609130001）urlTrail 人类可读摘要：URL 序列截 pathname 拼接 + 乐观会话中间态检测。
 *  WEB: 检测逻辑：urlTrail 任意项 URL 含 `/c/WEB:`（chatgpt 乐观会话创建=消息已提交收单的证据）。 */
function summarizeUrlTrail(urlTrail) {
  const items = Array.isArray(urlTrail) ? urlTrail : [];
  const segs = [];
  for (const it of items) {
    const u = String((it && it.url) || it || '');
    if (!u) continue;
    let seg = u;
    try { seg = new URL(u).pathname; } catch { /* 非法 URL 原样截断 */ }
    segs.push(seg.slice(0, 80));
  }
  return { summary: segs.join(' → '), optimisticMigration: items.some((it) => String((it && it.url) || it || '').includes('/c/WEB:')) };
}

/** 失败报告（附录 A3）：JSON+终态截图落 tmpdata/flow-fail/；人读摘要由调用方打印 */
async function buildFailReport(flowFile, completed, index, step, err, runner) {
  if (runner) {
    try { err.stepUrl = await runner.ev('location.href', 2000); } catch { /* 现场不可读 */ }
  }
  const report = {
    format: 'chromeuse-failreport/1',
    flow: path.basename(String(flowFile || 'flow.json')),
    ok: false,
    completedSteps: completed,
    stoppedAt: { index, stepNo: index + 1, action: step.action, desc: step.desc || '', elapsedMs: err.elapsedMs || 0, url: err.stepUrl || null },
    error: { code: err.code || 'CDP_ERROR', message: String(err.message || err), kind: (err.code === 'TARGET_NOT_FOUND' || err.code === 'TARGET_AMBIGUOUS') ? 'target' : 'step' },
    attempts: err.attempts || [],
    candidates: err.candidates || [],
    urlTrail: err.urlTrail || [],
  };
  // P1-1c：wait 超时终态取证并入报告（waitCond 抛错前捕获；无则字段省略）
  if (err.terminalState) report.terminalState = err.terminalState;
  // P1-2：urlTrail 人类可读摘要 + 乐观会话迁移检测（WEB: 中间态=消息已提交收单）
  const trail = summarizeUrlTrail(err.urlTrail);
  if (trail.summary) report.urlTrailSummary = trail.summary;
  if (trail.optimisticMigration) report.optimisticMigration = true;
  if (runner) {
    try { report.targetState = { url: await runner.ev('location.href', 2000), readyState: await runner.ev('document.readyState', 2000), dpr: await runner.ev('window.devicePixelRatio', 2000) }; }
    catch { report.targetState = { note: '现场不可读（renderer 无响应）' }; }
    // V202609100002：失败报告补视口现场（实际 innerWidth/Height/dpr）+ 对齐标志——多分辨率排查的现场证据
    try {
      const vpj = await runner.ev('JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio})', 2000);
      if (vpj) report.targetState.viewport = JSON.parse(vpj);
    } catch { /* 冻结期留空 */ }
    if (runner.viewportAligned !== undefined) report.targetState.viewportAligned = !!runner.viewportAligned;
    if (runner.viewportSkipReason) report.targetState.viewportSkipReason = runner.viewportSkipReason; // V202609280001 用户在场 skip 时如实反映
    // V202610190002：高度地板（viewportMinHeight）声明的 flow 记录视口计划现场（declared/actual/below/模式）——
    // 仅声明高度维度时挂载（宽度-only flow runner.viewportPlan 未设置 → 存量失败报告零变化）
    if (runner.viewportPlan) report.targetState.viewportPlan = runner.viewportPlan;
    // V202609300002 深交互取证快照（P1 检测面，obs-4 实证族）：失败时自动追加一次只读 evaluate（~10ms）——
    // TOP 覆盖层计数 + 最近点击坐标 TOP 命中链 + 各同源文档菜单 UL 计数，落 targetState.deepInteract。
    // 零成本把「零响应」变成「可归因」；fail-soft（快照失败只记 err 摘要，绝不阻塞报告落盘/掩盖原失败）。
    try {
      const diRaw = await runner.ev(buildDeepInteractExpr(runner.lastClickXY), 2000);
      try { report.targetState.deepInteract = JSON.parse(diRaw); }
      catch { report.targetState.deepInteract = { raw: String(diRaw).slice(0, 300) }; }
    } catch (e) {
      try { report.targetState.deepInteract = { err: String((e && e.message) || e).slice(0, 120) }; } catch { /* targetState 现场不可读路径 */ }
    }
    if (runner.lastClickXY) report.targetState.lastClickXY = runner.lastClickXY; // V202609300004 点击坐标可观测性：失败报告暴露最近一次真实派发坐标（mouseClick 派发 press 时记录）
    // V202610130003 件1 失败诊断增强：最近一次 centerClick 视口越界 advisory 在位 → targetState.viewportDiagnostics
    // （元素 rect vs 视口尺寸/中心/越界轴）——与 targetState.viewport（iw/ih/dpr）同场对照，advisory 不改判失败。
    if (runner.viewportAdvisory) report.targetState.viewportDiagnostics = runner.viewportAdvisory;
    // V202609300017 M5 候选扩散诊断：失败步最近一次成功定位存在跨 frame 次优候选（Runner.noteAmbiguityRisk 挂载）→
    // 报告顶层 ambiguityRisk（advisory——「排序赌赢可能赌错」的定位现场，配合 M1/M2 静态机检收窄）
    if (runner.ambiguityRisk) report.ambiguityRisk = runner.ambiguityRisk;
    // Q2 失败分诊器（V202609110001）：TARGET_NOT_FOUND 类失败触发三路取证（锚点回探/readyState 轻探针/拒因聚合）。
    // 纯 advisory 字段，不改判失败；分诊器自身异常 fail-soft（诊断缺失绝不掩盖原失败现场）。
    if (err.code === 'TARGET_NOT_FOUND') {
      try { report.diagnosis = await diagnoseFailure(runner, err); }
      catch (e) { report.diagnosis = { note: `分诊器自身异常（fail-soft）：${String((e && e.message) || e).slice(0, 80)}` }; }
    }
    try {
      const data = await require('./cdp-core').screenshot(runner.client, runner.sessionId, { timeoutMs: 5000 });
      const file = path.join(paths.FLOW_FAIL_DIR, `flow-fail-${time.formatStamp()}.png`);
      paths.ensureDir(paths.FLOW_FAIL_DIR);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      report.screenshot = file;
    } catch { report.screenshot = null; }
  }
  const jsonFile = path.join(paths.FLOW_FAIL_DIR, `flow-fail-${time.formatStamp()}.json`);
  paths.ensureDir(paths.FLOW_FAIL_DIR);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  report.file = jsonFile;
  return report;
}

/* ── 回放前标签卫生 preflight（2026-09-18 oracle 归因批后续三件之③）──
 * oracle 归因实锤（V202609180003 同批）：多 ERP 标签并存互踢是网络类回放症状主因——4 标签期点击链
 * 5.2s/步 vs 清场 222ms/步（差 23 倍），playbook 已有标签卫生纪律（回放/清理全程 ERP 标签数 ≤2）。
 * 本处把「回放前标签计数告警」机制化：统计 type=page 且 URL 命中本应用 matchers（webapps/<app>/webapp.md
 * urlPatterns，matchers.js 分段锚定语义——非裸子串）的标签数，超阈值返回告警文案。
 * 纯 advisory：不改判定/不抛错/不阻断；webapp.md/matchers 缺失返回 null 跳过（fail-soft，
 * 正式拒绝由 attachAppSafety 的 APP_NOT_FOUND 安全阀负责，本层不重复）。接线点 = tools/cdp.js
 * flow replay 探活块（复用同一发 Target.getTargets 结果零额外往返；告警在回放开始前随 stdout 可见，
 * 失败路径也不丢——runFlow 失败返回不携带 warnings）。 */
const TAB_HYGIENE_THRESHOLD = 2; // 阈值出处：oracle 归因 V202609180003（4 标签 23 倍劣化实证）+ playbook 标签卫生纪律（ERP 标签 ≤2 = 用户长活标签 + 当前自建标签）

/** 纯函数：统计命中本应用 urlPatterns 的 page 标签数（targets=Target.getTargets().targetInfos 形状数组）。
 *  返回 { count, host }；host=告警文案显示主机（首个非通配 pattern 的 host[:port]；全通配时 null 由调用方回退 app slug）。 */
function countAppTabs(targets, urlPatterns) {
  const matchers = require('./matchers');
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t && t.type === 'page');
  if (!Array.isArray(urlPatterns) || !urlPatterns.length) return { count: 0, host: null };
  let host = null;
  for (const p of urlPatterns) { const pat = matchers.parsePattern(p); if (pat.ok && !pat.hostAny) { host = pat.raw.split('/')[0]; break; } }
  const count = pages.filter((t) => matchers.matchUrl(urlPatterns, t.url).matched).length;
  return { count, host };
}

/** preflight 入口：flow（读 _meta.app）+ targetInfos → 超阈值告警文案串；否则 null。同步纯逻辑，异常由调用方 fail-soft 兜底 */
function tabHygieneWarning(flow, targets) {
  const app = flow && flow._meta && flow._meta.app;
  if (!app || !Array.isArray(targets)) return null;
  let matchers = null;
  try {
    const appFile = path.join(paths.SKILL_ROOT, 'webapps', app, 'webapp.md');
    if (!fs.existsSync(appFile)) return null;
    matchers = require('./matchers').extractMatchersMd(fs.readFileSync(appFile, 'utf8'));
  } catch { return null; } // fail-soft：读不到/解析不了 → 跳过（安全阀另有 APP_NOT_FOUND 把关）
  const { count, host } = countAppTabs(targets, matchers && matchers.urlPatterns);
  if (count <= TAB_HYGIENE_THRESHOLD) return null;
  return `[preflight] 检测到 ${count} 个 ${host || app} 标签（阈值 ${TAB_HYGIENE_THRESHOLD}，多标签并存互踢=网络类症状主因，建议先清场——playbook 标签卫生纪律）`;
}

/** 纯函数：用户在场视口自适应决策（V202609280001，2026-09-28 用户裁定）。vp=flow._meta.viewport；
 *  otherPageCount=既有页签数（Target.getTargets 里 type=page 且排除本次自建标签与 --target 目标标签；
 *  null=探测失败）。返回计划：
 *  - vp 缺失/非法 → {mode:'none'}（现行为，不 emulate——行为不变）
 *  - otherPageCount≥1 → {mode:'skip', viewportAligned:false, reason:'user-present', declared}
 *    （用户在场关注中：emulate 会把页面缩成录制时的怪分辨率干扰用户——不 emulate，自适应现有真实分辨率）
 *  - otherPageCount=0 → {mode:'align', viewportAligned:true, declared}（存量对齐行为）
 *  - otherPageCount 非数字（探测失败）→ align+probeFailed:true（fail-soft 保守保持存量行为，log.warn 调用方出）。
 *  runFlow 消费点在 setDeviceMetricsOverride 之前；selftest #65 机检决策表。 */
function viewportPlan(vp, otherPageCount) {
  if (!vp || !Number.isFinite(vp.width) || !Number.isFinite(vp.height)) return { mode: 'none', viewportAligned: false };
  const declared = { width: vp.width, height: vp.height };
  if (!Number.isFinite(otherPageCount)) return { mode: 'align', viewportAligned: true, probeFailed: true, declared };
  if (otherPageCount >= 1) return { mode: 'skip', viewportAligned: false, reason: 'user-present', declared };
  return { mode: 'align', viewportAligned: true, declared };
}

/** 纯函数：viewportMin / viewportMinHeight 三态视口策略（V202609280001 方案 B 动态化 + V202610190002 高度维度）。
 *  vmin=_meta.viewportMin（最小布局宽度地板，如 winui 双击路径声明 1920）；otherPageCount=既有页签数
 *  （null=Target.getTargets 探测失败）；actualW=启动时实测 innerWidth（null/undefined=evaluate 读取失败）；
 *  vminH=_meta.viewportMinHeight（最小布局高度地板，V202610190002——矮窗口下底栏下拉越界实证）；
 *  actualH=实测 innerHeight。宽度/高度两维独立可只声明其一。
 *  返回计划：
 *  - 两维皆非法/缺失 → null（调用方回落旧 viewportPlan 路径——存量 flow 语义不变）
 *  - **仅宽度声明（vminH 未声明）→ 存量返回形状逐字不变**（向后兼容硬约束：既有 flow 行为与输出零变化）：
 *    用户在场（otherPageCount≥1）→ {mode:'skip', reason:'user-present', belowMin}；不在场 + actualW≥vmin →
 *    {mode:'follow', width:actualW}；不在场 + actualW<vmin → {mode:'floor', width:vmin, height:'live'}；
 *    不在场 + actualW 不可读 → {mode:'floor', width:vmin, height:'live', probePartial:true}；
 *    presence 探测失败（null）保守按不在场 floor。
 *  - **声明高度（vminH 合法）→ 扩展返回形状**（含 declared/actual/override，宽度维度可缺省）：
 *    skip → {mode:'skip', reason:'user-present', declared, actual, below}（**永不 emulate**；below 诊断各维越界）
 *    follow → {mode:'follow', declared, actual, override:{width:0,height:0}}（各维实际均达标：纯跟随不施加）
 *    floor → {mode:'floor', declared, actual, override:{width,height}[, probePartial]}（只托底不缩放；
 *      override 各维 = 需托底时取该维 min，否则 0=该维跟随实际——CDP 0 禁用该维 override，同 dsf:0 先例）
 *  runFlow 接线在旧 viewport 分支之前（vmin/vminH 胜出）；selftest #65（宽度）+ #79（高度）机检决策表。 */
function viewportMinPlan(vmin, otherPageCount, actualW, vminH, actualH) {
  const wOk = Number.isFinite(vmin) && vmin > 0;
  const hOk = Number.isFinite(vminH) && vminH > 0;
  if (!wOk && !hOk) return null;
  if (!hOk) { // —— 存量宽度维度路径（V202609280001）：返回形状逐字不变，width-only flow 零回归 ——
    if (Number.isFinite(otherPageCount) && otherPageCount >= 1) {
      return { mode: 'skip', reason: 'user-present', belowMin: (actualW != null && actualW < vmin) ? { actualW, vmin } : null };
    }
    if (!Number.isFinite(actualW)) return { mode: 'floor', width: vmin, height: 'live', probePartial: true };
    if (actualW >= vmin) return { mode: 'follow', width: actualW };
    return { mode: 'floor', width: vmin, height: 'live' };
  }
  // —— 高度维度（V202610190002）：扩展形状；宽度维度未声明时 width 记 null / override 该维 0（跟随实际） ——
  const declared = { width: wOk ? vmin : null, height: vminH };
  const actual = { width: actualW, height: actualH };
  if (Number.isFinite(otherPageCount) && otherPageCount >= 1) { // 用户在场永不 emulate：只诊断越界
    const below = {};
    if (wOk && actualW != null && actualW < vmin) below.width = { actualW, min: vmin };
    if (actualH != null && actualH < vminH) below.height = { actualH, min: vminH };
    return { mode: 'skip', reason: 'user-present', declared, actual, below: Object.keys(below).length ? below : null };
  }
  const wUnreadable = wOk && !Number.isFinite(actualW); // 未声明的维度不参与读取失败判定（独立可只声明其一）
  const hUnreadable = !Number.isFinite(actualH);
  const needW = wOk && (wUnreadable || actualW < vmin);
  const needH = hUnreadable || actualH < vminH;
  const probePartial = (wUnreadable || hUnreadable) || undefined;
  if (!needW && !needH) return { mode: 'follow', declared, actual, override: { width: 0, height: 0 } };
  return { mode: 'floor', declared, actual, override: { width: needW ? vmin : 0, height: needH ? vminH : 0 }, probePartial };
}

/**
 * 应用安全阀（V202609080009）：_meta.app 必须有 webapps/<app>/webapp.md；matchers 与当前 URL 校验防错应用执行。
 * 校验时机：--target 模式回放前查 target.url；自建标签模式每次 goto 后查 location.href。
 * 语义：URL 命中其他应用且未命中本应用 → APP_MISMATCH 拒执行；命中本应用 → 记 verified；零命中/歧义 → 放行（门户等中转页合法）。
 */
function attachAppSafety(runner, flow) {
  const matchers = require('./matchers');
  const webappsDir = path.join(paths.SKILL_ROOT, 'webapps');
  const appFile = path.join(webappsDir, flow._meta.app, 'webapp.md');
  if (!fs.existsSync(appFile)) {
    throw flowErr('APP_NOT_FOUND', `flow._meta.app="${flow._meta.app}" 无对应 webapps/${flow._meta.app}/webapp.md——拒绝回放（安全阀；先蒸馏入库再执行）`);
  }
  runner.appMatchers = matchers.extractMatchersMd(fs.readFileSync(appFile, 'utf8'));
  runner.appIndex = matchers.loadAppsIndex(webappsDir);
  runner.appSlug = flow._meta.app;
  runner.appVerified = false;
  runner.safetyCheck = async (url) => {
    if (!runner.appMatchers || runner.appVerified || !url) return;
    const r = matchers.resolveApp(runner.appIndex, url);
    const other = r.candidates.filter((c) => c.slug !== runner.appSlug);
    const mine = r.candidates.some((c) => c.slug === runner.appSlug);
    if (other.length && !mine) {
      throw flowErr('APP_MISMATCH', `当前 URL（${String(url).slice(0, 80)}）命中其他应用 matchers（${other.map((o) => o.slug).join('、')}）而非 ${runner.appSlug}——拒绝执行（防错应用安全阀）`);
    }
    if (mine) runner.appVerified = true;
  };
}

/* ── V202610150003 popup-guard（P1）：replay 路径广告/推广弹窗拦截（A 路线 DOM 层 MutationObserver 守卫） ──
 * 三件套：init（target 选定后、首步 goto 前预埋 + 对已加载页面即时执行一次）/ read（读 window.__cu_pg_log 归并）/
 * cleanup（移除脚本注册 + 页侧 observer.disconnect + 清窗口变量——共享浏览器现场还原硬约束）。
 * 全部 fail-soft：guard 自身任何环节失败只告警，绝不影响回放判定；不加 --popup-guard 时本模块零调用（存量零改动）。 */

/** 规则加载 + 预埋（返回 state；失败回落 {ok:false,error}——调用方只记日志） */
async function popupGuardInit(client, sessionId, flow, opts) {
  const pg = require('./popup-guard');
  const loaded = (opts && opts.popupRules)
    ? pg.loadRulesFromFile(opts.popupRules)                       // --popup-rules 显式文件：跳过 app/全局加载
    : pg.loadRules({ appSlug: (flow._meta || {}).app });          // 双层语义（app 有配置=整体为准 / 无=全局）
  if (!loaded.ok) {
    log.warn('flow', `popup-guard 规则加载失败（fail-soft，不注入）：${loaded.error}（${loaded.file}）`);
    return { ok: false, source: loaded.source, file: loaded.file, error: loaded.error, rules: [] };
  }
  const summary = pg.compileRuleSummary(loaded.rules);
  if (!summary.total) {
    log.warn('flow', `popup-guard 规则集为空（${loaded.file}），不注入`);
    return { ok: false, source: loaded.source, file: loaded.file, error: '规则集为空', rules: [] };
  }
  const script = pg.buildGuardScript(loaded.rules);
  const state = {
    ok: true, source: loaded.source, file: loaded.file, summary, identifier: null, blocked: null, byRule: null,
  };
  try { // ⓪ Page 域启用（2026-10-20 最小复现实证：未 enable 时 addScriptToEvaluateOnNewDocument 注册成功但脚本不执行——必须前置）
    await client.send('Page.enable', {}, { sessionId, timeoutMs: 3000 });
  } catch (e) { log.warn('flow', `popup-guard Page.enable 失败（fail-soft）：${e.message}`); }
  try { // ① 预埋：新文档在页面 JS 之前运行（广告不闪现）
    const r = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, { sessionId });
    state.identifier = (r && r.identifier) || null;
  } catch (e) { log.warn('flow', `popup-guard 预埋失败（fail-soft）：${e.message}`); }
  try { // ② 当前已加载页面立即执行一次（覆盖「页面已开着」场景）
    await client.send('Runtime.evaluate', { expression: script }, { sessionId, timeoutMs: 3000 });
  } catch (e) { log.warn('flow', `popup-guard 即时注入失败（fail-soft，后续导航仍由预埋脚本覆盖）：${e.message}`); }
  log.info('flow', `popup-guard 已启用：${summary.total} 条规则（source=${loaded.source}；remove ${summary.remove}/hide ${summary.hide}/scope 收窄 ${summary.scoped}）${loaded.file}`);
  return state;
}

/** 读拦截留痕并归并（条数 + 规则 id）；页面不可读时 blocked=null（如实标注） */
async function popupGuardRead(runner, state) {
  if (!state || !state.ok) return state;
  try {
    const j = await runner.ev('JSON.stringify(window.__cu_pg_log || [])', 2000);
    const entries = typeof j === 'string' ? JSON.parse(j) : (j || []);
    const s = require('./popup-guard').summarizeLog(entries);
    state.blocked = s.count;
    state.byRule = s.byRule;
  } catch (e) { state.blocked = null; state.byRule = null; }
  return state;
}

/** 现场还原（finally 配对清理）：页侧 observer.disconnect + 清窗口变量 → 移除新文档脚本注册 */
async function popupGuardCleanup(client, sessionId, state) {
  if (!state || !state.ok || !sessionId) return;
  const pg = require('./popup-guard');
  try { await client.send('Runtime.evaluate', { expression: pg.TEARDOWN_SRC }, { sessionId, timeoutMs: 2000 }); } catch { /* 页面已关/不可读均无需善后 */ }
  try {
    if (state.identifier) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: state.identifier }, { sessionId, timeoutMs: 2000 });
  } catch { /* 尽力而为 */ }
}

/** 拦截摘要（日志行 + 回放返回值 + 成功 verdict 落盘共用；无 guard 时返回 undefined——调用方按需展开，
 *  不加旗标的存量输出零变化） */
function popupGuardReport(state) {
  if (!state) return undefined;
  if (!state.ok) return { enabled: false, source: state.source, file: state.file || null, error: state.error || null };
  return {
    enabled: true, source: state.source, file: state.file || null,
    rules: state.summary ? state.summary.total : 0,
    blocked: state.blocked === undefined ? null : state.blocked,
    byRule: state.byRule || null,
  };
}

/** 人类可读摘要行（成功/失败路径同口径；供 log + cdp.js stdout） */
function popupGuardLine(state) {
  const r = popupGuardReport(state);
  if (!r) return null;
  if (!r.enabled) return `popup-guard 未启用：${r.error || '未知'}${r.file ? `（${r.file}）` : ''}`;
  const br = r.byRule && Object.keys(r.byRule).length
    ? Object.entries(r.byRule).map(([k, v]) => `${k}:${v}`).join('，')
    : '无';
  return `popup-guard 拦截 ${r.blocked == null ? '留痕读取失败' : r.blocked} 条（规则 ${r.rules} 条，source=${r.source}；按规则：${br}）`;
}

/**
 * 回放入口。opts：{ flowFile?, browserUrl?, targetSel?, vars?, keepTab?, timeoutMs?, targetUrl?,
 *                   popupGuard?, popupRules? }
 * 未指定 targetSel 时自建 about:blank 标签执行，结束自关（谁开谁关；--keep-tab 保留）。
 * 返回 { ok:true, completed, dpr?, warnings?, popupGuard? } 或 { ok:false, failReport, completed, popupGuard? }。
 */
async function runFlow(flow, opts) {
  const errors = validateFlow(flow);
  if (errors.length) throw flowErr('FLOW_INVALID', `flow schema 校验失败：\n  - ${errors.join('\n  - ')}`);
  const vars = Object.assign({}, flow.vars, opts && opts.vars);
  // #127 V2：[变量赋值] 步骤执行时插值——存量 flow 的启动时插值结果逐字节等价（静态变量无运行时变化）。
  // 启动期仍保留 fail-fast：{{var}} 必须由 flow.vars/--var 或**任一 set/eval 步骤**提供；
  // 生产者在执行路径上（分支/循环可能未执行）时，缺失在消费步骤处诚实红（VAR_MISSING）。
  const varProducers = new Set(Object.keys(vars));
  for (const s of flow.steps) {
    if (s && (s.action === 'set' || s.action === 'eval') && typeof s.var === 'string') varProducers.add(s.var);
    if (s && s.action === 'loop') { // loop 帧变量（每遍写入）
      if (typeof s.itemVar === 'string') varProducers.add(s.itemVar);
      if (typeof s.indexVar === 'string') varProducers.add(s.indexVar);
    }
  }
  const refs = collectVarRefs(flow.steps, new Set());
  const missing = [...refs].filter((k) => !varProducers.has(k));
  if (missing.length) throw flowErr('VAR_MISSING', `未定义的 {{var}}：${missing.join('、')}（flow.vars / --var 提供，或前序 set/eval 步骤写入）`);
  const steps = flow.steps;
  const core = require('./cdp-core');
  const client = new core.CdpClient(opts.browserUrl, { timeoutMs: (opts && opts.timeoutMs) || 5000 });
  await client.connect();
  // --insecure（V20261112001 §17）：连接建立后 browser-level 忽略证书错误——flow replay 是长连接整场模型，
  // 一次设置覆盖整场回放（goto --insecure 断连后回退，自签 SPA 的 WS/持续子资源会落在无保护窗口，故必须挂这里）
  if (opts && opts.insecure) await client.send('Security.setIgnoreCertificateErrors', { ignore: true });
  // V202609090002 录屏兜底（-v 显式开启制）：replay 路径读 opts.video 时对目标 tab 起一路 screencast。
  // 命名裁定：不复用 rec- 会话命名——replay 无配套事件流（diff-video 按 events session.id 找 rec-*），
  // 用 replay-<ts> 独立命名落 tmpdata/video/，消费方式 = 人工/observer 直接按帧目录+index.json 看（形状同 chromeuse-video/1）
  // 时间戳单源 lib/time.js（配置时区，默认 UTC+8）；selftest #26 断言 'replay-' + replayTs() 字面量
  const replayTs = () => time.formatStamp();
  const videoDir = (opts && opts.video) ? paths.ensureDir(path.join(paths.VIDEO_DIR, 'replay-' + replayTs())) : null;
  let screencast = null;
  const flowLabel = `${flow._meta.title}（app=${flow._meta.app}，${steps.length} 步）`;
  log.info('flow', `replay 开始：${flowLabel} target=${(opts && opts.targetSel) || '自建标签'}`);
  let createdTab = null;
  let targetTabId = null;     // --target 模式目标标签 id（既有页签探测排除项——目标标签不算"其他页签"）
  const completed = [];
  const warnings = [];
  let sessionId = null;       // 提升到 try 外：finally 视口恢复需访问
  let viewportAligned = false;
  let popupGuardState = null; // V202610150003 popup-guard 状态（finally 配对清理；缺省 null=零改动）
  try {
    if (opts && opts.targetSel) {
      const r = await core.resolveTarget(client, opts.targetSel);
      sessionId = r.sessionId;
      targetTabId = r.target.id; // 既有页签探测排除项（目标标签不算"其他页签"）
      if (opts.targetUrl === undefined) opts.targetUrl = r.target.url; // 安全阀用真实初始 URL
    } else {
      const r = await client.send('Target.createTarget', { url: 'about:blank' });
      createdTab = r.targetId;
      sessionId = await client.attach(createdTab);
    }
    const runner = new Runner(client, sessionId);
    runner.vars = vars; // #127 V2：运行期变量作用域（flow.vars + --var 起步；set/eval 写入）
    // V202609090002：-v 时对回放目标 tab 起录屏（fail-soft——启动失败只告警不失败；帧流落 videoDir）
    if (opts.video) {
      try {
        screencast = await require('./screencast').start({
          client, sessionId, tab: 'replay', session: path.basename(videoDir),
          videoDir, intervalMs: opts.videoInterval, maxWidth: opts.videoWidth, quality: opts.videoQuality,
        });
        log.info('flow', `录屏兜底已启动（-v）：${videoDir}`);
      } catch (e) { log.warn('flow', `录屏启动失败（fail-soft 不影响回放）：${e.message}`); }
    }
    // X1/X4 总开关接线：CLI（--no-hit-test/--post-verify）> flow _meta > 默认（hitTest 开 / postVerify 关）
    runner.hitTest = (opts && opts.hitTest !== undefined) ? opts.hitTest : (flow._meta.hitTest !== false);
    runner.postVerify = (opts && opts.postVerify !== undefined) ? !!opts.postVerify : (flow._meta.postVerify === true);
    runner.flowMeta = flow._meta || {}; // kind 语义层总开关：_meta.kind===false 全 flow 不注入（withKind 读取）
    // CLI --no-kind（ora-5 设计 §3.7 逃生舱）：opts.kind===false 覆盖 _meta——CLI > flow（接线先例同 hitTest）
    if (opts && opts.kind === false) runner.flowMeta = Object.assign({}, runner.flowMeta, { kind: false });
    // C4（#124）challenge 挂点选项：CLI 旗标 > flow _meta > 默认（检测恒开、默认阻断、等待 15s）。
    // allowChallenge=false → goto 步命中 challenge 即抛 CHALLENGE_DETECTED（诚实红）；true → 只记 warnings 继续。
    {
      const metaAllow = (flow._meta || {}).allowChallenge;
      const cliWait = opts && opts.challengeWaitMs;
      const metaWait = (flow._meta || {}).challengeWaitMs;
      runner.challengeOpt = challenge.normalizeOptions({
        allowChallenge: (opts && opts.allowChallenge !== undefined) ? opts.allowChallenge : metaAllow === true,
        waitMs: cliWait !== undefined ? cliWait : metaWait,
        timeoutMs: (opts && opts.timeoutMs) || 5000,
        sleepFn: runner.sleepFn,
      });
    }
    // V202610150003 popup-guard（P1，默认关）：target 已选定、首步 goto 前预埋守卫——规则来源=--popup-rules 显式
    // 文件 > 双层（app 有配置整体为准 / 无=全局）。任何环节失败 fail-soft（只告警，不改判回放）。
    if (opts && opts.popupGuard) popupGuardState = await popupGuardInit(client, sessionId, flow, opts);
    // V202609090003 视口环境对齐：flow._meta.viewport 声明录制/验证时的 CSS 视口（如 winui 桌面双击路径
    // 需 ≥1920 宽布局——窄视口下双击不弹层实测）。deviceScaleFactor:0 = 保持环境真实 DPR（不触 DPR 红线——
    // 本对齐只改 CSS 视口尺寸，不改设备像素比；语义是"环境对齐"而非"设备模拟"）。fail-soft + finally 恢复。
    // V202609280001 方案 B 三态视口策略（2026-09-28 用户裁定+同日动态化）：共享浏览器多设备访问不写死
    // 分辨率——_meta.viewportMin（最小布局宽度地板）声明时：在场永不 emulate（低于 min 只打 advisory）/
    // 不在场 emulate 到 max(vmin, 实际宽)（永不缩小，override height:0=高度恒跟随实际）/实际已达标纯跟随；
    // 与旧 _meta.viewport 同声明时 viewportMin 胜出（旧值忽略）；两者皆无 = 现行为。探测失败 fail-soft。
    // V202610190002 高度地板扩展：_meta.viewportMinHeight（最小布局高度地板，矮窗口下底栏下拉越界实证）——
    // 与 vmin 宽度地板同三态语义、逐维独立（可只声明其一）；未声明 = 高度行为与现状完全一致（零回归）。
    const vp = flow._meta.viewport;
    const vmin = flow._meta.viewportMin;
    const vminH = flow._meta.viewportMinHeight; // V202610190002 高度地板（与 vmin 宽度地板独立，可只声明其一）
    const vminActive = vmin != null && Number.isFinite(vmin) && vmin > 0;
    const vminHActive = vminH != null && Number.isFinite(vminH) && vminH > 0;
    if (vminActive || vminHActive || (vp && Number.isFinite(vp.width) && Number.isFinite(vp.height))) {
      let otherPages = null; // null=探测失败（fail-soft——旧路径保守 align / vmin 路径保守 floor）
      try {
        const exclude = new Set([createdTab, targetTabId].filter(Boolean));
        const r = await client.send('Target.getTargets', {});
        otherPages = (r.targetInfos || []).filter((t) => t && t.type === 'page' && !exclude.has(t.targetId)).length;
      } catch (e) { log.warn('flow', `既有页签探测失败（fail-soft，保持视口对齐存量行为）：${e.message}`); }
      if (vminActive || vminHActive) {
        // 三态分支（vmin/vminH 胜出——先于旧 viewport 路径判定）
        let actualW = null, actualH = null; // 仅声明地板时才花这一次 evaluate 往返
        try {
          const o = JSON.parse(await runner.ev('JSON.stringify({w:window.innerWidth,h:window.innerHeight})', 2000));
          actualW = o.w; actualH = o.h;
        } catch { /* 读不到 → viewportMinPlan 走 probePartial 保守托底 */ }
        // 高度维度声明时透传 vminH/actualH（扩展形状）；未声明走存量 3 参调用（零回归 + 存量源断言面保留）
        const mplan = vminHActive
          ? viewportMinPlan(vmin, otherPages, actualW, vminH, actualH)
          : viewportMinPlan(vmin, otherPages, actualW);
        if (vp) log.info('flow', `已声明 _meta.viewportMin=${vminActive ? vmin : '—'}${vminHActive ? ` / _meta.viewportMinHeight=${vminH}` : ''}：三态视口策略生效，旧 _meta.viewport ${vp.width}x${vp.height} 忽略`);
        if (vminHActive) {
          // V202610190002 高度维度（可含宽度联合）：与宽度同三态语义、逐维独立——在场永不 emulate/缺席只托底不缩小/各维达标纯跟随
          runner.viewportPlan = { mode: mplan.mode, reason: mplan.reason || null, declared: mplan.declared, actual: mplan.actual, below: mplan.below || null }; // 现场诊断（失败报告 targetState.viewportPlan）
          if (mplan.mode === 'skip') { // 用户在场永不 emulate；越界维只打 advisory
            runner.viewport = null;            // goto 重申链不触发（未施加任何 override）
            runner.viewportAligned = false;    // 失败报告 targetState 如实反映
            runner.viewportSkipReason = mplan.reason;
            if (mplan.below) {
              const parts = [];
              if (mplan.below.width) parts.push(`宽 ${mplan.below.width.actualW} < min ${mplan.below.width.min}`);
              if (mplan.below.height) parts.push(`高 ${mplan.below.height.actualH} < min ${mplan.below.height.min}`);
              const msg = `视口低于声明最小值：${parts.join('；')}——布局依赖 flow 可能诚实失败（用户在场不 emulate，2026-09-28 裁定）`;
              log.warn('flow', msg);
              warnings.push(msg); // advisory 并入 warnings（成功 verdict/完成日志可见，不改判成功）
            } else {
              log.info('flow', `视口对齐跳过：检测到 ${otherPages} 个既有页签（用户在场）——自适应现有分辨率，viewportMin/Height 策略在场永不 emulate`);
            }
          } else if (mplan.mode === 'follow') { // 各维实际均达标：纯跟随不施加
            log.info('flow', `视口纯跟随：实际 ${actualW}x${actualH} ≥ 声明地板（宽 ${mplan.declared.width == null ? '未声明' : mplan.declared.width} / 高 ${mplan.declared.height}）——不 emulate`);
          } else { // floor：只托底不缩放——override 各维=需托底取该维 min / 0=该维跟随实际（CDP 0 禁用该维 override，同 DSF:0 先例）
            try {
              await client.send('Emulation.setDeviceMetricsOverride',
                { width: mplan.override.width, height: mplan.override.height, deviceScaleFactor: 0, mobile: false }, { sessionId });
              viewportAligned = true;
              runner.viewport = { width: mplan.override.width, height: mplan.override.height }; // goto 重申链复用（viewportFloor 分支只托底；0=该维跟随实际）
              runner.viewportFloor = true;
              runner.viewportAligned = true;     // 失败报告 targetState.viewportAligned（buildFailReport 读）
              log.info('flow', `视口地板托底：宽 min ${mplan.declared.width == null ? '未声明' : mplan.declared.width} / 高 min ${mplan.declared.height}（实际 ${actualW == null ? '读取失败' : actualW}x${actualH == null ? '读取失败' : actualH}${mplan.probePartial ? '，部分保守托底' : ''}）→ override ${mplan.override.width}x${mplan.override.height}（0=跟随实际），永不缩小`);
            } catch (e) { log.warn('flow', `视口地板施加失败（fail-soft，按环境实际视口继续）：${e.message}`); }
          }
        } else if (mplan.mode === 'skip') { // 用户在场永不 emulate；实际宽 <min 只打 advisory
          runner.viewport = null;            // goto 重申链不触发（未施加任何 override）
          runner.viewportAligned = false;    // 失败报告 targetState 如实反映
          runner.viewportSkipReason = mplan.reason;
          if (mplan.belowMin) {
            const msg = `视口低于声明最小值：实际 ${mplan.belowMin.actualW}x${actualH} < min ${mplan.belowMin.vmin}——布局依赖 flow 可能诚实失败（用户在场不 emulate，2026-09-28 裁定）`;
            log.warn('flow', msg);
            warnings.push(msg); // advisory 并入 warnings（成功 verdict/完成日志可见，不改判成功）
          } else {
            log.info('flow', `视口对齐跳过：检测到 ${otherPages} 个既有页签（用户在场）——自适应现有分辨率，viewportMin 策略在场永不 emulate`);
          }
        } else if (mplan.mode === 'follow') { // 实际已达标：纯跟随不施加（max 地板语义无需托底）
          log.info('flow', `视口纯跟随：实际 ${mplan.width}x${actualH} ≥ viewportMin ${vmin}——不 emulate`);
        } else { // floor：只托底不缩放——width=max(vmin,实际)，height:0=高度恒跟随实际（CDP 0 禁用该维 override，同 DSF:0 先例）
          try {
            await client.send('Emulation.setDeviceMetricsOverride',
              { width: mplan.width, height: 0, deviceScaleFactor: 0, mobile: false }, { sessionId });
            viewportAligned = true;
            runner.viewport = { width: mplan.width, height: 0 }; // goto 重申链复用（viewportFloor 分支只托底）
            runner.viewportFloor = true;
            runner.viewportAligned = true;     // 失败报告 targetState.viewportAligned（buildFailReport 读）
            log.info('flow', `视口地板托底：min ${vmin}（实际宽 ${actualW == null ? '读取失败' : actualW}${mplan.probePartial ? '，保守托底' : ''}）→ width=${mplan.width}，永不缩小，高度跟随实际`);
          } catch (e) { log.warn('flow', `视口地板施加失败（fail-soft，按环境实际视口继续）：${e.message}`); }
        }
      } else {
        const plan = viewportPlan(vp, otherPages);
        if (plan.mode === 'align') {
          try {
            await client.send('Emulation.setDeviceMetricsOverride',
              { width: vp.width, height: vp.height, deviceScaleFactor: 0, mobile: false }, { sessionId });
            viewportAligned = true;
            runner.viewport = vp;              // F2：goto 分支对齐重申需要声明值
            runner.viewportAligned = true;     // 失败报告 targetState.viewportAligned（buildFailReport 读）
            log.info('flow', `视口环境对齐：${vp.width}x${vp.height}（DSF 保持环境值${plan.probeFailed ? '；既有页签探测失败保守对齐' : '；无既有页签'}）`);
          } catch (e) { log.warn('flow', `视口对齐失败（fail-soft，按环境实际视口继续）：${e.message}`); }
        } else { // skip（reason='user-present'）：不 emulate 不重申；未 override 过，finally 无需 clear
          runner.viewport = null;            // goto 分支不得重申录制视口（this.viewport 为 null 即跳过）
          runner.viewportAligned = false;    // 失败报告 targetState 如实反映（viewportAligned=false）
          runner.viewportSkipReason = plan.reason; // 失败报告 targetState.viewportSkipReason='user-present'
          log.info('flow', `视口对齐跳过：检测到 ${otherPages} 个既有页签（用户在场）——自适应现有分辨率，不 emulate 录制视口（${vp.width}x${vp.height}）`);
        }
      }
    }
    attachAppSafety(runner, flow);
    await runner.safetyCheck && runner.safetyCheck(opts.targetUrl);
    // V202609080010 DPR 立场反转：撤销启动即 emulate——读 devicePixelRatio 记录参考（不修改不告警）。
    // 依据：用户实证原生 DPR 1.5 下人工全可点；历史"幽灵菜单"失败重归因为文本匹配歧义+主线程冻结。
    let actualDpr = null;
    try { actualDpr = await runner.ev('window.devicePixelRatio', 2000); } catch { /* 冻结期读不到则留空 */ }
    runner.actualDpr = actualDpr;
    const urlTrail = [{ step: 0, url: opts.targetUrl || 'about:blank' }]; // V202609080011 失败报告增强：URL 轨迹
    // B7 N6：作业进度（非作业进程不传；回调异常绝不影响回放主链）
    try { if (opts && typeof opts.onProgress === 'function') opts.onProgress({ phase: 'replay', current: 0, total: steps.length }); } catch { /* 进度旁路 */ }
    /* #127 V2 执行游标：while + label 表 + loop 帧栈 + 重复执行预算。
     * 无新原语时 next=i+1 恒进，与存量 for 循环语义逐字节等价（步骤序/日志/报告面全同）。
     * 硬上限 MAX_LOOP_ITERATIONS 覆盖 loop 重复 + cond 后退跳步——防死循环变通用脚本语言。 */
    const labelIndex = new Map();
    steps.forEach((s, i) => { if (s && typeof s.label === 'string') labelIndex.set(s.label, i); });
    const loopStack = [];
    const executedIndexes = new Set();
    let iterations = 0;
    let i = 0;
    while (i < steps.length) {
      const rawStep = steps[i];
      runner.stepIdx = i; // Q2：锚点快照记录当前步骤号
      const t0 = Date.now();
      let s = rawStep;     // 失败报告/日志消费的执行态步骤（插值后）
      let stepResult = null;
      let jumpedByCond = false;
      let next = i + 1;
      try {
        // #127 V2：步骤执行时插值（变量可在回放中变化）——分支未覆盖的变量在此诚实红
        const stepMissing = [];
        s = interpolateStep(rawStep, runner.vars, stepMissing);
        if (stepMissing.length) throw flowErr('VAR_MISSING', `步骤 ${i + 1} 引用未定义变量：${[...new Set(stepMissing)].join('、')}（该变量由未执行的分支/循环赋值？）`);
        log.info('flow', `步骤 ${i + 1}/${steps.length} ${s.action}${s.desc ? '：' + String(s.desc).slice(0, 40) : ''}`);
        const timeoutMs = Number.isFinite(s.timeoutMs) ? s.timeoutMs : (DEFAULT_TIMEOUT[s.action] || 5000);
        stepResult = await withTimeout(runner.step(s, timeoutMs), timeoutMs + 1000, `#${i} ${s.action}`);
        const stepMs = Date.now() - t0;
        const entry = { index: i, action: s.action, desc: s.desc || '', ok: true, ms: stepMs };
        // #127：新原语证据链（eval/set 结果、cond 命中、loop 次数）——存量条目形状不变（增量字段）
        if (s.action === 'eval' || s.action === 'set') entry.value = summarizeStepValue(stepResult, { redact: s.action === 'eval' });
        if (s.action === 'cond') entry.hit = !!(stepResult && stepResult.hit);
        if (s.action === 'loop') { entry.times = stepResult && stepResult.times; entry.count = s.count; }
        completed.push(entry);
        executedIndexes.add(i);
        try { if (opts && typeof opts.onProgress === 'function') opts.onProgress({ phase: 'step', current: i + 1, total: steps.length }); } catch { /* 进度旁路 */ }
        // V202609300004 click 步成功行带坐标 @x,y（排障可观测性：最近一次真实派发坐标——centerClick 判
        // success 跳过派发时为上一击坐标，属已知边界；低频每步一行，info 级直接可见）
        const clickXY = (s.action === 'click' && runner.lastClickXY) ? ` @${runner.lastClickXY.x},${runner.lastClickXY.y}` : '';
        log.info('flow', `步骤 ${i + 1} ✓ ${s.action}（${stepMs}ms）${clickXY}`);
        // M4 过闸耗时审计（2026-09-18 引擎批一，纪律⑧）：条件类 wait <100ms 过闸 = 假绿嫌疑——
        // [audit] fast-pass 进日志 + completed 条目 + warnings（replay 报告消费；纯 advisory 不改判成功）
        const fastPass = m4FastPass(s, stepMs);
        if (fastPass) {
          completed[completed.length - 1].audit = fastPass;
          const auditMsg = s.action === 'assert'
            ? `[audit] fast-pass 嫌疑：步骤 ${i + 1} assert 效果断言 ${stepMs}ms 过闸（<${M4_FAST_PASS_MS}ms）——可能命中旧状态残留文本（实弹 b2f1b 5ms 假绿：命中尚未拆除的提取表单自身行文本），人工复核断言锚定的目标本体`
            : `[audit] fast-pass 嫌疑：步骤 ${i + 1} wait 闸门 ${stepMs}ms 过闸（<${M4_FAST_PASS_MS}ms）——「文本早已存在于错误目标」假绿签名（38ms/25ms/18ms/13ms 实锤同款），人工复核该闸锚定的目标本体`;
          log.warn('flow', auditMsg);
          warnings.push(auditMsg);
        }
        if (s.action === 'goto') { try { await runner.safetyCheck(await runner.ev('location.href', 2000)); } catch (e) { if (e.code === 'APP_MISMATCH') throw e; } }
        try { urlTrail.push({ step: i + 1, url: await runner.ev('location.href', 1500) }); } catch { /* 轨迹尽力而为 */ }
        /* ── #127 V2 控制流应用（成功步后；错误走同一步的失败报告） ── */
        if (s.action === 'loop') {
          // 只建帧不执行体：重复体=后续 count 步；首遍从 i+1 起（帧变量先写入）
          const spec = stepResult || {};
          const frame = { start: i + 1, end: i + spec.count, times: spec.times, iter: 0, items: spec.items || null, itemVar: spec.itemVar, indexVar: spec.indexVar };
          loopStack.push(frame);
          applyLoopVars(runner.vars, frame);
          log.info('flow', `loop 帧建立：重复 steps[${frame.start + 1}..${frame.end + 1}]（${spec.times} 次${spec.items ? '，over 数组' : ''}${spec.indexVar ? `，indexVar=${spec.indexVar}` : ''}${spec.itemVar ? `，itemVar=${spec.itemVar}` : ''}）`);
        } else if (s.action === 'cond' && stepResult && stepResult.hit) {
          const jump = stepResult.jump || {};
          jumpedByCond = true;
          next = jump.to !== undefined ? labelIndex.get(jump.to) : i + 1 + jump.skip;
          if (!Number.isInteger(next)) throw flowErr('FLOW_INVALID', `cond 跳步目标不可解析：${JSON.stringify(jump)}`);
          if (next <= i) { // 后退跳步=循环式：计入重复执行预算
            iterations++;
            if (iterations > MAX_LOOP_ITERATIONS) throw flowErr('LOOP_LIMIT_EXCEEDED', `重复执行次数超过硬上限 ${MAX_LOOP_ITERATIONS}（步骤 ${i + 1} cond 后退跳步 → steps[${next + 1}]）——受控循环纪律：请确认退出条件/效果断言`);
          }
          log.info('flow', `cond 命中 → 跳至 steps[${next}]${next < steps.length ? `（${steps[next].action}${steps[next].desc ? '：' + String(steps[next].desc).slice(0, 30) : ''}）` : '（越过末尾=回放结束）'}`);
          completed[completed.length - 1].jumpedTo = next;
        }
        // 循环帧记账：体尾（end+1）→ 未满次数则回跳 start；越出体区间（cond 跳走）→ 弹帧
        for (;;) {
          const f = loopStack[loopStack.length - 1];
          if (!f) break;
          if (next === f.end + 1) {
            // cond 主动跳到体后 = 跳出循环（break）；自然走完体尾 = 进入下一遍/结束
            if (jumpedByCond) { loopStack.pop(); continue; }
            if (f.iter + 1 < f.times) {
              f.iter++;
              iterations++;
              if (iterations > MAX_LOOP_ITERATIONS) throw flowErr('LOOP_LIMIT_EXCEEDED', `重复执行次数超过硬上限 ${MAX_LOOP_ITERATIONS}（steps[${f.start}] loop 第 ${f.iter + 1}/${f.times} 遍）——受控循环纪律`);
              applyLoopVars(runner.vars, f);
              next = f.start;
              continue;
            }
            loopStack.pop();
            continue;
          }
          if (next < f.start || next > f.end + 1) { loopStack.pop(); continue; }
          break;
        }
      } catch (err) {
        err.elapsedMs = Date.now() - t0;
        err.urlTrail = urlTrail;
        log.error('flow', `步骤 ${i + 1} ✗ ${s.action} 错误[${err.code || 'CDP_ERROR'}]：${String(err.message).slice(0, 160)}`, err);
        const failReport = await buildFailReport(opts && opts.flowFile, completed, i, s, err, runner);
        // V202610150003 popup-guard 摘要（失败路径同样输出——拦截留痕是取证纪律，不因失败丢弃）
        if (popupGuardState) { await popupGuardRead(runner, popupGuardState); log.info('flow', String(popupGuardLine(popupGuardState))); }
        log.error('flow', `回放失败：${flowLabel} 停于步骤 ${failReport.stoppedAt.stepNo}，失败报告=${failReport.file}`);
        return { ok: false, failReport, completed, dpr: runner.actualDpr, video: screencast ? { dir: videoDir, frames: screencast.count() } : undefined, ...(popupGuardState ? { popupGuard: popupGuardReport(popupGuardState) } : {}) };
      }
      i = next;
    }
    if (runner.appMatchers && !runner.appVerified) {
      warnings.push(`回放全程 URL 未命中 webapps/${flow._meta.app}/webapp.md matchers（scope=demo 放行；正式回放请核对目标）`);
    }
    for (const w of (runner.postWarnings || [])) warnings.push(w); // X4 post 复核实验性告警并入
    // V202610150003 popup-guard 摘要（成功路径；读 window.__cu_pg_log 归并——条数 + 规则 id）
    if (popupGuardState) { await popupGuardRead(runner, popupGuardState); log.info('flow', String(popupGuardLine(popupGuardState))); }
    // #127 V2：循环/跳步流的"完成步数"口径=去重执行步数（存量流与 completed.length 恒等——文案零变化）；
    // 重复执行与条件跳过如实附注（不把 9/6 当全过）。
    const stepsDone = executedIndexes.size;
    const skippedSteps = steps.length - stepsDone;
    const repeatNote = (completed.length !== stepsDone || skippedSteps > 0)
      ? `（执行 ${completed.length} 次${completed.length !== stepsDone ? '，含循环/回跳重复' : ''}${skippedSteps > 0 ? `；条件跳步跳过 ${skippedSteps} 步` : ''}）`
      : '';
    log.info('flow', `回放完成：${stepsDone}/${steps.length} 步全过${repeatNote}（app=${flow._meta.app}${warnings.length ? `；warning ${warnings.length} 条` : ''}）`);
    // V202609190001 成功 verdict 先行同步落盘：finally 的 client.close() 间歇挂起时进程不退，
    // 外部 SIGKILL 会吞掉 stdout 管道缓冲（判定行已打却无人收到）——失败路径有 flow-fail 报告旁路，
    // 成功路径此前无任何落盘旁路，此处对等补齐（命名/目录/时间戳对齐 buildFailReport 既有约定，
    // paths 单源 + lib/time.js formatStamp 单源）。尽力而为：写失败只 warn，绝不影响回放成功判定。
    try {
      const stamp = time.formatStamp();
      paths.ensureDir(paths.REPLAY_VERDICT_DIR);
      const verdictFile = path.join(paths.REPLAY_VERDICT_DIR, `replay-verdict-${stamp}.json`);
      fs.writeFileSync(verdictFile, JSON.stringify({
        format: 'chromeuse-replay-verdict/1',
        flow: path.basename(String((opts && opts.flowFile) || 'flow.json')),
        flowFile: (opts && opts.flowFile) || null,
        ok: true,
        completed: `${stepsDone}/${steps.length}`,
        stepsDone,
        stepsSkipped: skippedSteps,
        stepsExecuted: completed.length,
        warnings,
        video: screencast ? { dir: videoDir, frames: screencast.count() } : undefined,
        dpr: runner.actualDpr,
        popupGuard: popupGuardReport(popupGuardState), // 无 guard 时 undefined → JSON.stringify 自动省略（存量 verdict 零变化）
        stamp,
      }, null, 2));
      log.info('flow', `成功 verdict 已同步落盘：${verdictFile}`);
    } catch (e) { log.warn('flow', `成功 verdict 落盘失败（尽力而为，不影响判定）：${String((e && e.message) || e).slice(0, 120)}`); }
    return { ok: true, completed, stepsDone, stepsSkipped: skippedSteps, stepsExecuted: completed.length, warnings, dpr: runner.actualDpr, video: screencast ? { dir: videoDir, frames: screencast.count() } : undefined, ...(popupGuardState ? { popupGuard: popupGuardReport(popupGuardState) } : {}) };
  } finally {
    // V202609090002：录屏先停并终写 index（拆 WS 前）；fail-soft
    if (screencast) { try { await screencast.stop(); } catch { /* 尽力而为 */ } }
    // V202610150003 popup-guard 现场还原（配对清理，失败/异常路径同样走到）：页侧 observer.disconnect + 清窗口变量
    // → 移除新文档脚本注册。共享浏览器是用户资产：不留观察器、不留注册（try/finally 保证）。
    if (popupGuardState) { try { await popupGuardCleanup(client, sessionId, popupGuardState); } catch { /* 尽力而为 */ } }
    if (createdTab && !(opts && opts.keepTab)) {
      try { await client.send('Target.closeTarget', { targetId: createdTab }); } catch { /* 尽力而为 */ }
    }
    // V202609090003：视口环境对齐的恢复（fail-soft；sessionId 为 null=未 attach 过则无需恢复）
    if (sessionId && viewportAligned) {
      try { await client.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId }); } catch { /* 尽力而为 */ }
    }
    // V202609190001 close 超时兜底：client.close() 间歇挂起（判定行已打、进程不退）→ 3s 强制放行，
    // 让进程正常退出、stdout 管道缓冲正常冲刷（挂起被外部 SIGKILL 会连判定一起吞掉）
    try { await withTimeout(client.close(), 3000, 'client.close 兜底超时'); } catch (e) { log.warn('flow', `client.close 兜底超时（3s）强制放行：${e.message}`); }
  }
}

module.exports = { validateFlow, interpolate, runFlow, buildLocateExpr, ACTIONS, ACTION_FIELDS, summarizeUrlTrail, diagnoseFailure, buildFailReport, parseKeyModifiers, m4FastPass, M4_FAST_PASS_MS, Runner, tabHygieneWarning, countAppTabs, TAB_HYGIENE_THRESHOLD, viewportPlan, viewportMinPlan, buildInsertVerifyExpr, clickRetryBackoff, CLICK_RETRY_BACKOFF_MS, CLICK_RETRY_BACKOFF_CAP_MS, CLICK_RETRY_RESERVE_MS, buildDeepInteractExpr, lintContracts, withUnique, uniqueGateInventory, UNIQUE_OPS, popupGuardInit, popupGuardRead, popupGuardCleanup, popupGuardReport, popupGuardLine,
  // #127 V2 纯函数/常量（selftest 单测面）
  MAX_LOOP_ITERATIONS, MAX_LOOP_BODY, EVAL_TIMEOUT_DEFAULT_MS, EVAL_TIMEOUT_MAX_MS,
  evalSandboxViolation, buildEvalExpr, interpolateStep, collectVarRefs, condVarMatch, evalBudgetOf, summarizeStepValue, applyLoopVars };
