'use strict';
/*
 * chromeuse lib/cast.js —— 一次性录屏实现单源（Page.startScreencast → bin/ffmpeg；二期-4，2026-10-31）
 *
 * 定位：`tools/cdp.js cast --duration <s>` 的唯一实现单源。CLI 短连接架构 ⇒ **一次性语义**
 *   （录 N 秒自动停 + 合成 mp4），不做 start/stop 长驻对（避免 watch 式子命令生命周期）。
 *
 * ── 协议与帧行为（GQ-001 核心）────────────────────────────────────────────────
 * - 链路：Page.enable（收 Page 域事件的前提，record/flow 已在别处实证）→
 *   Page.startScreencast({format:'jpeg', quality, everyNthFrame[, maxWidth]}) →
 *   Page.screencastFrame 事件流 → 到时 Page.stopScreencast（finally 必停）。
 * - ⚠ **Chrome 只在画面变化时推帧**（GQ-001：Chrome 88 静止页实测 6s 仅 1 帧；NAS 153 静止页同样
 *   稀帧——本批实弹如实记录）。因此：
 *   ① 绝不能用标称帧率（--every-nth / 名义 5fps）合成——静止 6s 只有 1 帧会被压成 1/5 秒（快放）；
 *   ② fps 一律按**全部实际帧首帧→末帧的真实时间跨度**归一（metadata.timestamp，CDP 秒；缺失时
 *      退回 Node 接收时刻 tArrive，再退录制墙钟）——视频时长=首末帧跨度，播放速度与真实一致。
 *   ③ 帧数 < 2 无法合成：如实失败并报「帧数/时长/帧间隔」（静止页的正常结果，不是 bug）。
 * - ⚠ 帧 ack 字段名陷阱：Page.screencastFrameAck 的参数 `sessionId` = **帧序列号（int）**，与
 *   flatten 多路复用的会话 sessionId（字符串）撞名——帧事件里取 params.sessionId 回填，命令本身
 *   下发给 flatten 会话（opts.sessionId）。**每帧立即 ack**：不 ack 会结构性断流（首弹
 *   9 帧/7s 死锁根因，V202609090003；Puppeteer ScreencastSession 同款）。
 * - **Chrome 88 兼容**：startScreencast / screencastFrame / screencastFrameAck / stopScreencast
 *   在 88 均存在（蓝本 tmpdata/test-tools/chrome-cast.mjs 在 88 实弹，唯一实测差异=静止期稀帧更
 *   明显）。无字段/方法分叉——能力差异不是代码分支，故不设 88 就地分叉。
 *
 * ── ffmpeg 合成（复用 lib/scroll-shot.js，不重写）─────────────────────────────
 * - 路径/可用性 = scrollShot.ffmpegBins() / ffmpegAvailable()（bin/ 单点真源 + `-version` 真探活，
 *   进程级缓存；不回落 PATH——2026-10-28 用户裁定）。
 * - ffmpeg 不可用 → **帧文件仍完整保留**（frameDir）+ 清单 note 给出等价离线命令（帧已留档）。
 * - 合成参数：-framerate <归一 fps> -i <frameDir>/%06d.jpg -c:v libx264 -preset veryfast -crf 28
 *   -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -pix_fmt yuv420p（蓝本同款 + 偶数尺寸护栏；
 *   yuv420p/libx264 要求偶数宽高，实弹 2880x1349 奇数高度直接 exit 187）。
 *
 * ── 前台保障（复用 scrollShot.ensureForeground）───────────────────────────────
 * 目标页签 hidden 时 startScreencast 的后台行为未知（可能不产帧/帧率异常）——开工前读
 * document.visibilityState，hidden/读取失败才 Page.bringToFront 并复核；失败 fail-soft 记 note
 * （前台保障失败不中断录制）。默认不自动还原前台（同 scroll-shot：Chrome 无「查询上一活跃
 * target」稳定 API，瞎切可能切走用户页签）。
 *
 * ── 产物布局（tmpdata 段图目录模式，同 scroll-shot / 蓝本）───────────────────────
 *   <root>/<name>.mp4        视频（成功时）
 *   <root>/<name>.frames/    000001.jpg…（恒保留：ffmpeg 缺失/帧数不足时是唯一留档）
 *   <root>/<name>.json       chromeuse-cast/1 清单
 * 默认 root=tmpdata/cast/、name=cast-<时间戳>；--out 指定则 mp4 路径为准，frames/json 同 stem 相邻。
 *
 * ── 验收语义 ─────────────────────────────────────────────────────────────────
 * 退出码由 CLI 按结果定：帧 >=2 且 mp4 产出 = 0；其余（帧不足/ffmpeg 缺失/startScreencast 失败）
 * 一律 1 并如实报「帧数/时长/帧间隔/离线命令」。**绝不假装成功**。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('./paths');
const log = require('./log');
const time = require('./time');
const scrollShot = require('./scroll-shot'); // ffmpegBins/ffmpegAvailable/ensureForeground 复用单源（不重写）

const FORMAT = 'chromeuse-cast/1';
const MAX_DURATION_SEC = 600;      // 上限防误录爆盘（TODO 要求 600s）
const MIN_DURATION_SEC = 0.1;      // 允许亚秒级（selftest/短动作）；0 拒绝
const DEFAULT_QUALITY = 70;        // 蓝本同款 jpeg 质量
const DEFAULT_EVERY_NTH = 1;
const DEFAULT_MAX_WIDTH = 0;       // 0 = 不约束（原始视口分辨率）
const QUALITY_MIN = 0;
const QUALITY_MAX = 100;
const EVERY_NTH_MIN = 1;
const EVERY_NTH_MAX = 30;
const MAX_WIDTH_MIN = 0;
const MAX_WIDTH_MAX = 3840;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 600000;
const FPS_MAX = 60;                // Chrome 合成器推帧上限 ~60；时钟异常导致计算越界时 clamp（note 如实记录）
const FPS_MIN = 0.001;
const SYNTH_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 3000;
const PROBE_TIMEOUT_MS = 30000;

/* ── 参数归一（纯函数；布尔值视为「--flag 缺值」绝不静默转数字） ── */

function numberField(value, what, min, max, def, integer) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') throw new Error(`${what} 缺值（需要 ${min}~${max} 的${integer ? '整数' : '数字'}）`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${what} 非法（须为 ${min}~${max} 的${integer ? '整数' : '数字'}）：${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * cast 参数归一。durationSec 必填（一次性录屏没有默认时长）。
 * @param {{duration?:*, out?:*, everyNth?:*, quality?:*, maxWidth?:*, timeoutMs?:*, foreground?:boolean}} src
 * @returns {{durationSec:number, out:(string|null), everyNth:number, quality:number, maxWidth:number,
 *            timeoutMs:number, foreground:boolean}}
 */
function normalizeCastOptions(src) {
  const o = src || {};
  const durationSec = numberField(o.duration, '--duration', MIN_DURATION_SEC, MAX_DURATION_SEC, null);
  if (durationSec === null) {
    throw new Error(`cast 需要 --duration <秒>（一次性录屏必须给时长；${MIN_DURATION_SEC}~${MAX_DURATION_SEC}s，上限防误录爆盘）`);
  }
  if (o.out === true) throw new Error('--out 缺值（需要 .mp4 路径）');
  let out = null;
  if (o.out !== undefined && o.out !== null && o.out !== '') {
    out = String(o.out).trim();
    if (!out) throw new Error('--out 不能为空');
  }
  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    out,
    everyNth: numberField(o.everyNth, '--every-nth', EVERY_NTH_MIN, EVERY_NTH_MAX, DEFAULT_EVERY_NTH, true),
    quality: numberField(o.quality, '--quality', QUALITY_MIN, QUALITY_MAX, DEFAULT_QUALITY, true),
    maxWidth: numberField(o.maxWidth, '--max-width', MAX_WIDTH_MIN, MAX_WIDTH_MAX, DEFAULT_MAX_WIDTH, true),
    timeoutMs: numberField(o.timeoutMs, '--timeout', TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 5000, true),
    foreground: o.foreground !== false,
  };
}

/**
 * 产物路径计划（纯函数；selftest 直测）。--out 扩展名非 .mp4 → 改写并告警（取证优先：mp4 容器
 * 不谎报编码，同 screenshot planOutPath 的策略）。
 * @param {{out?:(string|null), stamp?:string, rootDir?:string, exists?:(p:string)=>boolean}} opts
 */
function planCastPaths(opts) {
  const o = opts || {};
  const rootDir = o.rootDir || paths.CAST_DIR;
  const stamp = o.stamp || time.formatStamp();
  const exists = typeof o.exists === 'function' ? o.exists : (p) => fs.existsSync(p);
  const notes = [];
  let out;
  if (o.out) {
    out = path.resolve(String(o.out));
    const ext = path.extname(out).toLowerCase();
    if (ext !== '.mp4') {
      const rewritten = ext ? out.slice(0, -ext.length) + '.mp4' : out + '.mp4';
      notes.push(`--out 扩展名 ${ext || '（无）'} 改写为 .mp4（mp4 容器不谎报编码）：${rewritten}`);
      out = rewritten;
    }
  } else {
    // 默认名按秒级时间戳；同秒重跑追加 -2/-3…（不覆盖既有证据）
    let base = path.join(rootDir, `cast-${stamp}`);
    let n = 2;
    while (exists(base + '.mp4') || exists(base + '.frames') || exists(base + '.json')) {
      base = path.join(rootDir, `cast-${stamp}-${n++}`);
    }
    out = base + '.mp4';
  }
  const stem = out.replace(/\.mp4$/i, '');
  return { out, frameDir: stem + '.frames', manifest: stem + '.json', notes };
}

/* ── fps 归一（GQ-001 核心纯函数；selftest 直测） ── */

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 帧流统计 + fps 归一。**绝不使用标称帧率**：fps = 实际帧数 / 首帧→末帧真实跨度。
 * 时间源优先级（严格顺序，混钟会失真）：
 *   ① metadata：全部帧 metadata.timestamp（CDP 秒，浏览器侧时间戳）——缺一帧即整体弃用；
 *   ② arrival：全部帧 tArrive（Node Date.now() 毫秒，接收时刻）；
 *   ③ elapsed：调用方给的录制墙钟（opts.elapsedMs，最后兜底）。
 * 帧数 <2 → ok:false / reason:'insufficient-frames'（无法合成）；跨度算不出 → reason:'no-span'。
 * fps 仅作护栏 clamp 到 [MIN, MAX]（正常时间戳不会触发；触发即时间戳异常，note 如实记录）。
 * @param {Array<{seq?:number, metaTs?:(number|null), tArrive?:number}>} frames
 * @param {{elapsedMs?:number}} [opts]
 */
function analyzeFrames(frames, opts) {
  const o = opts || {};
  const list = (frames || []).slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const n = list.length;
  const first = n ? list[0] : null;
  const last = n ? list[n - 1] : null;
  const elapsedMs = Number.isFinite(o.elapsedMs) && o.elapsedMs > 0
    ? o.elapsedMs
    : (first && last ? Math.max(0, (Number(last.tArrive) || 0) - (Number(first.tArrive) || 0)) : 0);
  const r = {
    frames: n,
    ok: false,
    reason: null,
    spanSec: 0,
    spanMs: 0,
    fps: null,
    fpsRaw: null,
    source: null,
    clamped: null,
    intervalsMs: { min: null, max: null, median: null, avg: null },
    elapsedMs: Math.round(elapsedMs),
    note: '',
  };
  if (n < 2) {
    r.reason = 'insufficient-frames';
    r.note = `仅 ${n} 帧（<2 无法合成视频）——Chrome 仅画面变化时推帧，静止页属正常；录制 ${(elapsedMs / 1000).toFixed(2)}s`;
    return r;
  }
  const metas = list.map((f) => f.metaTs);
  const arrivals = list.map((f) => f.tArrive);
  if (metas.every((v) => Number.isFinite(v)) && metas[n - 1] > metas[0]) {
    r.spanSec = metas[n - 1] - metas[0];
    r.source = 'metadata';
  } else if (arrivals.every((v) => Number.isFinite(v)) && arrivals[n - 1] > arrivals[0]) {
    r.spanSec = (arrivals[n - 1] - arrivals[0]) / 1000;
    r.source = 'arrival';
  } else if (elapsedMs > 0) {
    r.spanSec = elapsedMs / 1000;
    r.source = 'elapsed';
  }
  if (!(r.spanSec > 0)) {
    r.reason = 'no-span';
    r.note = '首末帧时间跨度无法计算（时间戳全空或相同）——拒绝用标称帧率凑数';
    return r;
  }
  r.spanMs = Math.round(r.spanSec * 1000);
  const raw = n / r.spanSec;
  r.fpsRaw = Math.round(raw * 1000) / 1000;
  const clamped = Math.min(FPS_MAX, Math.max(FPS_MIN, raw));
  r.fps = Math.round(clamped * 1000) / 1000;
  if (Math.abs(clamped - raw) > 1e-9) {
    r.clamped = { from: r.fpsRaw, to: r.fps, reason: raw > FPS_MAX ? `>${FPS_MAX}` : `<${FPS_MIN}` };
    r.note = `fps 计算值 ${r.fpsRaw} 越界，clamp 到 ${r.fps}（时间戳异常，如实标注）`;
  }
  // 帧间隔（同一时间源；稀帧量化证据——静止页 max 可达秒级）
  const clock = r.source === 'metadata' ? metas.map((v) => v * 1000) : list.map((f) => f.tArrive);
  const diffs = [];
  for (let i = 1; i < clock.length; i++) {
    if (Number.isFinite(clock[i]) && Number.isFinite(clock[i - 1])) diffs.push(clock[i] - clock[i - 1]);
  }
  if (diffs.length) {
    r.intervalsMs = {
      min: Math.round(Math.min(...diffs)),
      max: Math.round(Math.max(...diffs)),
      median: Math.round(median(diffs)),
      avg: Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length),
    };
  }
  r.ok = true;
  return r;
}

/** ffmpeg -framerate 数值串（1→'1'，0.333→'0.333'；FPS_MIN 保证不会出现 0） */
function formatRate(fps) {
  const s = Number(fps).toFixed(3);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** ffmpeg 合成参数（纯函数；selftest 断言参数契约）。
 *  ⚠ yuv420p/libx264 要求宽高均为偶数——屏幕视口可能奇数（2026-10-31 实弹：2880x1349 → exit 187
 *  "height not divisible by 2"），故显式 scale 到 trunc(iw/2)*2 × trunc(ih/2)*2（最多裁 1px，无感）。 */
function buildFfmpegArgs(plan, fps) {
  return [
    '-y', '-loglevel', 'error',
    '-framerate', formatRate(fps),
    '-i', path.join(plan.frameDir, '%06d.jpg'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p',
    plan.out,
  ];
}

function shellQuote(s) {
  const v = String(s);
  return /[\s"'$`\\]/.test(v) ? `'${v.replace(/'/g, `'\\''`)}'` : v;
}

/** 等价离线合成命令（ffmpeg 不可用时的留档指引；纯函数） */
function offlineCommand(bins, plan, fps) {
  return [bins.ffmpeg].concat(buildFfmpegArgs(plan, fps)).map(shellQuote).join(' ');
}

/**
 * mp4 合成（依赖可注入：available/bins/spawn——selftest 用 fake 覆盖，生产走 scroll-shot 单源）。
 * 失败恒返回 {ok:false, error, cmdline}（cmdline 供「帧已留档」离线合成指引），绝不抛错。
 */
function synthVideo(plan, analysis, deps) {
  const d = deps || {};
  const bins = typeof d.bins === 'function' ? d.bins() : (d.bins || scrollShot.ffmpegBins());
  const available = typeof d.available === 'function' ? !!d.available() : scrollShot.ffmpegAvailable();
  const args = buildFfmpegArgs(plan, analysis.fps);
  const cmdline = offlineCommand(bins, plan, analysis.fps);
  const res = { ok: false, available, bin: bins.ffmpeg, args, cmdline, bytes: 0, error: null, elapsedMs: 0 };
  if (!available) {
    res.reason = 'ffmpeg-unavailable';
    res.error = 'bin/ffmpeg 或 bin/ffprobe 不可用（ffmpegAvailable() 探活失败）';
    return res;
  }
  fs.mkdirSync(path.dirname(path.resolve(plan.out)), { recursive: true });
  const spawn = typeof d.spawn === 'function' ? d.spawn : spawnSync;
  const t0 = Date.now();
  let r = null;
  try {
    r = spawn(bins.ffmpeg, args, { encoding: 'utf8', timeout: SYNTH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    res.error = `ffmpeg 启动失败：${e.message}`;
    return res;
  }
  res.elapsedMs = Date.now() - t0;
  if (!r || r.error) {
    res.error = `ffmpeg 执行失败：${(r && r.error && r.error.message) || 'unknown'}`;
    return res;
  }
  if (r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-1)[0] || '无 stderr';
    res.error = `ffmpeg 合成失败（exit ${r.status}）：${tail.slice(0, 200)}`;
    return res;
  }
  if (!fs.existsSync(plan.out)) {
    res.error = `ffmpeg exit 0 但产物不存在：${plan.out}`;
    return res;
  }
  res.bytes = fs.statSync(plan.out).size;
  if (!(res.bytes > 0)) {
    res.error = `产物 0 字节：${plan.out}`;
    return res;
  }
  res.ok = true;
  return res;
}

/** mp4 媒体信息（ffprobe best-effort；失败/不可用 → null，不影响主结果） */
function probeMedia(file, deps) {
  const d = deps || {};
  const bins = typeof d.bins === 'function' ? d.bins() : (d.bins || scrollShot.ffmpegBins());
  const spawn = typeof d.spawn === 'function' ? d.spawn : spawnSync;
  try {
    if (!fs.existsSync(file)) return null;
    const r = spawn(bins.ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', file,
    ], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    if (!r || r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    const s = (j.streams || [])[0] || {};
    const dur = parseFloat(String((j.format || {}).duration));
    const nf = Number(s.nb_read_frames);
    return {
      durationSec: Number.isFinite(dur) ? Math.round(dur * 1000) / 1000 : null,
      frames: Number.isFinite(nf) ? nf : null,
      avgFrameRate: s.avg_frame_rate || null,
    };
  } catch { return null; }
}

/** 记录窗口等待：到时 / WS 断开 → 返回原因（'duration' | 'disconnect'） */
function waitWindow(client, ms) {
  return new Promise((resolve) => {
    let done = false;
    let offClose = null;
    let timer = null;
    const finish = (why) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (offClose) { try { offClose(); } catch { /* 尽力而为 */ } }
      resolve(why);
    };
    timer = setTimeout(() => finish('duration'), Math.max(1, Math.round(ms)));
    if (client && typeof client.onClose === 'function') {
      offClose = client.onClose(() => finish('disconnect'));
    }
  });
}

/**
 * 执行一次录屏（CLI 一次性命令的实现单源）。
 * deps 可注入：{plan, target, ensureForeground, available, bins, spawn, now}
 * @returns {Promise<{ok:boolean, manifest:object, manifestFile:string, analysis:object, synth:object, plan:object}>}
 */
async function runCast(client, sessionId, opts, deps) {
  const d = deps || {};
  const plan = d.plan || planCastPaths({ out: opts.out });
  const ensureFg = typeof d.ensureForeground === 'function' ? d.ensureForeground : scrollShot.ensureForeground;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const target = d.target || null;
  const notes = [];
  for (const n of plan.notes || []) notes.push(n);
  fs.mkdirSync(plan.frameDir, { recursive: true });

  const frames = [];
  let frameSeq = 0;
  let writeFailures = 0;
  const acks = { sent: 0, failed: 0 };
  let pageEnabled = false;
  let startError = null;
  let startSent = false;
  let stop = { ok: false, skipped: true, error: null };
  let foreground = null;

  const t0 = now();
  const recordStart = time.isoLocal();

  // ① 前台保障（复用 scroll-shot；hidden/读取失败才置前，失败 fail-soft）
  try {
    foreground = await ensureFg(client, sessionId, { timeoutMs: opts.timeoutMs, foreground: opts.foreground, tag: 'cast' });
  } catch (e) {
    foreground = { enabled: opts.foreground, error: e.message, note: `前台保障异常（fail-soft）：${e.message}` };
    notes.push(`前台保障异常（不中断录制）：${e.message}`);
  }
  if (foreground) {
    if (foreground.broughtToFront) {
      notes.push(`前台保障：目标页签原 ${foreground.beforeVisibility || '未知'} → 已 Page.bringToFront（复核 ${foreground.afterVisibility || '未知'}）；默认不自动还原前台`);
    } else if (foreground.beforeVisibility === 'hidden' || foreground.beforeVisibility === null) {
      notes.push(`前台保障未生效（${foreground.note || foreground.bringToFront || '未知'}）——后台页签 startScreencast 行为未知，可能不产帧/帧率异常`);
    }
  }

  // ② Page.enable（收 Page 域事件前提；失败仍尝试 startScreencast，如实记录）
  try {
    await client.send('Page.enable', {}, { sessionId, timeoutMs: opts.timeoutMs });
    pageEnabled = true;
  } catch (e) {
    notes.push(`Page.enable 失败（继续尝试 startScreencast）：${e.message}`);
  }

  // ③ 帧事件收集（立即写盘 + 立即 ack——不 ack 会结构性断流）
  const off = client.onEvent((ev) => {
    if (!ev || ev.sessionId !== sessionId || ev.method !== 'Page.screencastFrame') return;
    const p = ev.params || {};
    if (!p.data) return;
    const seq = ++frameSeq;
    const file = path.join(plan.frameDir, String(seq).padStart(6, '0') + '.jpg');
    let frameBytes = 0;
    try {
      const buf = Buffer.from(p.data, 'base64');
      frameBytes = buf.length;
      /* 产物配额准入（V202611030005 B3 N2）：单帧体积/总配额超限 → 跳过该帧并如实记写盘失败（不中断录制） */
      const q = require('./quota').check({ file, bytes: buf.length, cmd: 'cast' });
      if (!q.ok) {
        writeFailures++;
        notes.push(`${q.code}: ${q.message}`);
        log.warn('cast', `帧 ${seq} 被配额拒绝（不进入合成，fail-soft）：${q.message}`);
        return;
      }
      fs.writeFileSync(file, buf);
    } catch (e) {
      writeFailures++;
      log.warn('cast', `帧 ${seq} 写盘失败（不进入合成，fail-soft）：${e.message}`);
      return;
    }
    frames.push({
      seq,
      file,
      bytes: frameBytes,
      metaTs: p.metadata && Number.isFinite(Number(p.metadata.timestamp)) ? Number(p.metadata.timestamp) : null,
      tArrive: now(),
    });
    // B7 N6：作业进度（帧数；非作业进程回调不传，异常不得影响录制主链）
    try { if (deps && typeof deps.onProgress === 'function') deps.onProgress({ phase: 'frames', current: frames.length, total: null }); } catch { /* 进度旁路 */ }
    // ⚠ 参数 sessionId = 帧序列号（int），不是 flatten 会话 id；命令下发给 flatten 会话
    if (Number.isFinite(p.sessionId)) {
      client.send('Page.screencastFrameAck', { sessionId: p.sessionId }, { sessionId, timeoutMs: opts.timeoutMs })
        .then(() => { acks.sent++; })
        .catch(() => { acks.failed++; });
    }
  });

  // ④ startScreencast + 等待录制窗口（到时/断连；不因"暂无新帧"提前停——静止期不推帧是正常的）
  const startParams = { format: 'jpeg', quality: opts.quality, everyNthFrame: opts.everyNth };
  if (opts.maxWidth > 0) startParams.maxWidth = opts.maxWidth;
  let stopReason = null;
  try {
    startSent = true;
    await client.send('Page.startScreencast', startParams, { sessionId, timeoutMs: opts.timeoutMs });
    stopReason = await waitWindow(client, opts.durationSec * 1000);
  } catch (e) {
    startError = e.message;
    log.warn('cast', `Page.startScreencast 失败：${e.message}`);
  }
  const recordedMs = Math.max(0, now() - t0);

  // ⑤ finally 必停：先 stopScreencast（收尾帧仍可入 stream）→ 再摘事件监听
  if (startSent) {
    try {
      await client.send('Page.stopScreencast', {}, { sessionId, timeoutMs: STOP_TIMEOUT_MS });
      stop = { ok: true, skipped: false, error: null };
    } catch (e) {
      stop = { ok: false, skipped: false, error: e.message };
      notes.push(`Page.stopScreencast 失败（会话关闭时浏览器会兜底停止）：${e.message}`);
    }
  }
  try { off(); } catch { /* 尽力而为 */ }

  // ⑥ fps 归一 + 合成 + 清单
  const timedOut = stopReason === 'duration';
  if (stopReason === 'disconnect') notes.push('录制窗口内连接断开（提前收工）——已合成已收帧，timedOut=false');
  const analysis = analyzeFrames(frames, { elapsedMs: recordedMs });
  if (analysis.note) notes.push(analysis.note);
  if (analysis.intervalsMs && analysis.intervalsMs.max != null && analysis.intervalsMs.max >= 1000) {
    notes.push(`稀帧：最大帧间隔 ${analysis.intervalsMs.max}ms（Chrome 仅画面变化时推帧）——fps 已按首末帧真实跨度归一（${analysis.fps}），非标称帧率（GQ-001）`);
  }
  let synth = { ok: false, available: false, cmdline: null, error: null, bytes: 0, args: [], elapsedMs: 0 };
  if (analysis.ok) {
    /* 产物配额准入（B3 N2）：mp4 体积按帧总量上限估算，超限=E_QUOTA（帧已留档，抛给 CLI 失败收口） */
    const estBytes = Math.max(1, frames.reduce((n, f) => n + (f.bytes || 0), 0));
    const q = require('./quota').check({ file: plan.out, bytes: estBytes, cmd: 'cast' });
    if (!q.ok) {
      const e = new Error(q.message);
      e.code = q.code;
      throw e;
    }
    if (q.message) notes.push(q.message);
    synth = synthVideo(plan, analysis, d);
    if (!synth.available) {
      notes.push(`bin/ffmpeg 不可用：${frames.length} 帧已留档 ${plan.frameDir}——ffmpeg 可用后离线合成：${synth.cmdline}`);
    } else if (!synth.ok) {
      notes.push(`mp4 合成失败：${synth.error}；帧序列保留在 ${plan.frameDir}（可手工重跑：${synth.cmdline}）`);
    }
  } else {
    // 帧不足时也探一下可用性（清单如实标注环境，便于判断后续离线合成是否可行）
    try { synth.available = typeof d.available === 'function' ? !!d.available() : scrollShot.ffmpegAvailable(); } catch { /* fail-soft */ }
    if (!synth.available) notes.push('bin/ffmpeg 不可用（帧数也不足，本无 mp4 可合成）');
  }
  if (startError) notes.push(`Page.startScreencast 失败：${startError}`);
  if (writeFailures) notes.push(`帧写盘失败 ${writeFailures} 次（未计入帧数）`);
  if (acks.failed) notes.push(`帧 ack 失败 ${acks.failed} 次（可能断流）`);
  if (synth.ok && analysis.ok) {
    notes.push(`mp4 已生成：${plan.out}（${synth.bytes} B，fps=${analysis.fps} 按首末帧 ${analysis.spanMs}ms 跨度归一，source=${analysis.source}）`);
  }
  const ok = !startError && analysis.ok && synth.ok;
  const reason = startError ? 'start-failed' : (!analysis.ok ? analysis.reason : (!synth.ok ? (synth.reason || 'synth-failed') : null));

  const manifest = {
    format: FORMAT,
    at: time.isoLocal(),
    duration: opts.durationSec,          // 请求时长（秒）
    recordedMs,                          // 实际录制窗口（墙钟）
    frames: analysis.frames,
    fps: analysis.fps,                   // 归一 fps；帧不足/跨度未知 = null
    fpsRaw: analysis.fpsRaw,
    fpsSource: analysis.source,          // metadata | arrival | elapsed | null
    spanMs: analysis.spanMs,             // 首帧→末帧真实跨度
    intervalsMs: analysis.intervalsMs,   // 稀帧量化证据（min/max/median/avg）
    everyNth: opts.everyNth,
    quality: opts.quality,
    maxWidth: opts.maxWidth,
    out: synth.ok ? plan.out : null,     // 只有真的产出才报路径（未产出 = null，不谎报）
    outPlan: plan.out,                   // 计划路径（离线合成目标）
    bytes: synth.ok ? synth.bytes : 0,
    frameDir: plan.frameDir,             // 帧文件恒保留
    timedOut,                            // true = 时长到点正常收工；false = 断连/启动失败提前结束
    note: notes.join('；'),
    reason,
    target,
    foreground,
    pageEnabled,
    startError,
    stop,
    ack: acks,
    writeFailures,
    ffmpeg: {
      available: synth.available,
      cmdline: synth.cmdline,
      error: synth.error || null,
      elapsedMs: synth.elapsedMs || 0,
    },
    probe: synth.ok ? probeMedia(plan.out, d) : null,
  };

  fs.mkdirSync(path.dirname(path.resolve(plan.manifest)), { recursive: true });
  fs.writeFileSync(plan.manifest, JSON.stringify(manifest, null, 2) + '\n');
  log.info('cast', `录屏完成 ok=${ok} frames=${manifest.frames} fps=${manifest.fps} source=${manifest.fpsSource} timedOut=${timedOut} reason=${reason || '-'} out=${manifest.out || manifest.outPlan}`);
  return { ok, manifest, manifestFile: plan.manifest, analysis, synth, plan, recordStart };
}

/** stdout 摘要（纯函数；CLI 逐行打印——显式给出产物/帧目录路径） */
function formatCastReport(m) {
  if (!m) return ['[cast] ✗ 无结果'];
  const lines = [];
  const fps = m.fps == null ? '—' : m.fps;
  if (m.out) {
    const probe = m.probe
      ? `；ffprobe 时长 ${m.probe.durationSec == null ? '?' : m.probe.durationSec}s/${m.probe.frames == null ? '?' : m.probe.frames} 帧`
      : '';
    lines.push(`[cast] ✓ 帧 ${m.frames}｜fps ${fps}（首末跨度 ${m.spanMs}ms，${m.fpsSource}）｜mp4 ${m.out}（${m.bytes} B${probe}）`);
  } else {
    lines.push(`[cast] ✗ 未产出 mp4：帧 ${m.frames}｜fps ${fps}｜录制 ${(m.recordedMs / 1000).toFixed(2)}s｜原因 ${m.reason || '未知'}`);
  }
  lines.push(`[cast] 帧目录：${m.frameDir}（${m.frames} 帧${m.intervalsMs && m.intervalsMs.max != null ? `，帧间隔 min/median/max=${m.intervalsMs.min}/${m.intervalsMs.median}/${m.intervalsMs.max}ms` : ''}）`);
  if (!m.out && m.ffmpeg && m.ffmpeg.cmdline) lines.push(`[cast] 离线合成：${m.ffmpeg.cmdline}`);
  if (m.note) lines.push(`[cast] 注：${m.note}`);
  return lines;
}

module.exports = {
  FORMAT, MAX_DURATION_SEC, MIN_DURATION_SEC, DEFAULT_QUALITY, DEFAULT_EVERY_NTH, DEFAULT_MAX_WIDTH,
  FPS_MAX, FPS_MIN,
  // 纯函数（selftest 直接消费）
  normalizeCastOptions, planCastPaths, analyzeFrames, formatRate, buildFfmpegArgs, offlineCommand,
  median, formatCastReport,
  // CDP 动作 / 合成
  runCast, synthVideo, probeMedia, waitWindow,
};
