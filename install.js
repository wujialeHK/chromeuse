#!/usr/bin/env node
'use strict';
/*
 * chromeuse skill 安装器 —— CJS，Node >=16，零第三方依赖（仅 node:fs/path/os/crypto）
 * 规格来源：设计方案 §11.4 + §14.4（模板实例模型，最终形态）
 *
 * 用法：
 *   node install.js                       # 默认 copy 安装到 DEST
 *   node install.js --link                # 链接安装（NAS/作者端推荐：源目录改动即时生效）
 *   node install.js --check               # 漂移检查（exit 0 in-sync / 2 drift）
 *   node install.js --prune               # 删除装机目录中白名单之外的文件
 *   node install.js --init-config [linux|windows|auto]   # 模板逐字实例化为 config.jsonc（脚本所在目录）
 *   node install.js --force               # 配合 --init-config / --link：旧物重命名 .bak-<时间戳> 后重建（绝不 rm -rf）
 *   node install.js --dest <路径>         # 覆盖安装目标
 *
 * DEST 优先级：--dest > 环境变量 CHROMEUSE_DEST > ~/.config/opencode/skills/chromeuse
 * 铁律：永不触碰 opencode.jsonc（运行态真源，改配置走 references/install.md 文档流程）
 * 铁律：永不复制/覆盖 config.jsonc（机器实例跨机器复制必错；--prune 亦保护之）
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadConfig, effectiveProxy, effectiveNoProxy } = require('./lib/config');
const log = require('./lib/log');
const time = require('./lib/time');

const SRC = __dirname;
const EXIT_OK = 0, EXIT_ERR = 1, EXIT_DRIFT = 2;

const STATIC_FILES = [
  'SKILL.md', 'README.md', 'VERSION.md', 'CHANGELOG.md', 'TODO.md',  // 文档面同族（SKILL/README/CHANGELOG/TODO）——live 须与骨架同版，README 漏装曾致 live 计数断言 fail
  'config-template-linux.jsonc', 'config-template-windows.jsonc',
  'install.js', 'selftest.js', 'commands.meta.json',
];
// 目录级白名单规则：lib/tools/snippets/scripts 只收 .js（scripts=build-help.js 帮助面同源构建器——须随分发，
// 否则 live 会出现「新版脚本 + 旧版 meta」误跑降级 SUB_HELP）；references 只收 .md；config 只收 .jsonc（popup-guard 规则库，V202610150003）；
// webapps 递归收 .md + flows/*.flow.json + <app>/selftest.js + <app>/popup-rules.jsonc + <app>/selftest.config.jsonc
// （配置=分发物不是机器实例，随 webapp 同族走；排除 *.local.json）
const DIR_RULES = { lib: '.js', tools: '.js', snippets: '.js', scripts: '.js', references: '.md', config: '.jsonc' };
// prune 永不删除（机器实例 / 备份 / 运行态数据——tmpdata 含事件流与锁，V202609080007 修复：缺失时桌面 copy 安装 --prune 会连事件流带锁一起删；log/ 运行日志同理保护；
// bin/ 用户自管二进制（V20261117001：不分发 ffmpeg——Windows 用户自放 ffmpeg.exe/ffprobe.exe 后 --prune 不许误删，--check 亦不报 drift）
const PRUNE_KEEP = [/^config\.jsonc/, /\.bak-/, /^tmpdata\//, /^log\//, /^bin\//];

let DEST = null;
let OPTS = null;

function say(m) { console.log(m); }
function die(m, code) { console.error(`✗ ${m}`); process.exit(code === undefined ? EXIT_ERR : code); }
function ts() { return time.formatStamp(); } // 备份命名单源（V20261108001 用户裁定收敛）：形状 20261108123456(UTC)→yyyy-MM-dd_HH-mm-ss(本地时区)，文件名安全，.bak-* 与 PRUNE_KEEP 兼容
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function printHelp() {
  say('chromeuse skill 安装器（零依赖 CJS，Node >=16）');
  say('  node install.js [--link] [--check] [--prune] [--force] [--dest <路径>] [--init-config [linux|windows|auto]]');
  say('DEST 优先级：--dest > 环境变量 CHROMEUSE_DEST > ~/.config/opencode/skills/chromeuse');
  say('详见 references/install.md');
}

function parseArgs(argv) {
  const o = { initConfig: null, check: false, link: false, force: false, prune: false, dest: null };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const peekVal = () => {
      if (inline !== null) return inline;
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[++i];
      return null;
    };
    switch (name) {
      case '--init-config': o.initConfig = peekVal() || 'auto'; break;
      case '--check': o.check = true; break;
      case '--link': o.link = true; break;
      case '--force': o.force = true; break;
      case '--prune': o.prune = true; break;
      case '--dest': { const v = peekVal(); if (!v) die('--dest 缺路径参数'); o.dest = v; break; }
      case '--help': case '-h': printHelp(); process.exit(EXIT_OK); break;
      default: die(`未知参数：${name}（--help 看用法）`);
    }
  }
  if (o.initConfig && !['linux', 'windows', 'auto'].includes(o.initConfig)) {
    die(`--init-config 取值须为 linux|windows|auto（got ${o.initConfig}）`);
  }
  return o;
}

/** manifest 白名单：静态成员（含 README.md、commands.meta.json）+ lib|tools|snippets|scripts/*.js + references/*.md + config/*.jsonc + selftest/ 递归（*.js + fixtures 数据文件 .html/.txt，排除 tmpdata//*.log/*.bak-*）+ webapps/ 递归（*.md、flows/*.flow.json、<app>/selftest.js、<app>/popup-rules.jsonc 与 <app>/selftest.config.jsonc，排除 *.local.json）；断言 config.jsonc 永不入清单（2026-10-20 修：补 snippets 目录规则——copy 安装形态长期漏装，NAS --link 掩盖；V20261117010 扩容：meta/scripts/fixtures 三类分发缺口；补丁：README 同族文档面；V20261117011 R4：selftest 参与策略配置随 webapp 分发） */
function buildManifest() {
  const missing = STATIC_FILES.filter(f => !fs.existsSync(path.join(SRC, f)));
  if (missing.length) die(`源不完整，缺文件：${missing.join(', ')}——不装半成品`);
  const files = [...STATIC_FILES];
  for (const [dir, ext] of Object.entries(DIR_RULES)) {
    const p = path.join(SRC, dir);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) die(`源不完整：缺少 ${dir}/ 目录`);
    for (const f of fs.readdirSync(p).sort()) {
      if (f.endsWith(ext) && !files.includes(`${dir}/${f}`)) files.push(`${dir}/${f}`);
    }
  }
  // lib/platform/ 子目录（V20261117001 平台适配分层批0）：DIR_RULES 只扫 lib/ 单层——平台层必须递归补入清单，
  // 否则 copy 安装形态漏装 lib/platform/（NAS --link 同源会掩盖此缺口）。
  const platformDir = path.join(SRC, 'lib', 'platform');
  if (fs.existsSync(platformDir)) {
    for (const f of fs.readdirSync(platformDir).sort()) {
      if (f.endsWith('.js') && !files.includes(`lib/platform/${f}`)) files.push(`lib/platform/${f}`);
    }
  }
  const selftestDir = path.join(SRC, 'selftest');
  if (fs.existsSync(selftestDir)) {
    // 分发扩展名白名单（V20261117010；V20261117012 追加 .json/.md）：除 *.js 外还须收 fixtures 数据文件（grid 自检依赖
    // fixture.html/fixture-iframe.html/sha256.txt；flow 断言靶子依赖 fixtures/flow/*.flow.json 与 fixtures/README.md——
    // 漏装则 live 跑 #44/#46 必 fail）；运行态/备份一律不入清单。
    const SELFTEST_EXT = ['.js', '.html', '.txt', '.json', '.md'];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        const rel = path.relative(SRC, abs).split(path.sep).join('/');
        if (/(^|\/)tmpdata\//.test(rel) || /\.log$/.test(rel) || /\.bak-/.test(rel)) continue;
        if (SELFTEST_EXT.some(ext => rel.endsWith(ext)) && !files.includes(rel)) files.push(rel);
      }
    })(selftestDir);
  }
  const webappsDir = path.join(SRC, 'webapps');
  if (fs.existsSync(webappsDir)) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        const rel = path.relative(SRC, abs).split(path.sep).join('/');
        const ok = (rel.endsWith('.md') || /\/flows\/[^/]+\.flow\.json$/.test(rel) || /\/selftest\.js$/.test(rel)
          || /\/popup-rules\.jsonc$/.test(rel) || /\/selftest\.config\.jsonc$/.test(rel)) && !rel.endsWith('.local.json');
        if (ok && !files.includes(rel)) files.push(rel);
      }
    })(webappsDir);
  }
  if (files.includes('config.jsonc')) die('内部错误：config.jsonc 是机器实例，不允许进入拷贝清单');
  return files;
}

function listRelative(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}

function installCopy(files) {
  fs.mkdirSync(DEST, { recursive: true });
  for (const rel of files) {
    const dst = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), dst);
  }
  say(`✓ copy 安装完成：${files.length} 个文件 → ${DEST}`);
  return 'copy';
}

function bakRename(p) {
  const target = `${p}.bak-${ts()}`;
  fs.renameSync(p, target);
  return target;
}

/** --link：POSIX symlink；Windows junction 优先 → dir symlink → copy 回退（回退成功仍 exit 0 + WARN） */
function installLink(files) {
  if (fs.existsSync(DEST)) {
    let cur = null;
    try { cur = fs.readlinkSync(DEST); } catch { cur = null; }
    if (cur !== null) {
      const curResolved = path.resolve(path.dirname(DEST), cur);
      if (curResolved === path.resolve(SRC)) {
        say(`✓ 已是链接且指向本源目录（幂等通过）：${DEST} → ${SRC}`);
        return 'link';
      }
      if (!OPTS.force) {
        die(`已存在链接指向异目标：${DEST} → ${cur}；确认替换请加 --force（旧链接将重命名为 .bak-<时间戳>）`);
      }
      say(`ℹ 旧链接已重命名为 ${path.basename(bakRename(DEST))}`);
    } else {
      if (!OPTS.force) {
        die(`目标已存在且不是链接：${DEST}；确认替换请加 --force（旧目录将重命名为 .bak-<时间戳>，绝不删除）`);
      }
      say(`ℹ 旧目录已重命名为 ${path.basename(bakRename(DEST))}`);
    }
  } else {
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
  }
  try {
    if (process.platform === 'win32') {
      try { fs.symlinkSync(SRC, DEST, 'junction'); return reportLink('junction'); }
      catch (e1) {
        try { fs.symlinkSync(SRC, DEST, 'dir'); return reportLink('symlink'); }
        catch (e2) {
          say(`⚠ junction（${e1.code}）与 symlink（${e2.code}）均失败，回退 copy 模式（--check 此后按 sha256 比对）`);
          installCopy(files);
          return 'copy-fallback';
        }
      }
    }
    fs.symlinkSync(SRC, DEST, 'dir');
    return reportLink('symlink');
  } catch (e) {
    say(`⚠ symlink 创建失败（${e.code || e.message}），回退 copy 模式`);
    installCopy(files);
    return 'copy-fallback';
  }
}

function reportLink(kind) {
  say(`✓ ${kind} 链接安装完成：${DEST} → ${SRC}`);
  say('  （源目录改动即时生效；注意【install 跨平台链接形态实测】：链接形态的跨平台实测待办）');
  return 'link';
}

/** --check：共享物 sha256 全量比对（含模板）；link 模式比 readlink 目标；config.jsonc 仅存在性 + environment 校验 */
function doCheck(files) {
  const srcVer = fs.readFileSync(path.join(SRC, 'VERSION.md'), 'utf8').trim();
  let drift = false;
  if (!fs.existsSync(DEST)) {
    say(`✗ 装机目录不存在：${DEST}`);
    say('  （先执行 node install.js 或 node install.js --link 完成安装）');
    printSummary('check', srcVer, null);
    process.exit(EXIT_DRIFT);
  }
  let linkTarget = null;
  try { linkTarget = fs.readlinkSync(DEST); } catch { linkTarget = null; }
  if (linkTarget !== null) {
    const resolved = path.resolve(path.dirname(DEST), linkTarget);
    if (resolved === path.resolve(SRC)) {
      say(`✓ link 模式：${DEST} → ${SRC}（内容同源，天然一致）`);
    } else {
      say(`✗ link 目标漂移：${linkTarget} ≠ ${SRC}`);
      drift = true;
    }
    say(`✓ VERSION（同源）：${srcVer}`);
  } else {
    for (const rel of files) {
      const d = path.join(DEST, rel);
      if (!fs.existsSync(d)) { say(`✗ 装机缺文件：${rel}`); drift = true; continue; }
      if (sha256(path.join(SRC, rel)) !== sha256(d)) { say(`✗ 内容漂移：${rel}`); drift = true; }
    }
    const keep = new Set(files);
    const extra = listRelative(DEST).filter(f => !keep.has(f) && !PRUNE_KEEP.some(re => re.test(f)));
    if (extra.length) { say(`✗ 装机多出 ${extra.length} 个白名单外文件：${extra.join(', ')}（--prune 可清理）`); drift = true; }
    // bin/ = 用户自管二进制（manifest 恒不含、不分发 153MB）——不参与漂移判定，仅一行 ℹ 供对账
    const binFiles = listRelative(DEST).filter(f => /^bin\//.test(f));
    if (binFiles.length) say(`ℹ bin/ 用户自管二进制 ${binFiles.length} 个（不分发/不参与漂移判定）：${binFiles.join(', ')}`);
    let dstVer = null;
    try { dstVer = fs.readFileSync(path.join(DEST, 'VERSION.md'), 'utf8').trim(); } catch { dstVer = '（缺失）'; }
    say(`VERSION：源=${srcVer} ｜ 装机=${dstVer}`);
  }
  // config.jsonc：机器实例两台机器本就应不同，不做源↔装机 hash 比对，只做存在性 + environment 合法性
  const instPath = path.join(SRC, 'config.jsonc');
  if (!fs.existsSync(instPath)) {
    say('⚠ 未发现 config.jsonc 实例（不影响已装文件；提示：node install.js --init-config auto）');
  } else if (CFG && (CFG.environment === 'linux' || CFG.environment === 'windows')) {
    say(`✓ config.jsonc 存在，environment=${CFG.environment}`);
  } else {
    say('✗ config.jsonc 存在但 environment 非法（须 linux|windows）——查 CHANGELOG 迁移说明');
    drift = true;
  }
  printSummary('check', srcVer, null);
  process.exit(drift ? EXIT_DRIFT : EXIT_OK);
}

/** --prune：删除装机目录中白名单之外的文件（config.jsonc / *.bak-* 永不删） */
function doPrune(files) {
  if (!fs.existsSync(DEST)) die(`装机目录不存在：${DEST}`);
  const keep = new Set(files);
  const extras = listRelative(DEST).filter(f => !keep.has(f));
  const removable = extras.filter(f => !PRUNE_KEEP.some(re => re.test(f)));
  const protectedExtra = extras.filter(f => PRUNE_KEEP.some(re => re.test(f)));
  if (!removable.length) say('✓ 无可删多余文件');
  for (const f of removable) { fs.unlinkSync(path.join(DEST, f)); say(`− 已删除：${f}`); }
  if (protectedExtra.length) say(`ℹ 保留（实例/备份不 prune）：${protectedExtra.join(', ')}`);
}

/** --init-config 模式归一（纯函数）：显式 linux/windows 原样返回；auto（含未给值）在 win32→windows、
 *  linux→linux（GQ-004：Windows 本机缺省不再落到 linux 模板的 NAS 服务名 browserUrl）；其他平台返回 null。 */
function resolveInitMode(mode, platform) {
  if (mode === 'linux' || mode === 'windows') return mode;
  if (mode !== 'auto') return null;
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return null;
}

/** --init-config：模板逐字复制到脚本所在目录为 config.jsonc；已存在拒绝，--force 先 .bak-<ts> 重命名 */
function doInitConfig(mode) {
  const choice = resolveInitMode(mode, process.platform);
  if (!choice) die(`平台 ${process.platform} 无内置模板：请手动复制最近似模板（config-template-linux.jsonc / config-template-windows.jsonc）为 config.jsonc 后按本机改值`);
  const tpl = path.join(SRC, `config-template-${choice}.jsonc`);
  if (!fs.existsSync(tpl)) die(`模板不存在：${tpl}`);
  const inst = path.join(SRC, 'config.jsonc');
  if (fs.existsSync(inst)) {
    if (!OPTS.force) {
      die(`config.jsonc 已存在（${inst}）——拒绝覆盖；确要重建请加 --force（旧实例将重命名为 .bak-<时间戳>，绝不覆盖丢失机器改动）`);
    }
    say(`ℹ 旧实例已重命名为 ${path.basename(bakRename(inst))}`);
  }
  fs.copyFileSync(tpl, inst);
  say(`✓ 已用 config-template-${choice}.jsonc 逐字实例化 → config.jsonc（实例化时刻 = 审阅值的时刻，请核对本机值）`);
  return `init-config(${choice})`;
}

function printSummary(mode, srcVer, installedVer) {
  const proxy = effectiveProxy(CFG);
  const noProxy = effectiveNoProxy(CFG);
  const envName = CFG && CFG.environment ? CFG.environment : '未知（无实例，查值走模板）';
  say('──────────────────────────────────────────────');
  say(`有效模式：${mode} ｜ 生效 environment：${envName} ｜ 源 VERSION：${srcVer}${installedVer ? ` ｜ 装机 VERSION：${installedVer}` : ''}`);
  say(`DEST：${DEST}`);
  say(`代理解析：proxy=${proxy || '（无）'} ｜ noProxy=${noProxy || '（空）'}`);
  say('下一步清单：');
  say('  1. 新会话生效（skill 注入按会话加载，旧会话看不到变更）');
  say('  2. MCP 配置按环境对应 references/install.md 节（§1 NAS / §2 桌面端）——改运行层 opencode.jsonc 真身，非 config.jsonc');
  if (proxy) {
    say(`  3. NAS npm 预热：HTTPS_PROXY=${proxy} HTTP_PROXY=${proxy} npx -y chrome-devtools-mcp@latest --version`);
  } else {
    say('  3. NAS npm 预热：未解析到代理（config.proxy.httpProxy 为空串且环境变量无值）；如需代理请设置后预热');
  }
  if (!CFG) say('  ⚠ 醒目提示：尚无 config.jsonc 实例——node install.js --init-config auto（普通安装不会自动实例化）');
}

// ---------- 主流程 ----------
let CFG = null;
function main() {
  OPTS = parseArgs(process.argv.slice(2));
  DEST = OPTS.dest || process.env.CHROMEUSE_DEST
    || path.join(os.homedir(), '.config', 'opencode', 'skills', 'chromeuse');
  log.info('install', `启动 mode=${OPTS.check ? 'check' : OPTS.prune ? 'prune' : OPTS.initConfig ? 'init-config' : OPTS.link ? 'link' : 'copy'} dest=${DEST}`);

  // 启动 fail-fast：实例存在但坏（parse/schemaVersion）→ exit 1 不装半成品；实例缺失不拦（末尾醒目提示）
  CFG = loadConfig();

  const manifest = buildManifest();
  let mode;
  if (OPTS.check) {
    doCheck(manifest); // 内部自行 exit（0/2）
  } else if (OPTS.prune) {
    doPrune(manifest);
    mode = 'prune';
  } else if (OPTS.initConfig) {
    mode = doInitConfig(OPTS.initConfig);
  } else {
    mode = OPTS.link ? installLink(manifest) : installCopy(manifest);
  }
  printSummary(mode, fs.readFileSync(path.join(SRC, 'VERSION.md'), 'utf8').trim(), null);
  log.info('install', `完成 mode=${mode || 'check'} 文件=${manifest.length} 个 exit=${EXIT_OK}`);
  process.exit(EXIT_OK);
}

if (require.main === module) main();
module.exports = { resolveInitMode, buildManifest };
