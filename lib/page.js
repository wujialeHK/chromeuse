'use strict';
/*
 * chromeuse lib/page.js —— 页面/标签生命周期 + eval 实现单源
 * （cdp 主通道战略二期 P0，2026-10-31 用户裁定；一期 lib/drive.js 只管 Input 域交互）
 *
 * 定位：`tools/cdp.js goto/new/close/select/targets --json/eval/viewport/emulate/dialog` 的唯一实现单源。
 * 为什么独立模块而不塞进 drive.js：drive.js 的红线声明是「全 Input 域真实事件（isTrusted）」，
 *   而本模块全是 Target/Page/Runtime 域生命周期（开/关/激活页签、导航、求值）——职责与红线边界不同，
 *   混写会让「drive=真实键鼠」的单源身份失真；本模块零 Input 事件，可单测面（协议白名单/关闭裁决/
 *   target 投影/文件读取）也独立。
 *
 * 域与 88 兼容：Target.* / Page.* / Runtime.evaluate 均为 Chrome 88 已存在且语义一致的命令族
 *   （Target.createTarget/closeTarget/activateTarget/getTargets、Page.enable/navigate/loadEventFired、
 *   Runtime.evaluate returnByValue/awaitPromise）——无 88 分叉；真遇到版本差异按「简单就地+注释，
 *   麻烦登记汇报」处置。
 *
 * 二期-2（2026-10-31，视口/模拟/交互补充批）在本模块追加「页面环境类」命令的单源：
 *   - viewport（Emulation.setDeviceMetricsOverride / clearDeviceMetricsOverride）
 *   - emulate（Emulation.setUserAgentOverride / setEmulatedMedia + 双 clear）
 *   - dialog（Page.javascriptDialogOpening + Page.handleJavaScriptDialog）
 *   为什么仍在 page.js：三者的域归属都是 Emulation/Page（页面环境/浏览器模态），零 Input 键鼠事件；
 *   drive.js 的红线身份是「Input 域真实键鼠」，交互补充里的 upload/drag 落 drive.js（见其文件头）。
 *
 * 页签礼仪（硬约束，2026-10-31 用户裁定）：
 * - 谁开谁关：agent 用 `new` 开的页签，任务结束必须用 `close <targetId>` 关闭；
 * - `new`/`close` stdout 恒回显完整 targetId（可脚本化配对）；
 * - `close --match` 多命中**不猜**：无 --yes 只列候选并退出非 0，绝不误关；
 *   `--all-but` 是批量破坏面，必须 --yes 才执行（无 --yes 只列将被关闭的清单）。
 *
 * 导航等待：Page.navigate → 同时听 Page.loadEventFired + 轮询 document.readyState；
 *   用 Page.frameNavigated（主 frame）标记「新文档已提交」，避免导航提交前读到旧页 readyState=complete
 *   的假完成；Page.enable 失败时退化为纯 readyState 轮询（fail-soft，事件不可用不阻断导航）。
 */

const fs = require('node:fs');
const time = require('./time');
const screenshot = require('./screenshot'); // 视口/DPR 解析与指标读回单源（V202610210001；本模块 viewport 复用）

const DEFAULT_CMD_TIMEOUT_MS = 5000;
const DEFAULT_GOTO_TIMEOUT_MS = 30000;
const GOTO_TIMEOUT_MIN_MS = 500;
const GOTO_TIMEOUT_MAX_MS = 600000;
const LOAD_POLL_MS = 100;
const DEFAULT_NEW_URL = 'about:blank';

/* 协议白名单（2026-10-31 二期规格）：http/https/file/about + chrome://（诊断场景要用）。
 * 拒绝 javascript:/data:/ftp: 等——goto 只做页面加载，不执行脚本注入（业务写操作走 Input 域）。 */
const ALLOWED_SCHEMES = ['http', 'https', 'file', 'about', 'chrome'];

const sleep = time.sleep;

/** URL 协议白名单校验（纯函数）：返回 {url, scheme}；非法抛错（绝不静默降级）。 */
function normalizeGotoUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('URL 不能为空');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!m) throw new Error(`URL 缺协议头（仅允许 ${ALLOWED_SCHEMES.map((s) => s + ':').join('/')}）：${JSON.stringify(raw)}`);
  const scheme = m[1].toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    throw new Error(`协议 ${scheme}: 被拒绝——goto/new 仅允许 ${ALLOWED_SCHEMES.map((s) => s + ':').join('/')}（chrome:// 仅诊断场景）`);
  }
  return { url: raw, scheme };
}

/** goto 总等待预算归一（默认 30000ms；显式非法值抛错，不做静默兜底）。 */
function normalizeGotoTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_GOTO_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < GOTO_TIMEOUT_MIN_MS || n > GOTO_TIMEOUT_MAX_MS) {
    throw new Error(`goto --timeout 非法（须 ${GOTO_TIMEOUT_MIN_MS}~${GOTO_TIMEOUT_MAX_MS}ms 的总加载预算）：${JSON.stringify(value)}`);
  }
  return Math.round(n);
}

/* 页面状态只读表达式（readyState + 当前 href；同源顶层文档） */
const PAGE_STATE_EXPR = '({ readyState: document.readyState, href: location.href })';

async function readPageState(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression: PAGE_STATE_EXPR, returnByValue: true, userGesture: false,
  }, { sessionId, timeoutMs });
  return (r && r.result && r.result.value) || null;
}

/**
 * 导航并等待加载完成（Page.navigate + loadEventFired/readyState 双信号）。
 * @param {object} client CdpClient（已 attach 到目标页）
 * @param {string} sessionId 目标页 session
 * @param {string} url 已经过 normalizeGotoUrl 的 URL（本函数内再校验一次兜底）
 * @param {object} [opts] {timeoutMs=30000, cmdTimeoutMs=5000}
 * @returns {Promise<object>} {ok, requestedUrl, finalUrl, sameDocument, pageEnabled, committed, loadEvent,
 *   readyState, polls, elapsedMs, timedOut?, errorText?, error?}
 */
async function navigate(client, sessionId, url, opts) {
  const o = opts || {};
  const targetUrl = normalizeGotoUrl(url).url;
  const budget = normalizeGotoTimeout(o.timeoutMs);
  const cmdTimeout = Math.max(GOTO_TIMEOUT_MIN_MS, Math.min(o.cmdTimeoutMs || DEFAULT_CMD_TIMEOUT_MS, budget));
  const t0 = Date.now();
  let pageEnabled = false;
  let loadEvent = false;
  let committed = false;
  const off = client.onEvent((ev) => {
    if (!ev || ev.sessionId !== sessionId) return;
    if (ev.method === 'Page.frameNavigated') {
      const f = ev.params && ev.params.frame;
      if (f && !f.parentId) committed = true; // 主 frame 新文档已提交（重定向同 loaderId 多次事件无副作用）
    } else if (ev.method === 'Page.loadEventFired') {
      loadEvent = true;
    }
  });
  try {
    try {
      await client.send('Page.enable', {}, { sessionId, timeoutMs: cmdTimeout });
      pageEnabled = true;
    } catch (e) { /* fail-soft：事件不可用仍可轮询 readyState（错误不外抛，结果里如实标 pageEnabled:false） */ }
    let nav;
    try {
      nav = await client.send('Page.navigate', { url: targetUrl }, { sessionId, timeoutMs: cmdTimeout });
    } catch (e) {
      return { ok: false, requestedUrl: targetUrl, phase: 'navigate', error: `Page.navigate 失败：${e.message}`, pageEnabled, elapsedMs: Date.now() - t0 };
    }
    if (nav && nav.errorText) {
      // 浏览器侧网络错误（ERR_NAME_NOT_RESOLVED 等）：页面显示错误页，如实失败（不伪装成功）
      return { ok: false, requestedUrl: targetUrl, phase: 'navigate', errorText: nav.errorText, pageEnabled, elapsedMs: Date.now() - t0 };
    }
    if (!nav || !nav.loaderId) {
      // 同文档导航（片段/历史 API）：无新 loader，不会再有 load 事件——直接读当前 href 返回
      const st = await readPageState(client, sessionId, Math.max(300, cmdTimeout)).catch(() => null);
      return {
        ok: true, requestedUrl: targetUrl, finalUrl: (st && st.href) || targetUrl, sameDocument: true,
        pageEnabled, committed, loadEvent, readyState: (st && st.readyState) || null, polls: 0, elapsedMs: Date.now() - t0,
      };
    }
    let readyState = null;
    let polls = 0;
    for (;;) {
      polls++;
      const remain = budget - (Date.now() - t0);
      const st = await readPageState(client, sessionId, Math.max(300, Math.min(cmdTimeout, remain > 0 ? remain : 300))).catch(() => null);
      if (st) readyState = st.readyState;
      // 只有「Event 域已启用 → 必须见过主 frame 提交」才算数；Page.enable 失败时退化为纯 readyState 轮询
      const gate = committed || !pageEnabled;
      if (gate && (loadEvent || readyState === 'complete')) {
        const fin = await readPageState(client, sessionId, Math.max(300, cmdTimeout)).catch(() => null);
        return {
          ok: true, requestedUrl: targetUrl, finalUrl: (fin && fin.href) || null,
          sameDocument: false, pageEnabled, committed, loadEvent,
          readyState: (fin && fin.readyState) || readyState, polls, elapsedMs: Date.now() - t0,
        };
      }
      const spent = Date.now() - t0;
      if (spent >= budget) {
        return {
          ok: false, requestedUrl: targetUrl, timedOut: true, phase: 'load',
          pageEnabled, committed, loadEvent, readyState, polls, elapsedMs: spent,
        };
      }
      await sleep(Math.min(LOAD_POLL_MS, Math.max(0, budget - spent)));
    }
  } finally {
    try { off(); } catch (e) { /* noop */ }
  }
}

/** 新开页签（Target.createTarget）：返回 {targetId, url, background}；URL 走同一协议白名单。 */
async function createTarget(client, url, opts) {
  const o = opts || {};
  const raw = (url === undefined || url === null || url === '') ? DEFAULT_NEW_URL : url;
  const targetUrl = normalizeGotoUrl(raw).url;
  const r = await client.send('Target.createTarget', {
    url: targetUrl, background: !!o.background,
  }, { timeoutMs: o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS });
  if (!r || !r.targetId) throw new Error('Target.createTarget 未返回 targetId');
  return { targetId: r.targetId, url: targetUrl, background: !!o.background };
}

/** 关闭页签（Target.closeTarget）；success===false 视为失败（如实返回，调用方定退出码）。 */
async function closeTarget(client, targetId, opts) {
  const o = opts || {};
  const id = String(targetId == null ? '' : targetId).trim();
  if (!id) throw new Error('closeTarget 需要 targetId');
  const r = await client.send('Target.closeTarget', { targetId: id }, { timeoutMs: o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS });
  return { targetId: id, success: !(r && r.success === false) };
}

/** 激活页签（Target.activateTarget，等价 bringToFront 的浏览器级入口）。 */
async function activateTarget(client, targetId, opts) {
  const o = opts || {};
  const id = String(targetId == null ? '' : targetId).trim();
  if (!id) throw new Error('activateTarget 需要 targetId');
  await client.send('Target.activateTarget', { targetId: id }, { timeoutMs: o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS });
  return { targetId: id };
}

/** 全量 target 列表（Target.getTargets；含 attached/type/title/url——targets --json 数据源）。 */
async function listTargetInfos(client, opts) {
  const o = opts || {};
  const r = await client.send('Target.getTargets', {}, { timeoutMs: o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS });
  return Array.isArray(r && r.targetInfos) ? r.targetInfos : [];
}

/** 单条 target 归一（纯函数）：Target.getTargets 用 targetId、HTTP /json/list 用 id——统一成 id */
function canonicalTarget(t) {
  return {
    id: String((t && (t.targetId || t.id)) || ''),
    type: String((t && t.type) || ''),
    title: String((t && t.title) || ''),
    url: String((t && t.url) || ''),
    attached: !!(t && t.attached),
  };
}

/** targets --json 投影（纯函数）：id/type/title/url/attached + 数量摘要（chromeuse-targets/1）。 */
function projectTargets(infos, meta) {
  const list = (Array.isArray(infos) ? infos : []).map(canonicalTarget);
  const byType = {};
  for (const t of list) byType[t.type] = (byType[t.type] || 0) + 1;
  return {
    format: 'chromeuse-targets/1',
    at: (meta && meta.at) || null,
    browserUrl: (meta && meta.browserUrl) || null,
    total: list.length,
    attachedCount: list.filter((t) => t.attached).length,
    byType,
    targets: list,
  };
}

/**
 * targetId 解析（纯函数）：仅 page 型；完整 id 精确 → 唯一前缀；多前缀不猜（ambiguous-id）。
 * @returns {{ok:true,target:object}|{ok:false,reason:'empty'|'not-found'|'ambiguous-id',candidates?:object[]}}
 */
function resolvePageId(targets, spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return { ok: false, reason: 'empty' };
  const pages = (Array.isArray(targets) ? targets : []).map(canonicalTarget).filter((t) => t.type === 'page');
  const exact = pages.find((t) => t.id === s);
  if (exact) return { ok: true, target: exact };
  const pref = pages.filter((t) => t.id.startsWith(s));
  if (pref.length === 1) return { ok: true, target: pref[0] };
  if (pref.length > 1) return { ok: false, reason: 'ambiguous-id', candidates: pref };
  return { ok: false, reason: 'not-found' };
}

/**
 * close 计划器（纯函数，不触网）——页签礼仪的裁决单源。
 * @param {object[]} targets [{id,type,title,url,attached}]
 * @param {object} opts {id?|allBut?|match?, yes?:boolean} —— 三种选择器恰一种
 * @returns {{ok:boolean, mode:string, reason?:string, planned?:object[], candidates?:object[], keep?:object}}
 *   ok:true  → planned=实际要关闭的 target 列表（可能为空=no-op）
 *   ok:false → 拒绝执行（reason: need-one-selector|empty-keyword|not-found|ambiguous-id|
 *              ambiguous-match|confirmation-required），candidates=候选清单（绝不猜、绝不误关）
 */
function planClose(targets, opts) {
  const o = opts || {};
  const forms = [o.id !== undefined && o.id !== null && o.id !== '', o.allBut !== undefined && o.allBut !== null && o.allBut !== '', o.match !== undefined && o.match !== null]
    .filter(Boolean).length;
  if (forms !== 1) return { ok: false, mode: 'invalid', reason: 'need-one-selector' };
  const pages = (Array.isArray(targets) ? targets : []).map(canonicalTarget).filter((t) => t.type === 'page');
  if (o.match !== undefined && o.match !== null) {
    const kw = String(o.match).trim();
    if (!kw) return { ok: false, mode: 'match', reason: 'empty-keyword' };
    const lower = kw.toLowerCase();
    const matched = pages.filter((t) => String(t.url || '').toLowerCase().includes(lower) || String(t.title || '').toLowerCase().includes(lower));
    if (!matched.length) return { ok: false, mode: 'match', reason: 'not-found', candidates: [] };
    if (matched.length === 1) return { ok: true, mode: 'match', planned: matched, requiredYes: false };
    if (!o.yes) return { ok: false, mode: 'match', reason: 'ambiguous-match', candidates: matched };
    return { ok: true, mode: 'match', planned: matched, requiredYes: true };
  }
  if (o.allBut !== undefined && o.allBut !== null && o.allBut !== '') {
    const keep = resolvePageId(pages, o.allBut);
    if (!keep.ok) return { ok: false, mode: 'all-but', reason: keep.reason, candidates: keep.candidates || [] };
    const planned = pages.filter((t) => t.id !== String(keep.target.id));
    if (!planned.length) return { ok: true, mode: 'all-but', planned: [], keep: keep.target, noop: true };
    if (!o.yes) return { ok: false, mode: 'all-but', reason: 'confirmation-required', candidates: planned, keep: keep.target };
    return { ok: true, mode: 'all-but', planned, keep: keep.target };
  }
  const hit = resolvePageId(pages, o.id);
  if (!hit.ok) return { ok: false, mode: 'id', reason: hit.reason, candidates: hit.candidates || [] };
  return { ok: true, mode: 'id', planned: [hit.target] };
}

/** 表达式/参数文件读取（纯 IO）：返回原内容（不 trim 本体）；空文件/目录/不可读一律抛错。
 *  opts.flag/label 供其他旗标复用（如 exec --params-file），缺省文案与历史 eval --file 完全一致。 */
function readExpressionFile(file, opts) {
  const o = opts || {};
  const flag = o.flag || '--file';
  const label = o.label || '表达式文件';
  const p = String(file == null ? '' : file).trim();
  if (!p) throw new Error(`${flag} 缺值（${label}路径）`);
  let stat;
  try { stat = fs.statSync(p); } catch (e) { throw new Error(`${label}不可读：${p}（${e.code || e.message}）`); }
  if (stat.isDirectory()) throw new Error(`${flag} 指向目录：${p}`);
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim()) throw new Error(`${label}为空：${p}`);
  return text;
}

/**
 * 页面求值（Runtime.evaluate returnByValue + awaitPromise；userGesture:false 不伪造用户手势）。
 * 异常不抛（fail-soft）：返回 {ok:false, exception:{text,description,lineNumber,columnNumber}}。
 */
async function evaluateExpression(client, sessionId, expression, opts) {
  const o = opts || {};
  const r = await client.send('Runtime.evaluate', {
    expression: String(expression), returnByValue: true, awaitPromise: o.awaitPromise !== false, userGesture: false,
  }, { sessionId, timeoutMs: o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    return {
      ok: false,
      exception: {
        text: String(d.text || ''),
        description: String((d.exception && d.exception.description) || ''),
        lineNumber: d.lineNumber,
        columnNumber: d.columnNumber,
      },
      type: (r.result && r.result.type) || null,
    };
  }
  const res = (r && r.result) || {};
  return { ok: true, type: res.type || null, value: res.value, unserializable: res.unserializableValue, description: res.description };
}

/** eval 结果人类可读行（纯函数）：undefined/unserializable/对象 JSON 均如实呈现。 */
function formatEvalValue(result) {
  if (!result || result.ok !== true) return '';
  if (result.unserializable !== undefined) return String(result.unserializable);
  if (result.value === undefined) {
    if (result.type === 'undefined') return 'undefined';
    if (result.description !== undefined) return String(result.description);
    return '(无返回值)';
  }
  if (typeof result.value === 'string') return JSON.stringify(result.value);
  try { return JSON.stringify(result.value, null, 2); } catch (e) { return String(result.value); }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 二期-2：视口 / 模拟 / dialog（页面环境类，Emulation/Page 域；实现单源）
 * ═══════════════════════════════════════════════════════════════════════════ */

const MEDIA_TYPES = ['print', 'screen'];
const DIALOG_ACTIONS = ['accept', 'dismiss', 'cancel'];
const DEFAULT_DIALOG_WAIT_MS = 10000;   // --auto 未给 --wait 时的默认监听窗（一次性 CLI 无法常驻）
const DIALOG_WAIT_MIN_MS = 100;
const DIALOG_WAIT_MAX_MS = 600000;
const DIALOG_QUERY_PROBE_MS = 400;      // 无 --wait 的「查询当前挂起」观察窗（CDP 无查询 API，尽力而为）

/**
 * viewport 参数归一（纯函数）：无参 / --reset = 清除覆盖；否则 WxH / --dpr 至少一项 = 施加覆盖。
 * 复用 lib/screenshot.js 的 metricsPlan/parseViewport（视口解析与 DPR 域的单源，V202610210001）。
 * @returns {{mode:'reset'}|{mode:'apply', plan:{width:number|null,height:number|null,deviceScaleFactor:number|null,mobile:false}}}
 */
function normalizeViewportRequest(src) {
  const o = src || {};
  const hasViewport = o.viewport !== undefined && o.viewport !== null && o.viewport !== '';
  const hasDpr = o.dpr !== undefined && o.dpr !== null && o.dpr !== '';
  if (o.reset === true && (hasViewport || hasDpr)) {
    throw new Error('viewport --reset 与 WxH/--dpr 互斥（清除覆盖与施加覆盖不能同一命令）');
  }
  if (o.reset === true || (!hasViewport && !hasDpr)) return { mode: 'reset' };
  return { mode: 'apply', plan: screenshot.metricsPlan({ dpr: hasDpr ? o.dpr : undefined, viewport: hasViewport ? o.viewport : undefined }) };
}

/**
 * emulate 参数归一（纯函数）：--ua / --media 至少一项 = 施加；--reset = 双清（UA+media）。
 * --reset 与 --ua/--media 互斥；media 仅 print|screen；UA 去首尾空白后不得为空。
 */
function normalizeEmulateRequest(src) {
  const o = src || {};
  const hasUa = o.ua !== undefined && o.ua !== null && o.ua !== '';
  const hasMedia = o.media !== undefined && o.media !== null && o.media !== '';
  if (o.reset === true && (hasUa || hasMedia)) {
    throw new Error('emulate --reset 与 --ua/--media 互斥（双清与施加模拟不能同一命令）');
  }
  if (o.reset === true) return { mode: 'reset' };
  if (!hasUa && !hasMedia) throw new Error('emulate 需要 --ua <ua> 或 --media print|screen（或 --reset 双清）');
  let ua = null;
  if (hasUa) {
    ua = String(o.ua).trim();
    if (!ua) throw new Error('--ua 不能为空');
  }
  let media = null;
  if (hasMedia) {
    media = String(o.media).toLowerCase();
    if (!MEDIA_TYPES.includes(media)) throw new Error(`--media 仅支持 ${MEDIA_TYPES.join('|')}：${JSON.stringify(o.media)}`);
  }
  return { mode: 'apply', ua, media };
}

/**
 * dialog 参数归一（纯函数）。
 * - 无 --wait 且无 --auto = queryOnly（CDP 无「查询当前挂起对话框」API，只能短观察窗尽力而为）；
 * - 有 --auto 未给 --wait = 默认 10000ms 监听窗（一次性 CLI 无法常驻自动处置）；
 * - --text 仅 accept 形态可用（prompt 答复）；dismiss/cancel 带 --text 报错。
 * @returns {{auto:string|null,text:string|null,waitMs:number,queryOnly:boolean}}
 */
function normalizeDialogOptions(src) {
  const o = src || {};
  let auto = null;
  if (o.auto !== undefined && o.auto !== null && o.auto !== '') {
    auto = String(o.auto).toLowerCase();
    if (!DIALOG_ACTIONS.includes(auto)) throw new Error(`--auto 仅支持 ${DIALOG_ACTIONS.join('|')}：${JSON.stringify(o.auto)}`);
    if (auto === 'cancel') auto = 'dismiss'; // CDP handleJavaScriptDialog 只有 accept:true/false，cancel=dismiss
  }
  const hasText = o.text !== undefined && o.text !== null && o.text !== '';
  if (hasText && auto !== 'accept') throw new Error('--text 仅与 --auto accept 同用（prompt 答复文本）');
  const hasWait = o.waitMs !== undefined && o.waitMs !== null && o.waitMs !== '';
  let waitMs = auto ? DEFAULT_DIALOG_WAIT_MS : 0;
  if (hasWait) {
    waitMs = Number(o.waitMs);
    if (!Number.isInteger(waitMs) || waitMs < DIALOG_WAIT_MIN_MS || waitMs > DIALOG_WAIT_MAX_MS) {
      throw new Error(`--wait 须为 ${DIALOG_WAIT_MIN_MS}~${DIALOG_WAIT_MAX_MS} 的整数毫秒：${JSON.stringify(o.waitMs)}`);
    }
  }
  return { auto, text: hasText ? String(o.text) : null, waitMs, queryOnly: !hasText && !auto && !hasWait };
}

/** dialog 事件参数投影（纯函数）：type/message/url/defaultPrompt/hasBrowserHandler。 */
function projectDialog(params) {
  const p = params || {};
  return {
    type: String(p.type || ''),
    message: String(p.message || ''),
    url: String(p.url || ''),
    defaultPrompt: p.defaultPrompt === undefined || p.defaultPrompt === null ? null : String(p.defaultPrompt),
    hasBrowserHandler: p.hasBrowserHandler === undefined || p.hasBrowserHandler === null ? null : !!p.hasBrowserHandler,
  };
}

/**
 * 施加视口覆盖（Emulation.setDeviceMetricsOverride）。
 * ⚠ 会话级语义（2026-10-31 实弹 Chrome 153）：Emulation 覆盖只在本 CDP session 存活期间对全浏览器可见，
 *   session 断开即被 Chrome 清理（宽度/高度若不带 dontSetVisibleSize 会改真实窗口且 clear 无法还原——
 *   因此本实现恒带 **dontSetVisibleSize:true**，绝不动用户真实窗口）。CLI 层在本命令结束前自动 clear；
 *   跨命令保持视口请用 screenshot --viewport（一次性截图）或 flow/MCP 长驻会话。
 * 施加后读回 innerWidth/innerHeight/DPR 校验，不符记 mismatch（调用方如实打印并决定退出码）。
 */
async function applyViewport(client, sessionId, req, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS;
  if (!req || req.mode !== 'apply') throw new Error('applyViewport 需要 normalizeViewportRequest 的 apply 结果');
  const pre = await screenshot.readMetrics(client, sessionId, timeoutMs);
  const plan = Object.assign({}, screenshot.materializePlan(req.plan, pre), { dontSetVisibleSize: true });
  await client.send('Emulation.setDeviceMetricsOverride', plan, { sessionId, timeoutMs });
  const post = await screenshot.readMetrics(client, sessionId, timeoutMs);
  const mismatch = [];
  if (post.width !== plan.width) mismatch.push(`innerWidth=${post.width} ≠ 请求 ${plan.width}`);
  if (post.height !== plan.height) mismatch.push(`innerHeight=${post.height} ≠ 请求 ${plan.height}`);
  if (Math.abs(post.dpr - plan.deviceScaleFactor) > 0.001) mismatch.push(`devicePixelRatio=${post.dpr} ≠ 请求 ${plan.deviceScaleFactor}`);
  return { pre, plan, post, mismatch, ok: mismatch.length === 0 };
}

/** 清除视口覆盖（Emulation.clearDeviceMetricsOverride）+ 前后读数。pre 可能是上一层的覆盖值，如实呈现。 */
async function resetViewport(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS;
  const pre = await screenshot.readMetrics(client, sessionId, timeoutMs);
  await client.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId, timeoutMs });
  const post = await screenshot.readMetrics(client, sessionId, timeoutMs);
  const unchanged = pre.width === post.width && pre.height === post.height && Math.abs(pre.dpr - post.dpr) <= 0.001;
  return { pre, post, cleared: true, unchanged };
}

const EMULATION_STATE_EXPR = '({ ua: navigator.userAgent, print: (window.matchMedia ? window.matchMedia("print").matches : null), screen: (window.matchMedia ? window.matchMedia("screen").matches : null) })';

async function readEmulationState(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', { expression: EMULATION_STATE_EXPR, returnByValue: true, userGesture: false }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v) throw new Error('模拟状态读取返回空值（Runtime.evaluate returnByValue 无 result.value）');
  return { ua: String(v.ua == null ? '' : v.ua), printMedia: v.print === null ? null : !!v.print, screenMedia: v.screen === null ? null : !!v.screen };
}

/** 施加 UA/媒体模拟（Emulation.setUserAgentOverride / setEmulatedMedia）+ 读回复核。 */
async function applyEmulation(client, sessionId, req, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS;
  if (!req || req.mode !== 'apply') throw new Error('applyEmulation 需要 normalizeEmulateRequest 的 apply 结果');
  const pre = await readEmulationState(client, sessionId, timeoutMs);
  if (req.ua !== null) await client.send('Emulation.setUserAgentOverride', { userAgent: req.ua }, { sessionId, timeoutMs });
  if (req.media !== null) await client.send('Emulation.setEmulatedMedia', { media: req.media }, { sessionId, timeoutMs });
  const post = await readEmulationState(client, sessionId, timeoutMs);
  const mismatch = [];
  if (req.ua !== null && post.ua !== req.ua) mismatch.push(`navigator.userAgent=${JSON.stringify(post.ua)} ≠ 请求 ${JSON.stringify(req.ua)}`);
  if (req.media !== null && post.printMedia !== (req.media === 'print')) mismatch.push(`matchMedia("print").matches=${post.printMedia} ≠ 媒体 ${req.media} 的期望`);
  return { pre, post, applied: { ua: req.ua, media: req.media }, mismatch, ok: mismatch.length === 0 };
}

/**
 * 双清模拟（UA + media）。
 * ⚠ 版本事实（2026-10-31 Chrome 153 实测）：`Emulation.clearUserAgentOverride` 与
 *   `Emulation.clearEmulatedMedia` 均返回 -32601（该版本无这两个 clear 命令）；协议级清除方式 =
 *   `setUserAgentOverride {userAgent:""}` + `setEmulatedMedia {media:""}`。实现先试 clear 命令，
 *   失败（含 -32601）即回落 set-empty（如实记 cleared 形态）；两条路径都不通才报错。
 */
async function resetEmulation(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_CMD_TIMEOUT_MS;
  const pre = await readEmulationState(client, sessionId, timeoutMs);
  const cleared = { userAgent: false, media: false };
  const errors = [];
  try { await client.send('Emulation.clearUserAgentOverride', {}, { sessionId, timeoutMs }); cleared.userAgent = true; }
  catch (e) {
    try { await client.send('Emulation.setUserAgentOverride', { userAgent: '' }, { sessionId, timeoutMs }); cleared.userAgent = 'fallback-set-empty'; }
    catch (e2) { errors.push(`clearUserAgentOverride：${e.message}；fallback setUserAgentOverride 也失败：${e2.message}`); }
  }
  try { await client.send('Emulation.clearEmulatedMedia', {}, { sessionId, timeoutMs }); cleared.media = true; }
  catch (e) {
    try { await client.send('Emulation.setEmulatedMedia', { media: '' }, { sessionId, timeoutMs }); cleared.media = 'fallback-set-empty'; }
    catch (e2) { errors.push(`clearEmulatedMedia：${e.message}；fallback setEmulatedMedia 也失败：${e2.message}`); }
  }
  const post = await readEmulationState(client, sessionId, timeoutMs);
  return { pre, post, cleared, errors, ok: errors.length === 0 };
}

/**
 * dialog 等待/处置（Page.javascriptDialogOpening + Page.handleJavaScriptDialog）。
 *
 * ⚠ 架构限制（如实声明）：CDP 没有「查询当前是否有挂起对话框」的 API；且 JS dialog 会阻塞 renderer。
 * - `queryOnly`（无 --wait/--auto）：Page.enable 后只能开一个 400ms 短观察窗——**仅能捕获该窗口内新开的
 *   dialog**；监听前已打开的历史 dialog 不会回放（Chrome 未提供回放语义，实测口径见 help）。
 * - `--wait N`：先 Page.enable 再听事件；窗口内首个 dialog 按 --auto 处置（无 --auto 只报告，页面仍阻塞）。
 * - 一次性短连接无法「常驻自动处置」：要处理即将弹出的 dialog，先在后台跑本命令再触发弹窗。
 */
async function waitForDialog(client, sessionId, opts) {
  // 兼容本模块 normalizeDialogOptions 的输出回灌：queryOnly 形态的 waitMs:0 不是用户 --wait 0（CLI 已在入口拒 0）
  const opts0 = Object.assign({}, opts);
  if (opts0.waitMs === 0) delete opts0.waitMs;
  const o = normalizeDialogOptions(opts0);
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_CMD_TIMEOUT_MS;
  const t0 = Date.now();
  let dialog = null;
  let settle = null;
  const first = new Promise((resolve) => { settle = resolve; });
  const off = client.onEvent((ev) => {
    if (!ev || ev.sessionId !== sessionId || ev.method !== 'Page.javascriptDialogOpening') return;
    if (!dialog) {
      dialog = ev.params || {};
      settle(dialog);
    }
  });
  let pageEnabled = false;
  try {
    try {
      await client.send('Page.enable', {}, { sessionId, timeoutMs });
      pageEnabled = true;
    } catch (e) {
      return { ok: false, pageEnabled, error: `Page.enable 失败：${e.message}` };
    }
    const windowMs = o.queryOnly ? DIALOG_QUERY_PROBE_MS : o.waitMs;
    const got = await Promise.race([first, time.sleep(windowMs).then(() => null)]);
    const waitedMs = Date.now() - t0;
    if (!got) {
      return {
        ok: false, pageEnabled, timedOut: true, queryOnly: o.queryOnly, waitedMs,
        note: o.queryOnly
          ? `CDP 无「查询当前挂起对话框」API；${windowMs}ms 观察窗内未收到 Page.javascriptDialogOpening——监听前已打开的 dialog 不会回放`
          : `${windowMs}ms 内未出现 dialog 事件`,
      };
    }
    const info = projectDialog(got);
    let handled = null;
    if (o.auto) {
      const params = { accept: o.auto === 'accept' };
      if (params.accept && o.text !== null && info.type === 'prompt') params.promptText = o.text;
      try {
        await client.send('Page.handleJavaScriptDialog', params, { sessionId, timeoutMs });
        handled = { ok: true, action: o.auto, accept: params.accept, promptText: params.promptText === undefined ? null : params.promptText };
      } catch (e) {
        handled = { ok: false, action: o.auto, error: e.message };
      }
    }
    return { ok: true, pageEnabled, dialog: info, handled, waitedMs };
  } finally {
    try { off(); } catch (e) { /* noop */ }
  }
}

module.exports = {
  // 常量
  DEFAULT_CMD_TIMEOUT_MS, DEFAULT_GOTO_TIMEOUT_MS, GOTO_TIMEOUT_MIN_MS, GOTO_TIMEOUT_MAX_MS,
  LOAD_POLL_MS, DEFAULT_NEW_URL, ALLOWED_SCHEMES, PAGE_STATE_EXPR,
  MEDIA_TYPES, DIALOG_ACTIONS, DEFAULT_DIALOG_WAIT_MS, DIALOG_WAIT_MIN_MS, DIALOG_WAIT_MAX_MS, DIALOG_QUERY_PROBE_MS,
  // 纯函数（selftest 直接消费）
  normalizeGotoUrl, normalizeGotoTimeout, projectTargets, resolvePageId, planClose, canonicalTarget,
  readExpressionFile, formatEvalValue,
  normalizeViewportRequest, normalizeEmulateRequest, normalizeDialogOptions, projectDialog,
  // CDP 动作（Target/Page/Runtime/Emulation 域）
  navigate, createTarget, closeTarget, activateTarget, listTargetInfos, readPageState, evaluateExpression,
  applyViewport, resetViewport, applyEmulation, resetEmulation, readEmulationState, waitForDialog,
};
