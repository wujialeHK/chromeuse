'use strict';
/*
 * chromeuse lib/popup-guard.js —— 广告/推广弹窗拦截体系（popup-guard，李跳跳式）P1 规则层 + guard 脚本生成器
 * （V202610150003；方案= TODO.md【广告/推广弹窗拦截体系（popup-guard，李跳跳式，2026-10-15 用户提出）】四路线之 A）
 *
 * 定位：**DOM 层 MutationObserver 守卫**（李跳跳式直译）——guard 脚本经
 * Page.addScriptToEvaluateOnNewDocument 预埋（先于页面 JS 运行）+ 对已加载页面即时执行一次；
 * 新节点按规则 anyOf 匹配 → action=remove（el.remove()）/ hide（style.display='none'，保留 DOM 供误杀排查）。
 *
 * 红线（硬约束，selftest #77 源断言守护）：
 *  - 只做 DOM 清理——**零合成事件**（不点击/不派发事件/不调用 el.click()），零网络层拦截（B 路线属 P3）；
 *  - 现场还原：注入必须配对清理（replay finally / cdp.js popup-guard off）——移除脚本注册 + 页侧 observer.disconnect()。
 *
 * 规则形态（JSONC，规则库双层）：
 *   { id, match: { anyOf: [ {selector} | {textContains} | {rect:{minW,minH}, zIndexMin} ] },
 *     action: "remove"|"hide", scope: "host[:port][/pathPrefix]", evidence: true }
 *   - anyOf 语义：任一 entry 命中即规则命中；单 entry 内 selector/textContains/rect/zIndexMin 同时给出 = 与（AND）；
 *   - scope 复用 lib/matchers.js 分段锚定语义（页侧为该语义的镜像实现，见 PAGE_UTIL.scopeHit），
 *     缺省/非法 scope = 不生效（保守：宁可少拦不误杀）。
 *
 * 规则库双层（2026-10-15 用户裁定加载语义）：
 *   - webapp **无**配置文件 → 使用全局 config/popup-rules.jsonc；
 *   - webapp **有**配置文件 → **以 webapp 配置整体为准（不与全局合并）**。
 *   （loadRules 单点实现；--popup-rules <file> 显式文件则跳过二者——loadRulesFromFile）
 *
 * 留痕：页侧 window.__cu_pg_log 数组（{ruleId, action, tag, cls, text, ts}，上限 200 防膨胀）；
 *       dry-run（test 模式）只记录不动作，entry 带 dryRun:true。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { parse } = require('./jsonc');
const matchers = require('./matchers');

const MAX_LOG = 200;                       // 页侧留痕上限（防膨胀）
const MAX_SCAN_HITS = 100;                 // scan 模式候选上限
const GLOBAL_RULES_REL = path.join('config', 'popup-rules.jsonc');
const APP_RULES_NAME = 'popup-rules.jsonc';
const ACTIONS = ['remove', 'hide'];

/** 页侧清理表达式（replay finally / cdp.js off 共用单源；尽力而为，绝不影响主流程） */
const TEARDOWN_SRC = "(function(){try{var w=window;if(w.__cu_pg_stop){w.__cu_pg_stop();}try{delete w.__cu_pg_log;delete w.__cu_pg_stop;delete w.__cu_pg_installed;delete w.__cu_pg_stopped;}catch(e){}}catch(e){}})()";

/* ─────────────── 规则归一与校验（Node 侧） ─────────────── */

/** anyOf entry 归一：只保留已知键（未知键静默丢弃），非法整条丢弃 */
function normalizeAnyOf(match) {
  const raw = (match && Array.isArray(match.anyOf)) ? match.anyOf
    : (match && typeof match === 'object' ? [match] : []);
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const entry = {};
    if (typeof c.selector === 'string' && c.selector.trim()) entry.selector = c.selector.trim();
    if (typeof c.textContains === 'string' && c.textContains) entry.textContains = c.textContains;
    if (c.rect && typeof c.rect === 'object') {
      const rect = {};
      if (Number.isFinite(c.rect.minW) && c.rect.minW >= 0) rect.minW = c.rect.minW;
      if (Number.isFinite(c.rect.minH) && c.rect.minH >= 0) rect.minH = c.rect.minH;
      if (Object.keys(rect).length) entry.rect = rect;
    }
    if (Number.isFinite(c.zIndexMin)) entry.zIndexMin = c.zIndexMin;
    if (Object.keys(entry).length) out.push(entry);
  }
  return out;
}

/** 规则归一（丢非法项；id 缺省 rule#N；action 非 remove|hide 丢弃；anyOf 空丢弃） */
function normalizeRules(rules) {
  const out = [];
  const list = Array.isArray(rules) ? rules : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object') continue;
    const id = (typeof r.id === 'string' && r.id.trim()) ? r.id.trim() : `rule#${i + 1}`;
    const action = ACTIONS.includes(r.action) ? r.action : null;
    if (!action) continue;
    const anyOf = normalizeAnyOf(r.match);
    if (!anyOf.length) continue;
    out.push({
      id,
      action,
      scope: (typeof r.scope === 'string' && r.scope.trim()) ? r.scope.trim() : null,
      evidence: r.evidence !== false,
      match: { anyOf },
    });
  }
  return out;
}

/** 规则校验（机器可读错误清单；selftest #77 / 规则库 authoring 用） */
function collectRuleIssues(rules) {
  const issues = [];
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length) issues.push('rules 为空数组（至少一条规则）');
  const seen = new Set();
  list.forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object') { issues.push(`${at} 非对象`); return; }
    if (typeof r.id !== 'string' || !r.id.trim()) issues.push(`${at} 缺 id`);
    else if (seen.has(r.id)) issues.push(`${at} id 重复：${r.id}`);
    else seen.add(r.id);
    if (!ACTIONS.includes(r.action)) issues.push(`${at} action 须为 remove|hide（got ${JSON.stringify(r.action)}）`);
    if (r.scope !== undefined && r.scope !== null) { // null/undefined = 缺省（全局生效），非错误
      if (typeof r.scope !== 'string' || !matchers.parsePattern(r.scope).ok) issues.push(`${at} scope 非法：${JSON.stringify(r.scope)}（分段锚定 host[:port][/pathPrefix]）`);
    }
    const anyOf = normalizeAnyOf(r.match);
    if (!anyOf.length) issues.push(`${at} match.anyOf 无非空单元（{selector}|{textContains}|{rect:{minW,minH},zIndexMin}）`);
  });
  return issues;
}

/** 按 URL 过滤规则（scope 缺省=全局生效；scope 非法/不匹配=不收窄不生效——与页侧同语义） */
function filterRulesByUrl(rules, url) {
  return normalizeRules(rules).filter((r) => (!r.scope ? true : matchers.matchUrl([r.scope], url).matched));
}

/* ─────────────── 规则文件读取（JSONC） ─────────────── */

/** 读单个规则文件：接受 {rules:[...]} 或裸数组；文件缺失/解析失败 → {ok:false,error} */
function readRulesFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, file, error: `规则文件不存在/不可读：${file}` }; }
  let obj = null;
  try { obj = parse(text); }
  catch (e) { return { ok: false, file, error: `规则文件 JSONC 解析失败：${e.message}` }; }
  const raw = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.rules) ? obj.rules : null);
  if (!raw) return { ok: false, file, error: `规则文件结构非法：须为 {rules:[...]} 或裸数组（${file}）` };
  return { ok: true, file, rules: normalizeRules(raw) };
}

/**
 * 双层规则库加载（2026-10-15 用户裁定语义，单点实现）：
 *   webapp 无配置文件 → 全局；webapp 有配置文件 → 以 webapp 配置整体为准（不合并）。
 * 返回 {ok, source:'app'|'global'|'none', file, rules, globalFile, ignoredGlobal?}
 */
function loadRules(opts) {
  const o = opts || {};
  const root = o.projectDir || paths.SKILL_ROOT;
  const globalFile = path.join(root, GLOBAL_RULES_REL);
  const g = readRulesFile(globalFile);
  const appFile = o.appSlug ? path.join(root, 'webapps', String(o.appSlug), APP_RULES_NAME) : null;
  if (appFile && fs.existsSync(appFile)) {
    const a = readRulesFile(appFile);
    if (a.ok) return { ok: true, source: 'app', file: appFile, rules: a.rules, globalFile, ignoredGlobal: true };
    // app 配置存在但坏 → 如实报错，不静默回落全局（宁可不注入也不误用规则）
    return { ok: false, source: 'app', file: appFile, rules: [], globalFile, error: a.error };
  }
  if (g.ok) return { ok: true, source: 'global', file: globalFile, rules: g.rules, globalFile };
  return { ok: false, source: 'none', file: appFile || globalFile, rules: [], globalFile, error: g.error || '未找到任何规则文件' };
}

/** 显式规则文件（--popup-rules <file>；跳过 app/全局加载） */
function loadRulesFromFile(file) {
  const r = readRulesFile(String(file || ''));
  return r.ok
    ? { ok: true, source: 'explicit', file: r.file, rules: r.rules }
    : { ok: false, source: 'explicit', file: r.file, rules: [], error: r.error };
}

/** 规则集摘要（scan 报告 / 启用日志用） */
function compileRuleSummary(rules) {
  const norm = normalizeRules(rules);
  let remove = 0, hide = 0, scoped = 0;
  const ids = [];
  const detail = norm.map((r) => {
    if (r.action === 'remove') remove++; else hide++;
    if (r.scope) scoped++;
    ids.push(r.id);
    const kinds = [];
    for (const c of r.match.anyOf) {
      if (c.selector) kinds.push('selector');
      if (c.textContains) kinds.push('textContains');
      if (c.rect) kinds.push(`rect>=${c.rect.minW || 0}x${c.rect.minH || 0}`);
      if (c.zIndexMin !== undefined) kinds.push(`z>=${c.zIndexMin}`);
    }
    return { id: r.id, action: r.action, scope: r.scope, kinds };
  });
  return { total: norm.length, remove, hide, scoped, ids, rules: detail };
}

/** 拦截留痕归并（window.__cu_pg_log → {count, byRule}） */
function summarizeLog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byRule = {};
  for (const e of list) {
    const id = (e && e.ruleId) ? String(e.ruleId) : '(unknown)';
    byRule[id] = (byRule[id] || 0) + 1;
  }
  return { count: list.length, byRule };
}

/* ─────────────── 页侧脚本（函数即源码：toString 生成，避免模板转义失误） ─────────────── */

/** 页侧共享工具（matchers 分段锚定语义的页内镜像 + 规则匹配；被 guard/scan 两个脚本复用） */
function PAGE_UTIL() {
  'use strict';
  function normUrl(url) {
    var u = String(url || '').split('#')[0];
    var q = u.indexOf('?');
    if (q > -1) u = u.slice(0, q);
    var m = /^([a-z][a-z0-9+.-]*:)?(\/\/)?([^/?#]+)(\/.*)?$/i.exec(u);
    if (!m) return null;
    var authority = m[3];
    var port = null;
    var hi = authority.lastIndexOf(':');
    if (hi > -1 && /^\d{1,5}$/.test(authority.slice(hi + 1))) { port = parseInt(authority.slice(hi + 1), 10); authority = authority.slice(0, hi); }
    var scheme = (m[1] || 'http:').toLowerCase();
    if (port === null) port = scheme === 'https:' ? 443 : 80;
    var p = m[4] || '/';
    if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
    return { host: authority.toLowerCase(), port: port, path: p };
  }
  function parseScope(raw) {
    var s = String(raw || '').trim();
    var m = /^([^/]+)(\/.*)?$/.exec(s);
    if (!m) return { ok: false };
    var host = m[1];
    var port = null;
    var pi = host.lastIndexOf(':');
    if (pi > -1) {
      var seg = host.slice(pi + 1);
      if (!/^\d{1,5}$/.test(seg)) return { ok: false };
      port = parseInt(seg, 10);
      host = host.slice(0, pi);
    }
    var segments = host.split('.');
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] === '*' || /^[a-z0-9-]+$/i.test(segments[i])) continue;
      return { ok: false };
    }
    var pathSegments = [];
    if (m[2]) {
      var ps = m[2].replace(/^\/+/, '').replace(/\/+$/, '');
      if (!ps) return { ok: false };
      pathSegments = ps.split('/');
      for (var k = 0; k < pathSegments.length; k++) if (!pathSegments[k]) return { ok: false };
    }
    return { ok: true, hostAny: host === '*', hostSegments: segments, port: port, pathSegments: pathSegments };
  }
  function scopeHit(pat, u) {
    if (!pat || !pat.ok || !u) return false;
    if (!pat.hostAny) {
      var segs = u.host.split('.');
      if (segs.length !== pat.hostSegments.length) return false;
      for (var i = 0; i < segs.length; i++) {
        if (pat.hostSegments[i] === '*') continue;
        if (pat.hostSegments[i].toLowerCase() !== segs[i]) return false;
      }
    }
    if (pat.port !== null && u.port !== null && pat.port !== u.port) return false;
    if (pat.pathSegments && pat.pathSegments.length) {
      var usegs = u.path === '/' ? [] : u.path.slice(1).split('/');
      if (usegs.length < pat.pathSegments.length) return false;
      for (var j = 0; j < pat.pathSegments.length; j++) if (usegs[j].toLowerCase() !== pat.pathSegments[j].toLowerCase()) return false;
    }
    return true;
  }
  function clsOf(el) {
    try {
      if (typeof el.className === 'string') return el.className;
      var a = el.getAttribute ? el.getAttribute('class') : '';
      return a ? String(a) : '';
    } catch (e) { return ''; }
  }
  function txtOf(el) {
    try { return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
    catch (e) { return ''; }
  }
  function zIndexOf(el) {
    var z = 0;
    try {
      var cs = getComputedStyle(el);
      z = parseInt(cs && cs.zIndex, 10);
      if (!isFinite(z)) z = 0;
    } catch (e) { z = 0; }
    return z;
  }
  function buildRules(rules) {
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var pat = null;
      if (r.scope) { var p = parseScope(r.scope); pat = (p && p.ok) ? p : null; }
      out.push({ id: r.id, action: r.action, evidence: r.evidence !== false, match: r.match, pat: pat, scopeRaw: r.scope || null });
    }
    return out;
  }
  function ruleApplies(rule, url) {
    if (!rule.scopeRaw) return true;
    if (!rule.pat) return false; // scope 非法 → 不收窄（保守：不生效）
    return scopeHit(rule.pat, normUrl(url));
  }
  function matchRule(rule, el) {
    var list = (rule.match && rule.match.anyOf) || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      /* 单 entry 内多键 = 与（AND）：所有给出的条件全真才命中该 entry；
       * anyOf 之间仍为或（OR，任一 entry 命中即规则命中）。 */
      var conds = 0;
      if (c.selector) conds++;
      if (c.textContains) conds++;
      if (c.rect || c.zIndexMin !== undefined) conds++;
      var ok = true;
      if (ok && c.selector) {
        var selOk = false;
        try { selOk = !!(el.matches && el.matches(c.selector)); } catch (e) { /* 非法选择器=该条件不成立 */ }
        if (!selOk) ok = false;
      }
      if (ok && c.textContains) {
        var t = '';
        try { t = String(el.textContent || ''); } catch (e) { t = ''; }
        if (t.indexOf(c.textContains) < 0) ok = false;
      }
      if (ok && (c.rect || c.zIndexMin !== undefined)) {
        if (c.rect) {
          var r = null;
          try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
          if (!r) ok = false;
          else {
            if (c.rect.minW !== undefined && r.width < c.rect.minW) ok = false;
            if (c.rect.minH !== undefined && r.height < c.rect.minH) ok = false;
          }
        }
        if (ok && c.zIndexMin !== undefined && zIndexOf(el) < c.zIndexMin) ok = false;
      }
      if (ok && conds > 0) return true;
    }
    return false;
  }
  return {
    normUrl: normUrl, parseScope: parseScope, scopeHit: scopeHit, clsOf: clsOf, txtOf: txtOf,
    zIndexOf: zIndexOf, buildRules: buildRules, ruleApplies: ruleApplies, matchRule: matchRule,
  };
}

/** 页侧 guard 主脚本（IIFE 体；用 addScriptToEvaluateOnNewDocument 预埋 或 Runtime.evaluate 即时执行） */
function PAGE_MAIN(CFG, U_FACTORY) {
  'use strict';
  var U = U_FACTORY();
  var W = window;
  if (W.__cu_pg_installed) return;
  var LOG = W.__cu_pg_log || (W.__cu_pg_log = []);
  var MAX = CFG.maxLog || 200;
  var SKIP = { HTML: 1, BODY: 1, HEAD: 1 };
  var RULES = U.buildRules(CFG.rules || []);
  function pushEntry(e) {
    try {
      if (LOG.length >= MAX) LOG.splice(0, LOG.length - MAX + 1);
      LOG.push(e);
    } catch (err) { /* 留痕失败绝不阻断 */ }
  }
  function act(rule, el, tag) {
    try { if (el && el.getAttribute && el.getAttribute('data-cu-pg-hidden')) return; } catch (err) { /* 已处置元素跳过（去重，2026-10-20 实弹：同一元素被 observer 多批次重复记录） */ }
    if (rule.evidence || CFG.dryRun) {
      pushEntry({
        ruleId: rule.id, action: rule.action, tag: tag, cls: U.clsOf(el).slice(0, 80),
        text: U.txtOf(el), ts: Date.now(), dryRun: !!CFG.dryRun,
      });
    }
    if (CFG.dryRun) return; // dry-run：只记录不动作（误杀检验）
    try {
      if (rule.action === 'remove') {
        if (el.remove) el.remove();
        else if (el.parentNode) el.parentNode.removeChild(el);
      } else {
        el.style.display = 'none';
        if (el.setAttribute) el.setAttribute('data-cu-pg-hidden', rule.id);
      }
    } catch (err) { /* 动作失败不阻断其他节点 */ }
  }
  function check(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (SKIP[tag]) return false; // 页面根节点永不处置
    for (var i = 0; i < RULES.length; i++) {
      var rule = RULES[i];
      if (!U.ruleApplies(rule, String(location.href))) continue;
      if (!U.matchRule(rule, el)) continue;
      act(rule, el, tag.toLowerCase());
      return true;
    }
    return false;
  }
  function sweep(root) {
    if (!root) return;
    if (check(root)) return; // 根已处置：子树随移除/隐藏失效
    var list = [];
    try { list = root.querySelectorAll ? root.querySelectorAll('*') : []; } catch (err) { list = []; }
    for (var i = 0; i < list.length; i++) check(list[i]);
  }
  var observer = null;
  W.__cu_pg_stop = function () {
    try { if (observer) observer.disconnect(); } catch (err) { /* 尽力而为 */ }
    W.__cu_pg_installed = false;
    W.__cu_pg_stopped = true;
    return true;
  };
  W.__cu_pg_installed = true;
  W.__cu_pg_stopped = false;
  try { sweep(document.documentElement || document); } catch (err) { /* 存量扫描 fail-soft */ }
  try {
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (!m || !m.addedNodes || !m.addedNodes.length) continue;
        for (var j = 0; j < m.addedNodes.length; j++) sweep(m.addedNodes[j]);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  } catch (err) { /* 观察器不可用 → 只剩一次性扫描 */ }
}

/** 页侧只读扫描脚本（scan 模式）：返回 JSON 字符串，不改 DOM、不装 observer */
function PAGE_SCAN(CFG, U_FACTORY) {
  'use strict';
  var U = U_FACTORY();
  var MAX_HITS = CFG.maxHits || 100;
  var RULES = U.buildRules(CFG.rules || []);
  var url = String(location.href);
  var hits = [];
  var scanned = 0;
  var all = [];
  try { all = document.querySelectorAll ? document.querySelectorAll('*') : []; } catch (err) { all = []; }
  for (var i = 0; i < all.length && hits.length < MAX_HITS; i++) {
    var el = all[i];
    scanned++;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD') continue;
    for (var j = 0; j < RULES.length; j++) {
      var rule = RULES[j];
      if (!U.ruleApplies(rule, url)) continue;
      if (!U.matchRule(rule, el)) continue;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (err) { r = null; }
      hits.push({
        ruleId: rule.id, action: rule.action, tag: tag.toLowerCase(), cls: U.clsOf(el).slice(0, 80),
        text: U.txtOf(el), zIndex: U.zIndexOf(el),
        rect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      });
      break;
    }
  }
  return JSON.stringify({ url: url, scanned: scanned, rules: RULES.length, hits: hits, truncated: hits.length >= MAX_HITS });
}

function jsLiteral(obj) {
  // 直嵌 JSON 字面量（转义 U+2028/U+2029，防旧解析器断句）
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * guard 页面脚本生成器：产出可直接被 Page.addScriptToEvaluateOnNewDocument 注入的 JS 文本
 * （IIFE，先于页面 JS 运行；同一文本也可用于 Runtime.evaluate 对已加载页面即时执行）。
 * @param {Array} rules 规则集（normalizeRules 归一）
 * @param {{dryRun?:boolean, maxLog?:number}} [opts] dryRun=true 时只记录不动作
 */
function buildGuardScript(rules, opts) {
  const o = opts || {};
  const cfg = { maxLog: Number.isFinite(o.maxLog) ? o.maxLog : MAX_LOG, dryRun: !!o.dryRun, rules: normalizeRules(rules) };
  return `(${PAGE_MAIN.toString()})(${jsLiteral(cfg)}, ${PAGE_UTIL.toString()});`;
}

/** scan 页面脚本生成器（只读取证；返回值 = JSON 字符串） */
function buildScanScript(rules, opts) {
  const o = opts || {};
  const cfg = { maxHits: Number.isFinite(o.maxHits) ? o.maxHits : MAX_SCAN_HITS, rules: normalizeRules(rules) };
  return `(${PAGE_SCAN.toString()})(${jsLiteral(cfg)}, ${PAGE_UTIL.toString()})`;
}

module.exports = {
  MAX_LOG, MAX_SCAN_HITS, GLOBAL_RULES_REL, APP_RULES_NAME, ACTIONS, TEARDOWN_SRC,
  normalizeRules, normalizeAnyOf, collectRuleIssues, filterRulesByUrl,
  readRulesFile, loadRules, loadRulesFromFile, compileRuleSummary, summarizeLog,
  buildGuardScript, buildScanScript, PAGE_UTIL,
};
