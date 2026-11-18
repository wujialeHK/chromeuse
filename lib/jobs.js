'use strict';
/*
 * chromeuse lib/jobs.js —— 长任务作业模型（V20261104002 B7 N6；契约 → references/mechanisms.md §14）
 *
 * 背景：cast/scroll-shot/record/flow replay 是长任务，同步等会被上游超时掐断；--async 把命令
 * 作业化——主进程只做「占槽 + 落状态 + spawn 子进程 + 立即返回」，进度/终态由子进程（或取消方）写状态文件。
 *
 * 核心设计（v2 计划 §〇 裁决 2 C 案，全套照抄）：
 *   ① 并发满 = 拒绝（E_BUSY），不排队：exit 1 + 失败信封（--json 不适用于 --async；文本失败同码审计）；
 *   ② 槽位用 fs.openSync(slotPath,'wx') O_EXCL **原子占用**（slots/slot-1..N；消灭 check-then-act
 *      TOCTOU——opencode/openclaw 双端并发是本仓真实场景）；上限默认 4（CHROMEUSE_JOB_MAX 覆盖）；
 *   ③ 状态文件 tmpdata/jobs/<jobId>.json：{jobId,pid,startedAt,cmdline,status,progress,artifact,exitCode}；
 *      孤儿判定 = {pid,startedAt,cmdline} 三元组（kill(pid,0) 之外校验 /proc cmdline 含 jobId + 进程
 *      启动时刻与 startedAt 偏差 ≤120s，防 pid 复用误判）；
 *   ④ cancel 双路：record 优先 POST /__stop（目标进程支持时优雅停），统一 detached 进程组
 *      SIGTERM→SIGKILL 兜底；已完成产物保留（partial 语义，绝不清理产物）；
 *   ⑤ --async 转发 argv **剔除自身**（防递归作业化）；子进程另带隐藏 --job-id 供三元组校验；
 *   ⑥ 终态保留 600s，惰性清扫挂在 job/list/status/cancel 与 start 执行时；孤儿自动标 failed 不删产物。
 *
 * 状态机：running → done（exit 0）｜failed（非 0/孤儿）｜cancelled（cancel 请求后退出）。
 * 状态文件写入用 tmp+rename 原子换名（并发写最后落者胜；仅是观测面，不承载互斥语义）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const paths = require('./paths');
const time = require('./time');
const platform = require('./platform');

const TERMINAL_TTL_MS = 600 * 1000;      // 终态状态文件保留 600s（惰性清扫）
const DEFAULT_MAX_JOBS = 4;              // 默认并发上限（CHROMEUSE_JOB_MAX 可覆盖）
const MAX_JOBS_CAP = 32;                 // 上限硬帽（防 env 误配把槽位开成海）
const ORPHAN_START_SKEW_MS = 120 * 1000; // startedAt 与 /proc 启动时刻允许偏差（防 pid 复用）
const SLOT_ORPHAN_MIN_AGE_MS = 5000;     // 无状态文件的槽位最小存活期（防 sweep 抢删刚建的槽）

/* ── 基础路径 / 参数归一 ── */

/** 作业目录（默认 paths.JOBS_DIR=<tmpdata>/jobs；测试可注入 jobsDir 覆盖，CLI 走 CHROMEUSE_TMPDATA_DIR） */
function jobsDirOf(opts) { return (opts && opts.jobsDir) || paths.JOBS_DIR; }
function slotsDirOf(dir) { return path.join(dir, 'slots'); }
function stateFileOf(dir, jobId) { return path.join(dir, `${jobId}.json`); }
function logFileOf(dir, jobId) { return path.join(dir, `${jobId}.log`); }

/** 并发上限：正整数 1..MAX_JOBS_CAP；非法 env 回退默认 4（不静默放到失控） */
function maxJobs(env) {
  const n = parseInt((env || process.env).CHROMEUSE_JOB_MAX, 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_JOBS_CAP ? n : DEFAULT_MAX_JOBS;
}

/** jobId 合法性（状态文件名即 id，禁路径分隔符/空白；CLI 用户输入同源校验） */
function isValidJobId(id) { return typeof id === 'string' && /^job-[A-Za-z0-9._-]{6,80}$/.test(id); }

function makeJobId(date) {
  const stamp = time.formatStamp(date).replace(/[:]/g, '-');
  const rand = require('node:crypto').randomBytes(4).toString('hex');
  return `job-${stamp}-${rand}`;
}

/** 剔除 argv 中的 --async 自身（含 --async=<v>），防子进程递归作业化；只删旗标 token，不吞后续位置参数 */
function stripAsync(argv) {
  const out = [];
  const src = Array.isArray(argv) ? argv : [];
  for (const a of src) {
    if (String(a) === '--async' || String(a).startsWith('--async=')) continue;
    out.push(a);
  }
  return out;
}

/* ── 原子槽位（O_EXCL） ── */

/**
 * 获取一个槽位。返回 {ok:true,index,file} 或 {ok:false,code:'E_BUSY',message}。
 * fsImpl 可注入（selftest 模拟 EEXIST 竞态）；生产恒走真实 fs。
 */
function acquireSlot(opts) {
  const o = opts || {};
  const dir = jobsDirOf(o);
  const max = o.max || maxJobs();
  const fsImpl = o.fsImpl || fs;
  const slotDir = slotsDirOf(dir);
  fsImpl.mkdirSync(slotDir, { recursive: true });
  for (let i = 1; i <= max; i++) {
    const file = path.join(slotDir, `slot-${i}`);
    try {
      // wx = O_CREAT|O_EXCL：内核级原子占位；两个进程同抢一个槽只可能一个成功
      const fd = fsImpl.openSync(file, 'wx');
      try {
        fsImpl.writeFileSync(fd, JSON.stringify({
          jobId: o.jobId || null,
          pid: process.pid,
          createdAt: time.isoLocal(),
        }));
      } finally {
        try { fsImpl.closeSync(fd); } catch { /* 忽略 */ }
      }
      return { ok: true, index: i, file };
    } catch (e) {
      if (e && e.code === 'EEXIST') continue; // 槽已被占：顺延下一个
      throw e;
    }
  }
  return {
    ok: false,
    code: 'E_BUSY',
    message: `并发作业已满（running ${max}/${max}，上限 ${max}）；请等待现有作业完成（cdp.js job list）后重试，或调大 CHROMEUSE_JOB_MAX`,
  };
}

/** 释放槽位文件（幂等；只删 slot-N 形态，路径由本模块生成） */
function releaseSlot(file) {
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** 按 jobId 释放残留槽位（cancel/孤儿清扫用；内容匹配才删，防误删别的作业刚抢到的槽） */
function releaseSlotByJobId(dir, jobId) {
  const slotDir = slotsDirOf(dir || paths.JOBS_DIR);
  let names = [];
  try { names = fs.readdirSync(slotDir); } catch { return false; }
  let released = false;
  for (const n of names) {
    if (!/^slot-\d+$/.test(n)) continue;
    const f = path.join(slotDir, n);
    try {
      const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (meta && meta.jobId === jobId) { fs.unlinkSync(f); released = true; }
    } catch { /* 损坏/空槽：留给 sweep 按 mtime 处理 */ }
  }
  return released;
}

/* ── 状态文件读写（原子换名） ── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function mergeState(file, patch) {
  const cur = readJson(file) || {};
  const next = Object.assign({}, cur, patch || {});
  writeJsonAtomic(file, next);
  return next;
}

/* ── 孤儿判定（纯函数 + /proc 探针） ── */

/**
 * judgeOrphan —— 三元组纯函数（selftest 直测）：
 *   probe={alive:boolean, cmdlineHasJobId:boolean|null, startDeltaMs:number|null}
 *   cmdlineHasJobId=null / startDeltaMs=null 表示平台不可验证（不据此判孤儿）。
 * 返回 {orphan:boolean, reason:'pid-dead'|'pid-reused-cmdline'|'pid-reused-startedAt'|null}
 */
function judgeOrphan(state, probe) {
  if (!state || state.status !== 'running') return { orphan: false, reason: null };
  const p = probe || {};
  if (p.alive === false) return { orphan: true, reason: 'pid-dead' };
  if (p.cmdlineHasJobId === false) return { orphan: true, reason: 'pid-reused-cmdline' };
  if (Number.isFinite(p.startDeltaMs) && Math.abs(p.startDeltaMs) > ORPHAN_START_SKEW_MS) {
    return { orphan: true, reason: 'pid-reused-startedAt' };
  }
  return { orphan: false, reason: null };
}

/* ── 平台层 process 域转调（批1，V20261117002）──
 * /proc 三探针 + 进程存活 + 进程组信号的实现单源已迁至 lib/platform/linux.js（Windows 覆写在
 * windows.js）；本文件保留 jobs 导出面与语义注释，函数体一律转调 platform().process.*。
 * 由此本文件内零平台字面量判断（平台选择由 platform/index.js 承担）。 */

/** 读 /proc/<pid>/cmdline（不可验证平台返 null=不据此判孤儿） */
function readProcCmdline(pid) { return platform().process.procCmdline(pid); }

/** 读 /proc/<pid> 启动时刻（epoch ms；不可验证平台返 null） */
function readProcStartMs(pid) { return platform().process.procStartMs(pid); }

/** pid 是否存活（EPERM=存在但不同用户，按存活处理；僵尸 Z 视为已死——未收割的 kill -9 子进程不得误判存活） */
function processAlive(pid) { return platform().process.alive(pid); }

/** 构造探针（纯函数 judgeOrphan 的实参） */
function probeProcess(state) {
  const pid = Number(state && state.pid);
  const alive = processAlive(pid);
  if (!alive) return { alive: false, cmdlineHasJobId: null, startDeltaMs: null };
  const argv = readProcCmdline(pid);
  let cmdlineHasJobId = (argv && argv.length) ? argv.includes(String(state.jobId)) : null;
  // 刚 spawn 的进程在 exec 完成前 cmdline 可能为空/未更新——5s 宽限内不据此判 pid 复用
  const startedMs = Date.parse(state.startedAt);
  if (cmdlineHasJobId === false && Number.isFinite(startedMs) && Date.now() - startedMs < 5000) cmdlineHasJobId = null;
  const startMs = readProcStartMs(pid);
  const started = Date.parse(state.startedAt);
  const startDeltaMs = (startMs != null && Number.isFinite(started)) ? startMs - started : null;
  return { alive: true, cmdlineHasJobId, startDeltaMs };
}

const ORPHAN_NOTES = {
  'pid-dead': '孤儿：进程已不存在（pid 已死）',
  'pid-reused-cmdline': '孤儿：pid 已被复用（cmdline 不含本作业 jobId）',
  'pid-reused-startedAt': '孤儿：pid 已被复用（启动时刻与 startedAt 不符）',
};

/* ── 惰性清扫（终态保留 600s / 孤儿标 failed / 残留槽位回收） ── */

function sweep(opts) {
  const o = opts || {};
  const dir = jobsDirOf(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const out = { orphaned: [], expired: [], slotsReleased: 0 };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const stateFiles = names.filter((n) => /^job-.*\.json$/.test(n)).map((n) => path.join(dir, n));

  // ① running 状态 → 三元组判定；孤儿标 failed（**不删产物**）
  for (const file of stateFiles) {
    const st = readJson(file);
    if (!st || st.status !== 'running') continue;
    const j = judgeOrphan(st, probeProcess(st));
    if (!j.orphan) continue;
    const note = ORPHAN_NOTES[j.reason] || `孤儿：${j.reason}`;
    try {
      mergeState(file, { status: 'failed', finishedAt: time.isoLocal(), note, orphanReason: j.reason });
      out.orphaned.push({ jobId: st.jobId, reason: j.reason });
    } catch { /* 清扫旁路：单条失败不影响其余 */ }
  }

  // ② 终态状态文件保留 600s 后清理（含日志）
  for (const file of stateFiles) {
    const st = readJson(file);
    if (!st || st.status === 'running') continue;
    const end = Date.parse(st.finishedAt || st.startedAt || '');
    if (!Number.isFinite(end) || now - end <= TERMINAL_TTL_MS) continue;
    const expiredId = st.jobId || path.basename(file, '.json');
    try { fs.unlinkSync(file); } catch { /* 已不在 */ }
    try { fs.unlinkSync(logFileOf(dir, expiredId)); } catch { /* 无日志 */ }
    // 状态先删后，槽位回收分支会因「无状态」只看 5s 宽限而漏删刚创建的槽——按 jobId 直接回收
    if (releaseSlotByJobId(dir, expiredId)) out.slotsReleased++;
    out.expired.push(expiredId);
  }

  // ③ 槽位回收：终态/孤儿/无主槽；无主槽给 5s 宽限（防抢删 start 的「先建槽后写状态」窗口）
  const slotDir = slotsDirOf(dir);
  let slots = [];
  try { slots = fs.readdirSync(slotDir); } catch { /* 无 slots 目录 */ }
  for (const n of slots) {
    if (!/^slot-\d+$/.test(n)) continue;
    const f = path.join(slotDir, n);
    const meta = readJson(f);
    const jobId = meta && meta.jobId;
    if (!jobId) {
      let age = Infinity;
      try { age = now - fs.statSync(f).mtimeMs; } catch { /* 已不在 */ }
      if (age > SLOT_ORPHAN_MIN_AGE_MS) { if (releaseSlot(f)) out.slotsReleased++; }
      continue;
    }
    const st = readJson(stateFileOf(dir, jobId));
    if (!st) {
      let age = Infinity;
      try { age = now - fs.statSync(f).mtimeMs; } catch { /* 已不在 */ }
      if (age > SLOT_ORPHAN_MIN_AGE_MS) { if (releaseSlot(f)) out.slotsReleased++; }
      continue;
    }
    if (st.status === 'running') continue; // 活作业/待清扫作业的槽位不动
    if (releaseSlot(f)) out.slotsReleased++;
  }
  return out;
}

/* ── 查询面 ── */

function list(opts) {
  const o = opts || {};
  const dir = jobsDirOf(o);
  sweep({ jobsDir: dir, now: o.now });
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^job-.*\.json$/.test(n)) continue;
    const st = readJson(path.join(dir, n));
    if (st) out.push(Object.assign({}, st, { stateFile: path.join(dir, n) }));
  }
  out.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return out;
}

/** 按精确 id 或唯一前缀查找（多前缀不猜）；返回 {ok,state,stateFile} 或 {ok:false,code,message} */
function findJob(id, opts) {
  const dir = jobsDirOf(opts);
  const raw = String(id == null ? '' : id);
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((n) => /^job-.*\.json$/.test(n)).map((n) => n.slice(0, -5)); } catch { /* 无 */ }
  if (isValidJobId(raw) && ids.includes(raw)) {
    const stateFile = stateFileOf(dir, raw);
    return { ok: true, state: readJson(stateFile), stateFile };
  }
  const hits = ids.filter((x) => x.startsWith(raw));
  if (hits.length === 1) {
    const stateFile = stateFileOf(dir, hits[0]);
    return { ok: true, state: readJson(stateFile), stateFile };
  }
  if (hits.length > 1) return { ok: false, code: 'E_USAGE', message: `job id 前缀「${raw}」命中 ${hits.length} 个作业，请给完整 id（${hits.slice(0, 6).join('、')}）` };
  return { ok: false, code: 'E_USAGE', message: `作业不存在：${raw}（cdp.js job list 查看）` };
}

function status(id, opts) {
  const dir = jobsDirOf(opts);
  sweep({ jobsDir: dir, now: opts && opts.now });
  const f = findJob(id, { jobsDir: dir });
  if (!f.ok) return f;
  return { ok: true, state: f.state, stateFile: f.stateFile };
}

/* ── 启动（占槽 → 状态 → spawn → 立即返回） ── */

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 退化：不睡 */ }
}

/**
 * start(opts)：
 *   argv: 用户命令 argv（含子命令，可含 --async；内部剔除）
 *   cmd: 命令名（仅展示；缺省 argv[0]）
 *   jobsDir/scriptPath/max/jobId/waitMs: 测试/内部接缝
 * 返回 {ok:true,jobId,status:'running',stateFile,pid,slot} 或 {ok:false,code,message}
 */
function start(opts) {
  const o = opts || {};
  const dir = jobsDirOf(o);
  const argv = stripAsync(o.argv || []);
  if (!argv.length) return { ok: false, code: 'E_USAGE', message: '作业缺少命令 argv' };
  const max = o.max || maxJobs();
  const jobId = o.jobId || makeJobId();
  if (!isValidJobId(jobId)) return { ok: false, code: 'E_USAGE', message: `非法 jobId：${jobId}` };
  const scriptPath = o.scriptPath || process.argv[1] || path.join(paths.SKILL_ROOT, 'tools', 'cdp.js');
  const cmd = o.cmd || String(argv[0] || '');

  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, code: 'E_IO', message: `jobs 目录不可建：${dir}（${e.message}）` }; }
  sweep({ jobsDir: dir });

  // E_BUSY 可选阻塞重试（--wait）：低复杂度增强——满时等到 deadline 再试一次
  let slot = acquireSlot({ jobsDir: dir, max, jobId });
  if (!slot.ok && Number(o.waitMs) > 0) {
    const deadline = Date.now() + Number(o.waitMs);
    while (!slot.ok && Date.now() < deadline) {
      sleepSync(Math.min(250, Math.max(20, deadline - Date.now())));
      slot = acquireSlot({ jobsDir: dir, max, jobId });
    }
  }
  if (!slot.ok) return slot;

  const stateFile = stateFileOf(dir, jobId);
  const logFile = logFileOf(dir, jobId);
  const state = {
    jobId,
    pid: null,
    startedAt: time.isoLocal(),
    cmdline: argv.slice(),
    cmd,
    status: 'running',
    progress: { phase: 'spawn', current: 0, total: null, updatedAt: time.isoLocal() },
    artifact: null,
    exitCode: null,
    stateFile,
    logFile,
    slot: slot.index,
    note: null,
  };
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    writeJsonAtomic(stateFile, state);
  } catch (e) {
    releaseSlot(slot.file);
    return { ok: false, code: 'E_IO', message: `作业状态文件不可写：${stateFile}（${e.message}）` };
  }

  let logFd = null;
  let child = null;
  try {
    logFd = fs.openSync(logFile, 'a');
    child = spawn(process.execPath, [scriptPath, ...argv, '--job-id', jobId], {
      detached: true, // 进程组组长：cancel 用 process.kill(-pid, sig) 整组终止
      stdio: ['ignore', logFd, logFd],
      cwd: o.cwd || process.cwd(),
      env: Object.assign({}, process.env, {
        CHROMEUSE_JOB_ID: jobId,
        CHROMEUSE_JOB_STATE_FILE: stateFile,
        CHROMEUSE_JOB_SLOT_FILE: slot.file,
        CHROMEUSE_JOB_LOG_FILE: logFile,
      }),
    });
  } catch (e) {
    try { if (logFd != null) fs.closeSync(logFd); } catch { /* 忽略 */ }
    releaseSlot(slot.file);
    try { fs.unlinkSync(stateFile); } catch { /* 忽略 */ }
    return { ok: false, code: 'E_INTERNAL', message: `作业子进程启动失败：${e.message}` };
  } finally {
    try { if (logFd != null) fs.closeSync(logFd); } catch { /* 忽略 */ }
  }

  if (!child || !child.pid) {
    releaseSlot(slot.file);
    try { fs.unlinkSync(stateFile); } catch { /* 忽略 */ }
    return { ok: false, code: 'E_INTERNAL', message: '作业子进程未取得 pid（spawn 失败）' };
  }
  try { child.unref(); } catch { /* 忽略 */ }
  child.on('error', (e) => {
    try {
      const st = readJson(stateFile) || {};
      writeJsonAtomic(stateFile, Object.assign({}, st, {
        status: 'failed', finishedAt: time.isoLocal(), note: `子进程 spawn 错误：${e.message}`,
      }));
    } catch { /* 忽略 */ }
    releaseSlot(slot.file);
  });
  try { mergeState(stateFile, { pid: child.pid }); } catch { /* 观测面失败不影响启动 */ }
  return { ok: true, jobId, status: 'running', stateFile, pid: child.pid, slot: slot.index };
}

/* ── 子进程侧接线（env 注入；退出时写终态并释放槽位） ── */

let childAttached = false;
let childFinalized = false;

/** cdp.js 启动时调用：若本进程是作业子进程，接管进度上报与终态落盘（同步 IO，exit 事件安全） */
function attachChild() {
  const stateFile = process.env.CHROMEUSE_JOB_STATE_FILE;
  if (!stateFile || childAttached) return null;
  childAttached = true;
  const jobId = process.env.CHROMEUSE_JOB_ID || path.basename(stateFile, '.json');
  const slotFile = process.env.CHROMEUSE_JOB_SLOT_FILE || null;
  // 只补 pid，不重置 status（防 cancelRequestedAt 已写入的极早期取消被覆盖回 running）
  try { mergeState(stateFile, { pid: process.pid }); } catch { /* 忽略 */ }

  const finalize = (code) => {
    if (childFinalized) return;
    childFinalized = true;
    try {
      const st = readJson(stateFile) || { jobId, startedAt: time.isoLocal(), cmdline: [] };
      const cancelled = !!st.cancelRequestedAt;
      const exitCode = Number.isFinite(code) ? code : (typeof code === 'number' ? code : null);
      const patch = {
        status: cancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed'),
        exitCode,
        finishedAt: time.isoLocal(),
      };
      if (cancelled && !st.note) patch.note = 'cancel：已完成产物保留（partial 语义）';
      writeJsonAtomic(stateFile, Object.assign({}, st, patch));
    } catch { /* 终态落盘失败不影响退出 */ }
    releaseSlot(slotFile);
  };
  process.on('exit', (code) => finalize(code));
  return { jobId, stateFile, slotFile, progress, setArtifact };
}

/** 进度上报（子进程侧单点；非作业进程恒 no-op） */
function progress(patch) {
  const stateFile = process.env.CHROMEUSE_JOB_STATE_FILE;
  if (!stateFile) return false;
  try {
    const st = readJson(stateFile);
    if (!st || st.status !== 'running') return false;
    const nextProgress = Object.assign({}, st.progress || {}, patch || {}, { updatedAt: time.isoLocal() });
    const next = Object.assign({}, st, { progress: nextProgress });
    if (patch && patch.artifact) next.artifact = patch.artifact;
    writeJsonAtomic(stateFile, next);
    return true;
  } catch { return false; }
}

/** 产物路径登记（子进程侧；状态文件 artifact 字段） */
function setArtifact(p) {
  if (!p) return false;
  return progress({ artifact: p });
}

/* ── 取消（双路信号 + partial 保留） ── */

/** 取消信号：整组 kill(-pid) 优先（Linux），失败落回单 pid；返回 'group'|'pid'|null（实现单源在 platform process 域） */
function signalProcessGroup(pid, signal) { return platform().process.signalProcessGroup(pid, signal); }

async function waitExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await time.sleep(Math.min(150, Math.max(20, deadline - Date.now())));
  }
  return !processAlive(pid);
}

/** record 专用优雅停：读 .record-state.json，pid 匹配才 POST /__stop（目标进程支持时的第一路） */
async function tryRecordStop(state) {
  const cmdline = state && Array.isArray(state.cmdline) ? state.cmdline : [];
  if (!cmdline.includes('record') || cmdline.includes('record-stop')) return { attempted: false, ok: false };
  const recFile = path.join(paths.EVENTS_DIR, '.record-state.json');
  const rec = readJson(recFile);
  if (!rec || Number(rec.pid) !== Number(state.pid) || !rec.port) return { attempted: false, ok: false };
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/__stop`, { method: 'POST', body: 'stop', signal: AbortSignal.timeout(5000) });
    return { attempted: true, ok: !!res.ok, status: res.status, port: rec.port };
  } catch (e) {
    return { attempted: true, ok: false, error: e.message, port: rec.port };
  }
}

/**
 * cancel(id, opts) → Promise<{ok:true, already?, state, stateFile, signal, artifact} | {ok:false,code,message}>
 * 双路：record 优先 POST /__stop；无论成败统一进程组 SIGTERM，3s 未退再 SIGKILL。
 */
async function cancel(id, opts) {
  const o = opts || {};
  const dir = jobsDirOf(o);
  sweep({ jobsDir: dir, now: o.now });
  const found = findJob(id, { jobsDir: dir });
  if (!found.ok) return found;
  let st = found.state || {};
  const stateFile = found.stateFile;
  if (st.status !== 'running') {
    return { ok: true, already: true, jobId: st.jobId, state: st, stateFile, message: `作业已是终态 ${st.status}` };
  }
  // 先落 cancelRequestedAt：子进程退出钩子据此把终态记为 cancelled（而非 failed）
  st = mergeState(stateFile, { cancelRequestedAt: time.isoLocal(), cancelBy: process.pid });
  const pathTaken = [];
  const stop = await tryRecordStop(st);
  if (stop.attempted) pathTaken.push(stop.ok ? 'post-stop' : 'post-stop-failed');
  let exited = false;
  if (stop.ok) {
    exited = await waitExit(st.pid, 8000);
    if (exited) pathTaken.push('graceful-exit');
  }
  if (!exited) {
    if (!processAlive(st.pid)) {
      exited = true;
    } else {
      const how = signalProcessGroup(st.pid, 'SIGTERM');
      pathTaken.push(how ? `sigterm-${how}` : 'sigterm-failed');
      exited = await waitExit(st.pid, 3000);
      if (!exited) {
        const how2 = signalProcessGroup(st.pid, 'SIGKILL');
        pathTaken.push(how2 ? `sigkill-${how2}` : 'sigkill-failed');
        exited = await waitExit(st.pid, 2000);
      }
    }
  }
  // 终态落盘（子进程可能已写 cancelled；此处兜底合并，保留 artifact/已完成产物）
  const before = readJson(stateFile) || st;
  const next = mergeState(stateFile, {
    status: 'cancelled',
    finishedAt: before.finishedAt || time.isoLocal(),
    exitCode: before.exitCode == null ? null : before.exitCode,
    note: before.note && /cancel/i.test(before.note)
      ? before.note
      : 'cancel：已完成产物保留（partial 语义，不自动删除）',
    cancelSignal: pathTaken.join('+') || 'none',
  });
  releaseSlotByJobId(dir, next.jobId || st.jobId || id);
  return {
    ok: true,
    jobId: next.jobId || st.jobId || id,
    state: next,
    stateFile,
    signal: pathTaken.join('+') || 'none',
    exited,
    artifact: next.artifact || null,
  };
}

module.exports = {
  // 参数/常量
  TERMINAL_TTL_MS, DEFAULT_MAX_JOBS, MAX_JOBS_CAP, ORPHAN_START_SKEW_MS,
  maxJobs, stripAsync, makeJobId, isValidJobId,
  // 槽位
  acquireSlot, releaseSlot, releaseSlotByJobId,
  // 孤儿判定（纯函数 + 探针）
  judgeOrphan, probeProcess, processAlive, readProcCmdline, readProcStartMs, ORPHAN_NOTES,
  // 状态
  readJson, writeJsonAtomic, mergeState,
  // 清扫/查询
  sweep, list, findJob, status,
  // 生命周期
  start, attachChild, progress, setArtifact, cancel,
};
