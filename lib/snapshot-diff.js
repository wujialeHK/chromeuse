'use strict';
/*
 * chromeuse lib/snapshot-diff.js —— a11y 快照分级：身份键 diff / 树内检索 / 游标分页 / 基线存储
 * （B6a N5，V20261104002）
 *
 * 定位：`tools/cdp.js a11y --find/--diff/--out/--cursor` 的唯一实现单源（纯函数 + 模板数据 IO）；
 * 快照取数/帧合并/降噪仍在 lib/perceive.js（CDP 动作），本模块零 CDP、零第三方依赖。
 *
 * ── 为什么需要它（G4 token 效率 + 假 diff 教训）─────────────────────────────────
 * 现状 a11y 每次全量文本输出：只想找一个元素 / 只看变了什么，仍要把上千行读进上下文。分级输出
 * 把「全量快照」拆成四种可组合视图：树内检索（--find）、增量 diff（--diff）、落盘（--out）、
 * 分页（--cursor）；同时提供三种降噪（--exclude 子树剪除 / --frames 同源帧合并 / --visible-only
 * 遮挡过滤）在 perceive.js 侧执行。
 *
 * ── diff 身份键（钉死，假 diff 之源）──────────────────────────────────────────
 * nodeId 跨快照不稳定（每次 getFullAXTree 重新分配），绝不能拿 nodeId 做 diff 键。身份键：
 *   ① `backendDOMNodeId` 优先（同一文档内稳定；B0 实测跨同进程帧无碰撞，但协议未承诺——
 *      所以本模块只在同一 target 的同一 loaderId 内使用，导航即 forcedFull）；
 *   ② 结构路径兜底 = `framePath + role + name + 同 role/name 出现序号`（backendDOMNodeId 缺失
 *      时；元素被删除会导致后续同 role/name 序号位移 → 这是兜底的已知边界，宁多报不静默漏报）；
 * 匹配时 bKey 优先、sKey 兜底（任一侧命中即视为同一节点）。身份键相同但签名（role/name/value/
 * description/focusable/clickable/disabled）变化 → change:'changed'。
 *
 * ── --diff 不可比回落（不给跨页假 diff）──────────────────────────────────────
 * 任一条件成立 → forcedFull:true + 全量输出（不标 *）：
 *   - 无基线（首次 --diff） / 基线读不出（坏文件）
 *   - 主帧 loaderId 变化（导航、刷新）或取不到代际
 *   - target 变化（基线按 targetId 分文件，正常不会命中；防御性校验）
 *   - 快照口径变化（depth/maxNodes/exclude/frames/visibleOnly/query 任一不同）
 * truncated/partial 基线或当前快照仍做 diff，但标 degraded（可能漏报新增，不制造假新增）。
 *
 * ── 基线（tmpdata/a11y-baseline/<targetId>.json；quota 预登记 7 天类）───────────
 * 一次 --diff/--cursor = 一代快照（整文件覆盖）。基线同时保存「全量行」与「本次输出视图」：
 * --cursor 的 token 只带 snapshotId+offset，续页直接读基线视图（零 CDP、零重解析），
 * 快照代际不一致即拒绝（不跨快照拼页）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const time = require('./time');

const BASELINE_FORMAT = 'chromeuse-a11y-baseline/1';
const SNAPSHOT_FORMAT = 'chromeuse-a11y-snapshot/1';
const DEFAULT_CURSOR_SIZE = 200;
const MAX_CURSOR_SIZE = 5000;
const FIND_CONTEXT_LINES = 2;
const DIFF_RATIO_THRESHOLD = 0.2;   // 验收基线：稳定页 diff 行数 < 全量 20%（3 页标定见 mechanisms §15）
const ID_LEN = 12;
const LABEL_NAME_MAX = 40;
const CURSOR_TOKEN_PREFIX = 'c1.';

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function compact(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function sha1Short(text, len) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, len || ID_LEN);
}

function rowLabel(row) {
  const role = (row && row.role) || (row && row.ignored ? '(ignored)' : '(no-role)');
  const name = row && row.name ? ' ' + JSON.stringify(compact(row.name, LABEL_NAME_MAX)) : '';
  return role + name;
}

/* ── --find 模式（文法 / 匹配 / 命中上下文）──────────────────────────────── */

/**
 * --find 文法归一（纯函数）：
 *   - 普通文本 → 大小写不敏感子串（role/name/value/description 四字段）
 *   - `/pattern/flags` → JS 正则；flags 仅 i/m/s/u（禁 g/y 的有状态 lastIndex，避免逐行匹配漂移）
 * 返回 {raw,isRegex,source,flags}（JSON 友好，不含 RegExp 对象）；非法抛错（CLI 归 E_USAGE）。
 */
function normalizeFindPattern(value) {
  if (value === undefined || value === null) return null;
  if (value === true) throw new Error('--find 缺值（文本或 /正则/）');
  if (typeof value !== 'string') throw new Error(`--find 需要字符串：${JSON.stringify(value)}`);
  const raw = value.trim();
  if (!raw) throw new Error('--find 不能为空');
  if (raw[0] === '/') {
    const end = raw.lastIndexOf('/');
    if (end <= 0) throw new Error(`--find 正则形态非法（形如 /pattern/i）：${JSON.stringify(raw)}`);
    const source = raw.slice(1, end);
    const flags = raw.slice(end + 1);
    if (!/^[imsu]*$/.test(flags)) throw new Error(`--find 正则 flags 仅支持 i/m/s/u：${JSON.stringify(flags)}`);
    if (!source) throw new Error('--find 正则不能为空');
    try { new RegExp(source, flags); } catch (e) { throw new Error(`--find 正则非法：${e.message}`); }
    return { raw, isRegex: true, source, flags };
  }
  return { raw, isRegex: false, source: raw, flags: '' };
}

function searchTextOf(row) {
  return [row && row.role, row && row.name, row && row.value, row && row.description]
    .map((v) => (v == null ? '' : String(v))).join('\n');
}

/** 构造匹配器（正则只编译一次；selftest 可直接消费） */
function findMatcher(pattern) {
  if (!pattern) return () => false;
  if (pattern.isRegex) {
    const re = new RegExp(pattern.source, pattern.flags);
    /* 正则逐字段匹配（role/name/value/description）：`/^alpha/i` 直觉上应对 name 生效，
     * 而不是被拼接文本里的 role 前缀挡掉。无 g/y → test 无状态。 */
    return (row) => [row && row.role, row && row.name, row && row.value, row && row.description]
      .some((v) => re.test(v == null ? '' : String(v)));
  }
  const needle = String(pattern.raw || '').toLowerCase();
  return (row) => searchTextOf(row).toLowerCase().includes(needle);
}

/**
 * 树内检索（纯函数）：按 DFS 行序返回命中 + 根到节点路径 + ±contextN 行上下文。
 * @param {object[]} rows perceive.buildAxRows 产物（含 framePath）
 * @param {{raw,isRegex,source,flags}} pattern normalizeFindPattern 产物
 * @param {{context?:number,allowedIndexes?:number[]}} [opts] allowedIndexes = diff 视图收窄（组合模式）
 * @returns {Array<{index,row,path:string[],context:Array<{index,row,hit:boolean}>}>}
 */
function buildFindHits(rows, pattern, opts) {
  const o = opts || {};
  const list = Array.isArray(rows) ? rows : [];
  const contextN = Number.isInteger(o.context) ? Math.max(0, o.context) : FIND_CONTEXT_LINES;
  const allowed = Array.isArray(o.allowedIndexes) ? new Set(o.allowedIndexes) : null;
  const match = findMatcher(pattern);
  const stack = [];
  const matchedStack = [];
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    while (stack.length && (Number(stack[stack.length - 1].depth) || 0) >= (Number(row && row.depth) || 0)) {
      stack.pop();
      matchedStack.pop();
    }
    const parentPath = stack.map((r) => rowLabel(r));
    const ancestorMatched = matchedStack.length > 0 && matchedStack[matchedStack.length - 1] === true;
    const textLeaf = row && (row.role === 'StaticText' || row.role === 'InlineTextBox');
    /* 去重：文本叶子命中且祖先已命中（button → StaticText → InlineTextBox 同一段文字）只报祖先，
     * 保证「找一个元素」输出单命中（<2KB），不被 AX 文本子节点重三遍。 */
    if ((!allowed || allowed.has(i)) && match(row) && !(textLeaf && ancestorMatched)) {
      const from = Math.max(0, i - contextN);
      const to = Math.min(list.length - 1, i + contextN);
      const context = [];
      for (let j = from; j <= to; j++) context.push({ index: j, row: list[j], hit: j === i });
      hits.push({ index: i, row, path: parentPath.concat([rowLabel(row)]), context });
    }
    stack.push(row);
    matchedStack.push(ancestorMatched || match(row));
  }
  return hits;
}

/* ── 身份键 / 签名 / diff ────────────────────────────────────────────────── */

/** 行签名（变化判据；bounds 不进签名——滚动/布局微移不是语义变化） */
function rowSignature(row) {
  const r = row || {};
  return JSON.stringify([
    String(r.role || ''), String(r.name || ''), String(r.value || ''),
    String(r.description || ''), r.focusable === true, r.clickable === true, r.disabled === true,
  ]);
}

/**
 * 身份键（纯函数）：bKey=backendDOMNodeId 优先；sKey=framePath+role+name+同组出现序号兜底。
 * 序号按各快照自身的 DFS 行序独立计算（跨快照删除节点会导致位移——兜底已知边界）。
 */
function buildRowKeys(rows) {
  const counts = new Map();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const fp = row && Array.isArray(row.framePath) && row.framePath.length ? row.framePath.join('>') : '';
    const base = `${fp}\u0000${String((row && row.role) || '')}\u0000${String((row && row.name) || '')}`;
    const idx = counts.get(base) || 0;
    counts.set(base, idx + 1);
    return {
      bKey: row && row.backendDOMNodeId !== null && row.backendDOMNodeId !== undefined ? `b:${row.backendDOMNodeId}` : null,
      sKey: `s:${base}\u0000${idx}`,
    };
  });
}

/** diff 口径键：快照内容口径（不含 find/out/cursor/diff 等视图旗标） */
function optionsKeyOf(opt) {
  const o = opt || {};
  const q = o.query ? `${o.query.kind}:${o.query.value}:${o.query.nth == null ? '' : o.query.nth}:${o.query.match || ''}` : '';
  return JSON.stringify({
    depth: o.depth, maxNodes: o.maxNodes, exclude: o.exclude || null,
    frames: o.frames || null, visibleOnly: o.visibleOnly === true, query: q,
  });
}

function diffComparability(currentMeta, baseline) {
  const cur = currentMeta || {};
  if (!baseline) return { forcedFull: true, forcedReason: 'no-baseline' };
  const bGen = baseline.generation || {};
  const cGen = cur.generation || {};
  if (!bGen.loaderId || !cGen.loaderId) return { forcedFull: true, forcedReason: 'no-generation' };
  if (String(bGen.loaderId) !== String(cGen.loaderId)) return { forcedFull: true, forcedReason: 'navigation' };
  const bTarget = String((baseline.target && baseline.target.id) || '');
  if (bTarget && cur.targetId && bTarget !== String(cur.targetId)) return { forcedFull: true, forcedReason: 'target-changed' };
  if (baseline.optionsKey && cur.optionsKey && baseline.optionsKey !== cur.optionsKey) {
    return { forcedFull: true, forcedReason: 'options-changed' };
  }
  return { forcedFull: false, forcedReason: null };
}

/**
 * 快照 diff（纯函数）：身份键匹配 + 签名比对。
 * @param {object[]} currentRows 当前快照行（已降噪）
 * @param {object|null} baseline readBaseline 产物
 * @param {{targetId,generation,optionsKey,truncated,partial}} meta
 * @returns {{forcedFull,forcedReason,degraded,degradedReasons,stats,entries,baseSnapshotId}}
 *   entries=[{row,index,change:'added'|'changed'|'full',matchedBy}]（forcedFull 时全部 change:'full'）
 */
function diffSnapshots(currentRows, baseline, meta) {
  const rows = Array.isArray(currentRows) ? currentRows : [];
  const m = meta || {};
  const cmp = diffComparability(m, baseline);
  const degradedReasons = [];
  if (baseline) {
    if (baseline.truncated === true) degradedReasons.push('baseline-truncated');
    if (baseline.partial === true) degradedReasons.push('baseline-partial');
  }
  if (m.truncated === true) degradedReasons.push('current-truncated');
  if (m.partial === true) degradedReasons.push('current-partial');
  if (cmp.forcedFull) {
    return {
      forcedFull: true, forcedReason: cmp.forcedReason,
      degraded: degradedReasons.length > 0, degradedReasons,
      stats: { baselineCount: baseline ? (baseline.rows || []).length : 0, currentCount: rows.length, added: 0, changed: 0, unchanged: 0, removed: 0 },
      entries: rows.map((row, index) => ({ row, index, change: 'full', matchedBy: null })),
      baseSnapshotId: baseline ? baseline.snapshotId || null : null,
    };
  }
  const baseRows = Array.isArray(baseline.rows) ? baseline.rows : [];
  const curKeys = buildRowKeys(rows);
  const baseKeys = buildRowKeys(baseRows);
  const byB = new Map();
  const byS = new Map();
  baseKeys.forEach((k, i) => {
    if (k.bKey && !byB.has(k.bKey)) byB.set(k.bKey, i);
    if (!byS.has(k.sKey)) byS.set(k.sKey, i);
  });
  const matchedBase = new Set();
  const entries = [];
  let added = 0, changed = 0;
  rows.forEach((row, index) => {
    const keys = curKeys[index];
    let j = null;
    let matchedBy = null;
    if (keys.bKey && byB.has(keys.bKey)) { j = byB.get(keys.bKey); matchedBy = 'backend'; }
    else if (byS.has(keys.sKey)) { j = byS.get(keys.sKey); matchedBy = 'structural'; }
    if (j === null) {
      added++;
      entries.push({ row, index, change: 'added', matchedBy: null });
      return;
    }
    matchedBase.add(j);
    if (rowSignature(row) !== rowSignature(baseRows[j])) {
      changed++;
      entries.push({ row, index, change: 'changed', matchedBy });
    }
  });
  return {
    forcedFull: false, forcedReason: null,
    degraded: degradedReasons.length > 0, degradedReasons,
    stats: {
      baselineCount: baseRows.length, currentCount: rows.length,
      added, changed, unchanged: rows.length - added - changed, removed: baseRows.length - matchedBase.size,
    },
    entries,
    baseSnapshotId: baseline.snapshotId || null,
  };
}

/* ── 游标（token 分页）──────────────────────────────────────────────────── */

function cursorViewKind(opt) {
  const o = opt || {};
  return o.find ? 'find' : (o.diff ? 'diff' : 'rows');
}

function cursorViewHash(opt) {
  const o = opt || {};
  return sha1Short(JSON.stringify({
    kind: cursorViewKind(o),
    find: o.find ? { raw: o.find.raw, flags: o.find.flags } : null,
  }), 8);
}

/** token = c1.<base64url({s:snapshotId,o:offset,v:viewHash})>；非法抛错（CLI 归 E_USAGE） */
function encodeCursorToken(snapshotId, offset, viewHash) {
  const body = JSON.stringify({ s: String(snapshotId || ''), o: Math.max(0, Number(offset) || 0), v: String(viewHash || '') });
  return CURSOR_TOKEN_PREFIX + Buffer.from(body, 'utf8').toString('base64url');
}

function decodeCursorToken(token) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('--cursor-token 缺值');
  const raw = token.trim();
  if (!raw.startsWith(CURSOR_TOKEN_PREFIX) || raw.length > 512) throw new Error(`--cursor-token 非法：${JSON.stringify(raw.slice(0, 40))}`);
  let obj = null;
  try { obj = JSON.parse(Buffer.from(raw.slice(CURSOR_TOKEN_PREFIX.length), 'base64url').toString('utf8')); } catch (e) {
    throw new Error('--cursor-token 非法（base64/JSON 解码失败）');
  }
  if (!obj || typeof obj.s !== 'string' || !obj.s) throw new Error('--cursor-token 非法（缺 snapshotId）');
  if (!Number.isInteger(obj.o) || obj.o < 0) throw new Error('--cursor-token 非法（offset）');
  if (typeof obj.v !== 'string') throw new Error('--cursor-token 非法（viewHash）');
  return { snapshotId: obj.s, offset: obj.o, viewHash: obj.v };
}

/**
 * 游标切片（纯函数）：返回当前页 + 下一页 offset（null=末页）。
 */
function pageSlice(items, offset, size) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, total));
  const n = Math.max(1, Number.isInteger(size) ? size : DEFAULT_CURSOR_SIZE);
  const end = Math.min(total, start + n);
  return { items: list.slice(start, end), offset: start, size: end - start, total, next: end < total ? end : null };
}

/* ── 基线 / 落盘 IO ──────────────────────────────────────────────────────── */

/** 基线路径（paths.A11Y_BASELINE_DIR 单源；targetId 净化防路径注入；dir=测试接缝） */
function baselinePath(targetId, dir) {
  const safe = String(targetId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir || paths.A11Y_BASELINE_DIR, `${safe || 'unknown'}.json`);
}

function readBaseline(targetId, dir) {
  const file = baselinePath(targetId, dir);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  try {
    const b = JSON.parse(raw);
    if (!b || b.format !== BASELINE_FORMAT || !Array.isArray(b.rows)) return null;
    b.file = file;
    return b;
  } catch (e) { return null; }
}

/** 原子写（tmp+rename）：并发读不会看到半截 JSON。失败抛错（调用方转 baselineError，不阻断快照）。 */
function writeBaseline(targetId, payload, opts) {
  const o = opts || {};
  const dir = o.dir || paths.A11Y_BASELINE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = baselinePath(targetId, dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = Object.assign({ format: BASELINE_FORMAT, at: time.isoLocal() }, payload || {});
  fs.writeFileSync(tmp, JSON.stringify(body) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 快照稳定 ID（内容哈希；bounds 不算内容） */
function snapshotIdOf(targetId, generation, rows) {
  const parts = [String(targetId || ''), String((generation && generation.loaderId) || '')];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    parts.push(`${row && row.depth}|${rowSignature(row)}|${row && Array.isArray(row.framePath) ? row.framePath.join('>') : ''}`);
  }
  return sha1Short(parts.join('\n'), ID_LEN);
}

/** --out 落盘（返回绝对路径；失败抛错） */
function writeSnapshotFile(file, payload) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('--out 缺值（需要文件路径）');
  const abs = path.resolve(file.trim());
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = Object.assign({ format: SNAPSHOT_FORMAT, at: time.isoLocal() }, payload || {});
  fs.writeFileSync(abs, JSON.stringify(body) + '\n', 'utf8');
  return abs;
}

module.exports = {
  BASELINE_FORMAT, SNAPSHOT_FORMAT, DEFAULT_CURSOR_SIZE, MAX_CURSOR_SIZE,
  FIND_CONTEXT_LINES, DIFF_RATIO_THRESHOLD, CURSOR_TOKEN_PREFIX,
  // 纯函数
  compact, rowLabel, normalizeFindPattern, findMatcher, searchTextOf, buildFindHits,
  rowSignature, buildRowKeys, optionsKeyOf, diffComparability, diffSnapshots,
  cursorViewKind, cursorViewHash, encodeCursorToken, decodeCursorToken, pageSlice,
  snapshotIdOf,
  // IO
  baselinePath, readBaseline, writeBaseline, writeSnapshotFile,
};
