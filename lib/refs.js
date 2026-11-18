'use strict';
/*
 * chromeuse lib/refs.js —— a11y 引用句柄 @eN：物化 / 三级定位链 / 失效契约（B5 N4，V202611030006）
 *
 * 定位：`tools/cdp.js a11y --ref`（产表）与 `click/type/hover --ref @eN`（消费）的唯一实现单源。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 现状每次操作都按 --text/--selector 全页重解析：多候选要 --nth 盲试、重页十几次往返、跨 iframe
 * 还要重新描述 frame 链。ref 表把「一次快照里看见的可交互节点」固化成稳定句柄：agent 看到 @e3
 * 就能直接点，不用把 cssPath 抄一遍（抄错=定位漂移）。
 *
 * ── 物化策略（v2 裁决案照抄 + 一处实现偏离）──────────────────────────────────
 * - 候选面：仅 clickable（AX 交互角色，见 perceive.CLICKABLE_ROLES）或 focusable、且已取得 rect
 *   （perceive.applyBounds 前 150 个有 backendDOMNodeId 的行）的节点；--max-refs 默认 50 上限。
 * - 结构：1× `DOM.getDocument({depth:-1, pierce:true})` 拿 DOM 树（含同进程 iframe 的 contentDocument），
 *   Node 侧按 parentId 链算 cssPath/container（算法对齐 locator.cssPathOf 语义：唯一 id 优先，
 *   否则 tag+首 class+同标签 :nth-of-type）。
 * - 页侧：**一次** `Runtime.evaluate` 批量核验全部候选（querySelectorAll 计数 / absRect / 可见性 /
 *   命中闸门 / name 源 / 身份标记），零逐节点往返。
 *   ⚠ 偏离 plan 字面「一次 Runtime.callFunctionOn」：改 Runtime.evaluate 是为了**零 objectId 句柄**
 *   （callFunctionOn 需要先 evaluate 拿 document objectId，还要 releaseObject，句柄泄漏面更大），
 *   往返同为 1、批量语义不变，实测证据见 tmpdata/b5/WORKLOG.md。
 *   原「逐节点 DOM.resolveNode + callFunctionOn」= 2N 往返（100 ref ≈ 200 次）已被本设计消除。
 *
 * ── 身份（不猜的根）──────────────────────────────────────────────────────────
 * - 物化时给每个 ref 元素打一个 **JS 层不可枚举扩展属性** `__cu_ref='eN'`
 *   （Object.defineProperty，可配置可写不可枚举）——不改 DOM 属性/结构/样式，不触发 MutationObserver
 *   与重排重绘，页面脚本 Object.keys/JSON.stringify 看不见；元素被替换即天然丢失。
 *   这是唯一一处「页面侧写」，与 locator pick 注入一次性监听同级，属受控例外（本文件头声明）。
 * - 消费时一级 cssPath 唯一命中 → 扩展属性必须仍等于本 ref：
 *   命中但标记丢失/是别的 ref = **元素已被替换**（重渲染）→ E_REF_STALE，绝不点同名新元素。
 * - 二级/三级（role+name / container 收窄）是**路径漂移**的 self-heal：元素还在但 cssPath 不再唯一
 *   或不再命中（多包一层 div、兄弟插入导致 nth-of-type 位移）。命中元素若仍带本 ref 标记 → verified；
 *   不带 → 走 name 重新识别（记 identity:'name'，有界、最多一次重解析、多候选不猜）。
 *
 * ── 三级定位链（顺序钉死，各跑一遍，整体有界）────────────────────────────────
 * ① framePath 内 cssPath（全树 @eN = 主文档；跨 frame ref 仅 --text/--selector partial 树可用）
 * ② role+name：AX role → DOM 选择器映射表（ROLE_DOM_SELECTORS，高频角色）+ name 三源
 *    （aria-label → alt → textContent，空白归一后精确相等）
 * ③ container 收窄：ref 记录的最近结构祖先 cssPath 内重跑 ②
 *
 * ── 失效契约（E_REF_STALE / E_AMBIGUOUS，码表已在 lib/errors.js ②）──────────
 * - 代际不一致：targetId 变 / 主帧 loaderId 变（导航、刷新）→ E_REF_STALE(reason:'navigation'|'target-changed')
 * - ref 不在表内（表被新快照覆盖 / 从未产表 / 序号越界）→ E_REF_STALE(reason:'not-in-table'|'no-table')
 * - 元素已 detached（一级 0 命中且二三级也找不到）→ E_REF_STALE(reason:'not-found')
 * - 一级唯一命中但身份标记不符 → E_REF_STALE(reason:'identity-mismatch')
 * - 任一级命中 >1 且无法唯一裁决 → E_AMBIGUOUS（不猜；附候选清单）
 * - 二三级命中但元素不可见/命中被挡/视口外（滚动一次后仍在外）→ E_LOCATE（元素存在，交互不成立）
 *
 * ── v1 边界（钉死，勿扩）────────────────────────────────────────────────────
 * - 全树 `a11y --ref` 的 @eN 只覆盖**主文档**（Accessibility.getFullAXTree 不并含子帧节点，B0 POC 已证）；
 *   同源 iframe 内元素用 `a11y --text/--selector --ref` 的 partial 树路径产 ref（带 framePath）。
 * - 跨域/OOPIF 不穿透（与 locator/perceive 同边界）。
 * - 表文件按 targetId 整表覆盖（一次快照=一代）；不做增量合并（旧 ref 一律随新快照作废）。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');
const { evaluate } = require('./cdp-core');
const { CONTAINER_STRUCT_SEL } = require('./target-resolver');

const REF_FORMAT = 'chromeuse-refs/1';
const DEFAULT_MAX_REFS = 50;
const MAX_REFS_MAX = 500;
const MAX_CONTAINER_ANCESTORS = 12;
const DEFAULT_TIMEOUT_MS = 10000;
const REF_MARK = '__cu_ref';

/* ── AX role → DOM 选择器映射表（高频角色；表外角色只能走一级 cssPath）──────
 * 与 locator.roleOf 的区别：roleOf 是「DOM → 角色」的粗糙反推（tag 三分类），拿来做
 * 「角色 → DOM」会把 <div role=button> / <input type=submit> 全漏掉，故本表独立维护（B5 裁决点）。
 * 选择器只用属性/标签，零 :has/:is，Chrome 88 亦可用。 */
const ROLE_DOM_SELECTORS = {
  button: 'button,input[type=submit],input[type=button],input[type=reset],input[type=image],[role=button]',
  link: 'a[href],[role=link]',
  textbox: 'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],textarea,[role=textbox]',
  searchbox: 'input[type=search],[role=searchbox]',
  checkbox: 'input[type=checkbox],[role=checkbox]',
  radio: 'input[type=radio],[role=radio]',
  switch: 'input[role=switch],[role=switch]',
  combobox: 'select,[role=combobox]',
  listbox: 'select[multiple],[role=listbox]',
  option: 'option,[role=option]',
  heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
  tab: '[role=tab]',
  tabpanel: '[role=tabpanel]',
  tablist: '[role=tablist]',
  menuitem: '[role=menuitem]',
  menuitemcheckbox: '[role=menuitemcheckbox]',
  menuitemradio: '[role=menuitemradio]',
  menu: '[role=menu]',
  treeitem: '[role=treeitem]',
  slider: 'input[type=range],[role=slider]',
  spinbutton: 'input[type=number],[role=spinbutton]',
  img: 'img[alt],[role=img]',
  dialog: 'dialog,[role=dialog]',
  gridcell: 'td,[role=gridcell]',
  cell: 'td,th,[role=cell]',
  row: 'tr,[role=row]',
  columnheader: 'th,[role=columnheader]',
  rowheader: 'th,[role=rowheader]',
  listitem: 'li,[role=listitem]',
  progressbar: 'progress,[role=progressbar]',
  separator: 'hr,[role=separator]',
  group: '[role=group]',
  region: '[role=region]',
};

/* CONTAINER_STRUCT_SEL 解析一次（tag 集 + role 集；与 locator ancestorsOf 的 container 口径同源） */
const CONTAINER_MATCH = (() => {
  const tags = new Set();
  const roles = new Set();
  for (const part of String(CONTAINER_STRUCT_SEL).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^\[role=([^\]]+)\]$/.exec(p);
    if (m) roles.add(m[1]);
    else tags.add(p.toUpperCase());
  }
  return { tags, roles };
})();

function roleSelectorFor(role) {
  const key = String(role || '').toLowerCase();
  return ROLE_DOM_SELECTORS[key] || null;
}

/* 非交互角色（即使 focusable 也不该成为 @eN 句柄：文档根/只读容器——点它等于盲点整页） */
const REF_EXCLUDE_ROLES = new Set(['RootWebArea', 'WebArea', 'document', 'Iframe', 'iframe']);

/* ── 纯函数：ref 记号 / 候选面 / 表路径 ─────────────────────────────────── */

/** `@e12` / `e12` / `12` → {n:12, ref:'e12', token:'@e12'}；非法抛错（CLI 归 E_USAGE） */
function normalizeRefToken(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('--ref 缺值（形如 @e12）');
  const s = value.trim();
  const m = /^@?e?(\d{1,6})$/i.exec(s);
  const raw = m ? m[1] : null;
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--ref 形态非法（须形如 @e12，e1 起）：${JSON.stringify(s)}`);
  return { n, ref: `e${n}`, token: `@e${n}` };
}

/** --max-refs 归一（1~500，默认 50）；布尔=缺值 */
function normalizeMaxRefs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_REFS;
  if (typeof value === 'boolean') throw new Error(`--max-refs 缺值（须为 1~${MAX_REFS_MAX} 的整数）`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REFS_MAX) {
    throw new Error(`--max-refs 非法（须为 1~${MAX_REFS_MAX} 的整数）：${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * 候选面（纯函数）：clickable|focusable ∧ 有 bounds ∧ 有 backendDOMNodeId，按行序取前 maxRefs；
 * 同一 backendDOMNodeId 去重（AX 可能因 ignored 展开重复投影同一元素）。
 */
function pickRefTargets(rows, opts) {
  const o = opts || {};
  const maxRefs = Number.isInteger(o.maxRefs) ? o.maxRefs : DEFAULT_MAX_REFS;
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row) continue;
    if (REF_EXCLUDE_ROLES.has(String(row.role || ''))) continue;
    if (row.clickable !== true && row.focusable !== true) continue;
    if (row.bounds === null || row.bounds === undefined) continue;
    if (row.backendDOMNodeId === null || row.backendDOMNodeId === undefined) continue;
    const key = String(row.backendDOMNodeId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= maxRefs) break;
  }
  return out;
}

/** 行序编号 @e1..@eN（纯函数，就地写 row.ref；返回同一数组） */
function assignRefNumbers(rows) {
  (rows || []).forEach((row, i) => { row.ref = `e${i + 1}`; row.refN = i + 1; });
  return rows;
}

/** 表文件路径（paths.REFS_DIR 单源；targetId 只保留安全字符，防路径注入）。
 *  dir 是**测试接缝**（selftest 用 mkdtemp 隔离写盘，不污染 tmpdata/refs；生产调用一律省略）。 */
function refTablePath(targetId, dir) {
  const safe = String(targetId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir || paths.REFS_DIR, `${safe || 'unknown'}.json`);
}

/* ── DOM 树索引（Node 侧；DOM.getDocument 结果 → backendNodeId 图）────────── */

function attrsOfNode(node) {
  const map = {};
  const list = Array.isArray(node && node.attributes) ? node.attributes : [];
  for (let i = 0; i + 1 < list.length; i += 2) map[String(list[i])] = String(list[i + 1]);
  return map;
}

function isElementEntry(entry) {
  return !!entry && entry.nodeType === 1;
}

/**
 * DOM 树 → 索引（纯函数）：
 *   {byBackend: Map<number, entry>, docIds: Map<backendNodeId, Set<idString>>}
 * entry = {backendNodeId, nodeId, nodeType, nodeName, attrs, parent, docRoot}
 * contentDocument（pierce:true 才有）作为新的「文档根」挂进同一棵树，parent=iframe 元素。
 */
function indexDomTree(root) {
  const byBackend = new Map();
  const idCounts = new Map(); // 文档根 backendNodeId → Map<id, count>
  const docOf = new Map();    // 节点 backendNodeId → 文档根 backendNodeId
  const walk = (node, parent, docRootId) => {
    if (!node || typeof node !== 'object') return;
    const hasBid = node.backendNodeId !== undefined && node.backendNodeId !== null;
    const bid = hasBid ? Number(node.backendNodeId) : null;
    const isDoc = node.nodeType === 9 || node.nodeName === '#document';
    const rootId = isDoc ? bid : docRootId;
    const attrs = node.nodeType === 1 ? attrsOfNode(node) : {};
    const entry = bid === null ? null : {
      backendNodeId: bid,
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      nodeName: String(node.nodeName || ''),
      attrs,
      parent: parent || null,
      children: [],
      docRoot: rootId === undefined ? null : rootId,
    };
    if (entry) {
      byBackend.set(bid, entry);
      if (rootId !== null && rootId !== undefined) {
        docOf.set(bid, rootId);
        if (!idCounts.has(rootId)) idCounts.set(rootId, new Map());
      }
      const idVal = String(attrs.id || '');
      if (idVal) {
        const m = idCounts.get(rootId);
        if (m) m.set(idVal, (m.get(idVal) || 0) + 1);
      }
      if (parent && Array.isArray(parent.children)) parent.children.push(bid);
    }
    const self = entry || parent;
    for (const child of (Array.isArray(node.children) ? node.children : [])) walk(child, self, rootId);
    if (node.contentDocument) walk(node.contentDocument, self, null);
    if (Array.isArray(node.shadowRoots)) for (const sr of node.shadowRoots) walk(sr, self, rootId);
  };
  walk(root, null, null);
  return { byBackend, idCounts, docOf };
}

/** CSS.escape 的 Node 侧等价（够用即可：非 [\w-] 一律反斜杠转义；首字符数字转义成 \3N ） */
function escapeCssIdent(s) {
  const v = String(s);
  if (!v) return v;
  let out = v.replace(/([^\w-])/g, '\\$1');
  if (/^[0-9]/.test(out)) out = '\\3' + out[0] + ' ' + out.slice(1);
  return out;
}

function uniqueIdSelector(index, entry) {
  const id = entry && entry.attrs ? String(entry.attrs.id || '') : '';
  if (!id) return '';
  const docId = index.docOf.get(entry.backendNodeId);
  const counts = index.idCounts.get(docId);
  if (!counts || counts.get(id) !== 1) return '';
  return '#' + escapeCssIdent(id);
}

function sameTagSiblings(index, entry) {
  const parent = entry && entry.parent;
  if (!parent) return { sameTag: 1, idx: 1 };
  let sameTag = 0;
  let idx = 0;
  for (const bid of (parent.children || [])) {
    const e = index.byBackend.get(bid);
    if (!e || e.nodeName !== entry.nodeName) continue;
    sameTag++;
    if (bid === entry.backendNodeId) idx = sameTag;
  }
  return { sameTag: sameTag || 1, idx: idx || 1 };
}

/**
 * backendNodeId → 文档内唯一 CSS 路径（纯函数；语义对齐 locator.cssPathOf）。
 * 返回 '' 表示无法生成（非元素/无 tag）。路径**必须**经页侧 querySelectorAll 复核 count===1 才入表
 * （见 materializeRefs：结构树与页面实时 DOM 可能有 shadow/动态差异）。
 */
function cssPathOfEntry(index, backendNodeId) {
  let entry = index.byBackend.get(Number(backendNodeId));
  if (!isElementEntry(entry)) return '';
  const parts = [];
  for (let depth = 0; entry && isElementEntry(entry) && depth < 64; depth++) {
    const tag = String(entry.nodeName || '').toLowerCase();
    if (!tag) break;
    const idSel = uniqueIdSelector(index, entry);
    if (idSel) { parts.unshift(idSel); break; }
    let seg = tag;
    const cls = String((entry.attrs && entry.attrs.class) || '').trim().split(/\s+/)[0] || '';
    if (cls && !/^[0-9]/.test(cls)) seg += '.' + escapeCssIdent(cls);
    const sib = sameTagSiblings(index, entry);
    if (sib.sameTag > 1) seg += `:nth-of-type(${sib.idx})`;
    parts.unshift(seg);
    if (tag === 'html') break;
    entry = entry.parent;
  }
  return parts.join(' > ');
}

function entryMatchesContainer(entry) {
  if (!isElementEntry(entry)) return false;
  if (CONTAINER_MATCH.tags.has(String(entry.nodeName || '').toUpperCase())) return true;
  const role = String((entry.attrs && entry.attrs.role) || '');
  return !!role && CONTAINER_MATCH.roles.has(role);
}

/** 最近结构祖先（≤12 层，不含自身——ref 元素本身通常已是交互控件） */
function containerEntryOf(index, backendNodeId) {
  let entry = index.byBackend.get(Number(backendNodeId));
  if (!entry) return null;
  let p = entry.parent;
  for (let i = 0; i < MAX_CONTAINER_ANCESTORS && p; i++) {
    if (isElementEntry(p) && entryMatchesContainer(p)) return p;
    p = p.parent;
  }
  return null;
}

/* ── 页面侧注入源（函数 toString 注入；只用参数，禁闭包）───────────────── */

function pgNorm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function pgFrameDoc(labels) {
  var doc = document;
  var chain = labels || [];
  for (var i = 0; i < chain.length; i++) {
    var frames = [];
    try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return null; }
    var next = null;
    for (var j = 0; j < frames.length; j++) {
      var f = frames[j];
      var lb = f.name || f.id || String(f.tagName || 'iframe').toLowerCase();
      if (lb === chain[i]) { next = f; break; }
    }
    if (!next) return null;
    var inner = null;
    try { inner = next.contentDocument; } catch (e) { return null; }
    if (!inner) return null;
    doc = inner;
  }
  return doc;
}

function pgRect(el) {
  var r = el.getBoundingClientRect();
  var local = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  var x = r.left, y = r.top, doc = el.ownerDocument;
  while (doc && doc.defaultView && doc.defaultView.frameElement) {
    var fe = doc.defaultView.frameElement;
    var fr = fe.getBoundingClientRect();
    x += fr.left; y += fr.top;
    doc = fe.ownerDocument;
  }
  return { local: local, abs: { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) } };
}

function pgVisible(el, local) {
  var ok = !!(local && local.w >= 1 && local.h >= 1);
  var st = null;
  try { st = el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return { visible: false, reason: 'style-unreadable' }; }
  if (!ok) return { visible: false, reason: 'zero-rect' };
  if (st.visibility === 'hidden' || st.display === 'none') return { visible: false, reason: 'css-hidden' };
  try {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
      return { visible: false, reason: 'check-visibility' };
    }
  } catch (e) { /* 老 Chrome 无 checkVisibility，退化为下面经典判据 */ }
  if (el.offsetParent === null && st.position !== 'fixed') {
    var p = el.parentElement, hidden = false;
    for (var i = 0; i < 12 && p; i++) {
      try {
        var ps = p.ownerDocument.defaultView.getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden') { hidden = true; break; }
      } catch (e) { break; }
      p = p.parentElement;
    }
    if (hidden) return { visible: false, reason: 'ancestor-hidden' };
  }
  return { visible: true, reason: null };
}

function pgHitOk(el, doc, local) {
  if (!local || local.w < 1 || local.h < 1) return false;
  var hit = null;
  try { hit = doc.elementFromPoint(local.x + local.w / 2, local.y + local.h / 2); } catch (e) { return false; }
  return !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
}

function pgName(el) {
  var a = null, alt = null;
  try { a = el.getAttribute('aria-label'); } catch (e) { /* noop */ }
  if (a != null && pgNorm(a)) return { name: pgNorm(a), source: 'aria-label' };
  try { alt = el.getAttribute('alt'); } catch (e) { /* noop */ }
  if (alt != null && pgNorm(alt)) return { name: pgNorm(alt), source: 'alt' };
  return { name: pgNorm(el.textContent), source: 'textContent' };
}

function pageHelperSrc() {
  return [pgNorm, pgFrameDoc, pgRect, pgVisible, pgHitOk, pgName].map((f) => f.toString()).join('\n');
}

/* ── 页面侧表达式（纯字符串构造；selftest 直接断言）─────────────────────── */

const PAYLOAD_START = '/*CU-REFS-PAYLOAD*/';
const PAYLOAD_END = '/*CU-REFS-END*/';
const RESOLVE_START = '/*CU-REF-PAYLOAD*/';
const RESOLVE_END = '/*CU-REF-END*/';

/**
 * 物化批量表达式：一次 evaluate 核验全部候选（querySelectorAll 计数 / 矩形 / 可见 / 命中 / name 源 / 身份标记）。
 * @param {{refs:Array<{ref:string,cssPath:string|null,framePath:string[]}>}} payload
 */
function buildMaterializeExpr(payload) {
  return `(function(){ ${PAYLOAD_START}var P=${JSON.stringify(payload || { refs: [] })};${PAYLOAD_END}
${pageHelperSrc()}
  var out = [];
  for (var i = 0; i < P.refs.length; i++) {
    var it = P.refs[i];
    var res = { ref: it.ref, cssPath: it.cssPath || null, count: 0, ok: false };
    var doc = pgFrameDoc(it.framePath || []);
    if (!doc) { res.reason = 'frame-missing'; out.push(res); continue; }
    var list = [];
    if (it.cssPath) { try { list = doc.querySelectorAll(it.cssPath); } catch (e) { res.error = String(e && e.message || e); } }
    res.count = list.length;
    if (list.length === 1) {
      var el = list[0];
      var rr = pgRect(el);
      var vi = pgVisible(el, rr.local);
      res.ok = true;
      res.connected = !!el.isConnected;
      res.localRect = rr.local;
      res.rect = rr.abs;
      res.visible = vi.visible;
      res.visibleReason = vi.reason || null;
      res.hitOk = pgHitOk(el, doc, rr.local);
      res.nameSource = pgName(el).source;
      res.nameNow = pgName(el).name.slice(0, 200);
      res.text = pgNorm(el.textContent).slice(0, 120);
      try {
        Object.defineProperty(el, '${REF_MARK}', { value: it.ref, configurable: true, writable: true, enumerable: false });
        res.marked = true;
      } catch (e) { res.marked = false; }
    } else {
      res.reason = list.length ? 'multi' : 'zero';
    }
    out.push(res);
  }
  return { ok: true, href: String(location.href), refs: out };
})()`;
}

/**
 * 解析表达式（三级定位链一次跑完；scroll=true 时命中后按需 scrollIntoView 并回报新矩形）。
 * @param {object} rec ref 记录（见 materializeRefs 产物）
 * @param {{scroll?:boolean}} [opts]
 */
function buildResolveExpr(rec, opts) {
  const r = rec || {};
  const payload = {
    ref: r.ref,
    cssPath: r.cssPath || null,
    framePath: Array.isArray(r.framePath) ? r.framePath : [],
    role: r.role || '',
    name: r.name || '',
    roleSelector: roleSelectorFor(r.role),
    containerCss: r.container || null,
    identitySet: r.identitySet !== false,
    scroll: !!(opts && opts.scroll),
  };
  return `(function(){ ${RESOLVE_START}var R=${JSON.stringify(payload)};${RESOLVE_END}
${pageHelperSrc()}
  var doc = pgFrameDoc(R.framePath || []);
  if (!doc) return { ok: false, reason: 'frame-missing' };
  var view = { width: window.innerWidth, height: window.innerHeight };
  function inView(pt) { return !!pt && pt.x >= 0 && pt.y >= 0 && pt.x < view.width && pt.y < view.height; }
  function identity(el) {
    try { if (el['${REF_MARK}'] === R.ref) return 'expando'; return el['${REF_MARK}'] ? 'other-ref' : 'none'; } catch (e) { return 'none'; }
  }
  function summarize(el, level) {
    var rr = pgRect(el);
    var vi = pgVisible(el, rr.local);
    return { level: level, tag: String(el.tagName || '').toLowerCase(), text: pgNorm(el.textContent).slice(0, 120),
      rect: rr.abs, localRect: rr.local, visible: vi.visible, visibleReason: vi.reason || null,
      hitOk: pgHitOk(el, doc, rr.local), identity: identity(el) };
  }
  function choose(list) {
    var vis = [];
    for (var i = 0; i < list.length; i++) { var s = summarize(list[i], 'probe'); if (s.visible) vis.push({ el: list[i], sum: s }); }
    if (vis.length === 1) return { pick: vis[0] };
    if (vis.length > 1) return { reason: 'ambiguous', count: vis.length, candidates: vis.slice(0, 8).map(function (x) { return x.sum; }) };
    if (list.length === 1) return { pick: { el: list[0], sum: summarize(list[0], 'probe') } };
    if (list.length === 0) return { reason: 'none', count: 0 };
    return { reason: 'ambiguous', count: list.length, candidates: list.slice(0, 8).map(function (el) { return summarize(el, 'probe'); }) };
  }
  function finish(el, sum, level) {
    sum.level = level;
    var point = { x: sum.rect.x + Math.round(sum.rect.w / 2), y: sum.rect.y + Math.round(sum.rect.h / 2) };
    var scrolled = false;
    if (R.scroll && !inView(point)) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* noop */ }
      var rr = pgRect(el);
      var vi = pgVisible(el, rr.local);
      sum.localRect = rr.local; sum.rect = rr.abs; sum.visible = vi.visible; sum.visibleReason = vi.reason || null;
      sum.hitOk = pgHitOk(el, doc, rr.local);
      point = { x: sum.rect.x + Math.round(sum.rect.w / 2), y: sum.rect.y + Math.round(sum.rect.h / 2) };
      scrolled = true;
    }
    return { ok: true, level: level, verified: sum.identity === 'expando', ref: sum, point: point, scrolled: scrolled, view: view, href: String(location.href) };
  }
  /* ① cssPath（主路径：唯一命中且身份标记相符）*/
  var l1 = [];
  if (R.cssPath) { try { l1 = doc.querySelectorAll(R.cssPath); } catch (e) { l1 = []; } }
  if (l1.length === 1) {
    var s1 = summarize(l1[0], 'cssPath');
    if (!R.identitySet || s1.identity === 'expando') return finish(l1[0], s1, 'cssPath');
    return { ok: false, reason: 'identity-mismatch', level: 'cssPath', count: 1, candidates: [s1], identity: s1.identity, view: view, href: String(location.href) };
  }
  if (l1.length > 1) {
    var multi1 = [];
    for (var i1 = 0; i1 < l1.length && i1 < 8; i1++) multi1.push(summarize(l1[i1], 'cssPath'));
    return { ok: false, reason: 'ambiguous', level: 'cssPath', count: l1.length, candidates: multi1, view: view, href: String(location.href) };
  }
  /* ② role+name（name 为空则跳过：空名会匹配全部无名元素 = 猜）*/
  var sel = R.roleSelector;
  var l2 = [];
  if (sel && R.name) {
    try {
      var all2 = doc.querySelectorAll(sel);
      for (var i2 = 0; i2 < all2.length; i2++) if (pgName(all2[i2]).name === R.name) l2.push(all2[i2]);
    } catch (e) { l2 = []; }
  }
  var c2 = choose(l2);
  if (c2.pick) return finish(c2.pick.el, c2.pick.sum, 'role-name');
  /* ③ container 收窄 */
  var scope = null;
  if (R.containerCss) { try { scope = doc.querySelector(R.containerCss); } catch (e) { scope = null; } }
  if (scope && sel && R.name) {
    var l3 = [];
    try {
      var all3 = scope.querySelectorAll(sel);
      for (var i3 = 0; i3 < all3.length; i3++) if (pgName(all3[i3]).name === R.name) l3.push(all3[i3]);
    } catch (e) { l3 = []; }
    var c3 = choose(l3);
    if (c3.pick) return finish(c3.pick.el, c3.pick.sum, 'container');
    if (c3.reason === 'ambiguous') return { ok: false, reason: 'ambiguous', level: 'container', count: c3.count, candidates: c3.candidates, view: view, href: String(location.href) };
  }
  if (c2.reason === 'ambiguous') return { ok: false, reason: 'ambiguous', level: 'role-name', count: c2.count, candidates: c2.candidates, view: view, href: String(location.href) };
  return { ok: false, reason: 'not-found', level: 'role-name', role: R.role, name: R.name, count: 0, view: view, href: String(location.href) };
})()`;
}

/* ── 表读写 ─────────────────────────────────────────────────────────────── */

function writeRefTable(targetId, table, opts) {
  const dir = (opts && opts.dir) || paths.REFS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = refTablePath(targetId, dir);
  const body = {
    format: REF_FORMAT,
    at: time.isoLocal(),
    target: table.target || null,
    generation: table.generation || null,
    maxRefs: table.maxRefs,
    query: table.query || null,
    stats: table.stats || null,
    refs: table.refs || [],
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return file;
}

function readRefTable(targetId, dir) {
  const file = refTablePath(targetId, dir);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  try {
    const t = JSON.parse(raw);
    if (!t || t.format !== REF_FORMAT || !Array.isArray(t.refs)) return null;
    t.file = file;
    return t;
  } catch (e) { return null; }
}

/* ── CDP 动作 ───────────────────────────────────────────────────────────── */

/** 快照代际：目标页 + 主帧 loaderId（导航/刷新即变；同文档导航不变） */
async function captureGeneration(client, sessionId, timeoutMs) {
  const ft = await client.send('Page.getFrameTree', {}, { sessionId, timeoutMs: timeoutMs || 5000 });
  const frame = (ft && ft.frameTree && ft.frameTree.frame) || {};
  return { loaderId: frame.loaderId || null, url: frame.url || null };
}

/**
 * 物化 ref 表（a11y --ref 调用；一次快照=一代，整表覆盖）。
 * @param {object} client CdpClient
 * @param {string} sessionId
 * @param {object[]} rows a11y 报告行（已带 bounds/backendDOMNodeId）
 * @param {object} opts {target:{id,url,title}, framePath:[], maxRefs, timeoutMs, withLocator, query}
 * @returns {Promise<{ok:boolean,refs:object[],tablePath?:string,error?:string,note?:string,stats?:object}>}
 */
async function materializeRefs(client, sessionId, rows, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRefs = Number.isInteger(o.maxRefs) ? o.maxRefs : DEFAULT_MAX_REFS;
  const target = o.target || {};
  const framePath = Array.isArray(o.framePath) ? o.framePath.slice() : [];
  const picked = assignRefNumbers(pickRefTargets(rows, { maxRefs }));
  if (!picked.length) {
    return { ok: true, refs: [], note: '无可引用节点（需 clickable/focusable 且已取得 rect 的前 150 行）', stats: { candidates: 0 } };
  }

  /* ① 一次 DOM 树（含同进程 iframe contentDocument；失败时降级为「只有 role+name」） */
  let index = null;
  let domError = null;
  try {
    const dom = await client.send('DOM.getDocument', { depth: -1, pierce: true }, { sessionId, timeoutMs });
    index = indexDomTree(dom && dom.root);
  } catch (e) {
    domError = e.message;
  }

  /* 代际（导航/刷新失效判据的基线）：调用方未注入时自取主帧 loaderId */
  let generation = o.generation || null;
  if (!generation) {
    try { generation = await captureGeneration(client, sessionId, Math.min(timeoutMs, 5000)); } catch (e) { generation = null; }
  }

  const refs = picked.map((row, i) => {
    const cssPath = index ? cssPathOfEntry(index, row.backendDOMNodeId) : '';
    const containerEntry = index ? containerEntryOf(index, row.backendDOMNodeId) : null;
    const container = containerEntry ? cssPathOfEntry(index, containerEntry.backendNodeId) : '';
    return {
      ref: row.ref,
      n: i + 1,
      role: row.role || '',
      name: String(row.name || '').slice(0, 200),
      backendNodeId: row.backendDOMNodeId,
      cssPath: cssPath || null,
      container: container || null,
      framePath: framePath.slice(),
      rect: row.bounds || null,
      identitySet: false,
      visible: null,
      hitOk: null,
      marked: false,
      nameSource: null,
    };
  });

  /* ② 一次页侧批量核验（count/rect/visible/hitOk/mark） */
  let batch = null;
  let batchError = null;
  try {
    batch = await evaluate(client, sessionId, buildMaterializeExpr({
      refs: refs.map((r) => ({ ref: r.ref, cssPath: r.cssPath, framePath: r.framePath })),
    }), timeoutMs);
  } catch (e) {
    batchError = e.message;
  }
  if (batch && Array.isArray(batch.refs)) {
    const byRef = new Map(batch.refs.map((b) => [String(b.ref), b]));
    for (const rec of refs) {
      const b = byRef.get(rec.ref);
      if (!b) continue;
      rec.nameSource = b.nameSource || null;
      rec.marked = b.marked === true;
      rec.identitySet = b.marked === true;
      if (b.ok === true) {
        rec.rect = b.rect || rec.rect;
        rec.localRect = b.localRect || null;
        rec.visible = b.visible === true;
        rec.visibleReason = b.visibleReason || null;
        rec.hitOk = b.hitOk === true;
        rec.connected = b.connected === true;
        rec.tag = b.tag || null;
        if (b.text) rec.text = b.text;
      } else {
        /* 路径在实时 DOM 里不唯一/不命中 → 不写进表（诚实降级：靠二级 role+name） */
        rec.cssPathDropped = b.reason || 'unverified';
        rec.cssPath = null;
      }
    }
  }

  /* --locator：可持久化定位器（供 flow 固化；等价 Playwright generate-locator 的语义三元组） */
  if (o.withLocator) {
    for (const rec of refs) {
      rec.locator = {
        kind: 'role-name',
        role: rec.role || null,
        name: rec.name || null,
        cssPath: rec.cssPath,
        container: rec.container,
        frame: ['main'].concat(rec.framePath || []),
        backendNodeId: rec.backendNodeId,
      };
    }
  }

  const stats = {
    candidates: picked.length,
    verified: refs.filter((r) => r.cssPath).length,
    cssPathDropped: refs.filter((r) => !r.cssPath).length,
    marked: refs.filter((r) => r.identitySet).length,
    domError: domError || null,
    batchError: batchError || null,
  };

  const table = {
    target: { id: target.id || null, url: target.url || null, title: target.title || null },
    generation,
    maxRefs,
    query: o.query || null,
    refs,
    stats,
  };
  const tablePath = writeRefTable(target.id, table, { dir: o.dir });
  return { ok: true, refs, tablePath, stats, table };
}

/** 失败结果构造（统一形状，CLI 按 code 落信封） */
function refFail(code, reason, extra) {
  return Object.assign({ ok: false, code, reason }, extra || {});
}

/**
 * 解析并核验 @eN（消费端唯一入口）。
 * @param {object} client
 * @param {string} sessionId
 * @param {object} target resolveTarget 的 target（id/url/title）
 * @param {{ref:string,token:string,n:number}} token normalizeRefToken 产物
 * @param {object} [opts] {timeoutMs}
 * @returns {Promise<{ok:boolean,code?:string,reason?:string,ref?:object,point?:object,scrolled?:boolean,level?:string,verified?:boolean,candidates?:object[],tablePath?:string}>}
 */
async function resolveRef(client, sessionId, target, token, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const tablePath = refTablePath(target && target.id, o.dir);
  const table = readRefTable(target && target.id, o.dir);
  if (!table) {
    return refFail('E_REF_STALE', 'no-table', {
      tablePath,
      message: `引用表不存在（${tablePath}）——先执行 a11y --ref 生成引用`,
    });
  }
  if (String((table.target && table.target.id) || '') !== String((target && target.id) || '')) {
    return refFail('E_REF_STALE', 'target-changed', { tablePath, message: '引用表属于另一个 target' });
  }
  /* 代际闸门：loaderId 变=导航/刷新（同文档导航不变）。读不到代际时保守放行到身份检查。 */
  let gen = null;
  try { gen = await captureGeneration(client, sessionId, Math.min(timeoutMs, 5000)); } catch (e) { gen = null; }
  const before = table.generation || {};
  if (gen && before.loaderId && gen.loaderId && String(gen.loaderId) !== String(before.loaderId)) {
    return refFail('E_REF_STALE', 'navigation', {
      tablePath,
      message: `页面已导航/刷新（loaderId ${String(before.loaderId).slice(0, 8)} → ${String(gen.loaderId).slice(0, 8)}）`,
      generation: { before: { loaderId: before.loaderId, url: before.url }, now: gen },
    });
  }
  const rec = (table.refs || []).find((r) => r.ref === token.ref);
  if (!rec) {
    return refFail('E_REF_STALE', 'not-in-table', {
      tablePath,
      message: `引用 ${token.token} 不在当前引用表（表内共 ${(table.refs || []).length} 个 ref，快照已刷新？）`,
    });
  }
  let ev = null;
  try {
    ev = await evaluate(client, sessionId, buildResolveExpr(rec, { scroll: false }), timeoutMs);
  } catch (e) {
    return refFail('E_LOCATE', 'evaluate-failed', { tablePath, message: `引用解析失败：${e.message}`, ref: rec });
  }
  /* 视口外：一次 scrollIntoView 后重解析（重解析有界=最多一次，不循环不猜） */
  if (ev && ev.ok === true && ev.point && ev.view && !(ev.point.x >= 0 && ev.point.y >= 0 && ev.point.x < ev.view.width && ev.point.y < ev.view.height)) {
    try {
      ev = await evaluate(client, sessionId, buildResolveExpr(rec, { scroll: true }), timeoutMs);
    } catch (e) {
      return refFail('E_LOCATE', 'evaluate-failed', { tablePath, message: `引用解析失败（滚动重试）：${e.message}`, ref: rec });
    }
  }
  if (!ev || typeof ev !== 'object') {
    return refFail('E_LOCATE', 'bad-result', { tablePath, message: '引用解析返回为空', ref: rec });
  }
  if (ev.ok === true) {
    const point = ev.point;
    const inView = !!(ev.view && point && point.x >= 0 && point.y >= 0 && point.x < ev.view.width && point.y < ev.view.height);
    if (!inView) {
      return refFail('E_LOCATE', 'out-of-viewport', {
        tablePath, level: ev.level, ref: ev.ref, point, viewport: ev.view,
        message: `引用 ${token.token} 命中元素中心点 (${point && point.x},${point && point.y}) 在顶层视口外（已 scrollIntoView 一次）`,
      });
    }
    if (ev.ref && ev.ref.visible === false) {
      return refFail('E_LOCATE', ev.ref.visibleReason || 'not-visible', {
        tablePath, level: ev.level, ref: ev.ref, point, viewport: ev.view,
        message: `引用 ${token.token} 命中元素不可见（${ev.ref.visibleReason || 'visibility'}）`,
      });
    }
    /* candidate 形状对齐 locator 候选（供 R1 --expect-* 主体判定 / 文本排版复用） */
    const hit = ev.ref || {};
    const candidate = {
      tag: hit.tag || null,
      text: hit.text || '',
      rect: hit.rect || null,
      visible: hit.visible === true,
      hitOk: hit.hitOk === true,
      cssPath: rec.cssPath || null,
      framePath: Array.isArray(rec.framePath) ? rec.framePath.slice() : [],
      frame: ['main'].concat(Array.isArray(rec.framePath) ? rec.framePath : []).join('>'),
    };
    return {
      ok: true, ref: ev.ref, candidate, cssPath: rec.cssPath || null, point, scrolled: ev.scrolled === true,
      level: ev.level, verified: ev.verified === true, tablePath, view: ev.view,
    };
  }
  const stales = new Set(['identity-mismatch', 'not-found', 'frame-missing']);
  const code = ev.reason === 'ambiguous' ? 'E_AMBIGUOUS' : (stales.has(ev.reason) ? 'E_REF_STALE' : 'E_LOCATE');
  return refFail(code, ev.reason || 'resolve-failed', {
    tablePath, level: ev.level || null, count: ev.count || 0, candidates: ev.candidates || [], ref: rec,
    message: refReasonText(token.token, ev, rec),
  });
}

function refReasonText(tokenText, ev, rec) {
  const t = tokenText || '@e?';
  const what = rec ? `${rec.role || '?'}${rec.name ? ` "${String(rec.name).slice(0, 40)}"` : ''}` : '元素';
  if (ev.reason === 'identity-mismatch') return `引用 ${t}（${what}）的 CSS 路径仍唯一，但元素已被替换（身份标记不符）——按失效契约不点新元素，重新 a11y --ref`;
  if (ev.reason === 'navigation') return `引用 ${t} 已失效：页面已导航/刷新`;
  if (ev.reason === 'not-found') return `引用 ${t}（${what}）三级定位链全部落空（元素已移除/detached）——重新 a11y --ref`;
  if (ev.reason === 'frame-missing') return `引用 ${t} 的 frame 链已不存在（iframe 被移除/跨域化）——重新 a11y --ref`;
  if (ev.reason === 'ambiguous') return `引用 ${t}（${what}）在 ${ev.level || '定位链'} 命中 ${ev.count} 个候选——不猜，重新 a11y --ref 或改用 --selector/--nth`;
  if (ev.reason === 'not-in-table') return `引用 ${t} 不在当前引用表——先执行 a11y --ref`;
  if (ev.reason === 'no-table') return `引用表不存在——先执行 a11y --ref`;
  return `引用 ${t} 解析失败（${ev.reason || 'unknown'}）`;
}

module.exports = {
  // 常量 / 映射表
  REF_FORMAT, DEFAULT_MAX_REFS, MAX_REFS_MAX, MAX_CONTAINER_ANCESTORS, REF_MARK,
  ROLE_DOM_SELECTORS, CONTAINER_MATCH, REF_EXCLUDE_ROLES,
  // 纯函数（selftest 直接消费）
  roleSelectorFor, normalizeRefToken, normalizeMaxRefs, pickRefTargets, assignRefNumbers,
  refTablePath, attrsOfNode, indexDomTree, escapeCssIdent, uniqueIdSelector, sameTagSiblings,
  cssPathOfEntry, entryMatchesContainer, containerEntryOf,
  buildMaterializeExpr, buildResolveExpr,
  // 表 IO
  writeRefTable, readRefTable,
  // CDP 动作
  captureGeneration, materializeRefs, resolveRef, refReasonText, refFail,
};
