'use strict';
/*
 * chromeuse lib/challenge.js —— bot challenge（人机验证墙）识别与止损单源（C4 #124，V20261113004）
 *
 * 用户裁定语义（2026-11-13，TODO【bot challenge 识别与止损】）：
 *   默认 = 安全优先：检测到 challenge → **阻断操作 + 诚实红**（exit 1，码 E_POLICY_DENIED，消息前缀
 *   CHALLENGE_DETECTED）+ 接管提示；`--allow-challenge` = 效率优先：不阻断仅提醒（exit 0）——供
 *   「人要 agent 连续自主执行、不被打断」场景显式舍弃保护。
 *   Browse 铁律：**禁自解**（不点/不猜/不绕验证控件）、**禁连环重试**（同一命令重跑不会通过）；
 *   CF 类非交互盾允许一次性有限自愈等待（默认 15s=Browse 先例，每 800ms 重检），等待后仍命中按上述语义处置。
 *
 * 检测面（多信号合取防误报）：五类信号 = title / body 文本 / DOM 特征选择器 / Cookie 名 / 页侧全局变量。
 *   单墙（wall）命中 ≥ minSignals（默认 2）类**不同**信号才判定——「页面恰好含单特征串」负样本零触发。
 *   特征表 WALLS 数据化单点（热修只改表，不散落代码）：Cloudflare / Akamai / DataDome / PerimeterX /
 *   Imperva / AWS WAF / 通用 captcha 墙 / access denied 页（六墙+captcha+拒绝页，共 8 条）。
 *
 * 边界如实（R10）：特征对抗本质——漏报不承诺全拦（自建/冷门盾不在表内即不识别）；误报面=正常内容页
 *   同时命中两类特征（如教程页标题含 captcha + 正文引「verify you are human」）——逃逸=`--allow-challenge`
 *   或热修特征表；不做跨命令状态文件（短连接模型，命令级即止）。
 *   Cookie 面走 Network.getAllCookies（含 httpOnly，如 cf_clearance）：失败 fail-soft 降级为无 Cookie 信号
 *   （少一类信号=更难判定，安全侧偏漏报不误拦）。响应头指纹（cf-ray 等）CDP Page.navigate 不回传，未纳入。
 */

const time = require('./time');

const DEFAULT_WAIT_MS = 15000;
const WAIT_MS_MAX = 60000;
const WAIT_POLL_MS = 800;
const DEFAULT_MIN_SIGNALS = 2;
const TEXT_MAX = 6000;
const TITLE_MAX = 200;
const READY_POLL_MS = 200;
const READY_DEFAULT_MS = 8000;

/* ── 特征表（数据化单点；热修只改本表。顺序=同分 tie-break 优先级） ──
 * autoWait=true 的墙=非交互式 JS 盾（有限自愈等待有意义）；交互式（按住/点选/验证码）不等待（白等=浪费预算）。 */
const WALLS = Object.freeze([
  {
    id: 'cloudflare', label: 'Cloudflare', autoWait: true,
    title: [/just a moment/i, /attention required/i, /^cloudflare$/i],
    text: [/checking your browser/i, /verify you are human/i, /enable javascript and cookies to continue/i, /attention required!?\s*\|?\s*cloudflare/i, /cf-error-details/i, /ray id:/i],
    dom: ['#challenge-form', '#cf-challenge-running', '.cf-browser-verification', '#cf-wrapper', '.cf-error-code', 'script[src*="/cdn-cgi/challenge-platform/"]'],
    cookies: [/^cf_clearance$/i, /^__cf_bm$/i, /^cf_chl_/i, /^__cflb$/i],
    globals: ['__cf_chl_opt', '__cf_chl_ctx'],
  },
  {
    id: 'akamai', label: 'Akamai Bot Manager', autoWait: true,
    title: [/access denied/i, /akamai/i],
    text: [/reference #\d/i, /akamai bot manager/i, /you don't have permission to access/i, /access denied/i],
    dom: ['#akamai-challenge', 'script[src*="/akam/"]', 'iframe[src*="akamai"]'],
    cookies: [/^ak_bmsc$/i, /^_abck$/i, /^bm_sv$/i, /^bm_sz$/i],
    globals: [],
  },
  {
    id: 'datadome', label: 'DataDome', autoWait: false,
    title: [/datadome/i, /access denied/i],
    text: [/datadome/i, /geo\.captcha-delivery\.com/i, /please enable cookies/i],
    dom: ['#datadome-captcha', 'iframe[src*="captcha-delivery.com"]', 'script[src*="datadome"]'],
    cookies: [/^datadome$/i],
    globals: [],
  },
  {
    id: 'perimeterx', label: 'PerimeterX (HUMAN)', autoWait: false,
    title: [/perimeterx/i, /access to this page has been denied/i, /before we continue/i],
    text: [/perimeterx/i, /press & hold/i, /please verify you are a human/i, /access to this page has been denied/i],
    dom: ['#px-captcha', 'script[src*="perimeterx"]', 'script[src*="px-cdn"]'],
    cookies: [/^_px/i, /^pxcts$/i],
    globals: ['_pxAppIds', '_pxUserValues'],
  },
  {
    id: 'imperva', label: 'Imperva (Incapsula)', autoWait: true,
    title: [/imperva/i, /incapsula/i, /request unsuccessful/i],
    text: [/incapsula/i, /imperva/i, /request unsuccessful/i, /_incapsula_resource/i],
    dom: ['#incapsula-container', 'iframe[src*="incapsula"]', 'script[src*="_Incapsula_Resource"]'],
    cookies: [/^incap_ses/i, /^visid_incap/i, /^nlbi_/i],
    globals: [],
  },
  {
    id: 'aws-waf', label: 'AWS WAF', autoWait: false,
    title: [/request blocked/i, /human verification/i],
    text: [/request blocked/i, /aws waf/i, /verify you are human/i, /complete the captcha/i],
    dom: ['#captcha-container', 'script[src*="awswaf.com"]', 'script[src*="captcha.awswaf"]'],
    cookies: [/^aws-waf-token$/i],
    globals: [],
  },
  {
    id: 'captcha', label: '通用验证码墙（CAPTCHA）', autoWait: false,
    title: [/^captcha$/i, /human verification/i, /security check/i, /are you a robot/i],
    text: [/verify you are (a )?human/i, /complete the (security )?captcha/i, /i'm not a robot/i, /are you a robot/i, /please (complete|solve) the (captcha|challenge)/i],
    dom: ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]', '.g-recaptcha', '.h-captcha', '.captcha-container'],
    cookies: [],
    globals: [],
  },
  {
    id: 'access-denied', label: '访问拒绝页（Access Denied / 403）', autoWait: false,
    title: [/access denied/i, /^403\b/, /forbidden/i, /request blocked/i],
    text: [/access denied/i, /you (don't|do not) have permission/i, /request blocked/i, /not authorized to access/i],
    dom: ['.error-403', '#error-page', 'h1.error-title'],
    cookies: [],
    globals: [],
  },
]);

/** 页侧一次只读扫描（返回 JSON 串：href/title/text/dom 命中/全局命中——不落盘不回显正文） */
const SCAN_EXPR = (() => {
  const sel = {}, glob = {};
  for (const w of WALLS) { if (w.dom.length) sel[w.id] = w.dom; if (w.globals.length) glob[w.id] = w.globals; }
  return `(function(){
  var out = { href: '', title: '', text: '', dom: {}, globals: {} };
  try { out.href = String(location.href || '').slice(0, 2048); } catch (e) {}
  try { out.title = String(document.title || '').slice(0, ${TITLE_MAX}); } catch (e) {}
  try { out.text = String((document.body && document.body.innerText) || '').slice(0, ${TEXT_MAX}); } catch (e) {}
  var SEL = ${JSON.stringify(sel)};
  for (var k in SEL) { var hits = []; for (var i = 0; i < SEL[k].length; i++) { try { if (document.querySelector(SEL[k][i])) hits.push(SEL[k][i]); } catch (e) {} } out.dom[k] = hits; }
  var G = ${JSON.stringify(glob)};
  for (var g in G) { var names = []; for (var j = 0; j < G[g].length; j++) { try { if (typeof window[G[g][j]] !== 'undefined') names.push(G[g][j]); } catch (e) {} } out.globals[g] = names; }
  return JSON.stringify(out);
})()`;
})();

function matchRes(patterns, value) {
  if (!value) return [];
  const out = [];
  for (const re of patterns) { if (re.test(value)) out.push(re.source); }
  return out;
}

function isHttpish(url) {
  try { const p = new URL(String(url || '')).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

/** 选项归一（非法值抛错=调用方 die→E_USAGE，不静默兜底） */
function normalizeOptions(input) {
  const o = input || {};
  let waitMs = DEFAULT_WAIT_MS;
  if (o.waitMs !== undefined && o.waitMs !== null && o.waitMs !== '') {
    if (typeof o.waitMs === 'boolean') throw new Error('--challenge-wait-ms 缺值（自愈等待预算毫秒数，0=不等待；默认 15000）');
    const n = Number(o.waitMs);
    if (!Number.isInteger(n) || n < 0 || n > WAIT_MS_MAX) throw new Error(`--challenge-wait-ms 非法（须 0~${WAIT_MS_MAX} 整数毫秒）：${JSON.stringify(o.waitMs)}`);
    waitMs = n;
  }
  let minSignals = DEFAULT_MIN_SIGNALS;
  if (o.minSignals !== undefined && o.minSignals !== null) {
    const n = Number(o.minSignals);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`challenge.minSignals 非法（须 1~5）：${JSON.stringify(o.minSignals)}`);
    minSignals = n;
  }
  const timeout = Number(o.timeoutMs);
  return {
    allowChallenge: !!o.allowChallenge,
    waitMs,
    minSignals,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
    readyMs: Number.isInteger(o.readyMs) && o.readyMs > 0 ? o.readyMs : 0,
    url: o.url === undefined ? undefined : String(o.url),
    sleepFn: typeof o.sleepFn === 'function' ? o.sleepFn : time.sleep,
  };
}

/** 页侧信号采集（只读；异常 fail-soft 返回 {ok:false,error}——检测面不可读绝不误拦） */
async function inspect(client, sessionId, opts) {
  const o = opts || {};
  const core = require('./cdp-core');
  let raw;
  try { raw = await core.evaluate(client, sessionId, SCAN_EXPR, o.timeoutMs || 5000); }
  catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  let sig;
  try { sig = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { ok: false, error: '页侧扫描结果不可解析' }; }
  if (!sig || typeof sig !== 'object' || typeof sig.title !== 'string') return { ok: false, error: '页侧扫描结果形状非法' };
  if (!isHttpish(sig.href)) return { ok: true, skipped: 'scheme', url: String(sig.href || '') };
  let cookies = [];
  try {
    const r = await client.send('Network.getAllCookies', {}, { timeoutMs: Math.min(o.timeoutMs || 5000, 3000) });
    cookies = (Array.isArray(r && r.cookies) ? r.cookies : []).map((c) => String((c && c.name) || '')).filter(Boolean);
  } catch { /* fail-soft：少一类 Cookie 信号（安全侧偏漏报） */ }
  return {
    ok: true,
    signals: {
      url: String(sig.href || ''),
      title: String(sig.title || '').slice(0, TITLE_MAX),
      text: String(sig.text || '').slice(0, TEXT_MAX),
      dom: (sig.dom && typeof sig.dom === 'object') ? sig.dom : {},
      globals: (sig.globals && typeof sig.globals === 'object') ? sig.globals : {},
      cookies,
    },
  };
}

/** 特征匹配纯函数：返回命中墙清单（按命中类别数降序，同分保表序）；单墙 <minSignals 类不判定 */
function detectFromSignals(signals, opts) {
  const o = opts || {};
  const minSignals = Number.isInteger(o.minSignals) ? o.minSignals : DEFAULT_MIN_SIGNALS;
  const sig = signals || {};
  const title = String(sig.title || '');
  const text = String(sig.text || '');
  const dom = sig.dom && typeof sig.dom === 'object' ? sig.dom : {};
  const globals = sig.globals && typeof sig.globals === 'object' ? sig.globals : {};
  const cookies = Array.isArray(sig.cookies) ? sig.cookies : [];
  const hits = [];
  for (const w of WALLS) {
    const matched = {
      title: matchRes(w.title, title),
      text: matchRes(w.text, text),
      dom: (Array.isArray(dom[w.id]) ? dom[w.id] : []).slice(),
      cookie: cookies.filter((n) => w.cookies.some((re) => re.test(n))),
      global: (Array.isArray(globals[w.id]) ? globals[w.id] : []).slice(),
    };
    const categories = Object.keys(matched).filter((k) => matched[k].length > 0);
    if (categories.length >= minSignals) hits.push({ wall: w.id, label: w.label, autoWait: !!w.autoWait, categories, matched });
  }
  hits.sort((a, b) => b.categories.length - a.categories.length);
  return hits;
}

/** 页侧就绪等待（new 用：createTarget 不等加载；fail-soft，超时交给检测面如实降级） */
async function waitReady(client, sessionId, budgetMs, sleepFn, timeoutMs) {
  const core = require('./cdp-core');
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const rs = await core.evaluate(client, sessionId, 'document.readyState', Math.min(timeoutMs || 3000, 3000));
      if (rs === 'complete' || rs === 'interactive') return true;
    } catch { /* renderer 未就绪，继续等 */ }
    if (Date.now() >= deadline) return false;
    await sleepFn(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * 检测 + 有限自愈等待（唯一对外入口）。
 * @returns {{detected:boolean, skipped?:string, error?:string, cleared?:boolean, wall?:string, label?:string,
 *            categories?:string[], matched?:object, url?:string, waitedMs:number, attempts:number}}
 */
async function check(client, sessionId, opts) {
  const o = normalizeOptions(opts);
  if (o.url !== undefined && !isHttpish(o.url)) return { detected: false, skipped: 'scheme', url: o.url, waitedMs: 0, attempts: 0 };
  const t0 = Date.now();
  if (o.readyMs) await waitReady(client, sessionId, o.readyMs, o.sleepFn, o.timeoutMs);
  const first = await inspect(client, sessionId, { timeoutMs: o.timeoutMs });
  if (!first.ok) return { detected: false, error: first.error, waitedMs: Date.now() - t0, attempts: 0 };
  if (first.skipped) return { detected: false, skipped: first.skipped, url: first.url, waitedMs: 0, attempts: 0 };
  let hits = detectFromSignals(first.signals, o);
  if (!hits.length) return { detected: false, url: first.signals.url, waitedMs: Date.now() - t0, attempts: 1 };
  const base = {
    detected: true, hits: hits.map((h) => h.wall), wall: hits[0].wall, label: hits[0].label,
    categories: hits[0].categories, matched: hits[0].matched, titleSample: first.signals.title.slice(0, 60),
    minSignals: o.minSignals, url: first.signals.url, attempts: 1,
  };
  /* 自愈只在「全是非交互盾」时发生（混入交互墙=白等）；等待后重检一次为循环内每轮 */
  const autoWait = hits.every((h) => h.autoWait);
  if (!autoWait || !(o.waitMs > 0)) return Object.assign(base, { waitedMs: Date.now() - t0 });
  const deadline = t0 + o.waitMs;
  let attempts = 1;
  while (Date.now() < deadline) {
    await o.sleepFn(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    attempts++;
    const again = await inspect(client, sessionId, { timeoutMs: o.timeoutMs }).catch(() => null);
    if (!again || !again.ok || again.skipped) continue;
    hits = detectFromSignals(again.signals, o);
    if (!hits.length) {
      return { detected: false, cleared: true, wall: base.wall, label: base.label, waitedMs: Date.now() - t0, attempts, url: again.signals.url };
    }
    if (!hits.every((h) => h.autoWait)) break;
  }
  return Object.assign(base, { waitedMs: Date.now() - t0, attempts });
}

/** 人类可读命中摘要（只含自有特征表/选择器名，不含页面正文——防泄） */
function describe(res) {
  const m = res.matched || {};
  const parts = [];
  if (m.title && m.title.length) parts.push(`title「${String(res.titleSample || '').slice(0, 60)}」`);
  if (m.text && m.text.length) parts.push(`文本 ${m.text.slice(0, 2).join(' / ')}`);
  if (m.dom && m.dom.length) parts.push(`DOM ${m.dom.slice(0, 2).join(', ')}`);
  if (m.cookie && m.cookie.length) parts.push(`Cookie ${m.cookie.slice(0, 3).join(', ')}`);
  if (m.global && m.global.length) parts.push(`全局 ${m.global.slice(0, 2).join(', ')}`);
  return `${res.label}（${parts.join(' + ') || '多信号'}）`;
}

function waitPhrase(res) {
  return (res.attempts > 1 || res.waitedMs >= 500) ? `；已自愈等待 ${res.waitedMs}ms/${res.attempts} 次重检仍未通过` : '';
}

/** 阻断文案（默认语义）：诚实红 + 接管提示 + 禁自解/禁连环重试 */
function formatBlock(res) {
  return `CHALLENGE_DETECTED：${describe(res)}${waitPhrase(res)} → 已阻断（默认安全优先，${res.url || '当前页'}）。
接管提示：请用户在该页签手工完成验证后重跑本命令；或用 --allow-challenge 显式放行（效率优先、自担风险）。禁自解/禁连环重试。
需要等人接管时：cdp.js handoff --reason "完成验证" 交还该页签（详见 cdp.js handoff --help）。`;
}

/** 放行文案（--allow-challenge）：仅提醒，不阻断 */
function formatAllowed(res) {
  return `CHALLENGE_DETECTED（--allow-challenge 已放行）：${describe(res)}${waitPhrase(res)} → 继续执行；后续操作可能被盾拦截/产生假数据，建议人工核对。`;
}

function formatCleared(res) {
  return `challenge 自愈通过：${res.label}${res.waitedMs > 0 ? `（等待 ${res.waitedMs}ms/${res.attempts} 次重检）` : ''}——继续执行`;
}

/** --json data.challenge（结构断言真源；不含页面正文） */
function summary(res) {
  if (!res || !res.detected) return res && res.cleared ? { detected: false, cleared: true, wall: res.wall, waitedMs: res.waitedMs, attempts: res.attempts } : { detected: false, skipped: res && res.skipped || null };
  return {
    detected: true, allowed: !!res.allowed, wall: res.wall, label: res.label,
    categories: res.categories, matched: res.matched, minSignals: res.minSignals,
    waitedMs: res.waitedMs, attempts: res.attempts, url: res.url,
  };
}

module.exports = {
  WALLS, SCAN_EXPR, DEFAULT_WAIT_MS, DEFAULT_MIN_SIGNALS,
  normalizeOptions, inspect, detectFromSignals, check,
  describe, formatBlock, formatAllowed, formatCleared, summary, isHttpish,
};
