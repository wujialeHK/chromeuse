'use strict';
/*
 * chromeuse lib/cdp-core.js —— raw CDP 连接内核（工具层唯一 WS 实现）
 *
 * 设计约束（最优架构 v3 / 优化方案 v2 §P2）：
 * - 零第三方依赖：Node >= 22 内置 global WebSocket + fetch（<22 明确报错指 install.md，降级不阻塞 skill 主功能）
 * - 一次性短连接：连 → 取 → 断，不与 MCP 长驻会话竞争（R30）；永不自动关 tab
 * - 每命令独立超时默认 5000ms（对冲 MCP 客户端 60s 提档后报错变慢，【MCP timeout 提档副作用观察】）
 * - 复用同一 WebSocket 到 /json/version 的 browser 端点，Target.attachToTarget(flatten) 多路复用
 *   （对页面/OOPIF 一视同仁；nginx sidecar 的 Host 改写下同样成立）
 * - 错误归类 kind：conn（连接失败）| http | timeout（命令超时）| cdp（协议错误）| disconnect | usage
 */
const MAJOR_REQUIRED = 22;

/** Node >= 22 版本守护：不满足明确报错并退出（--help 路径不经过这里） */
function requireNode22() {
  const major = parseInt(String(process.versions.node).split('.')[0], 10);
  if (!(major >= MAJOR_REQUIRED)) {
    console.error(`✗ chromeuse 工具层需要 Node >= ${MAJOR_REQUIRED}（内置 WebSocket），当前 ${process.versions.node}`);
    console.error('  降级声明：工具层不可用不影响 skill 主功能（chrome-devtools MCP 通道照常）。');
    console.error('  查 references/install.md「工具层运行要求」升级 Node。');
    process.exit(1);
  }
  if (typeof WebSocket !== 'function') {
    console.error(`✗ 当前 Node ${process.versions.node} 无内置 WebSocket（须 >= ${MAJOR_REQUIRED}）`);
    process.exit(1);
  }
}

/** 归一错误对象：kind ∈ conn|http|timeout|cdp|disconnect|usage */
function cdpErr(kind, message, extra) {
  const e = new Error(message);
  e.kind = kind;
  if (extra) Object.assign(e, extra);
  return e;
}

function kindText(kind) {
  return ({ conn: '连接失败', http: 'HTTP 错误', timeout: '命令超时', cdp: 'CDP 协议错误', disconnect: '连接中断', usage: '用法错误' })[kind] || kind;
}

/** 连接层异常归类（fetch/WS 打开阶段）；附 browserUrl 供调用方做环境特征提示（GQ-004） */
function classifyConn(e, url) {
  if (e && e.name === 'AbortError') return cdpErr('timeout', `连接超时：${url}`, { browserUrl: url });
  return cdpErr('conn', `无法连接 ${url}（${(e && e.message) || e}）——查浏览器调试端口 / sidecar 路由 / config mcp.browserUrl`, { browserUrl: url });
}

function trimUrl(u) { return String(u || '').replace(/\/+$/, ''); }

/* ── 诊断辅助纯函数（GQ-003 / GQ-004）──
 * ①isNoFrameUrl：合成器不出帧的内部页（chrome://newtab）——窗口非前台/未渲染时 Page.captureScreenshot
 *   无帧可拍 → 超时是页面性质而非工具缺陷，诊断面须跳过并注明，不能误判「合成器失效」。
 * ②nasBrowserUrlHint：browserUrl 指向 NAS 容器服务名（chrome-browser）——桌面端误拷 linux 实例的典型特征，
 *   建连失败时给出一行可操作提示（文案按平台层 impl 选择：Windows 含 --init-config windows）。批2 起
 *   NAS 判定与文案实现单源在 lib/platform/（linux.js 基准 + windows.js 覆写），本文件只做转调、零平台分支。 */
const NO_FRAME_CHROME_HOSTS = ['newtab', 'new-tab-page', 'new-tab-page-third-party'];
function isNoFrameUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u.startsWith('chrome://')) return false;
  const host = u.slice('chrome://'.length).split(/[/?#]/)[0];
  return NO_FRAME_CHROME_HOSTS.includes(host);
}

const platform = require('./platform');
/* NAS 服务名判定：平台无关纯函数，实现单源在平台层基准 impl（Windows 同值；此处仅 re-export 保持 API 稳定） */
const { isNasServiceBrowserUrl } = require('./platform/linux');

/** 返回一行提示文案（文案/判空均由平台层 impl 决定）；无命中返回 null */
function nasBrowserUrlHint(browserUrl) {
  return platform().browser.nasServiceHint(browserUrl);
}

/* ── 版本闸（C2；TODO L59 方向①）──
 * ①parseChromeVersion：解析 `GET /json/version` 的 Browser 字段（`Chrome/120.0.6099.109`、
 *   `HeadlessChrome/88.0.4324.190`）→ 主版本；非 Chrome 串返回 null（不猜、不抛）。
 * ②mcpAdvisory：低于「MCP 已知降级线」→ 一行 advisory（MCP 实测降级面 + 走 cdp.js 主通道建议）。
 *   下限=94：已知唯一硬能力门槛是 WebCodecs（Chrome 94+，MCP screencast 依赖）；88 实测面
 *   （list_pages 恒空/pageId 漂移/take_snapshot 超时）来自 2026-10-29 示例ERP批。措辞固定为
 *   「已知降级线（非硬协议门槛）」——advisory 只提示、不改变命令成败与 exit 语义。 */
const MCP_ADVISORY_BELOW = 94;
const CHROME_VERSION_RE = /^\s*(?:HeadlessChrome|Chrome)\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/;

function parseChromeVersion(text) {
  const m = String(text == null ? '' : text).match(CHROME_VERSION_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? null : Number(m[2]),
    build: m[3] === undefined ? null : Number(m[3]),
    patch: m[4] === undefined ? null : Number(m[4]),
  };
}

/** 返回一行 advisory 文案；>= 下限 / 非 Chrome 串 / 空值 → null */
function mcpAdvisory(text) {
  const v = parseChromeVersion(text);
  if (!v || v.major >= MCP_ADVISORY_BELOW) return null;
  return `Chrome ${v.major} 低于 MCP 已知降级线 ${MCP_ADVISORY_BELOW}（非硬协议门槛）：chrome-devtools MCP 在该版本实测 list_pages 恒空/pageId 跨调用漂移、screencast（WebCodecs）不可用——请走 cdp.js 主通道（probe/targets/a11y/click 等），MCP 仅作 fallback`;
}

/** browserUrl 解析：CLI 显式值 > config.jsonc mcp.browserUrl > 默认本机 9222 */
function resolveBrowserUrl(cliUrl) {
  if (cliUrl) return trimUrl(cliUrl);
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    const u = cfg && cfg.mcp && cfg.mcp.browserUrl;
    if (u) return trimUrl(u);
  } catch (e) { /* 实例坏 → 走默认（由调用方决定是否提示） */ }
  return platform().browser.defaultBrowserUrl();
}

/** GET /json/list（纯 HTTP，无需 WS） */
async function listTargets(browserUrl, timeoutMs) {
  const url = trimUrl(browserUrl) + '/json/list';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 5000) });
    if (!res.ok) throw cdpErr('http', `HTTP ${res.status}：${url}`);
    return await res.json();
  } catch (e) {
    if (e && e.kind) throw e;
    throw classifyConn(e, url);
  }
}

/** GET /json/version → { Browser, webSocketDebuggerUrl, ... } */
async function browserVersion(browserUrl, timeoutMs) {
  const url = trimUrl(browserUrl) + '/json/version';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 5000) });
    if (!res.ok) throw cdpErr('http', `HTTP ${res.status}：${url}`);
    return await res.json();
  } catch (e) {
    if (e && e.kind) throw e;
    throw classifyConn(e, url);
  }
}

/**
 * CdpClient：单条 WS 连 browser 端点，Target.attachToTarget(flatten) 多路复用会话。
 * send() 每命令独立超时；事件经 onEvent 分发（带 sessionId，供 net/record 归属）。
 */
class CdpClient {
  constructor(browserUrl, opts) {
    this.browserUrl = trimUrl(browserUrl);
    this.defaultTimeoutMs = (opts && opts.timeoutMs) || 5000;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();      // id → {resolve, reject, timer}
    this.sessions = new Map();     // targetId → sessionId（正向）
    this.sessionTargets = new Map(); // sessionId → targetInfo（反向；attach/registerSession 双路径回填）
    this.eventListeners = new Set();
    this.closeListeners = new Set(); // V202609090003 批2：WS close 回调（record 有界重连用）
    this.closed = false;
  }

  /** 连接（一次性短连接语义：用完 close） */
  async connect() {
    const ver = await browserVersion(this.browserUrl, this.defaultTimeoutMs);
    const wsUrl = ver.webSocketDebuggerUrl;
    if (!wsUrl) throw cdpErr('conn', `${this.browserUrl} 未返回 webSocketDebuggerUrl`);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(cdpErr('timeout', `WebSocket 握手超时：${wsUrl}`)); }, this.defaultTimeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(cdpErr('conn', `WebSocket 错误：${wsUrl}`)); };
      ws.onclose = () => {
        clearTimeout(timer);
        const err = cdpErr('disconnect', 'WebSocket 已断开');
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        if (!this.closed) this.closed = true;
        for (const fn of this.closeListeners) { try { fn(); } catch { /* 回调异常不传染 */ } } // V202609090003 批2
      };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(cdpErr('cdp', `CDP ${p.method} → ${msg.error.code} ${msg.error.message}`));
          else p.resolve(msg.result);
        } else if (msg.method) {
          for (const fn of this.eventListeners) {
            try { fn({ sessionId: msg.sessionId, method: msg.method, params: msg.params }); } catch { /* 监听器异常不传染 */ }
          }
        }
      };
    });
    return this;
  }

  /** 发送一条 CDP 命令（每命令独立超时，默认 5000ms） */
  send(method, params, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || this.defaultTimeoutMs;
    if (!this.ws || this.ws.readyState !== 1 || this.closed) {
      return Promise.reject(cdpErr('disconnect', `连接不可用，无法发送 ${method}`));
    }
    const id = this.nextId++;
    const msg = { id, method };
    if (params !== undefined) msg.params = params;
    if (opts && opts.sessionId) msg.sessionId = opts.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(cdpErr('timeout', `CDP 命令超时（${timeoutMs}ms）：${method}`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(cdpErr('disconnect', `发送失败：${method}（${e.message}）`)); }
    });
  }

  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }

  /** WS close 回调注册（V202609090003 批2：record 有界重连用）；返回退订函数 */
  onClose(cb) { this.closeListeners.add(cb); return () => this.closeListeners.delete(cb); }

  /** 有界重连（V202609090003 批2）：复用实例与其上全部事件监听器（onEvent 注册不丢），重走 connect 握手；
   *  旧 session 全部失效——sessions/sessionTargets 清空（重 attach 由 setAutoAttach 重发触发）。
   *  失败抛错由调用方处理（有界重试/退场）。 */
  async reconnect(timeoutMs) {
    if (this.ws) { try { this.ws.close(); } catch { /* 已断 */ } }
    this.sessions.clear();
    this.sessionTargets.clear();
    this.closed = false;
    await this.connect();
    return this;
  }

  /** Target 解析第二步：attachToTarget(flatten) → sessionId */
  async attach(targetId, timeoutMs) {
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: timeoutMs || this.defaultTimeoutMs });
    this.registerSession(r.sessionId, { targetId });
    return r.sessionId;
  }

  /** 反向登记（attach 与 setAutoAttach/attachedToTarget 两个入口共用）：sessionId → targetInfo */
  registerSession(sessionId, targetInfo) {
    if (targetInfo && targetInfo.targetId) this.sessions.set(targetInfo.targetId, sessionId);
    this.sessionTargets.set(sessionId, targetInfo || null);
  }

  /** sessionId → targetInfo 反查（targetId/type/url/title；attach() 直连路径仅含 targetId） */
  targetOfSession(sessionId) { return this.sessionTargets.get(sessionId) || null; }

  sessionOf(targetId) { return this.sessions.get(targetId); }

  async close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(cdpErr('disconnect', '客户端主动关闭')); }
    this.pending.clear();
    if (this.ws) { try { this.ws.close(); } catch { /* 已断 */ } }
  }
}

/**
 * Target 解析：/json/list + attachToTarget。
 * 选择器 sel：undefined = 首个 type=page；字符串依次匹配 targetId 精确 → url 包含 → title 包含（不自动开/关任何 tab）。
 */
async function resolveTarget(client, sel, timeoutMs) {
  const targets = await listTargets(client.browserUrl, timeoutMs || client.defaultTimeoutMs);
  const pages = targets.filter(t => t.type === 'page');
  let hit = null;
  if (!sel) hit = pages[0] || null;
  else {
    const s = String(sel);
    hit = pages.find(t => t.id === s)
      || pages.find(t => (t.url || '').includes(s))
      || pages.find(t => (t.title || '').includes(s));
  }
  if (!hit) {
    throw cdpErr('usage', `未找到匹配的页面 target：${sel || '（未指定，且无任何 page 类型标签）'}——用 cdp.js targets 查看现有标签（永不自动开/关 tab）`);
  }
  const sessionId = await client.attach(hit.id, timeoutMs);
  return { target: hit, sessionId };
}

/** Runtime.evaluate 只读求值（returnByValue；禁止用于合成业务事件——红线一）。
 *  V202610130003 件2：可选第 5 参 opts——opts.awaitPromise === true 时发送 awaitPromise:true（缺省 false，
 *  存量调用零改动全兼容）。returnByValue:true 下 promise 的 resolved value 仍在 r.result.value（CDP 语义，
 *  勿二次解包）；promise reject → exceptionDetails → 抛 cdp 错误（与同步异常同路径）。 */
async function evaluate(client, sessionId, expression, timeoutMs, opts) {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: !!(opts && opts.awaitPromise), userGesture: false,
  }, { sessionId, timeoutMs });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw cdpErr('cdp', `evaluate 异常：${(d.exception && d.exception.description) || d.text || '未知'}`);
  }
  return r.result && r.result.value;
}

/** Page.captureScreenshot → base64 数据（调用方负责落盘；走合成器通道） */
async function screenshot(client, sessionId, opts) {
  const r = await client.send('Page.captureScreenshot', {
    format: (opts && opts.format) || 'png',
  }, { sessionId, timeoutMs: opts && opts.timeoutMs });
  return r.data;
}

module.exports = {
  MAJOR_REQUIRED, requireNode22, resolveBrowserUrl,
  listTargets, browserVersion, CdpClient, resolveTarget,
  evaluate, screenshot, cdpErr, kindText, classifyConn,
  isNoFrameUrl, nasBrowserUrlHint, isNasServiceBrowserUrl,
  MCP_ADVISORY_BELOW, parseChromeVersion, mcpAdvisory,
};
