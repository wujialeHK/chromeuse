'use strict';
/*
 * chromeuse lib/har.js —— net 采集 → HAR 1.2 导出（C7 #122，V20261113003）
 *
 * 定位：`tools/cdp.js net --har <path>` 的唯一构建单源。纯函数为主（可单测），零第三方依赖。
 * 最小子集（计划内定，不追求全字段）：log{version/creator/pages}/entries[]——
 *   request{method/url/httpVersion/headers/queryString/cookies/headersSize/bodySize/postData?}
 *   response{status/statusText/httpVersion/headers/cookies/content{size/mimeType/text?}/redirectURL/headersSize/bodySize}
 *   + pageref（页签维度 page 引用）+ cache{} + timings{send/wait/receive}。未知量一律 -1（HAR 1.2 允许）。
 *
 * 脱敏（mechanisms §16 规则复用=引用，不重写模式）：
 * - 头值按 `name: value` 形态过 redact.text()——Authorization/Cookie/Set-Cookie/Bearer/JSON 敏感键
 *   （api_key 族）等 §16 内置模式原样命中；命中即替换为 `<redacted:NAME>`。
 * - URL、postData、响应体文本直接过 redact.text()；queryString 的 name 命中 rules.urlSet → `<redacted:name>`。
 * - 不自行维护敏感名单（单源在 lib/redact.js）；`--no-redact` 由进程级 enabled=false 统一放行。
 *
 * 边界（如实）：
 * - 响应体按 UTF-8 解码（二进制资源会失真；net 采集本身即此口径）；
 * - 结构化 cookies 数组不展开（cookie 头已在 headers 层脱敏）；
 * - timings 无分段数据（CDP 事件未采），send/wait/receive 全 -1，time 为 request→loadingFinished 的实测毫秒或 -1。
 */
const redact = require('./redact');

const HAR_VERSION = '1.2';
const PAGE_ID = 'page_1';
const DEFAULT_CREATOR = { name: 'chromeuse', version: 'unknown' };

const MARK = (name) => redact.MARK(name);

/** 头值脱敏（复用 §16 规则：借 `name: value` 文本形态命中头名模式） */
function redactHeaderValue(name, value, redactText) {
  const line = `${name}: ${value}`;
  let out;
  try { out = redactText(line); } catch { return { value, changed: false }; }
  if (typeof out !== 'string' || out === line) return { value, changed: false };
  const idx = out.indexOf(': ');
  return { value: idx >= 0 ? out.slice(idx + 2) : out, changed: true };
}

/** URL query → HAR queryString（值走 urlSet 引用 / redactText；坏 URL fail-soft 空数组） */
function queryStringOf(url, redactText, urlSet) {
  let u;
  try { u = new URL(String(url == null ? '' : url)); } catch { return []; }
  const out = [];
  for (const [name, value] of u.searchParams) {
    const hit = urlSet && typeof urlSet.has === 'function' && urlSet.has(String(name).toLowerCase());
    out.push({ name, value: hit ? MARK(name) : redactText(value) });
  }
  return out;
}

/** CDP 头对象 → HAR headers[]（保序；空/异常 → []） */
function headersOf(headers, counters, redactText) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  const out = [];
  for (const [name, value] of Object.entries(headers)) {
    const raw = value === null || value === undefined ? '' : String(value);
    const r = redactHeaderValue(name, raw, redactText);
    if (r.changed) counters.redacted++;
    out.push({ name: String(name), value: r.value });
  }
  return out;
}

/** 文本型字段脱敏（计数：命中即 +1；非字符串原样） */
function redactField(value, counters, redactText) {
  if (typeof value !== 'string' || !value) return value;
  const out = redactText(value);
  if (typeof out === 'string' && out !== value) counters.redacted++;
  return out;
}

/** CDP 协议串（http/1.1）→ HAR httpVersion（HTTP/1.1）；未知 → 空串（规范允许） */
function httpVersionOf(protocol) {
  const p = String(protocol == null ? '' : protocol).trim();
  if (!p) return '';
  const m = /^([a-z]+)\/([0-9.]+)$/i.exec(p);
  return m ? `${m[1].toUpperCase()}/${m[2]}` : '';
}

/**
 * HAR 1.2 构建（纯函数）。
 * @param {{capturedAt?:string, startedAt?:string, target?:{url?:string,title?:string}, requests?:Array}} capture
 *   requests[] 单条 = {id,url,method,status,statusText?,mime,protocol?,reqHeaders?,respHeaders?,
 *                      hasPost?,postData?,body?,bodyErr?,err?,startedAt?,timeMs?}
 * @param {{creator?:{name:string,version:string}, redactText?:Function, urlSet?:Set<string>, now?:string}} [opts]
 * @returns {{har:object, stats:{entries:number, redacted:number, networkErrors:number, bodyErrors:number}}}
 */
function buildHar(capture, opts) {
  const o = opts || {};
  const cap = capture && typeof capture === 'object' ? capture : {};
  const requests = Array.isArray(cap.requests) ? cap.requests : [];
  const counters = { redacted: 0 };
  const redactText = typeof o.redactText === 'function' ? o.redactText : (s) => redact.text(s);
  const urlSet = o.urlSet || (() => { try { return redact.getRules().urlSet; } catch { return null; } })();
  const startedDateTime = String((cap.startedAt || cap.capturedAt) || o.now || new Date().toISOString());
  const pageUrl = String((cap.target && cap.target.url) || '');
  const pageTitle = String((cap.target && cap.target.title) || '');

  const entries = [];
  let networkErrors = 0, bodyErrors = 0;
  for (const r of requests) {
    if (!r || typeof r !== 'object') continue;
    const method = String(r.method || 'GET');
    const url = String(r.url || '');
    const reqHeaders = r.reqHeaders || {};
    const postData = typeof r.postData === 'string' && r.postData ? r.postData : null;
    const reqMime = typeof reqHeaders['Content-Type'] === 'string' ? reqHeaders['Content-Type']
      : (typeof reqHeaders['content-type'] === 'string' ? reqHeaders['content-type'] : '');
    const body = typeof r.body === 'string' ? r.body : null;
    const failed = !!r.err;
    if (failed) networkErrors++;
    if (r.bodyErr) bodyErrors++;

    const request = {
      method,
      url: redactField(url, counters, redactText),
      httpVersion: httpVersionOf(r.protocol),
      cookies: [],
      headers: headersOf(reqHeaders, counters, redactText),
      queryString: queryStringOf(url, redactText, urlSet),
      headersSize: -1,
      bodySize: postData ? Buffer.byteLength(postData) : 0,
    };
    if (postData) request.postData = { mimeType: reqMime, text: redactField(postData, counters, redactText) };

    const content = {
      size: body === null ? 0 : Buffer.byteLength(body),
      mimeType: String(r.mime || 'x-unknown'),
    };
    if (body !== null) content.text = redactField(body, counters, redactText);
    if (r.bodyErr) content._chromeuseBodyError = redactField(String(r.bodyErr), counters, redactText);

    const response = {
      status: failed ? 0 : (Number.isFinite(Number(r.status)) ? Number(r.status) : 0),
      statusText: failed ? '' : String(r.statusText || ''),
      httpVersion: httpVersionOf(r.protocol),
      cookies: [],
      headers: headersOf(r.respHeaders, counters, redactText),
      content,
      redirectURL: '',
      headersSize: -1,
      bodySize: body === null ? -1 : Buffer.byteLength(body),
    };

    const entry = {
      pageref: PAGE_ID,
      startedDateTime: String(r.startedAt || startedDateTime),
      time: Number.isFinite(Number(r.timeMs)) ? Number(r.timeMs) : -1,
      request,
      response,
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
    };
    if (failed) entry._chromeuseError = redactField(String(r.err), counters, redactText);
    entries.push(entry);
  }

  const har = {
    log: {
      version: HAR_VERSION,
      creator: Object.assign({}, DEFAULT_CREATOR, (o.creator && typeof o.creator === 'object') ? o.creator : {}),
      pages: [{
        startedDateTime,
        id: PAGE_ID,
        title: redactField(pageTitle || pageUrl || 'chromeuse-net', counters, redactText) || 'chromeuse-net',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries,
      _chromeuse: {
        capturedAt: String(cap.capturedAt || startedDateTime),
        target: redactField(pageUrl, counters, redactText),
      },
    },
  };
  return { har, stats: { entries: entries.length, redacted: counters.redacted, networkErrors, bodyErrors } };
}

module.exports = { HAR_VERSION, PAGE_ID, DEFAULT_CREATOR, buildHar, redactHeaderValue, queryStringOf, headersOf, httpVersionOf };
