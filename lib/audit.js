'use strict';
/*
 * chromeuse lib/audit.js —— 结构化动作审计（JSONL，按天切分；V202611030004 B3 N3）
 *
 * 定位：回答「谁/哪个命令/在什么站点/做了什么/结果如何」——**不是**调试日志（lib/log.js 管调试）。
 * 落盘：paths.AUDIT_DIR/yyyy-mm-dd.jsonl（tmpdata/audit/，gitignored；日期按 CHROMEUSE_TZ_OFFSET 时区切分）。
 *
 * 安全边界（白名单字段制 + redact 第二层，结构性防泄——比「过滤密码」可靠）：
 *   记录字段恒为固定 10 个白名单键：{ts,cmd,targetHost,targetPath,action,code,phase,elapsedMs,artifact,sessionId}
 *   **绝不记录**：DOM 文本 / 输入值 / URL query 原文（targetPath 只留 pathname）/ Cookie / Token / 命令参数值。
 *   上层（tools/cdp.js）只把「命令名 + 目标 URL + 产物路径 + 结果码/phase」塞进来，永不传 --text 等参数值。
 *   B6b N7 起写入前再过 lib/redact.deep（白名单之后第二层；--no-redact 时整体旁路）。
 *   targetPath 截断 200 字符；非 http(s)/file/about/chrome 协议（data:/blob:/javascript: 等可能内嵌内容）→ host/path 均 null。
 *
 * 开关：CHROMEUSE_AUDIT=0|false|off|no → 关闭（默认开）。
 * 测试接缝：CHROMEUSE_AUDIT_FILE 存在时**正式审计停写**（B1a 遗留接缝仅供 selftest 断言失败调用点，
 *   见 references/mechanisms.md §6；防 selftest 污染真实 tmpdata/audit）。
 * 纪律：审计是旁路——任何异常都不得影响主流程/退出码；调用方也不得因审计失败改变行为。
 */
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const time = require('./time');
const redact = require('./redact'); // B6b N7：白名单之后第二层（持久化前脱敏）

/** 字段白名单（顺序即输出顺序；新增字段须走任务书评审——白名单是第一道防线，redact 第二层见 record()） */
const FIELDS = ['ts', 'cmd', 'targetHost', 'targetPath', 'action', 'code', 'phase', 'elapsedMs', 'artifact', 'sessionId'];
const PATH_MAX = 200;
const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 进程级上下文（tools/cdp.js 在解析 target / 落盘产物 / effect 收口时登记） */
const ctx = { targetUrl: null, action: null, artifact: null, phase: null };

/** 开关判断（参数 env 供单测注入） */
function enabled(env) {
  const raw = (env || process.env).CHROMEUSE_AUDIT;
  if (raw === undefined || raw === null || raw === '') return true;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/** 审计目录（paths 单源；随 CHROMEUSE_TMPDATA_DIR 覆盖——watcher 规避与 N2 清理同源） */
function dir() { return paths.AUDIT_DIR; }

/** 日期键 yyyy-mm-dd（按 CHROMEUSE_TZ_OFFSET 时区，与文件名/日志戳同源） */
function dateKey(date) {
  const p = time.tzParts(date);
  return `${p.year}-${time.pad2(p.month)}-${time.pad2(p.day)}`;
}

/** 当日文件绝对路径（date 可注入，供 selftest 跨午夜断言） */
function fileFor(date) {
  return path.join(dir(), `${dateKey(date)}.jsonl`);
}

function clip(s, max) {
  const t = String(s == null ? '' : s);
  const lim = Number.isFinite(max) ? max : PATH_MAX;
  return t.length > lim ? t.slice(0, lim) : t;
}

/** 原始字符串兜底去敏：去 fragment / query（query 值不落盘）后再截断 */
function stripQuery(s) {
  return clip(String(s == null ? '' : s).split('#')[0].split('?')[0]);
}

/**
 * 目标 URL → {host, path}：只保留 host 与 pathname（query/fragment 一律丢弃）。
 * 非 http(s)/file/about/chrome 协议（data:/blob:/javascript: 等）→ {host:null,path:null}（可能内嵌内容）。
 */
function sanitizeTarget(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return { host: null, path: null };
  let u;
  try { u = new URL(s); } catch { return { host: null, path: stripQuery(s) || null }; }
  if (!['http:', 'https:', 'file:', 'about:', 'chrome:', 'chrome-extension:'].includes(u.protocol)) {
    return { host: null, path: null };
  }
  return { host: u.host || null, path: clip(u.pathname || '/') };
}

/** 产物路径展示：tmpdata 内 → 相对路径；外部 → 原样（截断 200）；绝不写文件内容 */
function sanitizeArtifact(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return null;
  const abs = path.resolve(s);
  const rel = path.relative(paths.TMPDATA_DIR, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return clip(paths.toPosix(rel));
  return clip(abs);
}

/** 注册 target（tools/cdp.js 包装 resolveTarget 单点调用） */
function setTarget(url) {
  try { ctx.targetUrl = url == null ? null : String(url); } catch { /* 旁路 */ }
}
/** 注册子动作（flow replay / audit tail / artifacts prune 等；缺省=命令名） */
function setAction(action) { ctx.action = action == null ? null : String(action); }
/** 注册产物路径（五落盘入口与 flow 报告点调用） */
function setArtifact(file) { ctx.artifact = file == null ? null : String(file); }
/** 注册 effect phase（B2 confirmed/effect_pending/dispatched/stalled） */
function setPhase(phase) { ctx.phase = phase == null ? null : String(phase); }
/** 清空上下文（selftest/异常兜底） */
function resetContext() { ctx.targetUrl = null; ctx.action = null; ctx.artifact = null; ctx.phase = null; }

/** 白名单过滤：只允许 FIELDS 中的键，未知键一律丢弃（防御性二道闸） */
function whitelist(obj) {
  const out = {};
  for (const k of FIELDS) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

/**
 * 追加一条审计记录。返回写入的对象；关闭/失败/测试接缝 → null（调用方无需关心）。
 * @param {{cmd?:string, action?:string, code?:string|null, phase?:string|null, elapsedMs?:number,
 *          artifact?:string, targetUrl?:string, targetHost?:string, targetPath?:string,
 *          sessionId?:string}} input
 * @param {{now?:Date, legal?:boolean}} [opts] opts.legal=false 时强制落默认目录（selftest 用）
 */
function record(input, opts) {
  if (!enabled()) return null;
  if (process.env.CHROMEUSE_AUDIT_FILE && !(opts && opts.ignoreTestSeam)) return null; // B1a 测试接缝优先，防污染
  const o = input || {};
  const now = (opts && opts.now) || new Date();
  const tgt = o.targetUrl ? sanitizeTarget(o.targetUrl)
    : { host: o.targetHost ? clip(String(o.targetHost), 200) : null, path: o.targetPath ? stripQuery(o.targetPath) : null };
  const rec = redact.deep(whitelist({
    ts: time.isoLocal(now),
    cmd: o.cmd == null ? null : String(o.cmd),
    targetHost: tgt.host || null,
    targetPath: tgt.path || null,
    action: o.action == null ? (o.cmd == null ? null : String(o.cmd)) : String(o.action),
    code: o.code == null ? null : String(o.code),
    phase: o.phase == null ? null : String(o.phase),
    elapsedMs: Number.isFinite(o.elapsedMs) ? Math.max(0, Math.round(o.elapsedMs)) : null,
    artifact: o.artifact == null ? null : sanitizeArtifact(o.artifact),
    sessionId: o.sessionId || process.env.CHROMEUSE_SESSION || process.env.CHROMEUSE_SESSION_ID || null,
  }));
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(fileFor(now), JSON.stringify(rec) + '\n');
    return rec;
  } catch {
    return null; // 审计旁路：任何 IO 失败静默（不得影响退出语义）
  }
}

/** 失败收口（B1a auditFailure sink 适配）：只取 code/cmd/elapsed；msg 不落盘（白名单） */
function recordFailure(evt) {
  const e = evt || {};
  return record({
    cmd: e.cmd, action: ctx.action || e.cmd, code: e.code || 'E_INTERNAL',
    phase: ctx.phase, elapsedMs: e.elapsedMs, artifact: ctx.artifact, targetUrl: ctx.targetUrl,
    sessionId: e.sessionId,
  });
}

/** 成功收口（进程 exit 0 单点调用）：code=null */
function recordSuccess(evt) {
  const e = evt || {};
  return record({
    cmd: e.cmd, action: ctx.action || e.cmd, code: null,
    phase: ctx.phase, elapsedMs: e.elapsedMs, artifact: ctx.artifact, targetUrl: ctx.targetUrl,
    sessionId: e.sessionId,
  });
}

/* ── 查询面（audit tail / audit stats；只读） ── */
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function listFiles() {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  return names.filter((n) => FILE_RE.test(n)).sort().reverse()
    .map((n) => ({ key: n.slice(0, 10), file: path.join(dir(), n) }));
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

/** 最近 n 行原样（跨天按文件倒序收集，返回时间正序） */
function tail(n) {
  const want = Math.max(1, Number.isFinite(n) ? Math.floor(n) : 20);
  const acc = [];
  for (const f of listFiles()) {
    const lines = readLines(f.file);
    for (let i = lines.length - 1; i >= 0 && acc.length < want; i--) acc.push(lines[i]);
    if (acc.length >= want) break;
  }
  return acc.reverse();
}

/** 按命令/结果码/日聚合最近 days 天（含今天；文件按日期键过滤，不解析超范围文件） */
function stats(opts) {
  const o = opts || {};
  const days = Number.isFinite(o.days) && o.days > 0 ? Math.floor(o.days) : 7;
  const now = o.now || new Date();
  const cutoff = dateKey(new Date(now.getTime() - (days - 1) * 86400000));
  const files = listFiles().filter((f) => f.key >= cutoff);
  const out = { days, from: cutoff, to: dateKey(now), files: files.length, total: 0, parseErrors: 0, byCmd: {}, byCode: {}, byDay: {} };
  for (const f of files) {
    out.byDay[f.key] = out.byDay[f.key] || 0;
    for (const line of readLines(f.file)) {
      let rec;
      try { rec = JSON.parse(line); } catch { out.parseErrors++; continue; }
      out.total++;
      const cmd = rec && rec.cmd ? String(rec.cmd) : '(null)';
      const code = rec && rec.code ? String(rec.code) : 'ok';
      if (!out.byCmd[cmd]) out.byCmd[cmd] = { total: 0, ok: 0, fail: 0 };
      const c = out.byCmd[cmd];
      c.total++;
      if (code === 'ok') c.ok++; else c.fail++;
      inc(out.byCode, code);
      out.byDay[f.key] += 1;
    }
  }
  return out;
}

function inc(map, key) {
  if (!map[key]) map[key] = 0;
  map[key] += 1;
}

/**
 * 保留期清理（N2 prune 同一入口调用）：删除日期键早于 cutoff 的审计文件。
 * 默认 dry-run；apply=true 才真删。返回 {files:[{file,key,bytes}], bytes, deleted}。
 */
function purge(opts) {
  const o = opts || {};
  const days = Number.isFinite(o.days) && o.days > 0 ? Math.floor(o.days) : 30;
  const now = o.now || new Date();
  const cutoff = dateKey(new Date(now.getTime() - days * 86400000)); // 保留最近 days 天（含今天）
  const victims = listFiles().filter((f) => f.key < cutoff).map((f) => {
    let bytes = 0;
    try { bytes = fs.statSync(f.file).size; } catch { /* 已不在 */ }
    return { file: f.file, key: f.key, bytes };
  });
  let deleted = 0;
  if (o.apply) {
    for (const v of victims) {
      try { fs.unlinkSync(v.file); deleted++; } catch { /* 已不在 */ }
    }
  }
  return { days, cutoff, files: victims, bytes: victims.reduce((n, v) => n + v.bytes, 0), deleted };
}

module.exports = {
  FIELDS, PATH_MAX, enabled, dir, dateKey, fileFor, sanitizeTarget, sanitizeArtifact,
  setTarget, setAction, setArtifact, setPhase, resetContext, whitelist,
  record, recordFailure, recordSuccess, tail, stats, purge, listFiles,
};
