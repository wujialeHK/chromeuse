'use strict';
/*
 * chromeuse selftest/common.js —— 共享断言框架与 helper（自单文件 selftest.js 拆出）
 * 内容：断言框架（pass/warn/fail/check/checkAbsent + 计数器 + summary 汇总收口）、
 * 文件 helper（read/exists/countLines/tryParseTpl）、对象 helper（keyPaths/hasPath/deepEqual/findKeyPath）、
 * webapp.md 模板字段检查纯函数 webappTemplateIssues（#14 与 #32 单测共用——Node 侧可直接喂合成内容）。
 * 注意：① DIR 恒指 skill 根目录（本文件位于 selftest/ 子目录，故取上一级）；
 *       ② fake client/合成页构造在各组内联（spawnSync 子进程承载 async），无跨组共享体，不在此抽提。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../lib/jsonc');
const log = require('../lib/log');

const DIR = path.join(__dirname, '..'); // skill 根目录（selftest/ 上一级）
let passCount = 0, warnCount = 0, failCount = 0;

function pass(id, msg) { passCount++; console.log(`  ✓ [#${id}] ${msg}`); }
function warn(id, msg) { warnCount++; console.log(`  ⚠ [#${id}] WARN ${msg}`); }
function fail(id, msg) { failCount++; console.log(`  ✗ [#${id}] FAIL ${msg}`); }
function check(id, cond, failMsg, passMsg) { cond ? pass(id, passMsg || failMsg) : fail(id, failMsg); }
/** 「须不存在」型断言：通过时输出"无 X"而不是复述失败文案 */
function checkAbsent(id, cond, failMsg, passMsg) { cond ? fail(id, failMsg) : pass(id, passMsg || failMsg); }

function read(p) { return fs.readFileSync(path.join(DIR, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(DIR, p)); }
function countLines(p) {
  const c = read(p);
  return c.endsWith('\n') ? c.split('\n').length - 1 : c.split('\n').length;
}
function tryParseTpl(file, id) {
  try { return parse(read(file)); }
  catch (e) { fail(id, `${file} 解析失败：${e.message}`); return null; }
}

function keyPaths(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out;
}

function hasPath(obj, p) {
  let cur = obj;
  for (const seg of p.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function findKeyPath(obj, name, prefix = '') {
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (k === name) return p;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = findKeyPath(v, name, p);
      if (hit) return hit;
    }
  }
  return null;
}

/** webapp.md 模板字段检查纯函数（#14 与 #32 单测共用；Node 侧可直接喂合成内容）。
 *  快赢修复背景：修复前 #14 以 `statusM[1]` 模板串作 check() 实参——JS 实参急切求值，
 *  缺状态行时 statusM 为 null 直接 TypeError 崩栈，而非走 fail 分支给清晰文案。 */
function webappTemplateIssues(content) {
  const statusM = /^[-*]\s*状态[：:]\s*(active|stale)/m.exec(content);
  return {
    status: statusM ? statusM[1] : null,
    statusLine: !!statusM,
    lastVerified: /last-verified[：:]\s*\d{4}-\d{2}-\d{2}/.test(content),
    env: /验证环境/.test(content),
    identity: /识别特征/.test(content),
    ops: /专属操作手法/.test(content),
  };
}

/** 汇总收口（原 selftest.js 尾部汇总段，原样迁移——计数器单源） */
function summary() {
  console.log(`\n结果：${passCount} 过 / ${warnCount} warn / ${failCount} fail`);
  log.info('selftest', `结构自检完成：${passCount} 过 / ${warnCount} warn / ${failCount} fail${failCount ? '（FAIL）' : '（ALL PASS）'}`);
  if (failCount > 0) {
    console.log('SELFTEST：FAIL（存在未过检查项）');
    process.exit(1);
  }
  console.log('SELFTEST：ALL PASS');
  process.exit(0);
}

module.exports = {
  DIR, pass, warn, fail, check, checkAbsent,
  read, exists, countLines, tryParseTpl,
  keyPaths, hasPath, deepEqual, findKeyPath,
  webappTemplateIssues, summary,
};
