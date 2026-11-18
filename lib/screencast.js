'use strict';
/*
 * chromeuse lib/screencast.js —— CDP Page.startScreencast 页面录屏兜底（V202609090002，oracle 修订定稿；V202609090003 首弹故障修复）
 *
 * 裁定（用户裁定「-v 显式开启制」）：默认关——录制/回放默认纯事件+输入监听、零新增 CDP 命令；
 * 仅 -v（--video）时由调用方（lib/record.js 每 target 一路 / flow replay 对目标 tab 一路）启动本模块。
 * 页侧 tools/recorder.js 一行不碰（录屏完全在 Node 侧 CDP 会话内，零注入零侵入——本方案核心优势）。
 *
 * 协议要点（Chrome 151 实际协议，已按该版本核对）：
 * - Page.startScreencast({ maxWidth, everyNthFrame, format: 'jpeg', quality }) → 帧经 Page.screencastFrame
 *   事件到达（须先 Page.enable 才收 Page 域事件——record 路径 setupTarget 链已 enable，这里幂等再发一次，
 *   flow replay 路径可能从未 enable）；
 * - 帧率 v1（oracle-20260917 题2）：everyNthFrame 参数化（--every-nth，默认 6 = 每 N 个合成器帧取 1 ≈
 *   上限 10fps——相对抽取、vsync 基准漂移故为约数；1 = 旧全速收帧行为，30 封顶护栏）。
 *   ⚠ 默认值变化是行为变化：全速 1 → 6 意味着录制产物帧数下降（重动画场景峰值帧量约砍 6 倍），
 *   diff-video/evidence-pack 消费侧事后按 index.json 取帧、与采集率解耦不受影响（分析已证）。
 *   v1 边界：只参数化抽取率；每帧立即 ack 原样不动，trailing ack 两档制（巡航/事件升档）归 v2 不做；
 * - ⚠ 字段名陷阱：Page.screencastFrameAck 的参数名叫 `sessionId`，但语义 = 帧序列号（int，来自
 *   Page.screencastFrame 事件的 params.sessionId），与 flatten 多路复用的会话 sessionId（字符串）**撞名**——
 *   两者不能混淆：命令按 flatten 会话下发（opts.sessionId），参数里放帧序列号（params.sessionId）；
 * - **每帧立即 ack（V202609090003 故障 A 修复，Puppeteer ScreencastSession 同款）**：ack 是 ~40B WS 文本帧
 *   （帧本身几十 KB jpeg），帧率天然受合成器门控（仅可见变化时产帧），不存在 ack 洪泛。
 *   ⚠ 死锁根因（首弹实录 9 帧/7s 后断流）：「ack 节流跳过 × 仅帧到达时才检查 ack」= 一旦最后一帧落在
 *   节流窗内未 ack，Chrome 停发后续帧 → onEvent 不再触发 → 永远等不到下一个 ack 时机——结构性死锁。
 *   intervalMs 参数保留但 unused（签名兼容 --video-interval 旗标，预留 trailing ack 模式）；
 * - metadata.timestamp 是 CDP 时间戳（秒，浮点）——与 Node 侧 Date.now()（毫秒）不同钟，故每帧记
 *   { tArrive: Date.now(), tMeta: metadata.timestamp } 双时钟，对照基准统一用 tArrive（毫秒，与事件流
 *   tRecv/t 同钟）。
 *
 * 多 target index（V202609090003 故障 B 修复）：模块级 session 注册表（videoDir → 共享 frames 数组）——
 * 每 target 一路 screencast 实例共享同一 frames 累积（帧对象自带 tab 字段），flushIndex 按 tArrive 排序
 * 序列化共享数组、header 取首个 starter 值；实例级仅 frameNo（文件名在各自 frames/<tab>/ 无冲突）。
 * 此前实例级数组各自全量覆写同一 index.json → stopAll 按 Map 插入序停录，tab-2（1 帧）覆盖 tab-1（9 帧）。
 *
 * fail-soft 纪律：本模块全部 fs/CDP 异常吞掉打日志——录屏失败绝不拖垮录制/回放主流程。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const time = require('./time');

/** tab 名清洗（frames/<tab>/ 路径段；tab-N 别名天然安全，防御性保留） */
function safeSeg(s) {
  return String(s || 'tab-?').replace(/[^\w.-]/g, '_').slice(0, 60) || 'tab-?';
}

/** 抽帧参数解析（纯函数导出，selftest 直测；oracle-20260917 题2 帧率 v1）：everyNthFrame 默认 6
 *  ≈ 上限 10fps（合成器 fps/N 的相对抽取，vsync 基准漂移故为约数）；非法/越界回退默认；
 *  下限 1（=旧全速收帧行为仍可达）、上限 30 护栏（防误传超大值抽成幻灯片） */
function resolveEveryNth(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return 6;
  return Math.min(n, 30);
}

/** 模块级 session 注册表（V202609090003 故障 B）：videoDir → { frames: [], header }——多 target 实例共享 */
const sessions = new Map();

/**
 * 启动一路录屏。
 * @param {object} opts { client, sessionId, tab, videoDir, session, intervalMs=1000(unused 占位), maxWidth=960, quality=60, everyNthFrame=6(帧率 v1：抽帧率，1=旧全速), onFrame? }
 * @returns {{ stop: () => Promise<void>, count: () => number }} stop 幂等（重复调用直接返回）
 */
async function start(opts) {
  const client = opts.client;
  const sessionId = opts.sessionId;
  const tab = safeSeg(opts.tab);
  const videoDir = opts.videoDir;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 1000; // 兼容占位：预留 trailing ack 模式（当前每帧立即 ack，unused）
  const maxWidth = Number.isFinite(opts.maxWidth) && opts.maxWidth > 0 ? opts.maxWidth : 960;
  const quality = Number.isFinite(opts.quality) && opts.quality > 0 ? opts.quality : 60;
  const everyNthFrame = resolveEveryNth(opts.everyNthFrame); // 帧率 v1：参数化抽取率（默认 6；解析/护栏单源 resolveEveryNth；ack 策略不动）
  const framesDir = path.join(videoDir, 'frames', tab);
  const indexPath = path.join(videoDir, 'index.json');
  fs.mkdirSync(framesDir, { recursive: true });

  // 故障 B：get-or-create 共享态——frames 数组跨实例共享（帧对象自带 tab），header 取首个 starter
  let sh = sessions.get(videoDir);
  // index.json 头 startedAt = 显示字段（配置时区 lib/time.js，默认 UTC+8）；帧双时钟 tArrive/tMeta 是数据字段不动
  const startedAt = time.isoLocal();
  const config = { format: 'jpeg', maxWidth, quality, intervalMs, everyNthFrame };
  if (!sh) {
    sh = { frames: [], header: { session: opts.session || '', config, startedAt } };
    sessions.set(videoDir, sh);
  }
  const sharedFrames = sh.frames;

  let frameNo = 0;              // 帧号（NNNNNN.jpg 递增；实例私有——文件名在各自 frames/<tab>/ 无冲突）
  let lastFlushAt = 0;          // index 覆写节流（实例级节流、写共享态）
  let stopped = false;

  function flushIndex() {
    lastFlushAt = Date.now();
    try {
      const list = sharedFrames.slice().sort((a, b) => (a.tArrive || 0) - (b.tArrive || 0)); // 排序保证落盘确定性
      fs.writeFileSync(indexPath, JSON.stringify({
        format: 'chromeuse-video/1',
        session: sh.header.session,
        config: sh.header.config,
        startedAt: sh.header.startedAt,
        frames: list,
      }, null, 2));
      log.info('screencast', `${tab} index.json 覆写（共享帧总数 ${list.length}）`);
    } catch (e) { log.warn('screencast', `${tab} index.json 覆写失败（fail-soft）：${e.message}`); }
  }

  const onEvent = ({ sessionId: sid, method, params }) => {
    if (stopped || sid !== sessionId || method !== 'Page.screencastFrame' || !params || !params.data) return;
    frameNo++;
    const file = path.join(framesDir, String(frameNo).padStart(6, '0') + '.jpg');
    try { fs.writeFileSync(file, Buffer.from(params.data, 'base64')); }
    catch (e) { log.warn('screencast', `${tab} 帧 ${frameNo} 写盘失败（fail-soft）：${e.message}`); }
    // 双时钟：tArrive=Node 接收时刻（毫秒，对照基准）；tMeta=CDP metadata.timestamp（秒，留档不用于对照）
    const rec = { file, tab, tArrive: Date.now(), tMeta: params.metadata ? params.metadata.timestamp : null };
    sharedFrames.push(rec);
    if (typeof opts.onFrame === 'function') { try { opts.onFrame(rec); } catch { /* 统计回调尽力而为 */ } }
    // 故障 A 修复（V202609090003）：每帧立即 ack（Puppeteer 同款）——ack ~40B 文本帧、帧率受合成器门控无洪泛。
    // ⚠ 参数名 sessionId = 帧序列号 int（与 flatten 会话 id 撞名，见文件头）；节流跳过不 ack = 结构性死锁，已废
    if (Number.isFinite(params.sessionId)) {
      client.send('Page.screencastFrameAck', { sessionId: params.sessionId }, { sessionId }).catch(() => { /* fail-soft */ });
    }
    if (Date.now() - lastFlushAt >= 5000) flushIndex(); // ~5s 覆写一次 index（崩溃时最多丢 5s 索引，帧文件本身已落盘）
  };

  const off = client.onEvent(onEvent);
  await client.send('Page.enable', {}, { sessionId }); // Page 域事件（screencastFrame）前置；record 路径已 enable，幂等
  await client.send('Page.startScreencast', { maxWidth, everyNthFrame, format: 'jpeg', quality }, { sessionId });
  log.info('screencast', `${tab} 录屏启动（jpeg q=${quality} maxWidth=${maxWidth} everyNthFrame=${everyNthFrame}≈上限 10fps 级 每帧立即 ack）→ ${framesDir}`);

  async function stop() {
    if (stopped) return; // 幂等（closeTarget 与 stopAll 双路径可能先后调用）
    stopped = true;
    off();
    try { await client.send('Page.stopScreencast', {}, { sessionId }); }
    catch (e) { log.debug('screencast', `${tab} stopScreencast 失败（target 已关/连接已断，忽略）：${e.message}`); }
    flushIndex(); // 终写共享 index（含其他 tab 的帧——故障 B 修复后不再互相覆写）
    log.info('screencast', `${tab} 录屏停止（本路 ${frameNo} 帧；会话共享总数 ${sharedFrames.length}）`);
  }

  return { stop, count: () => frameNo };
}

module.exports = { start, safeSeg, resolveEveryNth };
