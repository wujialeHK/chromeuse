'use strict';
/*
 * chromeuse lib/locator.js —— 元素捕获/定位验证/拾取工具层（V202610190001，零依赖 CJS）
 *
 * 解决痛点：flow 的六层定位器（text/role/near/grid/domPath/point）在多候选歧义时纪律诚实红不猜；
 * 收窄手段在多层 iframe 下各有局限（domPath 只在当前文档解析 / container text 可能解析到元素自身 /
 * point 随布局漂移）——本模块把「看见候选 → 递归收窄 → 高亮视觉确认 → 点击拾取」做成 CLI 工具，
 * 不再让 agent 盲试多轮。
 *
 * 语义对齐（单源复用 lib/target-resolver.js）：
 * - X1 四层命中闸门（rect / offsetParent(+fixed 祖先豁免) / visibility / elementFromPoint）复用 GATE4_SRC；
 * - text/container 描述符归一复用 normTextDesc；container 结构祖先集复用 CONTAINER_STRUCT_SEL；
 * - frame path 形态与 target-resolver 的 collectDocs 一致：main>iframeName>…，并额外记录 frameIndexPath
 *   （同名 iframe 时按索引精确定位，供高亮找元素）。
 *
 * 边界（如实声明）：
 * - 只读为主：collectCandidates/uniqueness/suggestNarrowing 零 DOM 变更；highlight 只临时画框（Overlay +
 *   CSS outline），毫秒级后还原；pick 注入 capture-phase 一次性 click 监听（唯一写操作），拾取即自摘。
 * - 同源 iframe 才可穿透（contentDocument）；跨域/OOPIF 读不到 → 不收集、不注入、不拾取。
 * - domPath 的 CSS 路径是「所在文档内」路径；跨 frame 需先 frame 进入（见 toTargetSpec notes）。
 * - flow container 不支持跨 frame（contains 天然同文档）——suggestNarrowing 遇跨 frame 多候选如实报
 *   reason:'cross-frame'，不伪造收窄。
 * - 本模块不接入 lib/flow-engine.js（工具层独立；未来按需接线）。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');
const { evaluate } = require('./cdp-core');
const jsListeners = require('./js-listeners'); // C11 N12：JS click 监听候选 / cursor:pointer 兜底（默认关）
const {
  GATE4_SRC, CONTAINER_STRUCT_SEL, normTextDesc, matchModeOK, validContainer,
} = require('./target-resolver');

const DEFAULT_MAX_CANDIDATES = 200;
const DEFAULT_TIMEOUT_MS = 10000;
const sleep = time.sleep; // 通用延迟单源 lib/time.js

/* ── 纯函数（页面侧注入源；Node 侧可直接单测） ── */

/** iframe 标签：name > id > tag（与 target-resolver collectDocs 同口径） */
function frameLabel(f) {
  try {
    if (f.name) return String(f.name);
    if (f.id) return String(f.id);
    return String(f.tagName || 'iframe').toLowerCase();
  } catch (e) { return 'iframe'; }
}

function ownText(el) {
  let t = '';
  try { for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent; } catch (e) { return ''; }
  return String(t || '').trim();
}

function fullText(el) {
  try { return String(el.textContent || '').trim().slice(0, 80); } catch (e) { return ''; }
}

function roleOf(el) {
  let r = null;
  try { r = el.getAttribute('role'); } catch (e) { /* noop */ }
  if (r) return String(r);
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'select') return tag;
  if (tag === 'input') {
    let ty = 'text';
    try { ty = String(el.getAttribute('type') || 'text').toLowerCase(); } catch (e) { /* noop */ }
    return (ty === 'submit' || ty === 'button') ? 'button' : 'textbox';
  }
  return '';
}

function classOf(el) {
  try {
    const c = el.getAttribute ? el.getAttribute('class') : el.className;
    return c == null ? '' : String(c);
  } catch (e) { return ''; }
}

/**
 * 可交互性快照（B4/R2 #103；页面侧注入源，只读）：回答「候选本身是否可用」，
 * 与「是否定位到」解耦——禁用/只读/aria-disabled/cursor:not-allowed 均属**可用性**问题，
 * 不是定位失败（2026-10-29 示例ERP批误诊链：select 关闭态 0×0 + disabled 被当成浮层定位缺陷）。
 */
function interactState(el, doc) {
  const out = { disabled: false, readOnly: false, ariaDisabled: false, cursorNotAllowed: false };
  try { out.disabled = el.disabled === true; } catch (e) { /* noop */ }
  try { if (el.hasAttribute && el.hasAttribute('disabled')) out.disabled = true; } catch (e) { /* noop */ }
  try { out.readOnly = el.readOnly === true || !!(el.hasAttribute && el.hasAttribute('readonly')); } catch (e) { /* noop */ }
  try {
    const v = el.getAttribute ? el.getAttribute('aria-disabled') : null;
    out.ariaDisabled = String(v == null ? '' : v).toLowerCase() === 'true';
  } catch (e) { /* noop */ }
  try {
    const st = doc && doc.defaultView ? doc.defaultView.getComputedStyle(el) : null;
    out.cursorNotAllowed = !!(st && st.cursor === 'not-allowed');
  } catch (e) { /* noop */ }
  return out;
}

/**
 * 候选可交互性判读（B4/R2 #103；Node 侧纯函数，collectCandidates 逐候选标注）。
 * @returns {string|null} null=未发现禁用特征；非 null=一句话判读（含「非定位失败」措辞）
 */
function interactabilityVerdict(c) {
  if (!c || typeof c !== 'object') return null;
  const reasons = [];
  if (c.disabled === true) reasons.push('disabled=true');
  if (c.ariaDisabled === true) reasons.push('aria-disabled="true"');
  if (c.readOnly === true) reasons.push('readOnly=true');
  if (c.cursorNotAllowed === true) reasons.push('cursor:not-allowed');
  if (!reasons.length) return null;
  return `控件被禁用/只读（${reasons.join('；')}）——非定位失败：先解除禁用/只读或换取可用控件，再重试`;
}

/**
 * 唯一 CSS 路径（只用于显示/参考）：id 优先 → class + nth-of-type 祖先链。
 * 设计说明：id 只有在文档内 querySelectorAll 恰好 1 个时才采用（重复 id 不可作为唯一路径）；
 * 祖先链遇到唯一 id 即提前截断。返回空串表示无法生成（非元素节点等）。
 */
function cssPathOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const esc = (s) => {
    const v = String(s);
    try { if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(v); } catch (e) { /* noop */ }
    return v.replace(/([^\w-])/g, '\\$1');
  };
  const doc = el.ownerDocument || null;
  const uniqueId = (node) => {
    if (!node || !node.id) return '';
    const sel = '#' + esc(node.id);
    try { if (doc && doc.querySelectorAll) return doc.querySelectorAll(sel).length === 1 ? sel : ''; } catch (e) { return ''; }
    return sel;
  };
  const ownId = uniqueId(el);
  if (ownId) return ownId;
  const parts = [];
  let cur = el;
  for (let depth = 0; cur && cur.nodeType === 1 && depth < 64; depth++) {
    const tag = String(cur.tagName || '').toLowerCase();
    if (!tag) break;
    const idSel = uniqueId(cur);
    if (idSel) { parts.unshift(idSel); break; }
    let seg = tag;
    const cls = classOf(cur).trim().split(/\s+/)[0] || '';
    if (cls && !/^[0-9]/.test(cls)) seg += '.' + esc(cls);
    const parent = cur.parentElement;
    if (parent && parent.nodeType === 1) {
      let sameTag = 0;
      let idx = 0;
      let sibs = [];
      try { sibs = parent.children ? Array.from(parent.children) : []; } catch (e) { sibs = []; }
      for (const s of sibs) {
        if (String(s.tagName || '').toLowerCase() === tag) {
          sameTag++;
          if (s === cur) idx = sameTag;
        }
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

/* ── 候选唯一性（X1 过滤后计数） ── */

/** 可点击判定 = visible(rect/offsetParent/visibility 过闸) && hitOk(elementFromPoint 命中自身/后代) */
function isClickable(c) { return !!(c && c.visible === true && c.hitOk === true); }

/**
 * 唯一可点判定：candidates 中 visible+hitOk 的个数。
 * @returns {{total:number, clickable:number, unique:boolean, best:object|null, hidden:number, hitMiss:number}}
 */
function uniqueness(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const click = list.filter(isClickable);
  return {
    total: list.length,
    clickable: click.length,
    unique: click.length === 1,
    best: click.length === 1 ? click[0] : null,
    hidden: list.filter((c) => c && c.visible !== true).length,
    hitMiss: list.filter((c) => c && c.visible === true && c.hitOk !== true).length,
  };
}

/** 排序（verify 选 best 用）：可点优先 → exact 文本优先 → 面积升序 → 文档序稳定 */
function rankCandidates(candidates, spec) {
  const list = (Array.isArray(candidates) ? candidates : []).slice();
  const text = spec && spec.text && typeof spec.text === 'object' ? spec.text : null;
  const exact = (c) => {
    if (!text) return 0;
    if (text.match === 'exact') return String(c.text || '') === text.value ? 0 : 1;
    return String(c.text || '').indexOf(text.value) !== -1 ? 0 : 1;
  };
  return list.sort((a, b) => {
    const ka = isClickable(a) ? 0 : 1;
    const kb = isClickable(b) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const ea = exact(a), eb = exact(b);
    if (ea !== eb) return ea - eb;
    return (Number(a.area) || 0) - (Number(b.area) || 0);
  });
}

/* ── 页面侧收集表达式 ── */

function buildCollectExpr(rawSpec) {
  const spec = rawSpec || {};
  const maxCand = Number.isFinite(spec.__maxCandidates) ? spec.__maxCandidates : DEFAULT_MAX_CANDIDATES;
  return `(function(){ return (function(spec, MAX){
    ${GATE4_SRC}
    ${frameLabel.toString()}
    ${ownText.toString()}
    ${fullText.toString()}
    ${roleOf.toString()}
    ${classOf.toString()}
    ${interactState.toString()}
    ${cssPathOf.toString()}
    const CONTAINER_STRUCT_SEL = ${JSON.stringify(CONTAINER_STRUCT_SEL)};
    function collectDocs(){
      const docs = [];
      (function walk(doc, fp, ix){
        docs.push({ doc: doc, fp: fp, ix: ix });
        let fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
        for (let i = 0; i < fr.length; i++) {
          let inner = null; try { inner = fr[i].contentDocument; } catch(e) {}
          if (inner) walk(inner, fp.concat([frameLabel(fr[i])]), ix.concat([i]));
        }
      })(document, [], []);
      return docs;
    }
    function absRect(el, r){
      let x = r.left, y = r.top, doc = el.ownerDocument;
      while (doc && doc.defaultView && doc.defaultView.frameElement) {
        const fe = doc.defaultView.frameElement; const fr = fe.getBoundingClientRect();
        x += fr.left; y += fr.top; doc = fe.ownerDocument;
      }
      return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function visInfo(el, doc, r){
      let st = null;
      try { st = doc.defaultView.getComputedStyle(el); } catch(e) { return { visible:false, offsetParentOk:false, rectOk:false, ancestorHidden:false }; }
      let offsetParentOk = true;
      if (el.offsetParent === null && st.position !== 'fixed') {
        const fa = hasFixedAncestor(el, doc);
        if (fa === null || !fa) offsetParentOk = false;
      }
      let ancestorHidden = false;
      const par = el.parentElement;
      if (par && par.nodeType === 1) {
        try {
          const pst = par.ownerDocument.defaultView.getComputedStyle(par);
          if (pst.visibility === 'hidden' || pst.display === 'none') ancestorHidden = true;
        } catch(e) { ancestorHidden = true; }
      }
      const rectOk = !!(r && r.width >= 1 && r.height >= 1);
      return { visible: rectOk && offsetParentOk && st.visibility !== 'hidden' && !ancestorHidden, offsetParentOk: offsetParentOk, rectOk: rectOk, ancestorHidden: ancestorHidden };
    }
    function hitOkOf(el, doc, r){
      if (!r || r.width < 1 || r.height < 1) return false;
      let hit = null;
      try { hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch(e) { return false; }
      return !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    }
    function ancestorsOf(el){
      const out = []; let p = el.parentElement;
      for (let i = 0; i < 12 && p && p.nodeType === 1; i++) {
        let struct = false; try { struct = !!p.matches(CONTAINER_STRUCT_SEL); } catch(e) {}
        const ot = ownText(p);
        // 2026-10-19 实弹修正：祖先文本优先 innerText（可见文本，不含 <script> 源码）——
        // 原 fullText(textContent) 在体量大容器（ownText 为空）时会取到脚本源码当 container text
        let vis = ''; try { vis = (p.innerText != null ? String(p.innerText) : ''); } catch (e) {}
        const ancText = String(ot || vis.replace(/\s+/g, ' ').trim() || '').slice(0, 120);
        out.push({ tag: String(p.tagName || '').toLowerCase(), id: p.id || '', cls: classOf(p),
          text: ancText, ownText: String(ot || '').slice(0, 80),
          cssPath: cssPathOf(p), depth: i + 1, struct: struct });
        p = p.parentElement;
      }
      return out;
    }
    function textMatch(v, specText){
      if (specText && typeof specText === 'object') {
        return specText.match === 'exact' ? v === specText.value : v.indexOf(specText.value) !== -1;
      }
      return v.indexOf(String(specText)) !== -1;
    }
    function makeCandidate(el, pair, r){
      const vi = visInfo(el, pair.doc, r);
      const ar = absRect(el, r);
      const it = interactState(el, pair.doc);
      return { framePath: pair.fp.slice(), frameIndexPath: pair.ix.slice(),
        frame: ['main'].concat(pair.fp).join('>'),
        tag: String(el.tagName || '').toLowerCase(), id: el.id || '', cls: classOf(el), role: roleOf(el),
        text: String(ownText(el) || fullText(el) || '').slice(0, 120), rect: ar,
        localRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        visible: vi.visible, offsetParentOk: vi.offsetParentOk, rectOk: vi.rectOk, ancestorHidden: vi.ancestorHidden,
        hitOk: hitOkOf(el, pair.doc, r), area: Math.round(r.width * r.height),
        disabled: it.disabled, readOnly: it.readOnly, ariaDisabled: it.ariaDisabled, cursorNotAllowed: it.cursorNotAllowed,
        cssPath: cssPathOf(el), ancestors: ancestorsOf(el) };
    }
    function resolveContainer(docs){
      const c = spec.container;
      const form = c.text !== undefined ? 'text' : (c.role !== undefined ? 'role' : 'domPath');
      const ctext = c.text;
      let matched = 0;
      for (const pair of docs) {
        let list = [];
        if (form === 'domPath') {
          let el = null; try { el = pair.doc.querySelector(c.domPath); } catch(e) {}
          if (!el) continue;
          let r = null; try { r = el.getBoundingClientRect(); } catch(e) {}
          if (!r) continue;
          const vi = visInfo(el, pair.doc, r);
          if (!vi.visible) continue;
          list = [el];
        } else {
          let all = []; try { all = Array.from(pair.doc.querySelectorAll('*')); } catch(e) { continue; }
          for (const el of all) {
            let r = null; try { r = el.getBoundingClientRect(); } catch(e) {}
            if (!r) continue;
            const vi = visInfo(el, pair.doc, r);
            if (!vi.visible) continue;
            if (form === 'text') {
              const t = ownText(el) || fullText(el);
              if (!t || !textMatch(t, ctext) || t.length > String(ctext.value).length + 40) continue;
            } else if (roleOf(el) !== c.role) continue;
            list.push(el);
          }
          if (form === 'text' && list.length > 1) {
            const scored = list.map((el) => {
              const t = ownText(el) || fullText(el);
              const p = el.parentElement;
              const pf = p ? String(p.textContent || '').trim().slice(0, 80) : '';
              const fragment = !!(pf && pf.length > t.length && pf.indexOf(t) !== -1);
              let r = null; try { r = el.getBoundingClientRect(); } catch(e) {}
              return { el: el, fragment: fragment, area: r ? r.width * r.height : 0 };
            });
            scored.sort((a, b) => ((b.fragment ? 0 : 1) - (a.fragment ? 0 : 1)) || (a.area - b.area));
            list = scored.map((x) => x.el);
          }
        }
        if (!list.length) continue;
        matched++;
        let scopeEl = list[0];
        if (form === 'text') {
          let selfStruct = false; try { selfStruct = !!scopeEl.matches(CONTAINER_STRUCT_SEL); } catch(e) {}
          if (!selfStruct) {
            let p = scopeEl.parentElement;
            for (let i = 0; i < 8 && p; i++) {
              if (p.nodeType !== 1) break;
              let st = false; try { st = !!p.matches(CONTAINER_STRUCT_SEL); } catch(e) {}
              if (st) { scopeEl = p; break; }
              p = p.parentElement;
            }
          }
        }
        return { el: scopeEl, doc: pair.doc, fp: pair.fp, form: form, matched: matched };
      }
      return { el: null, form: form, matched: matched };
    }
    const docs = collectDocs();
    let scope = null;
    let container = null;
    if (spec.container !== undefined) {
      const rc = resolveContainer(docs);
      container = { form: rc.form, found: rc.el ? 1 : 0, matched: rc.matched, scopedFound: 0, outsideCount: 0 };
      if (!rc.el) return { ok: false, error: 'container-not-found', candidates: [], container: container, docs: docs.length };
      scope = rc;
    }
    const textLen = spec.text ? String(spec.text.value).length : 0;
    const out = [];
    let truncated = false;
    for (const pair of docs) {
      let els = [];
      try {
        els = spec.domPath !== undefined ? Array.from(pair.doc.querySelectorAll(spec.domPath)) : Array.from(pair.doc.querySelectorAll('*'));
      } catch(e) { els = []; }
      for (const el of els) {
        let r = null; try { r = el.getBoundingClientRect(); } catch(e) { continue; }
        if (!r) continue;
        if (spec.domPath === undefined) {
          const t = ownText(el) || fullText(el);
          if (spec.text !== undefined) {
            if (!t || !textMatch(t, spec.text) || t.length > textLen + 40) continue;
          } else if (spec.role !== undefined) {
            if (roleOf(el) !== spec.role) continue;
          } else continue;
        }
        if (scope) {
          let inside = false;
          try { inside = !!(scope.el === el || scope.el.contains(el)); } catch(e) { inside = false; }
          if (!inside) { if (container) container.outsideCount++; continue; }
        }
        out.push(makeCandidate(el, pair, r));
        if (out.length >= MAX) { truncated = true; break; }
      }
      if (out.length >= MAX) break;
    }
    if (container) container.scopedFound = out.length;
    return { ok: true, candidates: out, container: container, docs: docs.length, truncated: truncated };
  })( ${JSON.stringify(spec)}, ${maxCand} ); })()`;
}

/* ── 命中被挡取证（B4/R2 #103） ──
 * X1 闸门 L4（elementFromPoint 未命中）在点击类命令里表现为「候选可见但 hitOk=false」。
 * 诊断只读：在候选中心点复测 elementFromPoint，回报遮挡元素（tag/id/class/rect/z-index/position）+
 * 候选三层祖先 + 遮挡元素是否在 fixed/sticky 浮层内。零页面写、零合成事件。 */
function buildHitBlockedExpr(candidate) {
  const find = buildFindElementExpr(candidate);
  return `(function(){
    var el = ${find};
    if (!el) return { ok: false, error: 'element-not-found' };
    var doc = el.ownerDocument || document;
    var r = null; try { r = el.getBoundingClientRect(); } catch (e) {}
    if (!r) return { ok: false, error: 'rect-unavailable' };
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    function info(n) {
      if (!n || n.nodeType !== 1) return null;
      var rr = null; try { rr = n.getBoundingClientRect(); } catch (e) {}
      var st = null; try { st = doc.defaultView.getComputedStyle(n); } catch (e) {}
      var cls = ''; try { cls = classOf(n); } catch (e) {}
      return { tag: String(n.tagName || '').toLowerCase(), id: n.id || '', cls: String(cls || ''),
        rect: rr ? { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
        zIndex: st ? String(st.zIndex) : '', position: st ? String(st.position) : '',
        pointerEvents: st ? String(st.pointerEvents) : '' };
    }
    var hit = null; try { hit = doc.elementFromPoint(x, y); } catch (e) {}
    var ancestors = []; var p = el.parentElement;
    for (var i = 0; i < 3 && p && p.nodeType === 1; i++) { ancestors.push(info(p)); p = p.parentElement; }
    var inFixedLayer = false; var q = hit;
    for (var j = 0; j < 15 && q && q.nodeType === 1; j++) {
      var qst = null; try { qst = q.ownerDocument.defaultView.getComputedStyle(q); } catch (e) {}
      if (qst && (qst.position === 'fixed' || qst.position === 'sticky')) { inFixedLayer = true; break; }
      if (q === q.ownerDocument.documentElement) break;
      q = q.parentElement;
    }
    var vp = { w: 0, h: 0 };
    try { vp = { w: doc.defaultView.innerWidth || 0, h: doc.defaultView.innerHeight || 0 }; } catch (e) {}
    return { ok: true, evidence: {
      kind: 'hit-blocked', point: { x: Math.round(x), y: Math.round(y) }, viewport: vp,
      target: info(el), hit: info(hit), ancestors: ancestors, inFixedLayer: inFixedLayer,
    } };
  })()`;
}

/**
 * 采集命中被挡 evidence（只读 evaluate；失败 fail-soft 返回 {ok:false,error}，不改变失败码判定）。
 * @returns {Promise<{ok:boolean, evidence?:object, error?:string}>}
 */
async function collectHitBlockedEvidence(client, sessionId, candidate, opts) {
  const o = opts || {};
  try {
    const raw = await evaluate(client, sessionId, buildHitBlockedExpr(candidate), o.timeoutMs || 3000);
    const rep = _parsePageResult(raw);
    if (!rep || rep.ok !== true || !rep.evidence) return { ok: false, error: (rep && rep.error) || 'bad-result' };
    return { ok: true, evidence: rep.evidence };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/** spec 归一（text 兄弟键/对象两形态 → {value,match}；container.text 同规）；非法返回 null */
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const out = Object.assign({}, spec);
  if (out.text !== undefined) {
    const t = normTextDesc(out.text, out);
    if (!t) return null;
    out.text = t;
    delete out.match;
  }
  if (out.container !== undefined) {
    if (!validContainer(out.container)) return null;
    out.container = Object.assign({}, out.container);
    if (out.container.text !== undefined) {
      const t = normTextDesc(out.container.text, out.container);
      if (!t) return null;
      out.container.text = t;
    }
  }
  return out;
}

function _parsePageResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  return null;
}

/**
 * 跨全部同源 iframe 收集候选。
 * @param {object} client CdpClient
 * @param {string} sessionId
 * @param {object} spec {text?|role?|domPath?, container?}
 * @param {object} [opts] {timeoutMs?, maxCandidates?, jsListeners?:boolean, cursorPointer?:boolean}
 * @returns {Promise<{ok:boolean,candidates:object[],container?:object,error?:string,docs?:number,truncated?:boolean,
 *   jsListeners?:object,cursorPointer?:object}>}
 *   注意：candidates 含不可见/未命中项（visible/offsetParentOk/hitOk 逐项如实），唯一性判定请用 uniqueness()。
 *   C11 N12：jsListeners/cursorPointer 默认关——关时零额外 CDP 调用、输出与旧版逐字节一致；
 *   开时把「直接 click 监听节点」/「computed cursor:pointer 元素」并入候选（source 标注），
 *   **不改** isClickable/X1 判定。能力不支持（88 分叉/协议拒绝）→ 子报告 ok:false 降级，不影响基础候选。
 */
async function collectCandidates(client, sessionId, spec, opts) {
  const o = opts || {};
  const s = normalizeSpec(spec);
  if (!s) return { ok: false, error: 'bad-spec', candidates: [], message: 'spec 形态非法（text/container 描述符不合法）' };
  const wantJs = o.jsListeners === true;
  const wantCursor = o.cursorPointer === true;
  const hasAnchor = s.text !== undefined || s.role !== undefined || s.domPath !== undefined;
  if (!hasAnchor && !wantJs && !wantCursor) {
    return { ok: false, error: 'no-anchor', candidates: [], message: 'spec 至少需要 text/role/domPath 之一（container 只是修饰符；--js-listeners/--cursor-pointer 可单独作为候选源）' };
  }
  if (Number.isFinite(o.maxCandidates)) s.__maxCandidates = o.maxCandidates;
  const cap = Number.isFinite(o.maxCandidates) ? o.maxCandidates : DEFAULT_MAX_CANDIDATES;
  let rep;
  if (hasAnchor) {
    const raw = await evaluate(client, sessionId, buildCollectExpr(s), o.timeoutMs || DEFAULT_TIMEOUT_MS);
    rep = _parsePageResult(raw);
    if (!rep || !Array.isArray(rep.candidates)) {
      return { ok: false, error: 'bad-result', candidates: [], message: '页面收集表达式返回非法' };
    }
  } else {
    /* 纯候选源模式（如 `locator probe --js-listeners` 无文本锚点）：跳过页面 text/role 收集。 */
    rep = { ok: true, candidates: [], docs: 1, truncated: false };
  }
  /* C11 N12 ①：直接 click 监听节点并入（CDP DOMDebugger；能力失败 fail-soft 只标注）。 */
  if (wantJs) {
    const scan = await jsListeners.scanClickListeners(client, sessionId, { timeoutMs: o.timeoutMs });
    if (!scan.ok) {
      rep.jsListeners = { ok: false, supported: false, code: scan.code, error: scan.error, scanned: 0, added: 0, merged: 0 };
    } else {
      const col = await jsListeners.collectListenerCandidates(client, sessionId, scan.listeners, { timeoutMs: o.timeoutMs, maxCandidates: cap });
      if (!col.ok) {
        rep.jsListeners = { ok: false, supported: true, code: null, error: col.error, scanned: scan.listeners.length, added: 0, merged: 0 };
      } else {
        const merged = jsListeners.mergeCandidateSources(rep.candidates, col.candidates);
        rep.candidates = merged.candidates;
        rep.jsListeners = {
          ok: true, supported: true, code: null, scanned: scan.listeners.length,
          added: merged.added, merged: merged.merged, errors: col.errors || 0,
          truncated: col.truncated === true || scan.listeners.length > cap,
        };
      }
    }
  }
  /* C11 N12 ③：cursor:pointer 兜底候选并入（只读 getComputedStyle；与 --js-listeners 可组合）。 */
  if (wantCursor) {
    const cur = await jsListeners.collectCursorPointerCandidates(client, sessionId, { timeoutMs: o.timeoutMs, maxCandidates: cap });
    if (!cur.ok) {
      rep.cursorPointer = { ok: false, added: 0, merged: 0, error: cur.error };
    } else {
      const merged = jsListeners.mergeCandidateSources(rep.candidates, cur.candidates);
      rep.candidates = merged.candidates;
      rep.cursorPointer = { ok: true, added: merged.added, merged: merged.merged, truncated: cur.truncated === true, docs: cur.docs || 1 };
    }
  }
  /* 总候选上限：新增候选源并入后可能超 cap（默认路径由页面表达式限幅，行为不变）。 */
  if (rep.candidates.length > cap) {
    rep.candidates = rep.candidates.slice(0, cap);
    rep.truncated = true;
  }
  /* B4/R2 #103：逐候选标注可交互性判读（disabled/readOnly/aria-disabled/cursor:not-allowed）。
   * 只加诊断字段，**不改** isClickable 判定——禁用元素仍按 X1 闸门语义处理（回归零影响）。 */
  let blocked = 0;
  for (const c of rep.candidates) {
    c.interactability = interactabilityVerdict(c);
    if (c.interactability) blocked++;
  }
  if (blocked) rep.blocked = blocked;
  rep.spec = s;
  return rep;
}

/* ── 递归收窄 ── */

function ancestorContainer(a) {
  if (!a) return null;
  // domPath 优先（2026-10-19 实弹修正）：cssPath 精确到 nth-of-type、同文档内唯一；
  // 原 text 优先路径会撞「祖先全文含 <script> 源码」→ container-not-found（suggest 实弹 bug）。
  // container domPath 已实测跨同源 iframe 生效（容器在候选所在文档内解析）。
  if (a.cssPath) return { domPath: a.cssPath };
  const text = sanitizeAncestorText(a.text);
  if (text) return { text: text, match: 'exact' };
  return null;
}

/** 祖先文本兜底清洗（排除脚本源码残留/超长/含结构符号的串——仅 text 形态兜底用） */
function sanitizeAncestorText(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return '';
  if (/[<>{};]|function\s|window\.|document\.|=>/.test(s)) return '';
  return s;
}

function targetFromSpec(spec) {
  const s = normalizeSpec(spec);
  if (!s) return null;
  if (s.text !== undefined) {
    const t = { text: s.text.value };
    if (s.text.match !== 'contains') t.match = s.text.match;
    if (s.container !== undefined) t.container = s.container;
    return t;
  }
  if (s.role !== undefined) return { role: s.role };
  if (s.domPath !== undefined) return { domPath: s.domPath };
  return null;
}

/**
 * 递归收窄建议（用户核心诉求）：候选>1 时取共同祖先链（父→祖父→…），每级构造
 * container:{text} 或 container:{domPath} 重算候选，第一个唯一即返回。
 *
 * @param {object} client CdpClient（opts.collectFn 注入时可为 null——单测用）
 * @param {string} sessionId
 * @param {object} spec 同 collectCandidates
 * @param {object} [opts] {timeoutMs?, collectFn?(spec)=>{candidates}}
 * @returns {Promise<{ok:boolean,container?:object,remaining:number,tried:object[],candidate?:object,reason?:string,candidates?:object[]}>}
 */
async function suggestNarrowing(client, sessionId, spec, opts) {
  const o = opts || {};
  const collectFn = typeof o.collectFn === 'function'
    ? o.collectFn
    : (s) => collectCandidates(client, sessionId, s, o);
  const base = await collectFn(normalizeSpec(spec) || spec);
  const baseCands = (base && base.candidates) || [];
  const u0 = uniqueness(baseCands);
  if (u0.clickable === 1) {
    return { ok: true, container: null, remaining: 1, tried: [], candidate: u0.best, candidates: baseCands, note: '基础描述符已唯一可点，无需收窄' };
  }
  if (u0.clickable === 0) {
    return { ok: false, reason: 'no-clickable-candidate', remaining: 0, tried: [], candidates: baseCands, note: '零个 visible+hitOk 候选——先看 probe 的 visible/hitOk 明细（元素可能被遮罩/未展开）' };
  }
  const clickable = baseCands.filter(isClickable);
  const frames = new Set(clickable.map((c) => JSON.stringify(c.framePath || [])));
  if (frames.size > 1) {
    return { ok: false, reason: 'cross-frame', remaining: clickable.length, tried: [], candidates: baseCands,
      note: '多候选分布在不同 iframe：flow container 不支持跨 frame（contains 同文档）；先按 framePath 用 frame 步骤限定或改用唯一文本' };
  }
  // 共同祖先：按 cssPath 求交集，保留最近（depth 最小）→ 祖父级
  const maps = clickable.map((c) => {
    const m = new Map();
    for (const a of (c.ancestors || [])) if (a && a.cssPath) m.set(a.cssPath, a);
    return m;
  });
  let common = null;
  for (const m of maps) {
    if (common === null) { common = new Set(m.keys()); continue; }
    for (const k of [...common]) if (!m.has(k)) common.delete(k);
  }
  const levels = [];
  if (common && common.size) {
    const byPath = new Map();
    for (const m of maps) for (const [k, a] of m) if (common.has(k) && !byPath.has(k)) byPath.set(k, a);
    levels.push(...[...byPath.values()].sort((a, b) => (a.depth || 0) - (b.depth || 0)));
  }
  const tried = [];
  for (let i = 0; i < levels.length; i++) {
    const a = levels[i];
    if (a.tag === 'html' || a.tag === 'body') continue; // 根级容器无区分度（2026-10-19 实弹：主按钮与菜单项分属不同子树，共同祖先仅 body/html）
    const container = ancestorContainer(a);
    if (!container) continue;
    let recount = null;
    let count = 0;
    let error = null;
    try {
      const s2 = Object.assign({}, normalizeSpec(spec) || spec, { container: container });
      recount = await collectFn(s2);
      count = uniqueness((recount && recount.candidates) || []).clickable;
      if (recount && recount.error) error = recount.error;
    } catch (e) {
      error = String((e && e.message) || e);
    }
    tried.push({ level: i + 1, depth: a.depth || i + 1, container: container, count: count, unique: count === 1, error: error || undefined,
      ancestor: { tag: a.tag, id: a.id, cls: a.cls, text: a.text, cssPath: a.cssPath } });
    if (count === 1) {
      const best = uniqueness((recount && recount.candidates) || []).best;
      return { ok: true, container: container, remaining: 1, tried: tried, candidate: best || null,
        candidates: (recount && recount.candidates) || [], ancestor: { tag: a.tag, id: a.id, cls: a.cls, text: a.text, cssPath: a.cssPath } };
    }
  }
  // 策略二（2026-10-19 实弹新增）：逐候选祖先链扫描——共同祖先无区分度（body/html）时，
  // 对每个候选的各级祖先试容器，容器内只剩 1 个可点即收窄（例：主按钮与菜单项同文本时，
  // 菜单项 a 的父 li 作为容器 → 容器内唯一 a）。
  for (const c of clickable) {
    for (const a of (c.ancestors || [])) {
      if (a.tag === 'html' || a.tag === 'body') continue;
      const container = ancestorContainer(a);
      if (!container) continue;
      let recount = null;
      let count = 0;
      let error = null;
      try {
        const s2 = Object.assign({}, normalizeSpec(spec) || spec, { container: container });
        recount = await collectFn(s2);
        count = uniqueness((recount && recount.candidates) || []).clickable;
        if (recount && recount.error) error = recount.error;
      } catch (e) { error = String((e && e.message) || e); }
      tried.push({ level: 'per-candidate', depth: a.depth || 0, container: container, count: count, unique: count === 1, error: error || undefined,
        ancestor: { tag: a.tag, id: a.id, cls: a.cls, text: a.text, cssPath: a.cssPath } });
      if (count === 1) {
        const best = uniqueness((recount && recount.candidates) || []).best;
        return { ok: true, container: container, remaining: 1, tried: tried, candidate: best || null,
          candidates: (recount && recount.candidates) || [], ancestor: { tag: a.tag, id: a.id, cls: a.cls, text: a.text, cssPath: a.cssPath },
          note: '共同祖先无区分度，改用候选自身祖先链收窄（策略二）' };
      }
    }
  }
  return { ok: false, reason: levels.length ? 'not-unique' : 'no-common-ancestor', remaining: clickable.length, tried: tried,
    candidates: baseCands, note: levels.length ? '共同祖先逐级收窄后仍多候选——改用 exact/兄弟唯一文本/更精确的父容器或 role' : '多候选无共同祖先（跨容器/跨子树）——改用 exact 或分别处理' };
}

/* ── 高亮 + 截图 ── */

function frameDescendCode(candidate) {
  const ix = Array.isArray(candidate && candidate.frameIndexPath) ? candidate.frameIndexPath : null;
  if (ix) {
    return ix.map((i) => `doc = (function(){ var fs = doc.querySelectorAll('iframe,frame'); return fs[${Number(i)}] && fs[${Number(i)}].contentDocument; })(); if (!doc) return null;`).join(' ');
  }
  const labels = Array.isArray(candidate && candidate.framePath) ? candidate.framePath : [];
  return labels.map((l) => `doc = (function(){ var fs = doc.querySelectorAll('iframe,frame'); for (var i = 0; i < fs.length; i++) { var f = fs[i]; var lb = f.name || f.id || String(f.tagName || 'iframe').toLowerCase(); if (lb === ${JSON.stringify(String(l))}) return f.contentDocument; } return null; })(); if (!doc) return null;`).join(' ');
}

function buildFindElementExpr(candidate) {
  const sel = String((candidate && candidate.cssPath) || '');
  if (!sel) return '(function(){ return null; })()';
  return `(function(){ var doc = document; ${frameDescendCode(candidate)} if (!doc) return null; try { return doc.querySelector(${JSON.stringify(sel)}); } catch(e) { return null; } })()`;
}

function buildOutlineScript(candidate, ms) {
  return `(function(){ var el = ${buildFindElementExpr(candidate)}; if (!el) return { ok: false };
    try {
      var prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
      el.__cu_locator_prev = prev;
      el.style.outline = '3px solid rgba(255,0,0,0.95)';
      el.style.outlineOffset = '2px';
      try { clearTimeout(el.__cu_locator_timer); } catch(e) {}
      el.__cu_locator_timer = setTimeout(function(){ try {
        if (el.__cu_locator_prev) { el.style.outline = el.__cu_locator_prev.outline; el.style.outlineOffset = el.__cu_locator_prev.outlineOffset; }
      } catch(e) {} }, ${Math.max(200, ms)});
      return { ok: true };
    } catch(e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
}

function buildOutlineRestoreScript(candidate) {
  return `(function(){ var el = ${buildFindElementExpr(candidate)}; if (!el) return false;
    try {
      try { clearTimeout(el.__cu_locator_timer); } catch(e) {}
      if (el.__cu_locator_prev) { el.style.outline = el.__cu_locator_prev.outline; el.style.outlineOffset = el.__cu_locator_prev.outlineOffset; }
      delete el.__cu_locator_prev; delete el.__cu_locator_timer;
    } catch(e) {}
    return true; })()`;
}

/**
 * 高亮候选并截图（视觉确认定位是否正确）。
 * 实现：优先 CDP Overlay.enable+highlightNode(objectId)（DevTools 式高亮）；同时临时加 CSS outline——
 *   Overlay 是合成器覆盖层，Page.captureScreenshot 不保证包含，outline 保证截图可见。ms 后自动还原。
 * 截图默认落 tmpdata/events/locator-<stamp>.png（复用 lib/screenshot.js 硬化通道）。
 * @returns {Promise<{ok:boolean,via:string|null,screenshot:string|null,ms:number,...}>}
 */
async function highlight(client, sessionId, candidate, opts) {
  const o = opts || {};
  const ms = Math.max(200, Math.min(Number.isFinite(o.ms) ? o.ms : 3000, 60000));
  const out = { ok: false, via: null, screenshot: null, ms: ms, candidate: stripAncestors(candidate) };
  const findExpr = buildFindElementExpr(candidate);
  let overlayOn = false;
  let overlayEnabled = false;
  let outlineOk = false;
  let objectId = null;
  try {
    try {
      const ev = await client.send('Runtime.evaluate', { expression: findExpr, returnByValue: false, objectGroup: 'chromeuse-locator' }, { sessionId });
      if (!ev.exceptionDetails && ev.result && ev.result.objectId) objectId = ev.result.objectId;
    } catch (e) { /* Overlay 不可用 → outline 兜底 */ }
    if (objectId) {
      try {
        await client.send('Overlay.enable', {}, { sessionId });
        overlayEnabled = true;
        await client.send('Overlay.highlightNode', {
          objectId: objectId,
          highlightConfig: {
            showInfo: true,
            contentColor: { r: 0, g: 255, b: 0, a: 0.25 },
            borderColor: { r: 0, g: 255, b: 0, a: 1 },
          },
        }, { sessionId });
        overlayOn = true;
      } catch (e) { overlayOn = false; }
    }
    try {
      const r = await client.send('Runtime.evaluate', { expression: buildOutlineScript(candidate, ms), returnByValue: true }, { sessionId });
      outlineOk = !!(r && r.result && r.result.value && r.result.value.ok);
    } catch (e) { outlineOk = false; }
    out.via = overlayOn && outlineOk ? 'overlay+outline' : (outlineOk ? 'outline' : (overlayOn ? 'overlay' : null));
    out.ok = overlayOn || outlineOk;
    if (!out.ok) out.error = '元素未找到或不可高亮（cssPath/framePath 可能已漂移）';
    if (o.screenshot !== false) {
      await sleep(250); // 给合成器一帧绘制时间
      try {
        const shot = require('./screenshot');
        const r = await shot.screenshotHardened(client, sessionId, { timeoutMs: (o.timeoutMs || 8000) });
        const file = o.out || path.join(paths.EVENTS_DIR, `locator-${time.formatStamp()}.png`);
        paths.ensureDir(path.dirname(file));
        const buf = Buffer.from(r.data, 'base64');
        fs.writeFileSync(file, buf);
        out.screenshot = file;
        out.screenshotVia = r.via;
        out.screenshotBytes = buf.length;
      } catch (e) { out.screenshotError = String((e && e.message) || e); }
    }
    const spent = o.screenshot === false ? 0 : 250;
    if (ms - spent > 0) await sleep(ms - spent);
    return out;
  } finally {
    try {
      await client.send('Runtime.evaluate', { expression: buildOutlineRestoreScript(candidate), returnByValue: true }, { sessionId, timeoutMs: 1000 });
    } catch (e) { /* 页面可能已导航 */ }
    if (overlayEnabled) {
      try { if (overlayOn) await client.send('Overlay.hideHighlight', {}, { sessionId, timeoutMs: 1000 }); } catch (e) { /* noop */ }
      try { await client.send('Overlay.disable', {}, { sessionId, timeoutMs: 1000 }); } catch (e) { /* noop */ }
    }
  }
}

function stripAncestors(c) {
  if (!c || typeof c !== 'object') return c;
  const o = Object.assign({}, c);
  delete o.ancestors;
  return o;
}

/* ── 拾取器 ── */

/**
 * 页面侧拾取器脚本（注入后一次性 capture-phase click 监听，拾取即自摘）。
 * - 递归安装到全部同源 iframe 文档（点击子 frame 内元素也可拾取；framePath 由 frameElement 链动态计算）；
 * - 拾取结果写 window.top.__cu_pick_result（同时兼容本窗口）；
 * - block=true（默认）时 preventDefault+stopPropagation，点击不触发业务动作；
 * - autoTeardownMs 为页侧安全兜底（Node 侧超时仍为主控）。
 * @param {{block?:boolean, autoTeardownMs?:number}} [opts]
 */
function buildPickerScript(opts) {
  const o = Object.assign({ block: true, autoTeardownMs: 65000 }, opts || {});
  return `(function(){
    var OPT = ${JSON.stringify(o)};
    var W = window;
    try { if (W.top && W.top.__cu_picker_installed) return 'already-installed'; } catch(e) {}
    ${frameLabel.toString()}
    ${ownText.toString()}
    ${fullText.toString()}
    ${roleOf.toString()}
    ${classOf.toString()}
    ${cssPathOf.toString()}
    function absRect(el, r){
      var x = r.left, y = r.top, doc = el.ownerDocument;
      while (doc && doc.defaultView && doc.defaultView.frameElement) {
        var fe = doc.defaultView.frameElement; var fr = fe.getBoundingClientRect();
        x += fr.left; y += fr.top; doc = fe.ownerDocument;
      }
      return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function framePathOf(doc){
      var fp = []; var d = doc;
      while (d && d.defaultView && d.defaultView.frameElement) {
        var fe = d.defaultView.frameElement;
        fp.unshift(frameLabel(fe));
        d = fe.ownerDocument;
      }
      return fp;
    }
    var docs = [];
    var timer = null;
    function uninstall(){
      for (var i = 0; i < docs.length; i++) {
        try { docs[i].doc.removeEventListener('click', onClick, true); } catch(e) {}
      }
      docs.length = 0;
      if (timer) { try { clearTimeout(timer); } catch(e) {} timer = null; }
      try { W.top.__cu_picker_installed = false; } catch(e) { W.__cu_picker_installed = false; }
      try { W.top.__cu_picker_teardown = null; } catch(e) {}
    }
    function onClick(ev){
      try {
        var el = ev.target;
        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        var res = {
          text: String(ownText(el) || fullText(el) || '').slice(0, 120),
          role: roleOf(el),
          cssPath: cssPathOf(el),
          framePath: framePathOf(el.ownerDocument),
          rect: absRect(el, r),
          localRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          tag: String(el.tagName || '').toLowerCase(),
          id: el.id || '',
          cls: classOf(el),
          ts: Date.now()
        };
        try { W.top.__cu_pick_result = res; } catch(e) { W.__cu_pick_result = res; }
        uninstall();
        if (OPT.block) {
          try { ev.preventDefault(); } catch(e) {}
          try { ev.stopPropagation(); } catch(e) {}
        }
      } catch(e) {
        try { W.top.__cu_pick_result = { error: String(e && e.message || e), ts: Date.now() }; } catch(e2) {}
        uninstall();
      }
    }
    function install(doc){
      if (!doc) return;
      for (var i = 0; i < docs.length; i++) if (docs[i].doc === doc) return;
      docs.push({ doc: doc });
      doc.addEventListener('click', onClick, true);
      var fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
      for (var j = 0; j < fr.length; j++) {
        var inner = null; try { inner = fr[j].contentDocument; } catch(e) {}
        if (inner) install(inner);
      }
    }
    try { W.top.__cu_pick_result = null; } catch(e) { W.__cu_pick_result = null; }
    try { W.top.__cu_picker_installed = true; } catch(e) { W.__cu_picker_installed = true; }
    try { W.top.__cu_picker_teardown = uninstall; } catch(e) {}
    install(document);
    if (OPT.autoTeardownMs > 0) timer = setTimeout(uninstall, OPT.autoTeardownMs);
    return 'installed';
  })()`;
}

/** 拾取器摘除脚本（Node 侧超时/收尾；幂等） */
function buildPickerTeardownScript() {
  return `(function(){ try { var t = window.top || window; if (t && typeof t.__cu_picker_teardown === 'function') { t.__cu_picker_teardown(); return 'torn-down'; } } catch(e) {
    try { if (window && typeof window.__cu_picker_teardown === 'function') { window.__cu_picker_teardown(); return 'torn-down'; } } catch(e2) {}
  } return 'not-installed'; })()`;
}

/**
 * 拾取结果 → flow target JSON。优先 text+match exact（唯一时）；否则 role；否则 domPath + frame 提示。
 * @param {object} picked buildPickerScript 写入的 __cu_pick_result
 * @param {{unique?:boolean}} [opts]
 * @returns {{target:object|null, notes:string[]}}
 */
function toTargetSpec(picked, opts) {
  const p = picked || {};
  const o = opts || {};
  const notes = [];
  const framePath = Array.isArray(p.framePath) ? p.framePath : [];
  if (framePath.length) {
    notes.push(`元素位于 iframe 链 main>${framePath.join('>')}：flow 可先在步骤前用 frame 进入该链；text 定位本身跨同源 frame 扫描，container 不支持跨 frame。`);
  }
  const text = String(p.text || '').trim();
  if (text && o.unique !== false) {
    return { target: { text: text, match: 'exact' }, notes: notes };
  }
  if (p.role) {
    if (text) notes.push(`文本非唯一或未确认唯一（text="${text}"）→ 回退 role；建议用 locator suggest 收窄。`);
    else notes.push('无可见文本 → 回退 role；role 仍可能多候选，建议配合 container。');
    return { target: { role: String(p.role) }, notes: notes };
  }
  const cssPath = String(p.cssPath || '').trim();
  if (cssPath) {
    notes.push('无文本/role → 回退 domPath（仅作品参考；CSS 路径是所在文档内路径，跨 frame 需先 frame 进入）。');
    return { target: { domPath: cssPath }, notes: notes };
  }
  return { target: null, notes: notes.concat(['拾取结果缺少可转换的定位锚（text/role/cssPath 均为空）']) };
}

module.exports = {
  DEFAULT_MAX_CANDIDATES, DEFAULT_TIMEOUT_MS,
  // 页面侧纯函数（单元测试/注入源）
  frameLabel, ownText, fullText, roleOf, classOf, interactState, interactabilityVerdict, cssPathOf,
  // 收集与判定
  buildCollectExpr, normalizeSpec, collectCandidates, isClickable, uniqueness, rankCandidates,
  // 命中被挡取证（B4/R2 #103）
  buildHitBlockedExpr, collectHitBlockedEvidence,
  // 收窄
  suggestNarrowing, ancestorContainer, targetFromSpec,
  // 高亮
  highlight, buildFindElementExpr,
  // 拾取
  buildPickerScript, buildPickerTeardownScript, toTargetSpec,
  // 辅助
  stripAncestors,
};
