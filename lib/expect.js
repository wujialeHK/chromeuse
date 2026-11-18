'use strict';
/*
 * chromeuse lib/expect.js —— 交互后生效判据（R1，V202611030003 B2）
 *
 * 定位：动作类命令（click/type/key/drag/upload）的「生效判据 + 四态 phase + 事件驱动 settle 预算」单源。
 * 复用（**不照抄、不搬类方法**）：
 *   - `target-resolver.js` 的 `TEXT_EXISTS_V2_SRC`（X2 两级漏斗 + X1/GATE4 闸门，:656）——`--expect-text` 判据；
 *   - `target-resolver.js` 的 `buildVerifyExpr`（X4 容忍式命中复核，:700）——交互主体态 progress 采样
 *     （FlowEngine 的 verifyHit/ensureHittable 是绑 this 的类方法，不可复用；这里只复用已导出的表达式源）。
 *   - 轮询壳参考 flow-engine.js:1300-1318 `case 'assert'`（deadline + 固定节距 + 到点退出）：
 *     `EFFECT_POLL_MS=400`（M4：settle 节距 ≥400ms，禁 <100ms 短封顶 / 50ms 快节距）。
 *
 * 契约（详见 references/mechanisms.md §9 与 tmpdata/b2/state-machine.md）：
 *   - **裸命令（无任何 --expect-*）不激活本模块**：零新增 CDP 调用、输出逐字节不变、--json data 不含 phase；
 *   - 四态 phase：confirmed / effect_pending / dispatched / stalled；
 *   - exit：confirmed=0｜effect_pending=0（非失败，调用方必须读 phase）｜dispatched=0｜stalled=1（E_TIMEOUT 报告型失败+hint）；
 *   - 判据至多一种（--expect-text|--expect-value|--expect-selector|--expect-count 互斥）；
 *   - `--expect-value` 主体值口径：input/textarea/select 读 value；contenteditable 读 innerText（trim）；其余读 textContent（trim）；
 *   - effect-ms 默认 30000、下限 500（M4 硬约束）、上限 180000。
 *
 * 边界（如实声明）：
 *   - 「进展」是可观察信号（判据信号 / 主体 X4 判态 / 页面 `元素数:文本长度:scrollHeight` 签名）的变化；
 *     纯 CSS 动画（spinner）不改 DOM/文本/尺寸时可能判 stalled——按 hint 转 screenshot 复核，不假绿（判据本就未成立）。
 *   - 跨域 iframe 文本不可见（与 TEXT_EXISTS_V2_SRC 同边界）；selector/count 走同源 docs walk。
 *   - 本模块只做只读 evaluate（零 Input、零页面写、零注入 observer）；不承担点击/输入派发。
 */
const { TEXT_EXISTS_V2_SRC, buildVerifyExpr } = require('./target-resolver');
const time = require('./time');

const sleep = time.sleep;

/* ── 常量（selftest #99 M4 守卫直读） ── */
const EFFECT_MS_DEFAULT = 30000; // v2 裁决⑤：默认 30000（对齐 wait 家族；仅显式 --expect-* 生效）
const EFFECT_MS_MIN = 500;       // M4：任何 settle 判定不得设 <100ms 短封顶；下限 500 留出至少 1 个节距
const EFFECT_MS_MAX = 180000;    // 借鉴上限（报告 A3）
const EFFECT_POLL_MS = 400;      // 轮询节距（flow-engine assert 同款；禁止更细/50ms）
const VERDICT_EVERY = 3;         // 主体 X4 判态采样频度（每 3 次轮询 1 次，控重扫描成本）
const PROBE_TIMEOUT_MAX = 2000;  // 单次探测 evaluate 超时上限（冻结页不拖爆 settle 预算）
const VALUE_MAX = 200;           // effect 报告里读回值截断

const PHASES = Object.freeze({
  CONFIRMED: 'confirmed',
  EFFECT_PENDING: 'effect_pending',
  DISPATCHED: 'dispatched',
  STALLED: 'stalled',
});
const TERMINAL_PHASES = new Set(Object.values(PHASES));

/* ── effect-ms 归一（纯函数） ── */
function normalizeEffectMs(value) {
  if (value === undefined || value === null) return EFFECT_MS_DEFAULT;
  if (value === true) throw new Error('--effect-ms 缺值（毫秒；默认 30000，范围 500~180000）');
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < EFFECT_MS_MIN || n > EFFECT_MS_MAX) {
    throw new Error(`--effect-ms 须为 ${EFFECT_MS_MIN}~${EFFECT_MS_MAX} 的整数毫秒（收到 ${JSON.stringify(value)}；默认 ${EFFECT_MS_DEFAULT}）`);
  }
  return n;
}

/* ── --expect-count 文法：css=n（以最后一个 '=' 分割，容忍属性选择器里的 '='） ── */
function parseCountSpec(raw) {
  const s = String(raw == null ? '' : raw);
  const at = s.lastIndexOf('=');
  if (at <= 0) throw new Error(`--expect-count 须为 <css选择器>=<非负整数>（收到 ${JSON.stringify(raw)}）`);
  const selector = s.slice(0, at).trim();
  const countRaw = s.slice(at + 1).trim();
  if (!selector) throw new Error(`--expect-count 缺 CSS 选择器（左）=<n>（收到 ${JSON.stringify(raw)}）`);
  if (!/^\d+$/.test(countRaw)) throw new Error(`--expect-count 右侧须为非负整数（收到 ${JSON.stringify(countRaw)}）`);
  return { selector, count: Number(countRaw) };
}

/**
 * CLI 旗标解析（建连前调用；错误消息含「缺值/至多一种/须为/不接受值」→ die 归类 E_USAGE）。
 * @returns {null | {spec:object, effectMs:number, noWait:boolean}}
 *   null = 未激活（无任何 --expect-*；--effect-ms/--no-wait-effect 单独出现=no-op，仅做参数卫生校验）。
 */
function parseFlags(flags) {
  const f = flags || {};
  const provided = [];
  for (const k of ['expect-text', 'expect-value', 'expect-selector', 'expect-count']) {
    if (f[k] !== undefined) provided.push(k);
  }
  if (!provided.length) {
    // 无判据 = 裸命令路径：只校验新旗标的参数卫生，不激活判定（输出/调用零变化）
    if (f['no-wait-effect'] !== undefined && f['no-wait-effect'] !== true) {
      throw new Error('--no-wait-effect 不接受值（无参开关）');
    }
    if (f['effect-ms'] !== undefined) normalizeEffectMs(f['effect-ms']);
    return null;
  }
  if (provided.length > 1) {
    throw new Error(`--expect-* 至多一种（实际 ${provided.map((k) => '--' + k).join(' + ')}）：一次只验证一个判据，避免多判据时序歧义`);
  }
  if (f['no-wait-effect'] !== undefined && f['no-wait-effect'] !== true) {
    throw new Error('--no-wait-effect 不接受值（无参开关）');
  }
  const key = provided[0];
  const raw = f[key];
  if (raw === true) throw new Error(`--${key} 缺值`);
  let spec;
  if (key === 'expect-text') {
    const text = String(raw);
    if (!text) throw new Error('--expect-text 缺值（要等待出现的可见文本）');
    spec = { kind: 'text', text };
  } else if (key === 'expect-value') {
    const value = String(raw);
    if (!value) throw new Error('--expect-value 缺值（交互主体元素应读回的值）');
    spec = { kind: 'value', value };
  } else if (key === 'expect-selector') {
    const selector = String(raw).trim();
    if (!selector) throw new Error('--expect-selector 缺值（等待存在的 CSS 选择器）');
    spec = { kind: 'selector', selector };
  } else {
    spec = Object.assign({ kind: 'count' }, parseCountSpec(raw));
  }
  return { spec, effectMs: normalizeEffectMs(f['effect-ms']), noWait: f['no-wait-effect'] === true };
}

/** 判据的人类可读描述（stderr/信封 effect.expect） */
function describeSpec(spec) {
  switch (spec.kind) {
    case 'text': return `文本「${String(spec.text).slice(0, 80)}」出现`;
    case 'value': return `主体元素值 === ${JSON.stringify(String(spec.value).slice(0, 80))}`;
    case 'selector': return `选择器 ${String(spec.selector).slice(0, 120)} 存在`;
    case 'count': return `选择器 ${String(spec.selector).slice(0, 120)} 命中数 === ${spec.count}`;
    default: return String(spec.kind);
  }
}

/* ── 四态状态机（纯函数；selftest #99 全转移覆盖） ──
 * 实例=单次命令调用；内部中间态 `settling` 不是对外 phase。
 * 终态吸收；retry=新实例（本函数显式允许 terminal --retry--> settling 以建模重跑）。 */
function nextPhase(state, event, ctx) {
  const c = ctx || {};
  if (state === 'idle') {
    if (event === 'dispatch') return c.noWait ? PHASES.DISPATCHED : 'settling';
    if (event === 'no_wait_effect') return PHASES.DISPATCHED;
    return state;
  }
  if (state === 'settling') {
    if (event === 'criterion_met') return PHASES.CONFIRMED;
    if (event === 'window_expired') return c.progress ? PHASES.EFFECT_PENDING : PHASES.STALLED;
    if (event === 'no_wait_effect') return PHASES.DISPATCHED;
    if (event === 'probe_unobservable') return PHASES.STALLED;
    return state;
  }
  if (TERMINAL_PHASES.has(state)) {
    if (event === 'retry') return c.noWait ? PHASES.DISPATCHED : 'settling'; // 新实例
    return state; // 终态吸收
  }
  return state;
}

/* ── 页面侧探测表达式（只读 evaluate） ── */

const SIG_SRC = `var __dom = 0, __txt = 0, __sc = 0;
  try { __dom = document.getElementsByTagName('*').length; } catch (e) {}
  try { __txt = ((document.body && document.body.innerText) || '').length; } catch (e) {}
  try { __sc = document.documentElement.scrollHeight; } catch (e) {}`;

const DOCS_WALK_SRC = `var docs = [];
  (function walk(doc) { docs.push(doc);
    var fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch (e) {}
    for (var i = 0; i < fr.length; i++) { var inner = null; try { inner = fr[i].contentDocument; } catch (e) {} if (inner) walk(inner); }
  })(document);`;

/**
 * 判据探测表达式：返回 {hit, signal, sig, value}。
 * - text：直接复用 TEXT_EXISTS_V2_SRC（X2 两级漏斗；不照抄 GATE4_SRC）
 * - selector/count：同源 docs walk 内 querySelectorAll 计数
 * - value：读交互主体元素（subjectExpr 优先；缺省 document.activeElement）的 value/innerText/textContent
 * @param {object} spec parseFlags().spec
 * @param {string} [subjectExpr] 主体元素表达式（如 locator.buildFindElementExpr(candidate)）
 */
function buildProbeExpr(spec, subjectExpr) {
  if (spec.kind === 'text') {
    const q = JSON.stringify(String(spec.text));
    return `(function () {
      var q = ${q};
      var hit = false;
      try { hit = (${TEXT_EXISTS_V2_SRC})(q); } catch (e) { hit = false; }
      ${SIG_SRC}
      var partial = 0;
      try { var t = ((document.body && document.body.innerText) || ''); partial = t.indexOf(q) !== -1 ? 1 : 0; } catch (e) {}
      return { hit: !!hit, signal: hit ? 2 : (partial ? 1 : 0), sig: __dom + ':' + __txt + ':' + __sc, value: null };
    })()`;
  }
  if (spec.kind === 'selector' || spec.kind === 'count') {
    const sel = JSON.stringify(String(spec.selector));
    const hitExpr = spec.kind === 'selector' ? 'n > 0' : `n === ${Number(spec.count)}`;
    return `(function () {
      var sel = ${sel};
      ${DOCS_WALK_SRC}
      var n = 0;
      for (var i = 0; i < docs.length; i++) {
        try { n += docs[i].querySelectorAll(sel).length; }
        catch (e) { return { hit: false, signal: -1, sig: 'bad-selector', value: null, error: String(e && e.message || e) }; }
      }
      ${SIG_SRC}
      return { hit: ${hitExpr}, signal: n, sig: __dom + ':' + __txt + ':' + __sc, value: null };
    })()`;
  }
  if (spec.kind === 'value') {
    const subject = subjectExpr && String(subjectExpr).trim() ? `(${subjectExpr})` : 'document.activeElement';
    return `(function () {
      ${SIG_SRC}
      var el = null; try { el = ${subject}; } catch (e) { el = null; }
      var val = null;
      try {
        if (el) {
          var tag = String(el.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select') val = String(el.value == null ? '' : el.value);
          else if (el.isContentEditable) val = String(el.innerText || '').trim();
          else val = String(el.textContent || '').trim();
        }
      } catch (e) { val = null; }
      return {
        hit: val !== null && val === ${JSON.stringify(String(spec.value))},
        signal: val === null ? -1 : val.length,
        sig: __dom + ':' + __txt + ':' + __sc,
        value: val === null ? null : val.slice(0, ${VALUE_MAX}),
      };
    })()`;
  }
  throw new Error(`未知 expect 判据：${JSON.stringify(spec)}`);
}

/** 组合表达式：判据 + 主体 X4 判态（VERDICT_EVERY 采样时用；一次 evaluate 拿两样） */
function buildCombinedExpr(probeExpr, best) {
  return `(function () {
    var __p = ${probeExpr};
    var __v = null;
    try { __v = (${buildVerifyExpr(best)}); } catch (e) { __v = 'probe-error'; }
    return { probe: __p, verdict: __v };
  })()`;
}

/** 单次探测：返回 {probe, verdict|null}；evaluate 无返回值视为探测失败（抛错由 settle 收割） */
async function probeOnce(client, sessionId, expression, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: false, userGesture: false,
  }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v || typeof v !== 'object') throw new Error('探测 evaluate 无结构化返回值');
  if (v.probe && typeof v.probe === 'object') return { probe: v.probe, verdict: v.verdict === undefined ? null : v.verdict };
  return { probe: v, verdict: null };
}

/**
 * 事件驱动 settle：派发后按 deadline 轮询判据，返回四态 phase + effect 报告。
 * @param {object} client CdpClient（或 fake：需 send('Runtime.evaluate')）
 * @param {string} sessionId
 * @param {{spec:object, effectMs?:number, noWait?:boolean, target?:object, subjectExpr?:string}} opts
 *   target = 交互主体候选（{tag,id?,text,rect,frame}；有则采样 X4 判态作为进展信号）
 * @returns {Promise<{phase:string, effect:object}>}
 */
async function settleEffect(client, sessionId, opts) {
  const o = opts || {};
  if (!o.spec) throw new Error('settleEffect 需要 spec（裸命令不得调用本函数）');
  const effectMs = normalizeEffectMs(o.effectMs);
  const noWait = o.noWait === true;
  const spec = o.spec;
  const t0 = Date.now();
  const base = {
    kind: spec.kind, expect: describeSpec(spec), effectMs, noWait,
    polls: 0, waitedMs: 0, progress: false, firstProgressMs: null,
    observable: true, errors: 0, lastError: null, lastValue: null, targetVerdict: null,
  };
  const done = (phase, extra) => ({ phase, effect: Object.assign(base, extra || {}) });

  if (noWait) return done(nextPhase('settling', 'no_wait_effect'));

  const probeExpr = buildProbeExpr(spec, o.subjectExpr);
  const verdictEnabled = !!(o.target && o.target.rect);
  let last = null; // {signal, sig}
  let lastVerdict = null; // 最近一次采到的 X4 判态（采样间隔间不重置，保证跨采样可比）
  let progress = false;
  let firstProgressMs = null;
  let errors = 0;
  let lastError = null;
  let lastValue = null;
  let polls = 0;
  let hit = false;
  let matchedAtMs = null;

  for (;;) {
    const elapsed = Date.now() - t0;
    const budget = Math.max(EFFECT_MS_MIN, Math.min(PROBE_TIMEOUT_MAX, effectMs - elapsed));
    const useVerdict = verdictEnabled && (polls % VERDICT_EVERY === 0); // 第 1 次（polls=0）+ 每 3 次
    const expr = useVerdict ? buildCombinedExpr(probeExpr, o.target) : probeExpr;
    polls++;
    let sample = null;
    try {
      sample = await probeOnce(client, sessionId, expr, budget);
    } catch (e) {
      errors++;
      lastError = String((e && e.message) || e).slice(0, 200);
    }
    if (sample && sample.probe) {
      if (sample.probe.error && !lastError) lastError = String(sample.probe.error).slice(0, 200);
      if (sample.probe.value !== undefined && sample.probe.value !== null) lastValue = String(sample.probe.value).slice(0, VALUE_MAX);
      if (sample.probe.hit === true) {
        hit = true;
        matchedAtMs = Date.now() - t0;
        if (sample.verdict) base.targetVerdict = sample.verdict;
        break;
      }
      const snap = {
        signal: sample.probe.signal,
        sig: sample.probe.sig,
      };
      if (last) {
        if (snap.signal !== last.signal || snap.sig !== last.sig) progress = true;
      }
      const verdict = sample.verdict === undefined ? null : sample.verdict;
      if (verdict) {
        if (lastVerdict && verdict !== lastVerdict) progress = true;
        lastVerdict = verdict;
        base.targetVerdict = verdict;
      }
      if (progress && firstProgressMs === null) firstProgressMs = Date.now() - t0;
      last = snap;
    }
    const elapsed2 = Date.now() - t0;
    if (elapsed2 >= effectMs) break;
    await sleep(Math.min(EFFECT_POLL_MS, effectMs - elapsed2));
  }

  const waitedMs = Date.now() - t0;
  base.polls = polls;
  base.waitedMs = waitedMs;
  base.progress = progress;
  base.firstProgressMs = firstProgressMs;
  base.errors = errors;
  base.lastError = lastError;
  base.lastValue = lastValue;
  base.observable = errors < polls;
  if (hit) {
    base.matchedAtMs = matchedAtMs;
    return done(nextPhase('settling', 'criterion_met'));
  }
  if (errors === polls) return done(nextPhase('settling', 'probe_unobservable'));
  return done(nextPhase('settling', 'window_expired', { progress }));
}

/** 候选 → buildVerifyExpr 需要的身份对象（text 截 80 与页面侧重找口径对齐，防身份比对恒失败假 progress） */
function toVerifyTarget(candidate) {
  if (!candidate || !candidate.rect) return null;
  return {
    tag: String(candidate.tag || ''),
    id: String(candidate.id || ''),
    text: String(candidate.text || '').trim().slice(0, 80),
    rect: candidate.rect,
    frame: String(candidate.frame || 'main'),
  };
}

/** stall 取证指引（stderr / 信封 hint 共用单源） */
const STALL_HINT = '取证建议：① screenshot 看当前画面 ② console --listen 0 查报错 ③ wait --text <期望文本> --timeout 10000 延长观察 ④ 动作可疑时重跑并加 --nth/--selector 精确定位，或 doctor 查通道';

module.exports = {
  // 常量（M4 守卫直读）
  EFFECT_MS_DEFAULT, EFFECT_MS_MIN, EFFECT_MS_MAX, EFFECT_POLL_MS, VERDICT_EVERY, PROBE_TIMEOUT_MAX, VALUE_MAX,
  PHASES, STALL_HINT,
  // 纯函数
  normalizeEffectMs, parseCountSpec, parseFlags, describeSpec, nextPhase, buildProbeExpr, buildCombinedExpr,
  toVerifyTarget,
  // 运行时
  settleEffect,
};
