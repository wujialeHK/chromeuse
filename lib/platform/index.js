'use strict';
/*
 * chromeuse lib/platform/index.js —— 平台层单例入口（批0：binaries；批1：process；批2：browser；契约/分域见 contract.js）
 *
 * 判定序（双真源归一）：config.environment 显式声明（linux|windows）> process.platform 推断
 * （win32→windows，其余→linux）。config 读取失败/无实例一律容错回落 process.platform——
 * 平台层加载失败绝不拖垮整个 CLI（沿 lib/record.js:101 的惰性 try/catch 形态）。
 *
 * 调用面：
 *   const platform = require('./platform');
 *   platform().binaries.resolve()   // 契约域方法（batches 扩展自动透出）
 *   platform().process.alive(pid)   // 批1：/proc 探针/存活/进程组信号
 *   platform().browser.nasServiceHint(url) // 批2：默认 URL/NAS 提示/beacon 基址/冻结恢复文案
 *   platform.platformName()         // 'linux' | 'windows'
 * 日志：首次构造一行 platform=<name> impl覆写=[...]（走 lib/log.js；排障时「走了哪个 impl」直接可读）。
 *
 * ⚠ 惰性化（V20261117005 批B/R3）：判定/自检/冻结 API 从**模块加载期**推迟到**首次 platform() 调用**
 *   （闭包缓存单例，Object.freeze 语义不变）——根治「CLI 全局 --config 切换实例后 platform 已按旧实例
 *   定死」的时序硬点：cdp.js 顶部 pre-parse 先 setConfigPath，命令执行期首次调用即按新实例 environment 定。
 *   现有调用点只拿函数引用（cdp-core/jobs/record 等），首次真实调用都在命令执行期，行为零变化。
 *   config.environment 与物理平台不一致**允许**（跨平台语义测试=合法用法）但打一行 warn 显性提示。
 */
const log = require('../log');
const { CONTRACT, assertImpl } = require('./contract');
const linux = require('./linux');
const windows = require('./windows');

/** 平台名归一纯函数（selftest #133 注入直测）：config.environment 显式优先，process.platform 兜底 */
function detectPlatform(configEnv, nodePlatform) {
  if (configEnv === 'linux' || configEnv === 'windows') return configEnv;
  return nodePlatform === 'win32' ? 'windows' : 'linux';
}

/** config.environment 读取（容错：任何异常只告警并回落，绝不抛给调用方） */
function readEnvName() {
  try {
    const { loadConfig } = require('../config'); // 惰性：lib/config.js 仅依赖 path+jsonc，无循环风险
    const cfg = loadConfig();
    return cfg && typeof cfg.environment === 'string' ? cfg.environment : null;
  } catch (e) {
    try { log.warn('platform', `config.environment 读取失败，回落 process.platform 推断：${e.message}`); } catch { /* 日志失败不影响主流程 */ }
    return null;
  }
}

/** 首次调用时构造（闭包缓存）：判定 → 契约自检 → 冻结门面 → 日志 */
function build() {
  const NAME = detectPlatform(readEnvName(), process.platform);
  const MODULE = NAME === 'windows' ? windows : linux;

  assertImpl(MODULE.impl, NAME); // 首次构造时契约自检：缺键即抛（开发期 fail-fast，仍在任何平台方法使用前）

  /* 单例门面：name/impl/OVERRIDES + 契约域方法平铺（platform().binaries.resolve() 形态）。
   * linux（基准 impl）无 OVERRIDES 导出 → 归一为空清单。 */
  const OVERRIDES = MODULE.OVERRIDES || Object.freeze([]);
  const API = { name: NAME, impl: MODULE.impl, OVERRIDES };
  for (const domain of Object.keys(CONTRACT)) API[domain] = MODULE.impl[domain];
  Object.freeze(API);

  /* config.environment 与物理平台不一致：合法用法（跨平台行为测试/临时实例），一行 warn 显性说明语义 */
  const physical = process.platform === 'win32' ? 'windows' : 'linux';
  if (NAME !== physical) {
    try {
      log.warn('platform', `config.environment=${NAME} 与物理平台 ${physical} 不一致——正以 ${NAME} 语义运行（PATH/exe 探测按 ${NAME} 规则；跨平台测试/临时实例合法用法）`, { echo: true });
    } catch { /* 日志失败不影响主流程 */ }
  }
  try { log.info('platform', `platform=${NAME} impl覆写=[${OVERRIDES.join(',')}]`); } catch { /* 日志失败不影响主流程 */ }

  return { API, NAME, MODULE };
}

let cached = null; // 惰性单例（首次 platform()/platformName()/impl() 时构建一次）
function state() { if (!cached) cached = build(); return cached; }

function platform() { return state().API; }
platform.platformName = () => state().NAME;
platform.impl = () => state().MODULE.impl;
platform.detectPlatform = detectPlatform;
platform.CONTRACT = CONTRACT;

module.exports = platform;
