'use strict';
/*
 * chromeuse lib/config.js —— config.jsonc 加载 + 代理解析链（v6 模板实例模型）
 *
 * - 默认实例 = 本目录（skill 源/装机目录）的 config.jsonc；实例缺失返回 null（不报错，由调用方提示 --init-config）
 * - 解析经 lib/jsonc（四态状态机），schemaVersion 校验 fail-fast
 * - effectiveProxy 解析链：config.proxy.httpProxy 显式值（非空串）→ 环境变量 HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy → ALL_PROXY → all_proxy → null（无代理）
 * - effectiveNoProxy：config.proxy.noProxy 显式值；为空且代理生效 → 强制下限 "localhost,127.0.0.1"（逃生舱 beacon 必须绕代理）
 * - 无 detect、无深合并（v6：模板实例化模型，detect 循环已删）
 * - 动态实例（V20261117005 批B）：CLI 全局 `--config <path>` 由 tools/cdp.js 顶部 pre-parse（首个 lib
 *   require 之前）调 setConfigPath 单点落地——相对路径按**当刻 cwd** 解析；设后立即试读（不存在/坏 → throw
 *   由入口 die，绝不静默回落主实例）。loadConfig() 签名不变，9 个业务消费点零改动；
 *   install.js（部署域）不接 --config、从不调 setConfigPath（默认实例路径语义不变；显式 env 属用户主动行为）。
 *   CHROMEUSE_CONFIG_PATH 仅供子进程继承（jobs --async 的 child 从父进程 env 拿同一实例的绝对路径）；
 *   显式 setConfigPath 优先，无 --config/env 时恒等于默认实例（行为零变化）。
 */
const path = require('node:path');
const { readConfig } = require('./jsonc');

/** 默认实例路径（skill 源/装机目录，语义固定——不随 --config 变） */
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.jsonc');

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const NO_PROXY_FLOOR = 'localhost,127.0.0.1';

/** 当前生效实例（可变单例）：env 继承值 > 默认；显式 setConfigPath 可再覆盖 */
let CONFIG_PATH = (() => {
  const raw = process.env.CHROMEUSE_CONFIG_PATH;
  return raw ? path.resolve(process.cwd(), raw) : DEFAULT_CONFIG_PATH;
})();

/**
 * 切换生效实例（--config 入口单点）：相对 → cwd 绝对；设后立即试读一次
 * （不存在/无法解析/schemaVersion 非法 → throw，由调用方 fail-fast exit 1）。
 * 同时写 CHROMEUSE_CONFIG_PATH 供子进程（jobs --async）继承同一实例。
 */
function setConfigPath(p) {
  const abs = path.resolve(process.cwd(), String(p));
  if (!fsExists(abs)) throw new Error(`文件不存在：${abs}`);
  readConfig(abs); // 解析 + schemaVersion 校验（坏 JSONC → throw）
  CONFIG_PATH = abs;
  process.env.CHROMEUSE_CONFIG_PATH = abs;
  return abs;
}

/** 当前生效实例路径（绝对） */
function configPath() { return CONFIG_PATH; }

/** 恢复默认实例（selftest/测试钩子；同批清 env 继承值，防子进程串味） */
function resetConfigPath() {
  CONFIG_PATH = DEFAULT_CONFIG_PATH;
  delete process.env.CHROMEUSE_CONFIG_PATH;
  return CONFIG_PATH;
}

/** 加载当前生效实例；不存在返回 null；存在但坏 → 抛错（调用方 fail-fast exit 1） */
function loadConfig() {
  if (!fsExists(CONFIG_PATH)) return null;
  return readConfig(CONFIG_PATH);
}

function fsExists(p) {
  try { return require('node:fs').statSync(p).isFile(); } catch { return false; }
}

/** 代理解析链；返回 URL 字符串或 null（=无代理） */
function effectiveProxy(config, env) {
  env = env || process.env;
  const explicit = config && config.proxy && typeof config.proxy.httpProxy === 'string'
    ? config.proxy.httpProxy.trim() : '';
  if (explicit !== '') return explicit;
  for (const k of PROXY_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** noProxy：显式值优先；空且代理生效 → 强制下限；空且无代理 → 空串 */
function effectiveNoProxy(config, env) {
  env = env || process.env;
  const raw = config && config.proxy && typeof config.proxy.noProxy === 'string'
    ? config.proxy.noProxy.trim() : '';
  if (raw !== '') return raw;
  if (effectiveProxy(config, env)) return NO_PROXY_FLOOR;
  return '';
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  CONFIG_PATH: DEFAULT_CONFIG_PATH, // 历史别名=默认实例路径（动态实例一律用 configPath()）
  setConfigPath, configPath, resetConfigPath,
  loadConfig, effectiveProxy, effectiveNoProxy, NO_PROXY_FLOOR, PROXY_ENV_KEYS,
};
