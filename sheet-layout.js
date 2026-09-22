/* สำเนาจาก lib/sheet-layout.js (tools/build.py) — แก้ที่ lib/ */
/**
 * sheet-layout.js — ตำแหน่งทุกจุดบนกระดาษคำตอบ ScanGrade (หน่วย มม. บน A4)
 * แหล่งเดียวที่ใช้ร่วมกันระหว่าง: หน้าพิมพ์ใน GAS (js_lib.html) · ตัวสแกนในมือถือ (scanner/) · ชุดทดสอบ
 * แก้ไฟล์นี้แล้วรัน  python3 tools/build.py  เพื่อสร้าง js_lib.html และ scanner/sheet-layout.js ใหม่
 * ห้ามแก้ตัวเลขโดยไม่เพิ่ม VERSION — แผ่นที่พิมพ์ไปแล้วจะอ่านไม่ได้
 */
(function (root) {
  'use strict';
  var SL = { VERSION: 1, CHOICES: ['ก', 'ข', 'ค', 'ง'], MAX_ITEMS: 100 };

  SL.layout = function (n, groups) {
    n = Math.max(1, Math.min(SL.MAX_ITEMS, Number(n) || 40));
    groups = (groups && groups.length ? groups : ['ก', 'ข']).slice(0, 6);
    var L = { version: SL.VERSION, n: n, groups: groups, page: { w: 210, h: 297 } };

    // เครื่องหมายมุม 4 จุด (สี่เหลี่ยมดำ 7 มม.) — x,y = มุมซ้ายบน, c = จุดศูนย์กลาง
    var F = 7;
    L.fiducials = [[10, 10], [193, 10], [10, 280], [193, 280]].map(function (p) {
      return { x: p[0], y: p[1], s: F, cx: p[0] + F / 2, cy: p[1] + F / 2 };
    });

    // ---- เลขประจำตัว 5 หลัก ----
    var P = 5.6, R = 2.1;
    L.bubbleR = R;
    L.code = { label: { x: 21, y: 76 }, boxY: 78, boxH: 6.5, cols: [] };
    for (var c = 0; c < 5; c++) {
      var cx = 25 + c * 6.2, rows = [];
      for (var d = 0; d < 10; d++) rows.push({ v: String(d), x: cx, y: 90 + d * P });
      L.code.cols.push({ x: cx, rows: rows });
    }
    // ---- เลขที่: หลักสิบ 0–4 · หลักหน่วย 0–9 · กลุ่ม ก ข … ----
    var sy = 164;
    L.seat = { label: { x: 21, y: sy - 14 }, boxY: sy - 12, boxH: 6.5, tens: [], units: [], group: [] };
    for (d = 0; d < 5; d++) L.seat.tens.push({ v: String(d), x: 25, y: sy + d * P });
    for (d = 0; d < 10; d++) L.seat.units.push({ v: String(d), x: 31.2, y: sy + d * P });
    groups.forEach(function (g, i) { L.seat.group.push({ v: g, x: 40.6, y: sy + i * P }); });

    // ---- คำตอบ: 3 คอลัมน์ เรียงลงทีละคอลัมน์ ----
    var top = 84, bottom = 272, colW = 38, x0 = 76;
    var rowsPerCol = Math.max(10, Math.ceil(n / 3));
    var gaps = Math.floor((rowsPerCol - 1) / 5), GAP = 1.6;
    var pitch = Math.min(7, (bottom - top - gaps * GAP) / rowsPerCol);
    var ar = Math.min(2.3, pitch * 0.4);
    L.answer = { r: ar, pitch: pitch, rowsPerCol: rowsPerCol, headerY: top - 6.5, cols: [], items: [] };
    for (c = 0; c < 3; c++) {
      var bx = x0 + c * colW;
      L.answer.cols.push({ x: bx, mark: { x: bx + 1.2, y: top - 9, s: 3.6 }, labelX: bx + 6.8, choiceX: [bx + 11.5, bx + 18, bx + 24.5, bx + 31] });
    }
    L.rowY = [];
    for (var r = 0; r < rowsPerCol; r++) L.rowY.push(top + pitch / 2 + r * pitch + Math.floor(r / 5) * GAP);
    for (var i = 0; i < n; i++) {
      var col = Math.floor(i / rowsPerCol), row = i % rowsPerCol, cc = L.answer.cols[col];
      L.answer.items.push({ no: i + 1, col: col, row: row, y: L.rowY[row], xs: cc.choiceX.slice(), labelX: cc.labelX });
    }
    // ---- timing marks ขอบขวา: 1 ขีดต่อ 1 แถวคำตอบ ----
    L.timing = L.rowY.map(function (y) { return { x: 194.5, y: y - 0.8, w: 4, h: 1.6 }; });
    // ---- รหัสแม่แบบ: [1][b6..b0 = n][parity][1] ช่องละ 4 มม. ----
    var bits = [1], s = 0;
    for (var b = 6; b >= 0; b--) { var v = (n >> b) & 1; bits.push(v); s += v; }
    bits.push(s % 2); bits.push(1);
    L.bits = bits.map(function (v, k) { return { x: 26 + k * 6, y: 281.5, s: 4, on: v }; });
    return L;
  };

  /** อ่านจำนวนข้อจากบิต (ใช้ในเครื่องสแกน) */
  SL.decodeBits = function (arr) {
    if (arr.length !== 10 || !arr[0] || !arr[9]) return null;
    var n = 0, s = 0;
    for (var k = 1; k <= 7; k++) { n = n * 2 + (arr[k] ? 1 : 0); s += arr[k] ? 1 : 0; }
    return (s % 2) === (arr[8] ? 1 : 0) && n >= 1 && n <= SL.MAX_ITEMS ? n : null;
  };

  root.SheetLayout = SL;
  if (typeof module !== 'undefined' && module.exports) module.exports = SL;
})(typeof window !== 'undefined' ? window : this);
