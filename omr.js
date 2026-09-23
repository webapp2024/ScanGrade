/* สำเนาจาก lib/omr.js (tools/build.py) — แก้ที่ lib/ */
/**
 * omr.js — ตัวอ่านกระดาษคำตอบ ScanGrade (JavaScript ล้วน ไม่ใช้ OpenCV)
 * ใช้ได้ทั้งในเบราว์เซอร์ (หน้าสแกน) และ Node (ชุดทดสอบ)
 *
 *   OMR.fromImageData(imgData)              → gray {w,h,d}
 *   OMR.detect(gray)                         → มุม 4 จุด (px) หรือ null — ใช้ทุกเฟรมตอนเล็งกล้อง
 *   OMR.scan(gray, {n, groups, min, margin}) → ผลอ่านทั้งแผ่น (หา 4 มุม → หาทิศ → อ่านทุกวง)
 *   OMR.rectify(gray, H, pxPerMm)            → ภาพดัดตรง (สำหรับเก็บไว้ตรวจทาน)
 *
 * พิกัดทุกจุดมาจาก SheetLayout (lib/sheet-layout.js) — ไฟล์เดียวกับหน้าพิมพ์
 */
(function (root) {
  'use strict';
  var SL = root.SheetLayout || (typeof require === 'function' ? require('./sheet-layout.js') : null);

  /* ------------------------------------------------------------------ image */
  function fromImageData(img) {
    var n = img.width * img.height, d = new Uint8Array(n), s = img.data;
    for (var i = 0, j = 0; i < n; i++, j += 4) d[i] = (s[j] * 77 + s[j + 1] * 150 + s[j + 2] * 29) >> 8;
    return { w: img.width, h: img.height, d: d };
  }

  function downscale(g, maxW) {
    if (g.w <= maxW) return { g: g, k: 1 };
    var k = g.w / maxW, w = Math.round(g.w / k), h = Math.round(g.h / k), d = new Uint8Array(w * h);
    var step = Math.max(1, Math.floor(k));
    for (var y = 0; y < h; y++) {
      var sy = Math.floor(y * k);
      for (var x = 0; x < w; x++) {
        var sx = Math.floor(x * k), sum = 0, cnt = 0;
        for (var yy = 0; yy < step && sy + yy < g.h; yy++) {
          var row = (sy + yy) * g.w;
          for (var xx = 0; xx < step && sx + xx < g.w; xx++) { sum += g.d[row + sx + xx]; cnt++; }
        }
        d[y * w + x] = sum / cnt;
      }
    }
    return { g: { w: w, h: h, d: d }, k: k };
  }

  /* ------------------------------------------------------------------ fiducials */
  /** หา blob ทึบรูปสี่เหลี่ยม (adaptive threshold ด้วย integral image + connected components) */
  function blobs(g) {
    var w = g.w, h = g.h, d = g.d, W = w + 1;
    var I = new Float64Array(W * (h + 1));
    for (var y = 0; y < h; y++) {
      var rs = 0;
      for (var x = 0; x < w; x++) { rs += d[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs; }
    }
    var R = Math.max(8, Math.round(w / 14)); // หน้าต่างใหญ่กว่า fiducial → ด้านในยังนับเป็นสีดำ
    var mask = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
        var mean = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
        mask[y * w + x] = d[y * w + x] < mean * 0.62 ? 1 : 0;
      }
    }
    var label = new Int32Array(w * h), stack = new Int32Array(w * h), out = [];
    var minA = Math.pow(w * 0.010, 2), maxA = Math.pow(w * 0.09, 2), cur = 0;
    for (var p = 0; p < w * h; p++) {
      if (!mask[p] || label[p]) continue;
      cur++;
      var sp = 0, area = 0, sx = 0, sy = 0, bx0 = w, by0 = h, bx1 = 0, by1 = 0;
      stack[sp++] = p; label[p] = cur;
      while (sp) {
        var q = stack[--sp], qx = q % w, qy = (q - qx) / w;
        area++; sx += qx; sy += qy;
        if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
        if (qx > 0 && mask[q - 1] && !label[q - 1]) { label[q - 1] = cur; stack[sp++] = q - 1; }
        if (qx < w - 1 && mask[q + 1] && !label[q + 1]) { label[q + 1] = cur; stack[sp++] = q + 1; }
        if (qy > 0 && mask[q - w] && !label[q - w]) { label[q - w] = cur; stack[sp++] = q - w; }
        if (qy < h - 1 && mask[q + w] && !label[q + w]) { label[q + w] = cur; stack[sp++] = q + w; }
      }
      if (area < minA || area > maxA) continue;
      var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, ar = bw / bh, fill = area / (bw * bh);
      if (ar < 0.6 || ar > 1.65 || fill < 0.55) continue;
      out.push({ x: sx / area, y: sy / area, a: area, s: Math.sqrt(area) });
    }
    return out;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  /** ตรวจว่า 4 จุด (TL,TR,BR,BL ตามเข็ม) เป็นกรอบกระดาษที่สมเหตุสมผล */
  function plausible(q) {
    for (var i = 0; i < 4; i++) if (cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) <= 0) return false; // นูน + ตามเข็ม (แกน y ลง)
    var top = dist(q[0], q[1]), bot = dist(q[3], q[2]), left = dist(q[0], q[3]), right = dist(q[1], q[2]);
    var ratio = ((top + bot) / 2) / ((left + right) / 2);   // กระดาษจริง 183/270 = 0.678 (หรือกลับด้าน 1.475)
    var okRatio = (ratio > 0.5 && ratio < 0.9) || (ratio > 1.1 && ratio < 2.0);
    if (!okRatio) return false;
    if (Math.max(top, bot) / Math.min(top, bot) > 1.6 || Math.max(left, right) / Math.min(left, right) > 1.6) return false;
    var sizes = q.map(function (p) { return p.s; });
    return Math.max.apply(null, sizes) / Math.min.apply(null, sizes) < 2.6;
  }

  /** เลือก 4 มุมจาก blob — ลองจุดที่ใกล้มุมภาพ และจุดสุดขั้ว x±y */
  function pickCorners(bl, w, h) {
    if (bl.length < 4) return null;
    var big = bl.slice().sort(function (a, b) { return b.a - a.a; });
    var ref = big[Math.min(3, big.length - 1)].a;
    var cands = bl.filter(function (b) { return b.a >= ref * 0.35; });
    var tries = [];
    // 1) ใกล้มุมภาพที่สุด
    tries.push([[0, 0], [w, 0], [w, h], [0, h]].map(function (c) {
      return cands.reduce(function (best, b) { var dd = Math.hypot(b.x - c[0], b.y - c[1]); return !best || dd < best.dd ? { b: b, dd: dd } : best; }, null).b;
    }));
    // 2) จุดสุดขั้ว
    var ext = function (f) { return cands.reduce(function (m, b) { return !m || f(b) > f(m) ? b : m; }, null); };
    tries.push([ext(function (b) { return -(b.x + b.y); }), ext(function (b) { return b.x - b.y; }), ext(function (b) { return b.x + b.y; }), ext(function (b) { return b.y - b.x; })]);
    for (var t = 0; t < tries.length; t++) {
      var q = tries[t];
      if (q[0] === q[1] || q[1] === q[2] || q[2] === q[3] || q[3] === q[0] || q[0] === q[2] || q[1] === q[3]) continue;
      if (plausible(q)) return q;
    }
    return null;
  }

  /** ใช้ทุกเฟรม: คืนมุม 4 จุด (ตามเข็ม เริ่มซ้ายบนของภาพ) ในพิกัดของภาพที่ส่งมา */
  function detect(g, maxW) {
    var ds = downscale(g, maxW || 640);
    var q = pickCorners(blobs(ds.g), ds.g.w, ds.g.h);
    if (!q) return null;
    return q.map(function (p) { return { x: p.x * ds.k, y: p.y * ds.k, s: p.s * ds.k }; });
  }

  /** ปรับจุดศูนย์กลาง fiducial บนภาพความละเอียดเต็ม */
  function refine(g, p) {
    var r = Math.max(4, Math.round(p.s * 1.1)), x0 = Math.max(0, Math.round(p.x - r)), x1 = Math.min(g.w - 1, Math.round(p.x + r));
    var y0 = Math.max(0, Math.round(p.y - r)), y1 = Math.min(g.h - 1, Math.round(p.y + r));
    var mn = 255, mx = 0, x, y, v;
    for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) { v = g.d[y * g.w + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
    var th = (mn + mx) / 2, sx = 0, sy = 0, n = 0;
    for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) if (g.d[y * g.w + x] < th) { sx += x; sy += y; n++; }
    return n > 4 ? { x: sx / n, y: sy / n, s: p.s } : p;
  }

  /* ------------------------------------------------------------------ geometry */
  /** homography H ที่ map src[i] → dst[i] (4 จุด) · คืน array 9 ค่า */
  function homography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var n = 8;
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      var tA = A[c]; A[c] = A[piv]; A[piv] = tA; var tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = A[r][c] / A[c][c];
        if (!f) continue;
        for (var k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    var h = [];
    for (i = 0; i < n; i++) h.push(b[i] / A[i][i]);
    h.push(1);
    return h;
  }
  function apply(H, x, y) {
    var z = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / z, y: (H[3] * x + H[4] * y + H[5]) / z };
  }

  /* ------------------------------------------------------------------ sampling */
  /** ความเข้มของวง (0 = ขาว, 1 = ดำ) เทียบกับสีกระดาษรอบ ๆ (ทนแสงไม่เท่ากัน) */
  function darkness(g, H, x, y, r) {
    var c = apply(H, x, y), e = apply(H, x + 1, y), s = Math.hypot(e.x - c.x, e.y - c.y); // px ต่อ มม.
    var ri = Math.max(1.5, r * 0.62 * s), ri2 = ri * ri, sum = 0, n = 0, X, Y, v;
    var cx = c.x, cy = c.y;
    for (Y = Math.floor(cy - ri); Y <= Math.ceil(cy + ri); Y++) {
      if (Y < 0 || Y >= g.h) continue;
      for (X = Math.floor(cx - ri); X <= Math.ceil(cx + ri); X++) {
        if (X < 0 || X >= g.w) continue;
        var dx = X - cx, dy = Y - cy;
        if (dx * dx + dy * dy <= ri2) { sum += g.d[Y * g.w + X]; n++; }
      }
    }
    if (!n) return 0;
    // สีกระดาษ: เปอร์เซ็นไทล์ 90 ของพื้นที่รอบวง
    var R = Math.max(3, r * 2.3 * s), step = Math.max(1, Math.floor(R / 12)), hist = new Uint32Array(256), cnt = 0;
    for (Y = Math.floor(cy - R); Y <= cy + R; Y += step) {
      if (Y < 0 || Y >= g.h) continue;
      for (X = Math.floor(cx - R); X <= cx + R; X += step) {
        if (X < 0 || X >= g.w) continue;
        hist[g.d[Y * g.w + X]]++; cnt++;
      }
    }
    var target = cnt * 0.9, acc = 0, white = 255;
    for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { white = v; break; } }
    white = Math.max(white, 40);
    return Math.max(0, Math.min(1, 1 - (sum / n) / white));
  }

  /* ------------------------------------------------------------------ local alignment */
  // 4 มุมบอกตำแหน่งได้แม่นเฉพาะกระดาษที่เรียบสนิท — กระดาษโค้ง/ยกขอบ หรือเลนส์กล้อง ทำให้กลางแผ่นเพี้ยนได้ 2–3 มม.
  // (เกือบเท่ารัศมีวง) จึงวัดตำแหน่งจริงของ "ขอบวงที่พิมพ์ไว้" ทุกวง (วงว่างหรือระบายแล้วก็มีขอบเหมือนกัน)
  // แล้วสร้างสนามการเลื่อนแบบเรียบ (mm → mm) มาแก้ตำแหน่งก่อนอ่าน
  var AL_S1 = 2.5;   // รอบแรกค้นหา ±2.5 มม. (< ครึ่งระยะห่างแถวที่แคบสุด 5.25 มม. → ไม่กระโดดไปแถวข้าง ๆ)
  var AL_S2 = 1.0;   // รอบสองค้นรอบค่าที่คาดจากรอบแรก
  var AL_SIGMA = 8;  // ความกว้างของการเกลี่ย (มม.)
  var AL_GRID = 5;   // ความละเอียดตารางสนามการเลื่อน (มม.)
  var RING_N = 20, RING_COS = [], RING_SIN = [];
  for (var ri_ = 0; ri_ < RING_N; ri_++) { RING_COS.push(Math.cos(ri_ * 2 * Math.PI / RING_N)); RING_SIN.push(Math.sin(ri_ * 2 * Math.PI / RING_N)); }

  function pix(g, x, y) {
    var X = Math.floor(x), Y = Math.floor(y);
    if (X < 0 || Y < 0 || X >= g.w - 1 || Y >= g.h - 1) return 255;
    var fx = x - X, fy = y - Y, i = Y * g.w + X, d = g.d;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
  }

  /** หาตำแหน่งขอบวง 1 วงรอบจุด (x,y)+(cx,cy) มม. ภายใน ±S: คะแนน = สีกระดาษนอกวง − สีขอบวง */
  function findRing(g, H, x, y, r, cx, cy, S) {
    var c = apply(H, x, y), ex = apply(H, x + 1, y), ey = apply(H, x, y + 1); // ใกล้ ๆ จุดนี้ถือว่าเป็น affine
    var ax = ex.x - c.x, ay = ex.y - c.y, bx = ey.x - c.x, by = ey.y - c.y;
    var score = function (dx, dy) {
      var s = 0;
      for (var k = 0; k < RING_N; k++) {
        var u1 = dx + r * RING_COS[k], v1 = dy + r * RING_SIN[k], u2 = dx + r * 1.32 * RING_COS[k], v2 = dy + r * 1.32 * RING_SIN[k];
        s += pix(g, c.x + u2 * ax + v2 * bx, c.y + u2 * ay + v2 * by) - pix(g, c.x + u1 * ax + v1 * bx, c.y + u1 * ay + v1 * by);
      }
      return s / RING_N;
    };
    var best = null, pass = function (ox, oy, R, st) {
      for (var dy = -R; dy <= R + 1e-9; dy += st) for (var dx = -R; dx <= R + 1e-9; dx += st) {
        var sc = score(ox + dx, oy + dy);
        if (!best || sc > best.s) best = { dx: ox + dx, dy: oy + dy, s: sc };
      }
    };
    pass(cx, cy, S, 0.5);
    pass(best.dx, best.dy, 0.5, 0.125);
    best.edge = Math.abs(best.dx - cx) > S - 0.2 || Math.abs(best.dy - cy) > S - 0.2;
    return best;
  }

  /** สนามการเลื่อนแบบเรียบจากจุดวัด (local linear regression ถ่วงน้ำหนักแบบเกาส์) → ตาราง AL_GRID มม. */
  function fitField(pts) {
    var nx = Math.ceil(210 / AL_GRID) + 1, ny = Math.ceil(297 / AL_GRID) + 1, gx = new Float32Array(nx * ny), gy = new Float32Array(nx * ny);
    var inv = 1 / (2 * AL_SIGMA * AL_SIGMA), lam = 0.1 * AL_SIGMA * AL_SIGMA;
    for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
      var X = i * AL_GRID, Y = j * AL_GRID, m = [0, 0, 0, 0, 0, 0], bx = [0, 0, 0], by = [0, 0, 0];
      for (var k = 0; k < pts.length; k++) {
        var p = pts[k], u = p.x - X, v = p.y - Y, w = p.w * Math.exp(-(u * u + v * v) * inv);
        m[0] += w; m[1] += w * u; m[2] += w * v; m[3] += w * u * u; m[4] += w * u * v; m[5] += w * v * v;
        bx[0] += w * p.dx; bx[1] += w * u * p.dx; bx[2] += w * v * p.dx;
        by[0] += w * p.dy; by[1] += w * u * p.dy; by[2] += w * v * p.dy;
      }
      if (m[0] < 1e-12) continue;
      var a = m[0], b = m[1], c = m[2], d = m[3] + lam * m[0], e = m[4], f = m[5] + lam * m[0];
      var det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
      var solve = function (r) { // Cramer: เอาเฉพาะค่าคงที่ (ค่าที่จุดนี้)
        return Math.abs(det) < 1e-12 ? r[0] / a : (r[0] * (d * f - e * e) - b * (r[1] * f - e * r[2]) + c * (r[1] * e - d * r[2])) / det;
      };
      gx[j * nx + i] = solve(bx); gy[j * nx + i] = solve(by);
    }
    return {
      nx: nx, ny: ny, step: AL_GRID, gx: gx, gy: gy,
      at: function (x, y) {
        var fx = Math.max(0, Math.min(nx - 1.001, x / AL_GRID)), fy = Math.max(0, Math.min(ny - 1.001, y / AL_GRID));
        var i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, q = j * nx + i;
        var bl = function (A) { return (A[q] * (1 - tx) + A[q + 1] * tx) * (1 - ty) + (A[q + nx] * (1 - tx) + A[q + nx + 1] * tx) * ty; };
        return { x: x + bl(gx), y: y + bl(gy) };
      }
    };
  }

  /** วัดทุกวงบนแผ่น → สนามการเลื่อน (คืน null ถ้าวัดได้น้อยเกินไป) */
  function align(g, L, H) {
    var R = L.bubbleR, feats = [];
    L.code.cols.forEach(function (c) { c.rows.forEach(function (b) { feats.push({ x: b.x, y: b.y, r: R }); }); });
    L.seat.tens.concat(L.seat.units, L.seat.group).forEach(function (b) { feats.push({ x: b.x, y: b.y, r: R }); });
    L.answer.items.forEach(function (it) { it.xs.forEach(function (x) { feats.push({ x: x, y: it.y, r: L.answer.r }); }); });
    var anchors = L.fiducials.map(function (f) { return { x: f.cx, y: f.cy, dx: 0, dy: 0, w: 4 }; }); // มุมถูกปรับละเอียดแล้ว
    var keep = function (ms) {
      var sc = ms.map(function (m) { return m.s; }).sort(function (a, b) { return a - b; }), med = sc[sc.length >> 1] || 0;
      return ms.filter(function (m) { return !m.edge && m.s >= Math.max(6, med * 0.45); });
    };
    var robust = function (ms) { // ตัดจุดที่ต่างจากค่าเฉลี่ยเพื่อนบ้านเกิน 1 มม. (เช่น ระบายเลอะออกนอกวง) แล้วสร้างสนาม
      var inv = 1 / (2 * AL_SIGMA * AL_SIGMA);
      var good = ms.filter(function (m) {
        var sw = 0, sx = 0, sy = 0;
        ms.forEach(function (o) { if (o === m) return; var w = Math.exp(-((o.x - m.x) * (o.x - m.x) + (o.y - m.y) * (o.y - m.y)) * inv); sw += w; sx += w * o.dx; sy += w * o.dy; });
        return sw < 0.3 || Math.hypot(sx / sw - m.dx, sy / sw - m.dy) <= 1.0; // จุดโดดเดี่ยว = ไม่มีอะไรเทียบ เก็บไว้
      });
      return { F: fitField(anchors.concat(good)), n: good.length };
    };
    var m1 = keep(feats.map(function (f) { var b = findRing(g, H, f.x, f.y, f.r, 0, 0, AL_S1); return { x: f.x, y: f.y, dx: b.dx, dy: b.dy, s: b.s, edge: b.edge, w: 1 }; }));
    if (m1.length < 8) return null;
    var out = robust(m1), F1 = out.F;
    var m2 = keep(feats.map(function (f) {
      var p = F1.at(f.x, f.y), b = findRing(g, H, f.x, f.y, f.r, p.x - f.x, p.y - f.y, AL_S2);
      return { x: f.x, y: f.y, dx: b.dx, dy: b.dy, s: b.s, edge: b.edge, w: 1 };
    }));
    if (m2.length >= 8) out = robust(m2);
    // used/total ต่ำ = วัดแล้วขัดกันเอง (กระดาษโค้งเกินครึ่งระยะแถว อาจอ่านเลื่อนแถว) → ต้องตรวจทาน
    out.F.used = out.n; out.F.total = feats.length;
    return out.F;
  }

  /**
   * ตัดสิน 1 กลุ่มวง: index · -1 ว่าง · -2 ตอบซ้อน + ความมั่นใจ
   * นับว่าระบายเมื่อ เข้ม ≥ min (ค่าตั้งค่า) หรือ — ถ้ามี tc — เข้มกว่าวงอื่นในกลุ่มเดียวกันอย่างน้อย tc
   * (ดินสอจาง/แสงกล้องทำให้ค่าเข้มลดทั้งแผ่น แต่ยังต่างจากวงว่างข้าง ๆ ชัดเจน)
   */
  function decide(vals, min, margin, tc) {
    var order = vals.map(function (v, i) { return i; }).sort(function (a, b) { return vals[b] - vals[a]; });
    var a = vals[order[0]], b = vals.length > 1 ? vals[order[1]] : 0, idx, conf;
    var rest = order.slice(1).map(function (i) { return vals[i]; }).sort(function (x, y) { return x - y; });
    var base = rest.length ? rest[(rest.length - 1) >> 1] : 0; // ค่ากลางของวงที่เหลือ = ระดับวงว่างในกลุ่มนี้
    var strength = function (v) { return tc ? Math.max(v - min, Math.min(v - 0.15, v - base - tc)) : v - min; };
    var second = b >= min || (tc && strength(b) >= 0 && b >= a * 0.7); // วงที่ 2 ต้องเข้มพอ ๆ กันจึงนับว่าซ้อน (กันรอยลบ)
    if (strength(a) < 0) { idx = -1; conf = Math.min(1, -strength(a) / 0.12); }
    else if (second && a - b < margin) { idx = -2; conf = Math.min(1, strength(b) / 0.12); }
    else { idx = order[0]; conf = Math.min(1, Math.min(strength(a), (a - b) - margin + 0.1) / 0.12); }
    return { i: idx, conf: Math.max(0, conf), top: a, second: b };
  }

  /** ระดับ "ต่างจากวงว่าง" ที่แผ่นนี้ใช้ = 45% ของความต่างทั่วไปของข้อที่ระบายชัด · 0 = ไม่ใช้ (ข้อที่ระบายชัดน้อยเกินไป) */
  function contrastThreshold(groups) {
    var cs = [];
    groups.forEach(function (vals) {
      var v = vals.slice().sort(function (x, y) { return y - x; }), rest = v.slice(1).sort(function (x, y) { return x - y; });
      var c = v[0] - (rest.length ? rest[(rest.length - 1) >> 1] : 0);
      if (c >= 0.15) cs.push(c);
    });
    if (cs.length < 3) return 0;
    cs.sort(function (x, y) { return x - y; });
    return Math.max(0.12, Math.min(0.2, 0.45 * cs[cs.length >> 1]));
  }

  var CORNER_ORDER = [0, 1, 3, 2]; // layout.fiducials = TL,TR,BL,BR → ตามเข็ม TL,TR,BR,BL

  /** อ่านแผ่นเมื่อรู้ H (mm → px) แล้ว · F = สนามการเลื่อนจาก align() (ไม่มีก็ได้) */
  function readWith(g, L, H, opt, F) {
    var min = opt.min || 0.3, margin = opt.margin || 0.14, flags = [], confs = [];
    var dk = function (x, y, r) { var p = F ? F.at(x, y) : { x: x, y: y }; return darkness(g, H, p.x, p.y, r); };
    var bitVals = L.bits.map(function (b) { return dk(b.x + b.s / 2, b.y + b.s / 2, b.s * 0.45); });
    var bits = bitVals.map(function (v) { return v > 0.45 ? 1 : 0; });
    var R = L.bubbleR, tc = 0, val = function (list, r) { return list.map(function (b) { return dk(b.x, b.y, r); }); };
    var codeVals = L.code.cols.map(function (col) { return val(col.rows, R); });
    var ansVals = L.answer.items.map(function (it) { return it.xs.map(function (x) { return dk(x, it.y, L.answer.r); }); });
    if (opt.relative !== false) tc = contrastThreshold(ansVals.concat(codeVals));
    var grp = function (list, r) { return decide(val(list, r), min, margin, tc); };
    var code = '', seatOk = true, codeTops = [];
    L.code.cols.forEach(function (col, ci) {
      var d = decide(codeVals[ci], min, margin, tc); confs.push(d.conf); codeTops.push(Math.round(d.top * 100) / 100);
      code += d.i >= 0 ? String(d.i) : d.i === -1 ? '?' : '*';
    });
    var tens = grp(L.seat.tens, R), units = grp(L.seat.units, R), gi = L.seat.group.length ? grp(L.seat.group, R) : { i: -1, conf: 1 };
    var seat = '';
    if (tens.i >= 0 && units.i >= 0 && gi.i >= 0) seat = String(tens.i * 10 + units.i) + L.groups[gi.i];
    else seatOk = false;
    if (code.indexOf('?') > -1 || code.indexOf('*') > -1) flags.push('code_incomplete');
    var answers = '', details = [];
    L.answer.items.forEach(function (it, k) {
      var vals = ansVals[k];
      var d = decide(vals, min, margin, tc);
      answers += d.i >= 0 ? String(d.i + 1) : d.i === -1 ? '0' : '9';
      if (d.i === -2) flags.push('multi:' + it.no);
      if (d.i === -1) flags.push('blank:' + it.no);
      if (d.conf < 0.35) flags.push('low_conf:' + it.no);
      confs.push(d.conf);
      details.push(vals.map(function (v) { return Math.round(v * 100) / 100; }));
    });
    // ตรวจเรขาคณิต: หัวคอลัมน์ + ขีดขอบขวาทุกแถวต้องดำ และช่องระหว่างขีดต้องขาว (จับการอ่านเลื่อนแถว)
    var marks = L.answer.cols.filter(function (c, ci) { return L.answer.items.some(function (it) { return it.col === ci; }); })
      .map(function (c) { return dk(c.mark.x + c.mark.s / 2, c.mark.y + c.mark.s / 2, c.mark.s * 0.4); });
    var tm = L.timing.map(function (t) { return dk(t.x + t.w / 2, t.y + t.h / 2, 0.7); });
    var gaps = L.timing.slice(1).map(function (t, i) { var a = L.timing[i]; return dk(a.x + a.w / 2, (a.y + t.y + a.h) / 2, 0.5); });
    var geomOk = marks.every(function (v) { return v > 0.45; }) && tm.every(function (v) { return v > 0.45; }) && gaps.every(function (v) { return v < 0.3; });
    if (!geomOk || (F && F.used / F.total < 0.94)) flags.push('warp');
    var conf = confs.length ? confs.reduce(function (a, b) { return Math.min(a, b); }, 1) : 0;
    return {
      bits: bits, n_bits: SL.decodeBits(bits), code: code, seat: seat, seat_ok: seatOk, answers: answers,
      flags: flags, confidence: Math.round(conf * 1000) / 1000, geometry_ok: geomOk, details: details, code_tops: codeTops, contrast_min: Math.round(tc * 100) / 100
    };
  }

  /**
   * อ่านทั้งแผ่น: หา 4 มุม → ลองทั้ง 4 ทิศ (ตั้ง/กลับหัว/ตะแคง) → ทิศที่อ่านบิตจำนวนข้อได้ถูกต้อง
   * opt = { n (จำนวนข้อของชุดข้อสอบ), groups, min, margin, corners (ถ้ามีจากเฟรมก่อน) }
   */
  function scan(g, opt) {
    opt = opt || {};
    var corners = opt.corners || detect(g, 800);
    if (!corners) return { ok: false, error: 'not_found', message: 'ไม่พบสี่เหลี่ยมดำ 4 มุม' };
    corners = corners.map(function (p) { return refine(g, p); });
    var layout0 = SL.layout(opt.n || 40, opt.groups);
    var dstMm = CORNER_ORDER.map(function (i) { return { x: layout0.fiducials[i].cx, y: layout0.fiducials[i].cy }; });
    var best = null;
    for (var rot = 0; rot < 4; rot++) {
      var src = [0, 1, 2, 3].map(function (k) { return corners[(k + rot) % 4]; });
      var H = homography(dstMm, src); // mm → px
      if (!H) continue;
      var bitVals = layout0.bits.map(function (b) { return darkness(g, H, b.x + b.s / 2, b.y + b.s / 2, b.s * 0.45) > 0.45 ? 1 : 0; });
      var n = SL.decodeBits(bitVals);
      if (n) { best = { H: H, n: n, rot: rot }; break; }
    }
    if (!best) return { ok: false, error: 'bits', message: 'อ่านรหัสแบบกระดาษไม่ได้ — ถ่ายให้เห็นทั้งแผ่นชัด ๆ', corners: corners };
    var L = best.n === layout0.n ? layout0 : SL.layout(best.n, opt.groups);
    var F = opt.align === false ? null : align(g, L, best.H);
    var res = readWith(g, L, best.H, opt, F);
    res.ok = true; res.n = best.n; res.rotation = best.rot * 90; res.H = best.H; res.field = F; res.corners = corners;
    res.n_mismatch = !!(opt.n && best.n !== opt.n);
    res.review = res.n_mismatch || !res.geometry_ok || res.flags.some(function (f) { return /^(multi|low_conf|code_incomplete|warp)/.test(f); });
    return res;
  }

  /** ภาพดัดตรง (gray) ขนาด 210×297 มม. × pxPerMm — ใช้เก็บเป็นหลักฐาน/ตรวจทาน · F = res.field (ให้วงตรงกับตำแหน่งใน layout) */
  function rectify(g, H, pxPerMm, F) {
    var k = pxPerMm || 4, w = Math.round(210 * k), h = Math.round(297 * k), d = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var my = (y + 0.5) / k;
      for (var x = 0; x < w; x++) {
        var q = F ? F.at((x + 0.5) / k, my) : { x: (x + 0.5) / k, y: my };
        var p = apply(H, q.x, q.y), X = Math.round(p.x), Y = Math.round(p.y);
        d[y * w + x] = X >= 0 && Y >= 0 && X < g.w && Y < g.h ? g.d[Y * g.w + X] : 255;
      }
    }
    return { w: w, h: h, d: d };
  }

  // VERSION แสดงบนหน้าสแกน ใช้เช็คว่ามือถือโหลดตัวอ่านล่าสุดแล้ว · 2 = ปรับตำแหน่งวงเฉพาะจุด (กระดาษโค้ง) · 3 = + ค่าวินิจฉัย code_tops · 4 = ดินสอจาง: เทียบกับวงอื่นในข้อเดียวกัน
  var OMR = { VERSION: 4, fromImageData: fromImageData, downscale: downscale, blobs: blobs, detect: detect, refine: refine, homography: homography, apply: apply, darkness: darkness, decide: decide, align: align, scan: scan, readWith: readWith, rectify: rectify };
  root.OMR = OMR;
  if (typeof module !== 'undefined' && module.exports) module.exports = OMR;
})(typeof window !== 'undefined' ? window : this);
