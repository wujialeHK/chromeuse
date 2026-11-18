'use strict';
/*
 * chromeuse lib/handoff.js —— 人机接力 handoff 协议（C2 #128；契约 → references/mechanisms.md §23）
 *
 * 定位：把「2FA/支付/审批必须由人完成」的那段等待做成**可恢复的跨进程协议**——不靠模型回合挂等，
 * 也不靠 agent 自建状态。CLI 四形态（默认 start / --wait / --status / --cancel）在 tools/cdp.js；
 * 本模块只做状态机、原子落盘、惰性清扫与审计（零第三方依赖、无 CDP）。
 *
 * 状态机（唯一活跃态 waiting；三终态不可逆）：
 *   waiting ──信号文件存在──→ confirmed（continuedAt 写入）
 *           ──now ≥ deadline─→ expired
 *           ──--cancel──────→ cancelled
 * 活跃判据一律**读者侧双字段即时判定** isActive(state,deadline,now) = state==='waiting' ∧ now<deadline：
 *   不依赖文件内 state 字段被及时改写——agent 弃跑 --wait/进程被掐导致文件滞留 waiting 时，超时后
 *   tab-govern 的回收豁免自动失效（lib/tab-govern.js detectBusy 同口径）。穿越入口（--wait 主动迁移；
 *   start/status/list/cancel 经 sweep 惰性结算）会把终态写回文件并各记一行审计，幂等。
 * 信号优先级：信号存在 > 超时。用户确实按了确认（信号文件=唯一事实），即使 agent 迟到读取也记 confirmed。
 *
 * 状态文件 <HANDOFF_DIR>/<id>.json（id=ho-<yyyyMMdd-HHmmss>-<4hex>）：
 *   {id,state,who,why,pageId,url,createdAt,deadline(epoch ms 权威),timeoutMs,signalPath,
 *    continuedAt,endedAt,evidence:{startShot,endShot}}
 * 写入=tmp+rename 原子换名（lib/jobs.js 先例）；终态文件 24h 惰性清扫（顺带删 .continue 信号）。
 * 信号文件默认 <HANDOFF_DIR>/<id>.continue（--signal 可覆盖，落盘绝对值）；任何链路 touch 都算（存在性=事实）。
 *
 * 审计（直接 require 先例=lib/flow-engine.js:863）：handoff.created|confirmed|expired|cancelled，
 * 每次迁移恰一行；通用成功/失败行仍由 cdp.js exit 单点补（既有双行惯例）。审计异常全部吞掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const time = require('./time');
const audit = require('./audit');

const DEFAULT_TIMEOUT_MS = 600 * 1000;      // 默认 10min（Browse 先例）
const MAX_TIMEOUT_MS = 3600 * 1000;         // 1h 硬帽（防误配把 agent 挂死）
const WAIT_POLL_MS = 2000;                  // --wait 轮询间隔（stat 信号文件）
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000; // 终态状态文件 24h 惰性清扫
const WAITING = 'waiting';
const TERMINAL = Object.freeze(['confirmed', 'expired', 'cancelled']);

/* ── 路径与 id ── */

function handoffDirOf(opts) { return (opts && opts.handoffDir) || paths.HANDOFF_DIR; }
function stateFileOf(dir, id) { return path.join(dir, `${id}.json`); }
function signalPathOf(dir, id) { return path.join(dir, `${id}.continue`); }
function isValidHandoffId(id) { return typeof id === 'string' && /^ho-[A-Za-z0-9._-]{6,80}$/.test(id); }

/** ho-<yyyyMMdd-HHmmss>-<4hex>（crypto 随机防同秒碰撞；时间戳走 lib/time.js 时区配置） */
function makeHandoffId(date) {
  const p = time.tzParts(date);
  const stamp = `${p.year}${time.pad2(p.month)}${time.pad2(p.day)}-${time.pad2(p.hour)}${time.pad2(p.minute)}${time.pad2(p.second)}`;
  return `ho-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** --timeout-ms 归一：缺省=10min；正整数毫秒且 ≤1h；非法抛错（CLI 归 E_USAGE） */
function normalizeTimeout(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return Number.isFinite(fallback) ? fallback : DEFAULT_TIMEOUT_MS;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`--timeout-ms 须为正整数毫秒（收到 ${JSON.stringify(raw)}）`);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout-ms 须 > 0');
  if (n > MAX_TIMEOUT_MS) throw new Error(`--timeout-ms 超出上限 ${MAX_TIMEOUT_MS}ms（1h 硬帽防误配挂死）`);
  return n;
}

/* ── 纯函数（selftest 直测） ── */

/** 协议核心防呆：唯一活跃判据（读者侧即时判定，不信文件 state 字段被及时改写） */
function isActive(state, deadline, now) {
  return state === WAITING && Number.isFinite(deadline) && now < deadline;
}

/** 纯转移判定（不 IO）：终态不可逆；信号优先于超时 */
function nextState(state, signalExists, now, deadline) {
  if (state !== WAITING) return state;
  if (signalExists) return 'confirmed';
  if (Number.isFinite(deadline) && now >= deadline) return 'expired';
  return WAITING;
}

/** 唯一前缀解析：精确 > 唯一前缀 > E_AMBIGUOUS（多命中不猜）/ E_NOT_FOUND */
function resolvePrefix(ids, prefix) {
  const raw = String(prefix == null ? '' : prefix);
  if (!raw) return { ok: false, code: 'E_USAGE', message: 'handoff id 不能为空' };
  if (ids.includes(raw)) return { ok: true, id: raw };
  const hits = ids.filter((x) => x.startsWith(raw));
  if (hits.length === 1) return { ok: true, id: hits[0] };
  if (hits.length > 1) {
    return { ok: false, code: 'E_AMBIGUOUS', message: `handoff id 前缀「${raw}」命中 ${hits.length} 个，请给完整 id（${hits.slice(0, 6).join('、')}）` };
  }
  return { ok: false, code: 'E_NOT_FOUND', message: `handoff 不存在：${raw}（cdp.js handoff --status 查看）` };
}

/** 剩余时间短语 */
function remainingPhrase(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '已到期';
  const min = ms / 60000;
  return min >= 1 ? `剩余 ${min.toFixed(1)}min` : `剩余 ${Math.ceil(ms / 1000)}s`;
}

/* ── 状态文件 IO（tmp+rename 原子写） ── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 已不在 */ }
    throw e;
  }
}

function listIds(dir) {
  try { return fs.readdirSync(dir).filter((n) => /^ho-.*\.json$/.test(n)).map((n) => n.slice(0, -5)); } catch { return []; }
}

/* ── 迁移与惰性清扫 ── */

/** 写终态 + 审计恰一行（幂等：终态/同态直接返回 changed:false） */
function settleState(st, next, opts) {
  const o = opts || {};
  if (!st || st.state === next || !TERMINAL.includes(next)) return { state: st, changed: false };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const patch = { state: next, endedAt: time.isoLocal(now) };
  if (next === 'confirmed') patch.continuedAt = patch.endedAt;
  if (o.endShot !== undefined) patch.evidence = Object.assign({}, st.evidence, { endShot: o.endShot });
  const file = o.stateFile || stateFileOf(handoffDirOf(o), st.id);
  /* 只写 schema 字段：调用方可能传 decorate() 的投影（active/remainingMs/stateFile 是读侧字段，禁止回写） */
  const base = Object.assign({}, st);
  delete base.active; delete base.remainingMs; delete base.stateFile;
  writeJsonAtomic(file, Object.assign(base, patch));
  try {
    audit.record({
      cmd: 'handoff',
      action: `handoff.${next}`,
      code: next === 'expired' ? 'E_TIMEOUT' : null,
      targetUrl: st.url,
      artifact: (patch.evidence && patch.evidence.endShot) || undefined,
    });
  } catch { /* 审计旁路 */ }
  const baseOut = Object.assign({}, st);
  delete baseOut.active; delete baseOut.remainingMs; delete baseOut.stateFile;
  return { state: Object.assign(baseOut, patch), changed: true };
}

/**
 * 惰性清扫（每个命令入口顺带）：
 *  ① waiting 且信号已到/已超时 → 结算为终态（写回文件 + audit）；
 *  ② 终态文件 endedAt 超过 24h → 删状态文件与 .continue 信号（证据链主要由 audit+截图承载）。
 * 返回 {settled, removed}（selftest 可观测）。
 */
function sweep(opts) {
  const o = opts || {};
  const dir = handoffDirOf(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const out = { settled: 0, removed: 0 };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!/^ho-.*\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    let st = readJson(file);
    if (!st || typeof st !== 'object') continue;
    const sigPath = st.signalPath || signalPathOf(dir, st.id || n.slice(0, -5));
    const sig = fs.existsSync(sigPath);
    const nx = nextState(st.state, sig, now, st.deadline);
    if (nx !== st.state) {
      try { st = settleState(st, nx, { stateFile: file, now }).state; out.settled++; } catch { continue; }
    }
    if (!TERMINAL.includes(st.state)) continue;
    const end = Date.parse(st.endedAt || st.createdAt || '');
    if (!Number.isFinite(end) || now - end <= TERMINAL_TTL_MS) continue;
    try { fs.unlinkSync(file); out.removed++; } catch { /* 已不在 */ }
    try { fs.unlinkSync(sigPath); } catch { /* 无信号 */ }
  }
  return out;
}

/** 读一个状态 + 活跃/剩余投影 */
function decorate(st, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  return Object.assign({}, st, {
    active: isActive(st.state, st.deadline, n),
    remainingMs: Number.isFinite(st.deadline) ? Math.max(0, st.deadline - n) : null,
  });
}

/** 按精确 id 或唯一前缀查找（默认入口先惰性清扫；wait 传 sweep:false 以保留终态截图时机）
 *  返回 {ok,state,stateFile} 或 {ok:false,code,message} */
function find(id, opts) {
  const o = opts || {};
  const dir = handoffDirOf(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (o.sweep !== false) sweep({ handoffDir: dir, now });
  const r = resolvePrefix(listIds(dir), id);
  if (!r.ok) return r;
  const stateFile = stateFileOf(dir, r.id);
  const st = readJson(stateFile);
  if (!st) return { ok: false, code: 'E_NOT_FOUND', message: `handoff 状态文件损坏/不存在：${r.id}` };
  return { ok: true, state: decorate(st, now), stateFile };
}

/** 全量列表（入口先清扫；按 createdAt 倒序） */
function list(opts) {
  const o = opts || {};
  const dir = handoffDirOf(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  sweep({ handoffDir: dir, now });
  const out = [];
  for (const id of listIds(dir)) {
    const stateFile = stateFileOf(dir, id);
    const st = readJson(stateFile);
    if (st) out.push(Object.assign(decorate(st, now), { stateFile }));
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/* ── 创建 / 等待 / 取消 ── */

function create(opts) {
  const o = opts || {};
  const dir = handoffDirOf(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (typeof o.why !== 'string' || !o.why.trim()) throw new Error('handoff 需要非空 --reason（人需完成的事）');
  const timeoutMs = normalizeTimeout(o.timeoutMs === undefined ? null : o.timeoutMs, DEFAULT_TIMEOUT_MS);
  const id = o.id && isValidHandoffId(o.id) ? o.id : makeHandoffId(new Date(now));
  const signalPath = o.signalPath ? path.resolve(o.signalPath) : signalPathOf(dir, id);
  const st = {
    id,
    state: WAITING,
    who: o.who || process.env.CHROMEUSE_AGENT_ID || 'default',
    why: o.why.trim(),
    pageId: o.pageId || null,
    url: o.url || null,
    createdAt: time.isoLocal(now),
    deadline: now + timeoutMs,
    timeoutMs,
    signalPath,
    continuedAt: null,
    endedAt: null,
    evidence: { startShot: o.startShot || null, endShot: null },
  };
  paths.ensureDir(dir);
  paths.ensureDir(path.dirname(signalPath));
  writeJsonAtomic(stateFileOf(dir, id), st);
  try {
    audit.record({ cmd: 'handoff', action: 'handoff.created', targetUrl: st.url, artifact: st.evidence.startShot || undefined });
  } catch { /* 审计旁路 */ }
  return st;
}

/** 终态截图回调（cdp.js 注入 CDP 能力；本模块不碰浏览器）；异常/缺省不阻断协议 */
async function maybeCapture(o, st, next) {
  if (!o || typeof o.captureEnd !== 'function') return undefined;
  try { return await o.captureEnd(st, next); } catch { return null; }
}

/**
 * 阻塞轮询直到 confirmed/expired/cancelled。轮询读信号文件存在性（存在即退出）；
 * 预算=状态文件 deadline（不接 --timeout——deadline 单源）。每次轮询重读状态文件，
 * 外部 --cancel 也能让本进程及时返回。
 */
async function wait(id, opts) {
  const o = opts || {};
  const dir = handoffDirOf(o);
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : WAIT_POLL_MS;
  const t0 = Date.now();
  /* sweep:false —— 终态迁移由本进程当场完成（才能先截图再写终态）；若先 sweep，滞留状态会无截图地结算 */
  const f = find(id, { handoffDir: dir, now: t0, sweep: false });
  if (!f.ok) return f;
  if (!Number.isFinite(f.state.deadline)) return { ok: false, code: 'E_IO', message: `handoff 状态文件缺 deadline（损坏）：${f.state.id}` };
  let st = f.state;
  for (;;) {
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const cur = readJson(f.stateFile);
    if (!cur) return { ok: false, code: 'E_IO', message: `handoff 状态文件丢失或损坏：${f.state.id}` };
    const sig = fs.existsSync(cur.signalPath || signalPathOf(dir, cur.id));
    const nx = nextState(cur.state, sig, now, cur.deadline);
    if (nx !== cur.state) {
      const endShot = await maybeCapture(o, cur, nx);
      st = settleState(cur, nx, { stateFile: f.stateFile, now, endShot }).state;
    } else {
      st = cur;
    }
    if (st.state !== WAITING) {
      return { ok: true, state: decorate(st, now), stateFile: f.stateFile, waitedMs: Math.max(0, now - t0) };
    }
    const remain = Number.isFinite(st.deadline) ? st.deadline - now : pollMs;
    await time.sleep(Math.max(1, Math.min(pollMs, remain)));
  }
}

/** 取消 waiting（终态幂等提示，不报错）；返回 {ok,already,state,stateFile} */
async function cancel(id, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const f = find(id, { handoffDir: handoffDirOf(o), now });
  if (!f.ok) return f;
  if (f.state.state !== WAITING) return { ok: true, already: true, state: f.state, stateFile: f.stateFile };
  const endShot = await maybeCapture(o, f.state, 'cancelled');
  const r = settleState(f.state, 'cancelled', { stateFile: f.stateFile, now, endShot });
  return { ok: true, already: false, state: decorate(r.state, now), stateFile: f.stateFile };
}

/* ── 输出（文本模式；--json 走 cdp.js 信封） ── */

function formatBanner(st, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  const timeoutMin = Math.round((st.timeoutMs || 0) / 60000);
  return [
    `⚠⚠⚠ HUMAN REQUIRED —— 人机接力 handoff ${st.id}`,
    `  原因: ${st.why}`,
    `  页签: ${st.pageId || '-'} ${st.url || '-'} —— 请用户切换到该页签完成操作（工具不会替用户置前）`,
    '  Continue 指引: 请用户完成上述操作后执行',
    `      touch "${st.signalPath}"`,
    `  或查询: cdp.js handoff --status ${st.id}`,
    `  超时: ${timeoutMin}min（至 ${Number.isFinite(st.deadline) ? time.isoLocal(new Date(st.deadline)) : '-'}；${remainingPhrase(st.deadline - n)}）；到期未确认=expired（页签保留未关）`,
  ].join('\n');
}

function formatDetail(st, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  const ev = st.evidence || {};
  return [
    `[handoff] ${st.id}`,
    `  state: ${st.state}${isActive(st.state, st.deadline, n) ? `（活跃；${remainingPhrase(st.deadline - n)}）` : ''}`,
    `  why: ${st.why}`,
    `  pageId: ${st.pageId || '-'}`,
    `  url: ${st.url || '-'}`,
    `  createdAt: ${st.createdAt || '-'} → deadline: ${Number.isFinite(st.deadline) ? time.isoLocal(new Date(st.deadline)) : '-'}${st.continuedAt ? ` → continuedAt: ${st.continuedAt}` : ''}${st.endedAt ? ` → endedAt: ${st.endedAt}` : ''}`,
    `  signalPath: ${st.signalPath}`,
    `  evidence: start=${ev.startShot || '-'} end=${ev.endShot || '-'}`,
  ].join('\n');
}

function formatList(items, dir, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  const active = items.filter((x) => isActive(x.state, x.deadline, n)).length;
  const lines = [`[handoff] 共 ${items.length} 个（活跃 ${active} / 非活跃 ${items.length - active}；状态目录 ${dir}）`];
  for (const st of items) {
    const rem = st.state === WAITING ? remainingPhrase(st.deadline - n) : '—';
    lines.push(`  ${st.id}  ${String(st.state).padEnd(9)}  ${rem.padEnd(16)}  ${String(st.why).slice(0, 40)}`);
  }
  if (!items.length) lines.push('  （无 handoff）');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, WAIT_POLL_MS, TERMINAL_TTL_MS, WAITING, TERMINAL,
  handoffDirOf, stateFileOf, signalPathOf, isValidHandoffId, makeHandoffId, normalizeTimeout,
  isActive, nextState, resolvePrefix, remainingPhrase,
  readJson, writeJsonAtomic, sweep, decorate, find, list, create, wait, cancel,
  formatBanner, formatDetail, formatList,
};
