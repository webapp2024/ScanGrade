/* =====================================================================
 * ScanGrade — หน้าสแกนบนมือถือ
 * กล้องสด → หา 4 มุม (OMR.detect) → นิ่ง 3 เฟรม = ถ่ายเอง → อ่านทั้งแผ่น (OMR.scan)
 * → แสดงผล + คะแนนทันที → เก็บลงคิว (IndexedDB) → ส่งเข้า GAS ทีละ 10 แผ่นเมื่อมีเน็ต
 * ===================================================================== */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var CH = ['ก', 'ข', 'ค', 'ง'];
  var S = { api: '', token: '', user: null, config: { groups: ['ก', 'ข'], omr_min: 0.3, omr_margin: 0.14 }, exams: [], exam: null, roster: null, session: 0 };

  /* ---------------- storage ---------------- */
  var LS = {
    get: function (k) { try { return localStorage.getItem('sgs_' + k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem('sgs_' + k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem('sgs_' + k); } catch (e) { /* ignore */ } }
  };
  var DB = (function () {
    var dbp = null, mem = {};
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res) {
        try {
          var rq = indexedDB.open('scangrade', 1);
          rq.onupgradeneeded = function () { var s = rq.result.createObjectStore('queue', { keyPath: 'request_id' }); s.createIndex('status', 'status'); };
          rq.onsuccess = function () { res(rq.result); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        if (!db) return fn(null);
        return new Promise(function (res, rej) {
          var t = db.transaction('queue', mode), st = t.objectStore('queue'), out = fn(st);
          t.oncomplete = function () { res(out && typeof out === 'object' && 'readyState' in out ? out.result : out); };
          t.onerror = function () { rej(t.error); };
        });
      });
    }
    return {
      put: function (it) { return tx('readwrite', function (st) { if (!st) { mem[it.request_id] = it; return; } st.put(it); }); },
      all: function () {
        return tx('readonly', function (st) { if (!st) return Object.keys(mem).map(function (k) { return mem[k]; }); return st.getAll(); })
          .then(function (r) { return (r || []).sort(function (a, b) { return String(b.scanned_at).localeCompare(String(a.scanned_at)); }); });
      },
      del: function (id) { return tx('readwrite', function (st) { if (!st) { delete mem[id]; return; } st.delete(id); }); }
    };
  })();

  /* ---------------- ui helpers ---------------- */
  var screens = ['scrSetup', 'scrLogin', 'scrExams', 'scrScan', 'scrQueue'];
  function show(id) { screens.forEach(function (s) { $('#' + s).classList.toggle('hidden', s !== id); }); window.scrollTo(0, 0); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var toastT;
  function toast(msg, bad) {
    var el = $('.toast') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toast' }));
    el.textContent = msg; el.classList.toggle('bad', !!bad); el.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.add('hidden'); }, bad ? 4000 : 2200);
  }
  function busy(btn, on, text) { if (on) { btn.dataset.t = btn.textContent; btn.textContent = text || 'กำลังทำงาน…'; btn.disabled = true; } else { btn.textContent = btn.dataset.t || btn.textContent; btn.disabled = false; } }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function normCode(c) { var s = String(c || '').replace(/\D/g, ''); return s ? String(Number(s)) : ''; }

  /* ---------------- API ---------------- */
  function call(action, data) {
    var body = Object.assign({ action: action, token: S.token }, data || {});
    return fetch(S.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('เชื่อมต่อไม่ได้ (' + r.status + ')'); return r.json(); })
      .then(function (res) {
        if (res.status === 'ok') return res.data;
        if (res.message === 'SESSION_EXPIRED') { logout(true); throw new Error('หมดเวลาใช้งาน กรุณาเข้าสู่ระบบใหม่'); }
        throw new Error(res.message || 'ผิดพลาด');
      });
  }

  /* ---------------- setup / login ---------------- */
  function boot() {
    var m = location.hash.match(/api=([^&]+)/);
    if (m) { LS.set('api', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
    S.api = LS.get('api'); S.token = LS.get('token');
    try { S.user = JSON.parse(LS.get('user') || 'null'); S.config = Object.assign(S.config, JSON.parse(LS.get('config') || '{}')); } catch (e) { /* ignore */ }
    if (!S.api) { show('scrSetup'); return; }
    if (!S.token) { showLogin(); return; }
    showExams();
    sync();
  }
  function showLogin() {
    show('scrLogin');
    call('ping').then(function () { /* ok */ }).catch(function () { /* แสดงข้อผิดพลาดตอน login */ });
  }
  $('#setupBtn').addEventListener('click', function () {
    var url = $('#apiUrl').value.trim(), err = $('#setupErr'), btn = this;
    err.classList.add('hidden');
    if (!/^https?:\/\/.+/.test(url)) { err.textContent = 'ลิงก์ไม่ถูกต้อง'; err.classList.remove('hidden'); return; }
    S.api = url; busy(btn, true, 'กำลังตรวจสอบ…');
    call('ping').then(function () { LS.set('api', url); busy(btn, false); showLogin(); })
      .catch(function (e) { busy(btn, false); err.textContent = 'เชื่อมต่อไม่ได้: ' + e.message; err.classList.remove('hidden'); });
  });
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('#loginBtn'), err = $('#loginErr');
    err.classList.add('hidden'); busy(btn, true);
    call('login', { username: $('#lUser').value.trim(), password: $('#lPass').value }).then(function (d) {
      busy(btn, false);
      S.token = d.token; S.user = d.user; S.config = Object.assign(S.config, d.config || {});
      LS.set('token', d.token); LS.set('user', JSON.stringify(d.user)); LS.set('config', JSON.stringify(S.config));
      $('#lPass').value = '';
      showExams(); sync();
    }).catch(function (x) { busy(btn, false); err.textContent = x.message; err.classList.remove('hidden'); });
  });
  $('#resetApi').addEventListener('click', function () { LS.del('api'); S.api = ''; $('#apiUrl').value = ''; show('scrSetup'); });
  function logout(expired) {
    stopCamera();
    S.token = ''; LS.del('token');
    showLogin();
    if (expired) toast('หมดเวลาใช้งาน กรุณาเข้าสู่ระบบใหม่', true);
  }
  $('#logoutBtn').addEventListener('click', function () { logout(false); });

  /* ---------------- exams ---------------- */
  function showExams() {
    show('scrExams');
    $('#exUser').textContent = S.user ? S.user.name : '';
    updateStats();
    var list = $('#exList');
    list.innerHTML = '<div class="empty">กำลังโหลด…</div>';
    call('exams').then(function (d) {
      S.exams = d.rows; S.config = Object.assign(S.config, d.config || {}); LS.set('config', JSON.stringify(S.config));
      LS.set('exams', JSON.stringify(d.rows));
      renderExams();
    }).catch(function (e) {
      try { S.exams = JSON.parse(LS.get('exams') || '[]'); } catch (x) { S.exams = []; }
      renderExams();
      toast('ออฟไลน์: ' + e.message, true);
    });
  }
  function renderExams() {
    var list = $('#exList');
    if (!S.exams.length) { list.innerHTML = '<div class="empty">ยังไม่มีชุดข้อสอบ<br><small>สร้างที่ระบบหลังบ้าน เมนู ชุดข้อสอบ</small></div>'; return; }
    list.innerHTML = S.exams.map(function (e) {
      return '<button class="item" data-id="' + esc(e.id) + '"><div class="grow"><b>' + esc(e.subject_name) + '</b><small>' + esc([e.subject_code, e.n_items + ' ข้อ', (e.classrooms || []).map(function (c) { return c.code; }).join(' ')].filter(Boolean).join(' · ')) + '</small></div>' +
        (e.key_ready ? '<span class="pill pill-ok">' + e.n_responses + ' แผ่น</span>' : '<span class="pill pill-warn">ยังไม่มีเฉลย</span>') + '</button>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.item'), function (b) { b.addEventListener('click', function () { openExam(b.dataset.id); }); });
  }
  $('#exRefresh').addEventListener('click', showExams);
  $('#exQueue').addEventListener('click', showQueue);

  function openExam(id) {
    var cached = null;
    try { cached = JSON.parse(LS.get('roster_' + id) || 'null'); } catch (e) { cached = null; }
    toast('กำลังโหลดรายชื่อ…');
    call('roster', { exam_id: id }).then(function (d) {
      LS.set('roster_' + id, JSON.stringify(d));
      startScan(d);
    }).catch(function (e) {
      if (cached) { toast('ออฟไลน์ — ใช้รายชื่อที่เก็บไว้', true); startScan(cached); }
      else toast(e.message, true);
    });
  }

  /* ---------------- scoring (เหมือน score_ ใน Code.gs) ---------------- */
  function score(ex, answers) {
    var n = ex.n_items, pts = Number(ex.points) || 1, canc = {}, give = ex.cancel_mode !== 'drop', sc = 0, mx = 0, marks = [];
    (ex.cancelled || []).forEach(function (q) { canc[q] = 1; });
    for (var i = 0; i < n; i++) {
      if (canc[i + 1]) { marks.push('c'); if (give) { sc += pts; mx += pts; } continue; }
      mx += pts;
      var a = answers.charAt(i), k = String(ex.key[i] || ''), ok = a >= '1' && a <= '4' && k.indexOf(a) > -1;
      marks.push(ok ? 1 : 0); if (ok) sc += pts;
    }
    return { score: Math.round(sc * 100) / 100, max: Math.round(mx * 100) / 100, marks: marks };
  }

  /* ---------------- camera + detection loop ---------------- */
  var cam = { stream: null, track: null, raf: 0, last: 0, hist: [], paused: false, needClear: false, lostAt: 0, torch: false };
  var video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
  var small = $('#small'), sctx = small.getContext('2d', { willReadFrequently: true });
  var work = $('#work'), wctx = work.getContext('2d', { willReadFrequently: true });

  function startScan(d) {
    S.roster = d; S.exam = d.exam; S.session = 0;
    S.byCode = {}; d.students.forEach(function (s) { S.byCode[normCode(s.code)] = s; });
    S.scannedIds = {}; (d.scanned || []).forEach(function (r) { if (r.student_id) S.scannedIds[r.student_id] = 1; });
    S.config = Object.assign(S.config, d.config || {});
    $('#scTitle').textContent = S.exam.subject_name;
    $('#scSub').textContent = S.exam.n_items + ' ข้อ · ' + d.students.length + ' คน' + (S.exam.key_ready ? '' : ' · ยังไม่มีเฉลย');
    $('#scCount').textContent = '0';
    $('#result').classList.add('hidden');
    show('scrScan');
    updateStats();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setHint('เบราว์เซอร์นี้เปิดกล้องไม่ได้ (ต้องเปิดผ่าน https)', false); return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } } })
      .then(function (st) {
        cam.stream = st; cam.track = st.getVideoTracks()[0];
        video.srcObject = st;
        var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
        $('#scTorch').classList.toggle('hidden', !caps.torch);
        return video.play();
      })
      .then(function () { cam.paused = false; cam.hist = []; cam.needClear = false; loop(); })
      .catch(function (e) { setHint('เปิดกล้องไม่ได้: ' + (e.message || e.name), false); });
  }
  function stopCamera() {
    cancelAnimationFrame(cam.raf); cam.raf = 0;
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    cam.stream = null; cam.track = null;
  }
  $('#scBack').addEventListener('click', function () { stopCamera(); showExams(); });
  $('#scTorch').addEventListener('click', function () {
    if (!cam.track) return;
    cam.torch = !cam.torch;
    cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }).catch(function () { /* ignore */ });
    this.classList.toggle('on', cam.torch);
  });
  $('#scShutter').addEventListener('click', function () { if (!cam.paused) capture(null, true); });

  function setHint(t, good) { var h = $('#scHint'); h.textContent = t; h.classList.toggle('good', !!good); }

  /** แปลงพิกัดบนภาพวิดีโอ → พิกัดบนหน้าจอ (object-fit: contain) */
  function toScreen(p, vw, vh) {
    var W = overlay.clientWidth, H = overlay.clientHeight, k = Math.min(W / vw, H / vh);
    return { x: (W - vw * k) / 2 + p.x * k, y: (H - vh * k) / 2 + p.y * k };
  }
  function drawCorners(q, vw, vh, good) {
    var W = overlay.clientWidth, H = overlay.clientHeight, dpr = window.devicePixelRatio || 1;
    if (overlay.width !== W * dpr) { overlay.width = W * dpr; overlay.height = H * dpr; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);
    if (!q) return;
    var pts = q.map(function (p) { return toScreen(p, vw, vh); });
    octx.lineWidth = 3; octx.strokeStyle = good ? '#3ddc84' : '#ffd23f'; octx.fillStyle = good ? 'rgba(61,220,132,.16)' : 'rgba(255,210,63,.12)';
    octx.beginPath(); pts.forEach(function (p, i) { if (i) octx.lineTo(p.x, p.y); else octx.moveTo(p.x, p.y); }); octx.closePath(); octx.fill(); octx.stroke();
    pts.forEach(function (p) { octx.beginPath(); octx.arc(p.x, p.y, 9, 0, 7); octx.fillStyle = good ? '#3ddc84' : '#ffd23f'; octx.fill(); });
  }

  function loop() {
    cam.raf = requestAnimationFrame(loop);
    var now = performance.now();
    if (cam.paused || now - cam.last < 110 || video.readyState < 2) return;
    cam.last = now;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    var sw = 480, sh = Math.round(vh * sw / vw);
    if (small.width !== sw) { small.width = sw; small.height = sh; }
    sctx.drawImage(video, 0, 0, sw, sh);
    var g = OMR.fromImageData(sctx.getImageData(0, 0, sw, sh));
    var q = OMR.detect(g, sw);
    var k = vw / sw;
    var qv = q ? q.map(function (p) { return { x: p.x * k, y: p.y * k, s: p.s * k }; }) : null;
    if (!qv) {
      cam.hist = [];
      if (cam.needClear) { if (!cam.lostAt) cam.lostAt = now; if (now - cam.lostAt > 400) { cam.needClear = false; cam.lostAt = 0; } }
      drawCorners(null, vw, vh); setHint(cam.needClear ? 'เปลี่ยนแผ่นถัดไป' : 'วางกระดาษให้เห็นสี่เหลี่ยมดำครบ 4 มุม', false);
      return;
    }
    cam.lostAt = 0;
    if (cam.needClear) {
      // แผ่นเดิมยังอยู่ — รอจนกว่าจะเปลี่ยนแผ่น (มุมหายหรือขยับมาก)
      if (cam.lastCorners && moved(cam.lastCorners, qv, vw) > 0.12) cam.needClear = false;
      else { drawCorners(qv, vw, vh, false); setHint('เปลี่ยนแผ่นถัดไป', false); return; }
    }
    cam.hist.push(qv); if (cam.hist.length > 3) cam.hist.shift();
    var stable = cam.hist.length === 3 && moved(cam.hist[0], cam.hist[2], vw) < 0.02;
    drawCorners(qv, vw, vh, stable);
    setHint(stable ? 'กำลังอ่าน…' : 'ถือนิ่ง ๆ', stable);
    if (stable) capture(qv, false);
  }
  function moved(a, b, w) { var m = 0; for (var i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y)); return m / w; }

  /* ---------------- capture + read ---------------- */
  function capture(corners, manual) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    cam.paused = true;
    work.width = vw; work.height = vh;
    wctx.drawImage(video, 0, 0, vw, vh);
    var fl = $('#flash'); fl.classList.add('go'); setTimeout(function () { fl.classList.remove('go'); }, 60);
    if (navigator.vibrate) navigator.vibrate(40);
    setTimeout(function () {
      var g = OMR.fromImageData(wctx.getImageData(0, 0, vw, vh));
      var r = OMR.scan(g, { n: S.exam.n_items, groups: S.config.groups, min: S.config.omr_min, margin: S.config.omr_margin, corners: corners });
      if (!r.ok) {
        toast(r.message, true);
        cam.hist = []; cam.paused = false;
        return;
      }
      cam.lastCorners = corners || r.corners;
      r.image = makeImage(g, r.H);
      showResult(r);
    }, 30);
  }
  /** ภาพดัดตรงขนาดเล็ก (JPEG) ไว้ให้ครูตรวจทานในระบบหลังบ้าน */
  function makeImage(g, H) {
    try {
      var rg = OMR.rectify(g, H, 3.6), c = document.createElement('canvas');
      c.width = rg.w; c.height = rg.h;
      var ctx = c.getContext('2d'), img = ctx.createImageData(rg.w, rg.h);
      for (var i = 0, j = 0; i < rg.d.length; i++, j += 4) { img.data[j] = img.data[j + 1] = img.data[j + 2] = rg.d[i]; img.data[j + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.6);
    } catch (e) { return ''; }
  }

  var autoT = null;
  function showResult(r) {
    var ex = S.exam, st = S.byCode[normCode(r.code)] || null;
    var flags = [];
    if (r.n_mismatch) flags.push(['bad', 'แผ่นนี้เป็นแบบ ' + r.n + ' ข้อ แต่ชุดข้อสอบมี ' + ex.n_items + ' ข้อ']);
    if (!st) flags.push(['bad', r.code.indexOf('?') > -1 || r.code.indexOf('*') > -1 ? 'ระบายเลขประจำตัวไม่ครบ/ซ้อน' : 'ไม่พบเลขประจำตัว ' + r.code + ' ในรายชื่อ']);
    if (st && r.seat && r.seat !== st.seat) flags.push(['warn', 'เลขที่บนกระดาษ ' + r.seat + ' ไม่ตรงกับรายชื่อ (' + st.seat + ')']);
    if (st && S.scannedIds[st.id]) flags.push(['warn', 'คนนี้สแกนไปแล้ว']);
    var multi = r.flags.filter(function (f) { return f.indexOf('multi:') === 0; }).map(function (f) { return f.slice(6); });
    var blank = r.flags.filter(function (f) { return f.indexOf('blank:') === 0; }).map(function (f) { return f.slice(6); });
    var low = r.flags.filter(function (f) { return f.indexOf('low_conf:') === 0; }).map(function (f) { return f.slice(9); });
    if (multi.length) flags.push(['warn', 'ตอบซ้อน ข้อ ' + multi.join(', ')]);
    if (low.length) flags.push(['warn', 'อ่านไม่ชัด ข้อ ' + low.join(', ')]);
    if (blank.length) flags.push(['mute', 'ไม่ตอบ ' + blank.length + ' ข้อ']);
    var needReview = r.review || !st || flags.some(function (f) { return f[0] !== 'mute'; });
    var sc = ex.key_ready ? score(ex, r.answers) : null;
    var marks = sc ? sc.marks : [];
    var grid = '';
    for (var i = 0; i < ex.n_items; i++) {
      var a = r.answers.charAt(i), cls = a === '9' ? 'm' : marks[i] === 'c' ? 'c' : marks[i] === 1 ? 'y' : sc ? 'n' : '';
      grid += '<span class="' + cls + '">' + (i + 1) + '<b>' + (a >= '1' && a <= '4' ? CH[a - 1] : a === '9' ? '✱' : '–') + '</b></span>';
    }
    var el = $('#result');
    el.innerHTML =
      '<div class="r-head"><div class="grow"><div class="r-name">' + (st ? esc(st.name) : 'ไม่ทราบชื่อ') + '</div>' +
      '<div class="r-meta">รหัส ' + esc(r.code) + (st ? ' · เลขที่ ' + esc(st.seat) + ' · ห้อง ' + esc(st.room_code) : r.seat ? ' · เลขที่ ' + esc(r.seat) : '') + '</div></div>' +
      '<div class="r-score">' + (sc ? '<b>' + sc.score + '</b><small>จาก ' + sc.max + '</small>' : '<small>ยังไม่มีเฉลย</small>') + '</div></div>' +
      (flags.length ? '<div class="r-flags">' + flags.map(function (f) { return '<span class="pill pill-' + (f[0] === 'bad' ? 'bad' : f[0] === 'warn' ? 'warn' : 'mute') + '">' + esc(f[1]) + '</span>'; }).join('') + '</div>' : '') +
      (!st ? '<div class="r-code"><span>แก้เลขประจำตัว</span><input id="rCode" inputmode="numeric" maxlength="5" value="' + esc(r.code.replace(/\D/g, '')) + '"><span id="rCodeName" style="color:var(--ink2);font-size:.9rem"></span></div>' : '') +
      '<div class="r-grid">' + grid + '</div>' +
      (needReview ? '<div style="font-size:.85rem;color:var(--ink2);margin-top:.6rem">แผ่นนี้จะเข้า <b>คิวตรวจทาน</b> ในระบบหลังบ้าน</div>' : '') +
      '<div class="r-actions"><button class="btn" id="rRetry">สแกนใหม่</button><button class="btn btn-primary" id="rSave">บันทึก</button></div>' +
      (!needReview ? '<div class="countdown"><i id="rBar"></i></div>' : '');
    el.classList.remove('hidden');
    var codeIn = $('#rCode');
    if (codeIn) codeIn.addEventListener('input', function () {
      clearAuto();
      var s2 = S.byCode[normCode(codeIn.value)];
      $('#rCodeName').textContent = s2 ? '✓ ' + s2.name + ' (' + s2.seat + ')' : '';
    });
    $('#rRetry').addEventListener('click', function () { clearAuto(); el.classList.add('hidden'); cam.hist = []; cam.needClear = false; cam.paused = false; });
    $('#rSave').addEventListener('click', function () { clearAuto(); save(r, st, needReview); });
    el.addEventListener('pointerdown', clearAuto, { once: true });
    if (!needReview) {
      var bar = $('#rBar'), t0 = performance.now(), dur = 1600;
      var tick = function () {
        var p = (performance.now() - t0) / dur;
        if (!autoT) return;
        bar.style.transform = 'scaleX(' + Math.max(0, 1 - p) + ')';
        if (p >= 1) { autoT = null; save(r, st, false); } else autoT = requestAnimationFrame(tick);
      };
      autoT = requestAnimationFrame(tick);
    }
  }
  function clearAuto() { if (autoT) { cancelAnimationFrame(autoT); autoT = null; var b = $('#rBar'); if (b) b.parentNode.remove(); } }

  function save(r, st, review) {
    var codeIn = $('#rCode'), code = r.code;
    if (codeIn && codeIn.value.trim()) { code = ('00000' + codeIn.value.replace(/\D/g, '')).slice(-5); st = S.byCode[normCode(code)] || null; }
    var item = {
      request_id: uuid(), exam_id: S.exam.id, student_code: code, seat: r.seat, answers: r.answers,
      confidence: r.confidence, flags: r.flags.filter(function (f) { return f.indexOf('blank:') !== 0; }).concat(r.n_mismatch ? ['n_mismatch'] : []),
      review: !!review && !(codeIn && st && !r.review), image: r.image, scanned_at: new Date().toISOString(),
      status: 'pending', local: { name: st ? st.name : '', seat: st ? st.seat : r.seat, exam: S.exam.subject_name, score: S.exam.key_ready ? score(S.exam, r.answers).score : null }
    };
    DB.put(item).then(function () {
      if (st) S.scannedIds[st.id] = 1;
      S.session++; $('#scCount').textContent = S.session;
      $('#result').classList.add('hidden');
      cam.needClear = true; cam.hist = []; cam.paused = false;
      updateStats(); sync();
    }).catch(function (e) { toast('บันทึกในเครื่องไม่ได้: ' + e.message, true); });
  }

  /* ---------------- queue + sync ---------------- */
  var syncing = false;
  function sync() {
    if (syncing || !S.token || !S.api) return Promise.resolve();
    syncing = true;
    return DB.all().then(function (all) {
      var pend = all.filter(function (x) { return x.status === 'pending'; }).slice(0, 10);
      if (!pend.length) return null;
      var payload = pend.map(function (x) { var y = Object.assign({}, x); delete y.local; delete y.status; delete y.server; return y; });
      return call('submit', { items: payload }).then(function (d) {
        var byId = {}; d.results.forEach(function (r) { byId[r.request_id] = r; });
        return Promise.all(pend.map(function (x) {
          var r = byId[x.request_id];
          if (!r) return null;
          x.status = r.status === 'error' ? 'failed' : 'sent';
          x.server = r; x.image = x.status === 'sent' ? '' : x.image; // ส่งแล้วลบรูปออกจากเครื่อง
          return DB.put(x);
        })).then(function () { return pend.length === 10 ? 'more' : null; });
      });
    }).then(function (more) {
      syncing = false; updateStats();
      if (more) return sync();
    }).catch(function () { syncing = false; updateStats(); });
  }
  setInterval(sync, 8000);
  window.addEventListener('online', sync);

  function updateStats() {
    return DB.all().then(function (all) {
      var c = { pending: 0, sent: 0, review: 0, failed: 0 };
      all.forEach(function (x) {
        if (x.status === 'pending') c.pending++;
        else if (x.status === 'failed') c.failed++;
        else { c.sent++; if (x.server && x.server.status === 'review') c.review++; }
      });
      $('#scPending').textContent = c.pending;
      var html = '<div><b>' + c.pending + '</b><small>รอส่ง</small></div><div><b>' + c.sent + '</b><small>ส่งแล้ว</small></div><div><b>' + c.review + '</b><small>ต้องตรวจทาน</small></div>' + (c.failed ? '<div><b>' + c.failed + '</b><small>ผิดพลาด</small></div>' : '');
      $('#exStats').innerHTML = html; $('#qStats').innerHTML = html;
      return all;
    });
  }

  function showQueue() {
    show('scrQueue');
    updateStats().then(function (all) {
      var list = $('#qList');
      if (!all.length) { list.innerHTML = '<div class="empty">ยังไม่มีรายการ</div>'; return; }
      list.innerHTML = all.slice(0, 200).map(function (x) {
        var sv = x.server || {}, st = sv.student || {};
        var pill = x.status === 'pending' ? '<span class="pill pill-mute">รอส่ง</span>'
          : x.status === 'failed' ? '<span class="pill pill-bad">' + esc(sv.message || 'ผิดพลาด') + '</span>'
          : sv.status === 'review' ? '<span class="pill pill-warn">ตรวจทาน</span>' : '<span class="pill pill-ok">สำเร็จ</span>';
        var scoreTxt = sv.score !== undefined && sv.max ? sv.score + '/' + sv.max : x.local && x.local.score !== null ? String(x.local.score) : '';
        return '<div class="item"><div class="grow"><b>' + esc(st.name || x.local.name || ('รหัส ' + x.student_code)) + '</b><small>' + esc([x.local.exam, st.seat || x.local.seat, new Date(x.scanned_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ')) + '</small></div>' +
          '<div style="text-align:right"><div style="font-weight:700">' + esc(scoreTxt) + '</div>' + pill + '</div></div>';
      }).join('');
    });
  }
  $('#qBack').addEventListener('click', showExams);
  $('#qSync').addEventListener('click', function () { var b = this; busy(b, true, 'กำลังส่ง…'); sync().then(function () { busy(b, false); showQueue(); }); });
  $('#qClear').addEventListener('click', function () {
    DB.all().then(function (all) { return Promise.all(all.filter(function (x) { return x.status === 'sent'; }).map(function (x) { return DB.del(x.request_id); })); }).then(showQueue);
  });

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* ใช้งานได้แม้ไม่มี SW */ });
  }

  window.ScanApp = { S: S, DB: DB, sync: sync, score: score }; // สำหรับทดสอบ
  boot();
})();
