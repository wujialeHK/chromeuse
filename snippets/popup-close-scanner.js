// ─────────────────────────────────────────────────────────────────────────────
// popup-close-scanner.js — 营销弹窗/遮罩「关闭按钮（×）」定位扫描器 v1
// ─────────────────────────────────────────────────────────────────────────────
// 用途：现代电商/营销页面（淘宝/京东等）的弹窗关闭按钮常为「纯视觉 div」——
//       a11y 快照无节点、class 关键词易被同类淹没、截图目测坐标必偏。
//       本脚本（只读）通过「锚点文本 → 弹窗容器 → 右上角 elementFromPoint 网格扫描」
//       输出候选可点击元素清单（含精确 center 坐标），供 click_at 使用。
//
// 实测校准：2026-10-09 淘宝 PC 首页营销弹窗 688×484；关闭钮 DIV 40×40；
//           网格扫描命中 3 点（步长 12）；目测坐标偏差 64px 落空、网格法精确命中。
//
// 使用方式（三步）：
//   1. 填参：ANCHOR = 弹窗内唯一文本（按钮/标题，如「去抢购」）；
//      容器尺寸带默认 400~1100 × ≥250（窄弹窗调小 W_MIN）。
//   2. 调用（只读，waitForStableDom:false）：
//        chrome-devtools evaluate_script { function: "<本文件主脚本全文>", waitForStableDom: false }
//      看返回 suggestedClick：应为带 close 类名、hitCount≥2、40px 级尺寸的候选，
//      其 center 即关闭按钮中心。候选存疑时按 score/inContainer 人工挑，
//      或调大 REGION_W/REGION_H、EDGE=0 重跑；CONTAINER_NOT_FOUND 则调尺寸带或换锚点。
//   3. 点击 + 验证（点击必走真实鼠标工具，禁止合成事件）：
//        click_at(center[0], center[1])
//      点击后复跑主脚本——报 ANCHOR_NOT_FOUND 即已关闭；或用下方验证探针——
//      rect 归零(0×0) 或元素消失 = 成功。仍在 = 失败：查点击点是否被透明层拦截/
//      事件绑在父级，重测 rect 重点一次（≤1 轮），仍失败留证上报。
//
// 机制备注（chrome-devtools-mcp 1.10.1 源码核实）：
//   - 默认 take_snapshot 按 interestingOnly 过滤「无名称无描述叶子」，纯视觉关闭 div
//     因此在 a11y 树缺失；verbose:true 不过滤（本案例未实测，待补）。
//   - evaluate_script 的 args 传 uid 时，单 frame 场景执行上下文自动切到元素所在
//     iframe —— 跨 iframe 弹窗可复用本脚本思路。
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════ 主脚本（evaluate_script 用） ═══════════════════════════
() => {
  // ── 弹窗关闭按钮·网格扫描器 v1（只读探查；点击另走 click_at / click(uid)）──
  const ANCHOR = '去抢购';                        // 弹窗内唯一文本（按钮/标题均可）
  const W_MIN = 400, W_MAX = 1100, H_MIN = 250;   // 弹窗容器尺寸带（px）
  const REGION_W = 120, REGION_H = 96, STEP = 12, EDGE = 3; // 扫描区=容器右上角向左120×向下96，步长12

  const vis = el => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' &&
           parseFloat(cs.opacity) > 0.05 && el.getBoundingClientRect().width > 1;
  };
  const desc = el => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      center: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
      z: parseInt(cs.zIndex) || 0, pos: cs.position,
      aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',
      txt: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 20)
    };
  };

  // ① 锚点 → 弹窗容器（从锚点向上第一个满足尺寸带者；跳过全屏遮罩/根容器）
  const norm = s => (s || '').replace(/\s+/g, '');
  const anchors = [...document.querySelectorAll('button, a, span, div')]
    .filter(el => norm(el.textContent) === norm(ANCHOR))
    .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  const anchor = anchors.find(vis);
  if (!anchor) return { error: 'ANCHOR_NOT_FOUND', anchor: ANCHOR };

  let container = null, cur = anchor;
  for (let i = 0; cur && cur !== document.body && i < 25; i++, cur = cur.parentElement) {
    const r = cur.getBoundingClientRect();
    if (r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98) continue;  // 全屏层
    if (r.width >= W_MIN && r.width <= W_MAX && r.height >= H_MIN &&
        r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) { container = cur; break; }
  }
  if (!container) return { error: 'CONTAINER_NOT_FOUND', anchor: ANCHOR };
  let cr = container.getBoundingClientRect();
  if (cr.top < 0 || cr.left < 0 || cr.bottom > innerHeight || cr.right > innerWidth) {
    container.scrollIntoView({ block: 'center', inline: 'center' });  // 滚动定位（只读许可）
    cr = container.getBoundingClientRect();
  }

  // ② 右上角 elementFromPoint 网格扫描 → 按元素聚合去重
  const map = new Map();
  for (let x = Math.round(cr.right) - EDGE; x >= cr.right - EDGE - REGION_W; x -= STEP) {
    for (let y = Math.round(cr.top) + EDGE; y <= cr.top + EDGE + REGION_H; y += STEP) {
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      if (!map.has(el)) map.set(el, { ...desc(el), hits: [] });
      map.get(el).hits.push([x, y]);
    }
  }

  // ③ 候选清单：排除容器自身与大面积层（遮罩/内容块）；按 命中点数+class信号 排序
  const candidates = [];
  for (const [el, v] of map) {
    if (el === container) continue;
    if (v.rect[2] >= cr.width * 0.5 || v.rect[3] >= cr.height * 0.5) continue;
    candidates.push({
      ...v,
      hitCount: v.hits.length,
      inContainer: container.contains(el),
      score: v.hits.length + (/close|dismiss|关闭/i.test(v.cls) ? 2 : 0) + (v.rect[2] <= 80 && v.rect[3] <= 80 ? 1 : 0)
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  return {
    viewport: [innerWidth, innerHeight],
    container: desc(container),
    scanRegion: [Math.round(cr.right) - EDGE - REGION_W, Math.round(cr.top) + EDGE, REGION_W, REGION_H],
    suggestedClick: candidates.length ? { cls: candidates[0].cls, center: candidates[0].center, hitCount: candidates[0].hitCount } : null,
    candidates   // 全量不截断：cls / rect / center / hits(命中点) 供 click_at
  };
}

// ═══════════════════════════ 点击后验证探针（evaluate_script 用） ═══════════════════════════
// SEL 换成点击前 top 候选 cls 的稳定片段（如 closeBtn__333f3756 或 closeBtn）
() => {
  const el = document.querySelector('[class*="closeBtn"]');
  const r = el ? el.getBoundingClientRect() : null;
  return { gone: !el, rect: r ? [Math.round(r.width), Math.round(r.height)] : null,
           closed: !el || (r.width === 0 && r.height === 0) };
}
