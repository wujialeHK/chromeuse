'use strict';
/*
 * chromeuse lib/platform/windows.js —— Windows impl（批0：零覆写；批1：process 四方法覆写）
 *
 * 委托链：Object.create(linux.impl) 原型委托——Windows 未覆写的方法自动继承 Linux 基准实现；
 * 覆写 = 自有属性，Object.getOwnPropertyNames(impl) 即「覆写清单」（与 OVERRIDES 声明互为机检）。
 *
 * 批1 process 覆写（语义与迁移前 lib/jobs.js 的 `process.platform` 分支逐字等价）：
 *   procState/procCmdline/procStartMs → 恒 null（Windows 无 /proc = 探针不可验证，调用方按降级处理）
 *   signalProcessGroup → 单 pid process.kill（'pid' / null）；不做进程组 kill（无 POSIX 进程组语义）
 *   alive → **不覆写**：继承 Linux（kill0 + `this.procState() !== 'Z'`）；Windows 下 procState 覆写返
 *           null → `null !== 'Z'` = true，与迁移前 win32 行为（kill0 通即存活）逐字等价。
 *
 * 实现注意：Linux 方法表已 Object.freeze，原型上的同名数据属性不可写——覆写不能用赋值（[[Set]] 会被
 * 继承的非可写属性拦下抛 TypeError），必须用 Object.create 的属性描述符 / Object.defineProperty
 * 定义自有属性；全部先加覆写、后 Object.freeze（freeze 后无法新增属性）。
 * 批2 browser 覆写（V20261117003，文案/语义逐字沿用迁移前 win32 分支）：
 *   nasServiceHint → Windows 版指引（--init-config windows / 本机 9222）；NAS 判定复用 Linux 基准 impl 的纯函数
 *   beaconBase     → 'http://127.0.0.1:<port>'（桌面端无容器网络，beacon 走本机回环）
 *   defaultBrowserUrl / manualRestartHint → **不覆写**：继承 Linux（两平台同值）。
 * 批C1 browser 覆写（V20261117007，launch 模式）：
 *   findBrowserExe → Windows 发现序（见下方小节；唯一必需覆写——安装器不加 PATH 且 Node 不查注册表）
 *   spawnBrowser / launchArgs → **不覆写**：继承 Linux 基准（参数同构 + 统一 detached/ignore/windowsHide）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const linux = require('./linux');
const { isNasServiceBrowserUrl } = linux;

/** 普通文件判定（Windows 语义无执行位，isFile 即可；测试注入 fileExists） */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/* ── browser launch 发现序（批C1）：绝对路径 → App Paths 注册表 → 安装目录表 → PATH ──
 * 禁 shell:true 由继承的 spawnBrowser 承担（args 数组不经 shell）；注册表查询失败一律静默继续
 * （未装/权限不足/键不存在都是常态，不是错误）。 */

/** 环境变量读取（大小写不敏感：Windows env 键大小写不固定，Linux 上测试注入也走同一路径） */
function envVal(env, name) {
  const e = env || {};
  const want = String(name).toLowerCase();
  for (const k of Object.keys(e)) if (k.toLowerCase() === want) return e[k];
  return '';
}

/** App Paths 注册表键（HKCU 用户级优先，再 HKLM 机器级） */
function appPathKeys(exeName) {
  return [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
}

/** 安装目录表（%ProgramFiles% / %ProgramFiles(x86)% / %LOCALAPPDATA% 展开；Chrome 优先） */
function browserTable(env) {
  const roots = [
    envVal(env, 'ProgramFiles') || 'C:\\Program Files',
    envVal(env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)',
    envVal(env, 'LOCALAPPDATA'),
  ].filter(Boolean);
  const rels = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'Chromium\\Application\\chrome.exe',
  ];
  const out = [];
  for (const root of roots) for (const rel of rels) out.push(path.win32.join(root, rel));
  return out;
}

/** reg query 输出解析（纯函数，selftest fixture 直测）：优先 (Default) 的 REG_SZ/REG_EXPAND_SZ 值，否则首个 */
function parseAppPathsRegOutput(stdout) {
  let fallback = null;
  for (const line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const m = /^\s*(\(Default\)|.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^"|"$/g, '').trim();
    if (!v) continue;
    if (/^\(Default\)$/i.test(m[1].trim())) return v;
    if (!fallback) fallback = v;
  }
  return fallback;
}

/** App Paths 查询（reg.exe 系统自带；3s 超时；失败静默 null） */
function queryAppPath(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], {
      timeout: 3000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseAppPathsRegOutput(out);
  } catch { return null; }
}

/**
 * Windows 发现浏览器可执行文件（契约 browser.findBrowserExe 覆写）。
 * 发现序：① 绝对/带分隔符路径直通；② App Paths 注册表；③ 安装目录表；④ PATH。未命中 → null。
 * @param {string} launchCommand
 * @param {{fileExists?:(p:string)=>boolean, env?:object, regQuery?:(key:string)=>string|null, table?:string[]|((env:object)=>string[])}} [opts] 仅供测试注入
 * @returns {{path:string, source:'abs'|'app-paths'|'table'|'path'}|null}
 */
function findBrowserExe(launchCommand, opts) {
  const raw = String(launchCommand == null ? '' : launchCommand).trim();
  if (!raw) return null;
  const o = opts || {};
  const exists = typeof o.fileExists === 'function' ? o.fileExists : isFile;
  const env = o.env || process.env;
  if (path.win32.isAbsolute(raw) || raw.includes('\\') || raw.includes('/')) {
    const abs = path.win32.isAbsolute(raw) ? raw : path.win32.resolve(raw);
    if (exists(abs)) return { path: abs, source: 'abs' };
    if (!/\.exe$/i.test(abs) && exists(abs + '.exe')) return { path: abs + '.exe', source: 'abs' };
    return null;
  }
  const exe = /\.exe$/i.test(raw) ? raw : raw + '.exe';
  const reg = typeof o.regQuery === 'function' ? o.regQuery : queryAppPath;
  for (const key of appPathKeys(exe)) {
    const hit = reg(key);
    if (hit && exists(hit)) return { path: hit, source: 'app-paths' };
  }
  const table = Array.isArray(o.table) ? o.table : (typeof o.table === 'function' ? o.table(env) : browserTable(env));
  for (const p of table) if (exists(p)) return { path: p, source: 'table' };
  const pathEnv = envVal(env, 'PATH');
  for (const rawDir of String(pathEnv || '').split(';')) {
    const dir = String(rawDir || '').trim().replace(/^"|"$/g, ''); // PATH 条目常被引号包裹（含空格目录）
    if (!dir) continue;
    const p = path.win32.join(dir, exe);
    if (exists(p)) return { path: p, source: 'path' };
  }
  return null;
}

/** process 域：原型委托 Linux 基准表 + 自有覆写（描述符定义，冻结前完成） */
const PROCESS = Object.create(linux.impl.process, {
  procState: { value: () => null, enumerable: true },    // Windows 无 /proc：探针不可验证
  procCmdline: { value: () => null, enumerable: true },
  procStartMs: { value: () => null, enumerable: true },
  // 单 pid 信号（等价迁移前 win32 分支：跳过 kill(-pid) 组信号）；非法 pid 安全返 null
  signalProcessGroup: {
    value: (pid, signal) => {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return null;
      try { process.kill(n, signal); return 'pid'; } catch { return null; }
    },
    enumerable: true,
  },
});
Object.freeze(PROCESS);

/** browser 域：原型委托 Linux 基准表 + 自有覆写（提示文案/beacon 基址；默认 URL 与恢复文案继承） */
const BROWSER = Object.create(linux.impl.browser, {
  // Windows 版 NAS 服务名提示（文案逐字节沿用迁移前 win32 分支）；NAS 判定复用平台无关纯函数
  nasServiceHint: {
    value: (browserUrl) => {
      if (!isNasServiceBrowserUrl(browserUrl)) return null;
      return '检测到 NAS 服务名 browserUrl（chrome-browser）——Windows 端请 node install.js --init-config windows，或手改 config.jsonc 的 mcp.browserUrl 为 http://127.0.0.1:9222';
    },
    enumerable: true,
  },
  beaconBase: { value: (port) => 'http://127.0.0.1:' + port, enumerable: true },
  // Windows 发现序覆写（App Paths 注册表 → 安装目录表 → PATH；唯一必需覆写）
  findBrowserExe: { value: findBrowserExe, enumerable: true },
});
Object.freeze(BROWSER);

const IMPL = Object.create(linux.impl, {
  process: { value: PROCESS, enumerable: true }, // binaries/browser 之外其余域继续原型委托
  browser: { value: BROWSER, enumerable: true },
});
Object.freeze(IMPL);

module.exports = {
  impl: IMPL,
  // 覆写键清单（domain.method 形式）；selftest #133/#134/#135 断言「覆写清单 === OVERRIDES」
  OVERRIDES: Object.freeze([
    'process.procState',
    'process.procCmdline',
    'process.procStartMs',
    'process.signalProcessGroup',
    'browser.nasServiceHint',
    'browser.beaconBase',
    'browser.findBrowserExe',
  ]),
  // 测试注入面（纯函数直测：注册表输出解析/目录表展开；不真跑 reg）
  _internals: Object.freeze({ findBrowserExe, parseAppPathsRegOutput, browserTable, appPathKeys, queryAppPath, isFile }),
};
