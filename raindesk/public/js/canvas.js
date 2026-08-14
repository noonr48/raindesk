/*
 * Raindesk canvas core — DOM-free state machine + dependency-free PNG codec.
 *
 * Runs identically under node:test (CommonJS) and in the browser
 * (window.RaindeskCanvas). No DOM, no fetch, no Image: every pixel it owns
 * lives in Uint8ClampedArray RGBA buffers so the whole layer/lasso/mask/
 * commit/take/undo machine is unit-testable without a DOM.
 *
 * Layers:  { id, name, kind: 'base'|'pen'|'temp'|'gen', visible, data, strokes }
 * Lasso:   { points:[{x,y}...], closed } (freehand, even-odd polygon)
 * Mask:    coverage alpha inside the lasso, feathered INWARD from the edge
 *          (soft seam, pixels strictly outside the lasso are never touched).
 * Exports: regionPng + maskPng (both cropped around the lasso, dims padded
 *          to multiples of 8 for SDXL, edge-replicated when the canvas clips).
 * Commit:  current take composited through the feathered lasso onto the
 *          active layer; outside-lasso bytes stay identical.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaindeskCanvas = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------- PNG codec */

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const LAYER_KINDS = ['base', 'pen', 'temp', 'gen'];
  const MAX_UNDO = 100; // bounded undo: oldest records fall off; earliest actions become permanent
  const INF = 1e7;

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }
  function crc32(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function adler32(bytes) {
    let a = 1; let b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function writeU32BE(arr, off, v) {
    arr[off] = (v >>> 24) & 0xff;
    arr[off + 1] = (v >>> 16) & 0xff;
    arr[off + 2] = (v >>> 8) & 0xff;
    arr[off + 3] = v & 0xff;
  }
  function concatBytes(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function pngChunk(type, data) {
    const td = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
    td.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    writeU32BE(out, 0, data.length);
    out.set(td.subarray(0, 4), 4);
    out.set(data, 8);
    writeU32BE(out, 8 + data.length, crc32(td));
    return out;
  }

  /**
   * Encode 8-bit RGBA as PNG (color type 6, filter 0 rows, zlib stream of
   * STORED deflate blocks — fully valid, zero-dependency, deterministic).
   */
  function encodePNG(width, height, rgba) {
    if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
      throw new Error('encodePNG: bad dimensions');
    }
    if (!rgba || rgba.length < width * height * 4) throw new Error('encodePNG: buffer too small');
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const ro = y * (stride + 1);
      raw[ro] = 0; // filter type 0 (None)
      raw.set(rgba.subarray(y * stride, y * stride + stride), ro + 1);
    }
    const parts = [new Uint8Array([0x78, 0x01])]; // CMF/FLG: deflate, no dict, check ok
    for (let off = 0; off < raw.length; off += 65535) {
      const len = Math.min(65535, raw.length - off);
      const head = new Uint8Array(5);
      head[0] = (off + len >= raw.length) ? 1 : 0; // BFINAL on the last block
      head[1] = len & 0xff; head[2] = (len >>> 8) & 0xff;
      head[3] = (~len) & 0xff; head[4] = ((~len) >>> 8) & 0xff;
      parts.push(head, raw.subarray(off, off + len));
    }
    const ad = new Uint8Array(4);
    writeU32BE(ad, 0, adler32(raw));
    parts.push(ad);
    const ihdr = new Uint8Array(13);
    writeU32BE(ihdr, 0, width); writeU32BE(ihdr, 4, height);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return concatBytes([
      new Uint8Array(PNG_SIG),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', concatBytes(parts)),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
  }

  /** Inflate a zlib stream made only of STORED blocks (what encodePNG emits). */
  function inflateStored(data) {
    if (data.length < 6) throw new Error('zlib stream too short');
    const cmf = data[0]; const flg = data[1];
    if ((cmf & 0x0f) !== 8) throw new Error('unsupported zlib compression method');
    if ((((cmf << 8) | flg) % 31) !== 0) throw new Error('bad zlib header check');
    if (flg & 0x20) throw new Error('zlib preset dictionary unsupported');
    let p = 2;
    const parts = [];
    for (;;) {
      if (p + 5 > data.length) throw new Error('truncated deflate stream');
      const b = data[p++];
      const final = b & 1; const type = (b >> 1) & 3;
      if (type !== 0) throw new Error('only stored deflate blocks supported');
      const len = data[p] | (data[p + 1] << 8);
      const nlen = data[p + 2] | (data[p + 3] << 8);
      p += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('stored block length check failed');
      if (p + len > data.length) throw new Error('truncated stored block');
      parts.push(data.subarray(p, p + len));
      p += len;
      if (final) break;
    }
    const out = concatBytes(parts);
    const ad = (((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0);
    if (adler32(out) !== ad) throw new Error('adler32 mismatch');
    return out;
  }

  /** Reverse PNG row filters (types 0-4) for 8-bit images. */
  function unfilter(raw, w, h, bpp) {
    const stride = w * bpp;
    const out = new Uint8Array(stride * h);
    let pos = 0;
    for (let y = 0; y < h; y++) {
      const ft = raw[pos++];
      const rs = y * stride; const ps = rs - stride;
      for (let x = 0; x < stride; x++) {
        const f = raw[pos + x];
        const a = x >= bpp ? out[rs + x - bpp] : 0;
        const b = y > 0 ? out[ps + x] : 0;
        const c = (x >= bpp && y > 0) ? out[ps + x - bpp] : 0;
        let v;
        if (ft === 0) v = f;
        else if (ft === 1) v = f + a;
        else if (ft === 2) v = f + b;
        else if (ft === 3) v = f + ((a + b) >> 1);
        else if (ft === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          v = f + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
        } else throw new Error(`bad PNG filter type ${ft}`);
        out[rs + x] = v & 0xff;
      }
      pos += stride;
    }
    return out;
  }

  /** Decode an 8-bit non-interlaced RGB(A) PNG (covers our own encoder + most). */
  function decodePNG(bytes) {
    const b = bytes;
    if (!b || b.length < 8) throw new Error('decodePNG: too short');
    for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) throw new Error('decodePNG: bad signature');
    let p = 8;
    let width = 0; let height = 0; let colorType = 0; let bitDepth = 0;
    const idat = [];
    while (p + 8 <= b.length) {
      const len = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const dataStart = p + 8;
      if (dataStart + len + 4 > b.length) throw new Error('decodePNG: truncated chunk');
      if (type === 'IHDR') {
        width = (b[dataStart] << 24 | b[dataStart + 1] << 16 | b[dataStart + 2] << 8 | b[dataStart + 3]) >>> 0;
        height = (b[dataStart + 4] << 24 | b[dataStart + 5] << 16 | b[dataStart + 6] << 8 | b[dataStart + 7]) >>> 0;
        bitDepth = b[dataStart + 8]; colorType = b[dataStart + 9];
        if (b[dataStart + 12] !== 0) throw new Error('decodePNG: interlaced PNG unsupported');
      } else if (type === 'IDAT') {
        idat.push(b.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') break;
      p = dataStart + len + 4;
    }
    if (!width || !height) throw new Error('decodePNG: missing IHDR');
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
      throw new Error(`decodePNG: unsupported (depth ${bitDepth}, color ${colorType})`);
    }
    const raw = inflateStored(concatBytes(idat));
    const bpp = colorType === 6 ? 4 : 3;
    const px = unfilter(raw, width, height, bpp);
    if (colorType === 6) return { width, height, data: new Uint8ClampedArray(px) };
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      rgba[j] = px[i * 3]; rgba[j + 1] = px[i * 3 + 1]; rgba[j + 2] = px[i * 3 + 2]; rgba[j + 3] = 255;
    }
    return { width, height, data: rgba };
  }

  /* ------------------------------------------------------------- geometry */

  /** Even-odd scanline fill of a closed polygon into a w*h grid at origin. */
  function scanlineFill(points, ox, oy, w, h, out) {
    out.fill(0);
    if (!points || points.length < 3) return out;
    let minY = Infinity; let maxY = -Infinity;
    for (const p of points) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const yStart = Math.max(oy, Math.floor(minY));
    const yEnd = Math.min(oy + h - 1, Math.ceil(maxY));
    const xs = [];
    for (let gy = yStart; gy <= yEnd; gy++) {
      const yc = gy + 0.5;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i]; const bp = points[(i + 1) % points.length];
        if ((a.y <= yc) !== (bp.y <= yc)) xs.push(a.x + (yc - a.y) * (bp.x - a.x) / (bp.y - a.y));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(ox, Math.ceil(xs[k] - 0.5));
        const to = Math.min(ox + w - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let gx = from; gx <= to; gx++) out[(gy - oy) * w + (gx - ox)] = 1;
      }
    }
    return out;
  }

  /** Chamfer 3-4 distance (in 1/3-px units) from inside pixels to nearest outside. */
  function insideDistance(mask, w, h) {
    const d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, d[i - w] + 3);
          if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
        }
        d[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
        if (y < h - 1) {
          v = Math.min(v, d[i + w] + 3);
          if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
          if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
        }
        d[i] = v;
      }
    }
    return d;
  }

  /**
   * Feathered lasso coverage over the grid [ox,ox+w) x [oy,oy+h): 1 deep
   * inside the lasso, ramping to 0 AT the boundary (inward feather), exactly
   * 0 outside — so commits never alter outside-lasso pixels.
   */
  function coverageMask(points, ox, oy, w, h, feather) {
    const n = w * h;
    const cov = new Float32Array(n);
    const mask = scanlineFill(points, ox, oy, w, h, new Uint8Array(n));
    if (!feather || feather <= 0) {
      for (let i = 0; i < n; i++) cov[i] = mask[i];
      return cov;
    }
    const d = insideDistance(mask, w, h);
    const f3 = feather * 3; // chamfer units
    for (let i = 0; i < n; i++) cov[i] = mask[i] ? Math.min(1, d[i] / f3) : 0;
    return cov;
  }

  function boundsOf(points) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function fullCanvasPoly(w, h) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  /* --------------------------------------------------------- pixel blend */

  function blendSourceOver(dst, di, sr, sg, sb, sa255, aMul) {
    const sa = (sa255 / 255) * aMul;
    if (sa <= 0) return;
    const da = dst[di + 3] / 255;
    const ia = 1 - sa;
    dst[di] = sr * sa + dst[di] * da * ia;
    dst[di + 1] = sg * sa + dst[di + 1] * da * ia;
    dst[di + 2] = sb * sa + dst[di + 2] * da * ia;
    dst[di + 3] = (sa + da * ia) * 255;
  }

  function parseHex(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!m) throw new Error(`bad color "${color}"`);
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function stamp(data, W, H, cx, cy, r, g, b, rad) {
    const x0 = Math.max(0, Math.floor(cx - rad - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + rad + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const cover = Math.min(1, Math.max(0, rad + 0.5 - d));
        if (cover > 0) blendSourceOver(data, (y * W + x) * 4, r, g, b, 255, cover);
      }
    }
  }

  function rasterStrokeInto(data, W, H, stroke) {
    const [r, g, b] = parseHex(stroke.color);
    const rad = Math.max(0.5, stroke.width / 2);
    const pts = stroke.points;
    if (!pts.length) return;
    if (pts.length === 1) { stamp(data, W, H, pts[0].x, pts[0].y, r, g, b, rad); return; }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]; const bp = pts[i + 1];
      const dx = bp.x - a.x; const dy = bp.y - a.y;
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len * 2));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        stamp(data, W, H, a.x + dx * t, a.y + dy * t, r, g, b, rad);
      }
    }
  }

  /* -------------------------------------------------------------- core */

  /**
   * Grow a rect to multiples of 8 while staying inside the canvas:
   * extend right/bottom first, then left/up; whatever still cannot fit
   * (canvas itself smaller than the %8 size) is reported as pad to be
   * edge-replicated by the exporter.
   */
  function padRectTo8(x, y, w, h, W, H) {
    const tw = Math.ceil(w / 8) * 8;
    const th = Math.ceil(h / 8) * 8;
    let rw = w; let rh = h; let rx = x; let ry = y;
    rw += Math.min(tw - rw, W - (x + w));
    rh += Math.min(th - rh, H - (y + h));
    const needW = tw - rw;
    const shiftL = Math.min(needW, rx);
    rx -= shiftL; rw += shiftL;
    const needH = th - rh;
    const shiftU = Math.min(needH, ry);
    ry -= shiftU; rh += shiftU;
    return { x: rx, y: ry, w: rw, h: rh, padW: tw - rw, padH: th - rh };
  }

  class RainCanvasCore {
    constructor({ width = 1024, height = 1024 } = {}) {
      if (!(Number.isInteger(width) && width > 0 && width <= 8192) ||
        !(Number.isInteger(height) && height > 0 && height <= 8192)) {
        throw new Error('canvas size must be 1..8192');
      }
      this.width = width;
      this.height = height;
      this._layers = [];
      this._seq = 0;
      this._undo = [];
      this.activeLayerId = null;
      this.lasso = null;            // { points, closed }
      this.session = null;          // take session (see exportGenAssets)
    }

    /* layers ------------------------------------------------------- */

    ensureBase(name = 'base · ref plate') {
      const base = this._layers.find((l) => l.kind === 'base');
      if (base) return base;
      const layer = this._newLayer(name, 'base');
      this._layers.unshift(layer);
      if (!this.activeLayerId) this.activeLayerId = layer.id;
      return layer;
    }

    _newLayer(name, kind) {
      return {
        id: `L${++this._seq}`,
        name: String(name || kind),
        kind,
        visible: true,
        data: new Uint8ClampedArray(this.width * this.height * 4),
        strokes: [],
      };
    }

    addLayer({ name, kind = 'pen' } = {}) {
      if (!LAYER_KINDS.includes(kind) || kind === 'base') {
        throw new Error(`layer kind must be one of ${LAYER_KINDS.filter((k) => k !== 'base').join('|')}`);
      }
      const layer = this._newLayer(name, kind);
      this._layers.push(layer);
      this._undo.push({ type: 'addLayer', layerId: layer.id, prevActive: this.activeLayerId });
      if (this._undo.length > MAX_UNDO) this._undo.shift();
      this.activeLayerId = layer.id;
      return layer;
    }

    layerById(id) { return this._layers.find((l) => l.id === id) || null; }

    get layers() { return this._layers.slice(); }

    setActiveLayer(id) {
      const l = this.layerById(id);
      if (!l) throw new Error(`no such layer "${id}"`);
      this.activeLayerId = id;
      return l;
    }

    activeLayer() { return this.layerById(this.activeLayerId); }

    setLayerBuffer(id, rgba) {
      const l = this.layerById(id);
      if (!l) throw new Error(`no such layer "${id}"`);
      if (!rgba || rgba.length !== this.width * this.height * 4) throw new Error('layer buffer size mismatch');
      l.data.set(rgba);
      return l;
    }

    getLayerBuffer(id) {
      const l = this.layerById(id);
      if (!l) throw new Error(`no such layer "${id}"`);
      return { data: l.data, width: this.width, height: this.height };
    }

    /* lasso -------------------------------------------------------- */

    beginLasso() { this.lasso = { points: [], closed: false }; }
    extendLasso(p) { if (this.lasso && !this.lasso.closed) this.lasso.points.push({ x: p.x, y: p.y }); }
    clearLasso() { this.lasso = null; }

    closeLasso() {
      if (!this.lasso || this.lasso.points.length < 3) { this.lasso = null; return false; }
      const bb = boundsOf(this.lasso.points);
      if (bb.maxX - bb.minX < 4 || bb.maxY - bb.minY < 4) { this.lasso = null; return false; }
      this.lasso.closed = true;
      return true;
    }

    /* pen ---------------------------------------------------------- */

    addStroke(layerId, stroke) {
      const layer = this.layerById(layerId);
      if (!layer) throw new Error(`no such layer "${layerId}"`);
      if (layer.kind === 'base') throw new Error('base layer is locked — draw on a pen layer');
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) {
        throw new Error('stroke needs points');
      }
      const s = {
        id: `st${++this._seq}`,
        points: stroke.points.map((p) => ({ x: p.x, y: p.y })),
        color: stroke.color,
        width: stroke.width,
      };
      layer.strokes.push(s);
      rasterStrokeInto(layer.data, this.width, this.height, s);
      this._undo.push({ type: 'stroke', layerId, strokeId: s.id });
      if (this._undo.length > MAX_UNDO) this._undo.shift();
      return s;
    }

    _rasterLayer(layer) {
      layer.data.fill(0);
      for (const s of layer.strokes) rasterStrokeInto(layer.data, this.width, this.height, s);
    }

    /* composite + export ------------------------------------------- */

    compositeVisible() {
      const n = this.width * this.height;
      const out = new Uint8ClampedArray(n * 4);
      for (const layer of this._layers) {
        if (!layer.visible) continue;
        const src = layer.data;
        for (let i = 0; i < n; i++) {
          const j = i * 4;
          const sa = src[j + 3] / 255;
          if (sa <= 0) continue;
          const da = out[j + 3] / 255;
          const ia = 1 - sa;
          out[j] = src[j] * sa + out[j] * da * ia;
          out[j + 1] = src[j + 1] * sa + out[j + 1] * da * ia;
          out[j + 2] = src[j + 2] * sa + out[j + 2] * da * ia;
          out[j + 3] = (sa + da * ia) * 255;
        }
      }
      return { data: out, width: this.width, height: this.height };
    }

    /** Active lasso (or the whole canvas when none is closed). */
    effectiveLassoPoints() {
      if (this.lasso && this.lasso.closed) return this.lasso.points.slice();
      return fullCanvasPoly(this.width, this.height);
    }

    /**
     * Build { region, regionPng, maskPng, cov, feather } for /api/gen:
     * region cropped around the lasso (+feather context ring), both PNGs at
     * dims padded to %8, mask = white-on-black through the feathered lasso
     * (value written into every channel so any LoadImageMask channel works).
     */
    exportGenAssets({ feather = 24 } = {}) {
      const pts = this.effectiveLassoPoints();
      const bb = boundsOf(pts);
      const margin = Math.max(1, Math.ceil(feather));
      const x0 = Math.max(0, Math.floor(bb.minX - margin));
      const y0 = Math.max(0, Math.floor(bb.minY - margin));
      const x1 = Math.min(this.width - 1, Math.ceil(bb.maxX + margin));
      const y1 = Math.min(this.height - 1, Math.ceil(bb.maxY + margin));
      const rect = padRectTo8(x0, y0, x1 - x0 + 1, y1 - y0 + 1, this.width, this.height);
      const RW = rect.w + rect.padW;
      const RH = rect.h + rect.padH;

      const comp = this.compositeVisible();
      const region = new Uint8ClampedArray(RW * RH * 4);
      for (let y = 0; y < RH; y++) {
        const sy = Math.min(rect.y + Math.min(y, rect.h - 1), this.height - 1);
        const srow = sy * this.width;
        for (let x = 0; x < RW; x++) {
          const sx = Math.min(rect.x + Math.min(x, rect.w - 1), this.width - 1);
          const si = (srow + sx) * 4;
          const di = (y * RW + x) * 4;
          region[di] = comp.data[si];
          region[di + 1] = comp.data[si + 1];
          region[di + 2] = comp.data[si + 2];
          region[di + 3] = comp.data[si + 3];
        }
      }

      const cov = coverageMask(pts, rect.x, rect.y, RW, RH, feather);
      const mask = new Uint8ClampedArray(RW * RH * 4);
      for (let i = 0; i < RW * RH; i++) {
        const v = Math.round(cov[i] * 255);
        const j = i * 4;
        mask[j] = v; mask[j + 1] = v; mask[j + 2] = v; mask[j + 3] = v;
      }
      return {
        region: { x: rect.x, y: rect.y, w: RW, h: RH },
        regionPng: encodePNG(RW, RH, region),
        maskPng: encodePNG(RW, RH, mask),
        cov,
        feather,
      };
    }

    /* take session ------------------------------------------------- */

    /** Start (or continue, when the same lasso+region) a take session. */
    beginTakeSession(assets) {
      if (!assets || !assets.region || !assets.cov) throw new Error('beginTakeSession needs exportGenAssets output');
      const r = assets.region;
      const pts = this.effectiveLassoPoints();
      const s = this.session;
      // identity = same region AND same lasso geometry (a re-drawn lasso with
      // a coincidentally equal point count must NOT continue the old session)
      const samePts = !!s && pts.length === s.lassoPoints.length &&
        pts.every((p, i) => p.x === s.lassoPoints[i].x && p.y === s.lassoPoints[i].y);
      const same = samePts && s.region.x === r.x && s.region.y === r.y &&
        s.region.w === r.w && s.region.h === r.h;
      if (!same) {
        this.session = {
          region: { x: r.x, y: r.y, w: r.w, h: r.h },
          cov: assets.cov,
          feather: assets.feather,
          lassoPoints: pts,
          takes: [],
          takeIndex: -1,
        };
      }
      return this.session;
    }

    pushTake(rgba) {
      const s = this.session;
      if (!s) throw new Error('no take session');
      if (!rgba || rgba.length !== s.region.w * s.region.h * 4) throw new Error('take buffer size mismatch');
      const arr = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
      s.takes.push(arr);
      s.takeIndex = s.takes.length - 1;
      return s.takeIndex;
    }

    currentTake() {
      const s = this.session;
      return s && s.takeIndex >= 0 ? s.takes[s.takeIndex] : null;
    }

    prevTake() {
      const s = this.session;
      if (!s || s.takeIndex <= 0) return null;
      s.takeIndex -= 1;
      return this.currentTake();
    }

    nextTake() {
      const s = this.session;
      if (!s || s.takeIndex >= s.takes.length - 1) return null;
      s.takeIndex += 1;
      return this.currentTake();
    }

    discardTakes() {
      this.session = null;
      this.lasso = null;
    }

    /** Composite the current take through the feathered lasso onto the active layer. */
    commitTake() {
      const s = this.session;
      if (!s || s.takeIndex < 0) throw new Error('no take to commit');
      const layer = this.activeLayer();
      if (!layer) throw new Error('no active layer');
      const take = s.takes[s.takeIndex];
      const { x, y, w, h } = s.region;

      // snapshot the (canvas-clamped) affected rect for undo
      const cx = Math.max(0, x); const cy = Math.max(0, y);
      const cw = Math.min(w, this.width - cx); const ch = Math.min(h, this.height - cy);
      if (cw <= 0 || ch <= 0) throw new Error('region outside canvas');
      const prev = new Uint8ClampedArray(cw * ch * 4);
      for (let ry = 0; ry < ch; ry++) {
        const dOff = ((cy + ry) * this.width + cx) * 4;
        prev.set(layer.data.subarray(dOff, dOff + cw * 4), ry * cw * 4);
      }

      for (let ry = 0; ry < h; ry++) {
        const gy = y + ry;
        if (gy < 0 || gy >= this.height) continue;
        const rowBase = gy * this.width;
        for (let rx = 0; rx < w; rx++) {
          const gx = x + rx;
          if (gx < 0 || gx >= this.width) continue;
          const a = s.cov[ry * w + rx];
          if (a <= 0) continue; // outside lasso: byte-identical, untouched
          const si = (ry * w + rx) * 4;
          blendSourceOver(layer.data, (rowBase + gx) * 4,
            take[si], take[si + 1], take[si + 2], take[si + 3], a);
        }
      }

      this._undo.push({
        type: 'commit',
        layerId: layer.id,
        rect: { x: cx, y: cy, w: cw, h: ch },
        prev,
        session: { ...s, takes: s.takes.slice() },
      });
      if (this._undo.length > MAX_UNDO) this._undo.shift();
      this.session = null;
      return true;
    }

    /* undo ---------------------------------------------------------- */

    canUndo() { return this._undo.length > 0; }

    undo() {
      const rec = this._undo.pop();
      if (!rec) return null;
      if (rec.type === 'stroke') {
        const layer = this.layerById(rec.layerId);
        if (layer) {
          layer.strokes = layer.strokes.filter((st) => st.id !== rec.strokeId);
          this._rasterLayer(layer);
        }
      } else if (rec.type === 'commit') {
        const layer = this.layerById(rec.layerId);
        if (layer && rec.rect) {
          const { x, y, w, h } = rec.rect;
          for (let ry = 0; ry < h; ry++) {
            const dOff = ((y + ry) * this.width + x) * 4;
            layer.data.set(rec.prev.subarray(ry * w * 4, ry * w * 4 + w * 4), dOff);
          }
        }
        this.session = rec.session;
        this.lasso = { points: rec.session.lassoPoints.slice(), closed: true };
      } else if (rec.type === 'addLayer') {
        this._layers = this._layers.filter((l) => l.id !== rec.layerId);
        if (this.activeLayerId === rec.layerId) this.activeLayerId = rec.prevActive || null;
        if (!this.layerById(this.activeLayerId)) {
          this.activeLayerId = this._layers.length ? this._layers[this._layers.length - 1].id : null;
        }
      }
      return rec;
    }
  }

  /* ------------------------------------------- browser-only helpers */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Deterministic stylized rain-city base (mirrors the v1 mockup scene). */
  function paintRainCity(ctx, w, h, seed = 7) {
    const rnd = mulberry32(seed);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#264450'); sky.addColorStop(0.46, '#1b333d'); sky.addColorStop(1, '#132830');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

    const mg = ctx.createRadialGradient(w * 0.72, h * 0.2, 0, w * 0.72, h * 0.2, w * 0.3);
    mg.addColorStop(0, 'rgba(232,176,75,0.32)'); mg.addColorStop(1, 'rgba(232,176,75,0)');
    ctx.fillStyle = mg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(232,176,75,0.8)';
    ctx.beginPath(); ctx.arc(w * 0.72, h * 0.2, Math.max(6, w * 0.035), 0, Math.PI * 2); ctx.fill();

    const skyline = (baseF, heightF, color, windowChance, seedShift) => {
      const r = mulberry32(seed + seedShift);
      const hy = h * baseF;
      let x = -w * 0.05;
      ctx.fillStyle = color;
      while (x < w * 1.05) {
        const bw = w * (0.04 + r() * 0.09);
        const bh = h * heightF * (0.45 + r() * 0.85);
        const by = hy - bh + r() * h * 0.03;
        ctx.fillRect(x, by, bw, h - by);
        if (windowChance > 0) {
          const cols = Math.max(1, Math.floor(bw / (w * 0.02)));
          const rows = Math.max(1, Math.floor(bh / (h * 0.03)));
          for (let cxi = 0; cxi < cols; cxi++) {
            for (let ryi = 0; ryi < rows; ryi++) {
              if (r() < windowChance) {
                ctx.fillStyle = `rgba(232,176,75,${0.35 + r() * 0.45})`;
                ctx.fillRect(x + bw * 0.15 + cxi * (bw * 0.7 / cols),
                  by + bh * 0.1 + ryi * (bh * 0.8 / rows),
                  Math.max(2, bw * 0.08), Math.max(2, bh * 0.03));
              }
            }
          }
          ctx.fillStyle = color;
        }
        x += bw + w * 0.005;
      }
    };
    skyline(0.5, 0.2, '#0b1a21', 0.0, 1);
    skyline(0.56, 0.26, '#0e2129', 0.05, 2);

    const gr = ctx.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.55);
    gr.addColorStop(0, 'rgba(38,68,80,0.5)'); gr.addColorStop(1, 'rgba(38,68,80,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, h * 0.7, w, h * 0.3);

    ctx.strokeStyle = 'rgba(157,182,189,0.26)';
    ctx.lineWidth = Math.max(1, w / 1000);
    for (let i = 0; i < 150; i++) {
      const x = rnd() * w; const y = rnd() * h * 0.92; const l = h * 0.015 + rnd() * h * 0.03;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - l * 0.14, y + l); ctx.stroke();
    }
  }

  return {
    RainCanvasCore, encodePNG, decodePNG, coverageMask, scanlineFill,
    boundsOf, paintRainCity, PNG_SIG,
  };
});
