'use strict';
/*
 * chromeuse lib/grid.js —— 虚拟化网格（react-data-grid 等 windowing 表格）读数与定位
 * （C9 / TODO L61 第三段，V20261104004；取证纪律见 references/playbook.md「虚拟化网格取证纪律」）
 *
 * 两半拆分（人设对齐，deep-d2 §3 定稿）：
 *   - 读数（只读）    → extract --kind grid：extractGrid() 零合成事件/零导航/零滚动；
 *   - 定位+滚动渲染   → grid locate|scroll-to：允许滚动（副作用），滚动后派发一次原生 scroll
 *                      通知令 RDG 重算虚拟列（POC F2：程序化 scrollLeft 不会触发列虚拟化）。
 *
 * 核心语义（C6 纪律）：
 *   - 列头视觉序 = 按 getBoundingClientRect().left 升序（DOM 序≠视觉序；但 --col 文字→data 索引，
 *     绝不把视觉序号当列索引）；
 *   - 离屏未渲染 ≠ 空值：读数不滚动，未渲染时如实标注并给滚动复读提示；
 *   - 选择器双代际：v6 `.react-grid-*`（真实应用证据面）+ v7 `.rdg-*`（识别兜底）。
 *
 * 结果形状（readGrid）：{kind:'grid',found,generation,selector,framePath,container,scroll,rowHeight,
 *   totalRows,totalCols,renderedRows,visibleRows,headers[],visibleHeaders[],cell,cellRendered,target,warnings[]}
 * 零 IO；文本渲染在 tools/cdp.js。
 */
const { evaluate } = require('./cdp-core');

const NOT_RENDERED_HINT = '离屏未渲染≠空值（先滚动至可视复读：cdp.js grid locate/scroll-to --col <列头文字> --row <N>，C6 纪律）';
const MATCH_MODES = ['exact', 'contains'];
const DEFAULT_TIMEOUT_MS = 10000;
const POLL_MS = 120;
const NAV_HEADER_HINT = '列头未命中：列虚拟化下离屏列可能未渲染（离屏未渲染≠空值/≠缺列）——先横向滚动或 extract --kind grid 复看可见列头，再重试';

/* ── 纯函数（Node 侧单测 + 页面侧 toString 注入，单源） ── */

/** 视觉序：rect.left 升序；同 left（frozen 列等）按 data 索引稳定排序 */
function sortByLeft(list) {
  return (Array.isArray(list) ? list.slice() : []).sort(function (a, b) {
    var d = (Number(a && a.left) || 0) - (Number(b && b.left) || 0);
    if (d) return d;
    return (Number(a && a.index) || 0) - (Number(b && b.index) || 0);
  });
}

/** 代际识别：v6 `.react-grid-*` 优先（真实应用证据面），v7 `.rdg-*` 兜底 */
function detectGeneration(counts) {
  var c = counts || {};
  if ((Number(c.v6Rows) || 0) > 0 || (Number(c.v6Headers) || 0) > 0) return 'v6';
  if ((Number(c.v7Rows) || 0) > 0 || (Number(c.v7Headers) || 0) > 0) return 'v7';
  return null;
}

/** 列头匹配：exact 优先；无 exact 时唯一 contains 兜底；多 contains 判 ambiguous（不猜） */
function matchHeader(list, text, mode) {
  var want = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!want) return null;
  var exact = [], contains = [];
  for (var i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
    var t = String((list[i] && list[i].text) || '').replace(/\s+/g, ' ').trim();
    if (t === want) exact.push(i);
    else if (String(mode || 'exact') !== 'exact' && t.indexOf(want) >= 0) contains.push(i);
  }
  if (exact.length === 1) return { index: exact[0], mode: 'exact', ambiguous: 0 };
  if (exact.length > 1) return { index: exact[0], mode: 'exact', ambiguous: exact.length };
  if (contains.length === 1) return { index: contains[0], mode: 'contains', ambiguous: 0 };
  if (contains.length > 1) return { index: null, mode: 'ambiguous', ambiguous: contains.length };
  return null;
}

/** 参数归一（建连前调用；错误消息含「缺值/仅支持/须为/成对」→ die 归类 E_USAGE） */
function normalizeGridOptions(src, opts) {
  var o = src || {};
  var requirePair = !(opts && opts.requirePair === false);
  var selector = null;
  if (o.selector !== undefined && o.selector !== null) {
    if (typeof o.selector !== 'string' || !o.selector.trim()) throw new Error('--selector 缺值（网格容器 CSS；省略=自动探测 .react-grid-*/.rdg-*）');
    selector = o.selector.trim();
  }
  var col = null;
  if (o.col !== undefined && o.col !== null) {
    if (typeof o.col !== 'string' || !o.col.trim()) throw new Error('--col 缺值（列头文字，如「数量」）');
    col = o.col.trim();
  }
  var row = null;
  if (o.row !== undefined && o.row !== null) {
    if (o.row === true) throw new Error('--row 缺值（1 起算的数据行号）');
    var n = Number(o.row);
    if (!Number.isInteger(n) || n < 1 || n > 100000000) throw new Error('--row 须为 1 起算的整数（收到 ' + JSON.stringify(o.row) + '）');
    row = n;
  }
  if (requirePair) {
    if (col && row === null) throw new Error('--col 与 --row 须成对提供（只读单元格须同时指定列头文字与行号）');
    if (!col && row !== null) throw new Error('--col 与 --row 须成对提供（只读单元格须同时指定列头文字与行号）');
  }
  var match = o.match === undefined || o.match === null ? 'exact' : String(o.match).trim();
  if (!MATCH_MODES.includes(match)) throw new Error('--match 仅支持 exact|contains（收到 ' + JSON.stringify(o.match) + '）');
  var timeoutMs = DEFAULT_TIMEOUT_MS;
  if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
    var tm = Number(o.timeoutMs);
    if (!Number.isFinite(tm) || tm <= 0) throw new Error('--timeout 须为正整数毫秒');
    timeoutMs = tm;
  }
  return {
    selector: selector,
    col: col,
    row: row,
    match: match,
    restoreScroll: o.restoreScroll === undefined ? true : !!o.restoreScroll,
    timeoutMs: timeoutMs,
  };
}

/* ── 页面侧 helper（ES5 风格；函数体 toString 注入，零依赖） ── */

function _num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : d; }
function _qsa(el, sel) { try { return Array.prototype.slice.call(el.querySelectorAll(sel)); } catch (e) { return []; } }
function _txt(el) {
  var t = '';
  try { t = el.innerText != null ? String(el.innerText) : String(el.textContent || ''); } catch (e) { t = ''; }
  return t.replace(/\s+/g, ' ').trim();
}
function _rect(el) {
  var r = null;
  try { r = el.getBoundingClientRect(); } catch (e) { return null; }
  if (!r) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}
function _absRect(el, r) {
  var x = r.left, y = r.top, doc = el.ownerDocument, guard = 0;
  while (doc && doc.defaultView && doc.defaultView.frameElement && guard++ < 16) {
    var fe = doc.defaultView.frameElement;
    var fr = fe.getBoundingClientRect();
    x += fr.left; y += fr.top;
    doc = fe.ownerDocument;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
}
function _docs() {
  var out = [];
  (function walk(doc, fp) {
    out.push({ doc: doc, fp: fp });
    var fr = [];
    try { fr = doc.querySelectorAll('iframe,frame'); } catch (e) { fr = []; }
    for (var i = 0; i < fr.length; i++) {
      var inner = null;
      try { inner = fr[i].contentDocument; } catch (e) { inner = null; }
      if (inner) walk(inner, fp.concat([fr[i].id || fr[i].name || String(fr[i].tagName || 'iframe').toLowerCase()]));
    }
  })(document, []);
  return out;
}
function _styleLeft(el) {
  var n = _num(el.style && el.style.left, NaN);
  if (isFinite(n)) return n;
  var n2 = el.offsetLeft;
  return isFinite(n2) ? n2 : 0;
}
function _contentTop(el, stop) {
  var y = 0, e = el, guard = 0;
  while (e && e !== stop && guard++ < 64) { y += e.offsetTop || 0; e = e.offsetParent; }
  if (e === stop) return y;
  var r = _rect(el), sr = _rect(stop);
  return (r && sr) ? (r.top - sr.top + (stop.scrollTop || 0)) : 0;
}
function _isHeaderRow(el) { return /(^|\s)rdg-header-row(\s|$)/.test(String((el && el.className) || '')); }
function _partsAt(el) {
  var rows6 = _qsa(el, '.react-grid-Row');
  var h6 = _qsa(el, '.react-grid-HeaderCell');
  var rows7 = _qsa(el, '.rdg-row').filter(function (r) { return !_isHeaderRow(r); });
  var h7 = _qsa(el, '.rdg-header-row [role="gridcell"], .rdg-header-row .rdg-cell, .rdg-header-cell');
  var gen = detectGeneration({ v6Rows: rows6.length, v6Headers: h6.length, v7Rows: rows7.length, v7Headers: h7.length });
  return {
    root: el,
    generation: gen,
    rows: gen === 'v6' ? rows6 : (gen === 'v7' ? rows7 : []),
    headers: gen === 'v6' ? h6 : (gen === 'v7' ? h7 : []),
  };
}
function _findParts(el) {
  var cur = el, guard = 0, best = null;
  while (cur && guard++ < 8) {
    var p = _partsAt(cur);
    if (p.generation) {
      if (p.headers.length) return p;
      if (!best) best = p;
    }
    cur = cur.parentElement;
  }
  return best || _partsAt(el);
}
function _resolve(selector) {
  var docs = _docs(), i, j;
  if (selector) {
    for (i = 0; i < docs.length; i++) {
      var el = null;
      try { el = docs[i].doc.querySelector(selector); } catch (e) { return { err: 'bad-selector' }; }
      if (el) {
        var p = _findParts(el);
        if (!p.generation) return { err: 'not-a-grid' };
        return { root: p.root, parts: p, doc: docs[i].doc, fp: docs[i].fp };
      }
    }
    return { err: 'selector-not-found' };
  }
  for (i = 0; i < docs.length; i++) {
    var cands = _qsa(docs[i].doc, '.react-grid-Grid, .rdg, .react-grid-Canvas, .rdg-canvas, .react-grid-Viewport');
    for (j = 0; j < cands.length; j++) {
      var pp = _partsAt(cands[j]);
      if (pp.generation && pp.headers.length) return { root: cands[j], parts: pp, doc: docs[i].doc, fp: docs[i].fp };
    }
  }
  return { err: 'grid-not-found' };
}
function _scrollEl(root) {
  var cands = [root].concat(_qsa(root, '.react-grid-Canvas, .react-grid-Viewport, .rdg, .rdg-canvas, .react-grid-Grid'));
  var best = null, score = -1, i;
  for (i = 0; i < cands.length; i++) {
    var el = cands[i];
    var s = ((el.scrollHeight || 0) - (el.clientHeight || 0)) + ((el.scrollWidth || 0) - (el.clientWidth || 0));
    if (s > score) { score = s; best = el; }
  }
  return best || root;
}
function _scrollInfo(scrollEl) {
  return {
    top: Math.round(scrollEl.scrollTop || 0),
    left: Math.round(scrollEl.scrollLeft || 0),
    height: Math.round(scrollEl.scrollHeight || 0),
    width: Math.round(scrollEl.scrollWidth || 0),
    clientHeight: Math.round(scrollEl.clientHeight || 0),
    clientWidth: Math.round(scrollEl.clientWidth || 0),
  };
}
function _rowHeightOf(rows, scrollEl, totalRows) {
  var hs = [], i;
  for (i = 0; i < rows.length; i++) { var h = rows[i].offsetHeight || 0; if (h > 0) hs.push(h); }
  hs.sort(function (a, b) { return a - b; });
  if (hs.length) return hs[Math.floor(hs.length / 2)];
  var sh = scrollEl.scrollHeight || 0;
  if (totalRows > 0 && sh > 0) return sh / totalRows;
  return 35;
}
function _rowIndex(row, scrollEl, rowHeight, headerRows) {
  var aria = _num(row.getAttribute('aria-rowindex'), NaN);
  if (isFinite(aria)) return Math.max(1, Math.round(aria - headerRows));
  var top = _contentTop(row, scrollEl);
  return Math.round(top / (rowHeight || 35)) + 1;
}
function _headerList(parts) {
  var out = [], i;
  for (i = 0; i < parts.headers.length; i++) {
    var h = parts.headers[i];
    var r = _rect(h) || { left: 0, top: 0, width: 0, height: 0 };
    var ci = _num(h.getAttribute('aria-colindex'), NaN);
    if (!isFinite(ci)) ci = i + 1;
    out.push({
      text: _txt(h),
      index: Math.round(ci) - 1,
      domIndex: i,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      contentLeft: _styleLeft(h),
    });
  }
  return out;
}
function _nudgeScroll(el) {
  try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
}
function _cellOfRow(row, header) {
  var cells = _qsa(row, '.react-grid-Cell, .rdg-cell'), i;
  for (i = 0; i < cells.length; i++) {
    var ci = _num(cells[i].getAttribute('aria-colindex'), NaN);
    if (isFinite(ci) && ci === header.index + 1) return cells[i];
  }
  for (i = 0; i < cells.length; i++) {
    if (Math.abs(_styleLeft(cells[i]) - header.contentLeft) <= 1.5) return cells[i];
  }
  return null;
}
function _scrollRect(scrollEl) { return _rect(scrollEl) || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
function _inView(r, sr) {
  return !!(r && sr && r.width > 0 && r.height > 0 && r.right > sr.left && r.left < sr.right && r.bottom > sr.top && r.top < sr.bottom);
}
function _scanGrid(S) {
  var res = _resolve(S.selector);
  if (res.err) {
    return {
      kind: 'grid', found: false, error: res.err, selector: S.selector, generation: null, framePath: [],
      headers: [], visibleHeaders: [], visibleRows: [], totalRows: null, totalCols: null,
      renderedRows: 0, rowHeight: null, scroll: null, cell: null, cellRendered: false,
      target: S.col ? { col: S.col, row: S.row } : null, warnings: [],
    };
  }
  var parts = res.parts, root = res.root;
  var scrollEl = _scrollEl(root);
  var scroll = _scrollInfo(scrollEl);
  var sr = _scrollRect(scrollEl);
  var rows = parts.rows;
  var headerRows = _qsa(root, '.rdg-header-row').length;
  var ariaRowCount = _num(root.getAttribute('aria-rowcount'), NaN);
  if (!isFinite(ariaRowCount) && res.doc && res.doc.documentElement) ariaRowCount = _num(res.doc.documentElement.getAttribute('aria-rowcount'), NaN);
  var approxRowHeight = _rowHeightOf(rows, scrollEl, 0);
  var totalRows = null;
  if (isFinite(ariaRowCount) && ariaRowCount > headerRows) totalRows = Math.round(ariaRowCount - headerRows);
  else if (scrollEl.scrollHeight > 0) totalRows = Math.max(0, Math.round(scrollEl.scrollHeight / (approxRowHeight || 35)));
  var rowHeight = _rowHeightOf(rows, scrollEl, totalRows || 0);
  var headers = sortByLeft(_headerList(parts));
  var totalCols = _num(root.getAttribute('aria-colcount'), NaN);
  if (!isFinite(totalCols)) totalCols = headers.length;
  var i, j;
  for (i = 0; i < headers.length; i++) headers[i].visible = !!(headers[i].width > 0 && headers[i].left < sr.right && (headers[i].left + headers[i].width) > sr.left);
  var visibleHeaders = headers.filter(function (h) { return h.visible; });
  var rowInfo = [], visibleRows = [], maxCells = 0;
  for (i = 0; i < rows.length; i++) {
    var idx = _rowIndex(rows[i], scrollEl, rowHeight, headerRows);
    var rr = _rect(rows[i]);
    var cellN = _qsa(rows[i], '.react-grid-Cell, .rdg-cell').length;
    if (cellN > maxCells) maxCells = cellN;
    if (_inView(rr, sr)) visibleRows.push(idx);
    rowInfo.push({ index: idx, el: rows[i], top: rr ? rr.top : 0, height: rr ? rr.height : 0 });
  }
  visibleRows.sort(function (a, b) { return a - b; });

  var warnings = [];
  if (rows.length && totalRows && rows.length < totalRows) warnings.push('行虚拟化：DOM 仅渲染 ' + rows.length + '/' + totalRows + ' 行（离屏未渲染≠空值）');
  if (maxCells && totalCols && maxCells < totalCols) warnings.push('列虚拟化：每行仅渲染 ' + maxCells + '/' + totalCols + ' 列（离屏列未渲染≠缺列）');

  var target = S.col ? { col: S.col, row: S.row } : null;
  var cellOut = null, cellRendered = false, matched = null, headerHit = null;
  if (S.col && S.row) {
    matched = matchHeader(headers, S.col, S.match);
    if (matched && matched.index !== null && isFinite(matched.index)) headerHit = headers[matched.index];
    var rowEl = null;
    for (i = 0; i < rowInfo.length; i++) { if (rowInfo[i].index === S.row) { rowEl = rowInfo[i].el; break; } }
    if (rowEl && headerHit) {
      var cell = _cellOfRow(rowEl, headerHit);
      if (cell) {
        var cr = _rect(cell);
        cellRendered = true;
        cellOut = {
          col: headerHit.text,
          colIndex: headerHit.index,
          row: S.row,
          text: _txt(cell),
          empty: _txt(cell) === '',
          rendered: true,
          visible: _inView(cr, sr),
          rect: cr ? _absRect(cell, cr) : null,
        };
      }
    }
  }

  return {
    kind: 'grid',
    found: true,
    error: null,
    selector: S.selector,
    generation: parts.generation,
    framePath: res.fp || [],
    scroll: scroll,
    rowHeight: Math.round(rowHeight * 100) / 100,
    totalRows: totalRows,
    totalCols: totalCols,
    renderedRows: rows.length,
    visibleRows: visibleRows,
    headers: headers.map(function (h) {
      return { text: h.text, index: h.index, domIndex: h.domIndex, left: Math.round(h.left), top: Math.round(h.top), width: Math.round(h.width), height: Math.round(h.height), visible: h.visible };
    }),
    visibleHeaders: visibleHeaders.map(function (h) {
      return { text: h.text, index: h.index, domIndex: h.domIndex, left: Math.round(h.left), top: Math.round(h.top), width: Math.round(h.width), height: Math.round(h.height), visible: true };
    }),
    target: target,
    matchedBy: matched ? matched.mode : null,
    matchedAmbiguous: matched ? matched.ambiguous : 0,
    cell: cellOut,
    cellRendered: cellRendered,
    warnings: warnings,
  };
}

/** 页面侧只读表达式（零合成事件/零导航/零滚动——extract 红线） */
function buildGridReadExpr(spec) {
  var S = spec || {};
  return '(function(){ return (function(S){\n'
    + [sortByLeft, detectGeneration, matchHeader, _num, _qsa, _txt, _rect, _absRect, _docs, _styleLeft,
      _contentTop, _isHeaderRow, _partsAt, _findParts, _resolve, _scrollEl, _scrollInfo,
      _rowHeightOf, _rowIndex, _headerList, _cellOfRow, _scrollRect, _inView, _scanGrid]
      .map(function (f) { return f.toString(); }).join('\n')
    + '\nreturn _scanGrid(S);\n})( ' + JSON.stringify(S) + ' ); })()';
}

/** 页面侧滚动表达式（有副作用：设置 scrollTop/scrollLeft + 派发一次 scroll 通知） */
function buildGridScrollExpr(spec) {
  var S = spec || {};
  return '(function(){ return (function(S){\n'
    + [sortByLeft, detectGeneration, matchHeader, _num, _qsa, _txt, _rect, _absRect, _docs, _styleLeft,
      _contentTop, _isHeaderRow, _partsAt, _findParts, _resolve, _scrollEl, _scrollInfo,
      _rowHeightOf, _rowIndex, _headerList, _scrollRect, _nudgeScroll]
      .map(function (f) { return f.toString(); }).join('\n')
    + `
var res = _resolve(S.selector);
if (res.err) return { ok: false, error: res.err, before: null, after: null };
var parts = res.parts, root = res.root, scrollEl = _scrollEl(root);
var before = _scrollInfo(scrollEl);
var rows = parts.rows;
var headerRows = _qsa(root, '.rdg-header-row').length;
var approxRowHeight = _rowHeightOf(rows, scrollEl, 0);
var ariaRowCount = _num(root.getAttribute('aria-rowcount'), NaN);
var totalRows = null;
if (isFinite(ariaRowCount) && ariaRowCount > headerRows) totalRows = Math.round(ariaRowCount - headerRows);
else if (scrollEl.scrollHeight > 0) totalRows = Math.max(0, Math.round(scrollEl.scrollHeight / (approxRowHeight || 35)));
var rowHeight = _rowHeightOf(rows, scrollEl, totalRows || 0);
var headers = sortByLeft(_headerList(parts));
var headerHit = null, matched = null;
if (S.col) {
  matched = matchHeader(headers, S.col, S.match);
  if (matched && matched.index !== null && isFinite(matched.index)) headerHit = headers[matched.index];
  if (!headerHit) {
    return { ok: false, error: 'header-not-found', before: before, after: before,
      headers: headers.filter(function (h) { return h.visible; }).map(function (h) { return h.text; }) };
  }
}
var maxTop = Math.max(0, (scrollEl.scrollHeight || 0) - (scrollEl.clientHeight || 0));
var maxLeft = Math.max(0, (scrollEl.scrollWidth || 0) - (scrollEl.clientWidth || 0));
var wantTop = Math.min(maxTop, Math.max(0, (S.row - 1) * rowHeight - ((scrollEl.clientHeight || 0) - rowHeight) / 2));
scrollEl.scrollTop = wantTop;
if (headerHit) {
  var sr = _scrollRect(scrollEl);
  var contentX = headerHit.left - sr.left + (scrollEl.scrollLeft || 0);
  var wantLeft = Math.min(maxLeft, Math.max(0, contentX + headerHit.width / 2 - (scrollEl.clientWidth || 0) / 2));
  scrollEl.scrollLeft = wantLeft;
}
_nudgeScroll(scrollEl);
return { ok: true, error: null, before: before, after: _scrollInfo(scrollEl), rowHeight: rowHeight,
  totalRows: totalRows, matchedBy: matched ? matched.mode : null, header: headerHit ? headerHit.text : null };
` + '\n})( ' + JSON.stringify(S) + ' ); })()';
}

/** 页面侧还原滚动表达式（locate 默认逃生：读完还原现场） */
function buildGridRestoreExpr(spec) {
  var S = spec || {};
  return '(function(){ return (function(S){\n'
    + [sortByLeft, detectGeneration, matchHeader, _num, _qsa, _txt, _rect, _absRect, _docs, _styleLeft,
      _contentTop, _isHeaderRow, _partsAt, _findParts, _resolve, _scrollEl, _scrollInfo, _nudgeScroll]
      .map(function (f) { return f.toString(); }).join('\n')
    + `
var res = _resolve(S.selector);
if (res.err) return { ok: false, error: res.err };
var scrollEl = _scrollEl(res.root);
scrollEl.scrollTop = S.top || 0;
scrollEl.scrollLeft = S.left || 0;
_nudgeScroll(scrollEl);
return { ok: true, scroll: _scrollInfo(scrollEl) };
` + '\n})( ' + JSON.stringify(S) + ' ); })()';
}

/* ── Node 侧执行 ── */

function parseRep(raw) {
  var rep = raw;
  if (typeof raw === 'string' && raw) { try { rep = JSON.parse(raw); } catch (e) { rep = null; } }
  if (!rep || typeof rep !== 'object') throw new Error('grid 页面表达式返回非法（非对象）');
  return rep;
}

/** 只读读数（不滚动）。opts={selector,col,row,match,timeoutMs} */
async function readGrid(client, sessionId, opts) {
  var o = normalizeGridOptions(opts, { requirePair: false });
  var rep = parseRep(await evaluate(client, sessionId, buildGridReadExpr(o), o.timeoutMs));
  rep.kind = 'grid';
  rep.headers = Array.isArray(rep.headers) ? rep.headers : [];
  rep.visibleHeaders = Array.isArray(rep.visibleHeaders) ? rep.visibleHeaders : [];
  rep.visibleRows = Array.isArray(rep.visibleRows) ? rep.visibleRows : [];
  rep.warnings = Array.isArray(rep.warnings) ? rep.warnings : [];
  rep.found = rep.found === true;
  rep.cell = rep.cell && typeof rep.cell === 'object' ? rep.cell : null;
  rep.cellRendered = rep.cellRendered === true;
  rep.framePath = Array.isArray(rep.framePath) ? rep.framePath : [];
  return rep;
}

/** 读数 + 形状归一（extract --kind grid 用）：items=可见列头文字（视觉序），count=全部列头数 */
async function extractGrid(client, sessionId, opts) {
  var o = opts || {};
  var limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 100;
  var rep = await readGrid(client, sessionId, o);
  rep.count = rep.headers.length;
  rep.items = rep.visibleHeaders.slice(0, limit).map(function (h) { return h.text; });
  rep.truncated = rep.visibleHeaders.length > limit;
  rep.limit = limit;
  return rep;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function headerListText(headers, max) {
  var list = (headers || []).filter(function (h) { return h.visible !== false; }).slice(0, max || 12).map(function (h) { return h.text; });
  return list.length ? list.join('、') : '（无可见列头）';
}

function notFound(msg, hint, data) {
  return { ok: false, code: 'E_NOT_FOUND', message: msg, hint: hint, data: data || null };
}

/** 定位+滚动渲染（有副作用；默认还原滚动）。返回 {ok, ...}，不抛业务错误 */
async function locateGrid(client, sessionId, opts) {
  var o = normalizeGridOptions(Object.assign({}, opts, { restoreScroll: opts && opts.restoreScroll !== undefined ? opts.restoreScroll : true }));
  var deadline = Date.now() + o.timeoutMs;
  var first = await readGrid(client, sessionId, o);
  if (!first.found) return notFound('未识别到虚拟化网格容器（' + first.error + '）' + (o.selector ? '：--selector ' + o.selector : ''), NOT_RENDERED_HINT, first);
  if (first.matchedAmbiguous > 1) return { ok: false, code: 'E_AMBIGUOUS', message: '列头「' + o.col + '」命中 ' + first.matchedAmbiguous + ' 个候选，不猜；请用更完整的列头文字', hint: NAV_HEADER_HINT, data: first };
  var matched = matchHeader(first.headers, o.col, o.match);
  if (!matched || matched.index === null) {
    var msg = matched && matched.mode === 'ambiguous'
      ? '列头「' + o.col + '」contains 命中多个候选，不猜；请用完整列头文字'
      : '列头「' + o.col + '」未命中；可见列头：' + headerListText(first.headers);
    return notFound(msg, NAV_HEADER_HINT, first);
  }
  var header = first.headers[matched.index];
  if (first.totalRows && o.row > first.totalRows) return notFound('row=' + o.row + ' 超出 totalRows=' + first.totalRows, NAV_HEADER_HINT, first);
  var needScroll = !(first.cellRendered && first.cell && first.cell.visible);
  if (!needScroll) {
    return { ok: true, action: 'locate', scrolled: false, attempts: 0, matchedBy: matched.mode, header: header.text, result: first };
  }
  var scrollRep = parseRep(await evaluate(client, sessionId, buildGridScrollExpr(Object.assign({}, o, { col: header.text })), o.timeoutMs));
  if (!scrollRep.ok) {
    var sm = scrollRep.error === 'header-not-found'
      ? '列头「' + o.col + '」在滚动阶段未命中；可见列头：' + ((scrollRep.headers || []).join('、') || '（无）')
      : '网格滚动失败（' + scrollRep.error + '）';
    return notFound(sm, NAV_HEADER_HINT, first);
  }
  var last = first, attempts = 0, reNudged = false, restored = null;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      attempts++;
      last = await readGrid(client, sessionId, o);
      if (last.found && last.cellRendered && last.cell && last.cell.visible) break;
      if (!reNudged && attempts >= 5) {
        reNudged = true;
        try { await evaluate(client, sessionId, buildGridScrollExpr(Object.assign({}, o, { col: header.text })), o.timeoutMs); } catch (e) {}
      }
    }
  } finally {
    if (o.restoreScroll) {
      try {
        restored = parseRep(await evaluate(client, sessionId, buildGridRestoreExpr({ selector: o.selector, top: first.scroll.top, left: first.scroll.left }), o.timeoutMs));
      } catch (e) { restored = { ok: false, error: String(e && e.message || e) }; }
    }
  }
  var hit = !!(last.found && last.cellRendered && last.cell && last.cell.visible);
  var meta = {
    action: 'locate', scrolled: true, attempts: attempts, matchedBy: matched.mode, header: header.text,
    restoreScroll: o.restoreScroll, restored: restored ? restored.ok === true : false,
    scrollBefore: first.scroll, scrollAfter: last.scroll,
    scrollAfterRestore: restored && restored.scroll ? restored.scroll : null,
    reNudged: reNudged,
  };
  if (!hit) {
    var nf = notFound('滚动 ' + attempts + ' 次后仍未命中 cell（列头=' + header.text + ' row=' + o.row + '）', NOT_RENDERED_HINT, last);
    nf.locate = meta;
    return nf;
  }
  return { ok: true, locate: meta, result: last, header: header.text, matchedBy: matched.mode };
}

/** 只滚动到目标行列并复读（默认保留现场；--restore-scroll 可还原） */
async function scrollGrid(client, sessionId, opts) {
  var o = normalizeGridOptions(Object.assign({}, opts, { restoreScroll: opts && opts.restoreScroll === true }), { requirePair: false });
  var deadline = Date.now() + o.timeoutMs;
  var first = await readGrid(client, sessionId, o);
  if (!first.found) return notFound('未识别到虚拟化网格容器（' + first.error + '）', NOT_RENDERED_HINT, first);
  if (first.totalRows && o.row > first.totalRows) return notFound('row=' + o.row + ' 超出 totalRows=' + first.totalRows, NAV_HEADER_HINT, first);
  var matched = o.col ? matchHeader(first.headers, o.col, o.match) : null;
  if (o.col && matched && matched.ambiguous > 1) {
    return { ok: false, code: 'E_AMBIGUOUS', message: '列头「' + o.col + '」命中 ' + matched.ambiguous + ' 个候选，不猜；请用更完整的列头文字', hint: NAV_HEADER_HINT, data: first };
  }
  if (o.col && (!matched || matched.index === null)) {
    return notFound('列头「' + o.col + '」未命中；可见列头：' + headerListText(first.headers), NAV_HEADER_HINT, first);
  }
  var scrollRep = parseRep(await evaluate(client, sessionId, buildGridScrollExpr(o), o.timeoutMs));
  if (!scrollRep.ok) {
    var sm = scrollRep.error === 'header-not-found'
      ? '列头「' + o.col + '」在滚动阶段未命中；可见列头：' + ((scrollRep.headers || []).join('、') || '（无）')
      : '网格滚动失败（' + scrollRep.error + '）';
    return notFound(sm, NAV_HEADER_HINT, first);
  }
  var last = first, attempts = 0, restored = null;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      attempts++;
      last = await readGrid(client, sessionId, o);
      var rowHit = (last.visibleRows || []).indexOf(o.row) >= 0;
      var cellHit = !o.col || (last.cellRendered && last.cell && last.cell.visible);
      if (last.found && rowHit && cellHit) break;
    }
  } finally {
    if (o.restoreScroll) {
      try { restored = parseRep(await evaluate(client, sessionId, buildGridRestoreExpr({ selector: o.selector, top: first.scroll.top, left: first.scroll.left }), o.timeoutMs)); }
      catch (e) { restored = { ok: false, error: String(e && e.message || e) }; }
    }
  }
  var rowHit2 = (last.visibleRows || []).indexOf(o.row) >= 0;
  var cellHit2 = !o.col || (last.cellRendered && last.cell && last.cell.visible);
  var meta = {
    action: 'scroll-to', scrolled: true, attempts: attempts,
    restoreScroll: o.restoreScroll, restored: restored ? restored.ok === true : false,
    scrollBefore: first.scroll, scrollAfter: last.scroll,
    scrollAfterRestore: restored && restored.scroll ? restored.scroll : null,
  };
  if (!(rowHit2 && cellHit2)) {
    var nf = notFound('滚动 ' + attempts + ' 次后 row=' + o.row + (o.col ? ' 列头=' + o.col : '') + ' 仍不可见', NOT_RENDERED_HINT, last);
    nf.locate = meta;
    return nf;
  }
  return { ok: true, locate: meta, result: last };
}

module.exports = {
  NOT_RENDERED_HINT, NAV_HEADER_HINT, MATCH_MODES, DEFAULT_TIMEOUT_MS, POLL_MS,
  sortByLeft, detectGeneration, matchHeader, normalizeGridOptions,
  buildGridReadExpr, buildGridScrollExpr, buildGridRestoreExpr,
  readGrid, extractGrid, locateGrid, scrollGrid,
};
