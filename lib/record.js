'use strict';
/*
 * chromeuse lib/record.js —— 录制编排（注入 + 采集 + 停止落盘；cdp.js record/record-stop 委托到这里）
 *
 * 多 target（V202609080013，oracle 定稿）：
 * - 默认全标签页：Target.setAutoAttach(autoAttach+flatten) 单路径自动附挂全部存量与新增 page target——
 *   不做 Target.getTargets 枚举（autoAttach 对存量 target 也立即发 attachedToTarget，枚举=双 session 双注入冗余）；
 * - 风险#2：client.onEvent（attachedToTarget/detachedFromTarget/executionContextCreated 处理）必须先注册、
 *   再发 setAutoAttach——attachedToTarget 事件可能先于命令响应到达；
 * - 风险#3：每 target 注入链（Page.enable → addScript → Runtime.enable → 上下文补注入 → 存量 evaluate）
 *   独立 try/catch + 状态表隔离，单个 chrome:// 崩溃 target 不拖垮录制循环；
 * - 风险#1：去重键 = targetId:frame:seq（三元，跨 target seq 无意义）；事件双标 tab（tab-N 别名，
 *   attach 顺序分配，关了重开=新别名）+ targetId；events.js 折叠/突发键同步加 tab 维度；
 * - 停止铁律不变：flushToDisk 同步首刷（落盘前现取存活 target 的 url/title——attach 存档会过期，
 *   V202609080014）→ （可选增强）存活 session 逐个 flush() 等 300ms 二次覆写补尾 →
 *   collector.stop + client.close O(1) 拆除（WS 断开浏览器自动回收全部 session），不逐 session ping；
 * - --target 保留单 target 降级路径（不 setAutoAttach，仅注入指定标签页）。
 *
 * V202609080014 实测修复（多 target 首轮实录）：
 * - 主 bug：HTTPS 页面向 http beacon sendBeacon 被混合内容策略静默拦截（tab-1 https 零事件）→
 *   Runtime.addBinding('__chromeuseBeacon') 会话级注册 + Runtime.bindingCalled 回程直喂 onPayload 管道
 *   （不经页面网络栈）；页面侧优先 binding、sendBeacon 保留为 http 页面/降级通道，双通道靠去重幂等；
 * - 次 bug1：session.targets 的 url/title 用 attach 存档会过期 → 落盘前 Target.getTargetInfo 现取覆盖；
 * - 次 bug2：中途关闭的 tab 从 targets 消失 → detachedFromTarget 标 closedAt，落盘保留并加 closed:true。
 *
 * V202609080015 第二轮实录修复：
 * - 实锤：去重键跨导航碰撞——seq 是页面 IIFE 私有计数器、每文档独立从 1 起，同 target 同 frame 整页导航后
 *   新文档早期事件与旧文档撞三元键被静默丢弃（main navigate load 事件消失、iframe 事件幸存的实证）→
 *   recorder 加 docId 文档代际、去重键升四元 (targetId,frame,docId,seq)，旧流无 docId 回退 '' 天然兼容；
 * - 疑点（getTargetInfo 现取失效，异常曾被静默吞掉）双保险：① 页面自报 main navigate URL 实时回填
 *   targetsMeta（location.href 比 CDP 查询真实）② 现取失败打诊断日志 + 重试 1 次。
 *
 * V202609080016 第三轮实录（带录屏 ground truth 比对）修复：
 * - 实锤①：事件成对重复（双 recorder 实例）——executionContextCreated 补注入原本对全部 context 注入，
 *   isolated world 的 window 独立于主世界、IIFE 哨兵查不到 → 完整第二实例；修复 = 只认 auxData.type==='default'；
 * - 实锤②：关 tab 清理未触发——Chromium 关 tab 发 browser 级 Target.targetDestroyed（无 sessionId），
 *   此前只听 session 级 detachedFromTarget；修复 = 补听 targetDestroyed，两分支收敛 closeTarget 幂等清理。
 *
 * 注入双保险（架构 v3 裁定）：① Page.addScriptToEvaluateOnNewDocument（覆盖后续导航/新挂 frame）
 * ② Runtime.executionContextCreated 事件驱动对每个执行上下文即时补注入（存量 frame + 运行期新挂 iframe）；
 * recorder IIFE 哨兵免疫重复注入。事件流格式 = 附录 A2；落盘前按 (t, tab, seq) 排序、三元键去重。
 * beacon 地址按 config.environment 路由：linux(NAS) → http://opencode:<port>（coding-envs 互达）；windows → 127.0.0.1。
 *
 * V202609090002 录屏兜底（-v 显式开启制，oracle 修订定稿）：
 * - flags.video 为真才对每个 target 启动一路 Page.startScreencast（lib/screencast.js 单源；每 target 独立
 *   try/catch fail-soft——录屏失败不拖垮录制主流程）；默认关 = 零新增 CDP 命令，录制主路径行为不变；
 * - onPayload 每事件补 tRecv（Node Date.now() 接收时刻）——与录屏帧 tArrive 同钟，diff-video 对照基准；
 * - 落盘头 session.video = { dir, frames } 变可选字段（未开省略，chromeuse-events/1 不 bump）；
 *   .record-state.json 仅 -v 时补 video:true 一字段；
 * - stopAll：拆 WS 前先停全部录屏并终写各 index（closeTarget 同理——关 tab 即终写该路 index）。
 *
 * V202609090003 采集失效治理（council 定稿批1+批2，根因=Selkies 重连致 renderer 替换：①域状态记账静默清零
 * 且无通知（CDP await OK=伪成功）②同 targetId 新 session 的 attachedToTarget 被无条件跳过永不重注入）：
 * - 批1 自愈通道：attachedToTarget 会话感知（同 target 新 sessionId → 以新 session 重跑 ensureInject，
 *   tab 别名自 targetsMeta 复用）；幽灵 detached 守卫（仅 st.sessionId===事件 sid 才清理）；ensureInject
 *   幂等五连发（removeScript→addScript 记 identifier→enable/addBinding→evaluate）提取供四路径统一；
 *   per-target 注入锁；st.error（仅硬失败=协议错）与 st.pendingInject（瞬时失败交哨兵/context 补注入）拆分；
 *   waitForStableDocument（loading 等 loadEventFired/complete 后 300ms 稳定确认/冻结延迟重试 ×3）；
 *   注入后验证退避 300/800/1500ms ×3；「录制中」提示逐 tab 标注实际注入状态。
 * - 批2 哨兵+WS：10s 哨兵与 15s 采样合并单定时器交错；合并探针（recorder/beacon/readyState/beat 一次
 *   evaluate 2s 超时，纯只读）；状态机 OK→SUSPECT→LOST（迁移才打日志；探针超时=冻结信号计 SUSPECT 不升
 *   LOST）；三态处置（ok 跳过/no_binding 仅补 addBinding/其余全量 ensureInject(reInject:true)）；节流
 *   （重注入冷却 3s、单次 LOST ≤3 次、每 target 会话总上限 5、连续 2 败告警 10min 去抖、3 连败落盘头
 *   injectLost:true 响亮告警）；--no-sentinel 可关。WS 有界重连（cdp-core.onClose+reconnect）：一次
 *   5s 预算重连+重发 setAutoAttach（重 attach 路径全量重注入），未成 → 响亮 stopAll('ws-down') 落盘头
 *   wsDown:true。事件加 ch:'binding'|'beacon' 通道标记（chromeuse-events/1 不 bump）。
 *
 * V202609220001 定位素材采集（TODO【录制定位素材增强：语义事件采集 domPath+aria 名】Jev 吸收终审定稿）：
 * - 页侧（tools/recorder.js）对语义动作事件（白名单 click/dblclick/contextmenu/input/change/paste）
 *   计算 item.locate 素材（稳定 CSS path + aria role/name），随既有批次/通道回传——零新增监听、
 *   零新增 CDP 命令；选路页侧：事件时刻元素必活、O(depth) 属性读零网络往返（Node 侧回查每事件
 *   evaluate 5~50ms 超预算且元素易失——详见 recorder.js 模块注）；
 * - Node 侧本文件三职责：①接收剥离（onPayload 里 locateAccept 门控 → materials 数组 + delete e.locate——
 *   事件流 chromeuse-events/1 形状零变化，终审铁律：素材不进 flow schema、不进回放执行链）；
 *   ②哨兵门控（注入期 CFG.locateOn=--no-sentinel 关；接收期 st.sentinel.state==='OK' 才收——
 *   SUSPECT/LOST 自动停采、恢复自动续采，fail-soft 不影响录制主链路）；③落盘（独立素材 jsonl 文件名走
 *   paths.locateMaterialsPath 单源，写盘方零字面量）；
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const log = require('./log');
const time = require('./time');
const platform = require('./platform'); // 平台层单例（批2：beacon 基址按平台 impl 选择；无 environment 字面量散落）

const RECORDER_SRC = fs.readFileSync(path.join(paths.SKILL_ROOT, 'tools', 'recorder.js'), 'utf8');
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
// 时间戳单源 lib/time.js（时区配置 CHROMEUSE_TZ_OFFSET，默认 UTC+8）——session/落盘文件命名统一走配置时区
const ts = () => time.formatStamp();
const sleep = time.sleep; // 通用延迟单源 lib/time.js

/** 批1② 幽灵 detached 守卫（纯函数导出，selftest 可测）：事件 sid 已知且 ≠ 当前 state 的 sessionId
    → true（旧 session 的分离事件迟到——renderer swap 后旧 session 拆除，跳过清理，target 正活在新
    session 下）；browser 级事件无 sid（undefined）→ false（不跳过，正常清理） */
function ghostDetachFn(currentSessionId, eventSessionId) {
  return eventSessionId !== undefined && eventSessionId !== currentSessionId;
}

function beaconBaseFor(flags, port) {
  if (flags['beacon-url']) return String(flags['beacon-url']).replace(/\/+$/, '');
  return platform().browser.beaconBase(port); // 平台差异（容器服务名/本机回环）归平台层 impl（批2）
}

/** 分层录制档位解析纯函数（selftest #57 直测；ora-20260917 题1 步骤4）：truthy（--full-input）→ full，
    其余（含缺省）semantic——默认档零新增监听（过度录制边界，报告 1.3/1.7） */
function resolveInputProfile(fullFlag) {
  return fullFlag ? 'full' : 'semantic';
}

/** 剪贴板脱敏档位解析纯函数（selftest #57 直测；ora-20260917 题1 步骤1，报告 1.5.2 档位语义单源）：
    CLI --clipboard-policy > config recorder.clipboardPolicy > 默认 text（报告建议档）；
    非法值逐级跳过（非法 CLI 值不遮蔽合法 config 值），全非法回退默认 */
function resolveClipboardPolicy(flagVal, cfgVal) {
  const LEGAL = ['text', 'masked', 'meta'];
  if (LEGAL.includes(flagVal)) return flagVal;
  if (LEGAL.includes(cfgVal)) return cfgVal;
  return 'text';
}

/** 定位素材接收门控纯函数（V202609220001 ③，selftest #62 直测）：哨兵总开关 + 该 target 哨兵状态机
    OK 才收——SUSPECT/LOST（探针失败/冻结/重注入中）自动停采，恢复 OK 自动续采；st 缺失（状态表
    未及登记的边角）防御性拒收 */
function locateAcceptFn(sentinelOn, st) {
  return !!sentinelOn && !!st && !!st.sentinel && st.sentinel.state === 'OK';
}

/** 定位素材条目封装纯函数（V202609220001，selftest #62 直测）：事件信元（session/tab/targetId/frame/
    docId/seq/type/t）+ Node 侧 collectedAt 时间戳（lib/time.js isoLocal，last-verified 惯例打标；
    接收时刻 ≈ 采集时刻，页侧 flush 队列 ≤200ms）+ 页侧素材体展开（aria 恒先于 domPath——字段排布
    体现 aria/role/name 优先于 CSS path）。frame 字段即「frame 标识」：素材天然 frame 局部 path
    （页侧每 frame 独立实例，只爬本文档）+ 本字段定位 frame——⑤ 跨 frame 完整链不进首版 MV */
function locateEnvelopeFn(ev, session, collectedAt) {
  return Object.assign({
    collectedAt: String(collectedAt || ''),
    session: session || '',
    tab: (ev && ev.tab) || '',
    targetId: (ev && ev.targetId) || '',
    frame: (ev && ev.frame) || '',
    docId: (ev && ev.docId) || '',
    seq: (ev && ev.seq) || 0,
    type: (ev && ev.type) || '',
    t: (ev && ev.t) || 0,
  }, (ev && ev.locate) || {});
}

function makeInitScript(beaconUrl, session, tab, targetId, reInject, extra) {
  // __CHROMEUSE_RECORDER_SRC 供主世界向存量同源子帧自传播（tools/recorder.js propagate 段读取）；
  // tab/targetId 按 target 注入（每 target 一份 CFG——事件双标 tab+targetId，V202609080013）；
  // reInject:true = 哨兵/重连路径（V202609090003）：页侧跳过初始 load-navigate 发射 + uiAppear 静默重打底，
  // 防重注入伪 navigate 污染时间线（启动路径 false）；
  // extra { inputProfile, clipboardPolicy, locateOn }（ora-20260917 题1 步骤1/4 + V202609220001）：
  // 分层录制档位 + 剪贴板脱敏档位 + 定位素材注入侧哨兵门控（--no-sentinel → false）随 CFG 注入页侧
  // （页侧再各自非法回退 semantic/text/开，双保险）；缺省 semantic/text/开——旧调用方零回归
  const ex = extra || {};
  return 'window.__CHROMEUSE_RECORDER_CFG = ' + JSON.stringify({
    beaconUrl, session, tab: tab || '', targetId: targetId || '', reInject: !!reInject,
    inputProfile: ex.inputProfile === 'full' ? 'full' : 'semantic',
    clipboardPolicy: resolveClipboardPolicy(ex.clipboardPolicy, undefined),
    locateOn: ex.locateOn !== false,
  }) + ';\n'
    + 'window.__CHROMEUSE_RECORDER_SRC = ' + JSON.stringify(RECORDER_SRC) + ';\n'
    + RECORDER_SRC;
}

/** record 子命令：注入并采集，SIGINT / --duration / record-stop 停止落盘。默认全标签页，--target 单页降级
 *  互斥语义（V202610200001，2026-10-19 用户裁定）：**默认无锁**——锁只保留在「打开页签并获取 pageId」层
 *  （snippets/tab-helper.js 锁页 CAS，独立一层）；`--lock` = 可选显式互斥（兼容旧脚本语义）。
 *  无锁时零副作用：不建 locks 目录、不写锁文件、不起 heartbeat 定时器（无孤儿锁/孤儿 timer）。 */
async function record(flags) {
  const lockOn = !!flags.lock;
  const lock = require('./lock');
  if (lockOn) {
    const got = lock.acquire('record');
    if (!got.ok) {
      console.error(`✗ 另一动作正持锁：${got.holder.owner}（pid ${got.holder.pid}）——等其结束或清理 stale 锁（不加 --lock 即默认无互斥）`);
      return 1;
    }
  }
  const heartbeat = lockOn ? lock.hold(5000) : null;
  const core = require('./cdp-core');
  const { startCollector } = require('./collector');
  const url = core.resolveBrowserUrl(flags.url);
  const port = num(flags['beacon-port'], 9999);
  const beaconUrl = beaconBaseFor(flags, port) + '/beacon';
  const session = 'rec-' + ts();
  const outFile = flags.out || path.join(paths.EVENTS_DIR, `recording-${ts()}.json`);
  const stateFile = path.join(paths.EVENTS_DIR, '.record-state.json');

  /* ── 多 target 状态表（风险#3：per-target 隔离）──
     置于 onPayload 之前：navigate URL 兜底（V202609080015）在 onPayload 里引用 targetsMeta，
     collector 若在 listen 后、声明前收到 beacon 会触发 TDZ ReferenceError——声明顺序消除该窗口 */
  const targetStates = new Map(); // targetId → { sessionId, tab, targetId, url, title, script, dpr, error }
  const targetsMeta = new Map();  // targetId → {tab, targetId, url, title, closedAt?}（会话内累计台账：
                                  //   中途关闭的标 closedAt 落盘保留 closed:true——V202609080014 次 bug2）
  let tabCounter = 0;             // tab-N 别名：attach 顺序分配，关了重开=新别名（正确语义）
  let sessionDpr = null;          // 事件流头参考值 = 首个成功实测的 target DPR（录制不 emulate——V202609080010）
  let inflight = 0;               // 初始注入在途计数（「录制中」提示等全部初始注入完成后再打印）
  let singleTargetId = null;      // --target 降级路径的目标 id（默认全标签页模式为 null）
  let videoFramesTotal = 0;       // 录屏兜底帧总数（仅 -v 时增长；onFrame 回调累计，落盘头 session.video.frames）
  let sessionViewport = null;     // V202609100002 F3 数据基建：视口环境快照（首成功 target 采集一次，落盘头 session.viewport）
  const sentinelOn = !flags['no-sentinel']; // 批2：哨兵总开关（--no-sentinel 可关，默认开）
  // 帧率 v1（oracle-20260917 题2）：--every-nth 抽帧率，默认 6≈上限 10fps、1=旧全速收帧；
  // 解析/护栏单源 screencast.resolveEveryNth（这里传原始旗标值，非法值在 screencast 内回退默认）
  const everyNthFlag = require('./screencast').resolveEveryNth(flags['every-nth']);
  // 分层录制 + 剪贴板脱敏（ora-20260917 题1 步骤1/4）：解析单源 resolveInputProfile/resolveClipboardPolicy
  //（selftest #57 直测）；CLI 旗标 > config recorder.clipboardPolicy 可选键 > 默认（semantic/text，报告建议档）。
  // recorder.clipboardPolicy 为 config 可选键（模板未登记——实例缺省即默认档，不破坏 #16 模板键审阅）
  let cfgClipPolicy;
  try { const c = require('./config').loadConfig(); cfgClipPolicy = c && c.recorder && c.recorder.clipboardPolicy; } catch { /* config 缺失/坏 → 走默认档 */ }
  const clipPolicy = resolveClipboardPolicy(String(flags['clipboard-policy'] || ''), cfgClipPolicy);
  const inputProfile = resolveInputProfile(!!flags['full-input']);
  /* -v 录屏配额预检（V202611030005 B3 N2）：托管总量已超配额 → 关闭 -v（帧流是重产物），事件流继续；
   * 帧为逐帧增量写（lib/screencast），无法逐帧拒——预检是 video 入口的准入闸（总配额仍由事件流落盘闸兜底）。 */
  if (flags.video) {
    const vq = require('./quota').check({ file: path.join(paths.VIDEO_DIR, session, '000001.jpg'), bytes: 0, cmd: 'record' });
    if (!vq.ok) {
      flags.video = false;
      log.error('record', `${vq.code}: ${vq.message}`);
      console.error(`[record] ✗ ${vq.message}——已关闭 -v 录屏兜底（事件录制继续；可先 node tools/cdp.js artifacts prune --apply）`);
    } else if (vq.message) {
      console.error(`[record] ⚠ ${vq.message}`);
    }
  }
  let injectLostFlag = false;     // 批2：任一 target 哨兵 3 连败 → 落盘头 injectLost:true + 响亮告警
  const byCh = { binding: 0, beacon: 0 }; // 批2：通道计数（采样日志分通道列示）

  const events = [];
  const materials = []; // V202609220001 定位素材（onPayload 剥离后入列；flushToDisk 落独立素材 jsonl——paths 单源命名）
  const seen = new Set();
  const onPayload = (u, text) => {
    try {
      const obj = JSON.parse(text);
      for (const e of (obj && obj.batch) || []) {
        // 四元去重键（V202609080015）：seq 是页面 IIFE 私有计数器、每个文档独立从 1 起——同 target 同 frame
        // 跨整页导航后新文档早期事件会与旧文档撞三元键被静默丢弃（第二轮实录实锤）；docId=文档代际隔离。
        // 旧事件流无 docId 回退 ''，与旧三元键等价，天然兼容（chromeuse-events/1 不 bump）
        const key = `${e.targetId || ''}:${e.frame || ''}:${e.docId || ''}:${e.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // V202609220001 定位素材剥离：哨兵门控（注入侧 CFG.locateOn + 接收期 state==='OK'——SUSPECT/LOST
        // 自动停采/恢复自动续采）→ materials 入列；随后无条件 delete——素材永不入事件流
        // （chromeuse-events/1 形状零变化，终审铁律）。fail-soft：门控不过仅丢素材，录制主链路零感知
        if (e.locate) {
          if (locateAcceptFn(sentinelOn, targetStates.get(e.targetId))) {
            materials.push(locateEnvelopeFn(e, session, time.isoLocal()));
          }
          delete e.locate;
        }
        // V202609090002：每事件补 tRecv（Node 接收时刻，毫秒）——与录屏帧 tArrive 同钟，
        // diff-video 事件→帧对照统一用该字段（旧事件流无 tRecv 回退 e.t，天然兼容）
        e.tRecv = Date.now();
        // V202609090003 批2：回传通道标记（可选字段，chromeuse-events/1 不 bump）——
        // onPayload 来源参数 u：'binding:<sid>'（CDP binding 回程）| '/beacon'（HTTP collector）
        e.ch = String(u || '').indexOf('binding') === 0 ? 'binding' : 'beacon';
        byCh[e.ch] = (byCh[e.ch] || 0) + 1;
        events.push(e);
        // V202609080015 疑点双保险①：页面自报的 main navigate URL（location.href）永远比 CDP 查询真实——
        // 到达即实时更新 targetsMeta.url（title 无从知晓保留现值）；getTargetInfo 现取失效时落盘仍有正确 URL
        if (e.type === 'navigate' && e.frame === 'main' && e.url) {
          const meta = targetsMeta.get(e.targetId);
          if (meta) meta.url = String(e.url).slice(0, 300);
        }
      }
    } catch (e) { log.warn('record', `非 JSON payload（忽略）：${e.message}`, { echo: true }); }
  };
  const collector = await startCollector({ host: '0.0.0.0', port, quiet: true, onPayload, onStop: () => stopAll('record-stop') });
  const client = new core.CdpClient(url, { timeoutMs: num(flags.timeout, 8000) });
  await client.connect();

  /* ── 批1⑥ waitForStableDocument：注入前文档稳定探测 ──
     loading → 等 loadEventFired（5s 超时兜底）；complete/interactive → 300ms 无新导航确认；
     evaluate 超时/异常（冻结信号）→ 延迟 1s 重试 ×3 → 仍败返回失败（置 pendingInject 交哨兵） */
  function waitLoadEvent(sessionId, timeoutMs) {
    return new Promise((resolve) => {
      const off = client.onEvent(({ sessionId: sid, method }) => {
        if (sid === sessionId && method === 'Page.loadEventFired') { off(); clearTimeout(t); resolve(true); }
      });
      const t = setTimeout(() => { off(); resolve(false); }, timeoutMs);
    });
  }
  async function waitForStableDocument(st) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let rs = await core.evaluate(client, st.sessionId, 'document.readyState', 2000);
        if (rs === 'loading') {
          const loaded = await waitLoadEvent(st.sessionId, 5000);
          if (!loaded) return { ok: false, reason: 'loading>5s' };
        }
        const url1 = await core.evaluate(client, st.sessionId, 'String(location.href)', 2000).catch(() => null);
        await sleep(300); // 稳定确认：300ms 无新导航
        const rs2 = await core.evaluate(client, st.sessionId, 'document.readyState', 2000).catch(() => null);
        const url2 = await core.evaluate(client, st.sessionId, 'String(location.href)', 2000).catch(() => null);
        if (rs2 && rs2 !== 'loading' && url1 !== null && url1 === url2) return { ok: true };
        log.info('record', `${st.tab} 文档仍在导航（readyState=${JSON.stringify(rs2)}）——重探 ${attempt}/3`);
      } catch (e) {
        log.info('record', `${st.tab} 稳定探测异常（冻结信号）——延迟 1s 重试 ${attempt}/3：${e.message}`);
        await sleep(1000);
      }
    }
    return { ok: false, reason: '3 次探测未稳定（冻结/持续导航）' };
  }

  /* ── 批1⑦ 注入后验证 + 退避（前紧后松 300/800/1500ms ×3）── 验证只读哨兵，失败交哨兵接管 */
  async function verifyInject(st) {
    for (const delay of [0, 300, 800, 1500]) {
      if (delay) await sleep(delay);
      try {
        if (await core.evaluate(client, st.sessionId, '!!window.__chromeuseRecorder', 2000) === true) return true;
      } catch { /* 冻结轮询重试 */ }
    }
    log.warn('record', `${st.tab} 注入验证 3 次退避失败——置 pendingInject 交哨兵`);
    console.error(`[record] ⚠ ${st.tab} 注入验证失败（退避 300/800/1500ms）——交哨兵接管`);
    return false;
  }

  /* ── 批1③ ensureInject：幂等五连发注入链（启动/重 attach/哨兵 LOST/WS 重连四路径统一走它）──
     ①旧 scriptId removeScript（吞错）②addScript 记 identifier ③Page/Runtime.enable+addBinding
     ④evaluate 存量补注入。批1⑤语义拆分：enable/addScript/addBinding 协议错误 = 硬失败置 st.error；
     evaluate 失败/超时/验证不过 = 瞬时失败清 error 置 st.pendingInject（context 补注入与哨兵接管）。
     批1④注入锁：注入中不重入。opts { reason, reInject } */
  async function ensureInject(st, opts) {
    const o = opts || {};
    if (st.injecting) { log.info('record', `${st.tab} 注入进行中——重入跳过（注入锁，reason=${o.reason || 'startup'}）`); return false; }
    st.injecting = true;
    try {
      const stable = await waitForStableDocument(st);
      if (!stable.ok) {
        st.error = null; st.pendingInject = true;
        log.warn('record', `${st.tab} 注入等待文档稳定失败（${stable.reason}）——置 pendingInject 交哨兵`);
        return false;
      }
      if (st.scriptId) { // 重注入防双实例：移除旧注册（旧 renderer 可能已清零——吞错）
        try { await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: st.scriptId }, { sessionId: st.sessionId }); } catch { /* 吞错 */ }
        st.scriptId = null;
      }
      const script = makeInitScript(beaconUrl, session, st.tab, st.targetId, o.reInject, { inputProfile, clipboardPolicy: clipPolicy, locateOn: sentinelOn }); // locateOn：素材注入侧哨兵门控（V202609220001）
      st.script = script;
      try {
        await client.send('Page.enable', {}, { sessionId: st.sessionId }); // flatten 会话下 Page 域必须 enable（2026-09-08 S1 实测）
        const reg = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, { sessionId: st.sessionId });
        st.scriptId = (reg && reg.identifier) || null;
        await client.send('Runtime.enable', {}, { sessionId: st.sessionId });
        // V202609080014 beacon 主通道：addBinding 不下 executionContextId = 本会话全部 context 可用
        await client.send('Runtime.addBinding', { name: '__chromeuseBeacon' }, { sessionId: st.sessionId });
      } catch (e) {
        st.error = e.message; // 硬失败：协议错误（域不可用/会话死）
        log.warn('record', `${st.tab} 注入硬失败（${o.reason || 'startup'}）：${e.message}`);
        return false;
      }
      // V202609080010 DPR 立场反转：读实际值写事件流头（软失败静默留空）
      try {
        const dpr = await core.evaluate(client, st.sessionId, 'window.devicePixelRatio', 3000);
        st.dpr = dpr;
        if (sessionDpr === null) sessionDpr = dpr;
      } catch { /* 冻结期读不到则留空 */ }
      try {
        await core.evaluate(client, st.sessionId, script, 5000); // 主文档存量补注入（瞬时失败可重试）
      } catch (e) {
        st.error = null; st.pendingInject = true;
        log.warn('record', `${st.tab} 存量补注入失败（瞬时，${o.reason || 'startup'}）——置 pendingInject：${e.message}`);
        return false;
      }
      const ok = await verifyInject(st);
      if (!ok) { st.error = null; st.pendingInject = true; return false; }
      st.pendingInject = false; st.error = null;
      st.injectedAt = new Date().toISOString();
      log.info('record', `${st.tab} 注入成功（${o.reason || 'startup'}${o.reInject ? '，reInject 静默模式' : ''}）`);
      return true;
    } finally {
      st.injecting = false;
    }
  }

  /** 单 target 注入编排（批1① session 感知 + 批1④ 注入锁在 ensureInject 内）：每 target 独立 try/catch 隔离。
      opts { reason, reInject }；同 targetId 重入复用状态对象（tab/别名/哨兵簿记保留），sessionId 覆盖为新值 */
  async function setupTarget(sessionId, targetInfo, opts) {
    const o = opts || {};
    const targetId = targetInfo.targetId;
    const prev = targetStates.get(targetId);
    // 别名：新 targetId 按序分配 tab-N（关了重开=新 targetId=新别名）；同 targetId 重入复用旧别名
    const tab = (targetsMeta.get(targetId) || {}).tab || 'tab-' + (++tabCounter);
    const st = prev || { targetId, tab, url: '', title: '', script: null, scriptId: null, dpr: null, error: null, pendingInject: false, injecting: false, injectedAt: null, sentinel: { state: 'OK', fails: 0, reinjects: 0, totalReinjects: 0, lastReinjectAt: 0, lastAlertAt: 0 } };
    st.sessionId = sessionId; // 批1①：renderer swap → 覆盖为新 session（旧 session 域状态已随 renderer 清零）
    st.tab = tab; st.targetId = targetId;
    if (targetInfo.url) st.url = targetInfo.url;
    if (targetInfo.title) st.title = targetInfo.title;
    st.script = null; // 旧 script 引用作废（ensureInject 会重新组装并注册）
    targetStates.set(targetId, st);
    targetsMeta.set(targetId, { tab, targetId, url: st.url, title: st.title });
    inflight++;
    try {
      await ensureInject(st, { reason: o.reason || 'startup', reInject: !!o.reInject });
    } catch (e) {
      st.error = e.message;
      log.warn('record', `${st.tab} 注入编排异常（${st.url.slice(0, 60)}）——错误隔离：${e.message}`);
    } finally {
      inflight--;
    }
    // V202609100002 F3 数据基建：视口环境快照（session 头一次，首成功 target；Runtime 已 enable 窗口期）
    // resize 追踪列为 TODO 不本期做——先 session 头快照 + 采样日志附带 innerWidth 现值
    if (!sessionViewport) {
      try {
        const vpj = await core.evaluate(client, sessionId, 'JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio,sw:screen.width,sh:screen.height})', 2000);
        if (vpj) {
          sessionViewport = JSON.parse(vpj);
          log.info('record', `${tab} 视口环境采集：${vpj}`);
        }
      } catch { /* fail-soft：冻结期/受限页留空 */ }
    }
    // V202609090002 录屏兜底（-v 显式开启，默认关）：每 target 一路 screencast；重 attach（renderer swap）
    // 时旧路挂在死 session 上——停旧路再启新路（独立 try/catch fail-soft，不影响事件录制）
    if (flags.video) {
      try { if (st.screencast) await st.screencast.stop(); } catch { /* fail-soft */ }
      try {
        st.screencast = await require('./screencast').start({
          client, sessionId, tab, session,
          videoDir: paths.ensureDir(path.join(paths.VIDEO_DIR, session)),
          intervalMs: num(flags['video-interval'], 1000),
          maxWidth: num(flags['video-width'], 960),
          quality: num(flags['video-quality'], 60),
          everyNthFrame: everyNthFlag, // 帧率 v1：--every-nth 透传（默认 6≈上限 10fps；1=旧全速收帧）
          onFrame: () => { videoFramesTotal++; },
        });
      } catch (e) {
        log.warn('record', `${tab} 录屏启动失败（fail-soft，不影响事件录制）：${e.message}`);
        console.error(`[record] ⚠ ${tab} 录屏启动失败（不影响事件录制）：${e.message}`);
      }
    }
    return st;
  }

  /** 关 tab 幂等清理（V202609080016 bug②）+ 批1② 幽灵 detached 守卫：detachedFromTarget（session 级）
      与 targetDestroyed（browser 级无 sid）两事件共用；targetsMeta 的 !closedAt 守卫天然幂等。
      批1②：sid 已知（detached 路径）且 ≠ st.sessionId = 旧 session 的分离事件迟到（renderer swap 后
      旧 session 拆除）——不清理不标 closed（target 正活在 新 session 下），日志记录跳过 */
  function closeTarget(targetId, via, sid) {
    if (!targetId) return;
    const st = targetStates.get(targetId);
    if (st) {
      if (ghostDetachFn(st.sessionId, sid)) {
        log.info('record', `${st.tab} 收到旧 session（${String(sid).slice(0, 8)}）的 ${via}——当前 session ${String(st.sessionId).slice(0, 8)} 存活，跳过清理（幽灵守卫）`);
        return;
      }
      log.info('record', `${st.tab} 已关闭（${st.url.slice(0, 60)}，经 ${via}）——已录事件保留`);
      console.log(`[record] ${st.tab} 已关闭（${st.url.slice(0, 60)}，经 ${via}）——已录事件保留，不回填`);
      // V202609090002：关 tab 同步停该路录屏并终写 index（session 已死 stopScreencast 会失败——stop 内部吞掉）
      if (st.screencast) { try { st.screencast.stop(); } catch { /* fail-soft */ } }
      targetStates.delete(targetId); // 关了重开 = 新 targetId = 新别名
    }
    const meta = targetsMeta.get(targetId);
    if (meta && !meta.closedAt) meta.closedAt = new Date().toISOString(); // 落盘保留该条并加 closed:true
  }

  /* ── 风险#2：事件监听先注册，再发 setAutoAttach（attachedToTarget 可能先于命令响应到达） ── */
  const offEvent = client.onEvent(({ sessionId: sid, method, params }) => {
    if (method === 'Target.attachedToTarget') {
      const ti = params.targetInfo || {};
      client.registerSession(params.sessionId, ti); // cdp-core 反向映射回填（sessionId → targetInfo）
      const prev = targetStates.get(ti.targetId);
      if (prev && prev.sessionId === params.sessionId) return; // 批1①：同 target 同 session → 幂等跳过
      if (singleTargetId) {
        // --target 降级路径不经过这里（不 setAutoAttach）；防御：只认指定 target（同样会话感知）
        if (ti.targetId === singleTargetId) {
          setupTarget(params.sessionId, ti, { reason: prev ? 're-attach' : 'startup', reInject: !!prev }).catch(() => {});
        }
        return;
      }
      if (ti.type !== 'page') return; // OOPIF/service worker 各有独立 targetId，混入会打碎 tab 别名语义；同源子帧由页面内自传播覆盖
      if (prev) {
        // 批1① 核心：同 targetId 新 sessionId = renderer 替换（crash/Selkies 重连）——旧 session 域状态
        // 已随 renderer 静默清零（Page.enable/addScript/addBinding 全灭且 CDP await OK=伪成功），
        // 以新 session 重跑 setupTarget（tab 别名自 targetsMeta 复用、状态对象覆盖、ensureInject 全量）
        log.warn('record', `renderer-swapped re-attach: ${prev.tab} 旧ses=${String(prev.sessionId).slice(0, 8)}→新ses=${String(params.sessionId).slice(0, 8)}——重跑注入链`);
        console.log(`[record] ⚠ ${prev.tab} renderer 替换（重附挂）——自动重注入（reInject 静默模式）`);
      }
      setupTarget(params.sessionId, ti, { reason: prev ? 're-attach' : 'startup', reInject: !!prev }).catch(() => { /* setupTarget 内部已隔离，此处兜底 */ });
    } else if (method === 'Target.detachedFromTarget') {
      // session 级分离：经 cdp-core sessionId→targetInfo 反查；批1② 幽灵守卫 = sid 不匹配当前 state 则跳过
      const info = client.targetOfSession(sid) || {};
      closeTarget(info.targetId, 'detachedFromTarget', sid);
    } else if (method === 'Target.targetDestroyed') {
      // V202609080016 bug②：关 tab 时 Chromium 发的是 browser 级 targetDestroyed（无 sessionId、
      // params.targetId 直接携带；cdp-core 分发层无 sid 过滤，undefined sessionId 原样透传到监听器——已核实），
      // 此前只听 session 级 detachedFromTarget，实测关闭后死 target 残留（现取报 -32602）、台账无 closed 条目
      closeTarget(params && params.targetId, 'targetDestroyed');
    } else if (method === 'Runtime.bindingCalled') {
      // V202609080014 beacon 主通道回程：binding payload（batch JSON 字符串）直接喂 onPayload 管道。
      // binding 是会话级注册，事件按 sid 归属；解析异常吞掉不拖垮循环（onPayload 内部已 try/catch）
      if (!params || params.name !== '__chromeuseBeacon' || typeof params.payload !== 'string') return;
      try { onPayload('binding:' + sid, params.payload); } catch { /* 尽力而为 */ }
    } else if (method === 'Runtime.executionContextCreated') {
      const info = client.targetOfSession(sid) || {};
      const st = targetStates.get(info.targetId);
      // 批1⑤：st.error 现仅承载硬失败（协议错）——瞬时失败走 pendingInject 不在此挡；
      // 批1④：注入锁——全量链进行中时 context 补注入让路（链内 evaluate 覆盖主世界，防同帧双注入）
      if (!st || st.error || !st.script) return;
      if (st.injecting) return;
      const ctx = params.context;
      if (!ctx || !ctx.id) return;
      // V202609080016 bug①：只补注入主世界（auxData.type==='default'）——isolated world 二次注入=双实例
      // （第三轮实录实锤）。Page.addScriptToEvaluateOnNewDocument 不受影响（本来就只跑 main world）
      if (!ctx.auxData || ctx.auxData.type !== 'default') return;
      // 每 target 的 initScript 各带自己的 tab/targetId CFG；批1⑤：pendingInject 目标每次 context
      // 创建都尝试补注入，成功即解除 pending（哨兵接管的轻量替代路径）
      client.send('Runtime.evaluate', { expression: st.script, contextId: ctx.id }, { sessionId: sid })
        .then(() => {
          if (st.pendingInject) { st.pendingInject = false; log.info('record', `${st.tab} pendingInject 经 context 补注入解除`); }
        })
        .catch(() => { /* 跨域 frame 注入尽力而为 */ });
    }
  });

  if (flags.target) {
    /* ── 单 target 降级路径：不 setAutoAttach，仅注入指定标签页（新开 tab 不录） ── */
    const { target, sessionId } = await core.resolveTarget(client, flags.target);
    singleTargetId = target.id;
    client.registerSession(sessionId, { targetId: target.id, type: target.type, url: target.url, title: target.title });
    await setupTarget(sessionId, { targetId: target.id, url: target.url, title: target.title }, { reason: 'startup' });
  } else {
    /* ── 默认全标签页：setAutoAttach 单路径（风险#5：不做 getTargets 枚举——存量 target 也立即发 attachedToTarget） ── */
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // 「录制中」提示等全部初始注入完成后再打印（setup 内部命令自带超时，inflight 必然归零；30s 仅兜底）
    const t0 = Date.now();
    while (inflight > 0 && Date.now() - t0 < 30000) await sleep(50);
  }

  paths.ensureDir(paths.EVENTS_DIR);
  // V202609090002：stateFile 仅 -v 时补 video:true（record-stop 只读 port/pid/out，新增字段对旧消费方无影响）
  fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: collector.port, session, out: outFile, targets: targetsOut(), startedAt: time.isoLocal(), ...(flags.video ? { video: true } : {}) }));
  // B7 N6：作业进度（artifact=录制事件流路径；非作业进程回调不传）
  try {
    if (typeof flags.onProgress === 'function') {
      flags.onProgress({ phase: 'record', current: targetsMeta.size, total: null, artifact: outFile, detail: `session=${session}` });
    }
  } catch { /* 进度旁路 */ }
  log.info('record', `录制启动 session=${session} 模式=${flags.target ? '单页降级' : '全标签页'} 录屏=${flags.video ? '开' : '关'} 哨兵=${sentinelOn ? '开' : '关（--no-sentinel）'} 素材=${sentinelOn ? '开' : '关（随哨兵）'} beacon=${beaconUrl} 输出=${outFile} 输入档=${inputProfile} 剪贴板=${clipPolicy}`);
  console.log(`[record] 录制中：${targetsMeta.size} 个标签页（session=${session}）`);
  // 批1⑧「录制中」提示升级：逐 tab 标注实际注入状态（伪注入当场可见——第 5 轮实录若有此提示当场就能发现）
  for (const t of targetsMeta.values()) {
    const st = targetStates.get(t.targetId);
    const mark = !st ? '?' : st.pendingInject ? '⚠ pendingInject（哨兵接管）' : st.error ? `✗ 硬失败：${String(st.error).slice(0, 40)}` : '✓ 已注入';
    console.log(`[record]   ${t.tab}  [${mark}]  ${(t.title || t.url || '').slice(0, 56)}`);
  }
  log.info('record', `已附挂 ${targetsMeta.size} 个标签页：${[...targetStates.values()].map((s) => `${s.tab}(${s.pendingInject ? 'pending' : s.error ? 'hard-fail' : 'injected'})`).join('、') || '无（等待新开 tab 自动附挂）'}`);
  if (!targetsMeta.size) console.log('[record] ⚠ 当前无 page target——保持运行中，新开标签页会被自动附挂并录入');
  console.log(`[record] beacon=${beaconUrl}（页面侧可达地址）｜ 模式=全标签页（--target 可降级单页）｜ 注入=initScript+执行上下文双保险｜ DPR=${sessionDpr}（实测记录，不 emulate）｜ 哨兵=${sentinelOn ? '开（10s 探针）' : '关'}｜ 素材=${sentinelOn ? '开（独立素材文件，随哨兵门控，paths 单源）' : '关（随哨兵）'}｜ 输入档=${inputProfile}${inputProfile === 'full' ? '（--full-input：wheel/focus/auxclick/F 键）' : ''}｜ 剪贴板=${clipPolicy}`);
  if (flags.video) console.log(`[record] 录屏兜底=开（Page.startScreencast，每 target 一路，抽帧 everyNthFrame=${everyNthFlag}≈上限 10fps；--every-nth <n> 可调，1=全速，v2 事件驱动两档制见 reports/录制侧演进分析-oracle-20260917.md）→ ${path.join(paths.VIDEO_DIR, session)}（对照：node tools/cdp.js diff-video <事件流>）`);
  else console.log('[record] 录屏兜底=关（-v 开启：帧流视觉对照，默认关零开销）');
  console.log(`[record] 停止方式：Ctrl+C（SIGINT）｜ node tools/cdp.js record-stop ｜ --duration ${num(flags.duration, 0)}ms`);
  const state = { startedAt: time.isoLocal() };
  let stopping = false;
  let stopReason = 'unknown';
  let quotaBlocked = null; // 事件流落盘被配额拒绝时的原因（stopAll 据此输出失败而非假成功）

  /* ── 批2 WS 有界重连：cdp-core.onClose 回调 → reconnect 一次（5s 预算）→ 重发 setAutoAttach
     （存量 target 经重 attach 路径全量 ensureInject(reInject:true)）；未成 → 响亮 stopAll('ws-down') */
  const offClose = client.onClose(() => {
    if (stopping) return;
    log.warn('record', 'WebSocket 断开——有界重连（一次，5s 预算）');
    console.error('[record] ✗ WebSocket 断开——尝试有界重连（5s）…');
    (async () => {
      const deadline = Date.now() + 5000;
      let ok = false;
      while (Date.now() < deadline && !stopping && !ok) {
        try {
          await client.reconnect(3000); // cdp-core：复用实例与事件监听器，重走握手；旧 session 全清
          await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
          // 存量 target 的旧 session 已随 WS 断开全部失效——由重 attach 路径统一重注入（reInject:true）；
          // setAutoAttach 的 attachedToTarget 事件是异步流，此处不逐个 ensureInject（避免与重 attach 并发双注入）
          ok = true;
          console.log('[record] ✓ WebSocket 重连成功——存量标签页经重附挂自动重注入');
          log.info('record', `WS 重连成功（${Date.now() - deadline + 5000}ms 预算内）`);
        } catch (e) {
          log.info('record', `WS 重连尝试失败：${e.message}`);
          await sleep(500);
        }
      }
      if (!ok && !stopping) {
        log.error('record', 'WS 重连 5s 未成——响亮退场（ws-down：已采数据立即落盘）');
        console.error('[record] ✗✗ WebSocket 重连失败——落盘已采数据后退场（ws-down），绝不静默空转');
        await stopAll('ws-down');
      }
    })().catch(() => {});
  });

  /* ── 批2 哨兵状态机（10s）与 15s 采样合并单定时器交错（5s tick：哨兵每 2 tick、采样每 3 tick）──
     探针合并三家一次 evaluate（2s 超时，纯只读：零 DOM 写/零布局读/零副作用）；chrome:///about:blank 跳过；
     OK→SUSPECT→LOST 迁移才打日志；探针超时=冻结信号计 SUSPECT 不升 LOST（12s 冻结×连续 2 失败误报数学）；
     三态处置：ok 跳过 / no_binding 仅补 addBinding / no_recorder+rs=complete 全量 ensureInject(reInject)；
     节流：重注入冷却 3s、单次 LOST ≤3、每 target 会话总上限 5、连续 2 败告警（10min 去抖）、3 连败 injectLost */
  async function sentinelProbe(st) {
    const u = String(st.url || '');
    if (u.indexOf('chrome://') === 0 || u === 'about:blank' || u === '') return { kind: 'skip' };
    try {
      const v = await core.evaluate(client, st.sessionId,
        'JSON.stringify({r:!!window.__chromeuseRecorder,b:typeof window.__chromeuseBeacon==="function",rs:document.readyState,beat:(window.__chromeuseRecorder&&window.__chromeuseRecorder.beat)?window.__chromeuseRecorder.beat():null})', 2000);
      const o = JSON.parse(v);
      if (o.r && o.b && o.rs === 'complete' && o.beat) return { kind: 'ok' };
      if (o.r && !o.b) return { kind: 'no_binding' };
      return { kind: 'no_recorder', rs: String(o.rs || '?') };
    } catch (e) {
      return { kind: 'timeout' }; // 冻结信号：计 SUSPECT 不计 LOST
    }
  }
  async function sentinelTick() {
    for (const st of [...targetStates.values()]) {
      const s = st.sentinel;
      const v = await sentinelProbe(st);
      if (v.kind === 'skip' || v.kind === 'ok') {
        if (s.state !== 'OK') log.info('record', `哨兵：${st.tab} ${s.state}→OK（探测恢复）`);
        s.state = 'OK'; s.fails = 0;
        continue;
      }
      s.fails++;
      if (s.state === 'OK') { s.state = 'SUSPECT'; log.warn('record', `哨兵：${st.tab} OK→SUSPECT（${v.kind}）`); continue; }
      if (s.state === 'SUSPECT') {
        if (v.kind === 'timeout') { log.warn('record', `哨兵：${st.tab} SUSPECT 持续（探针超时=冻结信号，计 SUSPECT 不升 LOST）`); continue; }
        if (v.kind === 'no_recorder' && v.rs !== 'complete') { log.warn('record', `哨兵：${st.tab} SUSPECT 持续（导航中 rs=${v.rs}，不误判）`); continue; }
        s.state = 'LOST';
        s.reinjects = 0;
        log.warn('record', `哨兵：${st.tab} SUSPECT→LOST（${v.kind}）——进入自愈`);
      }
      if (s.state !== 'LOST') continue;
      // 三态处置（LOST）
      if (v.kind === 'no_binding') {
        try {
          await client.send('Runtime.addBinding', { name: '__chromeuseBeacon' }, { sessionId: st.sessionId });
          log.info('record', `哨兵：${st.tab} no_binding → 仅补 addBinding（双实例最小干预，不重新 evaluate）`);
          s.state = 'OK'; s.fails = 0;
        } catch (e) { log.warn('record', `哨兵：${st.tab} 补 addBinding 失败：${e.message}`); }
        continue;
      }
      if (v.kind === 'timeout') continue; // 冻结期不重注入
      if (v.kind === 'no_recorder' && v.rs !== 'complete') { log.warn('record', `哨兵：${st.tab} LOST 但导航中（rs=${v.rs}）——暂缓重注入`); continue; }
      const now = Date.now();
      if (now - s.lastReinjectAt < 3000) continue; // 重注入冷却 3s
      if (s.reinjects >= 3) { // 单次 LOST 片段重试 ≤3
        if (now - s.lastAlertAt > 600000) {
          s.lastAlertAt = now;
          injectLostFlag = true; // 3 连败 → 落盘头 injectLost:true
          log.error('record', `${st.tab} 哨兵重注入 3 次未恢复——injectLost 落盘头已标，该 tab 采集可能持续失效`);
          console.error(`[record] ✗✗ ${st.tab} 哨兵重注入 3 次未恢复——该 tab 采集可能持续失效（事件可能缺失，diff-video/events-summary 复核）`);
        }
        continue;
      }
      if (s.totalReinjects >= 5) { // 每 target 每会话总上限 5
        if (now - s.lastAlertAt > 600000) { s.lastAlertAt = now; log.error('record', `${st.tab} 重注入达会话总上限 5——不再自动重注入`); }
        continue;
      }
      s.lastReinjectAt = now; s.reinjects++; s.totalReinjects++;
      const ok = await ensureInject(st, { reason: 'sentinel', reInject: true }).catch(() => false);
      if (ok) {
        log.info('record', `哨兵：${st.tab} LOST 自愈成功（第 ${s.reinjects}/3 次重注入）`);
        s.state = 'OK'; s.fails = 0;
      } else {
        if (s.fails >= 2 && now - s.lastAlertAt > 600000) {
          s.lastAlertAt = now;
          log.warn('record', `哨兵：${st.tab} 连续 ${s.fails} 次自愈失败`);
          console.error(`[record] ⚠ ${st.tab} 哨兵连续 ${s.fails} 次自愈失败（继续观察）`);
        }
      }
    }
  }
  let tick = 0;
  const capTimer = setInterval(async () => {
    tick++;
    if (sentinelOn && tick % 2 === 1) { sentinelTick().catch((e) => log.warn('record', `哨兵 tick 异常（fail-soft）：${e.message}`)); }
    if (tick % 3 === 2) { // 15s 采样可见性（原 capTimer 职责）：按 tab 分列 + 分通道计数
      const c = {}, byTab = {};
      for (const e of events) {
        c[e.type] = (c[e.type] || 0) + 1;
        byTab[e.tab || '?'] = (byTab[e.tab || '?'] || 0) + 1;
      }
      // V202609100002：采样附带各存活 target 的 innerWidth 现值（视口漂移可见化；resize 追踪 TODO）
      const iwByTab = {};
      for (const st of [...targetStates.values()]) {
        try { iwByTab[st.tab] = await core.evaluate(client, st.sessionId, 'window.innerWidth', 1500); } catch { iwByTab[st.tab] = '?'; }
      }
      console.log(`[record] 采样：${events.length} 事件 ${JSON.stringify(c)}｜ 按标签 ${JSON.stringify(byTab)}｜ 通道 ${JSON.stringify(byCh)}｜ innerWidth ${JSON.stringify(iwByTab)}｜ 若你已操作但计数不增长，请立即告知（捕获可能有缺口）`);
      log.info('record', `采样：${events.length} 事件 ${JSON.stringify(c)}｜ 按 tab ${JSON.stringify(byTab)}｜ 通道 ${JSON.stringify(byCh)}｜ innerWidth ${JSON.stringify(iwByTab)}｜ beacon 批次 ${collector.payloads.length}`);
    }
  }, 5000);
  /** 排序三段键 (t, tab, seq)——跨 target seq 无意义，保证落盘确定性 */
  function sortEvents() {
    events.sort((a, b) => (a.t - b.t) || String(a.tab || '').localeCompare(String(b.tab || '')) || (a.seq - b.seq));
  }
  /** targets 台账出盘形状：中途关闭的条目保留并加 closed:true（url/title 用最后已知值） */
  function targetsOut() {
    return [...targetsMeta.values()].map((m) => (m.closedAt ? Object.assign({}, m, { closed: true }) : m));
  }
  /** V202609220001 定位素材落盘：独立素材 jsonl 与事件流同目录同 stem 配对（paths.locateMaterialsPath
      单源——写盘方禁字面量文件名，selftest #20 同口径）；纯 jsonl 逐行一条；
      零素材不落空文件（--no-sentinel 会话零噪音）。幂等：全量覆写，二次补尾后重调收尾 */
  function writeMaterials() {
    if (!materials.length) return 0;
    const f = paths.locateMaterialsPath(outFile);
    const body = materials.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const q = require('./quota').check({ file: f, bytes: Buffer.byteLength(body), cmd: 'record' });
    if (!q.ok) {
      log.error('record', `${q.code}: ${q.message}`);
      console.error(`[record] ✗ 定位素材未落盘（${q.message}）`);
      return 0;
    }
    if (q.message) console.error(`[record] ⚠ ${q.message}`);
    fs.writeFileSync(f, body);
    return materials.length;
  }
  function writeDoc() {
    sortEvents();
    // V202609090002：session.video 变可选字段（仅 -v 时存在）；V202609090003：injectLost（哨兵 3 连败）/wsDown（WS 重连失败退场）可选标记
    const videoOut = flags.video ? { dir: path.join(paths.VIDEO_DIR, session), frames: videoFramesTotal } : undefined;
    const doc = {
      format: 'chromeuse-events/1',
      session: Object.assign(
        { id: session, startedAt: state.startedAt, stoppedAt: time.isoLocal(), reason: stopReason, browserUrl: url, targets: targetsOut(), beaconUrl, dpr: sessionDpr, dprSource: '实测值（录制不 emulate——V202609080010）' },
        videoOut ? { video: videoOut } : {},
        injectLostFlag ? { injectLost: true } : {},
        stopReason === 'ws-down' ? { wsDown: true } : {},
        sessionViewport ? { viewport: sessionViewport } : {},
        inputProfile === 'full' ? { inputProfile } : {},              // ora-20260917 题1 步骤4：非默认档才落（默认流零变化）
        clipPolicy !== 'text' ? { clipboardPolicy: clipPolicy } : {}  // 脱敏非默认档标注（蒸馏/取证可感知 policy 元信息）
      ),
      events,
    };
    const body = JSON.stringify(doc, null, 2);
    /* 产物配额准入（V202611030005 B3 N2）：事件流落盘前检查；拒绝=不落半文件，stopAll 输出明确失败原因 */
    const q = require('./quota').check({ file: outFile, bytes: Buffer.byteLength(body), cmd: 'record' });
    if (!q.ok) {
      quotaBlocked = q.message;
      log.error('record', `${q.code}: ${q.message}`);
      console.error(`[record] ✗ 事件流未落盘（${q.code}: ${q.message}）`);
      return 0;
    }
    if (q.message) console.error(`[record] ⚠ ${q.message}`);
    fs.writeFileSync(outFile, body);
    try { require('./audit').setArtifact(outFile); } catch { /* 审计旁路 */ }
    return events.length;
  }
  /** V202609080014 次 bug1 + V202609080015 疑点双保险②：attach 存档的 url/title 会过期——落盘前对每个
      存活 target 用 browser 级 Target.getTargetInfo 现取覆盖；逐 target try/catch，失败重试 1 次后放弃
      （打诊断日志——此前静默吞掉导致根因无法判断），最终还有 navigate 自报 URL 兜底与存档兜底 */
  async function refreshTargetsMeta() {
    for (const [targetId, meta] of [...targetsMeta]) {
      if (!targetStates.has(targetId)) continue; // 已关闭：保留最后已知值
      let done = false;
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try {
          const r = await client.send('Target.getTargetInfo', { targetId }, { timeoutMs: 1500 });
          const ti = r && r.targetInfo;
          if (ti) {
            if (ti.url) meta.url = ti.url;
            if (ti.title) meta.title = ti.title;
          }
          done = true;
        } catch (e) {
          if (attempt === 2) {
            log.warn('record', `getTargetInfo 现取失败（${String(targetId).slice(0, 8)}，重试 1 次仍败）：${e.message}——用 navigate 兜底/存档`);
            console.error(`[record] ⚠ getTargetInfo 现取失败（${String(targetId).slice(0, 8)}，重试 1 次仍败）：${e.message}——用 navigate 兜底/存档`);
          }
        }
      }
    }
  }
  async function flushToDisk() {
    try { await refreshTargetsMeta(); } catch { /* 尽力而为，存档兜底 */ }
    const n = writeDoc();
    if (quotaBlocked) {
      /* 配额拒绝：不留 state 假象、不谎报已落盘——明确告知事件仍在内存但无法写盘 */
      try { fs.unlinkSync(stateFile); } catch { /* 已不在 */ }
      if (lockOn) lock.release();
      console.error(`[record] ✗ 录制已停止，但事件流因配额未落盘（${quotaBlocked}）——数据仍在内存、本进程即将退出；请先 node tools/cdp.js artifacts prune --apply 后重新录制`);
      log.error('record', `事件流未落盘（配额）：${quotaBlocked}（事件 ${events.length} 条）`);
      return 0;
    }
    const nMat = writeMaterials(); // V202609220001：定位素材与事件流同刷（零素材不落文件）
    try { fs.unlinkSync(stateFile); } catch { /* 已不在 */ }
    if (lockOn) lock.release(); // 无锁路径零副作用（V202610200001：默认无互斥）
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    log.info('record', `录制停止（${stopReason}）：${n} 事件 → ${outFile}｜ 类型分布 ${JSON.stringify(byType)}${nMat ? `｜ 素材 ${nMat} 条 → ${paths.locateMaterialsPath(outFile)}` : ''}`);
    console.log(`[record] 已停止（${stopReason}）：${n} 事件 → ${outFile}`);
    if (nMat) console.log(`[record] 定位素材：${nMat} 条 → ${paths.locateMaterialsPath(outFile)}（蒸馏定位③层兜底直接抄作）`);
    console.log(`[record] 类型分布：${JSON.stringify(byType)}｜ 下一步：node tools/cdp.js events-summary <file>`);
    return n;
  }
  async function stopAll(reason) {
    if (stopping) {
      // 2026-09-08 两次丢数据教训：拆除动作可能挂起，此时 SIGTERM 救援必须能确认数据已落盘
      console.log(`[record] 停止流程已在进行（事件已落盘：${outFile}）——如文件不存在请立即告知`);
      return;
    }
    stopping = true;
    stopReason = reason;
    clearInterval(heartbeat); // 仅 --lock 时有 timer；无锁路径 heartbeat=null（clearInterval(null) 无害）
    clearInterval(capTimer);
    // ⓪ 录屏兜底先停并终写各 index（V202609090002：必须在拆 WS 之前；逐路 try/catch fail-soft——
    //    flushToDisk 落盘头要引用最终帧计数，故排在首刷之前）
    if (flags.video) {
      for (const st of [...targetStates.values()]) {
        if (!st.screencast) continue;
        try { await st.screencast.stop(); } catch { /* 尽力而为 */ }
      }
      const videoDir = path.join(paths.VIDEO_DIR, session);
      console.log(`[record] 录屏已停止：${videoFramesTotal} 帧 → ${videoDir}`);
      log.info('record', `录屏已停止：${videoFramesTotal} 帧（dir=${videoDir}）`);
    }
    // ① 先落盘（同步写，零挂起风险）——事件只在内存里，落盘优先于一切拆除动作（2026-09-08 教训：拆除挂起 = 数据全丢）。
    //    落盘前先现取存活 target 的 url/title（V202609080014 次 bug1：attach 存档过期，逐 target 1.5s 超时兜底存档）。
    //    ⚠ 此阶段不拆事件监听：binding 成为首选通道后，二次补尾的尾部事件经 bindingCalled 回程，
    //    依赖监听器存活（offEvent 移至二次补尾之后、拆除之前——V202609080014）
    const firstCount = await flushToDisk();
    const nMatFirst = materials.length; // V202609220001：首刷素材基线（补尾增量可见性）
    // ② 可选二次补尾（增强项）：对仍存活 target 逐个触发页面侧 flush()，等 300ms 让尾部 ≤200ms 队列
    //    经 binding/sendBeacon 双通道入管道后覆写落盘。flushToDisk 同步廉价，双写不违"先落盘后拆除"铁律；
    //    任何异常吞掉——首刷数据已安全。
    try {
      let pinged = false;
      for (const st of [...targetStates.values()]) {
        if (st.error) continue;
        try { await core.evaluate(client, st.sessionId, 'window.__chromeuseRecorder && window.__chromeuseRecorder.flush()', 1000); pinged = true; } catch { /* 停止时不纠结 */ }
      }
      if (pinged) {
        await sleep(300);
        const n2 = writeDoc();
        const nMat2 = writeMaterials(); // V202609220001：补尾素材全量覆写收尾（幂等）
        if (n2 !== firstCount) console.log(`[record] 二次补尾：+${n2 - firstCount} 事件已覆写落盘`);
        if (nMat2 && nMat2 !== nMatFirst) console.log(`[record] 二次补尾：素材 ${nMat2} 条已覆写落盘`);
      }
    } catch { /* 尽力而为——首刷数据已安全 */ }
    offEvent();
    // ③ O(1) 拆除（WS 断开浏览器自动回收全部 session；不逐 session ping——N×1s 人为挂起风险）
    try { await collector.stop(); } catch (e) { log.warn('record', `collector.stop 异常（已忽略，数据已落盘）：${e.message}`); console.error('[record] collector.stop 异常（已忽略，数据已落盘）'); }
    try { await client.close(); } catch { /* 已落盘 */ }
    process.exit(0);
  }
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  const dur = num(flags.duration, 0);
  if (dur > 0) setTimeout(() => stopAll('duration'), dur);
  return new Promise(() => { /* 常驻至停止信号 */ });
}

/** record-stop：跨进程触发优雅停止（POST /__stop） */
async function stop(flags) {
  const stateFile = path.join(paths.EVENTS_DIR, '.record-state.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { console.error('✗ 未发现运行中的 record（无状态文件 tmpdata/events/.record-state.json）'); return 1; }
  try {
    const res = await fetch(`http://127.0.0.1:${st.port}/__stop`, { method: 'POST', body: 'stop', signal: AbortSignal.timeout(5000) });
    console.log(`[record-stop] 已通知 pid=${st.pid}（HTTP ${res.status}），等待落盘…`);
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (!fs.existsSync(stateFile)) { console.log(`[record-stop] ✓ 录制已停止并落盘：${st.out}`); return 0; }
    }
    console.error('[record-stop] ⚠ 通知已发但状态文件未消失（录制进程可能僵死，检查 pid）');
    log.warn('record-stop', `通知已发但状态文件未消失（pid=${st.pid} 可能僵死）`);
    return 1;
  } catch (e) {
    console.error(`✗ record-stop 失败：${e.message}（录制进程 pid=${st.pid} 可能已退出；可删除状态文件后重试）`);
    log.error('record-stop', `停止通知失败（pid=${st?.pid}）：${e.message}`, e);
    return 1;
  }
}

module.exports = { record, stop, makeInitScript, beaconBaseFor, ghostDetach: ghostDetachFn, resolveInputProfile, resolveClipboardPolicy, locateAccept: locateAcceptFn, locateEnvelope: locateEnvelopeFn };
