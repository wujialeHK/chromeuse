'use strict';
/*
 * chromeuse lib/assert.js —— 批量断言独立命令（B4/N9 #105，V202611030006）
 *
 * 定位：把「验收靠 wait+eval 手写」升级为一条命令多断言；默认失败不中断（exit 0）输出完整明细，
 * --fail-fast 才在首个失败处中止并 exit 1。与 B2/R1 的关系（防两套判定）：
 *   - text/count 判据表达式**直接复用** lib/expect.js 的 buildProbeExpr（同源 TEXT_EXISTS_V2_SRC
 *     两级漏斗 + 同源 docs walk 计数）；
 *   - attr 是 expect.js 未覆盖的判据（B2 只有 text/value/selector/count），本模块按同一 docs walk
 *     模式补一条只读表达式（不复制 X2 漏斗），并在 mechanisms §12 声明边界；
 *   - flow replay --post-verify 的 X4 复核复用 target-resolver.buildVerifyExpr（与本模块独立），
 *     两者不判同一语义，互不影响（见 mechanisms §12 兼容性说明）。
 *
 * 红线：全部断言只读（Runtime.evaluate；console 断言复用 drive.captureConsole 的 enable+短排水窗）。
 */
const expect = require('./expect');
const drive = require('./drive');
const { evaluate } = require('./cdp-core');

const DEFAULT_TIMEOUT_MS = 5000;

/* ── 参数解析（纯函数；错误消息含「须为/缺值/非法」→ die 归类 E_USAGE） ── */

/** --count <css>=<n>（复用 B2 单源 expect.parseCountSpec；文案改成本命令旗标名） */
function parseCountArg(raw) {
  try {
    return expect.parseCountSpec(raw);
  } catch (e) {
    throw new Error(String(e && e.message || e).replace(/--expect-count/g, '--count'));
  }
}

/** --attr <css>@<name>=<value>：属性名限定 [A-Za-z_:][-A-Za-z0-9_:.]*，值可含 '=' */
function parseAttrArg(raw) {
  const s = String(raw == null ? '' : raw);
  const m = /^(.*)@([A-Za-z_:][-A-Za-z0-9_:.]*)=([\s\S]*)$/.exec(s);
  if (!m) throw new Error(`--attr 须为 <css>@<name>=<value>（收到 ${JSON.stringify(raw)}；例：#btn@aria-label=提交）`);
  const selector = m[1].trim();
  const name = m[2].trim();
  const value = m[3];
  if (!selector) throw new Error(`--attr 缺 CSS 选择器（@ 左侧；收到 ${JSON.stringify(raw)}）`);
  return { selector, name, value };
}

/** --url <pattern>：/re/flags 或裸正则源；剥掉 g/y 防 test 状态污染 */
function parseUrlPattern(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) throw new Error('--url 缺值（URL 正则）');
  let re;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
  try {
    re = m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(s);
  } catch (e) {
    throw new Error(`--url 正则非法：${e.message}`);
  }
  return { pattern: s, regex: re };
}

/** 断言清单归一（建连前；空=用法错） */
function normalizeAssertions(input) {
  const a = input || {};
  const list = [];
  for (const raw of (a.count || [])) { const p = parseCountArg(raw); list.push({ kind: 'count', selector: p.selector, expected: p.count }); }
  for (const raw of (a.text || [])) {
    if (raw === true || String(raw) === '') throw new Error('--text 缺值（要断言的可见文本）');
    list.push({ kind: 'text', text: String(raw) });
  }
  for (const raw of (a.attr || [])) { const p = parseAttrArg(raw); list.push({ kind: 'attr', selector: p.selector, name: p.name, expected: p.value }); }
  for (const raw of (a.url || [])) { const p = parseUrlPattern(raw); list.push({ kind: 'url', pattern: p.pattern, regex: p.regex }); }
  if (a.noConsoleError) list.push({ kind: 'no-console-error' });
  return list;
}

/* ── 页面侧表达式（只读） ── */

/** attr 判据：同 docs walk 模式（expect.js 的 DOCS_WALK_SRC 未导出；此处只补 attr 单一判据） */
function buildAttrProbeExpr(selector, name) {
  return `(function(){
    var sel = ${JSON.stringify(String(selector))};
    var name = ${JSON.stringify(String(name))};
    var docs = [];
    (function walk(doc){
      docs.push(doc);
      var fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
      for (var i = 0; i < fr.length; i++) {
        var inner = null; try { inner = fr[i].contentDocument; } catch(e) {}
        if (inner) walk(inner);
      }
    })(document);
    var values = [], count = 0;
    for (var d = 0; d < docs.length; d++) {
      var els = [];
      try { els = docs[d].querySelectorAll(sel); } catch(e) { return { hit: false, signal: -1, value: null, error: String(e && e.message || e) }; }
      for (var j = 0; j < els.length; j++) {
        count++;
        var v = null; try { v = els[j].getAttribute(name); } catch(e) { v = null; }
        if (v !== null) values.push(String(v));
      }
    }
    return { hit: false, signal: values.length === 0 ? -1 : count, value: values.length ? values[0] : null, values: values.slice(0, 8), count: count };
  })()`;
}

async function probeOnce(client, sessionId, expression, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: false, userGesture: false,
  }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v || typeof v !== 'object') throw new Error('断言探测 evaluate 无结构化返回值');
  return v;
}

function expectedOf(a) {
  switch (a.kind) {
    case 'count': return a.expected;
    case 'text': return a.text;
    case 'attr': return a.expected;
    case 'url': return a.pattern;
    case 'no-console-error': return 0;
    default: return null;
  }
}

/** 单条断言执行（异常=该条 passed:false + error，不中断其它条目） */
async function runOne(client, sessionId, a, ctx) {
  const timeoutMs = ctx.timeoutMs || DEFAULT_TIMEOUT_MS;
  const base = { kind: a.kind, expected: expectedOf(a), actual: null, passed: false };
  try {
    if (a.kind === 'text' || a.kind === 'count') {
      const spec = a.kind === 'text'
        ? { kind: 'text', text: a.text }
        : { kind: 'count', selector: a.selector, count: a.expected };
      const probe = await probeOnce(client, sessionId, expect.buildProbeExpr(spec), timeoutMs);
      base.passed = probe.hit === true;
      base.actual = a.kind === 'text' ? probe.hit === true : probe.signal;
      if (probe.error) base.error = String(probe.error).slice(0, 200);
      return base;
    }
    if (a.kind === 'attr') {
      const v = await probeOnce(client, sessionId, buildAttrProbeExpr(a.selector, a.name), timeoutMs);
      const values = Array.isArray(v.values) ? v.values.map(String) : [];
      base.actual = values.length ? values[0] : null;
      base.passed = values.includes(String(a.expected));
      if (values.length > 1) base.matches = values.length;
      if (v.error) base.error = String(v.error).slice(0, 200);
      return base;
    }
    if (a.kind === 'url') {
      const v = await probeOnce(client, sessionId, '({ href: String(location.href || "") })', timeoutMs);
      base.actual = String(v.href || '');
      base.passed = a.regex.test(base.actual);
      return base;
    }
    if (a.kind === 'no-console-error') {
      if (!ctx.consoleCache) ctx.consoleCache = await drive.captureConsole(client, sessionId, { listenMs: 0, timeoutMs });
      const entries = (ctx.consoleCache && ctx.consoleCache.entries) || [];
      const errors = entries.filter((e) => e && (e.kind === 'exception' || String(e.level).toLowerCase() === 'error'));
      base.actual = errors.length;
      base.passed = errors.length === 0;
      if (errors.length) base.samples = errors.slice(0, 3).map((e) => String(e.text || '').slice(0, 160));
      base.note = ctx.consoleCache && ctx.consoleCache.enabled && ctx.consoleCache.enabled.runtime
        ? 'Runtime.enable 缓存回放（Chrome 153 实测；88 未验证）'
        : '运行时缓存不可用，读到的可能是空历史';
      return base;
    }
    base.error = `未知断言类型 ${a.kind}`;
    return base;
  } catch (e) {
    base.error = String((e && e.message) || e).slice(0, 300);
    return base;
  }
}

/**
 * 批量执行（顺序；默认不中断，fail-fast 遇首个失败即停）。
 * @returns {Promise<{passed:boolean, results:object[], stopped:boolean}>}
 */
async function runAssertions(client, sessionId, assertions, opts) {
  const o = opts || {};
  const ctx = { timeoutMs: o.timeoutMs || DEFAULT_TIMEOUT_MS, consoleCache: null };
  const results = [];
  let stopped = false;
  for (const a of (assertions || [])) {
    const r = await runOne(client, sessionId, a, ctx);
    results.push(r);
    if (o.failFast && !r.passed) { stopped = true; break; }
  }
  return { passed: results.length > 0 && results.every((r) => r.passed), results, stopped };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  parseCountArg, parseAttrArg, parseUrlPattern, normalizeAssertions,
  buildAttrProbeExpr, runOne, runAssertions,
};
