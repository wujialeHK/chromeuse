'use strict';
/*
 * chromeuse lib/events.js —— 事件流确定性预处理（events-summary）+ DevTools Recorder 转换器（recorder-convert）
 *
 * 分工按架构 v3 裁定：本文件只做层 1 确定性规则（噪声过滤 / IME 折叠 / 类型分布统计 / T2 格式转换），
 * 深度语义化（业务意图、步骤命名）归 LLM 蒸馏（references/distill.md），不写进预处理。
 * 事件流格式 = 附录 A2（chromeuse-events/1）。
 */
const fs = require('node:fs');
const path = require('node:path');


function load(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || doc.format !== 'chromeuse-events/1' || !Array.isArray(doc.events)) {
    throw new Error(`非 chromeuse-events/1 事件流：${file}`);
  }
  return doc;
}
/* 折叠/突发归组键：tab 维度必带（V202609080013 多 target）——跨 tab 的同 frame 同目标不得互相折叠；
   缺 tab 字段回退 ''（兼容旧事件流，格式版本号不 bump，chromeuse-events/1 不变） */
const tgtKey = (e) => `${e.tab || ''}|${e.frame}|${(e.target && (e.target.id || e.target.text || e.target.tag)) || ''}`;

/** 确定性预处理：噪声过滤（scroll 突发留首尾）+ IME 折叠（同目标 300ms 连续 input 留末值） */
function preprocess(events) {
  const dropped = { scrollBurst: 0, imeFold: 0 };
  const out = [];
  let lastScroll = null; // {tab, frame, t}
  for (const e of events) {
    if (e.type === 'scroll') {
      if (lastScroll && lastScroll.frame === e.frame && lastScroll.tab === (e.tab || '') && e.t - lastScroll.t < 1000) {
        // 突发中段丢弃：回填——保留首项并标记末项
        if (lastScroll.keptFirst) { out.push(e); lastScroll.keptFirst = false; dropped.scrollBurst++; continue; }
        dropped.scrollBurst++;
        lastScroll.t = e.t; // 末项延后：下一轮窗口判断用
        continue;
      }
      lastScroll = { tab: e.tab || '', frame: e.frame, t: e.t, keptFirst: true };
      out.push(e);
      continue;
    }
    // IME 折叠：连续 input（非 ime 终值）同目标 300ms 内 → 保留最后一个
    if (e.type === 'input') {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev && prev.type === 'input' && !prev.ime && tgtKey(prev) === tgtKey(e) && e.t - prev.t < 300) {
        out[out.length - 1] = e; dropped.imeFold++;
        continue;
      }
    }
    out.push(e);
  }
  return { events: out, dropped };
}

/** events-summary 子命令：预处理 + drag 聚合 + 类型/帧分布 + 高频目标 */
function summary(file, flags) {
  const doc = load(file);
  const { events: preEvents, dropped } = preprocess(doc.events);
  const { events, drags } = aggregateDrags(preEvents); // 标记驱动聚合（V202609170002）——蒸馏管线的确定性一步
  const byType = {}, byFrame = {};
  const clickTargets = new Map();
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byFrame[e.frame || '?'] = (byFrame[e.frame || '?'] || 0) + 1;
    if (e.type === 'click' || e.type === 'dblclick') {
      const k = `${e.frame}｜<${e.target && e.target.tag}> ${(e.target && e.target.text || '').slice(0, 24)}`;
      clickTargets.set(k, (clickTargets.get(k) || 0) + 1);
    }
  }
  console.log(`[events-summary] ${path.basename(file)}：原始 ${doc.events.length} → 处理后 ${events.length} 事件（scroll 突发弃 ${dropped.scrollBurst}，IME 折叠 ${dropped.imeFold}，drag 聚合 ${drags} 段）`);
  console.log(`  类型分布：${JSON.stringify(byType)}`);
  console.log(`  帧分布：${Object.entries(byFrame).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const top = [...clickTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) console.log('  高频点击目标（前 8）：');
  for (const [k, v] of top) console.log(`    ${v}× ${k}`);
  if (drags > 0) console.log(`  drag 聚合 ${drags} 段：合成 drag 事件带 from/to（point+target 描述符）/path 轨迹/types——蒸馏按 references/distill.md 映射 flow drag 步骤`);
  console.log('  下一步：LLM 蒸馏协议（references/distill.md）——业务意图确认/凭据脱敏复核/人机确认环节后入库。');
  if (flags.out) {
    fs.writeFileSync(flags.out, JSON.stringify({ format: 'chromeuse-events/1', session: doc.session, events, preprocess: Object.assign({}, dropped, { dragAggregated: drags }) }, null, 2));
    console.log(`  归一化输出：${flags.out}`);
  }
  return 0;
}

/* ── recorder-convert：DevTools Recorder 导出 JSON → flow 草案（T2 兜底） ── */
function selectorToTarget(selectors) {
  // DevTools 导出 selectors 为「数组的数组」（每个内数组是同一步的备选定位器），拍平后取最优
  const flat = [].concat(...(selectors || []).map((s) => (Array.isArray(s) ? s : [s])));
  for (const s of flat) {
    if (typeof s === 'string' && s.startsWith('text/')) return { target: { text: s.slice(5) }, via: 'text' };
    if (typeof s === 'string' && s.startsWith('aria/')) return { target: { text: s.slice(5) }, via: 'aria(文本近似)' };
    if (typeof s === 'string' && s.startsWith('xpath/')) return { target: { text: `//文本近似:${s.slice(6).slice(-30)}` }, via: 'xpath(不可靠)' };
  }
  return { target: null, via: flat.join(',') || '无' };
}
function convert(file, flags) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const warnings = [];
  const flowSteps = [];
  let lastFrame = 'main';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const at = `steps[${i}](${s.type})`;
    // frame 目标切换 → frame 步骤
    const t = typeof s.target === 'string' ? s.target : 'main';
    if (t && t !== 'main' && t !== lastFrame) { flowSteps.push({ action: 'frame', path: [t], desc: `[T2] 切换 frame（DevTools target=${t}）` }); lastFrame = t; }
    else if (t === 'main' && lastFrame !== 'main') { flowSteps.push({ action: 'frame', path: ['main'], desc: '[T2] 回主文档' }); lastFrame = 'main'; }
    switch (s.type) {
      case 'navigate':
        if (s.url) flowSteps.push({ action: 'goto', url: String(s.url), desc: '[T2] navigate' });
        else warnings.push(`${at} navigate 缺 url`);
        break;
      case 'click': {
        const m = selectorToTarget(s.selectors);
        if (m.target) flowSteps.push({ action: 'click', target: m.target, desc: `[T2:${m.via}] click` });
        else warnings.push(`${at} 无法映射 selectors=${m.via}（补 point 坐标或手写 target）`);
        break;
      }
      case 'change': {
        const m = selectorToTarget(s.selectors);
        if (m.target) flowSteps.push({ action: 'type', target: m.target, text: String(s.value === undefined ? '' : s.value), desc: `[T2:${m.via}] change→type` });
        else warnings.push(`${at} 无法映射 selectors=${m.via}`);
        break;
      }
      case 'keydown': case 'keyPress': case 'keyup':
        flowSteps.push({ action: 'key', key: String(s.value || s.key || 'Enter'), desc: '[T2] keydown' });
        break;
      case 'waitForNavigation': case 'navigation':
        flowSteps.push({ action: 'wait', ms: 1500, desc: '[T2] waitForNavigation→固定等待（建议手改为 wait text）' });
        break;
      case 'waitForElement': {
        const m = selectorToTarget(s.selectors);
        if (m.target && m.target.text) flowSteps.push({ action: 'wait', text: m.target.text, desc: '[T2] waitForElement→wait text' });
        else warnings.push(`${at} waitForElement 无法取文本（selectors=${m.via}）`);
        break;
      }
      default:
        warnings.push(`${at} 未支持类型（跳过）：${JSON.stringify(s).slice(0, 80)}`);
    }
  }
  const flow = {
    _meta: { format: 'chromeuse-flow/1', app: 'unknown', title: String(raw.title || 'T2 转换草案'), dpr: 1.0, baseKnowledgeVersion: new Date().toISOString().slice(0, 10), scope: 'demo' },
    steps: flowSteps,
  };
  const errs = require('./flow-engine').validateFlow(flow);
  console.log(`[recorder-convert] ${path.basename(file)}：${steps.length} 步 → flow 草案 ${flowSteps.length} 步（schema ${errs.length ? '未过：' + errs[0] : '✓'}）`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log('  提示：T2 是校准夹具/兜底——草案须经人工核对 target 描述符（尤其 frame 路径与 exact 匹配）再入库。');
  if (flags.out) {
    fs.writeFileSync(flags.out, JSON.stringify(flow, null, 2) + '\n');
    console.log(`  flow 草案：${flags.out}`);
  } else {
    console.log(JSON.stringify(flow, null, 2));
  }
  return errs.length ? 1 : 0;
}

/* ── drag 聚合（V202609170002，标记驱动基础版）──
 * 强信号 = V202609130007 已落流的 dragstart/drop 标记（librarian 定论：真 dragstart 出现 = 真拖动）。
 * 元规则：事件标记 > 阈值——双标记齐即聚合；DRAG_MIN_DISP_PX 只滤轨迹抖动噪声，不否决聚合
 *（精细标定留【drag 阈值标定】条目：积累 ≥5 段真实拖动演示后离线标定）。
 * 配对规则：同 tab 内 dragstart 与其后首个 drop 配对；区间起点 = 此前最近的 button:0 mousedown。
 * 区间内 mousedown/mousemove/mouseup/dragstart/drop 折叠为一条合成 drag 事件（type:'drag'，蒸馏 1:1
 * 映射 flow drag 步骤：from/to 各带 point+target 描述符），同区间其他类型事件原位保留。
 * 无标记不猜（红线）：缺 dragstart 或 drop 任一标记整段原样保留——纯轨迹推断聚合不做；
 * dragstart 有而 drop 无（取消拖拽）同样不聚合（v1 边界，事件先落流不丢）。
 * 跨 tab 隔离：上下文按 tab 记账（tab 键缺省归 ''）；同 tab 跨 frame 允许配对（原生拖拽可跨 iframe 边界，
 * recorder 按 frame 独立实例发射——dragstart/drop 的 docId 可能不同，故配对只锁 tab 不锁 docId）。 */
const DRAG_MIN_DISP_PX = 6;
const DRAG_MOUSE_TYPES = ['mousedown', 'mousemove', 'mouseup', 'dragstart', 'drop'];
const dist2 = (a, b) => ((a.x - b.x) * (a.x - b.x)) + ((a.y - b.y) * (a.y - b.y));
/** 事件坐标取值：descriptor.point（clientX/Y CSS px，recorder 鼠标类事件恒带）；无 point 返回 null */
function dragPointOf(e) {
  const p = e && e.target && e.target.point;
  return (p && Number.isFinite(p.x) && Number.isFinite(p.y)) ? p : null;
}
/** 纯函数（selftest #49 直测）：聚合 dragstart→drop 标记区间为合成 drag 事件。
 *  返回 { events: 聚合后事件数组, drags: 聚合段数 }；输入不做原地修改。 */
function aggregateDrags(events) {
  const out = [];
  let drags = 0;
  const ctx = new Map(); // tab → { pressIdx: out 内最近 button:0 mousedown 下标, drag: 待配对 dragstart 事件|null }
  for (const e of events) {
    const tab = e.tab || '';
    const c = ctx.get(tab) || {};
    if (e.type === 'mousedown') {
      c.pressIdx = e.button === 0 ? out.length : c.pressIdx; // 右键/中键按压不构成拖源锚点
      c.drag = null; // 新按压重置待配对（一次按压至多一次拖拽）
      out.push(e);
    } else if (e.type === 'dragstart') {
      c.drag = e; // 强信号：待 drop 配对
      out.push(e);
    } else if (e.type === 'drop' && c.drag && c.pressIdx !== undefined) {
      // 双标记齐 + 按压锚点在 → 聚合。seg = out 中自按压锚点起的同 tab 区间
      const seg = out.slice(c.pressIdx).filter((x) => (x.tab || '') === tab);
      const mouseEv = seg.filter((x) => DRAG_MOUSE_TYPES.includes(x.type));
      const press = mouseEv.find((x) => x.type === 'mousedown');
      const startEv = c.drag;
      const fromPt = (press && dragPointOf(press)) || dragPointOf(startEv) || { x: 0, y: 0 };
      const toPt = dragPointOf(e) || fromPt;
      // 轨迹：按压起点恒保留；move 点距上一保留点 ≥DRAG_MIN_DISP_PX 才入 path（抖动滤除）；
      // dragstart 点恒作终锚（与末保留点重合则不重复）——drop 点不入 path（它就是 to）
      const path = [{ x: fromPt.x, y: fromPt.y }];
      for (const m of mouseEv) {
        if (m.type !== 'mousemove') continue;
        const p = dragPointOf(m);
        if (!p) continue;
        if (dist2(p, path[path.length - 1]) >= DRAG_MIN_DISP_PX * DRAG_MIN_DISP_PX) path.push({ x: p.x, y: p.y });
      }
      const dsPt = dragPointOf(startEv);
      if (dsPt && dist2(dsPt, path[path.length - 1]) >= 1) path.push({ x: dsPt.x, y: dsPt.y });
      const drag = {
        seq: e.seq, t: e.t, type: 'drag', frame: e.frame, docId: e.docId, tab: e.tab, targetId: e.targetId, session: e.session,
        from: { point: { x: fromPt.x, y: fromPt.y }, target: (press && press.target) || startEv.target },
        to: { point: { x: toPt.x, y: toPt.y }, target: e.target },
        path,
        types: startEv.types || [],   // dragstart 的 DataTransfer types（types-only 红线，无数据）
        dropTypes: e.types || [],
        dispPx: Math.round(Math.sqrt(dist2(fromPt, toPt))), // 总位移（【drag 阈值标定】标定原料）
        aggregated: true, // 合成事件标记（区别于页面真实事件——蒸馏侧可溯源到原始标记区间）
      };
      // 原位替换：删同 tab 区间内鼠标序列事件（其余类型原位保留），合成 drag 落锚点处
      const keep = seg.filter((x) => !DRAG_MOUSE_TYPES.includes(x.type));
      out.length = c.pressIdx;
      for (const k of keep) out.push(k);
      out.push(drag);
      drags++;
      c.drag = null; c.pressIdx = undefined;
    } else if (e.type === 'drop') {
      c.drag = null; // 孤儿 drop（无待配对 dragstart 或缺按压锚点）：不猜，原样保留
      out.push(e);
    } else {
      out.push(e);
    }
    ctx.set(tab, c);
  }
  return { events: out, drags };
}

module.exports = { summary, convert, preprocess, aggregateDrags };
