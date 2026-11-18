'use strict';
/*
 * chromeuse lib/browser-launch.js —— 浏览器 launch 模式编排（批 C1/R2，V20261117007；平台无关）
 *
 * 定位：「配置三键 → 发现 exe → 幂等探测 → spawn 常驻 → 等就绪 → Chromium 校验 → state 落盘 → 显式关停」；
 * 命令层（批 C2 browser-up / --auto-launch）只做参数与输出。平台差异全走 lib/platform 契约，本文件零平台判断。
 * 安全红线（方案 §2.2.6）：① 独立 user-data-dir 强制（空/默认 profile 特征拒绝，绝不 attach 日常实例）；
 * ② 仅 Chromium 内核（firefox/safari 前置拒绝 + 就绪 Browser 须含 'Chrome/'）；③ 启动失败不静默；
 * ④ chrome.debugPort ≠ mcp.browserUrl 端口 → 一行 warn。
 * 代理（V20261117014 ISSUE-3）：launchArgs 第四参 --proxy-server，优先级 CLI --proxy > env CHROMEUSE_BROWSER_PROXY
 * > config.proxy.httpProxy；皆空不追加（逐字节同旧版），state 只落脱敏值。
 * 生命周期：默认常驻（登录态在独立 profile）；stop() 显式关停（进程组信号 → 兜底 CDP Browser.close）。
 * config 走 lib/config.loadConfig()（--config 已支持）；测试可注入 opts.config / opts.stateFile。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const log = require('./log');
const platform = require('./platform');
const { loadConfig } = require('./config');
const { cdpErr, CdpClient } = require('./cdp-core'); // 只取错误构造与关停兜底；cdp-core 不 require 本文件

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_INTERVAL_MS = 500;
const STOP_GRACE_MS = 2000;
const SPAWN_CONFIRM_MS = 3000;
const PROBE_TIMEOUT_MS = 2000;
const NON_CHROMIUM_MESSAGE = 'Firefox 使用自有协议（RDP）、Safari 使用 WebKit inspector，均不兼容 CDP——仅支持 Chromium 内核浏览器（Chrome/Edge/Brave/Chromium 等）';
// 浏览器代理（V20261117014 ISSUE-3 / 用户裁定 b「config 留空、命令手动加参数」）：仅 Chromium 内核认 --proxy-server。
const PROXY_SCHEMES = Object.freeze(['http://', 'https://', 'socks5://']);
const PROXY_ENV_KEY = 'CHROMEUSE_BROWSER_PROXY';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 代理 URL 基础校验/归一：空/未设 → ''（=无代理）；前缀仅 http/https/socks5，含空白或不可解析 → fail-fast */
function normalizeProxyUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (!PROXY_SCHEMES.some((p) => lower.startsWith(p))) {
    throw cdpErr('usage', `代理 URL 须以 http:// / https:// / socks5:// 开头（实际 ${JSON.stringify(s)}）——例：--proxy http://127.0.0.1:7897`);
  }
  if (/\s/.test(s)) throw cdpErr('usage', `代理 URL 不得含空白字符（实际 ${JSON.stringify(s)}）`);
  try { new URL(s); } catch { throw cdpErr('usage', `代理 URL 无法解析（实际 ${JSON.stringify(s)}）`); }
  return s;
}

/**
 * 代理解析链（三级优先级，2026-11-17 用户裁定 b）：CLI `--proxy <url>` > env `CHROMEUSE_BROWSER_PROXY`
 * > config.proxy.httpProxy；三者皆空 → { url:'', source:'none' }（不追加 --proxy-server，行为与旧版逐字节同）。
 * 非空值一律 normalizeProxyUrl 校验——非法值 fail-fast（不静默回退下一级，避免用户误以为已生效）。
 * @returns {{url:string, source:'cli'|'env'|'config'|'none'}}
 */
function resolveProxySource(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const fromConfig = o.config && o.config.proxy && typeof o.config.proxy.httpProxy === 'string'
    ? o.config.proxy.httpProxy : '';
  const chain = [['cli', o.cliProxy], ['env', env[PROXY_ENV_KEY]], ['config', fromConfig]];
  for (const [source, raw] of chain) {
    const url = normalizeProxyUrl(raw);
    if (url) return { url, source };
  }
  return { url: '', source: 'none' };
}

/** 代理 URL 脱敏（state 落盘/输出用）：userinfo 段 → `***`（password 一并消除；无语义损失：host:port 保留） */
function redactProxyUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@');
}

/** 路径末段（同时认 / 与 \，两平台配置串都能判） */
function baseName(p) {
  const parts = String(p == null ? '' : p).trim().split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** 非 Chromium 特征：末段小写含 firefox/safari（msedge/brave/chrome 不命中） */
function isRejectedBrowserName(cmd) {
  const b = baseName(cmd).toLowerCase();
  return b.includes('firefox') || b.includes('safari');
}

/** user-data-dir 安全校验：true=拒绝（空值 / 末段='User Data'＝浏览器默认 profile 特征） */
function isUnsafeUserDataDir(dir) {
  const raw = String(dir == null ? '' : dir).trim();
  return raw === '' || baseName(raw).toLowerCase() === 'user data';
}

/** 就绪标识是否 Chromium 系（Chrome/HeadlessChrome/Edg/Brave 的 Browser 字段均含 'Chrome/'） */
function isChromiumVersion(text) { return String(text == null ? '' : text).includes('Chrome/'); }

/** URL 端口（非法/缺省 → null） */
function portOf(url) {
  try {
    const u = new URL(String(url).replace(/\/+$/, ''));
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch { return null; }
}

/** chrome 三键读取 + 校验（缺键/非法值不静默）；返回归一配置 */
function validateChromeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw cdpErr('usage', '未找到 config 实例：先 node install.js --init-config <linux|windows>，再填 chrome 三键（launchCommand/debugPort/userDataDir）');
  }
  const c = cfg.chrome && typeof cfg.chrome === 'object' ? cfg.chrome : null;
  if (!c) throw cdpErr('usage', 'config.jsonc 缺 "chrome" 节：launch 模式需要 chrome.launchCommand / chrome.debugPort / chrome.userDataDir 三键（形态见 config-template-*.jsonc）');
  const missing = ['launchCommand', 'debugPort', 'userDataDir'].filter((k) => c[k] === undefined || c[k] === null || c[k] === '');
  if (missing.length) throw cdpErr('usage', `config.jsonc 的 chrome 节缺键：${missing.join('、')}——launch 模式三键必须齐备`);
  const launchCommand = String(c.launchCommand).trim();
  const debugPort = Number(c.debugPort);
  const userDataDir = String(c.userDataDir).trim();
  if (!launchCommand) throw cdpErr('usage', 'chrome.launchCommand 为空——填可执行名（PATH/注册表解析）或绝对路径');
  if (isRejectedBrowserName(launchCommand)) {
    throw cdpErr('usage', `chrome.launchCommand 指向非 Chromium 内核浏览器（${launchCommand}）：${NON_CHROMIUM_MESSAGE}`);
  }
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw cdpErr('usage', `chrome.debugPort 须为 1~65535 的整数（实际 ${JSON.stringify(c.debugPort)}）`);
  }
  if (isUnsafeUserDataDir(userDataDir)) {
    throw cdpErr('usage', `chrome.userDataDir 不安全（${JSON.stringify(c.userDataDir)}）：launch 模式强制独立 profile——须为非空自建目录，且不得指向浏览器默认 profile（.../User Data）；绝不 attach/复用日常实例（Chrome 136+ 亦要求非默认 user-data-dir）`);
  }
  return { launchCommand, debugPort, userDataDir };
}

/** 就绪探测：GET http://127.0.0.1:<port>/json/version → {ok, versionText}（失败不抛，不静默成功） */
async function isReady(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : PROBE_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, versionText: '' };
    const j = await res.json();
    return { ok: true, versionText: String((j && j.Browser) || '') };
  } catch { return { ok: false, versionText: '' }; }
}

/** 端口错配检查（chrome.debugPort vs mcp.browserUrl）：命中返回一行 warn 文案，否则 null */
function portMismatchWarning(cfg, debugPort) {
  const url = cfg && cfg.mcp && typeof cfg.mcp.browserUrl === 'string' ? cfg.mcp.browserUrl.trim() : '';
  if (!url) return null;
  const p = portOf(url);
  if (!p || p === debugPort) return null;
  return `chrome.debugPort=${debugPort} 与 mcp.browserUrl 端口 ${p} 不一致——启动/复用后默认连接目标指向 ${p}，请对齐 config.mcp.browserUrl 或命令加 --url http://127.0.0.1:${debugPort}`;
}

/* ── state 单文件（tmpdata/browser/launch-state.json；原子写 tmp+rename） ── */

function readState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

function writeState(file, obj) {
  paths.ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function removeState(file) { try { fs.unlinkSync(file); } catch { /* 已不存在 */ } }

/** 等 spawn 确认：pid 已回填即成功；'error'（ENOENT 等）转可识别错误 */
function waitSpawn(child, timeoutMs, exePath) {
  if (!child) return Promise.resolve(null);
  if (child.pid) return Promise.resolve(child.pid);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.removeListener('spawn', onSpawn); child.removeListener('error', onError); };
    const timer = setTimeout(() => { cleanup(); reject(cdpErr('conn', `浏览器进程未在 ${timeoutMs}ms 内确认启动：${exePath}`)); }, timeoutMs);
    const onSpawn = () => { cleanup(); resolve(child.pid); };
    const onError = (e) => {
      cleanup();
      reject(cdpErr('conn', `浏览器进程启动失败：${((e && e.code) || '') + ' ' + ((e && e.message) || e)}`.trim(), { code: e && e.code, exe: exePath }));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** 轮询等就绪（超时返回末次探测结果，由调用方报错） */
async function waitReady(port, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  const step = Math.max(50, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  for (;;) {
    const probe = await isReady(port, Math.min(PROBE_TIMEOUT_MS, Math.max(200, deadline - Date.now())));
    if (probe.ok || Date.now() >= deadline) return probe;
    await sleep(step);
  }
}

/** 尽力清理半启动进程（不抛） */
function killQuietly(pid) {
  try { if (pid) platform().process.signalProcessGroup(pid, 'SIGTERM'); } catch { /* 尽力清理 */ }
}

/**
 * 幂等启动调试实例（端口已就绪 → reused:true，不重复拉起）。
 * @param {{config?:object, stateFile?:string, timeoutMs?:number, intervalMs?:number, spawnConfirmMs?:number}} [opts]
 */
async function ensure(opts) {
  const o = opts || {};
  const cfg = o.config !== undefined ? o.config : loadConfig();
  const c = validateChromeConfig(cfg);
  const proxy = resolveProxySource({ cliProxy: o.proxy, env: o.env, config: cfg });
  const stateFile = o.stateFile || paths.LAUNCH_STATE_FILE;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : DEFAULT_INTERVAL_MS;
  const state = readState(stateFile);

  const mismatch = portMismatchWarning(cfg, c.debugPort);
  if (mismatch) { try { log.warn('browser-launch', mismatch, { echo: true }); } catch { /* 日志失败不影响主流程 */ } }

  const existing = await isReady(c.debugPort, PROBE_TIMEOUT_MS);
  if (existing.ok) {
    if (!isChromiumVersion(existing.versionText)) {
      throw cdpErr('usage', `调试端口 ${c.debugPort} 已有非 Chromium 调试实例（Browser=${JSON.stringify(existing.versionText)}）：${NON_CHROMIUM_MESSAGE}`);
    }
    // --proxy 只影响新拉起的实例：已有实例复用时代理不生效。CLI/env 显式要求时提示（config 兜底常驻场景不刷屏）。
    if (proxy.url && proxy.source !== 'config') {
      try {
        log.warn('browser-launch', `现有实例已就绪，代理不作用于已启动实例（请求=${redactProxyUrl(proxy.url)}，state=${(state && state.proxy) || '无记录'}）——需先 --stop 再 browser-up --proxy`, { echo: true });
      } catch { /* 日志失败不影响主流程 */ }
    }
    return {
      reused: true, pid: state && Number.isInteger(state.pid) ? state.pid : null, port: c.debugPort,
      exe: (state && state.exe) || null, userDataDir: (state && state.userDataDir) || null,
      proxy: (state && state.proxy) || null, proxySource: (state && state.proxySource) || null,
      version: existing.versionText, stateFile,
    };
  }

  const found = platform().browser.findBrowserExe(c.launchCommand); // null = 未发现（下方给发现序说明）
  if (!found) {
    throw cdpErr('usage', `未找到浏览器可执行文件：${c.launchCommand}（发现序：① 绝对路径直通；② 平台发现——Linux=PATH→固定目录表 / Windows=App Paths 注册表→安装目录表→PATH；③ 全部未命中）——请把 chrome.launchCommand 改为绝对路径（Windows 例：C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe；Linux 例：/usr/bin/google-chrome）`);
  }

  const args = platform().browser.launchArgs(found.path, c.debugPort, c.userDataDir, proxy.url);
  let spawned;
  try { spawned = platform().browser.spawnBrowser(found.path, args); }
  catch (e) { throw cdpErr('conn', `浏览器进程启动失败：${(e && e.message) || e}`, { code: e && e.code, exe: found.path }); }
  const pid = spawned && spawned.pid;
  const child = spawned && spawned.child;
  if (child) child.unref(); // 常驻：本进程退出不影响浏览器（detached 进程组）
  await waitSpawn(child, Number.isFinite(o.spawnConfirmMs) ? o.spawnConfirmMs : SPAWN_CONFIRM_MS, found.path);

  const ready = await waitReady(c.debugPort, timeoutMs, intervalMs);
  if (!ready.ok) {
    killQuietly(pid);
    throw cdpErr('timeout', `浏览器已启动（pid=${pid}，exe=${found.path}）但调试端口 ${c.debugPort} 在 ${timeoutMs}ms 内未就绪——排查：① 端口被占用（Linux: lsof -i :${c.debugPort}；Windows: netstat -ano | findstr :${c.debugPort}）② userDataDir 被其它实例占用（profile 锁 SingletonLock）③ 浏览器/版本不支持 --remote-debugging-port`);
  }
  if (!isChromiumVersion(ready.versionText)) {
    killQuietly(pid);
    throw cdpErr('usage', `调试端口 ${c.debugPort} 返回非 Chromium 就绪标识（Browser=${JSON.stringify(ready.versionText)}）：${NON_CHROMIUM_MESSAGE}`);
  }

  const record = {
    pid, port: c.debugPort, exe: found.path, exeSource: found.source,
    launchCommand: c.launchCommand, userDataDir: c.userDataDir, startedAt: new Date().toISOString(),
  };
  if (proxy.url) { record.proxy = redactProxyUrl(proxy.url); record.proxySource = proxy.source; } // 脱敏落盘（凭据不入 state）
  writeState(stateFile, record);
  try { log.info('browser-launch', `已拉起调试实例 pid=${pid} port=${c.debugPort} exe=${found.path}（source=${found.source}；独立 profile=${c.userDataDir}，首次各网站需手动登录一次${proxy.url ? `；proxy=${redactProxyUrl(proxy.url)}（source=${proxy.source}）` : ''}）`); } catch { /* 日志失败不影响主流程 */ }
  return Object.assign({ reused: false, version: ready.versionText, stateFile }, record);
}

/** 端口是否已关闭（Browser.close 兜底确认） */
async function waitNotReady(port, timeoutMs) {
  if (!port) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isReady(port, 500)).ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/**
 * 显式关停：state.pid 进程组信号（SIGTERM → 宽限 → SIGKILL）；state 丢失/进程不在 → 兜底 CDP Browser.close。
 * @param {{config?:object, stateFile?:string, graceMs?:number, cdpTimeoutMs?:number}} [opts]
 * @returns {Promise<{stopped:boolean, method:'signal'|'cdp'|'none', pid:(number|null), signal?:string}>}
 */
async function stop(opts) {
  const o = opts || {};
  let cfg = null;
  try { cfg = o.config !== undefined ? o.config : loadConfig(); } catch { cfg = null; }
  const stateFile = o.stateFile || paths.LAUNCH_STATE_FILE;
  const state = readState(stateFile);
  const proc = platform().process;
  const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : STOP_GRACE_MS;

  if (state && Number.isInteger(state.pid) && state.pid > 0 && proc.alive(state.pid)) {
    const pid = state.pid;
    const sig = proc.signalProcessGroup(pid, 'SIGTERM');
    if (sig) {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && proc.alive(pid)) await sleep(100);
      if (!proc.alive(pid)) {
        removeState(stateFile);
        try { log.info('browser-launch', `已关停调试实例 pid=${pid}（SIGTERM/${sig}）`); } catch { /* 忽略 */ }
        return { stopped: true, method: 'signal', pid, signal: sig };
      }
      proc.signalProcessGroup(pid, 'SIGKILL');
      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline && proc.alive(pid)) await sleep(100);
      const gone = !proc.alive(pid);
      try { log.warn('browser-launch', `SIGTERM 宽限 ${graceMs}ms 未退出，已 SIGKILL pid=${pid}（gone=${gone}）`); } catch { /* 忽略 */ }
      if (gone) { removeState(stateFile); return { stopped: true, method: 'signal', pid, signal: 'SIGKILL' }; }
    }
  } else if (state) {
    removeState(stateFile); // 陈旧 state（进程已不在）：清掉，走兜底
  }

  // 兜底：CDP Browser.close（state 丢失/进程不在/信号无效）
  let port = state && Number.isInteger(Number(state.port)) ? Number(state.port) : null;
  if (!port && cfg && cfg.chrome && Number.isInteger(Number(cfg.chrome.debugPort))) port = Number(cfg.chrome.debugPort);
  let browserUrl = port ? `http://127.0.0.1:${port}` : '';
  if (!browserUrl) {
    const u = cfg && cfg.mcp && typeof cfg.mcp.browserUrl === 'string' ? cfg.mcp.browserUrl.trim() : '';
    browserUrl = u || platform().browser.defaultBrowserUrl();
  }
  const cdpTimeoutMs = Number.isFinite(o.cdpTimeoutMs) ? o.cdpTimeoutMs : 3000;
  const client = new CdpClient(browserUrl, { timeoutMs: cdpTimeoutMs });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    try { await client.send('Browser.close', {}, { timeoutMs: cdpTimeoutMs }); } catch { /* 浏览器关闭时 WS 先断，属预期 */ }
  } catch { /* 不可达 → 无可关停 */ }
  finally { try { await client.close(); } catch { /* 已断 */ } }
  if (!connected) return { stopped: false, method: 'none', pid: (state && state.pid) || null };
  const gone = await waitNotReady(portOf(browserUrl), 3000);
  if (state) removeState(stateFile);
  try { log.info('browser-launch', `兜底 CDP Browser.close 已发送（${browserUrl}；端口已关=${gone}）`); } catch { /* 忽略 */ }
  return { stopped: gone, method: 'cdp', pid: (state && state.pid) || null };
}

/**
 * 状态查询：state 文件 + 实时就绪探测。
 * @param {{config?:object, stateFile?:string, timeoutMs?:number}} [opts]
 */
async function status(opts) {
  const o = opts || {};
  let cfg = null;
  try { cfg = o.config !== undefined ? o.config : loadConfig(); } catch { cfg = null; }
  const state = readState(o.stateFile || paths.LAUNCH_STATE_FILE);
  let port = state && Number.isInteger(Number(state.port)) ? Number(state.port) : null;
  if (!port && cfg && cfg.chrome && Number.isInteger(Number(cfg.chrome.debugPort))) port = Number(cfg.chrome.debugPort);
  const probe = port ? await isReady(port, Number.isFinite(o.timeoutMs) ? o.timeoutMs : PROBE_TIMEOUT_MS) : { ok: false, versionText: '' };
  return { state, ready: probe.ok, version: probe.versionText || null, port };
}

module.exports = {
  ensure, stop, status, isReady,
  readState, writeState,
  _internals: Object.freeze({
    validateChromeConfig, isRejectedBrowserName, isUnsafeUserDataDir, isChromiumVersion,
    portOf, portMismatchWarning, waitSpawn, waitReady, NON_CHROMIUM_MESSAGE,
    normalizeProxyUrl, resolveProxySource, redactProxyUrl, PROXY_SCHEMES, PROXY_ENV_KEY,
    DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_MS, STOP_GRACE_MS,
  }),
};
