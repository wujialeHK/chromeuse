'use strict';
/*
 * chromeuse lib/drive.js —— 最小交互命令集实现（cdp 主通道战略一期，2026-10-31 用户裁定）
 *
 * 定位：`tools/cdp.js click/click-at/type/key/hover/wait/console/upload/drag` 的唯一实现单源。
 * 蓝本：tmpdata/test-tools/gq-drive.mjs（Chrome 88 上 8 批 ~90 用例实战验证）——只取手法，
 *   连接/目标/日志/错误体系一律复用 lib/cdp-core（调用方 cdp.js 传入 client+sessionId）。
 *
 * 手法（全部 Input 域真实事件，isTrusted=true，红线一）：
 * - 点击 = mouseMoved → mousePressed → mouseReleased（双击 = clickCount 1→2 两段，间隔 60ms）
 * - 输入 = Ctrl+A → Delete → Input.insertText（默认覆盖；--append 跳过清空）
 * - 按键 = Input.dispatchKeyEvent keyDown/keyUp（键码映射表单源 KEY_TABLE；支持 Ctrl+A 组合串）
 * - 悬停 = 单发 mouseMoved
 * - wait = locator 跨同源 iframe 文本轮询（节距默认 700ms，蓝本实测参考值）
 * - console = Runtime.enable + Log.enable 短连接监听窗口（consoleAPICalled/exceptionThrown/entryAdded）
 *
 * Chrome 88 兼容（2026-10-31 用户裁定：简单则并入一期）：本模块只用 Input/Runtime/Log/Page 域，
 *   这些命令在 Chrome 88 全部存在且与新版语义一致（gq-drive 同款调用 88 实弹验证）——无 88 分叉。
 *
 * 边界（如实声明）：
 * - 文本定位复用 lib/locator.js（不重复造）：X1 四层命中闸门 + 跨同源 iframe + framePath；
 *   MCP 的 `uid` 是 chrome-devtools-mcp 快照期分配的临时句柄，raw CDP 无法解析——用 --selector
 *   （locator 输出的 cssPath）或 --text 取代（help 面明示）。
 * - 目标在视口外（hitOk=false）时默认对最高排序候选 scrollIntoView 后重采一次（--no-scroll 关）：
 *   仅改变滚动位置，不写 DOM、不合成事件。
 * - console 无「任意长度」历史：Chrome 153 实测 **Runtime.enable 会回放 console 历史**（consoleAPICalled 11 条）；
 *   Log.enable 未观测到 console API 条目（Log 域只收浏览器/网络日志）——旧版 Chrome 88 是否回放未验证。
 *   条目一律按 timestamp 标 pre:true 区分「连接前缓存」与「窗口内新增」，不按域名推断来源。
 *
 * 二期-2 追加（2026-10-31，视口/模拟/交互补充批；交互类落本模块）：
 * - upload = 定位（复用 interactSpec 语义）→ Runtime.evaluate 取元素 objectId → 类型闸门（必须 file input）
 *   → DOM.setFileInputFiles（**CDP 官方文件注入通道**，不是 DOM 合成事件，红线一不涉及）→ 读回 files 复核。
 *   ⚠ 文件路径必须存在于**执行 CDP 的机器**（本容器），相对路径按进程 cwd 解析为绝对路径。
 * - drag = Input 域真实鼠标序列：mouseMoved(buttons:0) → mousePressed(left,buttons:1) → N 段插值
 *   mouseMoved(left,buttons:1) → mouseReleased(buttons:0)。**复用 flow-engine drag 原语的已实证轨迹参数**
 *   （路线 A / DRAG_TRACE：5 段、90ms 段间、80ms hold；来源 tmpdata/drag-live/实验报告.md §5.6 G3 两连过），
 *   并把纯几何插值抽为 planDragPath 单源（flow-engine.dragGesture 同批改为消费本函数，见其注释）。
 */

const locator = require('./locator');
const expectMod = require('./expect'); // 交互后生效判据（R1：四态 phase/expect；裸命令不激活）
const time = require('./time');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INPUT_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_INTERVAL_MS = 700;
const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_CONSOLE_LISTEN_MS = 3000;
const WAIT_INTERVAL_MIN_MS = 50;
const WAIT_TIMEOUT_MIN_MS = 500;
const WAIT_TIMEOUT_MAX_MS = 600000;
const CONSOLE_LISTEN_MAX_MS = 300000;

const sleep = time.sleep; // 通用延迟单源 lib/time.js
const pad3 = (n) => String(n).padStart(3, '0');

/* ── 键码映射（单源；值对齐 Puppeteer USKeyboardLayout，CDP Input.dispatchKeyEvent 语义） ──
 * text 规则：字符键=字符本身；Enter='\r'；Space=' '；导航/功能键无 text（CDP 视为 rawKeyDown）。
 * 带 Ctrl/Alt/Meta 修饰时 text 一律省略（Ctrl+A 不能被当成字符输入）。 */
const KEY_TABLE = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};
for (let i = 1; i <= 12; i++) KEY_TABLE[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }; // F1=112 … F12=123
/* 可打印标点（US 布局 windowsVirtualKeyCode；text 走原字符） */
const PUNCT_TABLE = {
  ',': 188, '.': 190, '/': 191, ';': 186, "'": 222, '[': 219, ']': 221,
  '\\': 220, '-': 189, '=': 187, '+': 187, '`': 192,
};
const MODIFIER_ALIAS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };

/** 单个键名 → 键码计划（不含组合解析）。未知键抛错（不静默降级）。 */
function baseKeyPlan(name, modifiers) {
  const mods = Number(modifiers) || 0;
  const hit = KEY_TABLE[name];
  if (hit) return Object.assign({}, hit, { modifiers: mods });
  if (/^[a-zA-Z]$/.test(name)) {
    const upper = name.toUpperCase();
    const shifted = !!(mods & 8);
    const shortcut = !!(mods & 1 || mods & 2 || mods & 4); // Ctrl/Alt/Meta 组合按小写加速键语义（Ctrl+A 而非 Ctrl+Shift+A）
    const ch = shifted ? upper : name;
    const plan = { key: shortcut ? name.toLowerCase() : ch, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: ch, modifiers: mods };
    if (shortcut) delete plan.text; // Ctrl/Alt/Meta 不产生字符
    return plan;
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: 'Digit' + name, keyCode: name.charCodeAt(0), text: name, modifiers: mods };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCT_TABLE, name)) {
    const plan = { key: name, keyCode: PUNCT_TABLE[name], text: name, modifiers: mods };
    if (mods & 1 || mods & 2 || mods & 4) delete plan.text;
    return plan;
  }
  throw new Error(`未知按键「${name}」——支持：${Object.keys(KEY_TABLE).join('/')}/字母/数字/常用标点，组合用 Ctrl+Shift+A 形如`);
}

/**
 * 键名解析（含组合）：'Enter' / 'a' / 'Ctrl+A' / 'Shift+Tab' / 'Ctrl+Shift+ArrowLeft'。
 * @returns {{key:string, code?:string, keyCode:number, text?:string, modifiers:number, name:string}}
 */
function keyPlan(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) throw new Error('按键名不能为空');
  let parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length && raw === '+') parts = ['+']; // 单 '+' 键：split 后为空段，显式兜底
  if (!parts.length) throw new Error(`按键名非法：${JSON.stringify(spec)}`);
  let mods = 0;
  let base = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = MODIFIER_ALIAS[parts[i].toLowerCase()];
    if (m === undefined) throw new Error(`未知修饰键「${parts[i]}」（支持 Ctrl/Alt/Shift/Meta）`);
    mods |= m;
  }
  const plan = baseKeyPlan(base, mods);
  return Object.assign({ name: raw }, plan);
}

/** 组合键字符串 → CDP keyDown/keyUp 参数对（test 直接消费；text 仅 keyDown 携带） */
function keyEventParams(plan) {
  const down = {
    type: 'keyDown', key: plan.key, windowsVirtualKeyCode: plan.keyCode,
    nativeVirtualKeyCode: plan.keyCode, modifiers: plan.modifiers || 0,
  };
  if (plan.code) down.code = plan.code;
  if (plan.text !== undefined) down.text = plan.text;
  const up = {
    type: 'keyUp', key: plan.key, windowsVirtualKeyCode: plan.keyCode,
    nativeVirtualKeyCode: plan.keyCode, modifiers: plan.modifiers || 0,
  };
  if (plan.code) up.code = plan.code;
  return { down, up };
}

/* ── 参数纯函数 ── */

/** 'x,y' → {x,y}（整数；非法抛错——绝不静默回退 0,0） */
function parsePoint(value) {
  if (value && typeof value === 'object') {
    const x = Number(value.x), y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`坐标对象非法：${JSON.stringify(value)}`);
    return { x: Math.round(x), y: Math.round(y) };
  }
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(String(value == null ? '' : value));
  if (!m) throw new Error(`坐标须为 "x,y"（整数）：${JSON.stringify(value)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** wait 参数归一：默认 700ms / 30000ms；显式非法值抛错（不做静默兜底） */
function normalizeWaitOptions(src) {
  const o = src || {};
  const intervalMs = o.intervalMs === undefined ? DEFAULT_WAIT_INTERVAL_MS : Number(o.intervalMs);
  const timeoutMs = o.timeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : Number(o.timeoutMs);
  if (!Number.isFinite(intervalMs) || intervalMs < WAIT_INTERVAL_MIN_MS) throw new Error(`wait 节距非法（须 ≥${WAIT_INTERVAL_MIN_MS}ms）：${JSON.stringify(o.intervalMs)}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs < WAIT_TIMEOUT_MIN_MS || timeoutMs > WAIT_TIMEOUT_MAX_MS) throw new Error(`wait 总超时非法（须 ${WAIT_TIMEOUT_MIN_MS}~${WAIT_TIMEOUT_MAX_MS}ms）：${JSON.stringify(o.timeoutMs)}`);
  return { intervalMs, timeoutMs };
}

/** console 监听时长归一（默认 3000ms，0 = 只读 Log 缓存立即返回；上限 300000ms） */
function normalizeConsoleOptions(src) {
  const o = src || {};
  const listenMs = o.listenMs === undefined ? DEFAULT_CONSOLE_LISTEN_MS : Number(o.listenMs);
  if (!Number.isFinite(listenMs) || listenMs < 0 || listenMs > CONSOLE_LISTEN_MAX_MS) throw new Error(`console --listen 非法（须 0~${CONSOLE_LISTEN_MAX_MS}ms）：${JSON.stringify(o.listenMs)}`);
  return { listenMs };
}

/**
 * 可点候选裁决（纯函数）：0 个 → no-clickable；唯一 → 选中；多候选 → ambiguous（不猜，纪律同 locator）；
 * --nth N 显式指定（0 基，仅作用于可点候选）。
 */
function chooseClickable(candidates, opts) {
  const o = opts || {};
  const clickable = (Array.isArray(candidates) ? candidates : []).filter(locator.isClickable);
  if (!clickable.length) return { ok: false, reason: 'no-clickable', clickable: 0, total: (candidates || []).length };
  if (o.nth !== undefined && o.nth !== null) {
    const n = Number(o.nth);
    if (!Number.isInteger(n) || n < 0) return { ok: false, reason: 'bad-nth', clickable: clickable.length, total: (candidates || []).length, nth: o.nth };
    if (n >= clickable.length) return { ok: false, reason: 'nth-out-of-range', clickable: clickable.length, total: (candidates || []).length, nth: n };
    return { ok: true, candidate: clickable[n], clickable: clickable.length, total: (candidates || []).length, nth: n };
  }
  if (clickable.length > 1) return { ok: false, reason: 'ambiguous', clickable: clickable.length, total: (candidates || []).length, candidates: clickable };
  return { ok: true, candidate: clickable[0], clickable: 1, total: (candidates || []).length };
}

/** 候选中心点（rect 是视口坐标，含 iframe 偏移累加——与 Input.dispatchMouseEvent 语义一致） */
function candidatePoint(c) {
  if (!c || !c.rect) throw new Error('候选缺少 rect，无法计算点击坐标');
  return { x: Math.round(c.rect.x + c.rect.w / 2), y: Math.round(c.rect.y + c.rect.h / 2) };
}

/* ── 定位（复用 lib/locator.js） ── */

function buildScrollIntoViewExpr(candidate) {
  return `(function(){ var el = ${locator.buildFindElementExpr(candidate)}; if (!el) return { ok: false, error: 'element-not-found' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
}

/** 顶层视口尺寸（只读 evaluate；读不到返回 null——后续视口闸门 fail-soft 跳过） */
async function viewportInfo(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression: '({ w: innerWidth, h: innerHeight })', returnByValue: true, userGesture: false,
  }, { sessionId, timeoutMs: timeoutMs || DEFAULT_INPUT_TIMEOUT_MS });
  const v = r && r.result && r.result.value;
  if (!v || !Number.isFinite(Number(v.w)) || !Number.isFinite(Number(v.h))) return null;
  return { width: Number(v.w), height: Number(v.h) };
}

/** 视口闸门（纯函数）：候选中心点须落在顶层视口内——iframe 局部命中不代表顶层可见（F16 实弹缺陷） */
function pointInViewport(point, viewport) {
  if (!point || !viewport) return null;
  return point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
}

/**
 * 收集候选并裁决（必要时自动滚入视口后重采一次；顶层视口闸门防「iframe 局部命中但整体在视口外」假点击）。
 * @param {object} spec locator spec {text|domPath}
 * @param {object} [opts] {nth, autoScroll=true, timeoutMs}
 * @returns {Promise<{ok:boolean, reason?:string, candidate?:object, candidates:object[], clickable:number, point?:object, inViewport?:boolean|null}>}
 */
async function locate(client, sessionId, spec, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || locator.DEFAULT_TIMEOUT_MS;
  const autoScroll = o.autoScroll !== false;
  const collect = () => locator.collectCandidates(client, sessionId, spec, { timeoutMs });
  const rep = await collect();
  if (!rep.ok) return { ok: false, reason: rep.error || 'collect-failed', candidates: [], clickable: 0, error: rep.message };
  let ranked = locator.rankCandidates(rep.candidates, rep.spec || spec);
  let pick = chooseClickable(ranked, { nth: o.nth });
  const viewport = await viewportInfo(client, sessionId, timeoutMs).catch(() => null);
  let scrolled = null;
  let scrollTried = false;
  const doScroll = async (cand) => {
    if (scrollTried) return false;
    scrollTried = true;
    const sv = await client.send('Runtime.evaluate', {
      expression: buildScrollIntoViewExpr(cand), returnByValue: true, userGesture: false,
    }, { sessionId, timeoutMs }).then((r) => r.result && r.result.value).catch(() => null);
    if (!sv || !sv.ok) { scrolled = { scrolled: false, error: (sv && sv.error) || 'evaluate-failed' }; return false; }
    scrolled = { scrolled: true, at: time.isoLocal() };
    await sleep(150);
    const rep2 = await collect();
    if (!rep2.ok) return false;
    ranked = locator.rankCandidates(rep2.candidates, rep2.spec || spec);
    pick = chooseClickable(ranked, { nth: o.nth });
    return true;
  };
  if (autoScroll && pick.ok && viewport) {
    // 顶层视口闸门：rect 中心落在视口外（页面折叠/iframe 只有上沿可见）→ 先滚入再重采
    if (!pointInViewport(candidatePoint(pick.candidate), viewport)) await doScroll(pick.candidate);
  } else if (autoScroll && !pick.ok && pick.reason === 'no-clickable' && ranked.length) {
    const anchor = ranked.find((c) => c.visible === true) || null;
    if (anchor) await doScroll(anchor);
  }
  if (pick.ok) {
    const point = candidatePoint(pick.candidate);
    const inViewport = pointInViewport(point, viewport);
    if (inViewport === false) {
      return Object.assign({ candidates: ranked, scrolled, docs: rep.docs, viewport, point, inViewport },
        { ok: false, reason: 'out-of-viewport', clickable: pick.clickable, total: pick.total });
    }
    return Object.assign({ candidates: ranked, scrolled, docs: rep.docs, viewport, point, inViewport }, pick);
  }
  return Object.assign({ candidates: ranked, scrolled, docs: rep.docs, viewport }, pick);
}

/* ── 鼠标（Input 域） ── */

/** 坐标真实点击（单击/双击；双击=clickCount 1→2 两段 60ms 间隔，蓝本实测） */
async function clickPoint(client, sessionId, point, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const { x, y } = parsePoint(point);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', clickCount: 0,
  }, { sessionId, timeoutMs });
  const count = o.double ? 2 : 1;
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount,
    }, { sessionId, timeoutMs });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount,
    }, { sessionId, timeoutMs });
    if (o.double && clickCount < count) await sleep(60);
  }
  return { x, y, clicks: count, double: !!o.double };
}

/** 坐标悬停（单发 mouseMoved，真实事件流） */
async function hoverPoint(client, sessionId, point, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_INPUT_TIMEOUT_MS;
  const { x, y } = parsePoint(point);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', clickCount: 0,
  }, { sessionId, timeoutMs });
  return { x, y };
}

/* ── 键盘 / 输入（Input 域） ── */

/** 发送按键 N 次（组合键支持 Ctrl+A 形态） */
async function pressKey(client, sessionId, name, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const times = o.times === undefined ? 1 : Number(o.times);
  if (!Number.isInteger(times) || times < 1 || times > 100) throw new Error(`按键次数非法（须 1~100）：${JSON.stringify(o.times)}`);
  const plan = keyPlan(name);
  const { down, up } = keyEventParams(plan);
  for (let i = 0; i < times; i++) {
    await client.send('Input.dispatchKeyEvent', down, { sessionId, timeoutMs });
    await client.send('Input.dispatchKeyEvent', up, { sessionId, timeoutMs });
    if (times > 1) await sleep(80);
  }
  return { key: plan.name, times };
}

/* 焦点可编辑性探测（只读 evaluate；同源 iframe 内穿透，跨域止步如实报 crossFrame） */
const ACTIVE_EDITABLE_EXPR = `(function(){ var doc = document; var el = null;
  for (var i = 0; i < 8; i++) {
    try { el = doc.activeElement; } catch (e) { el = null; }
    if (!el) return null;
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      var inner = null; try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) return { tag: tag, editable: false, crossFrame: true, value: '' };
      doc = inner; continue;
    }
    if (tag === 'input' || tag === 'textarea') return { tag: tag, editable: !(el.disabled || el.readOnly), value: String(el.value == null ? '' : el.value).slice(0, 200) };
    if (el.isContentEditable) return { tag: tag, editable: true, value: String(el.innerText || '').slice(0, 200) };
    return { tag: tag, editable: false, value: String(el.textContent || '').slice(0, 80) };
  }
  return null; })()`;

async function readActiveEditable(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression: ACTIVE_EDITABLE_EXPR, returnByValue: true, userGesture: false,
  }, { sessionId, timeoutMs });
  return (r && r.result && r.result.value) || null;
}

/** 输入文本：默认 Ctrl+A + Delete 清空后 Input.insertText；--append 直接续写（蓝本手法） */
async function typeText(client, sessionId, text, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const value = String(text == null ? '' : text);
  if (!o.append) {
    await pressKey(client, sessionId, 'Ctrl+A', { timeoutMs });
    await sleep(80);
    await pressKey(client, sessionId, 'Delete', { timeoutMs });
    await sleep(80);
  }
  await client.send('Input.insertText', { text: value }, { sessionId, timeoutMs });
  const active = await readActiveEditable(client, sessionId, timeoutMs).catch(() => null);
  return { value, cleared: !o.append, active };
}

/* ── wait：轮询文本出现（复用 locator，跨同源 iframe） ── */

/**
 * 轮询等待文本出现（任一候选命中即返回；不要求可点——等待的是「结果文本出现」）。
 * @param {string|object} textSpec 文本或 locator text 描述符
 * @param {object} [opts] {intervalMs=700, timeoutMs=30000}
 */
async function waitForText(client, sessionId, textSpec, opts) {
  const o = normalizeWaitOptions(opts);
  const spec = { text: textSpec };
  const t0 = Date.now();
  let polls = 0;
  let lastError = null;
  for (;;) {
    polls++;
    const remaining = Math.max(200, o.timeoutMs - (Date.now() - t0));
    const rep = await locator.collectCandidates(client, sessionId, spec, { timeoutMs: Math.min(DEFAULT_INPUT_TIMEOUT_MS, remaining) }).catch((e) => ({ ok: false, error: 'evaluate-failed', message: e.message }));
    if (rep.ok && rep.candidates.length) {
      const ranked = locator.rankCandidates(rep.candidates, rep.spec || spec);
      return { ok: true, waitedMs: Date.now() - t0, polls, matches: rep.candidates.length, candidate: ranked[0] };
    }
    if (!rep.ok) lastError = rep.error || rep.message || 'collect-failed';
    const elapsed = Date.now() - t0;
    if (elapsed >= o.timeoutMs) return { ok: false, waitedMs: elapsed, polls, matches: 0, error: lastError };
    await sleep(Math.min(o.intervalMs, Math.max(0, o.timeoutMs - elapsed)));
  }
}

/**
 * 轮询等待任意 JS 表达式为真（V20261112001 §17 附节：wait --expr）。
 * 真值判定=JS truthy（Runtime.evaluate returnByValue+awaitPromise）；表达式异常/求值失败记 lastError
 * **继续轮询**（对齐 waitForText），超时才有结论；主 frame 执行不跨 iframe。
 * @param {string} expr JS 表达式（应为只读幂等）
 * @param {object} [opts] {intervalMs=700, timeoutMs=30000}
 * @returns {Promise<{ok,waitedMs,polls,value?,error?}>}
 */
async function waitForExpr(client, sessionId, expr, opts) {
  const o = normalizeWaitOptions(opts);
  const core = require('./cdp-core');
  const t0 = Date.now();
  let polls = 0;
  let lastError = null;
  let value;
  for (;;) {
    polls++;
    const remaining = Math.max(200, o.timeoutMs - (Date.now() - t0));
    try {
      value = await core.evaluate(client, sessionId, expr, Math.min(DEFAULT_INPUT_TIMEOUT_MS, remaining), { awaitPromise: true });
      if (value) return { ok: true, waitedMs: Date.now() - t0, polls, value };
    } catch (e) { lastError = String((e && e.message) || e); }
    const elapsed = Date.now() - t0;
    if (elapsed >= o.timeoutMs) return { ok: false, waitedMs: elapsed, polls, value, error: lastError };
    await sleep(Math.min(o.intervalMs, Math.max(0, o.timeoutMs - elapsed)));
  }
}

/* ── console 取证（Runtime/Log 域监听窗口） ── */

function remoteArgText(a) {
  if (a === null || a === undefined) return String(a);
  if (typeof a !== 'object') return String(a);
  if (Object.prototype.hasOwnProperty.call(a, 'value')) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue !== undefined) return String(a.unserializableValue);
  if (a.description !== undefined) return String(a.description).slice(0, 300);
  return a.type ? `<${a.type}>` : '<unknown>';
}

function consoleArgsText(args) {
  return (Array.isArray(args) ? args : []).map(remoteArgText).join(' ');
}

/** console 条目归集器（纯 Node 侧，可单测）：Runtime/Log 双源 + 去重 + 连接前缓存标记 */
function createConsoleCollector(opts) {
  const o = opts || {};
  const startedAt = Number.isFinite(o.startedAt) ? o.startedAt : Date.now();
  const entries = [];
  let deduped = 0;
  const seen = []; // 近窗口 console 条目（Log 域同文本回放去重）
  const push = (e) => {
    e.pre = Number.isFinite(e.ts) ? e.ts < startedAt - 50 : false;
    entries.push(e);
    return e;
  };
  return {
    entries,
    get deduped() { return deduped; },
    addConsole(params) {
      const p = params || {};
      const text = consoleArgsText(p.args);
      const e = push({
        kind: 'console', level: String(p.type || 'log'), text,
        ts: Number(p.timestamp) || Date.now(), url: '', line: 0,
        stack: p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0] ? p.stackTrace.callFrames[0].url : '',
      });
      seen.push({ text, ts: e.ts });
      if (seen.length > 50) seen.shift();
      return e;
    },
    addException(params) {
      const d = (params && params.exceptionDetails) || {};
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常';
      return push({
        kind: 'exception', level: 'error', text: String(desc).split('\n')[0].slice(0, 500),
        ts: Number(d.timestamp) || Date.now(), url: d.url || '', line: d.lineNumber || 0,
      });
    },
    addLog(params) {
      const en = (params && params.entry) || {};
      const text = String(en.text == null ? '' : en.text);
      const ts = Number(en.timestamp) || Date.now();
      // Chrome 会把 console API 消息同时报进 Log 域（source=javascript）：同文本 ±50ms 视为重复
      if (en.source === 'javascript') {
        const dup = seen.some((s) => s.text === text && Math.abs(s.ts - ts) <= 50);
        if (dup) { deduped++; return null; }
      }
      return push({
        kind: 'log', level: String(en.level || 'info'), text: text.slice(0, 500),
        ts, url: en.url || '', line: en.lineNumber || 0, source: en.source || '',
      });
    },
  };
}

/** 条目人类可读行：clock level text (url:line) */
function formatConsoleEntry(e) {
  const p = time.tzParts(new Date(Number(e.ts) || Date.now()));
  const clock = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}.${pad3(p.ms)}`;
  const lineNo = Number.isFinite(Number(e.line)) ? Number(e.line) + 1 : null;
  const where = e.url ? ` (${String(e.url).replace(/^data:[^,]*,/, 'data:…,').slice(0, 80)}${lineNo ? ':' + lineNo : ''})` : '';
  const pre = e.pre ? ' [连接前缓存]' : '';
  return `${clock} ${e.level.padEnd(7)} ${String(e.text).replace(/\s+/g, ' ').slice(0, 400)}${where}${pre}`;
}

/**
 * 短连接 console 监听窗口：Runtime.enable + Log.enable → 收集 → 到时摘监听返回。
 * @returns {Promise<{ok:boolean, entries:object[], listenMs:number, enabled:object, deduped:number}>}
 */
async function captureConsole(client, sessionId, opts) {
  const o = opts || {};
  const listenMs = normalizeConsoleOptions({ listenMs: o.listenMs }).listenMs;
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const startedAt = Date.now();
  const collector = createConsoleCollector({ startedAt });
  const enabled = { runtime: false, log: false };
  const off = client.onEvent((ev) => {
    if (!ev || ev.sessionId !== sessionId) return;
    if (ev.method === 'Runtime.consoleAPICalled') collector.addConsole(ev.params);
    else if (ev.method === 'Runtime.exceptionThrown') collector.addException(ev.params);
    else if (ev.method === 'Log.entryAdded') collector.addLog(ev.params);
  });
  try {
    try { await client.send('Runtime.enable', {}, { sessionId, timeoutMs }); enabled.runtime = true; }
    catch (e) { enabled.runtimeError = e.message; }
    try { await client.send('Log.enable', {}, { sessionId, timeoutMs }); enabled.log = true; }
    catch (e) { enabled.logError = e.message; }
    if (!enabled.runtime && !enabled.log) throw new Error(`Runtime/Log 域均不可用：${enabled.runtimeError || enabled.logError}`);
    if (listenMs > 0) await sleep(listenMs);
    else await sleep(120); // --listen 0：短排水窗，确保 enable 触发的缓存回放事件已到达再摘监听
    return { ok: true, entries: collector.entries, listenMs, enabled, deduped: collector.deduped };
  } finally {
    try { off(); } catch (e) { /* noop */ }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 二期-2：upload（DOM 文件注入） + drag（Input 真实鼠标拖拽）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 浏览器侧绝对路径判定（浏览器宿主平台未知：POSIX `/x` 与 Windows `C:\x`/`C:/x` 均算绝对）。 */
function isBrowserAbsPath(p) {
  return path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 上传文件路径归一（纯 IO，建连前调用）：字符串或数组；支持逗号分隔（`a.png,b.png`）。
 * 默认校验客户端存在/普通文件/可读，返回绝对路径。⚠ 该路径随后由 **DOM.setFileInputFiles 在浏览器进程侧解析**——
 * 客户端与浏览器文件系统隔离时文件内容读不到（见 uploadFiles 的 size 防假绿校验）。
 * `opts.skipLocalCheck=true`（CLI `--browser-path`）= 路径只在浏览器进程可见（如 chrome-browser 容器的
 * /config/Downloads）：**必须传浏览器侧绝对路径**（POSIX 与 Windows 盘符双标准），原样下发、绝不做本地
 * `path.resolve`（否则 Windows CLI 会给容器 POSIX 路径加盘符）；内容可达性由注入后「读回 size>0」兜底。
 */
function resolveUploadFiles(files, opts) {
  const o = opts || {};
  const arr = Array.isArray(files) ? files : [files];
  const parts = [];
  for (const f of arr) {
    if (f === undefined || f === null || f === '') continue;
    for (const s of String(f).split(',')) {
      const t = s.trim();
      if (t) parts.push(t);
    }
  }
  if (!parts.length) throw new Error('upload 需要至少一个文件路径');
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (o.skipLocalCheck) {
      // 浏览器侧路径：客户端不可见也不该改写——原样下发（DOM.setFileInputFiles 由浏览器进程解析）
      if (!isBrowserAbsPath(p)) throw new Error(`--browser-path 须为浏览器侧绝对路径：${p}`);
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      continue;
    }
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new Error(`文件不存在/不可读：${p}（${abs}，${e.code || e.message}）`); }
    if (!st.isFile()) throw new Error(`不是普通文件：${p}（${abs}）`);
    try { fs.accessSync(abs, fs.constants.R_OK); } catch (e) { throw new Error(`文件不可读：${p}（${abs}，${e.code || e.message}）`); }
    out.push(abs);
  }
  return out;
}

const UPLOAD_OBJECT_GROUP = 'chromeuse-upload';

/** file input 元素探针（Runtime.callFunctionOn；返回 tag/type/multiple/disabled + files 明细 [{name,size,type}]）。 */
async function probeFileInput(client, sessionId, objectId, timeoutMs) {
  const r = await client.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function(){ return { tag: String(this.tagName || "").toLowerCase(), type: String(this.type || "").toLowerCase(), multiple: !!this.multiple, disabled: !!this.disabled, files: Array.prototype.map.call(this.files || [], function(f){ return { name: String(f.name), size: Number(f.size), type: String(f.type || "") }; }) }; }',
    returnByValue: true,
  }, { sessionId, timeoutMs });
  return (r && r.result && r.result.value) || null;
}

/**
 * 文件注入（DOM.setFileInputFiles）。
 * @param {object} target {kind:'active'|'objectId'|'text'|'selector', objectId?, spec?, label?}
 * @param {string[]|string} files 文件路径（逗号分隔或数组；见 resolveUploadFiles）
 * @param {object} [opts] {nth, autoScroll=true, timeoutMs, locateTimeoutMs, browserPath=false}
 *   browserPath=true（CLI --browser-path）= 路径只在浏览器进程可见：须为浏览器侧绝对路径，原地原样下发
 *   （不做本地 resolve）；跳过客户端存在性校验，内容校验降级为「读回 size>0」（0 字节=不可读或空文件，按失败收割，不假绿）
 * @returns {Promise<object>} 成功 {ok:true,files,label,input:{tag,type,multiple,disabled,files},after:名称数组,
 *   afterDetail:[{name,size,type}],localSizes,contentOk,contentMismatch,candidate?,scrolled?}；
 *   ⚠ contentOk=false 表示注入动作已下发但浏览器读不到文件内容（size 不符，通常=两容器文件系统隔离），
 *   调用方必须按失败处理（exit 1）不得假绿；
 *   失败 {ok:false,reason:'not-element'|'not-file-input'|'disabled'|'multiple-required'|locate 失败原因,...}
 */
async function uploadFiles(client, sessionId, target, files, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const browserPath = o.browserPath === true;
  const list = resolveUploadFiles(files, { skipLocalCheck: browserPath });
  const t = target || { kind: 'active' };
  let objectId = null;
  let label = t.label || '当前焦点';
  let candidate = null;
  let scrolled = null;
  if (t.kind === 'objectId') {
    // 坐标定位的 elementFromPoint 解析由调用方（tools/cdp.js）完成——本模块保持零 elementFromPoint
    //（一期红线机检：drive.js 只做 Input 事件 + 元素对象操作，不承担点命中探测）
    objectId = String(t.objectId || '');
    if (!objectId) return { ok: false, reason: 'not-element', label, candidate, scrolled };
  } else {
    let expr;
    if (t.kind === 'active') {
      expr = 'document.activeElement';
    } else if (t.kind === 'text' || t.kind === 'selector') {
      const res = await locate(client, sessionId, t.spec, { nth: o.nth, autoScroll: o.autoScroll !== false, timeoutMs: o.locateTimeoutMs || 10000 });
      if (!res.ok) return { ok: false, reason: res.reason || 'locate-failed', locate: res, label };
      candidate = res.candidate;
      scrolled = res.scrolled;
      expr = locator.buildFindElementExpr(candidate);
      label = t.label || `「${String(candidate.text || '').slice(0, 40)}」<${candidate.tag}>`;
    } else {
      throw new Error(`upload 目标类型非法：${JSON.stringify(t.kind)}`);
    }
    const evalRes = await client.send('Runtime.evaluate', {
      expression: expr, objectGroup: UPLOAD_OBJECT_GROUP, returnByValue: false, userGesture: false,
    }, { sessionId, timeoutMs });
    objectId = evalRes && evalRes.result && evalRes.result.objectId;
    if (!objectId) return { ok: false, reason: 'not-element', label, candidate, scrolled };
  }
  try {
    const info = await probeFileInput(client, sessionId, objectId, timeoutMs).catch((e) => ({ error: e.message }));
    if (!info || info.error || info.tag !== 'input' || info.type !== 'file') {
      return { ok: false, reason: 'not-file-input', label, input: info || null, candidate, scrolled };
    }
    if (info.disabled) return { ok: false, reason: 'disabled', label, input: info, candidate, scrolled };
    if (list.length > 1 && !info.multiple) return { ok: false, reason: 'multiple-required', label, input: info, candidate, scrolled };
    // CDP 官方文件注入通道（非 DOM 合成事件；红线一禁的是合成业务事件，文件注入是协议许可的唯一入口）
    await client.send('DOM.setFileInputFiles', { files: list, objectId }, { sessionId, timeoutMs });
    const after = await probeFileInput(client, sessionId, objectId, timeoutMs).catch(() => null);
    const afterDetail = after ? after.files : null;
    // 内容校验（防假绿，2026-10-31 实弹发现）：DOM.setFileInputFiles 的 files 路径由**浏览器进程**解析，
    //   客户端与浏览器文件系统隔离时 Chrome 不报错——静默创建 0 字节 File（只有名字）。必须比对
    //   本地 size 与浏览器读回 size，不符如实上报（contentOk:false），绝不静默成功。
    const localSizes = list.map((p) => { try { return fs.statSync(p).size; } catch (e) { return null; } });
    const contentMismatch = [];
    if (!afterDetail) contentMismatch.push({ kind: 'no-readback' });
    else {
      if (afterDetail.length !== list.length) contentMismatch.push({ kind: 'count', local: list.length, remote: afterDetail.length });
      for (let i = 0; i < Math.min(list.length, afterDetail.length); i++) {
        if (browserPath) {
          // --browser-path：客户端读不到该路径，无法比对内容；只验证浏览器侧读回非空
          // （0 字节 = 路径在浏览器进程不可读，或真为空文件——后者按失败提示改用默认模式）
          if (!(afterDetail[i].size > 0)) {
            contentMismatch.push({ kind: 'empty', index: i, name: afterDetail[i].name, remote: afterDetail[i].size, path: list[i] });
          }
          continue;
        }
        if (localSizes[i] === null) continue;
        if (afterDetail[i].size !== localSizes[i]) {
          contentMismatch.push({ kind: 'size', index: i, name: afterDetail[i].name, local: localSizes[i], remote: afterDetail[i].size, path: list[i] });
        }
      }
    }
    return {
      ok: true, files: list, label, input: info, browserPath,
      after: afterDetail ? afterDetail.map((f) => f.name) : null, afterDetail, localSizes,
      contentOk: contentMismatch.length === 0, contentMismatch, candidate, scrolled,
    };
  } finally {
    try { await client.send('Runtime.releaseObject', { objectId }, { sessionId, timeoutMs: 1000 }); } catch (e) { /* 尽力而为 */ }
  }
}

/* ── drag：轨迹参数单源（与 flow-engine 同源；来源=G3 实证报告 §5.6） ──
 * SEGMENTS=按住段插值段数（G3 用 5 段；多段只为轨迹密度，非因子）、
 * MOVE_GAP_MS=段间节距（G3 用 90ms；零延迟也过，取值只为贴近真实手感）、
 * HOLD_MS=press 后按住起手间隔；PROBE_AT 供 flow-engine 拖动期取证探针使用。 */
const DRAG_TRACE = { SEGMENTS: 5, MOVE_GAP_MS: 90, HOLD_MS: 80, PROBE_AT: [2, 4] };
const DRAG_STEPS_MAX = 50;
const DRAG_DELAY_MAX_MS = 5000;

/** drag 轨迹参数归一（纯函数）：默认 5 段/90ms/80ms；steps 1~50，hold/gap 0~5000ms。 */
function normalizeDragOptions(src) {
  const o = src || {};
  const steps = o.steps === undefined ? DRAG_TRACE.SEGMENTS : Number(o.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > DRAG_STEPS_MAX) throw new Error(`drag --steps 须为 1~${DRAG_STEPS_MAX} 的整数：${JSON.stringify(o.steps)}`);
  const holdMs = o.holdMs === undefined ? DRAG_TRACE.HOLD_MS : Number(o.holdMs);
  if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > DRAG_DELAY_MAX_MS) throw new Error(`drag --hold 须为 0~${DRAG_DELAY_MAX_MS}ms：${JSON.stringify(o.holdMs)}`);
  const gapMs = o.gapMs === undefined ? DRAG_TRACE.MOVE_GAP_MS : Number(o.gapMs);
  if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > DRAG_DELAY_MAX_MS) throw new Error(`drag --gap 须为 0~${DRAG_DELAY_MAX_MS}ms：${JSON.stringify(o.gapMs)}`);
  return { steps, holdMs: Math.round(holdMs), gapMs: Math.round(gapMs) };
}

/**
 * 拖拽插值轨迹（纯函数，selftest 直测）：from/to 为 CSS 视口坐标，返回 N 段线性插值点（含落点）。
 * 硬约束（G3b 反证）：按住段每条 mouseMoved 必须 button:'left'+buttons:1——位面在 dragGesture 施加。
 */
function planDragPath(from, to, opts) {
  const f = parsePoint(from);
  const t = parsePoint(to);
  const { steps } = normalizeDragOptions(opts);
  const points = [];
  for (let i = 1; i <= steps; i++) {
    points.push({ seg: i, x: Math.round(f.x + ((t.x - f.x) * i) / steps), y: Math.round(f.y + ((t.y - f.y) * i) / steps) });
  }
  return { from: f, to: t, steps, points };
}

/** screenX/screenY 忠实映射（只读 evaluate；读不到返回 null，事件仍可发——screen 字段可选）。 */
async function readDragScreenOffset(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression: '(function(){ return [window.screenX || 0, window.screenY || 0, (window.outerHeight - window.innerHeight) || 0]; })()',
    returnByValue: true, userGesture: false,
  }, { sessionId, timeoutMs }).catch(() => null);
  const v = r && r.result && r.result.value;
  return Array.isArray(v) ? v : null;
}

/**
 * 拖拽手势（Input 域真实鼠标事件；路线 A，复用 flow-engine dragGesture 的已实证位面）：
 * hover moved(buttons:0) → pressed(left,buttons:1)@源 → HOLD → N 段插值 moved(left,buttons:1)（段间 GAP）
 * → released(left,buttons:0)@落点。坐标 = CSS 视口 px（DPR 无关）。
 * ⚠ 收尾语义：released 后 dragend 即终点——DOM mouseup 被拖拽管线消费，断言勿锚 mouseup。
 * @returns {Promise<{from,to,steps,points,holdMs,gapMs}>}
 */
async function dragGesture(client, sessionId, from, to, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_INPUT_TIMEOUT_MS;
  const { steps, holdMs, gapMs } = normalizeDragOptions(o);
  const path = planDragPath(from, to, { steps });
  const off = await readDragScreenOffset(client, sessionId, timeoutMs);
  const screen = (x, y) => ({ screenX: off ? off[0] + x : x, screenY: off ? off[1] + off[2] + y : y + 120 });
  const send = (params) => client.send('Input.dispatchMouseEvent', params, { sessionId, timeoutMs });
  // 归位（button:none + buttons:0）→ 按下（buttons:1 是路线 A 硬约束起点）
  await send(Object.assign({ type: 'mouseMoved', x: path.from.x, y: path.from.y, button: 'none', buttons: 0, clickCount: 1, pointerType: 'mouse' }, screen(path.from.x, path.from.y)));
  await send(Object.assign({ type: 'mousePressed', x: path.from.x, y: path.from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, screen(path.from.x, path.from.y)));
  if (holdMs > 0) await sleep(holdMs);
  for (const p of path.points) {
    // 按住段硬位面：button:'left' + buttons:1（缺位掩码会退化成普通 mousemove，G3b 反证）
    await send(Object.assign({ type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, screen(p.x, p.y)));
    if (p.seg < steps && gapMs > 0) await sleep(gapMs);
  }
  await send(Object.assign({ type: 'mouseReleased', x: path.to.x, y: path.to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, screen(path.to.x, path.to.y)));
  return { from: path.from, to: path.to, steps, points: path.points, holdMs, gapMs };
}

/* ── R1：交互后生效判据接线（V202611030003 B2） ──
 * 四态 phase / 判据解析 / 轮询 settle 的实现单源在 lib/expect.js；本模块只提供「动作命令侧」统一转发
 * （click/type/key/drag/upload 在 tools/cdp.js 统一走 drive.parseEffectFlags + drive.settleEffect）。
 * ⚠ 裸命令（无任何 --expect-*）不调用 → 零新增 CDP 调用、输出逐字节不变（硬约束）。
 * ⚠ 本模块仍保持零 elementFromPoint（点命中探测在 CLI/expect 侧）。 */
function parseEffectFlags(flags) { return expectMod.parseFlags(flags); }
async function settleEffect(client, sessionId, opts) { return expectMod.settleEffect(client, sessionId, opts); }
function toVerifyTarget(candidate) { return expectMod.toVerifyTarget(candidate); }
function subjectExprFor(candidate) { return candidate ? locator.buildFindElementExpr(candidate) : null; }

module.exports = {
  // 常量
  DEFAULT_WAIT_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_CONSOLE_LISTEN_MS, KEY_TABLE,
  DRAG_TRACE, DRAG_STEPS_MAX, DRAG_DELAY_MAX_MS,
  // 纯函数
  keyPlan, keyEventParams, parsePoint, normalizeWaitOptions, normalizeConsoleOptions,
  chooseClickable, candidatePoint, formatConsoleEntry, remoteArgText, createConsoleCollector,
  normalizeDragOptions, planDragPath, resolveUploadFiles,
  // CDP 动作（Input/Runtime/Log/DOM 域）
  locate, clickPoint, hoverPoint, pressKey, typeText, readActiveEditable, waitForText, waitForExpr, captureConsole,
  viewportInfo, pointInViewport,
  uploadFiles, dragGesture,
  // R1 生效判据（实现单源 lib/expect.js；CLI 转发面）
  parseEffectFlags, settleEffect, describeEffect: expectMod.describeSpec, STALL_HINT: expectMod.STALL_HINT,
  toVerifyTarget, subjectExprFor,
  // 页面侧表达式（selftest 红线断言用）
  buildScrollIntoViewExpr, ACTIVE_EDITABLE_EXPR, UPLOAD_OBJECT_GROUP,
};
