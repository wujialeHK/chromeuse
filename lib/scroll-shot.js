'use strict';
/*
 * chromeuse lib/scroll-shot.js —— scroll-shot 长图拼接子命令（V202610210002 → V202610210003 用户裁定批；TODO ④ 区新功能）
 *
 * 需求来源（竞品采集实测）：长文单页整页截图拿不全/拿不动——
 *   C1 23805 CSS px 整页截图报 "Unable to capture screenshot"；C2 不滚动直接截 img.src 为空（图片懒加载未触发）；
 *   C4 分段取高必须 min(屏高, 文档高-y)，否则末段重叠；C6 PNG 整页 ≈16MB；D1 超长单图在查看端被降采样
 *   → 物理切段 ≤4600px；B4 单页截图 120s 超时 → 分片；实测 1101×21354 单张可成、47610px 必须切段。
 *
 * 本模块职责（纯函数 + CDP 编排，零第三方依赖；CLI 接线在 tools/cdp.js cmdScrollShot）：
 *   ① 懒加载预热 prewarm()：逐屏向下滚动（步长 = 0.9 视口高）→ 每步等 settle → 到文档底部后
 *      「文档高度连续 3 次采样不变」判稳定（上限 prewarmSamples，默认 20）→ 回顶 → 等图片就绪
 *      （判据见 ①b；带超时；未就绪数量如实记 imagesPending，不谎报）。
 *   ①b 图片就绪判据（V202610210004 竞品采集实测修复，真源单点 classifyImg）：
 *      **旧判据 `complete && naturalWidth > 0` 是真 bug**——微信占位符 `<img class="rich_pages wxw-img
 *      js_img_placeholder" src="data:image/svg+xml,...">` 的 complete=true 且 **naturalWidth=1 > 0**，
 *      被判为"已加载"→ 等待循环立刻退出 → 长图中间留下 1000~20000px 纯白段（他方 140 篇实测）。
 *      新判据：占位符（data:image/svg 占位图 / class 含 js_img_placeholder / lazy 类且无内在尺寸 /
 *      complete 且 naturalWidth<=1 / 有 data-src 但 src 为空）→ 'placeholder'；
 *      **naturalWidth > 1** 且非占位符 → 'loaded'；其余 → 'pending'。
 *   ①c 强制 data-src 赋值（--img-promote，默认开；--no-img-promote 关）：预热前遍历 document.images，
 *      按 data-src → data-original → data-lazy-src → data-actualsrc → data-backsrc 取真源，仅当当前 src
 *      仍是占位/空时做**纯属性赋值** img.src = 值（不 dispatchEvent、不合成点击——红线 #1 不破），
 *      并打标 data-cu-promoted="1"。**先只读统计候选再赋值**；等待循环内允许补做一轮。
 *      ⚠ 现场影响如实标注：promote 改页面 DOM（图片开始真实加载）= 渲染加速，不改业务状态，但会触发
 *      真实网络图片请求；--no-img-promote 可关。需要说明的是它绕过了未触发的 IntersectionObserver——
 *      微信滚动本身不可靠（700px/180ms 慢滚到底仍有多张停占位符）。
 *   ①d 等待策略：promote 后按 --image-timeout（默认 5000）轮询到 pending=0 或超时；之后固定等
 *      --img-settle（默认 1800ms，覆盖 GIF 首帧解码；0 可关）再开始截图。
 *   ② 分段几何 planSlices()（纯函数）：y 从 0 起按 step=min(viewportH, chunkCss) 步进，
 *      段高 min(step, docH-y)（末段防重叠，C4）。step ≤ chunkCss ⇒ 任何文档都不会产出超长段。
 *      **单位双轨（V202610210003 用户裁定）**：--max-chunk 默认按**物理像素**（px）解释，
 *      chunkCss = floor(maxChunk / dpr)；--max-chunk-unit css 时 chunkCss = maxChunk（旧行为）。
 *      不变量：unit=px 时每段物理高 ≤ maxChunk（硬保证）；unit=css 时物理可超（用户显式选择）。
 *   ②b --overlap <css px>（默认 0）：**不改变切段位置**，非末段每张图向下多拍 overlap（captureHeight =
 *      cssHeight + overlap）；末段恒 0。0 适合机器消费/精确拼接，人工阅读长文用 8 左右避免文字被切点劈开。
 *   ②c --viewport-max-chunk（显式布尔）：运行期把视口高度 Emulation 成 chunkCss、宽度取 --viewport 的宽
 *      （未给则当前 innerWidth），使 step == viewportH（等价视口截图，规避 beyond-viewport 大 clip）。
 *      ⚠ 隐含显式 Emulation → finally 必将还原；不给该旗标时依旧零 Emulation 命令（红线不破）。
 *   ②d 切点吸附空白带（F15，**默认开**；--no-snap-cuts 关）：固定切点会把标题栏/产品卡拦腰截断。分段前
 *      **一次只读 evaluate**（RECTS_EXPR：只取「有直接文本节点的元素 + 替换元素」的文档坐标 rect，排除
 *      display:none / visibility:hidden / 零面积 / position:fixed|sticky）→ 纯函数 snapCuts 顺序推进：
 *      每刀以「上一刀 + step」为目标，在 ±--snap-window（默认 180 CSS px，32~512）内找「不与任何元素 rect
 *      相交的水平空白带」（最小宽度 12 CSS px），原切点已在带内则位移 0，否则取带中点并 clamp 到
 *      [prev+minSlice, prev+chunkCss] / [0, docH-lastMin]（minSlice=viewport/4，防极短段且不破每段 ≤chunkCss），
 *      clamp 后仍在带内才采纳，否则放弃该切点（method:'none'）。末段无切点 → 恒 'none'。
 *      清单：段级 snap{from,to,shift,method:dom|px|none}；顶层 snapConfig{enabled,windowPx,pxFallback}。
 *      **像素法兜底（--snap-px 显式开）**：DOM 该切点无合格带时，对已落盘当前段图跑 ⑦ 同款行剖面
 *      （连续 ≥12 CSS px 的行亮度 ≥ --blank-threshold），在段尾 ±window 的图内可见部分（向下仅 overlap 部分）
 *      找带定下一切点 → 本段 cssHeight/overlapPx 调整 + 尾部按新切点「滚动推进」重排（内容不丢，接缝重复
 *      量 = overlapPx）。ffmpeg 缺失/失败/无合格带 → fail-soft 回落原切点（只记 note）。dry-run 只算 DOM 法
 *      （无图不跑像素法，如实记 note）；吸附整体异常 → 全部原切点 + 日志一行告警 + 清单 note，不阻断截图。
 *      ⚠ 「只向短方向吸附」落地解读（待用户复核）：候选带∩窗口宽度 ≥12px；原切点已在带内 → 位移 0；
 *      否则取带中点，越窗口/越 minSlice/越 chunkCss 上界 → clamp 到边界，clamp 后不在带内 → 放弃。
 *      **三条 clamp 硬约束**（依据 `webapps/wechat-mp/webapp.md` L77 他方实测记录「只向短方向吸附（不为吸附
 *      把段拉长），终点 clamp 到文档高」）：① 吸附后任一段 cssHeight ≤ chunkCss（不为吸附把段拉长，段高不超
 *      max-chunk 计划值；step==chunkCss 时等价于只能上移）② 相邻段 ≥ viewport/4（防极短段，退化配置
 *      snapMinSlice 取 min(viewport/4, step) 兜底）③ 切点严格落在 (0, docHeight)（终点 clamp 到文档高）。
 *      违反即抛错，由 runScrollShot fail-soft 回落原切点。
 *   ③ 取图双路径（清单记录实际用了哪条）：
 *      A（首选，几何精确）滚到 y 后 Page.captureScreenshot{clip:{x:0,y,width,height:captureHeight,scale:1},
 *        captureBeyondViewport:true, format, quality} —— 单段 ≤ chunkCss 远低于实测失败阈值，通常成功；
 *      B（兜底，视口切片）逐视口高滚动截视口图 → bin/ffmpeg vstack（按实际 scrollY 求交裁剪，抗末段 clamp
 *        重叠）。ffmpeg/ffprobe 缺失 → **如实失败**（绝不产出错图）。
 *   ③c beyond-viewport legacy 回退（ISSUE-1，2026-11-18）：运行时双拍能力探测（机制/判定矩阵单源=
 *      lib/beyond-probe.js 头注释），长页惰性触发+按浏览器版本缓存；判定不支持且段 captureHeight ≤
 *      VIEWPORT_CAP 的段改走 A2（段级 beginEmulation 撑视口 → 无 clip 截图 → finally 恢复轮次覆盖），
 *      失败仍落 jpeg 降级 → B 兜底；清单 via=A|A2|B + 顶层 beyondProbe。
 *   ③a 重试/降级前重新落位（V202610220002 实弹 bug 修复）：Page.captureScreenshot 超时（重负载实测 90s 级）
 *      会扰动/丢失滚动位置——旧实现只在重试循环外滚一次，重试"成功"却可能拍到旧位置内容（实弹：段 2/3
 *      重复拍到同一个白块，仍记 via=A）。现每次 A 重试前 + jpeg 降级前都重新 shotScopedScroll（含 settle 与
 *      scrollY 读回校验）；次数如实记段 repositions 与顶层 scrollRepositions。断链（kind=disconnect）不滚
 *      （链路已死，滚也发不出去）——直接止损/降级，如实失败。
 *   ③b PNG 断链降级（V202610210003 用户裁定，默认开启，--no-format-fallback 可关）：
 *      PNG 超大段打挂 WS 的实测依据 = 1100×4600（5.06M px）打挂 / 1100×2000（2.2M px）正常。两层防护：
 *      ① 预防性告警：开跑前按 width×dpr × cssH×dpr 估算，> PNG_SAFE_PIXELS(3M) 且 format=png →
 *         打印明确告警 + 建议（改 jpeg / 减小 --max-chunk），**不改用户格式**；
 *      ② 失败后逐段降级：某段 A 两次失败（含 WS 断开类错误）→ format=png 时该段改 jpeg 重试一次
 *         （quality=默认 90），成功则清单记 format:'jpeg' + formatFallback:'png-fail'。
 *      降级后整轮仍中断 → 保持 failed/partial 语义并如实输出 missingSlices（不假装成功）。
 *      ⚠ 边界如实：**不做自动重连**——WS 断开后本工具止损（重连留后续）。
 *   ④ 体积/格式：默认 JPEG q90（C6 PNG 16MB）；png 忽略 quality 并告警（口径同 lib/screenshot.js formatPlan）。
 *   ⑤ 超时预算：--timeout 是**单段**截图超时（默认 30000，非整页）；总预算 = 段数 × 单段超时，超预算中止
 *      剩余段、status=partial 并保留已完成段清单。单段失败重试 1 次（同 shot 链路纪律），仍败→该段标 failed
 *      并继续下一段（不整轮报废），最后汇总 failedSlices。
 *   ⑥ 视口覆盖：只在显式 --dpr/--viewport 时走 lib/screenshot.js beginEmulation（红线 V202609080010
 *      「不默认 emulate」——无旗标全程零 Emulation 命令）；finally 单点 endEmulation + 滚动位置还原
 *      （还原失败如实记录，不谎报）。**不关闭用户页签**（解析出来的 target 不是自己开的）。
 *   ⑦ 空白段自检（F13，2026-10-22，**默认开且 advisory**）：每段落盘后用 bin/ffprobe 取高 →
 *      bin/ffmpeg `scale=1:H:flags=area,format=gray` 得到"每行平均亮度"字节流 → 连续满足
 *      `luma >= --blank-threshold`（默认 247）且长度 ≥ --blank-min-px（默认 800 物理 px）的行判"疑似空白段"。
 *      段字段 blank{suspect,ratio,runs(≤5),rows,threshold}；顶层 blankSummary{segments,suspect,suspectIndexes,
 *      minPx,threshold,ffmpeg,note}。**默认只报告不改退出码**（他方 140 篇实测：剩余可疑段经 DOM 复验
 *      remaining=0、截图高=文档高，属原文设计留白）；--blank-strict 才让可疑段 → exit 1（清单 status 仍记 ok，
 *      另加 blankSummary.strictFail=true，避免把"截图失败"与"内容留白"混为一谈）。ffmpeg 缺失/调用失败 →
 *      ffmpeg:false + 一行提示，**不阻断截图**（fail-soft）。--dry-run 不检测（没图）。
 *   ⑧ 前台保障（V202610220003，**静默错图级缺陷修复，默认开**）：raw CDP `Page.captureScreenshot`
 *      在**后台页签**会超时（30s 级）甚至返回**旧帧**（实测证据 tmpdata/realshot-fix/diag{,-2,-3}-result.json：
 *      同页同位置，后台 30015ms 超时 / `Page.bringToFront` 后 592ms 正确帧；后台 clip+captureBeyondViewport
 *      第二次返回 y=0 的旧画面 mean=[253,0,1] 而页面实际在 y=665）。lib/screenshot.js 自 2026-09 起每次
 *      attempt 前都 bringToFront（单张 `cdp.js screenshot` 不受影响），而 scroll-shot 走 raw 通道此前**没有**。
 *      做法（ensureForeground，在**第一次测量/预热之前**执行）：①读 `document.visibilityState` →
 *      beforeVisibility；②hidden **或读取失败**（无法证明在前台=按不可信处理）→ 目标 session 发
 *      `Page.bringToFront` + 再读一次复核，记 broughtToFront；③原本 visible → **不做任何多余动作**（不打扰用户）。
 *      **收尾不自动还原前台**：Chrome 无「查询上一活跃 target」的稳定 API（Target.getTargets 的 attached/type
 *      都是弱信号，无法判定用户原活跃页签），瞎切回去可能反而把用户正在看的页签切走 —— 故只在清单
 *      foreground 里如实记 broughtToFront + 提示"可能已切走用户前台"；`--no-foreground` 显式放弃保障
 *      （检测到 hidden 时打印强告警：可能超时/旧帧）。
 *
 * 红线：滚动只用 Runtime.evaluate('window.scrollTo(0,y)')（只读定位语义，playbook 允许），
 *   严禁合成业务事件（不 dispatchEvent / 不 Input.dispatchMouseEvent）；每次滚动后读回 scrollY 校验，
 *   未达目标如实记 scrollMismatches。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('./paths');
const time = require('./time');
const log = require('./log');
const shot = require('./screenshot');
const platform = require('./platform');
const beyond = require('./beyond-probe');

const MANIFEST_FORMAT = 'chromeuse-scroll-shot/1';

/* 默认值与合法域（非法一律 usage 报错——绝不静默忽略） */
const DEFAULT_MAX_CHUNK = 4600;      // D1：查看端 >~4600px 降采样
// V202610210003 用户裁定：--max-chunk 默认单位改为**物理像素**（dpr>1 时与旧行为不同——旧=CSS px）
const DEFAULT_MAX_CHUNK_UNIT = 'px';
const MAX_CHUNK_UNITS = ['px', 'css'];
const MAX_CHUNK_MIN = 100;
const MAX_CHUNK_MAX = 10000;         // 硬帽：再大就失去物理切段意义且放大失败面
const DEFAULT_OVERLAP = 0;           // 0 = 几何精确可拼接（机器消费）；人工阅读长文建议 8
const OVERLAP_MAX = MAX_CHUNK_MAX;
const PNG_SAFE_PIXELS = 3000000;     // 实测依据：1100×4600=5.06M px 打挂 WS / 1100×2000=2.2M px 正常
const PNG_FALLBACK_QUALITY = 90;     // 降级 jpeg 用默认档（与 DEFAULT_QUALITY 同值，独立常量防语义漂移）
const DEFAULT_SETTLE_MS = 200;
const SETTLE_MAX = 5000;
const DEFAULT_TIMEOUT_MS = 30000;    // 单段截图超时（非整页）
const TIMEOUT_MIN = 100;
const TIMEOUT_MAX = 600000;
const DEFAULT_QUALITY = 90;
const DEFAULT_PREWARM_SAMPLES = 20;
const PREWARM_SAMPLES_MIN = 3;
const PREWARM_SAMPLES_MAX = 100;
const STABLE_SAMPLES = 3;            // 文档高度连续 N 次采样不变 → 判稳定
const DEFAULT_IMAGE_TIMEOUT_MS = 5000;
const IMAGE_TIMEOUT_MAX = 120000;
const DEFAULT_IMG_SETTLE_MS = 1800;  // GIF 即使加载完也要等首帧解码（实测 1.5~2s）
const IMG_SETTLE_MAX = 30000;
const PREWARM_STEP_RATIO = 0.9;      // 步长 = 0.9 视口高（spec 0.8~1.0）
/* 懒加载真源属性优先级（页面侧 promote 与清单/文档单源）：先 data-src（微信/公众号），再常见变体 */
const IMG_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-backsrc'];
const IMG_PROMOTED_ATTR = 'data-cu-promoted';
const SCROLL_TOL = 2;                // scrollY 读回容差（CSS px）
const MAX_MISMATCH_RECORDS = 20;
const MAX_PREWARM_ROUNDS = 4;        // 高度增长后重扫底部的轮次上限
const MAX_PREWARM_STEPS = 2000;      // 单轮滚动步数硬帽（防异常页面无限增长）
const MAX_B_SHOTS = 200;             // B 路径单段视口截图数硬帽
const RETRY_PAUSE_MS = 300;          // 段内重试间歇（同 shot 链路纪律）
/* ── 前台保障（V202610220003）──
 * 环境事实：后台页签 raw Page.captureScreenshot 实测 30015ms 超时 / bringToFront 后 592ms 正确，
 * 且可**返回旧帧**（静默错图）。故默认开；--no-foreground 显式放弃时必须强告警。 */
const VISIBILITY_EXPR = 'document.visibilityState';
const FOREGROUND_BG_WARNING = '⚠ 目标页签在后台：captureScreenshot 实测会 30s 超时甚至返回旧帧（静默错图）';

/* ── 空白段自检（F13，2026-10-22）默认值 ──
 * 判据口径取自他方竞品采集实测脚本（灰度 → 每 80px 一行均值 → 连续 >10 行亮度 >248 判空白段），
 * 折算到本工具：整图宽度 1 列的行平均亮度 + 连续行游程长度。800px = 80px×10 行的物理等价（默认段高
 * ≤4600px，800px≈17% 段高）；247 比 248 低 1 档，容 JPEG 编码噪声（q90 纯白块实测仍有 ±1 抖动）。 */
const DEFAULT_BLANK_MIN_PX = 800;    // 连续空白最小物理像素长度（短于此不算可疑段）
const BLANK_MIN_PX_MIN = 0;          // 0 = 任意非空游程都算（边界语义：所有满足阈值的连续行都报）
const BLANK_MIN_PX_MAX = 100000;
const DEFAULT_BLANK_THRESHOLD = 247; // 行平均亮度阈值（0~255；≥ 该值算"空白行"）
const BLANK_THRESHOLD_MIN = 0;
const BLANK_THRESHOLD_MAX = 255;
const BLANK_MAX_RUNS = 5;            // 段记录里最多保留几条游程（ratio 按全部游程算，不截断）
const BLANK_TIMEOUT_MS = 60000;      // 单段行剖面 ffmpeg 超时

/* ── 切点吸附空白带（F15，TODO ④ 区【scroll-shot 切点吸附空白带】）默认值 ──
 * 需求：固定切点把标题栏/产品卡拦腰截断。DOM 优先法＝分段前一次**只读** evaluate 取可见内容元素 rect，
 *   纯函数 snapCuts 对每个非末段切点在 ±window 内找「不与任何元素 rect 相交的水平空白带」，取带中点为新切点；
 *   像素法（--snap-px 显式开）＝DOM 该切点无合格带时，对已落盘段图跑 F13 同款行剖面兜底。
 * ⚠ 「只向短方向吸附」的落地解读（2026-10-28 任务书给定语义 + 本实现细化，**待用户复核**）：
 *   ① 候选 = 与窗口相交且窗口内可用宽度 ≥ SNAP_MIN_BAND_PX 的空白带（上/下皆可）；
 *   ② 原切点本身已在某候选带内 → 位移 0（已落在空白里，无需移动——"最短位移"的自然下界）；
 *   ③ 否则取带中点；中点越出窗口、或使相邻任一段 cssHeight < viewport/4（minSlice，同时不超 chunkCss）→
 *      clamp 到边界；clamp 后切点仍须落在该空白带 ∩ 窗口内，否则**放弃该切点吸附**（method:'none'）。
 *   ④ 末段无切点 → 恒 method:'none'（不吸附）。
 * ⚠ **三条 clamp 硬约束**（依据 `webapps/wechat-mp/webapp.md` L77 他方实测记录：
 *   「只向短方向吸附（不为吸附把段拉长），终点 clamp 到文档高」）：
 *   ① 吸附后任一段 cssHeight ≤ chunkCss（**不为吸附把段拉长**，段高不超 max-chunk 计划值；
 *      step == chunkCss 时等价于只能上移）；② 相邻段 ≥ viewport/4（防极短段，退化配置由
 *      snapMinSlice 取 min(viewport/4, step) 兜底）；③ 切点严格落在 (0, docHeight)。
 *   违反即抛错 → runScrollShot fail-soft 回落原切点（截图不受影响）。 */
const DEFAULT_SNAP_WINDOW = 180;     // 切点吸附窗口 ±CSS px
const SNAP_WINDOW_MIN = 32;
const SNAP_WINDOW_MAX = 512;
const SNAP_MIN_BAND_PX = 12;         // 合格空白带最小宽度（CSS px，DOM 法与像素法同口径）
const MAX_SNAP_RECTS = 6000;         // evaluate 返回 rect 条数硬帽（超长页 JSON 体积兜底）
const MAX_PLAN_SLICES = 20000;       // 吸附后重排段数硬帽（防异常页面死循环）
const SNAP_METHODS = ['dom', 'px', 'none'];

const sleep = time.sleep; // 通用延迟单源 lib/time.js
const extOf = (format) => (format === 'jpeg' ? '.jpg' : '.png');

/** 参数错误（kind=usage）：非法旗标值一律明确报错，不静默忽略 */
function usageErr(msg) { const e = new Error(msg); e.kind = 'usage'; return e; }

/** 整数旗标解析（缺省→def；布尔旗标/非整数/越界→usage 报错） */
function intOption(value, name, def, min, max) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') throw usageErr(`${name} 需要数值（${min}~${max}），不能是布尔旗标`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw usageErr(`${name} 须为 ${min}~${max} 的整数：${JSON.stringify(value)}`);
  return n;
}

/**
 * 图片就绪三态判据（**真源单点**；页面表达式经 toString() 内嵌，Node 侧与页内判据永不漂移）。
 * 背景：微信长图成段纯白的根因 = 旧判据 `complete && naturalWidth > 0` 把占位 SVG 判成就绪——
 *   `<img class="rich_pages wxw-img js_img_placeholder" src="data:image/svg+xml,...">` 的
 *   complete=true 且 naturalWidth=**1**（>0）→ 等待循环立刻退出（他方 2026-10-21 全量 140 篇实测）。
 * 规则（顺序即优先级）：
 *   ① naturalWidth > 1（真实解码尺寸）→ loaded（占位 SVG / 1×1 占位片的 naturalWidth 恒 ≤1，不是 0）
 *   ② src 以 data:image/svg 开头（未 promote 的占位图）→ placeholder
 *   ③ class 含 js_img_placeholder / lazy：**仅在 complete 或无 src 或 src 仍是 data: 时采信** → placeholder
 *      （src 已是真实 URL 但未 complete = 正在加载 → 必须归 pending，否则等待循环提前退出、白段复现）
 *   ④ src 为空：有 data-src 真源 = 待 promote 的占位位 → placeholder；无真源 → pending
 *   ⑤ complete 但 naturalWidth ≤ 1（1×1 占位片 / 破图）→ placeholder
 *   ⑥ 其余（真 URL 在途）→ pending
 * @param {{src?:string, cls?:string, naturalWidth?:number, hasDataSrc?:boolean, complete?:boolean}} input
 * @returns {'placeholder'|'pending'|'loaded'}
 */
function classifyImg(input) {
  const im = input || {};
  const src = typeof im.src === 'string' ? im.src.trim() : '';
  const cls = typeof im.cls === 'string' ? im.cls : '';
  const naturalWidth = Number(im.naturalWidth) || 0;
  const complete = !!im.complete;
  const hasDataSrc = !!im.hasDataSrc;
  if (naturalWidth > 1) return 'loaded';
  if (/^data:image\/svg/i.test(src)) return 'placeholder';
  const classMark = /(^|\s)(js_img_placeholder|lazy)(\s|$)/.test(cls);
  if (classMark && (complete || !src || /^data:/i.test(src))) return 'placeholder';
  if (!src) return hasDataSrc ? 'placeholder' : 'pending';
  if (complete) return 'placeholder';
  return 'pending';
}

/**
 * 选项归一（纯函数；建连前校验全部旗标——非法参数绝不拖到连上浏览器才报）。
 * ⚠ 幂等（V202610210004 实弹暴露的既存 bug 修复）：runScrollShot 会再 normalizeOptions 一次，
 *   而 CLI 传进来的已是归一结果（键名是 settleMs / imageTimeoutMs / imgSettleMs）——只读 src.settle
 *   等原始键会让 **--settle / --image-timeout / --img-settle 被默认值静默覆盖**（实弹 --img-settle 0 仍记 1800）。
 *   pick(原始键, 已归一键) 让二次归一恒等。
 * @param o {maxChunk, maxChunkUnit, overlap, viewportMaxChunk, formatFallback, settle|settleMs,
 *           timeoutMs, prewarmSamples, imageTimeout|imageTimeoutMs, imgSettle|imgSettleMs,
 *           imgPromote, format, quality, dpr, viewport, outDir, name, dryRun, keepSlices}
 * @returns 归一后的选项（format/quality/dpr/viewport 已通过 lib/screenshot.js 纯函数校验）
 */
function normalizeOptions(o) {
  const src = o || {};
  const pick = (raw, normalized) => (raw === undefined || raw === null || raw === '' ? normalized : raw);
  const maxChunk = intOption(src.maxChunk, '--max-chunk', DEFAULT_MAX_CHUNK, MAX_CHUNK_MIN, MAX_CHUNK_MAX);
  // --max-chunk-unit：只认字面枚举值（缺省 px；非法绝不静默回退）
  let maxChunkUnit = DEFAULT_MAX_CHUNK_UNIT;
  if (src.maxChunkUnit !== undefined && src.maxChunkUnit !== null && src.maxChunkUnit !== '') {
    if (typeof src.maxChunkUnit === 'boolean') throw usageErr('--max-chunk-unit 需要值（px|css），不能是布尔旗标');
    maxChunkUnit = String(src.maxChunkUnit).trim().toLowerCase();
    if (!MAX_CHUNK_UNITS.includes(maxChunkUnit)) throw usageErr(`--max-chunk-unit 仅支持 px|css：${JSON.stringify(src.maxChunkUnit)}`);
  }
  // --overlap（CSS px）：上界由 chunkCss 在运行期复核（chunkCss 依赖 dpr）；这里只做数值域校验
  const overlap = intOption(src.overlap, '--overlap', DEFAULT_OVERLAP, 0, OVERLAP_MAX);
  const settleMs = intOption(pick(src.settle, src.settleMs), '--settle', DEFAULT_SETTLE_MS, 0, SETTLE_MAX);
  const timeoutMs = intOption(src.timeoutMs, '--timeout', DEFAULT_TIMEOUT_MS, TIMEOUT_MIN, TIMEOUT_MAX);
  const prewarmSamples = intOption(src.prewarmSamples, '--prewarm-samples', DEFAULT_PREWARM_SAMPLES, PREWARM_SAMPLES_MIN, PREWARM_SAMPLES_MAX);
  const imageTimeoutMs = intOption(pick(src.imageTimeout, src.imageTimeoutMs), '--image-timeout', DEFAULT_IMAGE_TIMEOUT_MS, 0, IMAGE_TIMEOUT_MAX);
  // --img-settle：promote/就绪轮询之后的固定等待（GIF 首帧解码；0 可关；非法值一律 usage 报错）
  const imgSettleMs = intOption(pick(src.imgSettle, src.imgSettleMs), '--img-settle', DEFAULT_IMG_SETTLE_MS, 0, IMG_SETTLE_MAX);
  // 空白段自检（F13）：默认开（advisory 只报告不改退出码）；--no-blank-check 关；--blank-strict 才判死
  const blankMinPx = intOption(src.blankMinPx, '--blank-min-px', DEFAULT_BLANK_MIN_PX, BLANK_MIN_PX_MIN, BLANK_MIN_PX_MAX);
  const blankThreshold = intOption(src.blankThreshold, '--blank-threshold', DEFAULT_BLANK_THRESHOLD, BLANK_THRESHOLD_MIN, BLANK_THRESHOLD_MAX);
  // 切点吸附（F15）：默认开（DOM 优先）；--no-snap-cuts 关；--snap-window 32~512；--snap-px 显式开像素兜底
  const snapWindow = intOption(src.snapWindow, '--snap-window', DEFAULT_SNAP_WINDOW, SNAP_WINDOW_MIN, SNAP_WINDOW_MAX);
  // 视口/DPR 与编码的校验单源在 lib/screenshot.js（scroll-shot 不重复实现一份）；
  // scroll-shot 的默认编码是 jpeg（C6：PNG 整页 ≈16MB），故缺省 format 先落 jpeg 再走 formatPlan。
  const metrics = shot.metricsPlan({ dpr: src.dpr, viewport: src.viewport });
  const base = shot.formatPlan({ format: src.format === undefined || src.format === null || src.format === '' ? 'jpeg' : src.format });
  const hasQuality = src.quality !== undefined && src.quality !== null && src.quality !== '';
  const cap = shot.formatPlan({
    format: base.format,
    // jpeg 缺省 quality=90（C6 体积基线）；png 不注入 quality（避免凭空告警），仅用户显式传入才忽略+告警
    quality: hasQuality ? src.quality : (base.format === 'jpeg' ? DEFAULT_QUALITY : undefined),
  });
  if (src.name !== undefined && src.name !== null && src.name !== true && src.name !== '') {
    const name = String(src.name);
    if (/[\\/\0]/.test(name) || name === '.' || name === '..') throw usageErr(`--name 不能含路径分隔符：${JSON.stringify(src.name)}`);
  }
  if (src.outDir === true) throw usageErr('--out-dir 需要目录路径，不能是布尔旗标');
  // 布尔旗标：显式给出即启用；false/缺省都视为关（归一结果会被 runScrollShot 二次归一，不能再报错）
  const viewportMaxChunk = src.viewportMaxChunk !== undefined && src.viewportMaxChunk !== null && src.viewportMaxChunk !== '' && src.viewportMaxChunk !== false;
  const dpr = src.dpr === undefined || src.dpr === null || src.dpr === '' ? null : src.dpr;
  const viewport = src.viewport === undefined || src.viewport === null || src.viewport === '' ? null : src.viewport;
  return {
    maxChunk, maxChunkUnit, overlap, viewportMaxChunk, settleMs, timeoutMs, prewarmSamples, imageTimeoutMs,
    imgSettleMs,
    format: cap.format,
    quality: cap.quality != null ? cap.quality : (cap.format === 'jpeg' ? DEFAULT_QUALITY : null),
    qualityIgnored: cap.qualityIgnored,
    // PNG 断链降级默认开启；--no-format-fallback 显式关闭（false 才关，其他真值视为开）
    formatFallback: src.formatFallback === false ? false : true,
    // 强制 data-src 赋值默认开启；--no-img-promote 显式关闭（false/缺省→开；只有 false 才关）
    imgPromote: src.imgPromote === false ? false : true,
    // 空白段自检：默认开（advisory）；--no-blank-check 显式关；--blank-strict 才让可疑段影响退出码
    blankCheck: src.blankCheck === false ? false : true,
    // 前台保障（V202610220003）：默认开（后台页签 raw captureScreenshot 会 30s 超时甚至返回旧帧）；
    // --no-foreground 显式放弃（只有 false 才关，检测到 hidden 时打强告警）
    foreground: src.foreground === false ? false : true,
    blankMinPx,
    blankThreshold,
    blankStrict: src.blankStrict === true,
    // 切点吸附（F15）：默认开（DOM 优先）；--no-snap-cuts 显式关（只有 false 才关，幂等）
    snapCuts: src.snapCuts === false ? false : true,
    snapWindow,
    // 像素法兜底：**只有显式 --snap-px 才开**（默认关——需要额外 ffmpeg 行剖面）
    snapPx: src.snapPx === true,
    dpr,
    viewport,
    emulate: metrics !== null || viewportMaxChunk, // 只有显式旗标才施加 Emulation（不默认 emulate）
    outDir: src.outDir ? String(src.outDir) : paths.EVENTS_DIR,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : `scroll-${time.formatStamp()}`,
    dryRun: !!src.dryRun,
    keepSlices: !!src.keepSlices,
    // ISSUE-1：beyond-viewport 探测注入面（CLI 不暴露；selftest/嵌入方用）——目录与依赖可替换，
    // 默认 beyondCacheDir=paths.STATE_DIR、beyondDeps=无（真探测 + GET /json/version 取版本 key）
    beyondCacheDir: src.beyondCacheDir === undefined ? undefined : src.beyondCacheDir,
    beyondDeps: src.beyondDeps && typeof src.beyondDeps === 'object' ? src.beyondDeps : null,
  };
}

/**
 * 分段几何归一（纯函数；selftest #82 直测）：把 --max-chunk + 单位 + DPR 折算成**内部统一的 CSS px**。
 *   unit=px（默认）：chunkCss = floor(maxChunk / dpr)  → 每段物理高 ≤ maxChunk（硬保证）
 *   unit=css       ：chunkCss = maxChunk                → 物理高 = chunkCss×dpr（可超 maxChunk，用户显式选择）
 * dpr 取显式 --dpr 或页面读回的原生 devicePixelRatio（调用方传入；缺省 1）。
 * overlap 必须 < chunkCss（否则重叠无意义）——此处复核（依赖 dpr，故不能在 build 前静默放过）。
 * @returns {{maxChunk:number, maxChunkUnit:'px'|'css', dpr:number, chunkCss:number, chunkPx:number,
 *            overlap:number, physicalCapped:boolean}}
 */
function resolveChunkGeometry(input) {
  const o = input || {};
  const mc = Number(o.maxChunk);
  if (!Number.isInteger(mc) || mc < MAX_CHUNK_MIN || mc > MAX_CHUNK_MAX) {
    throw usageErr(`--max-chunk 须为 ${MAX_CHUNK_MIN}~${MAX_CHUNK_MAX} 的整数：${JSON.stringify(o.maxChunk)}`);
  }
  const unit = o.maxChunkUnit == null || o.maxChunkUnit === '' ? DEFAULT_MAX_CHUNK_UNIT : String(o.maxChunkUnit).trim().toLowerCase();
  if (!MAX_CHUNK_UNITS.includes(unit)) throw usageErr(`--max-chunk-unit 仅支持 px|css：${JSON.stringify(o.maxChunkUnit)}`);
  const dprNum = Number(o.dpr);
  const dpr = Number.isFinite(dprNum) && dprNum > 0 ? dprNum : 1;
  const chunkCss = unit === 'css' ? mc : Math.max(1, Math.floor(mc / dpr));
  const chunkPx = Math.round(chunkCss * dpr);
  if (typeof o.overlap === 'boolean') throw usageErr('--overlap 需要数值（CSS px），不能是布尔旗标');
  const overlap = o.overlap == null ? DEFAULT_OVERLAP : Number(o.overlap);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > OVERLAP_MAX) {
    throw usageErr(`--overlap 须为 0~${OVERLAP_MAX} 的整数：${JSON.stringify(o.overlap)}`);
  }
  if (overlap >= chunkCss) {
    throw usageErr(`--overlap ${overlap} 须小于每段 CSS 高 ${chunkCss}（--max-chunk ${mc} ${unit} @DPR ${dpr}）——否则段间重叠无意义`);
  }
  return { maxChunk: mc, maxChunkUnit: unit, dpr, chunkCss, chunkPx, overlap, physicalCapped: unit === 'px' };
}

/**
 * 分段计划（纯函数，selftest #82 直测）：y 从 0 起按 step = min(viewportH, chunkCss) 步进；
 * 每段 cssHeight = min(step, docH - y)——末段取余数、绝不重叠（C4），任何文档都不产 > chunkCss 的段。
 * --overlap **不改变切段位置**：非末段 captureHeight = cssHeight + overlap（向下多拍），末段 overlapPx=0。
 * @returns {{step:number, docHeight:number, viewportH:number, chunkCss:number, maxChunk:number,
 *            overlap:number, count:number,
 *            slices:Array<{index:number, y:number, cssHeight:number, captureHeight:number, overlapPx:number}>}}
 */
function planSlices(docH, viewportH, chunkCss, overlap) {
  const doc = Number(docH), vp = Number(viewportH), mc = Number(chunkCss);
  if (!Number.isFinite(doc) || doc <= 0) throw usageErr(`文档高度非法（应 >0）：${JSON.stringify(docH)}`);
  if (!Number.isFinite(vp) || vp <= 0) throw usageErr(`视口高度非法（应 >0）：${JSON.stringify(viewportH)}`);
  if (!Number.isFinite(mc) || !Number.isInteger(mc) || mc < MAX_CHUNK_MIN || mc > MAX_CHUNK_MAX) {
    throw usageErr(`--max-chunk 须为 ${MAX_CHUNK_MIN}~${MAX_CHUNK_MAX} 的整数：${JSON.stringify(chunkCss)}`);
  }
  if (typeof overlap === 'boolean') throw usageErr('--overlap 需要数值（CSS px），不能是布尔旗标');
  const ov = overlap == null ? DEFAULT_OVERLAP : Number(overlap);
  if (!Number.isInteger(ov) || ov < 0 || ov >= mc) throw usageErr(`--overlap ${JSON.stringify(overlap)} 须为 0~${mc - 1} 的整数（小于每段 CSS 高 ${mc}）`);
  const step = Math.min(Math.ceil(vp), mc);
  const slices = [];
  for (let y = 0; y < doc; y += step) {
    const cssHeight = Math.min(step, doc - y);
    const isLast = y + cssHeight >= doc;
    const overlapPx = isLast ? 0 : ov; // 末段不叠加（页面已到底，多拍只会拿到空白）
    slices.push({ index: slices.length + 1, y, cssHeight, captureHeight: cssHeight + overlapPx, overlapPx });
  }
  return { step, docHeight: doc, viewportH: Math.ceil(vp), chunkCss: mc, maxChunk: mc, overlap: ov, count: slices.length, slices };
}

/** 物理像素预估（纯函数）：图高 = captureHeight × dpr（clip.scale=1 时输出像素 = CSS × DPR） */
function physicalPlan(plan, dpr) {
  const d = Number(dpr);
  const scale = Number.isFinite(d) && d > 0 ? d : 1;
  return plan.slices.map((s) => {
    const captureHeight = s.captureHeight != null ? s.captureHeight : s.cssHeight;
    return {
      index: s.index, y: s.y, cssHeight: s.cssHeight, captureHeight, overlapPx: s.overlapPx || 0,
      height: Math.round(captureHeight * scale),
      cssHeightPx: Math.round(s.cssHeight * scale),
      // 切点吸附记录（F15）：dry-run 也只有这里能看到吸附计划，故随计划一起带出
      snap: s.snap ? Object.assign({}, s.snap) : null,
    };
  });
}

/* ── 切点吸附空白带（F15）纯函数族 ───────────────────────────────────────────
 * 设计要点（顺序即语义，详见文件头 ②d 与常量块注释）：
 *   blankBands  → 元素 rect 合并成覆盖区间，取补集 = 不与任何元素相交的水平空白带；
 *   snapPoint   → 单个切点：窗口内选候选带（原切点已在带内 → 位移 0；否则取带中点），clamp 到
 *                 [prev+minSlice, prev+chunkCss] / [0, docH-lastMin]，clamp 后不在带内 → 放弃；
 *   planFromCuts→ 切点序列 → 段几何（y/cssHeight/captureHeight/overlapPx，末段 overlap 恒 0）；
 *   snapCuts    → 顺序推进：每步以「上一刀 + step」为目标做吸附（末段无切点 → method:'none'）。
 * 纯函数：不碰 client/文件/全局状态；rects 只读输入（[top,bottom] 或 {top,bottom}）。
 */

/** rect 归一（纯函数）：接受 [top,bottom] / {top,bottom}；非法返回 null */
function rectPair(r) {
  if (!r) return null;
  let top, bottom;
  if (Array.isArray(r)) { top = Number(r[0]); bottom = Number(r[1]); }
  else { top = Number(r.top); bottom = Number(r.bottom); }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  return { top, bottom };
}

/**
 * 空白带（纯函数，selftest #87 直测）：元素 rect 合并成覆盖区间，返回补集。
 * 区间语义：band = [from, to)（from 含 / to 不含）；rect 越界部分裁到 [0, docH]。
 * @param {Array<[number,number]|{top:number,bottom:number}>} rects
 * @param {number} docH 文档高（CSS px）
 * @returns {Array<{from:number, to:number}>} 按 from 升序、互不重叠
 */
function blankBands(rects, docH) {
  const doc = Number(docH);
  if (!Number.isFinite(doc) || doc <= 0) throw usageErr(`文档高度非法（应 >0）：${JSON.stringify(docH)}`);
  const iv = [];
  for (const r of rects || []) {
    const p = rectPair(r);
    if (!p) continue;
    const top = Math.max(0, Math.min(doc, p.top));
    const bottom = Math.max(0, Math.min(doc, p.bottom));
    if (!(bottom > top)) continue;
    iv.push([top, bottom]);
  }
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bands = [];
  let cursor = 0;
  for (const [a, b] of iv) {
    if (a > cursor) bands.push({ from: cursor, to: a });
    if (b > cursor) cursor = b;
  }
  if (cursor < doc) bands.push({ from: cursor, to: doc });
  return bands;
}

/** 无吸附记录（形状恒定：method='none'，from/to=null，shift=0） */
function noneSnap() { return { from: null, to: null, shift: 0, method: 'none' }; }

/**
 * 单切点吸附（纯函数，selftest #87 直测；DOM 法与像素法共用同一套选择/clamp 语义）。
 * @param {number} target 原切点（CSS px，文档坐标）
 * @param {Array<{from:number,to:number}>} bands blankBands 的输出（或像素法换算出的带）
 * @param {{windowPx?:number, minBandPx?:number, min?:number, max?:number, docH:number}} opts
 *        min/max = 切点额外上/下界（prev+minSlice / prev+chunkCss / docH-lastMin，由调用方算好）
 * @returns {{cut:number, from:number|null, to:number|null, shift:number, method:'dom'|'none'}}
 */
function snapPoint(target, bands, opts) {
  const o = opts || {};
  const t = Number(target);
  const doc = Number(o.docH);
  if (!Number.isFinite(t) || t < 0) throw usageErr(`切点非法（应 ≥0）：${JSON.stringify(target)}`);
  if (!Number.isFinite(doc) || doc <= 0) throw usageErr(`文档高度非法（应 >0）：${JSON.stringify(o.docH)}`);
  const W = o.windowPx == null ? DEFAULT_SNAP_WINDOW : Number(o.windowPx);
  if (!Number.isInteger(W) || W < SNAP_WINDOW_MIN || W > SNAP_WINDOW_MAX) {
    throw usageErr(`--snap-window 须为 ${SNAP_WINDOW_MIN}~${SNAP_WINDOW_MAX} 的整数：${JSON.stringify(o.windowPx)}`);
  }
  const minBand = o.minBandPx == null ? SNAP_MIN_BAND_PX : Number(o.minBandPx);
  if (!Number.isFinite(minBand) || minBand < 0) throw usageErr(`空白带最小宽度非法：${JSON.stringify(o.minBandPx)}`);
  const min = o.min == null ? 0 : Number(o.min);
  const max = o.max == null ? doc : Number(o.max);
  const winLo = Math.max(0, t - W);
  const winHi = Math.min(doc, t + W);
  const lo = Math.max(winLo, min);
  const hi = Math.min(winHi, max);
  if (!(hi >= lo)) return Object.assign({ cut: t }, noneSnap());
  let best = null;
  for (const b of bands || []) {
    const a = Math.max(Number(b.from), winLo);
    const z = Math.min(Number(b.to), winHi);
    if (!(z - a >= minBand)) continue;               // 窗口内可用宽度不足 → 不合格
    const inTarget = t >= a && t <= z && t >= lo && t <= hi; // 原切点已在空白带内（且满足 min/max 界）→ 零位移
    const mid = (Number(b.from) + Number(b.to)) / 2;
    let cut = inTarget ? t : Math.round(Math.max(lo, Math.min(hi, mid)));
    cut = Math.max(0, Math.min(doc, cut));          // ③ 终点 clamp 到 [0, docHeight]（L77「终点 clamp 到文档高」）
    if (!(cut > 0 && cut < doc)) continue;          // 切点须严格落在文档内部（不产零高段）
    if (cut < a || cut > z) continue;               // clamp 后被推出空白带 → 不合格
    const dist = Math.abs(cut - t);
    if (!best || dist < best.dist || (dist === best.dist && cut < best.cut)) {
      best = { cut, from: Number(b.from), to: Number(b.to), shift: cut - t, dist };
    }
  }
  if (!best) return Object.assign({ cut: t }, noneSnap());
  return { cut: best.cut, from: best.from, to: best.to, shift: best.shift, method: 'dom' };
}

/**
 * 切点序列 → 段几何（纯函数，selftest #87 直测）：与 planSlices 同口径（末段取余数、末段 overlap 恒 0）。
 * @param {number} docH
 * @param {number} viewportH
 * @param {number} chunkCss
 * @param {number} overlap
 * @param {number[]} cuts 非零切点（升序；起点由 startY 给出）
 * @param {number} [startY] 首段起点（默认 0；像素法兜底重排尾部时 = 新切点）
 */
function planFromCuts(docH, viewportH, chunkCss, overlap, cuts, startY) {
  const doc = Number(docH), vp = Number(viewportH), mc = Number(chunkCss);
  if (!Number.isFinite(doc) || doc <= 0) throw usageErr(`文档高度非法（应 >0）：${JSON.stringify(docH)}`);
  if (!Number.isFinite(vp) || vp <= 0) throw usageErr(`视口高度非法（应 >0）：${JSON.stringify(viewportH)}`);
  if (!Number.isFinite(mc) || !Number.isInteger(mc) || mc < MAX_CHUNK_MIN || mc > MAX_CHUNK_MAX) {
    throw usageErr(`--max-chunk 须为 ${MAX_CHUNK_MIN}~${MAX_CHUNK_MAX} 的整数：${JSON.stringify(chunkCss)}`);
  }
  const ov = overlap == null ? DEFAULT_OVERLAP : Number(overlap);
  if (!Number.isInteger(ov) || ov < 0) throw usageErr(`--overlap 非法：${JSON.stringify(overlap)}`);
  const ys = (cuts || []).map((c) => Math.round(Number(c))).filter((c) => Number.isFinite(c) && c > 0 && c < doc);
  const start = startY == null ? 0 : Math.round(Number(startY));
  if (!Number.isInteger(start) || start < 0 || start >= doc) throw usageErr(`起始切点非法：${JSON.stringify(startY)}`);
  const points = [start];
  for (const y of ys) if (y > points[points.length - 1]) points.push(y);
  const slices = [];
  for (let i = 0; i < points.length; i++) {
    const y = points[i];
    const next = i + 1 < points.length ? points[i + 1] : doc;
    const cssHeight = next - y;
    if (!(cssHeight > 0)) continue;
    const isLast = next >= doc;
    const overlapPx = isLast ? 0 : ov;
    slices.push({ index: slices.length + 1, y, cssHeight, captureHeight: cssHeight + overlapPx, overlapPx });
  }
  return {
    step: Math.min(Math.ceil(vp), mc), docHeight: doc, viewportH: Math.ceil(vp), chunkCss: mc, maxChunk: mc,
    overlap: ov, count: slices.length, slices,
  };
}

/** minSlice（防极短段）默认口径：viewport/4，且不超过 step（chunkCss 极小时的退化配置兜底） */
function snapMinSlice(viewportH, step) {
  const vp = Number(viewportH) || 0;
  const st = Number(step) || 0;
  return Math.max(1, Math.floor(Math.min(vp > 0 ? vp / 4 : 0, st > 0 ? st : 0) || 1));
}

/**
 * 分段计划 + 切点吸附（纯函数，selftest #87 直测）：顺序推进（滚动推进的静态等价）。
 * 每一步：target = 上一刀 + step → snapPoint（窗口 ±windowPx）→ 得下一刀；末段无切点（method:'none'）。
 * @param {{docHeight:number, viewportH:number, step:number, chunkCss:number, overlap:number}} plan
 * @param {Array} rects 元素 rect（enabled=false 时忽略）
 * @param {{enabled?:boolean, windowPx?:number, minBandPx?:number, minSlicePx?:number, startY?:number}} opts
 *        startY>0 = 只生成从 startY 起的尾部（像素法兜底改切点后的重排）；返回的 plan.slices 也从 startY 开始
 * @returns {{plan:object, snaps:Array<{from:number|null,to:number|null,shift:number,method:string}>}}
 */
function snapCuts(plan, rects, opts) {
  const o = opts || {};
  const base = plan || {};
  const doc = Number(base.docHeight);
  const vp = Number(base.viewportH);
  const stepIn = Number(base.step);
  const mc = Number(base.chunkCss);
  if (!Number.isFinite(doc) || doc <= 0) throw usageErr(`文档高度非法（应 >0）：${JSON.stringify(base.docHeight)}`);
  if (!Number.isFinite(vp) || vp <= 0) throw usageErr(`视口高度非法（应 >0）：${JSON.stringify(base.viewportH)}`);
  if (!Number.isFinite(stepIn) || stepIn <= 0) throw usageErr(`step 非法（应 >0）：${JSON.stringify(base.step)}`);
  const step = Math.max(1, Math.min(Math.ceil(stepIn), mc));
  const startY = o.startY == null ? 0 : Math.round(Number(o.startY));
  if (!Number.isInteger(startY) || startY < 0 || startY >= doc) throw usageErr(`起始切点非法：${JSON.stringify(o.startY)}`);
  const enabled = o.enabled !== false;
  const windowPx = o.windowPx == null ? DEFAULT_SNAP_WINDOW : Number(o.windowPx);
  const minBandPx = o.minBandPx == null ? SNAP_MIN_BAND_PX : Number(o.minBandPx);
  const minSlice = o.minSlicePx == null ? snapMinSlice(vp, step) : Number(o.minSlicePx);
  const bands = enabled ? blankBands(rects, doc) : [];
  const cuts = [];
  const snaps = [];
  let y = startY;
  let guard = 0;
  while (y + step < doc) {
    if (++guard > MAX_PLAN_SLICES) throw new Error(`切点吸附段数超硬帽 ${MAX_PLAN_SLICES}（页面/参数异常）`);
    const target = y + step;
    const lastMin = Math.min(minSlice, doc - target);
    const res = enabled
      ? snapPoint(target, bands, { windowPx, minBandPx, min: y + minSlice, max: Math.min(y + mc, doc - lastMin), docH: doc })
      : { cut: target, from: null, to: null, shift: 0, method: 'none' };
    cuts.push(res.cut);
    snaps.push({ from: res.from, to: res.to, shift: res.shift, method: res.method });
    y = res.cut;
  }
  // 末段：无切点 → 不吸附（形状恒一致）
  snaps.push(noneSnap());
  const out = planFromCuts(doc, vp, mc, base.overlap, cuts, startY);
  out.slices.forEach((s, i) => { s.snap = Object.assign({}, snaps[i] || noneSnap()); });
  // 三条 clamp 硬约束（依据 webapps/wechat-mp/webapp.md L77 他方实测：「只向短方向吸附（不为吸附把段拉长），
  // 终点 clamp 到文档高」）：①任一段 cssHeight ≤ chunkCss（不为吸附把段拉长）②相邻段 ≥ viewport/4（防极短段，
  // 退化配置由 snapMinSlice 取 min(viewport/4, step) 兜底）③切点严格在 (0, docHeight)。违反即抛错，由
  // runScrollShot 的 fail-soft 兜底回原切点（截图不受影响）——吸附是增强，绝不允许突破物理切段红线。
  for (const s2 of out.slices) {
    if (s2.cssHeight > mc) throw new Error(`切点吸附不变量破坏：段 ${s2.index} cssHeight=${s2.cssHeight} > chunkCss=${mc}（不为吸附把段拉长）`);
  }
  for (const c of cuts) {
    if (!(Number.isFinite(c) && c > 0 && c < doc)) throw new Error(`切点越界（应落在 (0, ${doc})）：${JSON.stringify(c)}（终点 clamp 到文档高）`);
  }
  return { plan: out, snaps };
}

/**
 * 像素法兜底改切点（纯函数；selftest #87 直测）：把第 i 段的切点改成 snap.cut，并按「滚动推进」
 * 重排尾部（startY=cut 之后照常用 DOM 吸附生成），返回新的 plan（不修改入参）。
 * 语义：段 i 的 cssHeight 缩/扩到新切点，captureHeight 取「已拍图不可变矮」，overlapPx=差值
 * （= 图向下多拍的部分，与 --overlap 同口径：内容不丢、接缝处重复 ≤ 该值）。
 */
function applyPxCut(plan, i, snap, opts) {
  const o = opts || {};
  const prior = plan.slices[i];
  if (!prior) throw usageErr(`applyPxCut 段索引越界：${i}`);
  const cut = Math.round(Number(snap && snap.cut));
  if (!Number.isFinite(cut) || !(cut > prior.y)) throw usageErr(`像素法切点非法：${JSON.stringify(snap && snap.cut)}`);
  const s = Object.assign({}, prior);
  s.cssHeight = cut - s.y;
  s.captureHeight = Math.max(Number(s.captureHeight) || 0, s.cssHeight);
  s.overlapPx = s.captureHeight - s.cssHeight;
  // shift 保持「相对原切点」语义（原切点 = prior.y + prior.cssHeight）
  s.snap = {
    from: snap.from == null ? null : Number(snap.from),
    to: snap.to == null ? null : Number(snap.to),
    shift: cut - (prior.y + prior.cssHeight),
    method: 'px',
  };
  const tail = snapCuts(plan, o.rects, Object.assign({}, o.snapOpts, { startY: cut }));
  const merged = plan.slices.slice(0, i).concat([s]).concat(tail.plan.slices);
  merged.forEach((x, k) => { x.index = k + 1; });
  // 同一组硬约束（L77）：像素法改切点也不得把段拉长超 chunkCss、不得越文档高
  const mc = Number(plan.chunkCss);
  for (const x of merged) {
    if (Number.isFinite(mc) && x.cssHeight > mc) throw new Error(`像素法重排破坏不变量：段 ${x.index} cssHeight=${x.cssHeight} > chunkCss=${mc}`);
    if (!(x.y >= 0 && x.y < plan.docHeight && x.cssHeight > 0)) throw new Error(`像素法重排产生越界段：y=${x.y} cssH=${x.cssHeight}`);
  }
  const out = Object.assign({}, plan, { count: merged.length, slices: merged });
  return out;
}

/* ── 页面测量（只读 evaluate；快照字段一次取齐，避免多次往返放大 TTFT） ──
 * 图片三态统计用 classifyImg 的**同一份源码**（toString 内嵌）——判据真源单点，Node 侧与页内不可能漂移。
 * ⚠ 就绪判据是 naturalWidth > 1（占位 SVG 的 naturalWidth 恒为 1，不是 0）；绝不出现 naturalWidth > 0。 */
const PAGE_EXPR = `(() => {
  const de = document.documentElement || {};
  const b = document.body || {};
  const ATTRS = ${JSON.stringify(IMG_SRC_ATTRS)};
  const classifyImg = ${classifyImg.toString()};
  const dataSrcOf = (im) => {
    for (const a of ATTRS) { const v = im.getAttribute(a); if (v && String(v).trim()) return String(v).trim(); }
    return '';
  };
  const hs = [de.scrollHeight, de.offsetHeight, b.scrollHeight, b.offsetHeight]
    .filter((v) => typeof v === 'number' && isFinite(v));
  const imgs = Array.prototype.slice.call(document.images || []);
  let placeholder = 0, pending = 0, loaded = 0;
  for (const im of imgs) {
    if (!im) { pending++; continue; }
    const kind = classifyImg({
      src: im.getAttribute('src') || '',
      cls: String(im.getAttribute('class') || ''),
      naturalWidth: Number(im.naturalWidth) || 0,
      hasDataSrc: !!dataSrcOf(im),
      complete: !!im.complete,
    });
    if (kind === 'placeholder') placeholder++; else if (kind === 'loaded') loaded++; else pending++;
  }
  return {
    docHeight: hs.length ? Math.max.apply(null, hs) : 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollY: window.scrollY,
    images: { total: imgs.length, placeholder, pending, loaded },
    readyState: document.readyState,
  };
})()`;

/* 强制 data-src 赋值表达式（--img-promote；**纯属性赋值**：不 dispatchEvent、不合成点击——红线 #1）。
 * 两阶段：①只读——遍历统计三态 + 收集候选（真源属性优先级 = IMG_SRC_ATTRS 顺序）；
 *        ②赋值——仅对「当前 src 仍是占位/空」的候选做 img.src = 值，成功者打标 data-cu-promoted="1"。
 * 幂等：已 promote 的图 src 不再占位 → 第二轮不会重复计为候选。 */
const IMG_PROMOTE_EXPR = `(() => {
  const ATTRS = ${JSON.stringify(IMG_SRC_ATTRS)};
  const PROMOTED_ATTR = ${JSON.stringify(IMG_PROMOTED_ATTR)};
  const classifyImg = ${classifyImg.toString()};
  const dataSrcOf = (im) => {
    for (const a of ATTRS) { const v = im.getAttribute(a); if (v && String(v).trim()) return String(v).trim(); }
    return '';
  };
  const placeholderSrc = (src, nw) => {
    const s = String(src || '').trim();
    if (!s) return true;
    if (/^data:image\\/svg/i.test(s)) return true;
    if (/^data:/i.test(s) && (Number(nw) || 0) <= 1) return true; // 1×1 data: gif/png 惰性占位片
    return false;
  };
  const imgs = Array.prototype.slice.call(document.images || []);
  const plan = [];
  let placeholder = 0, pending = 0, loaded = 0;
  // ① 只读阶段：先统计再赋值（统计值 = 页面当前真实状态，不含本函数将要造成的改变）
  for (const im of imgs) {
    if (!im) { pending++; continue; }
    const src = im.getAttribute('src') || '';
    const cls = String(im.getAttribute('class') || '');
    const nw = Number(im.naturalWidth) || 0;
    const dataSrc = dataSrcOf(im);
    const kind = classifyImg({ src, cls, naturalWidth: nw, hasDataSrc: !!dataSrc, complete: !!im.complete });
    if (kind === 'placeholder') placeholder++; else if (kind === 'loaded') loaded++; else pending++;
    // 幂等：本轮已赋值过的跳过（新 src 若仍是 data: 占位形态，naturalWidth 会先归 0，别误判成候选再提一遍）
    if (im.getAttribute(PROMOTED_ATTR) === '1') continue;
    if (dataSrc && placeholderSrc(src, nw) && !/^data:image\\/svg/i.test(dataSrc)) {
      plan.push({ im, value: dataSrc });
    }
  }
  // ② 赋值阶段（渲染加速：会触发真实网络图片请求；不改业务状态）
  let promoted = 0, failed = 0;
  for (const p of plan) {
    try {
      p.im.src = p.value;
      // 成功判据只看「真源已写上」：非空且不再是 SVG 占位（新 src 的 naturalWidth 会先归 0，不能拿它判成败）
      const after = String(p.im.getAttribute('src') || '').trim();
      if (after && !/^data:image\\/svg/i.test(after)) { p.im.setAttribute(PROMOTED_ATTR, '1'); promoted++; }
      else failed++;
    } catch (e) { failed++; }
  }
  return { total: imgs.length, candidates: plan.length, promoted, failed, placeholder, pending, loaded };
})()`;

/** 读页面几何/图片就绪状态（只读；不触发任何业务副作用） */
async function readPage(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', { expression: PAGE_EXPR, returnByValue: true }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v) throw new Error('页面测量返回空值（Runtime.evaluate returnByValue 无 result.value）');
  return {
    docHeight: Number(v.docHeight) || 0,
    viewportWidth: Number(v.viewportWidth) || 0,
    viewportHeight: Number(v.viewportHeight) || 0,
    dpr: Number(v.dpr) || 1,
    scrollY: Number(v.scrollY) || 0,
    images: {
      total: Number(v.images && v.images.total) || 0,
      placeholder: Number(v.images && v.images.placeholder) || 0,
      pending: Number(v.images && v.images.pending) || 0,
      loaded: Number(v.images && v.images.loaded) || 0,
    },
    readyState: v.readyState,
  };
}

/* ── 切点吸附：元素 rect 只读采集（F15） ─────────────────────────────────────
 * 只读表达式（红线：不写 DOM / 不 dispatch 事件）：一次遍历取「可见内容元素」的文档坐标 rect。
 * 只取**有直接文本节点**的元素 + 替换元素（img/svg/video/canvas/…）——容器 div 的 rect 覆盖整段，
 * 若把它们算作遮挡则整页无空白带可找（这是"空白带"语义的关键取舍，写进 SKILL.md 说明）。
 * 排除：display:none / visibility:hidden|collapse / 零面积 / position:fixed|sticky（浮层与吸顶条的
 * getBoundingClientRect 随滚动漂移，文档坐标不可信）。rect 返回 [top,bottom]（只关心水平带，忽略 x）。
 * 硬帽 MAX_SNAP_RECTS 条（超长页 JSON 体积兜底，truncated 如实回报）。 */
const RECTS_EXPR = `(() => {
  const sy = window.scrollY || 0;
  const LIMIT = ${MAX_SNAP_RECTS};
  const REPLACED = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|INPUT|BUTTON|TEXTAREA|SELECT|HR|OBJECT|EMBED)$/;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK|HEAD|TITLE|BASE)$/;
  const root = document.body || document.documentElement;
  if (!root) return { rects: [], total: 0, truncated: 0, scrollY: sy, docHeight: 0 };
  const els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
  const rects = [];
  let truncated = 0;
  for (const el of els) {
    if (rects.length >= LIMIT) { truncated++; continue; }
    const tag = String(el.tagName || '').toUpperCase();
    if (SKIP.test(tag)) continue;
    const cs = window.getComputedStyle(el);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
    if (cs.position === 'fixed' || cs.position === 'sticky') continue;
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue && String(n.nodeValue).trim()) { hasText = true; break; }
    }
    if (!hasText && !REPLACED.test(tag)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) continue;
    const top = r.top + sy, bottom = r.bottom + sy;
    if (!isFinite(top) || !isFinite(bottom)) continue;
    rects.push([Math.round(top), Math.round(bottom)]);
  }
  const de = document.documentElement || {};
  return { rects, total: els.length, truncated, scrollY: sy, docHeight: de.scrollHeight || 0 };
})()`;

/** 读元素 rect（只读 evaluate；失败抛错由 runScrollShot fail-soft 兜底——吸附是增强，绝不阻断截图） */
async function readRects(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', { expression: RECTS_EXPR, returnByValue: true }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v || !Array.isArray(v.rects)) throw new Error('元素 rect 采集返回空值（Runtime.evaluate returnByValue 无 rects 数组）');
  return {
    rects: v.rects,
    total: Number(v.total) || 0,
    truncated: Number(v.truncated) || 0,
    scrollY: Number(v.scrollY) || 0,
    docHeight: Number(v.docHeight) || 0,
  };
}

/**
 * 读页面前台的 visibilityState（只读；失败 fail-soft 返回 {visibility:null, error}——由调用方按"不可信"处理）。
 * 独立成小函数是为了 selftest 能按表达式精确打桩，且失败不掩盖真正诉求（前台保障不能因读失败而静默跳过）。
 * @returns {Promise<{visibility:('visible'|'hidden'|'prerender'|null), error?:string}>}
 */
async function readVisibility(client, sessionId, timeoutMs) {
  try {
    const r = await client.send('Runtime.evaluate', { expression: VISIBILITY_EXPR, returnByValue: true }, { sessionId, timeoutMs });
    const v = r && r.result && r.result.value;
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!s) return { visibility: null, error: 'visibilityState 返回空值/非字符串' };
    return { visibility: s };
  } catch (e) {
    return { visibility: null, error: fmtErr(e) };
  }
}

/**
 * 开工前前台保障（V202610220003，selftest #86 直测）：见文件头 ⑧。
 * **必须早于第一次测量/预热**——后台页签下 raw captureScreenshot 会 30s 超时甚至返回旧帧。
 * 恒返回 foreground 记录（形状恒定，失败也如实标注，不抛错——前台保障失败不该让整轮截图中断）：
 *   {enabled, beforeVisibility, afterVisibility, broughtToFront, bringToFront, userWasOnOtherTab, note}
 * userWasOnOtherTab = 目标页签原本在后台（hidden）——此时"前台"属于别的页签（可能是用户的，也可能是
 * 另一个 agent 的）；**不自动还原**的理由见文件头 ⑧。
 * @param {{foreground?:boolean, timeoutMs?:number, tag?:string}} opts  tag=复用方日志前缀（默认 'scroll-shot'；cast 传 'cast'）
 */
async function ensureForeground(client, sessionId, opts) {
  const o = opts || {};
  const enabled = o.foreground !== false;
  const tag = o.tag ? String(o.tag) : 'scroll-shot'; // 复用方的日志前缀（cast 传 'cast'；默认行为零变化）
  const fg = {
    enabled,
    beforeVisibility: null,
    afterVisibility: null,
    broughtToFront: false,
    bringToFront: null,        // 'ok' | 'not-needed' | 'skipped' | 错误串
    userWasOnOtherTab: false,
    note: '',
  };
  const first = await readVisibility(client, sessionId, o.timeoutMs);
  fg.beforeVisibility = first.visibility;
  const untrusted = first.visibility === null;
  fg.userWasOnOtherTab = first.visibility === 'hidden';

  // ① --no-foreground：显式放弃保障——检测到后台必须强告警（静默错图比报错更危险）
  if (!enabled) {
    fg.bringToFront = 'skipped';
    fg.afterVisibility = fg.beforeVisibility;
    if (fg.beforeVisibility === 'hidden' || untrusted) {
      log.warn(tag, FOREGROUND_BG_WARNING);
      console.error(`[${tag}] ${FOREGROUND_BG_WARNING}`); // CLI 安全契约（selftest #86③ 断言 stderr）：必须让操作者看见
      fg.note = `已按 --no-foreground 放弃前台保障；${FOREGROUND_BG_WARNING}`;
    } else {
      fg.note = '已按 --no-foreground 放弃前台保障（目标页签原本 visible，本次超时/旧帧风险低）';
    }
    return fg;
  }

  // ② 原本就在前台 → 不做任何多余动作（不打扰用户）
  if (fg.beforeVisibility === 'visible') {
    fg.afterVisibility = 'visible';
    fg.bringToFront = 'not-needed';
    fg.note = '目标页签原本在前台（visibilityState=visible）——未做多余动作';
    return fg;
  }

  // ③ hidden 或读取失败（无法证明在前台 → 按不可信处理）→ 置前 + 复核
  try {
    await client.send('Page.bringToFront', {}, { sessionId, timeoutMs: o.timeoutMs });
    fg.broughtToFront = true;
    fg.bringToFront = 'ok';
  } catch (e) {
    fg.bringToFront = fmtErr(e);
  }
  const second = await readVisibility(client, sessionId, o.timeoutMs);
  fg.afterVisibility = second.visibility;
  const why = fg.beforeVisibility === 'hidden'
    ? '目标页签原在后台（visibilityState=hidden）'
    : `visibilityState 读取失败（${first.error || '未知'}），按不可信处理`;
  if (!fg.broughtToFront) {
    fg.note = `${why}；Page.bringToFront 失败（${fg.bringToFront}）——目标页签可能仍在后台，截图可能超时/返回旧帧`;
    log.warn(tag, `⚠ Page.bringToFront 失败（${fg.bringToFront}）：${FOREGROUND_BG_WARNING}`, { echo: true });
    return fg;
  }
  if (fg.afterVisibility === 'visible') {
    fg.note = `${why} → 已 Page.bringToFront 并复核 visible；⚠ Chrome 无「查询上一活跃 target」的稳定 API，`
      + '默认**不自动还原**前台——可能已把前台从用户的页签切走';
  } else {
    fg.note = `${why} → 已 Page.bringToFront，但复核 visibilityState=${fg.afterVisibility || '读取失败'}（置前未生效，如实记录）`;
    log.warn(tag, `⚠ Page.bringToFront 后 visibilityState=${fg.afterVisibility || '读取失败'}——置前未生效，截图仍可能超时/返回旧帧`, { echo: true });
  }
  return fg;
}

/** 强制 data-src 赋值（IMG_PROMOTE_EXPR；只读统计 + 纯属性赋值，无合成事件）→ 返回统计 */
async function promoteImages(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', { expression: IMG_PROMOTE_EXPR, returnByValue: true }, { sessionId, timeoutMs });
  const v = (r && r.result && r.result.value) || {};
  return {
    total: Number(v.total) || 0,
    candidates: Number(v.candidates) || 0,
    promoted: Number(v.promoted) || 0,
    failed: Number(v.failed) || 0,
    placeholder: Number(v.placeholder) || 0,
    pending: Number(v.pending) || 0,
    loaded: Number(v.loaded) || 0,
  };
}

/** 滚动定位（只读语义；**不用合成事件**）→ 返回读回的 scrollY（未达目标由调用方如实记录） */
async function scrollTo(client, sessionId, y, timeoutMs) {
  const target = Math.max(0, Math.round(Number(y) || 0));
  const r = await client.send('Runtime.evaluate', {
    expression: `(() => { window.scrollTo(0, ${target}); return window.scrollY; })()`,
    returnByValue: true,
  }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  return Number(v) || 0;
}

/**
 * 懒加载预热（顺序 = promote → 滚动 → 等就绪 → settle）：
 *   ① --img-promote（默认开）：遍历 document.images 强制 data-src 赋值 → 图片就绪的**主负责路径**；
 *   ② 逐屏下滚（0.9 视口高/步）→ 到底后等高度稳定（连续 STABLE_SAMPLES 次采样不变，上限 prewarmSamples）
 *      → 回顶：滚动只负责**背景图与非图片懒加载兜底**（F9 结论：微信内部 IntersectionObserver+队列，
 *      滚动不可靠，实测 700px/180ms 慢滚到底仍有多张停占位符——所以图片不靠滚动）；
 *   ③ 等就绪（classifyImg 三态：pending=0 才算就绪；带 --image-timeout，未就绪如实记 imagesPending）；
 *   ④ 固定等 --img-settle（默认 1800ms，GIF 首帧解码；0 关）。
 * 每步读回 scrollY 校验；未达目标记 scrollMismatches（最多 20 条，超出只计数）。
 * @returns 预热统计（原样进清单 prewarm 字段）
 */
async function prewarm(client, sessionId, opts) {
  const settleMs = opts.settleMs;
  const timeoutMs = opts.timeoutMs;
  const maxSamples = opts.prewarmSamples;
  const t0 = Date.now();
  const imgPromoteEnabled = opts.imgPromote !== false;
  const first = await readPage(client, sessionId, timeoutMs);
  const vpH = Math.max(1, Math.round(first.viewportHeight));
  const stepPx = Math.max(1, Math.round(vpH * PREWARM_STEP_RATIO));
  const stats = {
    originalScrollY: Math.round(first.scrollY),
    stepPx,
    scrollSteps: 0,
    scrollMismatchCount: 0,
    scrollMismatches: [],
    rounds: 0,
    heightSamples: [],
    docHeightBefore: first.docHeight,
    docHeightAfter: first.docHeight,
    heightGrew: false,
    // 图片三态（total/placeholder/pending/loaded；就绪判据见 classifyImg——不是 naturalWidth > 0）
    images: Object.assign({}, first.images),
    imagesBefore: Object.assign({}, first.images),
    imagesPending: first.images.pending,
    imageWaits: 0,
    // 强制 data-src 赋值统计（enabled=false 时全 0，如实记录未启用）
    imgPromote: imgPromoteEnabled
      ? { enabled: true, candidates: 0, promoted: 0, failed: 0, rounds: 0, detail: [] }
      : { enabled: false, candidates: 0, promoted: 0, failed: 0, rounds: 0, detail: [] },
    imgSettleMs: 0,
    elapsedMs: 0,
  };
  // ① 强制 data-src 赋值（图片就绪的**主负责路径**；滚动预热只做背景图/非图片懒加载兜底）
  if (imgPromoteEnabled) {
    const p1 = await promoteImages(client, sessionId, timeoutMs);
    stats.imgPromote.candidates += p1.candidates;
    stats.imgPromote.promoted += p1.promoted;
    stats.imgPromote.failed += p1.failed;
    stats.imgPromote.rounds = 1;
    stats.imgPromote.detail.push(p1);
  }
  let docH = first.docHeight;
  for (let round = 0; round < MAX_PREWARM_ROUNDS; round++) {
    stats.rounds = round + 1;
    const maxScrollY = Math.max(0, docH - vpH);
    let y = stepPx;
    for (let i = 0; i < MAX_PREWARM_STEPS; i++) {
      // 步长推进但**夹到页面可滚动上限**——最后一屏必须真正滚到底，否则底部懒加载图永远不进视口
      const target = Math.min(y, maxScrollY);
      const actual = await scrollTo(client, sessionId, target, timeoutMs);
      stats.scrollSteps++;
      if (Math.abs(actual - target) > SCROLL_TOL) {
        stats.scrollMismatchCount++;
        if (stats.scrollMismatches.length < MAX_MISMATCH_RECORDS) {
          stats.scrollMismatches.push({ requested: target, actual: Math.round(actual), expected: target });
        }
      }
      if (settleMs) await sleep(settleMs);
      if (actual >= maxScrollY - SCROLL_TOL) break; // 已到底
      y += stepPx;
    }
    // 底部稳定采样：高度连续 STABLE_SAMPLES 次不变即稳定（懒加载/瀑布流追加会拉高 docHeight）
    let prev = docH;
    let stable = 1;
    let grew = false;
    for (let s = 0; s < maxSamples; s++) {
      if (settleMs) await sleep(settleMs);
      const m = await readPage(client, sessionId, timeoutMs);
      stats.heightSamples.push(m.docHeight);
      if (m.docHeight === prev) stable++;
      else { stable = 1; prev = m.docHeight; }
      stats.docHeightAfter = prev;
      if (m.docHeight > docH) { grew = true; docH = m.docHeight; }
      if (stable >= STABLE_SAMPLES) break;
    }
    if (grew) { stats.heightGrew = true; continue; } // 高度增长 → 重扫底部（轮次上限内）
    break;
  }
  // 回顶（后续按段滚动；这里先把页面放回起点，确保段 1 的视口内容正确）
  await scrollTo(client, sessionId, 0, timeoutMs);
  if (settleMs) await sleep(settleMs);

  // 等图片就绪（三态判据：pending=0 才算就绪；带超时，未就绪如实记录——不谎报）
  // 循环内允许**补做一轮** promote：滚动过程中新增的懒加载节点（或首轮因时机未赋值的）再提一次。
  const deadline = Date.now() + (opts.imageTimeoutMs || 0);
  let m = await readPage(client, sessionId, timeoutMs);
  let rePromoted = false;
  while (m.images.pending > 0 && Date.now() < deadline) {
    if (imgPromoteEnabled && !rePromoted) {
      rePromoted = true;
      const p2 = await promoteImages(client, sessionId, timeoutMs);
      if (p2.candidates > 0) {
        stats.imgPromote.candidates += p2.candidates;
        stats.imgPromote.promoted += p2.promoted;
        stats.imgPromote.failed += p2.failed;
        stats.imgPromote.rounds += 1;
        stats.imgPromote.detail.push(p2);
      }
    }
    const wait = Math.max(20, Math.min(settleMs || 200, 250));
    await sleep(wait);
    stats.imageWaits++;
    m = await readPage(client, sessionId, timeoutMs);
  }
  // 固定等首帧解码（GIF 即使加载完也要等首帧；--img-settle 0 关闭；dry-run 不等——不截图就没必要）
  if (opts.imgSettleMs > 0 && !opts.dryRun) {
    await sleep(opts.imgSettleMs);
    stats.imgSettleMs = opts.imgSettleMs;
    m = await readPage(client, sessionId, timeoutMs);
  }
  stats.images = Object.assign({}, m.images);
  stats.imagesPending = m.images.pending;
  stats.docHeightAfter = m.docHeight;
  stats.elapsedMs = Date.now() - t0;
  return stats;
}

/* ── 取图通道 ── */
function writeBin(file, base64) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('截图返回空数据');
  /* 产物配额准入（V202611030005 B3 N2）：单产物上限/总配额超限 → E_QUOTA（抛给 CLI 收口，不落半文件） */
  const q = require('./quota').check({ file, bytes: buf.length, cmd: 'scroll-shot' });
  if (!q.ok) {
    const e = new Error(q.message);
    e.code = q.code;
    throw e;
  }
  if (q.message) log.warn('scroll-shot', q.message, { echo: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** A 路径参数（几何精确）：整段 clip 一次取，captureBeyondViewport 允许越过当前视口。
 *  高度取 captureHeight（= cssHeight + overlap，非末段），--overlap 不改变切段位置只向下多拍。 */
function clipParams(slice, viewportWidth, format, quality) {
  const height = slice.captureHeight != null ? slice.captureHeight : slice.cssHeight;
  const p = {
    clip: { x: 0, y: slice.y, width: viewportWidth, height, scale: 1 },
    captureBeyondViewport: true,
    format,
  };
  if (format === 'jpeg' && quality != null) p.quality = quality;
  return p;
}

function fmtErr(e) {
  if (!e) return 'unknown';
  return `${e.kind ? `[${e.kind}]` : ''}${String(e.message || e).slice(0, 160)}`;
}

/* ── ffmpeg / ffprobe（可选依赖：缺失 → B 路径如实失败，绝不假装成功） ──
 * 路径解析/真探活单源 = lib/platform 的 binaries provider（config.bin > 内置 bin/（含 .exe 探测）；
 * 不回落 PATH——bin/ 单点真源，2026-10-28 用户裁定）。本模块仅保留导出面形状 {ffmpeg, ffprobe}。 */
function ffmpegBins() {
  const r = platform().binaries.resolve();
  return { ffmpeg: r.ffmpeg, ffprobe: r.ffprobe };
}
/** 可用性 = 文件在位 AND 真实探活（`-version` 退出码 0）；探活缓存收敛在 provider 内部（5s 超时防挂）。
 *  只判 existsSync 会误判：非 ELF/损坏/依赖缺失的同名文件照样"存在"（2026-10-28 ISSUE-4）。 */
function ffmpegAvailable() {
  const b = ffmpegBins();
  const { probeVersion } = platform().binaries;
  return probeVersion(b.ffmpeg) && probeVersion(b.ffprobe);
}
/** 读图尺寸（ffprobe JSON）；不可用/失败 → null（调用方如实降级到按 dpr 估算） */
function probeImage(file) {
  const bins = platform().binaries;
  const r = bins.resolve();
  if (!r.exists.ffprobe) return null;
  try {
    const probe = spawnSync(r.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { timeout: 15000, encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout) return null;
    const j = JSON.parse(probe.stdout);
    const s = (j.streams || [])[0];
    return s && s.width && s.height ? { width: Number(s.width), height: Number(s.height) } : null;
  } catch { return null; }
}

/* ── 空白段自检（F13，2026-10-22；**advisory 默认**——报告不判死） ──────────────
 * 背景：懒加载占位符 bug（V202610220001）修完，工具本身仍无"截完自检"能力；他方测修复前后靠外部脚本
 *   （灰度 → 每 80px 一行均值 → 连续 >10 行亮度 >248 判空白段），140 篇一次扫约 3 分钟，量化 31 篇 → 3 篇。
 *   剩下 3 篇经 DOM 逐篇复验 remaining=0、截图高=文档高 → **文章本身设计留白，不是缺陷**。
 *   ⇒ 因此本自检默认 advisory：只在日志/清单里报"疑似"，不改退出码；--blank-strict 才让可疑段 → exit 1
 *     （且清单 status 仍记 ok，避免把"截图失败"与"内容留白"混为一谈）。
 * 通道（零依赖，只读原图）：
 *   ① ffprobe 取像素高 H；
 *   ② ffmpeg -vf scale=1:H:flags=area,format=gray -pix_fmt gray -f rawvideo - → stdout 得 H 字节，
 *      每字节 = 该行平均亮度（实测 scale=1:270 → 270 字节）。
 *      ⚠ scale=1:-1 / scale=1:-2 报 `-22 Invalid argument`，必须显式给高度（先 ffprobe）。
 *      只读语义：不重编码、不改/不覆盖原文件，结果只走 stdout（selftest #84 源断言机检）。
 *   fail-soft：ffmpeg/ffprobe 缺失或调用失败 → **不阻断截图**，逐段 blank.checked=false + reason，
 *      顶层 blankSummary.ffmpeg=false + note，与 B 路径的 ffmpeg 兜底同风格（如实标注，不假装通过）。
 */

/**
 * 行游程归并（纯函数，selftest #84 直测）：把行亮度数组里连续满足 `luma >= threshold` 的行归并成游程。
 * 只保留 `rows >= minPx` 的游程（短空白段是正常排版留白/行距，不该报）。
 * 区间语义：from = 起始行（0 基，含），to = 结束行（不含）⇒ rows = to - from。
 * @param {Buffer|Uint8Array|number[]} luma 每字节 = 该行平均亮度（0~255）
 * @param {{threshold?:number, minPx?:number}} [opts]
 * @returns {Array<{from:number,to:number,rows:number}>}
 */
function blankRuns(luma, opts) {
  const o = opts || {};
  const threshold = o.threshold == null ? DEFAULT_BLANK_THRESHOLD : Number(o.threshold);
  const minPx = o.minPx == null ? DEFAULT_BLANK_MIN_PX : Number(o.minPx);
  if (!Number.isInteger(threshold) || threshold < BLANK_THRESHOLD_MIN || threshold > BLANK_THRESHOLD_MAX) {
    throw usageErr(`--blank-threshold 须为 ${BLANK_THRESHOLD_MIN}~${BLANK_THRESHOLD_MAX} 的整数：${JSON.stringify(o.threshold)}`);
  }
  if (!Number.isInteger(minPx) || minPx < BLANK_MIN_PX_MIN || minPx > BLANK_MIN_PX_MAX) {
    throw usageErr(`--blank-min-px 须为 ${BLANK_MIN_PX_MIN}~${BLANK_MIN_PX_MAX} 的整数：${JSON.stringify(o.minPx)}`);
  }
  const arr = luma || [];
  const rows = arr.length || 0;
  const runs = [];
  let start = -1;
  for (let i = 0; i < rows; i++) {
    const bright = Number(arr[i]) >= threshold;
    if (bright && start < 0) start = i;
    else if (!bright && start >= 0) { runs.push({ from: start, to: i, rows: i - start }); start = -1; }
  }
  if (start >= 0) runs.push({ from: start, to: rows, rows: rows - start });
  // minPx=0 的边界语义如实：任何非空游程都算「可疑」（调用方显式选择了"见白即报"）
  return runs.filter((r) => r.rows >= minPx);
}

/**
 * 空白段判定（纯函数，selftest #84 直测）：游程归并 + ratio + suspect。
 * ratio = Σrun.rows / H（按**全部**保留游程算）；runs 只保留前 BLANK_MAX_RUNS 条（清单体积可控），
 * runsTotal 如实给出真实条数（截断不隐瞒）。
 * suspect 判据 = 存在任何保留游程（即"连续 ≥minPx 行亮度 ≥threshold"）。
 * @returns {{suspect:boolean, ratio:number, runs:Array<{from,to,rows}>, runsTotal:number, rows:number,
 *            threshold:number, minPx:number}}
 */
function analyzeBlankSections(luma, opts) {
  const o = opts || {};
  const threshold = o.threshold == null ? DEFAULT_BLANK_THRESHOLD : Number(o.threshold);
  const minPx = o.minPx == null ? DEFAULT_BLANK_MIN_PX : Number(o.minPx);
  const rows = (luma && luma.length) || 0;
  const runs = blankRuns(luma, { threshold, minPx });
  const blankRows = runs.reduce((s, r) => s + r.rows, 0);
  return {
    suspect: runs.length > 0,
    ratio: rows > 0 ? Math.round((blankRows / rows) * 10000) / 10000 : 0,
    runs: runs.slice(0, BLANK_MAX_RUNS),
    runsTotal: runs.length,
    rows,
    threshold,
    minPx,
  };
}

/** 行剖面（真实通道）：ffprobe 取高 → ffmpeg 缩成 1 宽灰度 rawvideo（stdout）。失败抛错，由调用方 fail-soft。 */
function lumaProfile(file) {
  const b = ffmpegBins();
  if (!fs.existsSync(b.ffmpeg) || !fs.existsSync(b.ffprobe)) {
    const e = new Error('bin/ffmpeg 或 bin/ffprobe 不可用');
    e.kind = 'ffmpeg-missing';
    throw e;
  }
  const dim = probeImage(file);
  if (!dim || !dim.height) throw new Error(`ffprobe 无法读取图高：${path.basename(file)}`);
  const h = dim.height;
  const r = spawnSync(b.ffmpeg, [
    '-v', 'error', '-i', file,
    '-vf', `scale=1:${h}:flags=area,format=gray`,
    '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
  ], { timeout: BLANK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`ffmpeg 行剖面执行失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg 行剖面失败（exit ${r.status}）：${String(r.stderr || '').trim().slice(0, 160)}`);
  const out = r.stdout;
  if (!out || !out.length) throw new Error('ffmpeg 行剖面输出为空');
  // 行数 = 实际字节数（诚实口径：报告的是真实样本长度；与 ffprobe 高度不一致时以实测为准）
  return { height: h, luma: out };
}

/**
 * 像素法兜底（F15，--snap-px 显式开；**fail-soft**：任何异常都只返回 ok=false + reason，绝不抛错）。
 * 通道完全复用 F13：bin/ffprobe 取高 → bin/ffmpeg `scale=1:H:flags=area,format=gray` 得每行平均亮度；
 * 连续 ≥ round(12×dpr) 行亮度 ≥ threshold（沿用 --blank-threshold，默认 247）的游程 → 换算成文档 CSS 坐标
 * 的空白带 → 交给 snapPoint（与 DOM 法同一套"最近带/clamp/放弃"语义）。
 * 搜索区间 = 段尾 ±window 的**已落盘图可见部分**：向上 window 全在图内；向下只有 overlap 部分（图外像素
 * 不可得）——所以 --overlap 0（默认）时切点只可能上移（不产生内容缺口），overlap>0 时可在 overlap 内下移。
 * @param {string} file 已落盘的当前段图
 * @param {{yCss:number, cutCss:number, dpr:number, windowPx?:number, minBandPx?:number,
 *          threshold?:number, overlapPx?:number, minSlicePx?:number, chunkCss?:number, docH?:number}} opts
 * @returns {{ok:boolean, reason?:string, prof?:object, cut?:number, from?:number, to?:number, shift?:number}}
 */
function pxSnapCut(file, opts) {
  const o = opts || {};
  let prof;
  try {
    prof = lumaProfile(file);
  } catch (e) {
    return { ok: false, reason: `像素法兜底跳过（${fmtErr(e)}）` };
  }
  const luma = prof && prof.luma ? prof.luma : prof;
  const H = luma && luma.length ? luma.length : 0;
  if (!H) return { ok: false, reason: '像素法兜底跳过（行剖面为空）' };
  const dprNum = Number(o.dpr);
  const dpr = Number.isFinite(dprNum) && dprNum > 0 ? dprNum : 1;
  const yCss = Number(o.yCss);
  const cutCss = Number(o.cutCss);
  if (!Number.isFinite(yCss) || !Number.isFinite(cutCss) || !(cutCss > yCss)) {
    return { ok: false, reason: `像素法兜底跳过（段几何非法：y=${JSON.stringify(o.yCss)} cut=${JSON.stringify(o.cutCss)}）` };
  }
  const threshold = o.threshold == null ? DEFAULT_BLANK_THRESHOLD : Number(o.threshold);
  const minBandPx = o.minBandPx == null ? SNAP_MIN_BAND_PX : Number(o.minBandPx);
  const windowPx = o.windowPx == null ? DEFAULT_SNAP_WINDOW : Number(o.windowPx);
  const docH = Number(o.docH);
  const minSlice = o.minSlicePx == null ? snapMinSlice(0, 1) : Number(o.minSlicePx);
  // 图底（CSS 文档坐标）：已拍图不可变矮，切点最远只能到图底
  const imgBottomCss = yCss + H / dpr;
  const overlapCss = Number(o.overlapPx) || 0;
  const winLoCss = Math.max(yCss, cutCss - windowPx);
  const winHiCss = Math.min(imgBottomCss, cutCss + Math.min(windowPx, overlapCss));
  try {
    const runs = blankRuns(luma, { threshold, minPx: 1 });
    const bands = runs.map((r) => ({
      from: yCss + r.from / dpr,
      to: yCss + Math.min(H, r.to) / dpr,
    })).filter((b) => b.to > winLoCss && b.from < winHiCss);
    const lastMin = Number.isFinite(docH) && docH > cutCss ? Math.min(minSlice, docH - cutCss) : 0;
    const res = snapPoint(cutCss, bands, {
      windowPx,
      minBandPx,
      min: yCss + minSlice,
      max: Math.min(Number.isFinite(o.chunkCss) ? yCss + Number(o.chunkCss) : imgBottomCss,
        Number.isFinite(docH) ? docH - lastMin : imgBottomCss, imgBottomCss),
      docH: Number.isFinite(docH) && docH > 0 ? docH : imgBottomCss,
    });
    if (res.method === 'none') return { ok: false, reason: '像素法兜底未找到合格空白带（回落原切点）', prof };
    return { ok: true, prof, cut: res.cut, from: res.from, to: res.to, shift: res.shift };
  } catch (e) {
    return { ok: false, reason: `像素法兜底失败（${fmtErr(e)}）`, prof };
  }
}


/** 可注入依赖（selftest #84：ffmpeg 缺失/合成剖面零副作用；生产路径恒为真实 bin） */
function blankDeps(over) {
  const d = over || {};
  return {
    available: typeof d.available === 'function' ? d.available : ffmpegAvailable,
    luma: typeof d.luma === 'function' ? d.luma : lumaProfile,
  };
}

/**
 * 单段空白自检（fail-soft；**绝不抛错**，也不碰原图）。
 * @param {string} file 已落盘的段图
 * @param {{threshold?:number, minPx?:number, deps?:object}} [opts]
 * @returns {{ffmpeg:boolean, checked:boolean, elapsedMs:number,
 *            blank?:object, reason?:string}}
 */
function blankCheckImage(file, opts) {
  const o = opts || {};
  const deps = blankDeps(o.deps);
  const t0 = Date.now();
  let available = false;
  try { available = !!deps.available(); } catch { available = false; }
  if (!available) {
    return { ffmpeg: false, checked: false, elapsedMs: Date.now() - t0, reason: '自检跳过（bin/ffmpeg 不可用）' };
  }
  try {
    const prof = deps.luma(file);
    const luma = prof && prof.luma ? prof.luma : prof;
    const blank = analyzeBlankSections(luma, { threshold: o.threshold, minPx: o.minPx });
    return { ffmpeg: true, checked: true, elapsedMs: Date.now() - t0, blank };
  } catch (e) {
    // 不吞错：原因如实进清单/日志（截图本体仍算成功——fail-soft 与 B 路径 ffmpeg 兜底同风格）
    return { ffmpeg: false, checked: false, elapsedMs: Date.now() - t0, reason: `自检跳过（${fmtErr(e)}）` };
  }
}

/** 段记录里的 blank 字段（形状恒一致：未检测时 checked=false + 0 值，不伪造"通过"） */
function blankField(res, threshold, minPx) {
  if (res && res.checked && res.blank) {
    return Object.assign({}, res.blank, { checked: true, elapsedMs: res.elapsedMs || 0 });
  }
  return {
    suspect: false, ratio: 0, runs: [], runsTotal: 0, rows: 0, threshold, minPx,
    checked: false, elapsedMs: (res && res.elapsedMs) || 0, reason: (res && res.reason) || '未检测',
  };
}

/** 最长游程（报告用："疑似空白 1200px"取最大那段） */
function longestBlankRun(blank) {
  const runs = (blank && blank.runs) || [];
  return runs.reduce((m, r) => Math.max(m, r.rows), 0);
}

/**
 * 顶层空白自检汇总（纯函数；单一出口，正常/中断/dry-run 三条路径共用——避免各分支口径漂移）。
 * strictFail **只在** --blank-strict 且存在可疑段时出现（清单 status 仍如实保留 ok/partial/failed）。
 * @param {{enabled:boolean, dryRun:boolean, minPx:number, threshold:number}} o
 * @param {{segments:number, suspectIndexes:number[], unavailable:boolean, reason:?string, elapsedMs:number}} st
 */
function buildBlankSummary(o, st) {
  const s = st || {};
  const suspectIndexes = (s.suspectIndexes || []).slice();
  const segments = s.segments || 0;
  const suspect = suspectIndexes.length > 0;
  const out = {
    segments,
    suspect,
    suspectIndexes,
    minPx: o.minPx,
    threshold: o.threshold,
    // 未检测（关闭/dry-run）时如实报告 bin 是否在位（不代表本次跑过检测，note 里写明）
    ffmpeg: (o.enabled && !o.dryRun) ? !s.unavailable : ffmpegAvailable(),
    elapsedMs: s.elapsedMs || 0,
  };
  if (!o.enabled) out.note = '已关闭空白自检（--no-blank-check）';
  else if (o.dryRun) out.note = 'dry-run 未做空白自检（无图）';
  else if (s.unavailable) out.note = s.reason || '自检跳过（bin/ffmpeg 不可用）';
  else if (!segments) out.note = '无成功段，未做空白自检';
  else if (suspect) {
    out.note = `可疑 ${suspectIndexes.length}/${segments} 段（阈值 ≥${o.threshold} 亮度 × ≥${o.minPx}px）`
      + '——默认仅提示（advisory），请人工确认是否为原文设计留白；--blank-strict 可让其判失败';
  } else out.note = `未发现可疑空白段（阈值 ≥${o.threshold} 亮度 × ≥${o.minPx}px）`;
  if (o.strict && suspect) out.strictFail = true;
  return out;
}

/**
 * B 路径拼接：按「实际 scrollY」与目标段区间求交后逐块裁剪，再 vstack——末段滚动 clamp（页面到底后
 * scrollY 不再增长）产生的重叠自然被裁掉，不产重叠/错位图。质量档透传（jpeg qscale 由 quality 反算）。
 * @returns {{width,height,shots:number}}
 */
function stitchVertical(shots, outFile, format, quality) {
  const b = ffmpegBins();
  if (!fs.existsSync(b.ffmpeg) || !fs.existsSync(b.ffprobe)) {
    throw new Error('bin/ffmpeg 或 bin/ffprobe 不可用——B（视口切片拼接）路径不可用，如实失败不产出错图');
  }
  if (!shots.length) throw new Error('B 路径无可用切片（求交为空）');
  const first = probeImage(shots[0].file);
  if (!first || !first.width) throw new Error(`ffprobe 无法读取切片尺寸：${shots[0].file}`);
  const scale = first.width / shots[0].viewportWidth; // 实际缩放（DPR 实测值，不靠猜）
  const crops = [];
  // 顺序游标：同一段内相邻视口截图可能重叠（页面到底后 scrollY 被 clamp）——只取游标之后的新增区域，
  // 保证拼接结果既无重叠也无空洞（总高严格 = 段高）。
  let cursor = shots[0].clipTop;
  for (const s of shots) {
    const top = Math.max(cursor, s.y);
    const bottom = Math.min(s.y + s.viewportHeight, s.clipBottom);
    if (!(bottom - top > 0)) continue;
    const imgH = first.height;
    let offPx = Math.round((top - s.y) * scale);
    let hPx = Math.round((bottom - top) * scale);
    if (offPx < 0) offPx = 0;
    if (offPx + hPx > imgH) hPx = Math.max(1, imgH - offPx);
    crops.push({ file: s.file, offPx, hPx, imgH });
    cursor = bottom;
  }
  if (!crops.length) throw new Error('B 路径切片与目标区间无交集（滚动失败？）');
  // 单块且整图即目标 → 直接拷贝，省一次重编码
  if (crops.length === 1 && crops[0].offPx === 0 && crops[0].hPx === crops[0].imgH) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.copyFileSync(crops[0].file, outFile);
  } else {
    const args = ['-y', '-loglevel', 'error'];
    for (const c of crops) args.push('-i', c.file);
    const parts = crops.map((c, i) => `[${i}:v]crop=iw:${c.hPx}:0:${c.offPx}[c${i}]`);
    const labels = crops.map((_, i) => `[c${i}]`).join('');
    parts.push(crops.length > 1 ? `${labels}vstack=inputs=${crops.length}[out]` : `${labels}null[out]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[out]');
    if (format === 'jpeg') {
      const q = quality == null ? DEFAULT_QUALITY : Number(quality);
      const qscale = Math.max(2, Math.min(31, Math.round(31 - 29 * (q / 100))));
      args.push('-q:v', String(qscale));
    }
    args.push(outFile);
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const r = spawnSync(b.ffmpeg, args, { timeout: 120000, encoding: 'utf8' });
    if (r.error) throw new Error(`ffmpeg 执行失败：${r.error.message}`);
    if (r.status !== 0) throw new Error(`ffmpeg 拼接失败（exit ${r.status}）：${String(r.stderr || '').trim().slice(0, 200)}`);
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg 拼接未产出输出文件');
  }
  const dim = probeImage(outFile) || first;
  return { width: dim.width, height: dim.height, shots: crops.length };
}

/**
 * B 路径取段：逐视口高滚动截视口图 → 按实际 scrollY 求交裁剪 → vstack。
 * ffmpeg 不可用 → 抛错（由调用方标 failed，如实失败）。
 */
async function captureSliceB(client, sessionId, ctx, slice) {
  if (!ffmpegAvailable()) {
    throw new Error('bin/ffmpeg/ffprobe 不可用——B（视口切片）路径不可用（如实失败，不产出错图）');
  }
  const { viewportHeight, viewportWidth, settleMs, timeoutMs, format, quality, tmpDir, tag, onNote } = ctx;
  const vpH = Math.max(1, Math.round(viewportHeight));
  const targetHeight = slice.captureHeight != null ? slice.captureHeight : slice.cssHeight;
  const shots = [];
  let lastY = null;
  for (let k = 0; k < MAX_B_SHOTS; k++) {
    const targetY = slice.y + k * vpH;
    const actual = Math.round(await scrollTo(client, sessionId, targetY, timeoutMs));
    if (settleMs) await sleep(settleMs);
    if (lastY !== null && Math.abs(actual - lastY) <= 1) break; // 到底后 clamp：重复帧不参与拼接
    lastY = actual;
    const params = { format };
    if (format === 'jpeg' && quality != null) params.quality = quality;
    const r = await client.send('Page.captureScreenshot', params, { sessionId, timeoutMs });
    const file = path.join(tmpDir, `${tag}-vp${String(k).padStart(2, '0')}${extOf(format)}`);
    writeBin(file, r.data);
    shots.push({ file, y: actual, viewportHeight: vpH, viewportWidth, clipTop: slice.y, clipBottom: slice.y + targetHeight });
    if (actual + vpH >= slice.y + targetHeight) break;
  }
  if (!shots.length) throw new Error('B 路径未取到任何视口截图');
  if (onNote) onNote(`B 路径已取 ${shots.length} 个视口切片，ffmpeg vstack 拼接中…`);
  const stitched = stitchVertical(shots, ctx.outFile, format, quality);
  return { bytes: fs.statSync(ctx.outFile).size, width: stitched.width, height: stitched.height, shots: shots.length };
}

/** PNG 降级是否可用（默认开；--no-format-fallback 显式关） */
function canFormatFallback(ctx) {
  return ctx.format === 'png' && ctx.formatFallback !== false;
}

/** 降级产物路径：编码换成 jpeg → 扩展名必须跟着换（证据文件不谎报编码） */
function fallbackFileFor(outFile) {
  return /\.png$/i.test(outFile) ? outFile.replace(/\.png$/i, '.jpg') : `${outFile}.jpg`;
}

/**
 * 重试/降级前重新落位（V202610220002）：captureScreenshot 超时（重负载实测 90s 级）会扰动滚动位置，
 * 重试若不重新 scrollTo 就会拍到旧位置内容（实弹：段 2/3 重复拍到同一白块，仍记 via=A）。
 * 复用 shotScopedScroll（含 settleMs 等待 + scrollY 读回校验 + scrollMismatches 记录，不重复实现）。
 * 成本：一次 Runtime.evaluate（毫秒级），只在重试/降级路径发生，正常路径零额外开销。
 * 计数双记：ctx.scrollRedone 累计（顶层 scrollRepositions）+ state.repositions 逐段（清单每段 repositions）。
 * @param {{repositions:number}} [state] 段级计数（由 captureSlice 创建并随返回值上报）
 */
async function repositionForRetry(client, sessionId, ctx, slice, state) {
  const actual = await shotScopedScroll(client, sessionId, slice.y, ctx);
  if (state) state.repositions = (state.repositions || 0) + 1;
  ctx.scrollRedone = (ctx.scrollRedone || 0) + 1;
  return actual;
}

/* ── A2 取图引擎（ISSUE-1，2026-11-18）：beyond-viewport legacy 回退 ─────────────
 * 触发：beyond 探测判定「不支持」且本段 captureHeight ≤ shot.VIEWPORT_CAP（超帽段保持原 A→B 链）。
 * 手法：段级 shot.beginEmulation 把视口撑到 captureHeight → 滚到 y（撑高后滚动上限变化，必须在此滚动）
 *   → Page.captureScreenshot **无 clip / 无 captureBeyondViewport**（彻底绕开 clip 坐标语义）
 *   → finally 恢复轮次级 emulate 状态（有则重施加轮次 plan、无则 clear；异常也恢复）。
 * Emulation 全部复用 lib/screenshot.js 的 beginEmulation/endEmulation 闸门（不新增裸 send——selftest #82 闸门）；
 * 失败仍落既有链条：A2 重试 1 次 → PNG 时 jpeg 降级（A2 版）→ B 逐视口兜底。
 * 对调用方透明的边界：Windows 有头浏览器 setDeviceMetricsOverride 会调整真实窗口 client 尺寸，截完即恢复
 * （与既有 --viewport-max-chunk 同现状）。 */

/** 段取图高（captureHeight 优先，缺省 cssHeight） */
function sliceCaptureHeight(slice) {
  return slice.captureHeight != null ? slice.captureHeight : slice.cssHeight;
}

/** A2 分叉条件（selftest #141 直测）：明确判「不支持」+ 段高/视口宽未超单边上限（超帽段保持 A→B） */
function shouldUseA2(ctx, slice) {
  if (!ctx || ctx.beyondSupported !== false) return false;
  const vp = Math.round(Number(ctx.viewportWidth));
  return vp > 0 && vp <= shot.VIEWPORT_CAP && sliceCaptureHeight(slice) <= shot.VIEWPORT_CAP;
}

/** 恢复轮次级 emulate 状态（A2 段后）：轮次级有覆盖 → 重施加同 plan；无 → clear 段级覆盖 */
async function restoreRoundEmulation(client, sessionId, ctx, st) {
  if (ctx.roundEmuActive) {
    try {
      const re = await shot.beginEmulation(client, sessionId, ctx.roundEmuOpts, ctx.timeoutMs);
      ctx.a2RoundReapplied = (ctx.a2RoundReapplied || 0) + 1;
      return re;
    } catch (e) {
      ctx.a2RestoreFailures = (ctx.a2RestoreFailures || 0) + 1;
      log.warn('scroll-shot', `⚠ A2 段后重施加轮次视口失败：${fmtErr(e)}——尝试清除覆盖兜底（如实记录）`);
    }
  }
  const done = await shot.endEmulation(client, sessionId, st, ctx.timeoutMs);
  if (done && done.restore && done.restore.ok === false) ctx.a2RestoreFailures = (ctx.a2RestoreFailures || 0) + 1;
  return done;
}

/** A2 单拍：撑视口 → 落位 → 无 clip 截图 → finally 恢复（异常也恢复；恢复失败如实计数，不吞截图错误） */
async function a2CaptureAttempt(client, sessionId, ctx, slice, params) {
  const height = sliceCaptureHeight(slice);
  const vp = Math.round(ctx.viewportWidth);
  let st = null;
  try {
    // 原生 DPR 可能超 --dpr 合法域 1~4：超域时不显式传（materializePlan 继承当前 DPR，几何不变）
    const dprNum = Number(ctx.dpr);
    const emuPlan = { viewport: `${vp}x${height}` };
    if (Number.isFinite(dprNum) && dprNum >= 1 && dprNum <= 4) emuPlan.dpr = dprNum;
    st = await shot.beginEmulation(client, sessionId, emuPlan, ctx.timeoutMs);
  } catch (e) {
    if (e && e.emulation) await restoreRoundEmulation(client, sessionId, ctx, e.emulation);
    throw e;
  }
  try {
    const actual = Math.round(await scrollTo(client, sessionId, slice.y, ctx.timeoutMs));
    if (ctx.settleMs) await sleep(ctx.settleMs);
    // 撑高后滚动上限 = docH - height（比轮次视口更低）——按 A2 高度算期望，避免误记 mismatch
    const expect = Math.min(slice.y, Math.max(0, ctx.docHeight - height));
    if (Math.abs(actual - expect) > SCROLL_TOL) {
      ctx.scrollMismatchCount = (ctx.scrollMismatchCount || 0) + 1;
      if (!ctx.scrollMismatches) ctx.scrollMismatches = [];
      if (ctx.scrollMismatches.length < MAX_MISMATCH_RECORDS) {
        ctx.scrollMismatches.push({ phase: 'capture', requested: slice.y, actual, expected: expect, a2: true });
      }
    }
    return await client.send('Page.captureScreenshot', params, { sessionId, timeoutMs: ctx.timeoutMs });
  } finally {
    await restoreRoundEmulation(client, sessionId, ctx, st);
  }
}

/** A2 链：重试 1 次 → PNG 时 jpeg 降级（A2 版，内部重新撑视口+落位）→ B 兜底。返回形状同 captureSlice。 */
async function captureSliceA2(client, sessionId, ctx, slice, outFile) {
  const aErrors = [];
  const state = { repositions: 0 };
  const params = { format: ctx.format };
  if (ctx.format === 'jpeg' && ctx.quality != null) params.quality = ctx.quality;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) { // 重试前重新落位（A2 在撑高视口后滚动，计数口径同 A 路径）
        state.repositions += 1;
        ctx.scrollRedone = (ctx.scrollRedone || 0) + 1;
      }
      const r = await a2CaptureAttempt(client, sessionId, ctx, slice, params);
      const bytes = writeBin(outFile, r.data);
      const targetHeight = sliceCaptureHeight(slice);
      const dim = probeImage(outFile) || { width: Math.round(ctx.viewportWidth * ctx.dpr), height: Math.round(targetHeight * ctx.dpr) };
      return { via: 'A2', attempts: attempt, file: outFile, bytes, width: dim.width, height: dim.height, format: ctx.format, repositions: state.repositions, aErrors };
    } catch (e) {
      if (e && e.code === 'E_QUOTA') throw e; // 配额拒绝=全局中止
      aErrors.push(`A2#${attempt} ${fmtErr(e)}`);
      if (e && e.kind === 'disconnect') {
        if (canFormatFallback(ctx)) {
          const fb = await tryJpegFallback(client, sessionId, ctx, slice, outFile, aErrors, { state, reposition: false, mode: 'A2' });
          if (fb) return fb;
        }
        ctx.disconnected = true;
        return { via: null, attempts: attempt, bytes: 0, error: `A2 截图期连接中断（${e.message}）——疑似单段数据量超限，降 --max-chunk/改用 jpeg 后重试`, repositions: state.repositions, aErrors };
      }
      if (attempt === 1) await sleep(RETRY_PAUSE_MS);
    }
  }
  if (canFormatFallback(ctx)) {
    const fb = await tryJpegFallback(client, sessionId, ctx, slice, outFile, aErrors, { state, reposition: true, mode: 'A2' });
    if (fb) return fb;
  }
  if (ctx.disconnected) return { via: null, attempts: 2, bytes: 0, error: `连接中断，B 路径跳过（${aErrors.join(' | ')}）`, repositions: state.repositions, aErrors };
  try {
    const r = await captureSliceB(client, sessionId, Object.assign({}, ctx, { outFile, tag: `s${String(slice.index).padStart(2, '0')}` }), slice);
    return { via: 'B', attempts: 2 + r.shots, file: outFile, bytes: r.bytes, width: r.width, height: r.height, shots: r.shots, format: ctx.format, repositions: state.repositions, aErrors };
  } catch (e) {
    if (e && e.code === 'E_QUOTA') throw e;
    return { via: null, attempts: 2, bytes: 0, error: `A2 两连败（${aErrors.join(' | ')}）；B 失败（${e.message}）`, repositions: state.repositions, aErrors };
  }
}

/**
 * PNG 断链降级（V202610210003 用户裁定）：该段改 jpeg（默认档 q90）重试一次。
 * 成功 → 返回 via=A 段记录（file=.jpg / format=jpeg / formatFallback=png-fail）；失败 → null（调用方按原语义止损）。
 * V202610220002：入口先重新落位（A 失败后的新尝试，页面可能已被超时扰动）；断链路径
 *   （opts.reposition === false，链路已死滚也发不出去）不滚，如实失败。
 * ISSUE-1：opts.mode='A2' 时改用 A2 取图引擎（撑视口+无 clip；via=A2），其余语义不变。
 * ⚠ 不做自动重连：连接真死时这次尝试会立刻失败，随后如实记 disconnected。
 * @param {object} [opts] {state?:{repositions:number}, reposition?:boolean, mode?:'A'|'A2'}
 */
async function tryJpegFallback(client, sessionId, ctx, slice, outFile, aErrors, opts) {
  const o = opts || {};
  const a2 = o.mode === 'A2';
  const state = o.state || { repositions: 0 };
  const file = fallbackFileFor(outFile);
  if (o.reposition !== false) {
    if (a2) { // A2 的落位在 a2CaptureAttempt 内完成（撑高视口后滚动）——这里只记口径
      state.repositions += 1;
      ctx.scrollRedone = (ctx.scrollRedone || 0) + 1;
    } else {
      try {
        await repositionForRetry(client, sessionId, ctx, slice, state);
      } catch (e) {
        aErrors.push(`jpeg-fallback reposition ${fmtErr(e)}`);
        if (e && e.kind === 'disconnect') ctx.disconnected = true;
        return null;
      }
    }
  }
  try {
    const params = a2
      ? Object.assign({ format: 'jpeg', quality: PNG_FALLBACK_QUALITY })
      : clipParams(slice, ctx.viewportWidth, 'jpeg', PNG_FALLBACK_QUALITY);
    const r = a2
      ? await a2CaptureAttempt(client, sessionId, ctx, slice, params)
      : await client.send('Page.captureScreenshot', params, { sessionId, timeoutMs: ctx.timeoutMs });
    const bytes = writeBin(file, r.data);
    const targetHeight = slice.captureHeight != null ? slice.captureHeight : slice.cssHeight;
    const dim = probeImage(file) || { width: Math.round(ctx.viewportWidth * ctx.dpr), height: Math.round(targetHeight * ctx.dpr) };
    ctx.formatFallbacks = (ctx.formatFallbacks || 0) + 1;
    log.warn('scroll-shot', `⚠ 段 ${slice.index} PNG 失败 → 降级 jpeg q${PNG_FALLBACK_QUALITY} 成功（清单记 formatFallback=png-fail；如需纯 PNG 请减小 --max-chunk 后重跑）`, { echo: true });
    return { via: a2 ? 'A2' : 'A', attempts: 3, file, bytes, width: dim.width, height: dim.height, format: 'jpeg', formatFallback: 'png-fail', repositions: state.repositions, aErrors };
  } catch (e) {
    if (e && e.code === 'E_QUOTA') throw e; // 配额拒绝=全局中止（B3 N2）
    aErrors.push(`jpeg-fallback ${fmtErr(e)}`);
    if (e && e.kind === 'disconnect') ctx.disconnected = true;
    return null;
  }
}

/**
 * 单段取图（先 A 后 B）：A 首次失败 → 300ms 后重新落位 + 重试 1 次（同 shot 链路纪律）→ 仍败转 B。
 * PNG 时 A 两连败（含 WS 断开类错误）先试一次 jpeg 降级（tryJpegFallback），成功即用该段。
 * V202610220002：每次重试/降级前重新落位（防超时扰动后拍到错位内容）；断链不滚（直接止损/降级）。
 * 返回 {via:'A'|'B'|null, attempts, bytes, width, height, file?, format?, formatFallback?, repositions, error?, aErrors}
 */
async function captureSlice(client, sessionId, ctx, slice, outFile) {
  // ISSUE-1 A2 分叉：beyond 探测明确判「不支持」且段高未超单边上限 → legacy 撑视口无 clip
  if (shouldUseA2(ctx, slice)) return captureSliceA2(client, sessionId, ctx, slice, outFile);
  const aErrors = [];
  const state = { repositions: 0 };
  await shotScopedScroll(client, sessionId, slice.y, ctx);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await client.send('Page.captureScreenshot', clipParams(slice, ctx.viewportWidth, ctx.format, ctx.quality), { sessionId, timeoutMs: ctx.timeoutMs });
      const bytes = writeBin(outFile, r.data);
      const targetHeight = slice.captureHeight != null ? slice.captureHeight : slice.cssHeight;
      const dim = probeImage(outFile) || { width: Math.round(ctx.viewportWidth * ctx.dpr), height: Math.round(targetHeight * ctx.dpr) };
      return { via: 'A', attempts: attempt, file: outFile, bytes, width: dim.width, height: dim.height, format: ctx.format, repositions: state.repositions, aErrors };
    } catch (e) {
      if (e && e.code === 'E_QUOTA') throw e; // 配额拒绝=全局中止，不降级重试（B3 N2）
      aErrors.push(`A#${attempt} ${fmtErr(e)}`);
      // WS 断开 = 链路可能已死（超大单图/浏览器侧断链）——PNG 先试 jpeg 降级一次再判死（实测大 PNG 打挂 WS）
      if (e && e.kind === 'disconnect') {
        if (canFormatFallback(ctx)) {
          // 断链不重新落位（链路已死，滚动命令发不出去）——保持原止损语义
          const fb = await tryJpegFallback(client, sessionId, ctx, slice, outFile, aErrors, { state, reposition: false });
          if (fb) return fb;
        }
        ctx.disconnected = true;
        return { via: null, attempts: attempt, bytes: 0, error: `截图期连接中断（${e.message}）——疑似单段数据量超限，降 --max-chunk/改用 jpeg 后重试`, repositions: state.repositions, aErrors };
      }
      if (attempt === 1) {
        await sleep(RETRY_PAUSE_MS);
        // **重新落位**：超时可能已扰动滚动位置，不重滚就会拍到"别处"却记成功（V202610220002 实弹 bug）
        try {
          await repositionForRetry(client, sessionId, ctx, slice, state);
        } catch (ee) {
          // 落位失败（多半是链路已断且错误未被归类 disconnect）：不再空拍，直接走降级/止损
          aErrors.push(`A#${attempt} reposition ${fmtErr(ee)}`);
          if (ee && ee.kind === 'disconnect') ctx.disconnected = true;
          break;
        }
      }
    }
  }
  // A 两连败（非断链类）→ PNG 逐段降级一次（降级前同样先重新落位）
  if (canFormatFallback(ctx)) {
    const fb = await tryJpegFallback(client, sessionId, ctx, slice, outFile, aErrors, { state, reposition: true });
    if (fb) return fb;
  }
  if (ctx.disconnected) return { via: null, attempts: 2, bytes: 0, error: `连接中断，B 路径跳过（${aErrors.join(' | ')}）`, repositions: state.repositions, aErrors };
  try {
    const r = await captureSliceB(client, sessionId, Object.assign({}, ctx, { outFile, tag: `s${String(slice.index).padStart(2, '0')}` }), slice);
    return { via: 'B', attempts: 2 + r.shots, file: outFile, bytes: r.bytes, width: r.width, height: r.height, shots: r.shots, format: ctx.format, repositions: state.repositions, aErrors };
  } catch (e) {
    if (e && e.code === 'E_QUOTA') throw e; // 配额拒绝=全局中止（B3 N2）
    return { via: null, attempts: 2, bytes: 0, error: `A 两连败（${aErrors.join(' | ')}）；B 失败（${e.message}）`, repositions: state.repositions, aErrors };
  }
}

/** 段前滚动（A 路径需要「滚到 y」——懒内容与 fixed 层一致性）+ settle；读回校验如实记录 */
async function shotScopedScroll(client, sessionId, y, ctx) {
  const actual = Math.round(await scrollTo(client, sessionId, y, ctx.timeoutMs));
  if (ctx.settleMs) await sleep(ctx.settleMs);
  const expect = Math.min(y, Math.max(0, ctx.docHeight - ctx.viewportHeight));
  if (Math.abs(actual - expect) > SCROLL_TOL) {
    ctx.scrollMismatchCount = (ctx.scrollMismatchCount || 0) + 1;
    if (!ctx.scrollMismatches) ctx.scrollMismatches = [];
    if (ctx.scrollMismatches.length < MAX_MISMATCH_RECORDS) ctx.scrollMismatches.push({ phase: 'capture', requested: y, actual, expected: expect });
  }
  return actual;
}

/* ── beyond-viewport 能力探测接线（ISSUE-1）：机制/判定矩阵单源 = lib/beyond-probe.js 头注释 ── */

/** 探针几何（纯函数）：probeH = clamp(min(chunkCss, VIEWPORT_CAP), viewportH+1, VIEWPORT_CAP)；
 *  视口高已达上限（无 >视口 的合法高度）→ null（跳过探测，按支持处理）。 */
function beyondProbeClip(viewportWidth, viewportHeight, chunkCss) {
  const cap = shot.VIEWPORT_CAP;
  const vp = Math.round(Number(viewportHeight));
  if (!(vp > 0) || vp >= cap) return null;
  let h = Math.min(Number(chunkCss) || cap, cap);
  h = Math.max(h, vp + 1);
  h = Math.min(h, cap);
  if (!(h > vp)) return null;
  return { x: 0, y: 0, width: Math.round(Number(viewportWidth)), height: Math.round(h) };
}

/** 浏览器版本（缓存 key）：beyondDeps.version 注入优先（string|fn）；否则 GET /json/version 的 Browser 字段；
 *  取不到/失败 → null（探测照做但不读写缓存，防串档）。HTTP 调用不占 CDP 命令面。 */
async function resolveBrowserVersion(client, deps, timeoutMs) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'version')) {
    let v = deps.version;
    if (typeof v === 'function') {
      try { v = await v(); } catch { return null; }
    }
    return v == null ? null : String(v);
  }
  if (!client || !client.browserUrl) return null;
  try {
    const core = require('./cdp-core');
    const v = await core.browserVersion(client.browserUrl, Math.min(Number(timeoutMs) || 5000, 5000));
    return v && v.Browser ? String(v.Browser) : null;
  } catch { return null; }
}

/** 探测编排（缓存→双拍；异常 fail-open）：返回 {supported, judged, by, cached, version, probe, clip} */
async function resolveBeyondProbe(client, sessionId, o, m1, plan, ctx) {
  const deps = o.beyondDeps || {};
  const clip = deps.clip || beyondProbeClip(m1.viewportWidth, m1.viewportHeight, plan.chunkCss);
  if (!clip) {
    return {
      supported: true, judged: 'unknown', by: 'timeout', cached: false, version: null, probe: null,
      note: `视口高 ${m1.viewportHeight} 已达/超过单边上限 ${shot.VIEWPORT_CAP}——跳过 beyond-viewport 探测（按支持处理）`,
    };
  }
  const version = await resolveBrowserVersion(client, deps, o.timeoutMs);
  const cacheDir = o.beyondCacheDir === undefined ? paths.STATE_DIR : o.beyondCacheDir;
  const r = await beyond.detectBeyondSupport({
    client, sessionId, clip, version, cacheDir,
    timeoutMs: Math.min(Number(o.timeoutMs) || 30000, 20000),
    probe: typeof deps.probe === 'function' ? deps.probe : undefined,
  });
  return Object.assign(r, { clip });
}

/**
 * 主流程：测量 → 预热 → 分段 → 逐段取图 → 落盘清单。
 * 显式 --dpr/--viewport 才施加 Emulation；finally 单点 endEmulation + 滚动位置还原。
 * @returns 清单对象（chromeuse-scroll-shot/1）；失败时错误挂 e.manifest（含已完成段，status=partial）
 */
async function runScrollShot(client, sessionId, opts) {
  const o = normalizeOptions(opts);
  const t0 = Date.now();
  const outDir = o.outDir;
  const name = o.name;
  const manifest = {
    format: MANIFEST_FORMAT,
    at: time.isoLocal(),
    status: 'failed',
    target: opts.target || null,
    outDir,
    name,
    maxChunk: o.maxChunk,
    maxChunkUnit: o.maxChunkUnit,
    chunkCss: null,
    chunkPx: null,
    overlap: o.overlap,
    formatRequested: o.format,
    quality: o.quality,
    formatFallback: o.formatFallback,
    pngRisk: null,
    viewportMaxChunk: null,
    dryRun: o.dryRun,
    docHeight: null,
    docHeightInitial: null,
    viewport: null,
    dpr: null,
    step: null,
    sliceCount: null,
    plan: null,
    imgPromote: o.imgPromote,
    imgSettleMs: o.imgSettleMs,
    blankCheck: o.blankCheck,
    blankMinPx: o.blankMinPx,
    blankThreshold: o.blankThreshold,
    blankStrict: o.blankStrict,
    // 切点吸附（F15）：顶层配置口径（段级记录见 slices[].snap）
    snapConfig: { enabled: o.snapCuts, windowPx: o.snapWindow, pxFallback: !!(o.snapCuts && o.snapPx) },
    // beyond-viewport 能力探测（ISSUE-1）：{supported,judged,by,cached,version,probe}；短页/dry-run 恒 null
    beyondProbe: null,
    // 前台保障（V202610220003）：进入时/置前后各读一次 visibilityState，如实记录是否曾切前台
    foreground: null,
    images: null,
    prewarm: null,
    slices: [],
    failedSlices: [],
    missingSlices: [],
    budgetMs: null,
    budgetExceeded: false,
    // 重试/降级前重新落位合计（V202610220002；正常路径恒 0）
    scrollRepositions: 0,
    elapsedMs: 0,
    emulation: null,
    restore: null,
    notes: [],
    scrollMismatches: [],
  };
  let emu = null;
  let originalScrollY = null;
  let pre = null; // 仅 --viewport-max-chunk：施加覆盖前读原生几何（chunkCss 折算需要 dpr）
  // 空白段自检（F13）状态：segments = 实际完成检测的段数；unavailable 一旦为真本轮不再试（省 ffmpeg 进程）
  const blankState = { segments: 0, suspectIndexes: [], unavailable: false, reason: null, elapsedMs: 0 };
  let emuOpts = { dpr: o.dpr, viewport: o.viewport };
  const ctx = {
    format: o.format, quality: o.quality, timeoutMs: o.timeoutMs, settleMs: o.settleMs,
    viewportWidth: 0, viewportHeight: 0, dpr: 1, docHeight: 0,
    formatFallback: o.formatFallback, formatFallbacks: 0,
    tmpDir: path.join(outDir, `${name}.slices`),
    scrollMismatches: [],
    // ISSUE-1：beyond-viewport 能力（undefined/true=原 A 路径；仅显式 false 才走 A2）
    beyondSupported: true,
    roundEmuActive: false, roundEmuOpts: null,
  };
  if (o.qualityIgnored) manifest.notes.push('--quality 仅对 jpeg 有效：--format png 时忽略该值（与 lib/screenshot.js 同口径）');
  try {
    // ⓪ 前台保障（V202610220003）：**必须早于第一次测量/预热**——scroll-shot 走 raw captureScreenshot，
    //    不经过 lib/screenshot.js 的 bringToFront 前置；后台页签实测 30s 超时甚至返回旧帧（静默错图）。
    const fg = await ensureForeground(client, sessionId, o);
    manifest.foreground = fg;
    if (fg.broughtToFront) {
      manifest.notes.push(`前台保障（V202610220003）：${fg.note}`);
    } else if (fg.beforeVisibility === 'hidden' || fg.beforeVisibility === null) {
      // 检测到后台却没置前：两种来由（--no-foreground / bringToFront 失败）都如实进清单
      manifest.notes.push(fg.enabled
        ? `⚠ 前台保障未生效（Page.bringToFront ${fg.bringToFront}）：后台页签 captureScreenshot 实测 30s 超时甚至返回旧帧（静默错图）`
        : '⚠ 已按 --no-foreground 放弃前台保障：后台页签 captureScreenshot 实测 30s 超时甚至返回旧帧（静默错图）');
    }
    // --viewport-max-chunk：先把视口高度覆盖成 chunkCss（显式 Emulation，finally 必还原）
    if (o.viewportMaxChunk) {
      pre = await readPage(client, sessionId, o.timeoutMs);
      const dprForGeo = o.dpr != null ? Number(o.dpr) : pre.dpr;
      const geo0 = resolveChunkGeometry({ maxChunk: o.maxChunk, maxChunkUnit: o.maxChunkUnit, dpr: dprForGeo, overlap: o.overlap });
      if (geo0.chunkCss > shot.VIEWPORT_CAP) throw usageErr(`--viewport-max-chunk 需视口高 ${geo0.chunkCss} 超过单边上限 ${shot.VIEWPORT_CAP}——请减小 --max-chunk`);
      let vw = Math.round(pre.viewportWidth);
      let rel = '';
      if (o.viewport != null) {
        const vp = shot.parseViewport(o.viewport);
        vw = vp.width;
        rel = `--viewport 高度 ${vp.height} 被 --viewport-max-chunk 覆盖为 ${geo0.chunkCss}（宽度沿用 ${vw}）`;
      } else {
        rel = `宽度取当前 innerWidth=${vw}（未给 --viewport）`;
      }
      manifest.viewportMaxChunk = { enabled: true, requested: o.viewport || null, effective: { width: vw, height: geo0.chunkCss, dpr: dprForGeo }, relation: rel };
      manifest.notes.push(`--viewport-max-chunk 生效：视口 ${vw}x${geo0.chunkCss}@DPR ${dprForGeo}（${rel}）——step == viewportH，等价视口截图，规避 beyond-viewport 大 clip`);
      log.info('scroll-shot', `视口高度覆盖（--viewport-max-chunk）：${vw}x${geo0.chunkCss}@DPR ${dprForGeo}；${rel}`, { echo: true });
      emuOpts = { dpr: o.dpr, viewport: `${vw}x${geo0.chunkCss}` };
    }
    try {
      emu = await shot.beginEmulation(client, sessionId, emuOpts, o.timeoutMs);
    } catch (e) {
      if (e && e.emulation) emu = e.emulation;
      throw e;
    }
    // ISSUE-1：轮次级 emulate 状态单源（A2 段后恢复用；默认 false/无覆盖 = 段后 clear）
    ctx.roundEmuActive = !!emu;
    ctx.roundEmuOpts = emuOpts;
    const m0 = await readPage(client, sessionId, o.timeoutMs);
    originalScrollY = Math.round(m0.scrollY);
    manifest.docHeightInitial = pre ? pre.docHeight : m0.docHeight;
    manifest.notes.push(`预热前 scrollY=${originalScrollY} readyState=${m0.readyState} images=${m0.images.total}（占位=${m0.images.placeholder} pending=${m0.images.pending}）`);
    if (m0.docHeight <= 0) throw new Error('文档高度测得 0——页面可能未加载完成（先等 readyState=complete 再跑）');

    const pw = await prewarm(client, sessionId, o);
    manifest.prewarm = pw;
    manifest.images = {
      total: pw.images.total,
      promoted: pw.imgPromote.promoted,
      failed: pw.imgPromote.failed,
      placeholder: pw.images.placeholder,
      pending: pw.images.pending,
      loaded: pw.images.loaded,
    };
    if (pw.imgPromote.enabled) {
      manifest.notes.push(`强制加载（--img-promote）：候选 ${pw.imgPromote.candidates} 张 → 成功 ${pw.imgPromote.promoted} / 失败 ${pw.imgPromote.failed}（${pw.imgPromote.rounds} 轮）——这是渲染加速，不改业务状态，但会触发真实网络图片请求；--no-img-promote 可关`);
    } else {
      manifest.notes.push('已关闭强制加载（--no-img-promote）：懒加载占位图可能留成段空白（滚动预热只能兜底背景图/非图片懒加载）');
    }
    if (pw.images.pending > 0) {
      manifest.notes.push(`图片仍有 ${pw.images.pending} 张未就绪（占位 ${pw.images.placeholder}）——超过 --image-timeout ${o.imageTimeoutMs}ms，截图可能含空白（如实记录，不谎报）`);
    }
    if (pw.imgSettleMs) manifest.notes.push(`首帧解码等待 --img-settle=${pw.imgSettleMs}ms（GIF 即使加载完也要等首帧）`);
    if (pw.scrollMismatchCount) {
      manifest.scrollMismatches.push(...pw.scrollMismatches);
      manifest.notes.push(`预热有 ${pw.scrollMismatchCount} 次滚动未达目标（页面可能拦截滚动/存在滚动容器——已如实记录）`);
    }
    const m1 = await readPage(client, sessionId, o.timeoutMs);
    manifest.docHeight = m1.docHeight;
    manifest.viewport = { width: m1.viewportWidth, height: m1.viewportHeight };
    manifest.dpr = m1.dpr;
    ctx.viewportWidth = m1.viewportWidth;
    ctx.viewportHeight = m1.viewportHeight;
    ctx.dpr = m1.dpr;
    ctx.docHeight = m1.docHeight;

    // 几何单源：maxChunk + 单位 + DPR → chunkCss（内部一律 CSS px）；overlap 依赖 chunkCss 故在此复核
    const geo = resolveChunkGeometry({ maxChunk: o.maxChunk, maxChunkUnit: o.maxChunkUnit, dpr: m1.dpr, overlap: o.overlap });
    manifest.maxChunkUnit = geo.maxChunkUnit;
    manifest.chunkCss = geo.chunkCss;
    manifest.chunkPx = geo.chunkPx;
    manifest.overlap = geo.overlap;
    let plan = planSlices(m1.docHeight, m1.viewportHeight, geo.chunkCss, geo.overlap);
    let snapRects = null;
    let snapMeta = { rects: 0, truncated: 0, moved: 0, dom: 0, failed: null };
    // 切点吸附（F15）：DOM 优先法——分段前**一次只读 evaluate** 取可见内容元素 rect，纯函数重排切点。
    // fail-soft：整体异常（evaluate 失败/参数异常）→ 全部原切点 + 一行告警 + 清单 note，绝不阻断截图。
    if (o.snapCuts) {
      try {
        const rr = await readRects(client, sessionId, o.timeoutMs);
        snapRects = rr.rects;
        const minSlicePx = snapMinSlice(plan.viewportH, plan.step);
        const snapped = snapCuts(plan, rr.rects, {
          enabled: true, windowPx: o.snapWindow, minBandPx: SNAP_MIN_BAND_PX, minSlicePx,
        });
        plan = snapped.plan;
        snapMeta.rects = rr.rects.length;
        snapMeta.truncated = rr.truncated;
        snapMeta.dom = snapped.snaps.filter((x) => x.method === 'dom').length;
        snapMeta.moved = snapped.snaps.filter((x) => x.shift).length;
        const maxShift = snapped.snaps.reduce((m, x) => Math.max(m, Math.abs(x.shift || 0)), 0);
        manifest.notes.push(`切点吸附（DOM 优先）：rects ${rr.rects.length} 条${rr.truncated ? `（超硬帽 ${MAX_SNAP_RECTS} 截断 ${rr.truncated} 条）` : ''}｜非末段切点 ${snapped.snaps.length - 1} 个，吸附成功 ${snapMeta.dom} 个（位移 ${snapMeta.moved} 个，最大 ${maxShift} CSS px）｜窗口 ±${o.snapWindow}px、最小空白带 ${SNAP_MIN_BAND_PX}px`);
        log.info('scroll-shot', `切点吸附（DOM）：${snapMeta.dom}/${snapped.snaps.length - 1} 个切点命中空白带（位移 ${snapMeta.moved} 个，最大 ${maxShift}px；窗口 ±${o.snapWindow}px）`, { echo: true });
      } catch (e) {
        plan.slices.forEach((s) => { s.snap = noneSnap(); });
        snapMeta.failed = fmtErr(e);
        manifest.notes.push(`⚠ 切点吸附失败（${snapMeta.failed}）——全部使用原切点，截图不受影响（fail-soft）`);
        log.warn('scroll-shot', `⚠ 切点吸附失败：${snapMeta.failed}（回落原切点，截图不受影响）`, { echo: true });
      }
    } else {
      plan.slices.forEach((s) => { s.snap = noneSnap(); });
      manifest.notes.push('已关闭切点吸附（--no-snap-cuts）：切点硬切，可能把标题栏/产品卡拦腰截断');
    }
    if (o.snapCuts && o.snapPx && !o.dryRun) {
      manifest.notes.push(`像素法兜底已开（--snap-px）：DOM 无合格带的切点在段落盘后跑 F13 同款行剖面（亮度 ≥${o.blankThreshold} × ≥${SNAP_MIN_BAND_PX} CSS px；ffmpeg 缺失/失败 fail-soft 回落原切点）`);
    } else if (o.snapCuts && o.snapPx && o.dryRun) {
      manifest.notes.push('dry-run 未跑像素法兜底（无图）——实跑时 DOM 无合格带的切点才会用段图行剖面兜底');
    }
    manifest.step = plan.step;
    manifest.sliceCount = plan.count;
    manifest.plan = physicalPlan(plan, m1.dpr);
    const unitNote = geo.maxChunkUnit === 'px'
      ? `--max-chunk=${geo.maxChunk}px @DPR ${geo.dpr} → chunkCss=${geo.chunkCss}（物理 ≤ ${geo.maxChunk}px 硬保证）`
      : `--max-chunk=${geo.maxChunk}css @DPR ${geo.dpr} → chunkCss=${geo.chunkCss}（物理 ${geo.chunkPx}px，可超 maxChunk 属显式选择）`;
    manifest.notes.push(`分段：docHeight=${plan.docHeight} viewportH=${plan.viewportH} step=${plan.step} → ${plan.count} 段（每段 ≤ ${geo.chunkCss} CSS px；${unitNote}；overlap=${geo.overlap}）`);
    if (plan.step > plan.viewportH) throw new Error(`内部几何异常：step(${plan.step}) > viewportH(${plan.viewportH})（不变量：step ≤ viewportH）`);

    // PNG 预防性告警（不改用户格式）：单段像素 = width×dpr × cssH×dpr
    if (o.format === 'png') {
      const widthPx = Math.round(m1.viewportWidth * m1.dpr);
      const risky = plan.slices
        .map((s) => ({ index: s.index, y: s.y, cssHeight: s.cssHeight, pixels: Math.round(widthPx * s.cssHeight * m1.dpr) }))
        .filter((s) => s.pixels > PNG_SAFE_PIXELS);
      if (risky.length) {
        manifest.pngRisk = { safePixels: PNG_SAFE_PIXELS, widthPx, slices: risky };
        log.warn('scroll-shot', `⚠ PNG 风险告警：${risky.length}/${plan.count} 段超安全像素 ${PNG_SAFE_PIXELS}（最大 ${risky[0].pixels}px；实测 1100×4600=5.06M px 会打挂 WS，1100×2000=2.2M px 正常）——建议 --format jpeg 或减小 --max-chunk`, { echo: true });
        manifest.notes.push(`PNG 风险：${risky.map((s) => `段${s.index}=${s.pixels}px`).join(' ')} 超安全线 ${PNG_SAFE_PIXELS}——建议改 jpeg 或减小 --max-chunk（不改用户格式，仅告警；失败时按 formatFallback 逐段降级）`);
      }
    }

    // ⑫b beyond-viewport 能力探测（ISSUE-1，惰性）：仅实跑长页（docH > viewportH）触发一次；
    //     结果按 browserVersion 缓存（tmpdata/state/beyond-viewport.json，手删即重探），命中后零探测开销。
    //     短页（clip 全在视口内、无 beyond 语义）与 dry-run 零成本；判定不确定/异常 → fail-open 按支持处理且不写缓存。
    if (!o.dryRun && m1.docHeight > m1.viewportHeight) {
      try {
        const bp = await resolveBeyondProbe(client, sessionId, o, m1, plan, ctx);
        manifest.beyondProbe = {
          supported: bp.supported,
          judged: bp.judged,
          by: bp.by,
          cached: bp.cached,
          version: bp.version || null,
          probe: bp.probe || null,
        };
        ctx.beyondSupported = bp.supported;
        if (bp.note) {
          manifest.notes.push(bp.note);
        } else if (bp.judged === 'unknown') {
          manifest.notes.push(`beyond-viewport 探测不确定（${bp.by}）→ 按支持处理且不写缓存（fail-open，下轮重探）`);
        } else if (bp.supported === false) {
          manifest.notes.push(`beyond-viewport 判定不支持（${bp.by}${bp.cached ? '，缓存命中' : '，探测'}）——A 路径改走段级 Emulation 撑视口无 clip（via=A2）`);
        } else if (bp.cached) {
          log.info('scroll-shot', `beyond-viewport 能力缓存命中（${bp.version} → 支持），零探测开销`);
        }
        const overCap = plan.slices.filter((s) => sliceCaptureHeight(s) > shot.VIEWPORT_CAP).length;
        if (bp.supported === false && overCap > 0) {
          manifest.notes.push(`${overCap} 段 captureHeight > 单边上限 ${shot.VIEWPORT_CAP}——这些段保持 A→B 链（legacy 浏览器上仍可能白屏，如实标注）`);
        }
      } catch (e) {
        // fail-open：探测自身异常绝不阻断截图（按支持处理=现代 Chrome 默认行为不变）
        ctx.beyondSupported = true;
        manifest.beyondProbe = { supported: true, judged: 'unknown', by: 'timeout', cached: false, version: null, probe: null, error: fmtErr(e) };
        manifest.notes.push(`beyond-viewport 探测异常（${fmtErr(e)}）→ 按支持处理（fail-open）`);
      }
    }

    if (o.dryRun) {
      manifest.status = 'plan-only';
      manifest.restore = { scrollY: { before: originalScrollY, requested: originalScrollY, skipped: 'dry-run 由 finally 统一还原' } };
      return manifest;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const ext = extOf(o.format);
    const pad = Math.max(2, String(plan.count).length);
    manifest.budgetMs = plan.count * o.timeoutMs;
    const capT0 = Date.now();
    let failed = 0;
    // B7 N6：作业进度回调（非作业进程不传；回调异常绝不影响截图主链）
    try { if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'capture', current: 0, total: plan.slices.length }); } catch { /* 进度旁路 */ }
    for (let i = 0; i < plan.slices.length; i++) {
      if (ctx.disconnected) {
        manifest.missingSlices = plan.slices.slice(i).map((s) => ({ index: s.index, y: s.y, cssHeight: s.cssHeight }));
        manifest.notes.push(`连接中断——剩余 ${plan.slices.length - i} 段未截（已完成段保留，不整轮报废）`);
        log.warn('scroll-shot', `⚠ 连接已中断，跳过剩余 ${plan.slices.length - i} 段`, { echo: true });
        break;
      }
      if (Date.now() - capT0 > manifest.budgetMs) {
        manifest.budgetExceeded = true;
        manifest.missingSlices = plan.slices.slice(i).map((s) => ({ index: s.index, y: s.y, cssHeight: s.cssHeight }));
        manifest.notes.push(`总预算 ${manifest.budgetMs}ms 用尽——剩余 ${plan.slices.length - i} 段中止（已完成段保留，不整轮报废）`);
        log.warn('scroll-shot', `⚠ 总预算用尽，跳过剩余 ${plan.slices.length - i} 段`, { echo: true });
        break;
      }
      const s = plan.slices[i];
      const file = path.join(outDir, `${name}-${String(s.index).padStart(pad, '0')}${ext}`);
      log.info('scroll-shot', `段 ${s.index}/${plan.slices.length} y=${s.y} cssH=${s.cssHeight}${s.overlapPx ? `+${s.overlapPx}` : ''} …`, { echo: true });
      const r = await captureSlice(client, sessionId, ctx, s, file);
      // 像素法兜底（F15，仅 --snap-px 显式开 + 该切点 DOM 无合格带）：对**已落盘**段图跑 F13 同款行剖面，
      // 在段尾 ±window 的图内可见部分找空白带定下一切点；命中则改本段 cssHeight/overlapPx 并按
      // 「滚动推进」重排尾部。fail-soft：ffmpeg 缺失/失败/无合格带 → 回落原切点（只记 note，不阻断）。
      let pxProfile = null;
      if (o.snapCuts && o.snapPx && !r.error && r.file && s.snap && s.snap.method === 'none' && i < plan.slices.length - 1) {
        const pxr = pxSnapCut(r.file, {
          yCss: s.y,
          cutCss: s.y + s.cssHeight,
          dpr: ctx.dpr,
          windowPx: o.snapWindow,
          minBandPx: SNAP_MIN_BAND_PX,
          threshold: o.blankThreshold,
          overlapPx: s.overlapPx,
          minSlicePx: snapMinSlice(plan.viewportH, plan.step),
          chunkCss: plan.chunkCss,
          docH: plan.docHeight,
        });
        pxProfile = pxr.prof || null;
        if (pxr.ok) {
          try {
            plan = applyPxCut(plan, i, pxr, {
              rects: snapRects,
              snapOpts: {
                enabled: !!(o.snapCuts && snapRects), windowPx: o.snapWindow, minBandPx: SNAP_MIN_BAND_PX,
                minSlicePx: snapMinSlice(plan.viewportH, plan.step),
              },
            });
            manifest.sliceCount = plan.count;
            manifest.plan = physicalPlan(plan, m1.dpr);
            manifest.budgetMs = plan.count * o.timeoutMs;
            manifest.notes.push(`段 ${s.index} 像素法吸附：shift ${pxr.shift > 0 ? '+' : ''}${pxr.shift} CSS px（空白带 ${pxr.from}~${pxr.to}；本段 cssHeight=${plan.slices[i].cssHeight}，图向下多拍 ${plan.slices[i].overlapPx}px）——尾部已按新切点重排`);
            log.info('scroll-shot', `切点吸附（像素法）段 ${s.index}：shift ${pxr.shift > 0 ? '+' : ''}${pxr.shift}px（空白带 ${pxr.from}~${pxr.to}）`, { echo: true });
          } catch (e) {
            // fail-soft：重排失败（不变量破坏等）→ 保持原计划继续截图（吸附是增强，绝不阻断）
            manifest.notes.push(`段 ${s.index} 像素法重排失败（${fmtErr(e)}）——保持原切点，截图继续`);
            log.warn('scroll-shot', `⚠ 段 ${s.index} 像素法重排失败：${fmtErr(e)}（保持原切点，截图继续）`, { echo: true });
          }
        } else {
          manifest.notes.push(`段 ${s.index} ${pxr.reason}——回落原切点`);
          log.warn('scroll-shot', `⚠ 段 ${s.index} ${pxr.reason}（回落原切点，截图不受影响）`, { echo: true });
        }
      }
      const sl = plan.slices[i]; // 吸附后以最新几何记账（像素法可能已改本段 cssHeight/overlapPx）
      const rec = {
        index: sl.index,
        file: r.via ? (r.file || file) : null,
        y: sl.y,
        height: r.via ? r.height : 0,
        cssHeight: sl.cssHeight,
        captureHeight: sl.captureHeight,
        overlapPx: sl.overlapPx,
        bytes: r.via ? r.bytes : 0,
        ts: time.isoLocal(),
        via: r.via,
        attempts: r.attempts,
        // 本段重试/降级前的重新落位次数（0 = 一次命中；如实记录，便于发现超时扰动）
        repositions: r.repositions || 0,
        format: r.via ? (r.format || o.format) : null,
        // 切点吸附记录（F15）：本段**段尾切点**的吸附结果（末段无切点 → method='none'）
        snap: sl.snap ? Object.assign({}, sl.snap) : noneSnap(),
      };
      if (r.shots) rec.bShots = r.shots;
      if (r.formatFallback) rec.formatFallback = r.formatFallback;
      // 空白段自检（F13）：**只在落盘之后**做（有图才谈"白块"）；A/B/PNG→JPEG 降级段一视同仁
      // （降级段同样写进 rec.file，检测按实际产物走）。fail-soft：不影响失败/成功判定与退出码。
      if (o.blankCheck && !r.error && rec.file && !blankState.unavailable) {
        // 像素法已跑过同一张图的行剖面 → 复用（省一次 ffmpeg 进程；只读语义不变）
        const deps = pxProfile ? { available: () => true, luma: () => pxProfile } : opts.blankDeps;
        const bc = blankCheckImage(rec.file, { threshold: o.blankThreshold, minPx: o.blankMinPx, deps });
        blankState.elapsedMs += bc.elapsedMs || 0;
        rec.blank = blankField(bc, o.blankThreshold, o.blankMinPx);
        if (bc.checked) {
          blankState.segments++;
          if (rec.blank.suspect) {
            blankState.suspectIndexes.push(s.index);
            // 默认 advisory：日志一行提示（不判死），长度取最长游程
            log.warn('scroll-shot', `⚠ 段 ${s.index} 疑似空白 ${longestBlankRun(rec.blank)}px（≥${o.blankMinPx}px）—— 请人工确认是否为原文设计留白`, { echo: true });
          }
        } else if (!bc.ffmpeg) {
          blankState.unavailable = true;
          blankState.reason = bc.reason || '自检跳过（bin/ffmpeg 不可用）';
          log.warn('scroll-shot', `${blankState.reason}——空白自检不参与判定（截图不受影响）`, { echo: true });
        }
      } else if (o.blankCheck && !r.error && rec.file) {
        rec.blank = blankField(null, o.blankThreshold, o.blankMinPx);
      }
      if (r.error) {
        rec.error = r.error;
        failed++;
        manifest.failedSlices.push({ index: s.index, y: s.y, cssHeight: s.cssHeight, error: r.error });
        log.error('scroll-shot', `✗ 段 ${s.index} 失败：${r.error}`, undefined, { echo: true });
      } else {
        log.info('scroll-shot', `✓ 段 ${s.index} → ${path.basename(rec.file)}（${rec.bytes} 字节，${rec.height}px，via=${r.via}${rec.formatFallback ? '，PNG→JPEG 降级' : ''}）`, { echo: true });
      }
      manifest.slices.push(rec);
      // B7 N6：逐段进度（artifact=本段已落盘图片；cancel 后保留已完成段）
      try {
        if (typeof opts.onProgress === 'function') {
          opts.onProgress({ phase: 'slice', current: i + 1, total: plan.slices.length, artifact: rec.error ? null : rec.file });
        }
      } catch { /* 进度旁路 */ }
    }
    if (ctx.formatFallbacks) {
      manifest.formatFallbacks = ctx.formatFallbacks;
      manifest.notes.push(`${ctx.formatFallbacks} 段 PNG 失败后降级 jpeg（formatFallback=png-fail）——如需纯 PNG 请减小 --max-chunk 重跑`);
    }
    // ISSUE-1：A2（legacy 撑视口）段汇总——如实标注路径与恢复失败次数（恢复失败=视口可能未复原）
    const a2Count = manifest.slices.filter((r) => r.via === 'A2').length;
    if (a2Count) manifest.notes.push(`${a2Count} 段经 A2（段级 Emulation 撑视口 + 无 clip 截图；beyond-viewport legacy 回退）`);
    if (ctx.a2RestoreFailures) manifest.notes.push(`⚠ A2 段后视口恢复失败 ${ctx.a2RestoreFailures} 次（如实记录：可能残留覆盖，需刷新/重启浏览器复位）`);
    manifest.scrollMismatches.push(...(ctx.scrollMismatches || []));
    if (ctx.scrollMismatchCount) manifest.notes.push(`取图期有 ${ctx.scrollMismatchCount} 次滚动未达目标（已如实记录，末段 clamp 属正常）`);
    if (ctx.scrollRedone) manifest.notes.push(`重试/降级前重新落位 ${ctx.scrollRedone} 次（防截图超时扰动滚动位置后拍到错位内容；逐段见 slices[].repositions）`);
    const okCount = manifest.slices.filter((r) => !r.error).length;
    if (okCount === 0) manifest.status = 'failed';
    else if (failed > 0 || manifest.budgetExceeded) manifest.status = 'partial';
    else manifest.status = 'ok';
    return manifest;
  } catch (e) {
    if (e && typeof e === 'object') {
      e.manifest = manifest;
      if (manifest.status === 'failed' && manifest.slices.some((r) => !r.error)) manifest.status = 'partial';
    }
    throw e;
  } finally {
    manifest.elapsedMs = Date.now() - t0;
    // 重新落位合计（单一出口：正常/中断路径都如实带出，不因中断丢计数）
    manifest.scrollRepositions = ctx.scrollRedone || 0;
    // 空白自检汇总（单一出口：正常/dry-run/中断三条路径都带上——按实际已检测段如实统计）
    manifest.blankSummary = buildBlankSummary(
      { enabled: o.blankCheck, dryRun: o.dryRun, minPx: o.blankMinPx, threshold: o.blankThreshold, strict: o.blankStrict },
      blankState
    );
    if (o.blankCheck && !o.dryRun && blankState.suspectIndexes.length) {
      manifest.notes.push(manifest.blankSummary.note);
    }
    if (emu) {
      await shot.endEmulation(client, sessionId, emu, o.timeoutMs);
      manifest.emulation = emu;
    }
    // 现场还原：先清 Emulation（视口/DPR 复原）再回滚滚动位置——顺序反了会用错视口算滚动上限
    if (originalScrollY != null) {
      const restore = { before: originalScrollY, requested: originalScrollY, after: null, ok: false };
      try {
        const after = Math.round(await scrollTo(client, sessionId, originalScrollY, o.timeoutMs));
        restore.after = after;
        restore.ok = Math.abs(after - originalScrollY) <= SCROLL_TOL;
        if (!restore.ok) {
          restore.note = `滚动位置未完全还原（请求 ${originalScrollY}，实测 ${after}）——页面可能已到底/含滚动容器`;
          log.warn('scroll-shot', `⚠ ${restore.note}`);
        }
      } catch (e) {
        restore.error = fmtErr(e);
        log.warn('scroll-shot', `⚠ 滚动位置还原失败：${restore.error}`);
      }
      Object.assign(manifest.restore || (manifest.restore = {}), { scrollY: restore });
    }
    if (!o.keepSlices && !o.dryRun) {
      try { fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  }
}

module.exports = {
  MANIFEST_FORMAT,
  DEFAULT_MAX_CHUNK, DEFAULT_MAX_CHUNK_UNIT, MAX_CHUNK_UNITS, MAX_CHUNK_MIN, MAX_CHUNK_MAX,
  DEFAULT_OVERLAP, OVERLAP_MAX, PNG_SAFE_PIXELS, PNG_FALLBACK_QUALITY,
  DEFAULT_SETTLE_MS, DEFAULT_TIMEOUT_MS,
  DEFAULT_QUALITY, DEFAULT_PREWARM_SAMPLES, STABLE_SAMPLES, DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_IMG_SETTLE_MS, IMG_SRC_ATTRS, IMG_PROMOTED_ATTR,
  DEFAULT_BLANK_MIN_PX, DEFAULT_BLANK_THRESHOLD, BLANK_MIN_PX_MIN, BLANK_MIN_PX_MAX,
  BLANK_THRESHOLD_MIN, BLANK_THRESHOLD_MAX, BLANK_MAX_RUNS,
  PREWARM_STEP_RATIO,
  usageErr, intOption, normalizeOptions, resolveChunkGeometry, planSlices, physicalPlan,
  blankBands, snapPoint, planFromCuts, snapMinSlice, snapCuts, applyPxCut, pxSnapCut, readRects, RECTS_EXPR,
  DEFAULT_SNAP_WINDOW, SNAP_WINDOW_MIN, SNAP_WINDOW_MAX, SNAP_MIN_BAND_PX, MAX_SNAP_RECTS, SNAP_METHODS,
  classifyImg, PAGE_EXPR, IMG_PROMOTE_EXPR,
  readPage, scrollTo, promoteImages, prewarm,
  readVisibility, ensureForeground, VISIBILITY_EXPR, FOREGROUND_BG_WARNING,
  ffmpegAvailable, ffmpegBins, probeImage, stitchVertical,
  lumaProfile, blankRuns, analyzeBlankSections, blankCheckImage, blankField,
  buildBlankSummary, longestBlankRun,
  tryJpegFallback, captureSliceB, captureSlice, runScrollShot,
  // ISSUE-1：beyond-viewport 探测接线 + A2 分叉（纯函数直测面）
  sliceCaptureHeight, shouldUseA2, captureSliceA2, a2CaptureAttempt, beyondProbeClip,
};
