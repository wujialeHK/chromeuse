'use strict';
/*
 * chromeuse lib/target-resolver.js —— 定位解析层（V202609080011）
 *
 * 四层定位链（flow target 描述符按层回退）：
 *   ★V202609300006 text 权威规则：声明 spec.text 时 text 层零候选=四层全败（不回退后续层——
 *   near pool/grid/domPath 可独立产生无文本候选=误击红线，绝不静默改点别处）；后续层仅对
 *   无 text 声明的 target 可达。
 *   ① 语义（text [+role/near]，含 tspan 子片消歧：候选文本是父元素完整文本真子片 → 降权——
 *      2026-09-08 实测「销售订单」exact 误中「销售订单修改」tspan 的教训固化）
 *   ② grid-context（表头语义序列**有序子集匹配** + 行号 + 列名定位单元格——{ grid: { headers, row, col|colIndex } }）
 *   ③ DOM 路径（{ domPath: "css" } 跨 frame querySelector）
 *   ④ 坐标兜底（{ point: {x, y} }）
 * 条件文法（wait/assert 共用）：text | element(target) | value | count | url（+简写 urlContains）| network（Runner 侧）
 *   | absent（!exists，V202609110001）| hidden（exists && !visible 严格语义，V202609110001）。
 * stable 静止稳定条件（V202609300016 原语二，仅 element 条件）：可选 {ms, polls} 修饰——目标过定位且连续
 *   polls 次轮询 rect 相等（±1px）才算真（页侧轮询 IIFE，buildCondExpr element case；无 stable 零改动）。
 * target 修饰字段（V202609110001，仅 text 层生效）：tag（raw 标签名，字符串或字符串数组）——默认软评分
 *   （不在列表内的候选降权排后不排除）；strictTag:true 升级硬约束（不匹配候选直接排除——作者显式契约）。
 * unique 唯一性契约（V202609300016 原语四，oracle 报告 §3.3）：可选布尔修饰字段（仅 text 层实现）——true 时
 *   过闸候选 >1 → not-ok（ambiguous）诚实红附候选 tag/rect/frame 全量清单，不赌排序；与 container 收窄正交。
 * kind 语义层（ora-5 设计步骤 1，仅 text 层生效）：引擎按 action 推导的隐式期望（kindExpectations 映射，
 *   Runner 侧 withKind 复制 target 写 spec.__kind——作者无感知），页侧 kindMatches 分类器（独立于 roleOf，不改 roleOf）
 *   软评分 kindMiss ∈{0,1}：键序 fragment → tagMiss → kindMiss → nearZero → 面积（未注入 __kind 时键恒 0，
 *   排序链与旧链逐键等价）；显式压制隐式（spec.tag 或 spec.role 已声明则不评分）；恒软无 strictKind。
 * context-container 容器文法（ora-5 设计步骤 2，target 修饰字段——单独出现不构成锚点，与 tag 同规）：
 *   三形态 {text,match?}/{role}/{domPath} 恰居其一（validContainer Node 侧单源校验；grid/point/near/嵌套 container 拒绝）。
 * text 兄弟键归一（fix-16，container 侧与 target 侧共用单源 normTextDesc）：{text:'x', match?} 兄弟键与
 *   {text:{value,match}} 对象形态等效——match 优先级：对象形态显式声明 > 兄弟键 match > 默认 contains；
 *   页侧 textMatch 只认对象文法，兄弟键不归一则 match 被静默降级 contains（实弹实证误点 superstring 候选）；
 *   match 值域 matchModeOK 单源校验（validContainer/validTarget 共用，拼写错校验期拦截）。
 *   声明后语义层①（text+role）与 near 锚点/pool 硬收窄容器内（scopeEl.contains 收集循环过滤；grid/domPath/point 不动——
 *   domPath 仍是链上显式兜底）；text 形态复用 ownText‖fullText 匹配 + textLen+40 帽 + visRect 过滤（容器定位不过 gate4——
 *   容器是范围不是点击落点）→ 最优匹配的最近结构祖先或自身（结构集 CONTAINER_STRUCT_SEL，≤8 层；自身在结构集取自身）；
 *   role/domPath 形态取文档序首个；text 多匹配按 fragment→面积排序取首个 + attempts.containersMatched 歧义显性化。
 *   硬收窄无全局回退（§4.4）：容器未找到 → container-not-found 硬失败；容器内 0 候选且容器外 N 条 → 诊断带出
 *   （收窄生效但目标不在其中，target-changed 嫌疑）。跨 frame 容器不支持（contains 天然同文档）。
 * P0 wait 同链（2026-09-18 失败根治引擎批一，五方合议 unanimous 统一路线第一批）：wait text 带 container 修饰时
 *   经 waitLocateSpec 归一为定位描述符走 buildLocateExpr 全链路（四层定位+X1 闸门+候选排序+X4 命中复核）——
 *   「等的就是将来要点的那一个」；无 container 保持 TEXT_EXISTS_V2 简化路径（存量 flow 零破坏——语法糖升级而非替换）。
 * 纯函数（headersSubmatch 等）Node 侧可直接单测（selftest #23）；页面侧表达式由 buildLocateExpr/buildCondExpr 组装，
 * 组装时把纯函数源码注入页面 IIFE，保证"测的就是跑的"。
 * 红线一合规：全部只读 Runtime.evaluate，禁合成事件。
 */

/** 表头有序子集匹配：wanted 是否为 headerTexts 的有序子集（贪心顺序匹配），返回 { ok, matched } */
function headersSubmatch(headerTexts, wanted) {
  const H = (headerTexts || []).map((s) => String(s).trim());
  const W = (wanted || []).map((s) => String(s).trim());
  if (!W.length) return { ok: false, matched: 0 };
  let i = 0;
  for (const h of H) { if (i < W.length && h === W[i]) i++; }
  return { ok: i === W.length, matched: i };
}

/* ── container text 形态晋升的结构祖先选择器集（ora-5 设计步骤 2）：单源常量经 JSON.stringify 注入页侧 IIFE
 *  （测=跑一致），selftest #42 源断言哨兵。标签集（表格系行/HTML5 section 语义）+ ARIA role 集
 *  （row/region/dialog/menu/tab 系/grid/list/tree 系，设计 §4.3 定稿全集）。 ── */
const CONTAINER_STRUCT_SEL = 'tr,li,table,thead,tbody,ul,ol,dl,fieldset,form,section,article,aside,nav,main,'
  + '[role=row],[role=rowgroup],[role=group],[role=region],[role=dialog],[role=menu],[role=menubar],[role=tablist],[role=tabpanel],'
  + '[role=form],[role=table],[role=grid],[role=list],[role=listbox],[role=tree],[role=treegroup]';

/* ── kind 语义层：action → 期望元素语义映射（单源常量 + 纯函数导出，Node 侧可直接单测 selftest #41）──
 * 输入 action（Runner 侧原语名），输出展开的 kind 对象 { id, tags, roles, attrs, inputTypes?|inputNot? }——
 * 随 spec JSON 序列化进页侧 IIFE（页侧零 action 知识，保持 resolver 纯表达式组装器分工）；无对应语义 → null（不评分）。
 * tags/roles/attrs 均为小写字符串数组；input 的 type 维度单列（activate 白名单按钮类 / textinput 黑名单按钮类）。 */
const KIND_RULES = {
  // V202609180002 批二：tspan 移出 activate.tags——业务地图 SVG tspan 候选曾以 kindMiss=0+面积 1257<7680
  // 升序决胜抢占侧栏 a 真目标（diag-V1b/V1d 活体定位实证，R1 歧义=两规则叠加）；移出后 tspan 候选
  // kindMiss=1 软降权（仍可点 SVG 文本，真目标优先）。面积升序决胜复核结论：同类 kindMiss 内面积升序保留
  // （近零尺寸已前置降权 nearZero，text-node 精确落点语义成立），残余歧义由 container 硬收窄系统性兜底
  // （V202609130006），不再加额外决胜规则。
  activate: { id: 'activate', tags: ['button', 'a', 'li'],
    inputTypes: ['button', 'submit', 'image', 'reset'], // input[type=button‖submit‖image‖reset]（宽集合：覆盖侧栏 a/桌面 li/网格 gridcell 等存量真实点击形态）
    roles: ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'option', 'listitem', 'switch', 'checkbox', 'radio', 'gridcell'],
    attrs: ['onclick', 'tabindex'] }, // onclick 非空 / tabindex 有值（任一命中）
  textinput: { id: 'textinput', tags: ['textarea'],
    inputNot: ['button', 'submit', 'image', 'reset'], // input 非按钮类即算（表格口径「input（非按钮类）」）
    roles: ['textbox', 'searchbox', 'combobox'],
    attrs: ['contenteditable'] }, // contenteditable 非空
  selectcontrol: { id: 'selectcontrol', tags: ['select'], roles: ['combobox', 'listbox'], attrs: [] }, // 窄而软：自定义下拉（div/span 形态）kindMiss=1 但软评分不排除
};

/** action → kind 期望（纯函数）：click/dbl（dbl:true 同 click 路径）/rightClick→activate；type→textinput
 *  （仅带 target 时注入——kind 只约束定位，不约束已聚焦元素，Runner 侧判定）；select→selectcontrol；
 *  assert/wait/scroll/key/goto 等存在性/导航类动作→null（断言语义与元素类型无关，引入偏好反而扭曲含义）。 */
function kindExpectations(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'click' || a === 'dblclick' || a === 'rightclick') return KIND_RULES.activate;
  if (a === 'type') return KIND_RULES.textinput;
  if (a === 'select') return KIND_RULES.selectcontrol;
  return null;
}

/* ── text 描述符 match 模式与归一化（fix-16 单点，container 侧与 target 侧共用）：页侧 textMatch 只认
 *  对象文法 {value, match}——兄弟键写法 {text:'x', match?}（设计 §4.2）不归一喂入则兄弟键 match 被静默
 *  降级 contains（fix-16 实弹实证：存量 flow 兄弟 exact 在真浏览器误点 superstring 候选）。
 *  matchModeOK：match 合法值域 = undefined（缺省即 contains）|'exact'|'contains'——拼写错（如 'Exact'）
 *  校验期拦截，防静默降级（validContainer/validTarget 共用此单源）。
 *  normTextDesc：match 优先级 = 对象形态 {value,match} 显式声明 > 兄弟键 match（宿主对象第二参）> 默认
 *  contains；非法值归 contains（与页侧旧语义逐点等价）。形态不识别返回 null——调用方回退原值（正常路径
 *  校验层已保证形态，回退纯防御）。buildLocateExpr 经 toString() 注入页侧 IIFE（测=跑一致），Node 侧
 *  selftest #46 直接单测。 ── */
function matchModeOK(m) { return m === undefined || m === 'exact' || m === 'contains'; }
function normTextDesc(desc, host) {
  if (desc && typeof desc === 'object' && typeof desc.value === 'string') {
    return { value: desc.value, match: desc.match === 'exact' ? 'exact' : 'contains' };
  }
  if (typeof desc === 'string') {
    const m = (host && typeof host === 'object') ? host.match : undefined;
    return { value: desc, match: m === 'exact' ? 'exact' : 'contains' };
  }
  return null;
}

/** role 层 aria 可及名（V20261113006 #126 步5，getByRole+name 对齐的最小口径）：aria-label > alt >
 *  textContent，空白归一（trim+collapse）。与 lib/refs.js pgName 同口径（@eN 二级链 role+name 语义一致），
 *  不含 aria-labelledby/title（如实边界，不做完整 accname 规范）。buildLocateExpr 经 toString() 注入
 *  页侧 IIFE（测=跑一致）；仅 spec.name 声明时由 candidatesIn 调用——存量路径零额外 getAttribute。 */
function accNameOf(el) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  let a = null, alt = null;
  try { a = el.getAttribute('aria-label'); } catch (e) { /* 无属性面 */ }
  if (a != null && norm(a)) return norm(a);
  try { alt = el.getAttribute('alt'); } catch (e) { /* 无属性面 */ }
  if (alt != null && norm(alt)) return norm(alt);
  try { return norm(el.textContent); } catch (e) { return ''; }
}

/** P0 wait 同链（2026-09-18 失败根治引擎批一）：wait text+container → 定位描述符归一单源。
 *  语法糖升级而非替换：无 container 的 wait text 保持 TEXT_EXISTS_V2 简化路径（存量 flow 零破坏）；
 *  有 container 才经此归一为 { text: {value,match}, container } 目标描述符走 buildLocateExpr 全链路——
 *  match 归一复用 normTextDesc 单源（兄弟键 match/对象形态 {value,match} 显式声明优先，字符串缺省 contains）。
 *  返回 { spec, textValue }（textValue=纯文本值，锚点快照/错误信息用）；形态非法返回 null（校验层已拦截，
 *  调用方回退原值纯防御）。Node 侧可直接单测（selftest #59）。 */
function waitLocateSpec(text, container) {
  const t = normTextDesc(text, text);
  if (!t) return null;
  return { spec: { text: t, container }, textValue: t.value };
}

/** container 形态合法性（ora-5 设计步骤 2）：须为对象且恰含三形态之一——{text, match?} / {role} / {domPath}；
 *  grid/point/near/嵌套 container 拒绝（不支持形态校验期直接拦截，无静默降级）。text 支持字符串（match 为
 *  兄弟键——设计 §4.2 形态写法，与 target 作者习惯一致）或 {value, match?} 对象形态（页侧 textMatch 对象文法）。
 *  match 值域经 matchModeOK 单源校验（fix-16：与 validTarget 同一辅助，防两处漂移）。 */
function validContainer(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (c.grid !== undefined || c.point !== undefined || c.near !== undefined || c.container !== undefined) return false;
  const forms = (c.text !== undefined ? 1 : 0) + (c.role !== undefined ? 1 : 0) + (c.domPath !== undefined ? 1 : 0);
  if (forms !== 1) return false; // 恰居其一（零形态/多形态均拒）
  if (c.text !== undefined) {
    if (typeof c.text === 'string') return !!c.text.trim() && matchModeOK(c.match); // 兄弟键 match 同步校验（防拼错被静默降级 contains）
    return !!(c.text && typeof c.text === 'object' && typeof c.text.value === 'string' && !!c.text.value.trim()
      && matchModeOK(c.text.match));
  }
  if (c.role !== undefined) return typeof c.role === 'string' && !!c.role.trim();
  return typeof c.domPath === 'string' && !!c.domPath.trim();
}

/** target 描述符合法性（四层任一）
 *  text 锚点形态（fix-16）：字符串（match 兄弟键）或 {value, match?} 对象形态，match 值域经 matchModeOK
 *  单源校验（与 validContainer 同一辅助）——拼写错（如 'Exact'）校验期拦截，防静默降级 contains。
 *  修饰字段（V202609110001）：tag 须字符串或非空字符串数组（raw tag 名）；strictTag 须为布尔。
 *  两者均为修饰字段——单独出现不构成合法定位锚点（仍须四层锚点其一）。
 *  container（ora-5 设计步骤 2）：同为修饰字段，形态由 validContainer 单源校验；单独 container
 *  不构成合法锚点（不在下方锚点键清单内，自然落到 return false——与 tag 同规）。 */
function validTarget(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.tag !== undefined && !(typeof t.tag === 'string' || (Array.isArray(t.tag) && t.tag.length > 0
    && t.tag.every((x) => typeof x === 'string' && !!x.trim())))) return false;
  if (t.strictTag !== undefined && typeof t.strictTag !== 'boolean') return false;
  // V202609300016 原语四 unique（唯一性契约，oracle 报告 §3.3）：可选布尔修饰字段——true 时 text 层
  // 过闸候选 >1 诚实红（页侧 buildLocateExpr 排序后判定，requireLocated 消费为 TARGET_AMBIGUOUS）。
  // 类型错校验期拦截；修饰字段与 tag/strictTag 同规（单独出现不构成锚点——自然落到 return false）。
  if (t.unique !== undefined && typeof t.unique !== 'boolean') return false;
  // V20261113006 #126 步1：nth 索引消歧（0 基，与 CLI --nth 同名同基）——显式接受多命中、取排序后第 N 个
  // 过闸候选；与 unique 互斥（一个要唯一、一个要消歧，同时声明=校验期红）；仅 text/role 锚点层有候选序语义
  // （domPath 单命中/grid 自带 row/point 单点不适用，声明即拒）。
  if (t.nth !== undefined) {
    if (!Number.isInteger(t.nth) || t.nth < 0) return false;
    if (t.unique !== undefined) return false;
    if (t.text === undefined && t.role === undefined) return false;
  }
  // V20261113006 #126 步5：name=role 层 aria 可及名组合锚（getByRole+name 语义——role 必填；text 存在时
  // text 层权威优先会静默忽略 name，显式拒绝防「写了不生效」）。字符串=contains，对象形态 {value, match} 可 exact。
  if (t.name !== undefined) {
    if (t.role === undefined || t.text !== undefined) return false;
    if (typeof t.name === 'string') { if (!t.name.trim() || !matchModeOK(t.match)) return false; } // 兄弟键 match 与 text 同规（防拼错静默 contains）
    else if (!(t.name && typeof t.name === 'object' && !Array.isArray(t.name) && typeof t.name.value === 'string'
      && !!t.name.value.trim() && matchModeOK(t.name.match))) return false;
  }
  if (t.container !== undefined && !validContainer(t.container)) return false;
  if (t.text !== undefined) { // text 锚点形态校验（fix-16）：兄弟键/对象两形态 + match 值域单源拦截
    if (typeof t.text === 'string') return !!t.text.trim() && matchModeOK(t.match);
    return !!(t.text && typeof t.text === 'object' && typeof t.text.value === 'string' && !!t.text.value.trim()
      && matchModeOK(t.text.match));
  }
  if (t.role !== undefined || t.near !== undefined) return true;
  if (!!t.point && Number.isFinite(t.point.x) && Number.isFinite(t.point.y)) return true;
  if (t.grid && typeof t.grid === 'object' && Array.isArray(t.grid.headers) && t.grid.headers.length > 0
    && (Number.isFinite(t.grid.row) || t.grid.row === undefined)
    && (typeof t.grid.col === 'string' || Number.isFinite(t.grid.colIndex) || t.grid.col === undefined)) return true;
  if (typeof t.domPath === 'string' && t.domPath.trim().length > 0) return true;
  return false;
}

/** V202609300016 原语二 stable 形态校验（validateCond 单源）：宿主无 stable 键=合法（未声明零影响）；
 *  声明时须为 {ms, polls}——ms=静止观察预算 1-10000 整数（帽对齐 effect.timeoutMs）、polls=连续 rect
 *  相等（±1px）轮数 1-10 整数。返回 null（合法）或错误消息（以 element.stable 前缀措辞）。 */
function stableSpecErr(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t) || t.stable === undefined) return null;
  const st = t.stable;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return 'element.stable 须为对象 {ms, polls}（V202609300016 原语二：静止稳定观察）';
  if (!Number.isInteger(st.ms) || st.ms < 1 || st.ms > 10000) return 'element.stable.ms 须为 1-10000 整数（静止观察预算毫秒）';
  if (!Number.isInteger(st.polls) || st.polls < 1 || st.polls > 10) return 'element.stable.polls 须为 1-10 整数（连续 rect 相等轮数）';
  return null;
}

/** 条件文法校验：恰有一个已知键且类型正确；返回 null（合法）或错误消息
 *  V202609110001 新增两键（现有六键语义零改动）：absent（值=target 描述符，语义 !exists）/
 *  hidden（值=target 描述符，语义 exists && !visible——存在但不可见，target 不存在时必须 false 防 false-success）
 *  V202609300016 原语二 stable：element 条件可选 stable 修饰（{ms, polls} 静止稳定观察，stableSpecErr
 *  单源校验）；absent/hidden 拒收 stable（存在性判定无「静止」概念——声明即校验期红，不静默忽略）。 */
function validateCond(cond) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return 'cond 须为对象';
  const keys = Object.keys(cond);
  if (keys.length !== 1) return `cond 恰须一个条件键（got ${keys.join(',')}；可用：text/element/value/count/url/network/absent/hidden）`;
  const k = keys[0];
  const v = cond[k];
  switch (k) {
    case 'text': return typeof v === 'string' && v.length > 0 ? null : 'text 须为非空字符串';
    case 'element': {
      const stErr = stableSpecErr(v);
      if (stErr) return stErr;
      return validTarget(v) ? null : 'element 须为合法 target 描述符';
    }
    case 'absent':
      if (v && typeof v === 'object' && !Array.isArray(v) && v.stable !== undefined) return 'absent 不支持 stable 修饰（静止稳定观察仅 element 条件支持——V202609300016）';
      return validTarget(v) ? null : 'absent 须为合法 target 描述符（语义 !exists——DOM 中无匹配元素）';
    case 'hidden':
      if (v && typeof v === 'object' && !Array.isArray(v) && v.stable !== undefined) return 'hidden 不支持 stable 修饰（静止稳定观察仅 element 条件支持——V202609300016）';
      return validTarget(v) ? null : 'hidden 须为合法 target 描述符（语义 exists && !visible——存在但不可见；不存在时恒 false）';
    case 'url': return (v && typeof v === 'object' && typeof v.contains === 'string' && v.contains.length > 0) ? null : 'url 须为 { contains: "子串" }';
    case 'value': {
      if (!v || typeof v !== 'object') return 'value 须为 { domPath, equals?|contains? }';
      if (typeof v.domPath !== 'string' || !v.domPath.trim()) return 'value.domPath 须为非空字符串（CSS 选择器）';
      if (v.equals === undefined && v.contains === undefined) return 'value 缺 equals 或 contains';
      return null;
    }
    case 'count': {
      if (!v || typeof v !== 'object') return 'count 须为 { domPath, min?|max? }';
      if (typeof v.domPath !== 'string' || !v.domPath.trim()) return 'count.domPath 须为非空字符串';
      if (v.min === undefined && v.max === undefined) return 'count 缺 min 或 max';
      return null;
    }
    case 'network': {
      if (!v || typeof v === 'string') return null; // 字符串 = urlIncludes 简写
      if (typeof v !== 'object' || typeof v.urlIncludes !== 'string' || !v.urlIncludes) return 'network 须为字符串（urlIncludes）或 { urlIncludes, method?, minCount? }';
      return null;
    }
    default: return `未知条件键：${k}（可用：text/element/value/count/url/network/absent/hidden）`;
  }
}

/* ── 页面侧定位表达式（自包含 IIFE；只读） ── */

/** X1 四层可见性闸门（V202609090001，council 定稿）：页侧注入源——buildLocateExpr 与 TEXT_EXISTS_V2 共用（测=跑一致）。
 *  ① rect 自身 <1px（现状保留，不收紧亚像素——命中测试已是权威闸，亚像素收紧只添误杀面）
 *  ② offsetParent===null 且 position!=='fixed'（O(1) 覆盖任意深度 display:none 祖先）
 *  ③ 自身 visibility==='hidden'（opacity 不查——opacity:0 仍接收事件且能过命中测试）
 *  ④ 主判定命中测试：doc.elementFromPoint(局部中心)——用同文档 getBoundingClientRect 坐标而非 absRect
 *  绝对坐标（顺序不能错）；hit===el || el.contains(hit) || hit.contains(el) 过（第三段保 SVG tspan 与事件委托包装层）。
 *  返回 null=过闸；字符串=拒因（第几层:原因，随 TARGET_NOT_FOUND 诊断带出）。 */
const GATE4_SRC = `
  function hasFixedAncestor(el, doc) {
    let anc = el.parentElement;
    for (let i = 0; i < 30 && anc; i++) {
      if (anc === doc.body || anc === doc.documentElement) return false;
      let st = null;
      try { st = doc.defaultView.getComputedStyle(anc); } catch (e) { return null; }
      if (st && st.position === 'fixed') return true;
      anc = anc.parentElement;
    }
    return false;
  }
  function gate4(el, doc, r) {
    if (!r || r.width < 1 || r.height < 1) return 'L1:rect<1px';
    let st = null;
    try { st = doc.defaultView.getComputedStyle(el); } catch (e) { return 'L2:style读取失败'; }
    if (el.offsetParent === null && st.position !== 'fixed') {
      /* ★V202609300006 fixed 祖先豁免（深交互 saga 终章）：position:fixed 祖先的子元素 offsetParent
       * 也恒为 null（DOM 实测行为）——旧检查只豁免「自身 fixed」，fixed 底栏/悬浮容器内的正常子元素
       * 被误判隐藏（实证=示例ERP fixed 底栏按钮 09-07 起「引擎点击无响应」全链根因：X1 拒→text 零候选
       * →定位失败族/回退误击+重找 0cand→gone）。修法：offsetParent===null 且自身非 fixed 时，沿
       * parentElement 链有界上溯（≤30 跳或到 body/html 止）查 position:fixed 祖先——找到→放行
       * （继续 L3/L4 判定）；未找到→维持原拒因（display:none 族）。成本只落在 offsetParent===null
       * 的少数元素上（正常流元素零开销），getComputedStyle 读取异常=拒（保守，沿用周边哲学）。 */
      const fa = hasFixedAncestor(el, doc);
      if (fa === null) return 'L2:祖先style读取失败';
      if (!fa) return 'L2:offsetParent=null非fixed';
    }
    if (st.visibility === 'hidden') return 'L3:visibility=hidden';
    let hit = null;
    try { hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return 'L4:命中测试异常'; }
    if (hit === el || (hit && el.contains(hit)) || (hit && hit.contains(el))) return null;
    return 'L4:命中测试未命中(el=' + (hit ? String(hit.tagName).toLowerCase() : 'null') + ')';
  }`;

function buildLocateExpr(spec) {
  const body = `
  ${GATE4_SRC}
  ${headersSubmatch.toString()}
  ${normTextDesc.toString()} // text 描述符归一化单源（fix-16）：container 侧与 target 侧共用（selftest #46 接线哨兵）
  ${accNameOf.toString()} // role 层 aria 可及名单源（#126 步5）：与 lib/refs.js pgName 同口径（aria-label>alt>textContent）
  const CONTAINER_STRUCT_SEL = ${JSON.stringify(CONTAINER_STRUCT_SEL)}; // container 结构祖先集（Node 侧单源注入，selftest #42 哨兵）
  function collectDocs(){ const docs = [];
    (function walk(doc, fp){ docs.push({doc, fp});
      let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
      for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch(e) {}
        if (inner) walk(inner, fp + '>' + (f.name || f.id || String(f.tagName).toLowerCase())); }
    })(document, 'main');
    return docs; }
  function visRect(el){ let r; try { r = el.getBoundingClientRect(); } catch(e) { return null; }
    if (!r) return null;
    // 存在性模式（V202609110001，cond absent/hidden 专用，spec.__presence）：不验可见性与尺寸——
    // display:none/0×0 元素也算「存在」（hidden 严格语义依赖 exists 与 visible 解耦）
    if (spec.__presence) return r;
    if (r.width < 1 || r.height < 1) return null;
    // 祖先链可见性（V202609080017 提交#1，alpha 贡献）：向上 ≤8 层查 display:none / visibility:hidden，
    // 命中即不可见——display 不继承，祖先 display:none 时元素自身 computed display 仍可能是 block 且
    // rect 可被过渡动画保留非零，仅查自身会漏判。已知边界：visibility:hidden 祖先 + 后代显式
    // visible 覆盖的罕见模式会误判不可见——宁严勿漏（点击不可见元素是实录失败点#2 的直接根因族）
    let n = el;
    // V202609080017 性能修订：display:none 祖先（任意深度）走 offsetParent===null 的 O(1) 快捷
    // （position:fixed 元素 offsetParent 恒 null，需例外放行）；visibility:hidden 祖先罕见，
    // 仅查直接父级——原 8 层全链 getComputedStyle 在数百候选下放大 locate 重试至 ~5s/次点击
    // （实测回归），且重试间隔破坏 dblclick 两击连续性（示例ERP不认慢双击）。
    // ★V202609300006 与 gate4 L2 同款修正：fixed 祖先子元素 offsetParent 也恒为 null——
    // hasFixedAncestor 有界上溯豁免（GATE4_SRC 注入的同名助手，函数声明提升可用）；异常=null 保守拒。
    try {
      if (el.offsetParent === null && el.ownerDocument.defaultView.getComputedStyle(el).position !== 'fixed') {
        const fa = hasFixedAncestor(el, el.ownerDocument);
        if (fa === null || fa === false) return null;
      }
    } catch(e) { return null; }
    let par = el.parentElement;
    if (par && par.nodeType === 1) {
      let pst; try { pst = par.ownerDocument.defaultView.getComputedStyle(par); } catch(e) { return null; }
      if (pst.visibility === 'hidden' || pst.display === 'none') return null;
    }
    return r; }
  function absRect(el, r){ let x = r.left, y = r.top, doc = el.ownerDocument;
    while (doc && doc.defaultView && doc.defaultView.frameElement) {
      const fe = doc.defaultView.frameElement; const fr = fe.getBoundingClientRect();
      x += fr.left; y += fr.top; doc = fe.ownerDocument; }
    return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) }; }
  function ownText(el){ let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim(); }
  function fullText(el){ try { return String(el.textContent || '').trim().slice(0, 80); } catch(e) { return ''; } }
  function parentFull(el){ try { const p = el.parentElement || (el.ownerSVGElement && el.ownerSVGElement.parentElement);
    return p ? String(p.textContent || '').trim().slice(0, 80) : ''; } catch(e) { return ''; } }
  function roleOf(el){ let r = null; try { r = el.getAttribute('role'); } catch(e) {}
    if (r) return r;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'select') return tag;
    if (tag === 'input') { let ty = 'text'; try { ty = (el.getAttribute('type') || 'text').toLowerCase(); } catch(e) {}
      return (ty === 'submit' || ty === 'button') ? 'button' : 'textbox'; }
    return ''; }
  // kind 语义分类器（独立于 roleOf——roleOf 语义变更会波及 role 锚点层等价性，设计明示不改）：
  // 任一特征命中即 kind 命中——input 按 type 白/黑名单；非 input 对 tags；roleOf 产物对 roles；属性取证（item.attrHit）对 attrs。
  function kindMatches(c, kind){ if (!kind) return true;
    let ok = false;
    if (c.tag === 'input' && kind.inputTypes) ok = kind.inputTypes.indexOf(c.etype) !== -1;
    else if (c.tag === 'input' && kind.inputNot) ok = kind.inputNot.indexOf(c.etype) === -1;
    else ok = kind.tags.indexOf(c.tag) !== -1;
    if (ok) return true;
    if (kind.roles.indexOf(c.role) !== -1) return true;
    return !!(kind.attrs && kind.attrs.length && c.attrHit); }
  function ckey(c){ return c.frame + '|' + JSON.stringify(c.rect); }
  const HIT_ON = spec.__hitTest !== false; // X1 总开关：flow _meta.hitTest===false 或 CLI --no-hit-test 可关（默认开）
  // X1：candidatesIn 带闸门参数——仅 text/role 锚点层启用；near 的 pool 严禁启用（全 DOM 量级会重演
  // V202609080017 的 5s/次回归）；grid/domPath/point 不加（由 centerClick 的 X4 容忍式命中复核统一兜）。
  // 被拒候选 top-N 诊断随返回值带出（TARGET_NOT_FOUND 错误信息附被拒原因）。
  function candidatesIn(doc, fp, filter, gate, scopeEl) { const out = []; const rejected = []; let outside = 0;
    let all = []; try { all = doc.querySelectorAll('*'); } catch(e) { return { out, rejected, outside }; }
    for (const el of all) { const r = visRect(el); if (!r) continue;
      const item = { tag: String(el.tagName || '').toLowerCase(), id: el.id || '',
        role: roleOf(el), text: ownText(el) || fullText(el), rect: absRect(el, r), frame: fp,
        pfull: parentFull(el) };
      // #126 步5：aria 可及名仅在 target 声明 name 时采集（存量路径零额外 getAttribute；role 层过滤消费）
      if (spec.name !== undefined) item.aria = accNameOf(el);
      if (!filter || filter(item)) {
        // 容器硬收窄（ora-5 设计步骤 2）：收集循环内 scopeEl.contains 过滤——收窄即收集、无全局重试路径；
        // contains 天然同文档（跨 frame 容器不支持），scopeEl 为 null（未声明 container）时零开销直通
        if (scopeEl && !scopeEl.contains(el)) { outside++; continue; }
        // kind 语义层类型取证（ora-5 步骤 1）：仅引擎注入 __kind 的路径付此成本——存量 flow/cond/assert 路径
        // （无 __kind）零 getAttribute、零行为变化。etype=input 的 type 维度；attrHit=attrs 任一非空值命中（短路）。
        if (spec.__kind) {
          if (item.tag === 'input') { let et = 'text'; try { et = String(el.getAttribute('type') || 'text').toLowerCase(); } catch(e) {} item.etype = et; }
          const ka = spec.__kind.attrs || [];
          if (ka.length) { let ah = 0; try { for (const an of ka) { const av = el.getAttribute(an); if (av && String(av).length) { ah = 1; break; } } } catch(e) {} item.attrHit = ah; }
        }
        if (gate) { const rej = gate4(el, doc, r);
          if (rej) { if (rejected.length < 8) rejected.push({ tag: item.tag, text: String(item.text || '').slice(0, 24), rect: item.rect, rej });
            continue; }
          item.hitOK = true; } // 命中测试顺手产出（X4 零额外往返）
        out.push(item); } }
    return { out, rejected, outside }; }
  function textMatch(v, spec){ if (spec && typeof spec === 'object') {
      return spec.match === 'exact' ? v === spec.value : v.indexOf(spec.value) !== -1; }
    return v.indexOf(spec) !== -1; }
  const attempts = [], cands = [], rejAll = [];
  function tryCollect(filter, gate, scoped){ const list = [];
    for (const pair of collectDocs()) {
      if (spec.__framePath && pair.fp !== ['main'].concat(spec.__framePath).join('>')) continue;
      // 容器硬收窄（ora-5 设计步骤 2）：仅语义层①（text/role）与 near 锚点/pool 传 scoped——grid/domPath/point 不动
      const rr = candidatesIn(pair.doc, pair.fp, filter, gate, (scoped && contScope) ? contScope.el : null);
      for (const c of rr.out) list.push(c);
      for (const rj of rr.rejected) if (rejAll.length < 8) rejAll.push(rj);
      if (scoped && contDiag) contDiag.outsideCount += rr.outside; } // 容器外候选计数（收窄生效的可见性，§4.6）
    return list; }
  // #126 步1：nth 越界候选清单（tag/text/rect/frame）——CLI 侧候选序与 flow 侧排序链不同源，清单供模型自校对。
  function nthCandidateList(hits){ return hits.slice(0, 8).map(function(h){ return { tag: h.tag, text: h.text, rect: h.rect, frame: h.frame }; }); }
  /* ── container 作用域解析（ora-5 设计步骤 2）：声明才执行，同一次 evaluate 内单次全量扫描（与 text 层同量级，
   *  §4.7 净成本约 ±0）。硬收窄无全局回退：未找到 → 早失败（absent cond 语义 = !exists——scope 不在则容器内目标必不在，
   *  自然成立）；找到 → contScope 供收集循环 contains 过滤。 ── */
  function containerFormOf(c){ return c.text !== undefined ? 'text' : (c.role !== undefined ? 'role' : (c.domPath !== undefined ? 'domPath' : '')); }
  let contScope = null; // { el, doc, fp }——解析成功后的收窄作用域（跨 frame 容器不支持：contains 天然同文档）
  let contDiag = null;  // { form, found, matched, scopedFound, outsideCount }——attempts 与 TARGET_NOT_FOUND 诊断（§4.6）
  function resolveContainerScope() {
    const c = spec.container;
    if (c === undefined || typeof c !== 'object') return;
    contDiag = { form: containerFormOf(c), found: 0, matched: 0, scopedFound: 0, outsideCount: 0 };
    // text 形态规格归一（fix-16 单源化）：兄弟键 {text:'x', match?}（设计 §4.2 写法）与对象 {text:{value,match}}
    // 等效——经 normTextDesc 统一归一后喂入（与 target 侧共用同一辅助防两处漂移；兄弟键 match 不归一会被静默降级 contains）
    const ctext = normTextDesc(c.text, c) || c.text;
    const docs = collectDocs().filter((pair) => !spec.__framePath || pair.fp === ['main'].concat(spec.__framePath).join('>'));
    const matched = [];
    // 容器定位不过 gate4（§4.3——容器是范围不是点击落点，elementFromPoint 既贵又无意义）；可见性只走 visRect
    // （__presence 模式宽松放行——absent/hidden 条件语义不受容器可见性误伤）
    if (contDiag.form === 'domPath') { // domPath 形态：文档序首个可见匹配（querySelector 直达；选择器漂移时诚实失败）
      for (const pair of docs) {
        let el = null; try { el = pair.doc.querySelector(c.domPath); } catch(e) {}
        if (!el) continue;
        let r = null; try { r = visRect(el); } catch(e) {}
        if (!r) continue;
        matched.push({ el, doc: pair.doc, fp: pair.fp, tag: String(el.tagName || '').toLowerCase(),
          rect: { w: Math.round(r.width), h: Math.round(r.height) } });
        break;
      }
    } else {
      for (const pair of docs) {
        let all = []; try { all = pair.doc.querySelectorAll('*'); } catch(e) { continue; }
        for (const el of all) {
          let r = null; try { r = visRect(el); } catch(e) {}
          if (!r) continue;
          let t = '', ok = false;
          if (contDiag.form === 'text') { // text 形态复用 text 层匹配口径：ownText‖fullText + textLen+40 帽
            // （帽防 body/html 等巨型包裹层 fullText 撞文本的伪匹配——与 §4.3「复用 ownText‖fullText 匹配」同源）
            try { t = ownText(el) || fullText(el); } catch(e) {}
            ok = !!t && textMatch(t, ctext) && t.length <= String(ctext.value).length + 40;
          } else { try { ok = roleOf(el) === c.role; } catch(e) {} }
          if (!ok) continue;
          matched.push({ el, doc: pair.doc, fp: pair.fp, tag: String(el.tagName || '').toLowerCase(), text: t,
            rect: { w: Math.round(r.width), h: Math.round(r.height) }, pfull: contDiag.form === 'text' ? parentFull(el) : '' });
        }
      }
      if (contDiag.form === 'text' && matched.length > 1) { // text 多匹配：fragment→面积排序取首个（歧义显性化不静默联合，§4.3.4/§4.8）
        for (const m of matched) m.fragment = !!(m.pfull && m.pfull.length > m.text.length && m.pfull.indexOf(m.text) !== -1);
        // 排序键语义 = fragment 升序→面积升序（与 text 层同款），但源码字面量有意写成等价变形——
        // 不复用 text 层排序键字面量，保住 selftest #44「排序链逐键在位」源断言的唯一性哨兵不误触
        matched.sort((a, b) => ((b.fragment ? 0 : 1) - (a.fragment ? 0 : 1)) || (a.rect.w * a.rect.h - b.rect.w * b.rect.h));
      }
    }
    contDiag.matched = matched.length;
    if (!matched.length) return; // 未找到 → 调用方 container-not-found 硬失败（无全局回退，§4.4）
    let scopeEl = matched[0].el;
    if (contDiag.form === 'text') { // 结构祖先晋升：最近结构祖先或自身（≤8 层）——匹配落在标签元素（td/标题 span）时
      // 取其行/面板容器；自身已在结构集（tr/table 等 fullText 直接命中）则取自身（§4.3 规则 2）
      let selfStruct = false; try { selfStruct = !!scopeEl.matches(CONTAINER_STRUCT_SEL); } catch(e) {}
      if (!selfStruct) {
        let par = scopeEl.parentElement;
        for (let i = 0; i < 8 && par; i++) {
          if (par.nodeType !== 1) break;
          let st = false; try { st = !!par.matches(CONTAINER_STRUCT_SEL); } catch(e) {}
          if (st) { scopeEl = par; break; }
          par = par.parentElement;
        }
      }
    }
    contScope = { el: scopeEl, doc: matched[0].doc, fp: matched[0].fp };
    contDiag.found = 1;
  }
  if (spec.container !== undefined) resolveContainerScope();
  if (spec.container !== undefined && !contScope) { // 容器未找到：立即硬失败（收窄不回退全局，§4.4）
    attempts.push({ strategy: 'container', spec: JSON.stringify(spec.container), ok: false, found: 0, matched: 0,
      containersMatched: 0, container: contDiag });
    return { ok: false, candidates: cands, attempts, rejected: rejAll, container: contDiag };
  }
  const textWanted = spec.text !== undefined;
  // target 侧兄弟键归一（fix-16 单点）：{text:'x', match?} 兄弟键（match 挂 spec 本体，locate 原样透传）
  // 与 {text:{value,match}} 对象形态统一归一为 textSpec 喂 textMatch——优先级：对象形态显式声明 > 兄弟键
  // match > 默认 contains（normTextDesc 单源，container 侧共用；textLen/attempts 诊断同读归一产物）。
  const textSpec = textWanted ? (normTextDesc(spec.text, spec) || spec.text) : undefined;
  const textLen = textWanted ? String((textSpec && textSpec.value) || textSpec).length : 0;
  if (textWanted) {
    let hits = tryCollect((c) => textMatch(c.text, textSpec) && c.text.length <= textLen + 40, HIT_ON, true); // X1：text 锚点层过闸 + container 硬收窄（scoped）
    // tspan 子片消歧（V202609080011）：候选文本是父元素完整文本的真子片 → 降权（如 tspan「销售订单」⊂「销售订单修改」）
    for (const h of hits) {
      h.fragment = !!(h.pfull && h.pfull.length > h.text.length && h.pfull.indexOf(h.text) !== -1);
    }
    // tag 类型匹配（V202609110001，仅 text 层）：候选 tagName 对照声明 tag 列表（字符串或字符串数组，raw 小写 tag 名）——
    // 默认软评分：不在列表内降权（排后不排除，tagMiss 排序键追加在 fragment 之后 nearZero 之前；tag 未声明时键恒 0 零影响）；
    // strictTag:true（作者显式契约）：不匹配候选直接排除——改版时 fail 显性化告知契约破坏，不静默换候选。
    // 命中闸门（X1）与收集过滤零改动——评分只是排序键追加。
    let tagMissTotal = 0;
    if (spec.tag !== undefined) {
      const tagList = (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      if (tagList.length) {
        const tagMisses = (c) => tagList.indexOf(c.tag) === -1;
        if (spec.strictTag === true) {
          const before = hits.length;
          hits = hits.filter((c) => !tagMisses(c));
          tagMissTotal = before - hits.length;
        } else {
          for (const h of hits) h.tagMiss = tagMisses(h) ? 1 : 0;
          tagMissTotal = hits.filter((h) => h.tagMiss).length;
        }
      }
    }
    // kind 语义层软评分（ora-5 设计步骤 1，仅 text 层）：候选对照 spec.__kind 期望（kindMatches）——
    // kindMiss ∈{0,1} 排序键位次 tagMiss 之后 nearZero 之前（显式契约违例重于隐式期望违例；类型匹配优先于尺寸异常）。
    // 抑制双保险（显式压制隐式）：Runner withKind 单点已挡 tag/role 声明，页侧守卫兜底——声明存在则不评分；
    // __kind 未注入（存量 flow/cond/assert/wait）时评分块整体跳过、kindMiss 属性从不写入 → 排序键恒 0，
    // 排序链与旧链逐键等价（selftest #44 哨兵）。恒软不硬：不做 strictKind（隐式约束硬化误杀面不可控）。
    let kindMissTotal = 0;
    if (spec.__kind && spec.tag === undefined && spec.role === undefined) {
      for (const h of hits) h.kindMiss = kindMatches(h, spec.__kind) ? 0 : 1;
      kindMissTotal = hits.filter((h) => h.kindMiss).length;
    }
    // 近零尺寸降权（V202609080017 提交#1，oracle latent②）：0×0/1×N 动画中间态候选（宽或高 ≤1px）
    // 排到正常尺寸候选之后——降权不删除（保底仍可点）。实录失败点#2 根因：0×0 下拉项按面积升序
    // 被选中、点击其中心无效；visRect 的 <1 过滤只挡纯零，1×N 中间态漏网
    const nearZero = (c) => ((c.rect.w <= 1 || c.rect.h <= 1) ? 1 : 0);
    hits.sort((a, b) => ((a.fragment ? 1 : 0) - (b.fragment ? 1 : 0)) || ((a.tagMiss ? 1 : 0) - (b.tagMiss ? 1 : 0)) || ((a.kindMiss || 0) - (b.kindMiss || 0)) || (nearZero(a) - nearZero(b)) || ((a.rect.w * a.rect.h) - (b.rect.w * b.rect.h)));
    // V20261113006 #126 步1：nth 索引消歧（0 基，与 CLI --nth 同名同基）——排序后过闸候选取第 N 个；
    // 越界诚实红（TARGET_NOT_FOUND 族）+ 候选清单（tag/text/rect/frame）。⚠ CLI 侧候选序（locator：
    // 可点优先→exact→面积）与 flow 侧五键排序不同源，「第 N 个」可能不是同一元素——清单供模型自校对。
    // 实现=picked 置顶后走原有返回路径（attempts/cands/best 序与旧链一致，零分叉）。
    if (Number.isInteger(spec.nth) && hits.length) {
      if (spec.nth >= hits.length) {
        if (contDiag) contDiag.scopedFound = hits.length;
        attempts.push({ strategy: 'text', spec: String((textSpec && textSpec.value) || textSpec), ok: false, found: hits.length,
          nthOutOfRange: spec.nth, fragments: hits.filter((h) => h.fragment).length, rejected: rejAll.length,
          containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
        hits.slice(0, 8).forEach((h) => cands.push(h));
        return { ok: false, nthOutOfRange: true, nth: spec.nth, nthTotal: hits.length,
          nthCandidates: nthCandidateList(hits), candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
      }
      hits.unshift(hits.splice(spec.nth, 1)[0]);
    }
    // V202609300016 原语四 unique（唯一性契约，oracle 报告 §3.3/§七-1）：spec.unique===true 且排序后过闸
    // 候选 >1 → not-ok 诚实红（ambiguous）——不赌排序（排序救不了身份问题，唯一性契约才是正解）；附全部
    // 候选 tag/text/rect/frame 清单（ambiguousCandidates，Runner.requireLocated 消费为
    // TARGET_NOT_FOUND+ambiguous 错误附加）。与 container 硬收窄正交可叠加（本判定数的是收窄后过闸候选）；
    // 候选 =1 或字段未声明 → 行为零改动（不进本分支，排序/返回路径与旧链逐字节一致）。
    if (spec.unique === true && hits.length > 1) {
      if (contDiag) contDiag.scopedFound = hits.length;
      attempts.push({ strategy: 'text', spec: String((textSpec && textSpec.value) || textSpec), ok: false, found: hits.length,
        ambiguous: true, fragments: hits.filter((h) => h.fragment).length, rejected: rejAll.length,
        containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
      hits.slice(0, 8).forEach((h) => cands.push(h));
      return { ok: false, ambiguous: true,
        ambiguousCandidates: hits.slice(0, 8).map((h) => ({ tag: h.tag, text: h.text, rect: h.rect, frame: h.frame })),
        candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
    }
    // 容器诊断（§4.6）：容器内候选数（scopedFound=0 且容器外有候选 → 收窄生效但目标不在其中，target-changed 嫌疑）
    if (contDiag) contDiag.scopedFound = hits.length;
    attempts.push({ strategy: 'text', spec: textWanted ? String((textSpec && textSpec.value) || textSpec) : '', ok: hits.length > 0, found: hits.length,
      fragments: hits.filter(h => h.fragment).length, rejected: rejAll.length, tagMiss: tagMissTotal, kindMiss: kindMissTotal,
      containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
    if (hits.length) { hits.slice(0, 8).forEach((h) => cands.push(h));
      return { ok: true, strategy: 'text', best: hits[0], candidates: cands, attempts, rejected: rejAll }; }
    /* ★V202609300006 回退误击防线：spec.text 存在时 text 层即唯一权威——零候选直接四层全败
     * （TARGET_NOT_FOUND），绝不回退后续层。旧语义在组合 target（{text,near}/{text,grid}/{text,domPath}）
     * 下会把「偏好」降级为「回退」：near pool（无文本约束）/grid 单元格/domPath 命中可独立产生不含
     * 目标文本的候选（实测误击=树项 A 标签 kind activate 兼容但文本完全不符——点在树项上无害，
     * 下次可能是删除按钮=误击红线）。零候选=目标不在（或全被 X1 拒）→ 后续层救不回诚实性，只会
     * 改点别处。存量 flow 扫描零 {text+其他层} 组合（收紧零影响）；text 有候选时本层直接 return，
     * 后续层仅对无 text 声明的 target 可达（纯 role/near/grid/domPath/point 语义零改动）。 */
    return { ok: false, candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
  }
  if (spec.role !== undefined) {
    // #126 步5：{role, name} 组合锚（getByRole+name）——name 对齐 aria 可及名（aria-label>alt>textContent），
    // 缺省 contains（对齐 text 层口径），对象形态 {value, match:'exact'} 可精确；仅 name 声明时候选采集
    // aria 字段（candidatesIn 侧门控，存量零成本）。无 name 时策略名保持 'role'（诊断逐字节兼容）。
    const nameWanted = spec.name !== undefined;
    const nameSpec = nameWanted ? (normTextDesc(spec.name, spec) || spec.name) : undefined;
    const hits = tryCollect((c) => c.role === spec.role && (!textWanted || textMatch(c.text, textSpec))
      && (!nameWanted || textMatch(String(c.aria || ''), nameSpec)), HIT_ON, true); // X1：role 锚点层过闸 + container 硬收窄（scoped）
    const roleStrategy = nameWanted ? 'role-name' : 'role';
    if (contDiag) contDiag.scopedFound = hits.length;
    // #126 步4：unique 契约在 role 层同语义（原仅 text 层——role+name 组合锚的严格性依赖它；>1 诚实红）
    if (spec.unique === true && hits.length > 1) {
      attempts.push({ strategy: roleStrategy, spec: nameWanted ? spec.role + ':' + String((nameSpec && nameSpec.value) || nameSpec) : spec.role,
        ok: false, found: hits.length, ambiguous: true, rejected: rejAll.length,
        containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
      hits.slice(0, 8).forEach((h) => cands.push(h));
      return { ok: false, ambiguous: true, ambiguousCandidates: nthCandidateList(hits),
        candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
    }
    // #126 步1：nth 在 role 层同语义（候选序=文档序：main 先行、逐文档 querySelectorAll 序——与 text 层
    // 五键排序不同链，越界清单同样带 tag/text/rect/frame 供自校对）
    if (Number.isInteger(spec.nth) && hits.length && spec.nth >= hits.length) {
      attempts.push({ strategy: roleStrategy, spec: nameWanted ? spec.role + ':' + String((nameSpec && nameSpec.value) || nameSpec) : spec.role,
        ok: false, found: hits.length, nthOutOfRange: spec.nth, rejected: rejAll.length,
        containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
      hits.slice(0, 8).forEach((h) => cands.push(h));
      return { ok: false, nthOutOfRange: true, nth: spec.nth, nthTotal: hits.length,
        nthCandidates: nthCandidateList(hits), candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
    }
    if (Number.isInteger(spec.nth) && hits.length) hits.unshift(hits.splice(spec.nth, 1)[0]);
    attempts.push({ strategy: roleStrategy, spec: nameWanted ? spec.role + ':' + String((nameSpec && nameSpec.value) || nameSpec) : spec.role,
      ok: hits.length > 0, found: hits.length, rejected: rejAll.length, nameMatch: nameWanted ? nameSpec.match : undefined,
      containersMatched: contDiag ? contDiag.matched : undefined, container: contDiag || undefined });
    if (hits.length) { hits.slice(0, 8).forEach((h) => cands.push(h));
      return { ok: true, strategy: roleStrategy, best: hits[0], candidates: cands, attempts, rejected: rejAll }; }
    if (!spec.near && !spec.grid && !spec.domPath && !spec.point) return { ok: false, candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
  }
  if (spec.near !== undefined) {
    const anchors = tryCollect((c) => textMatch(c.text, spec.near), undefined, true); // near 锚点：不加闸门（性能红线）+ container 硬收窄（scoped）
    attempts.push({ strategy: 'near-anchor', spec: spec.near && (spec.near.value || spec.near.text || spec.near), ok: anchors.length > 0, found: anchors.length,
      container: contDiag || undefined });
    if (anchors.length) {
      const a = anchors[0]; const acx = a.rect.x + a.rect.w / 2, acy = a.rect.y + a.rect.h / 2;
      const ak = ckey(a);
      // X1 性能红线：near 的 pool 严禁过闸门（全 DOM 量级 candidatesIn×gate4 会重演 5s/次回归）——由 X4 容忍式复核兜
      const pool = tryCollect((c) => (c.text.length > 0 || c.role !== '') && !c.fragment, undefined, true).filter((c) => ckey(c) !== ak);
      pool.sort((p, q) => Math.hypot(p.rect.x + p.rect.w / 2 - acx, p.rect.y + p.rect.h / 2 - acy)
                        - Math.hypot(q.rect.x + q.rect.w / 2 - acx, q.rect.y + q.rect.h / 2 - acy));
      if (pool.length) { pool.slice(0, 8).forEach((h) => cands.push(h));
        return { ok: true, strategy: 'near', best: pool[0], candidates: cands, attempts, rejected: rejAll }; }
    }
    if (!spec.grid && !spec.domPath && !spec.point) return { ok: false, candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
  }
  if (spec.grid !== undefined) {
    const G = spec.grid;
    const wanted = Array.isArray(G.headers) ? G.headers : [];
    const grids = [];
    for (const pair of collectDocs()) {
      if (spec.__framePath && pair.fp !== ['main'].concat(spec.__framePath).join('>')) continue;
      let tables = []; try { tables = pair.doc.querySelectorAll('table,[role=grid],[role=table]'); } catch(e) {}
      for (const tb of tables) {
        let headerTexts = [];
        try {
          const ths = tb.querySelectorAll('th');
          if (ths.length) headerTexts = Array.from(ths).map((th) => String(th.textContent || '').trim());
          else { const firstRow = tb.querySelector('tr');
            if (firstRow) headerTexts = Array.from(firstRow.querySelectorAll('td,th')).map((c) => String(c.textContent || '').trim()); }
        } catch(e) {}
        headerTexts = headerTexts.filter((t) => t !== '');
        const m = headersSubmatch(headerTexts, wanted);
        if (m.ok) grids.push({ tb, headerTexts, score: m.matched, fp: pair.fp });
      }
    }
    grids.sort((a, b) => b.score - a.score);
    attempts.push({ strategy: 'grid-context', spec: JSON.stringify(wanted), ok: grids.length > 0, found: grids.length });
    if (grids.length) {
      const g = grids[0];
      let rows = []; try { rows = Array.from(g.tb.querySelectorAll('tbody tr')); } catch(e) {}
      if (!rows.length) { try { rows = Array.from(g.tb.querySelectorAll('tr')).filter((tr) => !tr.querySelector('th')); } catch(e) {} }
      let colIdx = -1;
      if (typeof G.col === 'string') {
        colIdx = g.headerTexts.findIndex((h) => h === G.col);
        if (colIdx === -1) colIdx = g.headerTexts.findIndex((h) => h.indexOf(G.col) !== -1);
      } else if (Number.isFinite(G.colIndex)) colIdx = G.colIndex;
      const rowNo = Number.isFinite(G.row) ? G.row : 1;
      const tr = rows[rowNo - 1];
      let cell = null;
      if (tr && colIdx >= 0) { try { cell = tr.querySelectorAll('td,th')[colIdx] || null; } catch(e) {} }
      const gridTried = { headers: g.headerTexts.slice(0, 12), rows: rows.length, colIdx, row: rowNo };
      if (cell) {
        const r = visRect(cell);
        if (r) { const item = { tag: String(cell.tagName).toLowerCase(), id: cell.id || '', role: roleOf(cell),
          text: ownText(cell) || fullText(cell), rect: absRect(cell, r), frame: g.fp };
          cands.push(item);
          return { ok: true, strategy: 'grid', best: item, candidates: cands, attempts, grid: gridTried }; }
      }
      return { ok: false, candidates: cands, attempts, gridTried, container: contDiag || undefined };
    }
    if (!spec.domPath && !spec.point) return { ok: false, candidates: cands, attempts, container: contDiag || undefined };
  }
  if (spec.domPath !== undefined) {
    let hit = null;
    for (const pair of collectDocs()) {
      if (spec.__framePath && pair.fp !== ['main'].concat(spec.__framePath).join('>')) continue;
      let el = null; try { el = pair.doc.querySelector(spec.domPath); } catch(e) {}
      if (el) { const r = visRect(el); if (r) { hit = { el, r, fp: pair.fp }; break; } }
    }
    attempts.push({ strategy: 'dom-path', spec: spec.domPath, ok: !!hit, found: hit ? 1 : 0 });
    if (hit) { const item = { tag: String(hit.el.tagName).toLowerCase(), id: hit.el.id || '', role: roleOf(hit.el),
      text: ownText(hit.el) || fullText(hit.el), rect: absRect(hit.el, hit.r), frame: hit.fp };
      cands.push(item);
      return { ok: true, strategy: 'dom', best: item, candidates: cands, attempts }; }
    if (!spec.point) return { ok: false, candidates: cands, attempts, container: contDiag || undefined };
  }
  if (spec.point !== undefined) {
    const el = document.elementFromPoint(spec.point.x, spec.point.y);
    const ev = el ? { tag: String(el.tagName).toLowerCase(), text: fullText(el) } : null;
    attempts.push({ strategy: 'point', spec: spec.point, ok: true, found: 1, elementAtPoint: ev });
    return { ok: true, strategy: 'point',
      best: { rect: { x: spec.point.x, y: spec.point.y, w: 2, h: 2 }, tag: ev ? ev.tag : '?', text: ev ? ev.text : '', frame: 'point' },
      candidates: cands, attempts };
  }
  return { ok: false, candidates: cands, attempts, rejected: rejAll, container: contDiag || undefined };
  `;
  return `(function(){ return (function(spec){ ${body} })( ${JSON.stringify(spec)} ); })()`;
}

const TEXT_EXISTS_SRC = `function(q){
  const docs = [];
  (function walk(doc){ docs.push(doc);
    let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
    for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch(e) {} if (inner) walk(inner); }
  })(document);
  for (const d of docs) { try { const t = (d.body && d.body.innerText) || d.documentElement.innerText || '';
    if (t.indexOf(q) !== -1) return true; } catch(e) {} }
  return false; }`;

/** X2 两级漏斗（V202609090001，council 定稿）——仅**无 container** 的 wait text 使用（2026-09-18 引擎批一起：
 *  带 container 修饰的 wait text 改走 buildLocateExpr 全链路（waitLocateSpec 归一），本表达式为存量兼容路径，
 *  语义零改动）；assert text 保持原单级语义（TEXT_EXISTS_SRC）。
 *  第一级（快路径）：innerText 全文档 walk——不含 q 直接 false（95% 轮询零增量）；
 *  第二级（仅 innerText 命中后执行）：候选扫描（ownText/fullText contains）+ 批1 同套四层闸门（GATE4_SRC 注入，
 *  复用定位同款辅助），存在过闸元素才算真——幽灵模板文本（innerText 命中但元素 0×0/隐藏/命中测试不过）不再假绿。 */
const TEXT_EXISTS_V2_SRC = `function(q){
  ${GATE4_SRC}
  const docs = [];
  (function walk(doc){ docs.push(doc);
    let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
    for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch(e) {} if (inner) walk(inner); }
  })(document);
  let pass = false; // 第一级：innerText 快路径（不含 q → false，轮询零增量）
  for (const d of docs) { try { const t = (d.body && d.body.innerText) || d.documentElement.innerText || '';
    if (t.indexOf(q) !== -1) { pass = true; break; } } catch(e) {} }
  if (!pass) return false;
  function ownText(el){ let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim(); }
  for (const d of docs) { // 第二级：候选扫描 + 四层闸门（存在过闸元素才算真）
    let all = []; try { all = d.querySelectorAll('*'); } catch(e) { continue; }
    for (const el of all) {
      let t = ''; try { t = ownText(el) || String(el.textContent || '').trim(); } catch(e) {}
      if (t.indexOf(q) === -1) continue;
      let r = null; try { r = el.getBoundingClientRect(); } catch(e) {}
      if (gate4(el, d, r) === null) return true;
    }
  }
  return false; }`;

/** X4 容忍式命中复核表达式（V202609090001；V202609180001 深度 iframe 坐标空间修复）：
 *  按 best 身份（frame+tag+id+text+rect±6px）重找元素 → elementFromPoint(中心) → 返回判定：
 *  'gone'      = best 不在 DOM/rect 大变（配合命中偏离 → 判成功：点击已产生效果，如点了会关菜单的项）
 *                ★V202609300005 返回值升级为 'gone|<诊断>'（重找候选数/最近Δpx/两侧 rect；无候选=0cand）——
 *                假 gone（深度 iframe 底栏按钮恒误判→静默跳派发，coords-probe 实证 lastClickXY=null）立即可见；
 *  'pass-hit'  = hit===best || best.contains(hit) || hit.contains(best)
 *  'pass-error'= elementFromPoint 异常（放行不阻塞——页面导航中等瞬态）
 *  'covered'   = hit 为 null/html/body/无关元素且 best 仍在原位 → TARGET_NOT_FOUND（hitMiss）
 *  ★V202609180001 修复：spec.rect 是 absRect（视口累加坐标），而重找时的 getBoundingClientRect 是
 *  frame 本地坐标——深度≥2 的 iframe 元素两者差一个父 iframe 累加偏移（实证：提取按钮 local y≈810 vs
 *  abs y≈885，Δ75px>6 恒判 gone→success→静默跳过派发还报 ✓，fix-31「✓ 但没发生」真根因）。
 *  修复=重找比对前先把本地 rect 沿 frameElement 链累加成视口坐标（与 absRect 同空间）；
 *  elementFromPoint 仍用同文档本地坐标（局部语义保留，见 §X4 设计 ④）。
 *  ★V202609300002 跨文档遮挡复核（X4 局部语义盲区根治，obs-4 实证族）：best 位于 iframe 内（fp !== 'main'）
 *  且同文档命中通过时，在 TOP 文档对 abs 中心再执行一次 elementFromPoint，沿命中链（≤8 级 parentElement）
 *  检查是否到达 best 所在 frameElement：到达=放行（无跨文档遮挡）；命中链落在别的 iframe（兄弟层吸收）或
 *  通用全屏覆盖层（.modal/.mloading/.layui-layer-shade——通用库类，应用专属类名不进引擎层；排除
 *  pointerEvents==='none' 装饰层防误报）→ 'blocked-cross-doc|<命中链摘要>'（flow-engine ensureHittable
 *  消费为 TARGET_NOT_FOUND 红——「✓ 但没发生」假绿变可归因红）。链耗尽未达 frameElement 也未命中已知
 *  覆盖层=保守放行维持原判定（未知布局不误报）；复核异常一律 pass-error（8s 容忍式预算沿用——同步 XHR
 *  阻塞期 evaluate 超时不误杀）。 */
function buildVerifyExpr(best) {
  const spec = { tag: String(best.tag || ''), id: String(best.id || ''), text: String(best.text || ''), rect: best.rect, frame: String(best.frame || 'main') };
  return `(function(){ return (function(){
    const spec = ${JSON.stringify(spec)};
    function absOf(doc, r) { let x = r.left, y = r.top, d = doc;
      while (d && d.defaultView && d.defaultView.frameElement) {
        const fe = d.defaultView.frameElement; const fr = fe.getBoundingClientRect();
        x += fr.left; y += fr.top; d = fe.ownerDocument; }
      return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) }; }
    function near(r, q) { return Math.abs(r.x - q.x) <= 6 && Math.abs(r.y - q.y) <= 6 && Math.abs(r.w - q.w) <= 6 && Math.abs(r.h - q.h) <= 6; }
    const docs = [];
    (function walk(doc, fp){ docs.push({doc, fp});
      let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
      for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch(e) {}
        if (inner) walk(inner, fp + '>' + (f.name || f.id || String(f.tagName).toLowerCase())); }
    })(document, 'main');
    let bestEl = null, bestDoc = null, br = null;
    let candCount = 0, bestCandD = null, bestCandRc = null; // ★V202609300005 'gone' 诊断：重找候选（tag+id+text 身份匹配）最近 Δpx
    for (const pair of docs) {
      if (spec.frame !== 'point' && pair.fp !== spec.frame) continue;
      let all = []; try { all = pair.doc.querySelectorAll('*'); } catch(e) { continue; }
      for (const el of all) {
        let tag = ''; try { tag = String(el.tagName || '').toLowerCase(); } catch(e) {}
        if (tag !== spec.tag) continue;
        let id = ''; try { id = el.id || ''; } catch(e) {}
        if (id !== spec.id) continue;
        let text = ''; try { text = String((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim().slice(0, 80); } catch(e) {}
        if (text !== spec.text) continue;
        let r = null; try { r = el.getBoundingClientRect(); } catch(e) { continue; }
        const rc = absOf(pair.doc, r); // V202609180001：累加成视口坐标再比对（spec.rect=absRect 同空间）
        candCount++;
        if (near(rc, spec.rect)) { bestEl = el; bestDoc = pair.doc; br = r; break; }
        const dd = Math.max(Math.abs(rc.x - spec.rect.x), Math.abs(rc.y - spec.rect.y), Math.abs(rc.w - spec.rect.w), Math.abs(rc.h - spec.rect.h));
        if (bestCandD === null || dd < bestCandD) { bestCandD = dd; bestCandRc = rc; }
      }
      if (bestEl) break;
    }
    if (!bestEl) {
      // ★V202609300005 'gone' 带诊断（存量暗雷可观测性：深度 iframe 底栏按钮曾恒误判 gone→静默跳派发）：
      // 重找有候选（tag+id+text 身份匹配）但 ±6px 外 → 附最近候选 Δpx 与两侧 rect；无候选 → 0cand（真移除/文本漂移）。
      // 'gone' + '|' 相接形式保持 'gone' 字面量（selftest #23 源断言兼容）；verifyHit 前缀拆包。
      if (bestCandRc) return 'gone' + '|' + candCount + 'cand 最近Δpx=' + Math.round(bestCandRc.x - spec.rect.x) + ',' + Math.round(bestCandRc.y - spec.rect.y)
        + ' 候选rect=' + Math.round(bestCandRc.x) + ',' + Math.round(bestCandRc.y) + ',' + Math.round(bestCandRc.w) + 'x' + Math.round(bestCandRc.h)
        + ' spec.rect=' + spec.rect.x + ',' + spec.rect.y + ',' + spec.rect.w + 'x' + spec.rect.h;
      return 'gone|0cand';
    }
    let hit = null;
    try { hit = bestDoc.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); } catch (e) { return 'pass-error'; }
    if (hit === bestEl || (hit && bestEl.contains(hit)) || (hit && hit.contains(bestEl))) {
      const fe = (bestDoc.defaultView && bestDoc.defaultView.frameElement) || null;
      if (spec.frame === 'main' || !fe) return 'pass-hit'; // 同文档/无 frame 链：原判定零改动
      /* V202609300002 跨文档遮挡复核：TOP 文档 elementFromPoint(abs 中心) 沿命中链查遮挡——
       * 本表达式在 TOP 文档上下文求值（evaluate 主会话语义），document 即 TOP，天然可查父文档覆盖层。
       * ★V202609300007 祖先帧链成员检查（V202609300002 自身缺陷修复，r6 实弹）：嵌套 iframe（depth≥2）
       * 时 TOP 的 elementFromPoint 物理上只可能返回最外层祖先 iframe（浏览器 API 不穿透嵌套层）——旧逻辑
       * 要求命中链到达最内层 frameElement → 祖先帧被误判「别的 iframe」→ blocked 假阳性（r6：depth2
       * 目标命中祖父帧 iframe#layui-layer-iframe5 误红）。修法：从目标 doc 侧逐级上溯（每级跨 doc 取
       * defaultView.frameElement）收集祖先 iframe 元素集合——命中链任一节点 ∈ 集合=放行（浏览器按帧树
       * 路由，点击自然进嵌套帧）；不在集合中的 iframe=真兄弟层遮挡。集合构造跨域容错：上溯须落在 TOP
       * 文档本体（d===document）才算完整，中途 frameElement 不可得/异常=部分集合——此时「非成员 iframe」
       * 不判兄弟层（无法排除其祖先身份）保守放行；覆盖层判定与完整性无关恒有效。 */
      try {
        const ar = absOf(bestDoc, br); // 视口累加坐标（与 absRect/mouseClick 派发同空间）
        let th = null;
        try { th = document.elementFromPoint(ar.x + Math.round(ar.w / 2), ar.y + Math.round(ar.h / 2)); } catch (e) { return 'pass-error'; }
        if (!th) return 'pass-error'; // TOP 无接收元素（视口外/瞬态）——容忍放行，同 pass-error 哲学
        const OVERLAY_SEL = '.modal,.mloading,.layui-layer-shade'; // 通用库类（应用专属类名不进引擎层）
        const ancFrames = []; // 祖先帧链（含最内层目标帧 fe——depth=1 时集合=[fe]，与旧「到达 fe」语义逐点等价）
        let ancComplete = false; // 上溯是否落在 TOP 文档本体（部分集合时非成员 iframe 不判兄弟层）
        try {
          let d = bestDoc;
          let i = 0;
          for (; i < 16 && d && d.defaultView && d.defaultView.frameElement; i++) {
            const feN = d.defaultView.frameElement;
            ancFrames.push(feN);
            d = feN.ownerDocument; // 跨到父文档继续收集（跨域时下一级访问抛异常→部分集合）
          }
          if (i < 16 && d && d === document) ancComplete = true; // 上溯终点=TOP 本体→集合完整
        } catch (e) { ancComplete = false; } // 跨域 frameElement 不可得→部分集合（保守哲学）
        let n = th, chain = [], reached = false, blocked = null, hops = 0;
        while (n && hops < 8) {
          hops++;
          let cls = ''; try { cls = typeof n.className === 'string' ? n.className : ''; } catch (e) {}
          chain.push(String(n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : ''));
          let isAnc = false;
          for (const af of ancFrames) { if (n === af) { isAnc = true; break; } }
          if (isAnc) { reached = true; break; } // 命中祖先帧（含最内层）→ 无跨文档遮挡，点击自然路由进嵌套帧
          let tg = ''; try { tg = String(n.tagName || '').toLowerCase(); } catch (e) {}
          if (tg === 'iframe' || tg === 'frame') { // 非祖先帧 iframe：集合完整=真兄弟层吸收；部分集合=无法排除祖先身份→保守放行
            if (ancComplete) { blocked = 'sibling-iframe'; break; }
            break;
          }
          let ovl = false; try { ovl = n.matches ? n.matches(OVERLAY_SEL) : false; } catch (e) {}
          if (ovl) { // 通用全屏覆盖层；排除 pointer-events:none 装饰层防误报
            let pe = ''; try { pe = String((document.defaultView.getComputedStyle(n) || {}).pointerEvents || ''); } catch (e) {}
            if (pe !== 'none') { blocked = chain[chain.length - 1]; break; }
          }
          n = n.parentElement;
        }
        if (reached) return 'pass-hit';
        if (blocked) return 'blocked-cross-doc|' + chain.slice(0, 6).join('>'); // 附命中链摘要（ensureHittable 消费）
        return 'pass-hit'; // 链耗尽未达任何相关帧也未命中已知覆盖层——保守放行维持原判定（未知布局不误报）
      } catch (e) { return 'pass-error'; }
    }
    return 'covered'; // null / html / body / 无关元素，且 best 仍在原位
  })(); })()`;
}

/** 条件文法 → 只读页面表达式（text/element/value/count/url/absent/hidden；network 由 Runner 侧处理，不进页面表达式） */
function buildCondExpr(cond) {
  const key = Object.keys(cond)[0];
  const v = cond[key];
  const docsWalk = `
  const docs = [];
  (function walk(doc){ docs.push(doc);
    let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
    for (const f of fr) { let inner = null; try { inner = f.contentDocument; } catch(e) {} if (inner) walk(inner); }
  })(document);`;
  switch (key) {
    case 'text':
      return `(function(){ return (${TEXT_EXISTS_SRC})(${JSON.stringify(String(v))}); })()`;
    case 'element': { // X2 顺修（V202609090001）：复用 buildLocateExpr 的 ok 表达式——此前 validateCond 收 element
      // 但 buildCondExpr 无此 case 落到 default 抛错、被 waitCond 吞掉空转超时（latent bug 消灭）
      // V202609300016 原语二 stable（oracle 报告 §3.3）：可选 {ms, polls}——页侧轮询 IIFE：目标过定位且
      // 连续 polls 次轮询 rect 相等（±1px）才算真（直接观察「动画收尾/重布局完成」，替代动画类魔法数盲等）；
      // 预算 ms 内未达连续相等 → false（waitCond Node 侧 500ms 轮询会带新帧重入本表达式）。无 stable 字段
      // 走原单发表达式（零改动）。
      // V202610130003 件2 帧钟边界根治（批三 V202609300016 残留风险条）：轮询 IIFE 改 async，帧间
      // await setTimeout(50ms) 真正让出主线程——rAF/timer 驱动的动画在单次求值内帧钟可推进，假稳定
      // 风险消除（50ms≈3 帧@60fps，兼顾 timer 节流族）；Node 侧求值走 awaitPromise:true（checkCond
      // stable 路径接线），预算 ms 自此为真实墙钟预算（每轮吃节距）。⚠ 已知边界（如实注明）：后台 tab
      // 的 rAF 仍可能被浏览器节流（timer 路径可用，rAF 驱动动画在节流 tab 下帧钟推进变慢——实弹待补：
      // 真实帧推进效果需 ERP 实弹验证）；跨求值（waitCond 重入）仍是帧推进的补充观察面。
      if (v && v.stable !== undefined) {
        return `(async function(){
  var locate = function(){ return ${buildLocateExpr(v)}; };
  var POLLS = ${Number(v.stable.polls)}, BUDGET = ${Number(v.stable.ms)};
  var prev = null, streak = 0, t0 = Date.now();
  for (;;) {
    var r = null; try { r = locate(); } catch (e) { r = null; }
    var cur = (r && r.ok && r.best && r.best.rect) ? r.best.rect : null;
    if (!cur) { prev = null; streak = 0; } // 定位未过（含 X1 拒）→ 连续计数清零重新累计
    else if (prev && Math.abs(prev.x - cur.x) <= 1 && Math.abs(prev.y - cur.y) <= 1 && Math.abs(prev.w - cur.w) <= 1 && Math.abs(prev.h - cur.h) <= 1) {
      if (++streak >= POLLS) return true; // 连续 POLLS 次 rect 相等（±1px）→ 静止成立
    } else { streak = 1; }
    prev = cur;
    if (Date.now() - t0 >= BUDGET) return false; // 预算耗尽未达连续相等 → false（外层轮询重入）
    await new Promise(function(res){ setTimeout(res, 50); }); // V202610130003 件2：帧间让出主线程（awaitPromise:true 求值——rAF/timer 跨帧推进）
  }
})()`;
      }
      return `(function(){ var r = ${buildLocateExpr(v)}; return !!(r && r.ok); })()`;
    }
    case 'absent': // V202609110001：!exists——存在性模式（__presence：不验可见性与尺寸，0×0/display:none 也算存在）
      return `(function(){ var r = ${buildLocateExpr(Object.assign({}, v, { __presence: true, __hitTest: false }))}; return !(r && r.ok); })()`;
    case 'hidden': { // V202609110001：exists && !visible 严格语义——目标不存在时恒 false（防 false-success）。
      // 双表达式：存在性模式定位（exists）+ 常规 X1 定位（visible）；轮询复用 waitCond 500ms 机制（Runner 侧不变）
      const presence = buildLocateExpr(Object.assign({}, v, { __presence: true, __hitTest: false }));
      const visible = buildLocateExpr(v);
      return `(function(){ var r = ${presence}; if (!(r && r.ok)) return false; var v = ${visible}; return !(v && v.ok); })()`;
    }
    case 'url':
      return `(function(){ ${docsWalk}
        const urls = [String(location.href)];
        for (const d of docs) { try { if (d.defaultView && d.defaultView.location) urls.push(String(d.defaultView.location.href)); } catch(e) {} }
        return urls.some((u) => u.indexOf(${JSON.stringify(String(v.contains))}) !== -1); })()`;
    case 'value':
      return `(function(){ ${docsWalk}
        for (const d of docs) { let el = null; try { el = d.querySelector(${JSON.stringify(String(v.domPath))}); } catch(e) {}
          if (el && 'value' in el) { const val = String(el.value == null ? '' : el.value);
            return true
              ${v.equals !== undefined ? `&& val === ${JSON.stringify(String(v.equals))}` : ''}
              ${v.contains !== undefined ? `&& val.indexOf(${JSON.stringify(String(v.contains))}) !== -1` : ''}; } }
        return false; })()`;
    case 'count':
      return `(function(){ ${docsWalk}
        let n = 0;
        for (const d of docs) { try { n += d.querySelectorAll(${JSON.stringify(String(v.domPath))}).length; } catch(e) {} }
        return true
          ${v.min !== undefined ? `&& n >= ${Number(v.min)}` : ''}
          ${v.max !== undefined ? `&& n <= ${Number(v.max)}` : ''}; })()`;
    default: throw new Error(`条件 ${key} 不支持页面表达式（network 由 Runner 侧处理）`);
  }
}

module.exports = { headersSubmatch, matchModeOK, normTextDesc, accNameOf, waitLocateSpec, validContainer, CONTAINER_STRUCT_SEL, validTarget, validateCond, buildLocateExpr, buildCondExpr, TEXT_EXISTS_SRC, TEXT_EXISTS_V2_SRC, buildVerifyExpr, kindExpectations, GATE4_SRC };
