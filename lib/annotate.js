'use strict';
/*
 * chromeuse lib/annotate.js —— screenshot --annotate 的 Node 侧叠字标注（C5 N11，TODO L107）
 *
 * 定位：`tools/cdp.js screenshot --annotate` 的唯一实现单源——把 a11y 引用表（lib/refs.js 编号源）
 * 的每个 @eN 画成截图上的编号框。**零页面副作用**：不注入 overlay / 不改 DOM / 不滚动，
 * 只在截图像素上叠字；真实点击路径仍走 click --ref 的 X1 闸门与三级定位链（本模块只做视觉辅助）。
 *
 * ── 叠字通道定夺（POC 2026-11-04，证据 tmpdata/c5/）────────────────────────────
 * ① ffmpeg drawtext：**不可用**——bin/ffmpeg 7.0.2-static 的 filter 表只有 drawbox 无 drawtext
 *    （构建缺 libfreetype），且容器内零字体（无 fc-list、无 /usr/share/fonts）。
 * ② 下载字体 + 其它渲染器：仍需 drawtext 或额外渲染依赖，且字体文件要同步到 live 部署面
 *    （新增外部依赖，违背 skill 零第三方依赖边界）。
 * ③ **纯 Node zlib PNG codec + 内置 5x7 点阵字模（本实现）**：零依赖、零字体、跨环境一致；
 *    decode 2558x996 实测 ~147ms，filter0+level6 encode ~134ms（实测数据见 WORKLOG）。
 *    字模仅需 e + 0-9（编号 e1..e50），总计 11 个 5x7 字形，无字形渲染依赖。
 *
 * ── PNG 边界（钉死）────────────────────────────────────────────────────────────
 * - 解码仅支持 8-bit、非隔行、colorType 0/2/3/4/6（CDP 截图实测为 8-bit 非隔行）；其它明确报错。
 * - 编码统一输出 colorType 6（RGBA）+ filter 0 + zlib level 6（实测对截图最优：体积比自适应过滤小、
 *   速度快 ~10x）。
 * - **--annotate 关闭时本模块完全不参与**（cmdScreenshot 的 flags.annotate 分支闸门）——截图字节不变。
 *
 * ── 标注语义 ─────────────────────────────────────────────────────────────────
 * - 输入 refs = lib/refs.js materializeRefs 产物（ref/localRect/rect）。localRect（视口相对）优先，
 *   缺失时用 rect（页面绝对）减滚动量还原；物化到截图之间页面滚动 → 调用方按 scroll 差修正。
 * - 视口外的 ref 不画（skipped reason=offscreen），但仍在 refs 清单里如实列出——不静默丢。
 * - 编号/rect 输出与 ref 表一一对应（同编号源=refs.assignRefNumbers），标注数=可画 ref 数。
 */

const zlib = require('node:zlib');

/* ── 5x7 点阵字模（仅 annotate 需要：e + 0-9；'1' 位=墨点） ── */
const GLYPHS = {
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
const GLYPH_W = 5, GLYPH_H = 7, GLYPH_GAP = 1;
const LABEL_PAD = 2;
const LABEL_SCALE_MIN = 1, LABEL_SCALE_MAX = 6;
const COLORS = {
  border: [255, 45, 45, 235],  // 框线（红，近不透明）
  fill: [255, 45, 45, 26],     // 框内淡染（提示命中范围，不遮内容）
  labelBg: [255, 214, 0, 255], // 标签底（亮黄，深底浅底都可读）
  labelFg: [0, 0, 0, 255],     // 标签字（黑）
};

/* ── 参数闸门（纯函数；cdp.js 建连前调用，非布尔值明确报错不静默） ── */
function normalizeAnnotate(flags) {
  const v = (flags || {}).annotate;
  if (v === undefined || v === null) return false;
  if (v === true) return true;
  const e = new Error('--annotate 不接受值（无参开关：--annotate）');
  e.kind = 'usage';
  throw e;
}

/** 文本像素宽（scale 已计入；字间 1px 间距、末字后无间距） */
function textWidth(text, scale) {
  const n = String(text).length;
  const s = Math.max(1, Math.round(scale || 1));
  return n ? (n * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP) * s : 0;
}

/** 截图物理像素 / 视口 CSS 像素（DPR 或 --viewport 覆盖后的实际比值；纯函数） */
function estimateScale(imageWidth, viewportWidth) {
  const iw = Number(imageWidth), vw = Number(viewportWidth);
  if (!(iw > 0) || !(vw > 0)) throw new Error(`无法计算标注比例：imageWidth=${imageWidth} viewportWidth=${viewportWidth}`);
  return iw / vw;
}

/**
 * ref 的视口坐标（纯函数）：localRect（物化时视口相对）优先；缺失时 rect（页面绝对）减滚动量。
 * @param {{ref,localRect?,rect?}} ref
 * @param {{x:number,y:number}} scroll 物化时的 window.scrollX/Y
 * @returns {null|{x,y,w,h}}
 */
function refViewportRect(ref, scroll) {
  if (!ref) return null;
  const lr = ref.localRect;
  if (lr && Number.isFinite(Number(lr.x)) && Number.isFinite(Number(lr.y))) {
    return { x: Number(lr.x), y: Number(lr.y), w: Number(lr.w), h: Number(lr.h) };
  }
  const r = ref.rect;
  if (!r || !Number.isFinite(Number(r.x)) || !Number.isFinite(Number(r.y))) return null;
  const sx = Number((scroll && scroll.x) || 0), sy = Number((scroll && scroll.y) || 0);
  return { x: Number(r.x) - sx, y: Number(r.y) - sy, w: Number(r.w), h: Number(r.h) };
}

/**
 * 标注计划（纯函数）：refs（每条带 ref + 视口坐标 rect）→ 像素框 + 标签位置。
 * @param {Array<{ref:string,rect:{x,y,w,h}}>} refs
 * @param {{viewport:{width,height}, scale:number, image?:{width,height}, pad?:number}} opts
 *   scale = 物理像素/CSS 像素；image 缺省按 viewport*scale 取整（实际截图尺寸优先传入）。
 * @returns {{markers:object[], skipped:object[], scale:number, image:{width,height}}}
 *   marker = {ref, rect(视口 CSS px), box(图像 px), label:{text,x,y,w,h,scale,textX,textY}, clipped}
 */
function planMarkers(refs, opts) {
  const o = opts || {};
  const vw = Number(o.viewport && o.viewport.width), vh = Number(o.viewport && o.viewport.height);
  if (!(vw > 0) || !(vh > 0)) throw new Error('planMarkers 需要合法 viewport {width,height}');
  const scale = Number(o.scale) > 0 ? Number(o.scale) : 1;
  const image = {
    width: Math.max(1, Math.round(o.image && o.image.width != null ? Number(o.image.width) : vw * scale)),
    height: Math.max(1, Math.round(o.image && o.image.height != null ? Number(o.image.height) : vh * scale)),
  };
  const pad = o.pad == null ? LABEL_PAD : Math.max(0, Math.round(Number(o.pad)));
  const markers = [], skipped = [];
  for (const ref of (Array.isArray(refs) ? refs : [])) {
    const id = String((ref && ref.ref) != null ? ref.ref : '');
    const rect = (ref && ref.rect) || null;
    if (!rect || !(Number(rect.w) > 0) || !(Number(rect.h) > 0)) { skipped.push({ ref: id, reason: 'empty-rect' }); continue; }
    const ix = Number(rect.x) * scale, iy = Number(rect.y) * scale;
    const iw = Number(rect.w) * scale, ih = Number(rect.h) * scale;
    const bx0 = Math.max(0, Math.round(ix)), by0 = Math.max(0, Math.round(iy));
    const bx1 = Math.min(image.width, Math.round(ix + iw)), by1 = Math.min(image.height, Math.round(iy + ih));
    if (bx1 <= bx0 || by1 <= by0) { skipped.push({ ref: id, reason: 'offscreen' }); continue; }
    const box = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
    const s = Math.max(LABEL_SCALE_MIN, Math.min(LABEL_SCALE_MAX, Math.round(scale)));
    const lw = textWidth(id, s) + pad * 2;
    const lh = GLYPH_H * s + pad * 2;
    let lx = box.x;
    let ly = box.y - lh - 1;               // 优先放框上方（不遮内容）
    if (ly < 0) ly = box.y + 1;            // 顶部放不下 → 框内左上
    if (ly + lh > image.height) ly = Math.max(0, image.height - lh);
    if (lx + lw > image.width) lx = Math.max(0, image.width - lw);
    markers.push({
      ref: id,
      rect: { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) },
      box,
      label: { text: id, x: lx, y: ly, w: lw, h: lh, scale: s, textX: lx + pad, textY: ly + pad },
      clipped: bx0 > Math.round(ix) || by0 > Math.round(iy) || bx1 < Math.round(ix + iw) || by1 < Math.round(iy + ih),
    });
  }
  return { markers, skipped, scale, image };
}

/* ── PNG 解码（8-bit 非隔行；colorType 0/2/3/4/6）→ RGBA ── */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('decodePng 需要 Buffer');
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('非 PNG（签名不符）');
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`PNG 位深 ${ihdr.bitDepth} 不支持（仅 8-bit）`);
  if (ihdr.interlace !== 0) throw new Error('PNG 隔行扫描不支持');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!ch) throw new Error(`PNG colorType ${ihdr.colorType} 不支持`);
  if (!idat.length) throw new Error('PNG 缺 IDAT');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error(`PNG IDAT 长度异常：${raw.length} < ${(stride + 1) * height}`);
  const px = Buffer.alloc(stride * height);
  unfilter(raw, px, height, ch, stride);
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0, k = 0; i < width * height; i++, j += ch, k += 4) {
    if (ch === 4) { out[k] = px[j]; out[k + 1] = px[j + 1]; out[k + 2] = px[j + 2]; out[k + 3] = px[j + 3]; }
    else if (ch === 3) { out[k] = px[j]; out[k + 1] = px[j + 1]; out[k + 2] = px[j + 2]; out[k + 3] = 255; }
    else if (ch === 1) {
      if (ihdr.colorType === 3) {
        if (!plte) throw new Error('PNG colorType 3 缺 PLTE');
        const p = px[j] * 3;
        out[k] = plte[p]; out[k + 1] = plte[p + 1]; out[k + 2] = plte[p + 2];
        out[k + 3] = trns && trns[px[j]] !== undefined ? trns[px[j]] : 255;
      } else { out[k] = out[k + 1] = out[k + 2] = px[j]; out[k + 3] = 255; }
    } else { out[k] = out[k + 1] = out[k + 2] = px[j]; out[k + 3] = px[j + 1]; }
  }
  return { width, height, data: out, colorType: ihdr.colorType };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, out, height, ch, stride) {
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prev = rowOut - stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[rowIn + x];
      const a = x >= ch ? out[rowOut + x - ch] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= ch ? out[prev + x - ch] : 0;
      let v;
      if (f === 0) v = rb;
      else if (f === 1) v = rb + a;
      else if (f === 2) v = rb + b;
      else if (f === 3) v = rb + ((a + b) >> 1);
      else if (f === 4) v = rb + paeth(a, b, c);
      else throw new Error(`PNG 行过滤类型非法：${f}`);
      out[rowOut + x] = v & 0xff;
    }
  }
}

/* ── PNG 编码（RGBA → colorType 6；filter 0 + zlib level 6，实测最优） ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, cb]);
}

function encodePng(img, opts) {
  const o = opts || {};
  const { width, height, data } = img || {};
  if (!(width > 0) || !(height > 0) || !Buffer.isBuffer(data) || data.length < width * height * 4) {
    throw new Error('encodePng 需要 {width,height,data(RGBA Buffer)}');
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter 0（None）
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const level = Number.isInteger(o.level) ? Math.max(0, Math.min(9, o.level)) : 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 绘制原语（就地改 RGBA） ── */
function blend(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  const a = rgba[3];
  if (a >= 255) { d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = 255; return; }
  const al = a / 255;
  d[i] = Math.round(d[i] * (1 - al) + rgba[0] * al);
  d[i + 1] = Math.round(d[i + 1] * (1 - al) + rgba[1] * al);
  d[i + 2] = Math.round(d[i + 2] * (1 - al) + rgba[2] * al);
  d[i + 3] = Math.max(d[i + 3], Math.round(255 * al));
}

function fillRect(img, box, rgba) {
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(img.width - 1, Math.round(box.x + box.w) - 1);
  const y1 = Math.min(img.height - 1, Math.round(box.y + box.h) - 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blend(img, x, y, rgba);
}

function strokeRect(img, box, thickness, rgba) {
  const t = Math.max(1, Math.round(thickness));
  const x0 = Math.round(box.x), y0 = Math.round(box.y), x1 = Math.round(box.x + box.w), y1 = Math.round(box.y + box.h);
  fillRect(img, { x: x0, y: y0, w: x1 - x0, h: t }, rgba);
  fillRect(img, { x: x0, y: y1 - t, w: x1 - x0, h: t }, rgba);
  fillRect(img, { x: x0, y: y0, w: t, h: y1 - y0 }, rgba);
  fillRect(img, { x: x1 - t, y: y0, w: t, h: y1 - y0 }, rgba);
}

function drawText(img, text, x, y, scale, rgba) {
  let cx = x;
  for (const chr of String(text)) {
    const rows = GLYPHS[chr];
    if (rows) {
      for (let ry = 0; ry < GLYPH_H; ry++) {
        for (let rx = 0; rx < GLYPH_W; rx++) {
          if (rows[ry][rx] === '1') fillRect(img, { x: cx + rx * scale, y: y + ry * scale, w: scale, h: scale }, rgba);
        }
      }
    }
    cx += (GLYPH_W + GLYPH_GAP) * scale;
  }
}

/**
 * 叠字主入口：PNG Buffer + refs（视口坐标）→ 标注后的 PNG Buffer。
 * @param {Buffer} pngBuffer CDP 截图原始 PNG
 * @param {Array<{ref:string,rect:{x,y,w,h}}>} refs 视口坐标（用 refViewportRect 归一）
 * @param {{viewport:{width,height}, scale?:number, image?:object, pad?:number}} opts
 *   scale 缺省 = image.width / viewport.width（截图实际 DPR；--viewport 覆盖后的实际比值）
 * @returns {{buffer:Buffer, markers:object[], skipped:object[], annotated:number, width:number, height:number, scale:number}}
 */
function annotatePng(pngBuffer, refs, opts) {
  const img = decodePng(pngBuffer);
  const o = opts || {};
  const scale = Number(o.scale) > 0 ? Number(o.scale) : estimateScale(img.width, o.viewport && o.viewport.width);
  const plan = planMarkers(refs, Object.assign({}, o, { scale, image: o.image || { width: img.width, height: img.height } }));
  for (const m of plan.markers) {
    fillRect(img, m.box, COLORS.fill);
    strokeRect(img, m.box, Math.max(1, Math.round(plan.scale)), COLORS.border);
    fillRect(img, { x: m.label.x, y: m.label.y, w: m.label.w, h: m.label.h }, COLORS.labelBg);
    drawText(img, m.label.text, m.label.textX, m.label.textY, m.label.scale, COLORS.labelFg);
  }
  return {
    buffer: encodePng(img),
    markers: plan.markers,
    skipped: plan.skipped,
    annotated: plan.markers.length,
    width: img.width,
    height: img.height,
    scale: plan.scale,
  };
}

module.exports = {
  GLYPHS, GLYPH_W, GLYPH_H, GLYPH_GAP, LABEL_PAD, COLORS,
  normalizeAnnotate, textWidth, estimateScale, refViewportRect, planMarkers,
  decodePng, encodePng, annotatePng,
};
