'use strict';
/*
 * chromeuse lib/envelope.js —— 统一输出信封（chromeuse-cli/1）构造 + 失败发射 + audit 预留接缝
 * （V202611030001 B1a；零第三方依赖）
 *
 * 职责边界：
 *   - 本模块 = **纯构造 + 单行发射 + audit 接缝**；不决定「谁失败」（分类在 lib/errors.js），
 *     不负责去重与控制流（三出口编排在 tools/cdp.js：die / main().then / catch）。
 *   - 非 --json 路径**绝不**调用本模块的发射函数——文本输出逐字节不变由调用方结构保证。
 *
 * 信封形状（失败；成功形状 B1b 迁移时启用 ok()）：
 *   {
 *     "envelope": { "name": "chromeuse-cli/1", "command": "click", "at": "ISO-8601" },
 *     "ok": false,
 *     "code": "E_USAGE",          // lib/errors.js 20 码表之一
 *     "message": "…",             // ≤800 字符（超长截断加 …，完整文案看 stderr/--help）
 *     "retryable": false,          // true 时必带 backoffMs（与红线 #10 熔断同向）
 *     "hint": "…",                // 码表建议（可被调用方覆盖）
 *     "elapsedMs": 12,
 *     "data": null,               // 默认 null；成功=命令自定义对象；报告型失败=诊断/旧报告（B1b）
 *     "backoffMs": 3000           // 仅 retryable=true 时出现
 *   }
 * 注：字段序不构成契约（golden 只做结构断言，不锁字段序、不锁 data）。
 *
 * audit 预留（B3 实装，本批只留点）：
 *   tools/cdp.js 在**每次失败收口**（无论 --json 与否）调用 auditFailure({cmd,code,msg,exitCode})。
 *   本模块默认不落盘（空函数语义）；B3 通过 setAuditSink(fn) 注入真实 JSONL sink（写入前须过 redact）。
 *   ⚠ CHROMEUSE_AUDIT_FILE 仅作 selftest 测试接缝（#96 断言 audit 调用点被触达）——不是正式审计通道，
 *   B3 落地时保留（测试需要）或一并替换，二选一在 B3 任务书钉死。
 */
const fs = require('node:fs');
const errors = require('./errors');

const NAME = 'chromeuse-cli/1';
const MESSAGE_MAX = 800;
const STARTED_AT = Date.now();

function elapsedMs() { return Date.now() - STARTED_AT; }

/** 统一截断：信封 message 单行/有界；完整文案在 stderr 与 --help（不丢信息，只是不塞爆信封） */
function clampMessage(msg) {
  const s = String(msg == null ? '' : msg).replace(/\r?\n/g, ' ⏎ ').trim();
  return s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX) + '…' : s;
}

function baseEnvelope(cmd) {
  return { name: NAME, command: cmd ? String(cmd) : null, at: new Date().toISOString() };
}

/** 失败信封构造（纯函数，不发射） */
function fail(opt) {
  const o = opt || {};
  const code = errors.isCode(o.code) ? o.code : 'E_INTERNAL';
  const meta = errors.CODES[code];
  const retryable = typeof o.retryable === 'boolean' ? o.retryable : errors.isRetryable(code, o.cmd);
  const env = {
    envelope: baseEnvelope(o.cmd),
    ok: false,
    code,
    message: clampMessage(o.message === undefined ? meta.zh : o.message),
    retryable,
    hint: o.hint === undefined ? meta.hint : String(o.hint),
    elapsedMs: Number.isFinite(o.elapsedMs) ? o.elapsedMs : elapsedMs(),
    data: o.data === undefined ? null : o.data,
  };
  if (retryable) env.backoffMs = errors.backoffMs(code);
  if (o.evidence !== undefined) env.evidence = o.evidence;
  return env;
}

/** 成功信封骨架（B1b 迁移启用；本批不发射，先固化形状防 B1a/B1b 各自发明）
 *  形状按 B1b 任务书：ok:true + data + 可选 warnings（不设 code——成功无错误码）。 */
function ok(opt) {
  const o = opt || {};
  const env = {
    envelope: baseEnvelope(o.cmd),
    ok: true,
    elapsedMs: Number.isFinite(o.elapsedMs) ? o.elapsedMs : elapsedMs(),
    data: o.data === undefined ? null : o.data,
  };
  if (Array.isArray(o.warnings) && o.warnings.length) env.warnings = o.warnings.map(clampMessage);
  if (o.evidence !== undefined) env.evidence = o.evidence;
  return env;
}

/** 单行发射到 stdout（同步 writeSync：process.exit 的 exit hook 里也能落完整行） */
function emit(env, fd) {
  fs.writeSync(typeof fd === 'number' ? fd : 1, JSON.stringify(env) + '\n');
}

/* ── audit 接缝（B3 实装；本批空实现 + 测试接缝） ── */
let auditSink = null;
function setAuditSink(fn) { auditSink = typeof fn === 'function' ? fn : null; }

/**
 * 失败审计调用点（B3 实装）。调用方必须保证「任何失败收口都触达」，且**不因审计异常改变退出语义**。
 * @param {{cmd:string|null, code:string, msg:string, exitCode:number}} evt
 */
function auditFailure(evt) {
  const e = {
    cmd: evt && evt.cmd ? String(evt.cmd) : null,
    code: evt && evt.code ? String(evt.code) : 'E_INTERNAL',
    msg: clampMessage(evt && evt.msg),
    exitCode: Number.isFinite(evt && evt.exitCode) ? evt.exitCode : 1,
  };
  if (auditSink) { try { auditSink(e); } catch { /* 审计旁路不得影响退出 */ } }
  const file = process.env.CHROMEUSE_AUDIT_FILE;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* 同上 */ }
}

module.exports = { NAME, MESSAGE_MAX, fail, ok, emit, auditFailure, setAuditSink, elapsedMs, clampMessage };
