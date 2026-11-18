'use strict';
/*
 * chromeuse lib/paths.js —— 落盘路径单源（V202609080007）
 *
 * 裁定（执行方案 v2.1 §V007）：路径是结构常量非用户偏好——不进 config.jsonc，独立本模块；
 * 之前字面量散落在 flow-engine / record / events / cdp.js / lock.js 五处，本文件收口后
 * 所有写盘方一律 require('./paths')，禁再写 path.join(__dirname, '..', 'reports', 'events') 类字面量（selftest #20 机检）。
 *
 * 目录结构（tmpdata/ 整目录 gitignored，随用随建——写盘前 ensureDir）：
 *   tmpdata/events/     事件流 recording-*.json / 截图 / 网络取证 net-*.json
 *   tmpdata/flow-fail/  flow 失败报告 flow-fail-*.json + 终态截图
 *   tmpdata/locks/      互斥锁 .chromeuse.lock（旧 skill 根 .chromeuse.lock 位置废弃）
 *   tmpdata/audit/      结构化审计 JSONL（yyyy-mm-dd.jsonl，按天切分；V202611030004 B3 N3）
 *   tmpdata/handoff/    人机接力状态 <id>.json + Continue 信号 <id>.continue（C2 #128；终态 24h 惰性清扫）
 *   tmpdata/browser/    浏览器 launch 模式 state launch-state.json（批C1/R2；quota 归 other 永不删）
 *   log/                统一日志（lib/log.js 专用；chromeuse.log 当天 + 日期轮转归档）
 *
 * 产物治理（V202611030005 B3 N2）：下列目录 = lib/quota.js 分类表**登记目录**（report 覆盖断言准源）。
 *   预登记（后续批将建，先登记防「未登记=other 永不删」无界增长）：refs/ jobs/ a11y-baseline/ flow-checkpoints/。
 */
const fs = require('node:fs');
const path = require('node:path');

const SKILL_ROOT = path.join(__dirname, '..');
/*
 * tmpdata 根（V202610280004 ISSUE-3）：默认 SKILL_ROOT/tmpdata，支持部署环境注入
 * CHROMEUSE_TMPDATA_DIR 覆盖（须绝对路径；空串/未设 → 默认；非绝对路径 → 默认 + stderr 一行 warn，
 * 防 cwd 漂移与静默忽略）。与文件头「路径是结构常量、不进 config.jsonc」裁定不冲突——env 是部署
 * 环境注入，不是 skill 运行配置项。动机：skill 装在 opencode skills 监视根内（如
 * ~/.config/opencode/skills/）时，高频写盘（尤其全量 selftest）会触发 skills watcher 重扫 →
 * agent 重注册风暴（2026-10-28 Windows 端实测 40~187 次/秒）；覆盖到监视根外即可规避。
 * 其余派生路径（EVENTS/FLOW_FAIL/LOCKS/LOCK_PATH/VIDEO/EVIDENCE/REPLAY_VERDICT/FORENSICS）自动跟随；
 * LOG_DIR 是独立根（默认 SKILL_ROOT/log，可经 CHROMEUSE_LOG_DIR 单独覆盖），不随本覆盖。
 */
const DEFAULT_TMPDATA_DIR = path.join(SKILL_ROOT, 'tmpdata');
const TMPDATA_DIR = (() => {
  const raw = process.env.CHROMEUSE_TMPDATA_DIR;
  if (!raw) return DEFAULT_TMPDATA_DIR; // 未设或空串 = 默认（不告警）
  if (!path.isAbsolute(raw)) {
    // ③ 加载序例外（V20261031006）：本模块被 lib/log.js require（log→paths 单向依赖），此处不能反向
    //    require('./log')（循环加载时 log 未初始化）。env 校验告警是模块加载期一次性 stderr 提示，
    //    保留原生 console.error 并注明理由，不视为绕过统一日志。
    console.error(`⚠ chromeuse paths: CHROMEUSE_TMPDATA_DIR 须为绝对路径（收到 ${JSON.stringify(raw)}），已忽略并回退 ${DEFAULT_TMPDATA_DIR}`);
    return DEFAULT_TMPDATA_DIR;
  }
  return path.normalize(raw);
})();
const EVENTS_DIR = path.join(TMPDATA_DIR, 'events');
const FLOW_FAIL_DIR = path.join(TMPDATA_DIR, 'flow-fail');
const LOCKS_DIR = path.join(TMPDATA_DIR, 'locks');
const LOCK_PATH = path.join(LOCKS_DIR, '.chromeuse.lock');
// 录屏兜底帧流目录（V202609090002）：tmpdata/video/<session>/{index.json, frames/<tab>/NNNNNN.jpg}
const VIDEO_DIR = path.join(TMPDATA_DIR, 'video');
// 一次性录屏 cast 产物目录（二期-4，2026-10-31）：tmpdata/cast/cast-<stamp>.{mp4,frames/,json}
const CAST_DIR = path.join(TMPDATA_DIR, 'cast');
// 验收回放证据包目录（V202609170003）：tmpdata/evidence/evidence-pack-<stamp>/{timeline.json, README.md}
const EVIDENCE_DIR = path.join(TMPDATA_DIR, 'evidence');
// 回放成功 verdict 目录（V202609190001）：tmpdata/replay-verdict/replay-verdict-<stamp>.json——
// 成功路径同步落盘旁路（finally client.close() 间歇挂起被外部 SIGKILL 时 stdout 管道缓冲被吞，
// 失败路径有 flow-fail 文件旁路、成功路径此前无任何落盘旁路——对等补齐）
const REPLAY_VERDICT_DIR = path.join(TMPDATA_DIR, 'replay-verdict');
// 录制定位素材文件（V202609220001）：locate-materials-<事件流 stem>.jsonl——与 recording-*.json 同目录
// 同 stem 配对（--out 自定义时跟随其目录与 stem）；纯 jsonl 无头行、逐行一条素材。消费定位：蒸馏
// 定位四层链③层兜底直接抄作；不进 flow schema、不进回放执行链（终审铁律）。写盘方（lib/record.js）
// 禁字面量文件名——一律走 locateMaterialsPath()（selftest #20 同口径机检）
const LOCATE_MATERIALS_PREFIX = 'locate-materials';
// CDP 失效分型取证报告目录（V202609300001 doctor-forensics）：tmpdata/cdp-forensics/forensics-<stamp>.json
// ——通道全死也照常落盘（取证命令存在的核心理由）；tmpdata/ 整目录 gitignored
const FORENSICS_DIR = path.join(TMPDATA_DIR, 'cdp-forensics');
// 结构化审计目录（V202611030004 B3 N3）：tmpdata/audit/yyyy-mm-dd.jsonl（gitignored；随 N2 prune 30 天清理）
const AUDIT_DIR = path.join(TMPDATA_DIR, 'audit');
// 人机接力 handoff 状态目录（C2 #128）：ho-<stamp>-<4hex>.json 状态文件 + <id>.continue 信号文件；
// 路径单源提升（原 tab-govern.js 本地定义），tab-govern/detectBusy 与 lib/handoff.js 共用本导出。
const HANDOFF_DIR = path.join(TMPDATA_DIR, 'handoff');
// 浏览器 launch 模式 state 目录（批C1/R2，V20261117007）：tmpdata/browser/launch-state.json——pid/port/exe/
// userDataDir/startedAt（原子写 tmp+rename）；--stop 据此关停。quota 分类归 other（永不自动删）
const BROWSER_DIR = path.join(TMPDATA_DIR, 'browser');
const LAUNCH_STATE_FILE = path.join(BROWSER_DIR, 'launch-state.json');
// 浏览器能力探测缓存目录（ISSUE-1，2026-11-18）：tmpdata/state/beyond-viewport.json（key=browserVersion，
// 手删即重探）。quota 分类归 other（lib/quota.js 白名单制：未登记=other 永不自动删）；消费者单源=lib/beyond-probe.js。
const STATE_DIR = path.join(TMPDATA_DIR, 'state');
// 产物分类表登记目录（V202611030005 B3 N2；lib/quota.js 唯一消费方，report 覆盖断言按此枚举）：
//   downloads     下载产物（当前无写入方，预登记）
//   scroll-shot   --out-dir 默认仍落 events/；此处为显式 --out-dir 的默认登记位（预留）
//   videodiff     diff-video 报告
//   refs          B5 ref 表缓存（→ other 永不删）
//   jobs          B7 作业状态（→ other；B7 实装终态清理）
//   a11y-baseline B6a 快照基线（→ 7 天）
//   flow-checkpoints B8 断点（→ 7 天）
//   browser       launch 模式 state（批C1；→ other 永不删）
const DOWNLOADS_DIR = path.join(TMPDATA_DIR, 'downloads');
const SCROLL_SHOT_DIR = path.join(TMPDATA_DIR, 'scroll-shot');
const VIDEODIFF_DIR = path.join(TMPDATA_DIR, 'videodiff');
const REFS_DIR = path.join(TMPDATA_DIR, 'refs');
const JOBS_DIR = path.join(TMPDATA_DIR, 'jobs');
const A11Y_BASELINE_DIR = path.join(TMPDATA_DIR, 'a11y-baseline');
const FLOW_CHECKPOINTS_DIR = path.join(TMPDATA_DIR, 'flow-checkpoints');
// pin 清单（artifacts pin）：证据类永不自动删；与 tmpdata 同根（本文件自身归 other 不自动删）
const ARTIFACTS_PIN_FILE = path.join(TMPDATA_DIR, 'artifacts-pinned.json');
function locateMaterialsPath(outFile) {
  const stem = path.basename(String(outFile || '')).replace(/\.(json|jsonl)$/i, '');
  return path.join(path.dirname(String(outFile || '')), `${LOCATE_MATERIALS_PREFIX}-${stem}.jsonl`);
}
/*
 * 统一日志目录（lib/log.js 单一消费者；当天活动日志 chromeuse.log + 日期轮转归档，*.log gitignored、目录 .gitkeep 入库）。
 * V20261117014 ISSUE-2：支持 CHROMEUSE_LOG_DIR 覆盖（与 CHROMEUSE_TMPDATA_DIR 成对用于隔离测试写盘——skill 位于
 * opencode skills 监视根内时，测试/批量运行不再写 live log/）。空串/未设 → 默认值（与旧版逐字节相同）；相对路径
 * **按 SKILL_ROOT 基准解析**（与 config.bin 同规则；不允许 cwd 基准——同一 skill 在任意 cwd 下跑日志落点必须一致）。
 */
const DEFAULT_LOG_DIR = path.join(SKILL_ROOT, 'log');
const LOG_DIR = (() => {
  const raw = process.env.CHROMEUSE_LOG_DIR;
  if (!raw) return DEFAULT_LOG_DIR; // 未设或空串 = 默认（不告警）
  return path.normalize(path.isAbsolute(raw) ? raw : path.join(SKILL_ROOT, raw));
})();

/** 确保目录存在（随用随建；写盘前调用），返回目录路径 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 展示/跨平台键归一：平台原生分隔符 → '/'（POSIX 恒等；批3 #136 单源收口）。
 * 用途：报告/JSON 路径展示与跨平台键比较（audit 产物相对路径、artifacts pin 键）——**不改变文件
 * 系统语义**，磁盘操作仍一律走 path.* 原生 API。sep 仅供 selftest 注入（path.win32.sep mock Windows）。
 */
function toPosix(p, sep) {
  return String(p).split(sep === undefined ? path.sep : sep).join('/');
}

/** root 相对的 POSIX 展示路径（= toPosix(path.relative(root, abs))）；越界/绝对路径判断留给调用方 */
function toPosixRel(root, abs) {
  return toPosix(path.relative(root, abs));
}

module.exports = {
  SKILL_ROOT, TMPDATA_DIR, EVENTS_DIR, FLOW_FAIL_DIR, LOCKS_DIR, LOCK_PATH, VIDEO_DIR, CAST_DIR,
  EVIDENCE_DIR, REPLAY_VERDICT_DIR, FORENSICS_DIR, LOCATE_MATERIALS_PREFIX, locateMaterialsPath,
  DEFAULT_LOG_DIR, LOG_DIR,
  AUDIT_DIR, HANDOFF_DIR, DOWNLOADS_DIR, SCROLL_SHOT_DIR, VIDEODIFF_DIR, REFS_DIR, JOBS_DIR, A11Y_BASELINE_DIR,
  FLOW_CHECKPOINTS_DIR, ARTIFACTS_PIN_FILE, BROWSER_DIR, LAUNCH_STATE_FILE, STATE_DIR, ensureDir, toPosix, toPosixRel,
};
