'use strict';
/*
 * chromeuse selftest/flow-policy.js —— flow 测试参与策略（webapps/<app>/selftest.config.jsonc 的读取/校验/枚举单源）
 * 语义（V20261117011 R4 批，2026-11-17 用户裁定）：被排除的 flow 完全不进测试面——不参与任何断言、不逐条 warn；
 * 仅由 #140 在启动后打一行「纳入 X / 排除 Y（app: reason）」汇总；只有配置本身坏（解析失败/清单与实存不符/
 * excludeApp 与 excludeFlows 并存/reason 空）才 fail。缺省不建配置文件 = 全参与（零行为变化，回滚=删文件）。
 * 防误用：凭据禁词扫描不随参与集豁免（安全红线在 main.js #18 仍全量扫 surface.all）；lib/、tools/ 零引用本文件语义（#140⑥ 守门）。
 * 枚举口径统一（报告 §六.3）：递归 *.flow.json，统一排除 *.local.json（#126/#127 历史三处无排除的偏差一并归一）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../lib/jsonc');

const DIR = path.join(__dirname, '..'); // skill 根目录（selftest/ 上一级）
const CONFIG_NAME = 'selftest.config.jsonc';
const KNOWN_KEYS = new Set(['excludeApp', 'excludeFlows', 'reason']);

/** 递归列目录下 *.flow.json 绝对路径（统一排除 *.local.json；排序保证输出稳定） */
function listFlowFiles(dir) {
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.flow.json') && !e.name.endsWith('.local.json')) out.push(p);
    }
  })(dir);
  return out.sort();
}

/** webapps/ 下 app 目录名（排序） */
function listApps() {
  const dir = path.join(DIR, 'webapps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * 读单个 webapp 的参与策略：解析 + schema 校验，不抛异常、错误/告警聚合返回（#140 转 fail/warn 文案）。
 * 返回 { ok, errors[], warnings[], policy: { file, exists, empty, excludeApp, excludeFlows[], reason } }
 * 非法值策略（报告 §三）：解析失败/类型错/互斥并存/有排除但 reason 空 → errors；未知键/未知 selftest 键 → warnings。
 */
function readPolicy(appDir) {
  const res = {
    ok: true, errors: [], warnings: [],
    policy: { file: null, exists: false, empty: true, excludeApp: false, excludeFlows: [], reason: '' },
  };
  const file = path.join(appDir, CONFIG_NAME);
  res.policy.file = file;
  if (!fs.existsSync(file)) return res; // 缺省 = 全参与
  res.policy.exists = true;
  let data;
  try { data = parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { res.ok = false; res.errors.push(`解析失败：${e.message}`); return res; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    res.ok = false; res.errors.push('顶层须为对象（{ "selftest": { … } }）');
    return res;
  }
  for (const k of Object.keys(data)) {
    if (k !== 'selftest') res.warnings.push(`未知顶层键 "${k}"（本文件只承载 selftest 语义）；`);
  }
  const st = data.selftest;
  if (st === undefined) return res; // 文件存在但缺 selftest 键 = 全参与（空占位可接受）
  if (!st || typeof st !== 'object' || Array.isArray(st)) {
    res.ok = false; res.errors.push('selftest 须为对象');
    return res;
  }
  res.policy.empty = false;
  for (const k of Object.keys(st)) {
    if (!KNOWN_KEYS.has(k)) res.warnings.push(`未知键 "selftest.${k}"（向前兼容不硬拒，疑似拼写错）；`);
  }
  if (st.excludeApp !== undefined) {
    if (typeof st.excludeApp !== 'boolean') { res.ok = false; res.errors.push(`selftest.excludeApp 须为 boolean（got ${JSON.stringify(st.excludeApp)}）`); }
    else res.policy.excludeApp = st.excludeApp;
  }
  if (st.excludeFlows !== undefined) {
    if (!Array.isArray(st.excludeFlows)) { res.ok = false; res.errors.push(`selftest.excludeFlows 须为数组（got ${JSON.stringify(st.excludeFlows)}）`); }
    else {
      for (const name of st.excludeFlows) {
        if (typeof name !== 'string' || !name.trim()) { res.ok = false; res.errors.push(`selftest.excludeFlows 项须为非空字符串（got ${JSON.stringify(name)}）`); continue; }
        res.policy.excludeFlows.push(name);
      }
    }
  }
  if (typeof st.reason === 'string') res.policy.reason = st.reason.trim();
  else if (st.reason !== undefined) { res.ok = false; res.errors.push(`selftest.reason 须为非空字符串（got ${JSON.stringify(st.reason)}）`); }
  const hasExclusion = res.policy.excludeApp || res.policy.excludeFlows.length > 0;
  if (hasExclusion && !res.policy.reason) { res.ok = false; res.errors.push('selftest.reason 缺失或空白（排除必须写明理由——#140 守门 + CHANGELOG 记账）'); }
  if (res.policy.excludeApp && res.policy.excludeFlows.length > 0) {
    res.ok = false; res.errors.push('selftest.excludeApp 与 selftest.excludeFlows 互斥（整 app 排除时不要再列单 flow——收敛为一种）');
  }
  return res;
}

let cache = null;
/**
 * 全 webapp 测试面枚举（selftest 单进程内缓存一次；多组消费）。
 * 返回 { all, participating, excluded: [{app,file,reason,wholeApp}], apps, policies, emptyExcludeApps }
 *  - all = 资产层全量（含排除项：排除≠删除，git 里仍是资产）
 *  - participating = 参与集合（所有断言/基线口径；零配置时 === all）
 *  - 配置坏（!ok）的 app 按「全参与」保守处理（不静默排除），红由 #140 报。
 */
function participatingFlows() {
  if (cache) return cache;
  const webappsDir = path.join(DIR, 'webapps');
  const all = listFlowFiles(webappsDir);
  const apps = listApps();
  const policies = {};
  const excluded = [];
  const emptyExcludeApps = [];
  for (const app of apps) {
    const r = readPolicy(path.join(webappsDir, app));
    policies[app] = r;
    const appFlows = all.filter((f) => path.relative(webappsDir, f).split(path.sep)[0] === app);
    if (!r.ok) continue; // 坏配置不生效（#140 fail 显式修）
    const { excludeApp, excludeFlows, reason } = r.policy;
    if (excludeApp) {
      if (!appFlows.length) { emptyExcludeApps.push(app); continue; } // #140③ 占位疑似过期 → warn
      for (const f of appFlows) excluded.push({ app, file: f, reason, wholeApp: true });
    } else if (excludeFlows.length) {
      for (const name of excludeFlows) {
        const hit = appFlows.find((f) => path.basename(f) === name);
        if (hit) excluded.push({ app, file: hit, reason, wholeApp: false }); // 不存在由 #140② 报 fail
      }
    }
  }
  const excludedSet = new Set(excluded.map((e) => e.file));
  cache = {
    all, participating: all.filter((f) => !excludedSet.has(f)),
    excluded, apps, policies, emptyExcludeApps,
  };
  return cache;
}

/** 排除集合（与 participatingFlows() 同源缓存——同一对象的 .excluded 视图，便于调用点语义直读） */
function excludedFlows() { return participatingFlows(); }

let assertionCache = null;
/**
 * 断言靶子集合（#18/#44/#46 单源，V20261117012）：webapps 参与集合 + selftest/fixtures/flow/ 合成靶子。
 * ⚠️ tmpdata 禁止入断言扫描集——它是运行时临时数据（可随时清空/被 CHROMEUSE_TMPDATA_DIR 覆盖），
 * 断言目标必须来自库内常量资产（fixtures 随分发清单安装，跨环境恒定）。
 * 缓存同 participatingFlows()：单进程内只枚举一次。
 */
function assertionFlows() {
  if (assertionCache) return assertionCache;
  const fixtureDir = path.join(DIR, 'selftest', 'fixtures', 'flow');
  assertionCache = participatingFlows().participating.concat(listFlowFiles(fixtureDir));
  return assertionCache;
}

module.exports = {
  CONFIG_NAME, DIR,
  listFlowFiles, listApps, readPolicy, participatingFlows, excludedFlows, assertionFlows,
};
