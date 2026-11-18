'use strict';
/*
 * chromeuse lib/screenshot.js —— 截图通道加固 + 失败诊断矩阵 + 冷启动退避（V202609220002）
 *
 * 来源：TODO【截图通道兜底体系完善】①②④（③ screencast 帧兜底随行），知识源 = references/facts.md
 * 「截图失败归因与 fromSurface 双路径」节（GPT 方案摘录 2026-09-19）：
 * - 截图失败 ≠ 合成器冻结的等价替换——截图依赖完整视觉输出链（Renderer→Paint→Compositor→GPU/Surface→
 *   CDP 传输），任一环异常都可致败；fromSurface:true（Surface 合成输出）与 :false（View 路径）是两条
 *   不同截图路径，行为可分化。
 * - 判读（单源 judgeMatrix）：runtime 通而截图败 = 截图路径异常；runtime 也败 = 更广泛阻塞；
 *   双路径分化 = 路径兼容问题。降级须由诊断裁决（allowFallback），禁止无条件切换。
 *
 * 链路（V202609130003 既有语义原样保留 + 只增不改）：
 *   ① attempt(fromSurface:true)×2（bringToFront 前置 + 300ms 重试 1 次——原语义）
 *   ② 仍败：三只读探针（Runtime.evaluate('1+1') / Page.getLayoutMetrics / fromSurfaceTrue 记录）
 *      → judgeMatrix 裁决 allowFallback（runtime ok 才降级——主线程冻结时 View 路径同源必死，降级无意义）
 *   ① allowFallback=true → attempt(fromSurface:false)；成 = via 标注返回（双路径分化=重要诊断信号）
 *   ④ runtimeCheck=ok（主线程活、非冻结）→ 疑似冷启动/合成器停滞（09-21 INBOX 判别法同源：先对照
 *      screenshot 其他既有页区分全局 vs 新 tab 冷启动）→ 退避重试：默认 2s/5s/10s 三档（总窗 17s <
 *      20s 自愈窗纪律，09-08 实测自愈 ~20s；env CHROMEUSE_SCREENSHOT_BACKOFF = 逗号分隔 ms 档位可配，
 *      零依赖解析范式同 lib/time.js tzOffset；总窗硬帽 5min——冷启动自愈观测 ~5min 上限）。每档前
 *      Runtime 轻探针复查——runtime 转死（冻结展开）立即中止退避；退避开始前对另一个既有 page target
 *      做一次对照截图（有标签置前副作用，同 doctor 探针口径如实标注）。全部用尽仍败 → 抛错并携带
 *      e.matrix 全矩阵，由调用方出失败报告（tools/cdp.js cmdScreenshot → chromeuse-screenshot-fail/1）。
 *
 * ③ screencast 活跃帧兜底（advisory）：截图最终失败时 latestLiveFrame() 扫 tmpdata/video/ 下各会话的
 *   index.json（lib/screencast.js 帧实时落盘——本模块只读磁盘，不改其接口零耦合）；saveFrame() 落兜底产物，
 *   bin/ffmpeg 可用则 jpeg→png 真转码，否则原字节 .jpg 直存（如实扩展名——证据不谎报容器格式）。
 *   ⚠ 边界如实：screencast 帧与截图同源（都是合成器视觉输出）——合成器冻结期帧流同死，本兜底只覆盖
 *   「冻结前已有帧」场景；帧龄如实标注，清晰度/时效弱于实时截图（advisory 定位）。
 *
 * ⑤ 截图增强（V202610210001；TODO【screenshot 增强：--dpr/--viewport/--format/--quality】B2/B3）：
 *   问题：MCP take_screenshot 的 DPR/视口不生效——输出宽度按窗口算（2160/2856 与请求 DPR 无关），
 *   resize_page(1440) 后 innerWidth 仍 1920（窗口尺寸不受页面侧控制）。治本 = Emulation.setDeviceMetricsOverride
 *   显式覆盖视口/DPR，截图后 clearDeviceMetricsOverride **finally 还原**。
 *   ⚠ 与 V202609080010「不默认 emulate」不冲突：仅在用户显式传 --dpr/--viewport 时施加；不传旗标 = 全程
 *   零 Emulation 命令（默认行为零改变，selftest #81 行为断言守护）。
 *   施加后读 window.innerWidth/devicePixelRatio 校验生效，不符 → 输出如实标注 mismatch（不谎报成功）；
 *   还原后读回 innerHeight/innerWidth/DPR 复核，漂移/clear 失败 → log.warn 如实报。
 *   --format png|jpeg + --quality 0~100：透传 Page.captureScreenshot（quality 仅 jpeg 携带，png 忽略+告警）；
 *   输出扩展名按 format 决定（--out 扩展名不一致 → 改写+告警，证据文件不谎报编码）。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const log = require('./log');
const platform = require('./platform');

const sleep = require('./time').sleep; // 通用延迟单源 lib/time.js

const DEFAULT_BACKOFF = [2000, 5000, 10000]; // 总窗 17s < 20s 自愈窗纪律（09-08 实测自愈 ~20s 级）
const BACKOFF_TOTAL_CAP_MS = 300000;         // 总窗硬帽 5min（09-21 冷启动自愈观测 ~5min 上限）
const BACKOFF_SEG_CAP_MS = 60000;            // 单档上限（防误传巨值一档吃光总窗）
const PROBE_MSG_CAP = 80;                    // 诊断矩阵 error:<msg> 截断长度

/** 探针结果归一（纯函数）：无错='ok'；kind=timeout→'timeout'；其余='error:<msg截断80>'——诊断矩阵值域 */
function fmtProbeErr(e) {
  if (!e) return 'ok';
  if (e.kind === 'timeout') return 'timeout';
  return 'error:' + String((e && e.message) || e).slice(0, PROBE_MSG_CAP);
}

/**
 * 诊断矩阵裁决（纯函数；facts.md 判读矩阵代码化单源）。
 * @param m {{runtimeCheck, layoutMetricsCheck, fromSurfaceTrue, fromSurfaceFalse?}} fmtProbeErr 值域
 * @returns {{allowFallback: boolean, coldStartSuspect: boolean, verdicts: string[]}}
 *   - allowFallback：runtimeCheck==='ok' 才允许 fromSurface:false 降级（runtime 也败=更广泛阻塞，
 *     View 路径同源必死——禁止无条件切换，facts.md 铁律）
 *   - coldStartSuspect：runtimeCheck==='ok'（主线程活、非冻结 → 疑似冷启动/合成器停滞 → ④退避资格）
 *   - verdicts：'screenshot-path'（runtime 通而截图败=截图路径异常）｜'broad-block'（runtime 也败=
 *     更广泛阻塞）｜'path-divergence'（双路径分化=路径兼容问题；需 fromSurfaceFalse 已知才可判）
 */
function judgeMatrix(m) {
  const runtimeOk = m.runtimeCheck === 'ok';
  const verdicts = [runtimeOk ? 'screenshot-path' : 'broad-block'];
  // 双路径分化：true 败而 false 成——两条截图路径行为分化=路径兼容问题（facts.md 诊断信号）
  if (runtimeOk && m.fromSurfaceTrue !== 'ok' && m.fromSurfaceFalse === 'ok') verdicts.push('path-divergence');
  return { allowFallback: runtimeOk, coldStartSuspect: runtimeOk, verdicts };
}

/**
 * 退避档位解析（纯函数；env 注入范式同 lib/time.js tzOffset——参数 env 供单测注入）。
 * CHROMEUSE_SCREENSHOT_BACKOFF = 逗号分隔 ms 档位（如 "2000,5000,10000"）；非法/越界段丢弃，
 * 全非法/缺省回退默认 2s/5s/10s；单档帽 60s、总窗硬帽 5min（超帽从尾截断——先快后慢纪律）。
 * @returns {{delays:number[], totalMs:number}}
 */
function backoffSchedule(env) {
  const raw = (env || process.env).CHROMEUSE_SCREENSHOT_BACKOFF;
  let delays = DEFAULT_BACKOFF;
  if (raw != null && String(raw).trim() !== '') {
    const parsed = String(raw).split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= BACKOFF_SEG_CAP_MS)
      .slice(0, 10);
    if (parsed.length) delays = parsed;
  }
  const capped = [];
  let total = 0;
  for (const d of delays) { if (total + d > BACKOFF_TOTAL_CAP_MS) break; capped.push(d); total += d; }
  return { delays: capped, totalMs: total };
}

/* ── ⑤ 显式视口/DPR/编码增强的纯函数层（V202610210001；selftest #81 直测） ── */
const DPR_MIN = 1, DPR_MAX = 4;          // --dpr 合法域（1=原生 CSS px，2 起步=Retina 级；>4 无实际收益且易被浏览器钳制）
const VIEWPORT_CAP = 10000;              // 单边上限（防误传巨值把合成器打爆）
const QUALITY_MIN = 0, QUALITY_MAX = 100;
const DEFAULT_JPEG_QUALITY = 90;         // jpeg 缺省质量**显式**落值（不依赖 Chrome 默认，保证可复现）
const JPEG_QUALITY_ENV = 'CHROMEUSE_JPEG_QUALITY';

/** 参数错误（kind=usage）：非法旗标值一律明确报错，不静默忽略 */
function usageErr(msg) { const e = new Error(msg); e.kind = 'usage'; return e; }

/**
 * 视口串解析（纯函数）：`750x900` / `750X900` / `750 x 900` → {width:750,height:900}；
 * 非法（缺高、非数字、0/负、超单边上限、布尔旗标）→ 抛 usage 错误（明确报错，不静默忽略）。
 */
function parseViewport(spec) {
  if (typeof spec === 'boolean') throw usageErr('--viewport 需要 WxH 值（如 --viewport 750x900），不能是布尔旗标');
  const s = String(spec == null ? '' : spec).trim();
  const m = /^(\d{1,6})\s*[xX]\s*(\d{1,6})$/.exec(s);
  if (!m) throw usageErr(`--viewport 格式非法：${JSON.stringify(spec)}（应为 WxH，如 750x900）`);
  const width = parseInt(m[1], 10), height = parseInt(m[2], 10);
  if (!(width > 0 && height > 0)) throw usageErr(`--viewport 尺寸须 >0：${JSON.stringify(spec)}`);
  if (width > VIEWPORT_CAP || height > VIEWPORT_CAP) throw usageErr(`--viewport 单边不得超过 ${VIEWPORT_CAP}：${JSON.stringify(spec)}`);
  return { width, height };
}

/**
 * 指标覆盖计划（纯函数）：无 --dpr 且无 --viewport → **null = 不施加**（默认零 Emulation 的分支闸门）。
 * @param {{dpr?, viewport?, current?}} input current={width,height,devicePixelRatio}（当前视口实测，可选；
 *   缺省时 width/height/deviceScaleFactor 可能为 null，由 materializePlan 在运行期补齐）
 * @returns {null|{width:number|null,height:number|null,deviceScaleFactor:number|null,mobile:false}}
 *   来源优先级：width/height = --viewport > current；deviceScaleFactor = --dpr > current.devicePixelRatio
 *   （只给 --viewport 时继承原生 DPR，不偷偷降级成 1）。
 *   --dpr 合法域 1~4；非法/布尔旗标 → usage 错误（明确报错，不静默）。
 */
function metricsPlan(input) {
  const o = input || {};
  // 显式旗标即进入校验：空串（--dpr= / --viewport=）同样按非法处理，不静默忽略
  const hasDpr = o.dpr !== undefined && o.dpr !== null;
  const hasViewport = o.viewport !== undefined && o.viewport !== null;
  if (!hasDpr && !hasViewport) return null;
  let dsf = null;
  if (hasDpr) {
    if (typeof o.dpr === 'boolean') throw usageErr('--dpr 需要数值（如 --dpr 3），不能是布尔旗标');
    const n = Number(o.dpr);
    if (!Number.isFinite(n) || n < DPR_MIN || n > DPR_MAX) throw usageErr(`--dpr 须为 ${DPR_MIN}~${DPR_MAX} 的数值：${JSON.stringify(o.dpr)}`);
    dsf = n;
  }
  const dims = hasViewport ? parseViewport(o.viewport) : null;
  const cur = o.current || null;
  const curW = cur && Number.isFinite(Number(cur.width)) ? Math.round(Number(cur.width)) : null;
  const curH = cur && Number.isFinite(Number(cur.height)) ? Math.round(Number(cur.height)) : null;
  const curDprNum = cur ? Number(cur.devicePixelRatio != null ? cur.devicePixelRatio : cur.dpr) : NaN;
  const curDpr = Number.isFinite(curDprNum) && curDprNum > 0 ? curDprNum : null;
  return {
    width: dims ? dims.width : curW,
    height: dims ? dims.height : curH,
    deviceScaleFactor: dsf != null ? dsf : curDpr,
    mobile: false, // 只改栅格参数，不切换移动 UA/触屏语义（移动端长文只借窄视口宽度）
  };
}

/**
 * 运行期补齐（纯函数）：把 metricsPlan 的 null 位（当前视口未知时）用 pre 实测值填满并最终校验；
 * 仍缺 → usage 错误（无法确定视口/DPR 时宁可响亮失败，也不静默忽略用户显式请求）。
 */
function materializePlan(plan, current) {
  if (!plan) return null;
  const pre = current || {};
  const width = plan.width != null ? plan.width : Math.round(Number(pre.width));
  const height = plan.height != null ? plan.height : Math.round(Number(pre.height));
  const dsf = plan.deviceScaleFactor != null ? plan.deviceScaleFactor : Number(pre.devicePixelRatio != null ? pre.devicePixelRatio : pre.dpr);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw usageErr('无法确定叠加视口尺寸（--viewport 未给且当前视口读取无效）');
  if (!Number.isFinite(dsf) || dsf <= 0) throw usageErr('无法确定 deviceScaleFactor（--dpr 未给且当前 DPR 读取无效）');
  return { width, height, deviceScaleFactor: dsf, mobile: false };
}

/**
 * jpeg 缺省质量解析（纯函数；env 注入范式同 backoffSchedule）：显式 --quality > env CHROMEUSE_JPEG_QUALITY > 90。
 * env 非法值（非 0~100 整数）**忽略并回传 warn**（不失败——取证优先），已在 formatPlan 里统一消费。
 * @returns {{quality:number, source:'explicit'|'env'|'default', warn:string|null}}
 */
function resolveJpegQuality(env) {
  const src = env || process.env;
  const raw = src && src[JPEG_QUALITY_ENV];
  if (raw == null || String(raw).trim() === '') return { quality: DEFAULT_JPEG_QUALITY, source: 'default', warn: null };
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < QUALITY_MIN || n > QUALITY_MAX) {
    return { quality: DEFAULT_JPEG_QUALITY, source: 'default', warn: `${JPEG_QUALITY_ENV}=${JSON.stringify(raw)} 非法（需 ${QUALITY_MIN}~${QUALITY_MAX} 整数）→ 忽略，回落默认 ${DEFAULT_JPEG_QUALITY}` };
  }
  return { quality: n, source: 'env', warn: null };
}

/**
 * 编码计划（纯函数）：--format png|jpeg（`jpg` 归一为 jpeg；缺省 png）；--quality 0~100 **仅 jpeg 生效**。
 * jpeg 缺省质量 = **显式默认 90**（解析顺序 --quality > env CHROMEUSE_JPEG_QUALITY > 90；env 非法忽略并 warn）
 * ——不再依赖 Chrome 默认，保证跨版本可复现；`--quality 0` 是合法值（显式判定，绝不被 falsy 吞掉）。
 * png 传 quality 无意义（Chrome 忽略该参数）：策略 = **忽略并如实告警**（qualityIgnored=true 由调用方打印），
 * 不让无关参数把截图搞失败；非法 format/quality 一律 usage 报错（明确，不静默）。
 * @param input {{format?, quality?, env?}} env 供单测注入（缺省 process.env）
 * @returns {{format, quality, qualityIgnored, qualitySource, qualityWarn}}
 */
function formatPlan(input) {
  const o = input || {};
  if (typeof o.format === 'boolean') throw usageErr('--format 需要值（png|jpeg），不能是布尔旗标');
  const raw = o.format === undefined || o.format === null || o.format === '' ? 'png' : String(o.format).toLowerCase();
  const format = raw === 'jpg' ? 'jpeg' : raw;
  if (format !== 'png' && format !== 'jpeg') throw usageErr(`--format 仅支持 png|jpeg：${JSON.stringify(o.format)}`);
  let quality = null, qualityIgnored = false, qualitySource = null, qualityWarn = null;
  const hasQ = o.quality !== undefined && o.quality !== null && o.quality !== '';
  if (hasQ) {
    if (typeof o.quality === 'boolean') throw usageErr('--quality 需要数值（0~100），不能是布尔旗标');
    const q = Number(o.quality);
    if (!Number.isInteger(q) || q < QUALITY_MIN || q > QUALITY_MAX) throw usageErr(`--quality 须为 ${QUALITY_MIN}~${QUALITY_MAX} 整数：${JSON.stringify(o.quality)}`);
    if (format === 'png') qualityIgnored = true; // png 无损无 quality 语义 → 忽略+告警（不让无关参数失败）
    else { quality = q; qualitySource = 'explicit'; }
  } else if (format === 'jpeg') {
    // 缺省不靠 Chrome 默认：显式 90（env 可像素级覆盖，非法值忽略并 warn）
    const r = resolveJpegQuality(o.env);
    quality = r.quality;
    qualitySource = r.source;
    qualityWarn = r.warn;
  }
  return { format, quality, qualityIgnored, qualitySource, qualityWarn };
}

/**
 * 输出路径策略（纯函数）：扩展名以 --format 为准——不给 --out 时生成 screenshot-<stamp>.<png|jpg>；
 * 给 --out 且扩展名与 format 一致 → 原样；不一致/缺失 → **改写/补**正确扩展名并返回 note 供调用方告警
 * （策略说明：宁可路径变一点，也不让扩展名与真实编码不符——取证文件不谎报格式）。
 */
function planOutPath(input) {
  const o = input || {};
  const format = o.format === 'jpeg' ? 'jpeg' : 'png';
  const ext = format === 'jpeg' ? '.jpg' : '.png';
  if (!o.out) return { file: path.join(o.eventsDir, `screenshot-${o.stamp}${ext}`), note: null };
  const out = String(o.out);
  const cur = path.extname(out);
  if (!cur) return { file: out + ext, note: `--out 无扩展名 → 按 --format ${format} 补 ${ext}` };
  const match = format === 'jpeg' ? /^\.jpe?g$/i.test(cur) : /^\.png$/i.test(cur);
  if (match) return { file: out, note: null };
  return { file: out.slice(0, out.length - cur.length) + ext, note: `--out 扩展名 ${cur} 与 --format ${format} 不一致 → 改写为 ${ext}（避免扩展名谎报编码）` };
}

/** 三只读探针之一发：Runtime.evaluate('1+1')（主线程活性）+ Page.getLayoutMetrics（Page 域健康，
 *  不依赖合成器/Surface）——零副作用，结果按 fmtProbeErr 值域归一 */
async function probeHealth(client, sessionId, timeoutMs) {
  const m = {};
  try { await client.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, { sessionId, timeoutMs }); m.runtimeCheck = 'ok'; }
  catch (e) { m.runtimeCheck = fmtProbeErr(e); }
  try { await client.send('Page.getLayoutMetrics', {}, { sessionId, timeoutMs }); m.layoutMetricsCheck = 'ok'; }
  catch (e) { m.layoutMetricsCheck = fmtProbeErr(e); }
  return m;
}

/** 对照截图（④；09-21 INBOX 判别法机制化）：对另一个既有 page 型 target 做一次硬通道试拍——
 *  成功 = 非全局死、冷启动置信度提升；失败 = 全局截图通道异常嫌疑（非单纯冷启动）。
 *  ⚠ 有标签置前副作用（bringToFront，同 doctor screenshotProbe 口径，如实标注）。fail-soft 恒返回。 */
async function controlShot(client, currentTargetId, timeoutMs) {
  try {
    const tg = await client.send('Target.getTargets', {}, { timeoutMs });
    const others = (((tg || {}).targetInfos) || []).filter((t) => t && t.type === 'page' && t.targetId !== currentTargetId);
    if (!others.length) return { controlShot: 'skipped', controlNote: '无其他既有 page target 可对照（单标签环境）' };
    const sid = await client.attach(others[0].targetId, timeoutMs);
    await client.send('Page.bringToFront', {}, { sessionId: sid, timeoutMs });
    await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: sid, timeoutMs });
    return {
      controlShot: 'ok',
      controlNote: `既有 tab（${String(others[0].url || '').slice(0, 60)}）可截 = 非全局死，冷启动/当前 tab Surface 停滞置信度提升；对照目标已被置前（副作用，如实标注）`,
    };
  } catch (e) {
    return { controlShot: fmtProbeErr(e), controlNote: '对照截图失败 = 全局截图通道异常嫌疑（非单纯冷启动），结合 verdicts 研判' };
  }
}

/**
 * 读当前视口实测（⑤）：innerWidth/innerHeight/devicePixelRatio——施加前基线 + 生效校验 + 还原校验共用。
 */
const VIEWPORT_EXPR = '({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio })';
async function readMetrics(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', { expression: VIEWPORT_EXPR, returnByValue: true }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v) throw new Error('视口读取返回空值（Runtime.evaluate returnByValue 无 result.value）');
  return { width: Number(v.iw), height: Number(v.ih), dpr: Number(v.dpr) };
}

/**
 * 施加显式指标覆盖（⑤ beginEmulation）：无 --dpr/--viewport → 返回 null 且**零 Emulation 命令**
 * （默认行为零改变——V202609080010「不默认 emulate」红线）。施加后读回 innerWidth/DPR 校验生效，
 * 不符只记 mismatch 如实标注（不谎报成功，也不因此中断截图）。
 * 返回状态 {requested, plan, pre, post, mismatch, active, restore}；失败时错误挂 e.emulation=状态
 * （调用方仍能 clear——active=true 即「需要还原」）。
 */
async function beginEmulation(client, sessionId, opts, timeoutMs) {
  const o = opts || {};
  const plan = metricsPlan({ dpr: o.dpr, viewport: o.viewport });
  if (!plan) return null;
  const state = {
    requested: { dpr: o.dpr == null ? null : o.dpr, viewport: o.viewport == null ? null : o.viewport },
    plan: null, pre: null, post: null, mismatch: [], active: false, restore: null,
  };
  try {
    state.pre = await readMetrics(client, sessionId, timeoutMs);       // 基线（还原校验基准）
    state.plan = materializePlan(plan, state.pre);
    state.active = true; // 已决定下发：即使 set 超时/报错也要 clear（可能已生效——还原优先）
    await client.send('Emulation.setDeviceMetricsOverride', state.plan, { sessionId, timeoutMs });
    state.post = await readMetrics(client, sessionId, timeoutMs);      // 生效校验
    if (state.post.width !== state.plan.width) state.mismatch.push(`innerWidth=${state.post.width} ≠ 请求 ${state.plan.width}`);
    if (state.post.height !== state.plan.height) state.mismatch.push(`innerHeight=${state.post.height} ≠ 请求 ${state.plan.height}`);
    if (Math.abs(state.post.dpr - state.plan.deviceScaleFactor) > 0.001) state.mismatch.push(`devicePixelRatio=${state.post.dpr} ≠ 请求 ${state.plan.deviceScaleFactor}`);
    log.info('screenshot', `视口覆盖 ${state.plan.width}x${state.plan.height} @DPR ${state.plan.deviceScaleFactor}（实测 innerWidth=${state.post.width} innerHeight=${state.post.height} dpr=${state.post.dpr}${state.mismatch.length ? `；⚠ mismatch：${state.mismatch.join('；')}` : ' ✓'}）`, { echo: true });
  } catch (e) {
    if (e && typeof e === 'object') e.emulation = state;
    throw e;
  }
  return state;
}

/**
 * 还原显式指标覆盖（⑤ endEmulation；**必须由 finally 调用**——所有成功/失败路径都还原）：
 * clearDeviceMetricsOverride → 读回视口复核（innerWidth/innerHeight/DPR 与基线比对）；
 * clear 失败或读回漂移 → log.warn 如实报（state.restore.ok=false，不谎报已恢复）。
 */
async function endEmulation(client, sessionId, state, timeoutMs) {
  if (!state) return state;
  try {
    await client.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId, timeoutMs });
  } catch (e) {
    state.restore = { ok: false, error: `clearDeviceMetricsOverride 失败：${e.message}` };
    log.warn('screenshot', `视口覆盖还原失败：${e.message}——视口/DPR 可能仍被覆盖，需手工重置（刷新页面/重启浏览器）（请求=${JSON.stringify(state.requested)} 基线=${JSON.stringify(state.pre)}）`);
    return state;
  }
  try {
    const after = await readMetrics(client, sessionId, timeoutMs);
    const drift = [];
    if (state.pre) {
      if (after.width !== state.pre.width) drift.push(`innerWidth ${after.width} ≠ 原 ${state.pre.width}`);
      if (after.height !== state.pre.height) drift.push(`innerHeight ${after.height} ≠ 原 ${state.pre.height}`);
      if (Math.abs(after.dpr - state.pre.dpr) > 0.001) drift.push(`devicePixelRatio ${after.dpr} ≠ 原 ${state.pre.dpr}`);
    }
    state.restore = drift.length ? { ok: false, after, drift } : { ok: true, after };
    if (drift.length) {
      log.warn('screenshot', `视口覆盖还原后仍有漂移：${drift.join('；')}（如实标注，未恢复原状）`);
    }
  } catch (e) {
    state.restore = { ok: false, error: `还原读回失败：${e.message}` };
    log.warn('screenshot', `视口覆盖还原读回失败：${e.message}（clear 已下发，实际状态未验证）`);
  }
  return state;
}

/**
 * 截图加固主链（V202609130003 语义保留 + ①降级②诊断④退避；V202609220002）——**不负责视口覆盖/还原**，
 * 由 screenshotHardened 包装（覆盖生效期内跑完整条链，含 fromSurface:false 降级与退避重试，不被中途 clear）。
 * @param ctx {{timeoutMs, env, sleepFn, cap}} cap=formatPlan 产物（format/quality 透传到每一次 captureScreenshot）
 * @returns {{data: string, via: string, matrix: object, recoveredByBackoff?: boolean}}
 * @throws Error 且 e.matrix = 全诊断矩阵（runtimeCheck/layoutMetricsCheck/fromSurfaceTrue/
 *   fromSurfaceFalse/verdicts/controlShot/backoff），由调用方出失败报告
 */
async function screenshotChain(client, sessionId, ctx, opts) {
  const { timeoutMs, env, sleepFn, cap } = ctx;
  const attempt = async (fromSurface) => {
    await client.send('Page.bringToFront', {}, { sessionId, timeoutMs });
    const params = { format: cap.format, fromSurface };
    if (cap.quality != null) params.quality = cap.quality; // 仅 jpeg 携带（png 无 quality 语义，已在 formatPlan 过滤）
    const r = await client.send('Page.captureScreenshot', params, { sessionId, timeoutMs });
    return r.data;
  };
  const matrix = { runtimeCheck: null, layoutMetricsCheck: null, fromSurfaceTrue: null, fromSurfaceFalse: null };

  // ── ① 既有链路原样：首选 fromSurface:true（Surface 合成输出=协议默认路径显式化），败后 300ms 重试 1 次
  try { return { data: await attempt(true), via: 'fromSurface:true', matrix }; }
  catch (first) {
    log.warn('screenshot', `⚠ 首次截屏失败（${first.message}）——重新 bringToFront 后重试 1 次…`, { echo: true });
    await sleepFn(300); // 小间歇：给合成器喘息（自愈型冻结实测 ~20s 级，这里只让 300ms 不放大延迟）
    try { return { data: await attempt(true), via: 'fromSurface:true', matrix }; }
    catch (second) {
      // fromSurfaceTrue 取双败中更强的信号：任一次超时记 timeout（冷启动/冻结主导签名），否则记末次错误
      matrix.fromSurfaceTrue = (first.kind === 'timeout' || second.kind === 'timeout') ? 'timeout' : fmtProbeErr(second);
    }
  }

  // ── ② 诊断矩阵：同发只读探针（runtime 活性 / Page 域健康），判读注释见 judgeMatrix
  Object.assign(matrix, await probeHealth(client, sessionId, timeoutMs));
  const judge = judgeMatrix(matrix);
  log.warn('screenshot', `⚠ 截屏两连败——诊断矩阵：runtime=${matrix.runtimeCheck} layout=${matrix.layoutMetricsCheck} fromSurfaceTrue=${matrix.fromSurfaceTrue}；判读=${judge.verdicts.join('+')}`, { echo: true });

  // ── ① fromSurface:false 降级（View 路径）：allowFallback 由诊断裁决——runtime ok（截图路径异常
  //    非全局阻塞）才值得试；runtime 也败=更广泛阻塞，降级无意义，不切
  if (judge.allowFallback) {
    log.info('screenshot', '⚠ 诊断裁决 allowFallback=true（runtime 存活）——尝试 fromSurface:false（View 路径）…', { echo: true });
    try {
      const data = await attempt(false);
      matrix.fromSurfaceFalse = 'ok';
      matrix.verdicts = judgeMatrix(matrix).verdicts; // 复判：true 败 false 成 → 补 path-divergence
      return { data, via: 'fromSurface:false', matrix };
    } catch (e3) { matrix.fromSurfaceFalse = fmtProbeErr(e3); }
  } else {
    matrix.fromSurfaceFalse = 'not-attempted'; // 值域注记：ok/timeout/error:<msg> 之外的显式跳过标记
  }
  matrix.verdicts = judgeMatrix(matrix).verdicts;

  // ── ④ 冷启动停滞退避：runtimeCheck=ok（主线程活、非冻结）→ 疑似冷启动/合成器停滞（09-21 INBOX
  //    判别法同源：既有 tab 截图正常区分非全局死）。退避窗口总量 ≤ ~20s（默认 17s），env 可配。
  if (judge.coldStartSuspect) {
    const sched = backoffSchedule(env);
    Object.assign(matrix, await controlShot(client, opts && opts.targetId, timeoutMs)); // 对照截图一次，置信度入矩阵
    log.warn('screenshot', `⚠ runtime 存活 = 疑似冷启动/合成器停滞（对照截图=${matrix.controlShot}）——退避重试 ${JSON.stringify(sched.delays)}ms（总窗 ${sched.totalMs}ms；CHROMEUSE_SCREENSHOT_BACKOFF 可配）…`, { echo: true });
    const trace = [];
    let recovered = null;
    for (const delay of sched.delays) {
      await sleepFn(delay);
      const recheck = await probeHealth(client, sessionId, timeoutMs); // 轻探针复查：冻结展开即中止（等无意义）
      if (recheck.runtimeCheck !== 'ok') { trace.push({ afterMs: delay, aborted: 'runtime-dead', runtimeCheck: recheck.runtimeCheck }); break; }
      // 全链重试：true 优先；裁决允许且 true 仍败则 false 补试（双路径每档都给恢复机会）
      try { recovered = { data: await attempt(true), via: 'fromSurface:true' }; }
      catch {
        if (judge.allowFallback) { try { recovered = { data: await attempt(false), via: 'fromSurface:false' }; } catch { /* 本档仍败 */ } }
      }
      trace.push({ afterMs: delay, runtimeCheck: 'ok', shotOk: !!recovered });
      if (recovered) break;
    }
    matrix.backoff = { delays: sched.delays, totalMs: sched.totalMs, controlShot: matrix.controlShot, trace };
    if (recovered) return { data: recovered.data, via: recovered.via, matrix, recoveredByBackoff: true };
  }

  // ── 全部用尽仍败：失败错误携带全矩阵（调用方出 chromeuse-screenshot-fail/1 报告）
  const e = new Error(
    `截屏多路全败（fromSurface:true ${matrix.fromSurfaceTrue}｜false ${matrix.fromSurfaceFalse}｜runtime ${matrix.runtimeCheck}｜layout ${matrix.layoutMetricsCheck}）`
    + `——诊断矩阵见 e.matrix/失败报告；判读：runtime 通而截图败=截图路径异常｜runtime 也败=更广泛阻塞｜双路径分化=路径兼容问题；`
    + `fallback 建议：node tools/cdp.js exec 'Page.captureSnapshot' '{}' --target … 拿 DOM 快照（不依赖合成器），或 browser-restart 重置后重试`
  );
  e.kind = 'cdp';
  e.matrix = matrix;
  throw e;
}

/**
 * 截图统一入口：格式计划 + 显式视口/DPR 覆盖（beginEmulation → 整条加固链 → finally endEmulation）。
 * 默认（不传 --dpr/--viewport）与 V202609220002 行为逐字节一致——不发任何 Emulation 命令、不读视口。
 * @param opts {{timeoutMs?, targetId?, env?, sleepFn?, dpr?, viewport?, format?, quality?}}
 * @returns {{data, via, matrix, format, quality, qualityIgnored, emulation}}
 *   emulation=null（默认）或 {requested, plan, pre, post, mismatch, restore}（如实呈现生效/还原结果）
 */
async function screenshotHardened(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 5000;
  const ctx = {
    timeoutMs,
    env: o.env || process.env,
    sleepFn: o.sleepFn || sleep,
    cap: formatPlan({ format: o.format, quality: o.quality, env: o.env }), // 非法 format/quality 在建连动作前就明确报错
  };
  if (ctx.cap.qualityWarn) {
    log.warn('screenshot', `⚠ ${ctx.cap.qualityWarn}`, { echo: true });
  }
  let emu = null, thrown = null;
  try {
    try { emu = await beginEmulation(client, sessionId, o, timeoutMs); }
    catch (e) { if (e && e.emulation) emu = e.emulation; throw e; }
    const r = await screenshotChain(client, sessionId, ctx, o);
    return Object.assign(r, { format: ctx.cap.format, quality: ctx.cap.quality, qualitySource: ctx.cap.qualitySource, qualityIgnored: ctx.cap.qualityIgnored, emulation: emu });
  } catch (e) {
    thrown = e;
    throw e;
  } finally {
    // 还原闸门：成功/失败/抛错所有路径都走到这里（clear 后再把还原结果挂回 matrix，供失败报告如实呈现）
    if (emu) {
      await endEmulation(client, sessionId, emu, timeoutMs);
      if (thrown && thrown.matrix) thrown.matrix.emulation = emu;
    }
  }
}


/**
 * 活跃 screencast 帧发现（③；只读磁盘——不改 lib/screencast.js 接口零耦合）：扫 videoDir/<session>/
 * index.json（chromeuse-video/1，录屏帧实时落盘、index ~5s 节流覆写），返回 tArrive 距 now 不超
 * freshMs 的最近帧 { file, tab, tArrive, session }；无会话/帧超龄/文件缺失 → null。
 * 注：index 5s 节流意味着最新一帧可能尚未入索引——advisory 兜底可接受（如实语义：最近「已索引」帧）。
 */
function latestLiveFrame(videoDir, nowMs, freshMs) {
  let sessions = [];
  try { sessions = fs.readdirSync(videoDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return null; } // videoDir 不存在/不可读 = 从未开过 -v → 跳过兜底
  let best = null;
  for (const s of sessions) {
    let idx;
    try { idx = JSON.parse(fs.readFileSync(path.join(videoDir, s, 'index.json'), 'utf8')); } catch { continue; }
    for (const f of (Array.isArray(idx && idx.frames) ? idx.frames : [])) {
      if (!f || !f.file || !Number.isFinite(f.tArrive)) continue;
      if (nowMs - f.tArrive > freshMs || !fs.existsSync(f.file)) continue;
      if (!best || f.tArrive > best.tArrive) best = { file: f.file, tab: f.tab || '', tArrive: f.tArrive, session: s };
    }
  }
  return best;
}

/**
 * 兜底帧落盘（③）：bin/ffmpeg 可用 → jpeg→png 真转码（spec 口径 png 产物）；不可用/转码失败 →
 * 原字节 .jpg 直存（如实扩展名——证据文件不谎报容器格式，零依赖边界）。返回 { file, note }。
 * 路径解析单源 = lib/platform binaries provider（config.bin > 内置 bin/，含 .exe 探测——修 Windows 遗漏）；
 * 缺失时 note 附可操作 hint（下载/放置/config 键），不再静默。
 */
function saveFrame(frameFile, outFile) {
  const { spawnSync } = require('node:child_process');
  const stem = outFile.replace(/\.(png|jpe?g)$/i, '');
  const r = platform().binaries.resolve();
  const ffmpeg = r.ffmpeg;
  if (r.exists.ffmpeg) {
    const png = stem + '.png';
    try {
      fs.mkdirSync(path.dirname(path.resolve(png)), { recursive: true });
      const res = spawnSync(ffmpeg, ['-y', '-i', frameFile, png], { timeout: 15000 });
      if (!res.error && res.status === 0 && fs.existsSync(png)) {
        return { file: png, note: 'screencast 帧 ffmpeg 转码 png（清晰度/时效弱于实时截图——advisory 兜底，合成器冻结期帧流同死属边界）' };
      }
    } catch { /* 落 jpg 兜底 */ }
  }
  const jpg = stem + '.jpg';
  fs.mkdirSync(path.dirname(path.resolve(jpg)), { recursive: true });
  fs.copyFileSync(frameFile, jpg);
  const hint = r.exists.ffmpeg ? '' : (r.hint ? `；${r.hint}` : '');
  return { file: jpg, note: `screencast 原帧 jpeg 直存（bin/ffmpeg 不可用或转码失败——png 转码跳过，零依赖边界），advisory 兜底${hint}` };
}

module.exports = {
  DEFAULT_BACKOFF, BACKOFF_TOTAL_CAP_MS, DPR_MIN, DPR_MAX, VIEWPORT_CAP, QUALITY_MIN, QUALITY_MAX,
  DEFAULT_JPEG_QUALITY, JPEG_QUALITY_ENV,
  fmtProbeErr, judgeMatrix, backoffSchedule, probeHealth, controlShot,
  parseViewport, metricsPlan, materializePlan, resolveJpegQuality, formatPlan, planOutPath,
  readMetrics, beginEmulation, endEmulation, screenshotChain, screenshotHardened, latestLiveFrame, saveFrame,
};
