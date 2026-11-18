'use strict';
/*
 * chromeuse lib/time.js —— 时间戳单源（时区配置；任务A：日志/录屏/事件流/落盘命名统一走配置）
 *
 * 裁定（单源边界）：
 * - 「文件命名 + 人类可读显示」的时间戳一律经本模块生成：rec-/recording-/net-/screenshot-/
 *   videodiff-/beacon-/flow-fail-/replay- 等落盘命名走 formatStamp()；日志行、落盘头
 *   startedAt/stoppedAt、index/report 显示字段走 isoLocal()；
 * - 数据字段不动：record/screencast 双时钟（tArrive=Node 毫秒 / tMeta=CDP 秒）、事件 tRecv/t、
 *   各类时长 ms、closedAt/injectedAt 台账记账等机器消费字段保持原值原语义——绝对时刻无时区语义，
 *   本模块不介入（消费方 diff-video 按 new Date() 解析，ISO 带偏移串天然兼容，零改动）。
 * 配置入口：环境变量 CHROMEUSE_TZ_OFFSET（分钟数，默认 480 = UTC+8；合法域 ±14h = ±840，
 *   非法/缺省一律回退默认）——零依赖方案（不引 Intl 时区数据包），容器 TZ=UTC 下输出稳定。
 * 两个时间戳出口的形状：
 * - formatStamp() → 'yyyy-MM-dd_HH-mm-ss'（文件名安全；形状同历史 ts()：ISO 串 [:.] 换 '-'、T 换 '_'，
 *   长度不变——落盘文件名从 UTC 切到配置时区，消费方按目录定位无格式假设，天然兼容）
 * - isoLocal() → 'yyyy-MM-ddTHH:mm:ss.sss±HH:mm'（ISO 8601 带偏移；new Date() 可直接解析回同一时刻，
 *   旧 Z 结尾串与新串混合读取亦正确——log 轮转判定/diff-video 对齐均用 new Date() 解析）
 * 非时间戳能力（V20261031006 console/单源复查批）：sleep(ms) 通用延迟单源——各脚本禁再自建
 *   `(ms) => new Promise(r => setTimeout(r, ms))` 小函数。
 */

const DEFAULT_TZ_OFFSET = 480; // UTC+8

/** 读配置偏移（分钟）：CHROMEUSE_TZ_OFFSET，缺省/非法回退 480（UTC+8）；参数 env 供单测注入 */
function tzOffset(env) {
  const raw = (env || process.env).CHROMEUSE_TZ_OFFSET;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= -840 && n <= 840 ? n : DEFAULT_TZ_OFFSET;
}

/** 按偏移平移后的墙上时钟部件：对「本地时刻 + 偏移」取 UTC 字段即目标时区的本地字段（零依赖核心技巧） */
function tzParts(date, offset) {
  const o = Number.isFinite(offset) ? offset : tzOffset();
  const d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  const s = new Date(d.getTime() + o * 60000);
  return {
    year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate(),
    hour: s.getUTCHours(), minute: s.getUTCMinutes(), second: s.getUTCSeconds(), ms: s.getUTCMilliseconds(),
  };
}

const pad2 = (n) => String(n).padStart(2, '0'); // 两位补零单源（log.js/audit.js 复用，勿在调用方重建）

/** 文件名安全时间戳 'yyyy-MM-dd_HH-mm-ss'（默认按 CHROMEUSE_TZ_OFFSET，默认 UTC+8） */
function formatStamp(date, offset) {
  const p = tzParts(date, offset);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}_${pad2(p.hour)}-${pad2(p.minute)}-${pad2(p.second)}`;
}

/** 显示用 ISO 8601 带偏移 'yyyy-MM-ddTHH:mm:ss.sss±HH:mm'（new Date() 可解析；默认按 CHROMEUSE_TZ_OFFSET） */
function isoLocal(date, offset) {
  const o = Number.isFinite(offset) ? offset : tzOffset();
  const p = tzParts(date, o);
  const abs = Math.abs(o);
  const suffix = `${o < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}.${String(p.ms).padStart(3, '0')}${suffix}`;
}

/** 通用延迟单源（Promise 包装 setTimeout）：各脚本禁再自建同名延迟小函数（V20261031006 单源复查批） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DEFAULT_TZ_OFFSET, tzOffset, tzParts, pad2, formatStamp, isoLocal, sleep };
