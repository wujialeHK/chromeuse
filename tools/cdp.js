#!/usr/bin/env node
'use strict';
/*
 * chromeuse tools/cdp.js —— raw CDP 逃生舱 CLI（单文件多子命令；零第三方依赖，Node >= 22）
 *
 * ⚠ 万能口 exec 红线警示：可执行任意 CDP 命令——Target.close 系列、Page.navigate、Runtime.terminateExecution、
 *   Browser.close、Storage 点系列等破坏性类别务必明确 --target 并自担风险；业务写操作走 Input 域（flow replay），
 *   严禁 Runtime.evaluate 合成事件（isTrusted=false，红线一）。
 * 子命令：probe│exec│targets│net│screenshot│scroll-shot│beacon│watch│flow│locator│
 *         click│click-at│type│key│hover│wait│console（最小交互命令集，一期：cdp 主通道战略 2026-10-31 用户裁定）│
 *         goto│new│close│select│eval（二期 P0：标签管理与页面求值；targets 增 --json 投影）│
 *         viewport│emulate│dialog│upload│drag（二期-2：视口/模拟/交互补充；P1 族）│
 *         a11y│css（二期-3：感知类；P1 a11y + P2 css）│
 *         cast（二期-4：一次性录屏 Page.startScreencast → ffmpeg）│
 *         record│record-stop│events-summary│recorder-convert│diff-video│evidence-pack│browser-restart│doctor│doctor-forensics
 * 超时：每命令独立默认 5000ms（--timeout 覆盖）；一次性短连接，不与 MCP 长驻竞争；tab 开关只由显式 new/close 执行（谁开谁关），其余命令永不自动开/关 tab。
 * 退出码：0 成功 ｜ 1 错误/失败 ｜ 2 watch 判定冻结。
 * -v 统一别名（V202609090002）：全部子命令 -v = --video（录屏兜底，默认关显式开启制）；未来 verbosity 用 -V/--verbose 避让。
 */
const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0, EXIT_ERR = 1, EXIT_FROZEN = 2;

/* ── 全局 --config pre-parse（V20261117005 批B/R3；必须先于一切 lib require）──
 * 只识别 `--config <path>` / `--config=<path>` 两形态（不走完整 parseArgs，避免吞子命令参数语义）；
 * 命中即 lib/config.setConfigPath（相对路径按当刻 cwd 解析；不存在/坏 JSONC → 内联 fail-fast——
 * 此时 die/jsonMode 尚未定义，按 E_USAGE 语义直写 stderr + exit 1，绝不静默回落主实例），
 * 并把该 flag 对从 argv **剥离**（后续 RAW_ARGV(:75)/parseArgs/子命令旗标空间都看不到它）。
 * platform 惰性化（lib/platform/index.js）保证首次构建落在命令执行期，按新实例 environment 定。
 * 子进程继承：setConfigPath 同批写 CHROMEUSE_CONFIG_PATH（jobs --async child 沿用同一实例）。 */
(function preParseConfigFlag() {
  const argv = process.argv;
  let chosen = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    let val = null;
    let span = 0;
    if (a === '--config') { val = argv[i + 1]; span = 2; }
    else if (a.startsWith('--config=')) { val = a.slice('--config='.length); span = 1; }
    else continue;
    if (val === undefined || val === '' || val.startsWith('--')) {
      process.stderr.write('✗ --config 缺值（用法：--config <path>；相对路径按当前 cwd 解析）\n');
      process.exit(EXIT_ERR);
    }
    argv.splice(i, span); // 剥离：flag 与值一并摘除（多写时最后一份生效）
    i -= 1;               // 回退一格，衔接被前移的下一个 token
    chosen = val;
  }
  if (chosen === null) return;
  try { require('../lib/config').setConfigPath(chosen); }
  catch (e) {
    process.stderr.write(`✗ --config 指向的文件不存在/无法解析：${chosen}（${e.message}）\n`);
    process.exit(EXIT_ERR);
  }
})();

/* ── 全局 --auto-launch pre-parse（批C2/R2，V20261117008）：位置无关（子命令前/后都认，同 --config 语义），
 * 剥离后经 `AUTO_LAUNCH` 交给 main 在分发前执行「连接前保障」。必须先于 RAW_ARGV/currentCmd 计算——
 * 否则写在子命令前会被当成子命令（argv[0] 抢位），写在后面会被 parseArgs 当成带值旗标吞掉下一 token。 ── */
const AUTO_LAUNCH = (function preParseAutoLaunchFlag() {
  const argv = process.argv;
  let hit = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--auto-launch' || argv[i] === '--auto-launch=true') {
      argv.splice(i, 1);
      i -= 1;
      hit = true;
    }
  }
  return hit;
})();

const paths = require('../lib/paths');
const log = require('../lib/log');
const platform = require('../lib/platform'); // 平台层单例（批0：binaries provider；无平台字面量散落）
const time = require('../lib/time');
const drive = require('../lib/drive'); // 最小交互命令集实现单源（click/type/key/hover/wait/console）
const pageOps = require('../lib/page'); // 页面/标签生命周期 + eval 实现单源（goto/new/close/select/targets --json/eval）
const perceive = require('../lib/perceive'); // 感知类实现单源（a11y/css；二期-3）
const cast = require('../lib/cast'); // 一次性录屏实现单源（Page.startScreencast → ffmpeg；二期-4）
const envelope = require('../lib/envelope'); // 统一输出信封（chromeuse-cli/1；V202611030001 B1a）
const errors = require('../lib/errors'); // 错误码表单源（V202611030001 B1a）
const audit = require('../lib/audit'); // 结构化动作审计 JSONL（V202611030004 B3 N3）
const quota = require('../lib/quota'); // 产物配额/保留期/pin（V202611030005 B3 N2）
const locator = require('../lib/locator'); // 元素捕获/命中诊断（B4/R2 #103 证 evidence）
const extractMod = require('../lib/extract'); // 结构化抽取（B4/N8 #104；只读原语；C9 --kind grid）
const gridMod = require('../lib/grid'); // 虚拟化网格读数/定位（C9；extract --kind grid + grid locate/scroll-to）
const assertLib = require('../lib/assert'); // 批量断言（B4/N9 #105；默认失败不中断）
const jobs = require('../lib/jobs'); // 长任务作业模型（V20261104002 B7 N6；lib/jobs.js）
const refs = require('../lib/refs'); // a11y 引用句柄 @eN：物化/三级定位链/失效契约（V202611030006 B5 N4）
const redact = require('../lib/redact'); // 输出脱敏单源（V20261104004 B6b N7：stdout/落盘/审计三同源）
const harLib = require('../lib/har'); // net → HAR 1.2 导出单源（C7 #122，V20261113003）
const tabGovern = require('../lib/tab-govern'); // agent 页签治理单源（C8 #123：命名标记/惰性回收/永不抢前台）
const challenge = require('../lib/challenge'); // bot challenge 识别与止损单源（C4 #124：六墙特征表/多信号合取/有限自愈）
const handoffMod = require('../lib/handoff'); // 人机接力 handoff 协议单源（C2 #128：状态机/原子落盘/惰性清扫）
// 作业子进程接线（env 由父进程注入；非作业进程 no-op）：接管进度上报 + 退出终态落盘 + 槽位释放。
// 必须在 cdp.js 末尾 process.on('exit') 注册前调用，保证状态文件先于进程消失落好终态。
jobs.attachChild();

/* ── 审计目标登记单点（V202611030004 B3 N3）──
 * 包装 cdp-core.resolveTarget：命令内部几十处调用零改动即可把「目标页 URL」登记进审计上下文；
 * 审计只取 host+pathname（query 永不落盘），且异常全部吞掉（审计是旁路，不得影响命令）。 */
try {
  const coreMod = require('../lib/cdp-core');
  const _resolveTarget = coreMod.resolveTarget;
  coreMod.resolveTarget = async function auditedResolveTarget(...args) {
    const r = await _resolveTarget.apply(this, args);
    try { audit.setTarget(r && r.target ? r.target.url : null); } catch { /* 审计旁路 */ }
    // C8（#123）：命中 agent 页签登记项即 touch lastActiveAt（15s 节流）——「被命令使用过」不算空闲。
    try { if (r && r.target) tabGovern.touchFromDisk(r.target.id); } catch { /* 治理旁路 */ }
    return r;
  };
} catch { /* 审计旁路：cdp-core 加载失败由真实调用路径报错 */ }

/* ── 统一失败出口（V202611030001 B1a，见 references/mechanisms.md）──
 * 三出口盘点（改造前 main().catch 只覆盖第 ① 类）：
 *   ① throw → main().catch（本文件尾部）
 *   ② die()（process.exit 直通；~120 处调用，参数校验几乎全走它）
 *   ③ cmd 内 console.error + return EXIT_ERR 散点（~44 处；catch 拿不到）
 * 单点化：die 置 failure → exit hook 发射；return EXIT_ERR 型由 main().then(code!==0) 兜底发射
 * （高频路径用 noteFail 标显式码，其余落 E_INTERNAL）；throw 型在 catch 里按 kind 映射。
 * 发射只在 jsonMode（--json）下进行——非 --json 输出逐字节不变（golden 断言 #96 守门）。
 * 冻结新增裸 die：新增失败一律用 fail(code, msg, extra)（内部走改造后 die 路径）。 */
const RAW_ARGV = process.argv.slice(2);
const jsonMode = RAW_ARGV.some((a) => a === '--json' || a.startsWith('--json='));
const noRedact = RAW_ARGV.some((a) => a === '--no-redact'); // 全局脱敏开关显式关（默认开；审计记 redact.disabled）
if (noRedact) redact.setEnabled(false);
const currentCmd = RAW_ARGV[0] && !RAW_ARGV[0].startsWith('-') ? RAW_ARGV[0] : null; // 信封 envelope.command
/* --json 放行面（V202611030002 B1b；C2 #128 扩至 13）：13 命令 = v1 卡 N1 的 9 命令 ∪ 现役 5 命令
 * （targets/a11y 去重）∪ handoff（人机协议：signalPath 必须机器可靠提取，横幅多行中文不宜 parse）。
 * 其余 36 个已知子命令在分发层（switch 前）统一 E_USAGE 拒绝——**不执行命令**，stdout 只发失败信封。
 * 精确名单与 49−13 的算术见 references/mechanisms.md §8（禁凭旧总数推算）。 */
const JSON_COMMANDS = new Set(['probe', 'targets', 'a11y', 'click', 'type', 'goto', 'screenshot', 'flow', 'wait', 'locator', 'console', 'css', 'handoff']);
let failure = null;        // {code, message, hint?, data?}——最近一次失败事实（noteFail/fail/die/catch 写）
let failureEmitted = false; // 全局去重：信封 + audit 只发一次
let successAudited = false; // 成功审计去重（一次命令调用一行）
let stdoutOwned = false;   // stdout 已产出内容（帮助文本/文本报告）→ 失败不再补信封
const STARTED_AT = Date.now(); // elapsedMs 单源（信封与 audit 共用）

/* stdout 占用探针（单点）：任何 console.log 输出即置位——帮助文本等「合法但非信封」的 stdout 输出后，
 * 失败收口不再补发信封（避免双 JSON 破坏 stdout 单文档）。12 个放行命令在 --json 下的进度/告警一律
 * 走 stderr（`info()` 单点，B1b），stdout 只留一个 JSON 文档。
 * B6b N7：本包装同时是**文本输出脱敏单点**（stdout+stderr 两通道；--no-redact 原样放行）。 */
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const redactArgs = (args) => (noRedact ? args : args.map((a) => (typeof a === 'string' ? redact.text(a) : a)));
console.log = (...args) => { stdoutOwned = true; _consoleLog(...redactArgs(args)); };
console.error = (...args) => { _consoleError(...redactArgs(args)); };

/* 落盘脱敏单点（B6b N7）：所有 JSON/文本写盘在**写之前**过 redact.text（Buffer=截图等二进制原样）。
 * 覆盖 cdp.js 自身与同进程 lib/* 的报告/证据/事件流写盘（Node 22 实测 appendFileSync 亦经此包装）；
 * 独立子进程（recorder 等）不在本包装内。 */
const _writeFileSync = fs.writeFileSync;
fs.writeFileSync = function writeFileSyncRedacted(file, data, opts) {
  if (!noRedact && typeof data === 'string' && data) {
    try { data = redact.text(data); } catch { /* fail-soft：脱敏失败写原文（不得阻断落盘） */ }
  }
  return _writeFileSync.call(fs, file, data, opts);
};

/* 启动期配置告警（fail-soft；secretsFile 不可读等）——只在启用脱敏时提示一次，走 stderr+日志。 */
if (!noRedact) {
  try {
    const rr = redact.getRules();
    for (const w of (rr.warnings || [])) { log.warn('redact', w); console.error(`[redact] ⚠ ${w}`); }
  } catch { /* fail-soft */ }
}

/** 记录失败事实但**不退出**（return EXIT_ERR 型路径用；main().then 兜底发射） */
function noteFail(code, message, extra) {
  failure = Object.assign({ code: errors.isCode(code) ? code : 'E_INTERNAL', message: String(message == null ? '' : message) }, extra || {});
}

/** 信封发射单点（B6b N7）：所有 `--json` 输出在此过 redact.deep（持久化/可见前脱敏；--no-redact 原样） */
function emitEnvelope(env) {
  try { envelope.emit(noRedact ? env : redact.deep(env)); } catch { /* EPIPE 等不改变退出码 */ }
}

/** --no-redact 审计标记（每次命令调用一行，恰一次）：action=redact.disabled。 */
let redactDisabledAudited = false;
function auditRedactDisabled() {
  if (!noRedact || redactDisabledAudited) return;
  redactDisabledAudited = true;
  try { audit.record({ cmd: currentCmd, action: 'redact.disabled', code: null, elapsedMs: Date.now() - STARTED_AT }); } catch { /* 审计旁路 */ }
}

/** --insecure 审计标记（V20261112001 §17；每次调用恰一次）：action=security.ignore-certs。
 *  挂各命令入口（openClient 无 cmd 上下文）——调用方在参数校验后、主操作前调用。 */
let insecureCertsAudited = false;
function auditInsecureCerts(flags) {
  if (!flags || !flags.insecure || insecureCertsAudited) return;
  insecureCertsAudited = true;
  try { audit.record({ cmd: currentCmd, action: 'security.ignore-certs', code: null, elapsedMs: Date.now() - STARTED_AT }); } catch { /* 审计旁路 */ }
}

/* ── C4 bot challenge 识别与止损（#124；lib/challenge.js 单源） ──
 * 默认=安全优先：检测到 → 阻断 + 诚实红（E_POLICY_DENIED，消息前缀 CHALLENGE_DETECTED）+ 接管提示；
 * --allow-challenge=效率优先：不阻断仅提醒（exit 0）。禁自解/禁连环重试（Browse 铁律，见 mechanisms §19）。 */
function challengeOptions(flags) {
  if (flags['challenge-wait-ms'] === true) die('--challenge-wait-ms 缺值（自愈等待预算毫秒数，0=不等待；默认 15000）');
  try {
    return challenge.normalizeOptions({
      allowChallenge: !!flags['allow-challenge'],
      waitMs: flags['challenge-wait-ms'],
      timeoutMs: num(flags.timeout, 5000),
    });
  } catch (e) { die(e.message); }
}

/** 检测 + 打印 + 审计（动作 challenge.blocked/allowed 恰一次）；返回结果，调用方按 detected&&!allowed 收口退出码 */
async function challengeGate(client, sessionId, opt) {
  let res;
  try { res = await challenge.check(client, sessionId, opt); }
  catch (e) { console.error(`[challenge] ⚠ 检测面异常（fail-soft 不误拦）：${e.message}`); return { detected: false, error: e.message }; }
  if (res.error) { console.error(`[challenge] ⚠ 检测面不可用（${res.error}）——本次不做 challenge 判定（如实边界）`); return res; }
  if (res.skipped) return res;
  if (res.cleared) { console.error(`[challenge] ✓ ${challenge.formatCleared(res)}`); return res; }
  if (!res.detected) return res;
  res.allowed = !!opt.allowChallenge;
  try { audit.record({ cmd: currentCmd, action: res.allowed ? 'challenge.allowed' : 'challenge.blocked', code: res.allowed ? null : 'E_POLICY_DENIED', elapsedMs: Date.now() - STARTED_AT }); } catch { /* 审计旁路 */ }
  if (res.allowed) console.error(`⚠ ${challenge.formatAllowed(res)}`);
  else console.error(`✗ ${challenge.formatBlock(res)}`);
  return res;
}

/** 失败收口（exit hook 与 main().then 共用；幂等）。audit 恒触达，信封仅 --json 且未被命令自行输出时发。 */
function finalizeFailure(exitCode) {
  if (failureEmitted) return;
  const f = failure || { code: errors.codeForExit(exitCode), message: `命令失败（exit ${exitCode}；无失败上下文）` };
  failureEmitted = true;
  auditRedactDisabled();
  try { envelope.auditFailure({ cmd: currentCmd, code: f.code, msg: redact.text(f.message), exitCode }); } catch { /* 审计不得改变退出语义 */ }
  if (!jsonMode || stdoutOwned) return;
  emitEnvelope(envelope.fail({ cmd: currentCmd, code: f.code, message: f.message, hint: f.hint, data: f.data, evidence: f.evidence }));
}
process.on('exit', (code) => {
  if (code !== 0 || failure) finalizeFailure(code);
  else finalizeSuccess();
});

/* 成功审计（B3 N3）：进程 exit 0 单点 → 一次命令调用一行（覆盖全部 41 命令，不依赖 --json 放行面）。
 * 与失败路径互补：die/return/catch 三个失败出口已由 finalizeFailure 统一（auditFailure 恒触达）。
 * 设计说明（deviation）：任务书建议「成功路径在 emitOk 埋点」——emitOk 只覆盖 12 个 --json 命令，
 * 而验收要求「audit 命令自身也被审计」且审计应覆盖全命令，故上提到 exit 单点；emitOk 只登记 phase/artifact 上下文。 */
function finalizeSuccess() {
  if (successAudited || helpOnly) return;
  successAudited = true;
  auditRedactDisabled();
  try { audit.recordSuccess({ cmd: currentCmd, elapsedMs: Date.now() - STARTED_AT }); } catch { /* 审计旁路 */ }
}

/* auditFailure → 正式 sink（B3 实装）：B1a 接缝 setAuditSink 注入 audit.recordFailure。
 * msg 不进审计（白名单制）；CHROMEUSE_AUDIT_FILE 测试接缝由 envelope 自身仍写（见 mechanisms §6）。 */
envelope.setAuditSink((e) => {
  try { audit.recordFailure(Object.assign({}, e, { elapsedMs: Date.now() - STARTED_AT })); } catch { /* 审计旁路 */ }
});

/* ── 通用小件 ── */
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
// 时间戳单源 lib/time.js（时区配置 CHROMEUSE_TZ_OFFSET，默认 UTC+8）——net/screenshot/videodiff 落盘命名统一走配置时区
const ts = () => time.formatStamp();
const sleep = time.sleep; // 通用延迟单源 lib/time.js
/** 失败退出单点（V202611030001 B1a）：置 failure → 日志/文本不变 → process.exit。
 *  code 缺省按消息模式初分类（lib/errors.js MESSAGE_RULES）；新增代码请改调 fail(code, msg)。 */
function die(msg, code, extra) {
  noteFail(code || errors.codeForMessage(msg), msg, extra);
  log.error('cdp', msg);
  console.error(`✗ ${msg}`);
  process.exit(EXIT_ERR);
}

/** 新增失败的**唯一**入口（冻结裸 die）：fail(code, msg, extra) 内部走改造后 die 路径 */
function fail(code, msg, extra) { die(msg, code, extra); }

/* ── --json 成功/报告型失败收口（V202611030002 B1b，见 references/mechanisms.md §8）── */
/** 人类可读进度行：--json 模式一律走 stderr（stdout 只留一个 JSON 文档）；非 --json 逐字节不变 */
function info(...args) { (jsonMode ? console.error : console.log)(...args); }

/** 成功信封发射单点：data=命令核心结果对象（结构见 mechanisms §8）；仅 --json 路径调用。
 *  B3 audit：同点登记 phase（B2 四态）与产物路径到审计上下文（成功审计行在进程 exit 单点写一次）。 */
function emitOk(cmd, data, extra) {
  try {
    if (data && data.phase) audit.setPhase(data.phase);
    /* data.out 可能是产物路径字符串（旧命令）或 a11y --out 的 {nodes,file,snapshotId} 摘要 */
    const rawOut = data && data.out;
    const a = data && (rawOut
      ? (typeof rawOut === 'object' ? rawOut.file : rawOut)
      : (data.reportPath || (data.video && data.video.dir) || null));
    if (a) audit.setArtifact(a);
  } catch { /* 审计旁路 */ }
  emitEnvelope(envelope.ok(Object.assign({ cmd, data }, extra || {})));
  return EXIT_OK;
}

/** 报告型失败收口（ok:false + code + data=诊断/报告对象）：--json 下 stdout 单文档；audit 同点触达。
 *  非 --json 路径**不得**调用本函数——调用方照旧打印旧文本/旧报告（逐字节不变）。 */
function emitFailWithData(cmd, code, message, data) {
  noteFail(code, message, data === undefined ? undefined : { data });
  finalizeFailure(EXIT_ERR);
  return EXIT_ERR;
}

/* ── R1：交互后生效判据（V202611030003 B2；四态 phase/expect）──
 * 实现单源 lib/expect.js（判据解析/轮询/状态机），本层只做 CLI 收口：
 *   parseEffectConfig=建连前解析（错误走 die→E_USAGE）；
 *   printEffectPhase=人类可读行（--json 下 info() 走 stderr，stdout 单文档不变）；
 *   withEffect=成功/中间态 data 合并 phase+effect（裸命令不合并→旧 data 逐字节不变）；
 *   stalledExit=stalled 按失败收口（E_TIMEOUT 报告型失败 + data.phase + 取证 hint）。 */
function parseEffectConfig(flags) {
  try { return drive.parseEffectFlags(flags); } catch (e) { die(e.message); }
}

function printEffectPhase(cmd, r) {
  const e = r.effect || {};
  const tail = `${e.waitedMs || 0}ms/${e.polls || 0} 次轮询`;
  if (r.phase === 'confirmed') info(`[${cmd}] phase=confirmed（${e.expect}；${tail}）`);
  else if (r.phase === 'effect_pending') info(`[${cmd}] phase=effect_pending（判据未成立但有可观察进展；${tail}）——继续观察，勿按成功收口`);
  else if (r.phase === 'dispatched') info(`[${cmd}] phase=dispatched（--no-wait-effect：送达即返回，判据未评估）`);
  else console.error(`[${cmd}] ✗ phase=stalled（${e.expect}；${e.effectMs}ms 窗口耗尽且无可观察进展${e.observable === false ? '；探测全部失败' : ''}）`);
}

/** 仅当本次调用激活了 --expect-* 才合并 phase/effect（裸命令 data 保持旧结构） */
function withEffect(data, r) {
  return r ? Object.assign({}, data, { phase: r.phase, effect: r.effect }) : data;
}

/** stalled 收口：--json=报告型失败 E_TIMEOUT（stdout 单文档）；文本=stderr 提示 + exit 1 */
function stalledExit(cmd, r, data) {
  const e = r.effect || {};
  const msg = `[${cmd}] 动作已送达但效果判据在 ${e.effectMs}ms 窗口内未成立且无可观察进展（phase=stalled`
    + `${e.observable === false ? '；探测全部失败：' + String(e.lastError || 'unknown').slice(0, 120) : ''}）`;
  noteFail('E_TIMEOUT', msg, { data, hint: drive.STALL_HINT });
  console.error(`ℹ ${drive.STALL_HINT}`);
  return EXIT_ERR;
}

/** 统一 settle 调用（裸命令零调用） */
async function settleFor(client, sessionId, cfg, candidate) {
  if (!cfg) return null;
  return drive.settleEffect(client, sessionId, {
    spec: cfg.spec, effectMs: cfg.effectMs, noWait: cfg.noWait,
    target: drive.toVerifyTarget(candidate), subjectExpr: drive.subjectExprFor(candidate),
  });
}

async function openClient(flags, defaultTimeout, opts) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  const client = trackedClient(core, url, num(flags.timeout, defaultTimeout || 5000));
  await client.connect();
  /* --insecure（V20261112001 §17）：连接建立后立即 browser-level（无 sessionId）发送一次证书忽略——
   * 生效窗口=本连接存活期间，断连即回退（秒级时滞+缓存命中例外）；不支持命令不传 opts=零命令。 */
  if (opts && opts.insecure) await client.send('Security.setIgnoreCertificateErrors', { ignore: true });
  return { core, client, url };
}

/* ── 连接优雅清理（V202609130003；研究题 2：session 堆积治理）──
 * 背景：CdpClient.close() 只发 ws.close()，不显式 detach 已附挂 session——浏览器侧此前依赖「进程退出 →
 * TCP 断开」兜底回收；一旦 WS close 帧未及刷出（process.exit 抢先/异常路径），session 释放就被动滞后。
 * 纪律（V202609130003 起）：所有子命令退出路径统一走 gracefulClose()——①逐 session Target.detachFromTarget
 * 显式释放（1s 短超时尽力而为）→ ②ws.close() 正常关闭帧；异常退出（SIGINT/SIGTERM）由 installSignalCleanup
 * 同步兜底关 WS（detach 属异步做不了——进程死后 OS 关 TCP，浏览器随即释放，注释如实声明）。
 * lib/flow-engine、lib/record 的内部连接不在本文件管辖（不动 lib/）——本机制覆盖 cdp.js 自有连接。 */
const ACTIVE_CLIENTS = new Set(); // 本进程存活中的 CdpClient（异常退出路径同步兜底用）
let _signalsInstalled = false;
function installSignalCleanup() {
  if (_signalsInstalled) return;
  _signalsInstalled = true;
  const bail = (sig) => {
    for (const c of ACTIVE_CLIENTS) { try { c.closed = true; if (c.ws) c.ws.close(); } catch { /* 尽力而为 */ } }
    ACTIVE_CLIENTS.clear();
    // 仅当本监听器是唯一 SIGINT/SIGTERM 监听器时才接管退出（record/beacon 有自己的信号语义，且不走
    // trackedClient——天然不触发本安装）；否则交还业务监听器处理
    if (process.listenerCount(sig) <= 1) process.exit(EXIT_ERR);
  };
  process.on('SIGINT', () => bail('SIGINT'));
  process.on('SIGTERM', () => bail('SIGTERM'));
  process.on('exit', () => { // 同步兜底：die()/顶层 catch 等 process.exit 路径来不及 await gracefulClose
    for (const c of ACTIVE_CLIENTS) { try { if (c.ws) c.ws.close(); } catch { /* 尽力而为 */ } }
  });
}
function trackedClient(core, url, timeoutMs) {
  const c = new core.CdpClient(url, { timeoutMs });
  ACTIVE_CLIENTS.add(c);
  installSignalCleanup();
  return c;
}
/** 优雅关闭：逐 session detach（尽力而为）→ ws.close() 正常关闭帧——浏览器侧不再依赖进程退出回收连接 */
async function gracefulClose(client) {
  if (!client) return;
  ACTIVE_CLIENTS.delete(client);
  try {
    if (client.ws && client.ws.readyState === 1 && !client.closed && client.sessionTargets.size) {
      for (const sessionId of [...client.sessionTargets.keys()]) {
        try { await client.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 1000 }); } catch { /* 已断/超时均视为已释放 */ }
      }
    }
  } catch { /* 尽力而为 */ }
  try { await client.close(); } catch { /* 尽力而为 */ }
}

/* ── C9 诊断易用性（V20261113001）：所有诊断族共用「结论 + nextStep 动作行」格式化。
 *  结构契约：{ status: 'ok'|'degraded'|'error', conclusion: string, nextStep: string[] }
 *  —— 文本面由各命令打印 `结论：…` / `nextStep：①… ②…`；JSON 面为新增字段（只增不改旧字段/旧行）。
 *  nextStep 按优先级排序（第一条=最该先做的动作）。 */
const NEXT_STEP_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
function fmtNextStep(steps) {
  return (steps && steps.length ? steps : ['无']).map((s, i) => `${NEXT_STEP_MARKS[i] || `${i + 1}.`} ${s}`).join(' ');
}

/** probe 三通道 → 结论/nextStep（纯函数；不改 exit 语义）。
 *  通道状态判据与 cmdProbe 同源：version/evaluate/screenshot.ok|skipped。 */
function probeDiagnosis(ch) {
  const v = ch.version || {}, e = ch.evaluate || {}, s = ch.screenshot || {};
  const problems = [];
  const nextStep = [];
  if (!v.ok) {
    problems.push('①浏览器进程');
    nextStep.push('查 chrome-browser 容器/调试端口（或按 nasBrowserUrlHint 换 browserUrl）');
    nextStep.push('恢复后复跑 probe；容器已起仍不通→browser-restart（人工批准）');
  }
  if (!e.ok) {
    problems.push('②renderer');
    nextStep.push('targets 查页签状态后换 --target 重试（页崩溃/加载中会短暂失效）');
    nextStep.push('仍失败→doctor-forensics 取证（renderer 冻结/域损伤分型）');
  }
  if (!s.ok && !s.skipped) {
    problems.push('③合成器');
    nextStep.push('复跑 probe 确认是否间歇（单次失败可能是瞬时冻结）');
    nextStep.push('仍失败→browser-restart（人工批准），或 exec Page.captureSnapshot 拿 DOM 快照兜底（不依赖合成器）');
  }
  if (s.skipped) nextStep.push('③已跳过：内部页/后台页不出帧属正常——需要截图时切正常网页或 --target 显式指定后复测');
  const ok = !!v.ok && !!e.ok && (!!s.ok || !!s.skipped);
  const conclusion = ok
    ? `三通道全存活（版本 ${v.ms}ms / renderer ${e.ms}ms / 合成器 ${s.skipped ? '跳过' : `${s.ms}ms`}）`
    : `通道降级：${problems.join(' / ')} 失效（逐行结论见上）`;
  if (!nextStep.length) nextStep.push('直接继续目标操作（无需处置）');
  return { status: ok ? 'ok' : 'error', conclusion, nextStep };
}

/** doctor 报告 → 结论/nextStep（纯函数；只读 report，不改健康度判定/exit）。
 *  优先级：截图通道死 > ws 往返异常 > target 堆积 > 全健康。 */
function doctorDiagnosis(report) {
  const sp = report.screenshotProbe || {};
  const ws = report.wsLatency || {};
  const tg = report.targets || {};
  const problems = [];
  const nextStep = [];
  if (sp.status === 'timeout' || sp.status === 'error') {
    problems.push(`截图通道 ${sp.status}`);
    nextStep.push('复跑 doctor 确认是否间歇（单次失败可能是瞬时合成器冻结）');
    nextStep.push('仍失败→browser-restart 重置合成器（人工批准）');
    nextStep.push('急需页面内容→exec Page.captureSnapshot 拿 DOM 快照兜底（不依赖合成器）');
  }
  if (Number(ws.avgMs) >= 500) {
    problems.push(`ws 往返 ${ws.avgMs}ms 偏高`);
    nextStep.push('targets --json 查 attached 客户端与页签数（长驻 MCP/页签堆积会拖慢往返）');
    nextStep.push('确认无并行重操作后复测；持续偏高→doctor-forensics 取证');
  }
  if (Number(tg.total) >= 30) {
    problems.push(`target 总数 ${tg.total} 可能堆积`);
    nextStep.push('targets 检查废弃 service worker/空白页；明确废弃页签用 close 关闭（工具不自动关）');
  }
  if (sp.status === 'skipped') nextStep.push('截图通道已跳过（无 page 型 target）——需要截图/页面操作时先 new 开页再复跑');
  const status = problems.length ? 'degraded' : 'ok';
  const conclusion = status === 'ok'
    ? `通道健康：browser 存活，ws 平均 ${ws.avgMs}ms，截图通道 ${sp.status || '?'}，targets ${tg.total}`
    : `通道可用但有降级项：${problems.join('；')}`;
  if (!nextStep.length) nextStep.push('直接继续目标操作（无需处置）');
  if (status === 'degraded') nextStep.push('按上述动作处置后复跑 doctor 确认');
  return { status, conclusion, nextStep };
}

/* ── probe：三通道依次探测（各 5s 独立超时），输出存活报告 ── */
async function cmdProbe(flags) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  const timeout = num(flags.timeout, 5000);
  const lines = [];
  /* --json data（B1b）：三通道结论+耗时；detail 与文本行同源，避免两套事实 */
  const channels = { version: { ok: false, ms: 0, detail: null, advisory: null }, evaluate: { ok: false, ms: 0, detail: null }, screenshot: { ok: false, ms: 0, detail: null, skipped: false } };
  let t0 = Date.now(), v = null, verErr = null;
  try {
    v = await core.browserVersion(url, timeout);
    const advisory = core.mcpAdvisory(v.Browser || ''); // C2 版本闸：只提示不失败（exit 语义不变）
    channels.version = { ok: true, ms: Date.now() - t0, detail: v.Browser || '', advisory };
    lines.push(`✓ ①浏览器进程 Browser.getVersion：存活（${channels.version.ms}ms，${v.Browser || ''}）`);
    if (advisory) lines.push(`ℹ ${advisory}`);
  }
  catch (e) {
    verErr = e;
    channels.version = { ok: false, ms: Date.now() - t0, detail: `${core.kindText(e.kind)}：${e.message}`, advisory: null };
    lines.push(`✗ ①浏览器进程 Browser.getVersion：失效（${core.kindText(e.kind)}：${e.message}）`);
  }
  if (!v) {
    const hint = core.nasBrowserUrlHint(url);
    if (hint) console.error(`ℹ ${hint}`);
    /* C9：快速失败同样给结论+nextStep（版本通道死=三通道未建立） */
    const diag = {
      status: 'error',
      conclusion: `通道未建立——浏览器进程不可达（${channels.version.detail}）`,
      nextStep: [
        '查 chrome-browser 容器/调试端口（或按上方提示换 browserUrl）',
        '通道恢复后复跑 probe；容器已起仍不通→browser-restart（人工批准）',
        '反复不可达→doctor-forensics 取证（通道死本身即判定原料）',
      ],
    };
    if (jsonMode) return emitFailWithData('probe', errors.codeFor({ kind: verErr && verErr.kind, message: verErr && verErr.message }), `probe ①浏览器进程失效：${channels.version.detail}`, { url, ok: false, channels, conclusionStatus: diag.status, conclusion: diag.conclusion, nextStep: diag.nextStep });
    lines.push(`结论：${diag.conclusion}`);
    lines.push(`nextStep：${fmtNextStep(diag.nextStep)}`);
    console.log(`[probe] ${url}\n[probe] ` + lines.join('\n[probe] '));
    return EXIT_ERR;
  }
  const client = trackedClient(core, url, timeout);
  try {
    await client.connect();
    let tg = null;
    t0 = Date.now();
    try {
      tg = await core.resolveTarget(client, flags.target);
      const rs = await core.evaluate(client, tg.sessionId, 'document.readyState');
      channels.evaluate = { ok: true, ms: Date.now() - t0, detail: `${(tg.target.title || tg.target.url).slice(0, 50)} → ${rs}` };
      lines.push(`✓ ②renderer Runtime.evaluate(readyState)：存活（${channels.evaluate.ms}ms，${channels.evaluate.detail}）`);
    } catch (e) {
      channels.evaluate = { ok: false, ms: Date.now() - t0, detail: `${core.kindText(e.kind) || '错误'}：${e.message}` };
      lines.push(`✗ ②renderer Runtime.evaluate(readyState)：失效（${core.kindText(e.kind) || '错误'}：${e.message}）`);
    }
    t0 = Date.now();
    try {
      const hit = tg || (await core.resolveTarget(client, flags.target));
      const targetUrl = String((hit.target && hit.target.url) || '');
      /* GQ-003：chrome://newtab 等内部页在窗口非前台/未渲染时不产帧，captureScreenshot 超时属页面性质
       * （非合成器失效）——诊断面跳过并注明，避免 probe 误报三通道全红。 */
      if (core.isNoFrameUrl(targetUrl)) {
        channels.screenshot = { ok: false, skipped: true, ms: 0, detail: `跳过：${targetUrl.slice(0, 60)} 不出帧属正常（内部页未渲染/窗口非前台）` };
        lines.push(`⏭ ③合成器 Page.captureScreenshot：跳过（当前目标 ${targetUrl.slice(0, 60)} 不出帧属正常——内部页未渲染/窗口非前台；换正常网页或 --target 显式指定后再测合成器）`);
      } else {
        const data = await core.screenshot(client, hit.sessionId, { timeoutMs: timeout });
        const note = flags.out ? `已存 ${flags.out}（${writeBin(flags.out, data)} 字节）` : `${data.length} base64 字符（--out 可落盘）`;
        channels.screenshot = { ok: true, skipped: false, ms: Date.now() - t0, detail: note };
        lines.push(`✓ ③合成器 Page.captureScreenshot：存活（${channels.screenshot.ms}ms，${note}）`);
      }
    } catch (e) {
      channels.screenshot = { ok: false, skipped: false, ms: Date.now() - t0, detail: `${core.kindText(e.kind) || '错误'}：${e.message}` };
      lines.push(`✗ ③合成器 Page.captureScreenshot：失效（${core.kindText(e.kind) || '错误'}：${e.message}）`);
    }
  } finally { await gracefulClose(client); }
  const diag = probeDiagnosis(channels);
  if (jsonMode) return emitOk('probe', { url, ok: channels.version.ok && channels.evaluate.ok && (channels.screenshot.ok || channels.screenshot.skipped), channels, conclusionStatus: diag.status, conclusion: diag.conclusion, nextStep: diag.nextStep });
  lines.push(`结论：${diag.conclusion}`);
  lines.push(`nextStep：${fmtNextStep(diag.nextStep)}`);
  console.log(`[probe] ${url}\n[probe] ` + lines.join('\n[probe] '));
  return EXIT_OK;
}
function writeBin(file, base64) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* ── exec：万能口（浏览器级命令免 --target；页面级命令必须 --target） ── */
async function cmdExec(pos, flags) {
  const method = pos[0];
  const paramsFile = flags['params-file'];
  if (!method) die('用法：cdp.js exec <method> [paramsJSON | --params-file <path>] [--target pageId|url子串|title子串] [--timeout ms]');
  if (paramsFile !== undefined && pos[1] !== undefined) die('exec 的 paramsJSON 与 --params-file 二选一（PowerShell 引号吞噬时优先 --params-file）');
  if (paramsFile === true) die('--params-file 缺值（JSON 文件路径）');
  let params;
  if (paramsFile !== undefined) {
    let text;
    try { text = pageOps.readExpressionFile(paramsFile, { flag: '--params-file', label: 'params 文件' }); } catch (e) { die(e.message); }
    try { params = JSON.parse(text); } catch (e) { die(`--params-file JSON 解析失败（${paramsFile}）：${e.message}`); }
  } else if (pos[1] !== undefined) { try { params = JSON.parse(pos[1]); } catch (e) { die(`paramsJSON 解析失败：${e.message}（PowerShell/CMD 引号易被吞噬——优先 --params-file <path>）`); } }
  const browserLevel = /^(Browser|Target|SystemInfo)\./.test(method);
  if (!browserLevel && !flags.target) die(`命令 ${method} 需要 --target（Browser.*/Target.* 等浏览器级命令除外）；破坏性命令务必确认目标再执行`);
  auditInsecureCerts(flags);
  const { core, client, url } = await openClient(flags, undefined, { insecure: !!flags.insecure });
  try {
    let result;
    if (flags.target) {
      const { sessionId, target } = await core.resolveTarget(client, flags.target);
      console.error(`[exec] 目标：${(target.title || target.url).slice(0, 60)}（${target.id}）`);
      result = await client.send(method, params, { sessionId, timeoutMs: num(flags.timeout, 5000) });
    } else {
      result = await client.send(method, params, { timeoutMs: num(flags.timeout, 5000) });
    }
    console.log(JSON.stringify(result, null, 2));
    console.error(`[exec] ✓ ${method} @ ${url}`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── targets：默认 HTTP /json/list（无需 WS）；--json = WS Target.getTargets 结构化投影 ── */
async function cmdTargets(flags) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  if (flags.json) {
    // --json 必须走 WS：attached 字段来自 Target.getTargets（HTTP /json/list 不保证）
    const client = trackedClient(core, url, num(flags.timeout, 5000));
    try {
      await client.connect();
      const infos = await pageOps.listTargetInfos(client, { timeoutMs: num(flags.timeout, 5000) });
      const report = pageOps.projectTargets(infos, { at: time.isoLocal(), browserUrl: url });
      return emitOk('targets', report); // B1b：data=旧 chromeuse-targets/1 报告（deep-equal 契约）
    } finally { await gracefulClose(client); }
  }
  const list = await core.listTargets(url, num(flags.timeout, 5000));
  let agentIds = new Set();
  let agentOwners = new Map();
  let markPrefix = tabGovern.DEFAULTS.markPrefix;
  try {
    const loaded = tabGovern.loadRegistry();
    agentIds = new Set(Object.keys(loaded.registry.tabs));
    agentOwners = new Map(Object.entries(loaded.registry.tabs).map(([id, e]) => [id, e.owner || '']));
    markPrefix = tabOptions().markPrefix;
  } catch { /* 治理旁路：读表失败仍照常列页签 */ }
  console.log(`[targets] ${url} 共 ${list.length} 个 target：`);
  for (const t of list) {
    // 注册表=权威标记；title 前缀=展示辅助（导航覆盖后仍可人工辨认，不参与回收判据）
    // C1：命名会话 owner 非缺省时标 [cu:<owner>]（单用户仍 [cu]，输出零变化）
    const marked = agentIds.has(t.id) || tabGovern.hasAgentMark(t.title, markPrefix);
    const owner = agentOwners.get(t.id) || '';
    const mark = marked ? (owner && owner !== tabGovern.DEFAULT_OWNER ? `[cu:${owner}] ` : '[cu] ') : '     ';
    console.log(`  ${String(t.type).padEnd(14)} ${String(t.id).slice(0, 8)}  ${mark}${(t.title || '').slice(0, 36).padEnd(36)}  ${(t.url || '').slice(0, 80)}`);
  }
  return EXIT_OK;
}

/* ── net：Network 域采集窗口 + body 拉取（【冻结期 Network 域可用性实测】工具；--har = HAR 1.2 导出） ── */
async function cmdNet(flags) {
  const duration = num(flags.duration, 5000);
  const wantHar = flags.har !== undefined;
  if (wantHar && (flags.har === true || String(flags.har).trim() === '')) die('--har 缺值（HAR 1.2 输出文件路径）');
  const captureStartedAt = time.isoLocal();
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    await client.send('Network.enable', {}, { sessionId });
    const reqs = new Map();
    const off = client.onEvent(({ sessionId: sid, method, params }) => {
      if (sid !== sessionId) return;
      if (method === 'Network.requestWillBeSent') {
        const r = { url: params.request.url, method: params.request.method, hasPost: !!params.request.postData };
        if (wantHar) {
          // HAR 需要更富字段：请求头/时间戳（默认路径零变化——#111 golden 守门）
          r.reqHeaders = params.request.headers || {};
          r.startedAt = params.wallTime ? new Date(params.wallTime * 1000).toISOString() : captureStartedAt;
          r.tsMono = Number(params.timestamp);
        }
        reqs.set(params.requestId, r);
      } else if (method === 'Network.responseReceived') {
        const r = reqs.get(params.requestId);
        if (r) {
          r.status = params.response.status;
          r.mime = params.response.mimeType;
          if (wantHar) { r.respHeaders = params.response.headers || {}; r.protocol = params.response.protocol || ''; }
        }
      } else if (method === 'Network.loadingFinished') {
        const r = reqs.get(params.requestId);
        if (r) { r.done = true; if (wantHar && Number.isFinite(r.tsMono) && Number.isFinite(Number(params.timestamp))) r.timeMs = Math.round((Number(params.timestamp) - r.tsMono) * 1000); }
      } else if (method === 'Network.loadingFailed') { const r = reqs.get(params.requestId); if (r) r.err = params.errorText; }
    });
    console.error(`[net] 目标：${redact.text((target.title || target.url).slice(0, 60))}；采集窗口 ${duration}ms（窗口内避免 MCP 重操作——R30）…`);
    await sleep(duration);
    off();
    let list = [...reqs.entries()].map(([id, r]) => Object.assign({ id }, r));
    if (flags.filter) list = list.filter((r) => r.url.includes(flags.filter));
    for (const r of list) {
      if (!r.err) {
        try { const b = await client.send('Network.getResponseBody', { requestId: r.id }, { sessionId }); r.body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body; }
        catch (e) { r.bodyErr = e.message; }
        if (r.hasPost) { try { const p = await client.send('Network.getRequestPostData', { requestId: r.id }, { sessionId }); r.postData = p.postData; } catch { /* 无 body */ } }
      }
    }
    const pick = flags.get ? list.filter((r) => r.id === flags.get) : list;
    for (const r of pick) {
      const size = r.body === undefined ? '—' : `${r.body.length} 字节`;
      const shownUrl = redact.text(r.url.slice(0, 100)); // B6b N7：URL query 按 redact.urlParams 脱敏（过渡防线）
      console.log(`[net] ${r.method} ${r.status || '…'} ${shownUrl}${r.err ? ` ✗ ${r.err}` : `（${size}${r.postData ? '，有 payload' : ''}）`}`);
      if (flags.get && r.body !== undefined) console.log(redact.text(r.body.length > 4000 ? r.body.slice(0, 4000) + '…' : r.body));
    }
    const file = flags.out || path.join(paths.EVENTS_DIR,  `net-${ts()}.json`);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ capturedAt: time.isoLocal(), target: target.url, filter: flags.filter || null, requests: list }, null, 2));
    console.error(`[net] 共 ${list.length} 条（匹配 filter=${flags.filter || '无'}）；全量含 body 已存 ${file}`);
    if (wantHar) {
      let creatorVersion = 'unknown';
      try { creatorVersion = fs.readFileSync(path.join(__dirname, '..', 'VERSION.md'), 'utf8').trim() || 'unknown'; } catch { /* fail-soft */ }
      const { har, stats } = harLib.buildHar(
        { capturedAt: captureStartedAt, startedAt: captureStartedAt, target: { url: target.url, title: target.title }, requests: list },
        { creator: { name: 'chromeuse', version: creatorVersion } },
      );
      const harFile = String(flags.har).trim();
      fs.mkdirSync(path.dirname(path.resolve(harFile)), { recursive: true });
      fs.writeFileSync(harFile, JSON.stringify(har, null, 2));
      console.error(`[net] HAR 1.2 已导出 ${harFile}（${stats.entries} entries，脱敏 ${stats.redacted} 处${stats.networkErrors ? `，网络错误 ${stats.networkErrors}` : ''}${stats.bodyErrors ? `，body 读取失败 ${stats.bodyErrors}` : ''}）`);
    }
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/**
 * 还原失败兜底（V202610210001）：finally 的 clear 需要活连接——若 WS 在覆盖生效期断开（实测：页面重绘
 * 把浏览器连接打挂时 clear 送不出去，覆盖会残留在页签上），用**新连接**再清一次并读回实测。
 * V202610210002 补强（scroll-shot 实测）：断开后「单发 clear」在新连接上可能无效（实测 read 回仍是覆盖值），
 * 改为 baseline 已知时**先 set 回基线再 clear**（同一 session 内 set→clear 实测可复原），并校验读回值。
 * 共享浏览器卫生红线：绝不给用户页签留 Emulation.setDeviceMetricsOverride 残留。fail-soft 恒返回。
 */
async function retryClearEmulation(flags, target, baseline) {
  let client2 = null;
  try {
    const core2 = require('../lib/cdp-core');
    const timeout = num(flags.timeout, 5000);
    client2 = trackedClient(core2, core2.resolveBrowserUrl(flags.url), timeout);
    await client2.connect();
    const sid = await client2.attach(target.id, timeout);
    const base = baseline && Number(baseline.width) > 0 && Number(baseline.height) > 0
      ? { width: Math.round(Number(baseline.width)), height: Math.round(Number(baseline.height)), deviceScaleFactor: Number(baseline.dpr) || 1, mobile: false }
      : null;
    if (base) await client2.send('Emulation.setDeviceMetricsOverride', base, { sessionId: sid, timeoutMs: timeout });
    await client2.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId: sid, timeoutMs: timeout });
    const r = await client2.send('Runtime.evaluate', { expression: '({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})', returnByValue: true }, { sessionId: sid, timeoutMs: timeout });
    const v = (r && r.result && r.result.value) || {};
    const after = { width: v.iw, height: v.ih, dpr: v.dpr };
    const drift = base ? (after.width !== base.width || after.height !== base.height || Math.abs(after.dpr - base.deviceScaleFactor) > 0.001) : false;
    if (drift) return { ok: false, error: `clear 后读回仍与基线不符（实测 ${after.width}x${after.height}@${after.dpr}，基线 ${base.width}x${base.height}@${base.deviceScaleFactor}）`, after, baselineReset: true };
    return { ok: true, after, baselineReset: !!base };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (client2) { try { await gracefulClose(client2); } catch { /* 尽力而为 */ } } }
}

/** 视口覆盖还原收尾（V202610210001）：restore 未成功 → 新连接重试 clear + 如实打印/记日志；
 *  返回打印用提示串（成功/仍失败含手工恢复命令）。emu=null（默认零 Emulation）→ 直接空串。
 *  V202610210002：兜底时带上 emu.pre 基线（先 set 回基线再 clear——断链后单发 clear 可能无效）。 */
async function ensureEmulationRestored(flags, target, emu) {
  if (!emu || !emu.restore || emu.restore.ok) return '';
  const retry = await retryClearEmulation(flags, target, emu.pre);
  emu.restoreRetry = retry;
  if (retry.ok) {
    const note = `还原兜底：原连接已断，已用新连接${retry.baselineReset ? '先 set 回基线再 clear' : '清除'} 视口覆盖（实测 innerWidth=${retry.after.width} innerHeight=${retry.after.height} dpr=${retry.after.dpr}）`;    console.error(`[screenshot] ⚠ ${note}`);
    log.warn('cdp', `screenshot 视口还原走兜底：${note}`);
    return `；⚠ 还原兜底：${note}`;
  }
  const note = `视口覆盖可能仍残留在页签上——手工恢复：node tools/cdp.js exec 'Emulation.setDeviceMetricsOverride' '{"width":<w>,"height":<h>,"deviceScaleFactor":<dpr>,"mobile":false}' --target ${String(target.id || '').slice(0, 8)} 后 node tools/cdp.js exec 'Emulation.clearDeviceMetricsOverride' '{}' --target ${String(target.id || '').slice(0, 8)}`;
  console.error(`[screenshot] ⚠ 还原兜底失败（${retry.error}）：${note}`);
  log.warn('cdp', `screenshot 视口还原兜底失败：${retry.error}（${note}）`);
  return `；⚠ 还原兜底失败：${note}`;
}

/* ── screenshot --annotate 辅助（C5 N11）──
 * ref 物化预算独立于 --timeout（后者是截图超时语义）：默认 10s，与 a11y --timeout 默认同档。
 * 失败/超时/降级一律抛错（调用方 die，不静默降级——标注图缺编号会误导定位）。 */
const ANNOTATE_REF_BUDGET_MS = 10000;
async function readScroll(client, sessionId, timeoutMs) {
  const r = await client.send('Runtime.evaluate', {
    expression: '({ x: window.scrollX, y: window.scrollY })', returnByValue: true,
  }, { sessionId, timeoutMs });
  const v = r && r.result && r.result.value;
  if (!v) throw new Error('滚动位置读取返回空值（Runtime.evaluate returnByValue 无 result.value）');
  return { x: Number(v.x) || 0, y: Number(v.y) || 0 };
}

/** 现场物化 ref 表（与 a11y --ref 同源）→ entries[{ref,viewRect}] + 视口/滚动基线 */
async function collectAnnotateRefs(client, sessionId, target, shot, timeoutMs) {
  const annotate = require('../lib/annotate');
  const perceive = require('../lib/perceive');
  const refsMod = require('../lib/refs');
  const opt = perceive.normalizeA11yOptions({ timeoutMs: ANNOTATE_REF_BUDGET_MS });
  const report = await perceive.runA11y(client, sessionId, opt, {
    target: { id: String(target.id || ''), url: String(target.url || ''), title: String(target.title || '') },
  });
  if (!report || report.ok !== true) {
    throw new Error(`--annotate 无法产 ref 表：a11y 取树失败（${(report && (report.error || report.reason)) || '未知'}）——不静默降级；先跑 a11y --ref 排查`);
  }
  if (report.timedOut || report.degraded) {
    throw new Error(`--annotate 无法产 ref 表：a11y ${report.timedOut ? `超时（${opt.timeoutMs}ms）` : '降级'}`
      + `（nodeCount=${report.nodeCount || 0}${report.error ? `；${report.error}` : ''}）——不静默降级；重试/换页或先 a11y --ref 核查`);
  }
  const metrics = await shot.readMetrics(client, sessionId, timeoutMs);
  const scrollBefore = await readScroll(client, sessionId, timeoutMs);
  const rows = opt.frames === 'same-origin'
    ? (report.nodes || []).filter((row) => !row || !Array.isArray(row.framePath) || row.framePath.length === 0)
    : (report.nodes || []);
  const mat = await refsMod.materializeRefs(client, sessionId, rows, {
    target: { id: target.id, url: target.url, title: target.title },
    framePath: (report.element && report.element.framePath) || [],
    timeoutMs: ANNOTATE_REF_BUDGET_MS,
    query: report.query || null,
  });
  if (!mat || mat.ok !== true) throw new Error(`--annotate 无法产 ref 表：${(mat && mat.error) || 'materialize-failed'}——不静默降级`);
  const entries = (mat.refs || []).map((rec) => ({
    ref: rec.ref,
    role: rec.role || '',
    name: String(rec.name || '').slice(0, 120),
    viewRect: annotate.refViewportRect(rec, scrollBefore),
  }));
  return { entries, metrics, scrollBefore, generation: (mat.table && mat.table.generation) || null, refTable: mat.tablePath || null, stats: mat.stats || null, note: mat.note || null };
}

/* ── screenshot：独立短超时截图落盘 ──
 * V202609130003 通道加固（研究题 1：多标签 race + 合成器冻结）：Page.bringToFront 前置 + 失败重试。
 * V202609220002 兜底体系（TODO【截图通道兜底体系完善】①②④③）：实现单源迁 lib/screenshot.js——
 *   fromSurface:false 诊断裁决降级 + 失败诊断矩阵（runtimeCheck/layoutMetricsCheck/双路径）+
 *   冷启动停滞退避（2s/5s/10s 可配 CHROMEUSE_SCREENSHOT_BACKOFF）+ screencast 活跃帧兜底（advisory）。
 *   链路与判读详见 lib/screenshot.js 文件头；成功输出格式兼容（只增 via/退避标注）；
 *   最终失败输出 chromeuse-screenshot-fail/1 结构化报告（含全矩阵 + 帧兜底产物指引）。
 *   probe/watch 的截图探针与 doctor screenshotProbe 保持裸通道/原语义——那是诊断面，不加固以保留原始信号。
 * V202610210001 截图增强（TODO【screenshot 增强：--dpr/--viewport/--format/--quality】B2/B3）：
 *   --dpr / --viewport 的唯一实现走 lib/screenshot.js 的 Emulation.setDeviceMetricsOverride 显式覆盖
 *   （截图前施加、finally 用 clearDeviceMetricsOverride 还原；不传旗标 → 全程零 Emulation 命令，默认零改变）；
 *   --format/--quality 透传 Page.captureScreenshot（quality 仅 jpeg），输出扩展名按 format 决定。
 * C5 N11（TODO L107）screenshot --annotate（V20261104003）：Node 侧叠字标注（lib/annotate.js 单源）——
 *   截图前现场物化一份 ref 表（与 a11y --ref 同编号源，落 tmpdata/refs/），把 @eN 画成红框+黄底编号；
 *   纯 Node zlib PNG codec + 内置 5x7 点阵字模（零依赖零字体；ffmpeg drawtext 不可用见 lib/annotate.js 头）。
 *   **零页面副作用**：不注入 overlay/DOM 改动；真实点击路径不变（仍走 click --ref 的 X1 闸门+三级定位链）。
 *   仅支持 --format png；物化超时/失败/a11y 降级 → 明确报错不静默降级；**--annotate 关闭时本分支零参与**。
 *   物化→截图间页面滚动按 scroll 差修正并如实标注；--dpr/--viewport 由本分支自管 Emulation（覆盖期内取坐标）。
 */
async function cmdScreenshot(flags) {
  const shot = require('../lib/screenshot');
  const annotate = require('../lib/annotate');
  // 参数先行校验（纯函数；不建连即明确报错——非法旗标绝不静默忽略）
  let cap;
  try {
    cap = shot.formatPlan({ format: flags.format, quality: flags.quality });
    shot.metricsPlan({ dpr: flags.dpr, viewport: flags.viewport });
  } catch (e) { die(`${e.message}（--help 看 screenshot 用法）`); }
  let annotateOn = false;
  try { annotateOn = annotate.normalizeAnnotate(flags); } catch (e) { die(`${e.message}（--help 看 screenshot 用法）`); }
  if (annotateOn && cap.format !== 'png') die('--annotate 仅支持 --format png（叠字需无损解码 PNG；jpeg 无法标注）');
  if (cap.qualityIgnored) console.error('[screenshot] ⚠ --quality 仅对 jpeg 有效：--format png 时忽略该值（无损格式无 quality 语义）');
  if (cap.format === 'jpeg') console.error(`[screenshot] jpeg 质量：${cap.quality}（来源 ${cap.qualitySource === 'explicit' ? '--quality' : cap.qualitySource === 'env' ? 'CHROMEUSE_JPEG_QUALITY' : '默认 90'}）`);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const timeoutMs = num(flags.timeout, 5000);
    /* --annotate：先物化 ref 表（与 a11y --ref 同源）+ 视口/滚动基线；--dpr/--viewport 由本分支自管
     * Emulation（screenshotHardened 收不到指标参数 → 不会提前还原，标注坐标在覆盖生效期内取得）。 */
    let annState = null;
    let ownEmu = null;
    if (annotateOn) {
      if (flags.dpr != null || flags.viewport != null) {
        try { ownEmu = await shot.beginEmulation(client, sessionId, { dpr: flags.dpr, viewport: flags.viewport }, timeoutMs); }
        catch (e) {
          if (e && e.emulation) { ownEmu = e.emulation; await shot.endEmulation(client, sessionId, ownEmu, timeoutMs); }
          die(e.message);
        }
      }
      try { annState = await collectAnnotateRefs(client, sessionId, target, shot, timeoutMs); }
      catch (e) {
        if (ownEmu) { await shot.endEmulation(client, sessionId, ownEmu, timeoutMs); ownEmu = null; }
        die(e.message, e.kind);
      }
    }
    let r;
    try {
      r = await shot.screenshotHardened(client, sessionId, {
        timeoutMs,
        targetId: target.id,
        dpr: annotateOn ? undefined : flags.dpr,
        viewport: annotateOn ? undefined : flags.viewport,
        format: flags.format,
        quality: flags.quality,
      });
      if (annState) {
        annState.scrollAfter = await readScroll(client, sessionId, timeoutMs);
        /* 代际闸门（与 click --ref 同契约）：物化后导航/刷新 → loaderId 变化，标注坐标失效 → 明确中止，不静默出错图 */
        try { annState.generationAfter = await require('../lib/refs').captureGeneration(client, sessionId, Math.min(5000, timeoutMs)); } catch { annState.generationAfter = null; }
        const g0 = annState.generation, g1 = annState.generationAfter;
        if (g0 && g1 && g0.loaderId && g1.loaderId && String(g0.loaderId) !== String(g1.loaderId)) {
          throw new Error('--annotate 中止：物化 ref 表后页面发生导航/刷新（loaderId 变化），标注坐标已失效——不静默降级，请重试');
        }
      }
    } catch (e) {
      if (!e || !e.matrix) throw e; // 非截图链路错误（连接/解析）原样上抛
      // 失败报告（chromeuse-screenshot-fail/1）：诊断矩阵平铺为一级字段（spec 值域 ok/timeout/error:<msg截断>）
      const report = {
        format: 'chromeuse-screenshot-fail/1',
        at: time.isoLocal(),
        target: { id: String(target.id || '').slice(0, 8), url: String(target.url || '').slice(0, 100), title: String(target.title || '').slice(0, 50) },
        error: e.message,
        runtimeCheck: e.matrix.runtimeCheck,
        layoutMetricsCheck: e.matrix.layoutMetricsCheck,
        fromSurfaceTrue: e.matrix.fromSurfaceTrue,
        fromSurfaceFalse: e.matrix.fromSurfaceFalse,
        verdicts: e.matrix.verdicts || [],
        controlShot: e.matrix.controlShot || null,
        controlNote: e.matrix.controlNote || null,
        backoff: e.matrix.backoff || null,
        emulation: e.matrix.emulation || ownEmu || null, // 显式视口/DPR 覆盖状态（含 mismatch/还原结果；未请求=null；--annotate 自管覆盖时取本分支状态）
        screencastFallback: null,
        hint: '判读：runtime 通而截图败=截图路径异常｜runtime 也败=更广泛阻塞｜双路径分化=路径兼容问题；fallback：exec Page.captureSnapshot（DOM 快照不依赖合成器）/browser-restart',
      };
      // ③ screencast 活跃帧兜底（advisory）：-v 录屏帧流活着才兜（无会话如实注明跳过）；fail-soft
      try {
        const fb = shot.latestLiveFrame(paths.VIDEO_DIR, Date.now(), 60000);
        report.screencastFallback = fb
          ? Object.assign({ source: 'screencast-frame', frame: fb.file, tab: fb.tab, tArrive: new Date(fb.tArrive).toISOString(), ageMs: Date.now() - fb.tArrive }, shot.saveFrame(fb.file, path.join(paths.EVENTS_DIR, `screenshot-fallback-${ts()}.png`)))
          : { source: null, note: '无活跃 screencast 帧流（-v 未开或最近帧超 60s 时效窗）——帧兜底跳过（如实注明）' };
      } catch (fe) { report.screencastFallback = { source: null, note: `帧兜底探测失败（fail-soft）：${fe.message}` }; }
      console.error(`[screenshot] ✗ 截屏最终失败：${(target.title || target.url).slice(0, 60)}`);
      // 覆盖未还原兜底（连接断开时 finally 的 clear 可能送不出去）——失败路径同样要清干净
      await ensureEmulationRestored(flags, target, e.matrix.emulation);
      if (jsonMode) {
        log.warn('cdp', `screenshot 最终失败（矩阵 runtime=${report.runtimeCheck}/layout=${report.layoutMetricsCheck}/双路径=${report.fromSurfaceTrue}→${report.fromSurfaceFalse}）`);
        return emitFailWithData('screenshot', errors.codeFor({ kind: e.kind, message: e.message }), `截屏最终失败：${e.message}`, report);
      }
      console.log(JSON.stringify(report, null, 2));
      log.warn('cdp', `screenshot 最终失败（矩阵 runtime=${report.runtimeCheck}/layout=${report.layoutMetricsCheck}/双路径=${report.fromSurfaceTrue}→${report.fromSurfaceFalse}）`);
      return EXIT_ERR;
    } finally {
      if (ownEmu) {
        await shot.endEmulation(client, sessionId, ownEmu, timeoutMs);
        if (annState) annState.emulation = ownEmu;
      }
    }
    /* --annotate 叠字（Node 侧，零页面副作用）：refs 表总数=total，可画数=annotated（视口外如实 skipped） */
    let ann = null;
    let annDrift = null;
    let annNote = '';
    if (annState) {
      const dx = annState.scrollBefore.x - annState.scrollAfter.x;
      const dy = annState.scrollBefore.y - annState.scrollAfter.y;
      annDrift = (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) ? { x: dx, y: dy } : null;
      const list = annState.entries.map((e) => ({
        ref: e.ref,
        rect: e.viewRect ? { x: e.viewRect.x + dx, y: e.viewRect.y + dy, w: e.viewRect.w, h: e.viewRect.h } : null,
      }));
      if (!list.length) {
        annNote = '｜annotate 跳过：现场 ref 表为空（无可标注节点），截图保持原字节';
        log.warn('cdp', 'screenshot --annotate：ref 表为空，截图未叠字');
      } else {
        try {
          const res = annotate.annotatePng(Buffer.from(String(r.data || ''), 'base64'), list, { viewport: annState.metrics });
          ann = { annotated: res.annotated, total: list.length, skipped: res.skipped, markers: res.markers, buffer: res.buffer, scale: res.scale, refTable: annState.refTable };
          const skipText = res.skipped.length
            ? `（skipped ${res.skipped.length}：${Array.from(new Set(res.skipped.map((s) => s.reason))).join('/')}）` : '';
          annNote = `｜annotate ${res.annotated}/${list.length} ref${skipText}`
            + (annDrift ? `；⚠ 物化→截图间页面滚动 dx=${annDrift.x} dy=${annDrift.y}（已按 scroll 差修正）` : '');
        } catch (e) {
          die(`--annotate 叠字失败：${e.message}（原截图未落盘；可去掉 --annotate 重截原图）`);
        }
      }
    }
    // 输出路径：扩展名以 --format 为准（--out 扩展名不一致 → 改写并告警，证据文件不谎报编码）
    const outPlan = shot.planOutPath({ out: flags.out, format: r.format, stamp: ts(), eventsDir: paths.EVENTS_DIR });
    if (outPlan.note) console.error(`[screenshot] ⚠ ${outPlan.note}`);
    const out = outPlan.file;
    /* 产物配额准入（B3 N2）：落盘前检查（单产物/总配额）；拒绝=E_QUOTA，不写半文件 */
    const shotBytes = ann ? ann.buffer.length : Buffer.byteLength(String(r.data || ''), 'base64');
    const qa = quota.check({ file: out, bytes: shotBytes, cmd: 'screenshot' });
    if (!qa.ok) die(qa.message, qa.code);
    if (qa.message) console.error(`[screenshot] ⚠ ${qa.message}`);
    const bytes = ann ? writeBin(out, ann.buffer.toString('base64')) : writeBin(out, r.data);
    audit.setArtifact(out);
    const diagNote = (r.via === 'fromSurface:false' || r.recoveredByBackoff)
      ? `｜⚠ via=${r.via}${r.recoveredByBackoff ? '（退避恢复，疑似冷启动/合成器停滞）' : '（双路径分化=路径兼容问题，advisory）'}`
      : '';
    // 覆盖生效/还原如实呈现（mismatch 不静默吞——advisory 风格同 click 前置视口校验）
    const emu = r.emulation || (annState && annState.emulation) || null;
    const restoreNote = await ensureEmulationRestored(flags, target, emu);
    const emuNote = emu
      ? `｜视口 ${emu.plan.width}x${emu.plan.height}@DPR ${emu.plan.deviceScaleFactor}（实测 innerWidth=${emu.post.width} innerHeight=${emu.post.height} dpr=${emu.post.dpr}`
        + `${emu.mismatch && emu.mismatch.length ? `；⚠ mismatch：${emu.mismatch.join('；')}` : ' ✓'}）`
        + `${emu.restore ? (emu.restore.ok ? '；已还原' : `；⚠ 还原异常：${emu.restore.error || (emu.restore.drift || []).join('；')}`) : ''}`
        + restoreNote
      : '';
    if (diagNote) log.warn('cdp', `screenshot 降级/退避恢复（via=${r.via}）——截图通道健康度预警`);
    if (emu && emu.mismatch && emu.mismatch.length) log.warn('cdp', `screenshot 视口覆盖 mismatch：${emu.mismatch.join('；')}（已如实标注，实际像素以文件为准）`);
    if (emu && emu.restore && !emu.restore.ok) log.warn('cdp', `screenshot 视口还原异常：${emu.restore.error || (emu.restore.drift || []).join('；')}`);
    info(`[screenshot] ✓ ${(target.title || target.url).slice(0, 60)} → ${out}（${bytes} 字节，${r.format}${r.quality != null ? ` q${r.quality}` : ''}，via=${r.via}）${emuNote}${diagNote}${annNote}`);
    /* 文本模式叠加 refs 摘要（--json 在 data.annotate；与图上编号一一对应，供定位核对） */
    if (ann && !jsonMode) {
      console.log(`[screenshot] refs ${JSON.stringify({
        refs: ann.markers.map((m) => ({ ref: m.ref, rect: m.rect })),
        skipped: ann.skipped,
        refTable: ann.refTable,
      })}`);
    }
    if (jsonMode) return emitOk('screenshot', {
      target: { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || ''), short: (target.title || target.url).slice(0, 60) },
      out, bytes, format: r.format, quality: r.quality == null ? null : r.quality, via: r.via,
      recoveredByBackoff: !!r.recoveredByBackoff,
      emulation: emu ? { plan: emu.plan || null, post: emu.post || null, mismatch: emu.mismatch || [], restore: emu.restore || null } : null,
      annotate: ann ? {
        refs: ann.markers.map((m) => ({ ref: m.ref, rect: m.rect })),
        skipped: ann.skipped,
        annotated: ann.annotated,
        total: ann.total,
        scale: ann.scale,
        refTable: ann.refTable,
        scrollDrift: annDrift,
      } : (annotateOn ? { refs: [], skipped: [], annotated: 0, total: annState ? annState.entries.length : 0, note: annNote || null } : null),
    });
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── scroll-shot：长文/长页长图分段拼接（V202610210002；TODO ④ 新功能区）──
 * 需求：竞品采集长文 2~4 万 CSS px 截不全（C1 23805px 整页报 Unable to capture screenshot；D1 查看端
 *   >~4600px 降采样；C2 懒加载图不滚不加载；C4 末段重叠；C6 PNG 16MB；B4 单页 120s 超时）。
 * 实现单源 lib/scroll-shot.js：预热（逐屏下滚→到底等高度稳定→回顶→等图片就绪）→ planSlices 分段
 *   （step=min(视口高, chunkCss)，末段取余数）→ 逐段取图（A=整段 clip captureBeyondViewport；
 *   失败重试 1 次 → B=逐视口截图 + bin/ffmpeg vstack，ffmpeg 缺失如实失败）→ 清单 JSON。
 * V202610210003（用户裁定）：--max-chunk 默认**物理像素**（--max-chunk-unit px|css）／--overlap 非末段向下
 *   多拍／PNG 预防告警 + 逐段 jpeg 降级（--no-format-fallback 关）／--viewport-max-chunk 显式把视口高
 *   覆盖成 chunkCss（隐含显式 Emulation，finally 还原）。
 * V202610210004（竞品采集第二轮实测真 bug 修复）：图片就绪判据从 `complete && naturalWidth > 0` 改为
 *   classifyImg 三态（**naturalWidth > 1** 才算 loaded）——旧判据把微信
 *   `<img class="… js_img_placeholder" src="data:image/svg+xml,…">`（complete=true, naturalWidth=1）
 *   误判为已加载 → 单篇长图中间成段 1000~20000px 纯白。新增 --img-promote（默认开）/--no-img-promote
 *   （强制 data-src 纯属性赋值，绕过未触发的 IntersectionObserver）与 --img-settle（默认 1800ms 首帧解码）。
 * 安全面：滚动只用 evaluate window.scrollTo（只读定位，禁合成事件）；--dpr/--viewport 只在显式时
 *   施加 Emulation，finally 单点还原 + 回滚 scrollY；**不关闭用户页签**（不是自己开的页面）。
 */
async function cmdScrollShot(flags) {
  const ss = require('../lib/scroll-shot');
  // 参数先行校验（纯函数；不建连即明确报错——非法旗标绝不静默忽略）
  let opts;
  try {
    opts = ss.normalizeOptions({
      maxChunk: flags['max-chunk'],
      maxChunkUnit: flags['max-chunk-unit'],
      overlap: flags.overlap,
      viewportMaxChunk: flags['viewport-max-chunk'],
      formatFallback: flags['no-format-fallback'] === undefined,
      settle: flags.settle,
      timeoutMs: flags.timeout,
      prewarmSamples: flags['prewarm-samples'],
      imageTimeout: flags['image-timeout'],
      imgSettle: flags['img-settle'],
      // --img-promote 默认开；显式 --no-img-promote 关闭（缺省视为开——只有给出该旗标才关）
      imgPromote: flags['no-img-promote'] === undefined,
      // 空白段自检（F13）：默认开（advisory 只报告）；--no-blank-check 关；--blank-strict 才判死
      blankCheck: flags['no-blank-check'] === undefined,
      blankMinPx: flags['blank-min-px'],
      blankThreshold: flags['blank-threshold'],
      blankStrict: !!flags['blank-strict'],
      // 切点吸附（F15）：默认开（DOM 优先）；--no-snap-cuts 关；--snap-window 32~512；--snap-px 显式开像素兜底
      snapCuts: flags['no-snap-cuts'] === undefined,
      snapWindow: flags['snap-window'],
      snapPx: !!flags['snap-px'],
      // 前台保障（V202610220003）：默认开；--no-foreground 显式放弃（后台页签会超时/旧帧）
      foreground: flags['no-foreground'] === undefined,
      format: flags.format,
      quality: flags.quality,
      dpr: flags.dpr,
      viewport: flags.viewport,
      outDir: flags['out-dir'],
      name: flags.name,
      dryRun: !!flags['dry-run'],
      keepSlices: !!flags['keep-slices'],
    });
  } catch (e) { die(`${e.message}（--help 看 scroll-shot 用法）`); }
  if (opts.qualityIgnored) console.error('[scroll-shot] ⚠ --quality 仅对 jpeg 有效：--format png 时忽略该值（无损格式无 quality 语义）');
  if (opts.overlap) console.error(`[scroll-shot] --overlap ${opts.overlap} CSS px：切段位置不变，非末段每张向下多拍 ${opts.overlap}px（末段恒 0）`);
  if (!opts.imgPromote) console.error('[scroll-shot] ⚠ 已关闭强制加载（可能出现占位空白）——--no-img-promote');
  else console.error(`[scroll-shot] 强制加载（--img-promote）：按 ${ss.IMG_SRC_ATTRS.join('→')} 取真源做纯属性赋值（不改业务状态，会触发真实图片请求；--no-img-promote 可关）；--img-settle ${opts.imgSettleMs}ms`);
  // 空白自检口径预告（默认开；advisory 只报告——用户先知道"报了不等于失败"）
  if (opts.blankCheck && opts.dryRun) console.error('[scroll-shot] 空白自检：dry-run 不检测（无图）');
  else if (opts.blankCheck) console.error(`[scroll-shot] 空白自检：开（advisory 只报告不判死；阈值 ≥${opts.blankThreshold} 亮度 × ≥${opts.blankMinPx}px${opts.blankStrict ? '；--blank-strict 已开→可疑段 exit 1' : ''}；--no-blank-check 可关）`);
  else console.error('[scroll-shot] 空白自检：已关闭（--no-blank-check）——建议保留，长图白块无法事后发现');
  // 前台保障（V202610220003）：后台页签 raw captureScreenshot 会 30s 超时甚至返回旧帧（静默错图）
  if (!opts.foreground) {
    console.error('[scroll-shot] ⚠ 已按 --no-foreground 关闭前台保障——若目标页签在后台，captureScreenshot 实测会 30s 超时甚至返回旧帧（静默错图）；测完务必核对图片内容（尤其滚动后的段）');
  }
  // 切点吸附（F15）：口径预告（默认开；DOM 优先，像素法需显式 --snap-px）
  if (!opts.snapCuts) console.error('[scroll-shot] 切点吸附：已关闭（--no-snap-cuts）——切点硬切，长文可能把标题栏/产品卡拦腰截断');
  else console.error(`[scroll-shot] 切点吸附：开（DOM 优先；窗口 ±${opts.snapWindow} CSS px，最小空白带 ${ss.SNAP_MIN_BAND_PX}px；${opts.snapPx ? '像素法兜底开（--snap-px）' : '像素法兜底关（--snap-px 开）'}；--no-snap-cuts 关）`);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const tgt = {
      id: String(target.id || '').slice(0, 8),
      url: String(target.url || '').slice(0, 100),
      title: String(target.title || '').slice(0, 50),
    };
    console.error(`[scroll-shot] 目标：${(target.title || target.url || '').slice(0, 60)}（${tgt.id}）${opts.dryRun ? '｜dry-run（只测量+计划，不落图）' : ''}`);
    let m = null;
    try {
      m = await ss.runScrollShot(client, sessionId, Object.assign({}, opts, {
        target: tgt,
        // B7 N6：作业进度（非作业进程 jobs.progress 恒 no-op）
        onProgress: (p) => jobs.progress(p),
      }));
    } catch (e) {
      if (e && e.code === 'E_QUOTA') die(e.message, 'E_QUOTA'); // 配额拒绝：显式码失败收口（B3 N2）
      const partial = e && e.manifest;
      if (!partial) throw e; // 非 scroll-shot 链路错误（连接/解析）原样上抛
      const restoreNote = await ensureEmulationRestored(flags, target, partial.emulation);
      printScrollShot(partial, restoreNote);
      if (!partial.dryRun) { log.warn('cdp', `scroll-shot 中断：${e.message}`); }
      console.error(`[scroll-shot] ✗ ${e.message}`);
      return EXIT_ERR;
    }
    const restoreNote = await ensureEmulationRestored(flags, target, m.emulation);
    printScrollShot(m, restoreNote);
    jobs.setArtifact(path.join(m.outDir, `${m.name}.json`)); // 作业产物=清单（段图在清单内引用）
    jobs.progress({ phase: 'done', current: m.slices.filter((x) => !x.error).length, total: m.slices.length });
    // 空白自检 strict：可疑段 → exit 1，但 status 仍如实（ok/partial/failed 不混入"内容留白"语义）
    if (m.blankSummary && m.blankSummary.strictFail) {
      log.warn('cdp', `scroll-shot 空白自检 strict 失败（可疑段 ${m.blankSummary.suspectIndexes.join(',')}）`);
      console.error(`[scroll-shot] ✗ --blank-strict：${m.blankSummary.suspectIndexes.length} 段疑似空白（截图已完成，清单 status=${m.status} 未改）`);
      return EXIT_ERR;
    }
    if (m.status === 'ok' || m.status === 'plan-only') return EXIT_OK;
    log.warn('cdp', `scroll-shot 未全绿（status=${m.status}，失败段 ${m.failedSlices.length}，缺段 ${m.missingSlices.length}）`);
    return EXIT_ERR;
  } finally { await gracefulClose(client); }
}

/** scroll-shot 结果输出：dry-run 打全量清单 JSON（不落盘）；实跑落 <out-dir>/<name>.json + stdout 摘要 */
function printScrollShot(m, restoreNote) {
  if (m.dryRun) { console.log(JSON.stringify(m, null, 2)); return; }
  const out = path.join(m.outDir, `${m.name}.json`);
  try { fs.mkdirSync(m.outDir, { recursive: true }); fs.writeFileSync(out, JSON.stringify(m, null, 2) + '\n'); }
  catch (e) { console.error(`[scroll-shot] ⚠ 清单落盘失败：${e.message}`); }
  const okCount = m.slices.filter((x) => !x.error).length;
  const vp = m.viewport || {};
  console.log(`[scroll-shot] ${m.status === 'ok' ? '✓' : '⚠'} 状态=${m.status} 段=${okCount}/${m.sliceCount}`
    + ` 文档高=${m.docHeight} CSS px 视口=${vp.width}x${vp.height} DPR=${m.dpr}`
    + ` 格式=${m.formatRequested}${m.quality != null ? ` q${m.quality}` : ''}`
    + ` maxChunk=${m.maxChunk}${m.maxChunkUnit || 'px'}${m.chunkCss != null ? `（chunkCss=${m.chunkCss} 物理≤${m.chunkPx}px）` : ''}`
    + ` overlap=${m.overlap || 0} 耗时=${m.elapsedMs}ms`);
  // 前台保障（V202610220003）：仅当曾切前台 / 检测到 hidden（含读取失败）时打印——visible 正常路径不占屏
  const fg = m.foreground;
  if (fg && (fg.broughtToFront || fg.beforeVisibility === 'hidden' || fg.beforeVisibility === null)) {
    const tail = fg.broughtToFront
      ? `已 Page.bringToFront（复核 ${fg.afterVisibility || '未知'}）｜默认不自动还原前台（可能已切走用户前台）`
      : `未置前（${fg.bringToFront === 'skipped' ? '--no-foreground' : (fg.bringToFront || '未知')}）｜⚠ 后台截图可能超时/返回旧帧`;
    console.log(`[scroll-shot] 前台：${fg.beforeVisibility || '读取失败'} → ${fg.afterVisibility || '未知'}｜${tail}`);
  }
  if (m.prewarm) {
    console.log(`[scroll-shot] 预热：滚动 ${m.prewarm.scrollSteps} 步（${m.prewarm.stepPx}px/步，${m.prewarm.rounds} 轮）`
      + ` 高度 ${m.prewarm.docHeightBefore}→${m.prewarm.docHeightAfter}${m.prewarm.heightGrew ? '（增长，已重扫）' : ''}`
      + ` 图片 ${m.prewarm.images.total} 张 未就绪=${m.prewarm.imagesPending} 等待 ${m.prewarm.imageWaits} 次`
      + `${m.prewarm.imgSettleMs ? ` 首帧等待=${m.prewarm.imgSettleMs}ms` : '（未等首帧）'}`);
  }
  // 图片总账：promote=成功/候选（默认开；--no-img-promote 时明示关闭与风险）
  if (m.images) {
    const ip = m.prewarm && m.prewarm.imgPromote ? m.prewarm.imgPromote : { enabled: m.imgPromote !== false, candidates: 0, promoted: 0 };
    console.log(`[scroll-shot] 图片：total=${m.images.total} promote=${m.images.promoted}/${ip.candidates}`
      + ` placeholder=${m.images.placeholder} pending=${m.images.pending}`);
    if (!ip.enabled) console.log('[scroll-shot] 已关闭强制加载（可能出现占位空白）——--no-img-promote（懒加载占位图只能靠滚动预热兜底，微信等站点不可靠）');
  }
  for (const s of m.slices) {
    const fb = s.formatFallback ? `｜⚠ PNG→JPEG 降级（formatFallback=${s.formatFallback}）` : '';
    const bk = s.blank && s.blank.suspect ? `｜⚠ 疑似空白 ${s.blank.runs.reduce((x, r) => Math.max(x, r.rows), 0)}px（ratio=${s.blank.ratio}）` : '';
    const sn = s.snap && s.snap.shift ? `｜切点吸附 ${s.snap.shift > 0 ? '+' : ''}${s.snap.shift}px（${s.snap.method}）` : '';
    const tail = s.error ? `✗ ${s.error}` : `${s.height}px ${s.bytes}B via=${s.via}${s.attempts > 1 ? `（尝试 ${s.attempts}）` : ''}${s.repositions ? `｜重落位=${s.repositions}` : ''}${fb}${bk}${sn}`;
    console.log(`[scroll-shot]   ${String(s.index).padStart(2, '0')} y=${s.y} cssH=${s.cssHeight}${s.overlapPx ? `+${s.overlapPx}` : ''} → ${s.file ? path.basename(s.file) : '（无产物）'} ${tail}`);
  }
  // 切点吸附汇总（F15）：dry-run 用 plan（无 slices），实跑用 slices——两处字段同源（snap 记录随计划/段带出）
  const snapList = m.slices && m.slices.length ? m.slices : (m.plan || []);
  if (m.snapConfig && m.snapConfig.enabled) {
    const snaps = snapList.map((x) => x.snap).filter(Boolean);
    const dom = snaps.filter((x) => x.method === 'dom').length;
    const px = snaps.filter((x) => x.method === 'px').length;
    const maxShift = snaps.reduce((a, x) => Math.max(a, Math.abs(x.shift || 0)), 0);
    console.log(`[scroll-shot] 切点吸附：DOM ${dom} / 像素 ${px}（窗口 ±${m.snapConfig.windowPx}px，最大位移 ${maxShift}px${m.snapConfig.pxFallback ? '，像素法已开' : '，像素法未开'}）${snapList.length ? `｜切点 ${Math.max(0, snapList.length - 1)} 个` : ''}`);
  } else if (m.snapConfig) {
    console.log('[scroll-shot] 切点吸附：已关闭（--no-snap-cuts）');
  }
  // 重落位合计（V202610220002：正常路径恒 0；重试/降级前重新 scrollTo 的次数——超时扰动的量化信号）
  if (m.scrollRepositions) console.log(`[scroll-shot] 重落位：${m.scrollRepositions} 次（重试/降级前重新 scrollTo，防超时扰动后拍到错位内容；逐段见清单 slices[].repositions）`);
  if (m.blankSummary) {
    const bs = m.blankSummary;
    const tail = bs.ffmpeg === false ? '｜自检跳过（bin/ffmpeg 不可用）'
      : (!bs.segments ? `｜${bs.note}` : '');
    console.log(`[scroll-shot] 空白自检：可疑 ${bs.suspectIndexes.length}/${bs.segments} 段（阈值 ≥${bs.threshold} 亮度 × ≥${bs.minPx}px）${tail}`
      + `${bs.strictFail ? '｜⚠ --blank-strict 判定失败（exit 1）' : ''}${bs.elapsedMs ? ` 检测耗时=${bs.elapsedMs}ms` : ''}`);
    if (bs.suspectIndexes.length) console.log(`[scroll-shot]   可疑段：${bs.suspectIndexes.join(',')}——请人工确认是否为原文设计留白（默认不判失败；--blank-strict 可判死）`);
  }
  if (m.missingSlices.length) console.log(`[scroll-shot] 缺段：${m.missingSlices.map((x) => x.index).join(',')}（未截：总预算用尽或连接中断）`);
  if (m.viewportMaxChunk) console.log(`[scroll-shot] --viewport-max-chunk 生效：${m.viewportMaxChunk.effective.width}x${m.viewportMaxChunk.effective.height}@DPR ${m.viewportMaxChunk.effective.dpr}（${m.viewportMaxChunk.relation}）`);
  if (m.emulation) {
    const e = m.emulation;
    const r = e.restore ? (e.restore.ok ? '已还原' : `⚠ 还原异常：${e.restore.error || (e.restore.drift || []).join('；')}`) : '还原未验证';
    console.log(`[scroll-shot] 视口覆盖 ${e.plan.width}x${e.plan.height}@DPR ${e.plan.deviceScaleFactor}（实测 innerWidth=${e.post.width} dpr=${e.post.dpr}${(e.mismatch || []).length ? `；⚠ mismatch：${e.mismatch.join('；')}` : ''}）；${r}${restoreNote}`);
  } else {
    console.log('[scroll-shot] 视口覆盖：未请求（全程零 Emulation 命令——不默认 emulate）');
  }
  if (m.restore && m.restore.scrollY) {
    const s = m.restore.scrollY;
    console.log(`[scroll-shot] 滚动还原：原 scrollY=${s.before} → 实测 ${s.after}${s.ok ? ' ✓' : ` ⚠ ${s.note || s.error || '未完全还原'}`}`);
  }
  if (m.notes.length) for (const n of m.notes) console.log(`[scroll-shot] 注：${n}`);
  console.log(`[scroll-shot] 清单：${out}`);
}

/* ── 二期-4：录屏 cast（GQ-010 F + GQ-001；2026-10-31 用户裁定；实现单源 lib/cast.js）──
 * 形态裁定：CLI 短连接架构 ⇒ 一次性命令（`cast --duration <s>` 录 N 秒自动停+合成），不做
 *   start/stop 长驻对（避免 watch 类生命周期与跨进程状态文件）。--duration 上限 600s 防误录爆盘。
 * 核心防错（GQ-001）：Chrome 仅在画面变化时推帧（88 静止页实测 6s 1 帧）——fps 必须按全部
 *   实际帧首帧→末帧真实跨度归一（lib/cast.analyzeFrames），**绝不用标称帧率**（否则静止期视频快放）。
 * 产物：tmpdata/cast/cast-<stamp>.{mp4,frames/,json}；ffmpeg 复用 scroll-shot 探活，缺失时帧恒留档。 */

async function cmdCast(flags) {
  let opt;
  try {
    opt = cast.normalizeCastOptions({
      duration: flags.duration,
      out: flags.out,
      everyNth: flags['every-nth'],
      quality: flags.quality,
      maxWidth: flags['max-width'],
      timeoutMs: flags.timeout,
      foreground: flags['no-foreground'] === undefined,
    });
  } catch (e) { die(`${e.message}（--help 看 cast 用法）`); }
  const plan = cast.planCastPaths({ out: opt.out, stamp: ts() });
  for (const n of plan.notes) console.error(`[cast] ⚠ ${n}`);
  if (!opt.foreground) console.error('[cast] ⚠ --no-foreground：放弃前台保障——后台页签 startScreencast 行为未知（可能不产帧）');
  const { core, client } = await openClient(Object.assign({}, flags, { timeout: opt.timeoutMs }), opt.timeoutMs);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const tgt = {
      id: String(target.id || '').slice(0, 8),
      url: String(target.url || '').slice(0, 100),
      title: String(target.title || '').slice(0, 50),
    };
    console.error(`[cast] 目标：${(target.title || target.url || '').slice(0, 60)}（${tgt.id}）｜录 ${opt.durationSec}s`
      + `（上限 ${cast.MAX_DURATION_SEC}s；jpeg q${opt.quality}，everyNth=${opt.everyNth}）→ ${plan.out}`);
    let r;
    try { r = await cast.runCast(client, sessionId, opt, { plan, target: tgt, onProgress: (p) => jobs.progress(p) }); }
    catch (e) { if (e && e.code === 'E_QUOTA') die(e.message, 'E_QUOTA'); throw e; }
    audit.setArtifact(r.manifestFile || plan.out);
    jobs.setArtifact(r.manifestFile || plan.out);
    jobs.progress({ phase: 'done', current: r.manifest.frames, total: r.manifest.frames });
    for (const line of cast.formatCastReport(r.manifest)) console.log(line);
    console.log(`[cast] 清单：${r.manifestFile}`);
    if (r.ok) return EXIT_OK;
    log.warn('cast', `录屏未产出 mp4：reason=${r.manifest.reason} frames=${r.manifest.frames} fps=${r.manifest.fps}`);
    if (r.manifest.reason === 'insufficient-frames') {
      console.error(`[cast] ✗ 仅 ${r.manifest.frames} 帧 / 录制 ${(r.manifest.recordedMs / 1000).toFixed(2)}s——Chrome 仅画面变化时推帧，`
        + '静止页只有 1 帧属正常（<2 帧无法合成）；需要视频请让页面在录制窗口内产生变化（滚动/动画/操作）');
    } else if (r.manifest.reason === 'ffmpeg-unavailable') {
      console.error('[cast] ✗ bin/ffmpeg 不可用：帧已留档（见上 frameDir）——ffmpeg 可用后按上面的离线命令合成');
    }
    return EXIT_ERR;
  } finally { await gracefulClose(client); }
}

/* ── 共享采集：browser 版本 + wsLatency 3 校样 + targets 摘要（V202609300001 自 doctor 抽取防漂移）──
 * doctor 与 doctor-forensics 共用；探针语义与原 doctor 逐行等价（browserVersion → 连接 →
 * Target.getTargets ×3 采样 → targets 摘要）。失败抛错由调用方定夺失败语义：
 *   doctor=通道不可达即 die（无从诊断）；doctor-forensics=照常落盘（通道死本身=取证原料）。
 * 返回 { client, browser, wsLatency, targets, infos }；client 由调用方 gracefulClose。 */
async function collectBrowserSnapshot(core, url, timeout) {
  const ver = await core.browserVersion(url, timeout);
  const browser = {
    browser: ver.Browser || null,
    protocolVersion: ver['Protocol-Version'] || null,
    userAgent: ver['User-Agent'] || null,
    webSocketDebuggerUrl: ver.webSocketDebuggerUrl || null,
  };
  const client = trackedClient(core, url, timeout);
  await client.connect();
  // wsLatency：3 次 Target.getTargets 往返校样（末次结果顺带供 targets 摘要复用）
  const samples = [];
  let lastTargets = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    lastTargets = await client.send('Target.getTargets', {}, { timeoutMs: timeout });
    samples.push(Date.now() - t0);
  }
  const wsLatency = {
    samplesMs: samples,
    avgMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
    maxMs: Math.max(...samples),
  };
  // targets 全列表摘要（target 堆积可见；attached=true 表示有客户端正附挂——MCP 长驻在场信号）
  const infos = (lastTargets && lastTargets.targetInfos) || [];
  const byType = {};
  for (const t of infos) byType[t.type] = (byType[t.type] || 0) + 1;
  const targets = {
    total: infos.length,
    byType,
    list: infos.map((t) => ({
      targetId: String(t.targetId || '').slice(0, 8),
      type: t.type,
      url: String(t.url || '').slice(0, 100),
      title: String(t.title || '').slice(0, 50),
      attached: !!t.attached,
    })),
  };
  return { client, browser, wsLatency, targets, infos };
}

/* ── doctor：CDP 通道健康一次性诊断（V202609130003；研究题 2 方案③失效前兆探测）──
 * 输出一次性诊断 JSON（chromeuse-cdp-doctor/1）：
 *   browser          Browser.getVersion 版本信息（advisory=低于 MCP 已知降级线的版本闸提示，非失败）
 *   targets          Target.getTargets 全列表摘要（数量 + type/url/attached——target 堆积可见）
 *   wsLatency        3 次 Target.getTargets 往返校样 ms（通道健康度参考）
 *   screenshotProbe  首个 page 型 target 试拍小截图（成功/超时/失败——screenshot 通道健康度；
 *                    与生产路径同款 bringToFront 前置，单次不重试保原始信号；有标签置前副作用，JSON 内如实标注）
 *   multiClientHint  多客户端共用 9222 现状提示——chromeuse 一次性短连接 × chrome-devtools MCP 长驻共存是
 *                    架构现状（无互斥机制），如实呈现 target 总数供人工判断
 * 退出码：0 = 诊断完成（各项健康度看 JSON 字段自行研判）｜1 = 通道不可达无从诊断 */
async function cmdDoctor(flags) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  const timeout = num(flags.timeout, 5000);
  const report = {
    format: 'chromeuse-cdp-doctor/1',
    at: time.isoLocal(),
    browserUrl: url,
    browser: null,
    targets: null,
    wsLatency: null,
    screenshotProbe: null,
    multiClientHint: null,
  };
  // ①②③ 共享采集（collectBrowserSnapshot：browser 版本/wsLatency/targets）——不可达即无从诊断（快速失败）
  let snap;
  try { snap = await collectBrowserSnapshot(core, url, timeout); }
  catch (e) {
    /* C9：快速失败也给结论+nextStep（doctor 未执行任何探测） */
    console.error(`[doctor] 结论：通道未建立——浏览器进程不可达（${core.kindText(e.kind)}：${e.message}）`);
    console.error('[doctor] nextStep：① 查 chrome-browser 容器/调试端口 ② 通道恢复后复跑 doctor ③ 反复不可达→doctor-forensics 取证（通道死本身即判定原料）');
    die(`浏览器通道不可达（${core.kindText(e.kind)}：${e.message}）——doctor 无从诊断；查容器/端口，或先 browser-restart`);
  }
  report.browser = snap.browser;
  // C2 版本闸：MCP 已知降级线 advisory（只提示，不改 exit 语义/健康度结论）
  report.browser.advisory = core.mcpAdvisory(report.browser.browser);
  if (report.browser.advisory) console.error(`ℹ ${report.browser.advisory}`);
  report.wsLatency = snap.wsLatency;
  report.targets = snap.targets;
  const client = snap.client;
  const infos = snap.infos;
  try {
    // ④ screenshotProbe：首个 page 型 target 试拍（生产路径同款：attach → bringToFront → captureScreenshot；
    //   单次不重试——诊断要的是原始信号，重试会掩盖间歇性失效）
    const page = infos.find((t) => t.type === 'page');
    if (!page) {
      report.screenshotProbe = { status: 'skipped', note: '无 page 型 target 可探' };
    } else {
      const t0 = Date.now();
      const probeTarget = { targetId: String(page.targetId || '').slice(0, 8), url: String(page.url || '').slice(0, 80) };
      try {
        const sid = await client.attach(page.targetId, timeout);
        await client.send('Page.bringToFront', {}, { sessionId: sid, timeoutMs: timeout });
        const shot = await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: sid, timeoutMs: timeout });
        report.screenshotProbe = {
          status: 'ok',
          durationMs: Date.now() - t0,
          target: probeTarget,
          approxBytes: Math.floor(String(shot.data || '').length * 3 / 4),
          note: '已对探针目标执行 Page.bringToFront（标签置前副作用，如实标注）',
        };
      } catch (e) {
        report.screenshotProbe = {
          status: (e && e.kind === 'timeout') ? 'timeout' : 'error',
          durationMs: Date.now() - t0,
          target: probeTarget,
          error: e.message,
          hint: '截图通道疑似失效前兆（合成器冻结/多标签 race）——可 browser-restart 重置；fallback：exec Page.captureSnapshot 拿 DOM 快照（不依赖合成器）',
        };
      }
    }
  } finally { await gracefulClose(client); }
  // ⑤ multiClientHint：多客户端共用 9222 现状提示（chromeuse 与 chrome-devtools MCP 共用是架构现状）
  report.multiClientHint = {
    webSocketDebuggerUrl: report.browser.webSocketDebuggerUrl,
    note: 'chromeuse 为一次性短连接（本诊断结束即断开）；chrome-devtools MCP 为长驻连接——两者共用同一调试端口是架构现状（无互斥机制）。'
      + `当前 target 总数 ${report.targets ? report.targets.total : '?'}（详见 targets 字段，attached=true 即有客户端在场）：`
      + '若出现大量非预期 target（废弃 service worker/空白页堆积）或 wsLatency 持续走高，结合 watch 观测与 browser-restart 人工判断处置。',
  };
  /* C9 诊断易用性（V20261113001）：结论行+nextStep 动作行（按优先级；JSON 新增字段，旧字段/旧行零改动） */
  const diag = doctorDiagnosis(report);
  report.conclusionStatus = diag.status;
  report.conclusion = diag.conclusion;
  report.nextStep = diag.nextStep;
  console.error(`[doctor] 结论：${diag.conclusion}`);
  console.error(`[doctor] nextStep：${fmtNextStep(diag.nextStep)}`);
  console.log(JSON.stringify(report, null, 2));
  log.info('doctor', `诊断完成：browser=${report.browser.browser || '?'} targets=${report.targets ? report.targets.total : '?'} wsAvg=${report.wsLatency ? report.wsLatency.avgMs : '?'}ms shotProbe=${report.screenshotProbe ? report.screenshotProbe.status : '?'}`);
  return EXIT_OK;
}

/* ── beacon：零依赖收数服务（默认绑 0.0.0.0——NAS 路由修正） ── */
async function cmdBeacon(flags) {
  const { startCollector } = require('../lib/collector');
  const host = flags.host === undefined ? '0.0.0.0' : String(flags.host);
  const port = num(flags.port, 9999);
  const col = await startCollector({ host, port, dumpDir: flags.dump || null });
  console.log(`[beacon] 收数服务 http://${host}:${col.port}（Ctrl+C 停止；容器内网 + 用完即关——R34）`);
  console.log(`[beacon] 页面侧 URL：NAS 填 http://opencode:${col.port} ｜ 桌面端填 http://127.0.0.1:${col.port}${flags.dump ? `\n[beacon] 落盘目录：${flags.dump}` : ''}`);
  const stop = async () => { await col.stop(); console.log('[beacon] 已停止'); process.exit(EXIT_OK); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return new Promise(() => { /* 常驻至信号 */ });
}

/* ── watch：看门狗（detect & advise，绝不自动杀——架构裁定） ── */
async function cmdWatch(flags) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  const interval = num(flags.interval, 10) * 1000;
  const windowMs = num(flags.window, 120) * 1000;
  const maxMs = flags['max-seconds'] ? num(flags['max-seconds'], 0) * 1000 : 0;
  const timeline = [];
  let deadSince = null;
  const start = Date.now();
  console.error(`[watch] 每轮 probe（${interval / 1000}s 间隔）；轻探针+截图双死持续 ≥${windowMs / 1000}s（实测自愈 20s 的 6× 余量）才判冻结；只检测+建议，不自动杀`);
  const probeOnce = async () => {
    const r = { at: time.isoLocal(), browser: false, renderer: false, shot: false };
    try { await core.browserVersion(url, 2000); r.browser = true; } catch (e) { r.note = e.message; return r; }
    const client = trackedClient(core, url, 3000);
    try {
      await client.connect();
      try { const { sessionId } = await core.resolveTarget(client, flags.target); await core.evaluate(client, sessionId, 'document.readyState', 3000); r.renderer = true; } catch { /* renderer 死 */ }
      try { const { sessionId } = await core.resolveTarget(client, flags.target); await core.screenshot(client, sessionId, { timeoutMs: 3000 }); r.shot = true; } catch { /* 合成器死 */ }
    } catch { /* 连接失败按浏览器不可达处理 */ } finally { await gracefulClose(client); }
    return r;
  };
  while (true) {
    const r = await probeOnce();
    timeline.push(r);
    const clock = r.at.slice(11, 19);
    if (!r.browser) { deadSince = null; console.log(`[watch] ${clock} 浏览器不可达（${(r.note || '').slice(0, 60)}）——非页面冻结，查容器/端口`); }
    else if (!r.renderer && !r.shot) {
      if (!deadSince) deadSince = Date.now();
      const held = Date.now() - deadSince;
      console.log(`[watch] ${clock} 双死中（轻探针 ✗ 截图 ✗）持续 ${(held / 1000).toFixed(0)}s / 判定窗 ${windowMs / 1000}s`);
      if (held >= windowMs) { printFreezeReport(timeline); return EXIT_FROZEN; }
    } else {
      if (deadSince) console.log(`[watch] ${clock} 双死解除（自愈型冻结——等待纪律生效，未杀进程）`);
      deadSince = null;
      console.log(`[watch] ${clock} renderer ${r.renderer ? '✓' : '✗'} 截图 ${r.shot ? '✓' : '✗'}（存活/未达双死）`);
    }
    if (maxMs && Date.now() - start >= maxMs) { console.log(`[watch] 达 --max-seconds 上限退出：共 ${timeline.length} 轮，未判定冻结`); return EXIT_OK; }
    await sleep(interval);
  }
}
function printFreezeReport(timeline) {
  console.error('[watch] ── 判定：不可恢复冻结（轻探针+截图双死持续达窗口；120s = 实测自愈 20s 的 6× 余量）──');
  console.error('[watch] 恢复命令（**人工执行**；agent 不得自动杀——红线 #5 / 看门狗裁定）：');
  for (const line of platform().browser.manualRestartHint()) console.error(line); // 两行原文单源在平台层（批2）
  console.error('[watch] 时间线（末 20 轮）：');
  for (const t of timeline.slice(-20)) console.error(`  ${t.at} browser=${t.browser ? '✓' : '✗'} renderer=${t.renderer ? '✓' : '✗'} shot=${t.shot ? '✓' : '✗'}`);
}

/* ── doctor-forensics：CDP 失效分型取证（V202609300001 Phase 1）──
 * 来源：reports/CDP失效分型取证协议-oracle-20260930.md 交付物 2（runbook）/交付物 3（spec）。
 * 定位：失效现场取证（doctor 是活时巡检；本命令死时更要用）——**通道全死也照常落盘**
 * （通道死本身=A/B 层判定原料；与 doctor 快速 die 的失败语义相反，这是本命令存在的核心理由）。
 * 探测序列 S0-S5（探针全单发不重试——取证要原始信号；总预算硬帽 120s，超帽截断标 truncated 照常落盘）：
 *   S0 环境：时间戳/Node 版本/--symptom 原文/flow 锁状态（fs 读 fail-soft）/log 末 20 行（fail-soft）
 *   S1 HTTP 探测面：GET /json/version（kind+状态码+latency+webSocketDebuggerUrl 回写值）+ /json/list
 *   S2 WS 面+browser 级：WS 握手 → Target.getTargets ×3（wsLatency）→ SystemInfo.getProcessInfo
 *      （fail-soft：方法行为未实测验证——失败不判死、记 unknown）
 *   S3 per-target 矩阵：page 型前 --max-targets 个（--target 指定者必入）；逐页 attach(2s) →
 *      Runtime.evaluate(readyState) → Page.getLayoutMetrics → 裸 Page.captureScreenshot（非加固链）；
 *      主 target（探针序首个）带前置 bringToFront，--no-front 全关（用户在场礼仪）；非主 target 不置前、
 *      记 inactive tab 截图 race 假阳性 caveat
 *   S4 对照 tab（条件触发：S3 有任一探针死 且 未 --no-control-tab——永不自动开关 tab 的唯一豁免）：
 *      Target.createTarget {url:'about:blank', background:true} 不抢焦点 → evaluate+截图 → Target.closeTarget
 *      自关（谁开谁关；探针成败都关）
 *   S5 分型判定：lib/forensics judgeLayers 纯函数（八层 M/A1/A2/B/C/D/E/F/G，恒 advisory）+
 *      screencast 帧龄旁证（latestLiveFrame fail-soft，-v 在录才非 null）
 * 红线：判定恒 advisory 不自动触发任何恢复动作；**绝无 exit 2**（冻结判定是 watch 的职责）；
 *       exit 0=取证落盘完成（无论判定/通道死活）｜1=取证自身失败（参数错/写盘失败）。 */
const FORENSICS_BUDGET_CAP_MS = 120000; // 总预算硬帽（spec：最坏 ≈66s ≪ 2min；超帽截断照常落盘）
async function cmdDoctorForensics(flags) {
  const core = require('../lib/cdp-core');
  const forensics = require('../lib/forensics');
  const shot = require('../lib/screenshot');
  const url = core.resolveBrowserUrl(flags.url);
  const timeout = num(flags.timeout, 3000);
  const maxTargets = num(flags['max-targets'], 3);
  if (maxTargets < 1) die('--max-targets 须 ≥1');
  const noControlTab = !!flags['no-control-tab'];
  const noFront = !!flags['no-front'];
  const symptom = flags.symptom === undefined ? '' : String(flags.symptom);
  const t0All = Date.now();
  const deadline = t0All + FORENSICS_BUDGET_CAP_MS;
  const overBudget = () => Date.now() >= deadline;
  const fmtErr = shot.fmtProbeErr; // 值域单源：'ok' | 'timeout' | 'error:<msg截断80>'（同 lib/screenshot 诊断矩阵）
  const httpStatus = (msg) => { const m = /HTTP (\d{3})/.exec(String(msg || '')); return m ? parseInt(m[1], 10) : null; };

  const ev = {
    format: 'chromeuse-cdp-forensics/1',
    at: time.isoLocal(),
    browserUrl: url,
    symptom,
    symptomChannel: forensics.parseSymptomChannel(symptom),
    env: { node: process.versions.node, browser: null, lockHolder: null, logTail: [] },
    http: { ok: false, versionProbe: null, listProbe: null, webSocketDebuggerUrl: null, targetsCountHttp: null },
    ws: { ok: false, connect: false, connectError: null, connectNote: null, wsLatency: null, getTargets: false, getTargetsError: null, systemInfo: null },
    targets: { total: undefined, byType: {}, attachedCount: 0, list: [] },
    probeMatrix: [],
    controlTab: { used: false, created: false, evalProbe: null, shotProbe: null, closed: null, note: '未触发' },
    screencastEvidence: null,
    layerVerdicts: [],
    verdictSummary: '',
    nextSteps: [],
    truncated: false,
    elapsedMs: null,
    raw: {},
  };

  // ── S0 环境（纯本地，全 fail-soft）──
  try { const lh = require('../lib/lock').readRaw(); ev.env.lockHolder = lh ? `${lh.owner}（pid ${lh.pid}）` : null; } catch { /* fail-soft */ }
  try {
    const content = fs.readFileSync(path.join(paths.LOG_DIR, 'chromeuse.log'), 'utf8');
    ev.env.logTail = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(-20);
  } catch { /* fail-soft：无日志不阻断取证 */ }

  // ── S1 HTTP 探测面（/json/version + /json/list，各 timeout 单发）──
  {
    const t0 = Date.now();
    try {
      const ver = await core.browserVersion(url, timeout);
      ev.http.versionProbe = { kind: 'ok', latencyMs: Date.now() - t0 };
      ev.http.webSocketDebuggerUrl = ver.webSocketDebuggerUrl || null;
      ev.env.browser = ver.Browser || null;
    } catch (e) {
      ev.http.versionProbe = { kind: e.kind || 'error', status: httpStatus(e.message), latencyMs: Date.now() - t0, error: e.message };
      ev.raw.versionProbe = e.message;
    }
  }
  {
    const t0 = Date.now();
    try {
      const list = await core.listTargets(url, timeout);
      ev.http.listProbe = { kind: 'ok', latencyMs: Date.now() - t0, count: list.length };
      ev.http.targetsCountHttp = list.length;
    } catch (e) {
      ev.http.listProbe = { kind: e.kind || 'error', status: httpStatus(e.message), latencyMs: Date.now() - t0, error: e.message };
      ev.raw.listProbe = e.message;
    }
  }
  ev.http.ok = !!(ev.http.versionProbe && ev.http.versionProbe.kind === 'ok' && ev.http.listProbe && ev.http.listProbe.kind === 'ok');

  // ── S2/S3/S4：单条 WS 短连接（HTTP 面死则整段跳过——分型已可判 A1/B，省预算）──
  if (ev.http.ok && !overBudget()) {
    const client = trackedClient(core, url, timeout);
    let wsInfos = []; // S2 Target.getTargets 原始 targetInfos（全量 targetId——S3 attach 用）
    try {
      // S2 WS 面 + browser 级（本块仅在 http.ok 且未超预算时进入——connect 恒真实尝试，失败记 connectError）
      try { await client.connect(); ev.ws.connect = true; }
      catch (e) { ev.ws.connect = false; ev.ws.connectError = e.message; ev.raw.wsConnect = e.message; }
      if (ev.ws.connect) {
        const samples = [];
        let last = null;
        try {
          for (let i = 0; i < 3; i++) {
            if (overBudget()) { ev.truncated = true; break; }
            const t0 = Date.now();
            last = await client.send('Target.getTargets', {}, { timeoutMs: timeout });
            samples.push(Date.now() - t0);
          }
        } catch (e) { ev.ws.getTargetsError = e.message; ev.raw.getTargets = e.message; }
        if (samples.length) {
          ev.ws.wsLatency = { samplesMs: samples, avgMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), maxMs: Math.max(...samples) };
        }
        ev.ws.getTargets = !ev.ws.getTargetsError;
        ev.ws.ok = ev.ws.connect && ev.ws.getTargets;
        if (ev.ws.getTargets) {
          wsInfos = (last && last.targetInfos) || [];
          const byType = {};
          for (const t of wsInfos) byType[t.type] = (byType[t.type] || 0) + 1;
          ev.targets = {
            total: wsInfos.length,
            byType,
            attachedCount: wsInfos.filter((t) => t.attached).length,
            list: wsInfos.map((t) => ({ targetId: String(t.targetId || '').slice(0, 8), type: t.type, url: String(t.url || '').slice(0, 100), title: String(t.title || '').slice(0, 50), attached: !!t.attached })),
          };
        }
        // SystemInfo.getProcessInfo——fail-soft（方法行为未实测验证，失败不判死、记 unknown）
        try {
          const si = await client.send('SystemInfo.getProcessInfo', {}, { timeoutMs: timeout });
          const procs = (si && si.processes) || [];
          ev.ws.systemInfo = { status: 'ok', processCount: procs.length, sample: procs.slice(0, 5).map((p) => ({ type: p.type, name: p.name })) };
        } catch (e) {
          ev.ws.systemInfo = { status: 'unknown', note: '方法行为未实测验证——失败不判死（fail-soft，spec 待验证项）', error: e.message };
        }
      } // else：connect 失败——connectError 已记录原始错误，不覆盖误导性注记（HTTP 活时 connect 恒已尝试）

      // S3 per-target 矩阵（条件：WS 活且 getTargets 成功；页清单取自 S2 原始 targetInfos——全量 targetId）
      if (ev.ws.getTargets) {
        const pageInfos = wsInfos.filter((t) => t.type === 'page');
        const chosen = [];
        if (flags.target) {
          const sel = String(flags.target);
          for (const p of pageInfos) {
            if (chosen.length >= maxTargets) break;
            if (String(p.targetId || '').startsWith(sel) || String(p.url || '').includes(sel) || String(p.title || '').includes(sel)) chosen.push(p);
          }
        }
        for (const p of pageInfos) {
          if (chosen.length >= maxTargets) break;
          if (!chosen.includes(p)) chosen.push(p);
        }
        for (let i = 0; i < chosen.length; i++) {
          if (overBudget()) { ev.truncated = true; break; }
          const pg = chosen[i];
          const isPrimary = i === 0;
          const row = {
            targetId: String(pg.targetId || '').slice(0, 8),
            url: String(pg.url || '').slice(0, 100),
            title: String(pg.title || '').slice(0, 50),
            readyState: null, evalMs: null, eval: null,
            layoutMetrics: null,
            rawShot: null, shotMs: null,
            frontApplied: false,
            note: '',
          };
          try {
            const tid = pg.targetId;
            const sid = await client.attach(tid, 2000); // spec：attach 2s
            if (isPrimary && !noFront) {
              try { await client.send('Page.bringToFront', {}, { sessionId: sid, timeoutMs: timeout }); row.frontApplied = true; }
              catch (e) { row.note += `bringToFront 失败（${fmtErr(e)}）；`; }
            }
            const tEval = Date.now();
            try { row.readyState = await core.evaluate(client, sid, 'document.readyState', timeout); row.eval = 'ok'; }
            catch (e) { row.eval = fmtErr(e); }
            row.evalMs = Date.now() - tEval;
            try { await client.send('Page.getLayoutMetrics', {}, { sessionId: sid, timeoutMs: timeout }); row.layoutMetrics = 'ok'; }
            catch (e) { row.layoutMetrics = fmtErr(e); }
            const tShot = Date.now();
            try { await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: sid, timeoutMs: timeout }); row.rawShot = 'ok'; }
            catch (e) { row.rawShot = fmtErr(e); }
            row.shotMs = Date.now() - tShot;
            if (!row.frontApplied) row.note += (row.note ? ' ' : '') + (noFront ? '--no-front：未置前' : '非主 target 未置前——inactive tab 截图有 race 假阳性 caveat');
          } catch (e) {
            row.eval = fmtErr(e); // attach 失败——该页全部探针记死
            row.note += (row.note ? ' ' : '') + `attach 失败：${e.message}`;
          }
          ev.probeMatrix.push(row);
        }
      }

      // S4 对照 tab（条件触发：S3 有任一探针死 且 未 --no-control-tab；about:blank background:true 不抢焦点；谁开谁关）
      const anyDead = ev.probeMatrix.some((p) => p.eval !== 'ok' || p.rawShot !== 'ok' || p.layoutMetrics !== 'ok');
      if (anyDead && !noControlTab && !overBudget()) {
        ev.controlTab = { used: true, created: false, evalProbe: null, shotProbe: null, closed: false, note: '' };
        try {
          const created = await client.send('Target.createTarget', { url: 'about:blank', background: true }, { timeoutMs: timeout });
          ev.controlTab.created = true;
          ev.controlTab.targetId = String(created.targetId || '').slice(0, 8);
          try {
            const sid = await client.attach(created.targetId, 2000);
            try { ev.controlTab.readyState = await core.evaluate(client, sid, 'document.readyState', timeout); ev.controlTab.evalProbe = 'ok'; }
            catch (e) { ev.controlTab.evalProbe = fmtErr(e); }
            const tShot = Date.now();
            try { await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: sid, timeoutMs: timeout }); ev.controlTab.shotProbe = 'ok'; }
            catch (e) { ev.controlTab.shotProbe = fmtErr(e); }
            ev.controlTab.shotMs = Date.now() - tShot;
          } catch (e) { ev.controlTab.note = `attach 失败：${e.message}`; }
          try { await client.send('Target.closeTarget', { targetId: created.targetId }, { timeoutMs: timeout }); ev.controlTab.closed = true; }
          catch (e) { ev.controlTab.note += (ev.controlTab.note ? '；' : '') + `closeTarget 失败：${e.message}（⚠ 自建对照 tab 未关成，需人工确认关闭）`; }
          if (!ev.controlTab.note) ev.controlTab.note = 'about:blank background:true 对照 tab——自开自关（永不触碰用户 tab；新 tab 可截=非全局死）';
        } catch (e) {
          ev.controlTab.note = `createTarget 失败：${e.message}`;
        }
      } else {
        ev.controlTab = {
          used: false, created: false, evalProbe: null, shotProbe: null, closed: null,
          note: anyDead ? '--no-control-tab：对照 tab 已禁用（全局/单 tab 无法细分）' : (ev.probeMatrix.length ? 'S3 全绿——对照 tab 条件未触发' : 'S3 未进行（WS 面死）——对照 tab 不触发'),
        };
      }
    } finally { await gracefulClose(client); }
  } else if (!ev.http.ok) {
    ev.ws.connectNote = 'HTTP 探测面不可达——S2/S3/S4 跳过（分型走 A1/B；通道死本身已是有效证据）';
  } else {
    ev.truncated = true;
    ev.ws.connectNote = '总预算硬帽耗尽（120s）——S2 起截断';
  }

  // ── S5 分型判定（纯函数）+ screencast 帧龄旁证（fail-soft）──
  try {
    const hit = shot.latestLiveFrame(paths.VIDEO_DIR, Date.now(), 60000);
    if (hit) ev.screencastEvidence = { frame: hit.file, ageMs: Math.max(0, Date.now() - (hit.tArrive || 0)), tab: hit.tab || null };
  } catch { /* fail-soft */ }
  const judged = forensics.judgeLayers({
    symptomChannel: ev.symptomChannel,
    http: { ok: ev.http.ok, versionProbe: ev.http.versionProbe },
    ws: { connect: ev.ws.connect, getTargets: ev.ws.getTargets, wsLatency: ev.ws.wsLatency },
    probeMatrix: ev.probeMatrix,
    controlTab: ev.controlTab,
    targets: ev.targets,
  });
  ev.layerVerdicts = judged.layerVerdicts;
  ev.verdictSummary = judged.verdictSummary;
  ev.nextSteps = judged.nextSteps;
  ev.elapsedMs = Date.now() - t0All;

  // ── 落盘（通道全死也照常落盘——本命令存在的核心理由）──
  const file = flags.out ? String(flags.out) : path.join(paths.FORENSICS_DIR, `forensics-${ts()}.json`);
  try {
    paths.ensureDir(paths.FORENSICS_DIR);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ev, null, 2) + '\n');
  } catch (e) { die(`取证 JSON 写盘失败：${file}（${e.message}）`); }
  const top = ev.layerVerdicts.filter((v) => v.status === 'confirmed' || v.status === 'suspect').map((v) => `${v.layer}:${v.status}(${v.confidence})`).join('，') || '无 confirmed/suspect 层';
  console.log(`[doctor-forensics] ${ev.verdictSummary}`);
  console.log(`[doctor-forensics] 分型：${top}${ev.truncated ? '；⚠ 预算截断 truncated=true（证据不完整）' : ''}`);
  console.log(`[doctor-forensics] 取证已落盘：${file}（exit 0=取证完成，与判定/通道死活无关；恢复动作恒人工批准——见 playbook 分型映射表）`);
  log.info('doctor-forensics', `取证完成：${top}；落盘 ${file}（${ev.elapsedMs}ms${ev.truncated ? '，truncated' : ''}）`);
  return EXIT_OK;
}

/* ── flow / record 系列 ─────────────────────────────────────────
 * 互斥锁语义（V202610200001，2026-10-19 用户裁定）：record 与 flow replay **默认无互斥**——锁只保留在
 * 「打开页签并获取 pageId」层（snippets/tab-helper.js 锁页 window-CAS，V202610140003，独立一层）；
 * 多客户端共连 9222 的干扰风险改由纪律兜底（V202609130003 归因遗留观察，实测见 TODO 条目）。
 * `--lock` = 可选显式互斥（兼容旧脚本语义/需要排他时显式声明）。lib/lock.js 保留不删（可选能力 +
 * doctor 取证读 holder），withLock 也保留供 --lock 分支使用。
 */
function withLock(owner, fn) {
  const lock = require('../lib/lock');
  const got = lock.acquire(owner);
  if (!got.ok) die(`另一动作正持锁：${got.holder.owner}（pid ${got.holder.pid}，${new Date(got.holder.acquiredAt).toISOString()} 起）——等其结束，或确认僵尸后删 ${lock.LOCK_PATH}（不加 --lock 即默认无互斥）`);
  process.on('exit', () => { try { lock.release(); } catch { /* 尽力而为 */ } });
  return Promise.resolve().then(fn).finally(() => lock.release());
}
/** 默认直通（无锁）；enabled=true（--lock）才走 withLock——单点开关，调用方零分支 */
function maybeLock(enabled, owner, fn) {
  return enabled ? withLock(owner, fn) : Promise.resolve().then(fn);
}
/** V202610130003 件3：webapp.md ambiguousTexts 清单解析（与 selftest #74 parseAmbiguous 同一解析口径——
 *  表格行首列抓取、跳过表头「文本」/分隔行；app 未登记或 webapp.md 缺失 → 空清单=M2 跳过，不阻断 lint）。 */
function parseAmbiguousTexts(app) {
  if (!app) return [];
  const p = path.join(paths.SKILL_ROOT, 'webapps', String(app), 'webapp.md');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\|\s*(\S+)\s*\|/.exec(line);
    if (m && m[1] !== '文本' && !m[1].startsWith('-') && !m[1].startsWith(':')) out.push(m[1]);
  }
  return out;
}
function cmdFlow(pos, flags) {
  const action = pos[0], file = pos[1];
  audit.setAction(`flow:${action || '?'}`);
  if ((action !== 'validate' && action !== 'replay' && action !== 'lint') || !file) {
    console.error(SUB_HELP.flow);
    noteFail('E_USAGE', SUB_HELP.flow); // 出口③显式码（用法错：缺 action/file）
    return EXIT_ERR;
  }
  const engine = require('../lib/flow-engine');
  let flow;
  try { flow = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(`flow 读取/解析失败：${file}（${e.message}）`); }
  if (action === 'lint') {
    // V202610130003 件3 flow lint：lintContracts 纯函数机检 CLI 化（V202609300017 契约批从 selftest 解放给
    // 日常 authoring）——M1 闸门-点击同描述符（铁律①）/M2 歧义文本登记（铁律②）/M3 盲等证据（铁律③）。
    // 违例=advisory inventory 语义不变：静态 lint 不进 validateFlow、不改判回放；有违例退出码非 0（对齐 validate）。
    const ambiguousTexts = parseAmbiguousTexts(flow._meta && flow._meta.app);
    if (!ambiguousTexts.length) info('[flow lint] M2 跳过：无 ambiguousTexts 清单（webapp.md 未登记或文件缺失）');
    const warns = engine.lintContracts(flow, { ambiguousTexts });
    for (const w of warns) info(`  ✗ [${w.rule}] 步骤 ${w.step}：${w.msg}`);
    if (warns.length) {
      console.error(`[flow lint] ✗ ${warns.length} 条违例（${flow._meta.title || path.basename(file)}，${flow.steps.length} 步，ambiguousTexts ${ambiguousTexts.length} 条）——铁律机检 M1/M2/M3/M6 详见 selftest #74/#127 与 CHANGELOG V202609300017/V20261113008`);
      if (jsonMode) return emitFailWithData('flow', 'E_USAGE', `flow lint ${warns.length} 条违例`, {
        action: 'lint', file, ok: false, title: flow._meta.title || path.basename(file), steps: flow.steps.length,
        ambiguousTexts: ambiguousTexts.length, violations: warns.map((w) => ({ rule: w.rule, step: w.step, msg: w.msg })),
      });
      return EXIT_ERR;
    }
    info(`[flow lint] ✓ 0 违例：${flow._meta.title || path.basename(file)}（${flow.steps.length} 步，ambiguousTexts ${ambiguousTexts.length} 条）`);
    if (jsonMode) return emitOk('flow', { action: 'lint', file, ok: true, title: flow._meta.title || path.basename(file), steps: flow.steps.length, ambiguousTexts: ambiguousTexts.length, violations: [] });
    return EXIT_OK;
  }
  if (action === 'validate') {
    const errors = engine.validateFlow(flow);
    if (errors.length) {
      for (const e of errors) console.error(`  ✗ ${e}`);
      die(`flow 校验失败：${errors.length} 处`);
    }
    info(`[flow] ✓ schema 校验通过：${flow._meta.title}（${flow.steps.length} 步，app=${flow._meta.app}，dpr=${flow._meta.dpr}）`);
    if (jsonMode) return emitOk('flow', { action: 'validate', file, ok: true, title: flow._meta.title, steps: flow.steps.length, app: flow._meta.app, dpr: flow._meta.dpr });
    return EXIT_OK;
  }
  return maybeLock(!!flags.lock, 'flow-replay', async () => {
    auditInsecureCerts(flags); // --insecure 仅 replay 面（validate/lint 不触达）
    const challengeOpt = challengeOptions(flags); // C4（#124）：--allow-challenge/--challenge-wait-ms（仅 replay 面；参数校验走 E_USAGE）
    let vars;
    if (flags['var-json']) { try { vars = JSON.parse(flags['var-json']); } catch (e) { die(`--var-json 解析失败：${e.message}`); } }
    else if (flags.var && flags.var.includes('=')) {
      const i = flags.var.indexOf('=');
      vars = { [flags.var.slice(0, i)]: flags.var.slice(i + 1) };
    }
    const core = require('../lib/cdp-core');
    const browserUrl = core.resolveBrowserUrl(flags.url);
    // 探活前置（V202609130003；研究题 2）：执行步骤前 Target.getTargets 单次探活——通道失效快速失败
    // （快速失败优于中途挂：失败直达用户而非卡在步骤中超时），不加重试循环保持简单
    {
      const probeClient = trackedClient(core, browserUrl, num(flags.timeout, 5000));
      try {
        await probeClient.connect();
        const infos = await probeClient.send('Target.getTargets', {}, { timeoutMs: num(flags.timeout, 5000) });
        // 标签卫生 preflight（2026-09-18 oracle 归因批后续三件之③）：复用探活同一发 getTargets 结果统计
        // 同应用标签数（零额外 CDP 往返），超阈值在回放开始前 stdout 告警（advisory only 不阻断；失败路径
        // 也不丢——runFlow 失败返回不携带 warnings）。fail-soft：preflight 自身挂了只静默跳过，探活语义不变。
        try {
          const preMsg = engine.tabHygieneWarning(flow, infos && infos.targetInfos);
          if (preMsg) info(`  ⚠ ${preMsg}`);
        } catch { /* fail-soft：preflight 挂了绝不影响回放 */ }
      } catch (e) {
        die(`CDP 通道探活失败（${core.kindText(e.kind) || '错误'}：${e.message}）——通道可能已失效，建议先 node tools/cdp.js doctor 诊断，或 browser-restart 重置后再回放`);
      } finally { await gracefulClose(probeClient); }
    }
    const r = await engine.runFlow(flow, {
      flowFile: file,
      browserUrl,
      targetSel: flags.target,
      vars,
      keepTab: !!flags['keep-tab'],
      timeoutMs: num(flags.timeout, 5000),
      hitTest: flags['no-hit-test'] ? false : undefined,   // X1 总开关（默认开）
      kind: flags['no-kind'] ? false : undefined,          // kind 语义层总开关（默认开；ora-5 设计 §3.7 CLI 逃生舱，_meta.kind:false 同效）
      postVerify: flags['post-verify'] ? true : undefined, // X4 post 复核（实验开关默认关）
      // V202610150003 popup-guard（广告/推广弹窗拦截，A 路线 DOM 守卫；默认关——不加旗标行为零变化）：
      // --popup-rules 显式文件则跳过 app/全局双层加载；guard 注入/清理/摘要全在 lib/flow-engine（fail-soft）。
      popupGuard: !!flags['popup-guard'],
      popupRules: flags['popup-rules'] ? String(flags['popup-rules']) : undefined,
      // V202609090002 录屏兜底（-v 显式开启，默认关）：对回放目标 tab 起 screencast，落 tmpdata/video/replay-<ts>/
      video: !!flags.video,
      videoWidth: num(flags['video-width'], 960),
      videoQuality: num(flags['video-quality'], 60),
      videoInterval: num(flags['video-interval'], 1000),
      // B7 N6：作业进度（非作业进程 jobs.progress 恒 no-op）
      onProgress: (p) => jobs.progress(p),
      // --insecure（V20261112001 §17）：连接级证书忽略——runFlow 连接建立后一行发送，整场回放窗口覆盖
      insecure: !!flags.insecure,
      // C4（#124）：challenge 挂点（goto 步后置）——CLI 旗标 > flow _meta > 默认（见 lib/challenge.js）
      allowChallenge: flags['allow-challenge'] ? true : undefined,
      challengeWaitMs: flags['challenge-wait-ms'] === undefined ? undefined : challengeOpt.waitMs,
    });
    if (r.ok) {
      // #127 V2：完成步数口径=去重执行步（r.stepsDone；存量流无该字段/恒等 completed.length——行为零变化）
      const doneN = r.stepsDone == null ? r.completed.length : r.stepsDone;
      jobs.setArtifact(r.reportPath || null);
      jobs.progress({ phase: 'done', current: doneN, total: doneN });
    }
    for (const s of r.completed) info(`  ✓ [${s.index}] ${s.action}${s.desc ? '：' + s.desc : ''}（${s.ms}ms）`);
    for (const w of r.warnings || []) info(`  ⚠ ${w}`);
    if (r.popupGuard) { // V202610150003 popup-guard 摘要（拦截留痕：条数 + 规则 id 归并）
      const pg = r.popupGuard;
      if (pg.enabled) {
        const br = pg.byRule && Object.keys(pg.byRule).length ? Object.entries(pg.byRule).map(([k, v]) => `${k}:${v}`).join('，') : '无';
        info(`  ⊘ popup-guard 拦截 ${pg.blocked == null ? '留痕读取失败' : pg.blocked} 条（规则 ${pg.rules} 条，source=${pg.source}；按规则：${br}）`);
      } else {
        info(`  ⊘ popup-guard 未启用：${pg.error || '未知'}${pg.file ? `（${pg.file}）` : ''}`);
      }
    }
    /* --json data（B1b）：报告路径 + 摘要（非全量嵌套——失败报告本体在报告文件里） */
    const flowSummary = {
      action: 'replay', file, steps: flow.steps.length,
      completed: r.stepsDone == null ? r.completed.length : r.stepsDone,
      // #127 V2：条件跳步跳过的步数（仅在 >0 时出现——存量流 JSON 形状零变化）
      ...(r.stepsSkipped ? { skipped: r.stepsSkipped } : {}),
      dpr: r.dpr === null || r.dpr === undefined ? null : r.dpr,
      insecure: flags.insecure ? true : undefined,
      video: r.video ? { dir: r.video.dir, frames: r.video.frames } : null,
      popupGuard: r.popupGuard ? { enabled: !!r.popupGuard.enabled, blocked: r.popupGuard.blocked == null ? null : r.popupGuard.blocked, rules: r.popupGuard.rules == null ? null : r.popupGuard.rules, source: r.popupGuard.source || null } : null,
      warnings: r.warnings || [],
    };
    if (r.ok) {
      // #127 V2：存量流无 stepsDone/stepsExecuted → 文案逐字节不变；循环/跳步流如实附执行次数与跳过步数
      const doneN = r.stepsDone == null ? r.completed.length : r.stepsDone;
      const repeatNote = (r.stepsExecuted != null && (r.stepsExecuted !== doneN || r.stepsSkipped))
        ? `（执行 ${r.stepsExecuted} 次${r.stepsExecuted !== doneN ? '，含循环/回跳' : ''}${r.stepsSkipped ? `；条件跳步跳过 ${r.stepsSkipped} 步` : ''}）`
        : '';
      info(`[flow] ✓ 回放完成：${doneN}/${flow.steps.length} 步全过${repeatNote}（真实 Input 事件；DPR 实际 ${r.dpr === null || r.dpr === undefined ? '读取失败' : r.dpr}，不 emulate——V202609080010）`);
      if (r.video) info(`[flow] 录屏兜底：${r.video.dir}（${r.video.frames} 帧）——帧流视觉证据，供假绿/前置问题排查`);
      if (jsonMode) return emitOk('flow', { ok: true, reportPath: null, summary: flowSummary }, { warnings: r.warnings || [] });
      return EXIT_OK;
    }
    const f = r.failReport;
    if (r.video) console.error(`[flow] 录屏兜底：${r.video.dir}（${r.video.frames} 帧）——失败过程帧流已留存，与失败报告对照看「✓ 但没发生」`);
    console.error(`[flow] ✗ 失败于步骤 ${f.stoppedAt.index}（${f.stoppedAt.action}${f.stoppedAt.desc ? '：' + f.stoppedAt.desc : ''}，${f.stoppedAt.elapsedMs}ms）`);
    console.error(`[flow]   错误[${f.error.code}]：${f.error.message}`);
    for (const a of f.attempts || []) console.error(`[flow]   尝试 ${a.strategy} ${JSON.stringify(a.spec).slice(0, 40)} → ${a.ok ? '命中' : `未命中（${a.found || 0} 候选）`}`);
    for (const c of (f.candidates || []).slice(0, 5)) {
      console.error(`[flow]   候选 <${c.tag}> "${String(c.text).slice(0, 30)}" rect=${JSON.stringify(c.rect)} @${c.frame}`);
    }
    if (f.targetState) console.error(`[flow]   现场：${JSON.stringify(f.targetState).slice(0, 120)}`);
    if (f.terminalState) console.error(`[flow]   终态取证：${JSON.stringify(f.terminalState).slice(0, 200)}`);
    // P1-2（V202609130001）：urlTrail 人类可读摘要——乐观会话迁移（/c/WEB: 中间态）=消息已提交收单的现场证据
    if (f.urlTrailSummary) console.error(`[flow]   URL 轨迹：${f.urlTrailSummary}${f.optimisticMigration ? '（检测到乐观会话迁移=消息已提交）' : ''}`);
    console.error(`[flow]   终态截图：${f.screenshot || '（截图失败）'}`);
    console.error(`[flow]   失败报告：${f.file}（self-heal 协议：交互修复该步→更新 flow→retry ≤1，二次失败交人工）`);
    if (jsonMode) {
      const code = /CHALLENGE/i.test(String(f.error.code || '')) ? 'E_POLICY_DENIED'
        : (/TARGET|LOCATE|NOT_FOUND|AMBIGUOUS/i.test(String(f.error.code || '')) ? 'E_LOCATE' : 'E_INTERNAL');
      return emitFailWithData('flow', code, `flow 回放失败于步骤 ${f.stoppedAt.index}（${f.stoppedAt.action}）：[${f.error.code}] ${f.error.message}`, {
        ok: false, reportPath: f.file, summary: Object.assign({}, flowSummary, {
          ok: false,
          stoppedAt: { index: f.stoppedAt.index, action: f.stoppedAt.action, elapsedMs: f.stoppedAt.elapsedMs },
          error: { code: f.error.code, message: f.error.message },
          attempts: (f.attempts || []).length, screenshot: f.screenshot || null,
        }),
      });
    }
    return EXIT_ERR;
  });
}
/* ── popup-guard：广告/推广弹窗拦截体系（P1，V202610150003）——规则库双层 + DOM 层守卫三态 ──
 * scan = 只读扫描当前页「命中规则 + 候选弹窗节点」（取证，零动作）；
 * test = dry-run 注入守卫观察 --seconds（默认 60）——只记录不动作，输出「将拦截清单」（上线前误杀检验）；
 * on|off = 会话内开关页侧守卫（on 只做页内注入：不注册新文档脚本，故进程退出后不留注册残留；
 *          页面刷新/导航后失效——需跨导航生效请用 `flow replay --popup-guard`）。
 * 红线：零合成事件、零网络层拦截（B 路线属 P3）；test/off 结束时尽力摘除守卫（现场还原）。 */
function appSlugForUrl(url) {
  try {
    const m = require('../lib/matchers');
    const r = m.resolveApp(m.loadAppsIndex(path.join(paths.SKILL_ROOT, 'webapps')), url);
    return r.app || null;
  } catch { return null; }
}
async function cmdPopupGuard(pos, flags) {
  const mode = pos[0];
  if (!['scan', 'test', 'on', 'off'].includes(mode)) { console.error(SUB_HELP['popup-guard']); return EXIT_ERR; }
  if (!flags.target) die('popup-guard 需 --target <pageId|url子串|title子串>（永不自动开/关 tab）');
  const pg = require('../lib/popup-guard');
  const { core, client } = await openClient(flags);
  try {
    const { target, sessionId } = await core.resolveTarget(client, flags.target);
    const url = target.url || '';
    const timeout = num(flags.timeout, 5000);
    if (mode === 'off') { // 摘除（幂等）：页侧 observer.disconnect + 清窗口变量
      const before = await core.evaluate(client, sessionId,
        'JSON.stringify({installed:!!window.__cu_pg_installed,stopped:!!window.__cu_pg_stopped,logged:(window.__cu_pg_log||[]).length})', timeout).catch(() => null);
      let st = null; try { st = before ? JSON.parse(before) : null; } catch { st = null; }
      await core.evaluate(client, sessionId, pg.TEARDOWN_SRC, timeout).catch(() => {});
      console.log(`[popup-guard off] 已摘除页侧守卫：${url}`);
      console.log(`  摘除前状态：${st ? JSON.stringify(st) : '读取失败'}${st && !st.installed ? '（该页未安装 guard——可能已失效/已刷新）' : ''}`);
      return EXIT_OK;
    }
    // 规则来源：--rules 显式文件 > app（--app 或按 URL 识别）> 全局（双层语义见 lib/popup-guard.loadRules）
    let loaded;
    if (flags.rules) {
      loaded = pg.loadRulesFromFile(flags.rules);
      console.log(`[popup-guard] 规则来源=显式文件 ${loaded.file}`);
    } else {
      const app = flags.app ? String(flags.app) : appSlugForUrl(url);
      loaded = pg.loadRules({ appSlug: app });
      console.log(`[popup-guard] 应用识别=${app || '（零命中）'} → 规则来源=${loaded.source === 'app' ? `app 配置（整体为准，不合并全局）` : '全局'} ${loaded.file}`);
    }
    if (!loaded.ok) die(`popup-guard 规则加载失败：${loaded.error}（${loaded.file}）`);
    const scoped = pg.filterRulesByUrl(loaded.rules, url);
    const summary = pg.compileRuleSummary(scoped);
    const head = `[popup-guard ${mode}] ${url}｜适用规则 ${summary.total} 条（remove ${summary.remove}/hide ${summary.hide}/scope 收窄 ${summary.scoped}）`;
    if (!summary.total) { console.log(`${head}\n  该页无适用规则（scope 全部不匹配）——零动作退出`); return EXIT_OK; }
    if (mode === 'scan') { // 只读数命中清单（不改 DOM、不装 observer）
      const raw = await core.evaluate(client, sessionId, pg.buildScanScript(scoped), num(flags.timeout, 8000));
      const rep = typeof raw === 'string' ? JSON.parse(raw) : raw;
      console.log(head);
      console.log(`  扫描 ${rep.scanned} 个节点，命中 ${rep.hits.length} 条${rep.truncated ? '（达上限截断）' : ''}——只读取证，未做任何动作`);
      for (const h of rep.hits) console.log(`  · ${h.ruleId}（${h.action}）<${h.tag}> "${String(h.text).slice(0, 40)}" cls="${String(h.cls).slice(0, 48)}" rect=${JSON.stringify(h.rect)} z=${h.zIndex}`);
      if (!rep.hits.length) console.log('  （零命中——当前页无候选弹窗节点）');
      return EXIT_OK;
    }
    const seconds = Math.min(Math.max(num(flags.seconds, 60), 1), 600);
    const script = mode === 'test' ? pg.buildGuardScript(scoped, { dryRun: true }) : pg.buildGuardScript(scoped);
    await core.evaluate(client, sessionId, script, timeout);
    if (mode === 'on') {
      console.log(head);
      console.log('  已注入页侧守卫（真动作）——⚠ 仅页内生效：页面刷新/导航后失效；跨导航请用 `flow replay --popup-guard`');
      console.log('  摘除：node tools/cdp.js popup-guard off --target <同一页>');
      return EXIT_OK;
    }
    console.log(head);
    console.log(`  dry-run 注入完成（只记录不动作）——观察 ${seconds}s…（等待期间请正常浏览，让弹窗自然出现）`);
    await sleep(seconds * 1000);
    const raw = await core.evaluate(client, sessionId, 'JSON.stringify(window.__cu_pg_log||[])', 3000).catch(() => null);
    let entries = [];
    try { entries = raw ? JSON.parse(raw) : []; } catch { entries = []; }
    const s = pg.summarizeLog(entries);
    console.log(`  将拦截 ${s.count} 条${raw === null ? '（留痕读取失败）' : ''}：`);
    for (const e of entries) console.log(`  · ${e.ruleId}（${e.action}）<${e.tag}> "${String(e.text).slice(0, 40)}"`);
    if (!entries.length) console.log('  （零命中——该时段无弹窗出现，或规则不适用本次现场）');
    await core.evaluate(client, sessionId, pg.TEARDOWN_SRC, timeout).catch(() => {});
    console.log('  已摘除 dry-run 守卫（现场还原）');
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}
function cmdRecord(flags) {
  // B7 N6：把作业进度回调透传给 record（非作业进程 jobs.progress 恒 no-op）
  return require('../lib/record').record(Object.assign({}, flags, { onProgress: (p) => jobs.progress(p) }));
}

/* ── identify：应用识别（matchers 分段锚定 + 约束度打分 + 用户断言优先；V202609080009） ──
 * 退出码：0 单命中（或断言命中）｜3 多命中同约束度（问用户）｜1 零命中/错误 */
async function cmdIdentify(flags) {
  const m = require('../lib/matchers');
  const pathsMod = require('../lib/paths');
  if (flags['assert-app']) {
    if (!flags.url) die('--assert-app 须配合 --url <url> 使用');
    const f = m.appendAssertion({ url: String(flags.url), app: String(flags['assert-app']), note: flags.note ? String(flags.note) : 'identify 记忆化（用户同意）' });
    console.log(`[identify] ✓ 断言已记忆化 → ${f}（推广时批量泛化入 matchers）`);
  }
  let url = flags.url;
  if (!url && flags.target) {
    const { core, client } = await openClient(flags);
    try { const t = await core.resolveTarget(client, flags.target); url = t.target.url; } finally { await gracefulClose(client); }
  }
  if (!url) { console.error(SUB_HELP.identify); return EXIT_ERR; }
  const apps = m.loadAppsIndex(pathsMod.SKILL_ROOT + '/webapps');
  const assertions = m.loadAssertions();
  const hit = m.assertionFor(assertions, url);
  const r = m.resolveApp(apps, url);
  console.log(`[identify] ${url}`);
  for (const c of r.candidates) console.log(`[identify]   候选 ${c.slug}（约束度 ${c.score}，命中 ${c.hits} 条模式）`);
  if (hit) { console.log(`[identify] ✓ 识别：${hit.app}（用户断言优先级最高${hit.note ? '：' + hit.note : ''}）`); return EXIT_OK; }
  if (r.ambiguous) { console.log('[identify] ⚠ 多命中同约束度——问用户一次并会话内记住（确认后 --assert-app <slug> 记忆化）'); return 3; }
  if (!r.matched) { console.log('[identify] ✗ 零命中——问用户并登记 TODO INBOX（候选新应用）'); return EXIT_ERR; }
  console.log(`[identify] ✓ 识别：${r.app}（单命中直载 webapps/${r.app}/webapp.md）`);
  return EXIT_OK;
}

/* ── diff-video：事件流 × 录屏帧对照报告（V202609090002 视觉兜底层2，chromeuse-videodiff/1）──
 * 读 recording-*.json 的 session.id → 自动定位 tmpdata/video/<session>/index.json（缺失扫帧目录重建）；
 * 或 --video-file <mp4> 外部录屏兼容（--t0 锚定，缺省 session.startedAt，对齐误差 ±2s 级）。
 * 对照基准时钟：事件 tRecv（Node 接收时刻，缺 tRecv 的旧流回退 t）↔ 帧 tArrive（同钟，毫秒）。 */
const DIFF_TYPES = ['click', 'dblclick', 'uiAppear', 'navigate'];

function diffEventDesc(e) {
  if (e.type === 'navigate') return String(e.url || '').slice(0, 80);
  if (e.type === 'uiAppear') return `trigger=${e.triggerType || '?'}#${e.triggerSeq != null ? e.triggerSeq : '?'} 容器=${(e.containers || []).length}`;
  const t = e.target || {};
  return `<${t.tag || '?'}> ${String(t.text || t.id || '').slice(0, 30)}`;
}

/** 帧数组（tArrive 升序）中取 t 前后最近帧（含 Δt；找不到为 null） */
function nearestFrames(frames, t) {
  let before = null, after = null;
  for (const f of frames) {
    if ((f.tArrive || 0) <= t) before = f;
    else { after = f; break; }
  }
  return {
    before: before ? { file: before.file, dtMs: t - before.tArrive } : null,
    after: after ? { file: after.file, dtMs: after.tArrive - t } : null,
  };
}

/** bin/ffprobe 取媒体时长（秒；不可用返回 null）。路径解析单源 = lib/platform binaries provider。 */
function probeMediaDuration(mp4) {
  const { spawnSync } = require('node:child_process');
  const r = platform().binaries.resolve();
  if (!r.exists.ffprobe) return null;
  try {
    const res = spawnSync(r.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4], { encoding: 'utf8', timeout: 15000 });
    const d = parseFloat(String(res.stdout || '').trim());
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

/** 帧目录实际 jpg 计数（rebuild 触发条件比对用：index 可能撒谎——per-target 覆写残留残缺 index） */
function countFrameJpgs(sessionDir) {
  const framesRoot = path.join(sessionDir, 'frames');
  if (!fs.existsSync(framesRoot)) return 0;
  let n = 0;
  try {
    for (const tab of fs.readdirSync(framesRoot)) {
      const dir = path.join(framesRoot, tab);
      let dstat = null;
      try { dstat = fs.statSync(dir); } catch { continue; }
      if (!dstat.isDirectory()) continue;
      try { n += fs.readdirSync(dir).filter((x) => x.endsWith('.jpg')).length; } catch { /* 尽力而为 */ }
    }
  } catch { /* 尽力而为 */ }
  return n;
}

/** index.json 缺失兜底：扫帧目录重建（tArrive 用文件 mtime——秒级误差，报告标注） */
function rebuildVideoIndex(sessionDir) {
  const framesRoot = path.join(sessionDir, 'frames');
  if (!fs.existsSync(framesRoot)) return null;
  const frames = [];
  for (const tab of fs.readdirSync(framesRoot)) {
    const dir = path.join(framesRoot, tab);
    let dstat = null;
    try { dstat = fs.statSync(dir); } catch { continue; }
    if (!dstat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg')).sort()) {
      let mt = null;
      try { mt = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* 尽力而为 */ }
      frames.push({ file: path.join(dir, f), tab, tArrive: mt, tMeta: null });
    }
  }
  if (!frames.length) return null;
  return { format: 'chromeuse-video/1', session: path.basename(sessionDir), config: { rebuilt: true, clock: 'mtime（秒级误差）' }, frames };
}

/** --mp4 可选：bin/ffmpeg 帧序列合成（-framerate 2；帧名 %06d 连续递增，fail-soft 写盘缺帧会断流——失败标注不阻塞报告）
 *  路径解析单源 = lib/platform binaries provider；缺失时 err 附可操作 hint（下载/放置/config 键）。 */
function synthMp4FromFrames(frames, outBase, report) {
  const { spawnSync } = require('node:child_process');
  const r = platform().binaries.resolve();
  if (!r.exists.ffmpeg) { report.mp4s = [{ err: `缺 ffmpeg（跳过合成）${r.hint ? `——${r.hint}` : ''}` }]; return; }
  const ffmpeg = r.ffmpeg;
  const byTab = new Map();
  for (const f of frames) { const a = byTab.get(f.tab) || []; a.push(f); byTab.set(f.tab, a); }
  const out = [];
  for (const [tab, fr] of [...byTab.entries()].sort()) {
    fr.sort((a, b) => (a.tArrive || 0) - (b.tArrive || 0));
    const mp4 = `${outBase}-${tab}.mp4`;
    try {
      const r = spawnSync(ffmpeg, ['-y', '-framerate', '2', '-i', path.join(path.dirname(fr[0].file), '%06d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4], { encoding: 'utf8', timeout: 120000 });
      if (r.status === 0 && fs.existsSync(mp4)) out.push({ tab, mp4 });
      else out.push({ tab, mp4: null, err: ((r.stderr || '').trim().split('\n').slice(-1)[0] || 'ffmpeg 失败（帧序列可能断号）').slice(0, 140) });
    } catch (e) { out.push({ tab, mp4: null, err: e.message }); }
  }
  report.mp4s = out;
}

/* ── browser-restart：优雅重启浏览器（Y1 治本方案产品化，V202609100002）──
 * 机制（2026-09-10 实测全链路 ~10s）：Browser.close（浏览器级、不带 --target）优雅关闭 Chromium
 * （ExitType:Normal，无恢复气泡）→ keep-alive 自动拉起 → CDP 探活 → tab 清单。
 * ⚠ 环境边界（用户裁定）：自动重启依赖容器 keep-alive（wrapped-chromium 循环，NAS chrome-browser 特有）；
 *   无自动重启机制的环境（如 Windows 桌面 chrome.exe）Browser.close 后浏览器退出即终止，需手动重启
 *   浏览器后再重试探活（本命令重试幂等）。
 * 用途：CDP 操作过多 / DevTools 域层损伤（per-target 全 -32601）时的环境重置——比 docker restart 干净。
 */
async function cmdBrowserRestart(flags) {
  const core = require('../lib/cdp-core');
  const url = core.resolveBrowserUrl(flags.url);
  const budget = num(flags.timeout, 30000);
  console.log(`[browser-restart] ⚠ 爆炸半径=整浏览器（所有 tab 将关闭）——确认无重要现场。目标：${url}`);
  console.log('[browser-restart] ① Browser.close（优雅关闭；ExitType:Normal，无恢复气泡）…');
  log.info('browser-restart', `开始：Browser.close @ ${url}（探活预算 ${budget}ms）`);
  try {
    const client = trackedClient(core, url, 5000);
    await client.connect();
    await client.send('Browser.close', {}, { timeoutMs: 3000 });
    await gracefulClose(client); // 浏览器关闭中：detach 多半直接失败（连接已断/1s 短超时封顶），统一走优雅关闭保持纪律
    console.log('[browser-restart]   Browser.close 已确认');
  } catch (e) {
    // 预期路径：Browser.close 后浏览器进程退出、WS 随之断开——连接错误不是失败，转探活
    console.log('[browser-restart]   连接已断开（浏览器关闭中），转入探活等待');
    log.info('browser-restart', `连接断开（预期，浏览器关闭中）：${e.message}`);
  }
  console.log(`[browser-restart] ② 探活轮询（每 2s /json/version，预算 ${budget / 1000}s；keep-alive 拉起一般 ≤2s）…`);
  const t0 = Date.now();
  let alive = false;
  while (Date.now() - t0 < budget) {
    await sleep(2000);
    try { await core.browserVersion(url, 2000); alive = true; break; } catch { /* 未拉起，继续轮询 */ }
  }
  if (!alive) {
    console.error(`[browser-restart] ✗✗ ${budget / 1000}s 探活超时——浏览器未自动拉起。`);
    console.error('[browser-restart]   若环境无自动重启机制（如 Windows 桌面端），请手动重启浏览器后重试探活（本命令幂等可重跑）；');
    console.error('[browser-restart]   NAS chrome-browser 容器（keep-alive 失效时）人工兜底：docker restart chrome-browser（coding-envs 仓库）。');
    log.error('browser-restart', `探活超时（${budget}ms）——无自动重启机制环境需手动重启浏览器；NAS 容器兜底 docker restart chrome-browser`);
    return EXIT_ERR;
  }
  console.log(`[browser-restart]   ✓ DevTools 探活成功（${((Date.now() - t0) / 1000).toFixed(1)}s）；等 2s DevTools 子系统稳定…`);
  await sleep(2000);
  // ③ 域级深检（V202609100002 实测补充）：HTTP /json/version 探活成功 ≠ per-target 域可用——
  //    keep-alive 拉起模式实测存在「进程已起但域命令 -32601」的过渡/持续状态；宽限轮询 30s（每 5s 一次）
  let domainOk = false;
  const dDeadline = Date.now() + 30000;
  while (Date.now() - dDeadline < 30000) {
    try {
      const targets = await core.listTargets(url, 4000);
      const page = targets.find((t) => t.type === 'page');
      if (!page) { await sleep(5000); continue; }
      const c2 = trackedClient(core, url, 4000);
      await c2.connect();
      const at = await c2.send('Target.attachToTarget', { targetId: page.id, flatten: true }, { timeoutMs: 4000 });
      await c2.send('Runtime.enable', {}, { sessionId: at.sessionId, timeoutMs: 4000 });
      await gracefulClose(c2);
      domainOk = true;
      console.log(`[browser-restart]   ✓ 域级深检通过（Runtime.enable 可用，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      break;
    } catch { /* 域未就绪——keep-alive 模式过渡态，宽限轮询 */ await sleep(5000); }
  }
  if (!domainOk) {
    console.error('[browser-restart] ⚠⚠ 域级深检 30s 未通过：浏览器进程已拉起，但 per-target 域命令仍 -32601（keep-alive 模式特性或 DevTools 损伤过深）。');
    console.error('[browser-restart]   处置：等待 1-2 分钟后重跑本命令（幂等，此时仅补域检与清单）；仍坏则人工 docker restart chrome-browser（coding-envs 仓库）。');
    log.error('browser-restart', `域级深检失败：进程已拉起但 per-target 域 -32601 持续`);
    return EXIT_ERR;
  }
  let list = [];
  try { list = await core.listTargets(url, 5000); } catch (e) {
    console.error(`[browser-restart] ⚠ /json/list 拉取失败（DevTools 可能仍在稳定）：${e.message}——浏览器已在运行，重跑本命令可仅补 tab 清单`);
    log.warn('browser-restart', `listTargets 失败：${e.message}`);
    return EXIT_ERR;
  }
  const pages = list.filter((t) => t.type === 'page');
  console.log(`[browser-restart] ✓ 浏览器已重启恢复（全链路 ${((Date.now() - t0) / 1000).toFixed(1)}s；进程全新 / 无恢复气泡）：${list.length} 个 target（page ${pages.length}）`);
  for (const t of pages) console.log(`[browser-restart]   ${String(t.title || '').slice(0, 30) || '（新标签页）'}  ${String(t.url).slice(0, 70)}`);
  log.info('browser-restart', `完成：全链路 ${((Date.now() - t0) / 1000).toFixed(1)}s，${list.length} target（page ${pages.length}）`);
  return EXIT_OK;
}

/* ── browser-up：OS 级拉起调试实例（批C2/R2，V20261117008）──
 * 与 browser-restart 分工：up=**进程级启动**（从「无调试实例」到「有」；无 keep-alive 环境如 Windows
 * 桌面端补齐空白）/ restart=**CDP 级重启**（Browser.close 依赖容器 keep-alive 自动拉起，治 DevTools 域损伤）。
 * 幂等探测/发现序/state/安全拒绝面全在 lib/browser-launch.js（平台差异走 lib/platform 契约）；本函数只做参数与输出。
 * 生命周期默认常驻（登录态在独立 profile）；--stop 显式关停；--status 只读查询。 */
async function cmdBrowserUp(flags) {
  const launch = require('../lib/browser-launch');
  if (flags.stop && flags.status) die('browser-up 的 --stop 与 --status 互斥（一次只做一件事）');
  if (flags.timeout === true) die('--timeout 缺值（就绪预算毫秒数，默认 20000）');
  if (flags.proxy === true || flags.proxy === '') die('--proxy 缺值（代理 URL，例：--proxy http://127.0.0.1:7897；Chromium 内核限定，仅作用于被拉起的实例）');
  if (flags.stop !== undefined && flags.stop !== true && flags.stop !== 'true') die(`browser-up --stop 不接受值（实际 ${JSON.stringify(flags.stop)}）`);
  if (flags.status !== undefined && flags.status !== true && flags.status !== 'true') die(`browser-up --status 不接受值（实际 ${JSON.stringify(flags.status)}）`);
  const timeoutMs = Math.max(500, Math.min(120000, num(flags.timeout, 20000)));
  if (flags.status) {
    const st = await launch.status({ timeoutMs: 2000 });
    console.log(`[browser-up] status：state=${st.state ? 'present' : 'absent'} ready=${st.ready} port=${st.port == null ? '—' : st.port}${st.version ? ` version=${st.version}` : ''}${st.state && st.state.proxy ? ` proxy=${st.state.proxy}` : ''}`);
    if (st.state) {
      console.log(`[browser-up]   pid=${st.state.pid == null ? '—' : st.state.pid} exe=${st.state.exe || '—'} userDataDir=${st.state.userDataDir || '—'} startedAt=${st.state.startedAt || '—'}`);
      if (st.state.proxy) console.log(`[browser-up]   proxy=${st.state.proxy}（state 记录=脱敏值${st.state.proxySource ? `，source=${st.state.proxySource}` : ''}；换代理需 --stop 后重拉）`);
    } else {
      console.log('[browser-up]   无 state 记录：首次使用请先 node tools/cdp.js browser-up（需 config chrome 三键齐备）');
    }
    return EXIT_OK;
  }
  if (flags.stop) {
    console.log('[browser-up] 关停调试实例：state.pid 进程组信号（SIGTERM→宽限→SIGKILL）→ 兜底 CDP Browser.close…');
    const r = await launch.stop({});
    if (r.stopped) console.log(`[browser-up] ✓ 已关停（method=${r.method}${r.pid ? `，pid=${r.pid}` : ''}${r.signal ? `，signal=${r.signal}` : ''}）`);
    else console.log(`[browser-up] ℹ 无可关停实例（method=${r.method}；当前已是停止状态）`);
    const st = await launch.status({ timeoutMs: 1200 });
    if (st.port != null) console.log(`[browser-up]   复核：port=${st.port} ready=${st.ready}（false=端口已关）`);
    return EXIT_OK;
  }
  const t0 = Date.now();
  console.log(`[browser-up] 拉起/复用调试实例（就绪预算 ${timeoutMs}ms；校验 chrome 三键 → 发现 exe → 幂等探测 → spawn 常驻 → 等就绪${flags.proxy ? `；proxy=${flags.proxy}` : ''}）…`);
  let r;
  try { r = await launch.ensure({ timeoutMs, proxy: flags.proxy }); }
  catch (e) { fail(errors.codeForKind((e && e.kind) || 'conn'), `browser-up 失败：${(e && e.message) || e}`); }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.reused) {
    console.log(`[browser-up] ✓ 调试实例已就绪（复用现有实例，${secs}s）：${r.version || 'Chromium'} @ http://127.0.0.1:${r.port}`);
  } else {
    console.log(`[browser-up] ✓ 已拉起调试实例 pid=${r.pid} port=${r.port}（${secs}s）：${r.version || 'Chromium'}`);
  }
  console.log(`[browser-up]   exe=${r.exe || '—'}${r.exeSource ? `（source=${r.exeSource}）` : ''}`);
  console.log(`[browser-up]   userDataDir=${r.userDataDir || '—'}（独立 profile：首次各网站需手动登录一次）`);
  if (r.proxy) {
    console.log(`[browser-up]   proxy=${r.proxy}${r.reused ? '（现有实例 state 记录，本次请求不生效）' : `（--proxy-server 已注入${r.proxySource ? `，source=${r.proxySource}` : ''}；仅本次拉起实例生效，换代理需 --stop 后重拉）`}`);
  }
  console.log(`[browser-up]   state=${r.stateFile}（--status 查询 / --stop 关停；browser-restart=CDP 级重启，依赖容器 keep-alive）`);
  return EXIT_OK;
}

async function cmdDiffVideo(pos, flags) {
  const file = pos[0];
  if (!file) die(SUB_HELP['diff-video']);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(`事件流读取/解析失败：${file}（${e.message}）`); }
  if (!doc || doc.format !== 'chromeuse-events/1' || !Array.isArray(doc.events)) die(`非 chromeuse-events/1 事件流：${file}`);
  const session = (doc.session && doc.session.id) || '';
  const events = doc.events.filter((e) => DIFF_TYPES.includes(e.type));
  const report = {
    format: 'chromeuse-videodiff/1',
    generatedAt: time.isoLocal(),
    recording: file,
    session: { id: session, startedAt: doc.session && doc.session.startedAt, stoppedAt: doc.session && doc.session.stoppedAt },
    source: null,
    alignNote: null,
    stats: { events: events.length, mapped: 0, unmapped: 0 },
    byTab: {},
  };
  const pools = new Map(); // tab → 帧数组（tArrive 升序）；'*' = 外部 mp4（跨 tab 通用）
  if (flags['video-file']) {
    /* 外部 mp4 兼容：bin/ffprobe 取时长；t0 缺省 session.startedAt（人工录屏起点非精确锚定 → ±2s 级误差） */
    const mp4 = String(flags['video-file']);
    if (!fs.existsSync(mp4)) die(`--video-file 不存在：${mp4}`);
    const dur = probeMediaDuration(mp4);
    const t0Ms = flags.t0 ? new Date(String(flags.t0)).getTime() : new Date(doc.session && doc.session.startedAt).getTime();
    if (!Number.isFinite(t0Ms)) die('--t0 无法解析为 ISO 时间：' + flags.t0);
    report.source = { kind: 'external-mp4', videoFile: mp4, durationSec: dur, t0: time.isoLocal(new Date(t0Ms)) };
    if (dur == null) {
      // 缺失 ffprobe → 时长恒 null（如实降级），并把 provider 的可操作 hint 透出到报告
      const r = platform().binaries.resolve();
      if (!r.exists.ffprobe && r.hint) report.source.ffprobeHint = r.hint;
    }
    report.alignNote = `外部 mp4 对齐误差 ±2s 级（t0=${flags.t0 ? '显式锚定 ' + report.source.t0 : '缺省取 session.startedAt，录屏起始与录制会话起点非同一时刻'}）`;
    pools.set('*', [{ file: mp4, tab: '*', tArrive: t0Ms, tMeta: null, durationMs: dur != null ? dur * 1000 : null }]);
  } else {
    const sessionDir = path.join(paths.VIDEO_DIR, session);
    const indexPath = path.join(sessionDir, 'index.json');
    let index = null;
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { index = null; }
    if (index && Array.isArray(index.frames) && index.frames.length) {
      // V202609090003 rebuild 条件放宽：index 撒谎（per-target 实例覆写残留，如 index 只剩 tab-2 的 1 帧
      // 而磁盘有 tab-1 的 9 帧）时不能直接信——frames.length < 磁盘 jpg 数也走 rebuild
      const diskCount = countFrameJpgs(sessionDir);
      if (diskCount > index.frames.length) {
        const stale = index.frames.length;
        const rebuilt = rebuildVideoIndex(sessionDir);
        if (rebuilt) {
          index = rebuilt;
          report.source = { kind: 'rebuilt-from-frames', sessionDir, note: `index 残缺已重建（index ${stale} 帧 < 磁盘 ${diskCount} 帧）` };
          report.alignNote = `index 残缺已重建（index ${stale} 帧 < 磁盘 ${diskCount} 帧；tArrive=mtime，秒级误差）`;
        } else {
          report.source = { kind: 'screencast-index', indexFile: indexPath }; // 重建失败（目录不可读）退回原 index
        }
      } else {
        report.source = { kind: 'screencast-index', indexFile: indexPath };
      }
    } else {
      index = rebuildVideoIndex(sessionDir); // index 缺失兜底：扫帧目录重建
      if (index) report.source = { kind: 'rebuilt-from-frames', sessionDir, note: 'index.json 缺失，已扫帧目录重建（tArrive=mtime，秒级误差）' };
    }
    if (index && Array.isArray(index.frames)) {
      for (const f of index.frames) { const tb = pools.get(f.tab) || []; tb.push(f); pools.set(f.tab, tb); }
      for (const tb of pools.values()) tb.sort((a, b) => (a.tArrive || 0) - (b.tArrive || 0));
    }
    if (!pools.size) die(`未找到录屏产物：${indexPath}（该 recording 录制时未带 -v？）——或用 --video-file <mp4> 指定外部录屏`);
  }
  /* 逐事件对照（按 tab 分列；tab 无帧如实标注不脑补） */
  const dtBefore = [];
  for (const e of events) {
    const tab = e.tab || '?';
    const tEvt = Number.isFinite(e.tRecv) ? e.tRecv : e.t;
    const entry = { seq: e.seq, t: e.t, type: e.type, frame: e.frame || '', desc: diffEventDesc(e), tRef: Number.isFinite(e.tRecv) ? 'tRecv' : 't' };
    const frames = pools.get(tab) || pools.get('*') || [];
    if (flags['video-file']) {
      const f = frames[0];
      const offsetMs = tEvt - f.tArrive;
      entry.offsetMs = offsetMs;
      entry.inRange = offsetMs >= 0 && (f.durationMs == null || offsetMs <= f.durationMs);
      entry.file = f.file;
      entry.inRange ? report.stats.mapped++ : report.stats.unmapped++;
    } else if (frames.length) {
      const nf = nearestFrames(frames, tEvt);
      entry.before = nf.before; entry.after = nf.after;
      if (nf.before || nf.after) { report.stats.mapped++; if (nf.before) dtBefore.push(nf.before.dtMs); }
      else report.stats.unmapped++;
    } else {
      entry.note = '该 tab 无录屏帧';
      report.stats.unmapped++;
    }
    (report.byTab[tab] = report.byTab[tab] || []).push(entry);
  }
  if (dtBefore.length) report.stats.dtBeforeMs = { min: Math.min(...dtBefore), max: Math.max(...dtBefore) };
  /* --mp4 可选：帧序列合成 mp4（仅 screencast 模式；外部 mp4 本身就是视频无需合成） */
  if (flags.mp4 && !flags['video-file']) {
    const all = [];
    for (const tb of pools.values()) all.push(...tb);
    synthMp4FromFrames(all, path.join(paths.ensureDir(path.join(paths.TMPDATA_DIR, 'videodiff')), `videodiff-${ts()}`), report);
  }
  /* 报告落盘 + stdout 摘要 */
  paths.ensureDir(path.join(paths.TMPDATA_DIR, 'videodiff'));
  const outFile = flags.out || path.join(paths.TMPDATA_DIR, 'videodiff', `videodiff-${ts()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  const srcLine = flags['video-file']
    ? `external-mp4（${report.source.videoFile}，${report.source.durationSec != null ? report.source.durationSec.toFixed(1) + 's' : '时长未知'}，t0=${report.source.t0}）`
    : `${report.source.kind}（${[...pools.entries()].map(([t, f]) => `${t}=${f.length}`).join('、')} 帧）`;
  console.log(`[diff-video] ${path.basename(file)}｜ session=${session}｜ 源=${srcLine}`);
  if (report.alignNote) console.log(`[diff-video] ⚠ ${report.alignNote}`);
  if (report.source && report.source.ffprobeHint) console.log(`[diff-video] ℹ ${report.source.ffprobeHint}`);
  console.log(`[diff-video] 关注事件（click/dblclick/uiAppear/navigate）${report.stats.events} 个：${report.stats.mapped} 已映射 / ${report.stats.unmapped} 无帧${report.stats.dtBeforeMs ? `｜ 前帧 Δt ${report.stats.dtBeforeMs.min}~${report.stats.dtBeforeMs.max}ms` : ''}`);
  for (const [tab, list] of Object.entries(report.byTab)) {
    console.log(`[diff-video] ${tab}：${list.length} 个事件（示例前 3）`);
    for (const en of list.slice(0, 3)) {
      const pos = en.before || en.after
        ? `前帧 ${en.before ? path.basename(en.before.file) + `（Δt ${en.before.dtMs}ms 前）` : '无'}｜ 后帧 ${en.after ? path.basename(en.after.file) + `（Δt ${en.after.dtMs}ms 后）` : '无'}`
        : (en.inRange !== undefined ? `mp4 偏移 ${en.offsetMs}ms（${en.inRange ? '在时长内' : '越界'}）` : en.note);
      console.log(`[diff-video]   #${en.seq} ${en.type} ${String(en.desc).slice(0, 40)}｜ ${pos}`);
    }
  }
  console.log(`[diff-video] 报告已存：${outFile}（疑点帧交 observer 视觉分析，≤25 帧/批）`);
  return EXIT_OK;
}

/* ── evidence-pack：验收回放证据包（V202609170003，核心单源 lib/evidence.js）──
 * 多段录制产物（事件流 + 录屏帧流）按绝对时间戳归一到统一时间轴 → 索引式证据包
 * （timeline.json chromeuse-evidence-pack/1 + README.md 取证自足）；段间 gap>阈值标记中断；
 * 原文件原位引用不复制不转码；损坏段如实登记不中断。纯本地聚合，零 CDP 连接（无 --url 依赖）。 */
async function cmdEvidencePack(pos, flags) {
  const evidence = require('../lib/evidence');
  if (!pos.length) die(SUB_HELP['evidence-pack']);
  let files;
  try { files = evidence.discoverRecordings(pos); }
  catch (e) { die(`evidence-pack 输入无效：${e.message}`); }
  if (!files.length) die('未发现任何 recording-*.json 事件流');
  let pack;
  try {
    pack = evidence.buildPack(files, {
      gapMs: num(flags['gap-seconds'], 300) * 1000,
      title: flags.title ? String(flags.title) : '',
      command: process.argv.slice(2).join(' '),
    });
  } catch (e) { die(`证据包构建失败：${e.message}`); }
  const outDir = flags.out || path.join(paths.EVIDENCE_DIR, 'evidence-pack-' + ts());
  paths.ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(pack.timeline, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), pack.readme);
  const tl = pack.timeline;
  console.log(`[evidence-pack] ✓ ${tl.segments.length} 段归一（零点 ${tl.origin.local}）｜段间中断/交叠 ${tl.gaps.length} 处（阈值 ${tl.gapThresholdMs / 1000}s）｜损坏段 ${tl.damaged.length}`);
  for (const s of tl.segments) {
    console.log(`[evidence-pack]   段 ${s.seg} ${s.sessionId}｜${s.startedAt.local}｜${s.counts.events} 事件/${s.counts.frames} 帧｜偏移 ${evidence.fmtOffset(s.startedAt.offsetMs)}`
      + `${s.flags.injectLost ? '｜⚠injectLost' : ''}${s.flags.wsDown ? '｜⚠wsDown' : ''}`);
  }
  for (const g of tl.gaps) console.log(`[evidence-pack]   ⚠ 段 ${g.beforeSeg}→${g.afterSeg} ${g.gapMs < 0 ? `交叠 ${( -g.gapMs / 60000).toFixed(1)} 分钟` : `间隔 ${(g.gapMs / 60000).toFixed(1)} 分钟`}——${g.kind === 'interruption' ? '段间中断' : '段间交叠'}`);
  for (const d of tl.damaged) console.log(`[evidence-pack]   ⚠ 损坏段未入轴：${d.file}（${d.error}）`);
  console.log(`[evidence-pack] 证据包：${outDir}（timeline.json + README.md；索引式——原文件原位引用不复制）`);
  log.info('evidence-pack', `证据包完成：${tl.segments.length} 段/${tl.gaps.length} gap/${tl.damaged.length} damaged → ${outDir}`);
  return EXIT_OK;
}

/* ── locator：元素定位探针/递归收窄建议/高亮验证/拾取器（V202610190001）──
 * 解决「元素捕获歧义反复试错」：probe 列候选（跨同源 iframe，visible/hitOk 逐项如实）；
 * suggest 递归收窄（共同祖先链逐级构造 container，唯一即止）；verify 高亮+截图做视觉确认；
 * pick 注入一次性 capture-phase 点击拾取器（DevTools「select an element」式）。
 * 只读为主：pick 注入监听是唯一写；highlight 只临时画框（ms 后还原，不改 DOM 结构）。
 * 语义与 lib/target-resolver.js 对齐（X1 闸门/container 文法/framePath 口径）。 */
function locatorSpecFromFlags(flags) {
  const { matchModeOK, validContainer } = require('../lib/target-resolver');
  const spec = {};
  if (flags.text !== undefined) spec.text = String(flags.text);
  if (flags.match !== undefined) spec.match = String(flags.match);
  if (flags.role !== undefined) spec.role = String(flags.role);
  if (flags['dom-path'] !== undefined) spec.domPath = String(flags['dom-path']);
  if (flags.dompath !== undefined) spec.domPath = String(flags.dompath);
  if (flags.container !== undefined) {
    try { spec.container = JSON.parse(String(flags.container)); }
    catch (e) { die(`--container JSON 解析失败：${e.message}`); }
    if (!validContainer(spec.container)) die('--container 形态非法：须为 {text,match?}|{role}|{domPath} 恰居其一');
  }
  if (spec.text !== undefined && spec.text.trim() === '') die('--text 不能为空');
  if (spec.match !== undefined && !matchModeOK(spec.match)) die('--match 仅支持 exact|contains');
  const sourceOnly = flags['js-listeners'] === true || flags['cursor-pointer'] === true;
  if (spec.text === undefined && spec.role === undefined && spec.domPath === undefined && !sourceOnly) {
    die('locator 需要 text/role/domPath 至少一个锚点（--container 只是修饰符；--js-listeners/--cursor-pointer 可单独作为候选源）');
  }
  return spec;
}
function locatorTargetJSON(flags) {
  const raw = String(flags['target-json'] || '');
  if (!raw) die('verify 需要 --target-json \'{"text":"...","container":{...}}\'（flow target 描述符）');
  let t = null;
  try { t = JSON.parse(raw); } catch (e) { die(`--target-json JSON 解析失败：${e.message}`); }
  const { validTarget } = require('../lib/target-resolver');
  if (!validTarget(t)) die('--target-json 不是合法 flow target（需 text/role/near/grid/domPath/point 锚点之一；container 须合法）');
  if (t.text === undefined && t.role === undefined && t.domPath === undefined) {
    die('locator verify 仅支持 text/role/domPath 语义（near/grid/point 请用 flow 失败报告或截图确认）');
  }
  return t;
}
function locatorLine(c, i) {
  const id = c.id ? `#${c.id}` : '';
  const cls = c.cls ? `.${String(c.cls).trim().split(/\s+/).join('.')}` : '';
  /* C11 N12：仅新旗标候选带 source → 默认输出逐字节不变 */
  const source = c.source ? ` source=${c.source}` : '';
  return `#${i + 1} <${c.tag}>${id}${cls} "${String(c.text || '').slice(0, 40)}" rect=${JSON.stringify(c.rect)} frame=${c.frame}`
    + ` visible=${c.visible} offsetParentOk=${c.offsetParentOk} hitOk=${c.hitOk} area=${c.area}${source}`
    + `\n      cssPath=${c.cssPath || '（空）'}`;
}
async function cmdLocator(pos, flags) {
  const mode = pos[0];
  if (!['probe', 'suggest', 'verify', 'pick'].includes(mode)) { console.error(SUB_HELP.locator); return EXIT_ERR; }
  for (const [f, label] of [['js-listeners', '--js-listeners'], ['cursor-pointer', '--cursor-pointer']]) {
    if (flags[f] !== undefined && flags[f] !== true) die(`${label} 不接受值（无参开关）`);
    if (flags[f] === true && mode !== 'probe') die(`${label} 仅 locator probe 支持（候选扩展面）`);
  }
  const loc = require('../lib/locator');
  const { core, client } = await openClient(flags, 10000);
  try {
    const { target, sessionId } = await core.resolveTarget(client, flags.target);
    const page = { id: target.id, title: target.title || '', url: target.url || '' };
    const timeout = num(flags.timeout, 10000);
    const jsonOut = !!flags.json;

    if (mode === 'probe') {
      const spec = locatorSpecFromFlags(flags);
      const rep = await loc.collectCandidates(client, sessionId, spec, {
        timeoutMs: timeout,
        jsListeners: flags['js-listeners'] === true,
        cursorPointer: flags['cursor-pointer'] === true,
      });
      const u = loc.uniqueness(rep.candidates);
      const report = { mode: mode, ok: rep.ok, error: rep.error || null, page: page, spec: rep.spec || spec,
        container: rep.container || null, docs: rep.docs, truncated: !!rep.truncated, uniqueness: u,
        candidates: rep.candidates.map(loc.stripAncestors) };
      /* C11 N12：子报告仅在旗标开启时出现（默认 JSON 逐字节不变） */
      if (rep.jsListeners) report.jsListeners = rep.jsListeners;
      if (rep.cursorPointer) report.cursorPointer = rep.cursorPointer;
      if (jsonOut) return emitOk('locator', report); // B1b：data=旧 locator 报告（probe）
      console.log(`[locator probe] ${page.title}｜${page.url}`);
      console.log(`  spec=${JSON.stringify(rep.spec || spec)}${rep.container ? `  container=${JSON.stringify(rep.container)}` : ''}  文档数=${rep.docs}`);
      if (rep.error === 'container-not-found') {
        console.log(`  ✗ container 未找到（${JSON.stringify(rep.container)}）——收窄不回退全局；确认容器文本/domPath 当前可见`);
        return EXIT_OK;
      }
      if (rep.jsListeners) {
        if (!rep.jsListeners.supported) {
          console.error(`[locator probe] ⚠ --js-listeners 不可用（${rep.jsListeners.error || 'unknown'}${rep.jsListeners.code !== null && rep.jsListeners.code !== undefined ? `；code=${rep.jsListeners.code}` : ''}）——该浏览器不支持 click 监听扫描（能力闸降级），其余输出不变`);
        } else if (!rep.jsListeners.ok) {
          console.error(`[locator probe] ⚠ --js-listeners 部分失败（${rep.jsListeners.error || 'unknown'}）——基础候选不受影响`);
        } else {
          console.log(`  JS 监听：扫描 ${rep.jsListeners.scanned} 个直接 click 监听节点；新增候选 ${rep.jsListeners.added}，合并 ${rep.jsListeners.merged}${rep.jsListeners.errors ? `；读取失败 ${rep.jsListeners.errors}` : ''}（只覆盖直接监听，React 根委托元素级不可见）`);
        }
      }
      if (rep.cursorPointer) {
        if (!rep.cursorPointer.ok) console.error(`[locator probe] ⚠ --cursor-pointer 扫描失败（${rep.cursorPointer.error || 'unknown'}）——基础候选不受影响`);
        else console.log(`  cursor:pointer：新增候选 ${rep.cursorPointer.added}，合并 ${rep.cursorPointer.merged}${rep.cursorPointer.truncated ? '（达上限截断）' : ''}`);
      }
      console.log(`  候选 ${rep.candidates.length} 个${rep.truncated ? '（达上限截断）' : ''}；可点 ${u.clickable}（visible+hitOk 过 X1 闸门）`);
      rep.candidates.slice(0, 20).forEach((c, i) => console.log('  ' + locatorLine(c, i)));
      if (rep.candidates.length > 20) console.log(`  …另有 ${rep.candidates.length - 20} 个候选（--json 看全量）`);
      console.log(`  结论：${u.unique ? '唯一可点 ✓' : (u.clickable > 1 ? `多候选 ✗（${u.clickable} 个可点）——先用 locator suggest 递归收窄，不要盲试` : '零可点候选 ✗（可见性或 elementFromPoint 未过闸；先确认元素已展开/未被遮罩）')}`);
      return EXIT_OK;
    }

    if (mode === 'suggest') {
      const spec = locatorSpecFromFlags(flags);
      const rep = await loc.suggestNarrowing(client, sessionId, spec, { timeoutMs: timeout });
      const suggested = rep.ok && rep.container ? Object.assign({}, loc.targetFromSpec(spec), { container: rep.container }) : loc.targetFromSpec(spec);
      const report = { mode: mode, ok: rep.ok, reason: rep.reason || null, page: page, spec: spec,
        container: rep.container || null, remaining: rep.remaining, tried: rep.tried,
        suggestedTarget: suggested, notes: rep.note ? [rep.note] : [], candidates: (rep.candidates || []).map(loc.stripAncestors) };
      if (jsonOut) return rep.ok ? emitOk('locator', report) : emitFailWithData('locator', 'E_LOCATE', `locator suggest 未能收窄（${rep.reason || 'still-ambiguous'}）`, report);
      console.log(`[locator suggest] ${page.title}｜${page.url}`);
      console.log(`  spec=${JSON.stringify(spec)}  可点候选=${rep.remaining}`);
      for (const t of rep.tried) {
        console.log(`  level ${t.level} depth=${t.depth} ${t.unique ? '✓' : '✗'} count=${t.count} container=${JSON.stringify(t.container)}${t.error ? ` error=${t.error}` : ''}`);
      }
      if (rep.ok) {
        if (rep.container) console.log(`  ✓ 唯一收窄：${JSON.stringify(rep.container)}`);
        else console.log('  ✓ 基础描述符本就唯一，无需收窄');
        console.log(`  建议 target：${JSON.stringify(suggested)}`);
      } else {
        console.log(`  ✗ 未能收窄（${rep.reason || 'still-ambiguous'}）${rep.note ? '：' + rep.note : ''}`);
      }
      return rep.ok ? EXIT_OK : EXIT_ERR;
    }

    if (mode === 'verify') {
      const t = locatorTargetJSON(flags);
      const spec = { text: t.text, role: t.role, domPath: t.domPath, container: t.container };
      Object.keys(spec).forEach((k) => { if (spec[k] === undefined) delete spec[k]; });
      const rep = await loc.collectCandidates(client, sessionId, spec, { timeoutMs: timeout });
      const u = loc.uniqueness(rep.candidates);
      const ranked = loc.rankCandidates(rep.candidates, rep.spec || spec);
      const best = ranked[0] || null;
      if (!best) {
        const report = { mode: mode, ok: false, error: rep.error || 'no-candidate', page: page, target: t,
          container: rep.container || null, uniqueness: u, candidates: [] };
        if (jsonOut) return emitFailWithData('locator', 'E_LOCATE', `locator verify 无候选（error=${report.error}）`, report);
        console.log(`[locator verify] ${page.title}｜${page.url}`); console.log(`  ✗ 无候选（error=${report.error}；container=${JSON.stringify(rep.container || null)}；target=${JSON.stringify(t)}）`);
        return EXIT_ERR;
      }
      const hi = await loc.highlight(client, sessionId, best, {
        ms: num(flags.ms, 3000),
        screenshot: flags['no-screenshot'] ? false : true,
        out: flags.out,
        timeoutMs: timeout,
      });
      const report = { mode: mode, ok: hi.ok, page: page, target: t, uniqueness: u, chosen: loc.stripAncestors(best),
        highlight: hi, candidates: ranked.slice(0, 10).map(loc.stripAncestors) };
      if (jsonOut) return hi.ok ? emitOk('locator', report) : emitFailWithData('locator', 'E_LOCATE', `locator verify 高亮失败（${hi.via || '错误'}）`, report);
      console.log(`[locator verify] ${page.title}｜${page.url}`);
      console.log(`  target=${JSON.stringify(t)}  候选=${rep.candidates.length} 可点=${u.clickable}${u.unique ? '（唯一 ✓）' : '（⚠ 非唯一，高亮的是排序 best）'}`);
      console.log('  选中：' + locatorLine(best, 0).replace(/^#1 /, '').replace(/\n\s*/g, '\n  '));
      console.log(`  高亮：${hi.via || '失败'}${hi.ok ? ' ✓' : ' ✗'}（${hi.ms}ms 后还原）`);
      if (hi.screenshot) console.log(`  截图：${hi.screenshot}（读图确认高亮框是否落在目标上）`);
      else console.log(`  ⚠ 截图失败：${hi.screenshotError || '未知'}`);
      return hi.ok ? EXIT_OK : EXIT_ERR;
    }

    // pick
    const seconds = Math.min(Math.max(num(flags.seconds, 60), 1), 600);
    const script = loc.buildPickerScript({ block: flags['no-block'] ? false : true, autoTeardownMs: (seconds + 5) * 1000 });
    await core.evaluate(client, sessionId, script, timeout);
    console.error(`[locator pick] 拾取器已注入（超时 ${seconds}s；点击即拾取，${flags['no-block'] ? '不拦截' : '拦截'}业务动作）——请在浏览器中点击目标元素…`);
    let picked = null;
    let lastErr = null;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const raw = await core.evaluate(client, sessionId, 'JSON.stringify(window.__cu_pick_result || null)', 3000).catch((e) => { lastErr = e; return null; });
      if (raw) {
        try {
          const v = JSON.parse(raw);
          if (v && v.error) lastErr = new Error(v.error);
          else if (v && v.ts) picked = v;
        } catch (e) { lastErr = e; }
      }
      if (picked) break;
      await sleep(300);
    }
    await core.evaluate(client, sessionId, loc.buildPickerTeardownScript(), 2000).catch(() => {});
    await core.evaluate(client, sessionId, 'try{window.__cu_pick_result=null}catch(e){}', 2000).catch(() => {});
    if (!picked) {
      const report = { mode: mode, ok: false, reason: 'timeout', page: page, seconds: seconds, error: lastErr ? String(lastErr.message || lastErr) : null };
      if (jsonOut) return emitFailWithData('locator', 'E_TIMEOUT', `locator pick ${seconds}s 内未拾取到元素${lastErr ? `（最后错误：${lastErr.message || lastErr}）` : ''}`, report);
      console.error(`✗ [locator pick] ${seconds}s 内未拾取到元素${lastErr ? `（最后错误：${lastErr.message || lastErr}）` : ''}`);
      return EXIT_ERR;
    }
    let spec = null;
    if (String(picked.text || '').trim()) spec = { text: picked.text, match: 'exact' };
    else if (picked.role) spec = { role: picked.role };
    else if (picked.cssPath) spec = { domPath: picked.cssPath };
    let u = null;
    let rep = null;
    if (spec) {
      rep = await loc.collectCandidates(client, sessionId, spec, { timeoutMs: timeout });
      u = loc.uniqueness(rep.candidates);
    }
    const conv = loc.toTargetSpec(picked, { unique: !!(u && u.unique) });
    const report = { mode: mode, ok: true, page: page, picked: picked,
      descriptors: { text: picked.text, role: picked.role, cssPath: picked.cssPath, framePath: picked.framePath, rect: picked.rect },
      uniqueness: u, suggestedTarget: conv.target, notes: conv.notes,
      candidates: rep ? (rep.candidates || []).slice(0, 10).map(loc.stripAncestors) : [] };
    if (jsonOut) return emitOk('locator', report); // B1b：data=旧 locator 报告（pick）
    console.log(`[locator pick] ${page.title}｜${page.url}`);
    console.log(`  拾取：<${picked.tag}>${picked.id ? '#' + picked.id : ''} "${String(picked.text || '').slice(0, 60)}"`);
    console.log(`  rect=${JSON.stringify(picked.rect)} frame=${['main'].concat(picked.framePath || []).join('>')}`);
    console.log(`  三层描述符：text=${JSON.stringify(picked.text)}｜role=${JSON.stringify(picked.role)}｜domPath=${JSON.stringify(picked.cssPath)}`);
    console.log(`  唯一性复算：${u ? `${u.clickable} 个可点${u.unique ? '（唯一 ✓）' : '（⚠ 非唯一）'}` : '未复算（无可用锚点）'}`);
    if (conv.target) console.log(`  建议 target：${JSON.stringify(conv.target)}`);
    conv.notes.forEach((n) => console.log(`  ⚠ ${n}`));
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── 最小交互命令集（cdp 主通道战略一期，2026-10-31 用户裁定；实现单源 lib/drive.js） ──
 * click / click-at / type / key / hover / wait / console：全部走 Input/Runtime/Log 域真实事件
 * （isTrusted=true，红线一），定位复用 lib/locator（跨同源 iframe + X1 四层闸门）。
 * MCP uid 是快照期临时句柄，raw CDP 无法解析——--uid 显式拒绝并提示 --selector/--text。 */

/** 定位形态解析（click/hover 共用）：--text | --selector | --point x,y（或 --x N --y M）| --ref @eN 四选一 */
function interactSpecFromFlags(flags, verb) {
  if (flags.uid !== undefined) {
    die(`--uid 不可用：MCP uid 是 chrome-devtools-mcp 快照期的临时句柄，raw CDP 无法解析——改用 --selector <cssPath>（cdp.js locator 输出）或 --text <文本>`);
  }
  const forms = [];
  if (flags.text !== undefined) forms.push('text');
  if (flags.selector !== undefined) forms.push('selector');
  if (flags.point !== undefined || flags['x,y'] !== undefined || flags.x !== undefined || flags.y !== undefined) forms.push('point');
  if (flags.ref !== undefined) forms.push('ref');
  if (forms.length !== 1) {
    die(`${verb} 需要且仅需一种定位：--text <文本>｜--selector <cssPath>｜--point "x,y"（或 --x,y "x,y" / --x N --y M）｜--ref @eN（a11y --ref 产出）；实际 ${forms.length ? forms.join('+') : '无'}`);
  }
  if (flags.match !== undefined && !['exact', 'contains'].includes(String(flags.match))) {
    die(`--match 仅支持 exact|contains（收到 ${JSON.stringify(flags.match)}）`);
  }
  if (forms[0] === 'point') {
    let point;
    if (flags.point !== undefined || flags['x,y'] !== undefined) {
      const raw = flags.point !== undefined ? flags.point : flags['x,y'];
      if (typeof raw !== 'string') die('--point 缺值（形态 "x,y"）');
      point = (() => { try { return drive.parsePoint(raw); } catch (e) { die(e.message); } })();
    } else {
      if (flags.x === undefined || flags.y === undefined) die('坐标需成对：--x N --y M（或 --point "x,y"）');
      point = (() => { try { return drive.parsePoint(`${flags.x},${flags.y}`); } catch (e) { die(e.message); } })();
    }
    return { kind: 'point', point };
  }
  if (forms[0] === 'text') {
    if (typeof flags.text !== 'string' || !flags.text) die('--text 缺值（要匹配的可见文本）');
    const spec = { text: flags.text };
    if (flags.match !== undefined) spec.match = String(flags.match);
    return { kind: 'text', spec, label: `文本「${flags.text}」` };
  }
  if (forms[0] === 'ref') {
    /* B5：@eN 引用（与 --nth/--match 互斥——ref 已是唯一身份，再给选择器语义只会误导） */
    if (flags.nth !== undefined) die('--nth 仅与 --text/--selector 同用（--ref 已是唯一句柄）');
    if (flags.match !== undefined) die('--match 仅与 --text 同用（--ref 已是唯一句柄）');
    const token = (() => { try { return refs.normalizeRefToken(flags.ref); } catch (e) { die(e.message); } })();
    return { kind: 'ref', ref: token, label: `引用 ${token.token}` };
  }
  if (typeof flags.selector !== 'string' || !flags.selector) die('--selector 缺值（CSS 选择器）');
  return { kind: 'selector', spec: { domPath: flags.selector }, label: `选择器 ${flags.selector}` };
}

/** @eN 解析失败的统一出口（不猜：失效/歧义/不可交互分别落 E_REF_STALE/E_AMBIGUOUS/E_LOCATE）。
 *  B5：文本模式打印可行动原因 + 候选清单（复用定位失败的排版习惯），--json 走失败信封 data。 */
function printRefFailure(verb, tokenText, rr) {
  const msg = rr.message || `引用 ${tokenText || '@e?'} 解析失败（${rr.reason || 'unknown'}）`;
  console.error(`✗ [${verb}] ${msg}`);
  if (Array.isArray(rr.candidates) && rr.candidates.length) {
    rr.candidates.slice(0, 8).forEach((c, i) => {
      console.error(`   [${i}] <${c.tag || '?'}> "${String(c.text || '').slice(0, 40)}" rect=${JSON.stringify(c.rect)} level=${c.level || '?'} visible=${c.visible}`);
    });
  }
  const data = {
    ref: tokenText || null,
    reason: rr.reason || 'resolve-failed',
    level: rr.level || null,
    count: rr.count === undefined ? null : rr.count,
    candidates: (rr.candidates || []).slice(0, 10),
    refTable: rr.tablePath || null,
  };
  noteFail(rr.code || 'E_REF_STALE', `[${verb}] ${msg}`, { data });
}

function nthFromFlags(flags, key) {
  const k = key || 'nth';
  if (flags[k] === undefined) return undefined;
  if (typeof flags[k] === 'boolean') die(`--${k} 缺值（须为非负整数，0 基）`);
  const n = Number(flags[k]);
  if (!Number.isInteger(n) || n < 0) die(`--${k} 须为非负整数（0 基；收到 ${JSON.stringify(flags[k])}）`);
  return n;
}

/** 定位失败细分码（B4/R2 #103，纯函数）：
 *  E_AMBIGUOUS=多命中不猜｜E_NOT_FOUND=零命中（含 container 未找到）｜
 *  E_HIT_BLOCKED=可见候选被 X1 L4 命中测试挡住｜E_LOCATE=定位链其他失败（视口外/nth 越界/坏选择器等）。
 *  口径见 references/mechanisms.md §2/§12。 */
function locateFailureCode(res) {
  const r = res || {};
  const cands = Array.isArray(r.candidates) ? r.candidates : [];
  if (r.reason === 'ambiguous') return 'E_AMBIGUOUS';
  if (r.reason === 'container-not-found') return 'E_NOT_FOUND';
  if (r.reason === 'no-clickable') {
    if (!cands.length) return 'E_NOT_FOUND';
    if (cands.some((c) => c && c.visible === true && c.hitOk !== true)) return 'E_HIT_BLOCKED';
  }
  return 'E_LOCATE';
}

/** 细分码可行动下一步（B4/R2 #103；stderr 与信封 hint 同源） */
const LOCATE_HINTS = {
  E_NOT_FOUND: '零命中处置：① screenshot 看当前画面（元素可能未渲染/在未展开区域）② locator probe 核对候选与选择器 ③ 换锚点（role/domPath/更短文本）再试',
  E_AMBIGUOUS: '多命中处置：① --nth N 显式选择（0 基，仅数可点候选）② locator suggest 递归收窄 container ③ 用 exact 匹配/更精确父容器限定',
  E_HIT_BLOCKED: '命中被挡处置：① click-at 坐标兜底（按 evidence.point；先确认遮挡元素是否浮层）② locator probe/suggest 收窄到未被遮挡的元素 ③ 先关弹窗/遮罩层（已给 evidence.inFixedLayer/z-index）后重试',
};

/** C9 诊断易用性（V20261113001）：定位失败族的「结论 + nextStep（按优先级）」结构。
 *  与 LOCATE_HINTS 同义重排（旧 hint 行保留=向后兼容，只增不改）；nextStep 同步进失败信封。 */
const LOCATE_DIAGNOSES = {
  E_NOT_FOUND: {
    conclusion: '零命中——目标不在当前可定位范围，未执行写操作（页面状态未变）',
    nextStep: [
      'screenshot 看当前画面（元素可能未渲染/在未展开区域/已随状态消失）',
      'locator probe 核对候选与选择器（--js-listeners/--cursor-pointer 可扩候选源）',
      '换锚点（role/domPath/更短文本/container 收窄）后重试',
    ],
  },
  E_AMBIGUOUS: {
    conclusion: '多候选不猜——按红线未执行写操作（页面状态未变）',
    nextStep: [
      '--nth N 显式选择（0 基，仅数可点候选）',
      'locator suggest 递归收窄 container（或手写 container 三形态）',
      '用 exact 匹配/更精确父容器限定后重试',
    ],
  },
  E_HIT_BLOCKED: {
    conclusion: '命中被遮挡——候选存在但中心点被其他元素接管，未执行写操作',
    nextStep: [
      '按 evidence 先处理遮挡（关弹窗/遮罩/等浮层消失）',
      'click-at 坐标兜底（按 evidence.point；先确认遮挡元素是否可点目标）',
      'locator probe/suggest 收窄到未被遮挡元素',
    ],
  },
  E_LOCATE: {
    conclusion: '定位链失败（视口/参数/选择器类）——未执行写操作',
    nextStep: [
      '读上方失败原因行按提示修正（视口外先滚动/关遮罩；nth 越界核对候选数；坏选择器换锚点）',
      'screenshot 确认页面状态 + locator probe 核对候选',
      '修正后重试；连续 3 次不同策略未果按 D1 熔断止损',
    ],
  },
};

/** 定位失败/歧义的统一输出（不猜：多候选必须显式 --nth 或收窄）。
 *  B1a：文本打印逐字节不变（body），另记失败事实 code=E_LOCATE。
 *  B4/R2 #103：细分码 E_AMBIGUOUS/E_NOT_FOUND/E_HIT_BLOCKED；E_HIT_BLOCKED 附只读 evidence
 *  （elementFromPoint 结果+三层祖先+fixed 浮层判定）。ctx={client,sessionId} 仅供取证，失败 fail-soft。 */
async function printLocateFailure(verb, label, res, ctx) {
  const code = locateFailureCode(res);
  printLocateFailureBody(verb, label, res, code);
  const cands = (res.candidates || []);
  const data = {
    reason: res.reason || 'locate-failed', label,
    clickable: res.clickable === undefined ? null : res.clickable,
    total: res.total === undefined ? cands.length : res.total,
    candidates: cands.slice(0, 10).map((c) => ({
      tag: c.tag || null, text: String(c.text || '').slice(0, 200), rect: c.rect || null,
      frame: c.frame || 'main', visible: c.visible === undefined ? null : c.visible, hitOk: c.hitOk === undefined ? null : c.hitOk,
      disabled: c.disabled === true, readOnly: c.readOnly === true,
      ariaDisabled: c.ariaDisabled === true, cursorNotAllowed: c.cursorNotAllowed === true,
      interactability: c.interactability || locator.interactabilityVerdict(c),
      cssPath: c.cssPath || null,
    })),
    point: res.point || null, viewport: res.viewport || null, scrolled: res.scrolled || null,
  };
  let evidence;
  if (code === 'E_HIT_BLOCKED') {
    const blocked = cands.find((c) => c && c.visible === true && c.hitOk !== true);
    if (ctx && ctx.client && blocked) {
      const probe = await locator.collectHitBlockedEvidence(ctx.client, ctx.sessionId, blocked, { timeoutMs: 3000 });
      if (probe.ok) { evidence = probe.evidence; data.hitBlocked = probe.evidence; }
      else data.hitBlocked = { ok: false, error: probe.error || 'probe-failed' };
    } else {
      data.hitBlocked = { ok: false, error: ctx && ctx.client ? 'no-visible-candidate' : 'no-client' };
    }
    if (evidence) printHitBlockedEvidence(evidence);
  }
  let message;
  if (code === 'E_AMBIGUOUS') message = `[${verb}] ${label} 多候选不猜（${res.clickable} 个可点；reason=${res.reason}）`;
  else if (code === 'E_NOT_FOUND') message = `[${verb}] ${label} 定位零命中（${res.reason}${res.error ? '：' + res.error : ''}）`;
  else if (code === 'E_HIT_BLOCKED') message = `[${verb}] ${label} 命中被遮挡（X1 L4 elementFromPoint 未命中；${data.hitBlocked && data.hitBlocked.hit ? '遮挡元素 <' + data.hitBlocked.hit.tag + '>' : '证据采集失败'}）`;
  else message = `[${verb}] ${label} 定位失败（${res.reason}${res.error ? '：' + res.error : ''}）`;
  const hint = LOCATE_HINTS[code];
  if (hint) console.error('   ' + hint);
  /* C9：结构化结论行 + nextStep 动作行（按优先级；与失败信封 data 同源） */
  const diag = LOCATE_DIAGNOSES[code] || LOCATE_DIAGNOSES.E_LOCATE;
  data.conclusion = diag.conclusion;
  data.nextStep = diag.nextStep;
  console.error(`   结论：${diag.conclusion}`);
  console.error(`   nextStep：${fmtNextStep(diag.nextStep)}`);
  const extra = { data, conclusion: diag.conclusion, nextStep: diag.nextStep };
  if (hint) extra.hint = hint;
  if (evidence) extra.evidence = evidence;
  noteFail(code, message, extra);
}

/** E_HIT_BLOCKED 人类可读取证行（stderr；--json 下 stdout 仍单文档） */
function printHitBlockedEvidence(ev) {
  const hit = ev.hit || null;
  const target = ev.target || {};
  const tcls = String(target.cls || '').trim().split(/\s+/)[0];
  console.error(`   候选 <${target.tag}${tcls ? '.' + tcls : ''}> rect=${JSON.stringify(target.rect)} 中心=(${ev.point.x},${ev.point.y})`);
  if (!hit) { console.error('   候选中心点 elementFromPoint 返回 null（页面空白/元素已移出/被滚动带走）'); return; }
  const cls = String(hit.cls || '').trim().split(/\s+/)[0];
  console.error(`   遮挡元素 <${hit.tag}${hit.id ? '#' + hit.id : ''}${cls ? '.' + cls : ''}> rect=${JSON.stringify(hit.rect)} z-index=${hit.zIndex || 'auto'} position=${hit.position || '?'}${ev.inFixedLayer ? '（fixed/sticky 浮层内）' : ''}`);
  console.error(`   候选三层祖先：${(ev.ancestors || []).map((a) => `<${a.tag}${a.id ? '#' + a.id : ''}${a.zIndex && a.zIndex !== 'auto' ? ' z=' + a.zIndex : ''}>`).join(' < ')}`);
}

function printLocateFailureBody(verb, label, res, code) {
  const disabledNote = () => {
    const blocked = (res.candidates || []).filter((c) => c && c.interactability);
    if (!blocked.length) return;
    console.error(`   判读：${blocked[0].interactability}${blocked.length > 1 ? `（共 ${blocked.length} 个候选命中该判读）` : ''}`);
  };
  if (res.reason === 'ambiguous') {
    console.error(`✗ [${verb}] ${label} 有 ${res.clickable} 个可点候选——不猜，用 --nth N 指定或收窄 --text/--selector：`);
    (res.candidates || []).slice(0, 10).forEach((c, i) => {
      console.error(`   [${i}] <${c.tag}> "${String(c.text || '').slice(0, 40)}" rect=${JSON.stringify(c.rect)} frame=${c.frame || ''}${c.interactability ? ' [禁用/只读]' : ''}`);
    });
    disabledNote();
    return;
  }
  if (res.reason === 'nth-out-of-range') {
    console.error(`✗ [${verb}] --nth 越界（可点候选 ${res.clickable} 个，nth=${res.nth}）`);
    return;
  }
  if (res.reason === 'out-of-viewport') {
    const p = res.point || {};
    const vp = res.viewport || {};
    const scrollNote = res.scrolled ? (res.scrolled.scrolled ? '已 scrollIntoView 一次' : `scrollIntoView 失败（${res.scrolled.error}）`) : '未自动滚动（--no-scroll）';
    console.error(`✗ [${verb}] ${label} 候选中心点 (${p.x},${p.y}) 在顶层视口外（innerWidth×innerHeight=${vp.width}×${vp.height}）——${scrollNote}；不盲点视口外坐标（会静默无效果=假绿），先滚动页面/关遮罩后重试`);
    return;
  }
  if (res.reason === 'no-clickable') {
    if (!(res.candidates || []).length) {
      console.error(`✗ [${verb}] ${label} 定位零命中（候选 0 个：确认文本/选择器与页面当前状态）`);
      return;
    }
    console.error(`✗ [${verb}] ${label} 无可点候选（共 ${res.candidates.length} 个，均未过 X1 闸门：visible/offsetParent/elementFromPoint）`);
    (res.candidates || []).slice(0, 8).forEach((c, i) => {
      const flags = [];
      if (c.disabled) flags.push('disabled');
      if (c.readOnly) flags.push('readOnly');
      if (c.ariaDisabled) flags.push('aria-disabled');
      if (c.cursorNotAllowed) flags.push('cursor:not-allowed');
      console.error(`   [${i}] <${c.tag}> "${String(c.text || '').slice(0, 40)}" visible=${c.visible} hitOk=${c.hitOk} rect=${JSON.stringify(c.rect)}${flags.length ? ' ' + flags.join(',') : ''}`);
    });
    disabledNote();
    if (code !== 'E_HIT_BLOCKED') console.error('   提示：元素可能在视口外（已默认尝试 scrollIntoView 一次）或未展开/被遮罩——先 locator probe/截图确认');
    return;
  }
  console.error(`✗ [${verb}] ${label} 定位失败（${res.reason}${res.error ? '：' + res.error : ''}）`);
}

async function cmdClick(flags) {
  const loc = interactSpecFromFlags(flags, 'click');
  const nth = nthFromFlags(flags);
  const double = !!(flags.dbl || flags.double);
  const effCfg = parseEffectConfig(flags);
  const { core, client, url } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const pageInfo = { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') };
    if (loc.kind === 'point') {
      const r = await drive.clickPoint(client, sessionId, loc.point, { double, timeoutMs: num(flags.timeout, 5000) });
      info(`[click] ✓ ${double ? '双击' : '单击'}坐标 ${r.x},${r.y} @ ${(target.title || target.url).slice(0, 50)}${r.double ? '（clickCount 1→2，60ms 间隔）' : ''}`);
      const data = { target: pageInfo, via: 'point', point: { x: r.x, y: r.y }, double: !!r.double, clicks: r.clicks };
      const eff = await settleFor(client, sessionId, effCfg, null);
      if (eff) printEffectPhase('click', eff);
      if (eff && eff.phase === 'stalled') return stalledExit('click', eff, withEffect(data, eff));
      if (jsonMode) return emitOk('click', withEffect(data, eff));
      return EXIT_OK;
    }
    if (loc.kind === 'ref') {
      /* B5：引用句柄消费——三级解析链 + 失效契约（重解析有界：视口外最多滚动重试一次），失败按码落信封 */
      const rr = await refs.resolveRef(client, sessionId, target, loc.ref, { timeoutMs: num(flags.timeout, 10000) });
      if (!rr.ok) { printRefFailure('click', loc.ref.token, rr); return EXIT_ERR; }
      const r = await drive.clickPoint(client, sessionId, rr.point, { double, timeoutMs: num(flags.timeout, 5000) });
      const c = rr.candidate || {};
      const levelNote = rr.level === 'cssPath'
        ? (rr.verified ? 'cssPath·身份确认' : 'cssPath')
        : `${rr.level}·重解析${rr.verified ? '·身份确认' : '（name 重识别）'}`;
      info(`[click] ✓ ${double ? '双击' : '单击'} ${loc.ref.token}「${String(c.text || '').slice(0, 40)}」<${c.tag || '?'}> @ ${r.x},${r.y}（${levelNote}${rr.scrolled ? '，已自动滚入视口' : ''}）@ ${(target.title || target.url).slice(0, 50)}`);
      const data = {
        target: pageInfo, via: 'ref', ref: loc.ref.token, refLevel: rr.level, refVerified: rr.verified === true,
        spec: null, label: loc.label,
        element: { tag: c.tag || null, text: String(c.text || '').slice(0, 200), frame: c.frame || 'main', cssPath: rr.cssPath || null, rect: c.rect || null },
        point: { x: r.x, y: r.y }, clickable: 1, scrolled: !!rr.scrolled, double: !!r.double, clicks: r.clicks,
      };
      const eff = await settleFor(client, sessionId, effCfg, rr.level === 'cssPath' ? c : null);
      if (eff) printEffectPhase('click', eff);
      if (eff && eff.phase === 'stalled') return stalledExit('click', eff, withEffect(data, eff));
      if (jsonMode) return emitOk('click', withEffect(data, eff));
      return EXIT_OK;
    }
    const res = await drive.locate(client, sessionId, loc.spec, { nth, autoScroll: !flags['no-scroll'], timeoutMs: num(flags.timeout, 10000) });
    if (!res.ok) { await printLocateFailure('click', loc.label, res, { client, sessionId }); return EXIT_ERR; }
    const p = res.point || drive.candidatePoint(res.candidate);
    const r = await drive.clickPoint(client, sessionId, p, { double, timeoutMs: num(flags.timeout, 5000) });
    const c = res.candidate;
    info(`[click] ✓ ${double ? '双击' : '单击'}「${String(c.text || '').slice(0, 40)}」<${c.tag}> @ ${r.x},${r.y}（可点候选 ${res.clickable} 个，frame ${c.frame || 'main'}${res.scrolled ? '，已自动滚入视口' : ''}）@ ${(target.title || target.url).slice(0, 50)}`);
    const data = {
      target: pageInfo, via: 'locate', spec: loc.spec, label: loc.label,
      element: { tag: c.tag, text: String(c.text || '').slice(0, 200), frame: c.frame || 'main', cssPath: c.cssPath || null, rect: c.rect || null },
      point: { x: r.x, y: r.y }, clickable: res.clickable, scrolled: !!res.scrolled, double: !!r.double, clicks: r.clicks,
    };
    const eff = await settleFor(client, sessionId, effCfg, c);
    if (eff) printEffectPhase('click', eff);
    if (eff && eff.phase === 'stalled') return stalledExit('click', eff, withEffect(data, eff));
    if (jsonMode) return emitOk('click', withEffect(data, eff));
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdClickAt(pos, flags) {
  const raw = pos[0] !== undefined ? pos[0] : flags.point;
  if (raw === undefined) die(SUB_HELP['click-at']);
  let point;
  try { point = drive.parsePoint(raw); } catch (e) { die(e.message); }
  const double = !!(flags.dbl || flags.double);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await drive.clickPoint(client, sessionId, point, { double, timeoutMs: num(flags.timeout, 5000) });
    console.log(`[click-at] ✓ ${double ? '双击' : '单击'}坐标 ${r.x},${r.y} @ ${(target.title || target.url).slice(0, 50)}`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdType(pos, flags) {
  if (flags.uid !== undefined) die('--uid 不可用（MCP 快照临时句柄）——改用 --into-selector/--into-text/--into-point');
  const value = flags.text !== undefined ? flags.text : pos[0];
  if (typeof value !== 'string') die('type 需要 --text <值>（或位置参数 <值>）');
  if (flags['echo-text'] !== undefined && flags['echo-text'] !== true) die('--echo-text 不接受值（无参开关：显式回显输入值，回显仍过脱敏）');
  const echoText = flags['echo-text'] === true;
  // B6b N7：占位符输入——真值只进 CDP insertText；stdout/JSON data 只出现 <placeholder:KEY>
  const ph = redact.resolvePlaceholder(value);
  const typedValue = ph.hit ? ph.value : value;
  if (ph.warning) console.error(`[type] ⚠ ${ph.warning}`);
  if (flags.ref !== undefined && flags['into-ref'] !== undefined) die('--ref 与 --into-ref 是同一开关的两种写法，二选一');
  const intoRefRaw = flags.ref !== undefined ? flags.ref : flags['into-ref'];
  const into = [];
  if (flags['into-text'] !== undefined) into.push('text');
  if (flags['into-selector'] !== undefined) into.push('selector');
  if (flags['into-point'] !== undefined || flags['into-x'] !== undefined || flags['into-y'] !== undefined) into.push('point');
  if (intoRefRaw !== undefined) into.push('ref');
  if (into.length > 1) die(`type 目标定位至多一种：--into-text｜--into-selector｜--into-point｜--ref @eN；实际 ${into.join('+')}`);
  let targetSpec = null, targetPoint = null, targetRef = null, label = '当前焦点';
  if (into[0] === 'text') {
    if (typeof flags['into-text'] !== 'string' || !flags['into-text']) die('--into-text 缺值');
    targetSpec = { text: flags['into-text'] };
    if (flags.match !== undefined) targetSpec.match = String(flags.match);
    label = `文本「${flags['into-text']}」`;
  } else if (into[0] === 'selector') {
    if (typeof flags['into-selector'] !== 'string' || !flags['into-selector']) die('--into-selector 缺值');
    targetSpec = { domPath: flags['into-selector'] };
    label = `选择器 ${flags['into-selector']}`;
  } else if (into[0] === 'point') {
    const raw = flags['into-point'] !== undefined ? flags['into-point'] : `${flags['into-x']},${flags['into-y']}`;
    try { targetPoint = drive.parsePoint(raw); } catch (e) { die(e.message); }
    label = `坐标 ${targetPoint.x},${targetPoint.y}`;
  } else if (into[0] === 'ref') {
    try { targetRef = refs.normalizeRefToken(intoRefRaw); } catch (e) { die(e.message); }
    label = `引用 ${targetRef.token}`;
  }
  const nth = nthFromFlags(flags);
  const append = !!flags.append;
  const effCfg = parseEffectConfig(flags);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    let clicked = null;
    let subjectCand = null;
    let refLevel = null;
    if (targetRef) {
      /* B5：--ref 聚焦（三级解析链 + 失效契约；与 --into-* 同语义：先真实点击聚焦） */
      const rr = await refs.resolveRef(client, sessionId, target, targetRef, { timeoutMs: num(flags.timeout, 10000) });
      if (!rr.ok) { printRefFailure('type', targetRef.token, rr); return EXIT_ERR; }
      refLevel = rr.level;
      subjectCand = rr.level === 'cssPath' ? rr.candidate : null;
      clicked = await drive.clickPoint(client, sessionId, rr.point, { timeoutMs: num(flags.timeout, 5000) });
    } else if (targetSpec) {
      const res = await drive.locate(client, sessionId, targetSpec, { nth, autoScroll: !flags['no-scroll'], timeoutMs: num(flags.timeout, 10000) });
      if (!res.ok) { await printLocateFailure('type', label, res, { client, sessionId }); return EXIT_ERR; }
      subjectCand = res.candidate;
      const p = res.point || drive.candidatePoint(res.candidate);
      clicked = await drive.clickPoint(client, sessionId, p, { timeoutMs: num(flags.timeout, 5000) });
    } else if (targetPoint) {
      clicked = await drive.clickPoint(client, sessionId, targetPoint, { timeoutMs: num(flags.timeout, 5000) });
      label = `坐标 ${clicked.x},${clicked.y}`;
    }
    if (clicked) await sleep(180); // 焦点落定（蓝本 180ms；输入法/受控组件需要一拍）
    const r = await drive.typeText(client, sessionId, typedValue, { append, timeoutMs: num(flags.timeout, 5000) });
    /* B6b N7：默认只回显长度/字符数（原默认打印输入值=现存泄漏路径）；--echo-text 才显式回显（仍过 redact）。
     * 占位符模式恒只显示 <placeholder:KEY>（真值永不进 stdout/JSON）。 */
    const safeLabel = redact.text(label);
    const len = r.value.length;
    let inputDesc;
    if (ph.hit) inputDesc = `「<placeholder:${ph.key}>」`;
    else if (echoText) inputDesc = `「${redact.text(len > 80 ? r.value.slice(0, 80) + '…' : r.value)}」`;
    else inputDesc = ` ${len} 字符`;
    info(`[type] ✓ 输入${inputDesc}（${append ? '续写' : '清空覆盖：Ctrl+A+Delete'}）→ ${clicked ? safeLabel : '当前焦点'} @ ${(target.title || target.url).slice(0, 50)}`);
    if (!r.active || r.active.editable !== true) {
      console.error(`[type] ⚠ 发送后焦点不在可编辑元素（${r.active ? `<${r.active.tag}>${r.active.crossFrame ? ' 跨域 iframe' : ''}` : '读不到 activeElement'}）——按键已发但可能未落入输入框，先截图/读值确认`);
    } else if (ph.hit) {
      info(`[type] 实测焦点 <${r.active.tag}> 值「<placeholder:${ph.key}>」`);
    } else if (echoText) {
      const av = r.active.value.length > 80 ? r.active.value.slice(0, 80) + '…' : r.active.value;
      info(`[type] 实测焦点 <${r.active.tag}> 值「${redact.text(av)}」`);
    } else {
      info(`[type] 实测焦点 <${r.active.tag}>（值 ${r.active.value.length} 字符，默认不回显；--echo-text 显式回显）`);
    }
    const activeOut = r.active ? (() => {
      const av = typeof r.active.value === 'string' ? r.active.value : '';
      const copy = Object.assign({}, r.active);
      copy.value = (!ph.hit && echoText && av) ? redact.text(av) : null;
      copy.valueChars = av.length;
      copy.valueEcho = !!(echoText && !ph.hit);
      return copy;
    })() : null;
    const data = {
      target: { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') },
      into: safeLabel, append, cleared: !!r.cleared,
      value: (!ph.hit && echoText) ? redact.text(r.value) : null,
      valueChars: r.value.length, valueEcho: !!(echoText && !ph.hit),
      active: activeOut, clicked: clicked ? { x: clicked.x, y: clicked.y } : null,
      focusEditable: !!(r.active && r.active.editable === true),
    };
    if (ph.hit) data.placeholder = ph.key;
    if (targetRef) { data.ref = targetRef.token; data.refLevel = refLevel; }
    const eff = await settleFor(client, sessionId, effCfg, subjectCand);
    if (eff) printEffectPhase('type', eff);
    if (eff && eff.phase === 'stalled') return stalledExit('type', eff, withEffect(data, eff));
    if (jsonMode) return emitOk('type', withEffect(data, eff));
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdKey(pos, flags) {
  const name = pos[0] !== undefined ? pos[0] : flags.key;
  if (typeof name !== 'string' || !name) die(SUB_HELP.key);
  try { drive.keyPlan(name); } catch (e) { die(e.message); }
  if (typeof flags.times === 'boolean') die('--times 缺值（须为 1~100 的整数）');
  const times = flags.times === undefined ? 1 : Number(flags.times);
  if (!Number.isInteger(times) || times < 1 || times > 100) die(`--times 须为 1~100 的整数（收到 ${JSON.stringify(flags.times)}）`);
  const effCfg = parseEffectConfig(flags);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await drive.pressKey(client, sessionId, name, { times, timeoutMs: num(flags.timeout, 5000) });
    console.log(`[key] ✓ 按键 ${r.key}${times > 1 ? ` × ${times}` : ''} @ ${(target.title || target.url).slice(0, 50)}`);
    const data = { target: { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') }, key: r.key, times };
    const eff = await settleFor(client, sessionId, effCfg, null); // 主体=document.activeElement（按键无定位候选）
    if (eff) printEffectPhase('key', eff);
    if (eff && eff.phase === 'stalled') return stalledExit('key', eff, withEffect(data, eff));
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdHover(flags) {
  const loc = interactSpecFromFlags(flags, 'hover');
  const nth = nthFromFlags(flags);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    if (loc.kind === 'point') {
      const r = await drive.hoverPoint(client, sessionId, loc.point, { timeoutMs: num(flags.timeout, 5000) });
      console.log(`[hover] ✓ 坐标 ${r.x},${r.y} @ ${(target.title || target.url).slice(0, 50)}`);
      return EXIT_OK;
    }
    if (loc.kind === 'ref') {
      /* B5：引用句柄悬停（语义同 click：解析链 + 失效契约） */
      const rr = await refs.resolveRef(client, sessionId, target, loc.ref, { timeoutMs: num(flags.timeout, 10000) });
      if (!rr.ok) { printRefFailure('hover', loc.ref.token, rr); return EXIT_ERR; }
      const r = await drive.hoverPoint(client, sessionId, rr.point, { timeoutMs: num(flags.timeout, 5000) });
      const c = rr.candidate || {};
      console.log(`[hover] ✓ 悬停 ${loc.ref.token}「${String(c.text || '').slice(0, 40)}」<${c.tag || '?'}> @ ${r.x},${r.y}（${rr.level}${rr.verified ? '·身份确认' : ''}${rr.scrolled ? '，已自动滚入视口' : ''}）`);
      return EXIT_OK;
    }
    const res = await drive.locate(client, sessionId, loc.spec, { nth, autoScroll: !flags['no-scroll'], timeoutMs: num(flags.timeout, 10000) });
    if (!res.ok) { await printLocateFailure('hover', loc.label, res, { client, sessionId }); return EXIT_ERR; }
    const p = res.point || drive.candidatePoint(res.candidate);
    const r = await drive.hoverPoint(client, sessionId, p, { timeoutMs: num(flags.timeout, 5000) });
    console.log(`[hover] ✓ 悬停「${String(res.candidate.text || '').slice(0, 40)}」<${res.candidate.tag}> @ ${r.x},${r.y}（frame ${res.candidate.frame || 'main'}${res.scrolled ? '，已自动滚入视口' : ''}）`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdWait(flags) {
  const hasText = flags.text !== undefined;
  const hasExpr = flags.expr !== undefined;
  if (!hasText && !hasExpr) die(SUB_HELP.wait);
  if (hasText && hasExpr) die('--text 与 --expr 互斥（wait 二选一：等文本出现｜等 JS 表达式为真）');
  if (hasText && (typeof flags.text !== 'string' || !flags.text)) die(SUB_HELP.wait);
  if (hasExpr) {
    if (typeof flags.expr !== 'string' || !flags.expr.trim()) die('--expr 缺值（JS 表达式，如 document.querySelectorAll("canvas").length>=1；应为只读幂等表达式）');
    if (flags.match !== undefined) die('--match 仅与 --text 连用（--expr 走 JS truthy 判定）');
  }
  let opt;
  if (typeof flags.interval === 'boolean' || typeof flags.timeout === 'boolean') die('--interval / --timeout 缺值（wait 的 --timeout = 总等待预算，毫秒数）');
  try { opt = drive.normalizeWaitOptions({ intervalMs: flags.interval, timeoutMs: flags.timeout === undefined ? undefined : flags.timeout }); }
  catch (e) { die(e.message); }
  if (!hasExpr && flags.match !== undefined && !['exact', 'contains'].includes(String(flags.match))) die(`--match 仅支持 exact|contains（收到 ${JSON.stringify(flags.match)}）`);
  const spec = { text: flags.text };
  if (flags.match !== undefined) spec.match = String(flags.match);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const pageInfo = { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') };
    if (hasExpr) {
      /* --expr（V20261112001 §17 附节）：轮询 Runtime.evaluate truthy；异常记 lastError 继续轮询（对齐 waitForText），
       * 主 frame 执行不跨 iframe；wait 不在 --insecure 四命令面（只读 evaluate 零证书校验触发）。 */
      console.error(`[wait] 轮询表达式为真最多 ${opt.timeoutMs}ms（节距 ${opt.intervalMs}ms；主 frame）@ ${(target.title || target.url).slice(0, 50)}…`);
      const r = await drive.waitForExpr(client, sessionId, flags.expr, { intervalMs: opt.intervalMs, timeoutMs: opt.timeoutMs });
      const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 80);
      if (!r.ok) {
        const failMsg = `[wait] ${r.waitedMs}ms 内表达式未为真（轮询 ${r.polls} 次${r.error ? `；最后错误 ${r.error}` : ''}）`;
        console.error(`✗ ${failMsg}`);
        noteFail('E_TIMEOUT', failMsg, { data: { found: false, expr: flags.expr, waitedMs: r.waitedMs, polls: r.polls, value: r.value === undefined ? null : fmt(r.value), error: r.error || null } });
        return EXIT_ERR;
      }
      info(`[wait] ✓ 表达式为真（等待 ${r.waitedMs}ms，轮询 ${r.polls} 次，值=${fmt(r.value)}）`);
      if (jsonMode) return emitOk('wait', { found: true, expr: flags.expr, waitedMs: r.waitedMs, polls: r.polls, value: r.value === undefined ? null : fmt(r.value), target: pageInfo });
      return EXIT_OK;
    }
    console.error(`[wait] 轮询「${flags.text}」最多 ${opt.timeoutMs}ms（节距 ${opt.intervalMs}ms；跨同源 iframe）@ ${(target.title || target.url).slice(0, 50)}…`);
    const r = await drive.waitForText(client, sessionId, spec.text, { intervalMs: opt.intervalMs, timeoutMs: opt.timeoutMs });
    if (!r.ok) {
      const failMsg = `[wait] ${r.waitedMs}ms 内未出现「${flags.text}」（轮询 ${r.polls} 次${r.error ? `；最后错误 ${r.error}` : ''}）`;
      console.error(`✗ ${failMsg}`);
      noteFail('E_TIMEOUT', failMsg, { data: { found: false, text: spec.text, match: spec.match || 'exact', waitedMs: r.waitedMs, polls: r.polls, error: r.error || null } }); // 出口③显式码（高频路径；其余 return EXIT_ERR 落 E_INTERNAL 兜底）
      return EXIT_ERR;
    }
    info(`[wait] ✓ 「${flags.text}」已出现（等待 ${r.waitedMs}ms，轮询 ${r.polls} 次，命中 ${r.matches} 个；首个 <${r.candidate.tag}> "${String(r.candidate.text || '').slice(0, 40)}" rect=${JSON.stringify(r.candidate.rect)}）`);
    if (jsonMode) return emitOk('wait', {
      found: true, text: spec.text, match: spec.match || 'exact', waitedMs: r.waitedMs, polls: r.polls, matches: r.matches,
      candidate: { tag: r.candidate.tag, text: String(r.candidate.text || '').slice(0, 200), rect: r.candidate.rect || null, frame: r.candidate.frame || 'main' },
      target: pageInfo,
    });
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdConsole(flags) {
  let opt;
  if (typeof flags.listen === 'boolean') die('--listen 缺值（毫秒数；0 = 只读缓存立即返回）');
  try { opt = drive.normalizeConsoleOptions({ listenMs: flags.listen }); } catch (e) { die(e.message); }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const page = { id: String(target.id || '').slice(0, 8), url: String(target.url || '').slice(0, 120), title: String(target.title || '').slice(0, 60) };
    console.error(`[console] 监听 ${opt.listenMs}ms（Runtime+Log 域；连接前历史按浏览器侧缓冲回放——Chrome 153 实测 Runtime.enable 回放 console 历史（Log 域仅浏览器/网络日志；88 未验证），条目按 timestamp 标「连接前缓存」）@ ${page.title || page.url}…`);
    const cap = await drive.captureConsole(client, sessionId, { listenMs: opt.listenMs, timeoutMs: num(flags.timeout, 5000) });
    const counts = { console: 0, log: 0, exception: 0, pre: 0 };
    for (const e of cap.entries) { counts[e.kind] = (counts[e.kind] || 0) + 1; if (e.pre) counts.pre++; }
    const report = {
      format: 'chromeuse-console/1', at: time.isoLocal(), page, listenMs: cap.listenMs,
      enabled: cap.enabled, deduped: cap.deduped, counts, entries: cap.entries,
    };
    const outFile = flags.out || path.join(paths.EVENTS_DIR, `console-${ts()}.json`);
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    if (jsonMode) return emitOk('console', report); // B1b：data=旧 chromeuse-console/1 报告
    for (const e of cap.entries) console.log(`[console] ${drive.formatConsoleEntry(e)}`);
    const head = cap.enabled.runtime ? (cap.enabled.log ? 'Runtime+Log' : 'Runtime-only') : 'Log-only';
    console.log(`[console] 共 ${cap.entries.length} 条（console ${counts.console}｜log ${counts.log}｜exception ${counts.exception}；连接前缓存 ${counts.pre}；去重 ${cap.deduped}；${head}；窗口 ${cap.listenMs}ms）`);
    if (!cap.entries.length) console.log('[console] 窗口内零输出——浏览器侧 console 缓冲也空（CDP 无任意长度历史）：请在触发日志前先起 --listen，或改用 MCP list_console_messages（其自带缓冲）');
    console.error(`[console] 全量报告（含 ts/url/line）已存 ${outFile}`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── 二期 P0：标签管理 + eval（2026-10-31 用户裁定；实现单源 lib/page.js） ──
 * goto/new/close/select/targets --json/eval：Target/Page/Runtime 域，零 Input 事件（红线一不涉及键鼠）。
 * 页签礼仪硬约束：谁开谁关（agent new 的页签必须 close）；new/close stdout 恒回显完整 targetId；
 * close --match 多命中不猜（无 --yes 只列候选并 exit 1）；--all-but 必须 --yes 才执行。 */

function shortTitle(t) { return String((t && t.title) || '').slice(0, 40); }
function targetLine(t) { return `targetId=${t.id || t.targetId}  ${shortTitle(t)}${t.url ? '  ' + String(t.url).slice(0, 100) : ''}`; }

/** close 拒绝执行时的统一输出（不猜、不误关）：候选清单 + 下一步建议 */
function printCloseRefusal(plan) {
  if (plan.reason === 'need-one-selector') {
    console.error('✗ [close] 需要且仅需一种选择器：<targetId>｜--all-but <保留 id>｜--match <url/title 关键字>');
    return;
  }
  if (plan.reason === 'empty-keyword') { console.error('✗ [close] --match 关键字不能为空'); return; }
  if (plan.reason === 'confirmation-required') {
    console.error(`✗ [close] --all-but 将关闭 ${plan.candidates.length} 个页签（保留 ${plan.keep ? targetLine(plan.keep) : '?'}）——批量破坏面必须 --yes 确认；本次未关闭任何页签：`);
    plan.candidates.forEach((t, i) => console.error(`   [${i}] ${targetLine(t)}`));
    return;
  }
  if (plan.reason === 'ambiguous-match') {
    console.error(`✗ [close] --match 命中 ${plan.candidates.length} 个页签——不猜，本次未关闭任何页签：`);
    plan.candidates.forEach((t, i) => console.error(`   [${i}] ${targetLine(t)}`));
    console.error('   下一步：用 close <targetId> 逐个精确关闭，或 --yes 确认全部关闭');
    return;
  }
  if (plan.reason === 'ambiguous-id') {
    console.error('✗ [close] targetId 前缀命中多个页签——不猜，用完整 targetId 指定：');
    (plan.candidates || []).forEach((t, i) => console.error(`   [${i}] ${targetLine(t)}`));
    return;
  }
  console.error('✗ [close] 未找到匹配的 page 页签（用 targets 查看现有标签；非 page 型 target 不在此命令管理范围）');
}

async function cmdGoto(pos, flags) {
  const raw = pos[0];
  if (raw === undefined) die(SUB_HELP.goto);
  let norm;
  try { norm = pageOps.normalizeGotoUrl(raw); } catch (e) { die(e.message); }
  if (flags.timeout === true) die('--timeout 缺值（goto 的 --timeout = 总加载预算，毫秒数）');
  let budget;
  try { budget = pageOps.normalizeGotoTimeout(flags.timeout); } catch (e) { die(e.message); }
  const challengeOpt = challengeOptions(flags);
  auditInsecureCerts(flags);
  const { core, client } = await openClient(flags, undefined, { insecure: !!flags.insecure });
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    console.error(`[goto] 目标：${shortTitle(target) || target.id}；导航到 ${norm.url}（加载预算 ${budget}ms）…`);
    const r = await pageOps.navigate(client, sessionId, norm.url, { timeoutMs: budget, cmdTimeoutMs: pageOps.DEFAULT_CMD_TIMEOUT_MS });
    const pageInfo = { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') };
    if (!r.ok) {
      if (r.timedOut) {
        console.error(`✗ [goto] ${r.elapsedMs}ms 内未完成加载（readyState=${r.readyState || '未知'}，已提交=${r.committed ? '是' : '否'}，loadEvent=${r.loadEvent ? '有' : '无'}，轮询 ${r.polls} 次）——长轮询/后台节流可加大 --timeout，或改用 wait --text / console 继续观察`);
        if (jsonMode) return emitFailWithData('goto', 'E_TIMEOUT', `goto ${r.elapsedMs}ms 内未完成加载（readyState=${r.readyState || '未知'}，已提交=${r.committed ? '是' : '否'}）`, Object.assign({ target: pageInfo }, r));
      } else if (r.errorText) {
        console.error(`✗ [goto] 导航失败：${r.errorText}（浏览器已显示错误页；检查 URL/网络/代理）`);
        if (jsonMode) return emitFailWithData('goto', 'E_CONN', `goto 导航失败：${r.errorText}`, Object.assign({ target: pageInfo }, r));
      } else {
        console.error(`✗ [goto] ${r.error || '导航失败'}`);
        if (jsonMode) return emitFailWithData('goto', 'E_INTERNAL', `goto ${r.error || '导航失败'}`, Object.assign({ target: pageInfo }, r));
      }
      return EXIT_ERR;
    }
    const redirected = !!(r.finalUrl && r.finalUrl !== r.requestedUrl);
    // C4（#124）：导航后只读页侧扫描——默认阻断（诚实红），--allow-challenge 仅提醒
    const ch = await challengeGate(client, sessionId, Object.assign({}, challengeOpt, { url: r.finalUrl || norm.url }));
    if (ch.detected && !ch.allowed) {
      if (jsonMode) return emitFailWithData('goto', 'E_POLICY_DENIED', challenge.formatBlock(ch), Object.assign({ target: pageInfo, challenge: challenge.summary(ch) }, r));
      return EXIT_ERR;
    }
    info(`[goto] ✓ ${r.finalUrl || r.requestedUrl}（${r.elapsedMs}ms${r.sameDocument ? '，同文档导航' : `，readyState=${r.readyState || '?'}，loadEvent=${r.loadEvent ? '有' : '无'}，轮询 ${r.polls} 次`}${redirected ? '，发生重定向' : ''}）@ ${shortTitle(target) || target.id}`);
    if (jsonMode) return emitOk('goto', Object.assign({ target: pageInfo, redirected }, flags.insecure ? { insecure: true } : {}, r, ch.detected ? { challenge: challenge.summary(ch) } : {}));
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── C8 页签治理（#123）：new/close 末尾惰性回收 + new 登记（白名单铁律见 lib/tab-govern.js） ──
 * 纪律：①回收只碰注册表登记的 agent 页签（未登记=用户页签，永不回收）；②回收只发
 * Target.getTargets/closeTarget，绝不 activateTarget/Page.bringToFront（永不抢前台）；
 * ③所有治理失败 fail-soft（不得阻断 new/close 主操作）。 */
function tabOptions() {
  let section = null;
  try { const cfg = require('../lib/config').loadConfig(); section = cfg && cfg.tabs; } catch { /* 配置坏 → 默认 */ }
  return tabGovern.normalizeOptions(section);
}

/** 惰性回收（new/close 顺带）：注册表空/关闭/busy → 零 CDP 开销直接返回 */
async function reclaimAgentTabs(client, flags) {
  const opt = tabOptions();
  if (!opt.enabled) return { skipped: 'disabled', options: opt };
  const loaded = tabGovern.loadRegistry();
  if (!Object.keys(loaded.registry.tabs).length) return { skipped: 'empty', options: opt };
  const busy = tabGovern.detectBusy();
  const infos = await pageOps.listTargetInfos(client, { timeoutMs: num(flags.timeout, 5000) });
  const plan = tabGovern.planReclaim({ registry: loaded.registry, liveTargets: infos, now: Date.now(), options: opt, busy });
  let closed = 0, failed = 0;
  for (const c of plan.reclaim) {
    const r = await pageOps.closeTarget(client, c.targetId, { timeoutMs: num(flags.timeout, 5000) })
      .catch((e) => ({ targetId: c.targetId, success: false, error: e.message }));
    if (r.success) {
      closed++;
      delete plan.registry.tabs[c.targetId]; // 成功回收才注销；失败保留登记，下轮重试
      console.error(`[reclaim] ✓ 已回收空闲 agent 页签 ${String(c.targetId).slice(0, 8)}（空闲 ${Math.round(c.idleMs / 1000)}s）：${shortTitle(c)}`);
    } else {
      failed++;
      console.error(`✗ [reclaim] ${String(c.targetId).slice(0, 8)} 关闭失败：${r.error || 'Target.closeTarget success=false'}`);
    }
  }
  const saved = tabGovern.saveRegistry(plan.registry);
  if (!saved.ok) console.error(`[reclaim] ⚠ 注册表回写失败（${saved.error}）`);
  if (plan.prune.length) console.error(`[reclaim] 清理注册表死条目 ${plan.prune.length} 个`);
  const leased = plan.keep.filter((k) => k.reason === 'leased');
  if (leased.length) console.error(`[reclaim] 跳过他方租约页签 ${leased.length} 个（${leased.map((k) => `${String(k.targetId).slice(0, 8)}=${k.owner}`).join('、')}）`);
  if (plan.skipped === 'busy') console.error(`[reclaim] 跳过本轮（忙碌信号：${(busy.reasons || []).join('、')}）`);
  return { reclaimed: closed, failed, pruned: plan.prune.length, kept: plan.keep.length, leased: leased.length, skipped: plan.skipped, options: opt };
}

/** new 登记：注册表（权威标记）+ about:blank title 前缀（best-effort；导航后会被站点覆盖） */
async function registerAgentTab(client, created, opt) {
  const now = Date.now();
  const loaded = tabGovern.loadRegistry();
  tabGovern.registerTab(loaded.registry, {
    targetId: created.targetId, url: created.url, now, prefix: opt.markPrefix,
    owner: opt.owner, leaseMs: opt.leaseMs, // C1：开页即发租约（owner=命名会话）
  });
  const saved = tabGovern.saveRegistry(loaded.registry);
  const out = { registered: saved.ok, registryError: saved.ok ? undefined : saved.error, titleMark: { ok: false, reason: null } };
  if (!saved.ok) return out; // 登记失败=不会被回收（安全侧），不再尝试 title
  if (created.url !== 'about:blank') { out.titleMark.reason = 'navigation-overwrites'; return out; }
  try {
    const sid = await client.attach(created.targetId, 5000);
    out.titleMark = await tabGovern.markTitle(client, sid, opt.markPrefix, { timeoutMs: 2000 });
  } catch (e) { out.titleMark = { ok: false, error: e.message }; }
  return out;
}

async function cmdNew(pos, flags) {
  const raw = pos[0];
  let norm = { url: pageOps.DEFAULT_NEW_URL };
  if (raw !== undefined) {
    try { norm = pageOps.normalizeGotoUrl(raw); } catch (e) { die(e.message); }
  }
  const challengeOpt = challengeOptions(flags);
  auditInsecureCerts(flags);
  const { core, client } = await openClient(flags, undefined, { insecure: !!flags.insecure });
  try {
    // C8（#123）：先惰性回收（注册表空/关闭/busy 时零 CDP 开销），再开新页签。
    try { await reclaimAgentTabs(client, flags); } catch (e) { console.error(`[reclaim] ⚠ 跳过（${e.message}）`); }
    const r = await pageOps.createTarget(client, norm.url, { background: !!flags.background, timeoutMs: num(flags.timeout, 5000) });
    // stdout 恒回显完整 targetId（脚本化配对：TID=$(... | sed -n 's/.*targetId=\([^ ]*\).*/\1/p')）
    console.log(`[new] ✓ targetId=${r.targetId} url=${r.url}${r.background ? '（后台页签）' : ''}`);
    try {
      const opt = tabOptions();
      const reg = await registerAgentTab(client, r, opt);
      if (reg.registered) {
        for (const w of opt.warnings) console.error(`[new] ⚠ ${w}`);
        const tm = reg.titleMark || {};
        if (tm.ok) console.error(`[new] 页签标记：registry + title 前缀「${opt.markPrefix}」（${tm.title || 'ok'}；空闲 ${Math.round(opt.idleMs / 60000)}min 后由 new/close 顺带回收）`);
        else console.error(`[new] 页签标记：registry（title 前缀跳过：${tm.reason || tm.error || 'unknown'}；空闲 ${Math.round(opt.idleMs / 60000)}min 后由 new/close 顺带回收）`);
      } else {
        console.error(`[new] ⚠ 页签登记失败（${reg.registryError}）——该页签不会被空闲回收（安全侧）`);
      }
    } catch (e) { console.error(`[new] ⚠ 页签登记异常（${e.message}）——该页签不会被空闲回收（安全侧）`); }
    console.error(`[new] 页签礼仪：谁开谁关——用完执行 cdp.js close ${r.targetId}`);
    // C4（#124）：新页签导航后 challenge 检查（createTarget 不等加载 → 先等页侧就绪；about:blank 直接跳过）
    if (r.url !== 'about:blank') {
      let sid = null;
      try { sid = await client.attach(r.targetId, 5000); } catch (e) { console.error(`[challenge] ⚠ 无法附着新页签（${e.message}）——跳过 challenge 判定`); }
      if (sid) {
        const ch = await challengeGate(client, sid, Object.assign({}, challengeOpt, { url: r.url, readyMs: 8000 }));
        if (ch.detected && !ch.allowed) return EXIT_ERR;
      }
    }
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdClose(pos, flags) {
  const forms = [];
  if (pos[0] !== undefined) forms.push('id');
  if (flags['all-but'] !== undefined) forms.push('all-but');
  if (flags.match !== undefined) forms.push('match');
  if (forms.length !== 1) {
    die(`${SUB_HELP.close}\n（实际选择器：${forms.length ? forms.join('+') : '无'}）`);
  }
  if (flags['all-but'] === true) die('--all-but 缺值（要保留的 targetId）');
  if (flags.match === true) die('--match 缺值（url/title 关键字）');
  const { core, client } = await openClient(flags);
  try {
    const infos = await pageOps.listTargetInfos(client, { timeoutMs: num(flags.timeout, 5000) });
    const plan = pageOps.planClose(infos, { id: pos[0], allBut: flags['all-but'], match: flags.match, yes: !!flags.yes });
    if (!plan.ok) { printCloseRefusal(plan); return EXIT_ERR; }
    if (!plan.planned.length) {
      console.log(`[close] 无需关闭（--all-but 保留 ${targetLine(plan.keep)}；其余无 page 页签）`);
      try { await reclaimAgentTabs(client, flags); } catch (e) { console.error(`[reclaim] ⚠ 跳过（${e.message}）`); }
      return EXIT_OK;
    }
    /* C1（#129）租约闸门：他方活跃租约=不关、诚实红（E_BUSY）。单用户/本主租约恒空 → 零感知。 */
    let leaseBlocked = [];
    try {
      const opt = tabOptions();
      leaseBlocked = tabGovern.leaseConflicts(plan.planned, tabGovern.loadRegistry().registry, { owner: opt.owner, now: Date.now() });
    } catch { /* 治理旁路：读表失败不阻断 close */ }
    const blockedIds = new Set(leaseBlocked.map((b) => b.targetId));
    const toClose = plan.planned.filter((t) => !blockedIds.has(String(t.id || t.targetId)));
    for (const b of leaseBlocked) {
      const when = b.expiresAt > 0 ? `到期 ${new Date(b.expiresAt).toISOString()}` : '不过期';
      console.error(`✗ [close] ${String(b.targetId).slice(0, 8)} E_BUSY：被「${b.owner}」租用中（${when}）——不关闭他方租约页签`);
    }
    let failed = leaseBlocked.length;
    if (leaseBlocked.length) console.error(`[close] ${leaseBlocked.length} 个目标因他方租约跳过（E_BUSY）；等对方租约过期或由该 owner 关闭`);
    if (!toClose.length) return EXIT_ERR;
    if (toClose.length > 1) {
      console.error(`[close] --yes 确认：将关闭 ${toClose.length} 个页签：`);
      toClose.forEach((t, i) => console.error(`   [${i}] ${targetLine(t)}`));
    }
    for (const t of toClose) {
      const r = await pageOps.closeTarget(client, t.id, { timeoutMs: num(flags.timeout, 5000) })
        .catch((e) => ({ targetId: t.id, success: false, error: e.message }));
      if (r.success) console.log(`[close] ✓ 已关闭 ${targetLine(t)}`);
      else { failed++; console.error(`✗ [close] ${targetLine(t)} 关闭失败：${r.error || 'Target.closeTarget success=false'}`); }
    }
    if (failed) console.error(`[close] ${toClose.length} 个目标中 ${failed - leaseBlocked.length} 个关闭失败${leaseBlocked.length ? `（另有 ${leaseBlocked.length} 个租约跳过）` : ''}`);
    try { await reclaimAgentTabs(client, flags); } catch (e) { console.error(`[reclaim] ⚠ 跳过（${e.message}）`); }
    return failed ? EXIT_ERR : EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdSelect(pos, flags) {
  const raw = pos[0];
  if (raw === undefined) die(SUB_HELP.select);
  const { core, client } = await openClient(flags);
  try {
    const infos = await pageOps.listTargetInfos(client, { timeoutMs: num(flags.timeout, 5000) });
    const hit = pageOps.resolvePageId(infos, raw);
    if (!hit.ok) {
      if (hit.reason === 'ambiguous-id') {
        console.error(`✗ [select] targetId 前缀命中多个页签——不猜，用完整 targetId：`);
        (hit.candidates || []).forEach((t, i) => console.error(`   [${i}] ${targetLine(t)}`));
      } else {
        console.error(`✗ [select] 未找到匹配的 page 页签（用 targets 查看现有标签）`);
      }
      return EXIT_ERR;
    }
    const t = hit.target;
    await pageOps.activateTarget(client, t.id || t.targetId, { timeoutMs: num(flags.timeout, 5000) });
    console.log(`[select] ✓ 已激活 ${targetLine(t)}`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdEval(pos, flags) {
  const hasFile = flags.file !== undefined;
  const hasExpr = pos[0] !== undefined;
  if (hasFile && hasExpr) die('eval 的 <expression> 与 --file 二选一（表达式写成文件更省 shell 引号）');
  if (!hasFile && !hasExpr) die(SUB_HELP.eval);
  if (flags.file === true) die('--file 缺值（表达式文件路径）');
  let expression, source;
  if (hasFile) {
    try { expression = pageOps.readExpressionFile(flags.file); } catch (e) { die(e.message); }
    source = `文件 ${flags.file}`;
  } else {
    expression = String(pos[0]);
    if (!expression.trim()) die('eval 表达式为空');
    source = '内联表达式';
  }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await pageOps.evaluateExpression(client, sessionId, expression, { timeoutMs: num(flags.timeout, 5000) });
    if (!r.ok) {
      const ex = r.exception || {};
      console.error(`✗ [eval] 表达式抛异常（${source}）：${ex.description || ex.text || '未知异常'}${Number.isFinite(ex.lineNumber) ? `（line ${ex.lineNumber + 1}）` : ''}`);
      return EXIT_ERR;
    }
    console.log(pageOps.formatEvalValue(r));
    console.error(`[eval] ✓ ${source}（${expression.length} 字符，返回类型 ${r.type || '?'}）@ ${shortTitle(target) || target.id}`);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── 二期-3：感知类 a11y / css（2026-10-31 用户裁定；实现单源 lib/perceive.js） ──
 * 只读感知：Accessibility/DOM/CSS/Runtime 域，零 Input 事件、零页面副作用（不滚动/不点击/不改 DOM）。
 * --timeout 在 a11y/css 是**取数预算**，不是连接超时——连接层固定 5s，避免 --timeout 1ms 时
 * 连浏览器都连不上（验收要求 1ms 仍能拿到 timedOut 语义）。 */

async function cmdA11y(flags) {
  if (flags.json !== undefined && flags.json !== true) die('--json 不接受值（结构化输出无参开关）');
  if (flags.ref !== undefined && flags.ref !== true) die('--ref 不接受值（无参开关：产引用表并在每行标 @eN）');
  if (flags.locator !== undefined && flags.locator !== true) die('--locator 不接受值（无参开关）');
  if (flags.locator === true && flags.ref !== true) die('--locator 只与 --ref 同用（可持久化定位器随引用表产出）');
  for (const [f, label] of [['diff', '--diff'], ['cursor', '--cursor'], ['visible-only', '--visible-only'], ['mark-js', '--mark-js'], ['group', '--group']]) {
    if (flags[f] !== undefined && flags[f] !== true) die(`${label} 不接受值（无参开关）`);
  }
  let maxRefs = null;
  if (flags.ref === true) {
    try { maxRefs = refs.normalizeMaxRefs(flags['max-refs']); } catch (e) { die(`${e.message}（--help 看 a11y 用法）`); }
  } else if (flags['max-refs'] !== undefined) {
    die('--max-refs 仅与 --ref 同用');
  }
  let opt;
  try {
    opt = perceive.normalizeA11yOptions({
      text: flags.text, selector: flags.selector, depth: flags.depth, match: flags.match,
      timeoutMs: flags.timeout, maxNodes: flags['max-nodes'], nth: flags.nth,
      find: flags.find, diff: flags.diff, out: flags.out, cursor: flags.cursor,
      cursorToken: flags['cursor-token'], cursorSize: flags['cursor-size'],
      exclude: flags.exclude, frames: flags.frames, visibleOnly: flags['visible-only'],
      markJs: flags['mark-js'], group: flags.group,
    });
  } catch (e) { die(`${e.message}（--help 看 a11y 用法）`); }
  if (flags['cursor-size'] !== undefined && !opt.cursor) die('--cursor-size 仅与 --cursor/--cursor-token 同用');
  if (flags.ref === true && opt.out) die('--out 与 --ref 不可组合（out 快照文件不含 @eN 行前缀；需要引用请先 a11y --ref）');
  // 连接层固定 5s：opt.timeoutMs 只约束取树预算
  const { core, client } = await openClient(Object.assign({}, flags, { timeout: 5000 }), 5000);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const report = await perceive.runA11y(client, sessionId, opt, {
      target: { id: String(target.id || ''), url: String(target.url || ''), title: String(target.title || '') },
    });
    report.target = { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') };
    /* C11 N12：--mark-js 结果提示（stderr；成功也说明语义边界，避免把根委托当已覆盖）。 */
    if (report.markJs) {
      if (!report.markJs.ok) {
        console.error(`[a11y] ⚠ --mark-js 不可用（${report.markJs.error || 'unknown'}${report.markJs.code !== null && report.markJs.code !== undefined ? `；code=${report.markJs.code}` : ''}）——该浏览器不支持 click 监听扫描（能力闸降级），其余输出不变`);
      } else {
        console.error(`[a11y] --mark-js：扫描 ${report.markJs.scanned} 个直接 click 监听节点，标记 ${report.markJs.marked} 个 [J]（只覆盖直接监听；React 根委托在元素级不可见）`);
      }
    }
    /* B5 N4：--ref = 物化引用表（一次 DOM 树 + 一次页侧批量；仅 clickable/focusable 且已有 rect 的节点）。
     * 失败不阻塞 a11y 本身（树是主产物，ref 是增强）——refError 如实进报告。 */
    if (flags.ref === true && report.ok && !report.timedOut && !report.degraded) {
      const refBudget = Math.max(1000, Math.min(opt.timeoutMs, 15000));
      /* B5 v1 边界：全树 @eN 只覆盖主文档；--frames 合并时子帧行不产 ref（跨 frame ref 走 partial 树） */
      const refRows = opt.frames === 'same-origin'
        ? report.nodes.filter((r) => !r || !Array.isArray(r.framePath) || r.framePath.length === 0)
        : report.nodes;
      try {
        const mat = await refs.materializeRefs(client, sessionId, refRows, {
          target: { id: target.id, url: target.url, title: target.title },
          framePath: (report.element && report.element.framePath) || [],
          maxRefs, timeoutMs: refBudget, withLocator: flags.locator === true,
          query: report.query,
        });
        if (mat.ok) {
          report.refs = mat.refs;
          report.refTable = mat.tablePath;
          report.refStats = mat.stats;
        } else {
          report.refError = mat.error || 'materialize-failed';
        }
      } catch (e) {
        report.refError = e.message;
      }
    } else if (flags.ref === true && report.ok === false) {
      report.refError = '树未取得（定位失败/超时），不产引用表';
    }
    /* C6 --group：分组统计在 @eN 物化之后算（口径=真实输出；分组只作用于渲染层，行序/编号不动） */
    if (opt.group && report.ok) {
      const gv = perceive.buildA11yGroups(report.nodes);
      report.groupView = {
        stats: gv.stats,
        groups: gv.groups.map((g) => ({
          kind: g.kind, path: perceive.groupPathOf(gv.groups, g), role: g.role,
          name: g.name || null, parent: g.parent, rows: g.rows.length, ref: g.headerRef,
        })),
      };
    }
    /* --out：stdout 只回三键摘要（文本/JSON 同契约；节点数组已落盘，不进上下文） */
    if (opt.out && !jsonMode && report.ok) {
      console.log(JSON.stringify(report.out));
    } else if (!jsonMode) {
      for (const line of perceive.formatA11yReport(report)) console.log(line);
    }
    if (!jsonMode && flags.locator === true && Array.isArray(report.refs) && report.refs.length) {
      for (const r of report.refs) console.log(`  @${r.ref} locator=${JSON.stringify(r.locator)}`);
    }
    if (report.timedOut) {
      console.error(`[a11y] ⚠ 超时（${opt.timeoutMs}ms）：返回 ${report.nodeCount || 0} 节点（timedOut:true${report.partial ? '，partial:true' : ''}）。`
        + '重页面先 --depth 裁剪（如 --depth 3 / --max-nodes 500）；替代通道：cdp.js exec DOM.getDocument / cdp.js screenshot / MCP take_snapshot（轻页面）');
      log.warn('cdp', `a11y 超时：nodeCount=${report.nodeCount || 0} depth=${opt.depth} query=${opt.query ? opt.query.kind : '全树'}`);
      if (jsonMode) return emitFailWithData('a11y', 'E_TIMEOUT', `a11y 超时（${opt.timeoutMs}ms）：返回 ${report.nodeCount || 0} 节点（timedOut:true${report.partial ? '，partial:true' : ''}）`, report);
      return EXIT_ERR;
    }
    if (report.degraded) {
      console.error(`✗ [a11y] 深段失败（${report.error || '未知'}）：仅返回浅层 partial 结果（nodeCount=${report.nodeCount || 0}，depth 可能不足 ${opt.depth || '全量'}）——重试或先 --depth 裁剪；替代通道：cdp.js exec DOM.getDocument / cdp.js screenshot`);
      log.warn('cdp', `a11y 降级 partial：${report.error || 'unknown'}（nodeCount=${report.nodeCount || 0}）`);
      if (jsonMode) return emitFailWithData('a11y', 'E_CDP', `a11y 深段失败（${report.error || '未知'}）：仅返回浅层 partial 结果`, report);
      return EXIT_ERR;
    }
    if (!report.ok) {
      if (Array.isArray(report.candidates) && report.candidates.length) {
        console.error(`✗ [a11y] 定位未唯一（${report.reason || 'ambiguous'}）：${report.candidates.length} 个候选——用 --nth N 显式选择或换精确文本/selector：`);
        report.candidates.forEach((c, i) => console.error(`   [${i}] ${c.tag || '?'} ${c.cssPath || ''} rect=${c.rect ? `${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h}` : '?'} text=${JSON.stringify(String(c.text || '').slice(0, 50))}`));
      }
      console.error(`✗ [a11y] ${report.error || '获取失败'}`);
      if (jsonMode) return emitFailWithData('a11y', report.code || 'E_LOCATE', `a11y ${report.error || '获取失败'}${report.reason ? `（${report.reason}）` : ''}`, report);
      return EXIT_ERR;
    }
    const frameNote = Array.isArray(report.frames) && report.frames.length
      ? `；同源帧已合并 ${report.frames.length} 个${report.frameErrors && report.frameErrors.length ? `（${report.frameErrors.length} 帧失败，见 stderr）` : ''}`
      : (opt.query ? `；定位=${opt.query.kind} 子树` : '；主文档树——同源 iframe 内容不展开');
    console.error(`[a11y] ✓ ${report.nodeCount} 节点（${report.elapsedMs}ms，depth=${opt.depth || '全量'}，truncated=${report.truncated}，ignored=${report.ignoredCount}，bounds=${report.boundsFetched}/${report.nodeCount}${frameNote}）`);
    if (jsonMode) return emitOk('a11y', report); // B1b：data=旧 chromeuse-a11y/1 报告（B6a 新旗标为 data 增量）
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

async function cmdCss(flags) {
  if (flags.json !== undefined && flags.json !== true) die('--json 不接受值（结构化输出无参开关）');
  if (flags.computed !== undefined && flags.computed !== true) die('--computed 不接受值（无参开关）');
  if (flags.matched !== undefined && flags.matched !== true) die('--matched 不接受值（无参开关）');
  let opt;
  try {
    opt = perceive.normalizeCssOptions({
      text: flags.text, selector: flags.selector, match: flags.match, computed: flags.computed === true,
      matched: flags.matched === true, timeoutMs: flags.timeout, nth: flags.nth,
    });
  } catch (e) { die(`${e.message}（--help 看 css 用法）`); }
  const { core, client } = await openClient(Object.assign({}, flags, { timeout: 5000 }), 5000);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const report = await perceive.runCss(client, sessionId, opt);
    report.target = { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') };
    if (!jsonMode) for (const line of perceive.formatCssReport(report)) console.log(line);
    if (!report.ok) {
      if (Array.isArray(report.candidates) && report.candidates.length) {
        console.error(`✗ [css] 定位未唯一（${report.reason || 'ambiguous'}）：${report.candidates.length} 个候选——用 --nth N 显式选择或换精确文本/selector：`);
        report.candidates.forEach((c, i) => console.error(`   [${i}] ${c.tag || '?'} ${c.cssPath || ''} text=${JSON.stringify(String(c.text || '').slice(0, 50))}`));
      }
      console.error(`✗ [css] ${report.error || report.computedError || report.matchedError || '获取失败'}`);
      if (jsonMode) return emitFailWithData('css', 'E_LOCATE', `css ${report.error || report.computedError || report.matchedError || '获取失败'}（${report.reason || 'locate-failed'}）`, report);
      return EXIT_ERR;
    }
    console.error(`[css] ✓ ${(report.element && report.element.tag) || '?'}${report.computed ? ` computed=${report.computedCount} 项` : ''}${report.matched ? ` matched=${report.matched.rules.length}${report.matched.truncated ? '/' + report.matched.totalRules : ''} 条` : ''}（${report.elapsedMs}ms）@ ${shortTitle(target) || target.id}`);
    if (jsonMode) return emitOk('css', report); // B1b：data=旧 chromeuse-css/1 报告
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── 二期-2：视口 / 模拟 / dialog / upload / drag（2026-10-31 用户裁定；实现单源 page.js + drive.js） ──
 * 域归属：viewport/emulate/dialog = Emulation/Page 页面环境（lib/page.js，零 Input 事件）；
 *         upload/drag = DOM 文件注入 / Input 真实鼠标序列（lib/drive.js，红线一交互域）。
 * 视口礼仪：viewport 是**操作者显式意图**（对齐 MCP resize_page 语义）；Emulation 覆盖是 CDP 会话级
 *   （命令结束前自动还原，不跨命令保持、不改真实窗口）——与 flow 回放 _meta.viewport 三态策略
 *   （在场纯跟随/不在场托底）互不干涉，后者只服务确定性回放。 */

function fmtMetrics(m) {
  return m ? `${m.width}×${m.height} dpr=${m.dpr}` : '读取失败';
}

function fmtEmuState(s) {
  return s ? `UA=${JSON.stringify(String(s.ua).slice(0, 80))}${s.ua.length > 80 ? '…' : ''} printMedia=${s.printMedia}` : '读取失败';
}

async function cmdViewport(pos, flags) {
  if (pos.length > 1) die(SUB_HELP.viewport);
  if (flags.reset !== undefined && flags.reset !== true) die('--reset 不接受值（清除覆盖是无参开关）');
  if (flags.dpr === true) die('--dpr 缺值（数值 1~4）');
  let req;
  try { req = pageOps.normalizeViewportRequest({ viewport: pos[0], dpr: flags.dpr, reset: flags.reset === true }); }
  catch (e) { die(e.message); }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const where = `@ ${(target.title || target.url).slice(0, 50)}`;
    if (req.mode === 'reset') {
      let r;
      try { r = await pageOps.resetViewport(client, sessionId, { timeoutMs: num(flags.timeout, 5000) }); }
      catch (e) { console.error(`✗ [viewport] 清除设备指标覆盖失败：${e.message}`); return EXIT_ERR; }
      console.log(`[viewport] 前：${fmtMetrics(r.pre)}（清除前读数）`);
      console.log(`[viewport] ✓ 已执行 clearDeviceMetricsOverride；后：${fmtMetrics(r.post)}${r.unchanged ? '（前后一致——可能原本就无覆盖）' : ''} ${where}`);
      console.error('[viewport] 视口礼仪：清除只作用于当前页签；刷新/关闭页签也会自然失效。与 flow 回放 _meta.viewport 三态策略互不干涉（前者只服务交互式操作/调试）。');
      return EXIT_OK;
    }
    let r, restore = null, applyErr = null;
    try { r = await pageOps.applyViewport(client, sessionId, req, { timeoutMs: num(flags.timeout, 5000) }); }
    catch (e) { applyErr = e.message; }
    if (r) {
      console.log(`[viewport] 前：${fmtMetrics(r.pre)}`);
      if (r.ok) {
        console.log(`[viewport] ✓ 已覆盖 ${r.plan.width}×${r.plan.height} @DPR ${r.plan.deviceScaleFactor}（会话内）；实测：${fmtMetrics(r.post)} ${where}`);
      } else {
        console.error(`✗ [viewport] setDeviceMetricsOverride 已下发，但实测读数不符：${r.mismatch.join('；')}`);
      }
    }
    // 会话级覆盖自动还原（2026-10-31 Chrome 153 实测：覆盖只在施加它的 CDP session 存活期间可见，
    // session 断开即清理；dontSetVisibleSize:true 保证不改真实窗口——命令结束主动 clear，绝不留残留）
    try { restore = await pageOps.resetViewport(client, sessionId, { timeoutMs: num(flags.timeout, 5000) }); }
    catch (e) { console.error(`✗ [viewport] 自动还原失败：${e.message}——覆盖可能残留到本进程退出（session 断开后 Chrome 会清理）`); }
    if (restore) console.log(`[viewport] ✓ 已自动还原（clearDeviceMetricsOverride）：${fmtMetrics(restore.post)}`);
    console.error('[viewport] 语义：Emulation 覆盖是 **CDP 会话级**——本命令结束前自动还原，不会跨命令保持（实测 Chrome 153 会话断开即回原生）。'
      + '不修改真实窗口大小（dontSetVisibleSize:true）。需要在后续命令中保持视口 → 用 screenshot --viewport（一次性截图）或 flow replay _meta.viewport / MCP resize_page（长驻会话）。'
      + '视口礼仪：本命令=操作者显式意图，与 flow 回放三态策略互不干涉；--reset 用于兜底清理本会话覆盖。');
    if (applyErr) { console.error(`✗ [viewport] 设置失败：${applyErr}`); return EXIT_ERR; }
    return r && r.ok && restore ? EXIT_OK : EXIT_ERR;
  } finally { await gracefulClose(client); }
}

async function cmdEmulate(flags) {
  if (flags.reset !== undefined && flags.reset !== true) die('--reset 不接受值（双清是无参开关）');
  if (flags.ua === true) die('--ua 缺值（User-Agent 字符串）');
  if (flags.media === true) die('--media 缺值（print|screen）');
  let req;
  try { req = pageOps.normalizeEmulateRequest({ ua: flags.ua, media: flags.media, reset: flags.reset === true }); }
  catch (e) { die(e.message); }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const where = `@ ${(target.title || target.url).slice(0, 50)}`;
    if (req.mode === 'reset') {
      let r;
      try { r = await pageOps.resetEmulation(client, sessionId, { timeoutMs: num(flags.timeout, 5000) }); }
      catch (e) { console.error(`✗ [emulate] 双清失败：${e.message}`); return EXIT_ERR; }
      console.log(`[emulate] 前：${fmtEmuState(r.pre)}`);
      console.log(`[emulate] ✓ 双清 clearUserAgentOverride=${r.cleared.userAgent} clearEmulatedMedia=${r.cleared.media}；后：${fmtEmuState(r.post)} ${where}`);
      if (!r.ok) { console.error(`✗ [emulate] 部分清除失败：${r.errors.join('；')}`); return EXIT_ERR; }
      return EXIT_OK;
    }
    let r, restore = null, applyErr = null;
    try { r = await pageOps.applyEmulation(client, sessionId, req, { timeoutMs: num(flags.timeout, 5000) }); }
    catch (e) { applyErr = e.message; }
    if (r) {
      console.log(`[emulate] 前：${fmtEmuState(r.pre)}`);
      console.log(`[emulate] ✓ 已设置${r.applied.ua !== null ? ` UA=${JSON.stringify(r.applied.ua)}` : ''}${r.applied.ua !== null && r.applied.media !== null ? '；' : ''}${r.applied.media !== null ? ` media=${r.applied.media}` : ''}（会话内）；实测：${fmtEmuState(r.post)} ${where}`);
      if (!r.ok) console.error(`✗ [emulate] 施加后读数不符：${r.mismatch.join('；')}`);
    }
    // 会话级模拟自动还原（同 viewport：Emulation 覆盖随 CDP session 断开被 Chrome 清理；命令结束主动双清不留残留）
    try { restore = await pageOps.resetEmulation(client, sessionId, { timeoutMs: num(flags.timeout, 5000) }); }
    catch (e) { console.error(`✗ [emulate] 自动还原失败：${e.message}——模拟可能残留到本进程退出（session 断开后 Chrome 会清理）`); }
    if (restore) {
      console.log(`[emulate] ✓ 已自动双清（UA/media）：${fmtEmuState(restore.post)}`);
      if (!restore.ok) console.error(`✗ [emulate] 自动还原部分失败：${restore.errors.join('；')}`);
    }
    console.error('[emulate] 语义：Emulation 模拟是 **CDP 会话级**——本命令结束前自动还原，不会跨命令保持（实测 Chrome 153 会话断开即回原生）。'
      + '需要在后续操作中保持模拟 → 用 flow emulate 原语或 MCP 长驻会话。');
    if (applyErr) { console.error(`✗ [emulate] 设置失败：${applyErr}`); return EXIT_ERR; }
    return r && r.ok && restore && restore.ok ? EXIT_OK : EXIT_ERR;
  } finally { await gracefulClose(client); }
}

async function cmdDialog(flags) {
  if (flags.auto === true) die('--auto 缺值（accept|dismiss|cancel）');
  if (flags.text === true) die('--text 缺值（prompt 答复文本）');
  if (flags.wait === true) die('--wait 缺值（毫秒监听窗）');
  let opt;
  try { opt = pageOps.normalizeDialogOptions({ auto: flags.auto, text: flags.text, waitMs: flags.wait }); }
  catch (e) { die(e.message); }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const where = `@ ${(target.title || target.url).slice(0, 50)}`;
    console.error(opt.queryOnly
      ? `[dialog] 查询当前挂起：CDP 无查询 API，仅开 ${pageOps.DIALOG_QUERY_PROBE_MS}ms 观察窗（监听前已打开的 dialog 不会回放）${where}…`
      : `[dialog] 监听 ${opt.waitMs}ms，首个 dialog 事件${opt.auto ? `按 --auto ${opt.auto} 处置` : '只报告（无 --auto 不处置）'}${where}…`);
    const r = await pageOps.waitForDialog(client, sessionId, { auto: opt.auto, text: opt.text, waitMs: opt.queryOnly ? undefined : opt.waitMs, timeoutMs: num(flags.timeout, 5000) });
    if (!r.ok) {
      if (r.timedOut) {
        console.error(`✗ [dialog] ${r.note || `${r.waitedMs}ms 内未出现 dialog`}`);
        if (r.queryOnly) console.error('[dialog] 限制：CDP 没有「查询当前挂起对话框」API；正确用法=先在后台跑 dialog --wait <ms> --auto accept 预埋监听，再由另一命令触发弹窗（一次性短连接无法常驻自动处置）。');
      } else {
        console.error(`✗ [dialog] ${r.error || '监听失败'}`);
      }
      return EXIT_ERR;
    }
    const d = r.dialog;
    console.log(`[dialog] ✓ 捕获 type=${d.type} message=${JSON.stringify(String(d.message).slice(0, 200))} url=${String(d.url).slice(0, 120)}${d.defaultPrompt !== null ? ` defaultPrompt=${JSON.stringify(String(d.defaultPrompt).slice(0, 80))}` : ''}（等待 ${r.waitedMs}ms）`);
    if (r.handled) {
      if (!r.handled.ok) { console.error(`✗ [dialog] 处置失败（action=${r.handled.action}）：${r.handled.error}`); return EXIT_ERR; }
      console.log(`[dialog] ✓ 已处置 action=${r.handled.action}（Page.handleJavaScriptDialog accept=${r.handled.accept}${r.handled.promptText !== null ? ` promptText=${JSON.stringify(r.handled.promptText)}` : ''}）`);
    } else {
      console.error('[dialog] ⚠ 无 --auto，未处置——页面仍被该 dialog 阻塞；补跑带 --auto accept|dismiss 的监听（或手动关闭）。若 dialog 已打开，--wait 不会回放历史事件，只能人工关闭后重试。');
    }
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/** upload 目标解析：--into-* 映射到一期 interactSpec（--text/--selector/--point 单源）；省略 = 当前焦点。 */
function uploadTargetFromFlags(flags) {
  if (flags.uid !== undefined) die('--uid 不可用（MCP 快照临时句柄）——改用 --into-selector / --into-text / --into-point');
  const forms = [];
  if (flags['into-text'] !== undefined) forms.push('text');
  if (flags['into-selector'] !== undefined) forms.push('selector');
  if (flags['into-point'] !== undefined || flags['into-x'] !== undefined || flags['into-y'] !== undefined) forms.push('point');
  if (forms.length > 1) die(`upload 目标定位至多一种：--into-text｜--into-selector｜--into-point；实际 ${forms.join('+')}`);
  if (!forms.length) return { kind: 'active', label: '当前焦点' };
  if (forms[0] === 'text') {
    return interactSpecFromFlags({ text: flags['into-text'], match: flags.match }, 'upload');
  }
  if (forms[0] === 'selector') {
    return interactSpecFromFlags({ selector: flags['into-selector'] }, 'upload');
  }
  if (flags['into-point'] === true) die('--into-point 缺值（形态 "x,y"）');
  if (flags['into-point'] === undefined && (flags['into-x'] === undefined || flags['into-y'] === undefined)) {
    die('--into-point 坐标需成对：--into-x N --into-y M（或 --into-point "x,y"）');
  }
  const raw = flags['into-point'] !== undefined ? flags['into-point'] : `${flags['into-x']},${flags['into-y']}`;
  const spec = interactSpecFromFlags({ point: raw }, 'upload');
  // interactSpecFromFlags 的 point 分支不带 label（一期 click 不依赖）；upload 输出需可读目标标识，就地补
  return Object.assign({}, spec, { label: `坐标 ${spec.point.x},${spec.point.y}` });
}

async function cmdUpload(pos, flags) {
  const rawFiles = pos.slice();
  if (flags.file !== undefined) {
    if (flags.file === true) die('--file 缺值（文件路径；多文件用逗号分隔或重复位置参数）');
    rawFiles.push(flags.file);
  }
  if (!rawFiles.length) die(SUB_HELP.upload);
  if (flags['browser-path'] !== undefined && flags['browser-path'] !== true) die('--browser-path 不接受值（路径按浏览器进程解析是无参开关）');
  const browserPath = flags['browser-path'] === true;
  let files;
  try { files = drive.resolveUploadFiles(rawFiles, { skipLocalCheck: browserPath }); } catch (e) { die(e.message); }
  const effCfg = parseEffectConfig(flags);
  const into = uploadTargetFromFlags(flags);
  const nth = nthFromFlags(flags);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const where = `@ ${(target.title || target.url).slice(0, 50)}`;
    let intoResolved = into;
    if (into.kind === 'point') {
      // 坐标定位：elementFromPoint 只读解析为元素 objectId（本解析留在 CLI 层；lib/drive.js 保持零 elementFromPoint）
      const ev = await client.send('Runtime.evaluate', {
        expression: `(function(){ return document.elementFromPoint(${into.point.x}, ${into.point.y}); })()`,
        objectGroup: drive.UPLOAD_OBJECT_GROUP, returnByValue: false, userGesture: false,
      }, { sessionId, timeoutMs: num(flags.timeout, 5000) });
      intoResolved = { kind: 'objectId', objectId: ev && ev.result && ev.result.objectId, label: into.label };
    }
    const r = await drive.uploadFiles(client, sessionId, intoResolved, files, {
      nth, autoScroll: !flags['no-scroll'], timeoutMs: num(flags.timeout, 5000), locateTimeoutMs: num(flags.timeout, 10000), browserPath,
    });
    if (!r.ok) {
      if (r.reason === 'not-file-input') {
        const actual = r.input && r.input.error ? `探针失败：${r.input.error}` : (r.input ? `<${r.input.tag}> type=${JSON.stringify(r.input.type)}` : '非 DOM 元素/探针失败');
        console.error(`✗ [upload] ${r.label} 不是 <input type="file">（实际 ${actual}）——拒绝注入；用 --into-selector 指向文件输入框`);
      } else if (r.reason === 'multiple-required') {
        console.error(`✗ [upload] ${r.label} 不支持多文件（multiple=false），但请求了 ${files.length} 个文件——改用单文件或换 multiple 输入框`);
      } else if (r.reason === 'disabled') {
        console.error(`✗ [upload] ${r.label} 文件输入框被禁用（disabled=true）——先解除禁用/触发上传控件`);
      } else if (r.reason === 'not-element') {
        console.error(`✗ [upload] ${r.label} 未解析到 DOM 元素（evaluate 无 objectId）`);
      } else {
        await printLocateFailure('upload', r.label || into.label || '目标', r.locate || { reason: r.reason, candidates: [] }, { client, sessionId });
      }
      return EXIT_ERR;
    }
    console.log(`[upload] ✓ 已注入 ${r.files.length} 个文件 → ${r.label}（multiple=${r.input.multiple}）${r.after ? `；读回 files=[${r.after.map((x) => JSON.stringify(x)).join(', ')}]` : ''} ${where}`);
    if (r.contentOk === false) {
      // 防假绿（2026-10-31 实弹发现）：DOM.setFileInputFiles 的路径由**浏览器进程**解析——客户端与浏览器
      //   文件系统隔离时 Chrome 静默创建 0 字节 File（只有名字），上传链路后续必然失败。size 不符即判失败。
      const detail = (r.contentMismatch || []).map((m) => {
        if (m.kind === 'size') return `${m.name}：本地 ${m.local}B ≠ 浏览器读回 ${m.remote}B`;
        if (m.kind === 'count') return `数量：本地 ${m.local} ≠ 浏览器读回 ${m.remote}`;
        if (m.kind === 'empty') return `${m.name}：浏览器读回 0 字节（路径在浏览器进程不可读，或空文件）`;
        return m.kind;
      }).join('；');
      console.error(`✗ [upload] 注入动作已下发，但**文件内容校验失败**（${detail}）`);
      if (browserPath) {
        console.error('[upload] --browser-path 只验证浏览器读回 size>0；0 字节=该路径在浏览器进程不可读（或真为空文件，空文件请改用默认模式）');
      } else {
        console.error('[upload] files 路径由浏览器进程（chrome-browser 容器）解析；两容器文件系统隔离时 setFileInputFiles 会静默创建 0 字节文件');
        console.error('[upload] 处置：①同机/共享挂载时确认客户端与浏览器解析到同一文件；②路径只在浏览器侧可见时加 --browser-path（跳过客户端存在性校验，仅验证读回 size>0）；本命令以 exit 1 收割，不按成功计');
      }
      return EXIT_ERR;
    }
    if (browserPath) console.error('[upload] --browser-path：已跳过客户端存在性校验；内容校验=浏览器读回 size>0（未与本地字节比对）');
    const eff = await settleFor(client, sessionId, effCfg, r.candidate || null);
    if (eff) printEffectPhase('upload', eff);
    if (eff && eff.phase === 'stalled') {
      return stalledExit('upload', eff, withEffect({
        target: { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') },
        label: r.label, files: r.files, after: r.after, contentOk: r.contentOk,
      }, eff));
    }
    return EXIT_OK;
  } catch (e) {
    console.error(`✗ [upload] 注入失败：${e.message}（文件必须存在于执行 CDP 的机器；DOM.setFileInputFiles 是协议官方文件注入通道）`);
    return EXIT_ERR;
  } finally { await gracefulClose(client); }
}

/** drag 单端定位解析（from/to 各三选一：text/selector/point）。 */
function dragEndpointFromFlags(flags, side, verb) {
  const forms = [];
  const hasPoint = flags[`${side}-point`] !== undefined || flags[`${side}-x,y`] !== undefined
    || flags[`${side}-x`] !== undefined || flags[`${side}-y`] !== undefined;
  if (hasPoint) forms.push('point');
  if (flags[`${side}-text`] !== undefined) forms.push('text');
  if (flags[`${side}-selector`] !== undefined) forms.push('selector');
  if (forms.length !== 1) {
    die(`${verb} ${side} 端需要且仅需一种定位：--${side}-text <文本>｜--${side}-selector <cssPath>｜--${side}-point "x,y"（或 --${side}-x,y "x,y" / --${side}-x N --${side}-y M）；实际 ${forms.length ? forms.join('+') : '无'}`);
  }
  if (forms[0] === 'point') {
    if (flags[`${side}-point`] === true || flags[`${side}-x,y`] === true) die(`--${side}-point/--${side}-x,y 缺值（形态 "x,y"）`);
    if (flags[`${side}-point`] === undefined && flags[`${side}-x,y`] === undefined
      && (flags[`${side}-x`] === undefined || flags[`${side}-y`] === undefined)) die(`--${side}-point 坐标需成对：--${side}-x N --${side}-y M（或 --${side}-point "x,y"）`);
    const raw = flags[`${side}-point`] !== undefined ? flags[`${side}-point`] : (flags[`${side}-x,y`] !== undefined ? flags[`${side}-x,y`] : `${flags[`${side}-x`]},${flags[`${side}-y`]}`);
    let point;
    try { point = drive.parsePoint(raw); } catch (e) { die(e.message); }
    return { kind: 'point', point, label: `坐标 ${point.x},${point.y}` };
  }
  if (forms[0] === 'text') {
    if (typeof flags[`${side}-text`] !== 'string' || !flags[`${side}-text`]) die(`--${side}-text 缺值（要匹配的可见文本）`);
    const spec = { text: flags[`${side}-text`] };
    if (flags.match !== undefined) spec.match = String(flags.match);
    return { kind: 'text', spec, label: `文本「${flags[`${side}-text`]}」` };
  }
  if (typeof flags[`${side}-selector`] !== 'string' || !flags[`${side}-selector`]) die(`--${side}-selector 缺值（CSS 选择器）`);
  return { kind: 'selector', spec: { domPath: flags[`${side}-selector`] }, label: `选择器 ${flags[`${side}-selector`]}` };
}

async function cmdDrag(flags) {
  const from = dragEndpointFromFlags(flags, 'from', 'drag');
  const to = dragEndpointFromFlags(flags, 'to', 'drag');
  if (flags.match !== undefined && !['exact', 'contains'].includes(String(flags.match))) die(`--match 仅支持 exact|contains（收到 ${JSON.stringify(flags.match)}）`);
  if (flags.steps === true) die('--steps 缺值（1~50 的整数）');
  if (flags.hold === true) die('--hold 缺值（毫秒）');
  if (flags.gap === true) die('--gap 缺值（毫秒）');
  let opt;
  try { opt = drive.normalizeDragOptions({ steps: flags.steps, holdMs: flags.hold, gapMs: flags.gap }); }
  catch (e) { die(e.message); }
  const fromNth = nthFromFlags(flags);
  const toNth = nthFromFlags(flags, 'to-nth');
  const effCfg = parseEffectConfig(flags);
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const where = `@ ${(target.title || target.url).slice(0, 50)}`;
    const resolvePoint = async (ep, nthV) => {
      if (ep.kind === 'point') return ep;
      const res = await drive.locate(client, sessionId, ep.spec, { nth: nthV, autoScroll: !flags['no-scroll'], timeoutMs: num(flags.timeout, 10000) });
      if (!res.ok) { await printLocateFailure('drag', ep.label, res, { client, sessionId }); return null; }
      return { kind: 'located', point: res.point || drive.candidatePoint(res.candidate), label: ep.label, candidate: res.candidate, scrolled: res.scrolled };
    };
    const src = await resolvePoint(from, fromNth);
    if (!src) return EXIT_ERR;
    const dst = await resolvePoint(to, toNth);
    if (!dst) return EXIT_ERR;
    const r = await drive.dragGesture(client, sessionId, src.point, dst.point, {
      steps: opt.steps, holdMs: opt.holdMs, gapMs: opt.gapMs, timeoutMs: num(flags.timeout, 5000),
    });
    console.log(`[drag] ✓ ${src.label}(${r.from.x},${r.from.y}) → ${dst.label}(${r.to.x},${r.to.y})（${r.steps} 段插值，hold ${r.holdMs}ms，段间 ${r.gapMs}ms；Input 域真实鼠标序列）${where}`);
    const eff = await settleFor(client, sessionId, effCfg, dst.candidate || null); // 主体=拖拽落点元素
    if (eff) printEffectPhase('drag', eff);
    if (eff && eff.phase === 'stalled') {
      return stalledExit('drag', eff, withEffect({
        target: { id: String(target.id || '').slice(0, 8), url: String(target.url || ''), title: String(target.title || '') },
        from: { label: src.label, point: r.from }, to: { label: dst.label, point: r.to },
        steps: r.steps, holdMs: r.holdMs, gapMs: r.gapMs,
      }, eff));
    }
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── 帮助 ── */
function helpMain() {
  console.log(`chromeuse cdp.js —— raw CDP 逃生舱（Node>=22，零依赖；退出码 0/1/2）

${CMD_QUICKREF}

⚠ 万能口 exec 警示：可执行任意 CDP 命令；Target.close*/Page.navigate/Browser.close/Storage.* 等
  破坏性类别务必明确 --target 并自担风险；业务写操作走 flow replay（Input 域真实事件），
  严禁 Runtime.evaluate 合成业务事件（isTrusted=false 红线）。

✨ 2026-11 能力补强（各命令 --help 有旗标详情；完整契约 → references/mechanisms.md §1~§17）：
  --json              13 命令统一信封 chromeuse-cli/1（ok/code/retryable/hint + 20 错误码；其余命令拒绝 E_USAGE 不执行）
  --expect-*          动作后生效判据（click/type/key/drag/upload；四态 phase=confirmed/effect_pending/dispatched/stalled；--effect-ms 窗口）
  --ref @eN           稳定引用：a11y --ref 产引用表 → click/type/hover --ref @eN 消费（失效 E_REF_STALE 不猜不点错）
  a11y --find/--diff/--frames/--cursor/--out    快照分级（万节点找单元素/只看变化行/同源 iframe 整树/分页/落盘）
  --async + job       长任务秒回 jobId（cast/scroll-shot/record/flow replay；job list/status/cancel；满载 E_BUSY；须显式 --target）
  extract / assert    结构化抽取（表格/链接/JSON-LD/虚拟化网格免写 eval）/ 批量断言（默认失败不中断出完整明细）
  grid               虚拟化网格定位/滚动（react-data-grid；按列头文字+行号，滚动渲染后复读；有滚动副作用）
  audit / artifacts   操作审计 JSONL（audit tail/stats；白名单无敏感值）/ 产物配额（report/prune/pin；prune 默认 dry-run、证据类永不删）
  输出脱敏            默认开（urlParams/Authorization/Cookie 等；type 只打字符数 --echo-text 才回显；--no-redact 显式关并记审计）

子命令：
  probe [--target] [--out] [--timeout]     三通道依次探测（浏览器/renderer/合成器，各 5s 独立超时）输出存活报告（chrome://newtab 内部页不出帧→合成器项跳过并注明，不算失效）；版本低于 MCP 已知降级线（94）时给 ℹ advisory（非失败，exit 语义不变）
  exec <method> [paramsJSON | --params-file <path>] [--target] [--insecure]  万能口：任意 CDP 命令 + 独立超时（页面级命令须 --target；PowerShell 引号吞噬时优先 --params-file；--insecure=连接级忽略证书错误）
  targets [--json]                         HTTP /json/list 列出全部 target（纯 HTTP 无需 WS；--json = Target.getTargets 结构化投影 id/type/title/url/attached）
  net [--filter] [--duration ms] [--get id] [--out]   Network 域采集窗口 + body/payload 拉取（【冻结期 Network 域可用性实测】工具）
  screenshot [--target] [--out] [--timeout] [--dpr 1~4] [--viewport WxH] [--format png|jpeg] [--quality 0~100] [--annotate]
           独立短超时截图落盘（默认 tmpdata/events/；--dpr/--viewport = Emulation.setDeviceMetricsOverride 显式覆盖视口/DPR（用完 finally 还原；不传则零 Emulation 命令、行为零改变）；--format/--quality 控编码与体积（quality 仅 jpeg）；--annotate = Node 侧叠字标注 @eN（现场物化 ref 表，与 a11y --ref 同编号源；仅 png；零页面副作用；关闭时截图字节不变）；失败自动诊断矩阵+fromSurface 降级+冷启动退避【CHROMEUSE_SCREENSHOT_BACKOFF 可配】+screencast 帧兜底，最终失败输出 chromeuse-screenshot-fail/1 报告）
  scroll-shot [--target 选择器] [--out-dir 目录] [--name 前缀] [--viewport WxH] [--viewport-max-chunk] [--dpr 1~4] [--format png|jpeg] [--quality 0~100] [--max-chunk 4600] [--max-chunk-unit px|css] [--overlap 0] [--no-format-fallback] [--img-promote|--no-img-promote] [--img-settle 1800] [--blank-check|--no-blank-check] [--blank-min-px 800] [--blank-threshold 247] [--blank-strict] [--snap-cuts|--no-snap-cuts] [--snap-window 180] [--snap-px] [--no-foreground] [--settle 200] [--timeout 30000] [--keep-slices] [--dry-run] [--async]
              长文/长页长图分段拼接：图片懒加载（默认 --img-promote 强制 data-src 赋值 → 等就绪 → 等 --img-settle 首帧解码）+ 滚动预热（背景图/非图片懒加载兜底）→ 按 min(视口高, chunkCss) 分段（末段防重叠）→ 逐段 A 整段 clip 截图（captureBeyondViewport；失败重试 1 次转 B 视口切片 + bin/ffmpeg vstack）→ 落 <out-dir>/<name>-01.jpg… + <name>.json 清单（chromeuse-scroll-shot/1）；默认 jpeg q90（PNG 整页 ≈16MB）；--max-chunk 默认**物理像素**（--max-chunk-unit css = 旧行为；⚠ dpr>1 时与旧行为不同）；--overlap = 非末段向下多拍 CSS px（切段位置不变，0=几何精确）；--viewport-max-chunk = 显式把视口高覆盖成 chunkCss（规避 beyond-viewport 大 clip）；--timeout = 单段截图超时（总预算 = 段数 × 单段）；--dry-run 只测布局+预热探测+出分段计划不落图；**空白段自检（默认开，advisory 只报告）**：每段落盘后 ffprobe 取高 → ffmpeg scale=1:H 灰度取"每行平均亮度" → 连续 ≥ --blank-min-px（默认 800 物理 px）行亮度 ≥ --blank-threshold（默认 247）判"疑似空白"，默认不改退出码（原文设计留白也会命中），--blank-strict 才让可疑段 exit 1（清单 status 仍记 ok），--no-blank-check 关，ffmpeg 缺失则自检跳过不阻断截图；**切点吸附空白带（F15，默认开）**：分段前一次只读 evaluate 取可见内容元素 rect（有直接文本节点的元素+替换元素；排除 display:none/visibility:hidden/零面积/fixed|sticky），纯函数对每个非末段切点在 ±--snap-window（默认 180 CSS px，32~512）内找「不与任何元素相交的水平空白带」（最小 12 CSS px）取带中点，原切点已在带内则位移 0，越窗口/越 viewport/4 极短段/越 chunkCss 上界则 clamp 到边界、clamp 后不在带内则放弃（method:'none'），末段不吸附；清单段级 snap{from,to,shift,method:dom|px|none} + 顶层 snapConfig{enabled,windowPx,pxFallback}；--no-snap-cuts 关；--snap-px 开像素法兜底（DOM 无合格带的切点用段图 F13 行剖面在段尾 ±window 图内可见部分找带，ffmpeg 缺失/失败 fail-soft 回落原切点，尾部按新切点滚动推进重排）；吸附整体异常 → 全部原切点 + stderr 告警 + 清单 note，不阻断截图；--dry-run 只算 DOM 法（无图不跑像素法）；**前台保障（默认开）**：进入时读 visibilityState，hidden 才 Page.bringToFront（后台页签 raw captureScreenshot 实测 30s 超时甚至返回旧帧=静默错图），默认不自动还原前台，--no-foreground 显式放弃（会强告警）
  cast --duration <s> [--out x.mp4] [--every-nth 1] [--quality 70] [--max-width 0] [--no-foreground] [--target 页] [--async]
            一次性录屏（Page.startScreencast 收帧 → bin/ffmpeg 合成 mp4；时长上限 600s 防误录爆盘）；**fps 按首末帧真实跨度归一（GQ-001：静止期 Chrome 不推帧，禁用标称帧率）**；<2 帧如实失败并报帧数/时长/帧间隔；ffmpeg 不可用 → 帧恒留档+离线合成命令；落 tmpdata/cast/
  beacon [--host 0.0.0.0] [--port 9999] [--dump 目录]  零依赖 HTTP 收 POST（页面侧 URL：NAS http://opencode:9999）
  watch [--interval 10] [--window 120] [--max-seconds N] [--target]   看门狗：双死持续≥window 判冻结；只建议不杀（exit 2=冻结）
  flow validate|replay <file> [--var k=v] [--target] [--keep-tab] [--lock] [--insecure] [--allow-challenge] [--async]     --insecure=整场回放连接级忽略证书错误；--allow-challenge=bot 盾不阻断仅提醒；flow 引擎（schema 校验/CDP Input 真实事件回放；默认无互斥，--lock 可选显式互斥）
  locator probe|suggest|verify|pick [--text X] [--target 页] [--json]   元素捕获工具：probe 列候选/suggest 递归收窄/verify 高亮截图/pick 点击拾取
  extract --kind text|table|attr|links|json|grid [--selector <css>] [--attr <name>] [--col <列头文字> --row <N>] [--limit 100]   结构化抽取（只读；text 缺省全文/table 首行表头映射/attr 属性值/links 去重/json JSON-LD+内嵌 JSON/grid 虚拟化网格读数：列头视觉序+visibleRows/totalRows，不滚动）
  grid locate --col <列头文字> --row <N> [--selector <css>] [--keep-scroll] | grid scroll-to --row <N> [--col <列头文字>] [--restore-scroll]   虚拟化网格定位/滚动（有滚动副作用：按列头文字+行号定位→必要时滚动复读；locate 默认还原滚动，scroll-to 默认保留供 extract 复读）
  assert [--count <css>=<n>] [--text <文本>] [--no-console-error] [--url <pattern>] [--attr <css>@<name>=<value>] [--fail-fast]   批量断言（默认失败不中断 exit 0 输出完整明细；--fail-fast 才在首个失败中止 exit 1）
  handoff --reason <事> [--target 页] [--timeout-ms ms] [--signal path] | handoff --wait <id> | handoff --status [<id>] | handoff --cancel <id>   人机接力（2FA/支付/审批交还用户）：start 落盘即返横幅+touch 信号指引；--wait 阻塞至信号/超时；页签永不置前，超时保留
  click --text <文本>|--selector <css>|--point x,y [--dbl] [--nth N] [--no-scroll] [--match exact|contains]   按文本/CSS 定位并真实鼠标点击（Input 域；跨同源 iframe；多候选不猜需 --nth）
  click-at <x,y> [--dbl]                    坐标真实点击（蓝本 clickat 手法；双击=clickCount 1→2 间隔 60ms）
  type --text <值> [--into-text <文本>|--into-selector <css>|--into-point x,y] [--append]   真实输入（默认 Ctrl+A+Delete 清空后 Input.insertText；不给 --into-* 则输入当前焦点）
  key <Enter|Tab|Esc|ArrowDown|Ctrl+A|字母…> [--times N]   真实按键（Input.dispatchKeyEvent 键码表；支持 Ctrl/Alt/Shift/Meta 组合）
  hover --text <文本>|--selector <css>|--point x,y   真实鼠标悬停（单发 mouseMoved）
  wait --text <文本> [--interval 700] [--timeout 30000] [--match exact|contains]   轮询等待文本出现（跨同源 iframe；到时未出现 exit 1）
  wait --expr <JS 表达式> [--interval 700] [--timeout 30000]   轮询等待 JS 表达式为真（truthy；主 frame 不跨 iframe；表达式应为只读幂等；与 --text 互斥）
  console [--listen 3000] [--json] [--out file]   console 取证：Runtime+Log 域监听窗口（连接前历史回放：153 实测 Runtime.enable 回放 console 历史；条目标 pre；全量落 tmpdata/events/console-*.json）
  viewport [WxH] [--dpr N] [--reset]        视口覆盖（Emulation.setDeviceMetricsOverride；**会话级**：命令结束前自动 clear，不跨命令保持、不改真实窗口——跨命令请用 screenshot --viewport 或 flow/MCP 长驻会话）；无参/--reset=兜底清除
  emulate --ua <ua>|--media print|screen [--reset]   UA/媒体模拟（Emulation.setUserAgentOverride/setEmulatedMedia；**会话级**：命令结束前自动双清；--reset=兜底双清）
  dialog [--auto accept|dismiss|cancel] [--text <prompt答复>] [--wait ms=10000]   原生 JS dialog 一次性监听/处置（Page.javascriptDialogOpening→handleJavaScriptDialog）；CDP 无查询 API，短连接不能常驻自动处置——先在后台预埋 --wait 再触发弹窗
  upload <file>[,<file>...] [--into-text <文本>|--into-selector <css>|--into-point x,y] [--nth N] [--browser-path]   向 file input 注入文件（DOM.setFileInputFiles 协议官方通道；路径由浏览器进程解析——两容器文件系统隔离时静默建 0 字节文件，注入后比对 size 不符即 exit 1 防假绿；--browser-path=路径仅在浏览器侧可见，跳过客户端校验、仅验证读回 size>0；非 file input 拒绝）
  drag --from-text <文本>|--from-selector <css>|--from-point x,y --to-text <文本>|--to-selector <css>|--to-point x,y [--steps 5] [--hold 80] [--gap 90]   真实鼠标拖拽（Input 域：hover→press→N 段插值 move→release；复用 flow-engine G3 实证轨迹参数）
  goto <url> [--target 页] [--insecure] [--timeout 30000] [--allow-challenge]   页面导航（协议白名单 http:/https:/file:/about:/chrome:；等 loadEventFired 或 readyState=complete，超时如实 exit 1；--insecure=连接级忽略证书错误，断连即回退；--allow-challenge=bot 盾不阻断仅提醒，默认阻断）
  new [url] [--background] [--insecure] [--allow-challenge]                 新开页签（Target.createTarget；stdout 回显 targetId= 可脚本配对；谁开谁关；--insecure=自签 HTTPS 一步到位；--allow-challenge=bot 盾不阻断仅提醒）
  close <targetId>|--all-but <id>|--match <url/title关键字> [--yes]  关闭页签（id 或唯一前缀；--match 多命中不猜需 --yes；--all-but 必须 --yes）
  select <targetId>                        激活页签（Target.activateTarget；id 或唯一前缀）
  eval --file <path> | <expression>        页面求值（Runtime.evaluate returnByValue+awaitPromise；--file 避 shell 引号地狱）
  a11y [--text <文本>|--selector <css>] [--match exact|contains] [--depth N=8] [--max-nodes 2000] [--timeout ms=10000] [--nth N] [--json]
           a11y 树快照（Accessibility.getFullAXTree；带定位=该元素子树 getPartialAXTree，复用 locator 跨同源 iframe）；--depth 0=全量、默认 8（重页面先 --depth 裁剪，G4）；节点上限截断+计数；浅层优先两段式——超时到点必返（partial+timedOut:true，绝不挂死）
  css --text <文本>|--selector <css> [--match exact|contains] [--computed] [--matched] [--timeout ms=5000] [--nth N] [--json]
           元素样式：computed（页面侧 getComputedStyle；全量键值）与/或 matched 匹配规则来源+属性（CSS.getMatchedStylesForNode；规则上限 200 截断标注）
  popup-guard scan|test|on|off --target <页> [--rules f] [--app slug] [--seconds 60]   广告/推广弹窗拦截（DOM 层守卫；test=dry-run 误杀检验）
  record [--duration ms] [--out] [--target 单页降级] [-v 录屏] [--lock] [--async]  全标签页注入录制（SIGINT/--duration 停止落盘 tmpdata/events/；-v 帧流落 tmpdata/video/；默认无互斥，--lock 可选显式互斥）
  record-stop                                      跨进程优雅停止录制（POST /__stop）
   diff-video <recording.json> [--video-file mp4] [--t0 iso] [--mp4] [--out]   事件流×录屏帧对照报告（chromeuse-videodiff/1，落 tmpdata/videodiff/）
   evidence-pack <recording-*.json|目录>... [--gap-seconds 300] [--out] [--title]   验收回放证据包：多段录制按绝对时间戳归一统一时间轴（timeline.json+README.md 索引式不复制大文件），段间 gap>阈值标记中断（落 tmpdata/evidence/）
  identify [--url <url>] [--target] [--assert-app slug]      应用识别：matchers 分段锚定 + 约束度打分（exit 0 单命中/3 多命中/1 零命中）
  events-summary <events.json> [--out]             事件流确定性预处理：噪声过滤/IME 折叠/类型分布
  recorder-convert <devtools.json> [--out file]    DevTools Recorder 导出 JSON → flow 草案转换（T2 兜底）
  browser-restart [--timeout ms=30000]             优雅重启浏览器（Browser.close + keep-alive 拉起探活）——DevTools 损伤/-32601 环境重置
  browser-up [--timeout ms=20000] [--proxy <url>] | --stop | --status  OS 级拉起调试实例（幂等：端口已就绪=复用；独立 user-data-dir 常驻；--stop 关停/--status 查询；--proxy=Chromium --proxy-server，仅影响被拉起实例）——与 browser-restart 区分：up=进程级启动（无 keep-alive 环境如 Windows 桌面端）/ restart=CDP 级重启（依赖容器 keep-alive）
  doctor [--url] [--timeout ms]                    CDP 通道健康一次性诊断（chromeuse-cdp-doctor/1 JSON：browser/targets 堆积/wsLatency 采样/截图探针/多客户端提示；browser.advisory=版本低于 MCP 已知降级线 94 的提示，非失败）
  doctor-forensics [--target] [--symptom "..."] [--timeout 3000] [--max-targets 3] [--no-control-tab] [--no-front] [--out]   CDP 失效分型取证（chromeuse-cdp-forensics/1：八层 M/A1/A2/B/C/D/E/F/G 判定恒 advisory；通道全死也照常落盘 tmpdata/cdp-forensics/；恢复映射→playbook §失效分型取证协议 v1）
  audit tail [n=20] | audit stats [--days 7]     结构化审计查询（tmpdata/audit/yyyy-mm-dd.jsonl；白名单字段制——无输入值/URL query/Cookie/Token；保留 30 天）
  artifacts report | prune [--apply] [--yes] | pin <path...>   产物配额/保留期（report 分类账覆盖全部登记目录；prune 默认 dry-run；pin 证据永不自动删清单）
  job list | status <id> | cancel <id>             长任务作业（cast/scroll-shot/record/flow replay 加 --async；状态 tmpdata/jobs/；并发满 4 个 E_BUSY 拒绝；cancel 保留已完成产物）

全局选项：--config <path>（指定另一份 config 实例：environment/browserUrl/bin 等整套生效；相对路径按当前 cwd 解析；仅本进程有效，不改默认 config.jsonc）｜--auto-launch（连接前确保本地调试实例就绪：browserUrl 主机为 127.0.0.1/localhost 才幂等拉起/复用，非本地自动跳过；机制 → mechanisms §26）｜--proxy <url>（browser-up / --auto-launch 拉起时注入 Chromium --proxy-server；优先级 CLI --proxy > env CHROMEUSE_BROWSER_PROXY > config.proxy.httpProxy；皆空不注入；仅影响被拉起实例，已启动实例需先 --stop）｜--url <browserUrl>（默认 config.jsonc mcp.browserUrl）｜--timeout <ms>（默认 5000）｜--target <pageId|url子串|title子串>｜-v（= --video 录屏兜底，默认关；未来 verbosity 用 -V/--verbose）｜--no-redact（关输出脱敏，默认开；脱敏规则=config.jsonc redact 段，审计记 action=redact.disabled）
结构化输出：--json（失败时 stdout 输出单行失败信封 chromeuse-cli/1：envelope.name/command/at + ok:false + code + message + retryable/hint/elapsedMs；成功信封逐步迁移，见 references/mechanisms.md）｜不加 --json 时输出与旧版逐字节一致
详见 references/playbook.md §逃生舱`);
}
/* ── extract：结构化抽取（B4/N8 #104；只读） ──
 * 本命令在 --json 放行面外：`extract --json` 由分发层统一 E_USAGE 拒绝且不执行（mechanisms §8.2）。
 * 输出 text 紧凑行；机器消费用 items/count/truncated 的形状由 lib/extract.js 返回。 */
function fmtExtractItem(kind, item) {
  if (kind === 'links') return `${item && item.href}${item && item.text ? '  ' + String(item.text).slice(0, 200) : ''}`;
  if (kind === 'table' || kind === 'json') return JSON.stringify(item);
  return String(item == null ? '' : item).replace(/\s+/g, ' ').slice(0, 400);
}

async function cmdExtract(flags) {
  const kind = flags.kind === undefined ? 'text' : String(flags.kind).trim();
  /* C9：虚拟化网格读数走 extract --kind grid（实现保持在 lib/grid.js；lib/extract.js 只承担五 kind，零改动） */
  if (kind === 'grid') return cmdExtractGrid(flags);
  if (flags.col !== undefined || flags.row !== undefined || flags.match !== undefined) {
    die('--col/--row/--match 仅与 --kind grid 搭配（extract 其它 kind 不接受）');
  }
  let opt;
  try { opt = extractMod.normalizeOptions({ kind: flags.kind, selector: flags.selector, attr: flags.attr, limit: flags.limit }); }
  catch (e) { die(e.message); }
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await extractMod.extract(client, sessionId, Object.assign({}, opt, { timeoutMs: num(flags.timeout, 10000) }));
    console.log(`[extract] kind=${r.kind}${r.selector ? ` selector=${r.selector}` : ''} count=${r.count} truncated=${r.truncated}${r.errors ? ` errors=${r.errors}` : ''} @ ${(target.title || target.url).slice(0, 50)}`);
    r.items.forEach((item, i) => console.log(`  [${i}] ${fmtExtractItem(r.kind, item)}`));
    if (!r.count) console.log('  （零命中：确认 --selector/页面状态；text 缺省读 document.body 全文）');
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* extract --kind grid：虚拟化网格只读读数（C9；不滚动/零合成事件） */
async function cmdExtractGrid(flags) {
  if (flags.attr !== undefined) die('--attr 仅与 --kind attr 搭配（--kind grid 不接受 --attr）');
  let opt;
  try {
    opt = gridMod.normalizeGridOptions({
      selector: flags.selector, col: flags.col, row: flags.row, match: flags.match,
      timeoutMs: num(flags.timeout, 10000),
    }, { requirePair: true });
  } catch (e) { die(e.message); }
  let limit = extractMod.DEFAULT_LIMIT;
  if (flags.limit !== undefined && flags.limit !== null) {
    if (flags.limit === true) die(`--limit 缺值（1~${extractMod.LIMIT_MAX} 的整数，默认 ${extractMod.DEFAULT_LIMIT}）`);
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 1 || n > extractMod.LIMIT_MAX) die(`--limit 须为 1~${extractMod.LIMIT_MAX} 的整数（收到 ${JSON.stringify(flags.limit)}）`);
    limit = n;
  }
  opt.limit = limit;
  const { core, client } = await openClient(flags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await gridMod.extractGrid(client, sessionId, opt);
    printGridExtract(r, opt, target);
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

/* ── extract --kind grid：虚拟化网格读数渲染（C9；只读） ──
 * 读数语义与 C6 纪律一致：列头视觉序（rect.left）、visibleRows/totalRows、指定单元格值+rect+visible；
 * 不滚动——离屏未渲染时明确标注「离屏未渲染≠空值」并指向 grid locate/scroll-to 复读。 */
function printGridExtract(r, opt, target) {
  const title = target ? ` @ ${String(target.title || target.url || '').slice(0, 50)}` : '';
  const total = (r.headers || []).length;
  const vis = r.visibleHeaders || [];
  console.log(`[extract] kind=grid generation=${r.generation || '-'} headers=${total} visibleHeaders=${vis.length} visibleRows=${(r.visibleRows || []).length}/${r.totalRows == null ? '?' : r.totalRows} renderedRows=${r.renderedRows == null ? '-' : r.renderedRows}${r.rowHeight ? ` rowHeight=${r.rowHeight}` : ''}${r.scroll ? ` scroll=${r.scroll.top}/${r.scroll.left}` : ''}${r.warnings && r.warnings.length ? ` warnings=${r.warnings.length}` : ''}${title}`);
  if (!r.found) {
    console.log(`  （零命中：${r.error || '未识别到虚拟化网格容器'}；确认 --selector/页面是否为 react-data-grid——.react-grid-* v6 / .rdg-* v7）`);
    return;
  }
  if (!vis.length) console.log('  （无可见列头：网格可能完全滚出视口/容器零尺寸；headers 总数=' + total + '）');
  vis.slice(0, opt.limit).forEach((h, i) => {
    console.log(`  h[${i}] ${h.text} left=${h.left} w=${h.width} idx=${h.index}`);
  });
  if (r.truncated) console.log(`  …（可见列头截断：${vis.length} > --limit ${opt.limit}）`);
  if (r.target) {
    if (r.matchedAmbiguous > 1) {
      console.log(`  cell 列头="${r.target.col}" row=${r.target.row} 列头命中 ${r.matchedAmbiguous} 个候选，不猜——请用更完整的列头文字（--col）`);
    } else if (r.cellRendered && r.cell) {
      const c = r.cell;
      console.log(`  cell 列头="${c.col}"(idx=${c.colIndex}) row=${c.row} value=${JSON.stringify(c.text)} visible=${c.visible}${c.empty ? '（渲染文本为空：如需确认真空值，滚动复读+截图双向佐证）' : ''}${c.rect ? ` rect={x:${c.rect.x},y:${c.rect.y},w:${c.rect.w},h:${c.rect.h}}` : ''}`);
    } else {
      console.log(`  cell 列头="${r.target.col}" row=${r.target.row} 未渲染：离屏未渲染≠空值——先滚动复读（cdp.js grid locate/scroll-to --col ${JSON.stringify(r.target.col)} --row ${r.target.row}）`);
    }
  }
  (r.warnings || []).forEach((w) => console.log(`  ⚠ ${w}`));
}

/* ── grid：虚拟化网格定位/滚动（C9；有滚动副作用，故不并入只读 extract） ──
 * locate=按列头文字+行号定位→必要时滚动渲染→轮询复读→默认还原现场（--keep-scroll 保留）；
 * scroll-to=只滚动到目标行列并保留现场（--restore-scroll 可还原），供随后 extract --kind grid 复读。 */
function printGridResult(action, out) {
  const r = out.result || {};
  const loc = out.locate || {};
  const cell = r.cell;
  const tgt = r.target || {};
  const title = out.target ? ` @ ${String(out.target.title || out.target.url || '').slice(0, 50)}` : '';
  let line = `[grid] ${action} ✓ generation=${r.generation || '-'} 列头="${out.header || (cell && cell.col) || '-'}" row=${tgt.row} `;
  line += cell ? `value=${JSON.stringify(cell.text)} visible=${cell.visible}${cell.rect ? ` rect={x:${cell.rect.x},y:${cell.rect.y},w:${cell.rect.w},h:${cell.rect.h}}` : ''}` : '（未渲染）';
  line += ` scrolled=${loc.scrolled === true} attempts=${loc.attempts == null ? 0 : loc.attempts}`;
  if (loc.scrolled) line += loc.restored ? ' restored=true（已还原滚动）' : ` restored=false（${action === 'locate' ? '--keep-scroll 保留现场' : '滚动已保留'}）`;
  if (out.matchedBy === 'contains' || loc.matchedBy === 'contains') line += ' match=contains';
  console.log(line + title);
  if (loc.scrollBefore && loc.scrollAfter) {
    let s = `[grid] scroll ${loc.scrollBefore.top}/${loc.scrollBefore.left} → ${loc.scrollAfter.top}/${loc.scrollAfter.left}`;
    if (loc.scrollAfterRestore) s += ` → 还原 ${loc.scrollAfterRestore.top}/${loc.scrollAfterRestore.left}`;
    console.log(s);
  }
  const vr = r.visibleRows || [];
  const shown = vr.slice(0, 5).join(',') + (vr.length > 5 ? ',…' : '');
  console.log(`[grid] visibleRows=${shown || '-'}（${vr.length} 行） totalRows=${r.totalRows == null ? '?' : r.totalRows} renderedRows=${r.renderedRows} rowHeight=${r.rowHeight}`);
  (r.warnings || []).forEach((w) => console.log(`  ⚠ ${w}`));
  if (action === 'scroll-to' && !loc.restored) console.log('[grid] 滚动已保留——复读用 cdp.js extract --kind grid（离屏未渲染≠空值）');
}

async function cmdGrid(pos, flags) {
  const action = pos[0];
  if (!['locate', 'scroll-to'].includes(action)) die(SUB_HELP.grid);
  let opt;
  try {
    opt = gridMod.normalizeGridOptions({
      selector: flags.selector, col: flags.col, row: flags.row, match: flags.match,
      restoreScroll: action === 'locate' ? flags['keep-scroll'] !== true : flags['restore-scroll'] === true,
      timeoutMs: num(flags.timeout, 10000),
    }, { requirePair: action === 'locate' });
  } catch (e) { die(e.message); }
  if (action === 'locate' && !opt.col) die(`${SUB_HELP.grid}\n（locate 须 --col <列头文字> --row <N>）`);
  if (action === 'scroll-to' && opt.row === null) die(`${SUB_HELP.grid}\n（scroll-to 须 --row <N>，--col 可选）`);
  const { core, client } = await openClient(flags);
  let out;
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    out = action === 'locate'
      ? await gridMod.locateGrid(client, sessionId, opt)
      : await gridMod.scrollGrid(client, sessionId, opt);
    out.target = target;
  } finally { await gracefulClose(client); }
  if (!out || !out.ok) {
    const hint = out && out.hint;
    const base = (out && out.message) || '网格定位失败';
    /* 非 --json 路径不打印 envelope.hint → 把可行动提示并入 stderr 文案（C9 验收：hint 含「离屏未渲染≠空值」） */
    const msg = hint && !String(base).includes(hint) ? `${base}；${hint}` : base;
    fail((out && out.code) || 'E_NOT_FOUND', msg, { hint: hint });
  }
  printGridResult(action, out);
  return EXIT_OK;
}

/* ── assert：批量断言（B4/N9 #105） ──
 * 默认失败不中断（exit 0，输出完整明细）；--fail-fast 遇首个失败中止并 exit 1。
 * 判据单源=lib/expect.js buildProbeExpr（text/count）；attr/url/console 的边界见 mechanisms §12。 */
function collectRepeated(argv, names) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq > -1 ? a.slice(2, eq) : a.slice(2);
    if (!names.includes(key)) continue;
    let val;
    if (eq > -1) val = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
    else val = true;
    if (!out[key]) out[key] = [];
    out[key].push(val);
  }
  return out;
}

async function cmdAssert(flags) {
  if (flags['fail-fast'] !== undefined && flags['fail-fast'] !== true) die('--fail-fast 不接受值（无参开关）');
  if (flags['no-console-error'] !== undefined && flags['no-console-error'] !== true) die('--no-console-error 不接受值（无参开关）');
  const multi = collectRepeated(RAW_ARGV.slice(1), ['count', 'text', 'attr', 'url']);
  let assertions;
  try {
    assertions = assertLib.normalizeAssertions({
      count: multi.count || [], text: multi.text || [], attr: multi.attr || [], url: multi.url || [],
      noConsoleError: flags['no-console-error'] === true,
    });
  } catch (e) { die(e.message); }
  if (!assertions.length) die(SUB_HELP.assert);
  /* 旗标冲突裁决（B4/N9）：--url 在 assert 语义是「当前 URL 正则」，不得再被 openClient 当 browserUrl
   * （否则会连到 "about:blank/json/version"）。浏览器地址在 assert 下只走 config；其它命令不受影响。 */
  const browserFlags = Object.assign({}, flags);
  delete browserFlags.url;
  const { core, client } = await openClient(browserFlags);
  try {
    const { sessionId, target } = await core.resolveTarget(client, flags.target);
    const r = await assertLib.runAssertions(client, sessionId, assertions, {
      failFast: flags['fail-fast'] === true, timeoutMs: num(flags.timeout, 5000),
    });
    const passedN = r.results.filter((x) => x.passed).length;
    console.log(`[assert] ${r.passed ? '✓' : '✗'} ${passedN}/${r.results.length} 项通过${r.stopped ? '（--fail-fast 已中止）' : ''} @ ${(target.title || target.url).slice(0, 50)}`);
    r.results.forEach((x, i) => {
      let line = `  [${i}] ${x.passed ? '✓' : '✗'} ${x.kind} expected=${JSON.stringify(x.expected)} actual=${JSON.stringify(x.actual)}`;
      if (x.matches) line += `（命中值 ${x.matches} 个）`;
      if (x.note) line += `（${x.note}）`;
      if (x.error) line += ` error=${x.error}`;
      console.log(line);
      if (x.samples) x.samples.forEach((s) => console.log(`       ! ${s}`));
    });
    if (!r.passed) {
      if (r.stopped) return EXIT_ERR;
      console.log('[assert] 默认失败不中断：exit 0；需要非 0 退出码用 --fail-fast');
    }
    return EXIT_OK;
  } finally { await gracefulClose(client); }
}

const SUB_HELP = {
  // ⚠ 本块由 scripts/build-help.js 从 commands.meta.json 生成（C8a 同源化）：改命令=改 meta + 跑 build，勿手改本块
  audit: '用法：cdp.js audit tail [n=20] | cdp.js audit stats [--days 7] —— 结构化审计查询（V202611030004 B3 N3）：落 tmpdata/audit/yyyy-mm-dd.jsonl（按 CHROMEUSE_TZ_OFFSET 时区按天切分，gitignored；CHROMEUSE_AUDIT=0 关闭）；字段白名单恒为 {ts,cmd,targetHost,targetPath,action,code,phase,elapsedMs,artifact,sessionId}，**绝不记录 DOM 文本/输入值/URL query 原文/Cookie/Token**（targetPath 只留 pathname 截 200）；tail=最近 n 行原样（跨天按日期倒序收集、输出时间正序）；stats=按命令/结果码/日聚合最近 --days 天；审计自身也被审计（exit 0 单点一行）；保留 30 天随 artifacts prune 一并清理',
  artifacts: '用法：cdp.js artifacts report | cdp.js artifacts prune [--apply] [--yes] | cdp.js artifacts pin <path...> | cdp.js artifacts pin --remove <path...> | cdp.js artifacts pin --list —— 产物配额/保留期/pin（V202611030005 B3 N2）：report=按类别列文件数/占用/最旧 + 覆盖全部登记目录（video/cast/scroll-shot/downloads/a11y-baseline/flow-checkpoints/log/events/flow-fail/evidence/cdp-forensics/replay-verdict/videodiff/audit/refs/jobs/locks，每项必出现含 0 文件）；prune=按保留期清理 + 超总配额按固定序（video→screenshot/download→log）淘汰，默认 dry-run（--apply 才删；>500 文件或 >1GB 需 --yes）；证据类（fail-report/evidence/audit）30 天到期清理但**不参与配额淘汰**；other（未登记目录/test-runs/用户材料）永不自动删；pin=证据类永不自动删清单（tmpdata/artifacts-pinned.json）；配额默认总 2GB/单产物 64MB（config.jsonc quota 段）；分类表/口径 → references/mechanisms.md §11',
  job: '用法：cdp.js job list | cdp.js job status <jobId> | cdp.js job cancel <jobId> —— 长任务作业模型（V20261104002 B7 N6）：cast/scroll-shot/record/flow replay 加 --async 即作业化（**须显式 --target**；--async 不支持 --json），主进程立即返回 `jobId=… status=running stateFile=…`；状态文件 tmpdata/jobs/<jobId>.json = {jobId,pid,startedAt,cmdline,status:running|done|failed|cancelled,progress,artifact,exitCode}；并发上限默认 4（CHROMEUSE_JOB_MAX 覆盖），满则 **E_BUSY 拒绝**（消息含 running/上限/重试建议；槽位 tmpdata/jobs/slots/slot-N 以 O_EXCL 原子占用，消灭 TOCTOU）；list=活动+终态（终态保留 600s 后惰性清理；running 但进程已死=孤儿自动标 failed）；status=单作业（终态含 exitCode/artifact；支持唯一前缀）；cancel=取消（record 优先 POST /__stop，统一进程组 SIGTERM→SIGKILL 兜底；已完成产物保留=partial 语义，绝不删产物）；孤儿判定= {pid,startedAt,cmdline} 三元组（防 pid 复用误判）；`--wait <ms>` = E_BUSY 时阻塞重试至超时再试一次；契约 → references/mechanisms.md §14',
  extract: '用法：cdp.js extract --kind text|table|attr|links|json|grid [--selector <css>] [--attr <name>] [--col <列头文字> --row <N>] [--match exact|contains] [--limit 100] [--target 页] [--timeout ms] —— 结构化抽取（只读；跨同源 iframe；零合成事件/零导航）：text=可见文本（省略 --selector 默认 document.body 全文）/ table=表格首行表头映射为对象数组 / attr=匹配元素的 --attr 属性值（须 --attr）/ links=a[href] 去重（绝对 href+文本+title）/ json=JSON-LD 与内嵌 script[type="application/json"]（数组展开一层，解析失败计 errors）/ grid=虚拟化网格读数（react-data-grid v6 `.react-grid-*`/v7 `.rdg-*`：列头视觉序+visibleRows/totalRows；--col/--row 成对读指定单元格；不滚动——离屏未渲染≠空值，先 grid locate/scroll-to 复读）；输出 [extract] 头行 + 紧凑项行（内部结果 {items,count,truncated}，count 为截断前总数；grid 的 items=可见列头文字/视觉序，count=全部列头数，另带 generation/visibleRows/totalRows/cell）；--limit 1~5000 默认 100；本命令不支持 --json（E_USAGE 拒绝面）',
  assert: '用法：cdp.js assert [--count <css>=<n>] [--text <文本>] [--no-console-error] [--url <pattern>] [--attr <css>@<name>=<value>] [--fail-fast] [--target 页] [--timeout ms] —— 批量断言（可多条重复旗标；只读）：count=命中数精确等于 / text=可见文本出现（复用 R1 的 TEXT_EXISTS_V2_SRC 两级漏斗与 buildProbeExpr）/ attr=任一匹配元素的属性值精确等于 / url=当前 location.href 匹配正则（/re/flags 或裸正则；**本命令的 --url 是断言模式，不是 browserUrl——浏览器地址走 config**）/ no-console-error=已有 console 历史（listen 0 缓存回放，Chrome 153 实测）无 exception/error；输出逐项 {kind,expected,actual,passed}；**默认失败不中断（exit 0）输出完整明细**，--fail-fast 才在首个失败中止并 exit 1；本命令不支持 --json（E_USAGE 拒绝面）',
  probe: '用法：cdp.js probe [--target 选择器] [--out 截图路径] [--timeout ms] [--json] —— 三通道各 5s 独立超时（Browser.getVersion → Runtime.evaluate(readyState) → Page.captureScreenshot），输出存活报告（浏览器进程可达即 exit 0；chrome://newtab 类不出帧页自动跳过通道③）；①版本低于 MCP 已知降级线（94，非硬协议门槛）时追加 ℹ advisory 行（提示走 cdp.js 主通道；只提示不改 exit）；--json = chromeuse-cli/1 成功信封，data={url,ok,channels{version:{ok,ms,detail,advisory}|evaluate|screenshot:{ok,ms,detail}}（三通道结论+耗时+版本闸 advisory；①失效时仍发失败信封并带 data）}',
  exec: '用法：cdp.js exec <method> [paramsJSON | --params-file <path>] [--target 选择器] [--insecure] [--timeout ms] —— ⚠ 破坏性命令类别（Target.close*/Page.navigate/Browser.close/Storage.* 等）务必明确 --target 并自担风险；禁 Runtime.evaluate 合成业务事件；**PowerShell/CMD 用户优先 --params-file**（引号吞噬导致 paramsJSON 解析失败时改读 JSON 文件；文件读取复用 eval --file 同款：多行/空/不存在/目录均报错）；--insecure = 连接级忽略证书错误（自签 HTTPS；browser-level 发送，无 sessionId）：**本命令连接存活期间生效、命令结束断连即回退**（秒级时滞+缓存命中例外）；动态应用（WS/持续子资源）整场覆盖用 flow replay --insecure（V20261112001 §17）',
  targets: '用法：cdp.js targets [--json] [--url] [--timeout ms] —— 默认 HTTP /json/list 纯 HTTP 无需 WS；--json = chromeuse-cli/1 成功信封，data = WS Target.getTargets 结构化投影（chromeuse-targets/1：total/attachedCount/byType + targets[{id,type,title,url,attached}]，脚本消费改读 .data.*）',
  net: '用法：cdp.js net [--filter url子串] [--duration ms=5000] [--get requestId] [--out file] [--har path] [--no-redact] —— 采集窗口内记录请求并拉取 body/payload（全量落 tmpdata/events/net-*.json）；默认脱敏（B6b N7）：stdout URL 行 + 落盘 JSON + 审计三处按 config.redact.urlParams（access_token/code/token/key/sign/sessionid/password）与内置 Authorization/Cookie/Bearer 模式替换 <redacted:NAME>，写盘前过滤；--no-redact 显式关（审计记 action=redact.disabled）；--har <path> = 采集结束同步导出 HAR 1.2（lib/har.js 最小子集：log/pages/entries[].request/response/timings；头值按 §16 规则替换为引用 <redacted:NAME>，URL/postData/body 同规则，--no-redact 同放行原值）',
  screenshot: '用法：cdp.js screenshot [--target 选择器] [--out 路径] [--timeout ms=5000] [--dpr 1~4] [--viewport WxH] [--format png|jpeg] [--quality 0~100] [--annotate] [--json] —— --json = chromeuse-cli/1 成功信封（data={target,out,bytes,format,quality,via,recoveredByBackoff,emulation,annotate}）；失败信封 data=chromeuse-screenshot-fail/1 诊断矩阵；默认存 tmpdata/events/screenshot-<时间>.<png|jpg>；截图增强（V202610210001）：--dpr/--viewport = Emulation.setDeviceMetricsOverride **显式**覆盖视口/DPR（B2/B3 治本：MCP 层 DPR/视口不生效、resize_page 后 innerWidth 不变）+ 截图后 clearDeviceMetricsOverride 还原（finally 全路径；还原后读回 innerWidth/DPR 复核，漂移 log.warn 如实报）；不传旗标=全程零 Emulation 命令（V202609080010「不默认 emulate」不冲突）；施加后读 innerWidth/devicePixelRatio 校验生效，不符如实标注 mismatch 不谎报；--format png|jpeg + --quality 0~100（仅 jpeg 携带，png 忽略+告警）控体积，jpeg 缺省质量 **显式 90**（解析顺序 --quality > env CHROMEUSE_JPEG_QUALITY > 90；env 非法值忽略并 warn——不依赖 Chrome 默认，跨版本可复现；--quality 0 是合法值），输出扩展名按 format 决定（--out 扩展名不一致 → 改写+告警；策略=**取证优先**：不让扩展名与真实编码不符，也绝不因参数风格失败；同理 png 传 --quality 只忽略+告警不报错）；失败自动走兜底体系（V202609220002）：诊断矩阵（runtimeCheck/layoutMetricsCheck/fromSurface 双路径）→ allowFallback 裁决 fromSurface:false 降级 → 冷启动退避重试（默认 2s/5s/10s 总窗 17s，CHROMEUSE_SCREENSHOT_BACKOFF=逗号分隔 ms 档位可配，对照截图+轻探针复查）→ screencast 活跃帧兜底（advisory，-v 帧流活着才兜）；最终失败输出 chromeuse-screenshot-fail/1 JSON 报告（含全矩阵+emulation）；**C5 N11 --annotate（V20261104003）**：Node 侧叠字标注——截图前现场物化 ref 表（与 a11y --ref 同编号源，落 tmpdata/refs/），图上叠红框+黄底 @eN 编号（纯 Node zlib PNG + 内置点阵字模，零依赖零字体），stdout 追加 {refs:[{ref,rect}],skipped,refTable}（--json 在 data.annotate）；**零页面副作用**（不注入 overlay/DOM，真实点击仍走 click --ref 的 X1 闸门+三级定位链）；仅支持 --format png；--dpr/--viewport 可组合（覆盖生效期内取坐标）；物化超时/失败/a11y 降级→明确报错不静默降级；**关闭时截图字节不变**（关闭=分支零参与）',
  cast: '用法：cdp.js cast --duration <s> [--out <path.mp4>] [--every-nth 1~30] [--quality 0~100] [--max-width 0~3840] [--no-foreground] [--target 页] [--timeout ms] —— 一次性录屏（二期-4，2026-10-31；GQ-010 F + GQ-001）：Page.startScreencast（format jpeg、quality 默认 70、everyNthFrame 默认 1）收帧 → 到时或连接断开 → Page.stopScreencast（finally 必停）→ bin/ffmpeg 合成 mp4（-framerate <归一 fps> -c:v libx264 -preset veryfast -crf 28 -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -pix_fmt yuv420p（偶数宽高护栏））。**fps 归一（GQ-001 核心）**：Chrome 仅在画面变化时推帧（Chrome 88 静止页实测 6s 仅 1 帧；153 同款稀帧）——fps = 实际帧数 / 首帧→末帧真实跨度（metadata.timestamp；缺失退回 Node 接收时刻，再退录制墙钟），**绝不用标称帧率**（否则静止期被压成快放）；清单 fpsSource 如实标 metadata|arrival|elapsed。**帧数 <2 如实失败**并报帧数/时长/帧间隔（min/median/max），不假装成功。ffmpeg 缺失（复用 lib/scroll-shot.js 的 ffmpegAvailable()/ffmpegBins() 探活）→ 帧文件恒保留 + 清单 + 等价离线合成命令。--duration 0.1~600s（上限防误录爆盘）；--max-width 0=原始分辨率，>0 时请求浏览器降采样；前台保障复用 ensureForeground（hidden/读取失败才 Page.bringToFront，失败 fail-soft 记 note；--no-foreground 显式放弃）；产物 tmpdata/cast/cast-<时间戳>.{mp4,frames/,json}，清单 chromeuse-cast/1 {duration,frames,fps,fpsSource,spanMs,intervalsMs,everyNth,quality,out,bytes,frameDir,timedOut,note}；timedOut=true 表示时长到点正常收工（非失败）；--async = 作业化（**须显式 --target**；主进程立即返回 jobId/status=running/stateFile，进度/终态用 `cdp.js job status <id>` 查；--async 不支持 --json）',
  beacon: '用法：cdp.js beacon [--host 0.0.0.0] [--port 9999] [--dump 目录] —— 零依赖收 POST；NAS 页面侧 URL 用 http://opencode:9999；用完即关（R34）',
  'scroll-shot': '用法：cdp.js scroll-shot [--target 选择器] [--out-dir 目录] [--name 前缀] [--viewport WxH] [--viewport-max-chunk] [--dpr 1~4] [--format png|jpeg] [--quality 0~100] [--max-chunk 4600] [--max-chunk-unit px|css] [--overlap 0] [--no-format-fallback] [--img-promote|--no-img-promote] [--img-settle 1800] [--blank-check|--no-blank-check] [--blank-min-px 800] [--blank-threshold 247] [--blank-strict] [--snap-cuts|--no-snap-cuts] [--snap-window 180] [--snap-px] [--no-foreground] [--settle 200] [--timeout 30000] [--prewarm-samples 20] [--image-timeout 5000] [--keep-slices] [--dry-run] —— 长文/长页长图分段拼接（V202610210002/3/4 + F15，chromeuse-scroll-shot/1）：①图片懒加载（**--img-promote 默认开，--no-img-promote 关**）：预热前遍历 document.images，按 data-src→data-original→data-lazy-src→data-actualsrc→data-backsrc 取真源，仅当 src 仍是占位/空时做**纯属性赋值** img.src=值（不 dispatchEvent/不合成点击，打标 data-cu-promoted="1"），**先只读统计候选再赋值**，等待循环内可补做一轮；⚠ 现场影响：改页面 DOM（触发真实网络图片请求）= 渲染加速，不改业务状态，可用 --no-img-promote 关闭；②滚动预热（逐屏下滚 0.9 视口高/步，每步 settle；到底后文档高度连续 3 次采样不变判稳定，上限 --prewarm-samples；回顶）= **背景图与非图片懒加载兜底**（微信等站点 IntersectionObserver+内部队列不可靠，滚动无法保证图片加载）；③就绪判据 classifyImg 三态（placeholder/pending/loaded）：**naturalWidth > 1 才算 loaded**——占位 SVG 的 naturalWidth 恒为 1（旧判据 complete&&naturalWidth>0 会把 `js_img_placeholder` 占位符误判为已加载 → 长图成段纯白，2026-10-21 他方 140 篇实测）；轮询到 pending=0 或 --image-timeout（默认 5000）超时，之后固定等 --img-settle（默认 1800ms，GIF 首帧解码；0 关）再截图；超时未就绪如实记 imagesPending ②分段 step=min(视口高, chunkCss)，段高 min(step, 文档高-y) 末段防重叠；**--max-chunk 默认按物理像素**（--max-chunk-unit px，默认）：chunkCss=floor(maxChunk/dpr)，不变量=每段物理高 ≤ maxChunk（硬保证）；--max-chunk-unit css = maxChunk 直接当 CSS px（旧行为，物理高可超 maxChunk 属显式选择）；⚠ 默认单位变更 → **dpr>1 时与旧行为不同**（旧=CSS px）；--overlap <css px，默认 0>：**不改变切段位置**，非末段每张向下多拍 overlap（captureHeight=cssH+overlap，末段恒 0，须 < chunkCss），清单记每段 overlapPx——0=几何精确可拼接（机器消费），人工阅读长文用 8 左右避免文字被 4600px 切点劈开 ③取图 A 首选：滚到 y 后 Page.captureScreenshot{clip, captureBeyondViewport:true} 几何精确；A 失败重试 1 次（**重试/降级前均重新落位滚动**，防止超时扰动后拍到错位内容，`repositions` 如实记录：段内次数 + 顶层 scrollRepositions 合计）仍败 → B 兜底：逐视口截图 + bin/ffmpeg vstack（ffmpeg 缺失如实失败，不产错图）；清单记录每段实际 via=A|B ④默认 jpeg q90（PNG 整页 ≈16MB），png 时忽略 quality 并告警；PNG 断链降级（默认开，--no-format-fallback 关）：开跑前按 width×dpr × cssH×dpr 估算，单段 >3000000 px 且 format=png → 打印明确告警+建议（改 jpeg 或减小 --max-chunk，**不改用户格式**）；某段 PNG 两连败（含 WS 断开类错误）→ 该段改 jpeg q90 重试一次，成功则清单记 format=jpeg + formatFallback=png-fail；降级后整轮仍中断 → 保持 failed/partial + missingSlices 如实，不假装成功；⚠ 不做自动重连（WS 断开即止损，重连留后续）⑤--timeout = 单段截图超时（默认 30000，非整页）；总预算 = 段数 × 单段，超预算中止剩余段 status=partial；单段失败不整轮报废，记 failedSlices 继续下一段 ⑥--dpr/--viewport 只在显式时施加 Emulation（不默认 emulate），finally 还原视口 + 回滚原 scrollY（失败如实记录）⑥b--viewport-max-chunk（显式布尔）：运行期用 Emulation 把视口**高度设为 chunkCss**、宽度取 --viewport 的宽（未给则当前 innerWidth）、DPR 取 --dpr（未给=原生）；与 --viewport 同时给时高度以本旗标为准（宽度沿用）并打印实际生效值说明覆盖关系；隐含显式 Emulation → finally 必须还原，**不给该旗标时依旧零 Emulation 命令**；副作用红利=step==viewportH 等价视口截图，规避 beyond-viewport 大 clip ⑦--dry-run 只做布局测量+预热探测+分段计划输出（不落图）⑧空白段自检（F13，**默认开且 advisory**）：每段落盘后（A/B/PNG→JPEG 降级段一律）用 bin/ffprobe 取图高 → bin/ffmpeg `scale=1:H:flags=area,format=gray` 取"每行平均亮度"字节流（只读原图、不重编码；输出全走 stdout）→ 连续满足 `luma >= 247` 且长度 ≥800 物理 px 的行判"疑似空白段"；段字段 blank{suspect,ratio,runs(≤5 条,{from,to,rows}),rows,threshold}，顶层 blankSummary{segments,suspect,suspectIndexes,minPx,threshold,ffmpeg,note,elapsedMs}；**默认只报告不改退出码**（他方 140 篇实测：剩余可疑段经 DOM 复验 remaining=0、截图高=文档高，属**原文设计留白**，见白即失败会造成大量误报）；--blank-min-px（默认 800 物理 px，0=任意游程都报）、--blank-threshold（默认 247，0~255，比 248 低 1 档容 JPEG q90 噪声）可调；--blank-strict 才让可疑段 → 退出码 1（**清单 status 仍记 ok**，另加 blankSummary.strictFail=true——避免把"截图失败"与"内容留白"混为一谈）；--no-blank-check 关；ffmpeg/ffprobe 缺失或调用失败 → blankSummary.ffmpeg=false + 一行提示，**不阻断截图**（fail-soft）；--dry-run 不检测（没图）⑨永不关闭用户页签⑩前台保障（V202610220003，**默认开**）：进入时读 document.visibilityState（hidden 或读取失败才 Page.bringToFront + 复核，原本 visible 不做多余动作）——**后台页签 raw Page.captureScreenshot 实测会 30s 超时甚至返回旧帧（静默错图）**（同页同位置：后台 30015ms 超时 / bringToFront 后 592ms 正确）；清单 foreground{beforeVisibility,afterVisibility,broughtToFront,userWasOnOtherTab,note}；**默认不自动还原前台**（Chrome 无「查询上一活跃 target」稳定 API，瞎切可能切走用户页签）——broughtToFront=true 时可能已把前台从用户页签切走，如实记录不隐瞒；--no-foreground 显式放弃保障（检测到 hidden 时打印强告警：可能超时/旧帧）⑪切点吸附空白带（F15，**默认开**，--no-snap-cuts 关）：固定切点会把标题栏/产品卡拦腰截断——分段前**一次只读** evaluate（RECTS_EXPR）取可见内容元素 rect（有直接文本节点的元素+替换元素；排除 display:none/visibility:hidden/零面积/position:fixed|sticky），纯函数 snapCuts 顺序推进：每刀以「上一刀+step」为目标，在 ±--snap-window（默认 180 CSS px，32~512）内找「不与任何元素 rect 相交的水平空白带」（最小 12 CSS px）取带中点；**「只向短方向吸附」落地解读**：原切点已在带内→位移 0；否则取带中点；**不为吸附把段拉长（段高不超 max-chunk 计划值）**——三条硬约束 ①段高 ≤ chunkCss ②相邻段 ≥ viewport/4 ③切点 ∈ (0, 文档高)（终点 clamp 到文档高；依据 `webapps/wechat-mp/webapp.md` L77 他方实测记录）；越界 clamp 到边界，clamp 后不在带内→放弃该切点（method:none），末段不吸附；清单段级 snap:{from,to,shift,method:dom|px|none} + 顶层 snapConfig{enabled,windowPx,pxFallback}；--snap-px 开像素法兜底（DOM 无合格带的切点用已落盘段图的 F13 行剖面在段尾 ±window 图内可见部分找带，ffmpeg 缺失/失败/无带 fail-soft 回落原切点；命中则本段 cssHeight/overlapPx 调整 + 尾部按新切点滚动推进重排）；吸附整体异常→全部原切点+stderr 一行告警+清单 note，不阻断截图；--dry-run 只算 DOM 法（无图不跑像素法，如实记 note）；--async = 作业化（**须显式 --target**；主进程立即返回 jobId/status=running/stateFile，进度/终态用 `cdp.js job status <id>` 查；--async 不支持 --json）；⑫beyond-viewport 自动探测（ISSUE-1）：长页首跑双拍对比（captureBeyondViewport true/false；尺寸差主判 + md5 同负判，md5 异时补控制拍区分页面动画）→ 结果缓存 tmpdata/state/beyond-viewport.json（key=浏览器版本，手删即重探）；判定不支持时 A 路径改走段级 Emulation 撑视口无 clip（清单 via=A2），失败仍落 jpeg 降级→B 兜底',
  watch: '用法：cdp.js watch [--interval 10] [--window 120] [--max-seconds N] [--target 选择器] —— 循环 probe；轻探针+截图双死持续 ≥window 判冻结，输出恢复命令建议不自动杀；exit 0=正常退出 2=判定冻结 1=错误',
  flow: '用法：cdp.js flow validate|replay|lint <file.flow.json> [--var k=v] [--var-json \'{"k":"v"}\'] [--target 选择器] [--keep-tab] [--lock] [--insecure] [--no-hit-test] [--post-verify] [--no-kind] [--allow-challenge] [--challenge-wait-ms ms=15000] [--json] —— --json = chromeuse-cli/1 成功信封（data={ok,reportPath,summary}；回放失败同样带 data，报告本体在 reportPath；进度行转 stderr）；flow 引擎；18 原语（计数真源=lib/flow-engine.js ACTIONS.length；V2 表达力 eval/set/cond/loop）/四层定位/真实 Input 事件；原生 DPR 回放不 emulate（emulate 原语为可选工具）；应用安全阀校验 matchers；--lock = 可选显式互斥（默认无互斥——2026-10-19 用户裁定：锁只保留「打开页签并获取 pageId」层=tab-helper 锁页 CAS；多客户端共连干扰风险由纪律兜底）；--no-hit-test 关 X1 四层命中闸门（默认开）；--post-verify 开 X4 点击后复核（实验，默认关）；--no-kind 关 kind 语义层软评分（默认开，同 flow _meta.kind:false）；未指定 --target 时自建标签执行并自关；失败输出结构化报告到 tmpdata/flow-fail/；flow lint <file> = lintContracts 铁律静态机检（M1 闸门-点击同描述符/M2 歧义文本登记/M3 盲等证据/M6 循环高迭代——authoring 期 advisory，不改判回放；ambiguousTexts 从 webapps/<app>/webapp.md 解析，未登记则 M2 跳过；有违例退出码非 0）；--popup-guard = 回放期广告/推广弹窗拦截（P1 A 路线 DOM 守卫，默认关：target 选定后、首步 goto 前预埋 addScriptToEvaluateOnNewDocument + 对已加载页即时执行一次，finally 配对清理移除注册+页侧 observer.disconnect——共享浏览器现场还原；规则双层=webapp 有 popup-rules.jsonc 整体为准/无则全局 config/popup-rules.jsonc；拦截留痕读 window.__cu_pg_log 输出条数+规则 id 归并）；--popup-rules <file> = 显式规则文件（跳过 app/全局加载）；--async（仅 replay）= 作业化（**须显式 --target**；立即返回 jobId/status=running/stateFile，进度/终态用 `cdp.js job status <id>` 查；--async 不支持 --json）；--insecure（仅 replay）= 连接级忽略证书错误（browser-level，连接存活期=**整场回放覆盖**、断连即回退）——自签 SPA 的 WS/持续子资源正确挂点；与 --async 组合经 argv 原样转发自动继承（V20261112001 §17）；**C4 bot challenge（#124）**：每个 goto 步导航就绪后做同款只读检测（lib/challenge.js 单源：五类信号多信号合取/六墙+captcha+access denied）——默认命中即失败停步（失败报告 error.code=CHALLENGE_DETECTED，--json 信封码 E_POLICY_DENIED），--allow-challenge 仅告警继续；等待预算 CLI --challenge-wait-ms > _meta.challengeWaitMs > 默认 15000ms，_meta.allowChallenge:true 亦可声明放行',
  locator: '用法：cdp.js locator probe|suggest|verify|pick [--text X] [--match exact|contains] [--role R] [--dom-path CSS] [--container \'<json>\'] [--js-listeners] [--cursor-pointer] [--target <pageId|url子串|title子串>] [--json] —— --json = chromeuse-cli/1 成功信封（data=旧 locator 报告；suggest 未收窄/verify 无候选或高亮失败/pick 超时为失败信封且带 data）；元素捕获/定位验证工具（V202610190001，跨同源 iframe；语义对齐 target-resolver 的 X1 闸门/container 文法）：probe=列候选（framePath/tag/rect/visible/offsetParentOk/hitOk/area/cssPath + 唯一性结论；不可见项也如实列出供诊断）｜suggest=递归收窄（多候选→共同祖先链逐级构造 container:{text|domPath} 重算，唯一即止；跨 frame 如实报 cross-frame）｜verify --target-json \'<flow target>\'=解析 best→高亮（Overlay+CSS outline）+ 截图（默认 tmpdata/events/locator-<stamp>.png，--no-screenshot 关；--ms 高亮时长默认 3000）供读图视觉确认｜pick [--seconds 60] [--no-block]=注入一次性 capture-phase 点击拾取器（DevTools select element 式；拾取即自摘；默认 preventDefault/stopPropagation 不触发业务动作），输出三层描述符+唯一性复算+建议 target JSON。退出码：probe/verify 采集成功=0（非唯一仍 0，结论见输出）；suggest 未收窄/pick 超时=1。**B4 候选诊断**：probe 候选追加 disabled/readOnly/aria-disabled/cursor:not-allowed + interactability 一句话判读（「控件被禁用/只读——非定位失败」；不改 X1 判定）。**C11 N12 候选扩展（仅 probe，默认关）**：--js-listeners=CDP DOMDebugger.getEventListeners（零 Debugger 前提）全页直接 click 监听节点并入候选（source=js-listener；只覆盖直接监听——React 根委托元素级不可见、handler 源码不可得；能力不支持按 error.code 能力闸降级不崩）；--cursor-pointer=getComputedStyle cursor:pointer 兜底候选（与 --js-listeners 可组合；可单独作为锚点）；新旗标只扩候选/加 source 标注，X1 判定与默认输出逐字节不变',
  click: '用法：cdp.js click --text <文本>|--selector <cssPath>|--point "x,y"（或 --x,y "x,y" / --x N --y M）|--ref @eN [--match exact|contains] [--nth N] [--dbl] [--no-scroll] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms=10000] [--json] —— --json = chromeuse-cli/1 成功信封（data={target,via,spec,element,point,clickable,scrolled,double,clicks}；定位失败为 E_LOCATE 失败信封且 data 带诊断；--expect-* 激活时 data 追加 phase/effect，stalled=报告型失败 E_TIMEOUT）；按文本/CSS 定位并**真实鼠标点击**（Input.dispatchMouseEvent：mouseMoved→mousePressed→mouseReleased，isTrusted=true，红线一）；文本/CSS 定位复用 lib/locator 跨同源 iframe + X1 四层闸门（visible/offsetParent/elementFromPoint）；**多候选不猜**=报候选清单需 --nth N 显式选定或收窄；目标在视口外默认对最高排序候选 scrollIntoView 一次后重采（只滚动不改 DOM；--no-scroll 关）；--dbl/--double=双击（clickCount 1→2，60ms 间隔）；MCP uid 是快照期临时句柄 raw CDP 无法解析——--uid 显式拒绝，用 --selector/--text。**--expect-* = 交互后生效判据**（至多一种；裸命令不带=旧行为逐字节不变、零额外 CDP）：confirmed=判据在 --effect-ms 窗口内成立 / effect_pending=有可观察进展但判据未成立（exit 0，**非成功非失败**，调用方须继续观察）/ dispatched=--no-wait-effect 送达即返 / stalled=窗口内零进展（exit 1，stderr+信封 hint 给 screenshot/console/wait/doctor 取证指引）；--expect-value 主体值口径：input/textarea/select 读 value，其余读文本（trim）；--effect-ms 默认 30000、范围 500~180000；**--ref @eN = a11y --ref 产出的引用句柄**（与 --text/--selector/--point 互斥、不接受 --nth/--match）：解析链=cssPath（身份标记确认）→role+name→container 收窄，命中唯一才点；导航/刷新/元素被替换/定位链命中 0 → E_REF_STALE，命中 >1 → E_AMBIGUOUS，都不猜不点错；失效即重新 a11y --ref',
  'click-at': '用法：cdp.js click-at <x,y> [--dbl] [--target 页] [--timeout ms] —— 坐标直点（真实 Input 域鼠标事件；双击=clickCount 1→2 间隔 60ms，蓝本 clickat 手法）。坐标是视口 CSS 像素（含 iframe 偏移由 locator 计算，手喂坐标自行换算）',
  type: '用法：cdp.js type --text <值> [--into-text <文本>|--into-selector <cssPath>|--into-point "x,y"|--ref @eN] [--match exact|contains] [--nth N] [--append] [--echo-text] [--no-redact] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms] [--json] —— --json = chromeuse-cli/1 成功信封（data={target,into,append,cleared,value,valueChars,valueEcho,active,focusEditable,clicked}；测试输入值默认不回显：value=null+valueChars=长度，--echo-text 才回显且仍过脱敏；--expect-* 激活时追加 phase/effect，stalled=报告型失败 E_TIMEOUT）；真实键盘输入：默认先 Ctrl+A 全选 + Delete 清空再 Input.insertText（蓝本手法，受控组件/输入法更稳）；--append=不清空直接续写；--into-* = 先按该定位真实点击聚焦（省略=当前焦点）；发送后只读 evaluate 复核 activeElement 可编辑性与实测值，焦点不在可编辑元素时如实告警（输入可能无效）；**--echo-text** 显式回显输入值/实测值（默认只打字符数：原默认打印输入值=现存泄漏路径，B6b 收紧）；**--text "%KEY%"** 占位符输入（secretsFile 或同名环境变量提供真值；真值只进 CDP insertText，stdout/JSON 只显示 <placeholder:KEY>）；**--no-redact** 关输出脱敏（默认开；审计记 action=redact.disabled）；**--expect-value** 读交互主体元素（--into-* 的定位候选；无则 document.activeElement）当前值精确比较（表单控件读 value；其余读文本）；--expect-* 四态/exit/默认 30000 语义同 click（裸命令逐字节不变）；**--ref @eN**（别名 --into-ref）= 用 a11y --ref 的引用句柄聚焦（与 --into-* 互斥；失效契约同 click：E_REF_STALE/E_AMBIGUOUS 不猜）',
  key: '用法：cdp.js key <Enter|Tab|Esc|Backspace|Delete|Space|ArrowUp/Down/Left/Right|Home|End|PageUp|PageDown|F1~F12|字母|数字|标点> [--times N=1] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] —— 真实按键（Input.dispatchKeyEvent keyDown/keyUp，键码表单源 lib/drive.js KEY_TABLE；text 规则：字符键=字符、Enter=\\r、Space=空格、导航/功能键无 text）；组合键 Ctrl+A / Shift+Tab / Ctrl+Shift+ArrowLeft（修饰位 Alt=1/Ctrl=2/Meta=4/Shift=8；带 Ctrl/Alt/Meta 时不产字符）；--expect-* 四态 phase/exit 语义同 click（主体元素=document.activeElement；本命令不支持 --json，phase 见 stdout/stderr；裸命令逐字节不变）',
  hover: '用法：cdp.js hover --text <文本>|--selector <cssPath>|--point "x,y"|--ref @eN [--match exact|contains] [--nth N] [--no-scroll] [--target 页] —— 真实鼠标悬停（单发 Input.dispatchMouseEvent mouseMoved；同 click 的定位/多候选不猜/视口外滚入规则；用于展开 hover 菜单/浮层）；--ref @eN = 引用句柄（a11y --ref 产出，解析链/失效契约同 click）',
  wait: '用法：cdp.js wait --text <文本> | --expr <JS 表达式> [--match exact|contains] [--interval 700] [--timeout 30000] [--target 页] [--json] —— --json = chromeuse-cli/1 成功信封（data={found,text|expr,match?,waitedMs,polls,value?,candidate?,target}；超时为 E_TIMEOUT 失败信封且 data.found=false）；轮询等待文本出现（lib/locator 跨同源 iframe 收集；节距默认 700ms 蓝本实测参考、总超时默认 30000ms、上限 600000ms）；到时未出现 exit 1 并报轮询次数。注意 --timeout 在本命令语义是**总等待预算**（单次 evaluate 另按 5000ms 上限）；--expr <JS 表达式> = 轮询 Runtime.evaluate truthy（returnByValue+awaitPromise；与 --text 互斥，同给 E_USAGE）：主 frame 执行**不跨 iframe**（iframe 内状态自写 frames[x].document…）；表达式异常/求值失败记最后错误**继续轮询**，到时未为真才 exit 1（报轮询次数+最后错误）；表达式应为**只读幂等**；等待读数链路=goto --insecure 一次导航 + 后续读命令不带旗标（wait 不在 --insecure 四命令面——只读 evaluate 零证书校验触发；V20261112001 §17 附节）',
  console: '用法：cdp.js console [--listen 3000] [--json] [--out file] [--target 页] [--timeout ms] —— --json = chromeuse-cli/1 成功信封（data=旧 chromeuse-console/1 报告，脚本改读 .data.*）；console 取证（Runtime.enable + Log.enable 短连接监听窗口）：收 Runtime.consoleAPICalled / Runtime.exceptionThrown / Log.entryAdded，到时打印后退出；**CDP 无任意长度历史**——Chrome 153 实测 `Runtime.enable` 会回放 console 历史（11 条）；`Log.enable` 未观测到 console API 条目（只收浏览器/网络日志）；Chrome 88 是否回放未验证（能力差异，见 88 分叉清单）。条目按 timestamp 标 pre:true 为「连接前缓存」；--listen 0 = 只读浏览器侧 console 缓存（短排水窗 120ms）立即返回；上限 300000ms；全量报告（ts/url/line/stack 首帧）恒落 tmpdata/events/console-<stamp>.json。排错顺序：先在页面上复现动作前起 listen，或改用 MCP list_console_messages（自带缓冲）',
  viewport: '用法：cdp.js viewport [WxH] [--dpr N] [--reset] [--target 页] [--timeout ms] —— 视口覆盖（Emulation.setDeviceMetricsOverride；WxH 形如 1000x700，--dpr 1~4）；无参或 --reset = clearDeviceMetricsOverride 兜底清除。**会话级语义（Chrome 153 实测）**：Emulation 覆盖只在施加它的 CDP session 存活期间对全浏览器可见，session 断开即被 Chrome 清理——因此本命令在结束前**自动还原**（stdout 打印前/中/后三段实测值供核对），不跨命令保持、不修改真实窗口大小（dontSetVisibleSize:true）。需要在后续命令/截图里保持视口 → 用 screenshot --viewport（一次性截图、finally 还原）或 flow 回放 _meta.viewport / MCP resize_page（长驻会话）。⚠ 视口礼仪（playbook §视口三态策略 / SKILL 红线）：本命令=操作者显式意图，与 flow 回放三态策略（在场纯跟随/不在场托底）互不干涉，仅服务交互式操作/调试；绝不给用户页签留 Emulation 残留',
  emulate: '用法：cdp.js emulate --ua <ua>|--media print|screen [--reset] [--target 页] [--timeout ms] —— UA/媒体模拟（Emulation.setUserAgentOverride / setEmulatedMedia；media 仅 print|screen）；--ua 与 --media 可同给。**会话级语义（Chrome 153 实测）**：模拟只在施加它的 CDP session 存活期间生效，session 断开即回原生——本命令结束前**自动双清**（UA + media），stdout 打印前/中/后三段实测值。清除路径：先试 clearUserAgentOverride/clearEmulatedMedia，遇 -32601（Chrome 153 已无这两个 clear 命令）回落 setUserAgentOverride{userAgent:""}/setEmulatedMedia{media:""}（88 兼容就地分叉）；--reset = 只做双清兜底。跨命令保持模拟 → 用 flow emulate 原语或 MCP 长驻会话',
  dialog: '用法：cdp.js dialog [--auto accept|dismiss|cancel] [--text <prompt答复>] [--wait ms] [--target 页] [--timeout ms] —— 原生 JS dialog（alert/confirm/prompt/beforeunload）一次性监听/处置：Page.enable → 听 Page.javascriptDialogOpening → 按 --auto 发 Page.handleJavaScriptDialog（cancel=dismiss 别名），窗口内首个事件后退出。**CDP 无「查询当前挂起对话框」API**：①无 --wait/--auto=400ms 短观察窗（仅捕获窗口内新开 dialog，监听前已打开的不会回放），失败 exit 1 并说明限制；②--auto 未给 --wait=默认 10000ms 监听窗；--wait 域 100~600000ms；③一次性短连接无法常驻自动处置——正确用法=先在后台跑本命令预埋监听，再由另一命令触发弹窗；④无 --auto 只报告不处置（页面仍阻塞）；⑤--text 仅 --auto accept 的 prompt 答复可用',
  upload: '用法：cdp.js upload <file>[,<file>...] [--file <path>] [--into-text <文本>|--into-selector <cssPath>|--into-point "x,y"] [--match exact|contains] [--nth N] [--no-scroll] [--browser-path] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms] —— 向 file input 注入文件（DOM.setFileInputFiles——CDP 官方文件注入通道，不是 DOM 合成事件，红线一不涉及）：支持多文件（逗号分隔/多个位置参数/--file；去重），路径按进程 cwd 解析为绝对路径并校验存在/普通文件/可读。⚠ **files 路径由浏览器进程解析**：客户端与浏览器文件系统隔离时 Chrome 不报错——静默创建 0 字节 File（只有名字）；因此注入后**比对本地 size 与浏览器读回 files[].size，不符如实 exit 1（防假绿）**。`--browser-path` = 路径只在浏览器进程可见（如 chrome-browser 容器的 /config/Downloads）：**须传浏览器侧绝对路径**（POSIX 与 Windows 盘符双标准），原样下发不做本地 resolve（否则 Windows CLI 会给容器路径加盘符）；跳过客户端存在性校验，内容校验降级为「读回 size>0」（0 字节按失败收割）。定位复用一期 interactSpec（--into-text/--into-selector/--into-point；省略=当前焦点）；非 <input type="file"> 拒绝并提示（disabled/multiple=false 多文件同样拒绝）；注入后读回 files 名列表复核；--expect-* 四态 phase/exit 语义同 click（本命令不支持 --json；裸命令逐字节不变）',
  drag: '用法：cdp.js drag --from-text <文本>|--from-selector <cssPath>|--from-point "x,y"（或 --from-x,y / --from-x N --from-y M） --to-text <文本>|--to-selector <cssPath>|--to-point "x,y"（或 --to-x,y / --to-x N --to-y M） [--steps 5] [--hold 80] [--gap 90] [--nth N] [--to-nth N] [--no-scroll] [--expect-text <文本>|--expect-value <值>|--expect-selector <css>|--expect-count <css>=<n>] [--effect-ms ms=30000] [--no-wait-effect] [--target 页] [--timeout ms] —— 真实鼠标拖拽（Input 域：mouseMoved(buttons:0)→mousePressed(left,buttons:1)→N 段插值 mouseMoved(left,buttons:1)→mouseReleased(buttons:0)；坐标=CSS 视口 px，附 screenX/Y 忠实映射）。轨迹参数复用 flow-engine drag 原语已实证值（G3 报告 §5.6：5 段/90ms 段间/80ms hold；planDragPath 单源）——--steps 1~50（默认 5，防网站对速度敏感）、--hold/--gap 0~5000ms。两端各三选一（文本/CSS/坐标），多候选不猜需 --nth/--to-nth；视口外默认 scrollIntoView 一次（--no-scroll 关）；收尾语义：released 后 dragend 即终点，DOM mouseup 被拖拽管线消费，断言勿锚 mouseup；--expect-* 四态 phase/exit 语义同 click（主体元素=落点候选；本命令不支持 --json；裸命令逐字节不变）',
  goto: '用法：cdp.js goto <url> [--target 页] [--insecure] [--timeout ms=30000] [--allow-challenge] [--challenge-wait-ms ms=15000] [--json] —— --json = chromeuse-cli/1 成功信封（data=page.navigate 结果 + target/redirected；超时/网络错误为失败信封且带 data；C4 challenge 阻断=E_POLICY_DENIED 失败信封带 data.challenge）；页面导航（Page.navigate）：协议白名单 http:/https:/file:/about:/chrome:（chrome:// 仅诊断场景；javascript:/data:/ftp: 等拒绝，业务写操作走 Input 域）；等待=Page.enable → Page.navigate → 同时听 Page.loadEventFired + 轮询 document.readyState，用 Page.frameNavigated（主 frame）标记新文档提交（防导航提交前读到旧页 readyState=complete 的假完成）；Page.enable 失败退化为纯 readyState 轮询（结果标 pageEnabled:false）；--timeout = **总加载预算**（默认 30000ms，500~600000ms），超时/网络错误如实 exit 1（不伪装成功）；同文档导航（无 loaderId）立即返回；输出最终 URL（重定向后）+ readyState/loadEvent/轮询次数；--insecure = 连接级忽略证书错误（自签 HTTPS；browser-level 发送，无 sessionId）：**本命令连接存活期间生效、命令结束断连即回退**（秒级时滞+缓存命中例外）；动态应用（WS/持续子资源）整场覆盖用 flow replay --insecure（V20261112001 §17）；**C4 bot challenge（#124）**：导航完成后只读页侧扫描（title/正文/DOM/Cookie 名/全局变量五类信号，特征表 lib/challenge.js 数据化单点可热修；六墙 Cloudflare/Akamai/DataDome/PerimeterX/Imperva/AWS WAF + 通用 captcha 墙 + access denied 页），单墙命中 ≥2 类**不同**信号才判定（多信号合取防误报）；默认命中即阻断（exit 1，码 E_POLICY_DENIED，消息前缀 CHALLENGE_DETECTED，附接管提示+禁自解/禁连环重试）；CF 类非交互盾先有限自愈等待（默认 15000ms，每 800ms 重检；--challenge-wait-ms 可配，0=不等待）；--allow-challenge = 不阻断仅提醒（exit 0，效率优先自担风险）；非 http(s) 页（file:/about: 等）不检测',
  new: '用法：cdp.js new [url] [--background] [--insecure] [--timeout ms] [--allow-challenge] [--challenge-wait-ms ms=15000] —— 新开页签（Target.createTarget；缺省 about:blank，URL 同一协议白名单）；默认前台打开（--background 后台）；**stdout 恒回显完整 targetId=**（可脚本化配对：TID=$(node tools/cdp.js new https://x | sed -n \'s/.*targetId=\\([^ ]*\\).*/\\1/p\')）；**页签礼仪：谁开谁关——agent 开的页签任务结束必须 close**；--insecure = 连接级忽略证书错误（自签 HTTPS；browser-level 发送，无 sessionId）：**本命令连接存活期间生效、命令结束断连即回退**（秒级时滞+缓存命中例外）；动态应用（WS/持续子资源）整场覆盖用 flow replay --insecure（V20261112001 §17）；**C8 页签治理（#123）**：新开页签登记 tmpdata/tab-registry/agent-tabs.json（agent 标记；**未登记=用户页签永不回收**），about:blank 尽力设 title 前缀 cu-（页面导航后会被站点覆盖，权威标记=注册表；targets 文本对登记项打 [cu]）；new 末尾顺带回收空闲 agent 页签（默认 10min；config tabs.reclaim/idleMs/markPrefix/maxPerRun 可调，env CHROMEUSE_TABS_RECLAIM=0 一键关）；**C4 bot challenge（#124）**：URL 非 about:blank 时附着新页签、等页侧就绪（≤8000ms）后做同款只读检测（特征表/多信号合取/有限自愈等待全同 goto）——默认命中阻断（exit 1，E_POLICY_DENIED，CHALLENGE_DETECTED），--allow-challenge 仅提醒；**targetId 仍恒回显**（脚本契约不变）',
  close: '用法：cdp.js close <targetId> | --all-but <保留 targetId> | --match <url/title 关键字> [--yes] [--timeout ms] —— 关闭页签（Target.closeTarget，仅 page 型）：<targetId> 支持完整 id 或唯一前缀（多前缀不猜=列候选 exit 1）；--match 按 url/title 大小写不敏感包含匹配——**唯一命中直接关；多命中不猜，无 --yes 只列候选并 exit 1（不关任何一个）**；--all-but 是批量破坏面，**必须 --yes** 才执行，无 --yes 只列将关闭清单；stdout 逐条回显 targetId 供配对；partial 失败逐个如实报并 exit 1；**C8（#123）**：close 末尾顺带回收空闲 agent 页签（仅注册表项；用户页签永不回收；job 运行/lock 未过期/handoff 等待中跳过本轮）',
  select: '用法：cdp.js select <targetId> [--timeout ms] —— 激活页签（Target.activateTarget；id 或唯一前缀，多前缀不猜列候选 exit 1）；用于 new/goto 后把页签置前做视觉/截图确认',
  eval: '用法：cdp.js eval --file <path> | cdp.js eval <expression> [--target 页] [--timeout ms] —— 页面求值（Runtime.evaluate returnByValue:true + awaitPromise:true + userGesture:false）：--file 读文件内容作 expression（**避 shell 引号地狱**，多行/引号/反引号安全）；内联表达式为便捷入口；文件空/目录/不可读建连前报错；表达式抛异常如实 exit 1（打印异常描述+行号）；返回值 JSON 打印（undefined/unserializable 如实标注）',
  a11y: '用法：cdp.js a11y [--text <文本>|--selector <css>] [--match exact|contains] [--depth N=8] [--max-nodes 2000] [--timeout ms=10000] [--nth N] [--mark-js] [--group] [--ref [--max-refs N=50] [--locator]] [--json] [--target 页] —— --json = chromeuse-cli/1 成功信封（data=旧 chromeuse-a11y/1 报告，脚本改读 .data.*；超时/降级/定位失败为失败信封且带 data）；a11y 树感知（只读；Accessibility 域，零 Input/零页面副作用）：无定位=主文档整树 Accessibility.getFullAXTree；--text/--selector=该元素子树（Accessibility.getPartialAXTree，复用 locator 跨同源 iframe；--text 匹配 DOM 文本而非 a11y name，图标按钮用 --selector；多候选不猜需 --nth，--text 可加 --match exact|contains）。**体积控制（G4）**：--depth 默认 8（CDP 层数，root=第 1 层；0=全量；重页面先 --depth 裁剪），节点上限 --max-nodes 默认 2000（**输出**上限：CDP 响应仍为请求深度内的全量，客户端截断+omitted 计数）。**超时到点必返（GQ-010 B）**：--timeout 默认 10000ms，浅层优先两段式（depth=3 用 35% 预算，深段用剩余）——深段超时返回浅层真实 partial + timedOut:true（exit 1），第一段即超时返回空树+timedOut:true，绝不挂死；超时/失败 stderr 提示替代通道（cdp.js exec DOM.getDocument / screenshot）。输出=紧凑缩进行 `role "name摘要" (x,y wxh) [F/C/D]`（F=focusable，C=可点击角色，D=disabled；bounds 仅前 150 个节点取框，其余省略）；--json=chromeuse-a11y/1（nodeCount/truncated/timedOut/partial/depthMode/stages/nodes）。iframe：只输出 CDP 主文档树（同源 iframe 内容用 --text 定位进入其子树）。**--ref（B5 引用句柄）**：每行前缀 @eN（e1 起、行序稳定），并把引用表落 tmpdata/refs/<targetId>.json（framePath/role/name/cssPath/container/rect/backendNodeId/代际 loaderId）；只收 clickable|focusable 且已取得 rect 的节点（前 150 bounds 限内），--max-refs 默认 50；--locator 附可持久化定位器（供 flow 固化）。**v1 边界**：全树 @eN 只覆盖主文档，跨 frame ref 用 --text/--selector partial 树（带 framePath）。消费 = click/type/hover --ref @eN（三级定位链 cssPath→role+name→container，命中 0/身份不符 → E_REF_STALE，>1 → E_AMBIGUOUS，不猜）；导航/刷新/元素替换即失效，重新 a11y --ref。**B6a 快照分级/降噪**：--find "文本"|"/正则/i"（树内检索，回命中行+根到节点路径+±2 行上下文，文本叶子去重；≥2KB 万节点页只回单命中）；--diff（身份键 backendDOMNodeId→结构路径兜底；新增/变化行前缀 *；无基线/导航/口径变化 → forcedFull:true 全量；基线 tmpdata/a11y-baseline/<targetId>.json）；--out <file>（全量快照落盘，stdout 只回 {nodes,file,snapshotId}）；--cursor（--cursor-size 默认 200，--cursor-token 续页零 CDP 读基线视图；可与 --find/--diff 组合，与 --out 互斥）；--exclude <css>（子树剪除）；--frames same-origin（Page.getFrameTree 递归→逐帧 getFullAXTree({frameId})→DOM.getFrameOwner 挂父树，单帧失败进 frameErrors[] 不整体失败；88 忽略 frameId → framesUnsupported+approximate 如实报不支持）；--visible-only（遮挡过滤，默认关）。**C11 N12 --mark-js（默认关）**：CDP DOMDebugger 扫描直接 click 监听节点并与 AX 树 backendDOMNodeId join，对「可交互但无 role/name」的行加 [J]（只覆盖直接监听——React 根委托元素级不可见；handler 源码不可得；能力不支持按 error.code 能力闸降级并明确告警）；只加标记不改节点数/行序。默认不带新旗标输出逐字节不变；组合顺序=降噪→diff→find→cursor→out。**C6 --group（默认关，opt-in）**：渲染层语义分组——landmark 行（main/nav/header/footer/aside/section/region/search 及 HTML 标签同义）开组、嵌套 landmark 成子组、组外散行按连续段成 flow 组；组内同父同角色连续 run 合并为一行（role ×N [flags]: @e3 "名" | @e4 "名"），冗余行折叠（InlineTextBox/ListMarker/无名 generic 包装；有 name/ref/flag 绝不折叠）；bounds 在分组态省略（设计内压缩），@eN 全树序与编号不变（编号源=报告行，分组只是展示形态）；与 --find/--diff/--cursor/--out 互斥（那些旗标自带输出视图）。实测缩减率随页面结构（合成样本 ≥30%），--json data.groupView 给 stats+组清单',
  css: '用法：cdp.js css --text <文本>|--selector <css> [--match exact|contains] [--computed] [--matched] [--timeout ms=5000] [--nth N] [--json] [--target 页] —— --json = chromeuse-cli/1 成功信封（data=旧 chromeuse-css/1 报告，脚本改读 .data.*；定位失败为 E_LOCATE 失败信封且带 data）；元素样式感知（只读）：定位复用 locator 跨同源 iframe（多候选不猜需 --nth）。--computed（默认）=页面侧 getComputedStyle（Runtime.evaluate；不启用 CSS 域、不做 nodeId 映射——实现成本最低），全量属性按名排序输出 `name: value`；--matched=CSS.getMatchedStylesForNode（DOM.enable+CSS.enable，结束 CSS.disable），输出规则来源 origin/选择器/media/属性（规则上限 200 条截断标注）；两者可同给。--json=chromeuse-css/1（element/computed/matched/errors）。注意：--timeout 是取数预算，连接层固定 5s',
  'popup-guard': '用法：cdp.js popup-guard scan|test|on|off --target <pageId|url子串|title子串> [--rules <file>] [--app <slug>] [--seconds 60] [--timeout ms] —— 广告/推广弹窗拦截体系（V202610150003，P1=A 路线 DOM 层 MutationObserver 守卫）：scan=只读扫描当前页命中规则与候选弹窗节点（取证不动作）｜test=dry-run 注入观察 --seconds（1~600，默认 60）只记录不动作 → 输出将拦截清单（上线前误杀检验）｜on=注入页侧守卫（真动作；仅页内生效——刷新/导航后失效，跨导航用 flow replay --popup-guard）｜off=摘除守卫（幂等，现场还原）。规则来源：--rules 显式文件 > app（--app 或按 URL 识别；webapp 有 popup-rules.jsonc=整体为准不合并全局）> 全局 config/popup-rules.jsonc。红线：零合成事件/零网络层拦截（B 路线属 P3）',
  record: '用法：cdp.js record [--duration ms] [--out file] [--target 选择器(单页降级)] [-v] [--lock] [--no-sentinel] [--full-input] [--clipboard-policy <text|masked|meta>] [-v 时: --video-width 960 --video-quality 60 --video-interval 1000] —— 默认全标签页录制（V202609080013）：Target.setAutoAttach 自动附挂全部存量/新增标签页，每 target 分配 tab-N 别名+独立错误隔离，事件双标 tab+targetId（V202609090003 起另带 ch=binding|beacon 回传通道标记），关 tab 不丢已录事件（pagehide 终刷）；--target = 单标签页降级录制；SIGINT 或 --duration 停止落盘 tmpdata/events/；互斥语义（V202610200001）=**默认无锁**（锁只保留「打开页签并获取 pageId」层=tab-helper 锁页 CAS；无锁路径零副作用：不建 locks 目录/不写锁文件/不起 heartbeat），--lock = 可选显式互斥（兼容旧脚本语义）；采集失效自愈（V202609090003）：10s 哨兵探针（OK→SUSPECT→LOST 状态机，LOST 自动重注入 reInject 静默模式，节流 3s/片段≤3/会话≤5，3 连败落盘头 injectLost:true）+ renderer 替换重附挂自动重注入 + WS 断开有界重连一次（5s 未成响亮 stopAll 落盘头 wsDown:true），--no-sentinel 可关哨兵；-v = 录屏兜底（V202609090002 显式开启制，默认关零开销）：每 target 一路 Page.startScreencast 帧流落 tmpdata/video/<session>/（index.json=chromeuse-video/1），事后 node tools/cdp.js diff-video <事件流> 出对照报告；--video-* 参数仅 -v 时生效（无 -v 静默忽略）；分层录制：--full-input = full 档（wheel 200ms 累计/focusin/focusout/auxclick/F1-F12 keydown；缺省 semantic 默认档零新增监听，full 档事件=取证原料、蒸馏默认不映射 flow）；--clipboard-policy <text|masked|meta> = 剪贴板三事件脱敏档（默认 text 内容截 200 入流+len 原始全长；masked 恒 *** 保留 len；meta 仅 len 内容零入流；password 目标恒 *** 优先于一切档位；优先级 CLI > config recorder.clipboardPolicy > 默认）；--async = 作业化（**须显式 --target**；主进程立即返回 jobId/status=running/stateFile，进度/终态用 `cdp.js job status <id>` 查；--async 不支持 --json）',
  'record-stop': '用法：cdp.js record-stop —— 对运行中的 record 发 POST /__stop 优雅停止并落盘',
  'diff-video': '用法：cdp.js diff-video <recording-*.json> [--video-file <mp4>] [--t0 <iso>] [--mp4] [--out file] —— 事件流×录屏帧对照报告（chromeuse-videodiff/1 落 tmpdata/videodiff/）：每个 click/dblclick/uiAppear/navigate 事件 → 前后最近帧（路径+Δt，按 tab 分列）；默认按 session.id 自动定位 tmpdata/video/<session>/index.json（缺失扫帧目录重建）；--video-file = 外部 mp4 兼容（bin/ffprobe 取时长，--t0 缺省 session.startedAt，对齐误差 ±2s 级）；--mp4 = 帧序列合成 mp4（bin/ffmpeg -framerate 2）；疑点帧交 observer ≤25 帧/批',
  'evidence-pack': '用法：cdp.js evidence-pack <recording-*.json|目录>... [--gap-seconds 300] [--out 目录] [--title 标题] —— 验收回放证据包（V202609170003，chromeuse-evidence-pack/1 落 tmpdata/evidence/evidence-pack-<时间戳>/）：多段录制产物（事件流 chromeuse-events/1 + 录屏帧流 chromeuse-video/1）按绝对时间戳归一到统一时间轴（timeline.json：各段起止/相对偏移/事件与帧统计/关键帧索引/损坏段登记）；段间间隔>阈值（默认 300s）标记段间中断、时间交叠标 overlap，均不静默拼接；关键帧 = 显著事件（click/dblclick/uiAppear/navigate，与 diff-video 同口径）前后最近帧路径引用（每段上限 20）；README.md 取证自足（段清单/时间轴/文件索引/生成命令与环境）；索引式证据包——视频/事件流原位引用不复制不转码（v1 边界）；输入支持：recording-*.json 文件列表 / 父目录（非递归自动发现）/ 录屏会话目录（含 index.json 按 session.id 反查事件流）；纯本地聚合零 CDP 连接；损坏段如实登记 timeline.damaged 不中断打包',
  identify: '用法：cdp.js identify [--url <url>] [--target 选择器] [--assert-app <slug>] [--note 备注] —— 应用识别（matchers 分段锚定+约束度打分，用户断言优先）；多命中问用户一次并会话内记住；--assert-app = 用户同意后的记忆化（追加 tmpdata/url-assertions.jsonl）',
  'events-summary': '用法：cdp.js events-summary <recording-*.json> [--out file] —— 确定性预处理：噪声过滤/IME 折叠/类型分布统计',
  'recorder-convert': '用法：cdp.js recorder-convert <DevTools导出.json> [--out flow.json] —— T2 兜底转换器：DevTools Recorder JSON → flow 草案（不可映射步骤出 warning）',
  'browser-restart': '用法：cdp.js browser-restart [--url <browserUrl>] [--timeout ms=30000] —— 优雅重启浏览器（Y1 治本产品化，V202609100002）：Browser.close（ExitType:Normal 无恢复气泡）→ keep-alive 自动拉起（NAS chrome-browser 容器特有）→ 探活轮询 → 域级深检 → tab 清单；用途 = CDP 操作过多/DevTools 域层损伤（per-target -32601）时的环境重置，比 docker restart 干净；⚠ 爆炸半径=整浏览器（所有 tab 关闭）；⚠ 环境边界：无自动重启机制的环境（如 Windows 桌面端）close 后需手动重启浏览器再重试探活（本命令幂等）；无 keep-alive 环境也可先 `node tools/cdp.js browser-up` OS 级拉起调试实例（**up=进程级启动 / restart=CDP 级重启**，二者互补）；超时兜底建议见输出',
  doctor: '用法：cdp.js doctor [--url <browserUrl>] [--timeout ms=5000] —— CDP 通道健康一次性诊断（V202609130003，chromeuse-cdp-doctor/1 JSON）：browser 版本（browser.advisory=低于 MCP 已知降级线 94 时提示走 cdp.js 主通道，非失败）/targets 全列表摘要（数量+type/url/attached——target 堆积可见）/wsLatency 3 次 Target.getTargets 往返校样/screenshotProbe 首个 page 型 target 试拍（bringToFront 前置单次不重试，有标签置前副作用）/multiClientHint 多客户端共用 9222 现状提示（chromeuse 短连接 × chrome-devtools MCP 长驻共存是架构现状）；exit 0=诊断完成（健康度看 JSON 字段）｜1=通道不可达无从诊断',
  'doctor-forensics': '用法：cdp.js doctor-forensics [--target 选择器] [--symptom "来源/目标页/错误码原文"] [--timeout ms=3000] [--max-targets 3] [--no-control-tab] [--no-front] [--out file] [--url <browserUrl>] —— CDP 失效分型取证（V202609300001，chromeuse-cdp-forensics/1）：S0 环境+S1 HTTP 面+S2 WS/browser 级（SystemInfo.getProcessInfo fail-soft 记 unknown）+S3 per-target 矩阵（attach 2s/单发 3s；主 target bringToFront 前置，--no-front 全关）+S4 对照 tab（条件触发：S3 有探针死——about:blank background:true 自开自关，--no-control-tab 可关）+S5 judgeLayers 八层分型 M/A1/A2/B/C/D/E/F/G（恒 advisory，不自动恢复）；探针全单发不重试；总预算硬帽 120s 超帽标 truncated 照常落盘；⚠ 通道全死也照常落盘（与 doctor 快速 die 相反——通道死本身=A/B 判定原料）；默认落 tmpdata/cdp-forensics/forensics-<时间戳>.json + stdout 分型摘要；exit 0=取证落盘完成（无论判定/通道死活）｜1=取证自身失败（参数错/写盘失败）——绝无 exit 2；恢复动作映射与批准线 → playbook §失效分型取证协议 v1',
  grid: '用法：cdp.js grid locate --col <列头文字> --row <N> [--selector <css>] [--keep-scroll] [--match exact|contains] [--target 页] [--timeout ms] | cdp.js grid scroll-to --row <N> [--col <列头文字>] [--selector <css>] [--restore-scroll] [--match exact|contains] [--target 页] [--timeout ms] —— 虚拟化网格（react-data-grid v6 `.react-grid-*`/v7 `.rdg-*`）定位/滚动（有页面滚动副作用）：locate=按列头文字+行号定位，必要时滚动并轮询复读，输出 rect/值/可见性；默认还原滚动（--keep-scroll 保留）；scroll-to=只滚动到目标行列并保留现场（--restore-scroll 还原），供 extract --kind grid 复读；读数走 extract --kind grid（只读不滚动）；本命令专管滚动渲染（C6 纪律）：列头按 rect.left 视觉序（DOM 序≠视觉序），--col 文字→data 索引；离屏未渲染≠空值；滚动后派发一次原生 scroll 通知令 RDG 重算虚拟列（POC F2：程序化 scrollLeft 不自动触发列虚拟化）；输出 visibleRows/totalRows/scroll before→after；未命中 E_NOT_FOUND 且 hint 含「离屏未渲染≠空值」；本命令不支持 --json（E_USAGE 拒绝面）',
  handoff: '用法：cdp.js handoff --reason "<人需完成的事>" [--target 页] [--timeout-ms ms=600000] [--signal <path>] | cdp.js handoff --wait <id> | cdp.js handoff --status [<id>] | cdp.js handoff --cancel <id> —— 人机接力（2FA/支付/审批交还用户；C2 #128）：默认 start 落盘即返 HUMAN REQUIRED 横幅，用户完成后 touch 信号文件续跑（--wait 阻塞轮询）；状态文件 tmpdata/handoff/<id>.json；状态机 waiting→confirmed（信号文件出现）/expired（now≥deadline）/cancelled（--cancel），终态不可逆；活跃判据=state∧deadline 双字段（读者侧即时判定：滞留 waiting 的超时文件不永久豁免页签回收）；信号默认 tmpdata/handoff/<id>.continue，agent 转告用户后执行 touch "<signalPath>"（--json data.signalPath 机器可靠提取）；--timeout-ms 默认 600000（10min）、上限 3600000（1h 硬帽），--wait 不接 timeout（等待预算=deadline 单源）；id 支持唯一前缀（多命中 E_AMBIGUOUS 不猜）；页签全程零 activate/bringToFront、等待期豁免 tab-govern 回收、超时保留不关；留证=前后截图 best-effort（2s fail-soft，失败记 null）+ audit action handoff.created/confirmed/expired/cancelled；契约 → references/mechanisms.md §23',
  'browser-up': '用法：cdp.js browser-up [--timeout ms=20000] [--proxy <url>] | cdp.js browser-up --stop | cdp.js browser-up --status —— OS 级拉起调试实例（批C2/R2）：校验 chrome 三键 → 发现浏览器可执行 → 幂等探测（端口已就绪=复用现有实例）→ spawn 常驻（独立 user-data-dir）→ 等 /json/version 就绪 → state 落盘；--stop 显式关停（进程组信号 → 兜底 CDP Browser.close）/ --status 只读查询；与 browser-restart 分工：up=进程级启动（从「无调试实例」到「有」；无 keep-alive 环境如 Windows 桌面端补齐空白）/ restart=CDP 级重启（Browser.close 依赖容器 keep-alive 自动拉起，治 DevTools 域损伤）；仅 Chromium 内核（Chrome/Edge/Brave/Chromium——Firefox/Safari 不支持 CDP）；userDataDir 必须独立非默认（绝不 attach 日常实例；Chrome 136+ 亦要求）；默认常驻，登录态保留在独立 profile（首次各网站需手动登录一次）；--timeout=就绪预算（默认 20000ms，500~120000）；--proxy <url>=注入 Chromium `--proxy-server`（V20261117014 ISSUE-3，用户裁定 b：config.proxy 保持空串常态、需要时命令带参数）——优先级 CLI --proxy > env CHROMEUSE_BROWSER_PROXY > config.proxy.httpProxy，三者皆空不注入（与旧版逐字节同）；仅 http/https/socks5 前缀，非法值 E_USAGE；只影响被拉起实例，已启动实例需先 --stop；state 记录脱敏值（user:pass → ***@，写盘层再归一为 <redacted:credentials>@）；state 文件 tmpdata/browser/launch-state.json；连接失败自动保障=全局 flag --auto-launch（仅 browserUrl 主机为 127.0.0.1/localhost 才确保，非本地跳过并 warn；--proxy 同样生效）；本命令不支持 --json（E_USAGE 拒绝面）；机制 → references/mechanisms.md §26',
};

/* CMD_QUICKREF —— main help 命令名速查（缺口③，V20261112001）：由 scripts/build-help.js 作为第三产物
 * 从 commands.meta.json 生成（组id: 命令名一行的全量投影；helpMain 子命令区头部插值——截断保头）。
 * ⚠ 本块勿手改：改命令=改 meta + 跑 build。 */
const CMD_QUICKREF = `命令名速查（49，按组；参数与语义见下方逐条）：
  diagnostics: probe console doctor doctor-forensics audit artifacts job net watch
  interaction: click click-at type key hover drag upload wait dialog
  lifecycle: goto new close select eval targets
  perception: a11y css locator extract
  grid: grid
  viewport: viewport emulate
  capture: scroll-shot cast screenshot
  automation: flow assert handoff
  record: record record-stop
  forensics: diff-video evidence-pack
  identify: identify events-summary recorder-convert
  escape: exec beacon popup-guard browser-restart browser-up`;

/* SUB_HELP —— 子命令帮助单源（--help 回显 / 未知名回显 / selftest #95 文档同源校验准源）。
 * --json 通用语义（V202611030001 B1a）：失败时 stdout 单行 chromeuse-cli/1 失败信封
 * （envelope.name/command/at + ok:false + code + message + retryable/hint/elapsedMs）；非 --json 输出逐字节不变。
 * 逐命令 --json 放行面（B1b 迁移 12 命令；其余命令 --json 一律 E_USAGE 拒绝）见 references/mechanisms.md。 */


/* ── audit：结构化审计查询（V202611030004 B3 N3）──
 * 只读查询面；落盘/字段白名单/按天切分在 lib/audit.js（写入点=进程 exit 单点 + finalizeFailure sink）。
 * 本命令自身也走统一审计（exit 0 单点），满足「audit 命令自身也被审计」。 */
function fmtOldest(ms) { return ms == null ? '—' : time.isoLocal(new Date(ms)); }

function cmdAudit(pos, flags) {
  const sub = pos[0];
  audit.setAction(`audit:${sub || '?'}`);
  if (sub === 'tail') {
    const raw = pos[1] !== undefined ? pos[1] : flags.n;
    const n = num(raw, 20);
    if (!(n >= 1 && n <= 2000)) die('audit tail 的条数须为 1~2000');
    const lines = audit.tail(n);
    if (!lines.length) { console.log(`（审计为空：${audit.dir()} 下无记录）`); return EXIT_OK; }
    for (const l of lines) fs.writeSync(1, l + '\n'); // 同步直写：防 process.exit 截断大 tail
    return EXIT_OK;
  }
  if (sub === 'stats') {
    const days = num(flags.days, 7);
    if (!(days >= 1 && days <= 3650)) die('audit stats --days 须为 1~3650');
    const s = audit.stats({ days });
    console.log(`audit stats（最近 ${s.days} 天：${s.from} ~ ${s.to}；文件 ${s.files} 个 / 记录 ${s.total} 条${s.parseErrors ? ` / 解析失败 ${s.parseErrors}` : ''}）`);
    console.log('按命令：');
    const cmds = Object.keys(s.byCmd).sort();
    if (!cmds.length) console.log('  （无记录）');
    for (const c of cmds) { const v = s.byCmd[c]; console.log(`  ${c}  ${v.total} 条（ok ${v.ok} / fail ${v.fail}）`); }
    console.log('按结果码：');
    for (const c of Object.keys(s.byCode).sort()) console.log(`  ${c}  ${s.byCode[c]}`);
    console.log('按日：');
    for (const d of Object.keys(s.byDay).sort()) console.log(`  ${d}  ${s.byDay[d]}`);
    return EXIT_OK;
  }
  die(SUB_HELP.audit);
}

/* ── artifacts：产物配额 / 保留期 / pin（V202611030005 B3 N2）──
 * report=分类账（覆盖全部登记目录断言）；prune=到期清理+超配额淘汰（默认 dry-run）；pin=永不自动删清单。
 * 分类表/配额口径/准入五入口 → references/mechanisms.md §11。 */
function cmdArtifacts(pos, flags) {
  const sub = pos[0];
  audit.setAction(`artifacts:${sub || '?'}`);
  if (sub === 'report') return cmdArtifactsReport();
  if (sub === 'prune') return cmdArtifactsPrune(flags);
  if (sub === 'pin') return cmdArtifactsPin(pos.slice(1), flags);
  die(SUB_HELP.artifacts);
}

function cmdArtifactsReport() {
  const r = quota.report();
  console.log(`[artifacts] 根：${r.root}｜总配额 ${r.quota.totalMB}MB（已用 ${r.quota.usedMB}MB / ${r.quota.usedPct}%${r.quota.over ? ' ⚠ 超限' : ''}）｜单产物上限 ${r.quota.maxArtifactMB}MB｜autoEvict=${r.quota.autoEvict ? 'on' : 'off'}`);
  console.log('[artifacts] 按类别：');
  console.log('  类别 | 文件数 | 占用 | 最旧 | 保留期 | 淘汰序 | 到期可清');
  for (const c of r.categories) {
    console.log(`  ${c.id} | ${c.files} | ${quota.fmtBytes(c.bytes)} | ${fmtOldest(c.oldestMs)} | ${c.retentionDays == null ? '永不' : `${c.retentionDays} 天`} | ${c.evictOrder == null ? '—' : c.evictOrder} | ${c.expiredFiles ? `${c.expiredFiles} 文件 / ${quota.fmtBytes(c.expiredBytes)}` : '—'}`);
  }
  console.log(`[artifacts] 登记目录（覆盖断言 ${r.dirs.length}/${r.dirs.length}）：`);
  for (const d of r.dirs) {
    console.log(`  ${d.key} | ${d.exists ? 'exists' : 'missing'} | ${d.files} 文件 | ${quota.fmtBytes(d.bytes)} | 最旧 ${fmtOldest(d.oldestMs)} | → ${d.category}`);
  }
  if (r.unregistered.length) {
    console.log(`[artifacts] 未登记（other，永不自动删）${r.unregistered.length} 项：`);
    for (const u of r.unregistered.slice(0, 50)) console.log(`  ${u.name} | ${u.type === 'dir' ? '目录' : '文件'} | ${u.files} 文件 | ${quota.fmtBytes(u.bytes)}`);
    if (r.unregistered.length > 50) console.log(`  …（另有 ${r.unregistered.length - 50} 项）`);
  }
  console.log(`[artifacts] pin 保护 ${r.pinnedFiles} 个路径（artifacts pin --list 查看）`);
  return EXIT_OK;
}

function cmdArtifactsPrune(flags) {
  const apply = flags.apply === true || flags.apply === 'true' || flags.apply === '1';
  const yes = flags.yes === true || flags.yes === 'true' || flags.yes === '1';
  const r = quota.prune({ apply, yes });
  if (!r.ok) die(r.message, r.code);
  console.log(`[artifacts] prune ${r.mode}：${apply ? '删除' : '将删除'} ${r.files} 个文件 / ${quota.fmtBytes(r.bytes)}｜清理后托管 ${quota.fmtBytes(r.remainingBytes)} / 配额 ${quota.fmtBytes(r.quotaBytes)}`);
  for (const g of r.groups) {
    console.log(`  ${g.category} | ${g.files} 文件 | ${quota.fmtBytes(g.bytes)} | 保留期 ${g.retentionDays} 天${g.evictOrder == null ? '（不参与淘汰）' : `，淘汰序 ${g.evictOrder}`}`);
  }
  if (r.victims.length) {
    const expired = r.victims.filter((v) => v.reason === 'expired').length;
    const over = r.victims.length - expired;
    console.log(`  明细：到期 ${expired} / 超配额淘汰 ${over}`);
    for (const v of r.victims.slice(0, 50)) console.log(`    [${v.reason}] ${v.path}（${quota.fmtBytes(v.size)}，${v.ageDays} 天）`);
    if (r.victims.length > 50) console.log(`    …（另有 ${r.victims.length - 50} 个）`);
  } else {
    console.log('  无需清理（无到期文件、托管总量未超配额）');
  }
  if (!apply) console.log('[artifacts] dry-run：未删除任何文件；确认后加 --apply（>500 文件或 >1GB 需 --yes）');
  else console.log(`[artifacts] ✓ 已删除 ${r.deleted} 个文件 / ${quota.fmtBytes(r.deletedBytes)}；清理空目录 ${r.removedDirs || 0} 个；现托管 ${quota.fmtBytes(r.remainingBytes)}`);
  return EXIT_OK;
}

function cmdArtifactsPin(pos, flags) {
  if (flags.list) {
    const r = quota.pin({ list: true });
    console.log(`[artifacts] pin 清单：${r.file}（${r.paths.length} 条）`);
    for (const p of r.paths) console.log(`  ${fs.existsSync(p) ? '✓' : '⚠ 不存在'} ${p}`);
    return EXIT_OK;
  }
  const removing = flags.remove !== undefined;
  const targets = removing
    ? [].concat(typeof flags.remove === 'string' ? [flags.remove] : [], pos)
    : pos;
  if (!targets.length) die('artifacts pin 需要路径（或 --list / --remove <path>）');
  const r = quota.pin(removing ? { remove: targets } : { add: targets });
  const missing = r.paths.filter((p) => !fs.existsSync(p));
  console.log(`[artifacts] pin ${removing ? '移除' : '登记'}完成：新增 ${r.added}，移除 ${r.removed}，当前 ${r.paths.length} 条 → ${r.file}`);
  if (missing.length) console.log(`[artifacts] ⚠ 清单中 ${missing.length} 条路径当前不存在（保留条目，文件回来即生效）`);
  return EXIT_OK;
}

/* ── job：长任务作业查询/取消（V20261104002 B7 N6；契约 → references/mechanisms.md §14）──
 * 作业化入口=四命令（cast/scroll-shot/record/flow replay）的 --async（在 main 分发前拦截）；
 * 本命令只做 list/status/cancel 三子命令，自身不作业化。 */
const ASYNC_COMMANDS = new Set(['cast', 'scroll-shot', 'record']);

function isAsyncRequested(argv, flags) {
  return !!(flags && flags.async !== undefined)
    || (Array.isArray(argv) && argv.some((a) => a === '--async' || String(a).startsWith('--async=')));
}

function fmtJobCmd(st) {
  const cmdline = Array.isArray(st.cmdline) ? st.cmdline : [];
  return cmdline.join(' ').slice(0, 160) || st.cmd || '-';
}

function fmtJobProgress(pr) {
  if (!pr || typeof pr !== 'object') return '-';
  const parts = [];
  if (pr.phase) parts.push(String(pr.phase));
  if (pr.current != null || pr.total != null) parts.push(`${pr.current == null ? '?' : pr.current}/${pr.total == null ? '?' : pr.total}`);
  if (pr.detail) parts.push(String(pr.detail).slice(0, 80));
  return parts.length ? parts.join(' ') : JSON.stringify(pr).slice(0, 120);
}

/** --async 启动收口：显式 --target 强制 + --json 拒绝 + argv 剔除自身后交给 lib/jobs */
function cmdAsync(sub, argv, pos, flags) {
  if (!ASYNC_COMMANDS.has(sub) && !(sub === 'flow' && pos[0] === 'replay')) {
    fail('E_USAGE', '--async 仅支持 cast/scroll-shot/record/flow replay（其余命令请同步执行）');
  }
  if (jsonMode) {
    fail('E_USAGE', '--async 不支持 --json（作业化固定输出一行 jobId/status/stateFile 文本；查询/取消用 cdp.js job list/status/cancel）');
  }
  if (typeof flags.target !== 'string' || !flags.target) {
    fail('E_USAGE', '--async 要求显式 --target：异步无人监督，禁止隐式操作当前页/自建页签（与页签礼仪同源）');
  }
  if (sub === 'flow' && (typeof pos[1] !== 'string' || !pos[1])) fail('E_USAGE', 'flow replay --async 需要 <file.flow.json> 参数');
  const waitMs = flags.wait === undefined ? 0 : (flags.wait === true ? num(flags.timeout, 30000) : num(flags.wait, 30000));
  const r = jobs.start({ cmd: sub, argv: jobs.stripAsync(argv), waitMs });
  if (!r.ok) fail(r.code || 'E_INTERNAL', r.message);
  // 文本一行（机器消费：jobId=/stateFile=；--json 面按编排方裁决不扩放——--async + --json 上方 E_USAGE）
  console.log(`[job] jobId=${r.jobId} status=running stateFile=${r.stateFile}`);
  return EXIT_OK;
}

function cmdJob(pos, flags) {
  const sub = pos[0];
  audit.setAction(`job:${sub || '?'}`);
  if (sub === 'list') {
    const items = jobs.list({});
    const running = items.filter((x) => x.status === 'running').length;
    console.log(`[job] 共 ${items.length} 个（running ${running}/${jobs.maxJobs()}；终态保留 600s；状态文件 ${paths.JOBS_DIR}）`);
    for (const st of items) {
      const pid = st.pid == null ? '-' : st.pid;
      console.log(`  ${st.jobId}  ${st.status.padEnd(9)}  pid=${pid}  ${st.startedAt}  进度 ${fmtJobProgress(st.progress)}  ${fmtJobCmd(st)}`);
    }
    if (!items.length) console.log('  （无作业）');
    return EXIT_OK;
  }
  if (sub === 'status') {
    if (typeof pos[1] !== 'string' || !pos[1]) die(SUB_HELP.job);
    const r = jobs.status(pos[1], {});
    if (!r.ok) fail(r.code || 'E_USAGE', r.message);
    const st = r.state || {};
    console.log(`[job] ${st.jobId}`);
    console.log(`  status: ${st.status}`);
    console.log(`  pid: ${st.pid == null ? '-' : st.pid}`);
    console.log(`  startedAt: ${st.startedAt || '-'}${st.finishedAt ? ` → ${st.finishedAt}` : ''}`);
    console.log(`  cmdline: ${fmtJobCmd(st)}`);
    console.log(`  progress: ${fmtJobProgress(st.progress)}`);
    console.log(`  artifact: ${st.artifact || '-'}`);
    console.log(`  exitCode: ${st.exitCode == null ? '-' : st.exitCode}`);
    if (st.note) console.log(`  note: ${st.note}`);
    console.log(`  stateFile: ${r.stateFile}`);
    return EXIT_OK;
  }
  if (sub === 'cancel') {
    if (typeof pos[1] !== 'string' || !pos[1]) die(SUB_HELP.job);
    return (async () => {
      const r = await jobs.cancel(pos[1], {});
      if (!r.ok) return fail(r.code || 'E_USAGE', r.message);
      if (r.already) {
        console.log(`[job] ${r.jobId} 已是终态 ${r.state.status}（无需取消；产物保留：${r.state.artifact || '-'}）`);
        return EXIT_OK;
      }
      console.log(`[job] cancelled ${r.jobId}（signal=${r.signal}；已完成产物保留：${r.artifact || '-'}；状态 ${r.stateFile}）`);
      return EXIT_OK;
    })();
  }
  die(SUB_HELP.job);
}

/* ── handoff：人机接力（C2 #128；契约 → references/mechanisms.md §23）──
 * 单命令四形态：默认 start（落盘即返横幅）/ --wait <id>（阻塞轮询信号文件）/ --status [<id>] / --cancel <id>。
 * 状态机/原子写/惰性清扫/审计 → lib/handoff.js 单源；页签=登记 tab-govern + busy 豁免（等 deadline）+ 永不置前。
 * 留证：start 与终态迁移各一张 Page.captureScreenshot（2s fail-soft，后台页可能不出帧→evidence 记 null）。 */
async function captureHandoffShot(client, sessionId, id, phase) {
  try {
    if (!client || !sessionId) return null;
    const r = await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId, timeoutMs: 2000 });
    if (!r || typeof r.data !== 'string' || !r.data) return null;
    const dir = paths.ensureDir(paths.EVIDENCE_DIR);
    const file = path.join(dir, `handoff-${id}-${phase}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  } catch { return null; }
}

/** 终态截图（fail-soft）：800ms 连接预算，不拖慢 --wait/--cancel 的返回时延；无 pageId 即跳过 */
async function captureHandoffEndShot(state, flags) {
  if (!state || !state.pageId) return null;
  let client = null;
  try {
    const opened = await openClient(Object.assign({}, flags, { timeout: '800' }), 800);
    client = opened.client;
    const r = await opened.core.resolveTarget(client, state.pageId);
    return await captureHandoffShot(client, r.sessionId, state.id, 'end');
  } catch { return null; }
  finally { if (client) await gracefulClose(client); }
}

async function cmdHandoffStart(flags) {
  if (typeof flags.reason !== 'string' || !flags.reason.trim()) {
    fail('E_USAGE', '--reason 缺值（人需完成的事，必填；用法见 cdp.js handoff --help）');
  }
  let timeoutMs;
  try { timeoutMs = handoffMod.normalizeTimeout(flags['timeout-ms']); }
  catch (e) { fail('E_USAGE', e.message); }
  let signalPath = null;
  if (flags.signal !== undefined) {
    if (typeof flags.signal !== 'string' || !flags.signal) fail('E_USAGE', '--signal 缺值（Continue 信号文件路径）');
    signalPath = path.resolve(flags.signal);
    try {
      paths.ensureDir(path.dirname(signalPath));
      fs.accessSync(path.dirname(signalPath), fs.constants.W_OK);
    } catch (e) { fail('E_IO', `信号文件父目录不可写：${path.dirname(signalPath)}（${e.message}）`); }
  }
  const { core, client } = await openClient(flags);
  let resolved;
  try { resolved = await core.resolveTarget(client, flags.target); }
  catch (e) {
    await gracefulClose(client);
    fail(errors.codeForKind(e.kind) || 'E_NO_TARGET', e.message);
  }
  const { target, sessionId } = resolved;
  const id = handoffMod.makeHandoffId();
  const startShot = await captureHandoffShot(client, sessionId, id, 'start');
  let st;
  try {
    st = handoffMod.create({
      id, why: flags.reason, pageId: target.id, url: target.url, timeoutMs, signalPath, startShot,
    });
  } catch (e) {
    await gracefulClose(client);
    fail('E_IO', `handoff 状态落盘失败：${e.message}`);
  }
  await gracefulClose(client);
  if (jsonMode) return emitOk('handoff', Object.assign({}, st, { banner: handoffMod.formatBanner(st), waitedMs: null }));
  console.log(handoffMod.formatBanner(st));
  return EXIT_OK;
}

async function cmdHandoffWait(flags) {
  if (typeof flags.wait !== 'string' || !flags.wait) fail('E_USAGE', '--wait 缺值（handoff id，支持唯一前缀）');
  const r = await handoffMod.wait(flags.wait, { captureEnd: (st, next) => captureHandoffEndShot(st, flags) });
  if (!r.ok) fail(r.code || 'E_USAGE', r.message);
  const st = r.state;
  const waitedSec = (r.waitedMs / 1000).toFixed(1);
  if (st.state === 'expired') {
    const msg = `handoff ${st.id} 超时未确认（E_TIMEOUT）——页签保留未关，请人工处置或 cdp.js close ${st.pageId || '<targetId>'}`;
    if (jsonMode) return emitFailWithData('handoff', 'E_TIMEOUT', msg, Object.assign({}, st, { waitedMs: r.waitedMs }));
    console.error(`✗ ${msg}`);
    return EXIT_ERR;
  }
  if (jsonMode) return emitOk('handoff', Object.assign({}, st, { waitedMs: r.waitedMs }));
  if (st.state === 'confirmed') console.log(`✓ handoff ${st.id} 用户已确认（等待 ${waitedSec}s）——续跑`);
  else console.log(`[handoff] ${st.id} 已 ${st.state}（等待 ${waitedSec}s；无需继续等待）`);
  return EXIT_OK;
}

async function cmdHandoffStatus(pos, flags) {
  const arg = typeof flags.status === 'string' ? flags.status : (pos[0] || null);
  if (!arg) {
    const items = handoffMod.list({});
    if (jsonMode) return emitOk('handoff', { items, total: items.length, dir: paths.HANDOFF_DIR });
    console.log(handoffMod.formatList(items, paths.HANDOFF_DIR));
    return EXIT_OK;
  }
  const r = handoffMod.find(arg, {});
  if (!r.ok) fail(r.code || 'E_USAGE', r.message);
  if (jsonMode) return emitOk('handoff', r.state);
  console.log(handoffMod.formatDetail(r.state));
  return EXIT_OK;
}

async function cmdHandoffCancel(flags) {
  if (typeof flags.cancel !== 'string' || !flags.cancel) fail('E_USAGE', '--cancel 缺值（handoff id，支持唯一前缀）');
  const r = await handoffMod.cancel(flags.cancel, { captureEnd: (st, next) => captureHandoffEndShot(st, flags) });
  if (!r.ok) fail(r.code || 'E_USAGE', r.message);
  if (jsonMode) return emitOk('handoff', Object.assign({}, r.state, { already: r.already }));
  if (r.already) console.log(`[handoff] ${r.state.id} 已是终态 ${r.state.state}（幂等：无需取消）`);
  else console.log(`✓ handoff ${r.state.id} 已取消（页签保留未关；状态 ${r.stateFile}）`);
  return EXIT_OK;
}

async function cmdHandoff(pos, flags) {
  const forms = ['wait', 'status', 'cancel'].filter((k) => flags[k] !== undefined);
  const startForm = flags.reason !== undefined;
  if (forms.length > 1 || (startForm && forms.length)) {
    fail('E_USAGE', 'handoff 四形态互斥：--reason <text>（start）｜--wait <id>｜--status [<id>]｜--cancel <id>');
  }
  if (!startForm && !forms.length) die(SUB_HELP.handoff);
  /* start 专属旗标不得被其他形态静默忽略（等待预算=状态文件 deadline 单源） */
  if (forms.length && (flags['timeout-ms'] !== undefined || flags.signal !== undefined)) {
    fail('E_USAGE', '--timeout-ms/--signal 仅 start 形态支持（--wait 的等待预算=状态文件 deadline 单源）');
  }
  audit.setAction(`handoff:${startForm ? 'start' : forms[0]}`);
  if (startForm) return cmdHandoffStart(flags);
  if (flags.wait !== undefined) return cmdHandoffWait(flags);
  if (flags.status !== undefined) return cmdHandoffStatus(pos, flags);
  return cmdHandoffCancel(flags);
}

/* ── 主入口 ── */
let helpOnly = true; // --help / 主帮助类调用不写日志（防 selftest #17 冒烟刷屏）；真实子命令执行才记
async function main() {
  // -v 统一别名（V202609090002）：预处理一行，全部子命令统一获得 -v = --video（录屏兜底，默认关）；
  // 未来 verbosity 语义用 -V/--verbose 避让，不占 -v
  const argv = process.argv.slice(2).map((a) => (a === '-v' ? '--video' : a));
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { helpMain(); return EXIT_OK; }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(SUB_HELP[sub] || `未知子命令：${sub}`);
    if (!SUB_HELP[sub]) return EXIT_ERR;
    return EXIT_OK;
  }
  /* --json 放行面统一拦截（B1b，switch 前）：未支持命令**不执行**，只发 E_USAGE 失败信封 + exit 1。
   * 禁止「执行 + stderr 告警」混合语义；未知子命令给独立文案（仍 E_USAGE）。 */
  if (jsonMode && !JSON_COMMANDS.has(sub)) {
    fail('E_USAGE', SUB_HELP[sub] ? '该命令暂不支持 --json，见 --help' : `未知子命令：${sub}（见 --help）`);
  }
  helpOnly = false;
  // --async / --insecure 是布尔旗标：归一成 =true 再 parseArgs，避免吞掉后面的位置参数
  // （如 `flow replay --async file.json`、`goto --insecure <url>`；parseArgs 会把紧随的非 -- 令牌当旗标值）
  const { pos, flags } = parseArgs(argv.slice(1).map((a) => {
    if (a === '--async') return '--async=true';
    if (a === '--insecure') return '--insecure=true';
    return a;
  }));
  /* --async 作业化（B7 N6）：分发前拦截，只认 cast/scroll-shot/record/flow replay；要求显式 --target、
   * 拒绝 --json（编排方裁决不扩放行面）、转发 argv 剔除 --async 自身（lib/jobs.stripAsync）。 */
  if (isAsyncRequested(argv, flags)) return cmdAsync(sub, argv, pos, flags);
  require('../lib/cdp-core').requireNode22();
  /* --auto-launch 全局保障（批C2/R2，V20261117008；--proxy 同源，V20261117014 ISSUE-3）：连接前确保本地调试
   * 实例就绪——幂等 ensure（端口已就绪=复用；未起=按 config chrome 三键拉起）。仅当 browserUrl 主机为
   * 127.0.0.1/localhost 才动作；非本地主机跳过并 warn（避免误启本地实例去连远端）。--config 已由顶部 pre-parse 生效。
   * browser-up 自身不重复触发（它本来就是显式拉起命令）。--proxy（CLI 形态）与 browser-up 同源透传 ensure。 */
  if (AUTO_LAUNCH && sub !== 'browser-up' && SUB_HELP[sub]) {
    const launchMod = require('../lib/browser-launch');
    const coreMod = require('../lib/cdp-core');
    if (flags.proxy === true || flags.proxy === '') die('--proxy 缺值（代理 URL，例：--proxy http://127.0.0.1:7897）');
    const autoUrl = coreMod.resolveBrowserUrl(flags.url);
    let autoHost = '';
    try { autoHost = new URL(String(autoUrl).replace(/\/+$/, '')).hostname.toLowerCase(); } catch { /* 非 URL 形态 → 按非本地跳过 */ }
    if (autoHost === '127.0.0.1' || autoHost === 'localhost') {
      try {
        const r = await launchMod.ensure({ proxy: flags.proxy });
        console.error(r.reused
          ? `[auto-launch] ✓ 调试实例已就绪（复用现有实例：${autoUrl}）`
          : `[auto-launch] ✓ 已拉起调试实例 pid=${r.pid} port=${r.port}（${autoUrl}）`);
      } catch (e) {
        fail(errors.codeForKind((e && e.kind) || 'conn'), `--auto-launch 自动保障失败：${(e && e.message) || e}`);
      }
    } else {
      console.error(`[auto-launch] ⚠ 跳过自动拉起：browserUrl 主机「${autoHost || autoUrl}」非本机（127.0.0.1/localhost）——需本地调试实例请显式 node tools/cdp.js browser-up`);
    }
  }
  // 统一日志：子命令入口（命令名 + 关键参数；热路径 record/watch 循环体内部不逐轮 log）
  log.info('cdp', `子命令 ${sub} 启动${pos.length ? ' pos=' + pos.join(',').slice(0, 80) : ''}`
    + (flags.target ? ` target=${String(flags.target).slice(0, 80)}` : '')
    + (flags.url ? ` url=${String(flags.url).slice(0, 80)}` : '')
    + (flags.out ? ` out=${String(flags.out).slice(0, 120)}` : ''));
  switch (sub) {
    case 'probe': return cmdProbe(flags);
    case 'exec': return cmdExec(pos, flags);
    case 'targets': return cmdTargets(flags);
    case 'net': return cmdNet(flags);
    case 'screenshot': return cmdScreenshot(flags);
    case 'scroll-shot': return cmdScrollShot(flags);
    case 'cast': return cmdCast(flags);
    case 'beacon': return cmdBeacon(flags);
    case 'watch': return cmdWatch(flags);
    case 'flow': return cmdFlow(pos, flags);
    case 'locator': return cmdLocator(pos, flags);
    case 'click': return cmdClick(flags);
    case 'click-at': return cmdClickAt(pos, flags);
    case 'type': return cmdType(pos, flags);
    case 'key': return cmdKey(pos, flags);
    case 'hover': return cmdHover(flags);
    case 'wait': return cmdWait(flags);
    case 'console': return cmdConsole(flags);
    case 'viewport': return cmdViewport(pos, flags);
    case 'emulate': return cmdEmulate(flags);
    case 'dialog': return cmdDialog(flags);
    case 'upload': return cmdUpload(pos, flags);
    case 'drag': return cmdDrag(flags);
    case 'goto': return cmdGoto(pos, flags);
    case 'new': return cmdNew(pos, flags);
    case 'close': return cmdClose(pos, flags);
    case 'select': return cmdSelect(pos, flags);
    case 'eval': return cmdEval(pos, flags);
    case 'a11y': return cmdA11y(flags);
    case 'css': return cmdCss(flags);
    case 'popup-guard': return cmdPopupGuard(pos, flags);
    case 'record': return cmdRecord(flags);
    case 'record-stop': return require('../lib/record').stop(flags);
    case 'diff-video': return cmdDiffVideo(pos, flags);
    case 'evidence-pack': return cmdEvidencePack(pos, flags);
    case 'browser-restart': return cmdBrowserRestart(flags);
    case 'browser-up': return cmdBrowserUp(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'doctor-forensics': return cmdDoctorForensics(flags);
    case 'audit': return cmdAudit(pos, flags);
    case 'artifacts': return cmdArtifacts(pos, flags);
    case 'job': return cmdJob(pos, flags);
    case 'extract': return cmdExtract(flags);
    case 'grid': return cmdGrid(pos, flags);
    case 'assert': return cmdAssert(flags);
    case 'handoff': return cmdHandoff(pos, flags);
    case 'identify': return cmdIdentify(flags);
    case 'events-summary': return pos[0] ? require('../lib/events').summary(pos[0], flags) : die(SUB_HELP['events-summary']);
    case 'recorder-convert': return pos[0] ? require('../lib/events').convert(pos[0], flags) : die(SUB_HELP['recorder-convert']);
    default: helpMain(); return EXIT_ERR;
  }
}
main().then((code) => {
  if (!helpOnly) log.info('cdp', `子命令 ${process.argv[2] || '-'} 完成 exit=${code}`);
  /* 出口②兜底：cmd 内 console.error + return EXIT_ERR 型（无 exitCtx）——此处补发失败信封（去重） */
  if (code !== 0) finalizeFailure(code);
  process.exit(code);
}).catch((e) => {
  const kind = e && e.kind ? require('../lib/cdp-core').kindText(e.kind) : '错误';
  if (!helpOnly) log.error('cdp', `子命令 ${process.argv[2] || '-'} 失败 [${kind}]：${e.message}`, e);
  /* 出口①：throw 型——按 cdp-core kind + 消息模式映射码（信封由 exit hook 发射） */
  noteFail(errors.codeFor({ kind: e && e.kind, message: e && e.message ? e.message : String(e) }), e && e.message ? e.message : String(e));
  console.error(`✗ [${kind}] ${e.message}`);
  /* GQ-004：连接类失败且 browserUrl 是 NAS 容器服务名时，stderr 追加一行可操作提示（Windows 误拷 linux 实例） */
  try {
    if (e && (e.kind === 'conn' || e.kind === 'timeout')) {
      const core = require('../lib/cdp-core');
      const hint = core.nasBrowserUrlHint(e.browserUrl || core.resolveBrowserUrl());
      if (hint) console.error(`ℹ ${hint}`);
      /* 批C2/R2：config 有 chrome 三键 → launch 能力已就绪，给出 OS 级拉起入口（无 keep-alive 环境的自愈路径） */
      try {
        const cfg = require('../lib/config').loadConfig();
        const ch = cfg && cfg.chrome;
        if (ch && ch.launchCommand && ch.debugPort && ch.userDataDir) {
          console.error('ℹ 可运行 node tools/cdp.js browser-up 启动调试实例（或加 --auto-launch 自动保障）');
        }
      } catch { /* 配置坏：不覆盖原始错误提示 */ }
    }
  } catch { /* 提示失败不影响原始错误 */ }
  process.exit(EXIT_ERR);
});
