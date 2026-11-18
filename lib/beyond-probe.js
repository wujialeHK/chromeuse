'use strict';
/*
 * chromeuse lib/beyond-probe.js —— Page.captureScreenshot{captureBeyondViewport} 运行时能力探测（ISSUE-1，2026-11-18）
 *
 * 机制单源（scroll-shot A 路径 legacy 回退的唯一判据来源；selftest #141 直测）：
 *   背景（Chrome 88.0.4324 实锤，TODO ISSUE-1）：clip{0,0,800,3000} + captureBeyondViewport true/false 两拍
 *   **md5 完全相同**，输出图含视口以下的 3228 行（只是全白）——即 88 **返回完整请求尺寸、视口外内容刷白**，
 *   不报错、不夹高。因此「单拍校验输出像素高 ≥ 请求高」**必然失效**（输出高=完整尺寸 → 误判支持 → 白屏照旧）。
 *
 *   探测原理（双拍对比，fail-safe）：
 *     P1 = 同 clip + captureBeyondViewport:true；P2 = 同 clip + captureBeyondViewport:false（均 format:'png'）。
 *     ① 尺寸差（P1 高 ≠ P2 高）→ **支持**（by='size'，确定性正判：现代 Chrome 可能夹到视口高）；
 *     ② 尺寸同 && md5 同 → **不支持**（by='md5'，两拍参数在浏览器侧等价被忽略的负判铁证）；
 *     ③ 尺寸同 && md5 异 → 歧义（页面在两拍间自身变化 vs 参数生效）→ **补第三拍 P3=true 自证**：
 *        - P3 md5 == P1 md5（控制稳定）→ 参数确实生效 → **支持**（by='md5'）；
 *        - P3 md5 ≠ P1 md5 → 页面在探测期变化 → **不确定**（按支持处理 + 不写缓存，下轮重探）；
 *     ④ 任一拍异常/超时 → **不确定**（by='timeout'，按支持处理 + 不写缓存）。
 *     方向恒 fail-safe：误判「不支持」→ 走 A2（段级撑视口无 clip），输出几何/内容仍正确，仅成本略增；
 *     误判「支持」只可能发生在歧义/异常路径（不写缓存、下轮重探），单轮最坏=回归现状。
 *     ⚠ 第三拍是对 oracle 双拍矩阵的**增强**（双拍在「尺寸同 + md5 异」时只能判不确定）：P2 实弹
 *       （Chrome 156，2026-11-18）证实现代 Chrome 的 beyond:false + 超视口 clip **不夹高**（输出完整尺寸、
 *       视口外刷白），双拍永远落在歧义态——不补控制拍则现代 Chrome 每轮都重探。控制拍只在歧义态才发，
 *       88/正常路径仍是两拍。
 *
 *   缓存（tmpdata/state/beyond-viewport.json，quota 分类归 other 永不自动删；手删即重探）：
 *     结构单对象 {capability, browserVersion, supported, by, probedAt, probe}；key 仅 browserVersion
 *     （能力是浏览器构建的确定属性；UA 可改且 Browser.getVersion 不受 UA 影响；取不到版本 → 探测照做但
 *     **不写缓存**，防串档）。readCache fail-soft（损坏/字段非法/版本不匹配 → null 重探，永不抛）；
 *     writeCache 原子写（同目录 tmp + rename）。无 TTL（能力不随时间漂移）。
 *
 * 依赖边界：本模块**不读 tmpdata 具体文件路径**——缓存目录由调用方注入（scroll-shot 传 paths.STATE_DIR，
 *   selftest 传 mkdtemp 临时目录；用户裁定：新断言零 live tmpdata 依赖）。pngSize 只读 PNG 头（探针强制
 *   png，无需 JPEG SOF 扫描）；md5 用 Node 内置 crypto。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('./log');

const CAPABILITY = 'captureBeyondViewport';
const CACHE_FILE = 'beyond-viewport.json';

/** PNG 头尺寸（纯函数）：签名 + IHDR 宽高（偏移 16/20）；非 PNG/过短 → null。
 *  先例=lib/annotate.js decodePng 的 IHDR 读取；探针强制 png，故不实现 JPEG SOF 扫描。 */
function pngSize(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** md5 十六进制（纯函数） */
function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** 单拍结果归一：{buf} 或预制 {size,md5} 或 {error} → {size,md5,error?}（不抛） */
function normShot(s) {
  if (!s) return { size: null, md5: null, error: 'missing' };
  if (s.error) return { size: null, md5: null, error: String(s.error) };
  let size = s.size === undefined ? null : s.size;
  let md5 = s.md5 === undefined ? null : s.md5;
  if (!size && s.buf) size = pngSize(s.buf);
  if (!md5 && s.buf) md5 = md5Hex(s.buf);
  return { size: size || null, md5: md5 || null, error: null };
}

/**
 * 判定矩阵（纯函数，selftest #141 直测）：两拍 + 可选控制拍。
 * @param {{buf?:Buffer,size?:{width,height},md5?:string,error?:string}} a P1(beyond:true)
 * @param {same} b P2(beyond:false)
 * @param {same} [control] P3(beyond:true，仅歧义态补拍) —— 缺省=纯双拍语义（歧义 → unknown）
 * @returns {{supported:true|false|'unknown', by:'size'|'md5'|'timeout',
 *            sizeP1:object|null, sizeP2:object|null, md5Eq:boolean, controlStable:boolean|null}}
 */
function judgeProbe(a, b, control) {
  const A = normShot(a);
  const B = normShot(b);
  const C = control ? normShot(control) : null;
  const out = {
    sizeP1: A.size, sizeP2: B.size,
    md5Eq: !!(A.md5 && B.md5 && A.md5 === B.md5),
    controlStable: C ? !!(A.md5 && C.md5 && A.md5 === C.md5) : null,
  };
  if (A.error || B.error || (C && C.error)) return Object.assign(out, { supported: 'unknown', by: 'timeout' });
  // ① 尺寸差 = 确定性正判（不受页面动画影响）
  if (A.size && B.size && (A.size.height !== B.size.height || A.size.width !== B.size.width)) {
    return Object.assign(out, { supported: true, by: 'size' });
  }
  // ② 两拍字节全同 = 参数被整体忽略（Chrome 88 实锤形态）
  if (out.md5Eq) return Object.assign(out, { supported: false, by: 'md5' });
  // ③ 歧义态：仅当控制拍证明页面静止（P3==P1）才判参数生效
  if (out.controlStable === true) return Object.assign(out, { supported: true, by: 'md5' });
  return Object.assign(out, { supported: 'unknown', by: 'md5' });
}

/** 单拍（绝不抛：异常收敛为 {error}，由 judgeProbe 归 unknown） */
async function shotOnce(client, sessionId, clip, beyond, timeoutMs) {
  try {
    const r = await client.send('Page.captureScreenshot', {
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
      captureBeyondViewport: beyond,
      format: 'png',
    }, { sessionId, timeoutMs });
    if (!r || !r.data) return { error: 'empty-data' };
    return { buf: Buffer.from(String(r.data), 'base64') };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * 双拍探测编排（+ 歧义态第三拍）：client/sessionId/clip 注入；永不抛（异常 → unknown）。
 * @param {{client:object, sessionId:string, clip:{x:number,y:number,width:number,height:number},
 *          timeoutMs?:number}} opts
 * @returns {{supported:true|false|'unknown', by:'size'|'md5'|'timeout',
 *            summary:{requestH:number, sizeP1:object|null, sizeP2:object|null, md5Eq:boolean, controlStable:boolean|null, shots:number}}}
 */
async function probeBeyondViewport(opts) {
  const o = opts || {};
  const clip = o.clip;
  const timeoutMs = o.timeoutMs || 30000;
  if (!o.client || !o.sessionId || !clip) {
    return { supported: 'unknown', by: 'timeout', summary: { requestH: clip ? clip.height : null, sizeP1: null, sizeP2: null, md5Eq: false, controlStable: null, shots: 0 } };
  }
  const p1 = await shotOnce(o.client, o.sessionId, clip, true, timeoutMs);
  const p2 = await shotOnce(o.client, o.sessionId, clip, false, timeoutMs);
  let ctl = null;
  let shots = 2;
  const prelim = judgeProbe(p1, p2);
  // 歧义态（尺寸同 + md5 异 + 两拍都成功）才补控制拍：区分「页面动画」与「参数生效」
  if (prelim.supported === 'unknown' && prelim.by === 'md5' && !p1.error && !p2.error) {
    ctl = await shotOnce(o.client, o.sessionId, clip, true, timeoutMs);
    shots = 3;
  }
  const judged = judgeProbe(p1, p2, ctl);
  return {
    supported: judged.supported,
    by: judged.by,
    summary: {
      requestH: clip.height,
      sizeP1: judged.sizeP1,
      sizeP2: judged.sizeP2,
      md5Eq: judged.md5Eq,
      controlStable: judged.controlStable,
      shots,
    },
  };
}

/** 读缓存（fail-soft 永不抛）：文件缺失/损坏/能力或版本不匹配/字段非法 → null（= miss 重探） */
function readCache(dir, version) {
  if (!dir || version == null || version === '') return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(String(dir), CACHE_FILE), 'utf8'));
    if (!j || j.capability !== CAPABILITY) return null;
    if (String(j.browserVersion || '') !== String(version)) return null;
    if (typeof j.supported !== 'boolean') return null;
    return j;
  } catch { return null; }
}

/** 写缓存（原子写：同目录 tmp + rename；目录随用随建）。返回文件路径。 */
function writeCache(dir, entry) {
  if (!dir) throw new Error('beyond-probe：缓存目录未指定');
  fs.mkdirSync(String(dir), { recursive: true });
  const file = path.join(String(dir), CACHE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 能力解析（缓存 → 探测）：返回 {supported:boolean, judged:true|false|'unknown', by, cached, version, probe}。
 * - 缓存命中（版本 key 相同）→ 零 CDP 探测；
 * - 缓存 miss → 探测；仅**确定性**结论（supported 布尔）写缓存，unknown 不写（防毒化缓存把一次性抖动固化）；
 * - version 缺失 → 探测照做但不读不写缓存（无 key 防串档）。
 * @param {{client,sessionId,clip,timeoutMs?,cacheDir?,version?:string|Function,probe?:Function}} opts
 */
async function detectBeyondSupport(opts) {
  const o = opts || {};
  let version = o.version;
  if (typeof version === 'function') {
    try { version = await version(); } catch { version = null; }
  }
  version = version == null ? null : String(version);
  if (version && o.cacheDir) {
    const hit = readCache(o.cacheDir, version);
    if (hit) {
      return { supported: !!hit.supported, judged: !!hit.supported, by: 'cache', cached: true, version, probe: hit.probe || null };
    }
  }
  const probeFn = typeof o.probe === 'function' ? o.probe : probeBeyondViewport;
  let r;
  try {
    r = await probeFn({ client: o.client, sessionId: o.sessionId, clip: o.clip, timeoutMs: o.timeoutMs });
  } catch (e) {
    r = { supported: 'unknown', by: 'timeout', summary: { error: String((e && e.message) || e).slice(0, 200) } };
  }
  if (!r || (r.supported !== true && r.supported !== false && r.supported !== 'unknown')) {
    r = { supported: 'unknown', by: 'timeout', summary: null };
  }
  const supported = r.supported === 'unknown' ? true : r.supported; // fail-open
  const out = { supported, judged: r.supported, by: r.by || 'timeout', cached: false, version, probe: r.summary || null };
  if (r.supported !== 'unknown' && version && o.cacheDir) {
    try {
      writeCache(o.cacheDir, {
        capability: CAPABILITY,
        browserVersion: version,
        supported,
        by: out.by,
        probedAt: new Date().toISOString(),
        probe: out.probe,
      });
    } catch (e) {
      log.warn('beyond-probe', `探测结果缓存写入失败：${e.message}（不影响本轮截图）`);
    }
  }
  return out;
}

module.exports = {
  CAPABILITY, CACHE_FILE,
  pngSize, md5Hex, judgeProbe, probeBeyondViewport, readCache, writeCache, detectBeyondSupport,
  // 纯函数直测面（selftest #141；仅供测试，业务代码勿依赖）
  _internals: { normShot },
};
