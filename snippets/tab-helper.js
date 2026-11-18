// ─────────────────────────────────────────────────────────────────────────────
// tab-helper.js — 共享浏览器「页签生命周期」助手 v3.0（编排侧 snippet）
// ─────────────────────────────────────────────────────────────────────────────
// 背景（2026-10-13 护腰会话复盘 + 2026-10-14 用户三轮裁定）：
//   chrome-devtools MCP 的 pageId 是「全浏览器全局单调递增序号」——用户与 agent
//   共用同一浏览器，序号任意消耗、"记忆"必漂移；且多 agent 会话可并发操作同一
//   浏览器（两个模型同时 new_page）。v3 在 v2 差集方案上再加「跨会话互斥锁」。
//
// 修复姿态（六原则——v3 加锁）：
//   ⓪ **并发互斥锁**（v3 新增，用户要的「加个锁」）：把「快照→new_page→解析」序列
//      加跨会话互斥——锁载体 = **专用锁页**（title=__chromeuse_newpage_lock__ 的
//      空白页）上的 window 变量 CAS。原理：**页面 JS 单线程 ⇒ 同一次同步 evaluate
//      内的「检查+写入」是原子的**（双并发 Promise.all 实测「恰好一个赢家」）。
//      持锁窗口仅覆盖 new_page 序列（几百 ms）；抢锁失败等待重试（12 轮 ≈1.5s，
//      间隔用 list_pages 网络往返充当——Code Mode 无 timer），超时**降级无锁执行**
//      +warn（差集兜底，可用性优先）；30s 死锁自动过期抢占；锁页自动创建/重建、
//      常驻无害（可手动关闭——关闭仅降低并发保护，差集兜底仍在）。**覆盖边界**：
//      锁只协调「同样使用本 helper 的调用者」（用户手动操作/绕过 helper 直调 MCP
//      不在锁域）——与之互补的是 ① 快照差集（无协调也安全）——**两层合璧**：
//      锁=消除极紧交叉窗口，差集=一切场景的兜底。
//   ① 新开页 = 前置快照差集 + new_page 返回值解析：快照后「新出现 id」=候选集，
//      单候选直取；多候选（并发痕迹）按 url/title 唯一 → [selected] 证据链，
//      均不唯一**不猜**（id:null+候选清单——对齐「候选>1 诚实红」纪律）。
//   ② 跨步骤引用 = findTabs 按 URL/title 现查（selected 优先→id 降序）。切勿信任记忆。
//   ③ 报错后（超时 / No page found）= list_pages 复核再判死活；超时抛错≠失败。
//   ④ 跨步骤操作前 = assertTab 轻量身份校验（1 次只读 evaluate）。
//   ⑤ 快照不可用 = 降级「全列表 max(id)」启发（并发下不可靠，warn 标注）。
//
//   Ⓟ **并行采集 = 每 worker 各自 openTab（独立 targetId）**：多 worker 共享同一
//      pageId 并发驱动必踩 navigate/close 竞态——症状 `Inspected target navigated or
//      closed` / `Not attached to an active page`（F10 他方实测 2026-10-21：4 worker
//      --reuse 复用一页 → 140 篇失败 21 篇；各自 new_page 后 140/140 全通过）。
//      ⚠ 本 helper 的锁只保「pageId 获取」这一段，**不保页签被多方并发驱动**；
//      单页签复用只在串行任务里成立。
//
// 使用方式（编排侧 = 粘贴到 execute / Code Mode 代码块顶部）：
//   ⭐ chromeuse 惯例：**所有开页操作首选 `openTab`**（快照+锁+id 解析一步到位；
//      勿手写 new_page 后紧跟 list_pages 校准的旧模式）；跨步骤引用/校验用 findTabs/assertTab。
//   const t = await openTab("https://item.jd.com/xxx.html");  // 开页拿 id（自动快照+锁）
//   t.id → pageId；t.warn/lockWarn 非空=降置信说明；t.candidates=多候选清单
//   const hits = await findTabs({ urlPart: "item.jd.com/100206359350" }); // 跨步骤现查
//   const a = await assertTab(t.id, { urlPart: "item.jd.com" }); if (!a.ok) { /* 校准 */ }
//   await closeTab(id);
//   // openTab(url, { lock: false }) 可显式关闭锁（一般不需要）
//
// 实测校准（2026-10-14，NAS 共享浏览器）：
//   - new_page 返回=完整页签列表 markdown，新页自动 [selected]；行格式「N: title (url) [selected]?」。
//   - 全局序号跳号实证（3→6→…），差集/现查必要。
//   - 锁机制实测：CAS 顺序（ok→busy→释放→ok）✓；过期抢占 ✓；**Promise.all 双并发
//     恰好一个赢家**（输家正确读到 winner.me）✓；锁页 title 可设可查 ✓；
//     ⚠ sessionStorage 在 about:blank 被拒（opaque origin）——**CAS 用 window 变量**（本文件实现）。
//   - 并发场景 E2E：v2 差集（Promise.all 双发双路皆中）；v3 锁串行化（见 CHANGELOG）。
//
// ⚠ 边界：编排侧片段（引用 code mode 的 tools 全局对象），与页面侧脚本形态不同；
//   纯只读查询 + 标准 MCP 页签/求值工具调用，无合成事件（红线一）。
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_TITLE = "__chromeuse_newpage_lock__"; // 锁页 title 标记（协议名）
const LOCK_KEY = "__cu_np_lock";                 // 锁页上的 window 变量名
const LOCK_STALE_MS = 30000;                     // 死锁过期（持锁者崩溃 30s 后可被抢占）
const LOCK_RETRY = 12;                           // 抢锁重试轮数（每轮等待≈1 次 list_pages 往返）

// ── parsePages(text) → [{id, title, url, selected}] — 页签列表文本解析（纯函数）──
function parsePages(text) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    const m = /^(\d+):\s+(.+)$/.exec(line);
    if (!m) continue;
    let body = m[2], selected = false;
    if (/\s*\[selected\]\s*$/.test(body)) { selected = true; body = body.replace(/\s*\[selected\]\s*$/, ""); }
    let url = "", title = body.trim();
    const um = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(body);
    if (um && (/^[a-z][a-z0-9+.-]*:/.test(um[2].trim()) || /\S\.\S/.test(um[2].trim()))) {
      title = um[1].trim(); url = um[2].trim();
    }
    out.push({ id: Number(m[1]), title, url, selected });
  }
  return out;
}

// ── unwrapEval(text) — evaluate_script 包装文本 → 值（剥 ```json fence + 双重 JSON.parse，null 安全）──
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

// ── idsSnapshot() → number[] | null — 页签 id 快照 ──
async function idsSnapshot() {
  try { return parsePages(await tools["chrome-devtools"].list_pages({})).map((p) => p.id); } catch (e) { return null; }
}

// ── selectNew(pages, url, before) → {id, page, selOk?, urlOk?, warn?, candidates?} — 差集选择（纯逻辑可单测）──
function selectNew(pages, url, before) {
  const haveSnap = Array.isArray(before);
  const New = haveSnap ? pages.filter((p) => !before.includes(p.id)) : pages;
  if (!New.length) return { id: null, warn: "快照差集为空（新页未创建/秒关）", candidates: [] };
  if (!haveSnap) {
    const maxId = Math.max(...New.map((p) => p.id));
    const pick = New.find((p) => p.id === maxId);
    return { id: pick.id, page: pick, selOk: !!pick.selected, warn: "快照不可用降级=全列表序号最大（并发下不可靠）" };
  }
  if (New.length === 1) { const pick = New[0]; return { id: pick.id, page: pick, selOk: !!pick.selected }; }
  const byUrl = New.filter((p) => [p.url, p.title].some((x) => x && (x === url || x.includes(url) || url.includes(x))));
  if (byUrl.length === 1) { const pick = byUrl[0]; return { id: pick.id, page: pick, selOk: !!pick.selected, urlOk: true }; }
  if (byUrl.length > 1) {
    const sel = byUrl.filter((p) => p.selected);
    if (sel.length === 1) return { id: sel[0].id, page: sel[0], selOk: true, urlOk: true, warn: `并发/多候选（${byUrl.length} 个 url 匹配）按 [selected] 认定——建议 assertTab 复核`, candidates: byUrl };
    return { id: null, warn: `并发/多候选（${byUrl.length} 个 url 匹配且 [selected] 不唯一）不猜——用 candidates/assertTab 裁决`, candidates: byUrl };
  }
  const selNew = New.filter((p) => p.selected);
  if (selNew.length === 1) return { id: selNew[0].id, page: selNew[0], selOk: true, warn: "url 未匹配（导航中?）多候选按 [selected] 认定——建议 assertTab 复核", candidates: New };
  return { id: null, warn: `并发/多候选（差集 ${New.length} 个、url 未匹配、[selected] 不唯一）不猜——用 candidates/assertTab 裁决`, candidates: New };
}

// ── 锁页管理（v3）：ensureLockPage(pages) → {lockPage} — 找/建锁页 ──
// pages 建议传入口快照（复用同一次 list_pages）；缺失时自行重列。**只对空白页设锁标题**（防污染真实页）。
async function ensureLockPage(pages) {
  try {
    let list = Array.isArray(pages) ? pages : parsePages(await tools["chrome-devtools"].list_pages({}));
    let locks = list.filter((p) => p.title === LOCK_TITLE);
    if (!locks.length) {
      const rp = parsePages(await tools["chrome-devtools"].new_page({ url: "about:blank" }));
      const blank = rp.find((p) => p.selected && (p.url === "about:blank" || p.title === "about:blank"))
        || rp.find((p) => p.url === "about:blank" || p.title === "about:blank");
      if (!blank) return { lockPage: null, error: "锁页创建：未找到可标记的空白页" };
      await tools["chrome-devtools"].evaluate_script({
        pageId: blank.id,
        function: `() => { document.title = "${LOCK_TITLE}"; return "titled"; }`,
        waitForStableDom: false,
      });
      // 重列（并发下他人可能也建了）——取 id 最小者作共识锁页
      list = parsePages(await tools["chrome-devtools"].list_pages({}));
      locks = list.filter((p) => p.title === LOCK_TITLE);
    }
    if (!locks.length) return { lockPage: null, error: "锁页不可用" };
    locks.sort((a, b) => a.id - b.id);
    return { lockPage: locks[0] }; // 多个锁页时取最旧（双方共识规则）；多余者无害（见文件头说明）
  } catch (e) {
    return { lockPage: null, error: String((e && e.message) || e) };
  }
}

// ── acquireLock(lockPageId) → {ok, me} | {ok:false, pageGone?|timeout?} — 锁页 CAS 抢锁 ──
async function acquireLock(lockPageId) {
  const fn = `() => {
    const now = Date.now();
    const cur = window["${LOCK_KEY}"] || null;
    if (cur && cur.ts && now - cur.ts < ${LOCK_STALE_MS}) return JSON.stringify({ ok: false, holder: cur.me, age: now - cur.ts });
    const me = Math.random().toString(36).slice(2, 10);
    window["${LOCK_KEY}"] = { ts: now, me };
    return JSON.stringify({ ok: true, me });
  }`;
  for (let i = 0; i < LOCK_RETRY; i++) {
    let r = null, gone = false;
    try {
      r = unwrapEval(await tools["chrome-devtools"].evaluate_script({ pageId: lockPageId, function: fn, waitForStableDom: false }));
    } catch (e) { gone = true; }
    if (gone) return { ok: false, pageGone: true };
    if (r && r.ok) return { ok: true, me: r.me };
    // busy 或解析异常：等待一拍（list_pages 网络往返充当间隔——Code Mode 无 timer）
    try { await tools["chrome-devtools"].list_pages({}); } catch (e) { /* ignore */ }
  }
  return { ok: false, timeout: true };
}

// ── releaseLock(lockPageId, me) — 仅当持有者是自己时释放（防误清他人超时抢占后的锁）──
async function releaseLock(lockPageId, me) {
  try {
    await tools["chrome-devtools"].evaluate_script({
      pageId: lockPageId,
      function: `() => { const c = window["${LOCK_KEY}"]; if (c && c.me === "${me}") { window["${LOCK_KEY}"] = null; return "released"; } return "not-holder"; }`,
      waitForStableDom: false,
    });
  } catch (e) { /* 锁页消失=锁随之失效 */ }
}

// ── findTabs({urlPart?, titlePart?}) → 匹配页签数组（现查校准主入口）──
async function findTabs(opts = {}) {
  const pages = parsePages(await tools["chrome-devtools"].list_pages({}));
  const hits = pages.filter((p) =>
    (!opts.urlPart || [p.url, p.title].some((x) => (x || "").includes(opts.urlPart))) &&
    (!opts.titlePart || (p.title || "").includes(opts.titlePart)));
  return hits.sort((a, b) => (b.selected - a.selected) || (b.id - a.id));
}

// ── openTab(url, {lock?}) → {id, page, via, selOk?, urlOk?, warn?, lockWarn?, candidates?, error?} ──
// v3：入口快照（顺带找锁页）→ 抢锁（默认启用）→ 快照→new_page→差集选择 → finally 释放。
async function openTab(url, opts = {}) {
  const useLock = opts.lock !== false;
  // ① 入口快照（同时作为锁页查找源）
  let pages = null;
  try { pages = parsePages(await tools["chrome-devtools"].list_pages({})); } catch (e) { pages = null; }
  const before = pages ? pages.map((p) => p.id) : null;

  // ② 抢锁（失败一律降级，不阻塞主流程）
  let lock = null, lockWarn = null;
  if (useLock) {
    let lockPage = pages ? pages.find((p) => p.title === LOCK_TITLE) : null;
    if (!lockPage) {
      const ens = await ensureLockPage(pages || []);
      if (ens.lockPage) { lockPage = ens.lockPage; if (before) before.push(lockPage.id); }
    }
    if (lockPage) {
      const acq = await acquireLock(lockPage.id);
      if (acq.ok) lock = { id: lockPage.id, me: acq.me };
      else if (acq.pageGone) {
        const ens2 = await ensureLockPage([]);
        if (ens2.lockPage) {
          if (before) before.push(ens2.lockPage.id);
          const acq2 = await acquireLock(ens2.lockPage.id);
          if (acq2.ok) lock = { id: ens2.lockPage.id, me: acq2.me };
          else lockWarn = "锁页重建后抢锁失败——降级无锁执行（差集兜底）";
        } else lockWarn = "锁页重建失败——降级无锁执行（差集兜底）";
      } else {
        lockWarn = "抢锁超时（他方持锁未释放）——降级无锁执行（差集兜底）";
      }
    } else lockWarn = "锁页不可用——降级无锁执行（差集兜底）";
  }

  try {
    // ③ 快照→new_page→差集选择（锁保护区内）
    try {
      const ret = parsePages(await tools["chrome-devtools"].new_page({ url }));
      return { ...selectNew(ret, url, before), via: "return", ...(lock ? { lock: "held" } : {}), ...(lockWarn ? { lockWarn } : {}) };
    } catch (e) {
      let pages2;
      try { pages2 = parsePages(await tools["chrome-devtools"].list_pages({})); }
      catch (e2) { return { id: null, via: "fallback", error: String((e && e.message) || e), ...(lockWarn ? { lockWarn } : {}) }; }
      return { ...selectNew(pages2, url, before), via: "fallback", error: String((e && e.message) || e), ...(lockWarn ? { lockWarn } : {}) };
    }
  } finally {
    // ④ 释放（含 new_page 抛错路径）
    if (lock) await releaseLock(lock.id, lock.me);
  }
}

// ── closeTab(id) → boolean — 容错关闭（失败返回 false，不抛）──
async function closeTab(id) {
  try { await tools["chrome-devtools"].close_page({ pageId: id }); return true; } catch (e) { return false; }
}

// ── assertTab(id, {urlPart?, titlePart?}) → {ok, raw} — 操作前轻量身份校验 ──
async function assertTab(id, { urlPart, titlePart } = {}) {
  try {
    const r = String(await tools["chrome-devtools"].evaluate_script({
      pageId: id,
      function: "() => JSON.stringify({ url: location.href, title: document.title })",
      waitForStableDom: false,
    }));
    const ok = (!urlPart || r.includes(urlPart)) && (!titlePart || r.includes(titlePart));
    return { ok, raw: r.slice(0, 220) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
