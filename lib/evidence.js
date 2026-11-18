'use strict';
/*
 * chromeuse lib/evidence.js —— 验收回放证据包（evidence-pack 子命令核心，V202609170003）
 *
 * 定位（TODO 条目「验收回放包产品化 v1」，ora-2 价值重定位）：chromeuse 最抗模型进化的价值不在
 * 「回放成功」而在「失败时也拿得出完整证据链」——本模块把一次验收的多段录制产物（事件流
 * chromeuse-events/1 + 录屏帧流 chromeuse-video/1）按绝对时间戳归一到统一时间轴，产出
 * 索引式证据包 timeline.json + README.md（chromeuse-evidence-pack/1）；段间中断（如午饭）
 * 显式标记，不静默拼接。cdp.js 的 evidence-pack 子命令只做 CLI 薄委托（同 events-summary →
 * lib/events.js 的分工惯例），核心逻辑单源在本文件供 selftest 直测纯函数。
 *
 * 输入格式（只读消费，不改动 record/screencast 落盘格式）：
 * - 事件流 tmpdata/events/recording-<stamp>.json：session.startedAt/stoppedAt（isoLocal 带
 *   时区偏移，new Date() 可解析——旧 Z 结尾串天然兼容）+ events[]（对照时刻 tRecv=Node 毫秒，
 *   旧流缺省回退 t）；
 * - 视频帧流 tmpdata/video/<session>/index.json（chromeuse-video/1，V202609130004 后 formatStamp
 *   命名同源）：frames[] 双时钟 tArrive（Node 毫秒，对照基准）/tMeta（CDP 秒，留档不用）+ file
 *   绝对路径（录制机视角）。
 *
 * v1 边界：索引式证据包——视频/事件流原文件原位引用，不复制不转码；损坏段如实登记
 * （timeline.damaged）不中断打包（失败时也要拿得出完整证据链）；关键帧只引用最近帧路径
 * （显著事件 = click/dblclick/uiAppear/navigate，与 tools/cdp.js diff-video DIFF_TYPES 同口径），
 * 单段全量对照走 diff-video。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');

const FORMAT = 'chromeuse-evidence-pack/1';
const KEYFRAME_TYPES = ['click', 'dblclick', 'uiAppear', 'navigate']; // 与 tools/cdp.js DIFF_TYPES 同口径
const KEYFRAME_CAP = 20;            // 每段关键帧上限（长段不膨胀，全量对照走 diff-video）
const GAP_DEFAULT_MS = 300 * 1000;  // 段间中断默认阈值 300s（CLI --gap-seconds 可参）

/** ISO 串（带时区偏移或旧 Z 结尾）→ epoch ms；解析失败返回 null */
function parseEpochMs(iso) {
  const t = new Date(String(iso || '')).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 事件对照时刻：tRecv（Node 接收毫秒，与帧 tArrive 同钟）优先；旧流缺省回退 t */
function evtMs(e) {
  return Number.isFinite(e.tRecv) ? e.tRecv : e.t;
}

/** 帧数组（tArrive 升序）中取 t 前后最近帧（同 tools/cdp.js diff-video nearestFrames 口径） */
function nearestFrames(frames, t) {
  let before = null, after = null;
  for (const f of frames) {
    if ((f.tArrive || 0) <= t) before = f;
    else { after = f; break; }
  }
  return {
    before: before ? { file: before.file, dtMs: t - before.tArrive } : null,
    after: after ? { file: after.file, dtMs: after.tArrive - t } : null,
  };
}

/** 位置参数 → 事件流文件绝对路径列表（去重 + 排序；无发现返回空数组由 CLI 判空）。
 *  支持：recording-*.json 文件；普通目录（非递归扫描目录下 recording-*.json——父目录自动发现）；
 *  录屏会话目录（含 chromeuse-video/1 index.json → 按 session.id 反查
 *  tmpdata/events/recording-<stamp>.json，rec-/recording- 前缀差异按 V202609130004 命名约定换算）。
 *  输入不存在/文件名不符/反查落空 → 抛错（CLI die 响亮失败，不静默跳过）。 */
function discoverRecordings(inputs, opts) {
  const eventsDir = (opts && opts.eventsDir) || paths.EVENTS_DIR;
  const found = new Set();
  for (const raw of inputs || []) {
    const p = path.resolve(String(raw));
    let st = null;
    try { st = fs.statSync(p); } catch { throw new Error(`输入不存在：${raw}`); }
    if (st.isFile()) {
      if (path.basename(p).startsWith('recording-') && p.endsWith('.json')) found.add(p);
      else throw new Error(`非 recording-*.json 事件流文件：${raw}`);
      continue;
    }
    // 目录：录屏会话目录（含 index.json）反查事件流；否则当父目录自动发现
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(path.join(p, 'index.json'), 'utf8')); } catch { idx = null; }
    if (idx && idx.session) {
      const guess = path.join(eventsDir, 'recording-' + String(idx.session).replace(/^rec-/, '') + '.json');
      if (fs.existsSync(guess)) { found.add(guess); continue; }
      throw new Error(`录屏会话目录 ${raw}（session=${idx.session}）未在 ${eventsDir} 反查到对应事件流（recording-<stamp>.json）`);
    }
    let hit = false;
    for (const f of fs.readdirSync(p).sort()) {
      if (f.startsWith('recording-') && f.endsWith('.json')) { found.add(path.join(p, f)); hit = true; }
    }
    if (!hit) throw new Error(`目录 ${raw} 内未发现 recording-*.json（非递归扫描）`);
  }
  return [...found].sort();
}

/** 读单段录制产物 → 段对象；结构性损坏抛错（上层收进 damaged 如实登记，不中断打包）。 */
function loadSeg(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || doc.format !== 'chromeuse-events/1' || !doc.session) {
    throw new Error('非 chromeuse-events/1 事件流或缺 session 头');
  }
  const startMs = parseEpochMs(doc.session.startedAt);
  if (startMs === null) throw new Error('session.startedAt 无法解析为时刻（跨段归一唯一基准缺失）');
  const stopMs = parseEpochMs(doc.session.stoppedAt); // 缺失可容忍：无 stoppedAt 的段不参与 gap 判定（如实跳过）
  const sessionId = String(doc.session.id || path.basename(file, '.json'));
  // 视频帧流定位：落盘头 session.video.dir（-v 录制时存在）优先；缺省按 session.id 约定路径兜底
  const videoDir = (doc.session.video && doc.session.video.dir) || path.join(paths.VIDEO_DIR, sessionId);
  const indexFile = path.join(videoDir, 'index.json');
  let video = { available: false, dir: videoDir, indexFile, frames: 0, index: null, note: '' };
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (idx && Array.isArray(idx.frames) && idx.frames.length) {
      video = { available: true, dir: videoDir, indexFile, frames: idx.frames.length, index: idx, note: '' };
    } else {
      video.note = 'index.json 存在但无有效 frames 数组';
    }
  } catch {
    video.note = 'index.json 缺失或不可读（该段录制未带 -v，或录屏产物不在本机）';
  }
  return { file: path.resolve(file), doc, sessionId, startMs, stopMs, video };
}

/** 段内事件统计：总数 / 类型分布 / 首末事件时刻（epoch ms；空段为 null） */
function segStats(seg) {
  const byType = {};
  let first = null, last = null;
  for (const e of seg.doc.events || []) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    const t = evtMs(e);
    if (Number.isFinite(t)) {
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
  }
  return { count: (seg.doc.events || []).length, byType, firstMs: first, lastMs: last };
}

/** 段内关键帧：显著事件（KEYFRAME_TYPES）× 该事件 tab 帧池的最近前后帧（路径引用非拷贝；
 *  上限 KEYFRAME_CAP；该 tab 无帧如实标注 note，不脑补）。tOffsetMs 相对本段起点。 */
function segKeyframes(seg) {
  if (!seg.video.available) return [];
  const pools = new Map(); // tab → 帧数组（按 tArrive 升序）
  for (const f of seg.video.index.frames) {
    const a = pools.get(f.tab) || [];
    a.push(f);
    pools.set(f.tab, a);
  }
  for (const a of pools.values()) a.sort((x, y) => (x.tArrive || 0) - (y.tArrive || 0));
  const out = [];
  for (const e of seg.doc.events || []) {
    if (!KEYFRAME_TYPES.includes(e.type)) continue;
    if (out.length >= KEYFRAME_CAP) break;
    const t = evtMs(e);
    if (!Number.isFinite(t)) continue;
    const frames = pools.get(e.tab) || [];
    const nf = frames.length ? nearestFrames(frames, t) : { before: null, after: null };
    out.push({
      seq: e.seq, type: e.type,
      tOffsetMs: t - seg.startMs,
      tab: e.tab || '?',
      tRef: Number.isFinite(e.tRecv) ? 'tRecv' : 't', // 对照时刻来源如实标注（旧流回退 t）
      before: nf.before, after: nf.after,
      note: frames.length ? undefined : '该 tab 无录屏帧',
    });
  }
  return out;
}

/** 统一时间轴组装：段按 startedAt 升序；零点 = 最早段 startedAt；段间 gap 按阈值标中断、
 *  负间隔（会话交叠）如实标 overlap——两类都不静默。 */
function buildTimeline(segs, opts) {
  const gapMs = Number.isFinite(opts && opts.gapMs) ? opts.gapMs : GAP_DEFAULT_MS;
  const ordered = segs.slice().sort((a, b) => (a.startMs - b.startMs) || String(a.file).localeCompare(String(b.file)));
  const originMs = ordered.length ? ordered[0].startMs : null;
  const segments = ordered.map((seg, i) => {
    const stats = segStats(seg);
    return {
      seg: i + 1,
      sessionId: seg.sessionId,
      recordingFile: seg.file,
      startedAt: { local: time.isoLocal(new Date(seg.startMs)), epochMs: seg.startMs, offsetMs: seg.startMs - originMs },
      stoppedAt: seg.stopMs !== null ? { local: time.isoLocal(new Date(seg.stopMs)), epochMs: seg.stopMs, offsetMs: seg.stopMs - originMs } : null,
      durationMs: seg.stopMs !== null ? seg.stopMs - seg.startMs : null,
      counts: { events: stats.count, byType: stats.byType, frames: seg.video.frames },
      eventsSpan: stats.firstMs !== null ? { firstOffsetMs: stats.firstMs - originMs, lastOffsetMs: stats.lastMs - originMs } : null,
      video: { available: seg.video.available, dir: seg.video.dir, indexFile: seg.video.indexFile, note: seg.video.note || undefined },
      keyframes: segKeyframes(seg),
      // 落盘头可信度标记如实透传（injectLost=采集确认失效 / wsDown=WS 断开退场——取证时先看这两位）
      flags: { injectLost: seg.doc.session.injectLost === true || undefined, wsDown: seg.doc.session.wsDown === true || undefined },
    };
  });
  const gaps = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    if (prev.stopMs === null) continue; // 前段无停止时刻无从判 gap（如实跳过）
    const d = cur.startMs - prev.stopMs;
    if (d > gapMs) gaps.push({ beforeSeg: i, afterSeg: i + 1, gapMs: d, kind: 'interruption', note: '段间中断（间隔超阈值——如午饭/会议；统一时间轴在此断点，不静默拼接）' });
    else if (d < 0) gaps.push({ beforeSeg: i, afterSeg: i + 1, gapMs: d, kind: 'overlap', note: '段间时间交叠（录制会话重叠，如实标注）' });
  }
  return { ordered, originMs, gapMs, segments, gaps };
}

/* ── README 渲染 helper ── */
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms === null) return '—';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}
function fmtOffset(ms) {
  if (!Number.isFinite(ms) || ms === null) return '—';
  return 't+' + (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : fmtDur(ms));
}
const base = (p) => (p ? path.basename(p) : '—');

/** README.md 渲染（证据包说明：段清单/时间轴/中断/文件索引/生成命令与环境——取证自足性） */
function renderReadme(tl) {
  const L = [];
  L.push('# chromeuse 验收回放证据包');
  L.push('');
  if (tl.title) { L.push(`**${tl.title}**`); L.push(''); }
  L.push(`- 生成时刻：${tl.generatedAt}`);
  L.push(`- 生成命令：\`node tools/cdp.js ${tl.generator.command}\``);
  const off = tl.generator.tzOffsetMinutes;
  L.push(`- 环境：Node ${tl.generator.node}｜skill 根 \`${tl.generator.skillRoot}\`｜时区偏移 UTC${off >= 0 ? '+' : ''}${off / 60}（CHROMEUSE_TZ_OFFSET）`);
  L.push(`- 时间轴零点：${tl.origin.local}（epoch ms ${tl.origin.epochMs}）——${tl.origin.note}`);
  L.push(`- 段间中断阈值：${tl.gapThresholdMs / 1000}s（--gap-seconds 可调）`);
  L.push('');
  L.push('## 段清单');
  L.push('');
  L.push('| # | 会话 | 开始（本地） | 时长 | 事件数 | 帧数 | 相对偏移 | 备注 |');
  L.push('|---|------|------------|------|--------|------|----------|------|');
  for (const s of tl.segments) {
    const notes = [s.flags.injectLost ? '⚠injectLost' : '', s.flags.wsDown ? '⚠wsDown' : '', s.video.available ? '' : '无录屏帧'].filter(Boolean).join('、');
    L.push(`| ${s.seg} | ${s.sessionId} | ${s.startedAt.local} | ${fmtDur(s.durationMs)} | ${s.counts.events} | ${s.counts.frames} | ${fmtOffset(s.startedAt.offsetMs)} | ${notes || '—'} |`);
  }
  L.push('');
  L.push('## 段间中断与交叠');
  L.push('');
  if (!tl.gaps.length) L.push('无（相邻段间隔均在阈值内且无时间交叠）。');
  for (const g of tl.gaps) {
    const span = g.gapMs < 0 ? `交叠 ${fmtDur(-g.gapMs)}` : `间隔 ${fmtDur(g.gapMs)}`;
    L.push(`- 段 ${g.beforeSeg} → 段 ${g.afterSeg}：${span}（${g.kind}）——${g.note}`);
  }
  L.push('');
  L.push('## 文件索引（原位引用——索引式证据包，不复制大文件）');
  L.push('');
  for (const s of tl.segments) {
    L.push(`- 段 ${s.seg}（${s.sessionId}）`);
    L.push(`  - 事件流：\`${s.recordingFile}\`（${s.counts.events} 事件，chromeuse-events/1）`);
    if (s.video.available) {
      L.push(`  - 视频 index：\`${s.video.indexFile}\`（${s.counts.frames} 帧，chromeuse-video/1）`);
      L.push(`  - 帧目录：\`${s.video.dir}${path.sep}frames${path.sep}\``);
    } else {
      L.push(`  - 视频：不可用（${s.video.note || '无帧'}）`);
    }
  }
  for (const d of tl.damaged) L.push(`- ⚠ 损坏段（如实登记，未入时间轴）：\`${d.file}\`——${d.error}`);
  L.push('');
  L.push(`## 关键帧（显著事件 ${KEYFRAME_TYPES.join('/')} × 前后最近帧；每段上限 ${KEYFRAME_CAP}，全量对照走 diff-video）`);
  L.push('');
  for (const s of tl.segments) {
    L.push(`- 段 ${s.seg}（${s.sessionId}）：${s.keyframes.length} 条`);
    for (const k of s.keyframes) {
      const pos = k.note ? k.note
        : `前帧 ${k.before ? `${base(k.before.file)}（Δt ${k.before.dtMs}ms 前）` : '无'}｜后帧 ${k.after ? `${base(k.after.file)}（Δt ${k.after.dtMs}ms 后）` : '无'}`;
      L.push(`  - #${k.seq} ${k.type} ${fmtOffset(k.tOffsetMs)} tab=${k.tab}（tRef=${k.tRef}）→ ${pos}`);
    }
  }
  L.push('');
  L.push('## 对齐基准与边界（取证自足性声明）');
  L.push('');
  L.push('- 段起止基准：事件流 session.startedAt/stoppedAt（ISO 带时区偏移；旧 Z 结尾串经 new Date() 解析天然兼容）——绝对时刻，跨段归一唯一基准。');
  L.push('- 事件↔帧对照基准：事件 tRecv（Node 接收毫秒）↔ 帧 tArrive（同钟）；旧流缺 tRecv 回退 t（条目 tRef 如实标注）；帧 tMeta=CDP 秒钟留档不用于对照。');
  L.push('- 统一时间轴：timeline.json 各段 startedAt/stoppedAt.offsetMs 相对零点（最早段 startedAt）；段内关键帧 tOffsetMs 相对本段起点。');
  L.push('- v1 边界：索引式证据包（timeline.json + README.md + 原文件引用），不复制/不转码视频；损坏段登记 timeline.damaged 不中断打包；关键帧为路径引用非拷贝。');
  L.push('- 后续分析：单段事件×帧全量对照 `node tools/cdp.js diff-video <recording>.json`；疑点帧交 observer ≤25 帧/批。');
  L.push('');
  return L.join('\n');
}

/** 打包（纯组装不写盘；写盘归 CLI）：files → { timeline, readme }。
 *  损坏段收进 timeline.damaged 继续打包；全部损坏才抛错（空包无证据价值，响亮失败）。 */
function buildPack(files, opts) {
  opts = opts || {};
  const segs = [], damaged = [];
  for (const f of files || []) {
    try { segs.push(loadSeg(f)); }
    catch (e) { damaged.push({ file: path.resolve(String(f)), error: String(e.message) }); }
  }
  if (!segs.length) throw new Error('无可用录制段（全部损坏或为空）——证据包无从建立');
  const built = buildTimeline(segs, opts);
  const timeline = {
    format: FORMAT,
    generatedAt: time.isoLocal(),
    generator: {
      command: opts.command || '',
      node: process.version,
      skillRoot: paths.SKILL_ROOT,
      tzOffsetMinutes: time.tzOffset(),
      boundary: 'v1 索引式证据包：视频/事件流原位引用，不复制不转码',
    },
    title: opts.title ? String(opts.title) : '',
    origin: { epochMs: built.originMs, local: time.isoLocal(new Date(built.originMs)), note: '时间轴零点 = 最早段 startedAt；各段 offsetMs 相对零点' },
    gapThresholdMs: built.gapMs,
    segments: built.segments,
    gaps: built.gaps,
    damaged,
  };
  return { timeline, readme: renderReadme(timeline) };
}

module.exports = { FORMAT, KEYFRAME_TYPES, KEYFRAME_CAP, GAP_DEFAULT_MS, parseEpochMs, evtMs, nearestFrames, discoverRecordings, loadSeg, buildTimeline, buildPack, fmtDur, fmtOffset };
