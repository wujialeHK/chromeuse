'use strict';
/*
 * chromeuse lib/platform/linux.js —— Linux 基准 impl（批0：binaries；批1：process）
 *
 * binaries 是本项目「平台差异」与「环境能力差异」分流后的第一个 provider：Windows 端不内置 ffmpeg，
 * .exe 后缀逻辑已被「能力探测」消解（无后缀 → 再试 .exe），故 Windows 零覆写、整层单实现。
 *
 * provider 语义（契约签名见 ./contract.js）：
 *   resolve()        解析序 config.bin 显式路径（相对=skill 根基准、绝对=原样）> 内置 bin/（含 .exe）> none+hint；不碰 spawn。
 *   probeVersion(b)  文件在位 AND spawnSync -version（5s 超时，stdio:ignore）exit 0；进程级缓存
 *                    （沿 lib/scroll-shot.js 2026-10-28 ISSUE-4 语义——只判 existsSync 会误判损坏文件）。
 * 行为边界：缺失绝不假装成功（调用方如实降级）；不做 PATH/系统 ffmpeg 回退（2026-10-28 裁定）。
 * process 语义（批1）：procState/procCmdline/procStartMs = /proc 探针（失败 null=不可验证）；
 *   alive = kill0 + 非僵尸；signalProcessGroup = 整组 kill(-pid) 优先、落回单 pid。
 * 纪律：impl 内部互调一律 `this.`（Windows 覆写后原型链 this 查找才能命中覆写版）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const paths = require('../paths');
const log = require('../log');

const BIN_DIR = path.join(paths.SKILL_ROOT, 'bin');
const SKILL_ROOT = path.dirname(BIN_DIR);
const PROBE_TIMEOUT_MS = 5000;
const DOWNLOAD_HINT = '下载：https://ffmpeg.org/download.html（Windows 构建：https://www.gyan.dev/ffmpeg/builds/）';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** config.jsonc 的 bin 节（缺实例/坏实例/坏键一律容错为 {}——平台层加载失败绝不拖垮整个 CLI） */
function binConfig() {
  try {
    const { loadConfig } = require('../config'); // 惰性：lib/config.js 仅依赖 path+jsonc，无循环风险
    const cfg = loadConfig();
    const bin = cfg && cfg.bin;
    return bin && typeof bin === 'object' ? bin : {};
  } catch (e) {
    try { log.warn('platform', `config.bin 读取失败，回落内置 bin/ 探测：${e.message}`); } catch { /* 日志失败不影响主流程 */ }
    return {};
  }
}

/** 显式路径采信：绝对路径原样；相对路径按 baseDir（默认 skill 根）解析——基准固定、与 cwd 无关（防 cwd 漂移）；
 *  空串/非字符串忽略。 */
function explicitPath(v, key, baseDir) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const raw = v.trim();
  if (path.isAbsolute(raw)) return raw;
  const p = path.resolve(baseDir || SKILL_ROOT, raw);
  try { log.info('platform', `config.bin.${key} 相对路径按 skill 根解析：${raw} → ${p}`); } catch { /* 日志失败不影响主流程 */ }
  return p;
}

/** 内置 bin/ 探测：平台原生名优先（Windows .exe / Linux 无后缀），再试另一形态（Windows 用户自行放置
 *  ffmpeg.exe 的兼容口）；缺失返回期望路径供指引引用（Windows 给 .exe——与迁移前 ffmpegBins 语义等价）。 */
function builtinBin(binDir, name, exists) {
  const native = path.join(binDir, name);
  const exe = native + '.exe';
  const order = process.platform === 'win32' ? [exe, native] : [native, exe];
  for (const p of order) if (exists(p)) return { path: p, found: true };
  return { path: order[0], found: false };
}

/**
 * 解析纯函数（selftest #133 直测；注入 binDir/skillRoot/fileExists 免真实 ffmpeg）。
 * @param {{configBin?:object, binDir?:string, skillRoot?:string, fileExists?:(p:string)=>boolean}} [opts]
 *   skillRoot = 相对路径基准（默认 skill 根目录；selftest 注入隔离根，不碰真实 skill）
 * @returns {{ffmpeg:string, ffprobe:string, source:'config'|'builtin'|'none',
 *            exists:{ffmpeg:boolean, ffprobe:boolean}, hint:(string|null)}}
 */
function resolveBinaries(opts) {
  const o = opts || {};
  const cfg = o.configBin && typeof o.configBin === 'object' ? o.configBin : {};
  const binDir = o.binDir || BIN_DIR;
  const skillRoot = o.skillRoot || SKILL_ROOT;
  const exists = typeof o.fileExists === 'function' ? o.fileExists : isFile;
  const cfgFfmpeg = explicitPath(cfg.ffmpegPath, 'ffmpegPath', skillRoot);
  const cfgFfprobe = explicitPath(cfg.ffprobePath, 'ffprobePath', skillRoot);
  const builtinFfmpeg = builtinBin(binDir, 'ffmpeg', exists);
  const builtinFfprobe = builtinBin(binDir, 'ffprobe', exists);
  const ffmpeg = cfgFfmpeg || builtinFfmpeg.path;
  const ffprobe = cfgFfprobe || builtinFfprobe.path;
  const found = { ffmpeg: exists(ffmpeg), ffprobe: exists(ffprobe) };
  const source = (cfgFfmpeg || cfgFfprobe) ? 'config'
    : (builtinFfmpeg.found || builtinFfprobe.found) ? 'builtin' : 'none';
  let hint = null;
  if (!found.ffmpeg || !found.ffprobe) {
    const missing = [];
    if (!found.ffmpeg) missing.push('ffmpeg');
    if (!found.ffprobe) missing.push('ffprobe');
    const parts = [`缺 ${missing.join('/')}`];
    parts.push(`① 把 ${missing.map((m) => `${m}（Windows 用 ${m}.exe）`).join('、')} 放入 ${binDir}/`);
    parts.push(`② 或在 config.jsonc 的 "bin" 节填 ${missing.map((m) => (m === 'ffmpeg' ? 'ffmpegPath' : 'ffprobePath')).join('/')} 路径（相对=skill 根基准，如 bin/ffmpeg；绝对=已安装地址，如 C:\\ffmpeg\\bin\\ffmpeg.exe）`);
    parts.push(DOWNLOAD_HINT);
    if ((cfgFfmpeg && !found.ffmpeg) || (cfgFfprobe && !found.ffprobe)) parts.push('config.bin 指定路径不存在，请核对');
    parts.push('不做 PATH/系统 ffmpeg 回退（bin/ 单点真源，2026-10-28 裁定）');
    hint = parts.join('；');
  }
  return { ffmpeg, ffprobe, source, exists: found, hint };
}

/** 探活缓存（进程级单例，收敛在本 provider 内部——委托 impl 不复制状态） */
const probeCache = new Map();

/** 真探活：在位 + `-version` exit 0；5s 超时防挂；同路径结果缓存一次 */
function probeVersion(bin) {
  if (typeof bin !== 'string' || bin === '') return false;
  if (probeCache.has(bin)) return probeCache.get(bin);
  let ok = false;
  try {
    if (isFile(bin)) {
      const r = spawnSync(bin, ['-version'], { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' });
      ok = !!r && r.status === 0;
    }
  } catch { ok = false; }
  probeCache.set(bin, ok);
  return ok;
}

/* ── process provider（批1，V20261117002）：/proc 三探针 + 进程存活 + 进程组信号 ──
 * 实现自 lib/jobs.js（readProcState :171-180 / processAlive :182-188 / readProcCmdline :190-196 /
 * readProcStartMs :198-214 / signalProcessGroup 非 win32 分支 :515-523）原样迁入，语义逐字沿用：
 * EPERM=存在但不同用户（按存活）、僵尸 Z=死、USER_HZ=100 偏差可接受。
 * 平台分支改由 impl 选择承担——本文件不再出现 process.platform 判断（platform/index.js 负责选 impl）。
 * 纪律：alive() 内互调一律 this.procState()——Windows 覆写 procState 返 null 后，继承的 alive 经原型链
 * 自动命中覆写版（kill0 通 + null !== 'Z' = true，与迁移前 win32 行为逐字等价）。 */

/** 读 /proc/<pid>/stat 的进程状态字符（Z=僵尸；失败 null） */
function procState(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    return raw.slice(close + 2).trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

/** pid 是否存活（EPERM=存在但不同用户，按存活处理；僵尸 Z 视为已死——未收割的 kill -9 子进程不得误判存活） */
function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch (e) { if (!(e && e.code === 'EPERM')) return false; }
  return this.procState(n) !== 'Z';
}

/** 读 /proc/<pid>/cmdline（失败返回 null=不可验证） */
function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch { return null; }
}

/** 读 /proc/<pid> 启动时刻（epoch ms；失败 null）——用 /proc/stat btime + stat 第 22 字段 */
function procStartMs(pid) {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const bt = /^btime\s+(\d+)$/m.exec(stat);
    if (!bt) return null;
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const rest = raw.slice(close + 2).trim().split(/\s+/); // rest[0]=state（总第 3 字段）
    const startTicks = Number(rest[19]); // 总第 22 字段（starttime）
    if (!Number.isFinite(startTicks)) return null;
    const hz = 100; // 容器/主流 Linux USER_HZ；偏差只影响 120s 级判定，可接受
    return Number(bt[1]) * 1000 + (startTicks * 1000) / hz;
  } catch { return null; }
}

/** 进程组信号：先整组 kill(-pid)（spawn detached 的作业进程组），失败落回单 pid；全失败 null */
function signalProcessGroup(pid, signal) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try { process.kill(-n, signal); return 'group'; } catch { /* 落回单 pid */ }
  try { process.kill(n, signal); return 'pid'; } catch { return null; }
}

/* ── browser provider（批2，V20261117003）：默认 browserUrl / NAS 服务名提示 / 录制 beacon 基址 / 冻结恢复命令 ──
 * 来源（语义/文案逐字沿用，只挪位置）：
 *   defaultBrowserUrl ← lib/cdp-core.js resolveBrowserUrl 默认值（http://127.0.0.1:9222，两平台相同）
 *   nasServiceHint    ← lib/cdp-core.js nasBrowserUrlHint 非 win32 分支（Windows 文案在 windows.js 覆写）
 *   beaconBase        ← lib/record.js beaconBaseFor 的 Linux 分支（容器网络内以服务名互访）
 *   manualRestartHint ← tools/cdp.js printFreezeReport 两行原文（含原始缩进=console 版式，逐字节直出；
 *     V20261117008 批C2 第二行尾追加「（或 `node tools/cdp.js browser-up`）」——合法演化，#135② 断言同批更新）
 * NAS 服务名判定是平台无关纯函数（两平台同值），实现单源在本文件：windows impl 与 cdp-core 都从此复用。 */
const NAS_SERVICE_HOSTNAMES = ['chrome-browser'];

/** URL 主机名（尾斜杠修剪后解析；非法 URL → ''，不抛） */
function browserUrlHostname(url) {
  try { return new URL(String(url || '').replace(/\/+$/, '')).hostname.toLowerCase(); } catch { return ''; }
}

/** NAS 容器服务名判定（主机名精确匹配：子域不算） */
function isNasServiceBrowserUrl(url) {
  return NAS_SERVICE_HOSTNAMES.includes(browserUrlHostname(url));
}

/** 默认 browserUrl（CLI/config 均缺省时）：本机 9222——两平台相同 */
function defaultBrowserUrl() { return 'http://127.0.0.1:9222'; }

/** NAS 服务名误配提示（Linux 文案：本机 --url/改 config；无命中 null） */
function nasServiceHint(browserUrl) {
  if (!isNasServiceBrowserUrl(browserUrl)) return null;
  return '检测到 NAS 服务名 browserUrl（chrome-browser）——非容器网络内无法解析；本机请改 config.jsonc 的 mcp.browserUrl（如 http://127.0.0.1:9222）或 --url 显式指定';
}

/** 录制 beacon 基址（Linux：容器网络内 opencode 服务名） */
function beaconBase(port) { return 'http://opencode:' + port; }

/** 冻结恢复命令两行（人工执行；含原始缩进——printFreezeReport 逐字节直出） */
function manualRestartHint() {
  return [
    '         NAS：coding-envs 项目内 docker compose restart chrome-browser（务必精确到服务名）',
    '         桌面端：taskkill /F /IM chrome.exe 后带 --remote-debugging-port 与 --user-data-dir 重启（或 `node tools/cdp.js browser-up`）',
  ];
}

/* ── browser launch 三方法（批C1/R2，V20261117007）：发现 exe / 参数 / spawn ──
 * 平台差异只有「发现」：Linux=绝对→PATH→固定目录表；Windows 覆写为绝对→App Paths 注册表→目录表→PATH。
 * launchArgs 是平台无关纯函数（两平台同构；第四参 proxy 可选，仅追加 --proxy-server）；spawnBrowser 统一
 * detached+ignore+windowsHide（Linux 忽略 windowsHide 无害），禁 shell:true（args 数组不经 shell，路径空格安全）。 */

/** 固定目录表（已安装 Chromium 浏览器的兜底发现；Chrome 优先，随后 Edge/Brave/Chromium） */
const BROWSER_PATH_TABLE = Object.freeze([
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/brave-browser',
  '/usr/bin/brave-browser-stable',
  '/opt/google/chrome/chrome',
  '/opt/microsoft/msedge/msedge',
  '/opt/brave.com/brave/brave',
]);

/** POSIX 可执行文件判定（普通文件 + 任一执行位；Windows impl 用自己的 isFile 覆写校验） */
function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

/**
 * 发现浏览器可执行文件（契约 browser.findBrowserExe）。
 * 发现序：① 绝对路径 / 带分隔符相对路径 → 直通+存在校验；② PATH 遍历；③ 固定目录表。未命中 → null。
 * @param {string} launchCommand 可执行名（PATH/目录表解析）或绝对路径
 * @param {{fileExists?:(p:string)=>boolean, pathEnv?:string, table?:string[]}} [opts] 仅供测试注入
 * @returns {{path:string, source:'abs'|'path'|'table'}|null}
 */
function findBrowserExe(launchCommand, opts) {
  const raw = String(launchCommand == null ? '' : launchCommand).trim();
  if (!raw) return null;
  const o = opts || {};
  const exists = typeof o.fileExists === 'function' ? o.fileExists : isExecutableFile;
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    const abs = path.resolve(raw);
    return exists(abs) ? { path: abs, source: 'abs' } : null;
  }
  const pathEnv = o.pathEnv !== undefined ? o.pathEnv : process.env.PATH;
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, raw);
    if (exists(p)) return { path: p, source: 'path' };
  }
  const table = Array.isArray(o.table) ? o.table : BROWSER_PATH_TABLE;
  for (const p of table) if (exists(p)) return { path: p, source: 'table' };
  return null;
}

/** launch 参数（平台无关纯函数）：调试端口 + 独立 profile + 首启抑制；exePath 目前不参与（保留按品牌扩展位）。
 *  proxy 可选第四参（V20261117014 ISSUE-3）：非空 → 尾部追加 `--proxy-server=<url>`（仅 Chromium 内核认）；
 *  空/缺省 → 输出与旧版逐字节相同（零回归硬要求）。 */
function launchArgs(exePath, port, userDataDir, proxy) {
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const p = typeof proxy === 'string' ? proxy.trim() : '';
  if (p) args.push('--proxy-server=' + p);
  return args;
}

/**
 * spawn 浏览器（契约 browser.spawnBrowser）：detached 独立进程组 + stdio ignore + 无窗口；unref 归调用方。
 * 同步异常转可识别 Error（带 code）；异步 ENOENT 经 child 'error' 事件由调用方收口。
 * @returns {{pid:(number|undefined), child:import('node:child_process').ChildProcess}}
 */
function spawnBrowser(exePath, args) {
  try {
    const child = spawn(exePath, Array.isArray(args) ? args : [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    return { pid: child.pid, child };
  } catch (e) {
    const err = new Error(`浏览器进程启动失败：${(e && e.message) || e}`);
    err.code = (e && e.code) || 'ESPAWN';
    throw err;
  }
}

const IMPL = Object.freeze({
  binaries: Object.freeze({
    resolve: () => resolveBinaries({ configBin: binConfig(), binDir: BIN_DIR }),
    probeVersion,
  }),
  process: Object.freeze({ procState, procCmdline, procStartMs, alive, signalProcessGroup }),
  browser: Object.freeze({ defaultBrowserUrl, nasServiceHint, beaconBase, manualRestartHint, findBrowserExe, launchArgs, spawnBrowser }),
});

module.exports = {
  impl: IMPL,
  isNasServiceBrowserUrl, // 平台无关纯函数（windows impl 与 cdp-core 复用单源）
  _internals: Object.freeze({
    resolveBinaries, explicitPath, binConfig, builtinBin, BIN_DIR, SKILL_ROOT, PROBE_TIMEOUT_MS,
    findBrowserExe, launchArgs, spawnBrowser, BROWSER_PATH_TABLE, isExecutableFile,
  }),
};
