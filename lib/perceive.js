'use strict';
/*
 * chromeuse lib/perceive.js —— 感知类命令实现单源（a11y / css；二期-3，2026-10-31 用户裁定）
 *
 * 定位：`tools/cdp.js a11y/css` 的唯一实现单源。只读感知命令——零 Input 事件、零页面副作用
 *   （不滚动、不点击、不改 DOM）；域=Accessibility / DOM / CSS / Runtime（全部只读命令）。
 *
 * ── 协议选择与理由（a11y）────────────────────────────────────────────────────
 * - 整树快照 = `Accessibility.getFullAXTree`：单次原子调用，一次拿到完整 AXNode 扁平表
 *   （nodeId/parentId/childIds/role/name/properties/backendDOMNodeId），客户端按 childIds 组树。
 *   不用「DOM.getDocument + getPartialAXTree」组合：后者要先拿 DOM 树再逐节点取 AX 子树，
 *   多次往返且无法保证与 AX 树同一次快照口径；getFullAXTree 是 DevTools take_snapshot 同源通道。
 * - 定位子树 = `Accessibility.getPartialAXTree({objectId, fetchRelatives:true})`：复用 locator
 *   找到的元素 objectId（同源 iframe 内元素也可），读取后按 backendDOMNodeId 过滤出目标子树
 *   （fetchRelatives:true 会附带祖先/兄弟，客户端只保留目标节点及其 childIds 后代）。
 * - 两个命令在 Chrome 88 均已存在（Accessibility 域 88 有 getFullAXTree/getPartialAXTree，
 *   当时标记 experimental 但可用）；88 的 getFullAXTree **没有 depth 参数**（实测实现直接忽略额外参数，
 *   全量返回）——本模块用「响应中是否有悬空 childIds」判断服务端是否真裁剪：无悬空=全量已返回，
 *   直接客户端裁剪；若协议层显式拒绝 depth 则无参重发（见 fetchFullTree/sendFullTree，88 分叉就地处理）。
 *
 * ── 超时与降级（GQ-010 B 硬要求）────────────────────────────────────────────
 * 背景：MCP take_snapshot 在 layui 弹出 iframe 上实测 10s 超时；a11y 不能挂死。
 * - `--timeout` 默认 10000ms，到点必须返回。send() 自带逐命令超时，外层再加 race 兜底
 *   （race 先到点即返回，晚到的 CDP 回包丢弃——`Promise.race` 已挂 handler，不会 unhandled）。
 * - 深树采用「浅层优先」两段式（planA11yStages）：第一段 depth=3 用 35% 预算（上限 3000ms）
 *   拿浅层树；第二段用剩余预算拿请求深度。第二段超时 → 返回第一段浅层结果 + timedOut:true +
 *   partial:true（真实部分结果，不是空树）；第一段就超时 → 用剩余预算再试深段，仍失败才返回空树
 *   + timedOut:true。⚠ 实测认知：Chrome 的 depth 只裁剪**响应**，AX 缓存仍需全量构建——浅段不保证
 *   更快，价值=小响应/超时前的部分结果；真正的超时兜底是预算硬切（到点必返，绝不挂死）。
 * - 超时/失败时 CLI stderr 提示替代通道：`cdp.js exec DOM.getDocument`（DOM 树）/ `cdp.js screenshot`
 *   （合成器通道）/ MCP take_snapshot（轻页面）。
 *
 * ── 体积控制（G4 教训：重页上千节点全量进上下文）────────────────────────────
 * - `--depth` 默认 8（CDP 层数，root=第 1 层；0=全量）；服务端 depth 生效时由 Chrome 裁剪，
 *   88/参数被忽略时客户端裁剪（depthMode:'client' 如实标注）。
 * - 节点上限默认 2000（--max-nodes 可调）：超出即截断，omitted 计数如实输出。
 * - 输出不是 MCP 的 yaml 大树，而是紧凑缩进行：`role "name摘要" (x,y wxh) [F][C][D]`。
 *
 * ── bounds 策略（成本取舍）──────────────────────────────────────────────────
 * AXNode 本身不带 bounds；逐节点 DOM.getBoxModel 是唯一不引入 DOMSnapshot 全量布局快照的轻量路径。
 * 只对前 BOUNDS_MAX_NODES（150）个有 backendDOMNodeId 的节点并发取框（每条 1.2s 上限），
 * 其余节点 bounds=null（JSON 中如实为 null，人类输出省略括号）——重页面不因取框拖垮整体预算。
 * DOM.getBoxModel 坐标是**顶层视口 CSS px**（Chrome 153 实测 iframe 内元素已含 frame 偏移，
 * 与 locator 的 absRect 口径一致；JSON 仍带 framePath 供归属判断）。
 *
 * ── CSS（P2 顺手）──────────────────────────────────────────────────────────
 * - computed：页面侧 `getComputedStyle` 走 Runtime.evaluate（不启用 CSS 域、不做 objectId→nodeId 映射，
 *   实现成本最低；跨同源 iframe 元素同样可读）。全量属性按名排序输出（约 300+ 行），--json 为对象。
 * - matched：`CSS.getMatchedStylesForNode`（先 DOM.enable + CSS.enable，结束 CSS.disable）——
 *   只有 CDP 能给出「规则来源 origin + 选择器 + media + 属性」的层叠信息；规则上限 200 条截断标注。
 *
 * ── 快照分级（B6a N5，2026-11-04）────────────────────────────────────────────
 * `a11y` 新增四模式 + 三降噪（互相独立可组合；实现单源=本文件，纯函数/IO 在 lib/snapshot-diff.js）：
 * - 四模式：--find 树内检索（命中 ref+根到节点路径+±2 行上下文）/ --diff 身份键增量（新增/变化行
 *   前缀 `*`；不可比回落全量 forcedFull:true）/ --out 落盘（stdout 只回 {nodes,file,snapshotId}）/
 *   --cursor 分页（--cursor-token/--cursor-size）。
 * - 三降噪：--exclude <css> 子树剪除（DOM.getDocument + DOM.querySelectorAll 定节点，按 DOM 祖先链
 *   判行归属）/ --frames same-origin 同源帧合并（B0 POC 定案路径）/ --visible-only 遮挡过滤（默认关；
 *   DOM.getNodeForLocation 命中测试，仅主文档有 bounds 的前 150 行）。
 * - 默认行为不变：不带新旗标仍走原全量文本/JSON 路径，逐字节不变（selftest #96 golden + #109 同批）。
 * - 88 分叉就地注释在 fetchFrameRows：frameId 参数 92~94 才引入；检测到参数被忽略 → framesUnsupported
 *   + approximate:true 如实报不支持（不做页侧投影假合并）。
 */

const locator = require('./locator');
const jsListeners = require('./js-listeners'); // C11 N12：a11y --mark-js（监听扫描 join，默认关）
const time = require('./time');
const snapshot = require('./snapshot-diff');

const DEFAULT_A11Y_DEPTH = 8;               // CDP 层数（root=1）；0=全量
const DEFAULT_A11Y_TIMEOUT_MS = 10000;
const DEFAULT_A11Y_MAX_NODES = 2000;
const A11Y_SHALLOW_DEPTH = 3;               // 两段式浅层深度（与 GQ-010 B 的 10s 超时场景对齐）
const A11Y_SHALLOW_BUDGET_RATIO = 0.35;
const A11Y_SHALLOW_BUDGET_MAX_MS = 3000;
const DEFAULT_CSS_TIMEOUT_MS = 5000;
const TIMEOUT_MIN_MS = 1;                   // 允许 1ms：验收要求「--timeout 1ms 验证 timedOut 不挂死」
const TIMEOUT_MAX_MS = 600000;
const DEPTH_MAX = 64;
const MAX_NODES_MAX = 100000;
const NTH_MAX = 100000;
const BOUNDS_MAX_NODES = 150;
const BOUNDS_CMD_TIMEOUT_MS = 1200;
const MAX_MATCHED_RULES = 200;
const NAME_MAX = 80;
const VALUE_MAX = 40;
const LOCATE_TIMEOUT_MIN_MS = 1000;
const LOCATE_TIMEOUT_MAX_MS = 5000;
const DEFAULT_CURSOR_SIZE = snapshot.DEFAULT_CURSOR_SIZE;
const MAX_CURSOR_SIZE = snapshot.MAX_CURSOR_SIZE;
const FRAME_FETCH_MIN_MS = 1000;
const FRAME_FETCH_MAX_MS = 10000;
const EXCLUDE_MAX_MATCHES = 500;
const OCCLUSION_CMD_TIMEOUT_MS = 1500;

/* C6 语义分组（--group；默认关）：landmark 角色 → 组标签（HTML 标签名与 ARIA role 名同义归一）。
 * 只做**渲染层**分组：行数组与 @eN 编号源不动（编号由 cdp.js 在报告行上物化，树序恒定）。 */
const A11Y_LANDMARK_ROLES = new Map([
  ['main', 'main'], ['navigation', 'nav'], ['nav', 'nav'],
  ['banner', 'header'], ['header', 'header'], ['contentinfo', 'footer'], ['footer', 'footer'],
  ['complementary', 'aside'], ['aside', 'aside'], ['region', 'region'], ['section', 'section'], ['search', 'search'],
]);
/* 无名 generic 包装行在分组态折叠（不占行；子行按自身深度稍进，结构不丢）——有 name/ref/flag 的绝不折叠 */
const A11Y_GROUP_FOLD_ROLES = new Set(['generic', 'GenericContainer', 'none']);
/* 纯冗余行：InlineTextBox=父 StaticText 的同一段文本副本，ListMarker=视觉项目符号；分组态一律折叠（文本不丢） */
const A11Y_GROUP_FOLD_ALWAYS_ROLES = new Set(['InlineTextBox', 'ListMarker']);
const A11Y_GROUP_VALUE_ROLES = /^(textbox|searchbox|combobox|spinbutton|slider)$/;

/* 可点击标记启发式：AX 无 clickable 属性，按交互角色集合判定（focusable 单独取 AX property） */
const CLICKABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'combobox', 'listbox', 'textbox', 'searchbox',
  'slider', 'spinbutton', 'scrollbar', 'treeitem', 'gridcell',
]);

const TIMEOUT = Symbol('chromeuse-perceive-timeout');
const sleep = time.sleep;

/* ── 参数归一（纯函数；布尔值视为「--flag 缺值」绝不静默转数字） ── */

function intField(value, what, min, max, def) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') throw new Error(`${what} 缺值（需要整数 ${min}~${max}）`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${what} 非法（须为 ${min}~${max} 的整数）：${JSON.stringify(value)}`);
  }
  return n;
}

function textField(value, flag, opts) {
  if (value === true) throw new Error(`${flag} 缺值（需要${opts && opts.kind === 'selector' ? ' CSS 选择器' : '文本'}）`);
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) throw new Error(`${flag} 不能为空`);
    return s;
  }
  throw new Error(`${flag} 需要字符串：${JSON.stringify(value)}`);
}

/** 无参开关（布尔 true=开；任何带值形态都拒绝，绝不静默转真） */
function boolSwitch(value, flag) {
  if (value === undefined || value === null) return false;
  if (value === true) return true;
  throw new Error(`${flag} 不接受值（无参开关）`);
}

/** 可选字符串（布尔=缺值；空白拒绝） */
function optionalText(value, flag, what) {
  if (value === undefined || value === null) return null;
  if (value === true) throw new Error(`${flag} 缺值（需要${what || '值'}）`);
  if (typeof value !== 'string') throw new Error(`${flag} 需要字符串：${JSON.stringify(value)}`);
  const s = value.trim();
  if (!s) throw new Error(`${flag} 不能为空`);
  return s;
}

/** --frames 归一：v1 只支持 same-origin（B0 POC 范围；OOPIF 不在 N5） */
function normalizeFrames(value) {
  if (value === undefined || value === null) return null;
  if (value === true) throw new Error('--frames 缺值（仅支持 same-origin）');
  const s = String(value).trim().toLowerCase();
  if (s !== 'same-origin') throw new Error(`--frames 仅支持 same-origin：${JSON.stringify(value)}`);
  return 'same-origin';
}

function normalizeQuery(src, command) {
  const o = src || {};
  const hasText = o.text !== undefined && o.text !== null && o.text !== '';
  const hasSelector = o.selector !== undefined && o.selector !== null && o.selector !== '';
  if (hasText && hasSelector) throw new Error(`${command} --text 与 --selector 互斥（一次只用一个定位锚）`);
  if (!hasText && !hasSelector) {
    if (o.nth !== undefined && o.nth !== null && o.nth !== '') throw new Error(`${command} --nth 仅与 --text/--selector 同用`);
    if (o.match !== undefined && o.match !== null && o.match !== '') throw new Error(`${command} --match 仅与 --text 同用`);
    return null;
  }
  const kind = hasText ? 'text' : 'selector';
  const value = textField(hasText ? o.text : o.selector, hasText ? '--text' : '--selector', { kind });
  const nth = intField(o.nth, '--nth', 0, NTH_MAX, null);
  let match = null;
  if (o.match !== undefined && o.match !== null && o.match !== '') {
    if (o.match === true) throw new Error(`${command} --match 缺值（exact|contains）`);
    match = String(o.match).toLowerCase();
    if (!['exact', 'contains'].includes(match)) throw new Error(`${command} --match 仅支持 exact|contains：${JSON.stringify(o.match)}`);
    if (!hasText) throw new Error(`${command} --match 仅与 --text 同用（--selector 天然唯一/或需 --nth）`);
  }
  const query = { kind, value, nth };
  if (match) query.match = match;
  return query;
}

/**
 * a11y 参数归一（纯函数）：query 可空（整树）；depth 默认 8、0=全量；timeout 默认 10s。
 * B6a 新增：find/diff/out/cursor(+token/size)/exclude/frames/visibleOnly（互相独立可组合）。
 * 组合约束：--cursor-token 续页基于已存快照视图 → 不与 --diff（需新快照）同用；
 *           --out 只回三键摘要 → 不与 --cursor（分页 stdout 契约冲突）同用。
 * C6 新增：group（--group，纯渲染层分组，默认关）；与 find/diff/cursor/out 互斥。
 * @returns {{query,depth,timeoutMs,maxNodes,find,diff,out,cursor,cursorToken,cursorSize,exclude,frames,visibleOnly,group}}
 */
function normalizeA11yOptions(src) {
  const o = src || {};
  const out = optionalText(o.out, '--out', '文件路径');
  const cursor = boolSwitch(o.cursor, '--cursor');
  const cursorToken = optionalText(o.cursorToken, '--cursor-token', ' token');
  const diff = boolSwitch(o.diff, '--diff');
  /* token 续页读基线视图：--diff/--find 旗标只用于校验视图哈希（不重新取树），允许组合；
   * --out 的 stdout 三键契约与分页冲突 → 拒绝。 */
  if (cursorToken && out) throw new Error('--cursor-token 与 --out 不可组合（out 只回三键摘要）');
  const find = snapshot.normalizeFindPattern(o.find);
  if (out && (cursor || cursorToken)) throw new Error('--out 与 --cursor 不可组合（out 只回三键摘要）');
  /* C6 --group = 纯渲染层分组（默认关）：与自带视图契约的旗标互斥（那些旗标的输出面已被定义） */
  const group = boolSwitch(o.group, '--group');
  if (group) {
    for (const [on, flag] of [[find, '--find'], [diff, '--diff'], [cursor || cursorToken, '--cursor/--cursor-token'], [out, '--out']]) {
      if (on) throw new Error(`--group 与 ${flag} 不可组合（${flag} 自带输出视图；分组只作用于默认行式视图）`);
    }
  }
  return {
    query: normalizeQuery(o, 'a11y'),
    markJs: boolSwitch(o.markJs, '--mark-js'),
    depth: intField(o.depth, '--depth', 0, DEPTH_MAX, DEFAULT_A11Y_DEPTH),
    timeoutMs: intField(o.timeoutMs, '--timeout', TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULT_A11Y_TIMEOUT_MS),
    maxNodes: intField(o.maxNodes, '--max-nodes', 1, MAX_NODES_MAX, DEFAULT_A11Y_MAX_NODES),
    find,
    diff,
    out,
    cursor: cursor || !!cursorToken,
    cursorToken,
    cursorSize: intField(o.cursorSize, '--cursor-size', 1, MAX_CURSOR_SIZE, DEFAULT_CURSOR_SIZE),
    exclude: optionalText(o.exclude, '--exclude', ' CSS 选择器'),
    frames: normalizeFrames(o.frames),
    visibleOnly: boolSwitch(o.visibleOnly, '--visible-only'),
    group,
  };
}

/**
 * css 参数归一（纯函数）：--text/--selector 必须且只能一个；--computed/--matched 至少一个
 * （都不给=computed，保持「直接看样式」的默认直觉）；timeout 默认 5s。
 * @returns {{query:{kind,value,nth},computed:boolean,matched:boolean,timeoutMs:number}}
 */
function normalizeCssOptions(src) {
  const o = src || {};
  const query = normalizeQuery(o, 'css');
  if (!query) throw new Error('css 需要 --text <文本> 或 --selector <css>（定位到目标元素）');
  const computed = o.computed === true;
  const matched = o.matched === true;
  return {
    query,
    computed: computed || !matched,
    matched,
    timeoutMs: intField(o.timeoutMs, '--timeout', TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULT_CSS_TIMEOUT_MS),
  };
}

/**
 * a11y 取树阶段计划（纯函数）——「浅层优先」两段式：
 * depth 1~3 → 单段；depth 0 或 >3 → shallow(3, 35%/≤3s) + full(请求深度, 剩余预算)。
 * 预算过小（剩余 <1ms）时只保留 shallow 段（到点立即返回，不空转第二段）。
 * @returns {{depth:number,timeoutMs:number,label:'depth'|'shallow'|'full'}[]}
 */
function planA11yStages(depth, timeoutMs) {
  if (depth >= 1 && depth <= A11Y_SHALLOW_DEPTH) {
    return [{ depth, timeoutMs, label: 'depth' }];
  }
  const shallowBudget = Math.max(1, Math.min(A11Y_SHALLOW_BUDGET_MAX_MS, Math.floor(timeoutMs * A11Y_SHALLOW_BUDGET_RATIO)));
  const stages = [{ depth: A11Y_SHALLOW_DEPTH, timeoutMs: shallowBudget, label: 'shallow' }];
  const remain = timeoutMs - shallowBudget;
  if (remain >= 1) stages.push({ depth, timeoutMs: remain, label: 'full' });
  return stages;
}

/* ── AXNode 处理（纯函数） ── */

function axText(v) {
  if (v === undefined || v === null) return '';
  const raw = (typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value')) ? v.value : v;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
}

function axMap(nodes) {
  const map = new Map();
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    if (n && n.nodeId !== undefined && n.nodeId !== null) map.set(String(n.nodeId), n);
  }
  return map;
}

function childIdsOf(node) {
  return Array.isArray(node && node.childIds) ? node.childIds.map(String) : [];
}

function rootNodesOf(nodes, map) {
  const m = map || axMap(nodes);
  return [...m.values()].filter((n) => !n.parentId || !m.has(String(n.parentId)));
}

/**
 * 是否存在「悬空 childIds」——即 childIds 指向本次响应中不存在的节点。
 * 这是判断 getFullAXTree 的 depth 是否真正生效的可靠信号：
 *   服务端裁剪 → 被访问节点的子节点已加入结果，但更深层未加入，frontier 节点会留下悬空 childIds；
 *   全量返回（含 Chrome 88 忽略 depth 参数）→ 所有 childIds 都能在结果里找到。
 */
function hasDanglingChildren(nodes) {
  const map = axMap(nodes);
  for (const n of map.values()) {
    for (const cid of childIdsOf(n)) if (!map.has(cid)) return true;
  }
  return false;
}

/** 扁平 AXNode 表的最大树深（root=0；空表返回 -1；环安全）。 */
function maxDepthOf(nodes) {
  const map = axMap(nodes);
  if (!map.size) return -1;
  let max = -1;
  const seen = new Set();
  const stack = rootNodesOf(nodes, map).map((n) => [n, 0]);
  while (stack.length) {
    const [node, d] = stack.pop();
    const id = String(node.nodeId);
    if (seen.has(id)) continue;
    seen.add(id);
    if (d > max) max = d;
    for (const cid of childIdsOf(node)) {
      const c = map.get(cid);
      if (c) stack.push([c, d + 1]);
    }
  }
  return max;
}

function projectAxNode(node, depth) {
  const props = {};
  for (const p of (Array.isArray(node.properties) ? node.properties : [])) {
    if (!p || !p.name) continue;
    const v = p.value;
    props[p.name] = v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : undefined;
  }
  const role = axText(node.role);
  const name = axText(node.name);
  const value = axText(node.value);
  return {
    depth,
    nodeId: String(node.nodeId),
    backendDOMNodeId: node.backendDOMNodeId === undefined || node.backendDOMNodeId === null ? null : node.backendDOMNodeId,
    role,
    name,
    value: value || null,
    description: axText(node.description) || null,
    focusable: props.focusable === true,
    clickable: CLICKABLE_ROLES.has(role),
    disabled: props.disabled === true,
    ignored: node.ignored === true,
    bounds: null,
  };
}

/**
 * 扁平 AXNode 表 → 深度优先行（保留 CDP 树序；ignored 节点默认不输出但继续下钻）。
 * depth 语义与 CDP getFullAXTree 一致：root=第 1 层，depth=N 保留相对深度 0..N-1。
 * maxNodes 上限：到达上限后继续遍历仅计数 omitted（不存行），truncated=omitted>0。
 * @param {object[]} nodes
 * @param {object} [opts] {depth=8, maxNodes=2000, startNodeId?, forceRoot?}
 * @returns {{rows:object[],nodeCount:number,omitted:number,ignoredCount:number,truncated:boolean,rootIds:string[]}}
 */
function buildAxRows(nodes, opts) {
  const o = opts || {};
  const depth = Number.isInteger(o.depth) ? o.depth : DEFAULT_A11Y_DEPTH;
  const maxNodes = Number.isInteger(o.maxNodes) ? o.maxNodes : DEFAULT_A11Y_MAX_NODES;
  const map = axMap(nodes);
  const startId = o.startNodeId === undefined || o.startNodeId === null ? null : String(o.startNodeId);
  const start = startId === null ? null : map.get(startId);
  const roots = start ? [start] : rootNodesOf(nodes, map);
  const forceRoot = start ? o.forceRoot !== false : false;
  const maxRelDepth = depth > 0 ? depth - 1 : Infinity;
  const rows = [];
  const seen = new Set();
  let omitted = 0;
  let ignoredCount = 0;
  const visit = (node, d) => {
    if (!node) return;
    const id = String(node.nodeId);
    if (seen.has(id)) return;
    seen.add(id);
    const ignored = node.ignored === true;
    const include = !ignored || (forceRoot && node === start && d === 0);
    if (!include) ignoredCount++;
    if (include) {
      if (rows.length < maxNodes) rows.push(projectAxNode(node, d));
      else omitted++;
    }
    // 显示深度以「未忽略节点」计层：ignored 包装节点不占一层，其子节点与它同层。
    // 与 CDP getFullAXTree depth 的 unignored 语义对齐（Chrome 153 实测 depth=3 的原始树
    // 因 ignored 展开可深达 5，按原始父子链裁剪会把内容误裁掉）。
    const childDepth = include ? d + 1 : d;
    const canDescend = include ? (d < maxRelDepth) : (d <= maxRelDepth);
    if (canDescend) {
      for (const cid of childIdsOf(node)) visit(map.get(cid), childDepth);
    }
  };
  for (const r of roots) visit(r, 0);
  return {
    rows,
    nodeCount: rows.length,
    omitted,
    ignoredCount,
    truncated: omitted > 0,
    rootIds: roots.map((r) => String(r.nodeId)),
  };
}

/* ── 输出格式（纯函数） ── */

function compactText(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function formatBounds(b) {
  if (!b) return '';
  return `${b.x},${b.y} ${b.w}x${b.h}`;
}

function formatA11yLine(row, opts) {
  const o = opts || {};
  const indent = '  '.repeat(Math.max(0, Number(row.depth) || 0));
  /* B5：--ref 时行首带 @eN 引用句柄（无 --ref 的路由 row.ref 不存在 → 输出逐字节不变） */
  const ref = row.ref ? `@${row.ref} ` : '';
  /* B6a：--frames 时子帧行带 frame 路径；仅该旗标下 row.framePath 有值 → 默认输出不变 */
  const frame = Array.isArray(row.framePath) && row.framePath.length ? `[f:main>${row.framePath.join('>')}] ` : '';
  const role = row.role || (row.ignored ? '(ignored)' : '(no-role)');
  const name = row.name ? ' ' + JSON.stringify(compactText(row.name, NAME_MAX)) : '';
  const bounds = row.bounds ? ` (${formatBounds(row.bounds)})` : '';
  const flags = [];
  if (row.focusable) flags.push('F');
  if (row.clickable) flags.push('C');
  if (row.disabled) flags.push('D');
  /* C11 N12：--mark-js 才有 row.jsListener → 默认输出逐字节不变 */
  if (row.jsListener) flags.push('J');
  const flagText = flags.length ? ` [${flags.join('')}]` : '';
  const value = row.value && /^(textbox|searchbox|combobox|spinbutton|slider)$/.test(row.role)
    ? ` value=${JSON.stringify(compactText(row.value, VALUE_MAX))}` : '';
  return `${indent}${o.prefix || ''}${frame}${ref}${role}${name}${bounds}${flagText}${value}`;
}

/** 命中路径压缩：最多 6 段（超出用 … 省略中间），保证 --find 单命中输出 <2KB */
function formatFindPath(path) {
  const p = (Array.isArray(path) ? path : []).map((x) => compactText(x, 40));
  if (p.length <= 6) return p.join(' > ');
  return [p[0], '…', ...p.slice(-4)].join(' > ');
}

function formatFindLines(r, lines) {
  const f = r.find || {};
  const hits = Array.isArray(f.hits) ? f.hits : [];
  lines.push(`[a11y] 检索 ${JSON.stringify(f.pattern || '')}${f.isRegex ? `（正则/${f.flags || ''}）` : ''}：`
    + `${f.count || 0} 命中 / ${f.total || 0} 节点${r.cursor ? `（本页 ${hits.length}）` : ''}`);
  hits.forEach((hit, i) => {
    lines.push(`[hit ${i + 1}] 行 ${hit.index} · ${formatFindPath(hit.path)}`);
    for (const c of (hit.context || [])) {
      lines.push(formatA11yLine(c.row, { prefix: c.hit ? '* ' : '  ' }));
    }
  });
}

/* ── C6 语义分组（纯函数；--group opt-in，默认路径零参与） ── */

/** 行数组 → 父行下标（depth 栈重建；-1=顶层）。DFS 行序保证「最近的更浅行」即父行。 */
function parentIndexesOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const parent = new Array(list.length).fill(-1);
  const stack = [];
  for (let i = 0; i < list.length; i++) {
    const d = Number(list[i] && list[i].depth) || 0;
    while (stack.length && (Number(list[stack[stack.length - 1]].depth) || 0) >= d) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
  }
  return parent;
}

/** 分组态行签名：同 run 合并的前提=同父行+同深度+同角色+同标记（ref 不参与，逐项保留） */
function groupRowSig(row) {
  return `${row.focusable ? 'F' : ''}${row.clickable ? 'C' : ''}${row.disabled ? 'D' : ''}${row.jsListener ? 'J' : ''}`;
}

/** 分组态单行文本：`@e3 "名称" v="值"`（无名用 `-`；bounding 框在分组态省略=设计内压缩） */
function groupItemText(row) {
  const ref = row.ref ? `@${row.ref} ` : '';
  /* --frames 时才存在的 framePath：分组态保留帧归属（缺省行无此字段 → 零输出差异） */
  const frame = Array.isArray(row.framePath) && row.framePath.length ? `[f:main>${row.framePath.join('>')}] ` : '';
  const name = row.name ? JSON.stringify(compactText(row.name, NAME_MAX)) : '-';
  const value = row.value && A11Y_GROUP_VALUE_ROLES.test(row.role)
    ? ` v=${JSON.stringify(compactText(row.value, VALUE_MAX))}` : '';
  return `${ref}${frame}${name}${value}`;
}

/** 组路径标签：`main > nav`（父组路径 + 本组标签；flow 组= `(flow)`） */
function groupPathOf(groups, g) {
  const parts = [];
  let cur = g;
  let guard = 0;
  while (cur && guard++ < 32) {
    parts.unshift(cur.kind === 'landmark' ? (A11Y_LANDMARK_ROLES.get(String(cur.role || '')) || cur.role) : '(flow)');
    cur = cur.parent === null || cur.parent === undefined ? null : groups[cur.parent];
  }
  return parts.join(' > ');
}

/**
 * 语义分组（纯函数）：landmark 行开组（嵌套 landmark 成子组），组外散行按连续段成 flow 组。
 * 组内行严格保持原行序（**不重排**）=@eN 树序与编号连续性的结构保证；渲染期只做同父同角色连续 run 合并。
 * @param {object[]} rows a11y 报告行（depth/role/name/ref/...）
 * @returns {{groups:object[],stats:object}}
 */
function buildA11yGroups(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const parent = parentIndexesOf(list);
  const groups = [];
  const folded = new Set();
  const stack = [];      // [{rowIndex, groupIndex}] 当前 landmark 祖链
  let flow = null;       // 当前顶层 flow 组（landmark 组开启即封口）
  const open = (rowIndex, kind, parentGroup) => {
    const row = list[rowIndex] || {};
    const g = {
      index: groups.length,
      kind,
      rowIndex,
      role: String(row.role || ''),
      name: String(row.name || ''),
      depth: Number(row.depth) || 0,
      parent: parentGroup ? parentGroup.index : null,
      headerRef: row.ref ? String(row.ref) : null,
      rows: [],
      items: [],
      childGroups: [],
    };
    groups.push(g);
    if (parentGroup) {
      parentGroup.childGroups.push(g.index);
      parentGroup.items.push({ type: 'group', index: g.index });
    }
    return g;
  };
  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {};
    const d = Number(row.depth) || 0;
    while (stack.length && (Number(list[stack[stack.length - 1].rowIndex].depth) || 0) >= d) stack.pop();
    const enclosing = stack.length ? groups[stack[stack.length - 1].groupIndex] : null;
    const role = String(row.role || '');
    if (A11Y_LANDMARK_ROLES.has(role)) {
      const g = open(i, 'landmark', enclosing);
      g.rows.push(i);
      stack.push({ rowIndex: i, groupIndex: g.index });
      flow = null;
      continue;
    }
    let g;
    if (enclosing) g = enclosing;
    else {
      if (!flow) flow = open(i, 'flow', null);
      g = flow;
    }
    g.rows.push(i);
    g.items.push({ type: 'row', index: i });
    /* 折叠判据：①纯冗余行（InlineTextBox/ListMarker）；②无名/无引用/无标记的 generic 包装行（纯结构噪声）。
     * 有任一信息（name/ref/flag/value/J）的包装行一律保留。 */
    const noise = (A11Y_GROUP_FOLD_ROLES.has(role) && !row.name) || A11Y_GROUP_FOLD_ALWAYS_ROLES.has(role);
    if (noise && !row.ref && !row.focusable && !row.clickable && !row.disabled && !row.value && !row.jsListener) folded.add(i);
  }

  const rendered = renderA11yGroupLines(list, { groups, folded, parent });
  const defaultChars = list.map((r) => formatA11yLine(r)).join('\n').length;
  const groupChars = rendered.lines.join('\n').length;
  const reduction = defaultChars > 0 ? Math.max(0, Math.round((1 - groupChars / defaultChars) * 1000) / 10) : 0;
  const stats = {
    groups: groups.length,
    landmarkGroups: groups.filter((g) => g.kind === 'landmark').length,
    flowGroups: groups.filter((g) => g.kind === 'flow').length,
    rows: list.length,
    lines: rendered.lines.length,
    runs: rendered.runs,
    folded: folded.size,
    refs: list.filter((r) => r && r.ref).length,
    defaultChars,
    groupChars,
    reduction,
  };
  return { groups, stats, parent, folded };
}

/**
 * 分组视图渲染（纯函数）：组头 = `[path] "name" · N 行 · @eN`；组内同父同角色连续 run 合并为一行。
 * @returns {{lines:string[],runs:number}}
 */
function renderA11yGroupLines(rows, view) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = view && Array.isArray(view.groups) ? view.groups : [];
  const folded = (view && view.folded) || new Set();
  const parent = (view && view.parent) || parentIndexesOf(list);
  const lines = [];
  let runs = 0;
  const renderGroup = (g, depthInGroups) => {
    const pad = '  '.repeat(Math.min(depthInGroups, 2));
    const visible = g.rows.filter((i) => !folded.has(i));
    const isFlow = g.kind !== 'landmark';
    /* flow 组：单行组不配组头（多一行纯噪声）；全页只有一个 flow 组（无 landmark 页面）=不分组的等价形态，同样不配组头。
     * landmark 组头承载 landmark 自身行（name/@eN 不重复渲染）。 */
    if (!isFlow || (visible.length > 1 && groups.length > 1)) {
      const path = groupPathOf(groups, g);
      const name = !isFlow && g.name ? ` ${JSON.stringify(compactText(g.name, NAME_MAX))}` : '';
      const ref = !isFlow && g.headerRef ? ` · @${g.headerRef}` : '';
      lines.push(`${pad}[${path}]${name} · ${visible.length} 行${ref}`);
    }
    /* 深度压缩：组内可见行的实际深度按秩映射（折叠 generic 留下的空洞不占缩进） */
    const depthRank = new Map();
    [...new Set(visible.filter((i) => isFlow || i !== g.rowIndex).map((i) => Number(list[i].depth) || 0))]
      .sort((a, b) => a - b)
      .forEach((d, i) => depthRank.set(d, Math.min(i, 8)));
    let run = null;
    const flush = () => {
      if (!run) return;
      const indent = '  '.repeat(Math.max(0, run.rel));
      const count = run.items.length > 1 ? ` ×${run.items.length}` : '';
      const flags = run.flags ? ` [${run.flags}]` : '';
      const role = run.role || '(no-role)';
      lines.push(`${pad}${indent}${role}${count}${flags}: ${run.items.join(' | ')}`);
      runs++;
      run = null;
    };
    for (const it of g.items) {
      if (it.type === 'group') {
        flush();
        renderGroup(groups[it.index], depthInGroups + 1);
        continue;
      }
      const row = list[it.index] || {};
      if (folded.has(it.index)) continue;
      const rel = depthRank.get(Number(row.depth) || 0) || 0;
      const key = `${parent[it.index]}|${row.depth}|${row.role}|${groupRowSig(row)}`;
      if (run && run.key === key) run.items.push(groupItemText(row));
      else {
        flush();
        run = { key, role: String(row.role || ''), flags: groupRowSig(row), rel, items: [groupItemText(row)] };
      }
    }
    flush();
  };
  for (const g of groups) if (g.parent === null || g.parent === undefined) renderGroup(g, 0);
  return { lines, runs };
}

/** 分组视图摘要行（仅 --group；默认路径零参与） */
function formatA11yGroupHeader(r, stats) {
  const s = stats || {};
  return `[a11y] 分组：${s.landmarkGroups || 0} 个 landmark 组 + ${s.flowGroups || 0} 个散段组 / ${s.rows || 0} 节点 → ${s.lines || 0} 行`
    + `（行区字符 -${s.reduction || 0}%${s.folded ? `；折叠冗余行 ${s.folded}` : ''}${s.refs ? `；@eN ${s.refs} 个全树序不变，编号与默认视图一致` : ''}）`;
}

function formatA11yReport(report) {
  const r = report || {};
  const target = r.target || {};
  const where = [compactText(target.url || '', 120), target.title ? `@ ${target.title}` : ''].filter(Boolean).join(' ');
  const depthText = r.depth ? `深度≤${r.depth}` : '全量深度';
  const lines = [];
  lines.push(`[a11y] ${r.ok ? '✓' : '✗'} ${where || '(未知目标)'}（${r.nodeCount || 0} 节点`
    + `${r.truncated ? `，截断省略 ${r.omitted}` : ''}；${depthText}`
    + `${r.depthMode === 'client' ? '·客户端裁剪' : ''}；${r.elapsedMs || 0}ms${r.timedOut ? '；⚠ 超时 partial' : r.degraded ? '；⚠ 降级 partial' : ''}`
    + `${Array.isArray(r.frames) && r.frames.length ? `；frames=${r.frames.length}` : ''}）`);
  if (r.query) {
    lines.push(`[a11y] 定位：${r.query.kind}=${JSON.stringify(r.query.value)}`
      + `${r.element ? ` → ${r.element.tag}${r.element.cssPath ? ' ' + r.element.cssPath : ''}` : ''}`
      + `${r.element && r.element.framePath && r.element.framePath.length ? `（frame main>${r.element.framePath.join('>')}）` : ''}`);
  }
  if (r.framesSkipped) lines.push(`[a11y] ⚠ --frames 对定位子树不适用（已跳过帧合并：${r.framesSkipped}）`);
  if (r.exclude) {
    lines.push(`[a11y] 排除 ${JSON.stringify(r.exclude.selector)}：剪除 ${r.exclude.pruned || 0} 节点`
      + `（匹配 ${r.exclude.matched || 0} 元素${r.exclude.truncated ? '，超上限截断' : ''}）`);
  }
  if (r.visibleOnly) {
    lines.push(`[a11y] 可见过滤：检查 ${r.visibleOnly.checked || 0}，遮挡剪除 ${r.visibleOnly.occluded || 0}`
      + `${r.visibleOnly.offscreen ? `，视口外 ${r.visibleOnly.offscreen}` : ''}`
      + `${r.visibleOnly.skippedFrames ? `，子帧跳过 ${r.visibleOnly.skippedFrames}` : ''}`
      + `${r.visibleOnly.errors ? `，读取失败 ${r.visibleOnly.errors}` : ''}`);
  }
  if (Array.isArray(r.frameErrors) && r.frameErrors.length) {
    const shown = r.frameErrors.slice(0, 3);
    lines.push(`[a11y] ⚠ 帧取数失败 ${r.frameErrors.length} 个（不影响主树）：`);
    for (const e of shown) lines.push(`  - ${e.name || e.frameId || '(frame)'}：${compactText(e.error || e.reason || 'unknown', 120)}`);
    if (r.frameErrors.length > shown.length) lines.push(`  - …另 ${r.frameErrors.length - shown.length} 个见 --json data.frameErrors`);
  }
  if (r.framesUnsupported) lines.push('[a11y] ⚠ framesUnsupported=true（当前 Chrome 忽略 getFullAXTree.frameId）——仅返回主文档树，approximate=true；升级浏览器或改 --text/--selector 进入子帧子树');

  if (r.diff) {
    const d = r.diff;
    if (d.forcedFull) {
      lines.push(`[a11y] diff：基线不可比（${d.forcedReason || 'unknown'}）→ 全量输出 forcedFull=true${d.baseSnapshotId ? `（旧基线 ${d.baseSnapshotId}）` : ''}`);
    } else {
      lines.push(`[a11y] diff：基线 ${d.baseSnapshotId || '?'}；新增 ${d.stats.added} / 变化 ${d.stats.changed} / 未变 ${d.stats.unchanged} / 移除 ${d.stats.removed}`
        + `${d.degraded ? `；⚠ degraded（${(d.degradedReasons || []).join(',')}）` : ''}`);
    }
  }
  if (r.cursor) {
    const c = r.cursor;
    const end = c.offset + c.size;
    lines.push(`[a11y] 分页 ${c.offset}..${end - 1 >= c.offset ? end - 1 : c.offset}/${c.total}（view=${c.view}；snapshot ${c.snapshotId || '?'}）`);
  }

  if (r.find) formatFindLines(r, lines);
  else if (r.groupView || r.group === true) {
    /* C6 --group：渲染层分组（默认路径两字段都不存在 → 下方 else 逐字节不变）。
     * r.group 标记=库层（runA11y）也自洽；CLI 另补 groupView 统计/组清单进 --json。 */
    const view = buildA11yGroups(r.nodes || []);
    lines.push(formatA11yGroupHeader(r, view.stats));
    for (const line of renderA11yGroupLines(r.nodes || [], view).lines) lines.push(line);
  } else for (const row of (r.nodes || [])) {
    lines.push(formatA11yLine(row, { prefix: r.diff && !r.diff.forcedFull ? '* ' : '' }));
  }

  /* B5：引用表落点与消费方式（仅 --ref；无 --ref 时 report.refTable 不存在 → 逐字节不变） */
  if (r.refTable) {
    const n = Array.isArray(r.refs) ? r.refs.length : 0;
    lines.push(`[a11y] 引用：${n} 个 @eN（表 ${r.refTable}）——消费 click/type/hover --ref @e1；`
      + '导航/刷新/元素被替换即失效（E_REF_STALE），重新 a11y --ref 刷新');
    if (r.refStats && r.refStats.cssPathDropped) {
      lines.push(`[a11y] ⚠ ${r.refStats.cssPathDropped} 个 ref 无可用 cssPath（降级为 role+name 二级定位）`);
    }
  } else if (r.refError) {
    lines.push(`[a11y] ⚠ 引用表生成失败：${r.refError}`);
  }
  if (r.cursor) {
    if (r.cursor.nextToken) lines.push(`[a11y] 下一段：--cursor-token ${r.cursor.nextToken}`);
    else lines.push('[a11y] 分页：末页');
  }
  if (r.timedOut) {
    lines.push(`[a11y] ⚠ timedOut=true：以上为超时前所得${r.partial ? '部分' : ''}结果（nodeCount=${r.nodeCount || 0}）；`
      + '替代通道：cdp.js exec DOM.getDocument / cdp.js screenshot / MCP take_snapshot（轻页面）');
  }
  if (r.degraded) lines.push(`[a11y] ⚠ 深段失败（${r.error}）：仅返回浅层 partial 结果（nodeCount=${r.nodeCount || 0}）——重试或先 --depth 裁剪`);
  if (!r.ok && r.error) lines.push(`[a11y] ✗ ${r.error}`);
  return lines;
}

/* ── CSS 投影/格式化（纯函数） ── */

function cssPropertiesOf(style) {
  const props = Array.isArray(style && style.cssProperties) ? style.cssProperties : [];
  return props
    .filter((p) => p && p.name && p.value !== undefined && p.value !== null)
    .map((p) => ({ name: String(p.name), value: String(p.value), important: p.important === true, disabled: p.disabled === true }));
}

function mediaTextOf(media) {
  if (!media) return null;
  if (typeof media === 'string') return media;
  if (typeof media.text === 'string') return media.text;
  return null;
}

/**
 * CSS.getMatchedStylesForNode 结果 → 紧凑结构（纯函数）。
 * @returns {{inline:object|null,attributes:object|null,rules:object[],truncated:boolean,totalRules:number}}
 */
function projectMatchedStyles(raw) {
  const r = raw || {};
  const inline = r.inlineStyle ? { source: 'inline', properties: cssPropertiesOf(r.inlineStyle) } : null;
  const attributes = r.attributesStyle ? { source: 'attributes', properties: cssPropertiesOf(r.attributesStyle) } : null;
  const rawRules = Array.isArray(r.matchedCSSRules) ? r.matchedCSSRules : [];
  const rules = rawRules.slice(0, MAX_MATCHED_RULES).map((entry) => {
    const rule = (entry && entry.rule) || {};
    return {
      origin: String(rule.origin || ''),
      selector: String((rule.selectorList && rule.selectorList.text) || ''),
      media: mediaTextOf(rule.media),
      properties: cssPropertiesOf(rule.style),
      matchingSelectors: Array.isArray(entry && entry.matchingSelectors) ? entry.matchingSelectors.slice() : [],
    };
  });
  return { inline, attributes, rules, truncated: rawRules.length > MAX_MATCHED_RULES, totalRules: rawRules.length };
}

function formatCssReport(report) {
  const r = report || {};
  const target = r.target || {};
  const element = r.element || {};
  const where = [compactText(target.url || '', 120), target.title ? `@ ${target.title}` : ''].filter(Boolean).join(' ');
  const lines = [];
  lines.push(`[css] ${r.ok ? '✓' : '✗'} ${where || '(未知目标)'}（${r.elapsedMs || 0}ms）`);
  if (element.tag) {
    lines.push(`[css] 元素：${element.tag}${element.id ? '#' + element.id : ''}`
      + `${element.cssPath ? ' ' + element.cssPath : ''}`
      + `${element.framePath && element.framePath.length ? `（frame main>${element.framePath.join('>')}）` : ''}`);
  }
  if (r.computed) {
    const keys = Object.keys(r.computed).sort();
    lines.push(`[css] computed（getComputedStyle，${keys.length} 项）：`);
    for (const k of keys) lines.push(`  ${k}: ${r.computed[k]}`);
  }
  if (r.computedError) lines.push(`[css] ✗ computed 失败：${r.computedError}`);
  if (r.matched) {
    const rules = r.matched.rules || [];
    lines.push(`[css] matched（CSS.getMatchedStylesForNode，${rules.length}${r.matched.truncated ? '/' + r.matched.totalRules : ''} 条）：`);
    if (r.matched.inline && r.matched.inline.properties.length) lines.push(`  [inline] { ${r.matched.inline.properties.map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`).join('; ')} }`);
    if (r.matched.attributes && r.matched.attributes.properties.length) lines.push(`  [attributes] { ${r.matched.attributes.properties.map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`).join('; ')} }`);
    rules.forEach((rule, i) => {
      const body = rule.properties.map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`).join('; ');
      lines.push(`  [${i + 1}] ${rule.origin || '?'} ${rule.selector || '(unknown)'}${rule.media ? ` @media ${rule.media}` : ''} { ${body} }`);
    });
    if (r.matched.truncated) lines.push(`[css] ⚠ matched 规则超上限（${MAX_MATCHED_RULES}），已截断（total=${r.matched.totalRules}）`);
  }
  if (r.matchedError) lines.push(`[css] ✗ matched 失败：${r.matchedError}`);
  return lines;
}

/* ── 通用小件 ── */

/** 到点返回 TIMEOUT 的 race 包装（底层 send 自身也有超时；双保险防挂死） */
function raceTimeout(promise, ms) {
  let timer = null;
  const gate = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ms)); });
  return Promise.race([promise, gate]).finally(() => { if (timer) clearTimeout(timer); });
}

function quadToRect(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  if (xs.some((n) => !Number.isFinite(n)) || ys.some((n) => !Number.isFinite(n))) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(...xs) - x), h: Math.round(Math.max(...ys) - y) };
}

function projectElement(candidate) {
  const c = candidate || {};
  return {
    tag: String(c.tag || ''),
    id: String(c.id || ''),
    cls: String(c.cls || ''),
    text: compactText(c.text || '', 60),
    cssPath: String(c.cssPath || ''),
    framePath: Array.isArray(c.framePath) ? c.framePath.slice() : [],
    rect: c.rect || null,
  };
}

/**
 * 候选裁决（纯函数；不滚动、不点）。优先级：唯一可点 → 唯一可见 → 仅一个候选；
 * 多候选不猜（返回 ambiguous + 候选清单），--nth 在「可见优先」池中显式选择。
 */
function chooseA11yCandidate(candidates, opts) {
  const o = opts || {};
  const list = Array.isArray(candidates) ? candidates : [];
  const ranked = locator.rankCandidates(list, o.spec);
  const nth = Number.isInteger(o.nth) ? o.nth : null;
  if (nth !== null) {
    const visiblePool = ranked.filter((c) => c && c.visible === true);
    const pool = visiblePool.length ? visiblePool : ranked;
    if (nth >= pool.length) return { ok: false, reason: 'nth-out-of-range', pool: pool.length, total: list.length };
    return { ok: true, candidate: pool[nth] };
  }
  const clickable = ranked.filter(locator.isClickable);
  if (clickable.length === 1) return { ok: true, candidate: clickable[0] };
  const visible = ranked.filter((c) => c && c.visible === true);
  if (visible.length === 1) return { ok: true, candidate: visible[0] };
  if (list.length === 1) return { ok: true, candidate: list[0] };
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: (visible.length ? visible : ranked).slice(0, 8),
    clickable: clickable.length,
    visible: visible.length,
    total: list.length,
  };
}

/* ── CDP 动作 ── */

async function releaseObject(client, sessionId, objectId) {
  if (!objectId) return;
  try { await client.send('Runtime.releaseObject', { objectId }, { sessionId, timeoutMs: 1000 }); } catch (e) { /* 尽力而为 */ }
}

/** 定位元素（复用 locator 跨同源 iframe；零滚动）：返回 objectId/nodeId/backendNodeId + 元素摘要。 */
async function locateElement(client, sessionId, query, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 10000;
  const spec = query.kind === 'text'
    ? (query.match ? { text: query.value, match: query.match } : { text: query.value })
    : { domPath: query.value };
  const rep = await locator.collectCandidates(client, sessionId, spec, { timeoutMs, maxCandidates: 200 });
  if (!rep.ok) return { ok: false, reason: rep.error || 'collect-failed', error: rep.message || rep.error, candidates: [] };
  const chosen = chooseA11yCandidate(rep.candidates, { nth: query.nth, spec: rep.spec || spec });
  if (!chosen.ok) return Object.assign({ ok: false, candidates: chosen.candidates || [] }, chosen);
  const candidate = chosen.candidate;
  const expression = locator.buildFindElementExpr(candidate);
  const ev = await client.send('Runtime.evaluate', {
    expression, returnByValue: false, objectGroup: 'chromeuse-perceive', userGesture: false,
  }, { sessionId, timeoutMs });
  const objectId = ev && ev.result && ev.result.objectId;
  if (!objectId) return { ok: false, reason: 'element-not-found', candidate, candidates: [candidate] };
  let node = {};
  try {
    const desc = await client.send('DOM.describeNode', { objectId }, { sessionId, timeoutMs });
    node = (desc && desc.node) || {};
  } catch (e) {
    return { ok: false, reason: 'describe-failed', error: e.message, candidate, objectId, candidates: [candidate] };
  }
  return {
    ok: true, candidate, objectId,
    nodeId: node.nodeId === undefined ? null : node.nodeId,
    backendNodeId: node.backendNodeId === undefined ? null : node.backendNodeId,
    element: projectElement(candidate),
  };
}

/**
 * 取整树（带 depth 参数；88 无 depth 参数时降级无参重发，由调用方客户端裁剪）。
 * @returns {Promise<{ok:boolean,nodes?:object[],timedOut?:boolean,error?:string,paramFallback?:boolean}>}
 */
async function sendFullTree(client, sessionId, depth, budgetMs, opts) {
  const t0 = Date.now();
  const frameId = opts && opts.frameId ? String(opts.frameId) : null;
  const paramsFor = (d) => {
    const p = d >= 1 ? { depth: d } : {};
    if (frameId) p.frameId = frameId;
    return p;
  };
  const attempt = async (params, budget) => {
    const timeoutMs = Math.max(1, budget);
    const p = client.send('Accessibility.getFullAXTree', params, { sessionId, timeoutMs });
    const res = await raceTimeout(p, timeoutMs);
    if (res === TIMEOUT) {
      p.catch(() => { /* race 已返回；晚到错误丢弃 */ });
      return { kind: 'timeout' };
    }
    return { kind: 'ok', nodes: Array.isArray(res && res.nodes) ? res.nodes : [] };
  };
  try {
    const first = await attempt(paramsFor(depth), budgetMs);
    if (first.kind === 'ok') return { ok: true, nodes: first.nodes };
    return { ok: false, timedOut: true, error: `Accessibility.getFullAXTree 超时（${budgetMs}ms）` };
  } catch (e) {
    // 88 分叉：Chrome 88 的 getFullAXTree 无 depth/frameId 参数；若被协议层拒绝，退化为无参（保留
    // frameId，便于 153 上 depth 被拒但 frameId 可用的实现）重发；客户端仍按请求 depth 裁剪。
    if (depth >= 1 && /depth|Invalid parameters|unknown property|Failed to deserialize/i.test(String(e && e.message))) {
      const remain = Math.max(1, budgetMs - (Date.now() - t0));
      try {
        const second = await attempt(frameId ? { frameId } : {}, remain);
        if (second.kind === 'ok') return { ok: true, nodes: second.nodes, paramFallback: true };
        return { ok: false, timedOut: true, error: `Accessibility.getFullAXTree 超时（${remain}ms）` };
      } catch (e2) {
        return { ok: false, timedOut: e2 && e2.kind === 'timeout', error: e2.message };
      }
    }
    return { ok: false, timedOut: e && e.kind === 'timeout', error: e.message };
  }
}

/**
 * 整树两段式取数：浅层先拿（保证超时也有 partial），深段失败/超时返回浅层结果并标 timedOut。
 * depth 被服务端忽略（Chrome 88 或旧实现）时，第 1 段实际是全树 → 直接返回并标 depthMode:'client'。
 */
async function fetchFullTree(client, sessionId, opt, deadline) {
  const stages = planA11yStages(opt.depth, opt.timeoutMs);
  const stageLog = [];
  let best = null;
  let depthMode = null;
  for (const st of stages) {
    const remain = deadline - Date.now();
    if (remain < 1) {
      stageLog.push({ label: st.label, depth: st.depth, timeoutMs: 0, elapsedMs: 0, ok: false, timedOut: true, error: 'deadline' });
      if (best) return { ok: true, nodes: best, stageLog, timedOut: true, partial: true, depthMode };
      return { ok: false, nodes: [], stageLog, timedOut: true, error: `总预算 ${opt.timeoutMs}ms 已用尽（未取得节点）` };
    }
    const budget = Math.max(1, Math.min(st.timeoutMs, remain));
    const t = Date.now();
    const r = await sendFullTree(client, sessionId, st.depth, budget, { frameId: opt.frameId });
    stageLog.push({
      label: st.label, depth: st.depth, timeoutMs: budget, elapsedMs: Date.now() - t,
      ok: r.ok, timedOut: !!r.timedOut, error: r.error, paramFallback: !!r.paramFallback,
    });
    if (!r.ok) {
      if (best) return { ok: true, nodes: best, stageLog, timedOut: !!r.timedOut, partial: true, depthMode, error: r.error };
      // 浅段失败不立即放弃：Chrome 的 depth 只裁剪响应，AX 缓存仍需全量构建——首调可能因冷缓存
      // 超时，第二次（剩余预算）常能命中已建好的缓存。仍有剩余预算就继续深段；预算耗尽/单段
      // 命令则如实失败（到点必返，绝不挂死）。
      if (st.label === 'shallow' && stages.length > 1) continue;
      return { ok: false, nodes: [], stageLog, timedOut: !!r.timedOut, error: r.error };
    }
    if (st.label === 'depth') {
      // 单段：Chrome 153 depth 会留下悬空 childIds；Chrome 88 忽略 depth 返回全量（无悬空且更深）
      // → 后者由 buildAxRows 客户端裁剪，并在报告里如实标 depthMode:'client'。
      const full = buildAxRows(r.nodes, { depth: 0, maxNodes: MAX_NODES_MAX });
      const maxD = full.rows.reduce((m, row) => Math.max(m, row.depth), -1);
      const honored = hasDanglingChildren(r.nodes) || maxD <= (st.depth - 1);
      return { ok: true, nodes: r.nodes, stageLog, timedOut: false, partial: false, depthMode: honored ? 'server' : 'client' };
    }
    if (st.label === 'shallow') {
      best = r.nodes;
      // 判断 depth 是否真正生效：悬空 childIds=服务端确实裁剪（Chrome 153 实测 depth=3 会因
      // ignored 节点展开导致 maxDepth 达 5，不能用 maxDepth 反推）；无悬空=本次已是完整树
      // （Chrome 88 忽略 depth 参数时即全量返回），直接返回，避免 88 上重复拉一遍全树。
      if (!hasDanglingChildren(best)) {
        const full = buildAxRows(best, { depth: 0, maxNodes: MAX_NODES_MAX });
        const maxD = full.rows.reduce((m, row) => Math.max(m, row.depth), -1);
        depthMode = maxD > (st.depth - 1) ? 'client' : 'server';
        return { ok: true, nodes: best, stageLog, timedOut: false, partial: false, depthMode };
      }
      depthMode = 'server';
      continue; // 服务端已按浅层裁剪 → 继续深段
    }
    return { ok: true, nodes: r.nodes, stageLog, timedOut: false, partial: false, depthMode: depthMode || 'server' };
  }
  return { ok: true, nodes: best || [], stageLog, timedOut: false, partial: false, depthMode };
}

/** 定位子树（getPartialAXTree；fetchRelatives:true 后用 backendDOMNodeId 过滤出目标子树根）。 */
async function fetchPartialTree(client, sessionId, loc, budgetMs) {
  const p = client.send('Accessibility.getPartialAXTree', {
    objectId: loc.objectId, fetchRelatives: true,
  }, { sessionId, timeoutMs: budgetMs });
  let res;
  try {
    res = await raceTimeout(p, budgetMs);
  } catch (e) {
    return { ok: false, timedOut: e && e.kind === 'timeout', error: `Accessibility.getPartialAXTree 失败：${e.message}` };
  }
  if (res === TIMEOUT) {
    p.catch(() => { /* race 已返回 */ });
    return { ok: false, timedOut: true, error: `Accessibility.getPartialAXTree 超时（${budgetMs}ms）` };
  }
  const nodes = Array.isArray(res && res.nodes) ? res.nodes : [];
  let target = null;
  if (loc.backendNodeId !== null && loc.backendNodeId !== undefined) {
    target = nodes.find((n) => n && n.backendDOMNodeId === loc.backendNodeId && n.ignored !== true)
      || nodes.find((n) => n && n.backendDOMNodeId === loc.backendNodeId)
      || null;
  }
  if (!target && nodes.length === 1) target = nodes[0]; // 部分实现只回目标节点
  if (!target) {
    return { ok: false, error: `AX 树未找到目标元素（backendNodeId=${loc.backendNodeId}；元素可能不可访问/已被移除）`, nodes: [] };
  }
  return { ok: true, nodes, startNodeId: String(target.nodeId) };
}

/** 取 bounds（前 150 个有 backendDOMNodeId 的行并发 getBoxModel；失败/超限保持 null）。 */
async function applyBounds(client, sessionId, rows, opts) {
  const o = opts || {};
  const maxNodes = Number.isInteger(o.maxNodes) ? o.maxNodes : BOUNDS_MAX_NODES;
  const timeoutMs = Number.isInteger(o.timeoutMs) ? o.timeoutMs : BOUNDS_CMD_TIMEOUT_MS;
  const targets = rows.filter((r) => r && r.backendDOMNodeId !== null && r.backendDOMNodeId !== undefined && r.bounds === null).slice(0, maxNodes);
  let fetched = 0;
  await Promise.all(targets.map(async (row) => {
    try {
      const res = await client.send('DOM.getBoxModel', { backendNodeId: row.backendDOMNodeId }, { sessionId, timeoutMs });
      const model = res && res.model;
      const rect = quadToRect(model && (model.border || model.content));
      if (rect) { row.bounds = rect; fetched++; }
    } catch (e) { /* 不可布局/不可见节点没有 box model——保持 null */ }
  }));
  return { fetched, skipped: rows.length - fetched };
}

/* ── B6a：同源帧合并（--frames same-origin）─────────────────────────────── */

/**
 * Page.getFrameTree → 扁平帧表（纯函数；只含本 target 可见的同进程帧，OOPIF 不在内）。
 * 不入 root 主帧自身；path = 从主帧到该帧的标签链（iframe name 优先，空名用 frame-<id6>）。
 */
function flattenFrameTree(frameTree) {
  const rootNode = (frameTree && frameTree.frameTree) || frameTree || null;
  const out = [];
  const seen = new Set();
  const walk = (node, parentPath) => {
    const f = (node && node.frame) || {};
    if (!f.id) return;
    const id = String(f.id);
    if (seen.has(id)) return;
    seen.add(id);
    const name = String(f.name || '').trim();
    const label = name || `frame-${id.slice(0, 6)}`;
    const path = parentPath.concat(label);
    out.push({
      frameId: id,
      parentFrameId: f.parentId ? String(f.parentId) : null,
      name,
      url: String(f.url || ''),
      loaderId: String(f.loaderId || ''),
      path,
    });
    for (const c of (node.childFrames || [])) walk(c, path);
  };
  if (rootNode) for (const c of (rootNode.childFrames || [])) walk(c, []);
  return out;
}

/**
 * frameId 参数是否真被服务端采纳（纯函数；88 分叉判据）：
 *   - 响应 root 节点带 frameId → 等于请求=honored / 不等=ignored（Chrome 153 实测 RootWebArea 带）；
 *   - 无 frameId 字段 → 与主树节点集合全等（数量+id）判 ignored（88 忽略额外参数返回主帧全树）；
 *   - 其余=honored（空树也是合法空帧）。
 * 只做判据，不做页侧投影——ignored 时如实报 framesUnsupported，绝不假合并。
 */
function classifyFrameTreeResponse(nodes, frameId, mainNodeIds) {
  const list = Array.isArray(nodes) ? nodes : [];
  const ids = new Set(list.map((n) => String(n && n.nodeId)));
  const roots = list.filter((n) => !n || !n.parentId || !ids.has(String(n.parentId)));
  const withFrame = roots.filter((n) => n && n.frameId !== undefined && n.frameId !== null);
  if (withFrame.length) {
    return withFrame.every((n) => String(n.frameId) === String(frameId)) ? 'honored' : 'ignored';
  }
  if (mainNodeIds && mainNodeIds.size && ids.size === mainNodeIds.size) {
    let same = true;
    for (const id of ids) { if (!mainNodeIds.has(id)) { same = false; break; } }
    if (same) return 'ignored';
  }
  return 'honored';
}

/**
 * 帧行挂接（纯函数）：按 DOM.getFrameOwner 的 backendNodeId 把子帧行拼到父树 Iframe 行之后。
 * frames = [{frameId,parentFrameId,path,ownerBid,rows:[...]}]; 子帧 RootWebArea 已在取数时折叠。
 * 未挂接的帧（owner 行被 depth/截断裁掉）追加到末尾（depth 从 0 起）并计入 frameErrors（调用方负责）。
 */
function mergeFrameRows(mainRows, frames, mainFrameId) {
  const list = Array.isArray(frames) ? frames : [];
  const byParent = new Map();
  for (const f of list) {
    const p = f.parentFrameId == null ? null : String(f.parentFrameId);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(f);
  }
  const rendered = new Set();
  const attach = (frame, anchorDepth, path) => {
    if (!frame || rendered.has(frame.frameId)) return [];
    rendered.add(frame.frameId);
    const out = [];
    for (const row of (frame.rows || [])) {
      row.depth = anchorDepth + Math.max(1, Number(row.depth) || 0);
      row.framePath = path.slice();
      out.push(row);
      for (const child of (byParent.get(frame.frameId) || [])) {
        if (child.ownerBid !== null && child.ownerBid !== undefined && child.ownerBid === row.backendDOMNodeId) {
          out.push(...attach(child, row.depth, child.path));
        }
      }
    }
    return out;
  };
  const out = [];
  for (const row of (Array.isArray(mainRows) ? mainRows : [])) {
    out.push(row);
    for (const child of (byParent.get(mainFrameId) || [])) {
      if (child.ownerBid !== null && child.ownerBid !== undefined && child.ownerBid === row.backendDOMNodeId) {
        out.push(...attach(child, row.depth, child.path));
      }
    }
  }
  for (const f of list) if (!rendered.has(f.frameId)) out.push(...attach(f, 0, f.path));
  return out;
}

/**
 * 同源帧取树（B0 POC 定案路径）：Page.getFrameTree 递归枚举 → 逐帧 getFullAXTree({frameId})
 * → DOM.getFrameOwner 记挂载点；单帧失败只记 frameErrors[]，不整体失败。
 * ⚠ 88 分叉：frameId 参数约 Chrome 92~94 才引入；88 会忽略额外参数返回主帧树——由
 *   classifyFrameTreeResponse 检测后设 framesUnsupported/approximate:true（如实报不支持，
 *   不做页侧 contentDocument 投影假合并）。
 */
async function fetchFrameRows(client, sessionId, opt, deadline, mainNodes) {
  const out = { frames: [], errors: [], unsupported: false, approximate: false, mainFrameId: null, mainFrame: null };
  let remain = deadline - Date.now();
  if (remain < 1) {
    out.errors.push({ frameId: null, name: null, url: null, error: '总预算已用尽（未枚举帧）' });
    return out;
  }
  let tree = null;
  try {
    tree = await client.send('Page.getFrameTree', {}, { sessionId, timeoutMs: Math.max(1, Math.min(5000, remain)) });
  } catch (e) {
    out.errors.push({ frameId: null, name: null, url: null, error: `Page.getFrameTree 失败：${e.message}` });
    return out;
  }
  out.mainFrame = (tree && tree.frameTree && tree.frameTree.frame) || null;
  out.mainFrameId = String((out.mainFrame && out.mainFrame.id) || '') || null;
  const flat = flattenFrameTree(tree);
  if (!flat.length) return out;
  const mainNodeIds = new Set((Array.isArray(mainNodes) ? mainNodes : []).map((n) => String(n && n.nodeId)));
  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    remain = deadline - Date.now();
    if (remain < 1) {
      out.errors.push({ frameId: f.frameId, name: f.name, url: f.url, error: '总预算已用尽' });
      continue;
    }
    const left = flat.length - i;
    const budget = Math.max(1, Math.min(FRAME_FETCH_MAX_MS, Math.max(FRAME_FETCH_MIN_MS, Math.floor(remain / (left + 1)))));
    const fetched = await fetchFullTree(client, sessionId, {
      depth: opt.depth, timeoutMs: budget, frameId: f.frameId,
    }, Date.now() + budget);
    if (!fetched.ok) {
      const msg = String(fetched.error || '');
      /* 参数层拒绝（88/-32602 Invalid parameters 族）→ 与「帧被移除」区分：后者只记该帧错误，
       * 前者说明 frameId 参数不可用，直接整体降级为 framesUnsupported（不逐帧刷错误）。 */
      if (/Invalid parameters|unknown property|Failed to deserialize|Unsupported method/i.test(msg)) {
        out.unsupported = true;
        out.approximate = true;
        out.frames = [];
        out.errors.push({
          frameId: f.frameId, name: f.name, url: f.url, reason: 'frameid-unsupported',
          error: `getFullAXTree.frameId 不被当前 Chrome 支持：${msg}`,
        });
        return out;
      }
      out.errors.push({
        frameId: f.frameId, name: f.name, url: f.url,
        error: fetched.error || 'fetch-failed', timedOut: !!fetched.timedOut,
      });
      continue;
    }
    const verdict = classifyFrameTreeResponse(fetched.nodes, f.frameId, mainNodeIds);
    if (verdict === 'ignored') {
      // 88：frameId 被忽略（返回主帧树）→ 不合并任何子帧，如实报不支持。
      out.unsupported = true;
      out.approximate = true;
      out.frames = [];
      out.errors.push({
        frameId: f.frameId, name: f.name, url: f.url, reason: 'frameid-ignored',
        error: '当前 Chrome 忽略 getFullAXTree.frameId（约 92~94 才引入）——--frames 不可用；已按主文档树返回（approximate=true），未做页侧投影假合并',
      });
      return out;
    }
    const built = buildAxRows(fetched.nodes, { depth: opt.depth, maxNodes: Math.max(1, opt.maxNodes) });
    const rows = built.rows.filter((r) => r.role !== 'RootWebArea' && r.role !== 'WebArea');
    let ownerBid = null;
    try {
      const owner = await client.send('DOM.getFrameOwner', { frameId: f.frameId }, { sessionId, timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())) });
      if (owner && owner.backendNodeId !== undefined && owner.backendNodeId !== null) ownerBid = Number(owner.backendNodeId);
    } catch (e) { /* 挂载点取不到 → 追加到末尾，不阻断其他帧 */ }
    out.frames.push({
      frameId: f.frameId, parentFrameId: f.parentFrameId, name: f.name, url: f.url,
      path: f.path, ownerBid, rows, nodeCount: rows.length,
      omitted: built.omitted, truncated: built.truncated, depthMode: fetched.depthMode || null,
    });
  }
  return out;
}

/* ── B6a：DOM 侧索引 / 降噪（--exclude / --visible-only）────────────────── */

/** DOM.getDocument 树 → backendNodeId 索引（children/contentDocument/shadowRoots 全走） */
function buildDomIndex(root) {
  const byBid = new Map();
  const children = new Map();
  const docRoots = [];
  const walk = (node, parentBid) => {
    if (!node || typeof node !== 'object') return;
    const isDoc = node.nodeType === 9 || node.nodeName === '#document';
    const bid = node.backendNodeId === undefined || node.backendNodeId === null ? null : Number(node.backendNodeId);
    if (isDoc && node.nodeId !== undefined && node.nodeId !== null) docRoots.push({ nodeId: node.nodeId, backendNodeId: bid });
    if (bid !== null) {
      byBid.set(bid, {
        backendNodeId: bid, nodeId: node.nodeId, nodeType: node.nodeType,
        nodeName: String(node.nodeName || ''), parentBid: parentBid === undefined ? null : parentBid,
      });
      if (parentBid !== null && parentBid !== undefined) {
        if (!children.has(parentBid)) children.set(parentBid, []);
        children.get(parentBid).push(bid);
      }
    }
    for (const c of (node.children || [])) walk(c, bid);
    if (node.contentDocument) walk(node.contentDocument, bid);
    if (Array.isArray(node.shadowRoots)) for (const sr of node.shadowRoots) walk(sr, bid);
  };
  walk(root, null);
  return { byBid, children, docRoots };
}

async function fetchDomIndex(client, sessionId, timeoutMs) {
  const dom = await client.send('DOM.getDocument', { depth: -1, pierce: true }, { sessionId, timeoutMs });
  return buildDomIndex(dom && dom.root);
}

/** 某 backendNodeId 是否被排除节点集合（含祖先）覆盖（纯函数；memo 就地写） */
function coveredByExcluded(index, bid, excluded, memo) {
  if (bid === null || bid === undefined) return false;
  const key = Number(bid);
  if (memo.has(key)) return memo.get(key);
  let cur = index.byBid.get(key);
  let hit = false;
  const chain = [];
  while (cur) {
    chain.push(cur.backendNodeId);
    if (excluded.has(cur.backendNodeId)) { hit = true; break; }
    cur = cur.parentBid === null || cur.parentBid === undefined ? null : index.byBid.get(cur.parentBid);
  }
  for (const id of chain) memo.set(id, hit);
  return hit;
}

/**
 * --exclude 子树剪除：对每个文档根跑 DOM.querySelectorAll（含同进程 iframe contentDocument），
 * describeNode 取 backendNodeId，再按 DOM 祖先链判定行归属（无 bId 的文本行保守保留）。
 * 选择器非法 → 抛错（CLI 归 E_USAGE）；匹配 0 个不算错。
 */
async function applyExclude(client, sessionId, rows, selector, timeoutMs, domIndex) {
  if (!selector) return { rows, info: null };
  const index = domIndex || await fetchDomIndex(client, sessionId, timeoutMs);
  const nodeIds = [];
  let truncated = false;
  for (const doc of index.docRoots) {
    let res = null;
    try {
      res = await client.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector }, { sessionId, timeoutMs });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/selector|syntax|Invalid/i.test(msg)) throw new Error(`--exclude 选择器非法：${msg}`);
      continue;
    }
    for (const id of (res && res.nodeIds) || []) {
      if (nodeIds.length >= EXCLUDE_MAX_MATCHES) { truncated = true; break; }
      nodeIds.push(id);
    }
    if (truncated) break;
  }
  const excluded = new Set();
  for (const nodeId of nodeIds) {
    try {
      const desc = await client.send('DOM.describeNode', { nodeId }, { sessionId, timeoutMs });
      const n = (desc && desc.node) || {};
      if (n.backendNodeId !== undefined && n.backendNodeId !== null) excluded.add(Number(n.backendNodeId));
    } catch (e) { /* 节点瞬态消失：跳过 */ }
  }
  const memo = new Map();
  const kept = [];
  let pruneDepth = null;
  for (const row of rows) {
    const d = Number(row && row.depth) || 0;
    if (pruneDepth !== null) {
      if (d > pruneDepth) continue;   // 被排除子树的更深行（含无 backendDOMNodeId 的文本行）
      pruneDepth = null;
    }
    if (row && nonNullBid(row) !== null && coveredByExcluded(index, row.backendDOMNodeId, excluded, memo)) {
      pruneDepth = d;
      continue;
    }
    kept.push(row);
  }
  return {
    rows: kept,
    info: { selector, matched: excluded.size, pruned: rows.length - kept.length, truncated, documents: index.docRoots.length },
  };
}

function nonNullBid(row) {
  return row && row.backendDOMNodeId !== null && row.backendDOMNodeId !== undefined ? row.backendDOMNodeId : null;
}

/** 祖先判定（纯函数）：a 是否为 b 的祖先 */
function isAncestorBid(index, a, b) {
  let cur = index.byBid.get(Number(b));
  while (cur) {
    if (cur.backendNodeId === Number(a)) return true;
    cur = cur.parentBid === null || cur.parentBid === undefined ? null : index.byBid.get(cur.parentBid);
  }
  return false;
}

/** 顶层视口尺寸（Page.getLayoutMetrics 优先；失败退 window.innerWidth/Height；再失败 0=跳过检查） */
async function viewportSize(client, sessionId, timeoutMs) {
  try {
    const m = await client.send('Page.getLayoutMetrics', {}, { sessionId, timeoutMs });
    const v = (m && (m.cssLayoutViewport || m.layoutViewport)) || {};
    const w = Number(v.clientWidth) || 0;
    const h = Number(v.clientHeight) || 0;
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch (e) { /* 退页面求值 */ }
  try {
    const r = await client.send('Runtime.evaluate', {
      expression: '({width: window.innerWidth, height: window.innerHeight})', returnByValue: true, userGesture: false,
    }, { sessionId, timeoutMs });
    const v = r && r.result && r.result.value;
    if (v && v.width > 0 && v.height > 0) return { width: v.width, height: v.height };
  } catch (e) { /* 放弃遮挡检查 */ }
  return { width: 0, height: 0 };
}

/**
 * --visible-only 遮挡过滤（默认关）：仅主文档、有 bounds 的前 150 行；DOM.getNodeForLocation 求
 * 中心点最上层节点，命中自身/祖先/后代才算可见。视口外与子帧行跳过（如实计数，不猜）。
 */
async function applyVisibleOnly(client, sessionId, rows, timeoutMs, domIndex, viewport) {
  const index = domIndex || await fetchDomIndex(client, sessionId, timeoutMs);
  const vp = viewport || await viewportSize(client, sessionId, timeoutMs);
  const info = { checked: 0, occluded: 0, offscreen: 0, skippedFrames: 0, errors: 0 };
  if (!(vp.width > 0 && vp.height > 0)) {
    info.skipped = 'viewport-unavailable';
    return { rows, info };
  }
  const candidates = [];
  for (const row of rows) {
    if (row && Array.isArray(row.framePath) && row.framePath.length) { info.skippedFrames++; continue; }
    if (!row || !row.bounds || nonNullBid(row) === null) continue;
    candidates.push(row);
    if (candidates.length >= BOUNDS_MAX_NODES) break;
  }
  const occluded = new Set();
  await Promise.all(candidates.map(async (row) => {
    const b = row.bounds;
    const cx = Math.round(Number(b.x) + Number(b.w) / 2);
    const cy = Math.round(Number(b.y) + Number(b.h) / 2);
    if (!(cx >= 0 && cy >= 0 && cx < vp.width && cy < vp.height)) { info.offscreen++; return; }
    try {
      const hit = await client.send('DOM.getNodeForLocation', {
        x: cx, y: cy, ignorePointerEventsNone: true,
      }, { sessionId, timeoutMs: Math.min(OCCLUSION_CMD_TIMEOUT_MS, timeoutMs) });
      info.checked++;
      const hitBid = hit && hit.backendNodeId !== undefined && hit.backendNodeId !== null ? Number(hit.backendNodeId) : null;
      if (hitBid === null) return;
      const rowBid = Number(row.backendDOMNodeId);
      if (hitBid === rowBid || isAncestorBid(index, hitBid, rowBid) || isAncestorBid(index, rowBid, hitBid)) return;
      row.occluded = true;
      occluded.add(row);
      info.occluded++;
    } catch (e) { info.errors++; /* fail-open：读不到命中就保留行 */ }
  }));
  /* 遮挡行连同其后代一起剪除（AX 文本叶子无 backendDOMNodeId，单靠集合会漏） */
  const kept = [];
  let pruneDepth = null;
  for (const row of rows) {
    const d = Number(row && row.depth) || 0;
    if (pruneDepth !== null) {
      if (d > pruneDepth) continue;
      pruneDepth = null;
    }
    if (occluded.has(row)) { pruneDepth = d; continue; }
    kept.push(row);
  }
  return { rows: kept, info };
}

/* ── B6a：游标续页（读基线视图，零 CDP）────────────────────────────────── */

function cursorFailure(report, code, message) {
  Object.assign(report, { ok: false, code, error: message, elapsedMs: 0 });
  return report;
}

/**
 * --cursor-token 续页：只读 tmpdata/a11y-baseline/<targetId>.json 的已存视图（零 CDP/零重解析）。
 * token 与基线 snapshotId/视图哈希不一致 → 拒绝（不跨快照拼页）。
 */
function resumeCursorPage(opt, context, report) {
  const targetId = context && context.target && context.target.id;
  if (!targetId) return cursorFailure(report, 'E_NOT_FOUND', '--cursor-token 需要 --target（无法定位基线）');
  let token;
  try { token = snapshot.decodeCursorToken(opt.cursorToken); } catch (e) {
    return cursorFailure(report, 'E_USAGE', e.message);
  }
  const baseline = snapshot.readBaseline(targetId, context.baselineDir);
  if (!baseline) {
    return cursorFailure(report, 'E_NOT_FOUND', `游标基线不存在（${snapshot.baselinePath(targetId, context.baselineDir)}）——先执行 a11y --cursor 取第一页`);
  }
  if (String(baseline.snapshotId || '') !== token.snapshotId) {
    return cursorFailure(report, 'E_NOT_FOUND', '游标已过期（快照已更新）——重新执行 a11y --cursor 取第一页，不跨快照拼页');
  }
  const kind = snapshot.cursorViewKind(opt);
  const viewHash = snapshot.cursorViewHash(opt);
  if (token.viewHash !== viewHash) {
    return cursorFailure(report, 'E_USAGE', '--cursor-token 与当前模式/参数不一致（find/diff 旗标变了）——重新执行 a11y --cursor 取第一页');
  }
  const view = baseline.view || {};
  if (view.kind !== kind) {
    return cursorFailure(report, 'E_USAGE', `--cursor-token 属于 ${view.kind || 'unknown'} 视图，与当前 ${kind} 视图不一致`);
  }
  let items = [];
  if (kind === 'find') {
    const pattern = baseline.options && baseline.options.find ? baseline.options.find : null;
    if (!pattern) return cursorFailure(report, 'E_NOT_FOUND', '基线缺少 find 视图参数');
    items = snapshot.buildFindHits(baseline.rows, pattern, {
      context: snapshot.FIND_CONTEXT_LINES,
      allowedIndexes: Array.isArray(view.allowedIndexes) ? view.allowedIndexes : null,
    });
  } else {
    const indexes = Array.isArray(view.indexes) ? view.indexes : baseline.rows.map((_, i) => i);
    for (const i of indexes) if (baseline.rows[i]) items.push(baseline.rows[i]);
  }
  const page = snapshot.pageSlice(items, token.offset, opt.cursorSize);
  const nextToken = page.next === null ? null : snapshot.encodeCursorToken(baseline.snapshotId, page.next, viewHash);
  report.at = time.isoLocal();
  report.depth = (baseline.options && baseline.options.depth) || 0;
  report.maxNodes = (baseline.options && baseline.options.maxNodes) || 0;
  report.timeoutMs = opt.timeoutMs;
  report.nodeCount = baseline.nodeCount || baseline.rows.length;
  report.rawNodeCount = baseline.rawNodeCount || report.nodeCount;
  report.truncated = baseline.truncated === true;
  report.omitted = baseline.omitted || 0;
  report.ignoredCount = baseline.ignoredCount || 0;
  report.partial = baseline.partial === true;
  report.timedOut = false;
  report.degraded = false;
  report.depthMode = baseline.depthMode || null;
  report.snapshotId = baseline.snapshotId;
  if (kind === 'find') {
    report.find = {
      pattern: (baseline.options.find && baseline.options.find.raw) || '',
      isRegex: !!(baseline.options.find && baseline.options.find.isRegex),
      flags: (baseline.options.find && baseline.options.find.flags) || '',
      count: items.length,
      total: baseline.rows.length,
      hits: page.items,
    };
    report.nodes = uniqueRows(page.items.map((h) => h.row));
  } else if (kind === 'diff') {
    if (!view.diff || !view.diff.stats) return cursorFailure(report, 'E_NOT_FOUND', '基线缺少 diff 视图元数据（重新执行 a11y --diff --cursor 取第一页）');
    report.diff = Object.assign({}, view.diff, { baseSnapshotId: view.diff.baseSnapshotId || null });
    report.nodes = page.items;
  } else {
    report.nodes = page.items;
  }
  report.cursor = {
    offset: page.offset, size: page.size, total: page.total, next: page.next,
    nextToken, hasMore: page.next !== null, view: kind, snapshotId: baseline.snapshotId,
    baselineFile: baseline.file || null,
  };
  report.ok = true;
  report.elapsedMs = 0;
  return report;
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    const key = nonNullBid(row) === null ? row : `b:${row.backendDOMNodeId}:${row.depth}:${row.role}:${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildComputedExpr(candidate) {
  return `(function(){ var el = ${locator.buildFindElementExpr(candidate)}; if (!el) return null;
    var view = el.ownerDocument && el.ownerDocument.defaultView; if (!view || !view.getComputedStyle) return null;
    var cs = view.getComputedStyle(el); var out = {};
    for (var i = 0; i < cs.length; i++) { var name = cs[i]; out[name] = cs.getPropertyValue(name); }
    return out; })()`;
}

/**
 * CSS.getMatchedStylesForNode（DOM/CSS 域只读命令；结束前 CSS.disable 还原 agent 状态）。
 * ⚠ 实测坑（Chrome 153）：定位阶段 DOM.describeNode 拿到的 nodeId 在 DOM.enable/CSS.enable 之后会
 *   失效（-32000 Could not find node with given id）。正确顺序 = enable → DOM.getDocument（初始化
 *   DOM agent）→ CSS.enable → DOM.requestNode(objectId) 重新登记并取 nodeId → getMatchedStylesForNode。
 */
async function fetchMatchedStyles(client, sessionId, loc, timeoutMs) {
  if (!loc || typeof loc !== 'object' || (loc.nodeId === null && loc.backendNodeId === null && !loc.objectId)) {
    throw new Error('元素缺少 DOM 节点引用（objectId/nodeId/backendNodeId 均不可用）');
  }
  let cssEnabled = false;
  try {
    try { await client.send('DOM.enable', {}, { sessionId, timeoutMs }); } catch (e) { /* DOM.enable 失败仍尝试 CSS */ }
    try { await client.send('DOM.getDocument', { depth: 0 }, { sessionId, timeoutMs }); } catch (e) { /* 初始化尽力而为 */ }
    try {
      await client.send('CSS.enable', {}, { sessionId, timeoutMs });
      cssEnabled = true;
    } catch (e) {
      throw new Error(`CSS.enable 失败：${e.message}`);
    }
    let nodeId = loc.nodeId;
    try {
      const req = await client.send('DOM.requestNode', { objectId: loc.objectId }, { sessionId, timeoutMs });
      if (req && req.nodeId !== undefined) nodeId = req.nodeId;
    } catch (e) {
      try {
        const desc = await client.send('DOM.describeNode', { backendNodeId: loc.backendNodeId }, { sessionId, timeoutMs });
        if (desc && desc.node && desc.node.nodeId !== undefined) nodeId = desc.node.nodeId;
      } catch (e2) { /* 保留原 nodeId（下方会如实报错） */ }
    }
    if (nodeId === null || nodeId === undefined) throw new Error('元素缺少 DOM nodeId（DOM.requestNode 未返回）');
    const raw = await client.send('CSS.getMatchedStylesForNode', { nodeId }, { sessionId, timeoutMs });
    return Object.assign({ ok: true }, projectMatchedStyles(raw));
  } finally {
    if (cssEnabled) {
      try { await client.send('CSS.disable', {}, { sessionId, timeoutMs: 1000 }); } catch (e) { /* 尽力而为 */ }
    }
  }
}

/* ── 公开动作：a11y ── */

/**
 * 执行 a11y 感知（整树或定位子树）。
 * @param {object} client CdpClient
 * @param {string} sessionId
 * @param {object} opt normalizeA11yOptions 结果
 * @returns {Promise<object>} chromeuse-a11y/1 报告（target 由 CLI 填入）
 */
async function runA11y(client, sessionId, opt, context) {
  const t0 = Date.now();
  const ctx = context || {};
  const target = ctx.target || null;
  const targetId = target && target.id ? String(target.id) : null;
  const baselineDir = ctx.baselineDir;
  const report = {
    format: 'chromeuse-a11y/1',
    at: time.isoLocal(),
    target: null,
    query: opt.query ? Object.assign({ kind: opt.query.kind, value: opt.query.value, nth: opt.query.nth }, opt.query.match ? { match: opt.query.match } : {}) : null,
    depth: opt.depth,
    maxNodes: opt.maxNodes,
    timeoutMs: opt.timeoutMs,
    nodeCount: 0,
    rawNodeCount: 0,
    omitted: 0,
    ignoredCount: 0,
    truncated: false,
    timedOut: false,
    partial: false,
    degraded: false,
    depthMode: null,
    boundsFetched: 0,
    boundsSkipped: 0,
    element: null,
    stages: [],
    nodes: [],
    ok: false,
  };
  let loc = null;
  try {
    /* --cursor-token 续页：零 CDP，直接读基线视图（快照代际/视图哈希不符即拒绝） */
    if (opt.cursor && opt.cursorToken) return resumeCursorPage(opt, { target, baselineDir }, report);

    let fetched;
    if (opt.query) {
      const locBudget = Math.max(LOCATE_TIMEOUT_MIN_MS, Math.min(LOCATE_TIMEOUT_MAX_MS, opt.timeoutMs));
      loc = await locateElement(client, sessionId, opt.query, { timeoutMs: locBudget });
      if (!loc.ok) {
        Object.assign(report, {
          ok: false, error: loc.error || loc.reason || 'locate-failed', reason: loc.reason || null,
          candidates: loc.candidates || [], elapsedMs: Date.now() - t0,
        });
        return report;
      }
      report.element = loc.element;
      const remain = Math.max(1, (t0 + opt.timeoutMs) - Date.now());
      const stageStart = Date.now();
      fetched = await fetchPartialTree(client, sessionId, loc, remain);
      report.stages = [{
        label: 'partial', depth: opt.depth, timeoutMs: remain, elapsedMs: Date.now() - stageStart,
        ok: fetched.ok, timedOut: !!fetched.timedOut, error: fetched.error,
      }];
    } else {
      fetched = await fetchFullTree(client, sessionId, opt, t0 + opt.timeoutMs);
      report.stages = fetched.stageLog || [];
      report.depthMode = fetched.depthMode || null;
    }
    if (!fetched.ok) {
      Object.assign(report, {
        ok: false, timedOut: !!fetched.timedOut, error: fetched.error || 'fetch-failed',
        elapsedMs: Date.now() - t0,
      });
      return report;
    }
    const nodes = fetched.nodes || [];
    const built = buildAxRows(nodes, {
      depth: opt.depth, maxNodes: opt.maxNodes,
      startNodeId: fetched.startNodeId, forceRoot: fetched.startNodeId !== undefined,
    });
    let rows = built.rows;
    let omitted = built.omitted;
    let truncated = built.truncated;
    Object.assign(report, {
      ok: true,
      rawNodeCount: nodes.length,
      nodeCount: rows.length,
      omitted,
      ignoredCount: built.ignoredCount,
      truncated,
      timedOut: !!fetched.timedOut,
      partial: !!fetched.partial,
      degraded: !!(fetched.partial && fetched.error),
      nodes: rows,
    });
    if (fetched.error) report.error = fetched.error;

    /* --frames same-origin：主树已取到后逐帧取真 AX 并挂接（局部定位子树不适用，跳过并说明） */
    let frameResult = null;
    if (opt.frames === 'same-origin') {
      if (opt.query) {
        report.framesSkipped = 'partial-tree';
      } else if (!report.timedOut) {
        frameResult = await fetchFrameRows(client, sessionId, opt, t0 + opt.timeoutMs, nodes);
        report.frames = frameResult.frames.map((f) => ({
          frameId: f.frameId, parentFrameId: f.parentFrameId, name: f.name, url: f.url,
          path: f.path, depth: f.path.length, nodeCount: f.nodeCount,
          ownerBackendNodeId: f.ownerBid, attached: false,
          truncated: f.truncated === true, omitted: f.omitted || 0,
        }));
        report.frameErrors = frameResult.errors;
        if (frameResult.unsupported) {
          report.framesUnsupported = true;
          report.approximate = true;
        } else if (frameResult.frames.length) {
          const byId = new Map(frameResult.frames.map((f) => [f.frameId, f]));
          for (const f of frameResult.frames) {
            const parentRows = f.parentFrameId && f.parentFrameId !== frameResult.mainFrameId
              ? (byId.get(f.parentFrameId) || {}).rows
              : rows;
            f.attached = !!parentRows && parentRows.some((r) => r && r.backendDOMNodeId !== null
              && r.backendDOMNodeId !== undefined && Number(r.backendDOMNodeId) === Number(f.ownerBid));
          }
          rows = mergeFrameRows(rows, frameResult.frames, frameResult.mainFrameId);
          if (rows.length > opt.maxNodes) {
            omitted += rows.length - opt.maxNodes;
            rows = rows.slice(0, opt.maxNodes);
            truncated = true;
          }
          for (const entry of report.frames) {
            const f = byId.get(entry.frameId);
            entry.attached = !!(f && f.attached);
          }
          report.nodeCount = rows.length;
          report.omitted = omitted;
          report.truncated = truncated;
          report.nodes = rows;
        }
      } else {
        report.framesSkipped = 'partial-tree';
      }
    }

    /* DOM 索引：--exclude / --visible-only 共用一次 DOM.getDocument（含同进程 iframe contentDocument） */
    let domIndex = null;
    if (opt.exclude || opt.visibleOnly) {
      try {
        domIndex = await fetchDomIndex(client, sessionId, Math.max(1000, Math.min(5000, opt.timeoutMs)));
      } catch (e) {
        if (opt.exclude) {
          Object.assign(report, { ok: false, code: 'E_CDP', error: `--exclude 需要 DOM 树但获取失败：${e.message}`, elapsedMs: Date.now() - t0 });
          return report;
        }
        report.visibleOnly = { checked: 0, occluded: 0, offscreen: 0, skippedFrames: 0, errors: 1, error: e.message };
      }
    }
    if (opt.exclude && domIndex) {
      try {
        const ex = await applyExclude(client, sessionId, rows, opt.exclude, Math.max(1000, Math.min(5000, opt.timeoutMs)), domIndex);
        rows = ex.rows;
        report.exclude = ex.info;
        report.nodeCount = rows.length;
        report.nodes = rows;
      } catch (e) {
        Object.assign(report, { ok: false, code: 'E_USAGE', error: e.message, elapsedMs: Date.now() - t0 });
        return report;
      }
    }

    /* bounds 先于遮挡过滤（--visible-only 需要真实矩形）；超时/降级快照不取框（沿用旧语义） */
    if (report.timedOut || report.degraded) {
      report.boundsSkipped = rows.length;
    } else {
      try {
        const b = await applyBounds(client, sessionId, rows, { maxNodes: BOUNDS_MAX_NODES, timeoutMs: BOUNDS_CMD_TIMEOUT_MS });
        report.boundsFetched = b.fetched;
        report.boundsSkipped = b.skipped;
      } catch (e) {
        report.boundsError = e.message;
        report.boundsSkipped = rows.length;
      }
    }

    if (opt.visibleOnly && domIndex) {
      try {
        const vi = await applyVisibleOnly(client, sessionId, rows, Math.max(1000, Math.min(5000, opt.timeoutMs)), domIndex);
        rows = vi.rows;
        report.visibleOnly = vi.info;
        report.nodeCount = rows.length;
        report.nodes = rows;
      } catch (e) {
        report.visibleOnly = { checked: 0, occluded: 0, offscreen: 0, skippedFrames: 0, errors: 1, error: e.message };
      }
    }

    /* 快照代际/ID（--diff/--cursor/--out 需要；--find 也带 snapshotId 便于引用） */
    const needGeneration = !!(opt.diff || opt.cursor || opt.out);
    let generation = null;
    if (needGeneration) {
      if (frameResult && frameResult.mainFrame) {
        generation = { loaderId: frameResult.mainFrame.loaderId || null, url: frameResult.mainFrame.url || null };
      } else {
        try {
          const ft = await client.send('Page.getFrameTree', {}, { sessionId, timeoutMs: Math.max(1, Math.min(5000, opt.timeoutMs)) });
          const frame = (ft && ft.frameTree && ft.frameTree.frame) || {};
          generation = { loaderId: frame.loaderId || null, url: frame.url || null };
        } catch (e) { generation = null; }
      }
      report.generation = generation;
    }
    if (needGeneration || opt.find) report.snapshotId = snapshot.snapshotIdOf(targetId, generation, rows);

    /* --diff：读基线 → 身份键 diff → 视图（不可比回落全量 forcedFull） */
    let view = null;
    if (opt.diff) {
      if (!targetId) {
        Object.assign(report, { ok: false, code: 'E_NOT_FOUND', error: '--diff 需要 --target（基线按 targetId 存储）', elapsedMs: Date.now() - t0 });
        return report;
      }
      const baseline = snapshot.readBaseline(targetId, baselineDir);
      const d = snapshot.diffSnapshots(rows, baseline, {
        targetId, generation, optionsKey: snapshot.optionsKeyOf(opt),
        truncated, partial: report.partial,
      });
      report.diff = {
        baseSnapshotId: d.baseSnapshotId, forcedFull: d.forcedFull, forcedReason: d.forcedReason,
        degraded: d.degraded, degradedReasons: d.degradedReasons, stats: d.stats,
        changes: d.entries.map((e) => ({ index: e.index, change: e.change, matchedBy: e.matchedBy })),
      };
      report.nodes = d.entries.map((e) => e.row);
      view = { kind: 'diff', indexes: d.entries.map((e) => e.index), diff: report.diff };
    }

    /* --find：树内检索（与 --diff 组合时只搜 diff 视图行，上下文仍取全量行） */
    if (opt.find) {
      const allowed = opt.diff && report.diff && Array.isArray(report.diff.changes)
        ? report.diff.changes.map((c) => c.index) : null;
      const hits = snapshot.buildFindHits(rows, opt.find, {
        context: snapshot.FIND_CONTEXT_LINES, allowedIndexes: allowed,
      });
      report.find = {
        pattern: opt.find.raw, isRegex: opt.find.isRegex, flags: opt.find.flags,
        count: hits.length, total: rows.length, hits,
      };
      report.nodes = uniqueRows(hits.reduce((acc, h) => acc.concat([h.row], h.context.map((c) => c.row)), []));
      view = { kind: 'find', indexes: hits.map((h) => h.index), allowedIndexes: allowed, diff: report.diff || null };
    }

    /* --cursor：分页视图（find=命中条目 / diff=变化行 / rows=全量行） */
    if (opt.cursor) {
      const kind = view ? view.kind : 'rows';
      const viewIndexes = view && Array.isArray(view.indexes) ? view.indexes : rows.map((_, i) => i);
      const items = kind === 'find'
        ? (report.find && Array.isArray(report.find.hits) ? report.find.hits : [])
        : viewIndexes.map((i) => rows[i]).filter(Boolean);
      const page = snapshot.pageSlice(items, 0, opt.cursorSize);
      const viewHash = snapshot.cursorViewHash(opt);
      const nextToken = page.next === null ? null : snapshot.encodeCursorToken(report.snapshotId, page.next, viewHash);
      report.cursor = {
        offset: page.offset, size: page.size, total: page.total, next: page.next,
        nextToken, hasMore: page.next !== null, view: kind, snapshotId: report.snapshotId,
      };
      if (kind === 'find') {
        report.find.hits = page.items;
        report.find.count = items.length;
        report.nodes = uniqueRows(page.items.map((h) => h.row));
      } else {
        report.nodes = page.items;
      }
      if (!view) view = { kind: 'rows', indexes: viewIndexes, diff: null };
      view.indexes = viewIndexes;
      view.kind = kind;
    }

    /* 基线落盘（--diff/--cursor 一代快照；保存全量行 + 本次视图，供 token 续页零 CDP 读取） */
    if (targetId && (opt.diff || opt.cursor)) {
      const viewPayload = view || { kind: 'rows', indexes: rows.map((_, i) => i), diff: null };
      try {
        report.baselineFile = snapshot.writeBaseline(targetId, {
          snapshotId: report.snapshotId,
          target: { id: targetId, url: target && target.url ? String(target.url) : null, title: target && target.title ? String(target.title) : null },
          generation,
          optionsKey: snapshot.optionsKeyOf(opt),
          options: {
            depth: opt.depth, maxNodes: opt.maxNodes, exclude: opt.exclude, frames: opt.frames,
            visibleOnly: opt.visibleOnly, find: opt.find,
            query: report.query,
          },
          nodeCount: rows.length,
          rawNodeCount: report.rawNodeCount,
          omitted, ignoredCount: report.ignoredCount, truncated, partial: report.partial,
          depthMode: report.depthMode,
          rows,
          view: viewPayload,
        }, { dir: baselineDir });
      } catch (e) {
        report.baselineError = e.message;
      }
    }

    /* C11 N12 --mark-js：click 监听扫描与 AX 树 join，仅对「可交互但无 role/name」行加 [J]。
     * 放在基线落盘之后 / --out 之前：diff 与快照身份零影响，--out 文件与 stdout 视图都能看到标记；
     * 能力不可用（88 分叉/协议拒绝）→ report.markJs 明确降级，不改变 a11y 成败（不崩不静默）。 */
    if (opt.markJs) {
      const budget = Math.max(1000, Math.min(5000, opt.timeoutMs));
      const scan = await jsListeners.scanClickListeners(client, sessionId, { timeoutMs: budget });
      if (!scan.ok) {
        report.markJs = { ok: false, supported: false, code: scan.code, error: scan.error, scanned: 0, marked: 0 };
      } else {
        const applied = jsListeners.applyListenerMarks(rows, scan.listeners);
        report.markJs = { ok: true, supported: true, code: null, scanned: scan.listeners.length, marked: applied.marked, elapsedMs: scan.elapsedMs };
      }
    }

    /* --out：全量快照落盘；stdout 只回 {nodes,file,snapshotId}（节点数组不进 stdout） */
    if (opt.out) {
      try {
        const file = snapshot.writeSnapshotFile(opt.out, {
          snapshotId: report.snapshotId || null,
          target: { id: targetId, url: target && target.url ? String(target.url) : null, title: target && target.title ? String(target.title) : null },
          generation,
          options: {
            depth: opt.depth, maxNodes: opt.maxNodes, exclude: opt.exclude, frames: opt.frames,
            visibleOnly: opt.visibleOnly, find: opt.find, query: report.query,
          },
          nodeCount: rows.length,
          rawNodeCount: report.rawNodeCount,
          omitted, ignoredCount: report.ignoredCount, truncated, partial: report.partial,
          depthMode: report.depthMode,
          rows,
          view: view || { kind: 'rows', indexes: rows.map((_, i) => i), diff: null },
          diff: report.diff || null,
          find: report.find ? { pattern: report.find.pattern, isRegex: report.find.isRegex, flags: report.find.flags, count: report.find.count, hits: report.find.hits } : null,
        });
        report.out = { nodes: rows.length, file, snapshotId: report.snapshotId || null };
        report.nodes = [];
      } catch (e) {
        Object.assign(report, { ok: false, code: 'E_IO', error: `--out 写盘失败：${e.message}`, elapsedMs: Date.now() - t0 });
        return report;
      }
    }

    /* C6 --group：渲染层分组标记（@eN 由 CLI 层在 refs 物化后写入行对象；
     * 完整分组统计在 CLI 侧补 report.groupView，见 tools/cdp.js cmdA11y） */
    if (opt.group) report.group = true;

    report.elapsedMs = Date.now() - t0;
    return report;
  } catch (e) {
    Object.assign(report, { ok: false, error: e.message, elapsedMs: Date.now() - t0 });
    return report;
  } finally {
    if (loc && loc.objectId) await releaseObject(client, sessionId, loc.objectId);
  }
}

/* ── 公开动作：css ── */

/**
 * 执行 css 感知（computed 与/或 matched）。
 * @param {object} client CdpClient
 * @param {string} sessionId
 * @param {object} opt normalizeCssOptions 结果
 * @returns {Promise<object>} chromeuse-css/1 报告（target 由 CLI 填入）
 */
async function runCss(client, sessionId, opt) {
  const t0 = Date.now();
  const report = {
    format: 'chromeuse-css/1',
    at: time.isoLocal(),
    target: null,
    query: Object.assign({ kind: opt.query.kind, value: opt.query.value, nth: opt.query.nth }, opt.query.match ? { match: opt.query.match } : {}),
    element: null,
    computed: null,
    computedCount: 0,
    computedError: null,
    matched: null,
    matchedError: null,
    timeoutMs: opt.timeoutMs,
    elapsedMs: 0,
    ok: false,
  };
  let loc = null;
  try {
    loc = await locateElement(client, sessionId, opt.query, {
      timeoutMs: Math.max(LOCATE_TIMEOUT_MIN_MS, Math.min(LOCATE_TIMEOUT_MAX_MS, opt.timeoutMs)),
    });
    if (!loc.ok) {
      Object.assign(report, {
        ok: false, error: loc.error || loc.reason || 'locate-failed', reason: loc.reason || null,
        candidates: loc.candidates || [], elapsedMs: Date.now() - t0,
      });
      return report;
    }
    report.element = loc.element;
    if (opt.computed) {
      try {
        const r = await client.send('Runtime.evaluate', {
          expression: buildComputedExpr(loc.candidate), returnByValue: true, userGesture: false,
        }, { sessionId, timeoutMs: opt.timeoutMs });
        const value = r && r.result && r.result.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          report.computedError = 'computed style 返回空值（元素不可读或已移除）';
        } else {
          report.computed = value;
          report.computedCount = Object.keys(value).length;
        }
      } catch (e) {
        report.computedError = e.message;
      }
    }
    if (opt.matched) {
      try {
        report.matched = await fetchMatchedStyles(client, sessionId, loc, opt.timeoutMs);
      } catch (e) {
        report.matchedError = e.message;
      }
    }
    report.ok = !report.computedError && !report.matchedError;
    report.elapsedMs = Date.now() - t0;
    return report;
  } catch (e) {
    Object.assign(report, { ok: false, error: e.message, elapsedMs: Date.now() - t0 });
    return report;
  } finally {
    if (loc && loc.objectId) await releaseObject(client, sessionId, loc.objectId);
  }
}

module.exports = {
  // 常量
  DEFAULT_A11Y_DEPTH, DEFAULT_A11Y_TIMEOUT_MS, DEFAULT_A11Y_MAX_NODES, A11Y_SHALLOW_DEPTH,
  DEFAULT_CSS_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEPTH_MAX, MAX_NODES_MAX,
  BOUNDS_MAX_NODES, MAX_MATCHED_RULES, CLICKABLE_ROLES,
  DEFAULT_CURSOR_SIZE, MAX_CURSOR_SIZE, FRAME_FETCH_MIN_MS, FRAME_FETCH_MAX_MS, EXCLUDE_MAX_MATCHES,
  // 纯函数（selftest 直接消费）
  normalizeA11yOptions, normalizeCssOptions, planA11yStages,
  axText, axMap, maxDepthOf, hasDanglingChildren, buildAxRows, projectAxNode,
  compactText, formatBounds, formatA11yLine, formatA11yReport, formatFindPath, formatFindLines,
  cssPropertiesOf, projectMatchedStyles, formatCssReport,
  quadToRect, projectElement, chooseA11yCandidate,
  buildComputedExpr,
  // B6a：帧 / 降噪 / 游标（纯函数 + CDP 动作）
  flattenFrameTree, classifyFrameTreeResponse, mergeFrameRows,
  buildDomIndex, coveredByExcluded, isAncestorBid,
  fetchFrameRows, fetchDomIndex, applyExclude, applyVisibleOnly, viewportSize, resumeCursorPage,
  // C6：a11y 语义分组（纯函数；--group 渲染层，默认关）
  A11Y_LANDMARK_ROLES, A11Y_GROUP_FOLD_ROLES, parentIndexesOf, groupItemText, groupPathOf,
  buildA11yGroups, renderA11yGroupLines, formatA11yGroupHeader,
  // CDP 动作
  locateElement, sendFullTree, fetchFullTree, fetchPartialTree, applyBounds, fetchMatchedStyles,
  runA11y, runCss, releaseObject,
};
