'use strict';
/*
 * chromeuse lib/matchers.js —— 应用识别 matchers（分段锚定）+ 约束度打分 + 用户断言账本（V202609080009）
 * 规格 = reports/report_20260908_010_chromeuse-执行方案-v2.1-合成定稿.md §V009 + 需求 A 终审合成。
 *
 * 语法：urlPattern = host[:port][/pathPrefix]；host 通配仅两种——整段 `*`（单独成 host = 任意主机）
 *       或整段 `*` 出现在段位（如 `*.example.com`）；段内部分通配（192.168.*）不合法（语义=整段）。
 *       正则不做（ReDoS）；裸子串语义被否决（同网段 IP 必炸：192.168.1.7 子串命中 192.168.1.70）。
 * 匹配语义：URL 归一（去 query/hash/尾斜杠）→ host 段锚定（段数相等逐段相等，* 段任配）+ 端口 + pathPrefix 段边界前缀。
 * 约束度：确定性打分——精确段 4 分/段、通配段 0 分；有 port +2；有 pathPrefix +1+段数（越深越约束）。
 *         同分多命中 = 歧义（问用户一次并会话内记住），禁"第一个命中即止"（声明序耦合）。
 * 优先级：用户断言（tmpdata/url-assertions.jsonl，host:port 级）> 精确模式 > 宽模式。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { parse } = require('./jsonc');

const ASSERTIONS_FILE = path.join(paths.TMPDATA_DIR, 'url-assertions.jsonl');

/* ── 模式解析 ── */
function parsePattern(raw) {
  const s = String(raw || '').trim();
  const m = /^([^/]+)(\/.*)?$/.exec(s);
  if (!m) return { ok: false, error: '缺 host 部分', raw: s };
  let host = m[1];
  let port = null;
  const pi = host.lastIndexOf(':');
  if (pi > -1) {
    const p = host.slice(pi + 1);
    if (!/^\d{1,5}$/.test(p)) return { ok: false, error: `端口非法：${p}`, raw: s };
    port = parseInt(p, 10);
    host = host.slice(0, pi);
  }
  const hostAny = host === '*';
  const hostSegments = host.split('.');
  for (const seg of hostSegments) {
    if (seg === '*' || /^[a-z0-9-]+$/i.test(seg)) continue;
    return { ok: false, error: `host 段非法（仅整段 * 或 [a-z0-9-]，段内部分通配不支持）：${seg}`, raw: s };
  }
  let pathPrefix = null;
  let pathSegments = [];
  if (m[2]) {
    pathPrefix = '/' + m[2].replace(/^\/+/, '').replace(/\/+$/, '');
    pathSegments = pathPrefix.slice(1).split('/');
    if (pathSegments.some((x) => !x)) return { ok: false, error: 'pathPrefix 出现空段', raw: s };
  }
  return { ok: true, raw: s, hostAny, hostSegments, port, pathPrefix, pathSegments };
}

/* ── URL 归一：去 query/hash/尾斜杠 → { host, port, path } ── */
function normalizeUrl(url) {
  let u = String(url || '').trim().split('#')[0];
  const q = u.indexOf('?');
  if (q > -1) u = u.slice(0, q);
  const m = /^([a-z][a-z0-9+.-]*:)?(\/\/)?([^/?#]+)(\/.*)?$/i.exec(u);
  if (!m) return null;
  let authority = m[3];
  let port = null;
  const hi = authority.lastIndexOf(':');
  if (hi > -1 && /^\d{1,5}$/.test(authority.slice(hi + 1))) {
    port = parseInt(authority.slice(hi + 1), 10);
    authority = authority.slice(0, hi);
  }
  const scheme = (m[1] || 'http:').toLowerCase();
  if (port === null) port = scheme === 'https:' ? 443 : 80;
  let p = m[4] || '/';
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  return { host: authority.toLowerCase(), port, path: p };
}

/* ── 单模式匹配 ── */
function matchPattern(pat, u) {
  if (!pat.hostAny) {
    const segs = u.host.split('.');
    if (segs.length !== pat.hostSegments.length) return false;
    for (let i = 0; i < segs.length; i++) {
      if (pat.hostSegments[i] === '*') continue;
      if (pat.hostSegments[i].toLowerCase() !== segs[i]) return false;
    }
  }
  if (pat.port !== null && u.port !== null && pat.port !== u.port) return false;
  if (pat.pathPrefix) {
    const usegs = u.path === '/' ? [] : u.path.slice(1).split('/');
    if (usegs.length < pat.pathSegments.length) return false;
    for (let i = 0; i < pat.pathSegments.length; i++) {
      if (usegs[i].toLowerCase() !== pat.pathSegments[i].toLowerCase()) return false;
    }
  }
  return true;
}

/* ── 约束度确定性打分（精确段>通配段；有 port>省略；有 pathPrefix>省略；同段数少通配胜） ── */
function specificity(pat) {
  let s = 0;
  if (!pat.hostAny) for (const seg of pat.hostSegments) s += seg === '*' ? 0 : 4;
  if (pat.port !== null) s += 2;
  if (pat.pathPrefix) s += 1 + pat.pathSegments.length;
  return s;
}

/** 匹配一组模式：返回 { matched, ambiguous, hits[{pattern,score}], best }；同分多命中 = ambiguous */
function matchUrl(patterns, url) {
  const u = typeof url === 'string' ? normalizeUrl(url) : url;
  if (!u) return { ok: false, matched: false, ambiguous: false, hits: [], best: null, error: 'URL 无法解析' };
  const hits = [];
  for (const p of patterns || []) {
    const pat = p && p.raw ? p : parsePattern(p);
    if (pat.ok && matchPattern(pat, u)) hits.push({ pattern: pat.raw, score: specificity(pat) });
  }
  hits.sort((a, b) => b.score - a.score || (a.pattern < b.pattern ? -1 : 1));
  const ambiguous = hits.length > 1 && hits[0].score === hits[1].score;
  return { ok: true, matched: hits.length > 0, ambiguous, hits, best: hits[0] || null };
}

/* ── webapps/<app>/webapp.md 首部 jsonc 块提取（首个含 matchers 键的 ```jsonc 块） ── */
function extractMatchersMd(mdText) {
  // \r?\n：Windows 端检出 CRLF 行尾时旧正则恒不命中（matchers 恒 null，2026-10-28 ISSUE-1）。
  // 捕获组尾部会带 \r\n（或极端情形单个 \r）——jsonc.parse → JSON.parse 允许尾随空白，无需额外清洗（已实测）。
  const re = /```jsonc\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(mdText || '')))) {
    try {
      const obj = parse(m[1]);
      if (obj && obj.matchers && typeof obj.matchers === 'object') return obj.matchers;
    } catch { /* 块解析失败 → 尝试下一块 */ }
  }
  return null;
}

/** 扫描 webapps/<app>/webapp.md（统一入口模式 webapps 加星号斜杠 webapp.md：每个 webapp 目录必有 webapp.md；删除目录=删除该 webapp，复制目录改名=新增）→ [{ slug, file, matchers }]；matchers 缺失为 null（回放安全阀对 null 跳过 URL 校验） */
function loadAppsIndex(webappsDir) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(webappsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return out; }
  for (const d of dirs) {
    let c = '';
    const file = path.join(webappsDir, d, 'webapp.md');
    try { c = fs.readFileSync(file, 'utf8'); } catch { continue; }
    out.push({ slug: d, file, matchers: extractMatchersMd(c) });
  }
  return out;
}

/** 跨应用解析：约束度最高胜出；同分多应用 = ambiguous（问用户） */
function resolveApp(appsIndex, url) {
  const cands = [];
  for (const a of appsIndex) {
    if (!a.matchers || !Array.isArray(a.matchers.urlPatterns)) continue;
    const r = matchUrl(a.matchers.urlPatterns, url);
    if (r.matched) cands.push({ slug: a.slug, score: r.best.score, hits: r.hits.length });
  }
  cands.sort((x, y) => y.score - x.score || (x.slug < y.slug ? -1 : 1));
  const ambiguous = cands.length > 1 && cands[0].score === cands[1].score;
  return { matched: cands.length > 0, ambiguous, candidates: cands, app: cands.length && !ambiguous ? cands[0].slug : null };
}

/* ── 用户断言账本（两级：会话级绑定=AI 会话内纪律零持久化；记忆化=jsonl 追加，须用户同意） ── */
function loadAssertions(file) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(file || ASSERTIONS_FILE, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    try { const o = JSON.parse(t); if (o && o.url && o.app) out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 追加一条断言（AI 建议 → 用户同意后调用）；返回落盘文件 */
function appendAssertion(entry, file) {
  const f = file || ASSERTIONS_FILE;
  paths.ensureDir(path.dirname(f));
  fs.appendFileSync(f, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  return f;
}

/** 断言查找：归一 URL 精确（host:port+path）优先，host:port 级兜底；未命中 null */
function assertionFor(assertions, url) {
  const u = typeof url === 'string' ? normalizeUrl(url) : url;
  if (!u) return null;
  const keyOf = (a) => { const au = normalizeUrl(a.url); return au ? { host: au.host, port: au.port, path: au.path } : null; };
  for (const a of assertions) { const k = keyOf(a); if (k && k.host === u.host && k.port === u.port && k.path === u.path) return a; }
  for (const a of assertions) { const k = keyOf(a); if (k && k.host === u.host && k.port === u.port) return a; }
  return null;
}

/** matchers 结构校验（selftest / 回放安全阀共用）：返回错误数组 */
function validateMatchers(matchers) {
  const errors = [];
  if (!matchers || typeof matchers !== 'object') return ['matchers 缺失或非对象'];
  if (!Array.isArray(matchers.urlPatterns) || matchers.urlPatterns.length === 0) return ['matchers.urlPatterns 须为非空数组'];
  matchers.urlPatterns.forEach((p, i) => {
    const r = parsePattern(p);
    if (!r.ok) errors.push(`urlPatterns[${i}] 非法：${r.error}（${JSON.stringify(p)}）`);
  });
  if (matchers.knownDeployments !== undefined) {
    if (!Array.isArray(matchers.knownDeployments)) errors.push('knownDeployments 须为数组');
    else matchers.knownDeployments.forEach((d, i) => {
      if (!d || typeof d !== 'object' || !d.pattern) errors.push(`knownDeployments[${i}] 缺 pattern`);
      else if (!parsePattern(d.pattern).ok) errors.push(`knownDeployments[${i}].pattern 非法：${d.pattern}`);
      if (d && !d.verifiedAt) errors.push(`knownDeployments[${i}] 缺 verifiedAt（版本指纹+验证时间）`);
    });
  }
  return errors;
}

module.exports = {
  ASSERTIONS_FILE, parsePattern, normalizeUrl, matchPattern, specificity, matchUrl,
  extractMatchersMd, loadAppsIndex, resolveApp, loadAssertions, appendAssertion, assertionFor, validateMatchers,
};
