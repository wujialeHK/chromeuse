'use strict';
/*
 * chromeuse lib/tab-govern.js —— agent 页签治理单源（C8 #123，V20261113003）
 *
 * 用户裁定后的正式形态（非降级偷工）：CDP 无页签分组/标色原生通道（tab groups 走扩展 API、
 * Target.createTarget 无 group 参数）→ ①命名标记（注册表 + about:blank title 前缀，与用户页签可区分）
 * ②惰性空闲回收（new/close 命令末尾顺带扫描，无 daemon）③永不抢前台（回收只发 getTargets/closeTarget）。
 *
 * 白名单铁律（R2 缓解核心）：**注册表未登记的页签 = 用户页签，永不回收**——回收面只由本模块
 * 登记的 agent 页签构成；登记项还须 agent:true（防手改/误写）。批量上限（默认 5）防一次误扫成灾。
 *
 * 活动追踪：tools/cdp.js 的 resolveTarget 包装对命中登记的页签 touch lastActiveAt（15s 节流）——
 * 「被命令使用过」即视为活动，空闲阈值不会误伤正在用的页签；C1 起 touch 顺带心跳续租。
 *
 * 豁免（脚本运行/录制/交接中）：detectBusy() 读三类机器信号——①job 状态文件 status=running
 * ②.tmpdata/locks/.chromeuse.lock 未过期 ③tmpdata/handoff/*.json 处于 pending/waiting 且未过 deadline
 * （C2 #128 起活跃判据=state∧deadline 双字段：滞留 waiting 的超时文件不再永久豁免回收）。
 * 边界如实：前台 record 与回收命令不会同时执行（短连接单进程模型）；跨终端并行的 record --lock 由锁信号覆盖，
 * 无 --lock 的 record 与回收的竞态靠「回收只碰登记页签」隔离（record 使用的用户页签不登记）。
 * C1 起多 agent 并发由租约兜住可回收面（他方活跃租约=不回收/不关），但同一页签的并发驱动（click/type 交叉）
 * 仍靠调用侧纪律——本批不做跨命令互斥（零新命令/零新旗标）。
 *
 * 配置（config.jsonc `tabs` 段，缺失走默认）：{reclaim:true, idleMs:600000, markPrefix:"cu-", maxPerRun:5,
 * owner:"local", leaseMs:1800000}；env 接缝（部署/测试）：CHROMEUSE_TABS_RECLAIM=0、CHROMEUSE_TABS_IDLE_MS、
 * CHROMEUSE_TABS_MAX_PER_RUN、CHROMEUSE_TABS_MARK_PREFIX、CHROMEUSE_TABS_OWNER（命名会话）、
 * CHROMEUSE_TABS_LEASE_MS（租期，0=不过期）。回退面=config 一键关（reclaim:false）或 env=0，零代码回滚。
 *
 * C1 命名会话 + 页签租约（#129，V20261113009）：登记条目即租约——owner（命名会话标识，缺省
 * `local`；env CHROMEUSE_TABS_OWNER 命名本会话）+ expiresAt（租期，0=不过期）+ heartbeatAt
 * （活动心跳，touch 时顺带续租）+ leaseMs（本条目 TTL，续租据此自洽）。
 * ①零新命令/零新旗标：租约内建在 new/close/tab-helper；
 * ②单用户零感知：本主租约绝不拦自己（回收/close 与无租约时逐字节一致）——E_BUSY 只在他方活跃
 *   租约时出现（claimLease/renewLease/leaseConflicts，close 破坏性操作诚实红）；
 * ③过期=无主（可回收）：planReclaim 把过期租约清成无主，仍按空闲阈值判定（与空闲回收正交）；
 * ④兼容：无 owner 字段的旧条目=无主（不是他方），首次 touch 自动认领。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');

const REGISTRY_VERSION = 2; // v2 = 条目可选租约字段（owner/expiresAt/heartbeatAt/leaseMs）
const REGISTRY_DIR = path.join(paths.TMPDATA_DIR, 'tab-registry');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'agent-tabs.json');
const HANDOFF_DIR = paths.HANDOFF_DIR; // 路径单源（C2 #128 提升至 lib/paths.js）
const MAX_ENTRIES = 500;
const TOUCH_THROTTLE_MS = 15000;
const LOCK_STALE_MS = 15000;
const DEFAULT_OWNER = 'local';       // 缺省命名会话=单用户本机（与旧行为等价）
const LEASE_MS = 1800000;            // 默认租期 30min（相对命令时长=极长；touch 即续租）

const DEFAULTS = Object.freeze({
  enabled: true,
  idleMs: 600000,     // 10min（Browse 先例）
  markPrefix: 'cu-',
  maxPerRun: 5,
  owner: DEFAULT_OWNER,
  leaseMs: LEASE_MS,
});

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function toPositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || (max !== undefined && n > max)) return null;
  return n;
}

function parseBoolEnv(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  return null;
}

/**
 * 配置段 + env → 归一选项（fail-soft：非法值回退默认并记 warnings）。
 * @param {object} [section] config.jsonc 的 tabs 段
 * @param {object} [env]
 */
function normalizeOptions(section, env) {
  const e = env || process.env;
  const raw = section && typeof section === 'object' ? section : {};
  const warnings = [];
  const out = Object.assign({}, DEFAULTS);

  if (raw.reclaim !== undefined) {
    if (typeof raw.reclaim === 'boolean') out.enabled = raw.reclaim;
    else warnings.push('tabs.reclaim 须为布尔（已回退默认 true）');
  }
  if (e.CHROMEUSE_TABS_RECLAIM !== undefined && e.CHROMEUSE_TABS_RECLAIM !== '') {
    const b = parseBoolEnv(e.CHROMEUSE_TABS_RECLAIM);
    if (b === null) warnings.push(`CHROMEUSE_TABS_RECLAIM 非法（${e.CHROMEUSE_TABS_RECLAIM}），已忽略`);
    else out.enabled = b;
  }

  const idleSrc = e.CHROMEUSE_TABS_IDLE_MS !== undefined && e.CHROMEUSE_TABS_IDLE_MS !== ''
    ? e.CHROMEUSE_TABS_IDLE_MS : raw.idleMs;
  if (idleSrc !== undefined) {
    const n = toPositiveInt(idleSrc, DEFAULTS.idleMs, 0);
    if (n === null) warnings.push(`tabs.idleMs 须为非负整数毫秒（收到 ${JSON.stringify(idleSrc)}，已回退 ${DEFAULTS.idleMs}）`);
    else out.idleMs = n;
  }

  const prefixSrc = e.CHROMEUSE_TABS_MARK_PREFIX !== undefined && e.CHROMEUSE_TABS_MARK_PREFIX !== ''
    ? e.CHROMEUSE_TABS_MARK_PREFIX : raw.markPrefix;
  if (prefixSrc !== undefined) {
    const s = String(prefixSrc).trim();
    if (!s) warnings.push('tabs.markPrefix 须为非空字符串（已回退默认 cu-）');
    else out.markPrefix = s;
  }

  const capSrc = e.CHROMEUSE_TABS_MAX_PER_RUN !== undefined && e.CHROMEUSE_TABS_MAX_PER_RUN !== ''
    ? e.CHROMEUSE_TABS_MAX_PER_RUN : raw.maxPerRun;
  if (capSrc !== undefined) {
    const n = toPositiveInt(capSrc, DEFAULTS.maxPerRun, 1, 50);
    if (n === null) warnings.push(`tabs.maxPerRun 须为 1~50 整数（收到 ${JSON.stringify(capSrc)}，已回退 ${DEFAULTS.maxPerRun}）`);
    else out.maxPerRun = n;
  }

  /* C1 租约（#129）：owner=命名会话标识（env/config），leaseMs=租期 0~（0=不过期） */
  const ownerSrc = e.CHROMEUSE_TABS_OWNER !== undefined && e.CHROMEUSE_TABS_OWNER !== ''
    ? e.CHROMEUSE_TABS_OWNER : raw.owner;
  if (ownerSrc !== undefined) {
    if (typeof ownerSrc !== 'string' || !ownerSrc.trim() || ownerSrc.trim().length > 64) {
      warnings.push(`tabs.owner 须为非空字符串（≤64 字符；收到 ${JSON.stringify(ownerSrc)}，已回退 ${DEFAULT_OWNER}）`);
    } else out.owner = ownerSrc.trim();
  }

  const leaseSrc = e.CHROMEUSE_TABS_LEASE_MS !== undefined && e.CHROMEUSE_TABS_LEASE_MS !== ''
    ? e.CHROMEUSE_TABS_LEASE_MS : raw.leaseMs;
  if (leaseSrc !== undefined) {
    const n = toPositiveInt(leaseSrc, DEFAULTS.leaseMs, 0);
    if (n === null) warnings.push(`tabs.leaseMs 须为非负整数毫秒（0=不过期；收到 ${JSON.stringify(leaseSrc)}，已回退 ${DEFAULTS.leaseMs}）`);
    else out.leaseMs = n;
  }

  return {
    enabled: out.enabled, idleMs: out.idleMs, markPrefix: out.markPrefix, maxPerRun: out.maxPerRun,
    owner: out.owner, leaseMs: out.leaseMs, warnings,
  };
}

/** env-only 租约标识（resolveTarget 热路径用：不读 config；非法值静默回退——配置告警由 normalizeOptions 负责） */
function leaseEnv(env) {
  const e = env || process.env;
  const owner = String(e.CHROMEUSE_TABS_OWNER == null ? '' : e.CHROMEUSE_TABS_OWNER).trim();
  const ttlRaw = e.CHROMEUSE_TABS_LEASE_MS;
  const ttl = ttlRaw === undefined || ttlRaw === '' ? LEASE_MS : toPositiveInt(ttlRaw, LEASE_MS, 0);
  return { owner: owner || DEFAULT_OWNER, leaseMs: ttl === null ? LEASE_MS : ttl };
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, updatedAt: time.isoLocal(), tabs: {} };
}

/** 读注册表（缺失/坏文件 → 空表 + warnings；永不抛错） */
function loadRegistry(file) {
  const target = file || REGISTRY_FILE;
  const warnings = [];
  if (!fs.existsSync(target)) return { registry: emptyRegistry(), warnings };
  const raw = readJson(target);
  if (!raw || typeof raw !== 'object' || !raw.tabs || typeof raw.tabs !== 'object' || Array.isArray(raw.tabs)) {
    warnings.push(`页签注册表不可解析或结构非法（已按空表处理，不会回收任何页签）：${target}`);
    return { registry: emptyRegistry(), warnings };
  }
  const tabs = {};
  for (const [id, entry] of Object.entries(raw.tabs)) {
    if (!id || !entry || typeof entry !== 'object') continue;
    /* C1 租约字段（可选；无 owner=旧条目/无主，不补默认值——保持旧文件读取零改写） */
    const lease = {};
    if (typeof entry.owner === 'string' && entry.owner) lease.owner = entry.owner;
    const exp = Number(entry.expiresAt);
    if (Number.isFinite(exp) && exp > 0) lease.expiresAt = exp;
    const hb = Number(entry.heartbeatAt);
    if (Number.isFinite(hb) && hb > 0) lease.heartbeatAt = hb;
    const ttl = Number(entry.leaseMs);
    if (Number.isFinite(ttl) && ttl >= 0) lease.leaseMs = ttl;
    tabs[id] = {
      agent: entry.agent === true,
      createdAt: Number(entry.createdAt) || 0,
      lastActiveAt: Number(entry.lastActiveAt) || Number(entry.createdAt) || 0,
      prefix: typeof entry.prefix === 'string' ? entry.prefix : DEFAULTS.markPrefix,
      url: typeof entry.url === 'string' ? entry.url : '',
      ...(entry.pinned === true ? { pinned: true } : {}),
      ...lease,
    };
  }
  return { registry: { version: REGISTRY_VERSION, updatedAt: String(raw.updatedAt || ''), tabs }, warnings };
}

/** 原子写注册表（temp+rename；条目上限裁剪最旧；失败 fail-soft 返回 ok:false） */
function saveRegistry(registry, file) {
  const target = file || REGISTRY_FILE;
  try {
    const reg = registry && registry.tabs ? registry : emptyRegistry();
    let ids = Object.keys(reg.tabs);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => Number(reg.tabs[a].lastActiveAt || 0) - Number(reg.tabs[b].lastActiveAt || 0));
      for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete reg.tabs[id];
    }
    reg.version = REGISTRY_VERSION;
    reg.updatedAt = time.isoLocal();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ── C1 命名会话 + 页签租约（#129）：纯函数状态机 ──────────────────────────
 * 条目字段：owner（命名会话）/expiresAt（0 或缺省=不过期）/heartbeatAt/leaseMs。
 * 兼容：无 owner 的旧条目=无主（active:false）——任何 owner 都可认领/回收，升级零改写。 */

/** 租约视图（纯函数；now 缺省=Date.now()） */
function leaseHolder(entry, now) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const t = Number.isFinite(now) ? now : Date.now();
  const owner = typeof e.owner === 'string' ? e.owner : '';
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const expiresAt = num(e.expiresAt, 0);
  const heartbeatAt = num(e.heartbeatAt, 0);
  const leaseMs = num(e.leaseMs, LEASE_MS);
  return {
    owner, expiresAt, heartbeatAt, leaseMs,
    active: !!owner && (expiresAt <= 0 || expiresAt > t),
    expired: !!owner && expiresAt > 0 && expiresAt <= t,
  };
}

/** 写入租约字段（发放/接管/续租共用；leaseMs=0=不过期→不写 expiresAt） */
function issueLease(entry, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const owner = String(o.owner || DEFAULT_OWNER);
  const leaseMs = Number.isFinite(o.leaseMs) && o.leaseMs >= 0 ? o.leaseMs : LEASE_MS;
  entry.owner = owner;
  entry.heartbeatAt = now;
  entry.leaseMs = leaseMs;
  if (leaseMs > 0) entry.expiresAt = now + leaseMs;
  else delete entry.expiresAt;
  return entry;
}

/**
 * 领取/接管租约（CAS 语义纯函数）：他方活跃租约 → E_BUSY 不抢占；无主/过期/本主 → 发放/续租。
 * @returns {{ok:boolean, code?:string, message?:string, entry?:object, holder?:object, renewed?:boolean, takenOverFrom?:string}}
 */
function claimLease(registry, targetId, opts) {
  const o = opts || {};
  const reg = registry && registry.tabs ? registry : null;
  const id = String(targetId || '');
  if (!reg || !id) return { ok: false, code: 'E_USAGE', message: 'claimLease 需要 registry.tabs 与 targetId' };
  const entry = reg.tabs[id];
  if (!entry) return { ok: false, code: 'E_NOT_FOUND', message: `页签 ${id} 未登记（未登记=用户页签，不租用）` };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const owner = String(o.owner || DEFAULT_OWNER);
  const holder = leaseHolder(entry, now);
  if (holder.active && holder.owner !== owner) {
    return {
      ok: false, code: 'E_BUSY', holder,
      message: `页签 ${id} 被「${holder.owner}」租用中（${holder.expiresAt > 0 ? `到期 ${new Date(holder.expiresAt).toISOString()}` : '不过期'}）——E_BUSY，勿并发驱动同一页签`,
    };
  }
  const previous = holder.owner;
  issueLease(entry, { owner, leaseMs: o.leaseMs === undefined ? holder.leaseMs : o.leaseMs, now });
  return {
    ok: true, entry, renewed: previous === owner,
    ...(previous && previous !== owner ? { takenOverFrom: previous } : {}),
  };
}

/** 心跳续租（touch 顺带）：本主续期；无主/过期→认领；他方活跃→E_BUSY 且零改动 */
function renewLease(registry, targetId, opts) {
  const o = opts || {};
  const reg = registry && registry.tabs ? registry : null;
  const id = String(targetId || '');
  if (!reg || !id || !reg.tabs[id]) return { ok: false, code: 'E_NOT_FOUND', message: `页签 ${id} 未登记` };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const owner = String(o.owner || DEFAULT_OWNER);
  const entry = reg.tabs[id];
  const holder = leaseHolder(entry, now);
  if (holder.active && holder.owner !== owner) {
    return { ok: false, code: 'E_BUSY', holder, message: `页签 ${id} 被「${holder.owner}」租用中——E_BUSY` };
  }
  issueLease(entry, { owner, leaseMs: o.leaseMs === undefined ? holder.leaseMs : o.leaseMs, now });
  return { ok: true, entry, renewed: true };
}

/** close 前置闸门（纯函数）：列出被「他方活跃租约」占用的目标（单用户恒空） */
function leaseConflicts(targets, registry, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const owner = String(o.owner || DEFAULT_OWNER);
  const reg = registry && registry.tabs ? registry : null;
  if (!reg) return [];
  const conflicts = [];
  for (const t of (Array.isArray(targets) ? targets : [])) {
    const id = String((t && (t.id || t.targetId)) || '');
    if (!id || !reg.tabs[id]) continue;
    const holder = leaseHolder(reg.tabs[id], now);
    if (holder.active && holder.owner !== owner) conflicts.push(Object.assign({ targetId: id, target: t }, holder));
  }
  return conflicts;
}

/** 登记新 agent 页签（targetId 为键；重复登记刷新 lastActiveAt 并重发租约） */
function registerTab(registry, opts) {
  const o = opts || {};
  const reg = registry && registry.tabs ? registry : emptyRegistry();
  const id = String(o.targetId || '');
  if (!id) return reg;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const prev = reg.tabs[id];
  const entry = {
    agent: true,
    createdAt: prev && prev.createdAt ? prev.createdAt : now,
    lastActiveAt: now,
    prefix: String(o.prefix || DEFAULTS.markPrefix),
    url: String(o.url || ''),
  };
  issueLease(entry, { owner: o.owner, leaseMs: o.leaseMs, now }); // C1：开页即发租约（owner=命名会话）
  reg.tabs[id] = entry;
  return reg;
}

/** 单条目 touch（存在才写；节流避免每条命令落盘；C1：顺带心跳续租） */
function touch(registry, targetId, opts) {
  const o = opts || {};
  const reg = registry && registry.tabs ? registry : null;
  const id = String(targetId || '');
  if (!reg || !id) return false;
  const entry = reg.tabs[id];
  if (!entry) return false;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (now - Number(entry.lastActiveAt || 0) < (o.throttleMs || TOUCH_THROTTLE_MS)) return false;
  entry.lastActiveAt = now;
  /* 他方活跃租约：只记活动（页签确被用过），不抢租约、不续他的期 */
  renewLease(reg, id, { owner: o.owner || DEFAULT_OWNER, now, leaseMs: o.leaseMs });
  return true;
}

/** resolveTarget 热路径接缝：命中登记页签才 touch 落盘（注册表不存在=零开销） */
function touchFromDisk(targetId, opts) {
  const o = opts || {};
  const file = o.file || REGISTRY_FILE;
  try {
    if (!fs.existsSync(file)) return false;
    const { registry } = loadRegistry(file);
    const owner = o.owner || leaseEnv().owner;
    if (!touch(registry, targetId, Object.assign({}, o, { owner }))) return false;
    return saveRegistry(registry, file).ok;
  } catch { return false; }
}

function canonicalTarget(t) {
  return {
    id: String((t && (t.targetId || t.id)) || ''),
    type: String((t && t.type) || ''),
    title: String((t && t.title) || ''),
    url: String((t && t.url) || ''),
  };
}

/**
 * 回收判定（纯函数，不 IO）。
 * @param {{registry?:object, liveTargets?:Array, now?:number, options?:object, busy?:{busy:boolean,reasons?:string[]}}} input
 * @returns {{enabled:boolean, idleMs:number, reclaim:Array, keep:Array, prune:Array, registry:object, skipped?:string}}
 */
function planReclaim(input) {
  const o = input || {};
  const options = Object.assign({}, DEFAULTS, o.options || {});
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const loaded = o.registry && o.registry.tabs ? o.registry : emptyRegistry();
  const live = (Array.isArray(o.liveTargets) ? o.liveTargets : []).map(canonicalTarget).filter((t) => t.id);
  const liveById = new Map(live.map((t) => [t.id, t]));
  const next = emptyRegistry();
  const reclaim = [], keep = [], prune = [];

  // ① 先按「活着的 page 页签」剪枝（死条目只清账，绝不发 close）
  for (const [id, entry] of Object.entries(loaded.tabs)) {
    const t = liveById.get(id);
    if (!t) { prune.push({ targetId: id, reason: 'gone' }); continue; }
    if (t.type !== 'page') { prune.push({ targetId: id, reason: 'not-page' }); continue; }
    next.tabs[id] = entry;
  }

  if (options.enabled === false) {
    for (const id of Object.keys(next.tabs)) keep.push({ targetId: id, reason: 'disabled' });
    return { enabled: false, idleMs: options.idleMs, reclaim, keep, prune, registry: next, skipped: 'disabled' };
  }
  if (o.busy && o.busy.busy) {
    const why = (o.busy.reasons || []).join(',') || 'busy';
    for (const id of Object.keys(next.tabs)) keep.push({ targetId: id, reason: `busy:${why}` });
    return { enabled: true, idleMs: options.idleMs, reclaim, keep, prune, registry: next, skipped: 'busy' };
  }

  const candidates = [];
  const owner = String(options.owner || DEFAULT_OWNER);
  for (const [id, entry] of Object.entries(next.tabs)) {
    const t = liveById.get(id);
    if (!entry || entry.agent !== true) {
      // 非本模块登记的 agent 行（脏数据/手改）：清出注册表但绝不关页签（白名单铁律）
      delete next.tabs[id];
      prune.push({ targetId: id, reason: 'not-agent-entry' });
      keep.push({ targetId: id, reason: 'not-agent' });
      continue;
    }
    if (entry.pinned === true) { keep.push({ targetId: id, reason: 'pinned' }); continue; }
    /* C1 租约（#129）：他方活跃租约=保留（与空闲回收正交，先于 idle 判定）；过期=清成无主，
     * 继续按空闲阈值走（本主租约不拦自己——单用户零感知）。 */
    const holder = leaseHolder(entry, now);
    if (holder.active && holder.owner !== owner) {
      keep.push({ targetId: id, reason: 'leased', owner: holder.owner, expiresAt: holder.expiresAt });
      continue;
    }
    if (holder.expired) {
      delete next.tabs[id].owner;
      delete next.tabs[id].expiresAt;
      delete next.tabs[id].heartbeatAt;
      delete next.tabs[id].leaseMs;
    }
    const last = Number(entry.lastActiveAt || entry.createdAt || 0);
    const idleMs = now - last;
    if (!Number.isFinite(last) || last <= 0) { keep.push({ targetId: id, reason: 'no-timestamp' }); continue; }
    if (idleMs < options.idleMs) { keep.push({ targetId: id, reason: 'fresh', idleMs }); continue; }
    candidates.push({ targetId: id, title: t.title, url: t.url, idleMs });
  }
  // ② 最旧优先，超出单次上限的留到下轮（防一次误扫成灾）
  candidates.sort((a, b) => b.idleMs - a.idleMs);
  for (const c of candidates) {
    if (reclaim.length >= options.maxPerRun) { keep.push({ targetId: c.targetId, reason: 'cap', idleMs: c.idleMs }); continue; }
    reclaim.push(c);
  }
  return { enabled: true, idleMs: options.idleMs, reclaim, keep, prune, registry: next };
}

/**
 * 忙碌信号探测（job 运行中 / lock 未过期 / handoff 等待中）→ 本轮跳过回收。
 * @param {{jobsDir?:string, lockPath?:string, handoffDir?:string, now?:number}} [opts]
 * @returns {{busy:boolean, reasons:string[]}}
 */
function detectBusy(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const reasons = [];

  const jobsDir = o.jobsDir || paths.JOBS_DIR;
  try {
    for (const n of fs.readdirSync(jobsDir)) {
      if (!/^job-.*\.json$/.test(n)) continue;
      const st = readJson(path.join(jobsDir, n));
      if (st && st.status === 'running') { reasons.push(`job:${st.jobId || n}`); break; }
    }
  } catch { /* 无 jobs 目录 */ }

  try {
    const info = readJson(o.lockPath || paths.LOCK_PATH);
    const stale = !info || typeof info.heartbeatAt !== 'number' || (now - info.heartbeatAt) > LOCK_STALE_MS;
    if (!stale) reasons.push(`lock:${info.owner || 'unknown'}`);
  } catch { /* 无锁 */ }

  const handoffDir = o.handoffDir || HANDOFF_DIR;
  try {
    for (const n of fs.readdirSync(handoffDir)) {
      if (!/\.json$/.test(n)) continue;
      const st = readJson(path.join(handoffDir, n));
      const state = String((st && (st.state || st.status)) || '').toLowerCase();
      /* C2 #128 活跃判据双字段：state 命中 ∧ deadline 未过期才豁免。deadline 缺失/非数=坏文件，不豁免
       * （安全侧回收优先）；agent 弃跑 --wait 导致状态文件滞留 waiting 时，超时后自动失去豁免。 */
      if (!['pending', 'waiting', 'created', 'active'].includes(state)) continue;
      if (!Number.isFinite(st.deadline) || now >= st.deadline) continue;
      reasons.push(`handoff:${n}`);
      break;
    }
  } catch { /* 无 handoff 目录 */ }

  return { busy: reasons.length > 0, reasons };
}

/** title 前缀匹配（纯函数）：展示/诊断用——**回收权威判据仍是注册表**（页面导航会覆盖 title，不能据此关闭） */
function hasAgentMark(title, prefix) {
  const p = String(prefix === undefined || prefix === null ? DEFAULTS.markPrefix : prefix);
  if (!p) return false;
  return String(title == null ? '' : title).startsWith(p);
}

/** about:blank 的 title 前缀表达式（页面导航后会被站点覆盖——权威标记在注册表，title 仅人工可见提示） */
function titleMarkExpression(prefix) {
  const p = JSON.stringify(String(prefix || ''));
  return `(() => { const p = ${p}; if (!p) return document.title; const t = String(document.title || ''); if (t.startsWith(p)) return t; document.title = p + (t || 'chromeuse'); return document.title; })()`;
}

/** 尽力设置 title 前缀（fail-soft：失败不阻断 new） */
async function markTitle(client, sessionId, prefix, opts) {
  const o = opts || {};
  try {
    const r = await client.send('Runtime.evaluate', {
      expression: titleMarkExpression(prefix), returnByValue: true,
    }, { sessionId, timeoutMs: o.timeoutMs || 2000 });
    const v = r && r.result && r.result.value;
    return { ok: true, title: typeof v === 'string' ? v : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  REGISTRY_VERSION, REGISTRY_DIR, REGISTRY_FILE, HANDOFF_DIR, MAX_ENTRIES, TOUCH_THROTTLE_MS, LOCK_STALE_MS,
  DEFAULT_OWNER, LEASE_MS, DEFAULTS,
  normalizeOptions, parseBoolEnv, leaseEnv, emptyRegistry, loadRegistry, saveRegistry, registerTab, touch, touchFromDisk,
  leaseHolder, claimLease, renewLease, leaseConflicts,
  canonicalTarget, planReclaim, detectBusy, hasAgentMark, titleMarkExpression, markTitle,
};
