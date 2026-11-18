'use strict';
/*
 * chromeuse lib/quota.js —— 产物配额 / 保留期 / 淘汰 / pin（V202611030005 B3 N2）
 *
 * 目标：治「产物零治理无界增长」。三件套：
 *   artifacts report  按类别列文件数/占用/最旧 + 覆盖全部登记目录（断言：每个登记目录都出现）
 *   artifacts prune   按保留期清理 + 超总配额按固定序淘汰；默认 dry-run，--apply 才删
 *   artifacts pin     证据类永不自动删清单（tmpdata/artifacts-pinned.json）
 * 准入：五落盘入口（scroll-shot/cast/screenshot/record events/video 预检）调用 check() 做落盘前总配额检查；
 *       超单产物上限或总配额 → {ok:false, code:'E_QUOTA'}（调用方按信封失败收口）。
 *
 * 安全设计（防误删三层）：①白名单路径制——只处理 paths.js 登记目录内、且分类=可清理类别的文件；
 *   绝不「扫全 tmpdata 按 mtime 删」（未登记=other 永不自动删，含 test-runs/ 用户补投材料）；
 *   ②证据类（fail-report/evidence/audit）只按 30 天到期清理，不参与配额淘汰；
 *   ③prune 默认 dry-run；--apply 仍需 >500 文件或 >1GB 时显式 --yes（防分类 bug 一次性毁尸）。
 *
 * 分类表（v2 裁决；新增目录必须同批登记，否则按未登记=other 永不删）：
 *   video       3 天   淘汰序 1（视频/录屏帧流/cast）
 *   screenshot  7 天   淘汰序 2（截图/长图/a11y-baseline/flow-checkpoints）
 *   download    7 天   淘汰序 2
 *   log         7 天   淘汰序 3（最后淘汰）
 *   record      30 天  不参与淘汰（录屏事件流；重产物但属用户取证原料）
 *   evidence    30 天  不参与淘汰（evidence/forensics/replay-verdict/videodiff/net/console）
 *   fail-report 30 天  不参与淘汰（flow-fail）
 *   audit       30 天  不参与淘汰（结构化审计；与 prune 同一入口清理）
 *   other       永不自动删（未登记目录/散文件/locks；test-runs/ 已拍板归此）
 * 预登记后续批目录：refs→other、jobs→other（B7 实装终态清理）、a11y-baseline→7 天、flow-checkpoints→7 天、
 *   browser→other（批C1 launch state，V20261117007）。
 *
 * 配额口径：总配额只统计 counted 类别（video/screenshot/download/log/record/evidence/fail-report/audit）；
 *   other/locks 不计入（否则用户补投材料会把业务产物挤爆）。体积=regular file stat size 合计，不跟随符号链接。
 */
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const time = require('./time');

const MB = 1024 * 1024;
const DAY_MS = 86400000;

const DEFAULTS = {
  totalMB: 2048,
  maxArtifactMB: 64,
  autoEvict: false,
  retentionDays: { video: 3, screenshot: 7, download: 7, log: 7, record: 30, evidence: 30, 'fail-report': 30, audit: 30 },
};

/** 类别基表（retentionDays 可被 config.quota.retentionDays 覆盖；evictOrder=配额淘汰序，null=不参与淘汰） */
const BASE_CATEGORIES = [
  { id: 'video', label: 'video（录屏/帧流/cast）', retentionDays: 3, evictOrder: 1, counted: true, admitted: true },
  { id: 'screenshot', label: 'screenshot（截图/长图）', retentionDays: 7, evictOrder: 2, counted: true, admitted: true },
  { id: 'download', label: 'download（下载）', retentionDays: 7, evictOrder: 2, counted: true, admitted: true },
  { id: 'log', label: 'log（统一日志）', retentionDays: 7, evictOrder: 3, counted: true, admitted: false },
  { id: 'record', label: 'record（录屏事件流）', retentionDays: 30, evictOrder: null, counted: true, admitted: true },
  { id: 'evidence', label: 'evidence（取证类）', retentionDays: 30, evictOrder: null, counted: true, admitted: false },
  { id: 'fail-report', label: 'fail-report（flow 失败报告）', retentionDays: 30, evictOrder: null, counted: true, admitted: false },
  { id: 'audit', label: 'audit（结构化审计）', retentionDays: 30, evictOrder: null, counted: true, admitted: false },
  { id: 'other', label: 'other（不自动删）', retentionDays: null, evictOrder: null, counted: false, admitted: false },
];

/** 配置解析（override 供 selftest 注入；默认读 config.jsonc，缺失/坏 → 内置默认） */
function resolveConfig(override) {
  let raw = null;
  if (override && typeof override === 'object') raw = override;
  else {
    try { const cfg = require('./config').loadConfig(); raw = (cfg && cfg.quota) || {}; } catch { raw = {}; }
  }
  const q = raw || {};
  const retention = Object.assign({}, DEFAULTS.retentionDays, (q.retentionDays && typeof q.retentionDays === 'object') ? q.retentionDays : {});
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    totalMB: num(q.totalMB, DEFAULTS.totalMB),
    totalBytes: num(q.totalMB, DEFAULTS.totalMB) * MB,
    maxArtifactMB: num(q.maxArtifactMB, DEFAULTS.maxArtifactMB),
    maxArtifactBytes: num(q.maxArtifactMB, DEFAULTS.maxArtifactMB) * MB,
    autoEvict: q.autoEvict === true,
    retentionDays: retention,
  };
}

/** 类别表（retention 按配置覆盖） */
function categories(cfg) {
  const c = cfg || resolveConfig();
  return BASE_CATEGORIES.map((x) => Object.assign({}, x, {
    retentionDays: x.retentionDays == null ? null : (Number.isFinite(Number(c.retentionDays[x.id])) ? Number(c.retentionDays[x.id]) : x.retentionDays),
  }));
}

function categoryById(id, cfg) { return categories(cfg).find((c) => c.id === id) || null; }

/**
 * 登记目录表（report 覆盖断言准源；root/logDir 可注入供 selftest）。
 * category='mixed' = 按文件分类（events/）；locks 不进入配额/清理面。
 */
function registry(root, logDir) {
  const R = root || paths.TMPDATA_DIR;
  const L = logDir || paths.LOG_DIR;
  return [
    { key: 'video', dir: path.join(R, 'video'), category: 'video' },
    { key: 'cast', dir: path.join(R, 'cast'), category: 'video' },
    { key: 'scroll-shot', dir: path.join(R, 'scroll-shot'), category: 'screenshot' },
    { key: 'downloads', dir: path.join(R, 'downloads'), category: 'download' },
    { key: 'a11y-baseline', dir: path.join(R, 'a11y-baseline'), category: 'screenshot' },
    { key: 'flow-checkpoints', dir: path.join(R, 'flow-checkpoints'), category: 'screenshot' },
    { key: 'log', dir: L, category: 'log' },
    { key: 'events', dir: path.join(R, 'events'), category: 'mixed' },
    { key: 'flow-fail', dir: path.join(R, 'flow-fail'), category: 'fail-report' },
    { key: 'evidence', dir: path.join(R, 'evidence'), category: 'evidence' },
    { key: 'cdp-forensics', dir: path.join(R, 'cdp-forensics'), category: 'evidence' },
    { key: 'replay-verdict', dir: path.join(R, 'replay-verdict'), category: 'evidence' },
    { key: 'videodiff', dir: path.join(R, 'videodiff'), category: 'evidence' },
    { key: 'audit', dir: path.join(R, 'audit'), category: 'audit' },
    { key: 'refs', dir: path.join(R, 'refs'), category: 'other' },
    { key: 'jobs', dir: path.join(R, 'jobs'), category: 'other' },
    { key: 'locks', dir: path.join(R, 'locks'), category: 'other' },
    { key: 'browser', dir: path.join(R, 'browser'), category: 'other' },
  ];
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 事件目录按文件名细分（mixed 目录的唯一分类器） */
function classifyEventsFile(name) {
  if (/^screenshot-/i.test(name)) return 'screenshot';
  if (/^locator-.*\.(png|jpe?g)$/i.test(name)) return 'screenshot';
  if (/^recording-.*\.json$/i.test(name)) return 'record';
  if (/^locate-materials-.*\.jsonl$/i.test(name)) return 'record';
  if (/^net-.*\.json$/i.test(name)) return 'evidence';
  if (/^console-.*\.json$/i.test(name)) return 'evidence';
  return 'other';
}

/**
 * 单文件分类（绝对路径 → 类别对象 + 登记目录 key）；不在登记面（tmpdata/log 之外）→ null（unmanaged）。
 * 白名单制：只有这里认识的路径才可被 prune 删除。
 */
function classifyFile(absPath, root, logDir) {
  const abs = path.resolve(String(absPath));
  const R = root || paths.TMPDATA_DIR;
  const L = logDir || paths.LOG_DIR;
  /* .gitkeep 永不自动删（占位文件，删了目录会消失）；log 目录只把 *.log 归 log 类 */
  if (path.basename(abs) === '.gitkeep') return { id: 'other', dirKey: '(gitkeep)' };
  if (isInside(L, abs)) {
    if (!/\.log$/i.test(path.basename(abs))) return { id: 'other', dirKey: 'log' };
    return { id: 'log', dirKey: 'log' };
  }
  if (!isInside(R, abs)) return null;
  const rel = path.relative(R, abs);
  if (!rel) return { id: 'other', dirKey: '(root)' };
  const seg = rel.split(path.sep);
  const top = seg[0];
  if (top === 'video') return { id: 'video', dirKey: 'video' };
  if (top === 'cast') return { id: 'video', dirKey: 'cast' };
  if (top === 'scroll-shot') return { id: 'screenshot', dirKey: 'scroll-shot' };
  if (top === 'downloads') return { id: 'download', dirKey: 'downloads' };
  if (top === 'a11y-baseline') return { id: 'screenshot', dirKey: 'a11y-baseline' };
  if (top === 'flow-checkpoints') return { id: 'screenshot', dirKey: 'flow-checkpoints' };
  if (top === 'events' && seg.length === 2) return { id: classifyEventsFile(seg[1]), dirKey: 'events' };
  if (top === 'flow-fail') return { id: 'fail-report', dirKey: 'flow-fail' };
  if (top === 'evidence') return { id: 'evidence', dirKey: 'evidence' };
  if (top === 'cdp-forensics') return { id: 'evidence', dirKey: 'cdp-forensics' };
  if (top === 'replay-verdict') return { id: 'evidence', dirKey: 'replay-verdict' };
  if (top === 'videodiff') return { id: 'evidence', dirKey: 'videodiff' };
  if (top === 'audit') return { id: 'audit', dirKey: 'audit' };
  if (top === 'refs') return { id: 'other', dirKey: 'refs' };
  if (top === 'jobs') return { id: 'other', dirKey: 'jobs' };
  if (top === 'locks') return { id: 'other', dirKey: 'locks' };
  if (top === 'browser') return { id: 'other', dirKey: 'browser' };
  return { id: 'other', dirKey: '(unregistered)' };
}

/** 递归扫描 regular files（不跟随符号链接；失败 fail-soft 返回已收集部分） */
function scanDir(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir);
  return out;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * MB) return `${(b / (1024 * MB)).toFixed(2)} GB`;
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function roundMB(bytes) { return Math.round((Number(bytes) || 0) / MB * 10) / 10; }

function oldestOf(files) {
  let m = null;
  for (const f of files) if (m == null || f.mtimeMs < m) m = f.mtimeMs;
  return m;
}

/* ── pin 清单 ── */
function pinFile(root) { return path.join(root || paths.TMPDATA_DIR, 'artifacts-pinned.json'); }

/** 读取 pin（绝对路径数组；相对项按 root 解析） */
function loadPins(opts) {
  const o = typeof opts === 'string' ? { root: opts } : (opts || {});
  const root = o.root || paths.TMPDATA_DIR;
  try {
    const j = JSON.parse(fs.readFileSync(pinFile(root), 'utf8'));
    if (!Array.isArray(j.paths)) return [];
    return [...new Set(j.paths.map((p) => path.resolve(root, String(p))).filter(Boolean))];
  } catch { return []; }
}

function savePins(list, opts) {
  const o = typeof opts === 'string' ? { root: opts } : (opts || {});
  const root = o.root || paths.TMPDATA_DIR;
  const rel = [...new Set((list || []).map((p) => {
    const abs = path.resolve(String(p));
    return isInside(root, abs) ? paths.toPosixRel(root, abs) : abs;
  }))];
  const body = { format: 'chromeuse-artifacts-pins/1', updatedAt: time.isoLocal(), paths: rel };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pinFile(root), JSON.stringify(body, null, 2) + '\n');
  return body;
}

/** pin 增/删/列（--list / --remove） */
function pin(opts) {
  const o = opts || {};
  const root = o.root || paths.TMPDATA_DIR;
  const current = loadPins({ root });
  if (o.list) return { root, file: pinFile(root), paths: current, removed: 0, added: 0 };
  const normalize = (arr) => (arr || []).filter(Boolean).map((p) => path.resolve(String(p)));
  const add = normalize(o.add);
  const remove = new Set(normalize(o.remove));
  let next = current.filter((p) => !remove.has(p));
  let added = 0;
  for (const p of add) { if (!next.includes(p)) { next.push(p); added++; } }
  savePins(next, { root });
  return { root, file: pinFile(root), paths: next, added, removed: current.length - (next.length - added) };
}

/* ── report ── */
function emptyCat(cat) {
  return {
    id: cat.id, label: cat.label, retentionDays: cat.retentionDays, evictOrder: cat.evictOrder,
    counted: cat.counted, admitted: cat.admitted, files: 0, bytes: 0, oldestMs: null,
    expiredFiles: 0, expiredBytes: 0,
  };
}

/**
 * 全量报告：按类别 + 按登记目录（覆盖断言：每个登记目录都出现在 dirs[]，含 0 文件）。
 * @param {{root?:string, logDir?:string, now?:number, config?:object}} [opts]
 */
function report(opts) {
  const o = opts || {};
  const root = o.root || paths.TMPDATA_DIR;
  const logDir = o.logDir || paths.LOG_DIR;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const cfg = resolveConfig(o.config);
  const cats = categories(cfg);
  const catMap = {};
  for (const c of cats) catMap[c.id] = emptyCat(c);
  const reg = registry(root, logDir);
  const dirs = [];
  const seen = new Set();

  const addFile = (f) => {
    const cls = classifyFile(f.path, root, logDir);
    if (!cls || !catMap[cls.id]) return;
    const c = catMap[cls.id];
    c.files++;
    c.bytes += f.size;
    if (c.oldestMs == null || f.mtimeMs < c.oldestMs) c.oldestMs = f.mtimeMs;
    const cat = catMap[cls.id];
    if (cat.retentionDays != null && now - f.mtimeMs > cat.retentionDays * DAY_MS) {
      c.expiredFiles++;
      c.expiredBytes += f.size;
    }
  };

  for (const d of reg) {
    const files = scanDir(d.dir);
    for (const f of files) { seen.add(f.path); addFile(f); }
    dirs.push({
      key: d.key, dir: d.dir, category: d.category, exists: fs.existsSync(d.dir),
      files: files.length, bytes: files.reduce((n, f) => n + f.size, 0),
      oldestMs: oldestOf(files),
    });
  }

  // 未登记：tmpdata 根散文件 + 未登记目录（全部归 other，永不自动删；report 仍要看见）
  const extra = [];
  const regNames = new Set(reg.map((d) => path.basename(d.dir)));
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (regNames.has(e.name)) continue;
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const files = scanDir(abs);
      for (const f of files) addFile(f);
      extra.push({ name: e.name, type: 'dir', files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), oldestMs: oldestOf(files) });
    } else if (st.isFile()) {
      addFile({ path: abs, size: st.size, mtimeMs: st.mtimeMs });
      extra.push({ name: e.name, type: 'file', files: 1, bytes: st.size, oldestMs: st.mtimeMs });
    }
  }

  const categoriesArr = cats.map((c) => catMap[c.id]);
  const usedBytes = categoriesArr.filter((c) => c.counted).reduce((n, c) => n + c.bytes, 0);
  const totalFiles = categoriesArr.reduce((n, c) => n + c.files, 0);
  const pinned = loadPins({ root });
  return {
    format: 'chromeuse-artifacts/1',
    at: time.isoLocal(),
    root,
    logDir,
    quota: {
      totalMB: cfg.totalMB, totalBytes: cfg.totalBytes, maxArtifactMB: cfg.maxArtifactMB,
      usedBytes, usedMB: roundMB(usedBytes), usedPct: cfg.totalBytes ? Math.round(usedBytes / cfg.totalBytes * 1000) / 10 : 0,
      over: usedBytes > cfg.totalBytes, autoEvict: cfg.autoEvict,
    },
    categories: categoriesArr,
    dirs,
    unregistered: extra,
    pinnedFiles: pinned.length,
    pinnedPaths: pinned,
    totalFiles,
    scannedFiles: totalFiles,
  };
}

/* ── 配额准入（admit） ── */
let cache = { root: null, at: 0, total: 0 };

function managedTotal(o, force) {
  const root = o.root || paths.TMPDATA_DIR;
  const logDir = o.logDir || paths.LOG_DIR;
  if (!force && cache.root === root && Date.now() - cache.at < 60000) return cache.total;
  const reg = registry(root, logDir);
  const cats = categories(resolveConfig(o.config));
  const counted = new Set(cats.filter((c) => c.counted).map((c) => c.id));
  let total = 0;
  for (const d of reg) {
    if (d.key === 'locks') continue;
    for (const f of scanDir(d.dir)) {
      const cls = classifyFile(f.path, root, logDir);
      if (cls && counted.has(cls.id)) total += f.size;
    }
  }
  cache = { root, at: Date.now(), total };
  return total;
}

function bumpCache(bytes, root) {
  if (cache.root === (root || paths.TMPDATA_DIR) && Date.now() - cache.at < 60000) cache.total += Math.max(0, Number(bytes) || 0);
}

function quotaFail(message, extra) {
  return Object.assign({ ok: false, code: 'E_QUOTA', message }, extra || {});
}

/** 到期可淘汰体积（供 over-quota 判定参考；不删除） */
function expiredEvictable(o, cfg) {
  const root = o.root || paths.TMPDATA_DIR;
  const logDir = o.logDir || paths.LOG_DIR;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const cats = categories(cfg);
  const byId = {};
  for (const c of cats) byId[c.id] = c;
  const pinned = new Set(loadPins({ root }));
  let bytes = 0, files = 0;
  for (const d of registry(root, logDir)) {
    if (d.key === 'locks') continue;
    for (const f of scanDir(d.dir)) {
      if (pinned.has(f.path)) continue;
      const cls = classifyFile(f.path, root, logDir);
      if (!cls) continue;
      const cat = byId[cls.id];
      if (!cat || cat.evictOrder == null || cat.retentionDays == null) continue;
      if (now - f.mtimeMs > cat.retentionDays * DAY_MS) { bytes += f.size; files++; }
    }
  }
  return { bytes, files };
}

/**
 * 落盘前配额检查（非抛错；调用方按 ok/!ok 决定 diag/失败收口）。
 * @param {{file?:string, category?:string, bytes?:number, cmd?:string, root?:string, logDir?:string, config?:object, now?:number}} input
 * @returns {{ok:true, category?:string, skipped?:string, overQuota?:boolean, message?:string, totalBytes?:number, quotaBytes?:number}
 *          |{ok:false, code:'E_QUOTA', message:string, ...}}
 */
function check(input) {
  const o = input || {};
  const root = o.root || paths.TMPDATA_DIR;
  const logDir = o.logDir || paths.LOG_DIR;
  const cfg = resolveConfig(o.config);
  const abs = o.file ? path.resolve(String(o.file)) : null;
  const cls = abs ? classifyFile(abs, root, logDir) : (o.category ? { id: o.category, dirKey: null } : null);
  if (!cls) return { ok: true, skipped: 'unmanaged' };
  const cat = categoryById(cls.id, cfg);
  if (!cat) return { ok: true, skipped: 'unknown-category' };
  if (!cat.admitted) return { ok: true, skipped: 'excluded', category: cat.id };
  const bytes = Math.max(0, Number.isFinite(o.bytes) ? o.bytes : 0);
  if (bytes > cfg.maxArtifactBytes) {
    return quotaFail(`单产物 ${fmtBytes(bytes)} 超上限 ${cfg.maxArtifactMB}MB（config quota.maxArtifactMB）——已拒绝落盘（E_QUOTA）`,
      { category: cat.id, bytes, maxArtifactBytes: cfg.maxArtifactBytes });
  }
  let total = managedTotal(o);
  if (total + bytes <= cfg.totalBytes) {
    bumpCache(bytes, root);
    return { ok: true, category: cat.id, totalBytes: total + bytes, quotaBytes: cfg.totalBytes };
  }
  // 超总配额：可由到期淘汰释放的部分先算（autoEvict=true 才真删；默认只告警，首周观察）
  let expired = expiredEvictable(o, cfg);
  if (cfg.autoEvict && expired.bytes > 0) {
    const cutoff = Number.isFinite(o.now) ? o.now : Date.now();
    prune(Object.assign({}, o, { apply: true, yes: true, now: cutoff, reason: 'admit-auto-evict' }));
    total = managedTotal(o, true);
    expired = expiredEvictable(o, cfg);
  }
  if (total - expired.bytes + bytes <= cfg.totalBytes) {
    bumpCache(bytes, root);
    return {
      ok: true, category: cat.id, overQuota: true,
      message: `总配额余量不足（${fmtBytes(total)}/${fmtBytes(cfg.totalBytes)}）；到期产物可释放 ${fmtBytes(expired.bytes)}——请运行 artifacts prune --apply`,
      totalBytes: total + bytes, quotaBytes: cfg.totalBytes, expiredBytes: expired.bytes,
    };
  }
  return quotaFail(`总配额超限（已用 ${fmtBytes(total)} + 本次 ${fmtBytes(bytes)} > ${fmtBytes(cfg.totalBytes)}；到期可释放 ${fmtBytes(expired.bytes)} 仍不足）——先 artifacts prune --apply 或调大 config quota.totalMB（E_QUOTA）`,
    { category: cat.id, bytes, totalBytes: total, quotaBytes: cfg.totalBytes, expiredBytes: expired.bytes });
}

/* ── prune ── */
function collectManaged(o) {
  const root = o.root || paths.TMPDATA_DIR;
  const logDir = o.logDir || paths.LOG_DIR;
  const cfg = resolveConfig(o.config);
  const cats = categories(cfg);
  const byId = {};
  for (const c of cats) byId[c.id] = c;
  const files = [];
  for (const d of registry(root, logDir)) {
    if (d.key === 'locks') continue; // 锁文件永不进清理面
    for (const f of scanDir(d.dir)) {
      const cls = classifyFile(f.path, root, logDir);
      if (!cls) continue;
      const cat = byId[cls.id];
      if (!cat) continue;
      files.push(Object.assign({}, f, { category: cat.id, dirKey: d.key, retentionDays: cat.retentionDays, evictOrder: cat.evictOrder, counted: cat.counted }));
    }
  }
  return { root, logDir, cfg, files, cats };
}

/** 删除空目录（仅登记目录内部；不删登记目录本身） */
function pruneEmptyDirs(reg) {
  let removed = 0;
  for (const d of reg) {
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name));
      try {
        if (fs.readdirSync(dir).length === 0 && dir !== d.dir) { fs.rmdirSync(dir); removed++; }
      } catch { /* 非空/竞态 */ }
    };
    if (fs.existsSync(d.dir)) walk(d.dir);
  }
  return removed;
}

/**
 * 保留期清理 + 超配额淘汰。默认 dry-run。
 * @param {{apply?:boolean, yes?:boolean, root?:string, logDir?:string, config?:object, now?:number}} [opts]
 * @returns {{ok:boolean, code?:string, message?:string, mode:string, victims:Array, groups:Array,
 *            bytes:number, files:number, deleted:number, deletedBytes:number, freedBytes:number, remainingBytes:number, quotaBytes:number}}
 */
function prune(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const { root, logDir, cfg, files } = collectManaged(o);
  const pinned = new Set(loadPins({ root }));

  const victims = new Map(); // path -> {path,size,category,reason,ageDays}
  const isExcluded = (f) => f.category === 'other' || pinned.has(f.path);

  // ① 到期清理（所有有 retention 的类别；证据类只走到期这条）
  for (const f of files) {
    if (isExcluded(f)) continue;
    if (f.retentionDays == null) continue;
    if (now - f.mtimeMs > f.retentionDays * DAY_MS) {
      victims.set(f.path, { path: f.path, size: f.size, category: f.category, reason: 'expired', ageDays: Math.floor((now - f.mtimeMs) / DAY_MS) });
    }
  }
  // ② 超总配额淘汰（固定序 video→screenshot/download→log，各类别内最旧优先；证据/other 不参与）
  let remainingBytes = files.filter((f) => f.counted).reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (victims.has(f.path) && f.counted) remainingBytes -= f.size;
  }
  if (remainingBytes > cfg.totalBytes) {
    for (const order of [1, 2, 3]) {
      if (remainingBytes <= cfg.totalBytes) break;
      const pool = files.filter((f) => f.evictOrder === order && !isExcluded(f) && !victims.has(f.path))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of pool) {
        if (remainingBytes <= cfg.totalBytes) break;
        victims.set(f.path, { path: f.path, size: f.size, category: f.category, reason: 'over-quota', ageDays: Math.floor((now - f.mtimeMs) / DAY_MS) });
        if (f.counted) remainingBytes -= f.size;
      }
    }
  }

  const list = [...victims.values()].sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  const bytes = list.reduce((n, v) => n + v.size, 0);
  const groups = [];
  for (const c of categories(cfg)) {
    const items = list.filter((v) => v.category === c.id);
    if (!items.length) continue;
    groups.push({ category: c.id, retentionDays: c.retentionDays, evictOrder: c.evictOrder, files: items.length, bytes: items.reduce((n, x) => n + x.size, 0) });
  }
  const result = {
    ok: true, mode: o.apply ? 'apply' : 'dry-run', at: time.isoLocal(),
    quotaBytes: cfg.totalBytes, remainingBytes, victims: list, groups,
    files: list.length, bytes, deleted: 0, deletedBytes: 0, freedBytes: 0,
  };
  if (!o.apply) return result;

  // 安全闸：批量破坏面须 --yes（>500 文件或 >1GB）
  if (!o.yes && (list.length > 500 || bytes > 1024 * MB)) {
    return {
      ok: false, code: 'E_USAGE', mode: 'apply',
      message: `将删除 ${list.length} 个文件 / ${fmtBytes(bytes)}（>500 文件或 >1GB）——须显式 --yes 确认（防分类 bug 一次性毁尸）`,
      victims: list, groups, files: list.length, bytes,
    };
  }
  for (const v of list) {
    try { fs.unlinkSync(v.path); result.deleted++; result.deletedBytes += v.size; } catch { /* 竞态已不在 */ }
  }
  result.freedBytes = result.deletedBytes;
  const reg = registry(root, logDir);
  result.removedDirs = pruneEmptyDirs(reg);
  result.remainingBytes = managedTotal(Object.assign({}, o, { root, logDir }), true);
  cache = { root: null, at: 0, total: 0 };
  return result;
}

module.exports = {
  MB, DAY_MS, DEFAULTS, BASE_CATEGORIES, resolveConfig, categories, categoryById, registry,
  classifyFile, scanDir, fmtBytes, roundMB, isInside,
  report, check, prune, managedTotal,
  loadPins, savePins, pin, pinFile,
};
