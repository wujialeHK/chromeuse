'use strict';
/*
 * chromeuse lib/extract.js —— 结构化抽取（B4/N8 #104，V202611030006）
 *
 * 定位：把「列表页抽文本 / 表格首行表头映射 / 属性值 / 链接去重 / JSON-LD+内嵌 JSON」
 * 做成原语，替代每次让模型手写 eval（引号地狱 / 每站重写 JS / 注入面大）。
 *
 * 红线（与 SKILL §三 同源）：
 *   - 页面侧表达式**只读**：零合成事件、零导航、零文件注入、零页面写；
 *   - 跨同源 iframe（与 locator 同口径：contentDocument，跨域不可见）；
 *   - 结果只经 Runtime.evaluate 回传，Node 侧不做二次页面访问。
 *
 * 结果形状：{ kind, selector, count, items, truncated, errors? }
 *   - count = 截断前总数；items = 截断后前 limit 项；truncated = count > limit。
 *   - 文本模式渲染在 tools/cdp.js（compact 行）；本模块零 IO。
 */
const { evaluate } = require('./cdp-core');

const KINDS = ['text', 'table', 'attr', 'links', 'json'];
const DEFAULT_LIMIT = 100;
const LIMIT_MAX = 5000;
const DEFAULT_TIMEOUT_MS = 10000;

/** 旗标归一（建连前调用；错误消息含「缺值/仅支持/须为」→ die 归类 E_USAGE） */
function normalizeOptions(src) {
  const o = src || {};
  const kind = o.kind === undefined ? 'text' : String(o.kind).trim();
  if (!KINDS.includes(kind)) throw new Error(`--kind 仅支持 ${KINDS.join('|')}（收到 ${JSON.stringify(o.kind)}）`);
  let selector = null;
  if (o.selector !== undefined && o.selector !== null) {
    if (typeof o.selector !== 'string' || !o.selector.trim()) throw new Error('--selector 缺值（CSS 选择器；省略=默认全文 text）');
    selector = o.selector.trim();
  }
  let attr = null;
  if (o.attr !== undefined && o.attr !== null) {
    if (typeof o.attr !== 'string' || !o.attr.trim()) throw new Error('--attr 缺值（要读取的属性名，如 href/title/src）');
    attr = o.attr.trim();
  }
  if (kind === 'attr' && !attr) throw new Error('extract --kind attr 需要 --attr <name>（要读取的属性名）');
  if (attr && kind !== 'attr') throw new Error('--attr 仅与 --kind attr 搭配（其它 kind 不接受 --attr）');
  let limit = DEFAULT_LIMIT;
  if (o.limit !== undefined && o.limit !== null) {
    if (o.limit === true) throw new Error(`--limit 缺值（1~${LIMIT_MAX} 的整数，默认 ${DEFAULT_LIMIT}）`);
    const n = Number(o.limit);
    if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) throw new Error(`--limit 须为 1~${LIMIT_MAX} 的整数（收到 ${JSON.stringify(o.limit)}）`);
    limit = n;
  }
  return { kind, selector, attr, limit };
}

/* ── 纯函数（页面侧注入源 + Node 侧单测） ── */

/** 表头去重：重复列名追加 #2/#3（避免对象键互相覆盖） */
function headersUnique(head) {
  const seen = Object.create(null);
  return (Array.isArray(head) ? head : []).map((h, i) => {
    const base = String(h == null ? '' : h).trim() || ('col' + (i + 1));
    const n = seen[base] || 0;
    seen[base] = n + 1;
    return n ? base + '#' + (n + 1) : base;
  });
}

/** 行数组 → 对象（首行表头映射；缺列名补 colN） */
function rowsToObjects(head, rows) {
  const keys = headersUnique(head);
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const cells = Array.isArray(row) ? row : [];
    if (!cells.length) continue;
    const obj = {};
    for (let i = 0; i < cells.length; i++) obj[keys[i] || ('col' + (i + 1))] = String(cells[i] == null ? '' : cells[i]).replace(/\s+/g, ' ').trim();
    out.push(obj);
  }
  return out;
}

/** 链接去重（按 href 绝对地址；保序） */
function dedupeLinks(list) {
  const seen = Object.create(null);
  const out = [];
  for (const it of (Array.isArray(list) ? list : [])) {
    const href = String((it && it.href) || '');
    if (!href || seen[href]) continue;
    seen[href] = 1;
    out.push({ href, text: String((it && it.text) || '').slice(0, 200), title: String((it && it.title) || '').slice(0, 200) });
  }
  return out;
}

/**
 * 页面侧抽取表达式（只读）。
 * spec={kind,selector,attr,limit}
 */
function buildExtractExpr(spec) {
  const s = spec || {};
  return `(function(){ return (function(S){
    ${headersUnique.toString()}
    ${rowsToObjects.toString()}
    ${dedupeLinks.toString()}
    function docsWalk(){
      var docs = [];
      (function walk(doc){
        docs.push(doc);
        var fr = []; try { fr = doc.querySelectorAll('iframe,frame'); } catch(e) {}
        for (var i = 0; i < fr.length; i++) {
          var inner = null; try { inner = fr[i].contentDocument; } catch(e) {}
          if (inner) walk(inner);
        }
      })(document);
      return docs;
    }
    function pick(doc, sel){
      var out = [];
      try { out = Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch(e) { out = []; }
      return out;
    }
    function textOf(el){
      var t = '';
      try { t = el.innerText != null ? String(el.innerText) : String(el.textContent || ''); } catch(e) { t = ''; }
      return t.replace(/\s+/g, ' ').trim();
    }
    function cellText(c){ return textOf(c); }
    function finish(items, errors){
      var total = items.length;
      var truncated = total > S.limit;
      return { kind: S.kind, selector: S.selector, count: total, items: items.slice(0, S.limit), truncated: truncated, errors: errors || 0 };
    }
    var docs = docsWalk();
    var i, j, els, items = [];

    if (S.kind === 'text') {
      if (!S.selector) {
        var body = document.body ? String(document.body.innerText || document.body.textContent || '') : '';
        var full = body.replace(/\\r/g, '').trim();
        return finish(full ? [full] : []);
      }
      for (i = 0; i < docs.length; i++) {
        els = pick(docs[i], S.selector);
        for (j = 0; j < els.length; j++) {
          var tx = textOf(els[j]);
          if (tx) items.push(tx);
        }
      }
      return finish(items);
    }

    if (S.kind === 'attr') {
      for (i = 0; i < docs.length; i++) {
        els = pick(docs[i], S.selector);
        for (j = 0; j < els.length; j++) {
          var v = null;
          try { v = els[j].getAttribute(S.attr); } catch(e) { v = null; }
          if (v !== null) items.push(String(v));
        }
      }
      return finish(items);
    }

    if (S.kind === 'links') {
      for (i = 0; i < docs.length; i++) {
        els = pick(docs[i], S.selector || 'a[href]');
        for (j = 0; j < els.length; j++) {
          var el = els[j];
          var anchors = [];
          try { if (el.matches && el.matches('a[href]')) anchors.push(el); } catch(e) {}
          try { anchors = anchors.concat(Array.prototype.slice.call(el.querySelectorAll('a[href]'))); } catch(e) {}
          for (var k = 0; k < anchors.length; k++) {
            var a = anchors[k];
            var href = '';
            try { href = String(a.href || a.getAttribute('href') || ''); } catch(e) { href = ''; }
            if (!href) continue;
            var title = '';
            try { title = a.getAttribute('title') || ''; } catch(e) {}
            items.push({ href: href, text: textOf(a), title: String(title) });
          }
        }
      }
      return finish(dedupeLinks(items));
    }

    if (S.kind === 'table') {
      var tables = [];
      for (i = 0; i < docs.length; i++) {
        if (!S.selector) { tables = tables.concat(pick(docs[i], 'table')); continue; }
        els = pick(docs[i], S.selector);
        for (j = 0; j < els.length; j++) {
          var e = els[j];
          if (String(e.tagName || '').toLowerCase() === 'table') tables.push(e);
          else tables = tables.concat(pick(e, 'table'));
        }
      }
      for (i = 0; i < tables.length; i++) {
        var rows = [];
        try { rows = Array.prototype.slice.call(tables[i].rows || tables[i].querySelectorAll('tr')); } catch(e) { rows = []; }
        if (!rows.length) continue;
        var cellsOf = function(row){
          var cs = [];
          try { cs = Array.prototype.slice.call(row.cells || row.querySelectorAll('th,td')); } catch(e) { cs = []; }
          return cs.map(cellText);
        };
        var head = cellsOf(rows[0]);
        var bodyRows = [];
        for (j = 1; j < rows.length; j++) bodyRows.push(cellsOf(rows[j]));
        items = items.concat(rowsToObjects(head, bodyRows));
      }
      return finish(items);
    }

    // kind === 'json'：JSON-LD + 内嵌 application/json（可选 selector 覆盖扫描面）
    var scripts = [];
    for (i = 0; i < docs.length; i++) {
      scripts = scripts.concat(pick(docs[i], S.selector || 'script[type="application/ld+json"],script[type="application/json"]'));
    }
    var errors = 0;
    for (i = 0; i < scripts.length; i++) {
      var raw = '';
      try { raw = String(scripts[i].textContent || ''); } catch(e) { raw = ''; }
      if (!raw.trim()) continue;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch(e) { errors++; continue; }
      if (Array.isArray(parsed)) items = items.concat(parsed);
      else items.push(parsed);
    }
    return finish(items, errors);
  })( ${JSON.stringify(s)} ); })()`;
}

/**
 * 抽取执行（只读 evaluate）。
 * @param {object} client CdpClient（或 fake：需 send('Runtime.evaluate')）
 * @param {string} sessionId
 * @param {object} opts {kind,selector,attr,limit,timeoutMs}
 * @returns {Promise<{kind,selector,count,items,truncated,errors?}>}
 */
async function extract(client, sessionId, opts) {
  const o = normalizeOptions(opts);
  const raw = await evaluate(client, sessionId, buildExtractExpr(o), (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  let rep = raw;
  if (typeof raw === 'string' && raw) { try { rep = JSON.parse(raw); } catch (e) { rep = null; } }
  if (!rep || typeof rep !== 'object' || !Array.isArray(rep.items)) throw new Error('extract 页面表达式返回非法（缺 items 数组）');
  rep.kind = rep.kind || o.kind;
  rep.selector = rep.selector === undefined ? o.selector : rep.selector;
  rep.count = Number.isFinite(rep.count) ? rep.count : rep.items.length;
  rep.truncated = rep.truncated === true;
  if (Number.isFinite(rep.errors) && rep.errors > 0) rep.errors = rep.errors; else delete rep.errors;
  return rep;
}

module.exports = {
  KINDS, DEFAULT_LIMIT, LIMIT_MAX, DEFAULT_TIMEOUT_MS,
  normalizeOptions, headersUnique, rowsToObjects, dedupeLinks, buildExtractExpr, extract,
};
