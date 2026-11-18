'use strict';
/*
 * chromeuse lib/jsonc.js —— JSONC 解析（唯一实现，install.js / selftest.js 共用）
 *
 * 设计约束（来自设计方案 §12.1 / §14）：
 * - 严禁正则剥注释："http://..." 串内 // 必坏正则方案；逐字符四态状态机（normal / in-string / line-comment / block-comment）
 * - 注释替换为等长空白、换行保留 → JSON.parse 报错行号与源文件一致（排障定位不漂移）
 * - in-string 处理 \" 转义（转义内的引号不终止字符串）
 * - 尾逗号二次扫描删除（含嵌套对象/数组）
 * - 拒绝 UTF-8 BOM；块注释不嵌套（/* 内再遇 /* 按普通注释文本处理）
 * - 导出 stripComments / parse / readConfig
 */
const fs = require('node:fs');

/** 逐字符四态状态机：剥离注释与尾逗号，保持行号不变 */
function stripComments(text) {
  if (typeof text !== 'string') throw new Error('jsonc: 输入不是字符串');
  if (text.charCodeAt(0) === 0xfeff) {
    throw new Error('jsonc: 检测到 UTF-8 BOM，请以无 BOM UTF-8 保存');
  }
  let out = '';
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : undefined;
    if (state === 'normal') {
      if (ch === '"') {
        state = 'in-string';
        out += ch;
      } else if (ch === '/' && next === '/') {
        state = 'line-comment';
        out += '  '; // 两个字符等长替换
        i++;
      } else if (ch === '/' && next === '*') {
        state = 'block-comment';
        out += '  ';
        i++;
      } else {
        out += ch;
      }
    } else if (state === 'in-string') {
      if (ch === '\\') {
        // 转义：连同被转义字符原样保留（含 \" 与 \\；EOF 处悬空反斜杠只保留自身）
        out += ch;
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        state = 'normal';
        out += ch;
      } else {
        out += ch;
      }
    } else if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') {
        state = 'normal';
        out += ch; // 换行保留 → 行号一致
      } else {
        out += ' ';
      }
    } else {
      // block-comment（不嵌套：内部一切字符按注释文本处理，直到 */
      if (ch === '*' && next === '/') {
        state = 'normal';
        out += '  ';
        i++;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
    }
  }
  return removeTrailingCommas(out);
}

/** 二次扫描删除尾逗号（逗号替换为空格，位置不变 → 行号仍一致） */
function removeTrailingCommas(text) {
  const chars = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (j < text.length && (text[j] === '}' || text[j] === ']')) chars[i] = ' ';
  }
  return chars.join('');
}

/** 解析 JSONC 文本 → JS 对象；失败时抛出带行号的错误 */
function parse(text) {
  const stripped = stripComments(text);
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    let at = '';
    if (m) {
      const line = (stripped.slice(0, Number(m[1])).match(/\n/g) || []).length + 1;
      at = `（第 ${line} 行附近）`;
    }
    throw new Error(`jsonc: JSON 解析失败${at}：${e.message}`);
  }
}

/** 读文件 + parse + schemaVersion 校验（install.js / selftest.js 的 fail-fast 入口） */
function readConfig(p) {
  const text = fs.readFileSync(p, 'utf8');
  const data = parse(text);
  if (typeof data.schemaVersion !== 'number') {
    throw new Error(`config: schemaVersion 缺失或非数字（got ${JSON.stringify(data.schemaVersion)}）——schema 变更须查 CHANGELOG 迁移说明`);
  }
  return data;
}

module.exports = { stripComments, removeTrailingCommas, parse, readConfig };
