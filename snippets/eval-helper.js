// ─────────────────────────────────────────────────────────────────────────────
// eval-helper.js — evaluate 返回值解析 / 条件等待 / 可点元素查找助手 v1.0（编排侧 snippet）
// ─────────────────────────────────────────────────────────────────────────────
// 背景（2026-10-13 护腰坐垫会话复盘 + oracle 复核）：
//   `evaluate_script` 返回的是**包装文本**（"Script ran on page and returned:" +
//   ```json fence，fence 内是「JSON 字符串的 JSON」），会话中 4 次 TypeError 同根因=
//   返回值**全程 0 次程序化解析**——串联使用时 `x[0]` 取到字符串首字符（truthy），
//   空值防御整体失效。本文件把「解析 / 等待 / 查找」固化成可直接粘贴的助手。
//
// 设计原则：
//   ① 一切 evaluate 返回值**先过 unwrapEval** 再判断/取值（fence 剥离 + 双重
//      JSON.parse，失败 null 安全，永不 throw）。
//   ② 等条件用 waitUntil（页面侧探针文本）**替代估算 sleep**；Code Mode 无 timer
//      → 编排侧 for 循环 + Date.now() 判超时，轮间隔用**页面侧探针内 await
//      setTimeout** 实现（evaluate_script 支持 async 函数）。
//   ③ 找元素用 findClickable：**空结果恒返回 items: []**（永不 undefined/null——
//      根治 TypeError 的核心纪律；调用方只判 length，不判存在）。
//   ④ 纯只读探查 + 标准 MCP 工具调用封装，**无合成事件**——点击交给 MCP 原语
//      （click_at / take_snapshot→click），本文件不做 dispatchEvent / el.click()。
//   ⑤ 所有函数 try/catch 兜底、**永不 throw**——助手故障绝不允许打断调用方主流程。
//   ⑥ 与 tab-helper.js 是**各自独立的粘贴单元**（调用方可能只贴其一）——unwrapEval
//      在两文件各有一份副本是**有意冗余**（同款实现）；改动任一处语义请同步另一处
//      （v3 对齐基线 = tab-helper.js 的 unwrapEval）。
//
// 使用方式（编排侧 = 粘贴到 execute / Code Mode 代码块顶部，与 tab-helper 并列可选）：
//   ⭐ chromeuse 惯例（本文件存在的理由）：
//     1) evaluate_script 的返回值**一律先过 unwrapEval** 再做任何判断/取值；严禁对
//        包装文本裸操作（String(r)[0] / r[0] / split 后取下标）——包装文本首段是固定
//        前缀，取下标/切片所得恒 truthy 的垃圾值，空值防御会整体失效。
//     2) 等条件（菜单出现/URL 变化/回复完成）用 waitUntil——轮询到即走，替代 sleep。
//     3) 找可点元素用 findClickable 拿 center（CSS 视口坐标）；判空**只判 items.length**。
//     4) 点击/输入交给 MCP 原语（click / click_at / fill），本文件不代做交互。
//   示例：
//     const f = await findClickable({ pageId: pg, text: "发送" });            // 找元素
//     const r = await waitUntil(pg, "() => JSON.stringify({done: !!document.querySelector('.ok')})");
//     const d = await waitUntil(pg, chatgptDoneProbe, { intervalMs: 1000, timeoutMs: 60000 });
//
// ── find → click → verify 三段模板（复制改写；推进纪律=每步验证是闸门，确认通过才继续）──
//   // ① FIND —— 显式传目标页自己的 pageId（跨步骤勿信任记忆，见 tab-helper 纪律）
//   const f = await findClickable({ pageId: pg, text: "发送" });
//   if (!f.ok || !f.items.length) { /* 没找到：先截图看画面（视觉优先），别瞎猜选择器 */ }
//   const t = f.items[0];                     // 面积最小者优先（按钮 > 大容器）
//   if (!t.inViewport) { /* 视口外/被遮挡：先滚动（scrollIntoView({block:'center'})）再重查，勿硬点 */ }
//   // ② CLICK —— 首选 MCP 原语（坐标=CSS 视口像素；click_at 1.10.1 schema={x,y}）：
//   await tools["chrome-devtools"].click_at({ pageId: pg, x: t.center.x, y: t.center.y });
//   //   或 a11y 路线：take_snapshot 取 uid → click({ pageId: pg, uid })
//   // ③ VERIFY —— 断言「预期变化」而非「点过了」（防假绿）；三类断言示例：
//   //   a. 菜单类（含客服会话面板=面板节点出现）：
//   //      await waitUntil(pg, "() => JSON.stringify({done: !!document.querySelector('.chat-panel')})", { timeoutMs: 8000 });
//   //   b. 导航类（URL 变化）：
//   //      await waitUntil(pg, "() => JSON.stringify({done: location.href.includes('/order')})", { timeoutMs: 15000 });
//   //   c. 输入类（目标输入框获得焦点/值更新）：
//   //      await waitUntil(pg, "() => JSON.stringify({done: document.activeElement === document.querySelector('.input')})");
//   //   失败处理：断言超时 → 截图看画面 + 查遮挡/懒加载；同一目标连续 3 次不同策略
//   //   未果强制止损（SKILL 红线 10）。
//
// 版本注记（v1.0，2026-10-15）：护腰会话复盘批 S1+S2+S6 首版。MCP 行为依据=
//   chrome-devtools-mcp 1.10.1 源码核实（page-id-routing 默认开启——页面级工具缺
//   pageId 直接报错；click_at schema={x,y} 已核对）；chatgptDoneProbe 的选择器按
//   当天已知 DOM 编写，**live 实弹校准记录待首次使用后回填**。
//
// ⚠ 边界：编排侧片段（引用 code mode 的 tools 全局对象），与页面侧脚本形态不同；
//   纯只读探查 + 标准 MCP 求值/交互工具调用，无合成事件（红线一）；
//   所有函数永不 throw；pageId 一律显式传（见版本注记）。
// ─────────────────────────────────────────────────────────────────────────────

const FIND_CLICKABLE_MAX_ITEMS = 200; // findClickable 返回条数上限（按面积升序截尾，防撑爆上下文）

const CHATGPT_STABLE_ROUNDS = 3;      // chatgptDoneProbe 的 text-stable 判定所需连续稳定轮数

// ── chatgptDoneProbe — chatgpt.com 回复「完成」判别探针（页面侧函数文本，配 waitUntil 用）──
// 用途：替代「盲等 sleep 35/45s」——轮询到真完成即走。推荐用法：
//   await waitUntil(pg, chatgptDoneProbe, { intervalMs: 1000, timeoutMs: 60000 });
// 信号（多信号任一命中即 done，对旧版 DOM 兜底；全部找不到返回 {done:false, signals:[]} 不报错）：
//   主信号 "voice-btn"   =「开始语音」按钮回归且可用（aria-label 含 开始语音/语音模式/
//                          start voice/voice mode，或 data-testid=composer-speech-button；
//                          生成期间该位被「停止」占用，完成时回归）
//   辅信号 "text-stable" = 最后一条 assistant 消息文本长度连续 CHATGPT_STABLE_ROUNDS 轮不变
//                          （第 1 轮建立基线、第 2~4 轮确认；需 waitUntil 同页连续轮询；轮间
//                          建议 ≥1s——太密易把 token 流间隙误判为稳定；纯图回复 len=0 时靠主信号）
//   反向闸 generating    = 发现「停止」类按钮（aria-label 含 停止/stop 或
//                          data-testid=stop-button）时抑制一切 done 判定（语音按钮共存误报的保险）
// 返回 JSON：{done, signals:[...], len, generating}——len=当前最后一条回复文本长度（供调用方
//   自行对比/兜底判断）；页面用 window.__cu_cg_len / __cu_cg_stable 暂存（同一页签连续轮询语义）。
// ⚠ 追问/换对话场景建议发送前清零一次别把上一轮稳定态带进来（可选一行 evaluate：
//   window.__cu_cg_len=null; window.__cu_cg_stable=0; 实测如无碍可省）。
const chatgptDoneProbe = `() => {
  const signals = [];
  const out = { done: false, signals: signals, len: 0, generating: false };
  try {
    const stopLike = Array.from(document.querySelectorAll("button")).filter((b) => {
      const a = b.getAttribute("aria-label") || "";
      const t = b.getAttribute("data-testid") || "";
      return /停止|stop/i.test(a) || t === "stop-button" || t === "composer-stop-button";
    });
    out.generating = stopLike.length > 0;
    const voice =
      Array.from(document.querySelectorAll("button[aria-label]")).find((b) =>
        /开始语音|语音模式|start voice|voice mode/i.test(b.getAttribute("aria-label") || "")
      ) || document.querySelector('[data-testid="composer-speech-button"]');
    const voiceUsable = !!voice && !voice.disabled && voice.getAttribute("aria-disabled") !== "true";
    if (voiceUsable) signals.push("voice-btn");
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const last = turns.length ? turns[turns.length - 1] : null;
    const len = last ? (last.innerText || "").length : 0;
    out.len = len;
    const prev = window.__cu_cg_len;
    const cnt = typeof prev === "number" && prev === len && len > 0 ? (window.__cu_cg_stable || 0) + 1 : 0;
    window.__cu_cg_len = len;
    window.__cu_cg_stable = cnt;
    if (cnt >= ${CHATGPT_STABLE_ROUNDS}) signals.push("text-stable");
    out.done = !out.generating && signals.length > 0;
  } catch (e) {
    return JSON.stringify({ done: false, signals: [], error: String((e && e.message) || e) });
  }
  return JSON.stringify(out);
}`;

// ── unwrapEval(text) — evaluate_script 包装文本 → 值（剥 ```json fence + 双重 JSON.parse，null 安全）──
// 与 tab-helper.js v3 的 unwrapEval 同款实现（两处各一份副本=有意冗余，见文件头⑥）。
// 双重 parse 解释：fence 内先是一层 JSON 编码（evaluate_script 对页面返回值的再序列化），
// parse 一次得字符串，再 parse 一次才是页面真实返回值（对象/数字）——只 parse 一次会拿到
// "{\"a\":1}" 这样的字符串，正是 x[0] 事故的温床。任何失败返回 null，永不 throw。
function unwrapEval(text) {
  const s = String(text);
  let body = s;
  const m = s.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (m) body = m[1].trim();
  try {
    let v = JSON.parse(body);
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { /* keep string */ } }
    return v;
  } catch (e) { return null; }
}

// ── probeHit(v) — waitUntil 命中判定（对 unwrapEval 后的值；也可单独复用）──
// 规则：null/undefined/false → 否；对象 → 看 .done / .ok 字段（truthy 即命中；两字段皆无
// 的对象按 truthy 处理）；其余值按 truthy。注意 {done:false} **不算**命中——chatgptDoneProbe
// 等探针的「继续轮询」语义依赖此条。
function probeHit(v) {
  if (v == null || v === false) return false;
  if (typeof v === "object") {
    if ("done" in v) return !!v.done;
    if ("ok" in v) return !!v.ok;
    return true;
  }
  return !!v;
}

// ── waitUntil(pageId, probeFn, {timeoutMs=15000, intervalMs=400}) → {ok, value?, error?, elapsedMs, rounds} ──
// 轮询执行页面侧探针文本 probeFn（`() => JSON 可序列化值`；支持 async 函数）直到命中：
//   const r = await waitUntil(pg, '() => JSON.stringify({done: !!document.querySelector(".x")})');
// 命中判定=unwrapEval(evaluate 返回值) 过 probeHit（true / {done:true} / {ok:true} / truthy）。
// ⚠ Code Mode 无 timer——轮间隔=本函数对第 2 轮起**自动向探针注入页面侧 await setTimeout
//   (intervalMs)**（第 1 轮立即执行）+ 网络往返天然耗时，总间隔≈intervalMs+往返；若 probeFn
//   自身已含长延迟请把 intervalMs 设 0 避免叠付；intervalMs 应 ≤ timeoutMs（页面侧等待期间
//   无法中断，超时只能在轮与轮之间生效）。
// 返回：命中 {ok:true, value, elapsedMs, rounds}；超时 {ok:false, elapsedMs, rounds}（无 error
//   字段）；evaluate 抛错（页面消失等）{ok:false, error, elapsedMs, rounds}。永不 throw。
async function waitUntil(pageId, probeFn, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
  const intervalMs = opts.intervalMs == null ? 400 : Math.max(0, Number(opts.intervalMs) || 0);
  const t0 = Date.now();
  let rounds = 0;
  try {
    for (;;) {
      if (Date.now() - t0 >= timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, rounds };
      rounds++;
      const delayLine = (rounds > 1 && intervalMs > 0)
        ? `  await new Promise((r) => setTimeout(r, ${intervalMs}));\n`
        : "";
      const wrapped = `async () => {
  const __p = ${probeFn};
${delayLine}  return await __p();
}`;
      let raw;
      try {
        raw = await tools["chrome-devtools"].evaluate_script({ pageId, function: wrapped, waitForStableDom: false });
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0, rounds };
      }
      const v = unwrapEval(raw);
      if (probeHit(v)) return { ok: true, value: v, elapsedMs: Date.now() - t0, rounds };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0, rounds };
  }
}

// ── findClickable({pageId, text?, selector?, visibleOnly=true}) → {ok, items, error?} ──
// 在目标页执行只读探查，找可点元素（text/selector 至少给一；两者都给=先 selector 缩小再 text 过滤）。
//   text     = 元素纯文本精确匹配（trim 后 === ，**大小写敏感**；全页 `*` 遍历，超大 DOM 页
//              可能百 ms 级；想放宽可自行把页面脚本内的 === 改 .includes() / toLowerCase()）
//   selector = CSS 选择器直查（比 text 快；text 同时给时做二次过滤）
//   pageId   = 建议必传（MCP page-id-routing 默认开启下页面级工具需要它；缺省=走 MCP 当前页，
//              跨步骤场景勿依赖「当前页」，传目标页自己的 id）
// items 按**面积升序**（小元素=按钮优先于大容器），每项：
//   {text, tag, id?, rect:{x,y,w,h}, center:{x,y}, inViewport}——坐标为 **CSS 视口像素**（click_at 用）。
// visibleOnly=true 过滤（尺寸>0 / display / visibility / offsetParent 或 fixed）；inViewport=
//   视口内且 elementFromPoint(center) 命中自身或后代（false=滚出视口或被遮挡，点击前先滚动）。
// ⭐ 空结果恒返回 items: []（永不 undefined/null）——调用方只判 items.length。
// 结果条数上限 FIND_CLICKABLE_MAX_ITEMS（面积升序截尾）。永不 throw。
async function findClickable(opts = {}) {
  try {
    const text = opts.text == null ? "" : String(opts.text).trim();
    const selector = opts.selector == null ? "" : String(opts.selector);
    const visibleOnly = opts.visibleOnly !== false;
    if (!text && !selector) return { ok: false, items: [], error: "text/selector 至少给一" };
    const pageFn = `() => {
  const needle = ${JSON.stringify(text)};
  const sel = ${JSON.stringify(selector)};
  const visibleOnly = ${visibleOnly ? "true" : "false"};
  const MAX_ITEMS = ${FIND_CLICKABLE_MAX_ITEMS};
  const out = [];
  let els = [];
  try {
    if (sel) {
      els = Array.from(document.querySelectorAll(sel));
      if (needle) els = els.filter((el) => (el.innerText || "").trim() === needle);
    } else {
      els = Array.from(document.querySelectorAll("*")).filter((el) => (el.innerText || "").trim() === needle);
    }
  } catch (e) {
    return JSON.stringify({ ok: false, items: [], error: "selector 无效: " + String((e && e.message) || e) });
  }
  for (const el of els) {
    try {
      const r = el.getBoundingClientRect();
      if (visibleOnly) {
        if (!(r.width > 0 && r.height > 0)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") continue;
        if (el.offsetParent === null && cs.position !== "fixed") continue;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inVp = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
      let inView = false;
      if (inVp) {
        const hit = document.elementFromPoint(cx, cy);
        inView = !!(hit && (hit === el || el.contains(hit)));
      }
      out.push({
        text: (el.innerText || "").trim().slice(0, 120),
        tag: (el.tagName || "").toLowerCase(),
        ...(el.id ? { id: el.id } : {}),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        center: { x: cx, y: cy },
        inViewport: inView,
      });
    } catch (e) { /* 单元素失败跳过 */ }
  }
  out.sort((a, b) => (a.rect.w * a.rect.h) - (b.rect.w * b.rect.h));
  return JSON.stringify({ ok: true, items: out.slice(0, MAX_ITEMS) });
}`;
    const call = { function: pageFn, waitForStableDom: false };
    if (opts.pageId != null) call.pageId = opts.pageId;
    const raw = await tools["chrome-devtools"].evaluate_script(call);
    const v = unwrapEval(raw);
    if (!v || typeof v !== "object" || !Array.isArray(v.items)) {
      return { ok: false, items: [], error: "返回值解析失败（unwrapEval → " + (v === null ? "null" : typeof v) + "）", raw: String(raw).slice(0, 220) };
    }
    return { ok: v.ok !== false, items: v.items, ...(v.error ? { error: String(v.error) } : {}) };
  } catch (e) {
    return { ok: false, items: [], error: String((e && e.message) || e) };
  }
}
