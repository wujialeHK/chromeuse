'use strict';
/*
 * chromeuse lib/js-listeners.js —— JS click 监听可交互候选（C11 N12；TODO L94）
 *
 * 定位：`locator probe --js-listeners` / `a11y --mark-js` / `locator probe --cursor-pointer`
 * 的唯一实现单源。动机：a11y 基于可访问性树，React/Vue 常见 `<div onClick>` 无 role/name
 * 在树里不可见；本模块用 CDP DOMDebugger 只读能力补一条「直接监听」候选/标注通道。
 *
 * ── POC 实证前提（tmpdata/n12-poc/report.md，Chrome 153）─────────────────────
 * - **零前提**：无需启用 Debugger/Runtime 域即可调用 DOMDebugger.getEventListeners。
 *   本文件永不调用 Debugger 域（禁回退；无 breakpoint/暂停语义副作用）。
 * - **objectId 会话级**：Runtime.evaluate 拿 documentElement 句柄 → getEventListeners →
 *   releaseObject 必须**单命令单连接闭环**（跨连接报 -32000）；本模块所有调用都在同一 client/session。
 * - **一轮拿全页**：documentElement + depth:-1 + pierce:true 覆盖主文档/同源 iframe/shadow root。
 * - **能力边界（不承诺）**：①只覆盖**直接监听**——React 17+ 根容器委托在元素级不可见
 *   （需 --cursor-pointer 兜底）；②handler 源码不可得（协议 optional，inline/addEventListener 均缺省）。
 * - **88 分叉**：协议调用失败按 error.code 能力闸降级（-32601 方法不存在 / -32000 对象失效），
 *   明确返回 supported:false + code，调用方 fail-soft（不得让旧 probe/a11y 失败）。
 *
 * ── 输出面（默认关，零行为漂移）──────────────────────────────────────────────
 * - 监听候选仅由 locator.probe 在 --js-listeners 时并入（source='js-listener'）；默认 probe 不触发
 *   本模块任何 CDP 调用（dom 树输出逐字节不变）。
 * - a11y --mark-js 只给「可交互但无 role/name」的行加 [J]（数据=监听扫描 backendNodeId 与
 *   AXNode.backendDOMNodeId 直接 join），不改节点数、不进默认输出。
 */

const { evaluate } = require('./cdp-core');

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CANDIDATES = 200;

/* CDP 错误码提取：cdp-core 的 cdp 错误 message 形如「CDP X → -32601 ...」（error.code 未上抛）。 */
function parseCdpErrorCode(err) {
  const m = /→\s*(-?\d+)\b/.exec(String((err && err.message) || err || ''));
  return m ? Number(m[1]) : null;
}

/** 监听记录归一（纯函数）：只留 click 型 + 有 backendNodeId，按 backendNodeId 去重（capture 取首见）。 */
function normalizeListenerRecords(raw) {
  const seen = new Set();
  const out = [];
  for (const l of (Array.isArray(raw) ? raw : [])) {
    if (!l || l.type !== 'click') continue;
    if (l.backendNodeId === undefined || l.backendNodeId === null) continue;
    const id = Number(l.backendNodeId);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ backendNodeId: id, capture: l.useCapture === true, passive: l.passive === true, once: l.once === true });
  }
  out.sort((a, b) => a.backendNodeId - b.backendNodeId);
  return out;
}

/**
 * 全页直接 click 监听扫描（只读；单 session 单命令闭环）。
 * @param {object} client CdpClient
 * @param {string} sessionId
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean,supported:boolean,listeners:object[],backendIds:number[],code:number|null,error?:string,elapsedMs:number}>}
 */
async function scanClickListeners(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  let objectId = null;
  try {
    /* ⚠ 禁启用 Debugger 域：POC A1/A2 已证直调可行；此处仅取 documentElement 句柄。 */
    const ev = await client.send('Runtime.evaluate', {
      expression: 'document.documentElement',
      returnByValue: false, objectGroup: 'chromeuse-js-listeners', userGesture: false,
    }, { sessionId, timeoutMs });
    objectId = ev && ev.result && ev.result.objectId;
    if (!objectId) {
      return { ok: false, supported: false, listeners: [], backendIds: [], code: null, error: 'documentElement 句柄不可得', elapsedMs: Date.now() - t0 };
    }
    /* depth:-1 + pierce:true：一次调用覆盖子树/穿透 shadow root 与同源 iframe（POC A7/A8）。 */
    const res = await client.send('DOMDebugger.getEventListeners', { objectId, depth: -1, pierce: true }, { sessionId, timeoutMs });
    const listeners = normalizeListenerRecords(res && res.listeners);
    return { ok: true, supported: true, listeners, backendIds: listeners.map((l) => l.backendNodeId), code: null, elapsedMs: Date.now() - t0 };
  } catch (e) {
    /* 能力闸：协议层拒绝（-32601 方法不存在 / -32000 对象失效等）→ supported:false，不抛给旧逻辑。 */
    return {
      ok: false, supported: false, listeners: [], backendIds: [],
      code: parseCdpErrorCode(e), error: String((e && e.message) || e).slice(0, 300),
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (objectId) {
      try { await client.send('Runtime.releaseObject', { objectId }, { sessionId, timeoutMs: 1000 }); } catch (e) { /* 尽力而为 */ }
    }
  }
}

/* ── 页侧候选构造源（与 locator.buildCollectExpr 的候选形状对齐；自包含，供 callFunctionOn/批量扫描共用）──
 * 注意：locator.buildCollectExpr 是整段内联表达式，未导出内部 helper；本处独立一份但字段/口径与
 * locatorLine/rank/uniqueness 消费面一致（cssPath·framePath·rect·visible·hitOk·cursor 等）。 */
const CANDIDATE_HELPERS_SRC = `
    function __cuClass(el){
      var c = '';
      try { c = el.getAttribute ? el.getAttribute('class') : el.className; } catch(e) {}
      return c == null ? '' : String(c);
    }
    function __cuOwnText(el){
      var t = '';
      try { for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) t += n.textContent; } } catch(e) { return ''; }
      return String(t || '').trim();
    }
    function __cuFullText(el){
      try { return String(el.textContent || '').trim().slice(0, 80); } catch(e) { return ''; }
    }
    function __cuRole(el){
      var r = null;
      try { r = el.getAttribute('role'); } catch(e) {}
      if (r) return String(r);
      var tag = String(el.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'select') return tag;
      if (tag === 'input') {
        var ty = 'text';
        try { ty = String(el.getAttribute('type') || 'text').toLowerCase(); } catch(e) {}
        return (ty === 'submit' || ty === 'button') ? 'button' : 'textbox';
      }
      return '';
    }
    function __cuCssPath(el){
      if (!el || el.nodeType !== 1) return '';
      function esc(s){
        var v = String(s);
        try { if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(v); } catch(e) {}
        return v.replace(/([^\\w-])/g, '\\\\$1');
      }
      var doc = el.ownerDocument || null;
      function uniqueId(node){
        if (!node || !node.id) return '';
        var sel = '#' + esc(node.id);
        try { if (doc && doc.querySelectorAll) return doc.querySelectorAll(sel).length === 1 ? sel : ''; } catch(e) { return ''; }
        return sel;
      }
      var ownId = uniqueId(el);
      if (ownId) return ownId;
      var parts = [];
      var cur = el;
      for (var depth = 0; cur && cur.nodeType === 1 && depth < 64; depth++) {
        var tag = String(cur.tagName || '').toLowerCase();
        if (!tag) break;
        var idSel = uniqueId(cur);
        if (idSel) { parts.unshift(idSel); break; }
        var seg = tag;
        var cls = __cuClass(cur).trim().split(/\\s+/)[0] || '';
        if (cls && !/^[0-9]/.test(cls)) seg += '.' + esc(cls);
        var parent = cur.parentElement;
        if (parent && parent.nodeType === 1) {
          var sameTag = 0, idx = 0, sibs = [];
          try { sibs = parent.children ? Array.prototype.slice.call(parent.children) : []; } catch(e) { sibs = []; }
          for (var i = 0; i < sibs.length; i++) {
            if (String(sibs[i].tagName || '').toLowerCase() === tag) { sameTag++; if (sibs[i] === cur) idx = sameTag; }
          }
          if (sameTag > 1) seg += ':nth-of-type(' + idx + ')';
        }
        parts.unshift(seg);
        if (tag === 'html') break;
        if (!parent || parent.nodeType !== 1) break;
        cur = parent;
      }
      return parts.join(' > ');
    }
    function __cuFrame(el){
      var fp = [], ix = [], doc = el.ownerDocument;
      while (doc && doc.defaultView && doc.defaultView.frameElement) {
        var fe = doc.defaultView.frameElement;
        var label = 'iframe';
        try { label = fe.name ? String(fe.name) : (fe.id ? String(fe.id) : String(fe.tagName || 'iframe').toLowerCase()); } catch(e) {}
        fp.unshift(label);
        var idx = 0;
        try {
          var par = fe.parentElement;
          if (par) {
            var fs = par.querySelectorAll('iframe,frame');
            for (var i = 0; i < fs.length; i++) { if (fs[i] === fe) { idx = i; break; } }
          }
        } catch(e) {}
        ix.unshift(idx);
        doc = fe.ownerDocument;
      }
      return { framePath: fp, frameIndexPath: ix, frame: ['main'].concat(fp).join('>') };
    }
    function __cuAbsRect(el, r){
      var x = r.left, y = r.top, doc = el.ownerDocument;
      while (doc && doc.defaultView && doc.defaultView.frameElement) {
        var fe = doc.defaultView.frameElement;
        var fr = fe.getBoundingClientRect();
        x += fr.left; y += fr.top; doc = fe.ownerDocument;
      }
      return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function __cuCandidate(el){
      if (!el || el.nodeType !== 1) return null;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch(e) {}
      if (!r) return null;
      var doc = el.ownerDocument || document;
      var st = null;
      try { st = doc.defaultView.getComputedStyle(el); } catch(e) { return null; }
      var offsetParentOk = true;
      if (el.offsetParent === null && st.position !== 'fixed') offsetParentOk = false;
      var rectOk = !!(r.width >= 1 && r.height >= 1);
      var visible = !!(rectOk && offsetParentOk && st.visibility !== 'hidden');
      var hitOk = false;
      try {
        var hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hitOk = !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      } catch(e) {}
      var fp = __cuFrame(el);
      var text = __cuOwnText(el) || __cuFullText(el) || '';
      var cursor = String(st.cursor || '');
      return {
        framePath: fp.framePath, frameIndexPath: fp.frameIndexPath, frame: fp.frame,
        tag: String(el.tagName || '').toLowerCase(), id: el.id || '', cls: __cuClass(el), role: __cuRole(el),
        text: String(text).slice(0, 120), rect: __cuAbsRect(el, r),
        localRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        visible: visible, offsetParentOk: offsetParentOk, rectOk: rectOk, ancestorHidden: false,
        hitOk: hitOk, area: Math.round(r.width * r.height),
        disabled: el.disabled === true, readOnly: el.readOnly === true,
        ariaDisabled: !!(el.getAttribute && String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true'),
        cursorNotAllowed: cursor === 'not-allowed', cursorPointer: cursor === 'pointer',
        cssPath: __cuCssPath(el), ancestors: []
      };
    }`;

/** callFunctionOn 用：以 this（监听节点）为元素构造候选（DOM.resolveNode → callFunctionOn 单点）。 */
const LISTENER_CANDIDATE_FN = `function(){${CANDIDATE_HELPERS_SRC}
    return __cuCandidate(this);
  }`;

/** cursor:pointer 全页扫描表达式（只读；同源 iframe 同口径；半开上限截断）。 */
function buildCursorScanExpr(opts) {
  const max = (opts && Number.isFinite(opts.maxCandidates)) ? opts.maxCandidates : DEFAULT_MAX_CANDIDATES;
  return `(function(){
    ${CANDIDATE_HELPERS_SRC}
    var MAX = ${max};
    var docs = [];
    (function walk(doc, fp, ix){
      docs.push({ doc: doc, fp: fp, ix: ix });
      var fr = [];
      try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
      for (var i = 0; i < fr.length; i++) {
        var inner = null;
        try { inner = fr[i].contentDocument; } catch(e) {}
        if (inner) {
          var label = 'iframe';
          try { label = fr[i].name ? String(fr[i].name) : (fr[i].id ? String(fr[i].id) : String(fr[i].tagName || 'iframe').toLowerCase()); } catch(e) {}
          walk(inner, fp.concat([label]), ix.concat([i]));
        }
      }
    })(document, [], []);
    var out = [], truncated = false;
    for (var d = 0; d < docs.length; d++) {
      var pair = docs[d];
      var els = [];
      try { els = pair.doc.querySelectorAll('*'); } catch(e) { els = []; }
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var tag = String(el.tagName || '').toLowerCase();
        if (tag === 'html' || tag === 'body') continue;
        var st = null;
        try { st = pair.doc.defaultView.getComputedStyle(el); } catch(e) { continue; }
        if (!st || st.cursor !== 'pointer') continue;
        var c = __cuCandidate(el);
        if (!c) continue;
        c.cursorPointer = true;
        c.source = 'cursor-pointer';
        out.push(c);
        if (out.length >= MAX) { truncated = true; break; }
      }
      if (out.length >= MAX) break;
    }
    return { ok: true, candidates: out, truncated: truncated, docs: docs.length };
  })()`;
}

/** cursor:pointer 兜底候选采集（只读 evaluate；失败 fail-soft 返回 ok:false 不抛）。 */
async function collectCursorPointerCandidates(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  try {
    const raw = await evaluate(client, sessionId, buildCursorScanExpr(o), timeoutMs);
    if (!raw || raw.ok !== true || !Array.isArray(raw.candidates)) {
      return { ok: false, candidates: [], error: 'cursor-scan-bad-result' };
    }
    return { ok: true, candidates: raw.candidates, truncated: raw.truncated === true, docs: raw.docs || 1 };
  } catch (e) {
    return { ok: false, candidates: [], error: String((e && e.message) || e).slice(0, 300) };
  }
}

/** 候选去重键（纯函数）：framePath + cssPath；无 cssPath 退 rect+tag。 */
function candidateKey(c) {
  if (!c || typeof c !== 'object') return '';
  const fp = Array.isArray(c.framePath) ? c.framePath.join('>') : '';
  if (c.cssPath) return `${fp}|${c.cssPath}`;
  const r = c.rect || {};
  return `${fp}|${String(c.tag || '')}|${[r.x, r.y, r.w, r.h].join(',')}`;
}

const SOURCE_ORDER = ['spec', 'js-listener', 'cursor-pointer'];

function combineSource(a, b) {
  const parts = new Set();
  for (const s of [a, b]) {
    if (!s) continue;
    String(s).split('+').forEach((x) => { if (x) parts.add(x); });
  }
  return SOURCE_ORDER.filter((x) => parts.has(x)).concat([...parts].filter((x) => !SOURCE_ORDER.includes(x))).join('+');
}

/**
 * 候选来源合并（纯函数）：base 与 extras 按 candidateKey 去重；同元素合并来源标注，
 * extras 独有项追加（保留其 source/jsListener/cursorPointer 字段）。
 * @returns {{candidates:object[],added:number,merged:number}}
 */
function mergeCandidateSources(base, extras) {
  const out = (Array.isArray(base) ? base : []).slice();
  const index = new Map();
  for (const c of out) if (c && candidateKey(c)) index.set(candidateKey(c), c);
  let added = 0;
  let merged = 0;
  for (const e of (Array.isArray(extras) ? extras : [])) {
    if (!e) continue;
    const k = candidateKey(e);
    const hit = k ? index.get(k) : null;
    if (hit) {
      merged++;
      if (e.jsListener === true) hit.jsListener = true;
      if (e.cursorPointer === true) hit.cursorPointer = true;
      if (e.listenerCapture === true) hit.listenerCapture = true;
      /* base 候选来自 spec 锚点匹配（无 source 字段是存量形状）→ 合并时补成 spec+… */
      hit.source = combineSource(hit.source || 'spec', e.source);
      if (!hit.role && e.role) hit.role = e.role;
      if (!hit.text && e.text) hit.text = e.text;
    } else {
      out.push(e);
      if (k) index.set(k, e);
      added++;
    }
  }
  return { candidates: out, added, merged };
}

/**
 * 监听候选采集（DOM.resolveNode → Runtime.callFunctionOn；单 session 闭环）。
 * 先 DOM.getDocument({depth:0}) 确保 backendNodeId 可解析（POC A9：未请求文档时映射报 -32000）。
 */
async function collectListenerCandidates(client, sessionId, listeners, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const max = Number.isFinite(o.maxCandidates) ? o.maxCandidates : DEFAULT_MAX_CANDIDATES;
  const list = Array.isArray(listeners) ? listeners : [];
  if (!list.length) return { ok: true, candidates: [], errors: 0, truncated: false };
  try {
    await client.send('DOM.getDocument', { depth: 0 }, { sessionId, timeoutMs });
  } catch (e) {
    return { ok: false, candidates: [], errors: 0, truncated: false, error: `DOM.getDocument 失败：${String((e && e.message) || e).slice(0, 200)}` };
  }
  const out = [];
  let errors = 0;
  const slice = list.slice(0, max);
  for (const l of slice) {
    let objectId = null;
    try {
      const r = await client.send('DOM.resolveNode', { backendNodeId: l.backendNodeId }, { sessionId, timeoutMs });
      objectId = r && r.object && r.object.objectId;
      if (!objectId) { errors++; continue; }
      const call = await client.send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: LISTENER_CANDIDATE_FN, returnByValue: true, silent: true,
      }, { sessionId, timeoutMs });
      const v = call && call.result && call.result.value;
      if (!v || typeof v !== 'object') { errors++; continue; }
      v.jsListener = true;
      v.source = 'js-listener';
      v.listenerCapture = l.capture === true;
      out.push(v);
    } catch (e) {
      errors++;
    } finally {
      if (objectId) {
        try { await client.send('Runtime.releaseObject', { objectId }, { sessionId, timeoutMs: 1000 }); } catch (e) { /* 尽力而为 */ }
      }
    }
  }
  return { ok: true, candidates: out, errors, truncated: list.length > max };
}

/* ── a11y --mark-js（操作员标注） ─────────────────────────────────────────── */

/** [J] 标注资格（纯函数）：AX 行可交互但无 role/name —— 空/none/generic 系 role 且 name 为空。 */
function isMarkEligible(row) {
  if (!row || typeof row !== 'object' || row.ignored === true) return false;
  const role = String(row.role || '').toLowerCase();
  if (role !== '' && role !== 'none' && !role.startsWith('generic')) return false;
  return !String(row.name == null ? '' : row.name).trim();
}

/**
 * 监听 backendNodeId 集合 → 给 AX 行打 [J]（纯函数，原地标注；不改节点数/行序）。
 * @returns {{marked:number,scanned:number}}
 */
function applyListenerMarks(rows, listeners) {
  const ids = new Set();
  for (const l of (Array.isArray(listeners) ? listeners : [])) {
    if (l && l.backendNodeId !== undefined && l.backendNodeId !== null) ids.add(Number(l.backendNodeId));
  }
  let marked = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!isMarkEligible(row)) continue;
    if (row.backendDOMNodeId === undefined || row.backendDOMNodeId === null) continue;
    if (!ids.has(Number(row.backendDOMNodeId))) continue;
    row.jsListener = true;
    marked++;
  }
  return { marked, scanned: ids.size };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CANDIDATES,
  parseCdpErrorCode, normalizeListenerRecords, scanClickListeners,
  candidateKey, combineSource, mergeCandidateSources,
  collectListenerCandidates, buildCursorScanExpr, collectCursorPointerCandidates,
  isMarkEligible, applyListenerMarks,
  CANDIDATE_HELPERS_SRC, LISTENER_CANDIDATE_FN,
};
