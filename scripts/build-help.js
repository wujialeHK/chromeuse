#!/usr/bin/env node
/* build-help.js —— 帮助面同源化构建器（C8a 产物① / C8b 接线产物②；规划见 tmpdata/agent-cleanup-261104/deep-d1.md）
 *
 * 源 = commands.meta.json（唯一事实源）
 * 产物① = tools/cdp.js 内 `const SUB_HELP = {` … `\n};` 块（整体覆写；运行时零变化，仍是字面量）
 * 产物② = SKILL.md §1.2 的 #### 组段（就地覆写「§1.2 引导 blockquote 之后、### 1.3 之前」；引导 blockquote 手写）
 *
 * 模板（从现状 SUB_HELP 原文反切校准，detail 为空时省略「；」——5 条无 detail 命令原文无尾分号）：
 *   SUB_HELP：用法：{usage} —— {summary}；{detail}
 *   SKILL：  - `{usage}` — {title || summary}（title 可选，给「--json 先行」/超长 summary 命令更短的一行式）
 *
 * 用法：
 *   node scripts/build-help.js                     # 覆写 cdp.js SUB_HELP + SKILL §1.2（幂等）+ node --check
 *   node scripts/build-help.js --check             # 只检查两产物是否同步（漂移 exit 1，不写盘）
 *   node scripts/build-help.js --preview <file>    # 额外输出 SKILL §1.2 组段预览（相对路径以 skill 根解析）
 *
 * 零第三方依赖。部署模式不变：产物入库，覆盖复制即部署，live 无需 build。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const META_PATH = path.join(ROOT, 'commands.meta.json');
const CDP_PATH = path.join(ROOT, 'tools/cdp.js');
const SKILL_PATH = path.join(ROOT, 'SKILL.md');
const ANCHOR_START = 'const SUB_HELP = {';
const ANCHOR_END = '\n};';
const QUICKREF_START = 'const CMD_QUICKREF = `';
const QUICKREF_END = '`;';
const QUICKREF_TITLE = '命令名速查';
const SKILL_12_HEAD = '### 1.2 命令速查（按场景分组）';
const SKILL_12_GROUPS_START = '#### ';
const SKILL_13_HEAD = '### 1.3 ';
const SEP = ' —— ';
const GENERATED_NOTE = '  // ⚠ 本块由 scripts/build-help.js 从 commands.meta.json 生成（C8a 同源化）：改命令=改 meta + 跑 build，勿手改本块';

function fail(msg) {
  console.error(`✗ build-help：${msg}`);
  process.exit(1);
}

function loadMeta() {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch (e) {
    fail(`commands.meta.json 读取/解析失败：${e.message}`);
  }
  if (meta.schemaVersion !== 1) fail(`schemaVersion 须为 1（实际 ${meta.schemaVersion}）`);
  if (!Array.isArray(meta.groups) || !meta.groups.length) fail('groups 须为非空数组');
  const groupIds = new Set();
  for (const g of meta.groups) {
    if (!g || typeof g.id !== 'string' || !g.id) fail('groups[].id 缺失');
    if (groupIds.has(g.id)) fail(`groups[].id 重复：${g.id}`);
    if (typeof g.title !== 'string' || !g.title) fail(`groups[${g.id}].title 缺失`);
    if (!Array.isArray(g.commands) || !g.commands.length) fail(`groups[${g.id}].commands 须为非空数组（§1.2 展示顺序）`);
    groupIds.add(g.id);
  }
  if (!meta.commands || typeof meta.commands !== 'object') fail('commands 须为对象');
  const names = Object.keys(meta.commands);
  if (!names.length) fail('commands 为空');
  const listed = new Set();
  for (const g of meta.groups) {
    for (const name of g.commands) {
      if (listed.has(name)) fail(`groups[].commands 重复登记：${name}`);
      listed.add(name);
    }
  }
  for (const name of names) if (!listed.has(name)) fail(`命令 ${name} 未在任何 groups[].commands 登记`);
  for (const name of listed) if (!(name in meta.commands)) fail(`groups[].commands 含未知命令：${name}`);
  const usedGroups = new Set();
  for (const name of names) {
    const c = meta.commands[name];
    if (!/^[a-z0-9-]+$/.test(name)) fail(`命令名非法：${name}`);
    if (typeof c.usage !== 'string' || !c.usage.startsWith(`cdp.js ${name}`)) fail(`${name}.usage 须以 "cdp.js ${name}" 开头`);
    if (typeof c.summary !== 'string' || !c.summary) fail(`${name}.summary 缺失`);
    /* title 可选：只供 SKILL §1.2 一行式投影（summary 仍供 SUB_HELP 拼装 → 帮助面零漂移） */
    if (c.title !== undefined) {
      if (typeof c.title !== 'string' || !c.title.trim()) fail(`${name}.title 若给须为非空字符串`);
      if (c.title.length > 120) fail(`${name}.title 超长（${c.title.length} > 120 字符）`);
      if (/[\r\n]/.test(c.title)) fail(`${name}.title 须为单行（不含换行）`);
    }
    if (typeof c.detail !== 'string') fail(`${name}.detail 须为字符串（无详情用空串）`);
    if (!Array.isArray(c.flags) || c.flags.some((f) => typeof f !== 'string' || !/^--[a-z0-9-]+$/.test(f))) fail(`${name}.flags 须为 --kebab-case 字符串数组`);
    if (!groupIds.has(c.group)) fail(`${name}.group 未在 groups 声明：${c.group}`);
    if (!(c.since === null || (typeof c.since === 'string' && c.since))) fail(`${name}.since 须为 null 或非空字符串`);
    if (typeof c.jsonAllowed !== 'boolean') fail(`${name}.jsonAllowed 须为布尔`);
    usedGroups.add(c.group);
  }
  for (const g of meta.groups) if (!usedGroups.has(g.id)) fail(`组 ${g.id} 无任何命令`);
  for (const g of meta.groups) for (const name of g.commands) {
    if (meta.commands[name].group !== g.id) fail(`${name}.group=${meta.commands[name].group} 与 groups[${g.id}] 登记不一致`);
  }
  /* 组标题由本脚本生成（C8b 接线）：不再预检 SKILL 现状——否则 meta 改标题会被旧标题卡住，
   * 违背单源；漂移由 --check 的区域逐字节比对兜底（selftest #116 ⑤ 另断言标题/组序一致）。 */
  return meta;
}

/* SUB_HELP 单条文本模板（与现原文反切互逆） */
function commandText(c) {
  return `用法：${c.usage}${SEP}${c.summary}${c.detail ? '；' + c.detail : ''}`;
}

/* JS 单引号字符串转义（与现状源码风格一致：\' / \\ / 换行转义） */
function jsString(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderBlock(meta) {
  const lines = [ANCHOR_START, GENERATED_NOTE];
  for (const [name, c] of Object.entries(meta.commands)) {
    const key = /^[a-z0-9]+$/.test(name) ? name : `'${name}'`;
    lines.push(`  ${key}: '${jsString(commandText(c))}',`);
  }
  lines.push('};');
  return lines.join('\n');
}

function readCdp() {
  return fs.readFileSync(CDP_PATH, 'utf8');
}

function locateBlock(src) {
  const start = src.indexOf(ANCHOR_START);
  if (start < 0) fail(`cdp.js 未找到锚点「${ANCHOR_START}」`);
  if (src.indexOf(ANCHOR_START, start + 1) >= 0) fail(`cdp.js 锚点「${ANCHOR_START}」出现多次`);
  const end = src.indexOf(ANCHOR_END, start);
  if (end < 0) fail('cdp.js 未找到 SUB_HELP 块尾锚点');
  return { start, end: end + ANCHOR_END.length };
}

/* 产物③ quickref：cdp.js 模块级 `const CMD_QUICKREF = `…`;` 块（helpMain `${CMD_QUICKREF}` 插值，
 * 子命令详情区头部速查——工具输出截断保头，冷启动 agent 读前几百字符即获全部命令名）。
 * 内容纯「组id: 命令名 …」纯文本；模板字符串安全=renderQuickref 防御性拒绝反引号与 ${。 */
function renderQuickref(meta) {
  const total = Object.keys(meta.commands).length;
  const lines = [`${QUICKREF_TITLE}（${total}，按组；参数与语义见下方逐条）：`];
  for (const g of meta.groups) lines.push(`  ${g.id}: ${g.commands.join(' ')}`);
  const body = lines.join('\n');
  if (body.includes('`') || body.includes('${')) fail('quickref 生成内容含反引号或 ${（模板字符串注入风险）');
  return `${QUICKREF_START}${body}${QUICKREF_END}`;
}

function locateQuickref(src) {
  const start = src.indexOf(QUICKREF_START);
  if (start < 0) fail(`cdp.js 未找到锚点「${QUICKREF_START}」`);
  if (src.indexOf(QUICKREF_START, start + 1) >= 0) fail(`cdp.js 锚点「${QUICKREF_START}」出现多次`);
  const end = src.indexOf(QUICKREF_END, start + QUICKREF_START.length);
  if (end < 0) fail('cdp.js 未找到 quickref 块尾锚点');
  return { start, end: end + QUICKREF_END.length };
}

function describeDiff(cur, next) {
  const a = cur.split('\n');
  const b = next.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const cut = (s) => (s === undefined ? '<缺失>' : JSON.stringify(s.slice(0, 160)) + (s.length > 160 ? '…' : ''));
      return `首个差异行 ${i + 1}：\n  现状 ${cut(a[i])}\n  生成 ${cut(b[i])}`;
    }
  }
  return '无行级差异（疑为换行/编码差异）';
}

/* SKILL §1.2 组段：`- \`{usage}\` — {title || summary}`（C8b 接线：替换 §1.2 引导 blockquote 之后、§1.3 之前） */
function renderSkillGroups(meta) {
  const out = [];
  for (const g of meta.groups) {
    out.push(`#### ${g.title}`);
    for (const name of g.commands) {
      const c = meta.commands[name];
      out.push(`- \`${c.usage}\` — ${c.title || c.summary}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/* SKILL §1.2 组段区域：§1.2 标题后首个 `#### ` 起，至 `### 1.3` 前止（引导 blockquote 保留手写） */
function locateSkillRegion(src) {
  const head = src.indexOf(SKILL_12_HEAD);
  if (head < 0) fail(`SKILL.md 未找到 §1.2 标题「${SKILL_12_HEAD}」`);
  const start = src.indexOf(SKILL_12_GROUPS_START, head);
  if (start < 0) fail('SKILL.md §1.2 未找到 #### 组段起点');
  const end = src.indexOf(SKILL_13_HEAD, start);
  if (end < 0) fail('SKILL.md §1.2 未找到 ### 1.3 组段终点');
  return { start, end };
}

function checkSyntax() {
  const r = spawnSync(process.execPath, ['--check', CDP_PATH], { encoding: 'utf8' });
  if (r.status !== 0) fail(`node --check tools/cdp.js 失败：\n${(r.stderr || r.stdout || '').trim()}`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('node scripts/build-help.js [--check] [--preview <file>]\n  默认：从 commands.meta.json 重生成 cdp.js 的 SUB_HELP 块 + CMD_QUICKREF 块 + SKILL.md §1.2 组段（整体覆写，幂等）+ node --check\n  --check：只检查三产物是否同步（漂移 exit 1，不写盘）\n  --preview <file>：额外生成 SKILL §1.2 组段预览（相对路径以 skill 根解析）');
    return 0;
  }
  const meta = loadMeta();
  const wantCheck = argv.includes('--check');
  const previewAt = argv.indexOf('--preview');
  const previewPath = previewAt >= 0 ? argv[previewAt + 1] : null;
  if (previewAt >= 0 && (!previewPath || previewPath.startsWith('--'))) fail('--preview 缺文件路径');

  const src = readCdp();
  const { start, end } = locateBlock(src);
  const current = src.slice(start, end);
  const rendered = renderBlock(meta);
  const quick = locateQuickref(src);
  const currentQuick = src.slice(quick.start, quick.end);
  const renderedQuick = renderQuickref(meta);
  const skillSrc = fs.readFileSync(SKILL_PATH, 'utf8');
  const skillLoc = locateSkillRegion(skillSrc);
  const currentSkill = skillSrc.slice(skillLoc.start, skillLoc.end);
  const renderedSkill = renderSkillGroups(meta);

  if (wantCheck) {
    const cdpOk = current === rendered;
    const quickOk = currentQuick === renderedQuick;
    const skillOk = currentSkill === renderedSkill;
    if (cdpOk && quickOk && skillOk) {
      console.log(`✓ 三产物与 commands.meta.json 同步（${Object.keys(meta.commands).length} 命令；SUB_HELP sha256=${crypto.createHash('sha256').update(rendered).digest('hex').slice(0, 16)}…，CMD_QUICKREF sha256=${crypto.createHash('sha256').update(renderedQuick).digest('hex').slice(0, 16)}…，SKILL §1.2 sha256=${crypto.createHash('sha256').update(renderedSkill).digest('hex').slice(0, 16)}…）`);
      return 0;
    }
    if (!cdpOk) {
      console.error('✗ SUB_HELP 与 commands.meta.json 不同步（改命令须改 meta + 跑 build，勿直改 cdp.js）');
      console.error(describeDiff(current, rendered));
    }
    if (!quickOk) {
      console.error('✗ CMD_QUICKREF 与 commands.meta.json 不同步（改命令须改 meta + 跑 build，勿直改 cdp.js）');
      console.error(describeDiff(currentQuick, renderedQuick));
    }
    if (!skillOk) {
      console.error('✗ SKILL.md §1.2 组段与 commands.meta.json 不同步（改命令须改 meta + 跑 build，勿手改 §1.2 组段）');
      console.error(describeDiff(currentSkill, renderedSkill));
    }
    return 1;
  }

  let wrote = false;
  /* 同一文件两个锚点：按 start 降序应用（后位先改），避免偏移失效 */
  let nextSrc = src;
  if (current !== rendered || currentQuick !== renderedQuick) {
    const editsToApply = [
      { start, end, cur: current, next: rendered, label: 'SUB_HELP' },
      { start: quick.start, end: quick.end, cur: currentQuick, next: renderedQuick, label: 'CMD_QUICKREF' },
    ].filter((e) => e.cur !== e.next).sort((a, b) => b.start - a.start);
    for (const e of editsToApply) {
      nextSrc = nextSrc.slice(0, e.start) + e.next + nextSrc.slice(e.end);
      console.log(`✓ ${e.label} 已重建：${Object.keys(meta.commands).length} 命令（${e.cur.length} → ${e.next.length} 字符）`);
    }
    fs.writeFileSync(CDP_PATH, nextSrc);
    wrote = true;
  }
  if (currentSkill !== renderedSkill) {
    fs.writeFileSync(SKILL_PATH, skillSrc.slice(0, skillLoc.start) + renderedSkill + skillSrc.slice(skillLoc.end));
    console.log(`✓ SKILL §1.2 已重建：${meta.groups.length} 组 / ${Object.keys(meta.commands).length} 命令（${currentSkill.length} → ${renderedSkill.length} 字符）`);
    wrote = true;
  }
  if (!wrote) console.log(`✓ 三产物已是最新：${Object.keys(meta.commands).length} 命令（幂等，未写盘）`);
  checkSyntax();
  console.log('✓ node --check tools/cdp.js 通过');

  if (previewPath) {
    const abs = path.isAbsolute(previewPath) ? previewPath : path.join(ROOT, previewPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, renderedSkill);
    console.log(`✓ SKILL §1.2 预览已生成：${path.relative(ROOT, abs)}`);
  }
  return 0;
}

process.exit(main());
