'use strict';
/*
 * chromeuse lib/lock.js —— .chromeuse.lock 最小互斥锁（架构 v3「并发」裁定：锁已做、调度不做）
 *
 * - 作用域：flow replay / record 两个长动作入口 acquire，退出 release；probe/targets 等秒级只读命令不加锁
 * - 结构：{ owner, pid, host, acquiredAt, heartbeatAt }；heartbeat 超时（默认 15s）视为 stale 可抢占
 *   （record 长驻进程要 hold() 定期续约；replay 短进程无需续约）
 * - 最小实现不做 TOCTOU 双写校验（单机单用户场景，纪律兜底）；锁文件在 tmpdata/locks/（V202609080007 起
 *   路径单源 lib/paths.js，获取前 mkdir -p 随用随建），tmpdata/ 整目录 gitignored
 */
const fs = require('node:fs');
const paths = require('./paths');

const LOCK_PATH = paths.LOCK_PATH;
const STALE_MS = 15000;

function readRaw() {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch { return null; }
}

function isStale(info, now) {
  now = now || Date.now();
  return !info || typeof info.heartbeatAt !== 'number' || (now - info.heartbeatAt) > STALE_MS;
}

/** 尝试持锁；被非 stale 锁占住 → { ok:false, holder }；locks 目录随用随建 */
function acquire(owner) {
  const now = Date.now();
  const cur = readRaw();
  if (cur && !isStale(cur, now)) return { ok: false, holder: cur };
  paths.ensureDir(paths.LOCKS_DIR);
  const info = {
    owner: String(owner || 'unknown'),
    pid: process.pid,
    host: process.env.HOSTNAME || 'local',
    acquiredAt: now,
    heartbeatAt: now,
  };
  fs.writeFileSync(LOCK_PATH, JSON.stringify(info, null, 2) + '\n');
  return { ok: true, info };
}

/** 续约（仅本进程的锁可续）；锁被抢占后返回 false */
function heartbeat() {
  const cur = readRaw();
  if (!cur || cur.pid !== process.pid) return false;
  cur.heartbeatAt = Date.now();
  fs.writeFileSync(LOCK_PATH, JSON.stringify(cur, null, 2) + '\n');
  return true;
}

/** 长驻进程续约定时器：返回 timer（须 clearInterval） */
function hold(intervalMs) {
  return setInterval(() => { if (!heartbeat()) { /* 被抢占：停续约，动作方自行察觉 */ } }, intervalMs || 5000);
}

/** 释放（仅本进程的锁可释放） */
function release() {
  const cur = readRaw();
  if (!cur || cur.pid !== process.pid) return false;
  try { fs.unlinkSync(LOCK_PATH); } catch { /* 已不在 */ }
  return true;
}

module.exports = { LOCK_PATH, STALE_MS, acquire, heartbeat, hold, release, readRaw, isStale };
