'use strict';
/*
 * chromeuse lib/log.js —— 统一日志工具类（skill 全部脚本的唯一日志出口）
 *
 * 纪律：各脚本禁止直接 console/file 写运行日志，一律 require('./log') 调 info/warn/error/debug；
 *   （面向用户的交互输出——CLI 结果打印、selftest 报告行——不算日志，仍走 console）
 * 日志文件：log/chromeuse.log（当天活动日志；路径单源 lib/paths.js LOG_DIR）。
 * 日期轮转：首次写日志时检查 chromeuse.log 是否非今天——判定优先读首行 [ISO 时间戳] 的日期，
 *   读不到（空文件/损坏）回退文件 mtime；非今天则改名归档为 chromeuse.<yyyyMMddTHHmmss>.log
 *   （归档时间戳 = 轮转时刻本地时间，命名风格同 omo-slim 的 oh-my-opencode-slim.20260901T005459.log）
 *   再由后续 appendFileSync 自然创建新文件。
 * 行格式：`[ISO 带偏移时间（配置时区，lib/time.js，默认 UTC+8）] [LEVEL] [tag] msg`；error 可附 err（stack 压成单行追加）。
 * 可靠性：全部写文件逻辑 try/catch 吞异常——日志失败绝不影响主流程；同步 appendFileSync
 *   （录制/回放是长驻进程且日志低频，同步写简单可靠、无丢尾风险）。
 * debug 级默认静默，环境变量 CHROMEUSE_LOG_DEBUG=1 时启用。
 * 终端回显（V20261031007 用户裁定 A）：info/warn/error 末位可选 opts { echo: true }——该条写盘后
 *   **同时以 `[tag] msg` 单行打 stderr**（信息量与迁移前 console 行等价；无时间戳/级别修饰）。
 *   默认全关：不传 opts 的既有调用行为零变化（flow-engine 等只落盘不回显）；仅长任务进度/告警点显式标注。
 *   环境变量 CHROMEUSE_LOG_ECHO=0 全局关闭回显（默认开启 echo 标注；安静模式门）；与 CHROMEUSE_LOG_DEBUG 并列。
 * 热路径禁令：events.js preprocess 逐事件等高频路径禁止调用本模块（防刷屏）。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');

const LOG_FILE = path.join(paths.LOG_DIR, 'chromeuse.log');
const DEBUG = process.env.CHROMEUSE_LOG_DEBUG === '1';
const ECHO_ENABLED = process.env.CHROMEUSE_LOG_ECHO !== '0'; // 默认开启 echo 标注；=0 全局静默
let initialized = false;

/** 本地日期串 yyyy-MM-dd（轮转"今天"判定与归档名统一用配置时区——lib/time.js 单源，默认 UTC+8） */
function localDateStr(d) {
  const p = time.tzParts(d || new Date());
  return `${p.year}-${time.pad2(p.month)}-${time.pad2(p.day)}`;
}

/** 归档名时间戳 yyyyMMddTHHmmss（配置时区；风格同 omo-slim oh-my-opencode-slim.20260901T005459.log） */
function archiveStamp(d) {
  const p = time.tzParts(d || new Date());
  return `${p.year}${time.pad2(p.month)}${time.pad2(p.day)}T${time.pad2(p.hour)}${time.pad2(p.minute)}${time.pad2(p.second)}`;
}

/** 判定日志文件是否属于今天：首行 [ISO 时间戳] 优先（完整时间戳换算本地日期——UTC 日历日与本地日差 8h，
    只比日期串会在本地 0~8 点间误轮转），读不到/解析失败回退 mtime */
function isFromToday(file, now) {
  const today = localDateStr(now || new Date());
  let d = null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const m = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(buf.toString('utf8', 0, n));
    if (m) { const p = new Date(m[1]); if (!isNaN(p.getTime())) d = p; }
  } catch { /* 空文件/读失败 → mtime 兜底 */ }
  if (!d) {
    try { d = fs.statSync(file).mtime; } catch { return false; }
  }
  return localDateStr(d) === today;
}

/**
 * 归档改名：file 存在且非今天 → 同目录改名 chromeuse.<yyyyMMddTHHmmss>.log，返回归档绝对路径；
 * 文件不存在或已是今天 → 返回 null。参数化 file/now 便于临时目录单测（selftest #25）。
 */
function rotateStale(file, now) {
  try {
    if (!fs.existsSync(file) || isFromToday(file, now)) return null;
    const target = path.join(path.dirname(file), `chromeuse.${archiveStamp(now)}.log`);
    fs.renameSync(file, target);
    return target;
  } catch { return null; }
}

/** 初始化（首次写日志时调用一次）：建目录 + 过期日志归档轮转；失败吞掉 */
function init() {
  if (initialized) return;
  initialized = true;
  try {
    paths.ensureDir(paths.LOG_DIR);
    rotateStale(LOG_FILE);
  } catch { /* 日志失败不影响主流程 */ }
}

/** 组装行：`[ISO 带偏移] [LEVEL] [tag] msg`（时间显示走配置时区 lib/time.js，默认 UTC+8；new Date() 可解析——
    轮转判定 isFromToday 的正则本就兼容 Z/±HH:mm 两种结尾）；err（含 stack）压成单行追加，日志保持一事件一行 */
function buildLine(level, tag, msg, err) {
  let line = `[${time.isoLocal()}] [${level}] [${tag}] ${msg}`;
  if (err !== undefined && err !== null) {
    const detail = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
    line += ` ｜ ${detail.replace(/\s*\r?\n[\s\t]*/g, ' / ')}`;
  }
  return line;
}

/** 终端回显：`[tag] msg` 单行 → stderr（格式与迁移前 console 行等价）；失败吞掉，绝不影响主流程 */
function echoLine(tag, msg) {
  try { process.stderr.write(`[${tag}] ${msg}\n`); } catch { /* 回显失败不影响主流程 */ }
}

function write(level, tag, msg, err, opts) {
  try {
    init();
    fs.appendFileSync(LOG_FILE, buildLine(level, tag, msg, err) + '\n');
  } catch { /* 吞掉——日志失败绝不影响主流程 */ }
  // 回显独立于写盘：即使日志目录不可写，长任务进度仍应让操作者看见
  if (opts && opts.echo === true && ECHO_ENABLED) echoLine(tag, String(msg));
}

module.exports = {
  info: (tag, msg, opts) => write('INFO', tag, msg, undefined, opts),
  warn: (tag, msg, opts) => write('WARN', tag, msg, undefined, opts),
  error: (tag, msg, err, opts) => write('ERROR', tag, msg, err, opts),
  debug: (tag, msg) => { if (DEBUG) write('DEBUG', tag, msg); },
  /** 单测/自检钩子（selftest #25/#89）：归档命名与轮转判定的纯逻辑，临时目录可直接测 */
  _internals: { LOG_FILE, archiveStamp, isFromToday, rotateStale, buildLine, ECHO_ENABLED },
};
