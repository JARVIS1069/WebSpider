/* renderer.js - UI, webview bridge, timeline + scraping state machine, render loop. */
(function () {
  'use strict';
  const { Spider, Hole, WebLayer, fx, util } = WS;
  const { clamp, lerp } = util;
  const api = window.webSpider;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), canvas = $('fx'), ctx = canvas.getContext('2d');
  const urlInput = $('url'), summonBtn = $('summon'), statusEl = $('status');

  const view = { w: 800, h: 600 };
  let dpr = 1, wv = null, info = null;
  const S = { mode: 'idle', speed: 1, robots: true, polite: false, brood: 4, outDir: null, loading: false, pageY: 0, autotest: false };
  let R = null;      // current run (kept after completion so the webbed page keeps animating)
  let last = performance.now();

  /* ---------------- UI plumbing ---------------- */
  function resize() {
    dpr = window.devicePixelRatio || 1;
    view.w = stage.clientWidth; view.h = stage.clientHeight;
    canvas.width = Math.round(view.w * dpr); canvas.height = Math.round(view.h * dpr);
  }
  new ResizeObserver(resize).observe(stage);

  const setStatus = (t) => { statusEl.textContent = t || ''; };
  let toastTimer = 0, lastDir = null;
  function toast(msg, dir, sticky) {
    $('toast-msg').textContent = msg; $('toast').hidden = false;
    lastDir = dir || null; $('toast-open').hidden = !dir;
    clearTimeout(toastTimer);
    if (!sticky && !dir) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }
  $('toast-open').onclick = () => lastDir && api.openFolder(lastDir);
  $('speed').oninput = (e) => { S.speed = +e.target.value; $('speedv').textContent = S.speed.toFixed(1) + '\u00d7'; };
  $('brood').oninput = (e) => { S.brood = +e.target.value; $('broodv').textContent = S.brood; };
  $('robots').onchange = (e) => { S.robots = e.target.checked; };
  $('polite').onchange = (e) => { S.polite = e.target.checked; };
  $('folder').onclick = async () => { const d = await api.pickFolder(); if (d) { S.outDir = d; $('folder').title = d; toast('Output folder: ' + d); } };
  $('go').onclick = () => navigate(urlInput.value);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value); });
  summonBtn.onclick = toggleRun;
  api.onHotkey(toggleRun);

  function navigate(raw) {
    raw = raw.trim(); if (!raw) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
    if (S.mode !== 'idle' && S.mode !== 'done') return toast('Cancel the spider first');
    clearRun(); wv.loadURL(raw);
  }
  function clearRun() { R = null; $('hud').hidden = true; $('toast').hidden = true; setStatus(''); S.mode = 'idle'; setBtn(); }
  function setBtn() {
    const run = S.mode !== 'idle' && S.mode !== 'done';
    summonBtn.textContent = run ? 'Cancel' : 'Summon Spider';
    summonBtn.classList.toggle('running', run);
  }

  /* ---------------- webview + IPC ---------------- */
  let callId = 1; const pending = new Map();
  function call(cmd, args, timeout = 8000) {
    return new Promise((resolve) => {
      const id = callId++;
      const t = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
      pending.set(id, (r) => { clearTimeout(t); resolve(r); });
      try { wv.send('ws:cmd', { id, cmd, args }); } catch (e) { clearTimeout(t); pending.delete(id); resolve(null); }
    });
  }
  function createWebview(url) {
    wv = document.createElement('webview');
    wv.id = 'page'; wv.setAttribute('src', url);
    stage.prepend(wv);
    wv.addEventListener('ipc-message', (e) => {
      const m = e.args[0];
      if (e.channel === 'ws:res') { const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m.result); } }
      else if (e.channel === 'ws:scroll') { S.pageY = m.y; if (R) R.docH = Math.max(m.docH, 1); }
    });
    const nav = (e) => { if (e.isMainFrame !== false) urlInput.value = e.url; };
    wv.addEventListener('did-navigate', nav);
    wv.addEventListener('did-navigate-in-page', nav);
    wv.addEventListener('did-start-loading', () => { S.loading = true; });
    wv.addEventListener('did-stop-loading', () => { S.loading = false; });
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3 && e.isMainFrame) toast('Load failed: ' + e.errorDescription); });
  }
  const waitLoaded = async () => { for (let i = 0; i < 150 && S.loading; i++) await new Promise((r) => setTimeout(r, 100)); };

  /* ---------------- run lifecycle ---------------- */
  function toggleRun() {
    if (S.mode === 'idle' || S.mode === 'done') summon();
    else if (R) R.cancel = true; else S.mode = 'cancel-pending';
  }

  async function summon() {
    if (!wv) return;
    S.mode = 'preparing'; setBtn(); $('toast').hidden = true;
    await waitLoaded();
    let url = wv.getURL();
    if (S.robots && /^https?:/.test(url)) {
      setStatus('Checking robots.txt\u2026');
      const rb = await api.checkRobots(url);
      if (rb && !rb.allowed) { S.mode = 'idle'; setBtn(); setStatus(''); return toast('robots.txt disallows this page. Untick "robots.txt" to override.'); }
    }
    setStatus('Preparing page (scrolling for lazy content)\u2026');
    await call('prepare', {}, 25000);
    if (S.mode === 'cancel-pending') { S.mode = 'idle'; setBtn(); setStatus(''); return; }
    const pageInfo = await call('info', {}) || {};
    const built = await call('build', { max: 500 }, 20000);
    if (!built || !built.records || !built.records.length) { S.mode = 'idle'; setBtn(); setStatus(''); return toast('Nothing to scrape on this page.'); }
    startRun(built, pageInfo, url);
  }

  function startRun(built, pageInfo, url) {
    const S_ = 0.8;
    const spider = new Spider({ scale: S_ });
    const hx = view.w * (0.3 + Math.random() * 0.4), hy = view.h * (0.5 + Math.random() * 0.2);
    const pool = new fx.ParticlePool(700);
    const hole = new Hole(hx, hy, spider.reach * 0.82, pool);
    spider.pos.x = hx; spider.pos.y = hy; spider.teleport(hx, hy);
    const dir = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
    spider.heading = dir;
    spider.emerge = { cx: hx, cy: hy, r: hole.r, dir, p: 0 };
    spider.legs.forEach((l) => { l.hidden = true; l.foot.x = hx; l.foot.y = hy; });
    spider.onGrip = (x, y) => {
      hole.shakeBump(0.7);
      for (let i = 0; i < 8; i++) pool.emit({ x, y, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.3) * 90, g: 220, life: 0.5 + Math.random() * 0.5, size: 2 + Math.random() * 3, kind: i % 2 ? 'chunk' : 'spark', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 9, color: '34,243,255' });
    };
    spider.onLand = (x, y, snapped) => {
      if (snapped && Math.random() < 0.5) pool.emit({ x, y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 0.3, size: 2, color: '255,43,214', drag: 4 });
    };
    R = {
      url, pageInfo, T: 0, clock: 0, step: 'intro', queue: built.records, idx: 0, done: [], birthT: 0,
      docH: built.docH || pageInfo.docH || view.h, spider, hole, pool, web: new WebLayer(),
      workers: [makeWorker(spider, 0, null)],
      cancel: false, camCmd: 0, lastSent: 0, words: 0, links: 0, dim: 0, surfTimer: 0, hudTimer: 0,
      startedAt: Date.now(), partial: false, standBase: dir, fin: 0, finDur: 3.4, saving: false
    };
    S.mode = 'run'; setBtn();
    $('hud').hidden = false; updateLegend(); updateHud();
    api.log(`run started: ${R.queue.length} elements, docH=${R.docH}`);
  }

  /* ---------------- per-frame update ---------------- */
  // Each little spider gets its own palette (colour-coded so you can tell who scraped what).
  const BROOD = [
    { main: '70,255,80', light: '170,255,150', stroke: '120,255,110', accent: '255,255,120' },   // lime
    { main: '255,140,20', light: '255,210,130', stroke: '255,170,60', accent: '255,60,60' },     // amber
    { main: '170,90,255', light: '220,180,255', stroke: '190,130,255', accent: '255,120,240' },  // violet
    { main: '255,60,110', light: '255,170,190', stroke: '255,100,140', accent: '255,230,90' },   // rose
    { main: '255,225,40', light: '255,246,160', stroke: '255,232,90', accent: '60,230,255' },    // gold
    { main: '60,130,255', light: '170,205,255', stroke: '100,160,255', accent: '120,255,200' }   // azure
  ];

  function makeWorker(spider, id, pal) {
    return { id, spider, pal, step: 'pick', cur: null, st: 0, dwell: 0, walkTarget: null, absorbed: false, scan: new fx.ScanFx(), snip: new fx.Snippets(), count: 0 };
  }
  const say = (w, t) => { if (!w.id) setStatus(t); };

  /* The mother lays a hatchling every ~0.7s once she has finished emerging. Each hatchling hops out
   * from her abdomen, fades in, then joins the shared reading-order queue as an independent worker. */
  function birthChild() {
    const mom = R.spider, id = R.workers.length, pal = BROOD[(id - 1) % BROOD.length], rp = mom.rear();
    const h = mom.heading + Math.PI + (Math.random() - 0.5) * 1.6;
    const kid = new Spider({ scale: 0.36, x: rp.x, y: rp.y, heading: h, palette: pal, speedScale: 1.35 });
    kid.alpha = 0; kid.surfaces = mom.surfaces;
    kid.target.x = rp.x + Math.cos(h) * 70; kid.target.y = rp.y + Math.sin(h) * 70;
    kid.vel.x = Math.cos(h) * 160; kid.vel.y = Math.sin(h) * 160;
    const w = makeWorker(kid, id, pal); w.step = 'birth';
    R.workers.push(w);
    for (let i = 0; i < 14; i++) R.pool.emit({ x: rp.x, y: rp.y, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, life: 0.5, size: 3, color: pal.main, drag: 4 });
    updateLegend();
  }

  function update(dt) {
    const sp = R.spider;
    R.clock += dt;
    if (S.autotest && (R.dbg = (R.dbg || 0) + dt) > 2) { R.dbg = 0; api.log(`step=${R.step} idx=${R.idx}/${R.queue.length} workers=${R.workers.length} T=${R.T.toFixed(1)} pos=${sp.pos.x|0},${sp.pos.y|0} pageY=${S.pageY}`); }
    R.pool.update(dt);
    const mul = 0.6 + 0.5 * S.speed;
    for (const w of R.workers) w.spider.speedMul = mul;
    if ((R.step === 'intro' || R.step === 'scrape') && R.cancel) startFinale(true);
    if (R.step === 'intro') {
      R.T += dt; const T = R.T;
      R.hole.update(T, dt);
      if (T >= 1.5 && T < 6) sp.emerge.p = (T - 1.5) / 4.5;
      else if (T >= 6 && sp.emerge) sp.emerge.p = 1;
      if (T >= 6) sp.headingOverride = R.standBase + Math.sin((T - 6) * 1.6) * 0.9 + (Math.random() < 0.02 ? 0.3 : 0);
      R.dim = lerp(R.dim, 0.3 * clamp(T / 1.5, 0, 1), 0.1);
      if (T >= 10) { sp.headingOverride = null; sp.behaviorOn = true; R.step = 'scrape'; R.birthT = 0.4; }
    } else {
      R.hole.update(99, dt);
      if (R.step === 'scrape') {
        if (R.workers.length - 1 < S.brood && R.idx < R.queue.length - 2 && (R.birthT -= dt) <= 0) { R.birthT = 0.7; birthChild(); }
        for (const w of R.workers) workerUpdate(w, dt);
        if (R.idx >= R.queue.length && R.workers.every((w) => w.step === 'idle')) startFinale(false);
      } else if (R.step === 'finale') finaleUpdate(dt);
      R.dim = lerp(R.dim, R.step === 'finale' || R.step === 'done' ? 0.16 : 0.3, 0.02);
    }
    for (const w of R.workers) w.spider.update(dt);
    if (R.step === 'scrape') for (const w of R.workers) if (w.step !== 'birth') R.web.trail(w.spider.rear(), R.clock, w.id, w.id ? 80 : 130);
    for (const w of R.workers) {
      w.snip.update(dt, w.spider.mouth(), (x, y) => {
        for (let i = 0; i < 3; i++) R.pool.emit({ x, y, vx: (Math.random() - 0.5) * 90, vy: (Math.random() - 0.5) * 90, life: 0.3, size: 2.5, color: w.id ? w.pal.main : '57,255,122', drag: 5 });
      });
    }
    updateCamera(dt);
    R.surfTimer -= dt;
    if (R.surfTimer <= 0) { R.surfTimer = 0.12; refreshSurfaces(); }
    R.hudTimer -= dt;
    if (R.hudTimer <= 0) { R.hudTimer = 0.1; updateHud(); }
  }

  function refreshSurfaces() {
    const y0 = S.pageY - 300, y1 = S.pageY + view.h + 300, out = [];
    for (const r of R.queue) {
      const b = r.rect; if (!b || b.y > y1 || b.y + b.h < y0) continue;
      out.push({ x: b.x, y: b.y, w: b.w, h: b.h, kind: r.kind });
    }
    for (const w of R.workers) w.spider.surfaces = out;
  }

  function updateCamera(dt) {
    const scraping = R.step === 'scrape';
    const maxScroll = Math.max(0, R.docH - view.h);
    let cy = 0; for (const w of R.workers) cy += w.spider.pos.y; cy /= R.workers.length;
    const target = scraping ? clamp(cy - view.h * 0.5, 0, maxScroll) : (R.step === 'finale' || R.step === 'done' ? 0 : R.camCmd);
    R.camCmd = lerp(R.camCmd, target, 1 - Math.exp(-dt * 3.5));
    const px = Math.round(R.camCmd);
    if (px !== R.lastSent) { R.lastSent = px; try { wv.send('ws:cmd', { id: 0, cmd: 'scrollTo', args: { y: px } }); } catch (_) {} }
  }

  /* ---------------- scraping state machine (one per spider) ---------------- */
  function dwellFor(rec) {
    const n = Math.max(1, R.queue.length);
    const base = clamp((60 / S.speed / n) * 0.55, 0.18, 2.2);
    return rec.virtual || !rec.rect ? Math.min(0.3, base) : base * (1 + Math.min(rec.words, 80) / 80 * 0.6);
  }

  // Workers claim the next record from the shared queue, so the brood and the mother
  // sweep through the page together in reading order.
  function workerUpdate(w, dt) {
    const sp = w.spider;
    switch (w.step) {
      case 'birth': {
        w.st += dt; sp.alpha = clamp(w.st / 0.4, 0, 1);
        if (w.st >= 0.8) { sp.alpha = 1; sp.behaviorOn = true; w.step = 'pick'; }
        break;
      }
      case 'pick': {
        if (R.idx >= R.queue.length) { sp.behaviorOn = false; w.step = 'idle'; return; }
        const rec = R.queue[R.idx++]; w.cur = rec; w.absorbed = false;
        if (rec.virtual || !rec.rect) { sp.behaviorOn = false; w.step = 'scan'; w.st = 0; w.dwell = dwellFor(rec); w.scan.start(rec); w.scan.rec = null; say(w, 'Reading ' + (rec.kind === 'meta' ? 'metadata' : rec.kind) + '\u2026'); break; }
        w.step = 'measure'; const run = R;
        call('rect', { id: rec.id }, 3000).then((r) => {
          if (R !== run || w.step !== 'measure') return;
          if (r && r.rect) { rec.rect = r.rect; R.docH = r.docH || R.docH; }
          const b = rec.rect;
          w.walkTarget = { x: clamp(b.x + 8, 10, b.x + b.w), y: b.y + Math.min(b.h / 2, 14) };
          sp.target.x = w.walkTarget.x; sp.target.y = w.walkTarget.y; sp.behaviorOn = true;
          w.step = 'walk'; w.st = 0; say(w, 'Crawling to <' + rec.tag + '>\u2026');
        });
        break;
      }
      case 'walk': {
        w.st += dt;
        const d = Math.hypot(sp.pos.x - w.walkTarget.x, sp.pos.y - w.walkTarget.y);
        if (d < 30 || w.st > 4.5) {
          sp.behaviorOn = false; sp.beh = { mult: 1, t: 1 };
          w.step = 'scan'; w.st = 0; w.dwell = dwellFor(w.cur); w.scan.start(w.cur); say(w, 'Scraping <' + w.cur.tag + '>');
        }
        break;
      }
      case 'scan': {
        w.st += dt;
        const p = clamp(w.st / w.dwell, 0, 1), rec = w.cur, b = rec.rect;
        w.scan.setProgress(clamp(p / 0.5, 0, 1));
        if (b) { // sweep the spider across the element line by line
          const lines = clamp(Math.round(b.h / 22), 1, 5), li = Math.min(lines - 1, Math.floor(p * lines)), f = p * lines - li;
          const x0 = b.x + 10, x1 = b.x + Math.min(b.w, 900) - 10;
          sp.target.x = li % 2 ? lerp(x1, x0, f) : lerp(x0, x1, f);
          sp.target.y = b.y + (li + 0.5) / lines * b.h;
        }
        if (!w.absorbed && p >= 0.55) { w.absorbed = true; absorb(w, rec); }
        if (p >= 1) {
          w.scan.stop();
          R.web.drain(rec, R.clock); R.web.bridge(rec, sp.surfaces, view, R.clock);
          R.done.push(rec); w.count++; R.words += rec.words || 0; R.links += (rec.links || []).length;
          w.step = 'gap'; w.st = S.polite ? 0.5 + Math.random() * 0.6 : 0.04;
        }
        break;
      }
      case 'gap':
        w.st -= dt; if (w.st <= 0) w.step = 'pick';
        break;
    }
  }

  function absorb(w, rec) {
    const words = (rec.kind === 'img' ? (rec.alt || 'IMG ' + (rec.src || '').slice(-20)) : rec.text || '').split(/\s+/).filter(Boolean);
    const n = clamp(Math.ceil(words.length / 4), 1, 6), color = fx.colorFor(rec), b = rec.rect;
    for (let i = 0; i < n; i++) {
      const at = Math.floor((i / n) * words.length), txt = words.slice(at, at + 3).join(' ') || '\u2022';
      const x = b ? b.x + Math.random() * Math.min(b.w, 600) : 40 + Math.random() * 200;
      const y = b ? b.y + Math.random() * b.h : S.pageY + 40;
      w.snip.spawn(txt, x, y, color, i * 0.07);
    }
  }

  function startFinale(cancelled) {
    R.step = 'finale'; R.partial = cancelled; R.fin = 0; R.finDur = cancelled ? 1.6 : 3.4;
    const mom = R.spider;
    if (mom.emerge) { mom.emerge = null; mom.alpha = 1; mom.legs.forEach((l) => { l.hidden = false; l.pinned = false; }); }
    const cx = view.w / 2, cy = view.h / 2, kids = R.workers.length - 1;
    R.workers.forEach((w, i) => {
      const sp = w.spider;
      w.scan.stop(); w.step = 'idle'; sp.alpha = 1; sp.behaviorOn = false; sp.headingOverride = null; sp.beh = { mult: 1, t: 5 };
      // the mother takes the web centre, the brood perches on a ring around her
      w.ringAng = i ? (i - 1) / Math.max(1, kids) * Math.PI * 2 + 0.5 : -Math.PI / 2;
      const rad = i ? Math.min(view.w, view.h) * 0.2 : 0;
      const tx = cx + Math.cos(w.ringAng) * rad, ty = cy + Math.sin(w.ringAng) * rad;
      const dx = sp.pos.x - tx, dy = sp.pos.y - ty, d = Math.hypot(dx, dy);
      if (d > 800) sp.teleport(tx + (dx / d) * 600, ty + (dy / d) * 600); // skitter up a dragline
      sp.target.x = tx; sp.target.y = ty;
    });
    setStatus('Weaving the final web\u2026');
  }

  function finaleUpdate(dt) {
    R.fin += dt;
    for (const w of R.workers) w.spider.speedMul = 2.2;
    R.web.finale = clamp((R.fin - 0.4) / 1.6, 0, 1);
    R.dim = lerp(R.dim, 0.16, 0.05);
    if (R.fin > R.finDur * 0.7) for (const w of R.workers) w.spider.headingOverride = w.id ? w.ringAng : -Math.PI / 2;
    const ready = Math.abs(S.pageY) < 2 || R.fin > R.finDur + 2.5;
    if (R.fin >= R.finDur && ready && !R.saving) finalize();
  }
  /* ---------------- save ---------------- */
  function composite(pageDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.drawImage(canvas, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src = pageDataUrl;
    });
  }

  async function finalize() {
    R.saving = true; setStatus('Saving results\u2026');
    if (S.autotest) api.log('FINAL spider ' + JSON.stringify({ p: R.spider.pos, a: R.spider.alpha, h: R.spider.heading, f: R.web.finale, y: S.pageY, emerge: !!R.spider.emerge, hid: R.spider.legs.map((l) => l.hidden) }));
    await new Promise((r) => setTimeout(r, 120)); // let the final frame paint
    let shot = null;
    try { const du = await api.capture(wv.getWebContentsId()); if (du) shot = await composite(du); } catch (e) { api.log('capture failed ' + e); }
    // workers finish out of order; ids ascend in reading order, so restore it for the saved output
    const records = R.done.slice().sort((a, b) => a.id - b.id).map((r) => { const c = Object.assign({}, r); delete c.rect; return c; });
    let res = null;
    try {
      res = await api.save({
        url: R.url, title: R.pageInfo.title || '', lang: R.pageInfo.lang || '', records, scrapedAt: R.startedAt,
        partial: R.partial, outDir: S.outDir, screenshot: shot
      });
    } catch (e) { toast('Save failed: ' + e.message, null, true); }
    R.step = 'done'; S.mode = 'done'; setBtn(); setStatus('');
    R.web.finale = 1;
    if (res) toast((R.partial ? 'Scrape cancelled \u2014 partial results saved. ' : 'Scrape complete. ') + `${res.stats.words} words, ${res.stats.links} links.`, res.dir);
    updateHud(true);
    if (S.autotest) api.autotestDone(res ? { dir: res.dir, stats: res.stats } : null);
  }

  function updateLegend() {
    const dots = R.workers.map((w) => `<i style="background:rgb(${w.id ? w.pal.main : '34,243,255'})"></i>`).join('');
    $('h-legend').innerHTML = dots; $('h-s').textContent = R.workers.length;
  }

  function updateHud(final) {
    if (!R) return;
    $('h-el').textContent = R.done.length; $('h-w').textContent = R.words; $('h-l').textContent = R.links;
    const pct = final && !R.partial ? 100 : Math.round((R.idx / Math.max(1, R.queue.length)) * 100);
    $('h-p').textContent = (R.step === 'intro' ? 0 : pct) + '%';
  }

  /* ---------------- render ---------------- */
  function draw() {
    const sp = R.spider, t = R.clock, sh = R.step === 'intro' ? R.hole.shake(R.T) : { x: 0, y: 0 };
    ctx.fillStyle = `rgba(0,0,0,${R.dim})`; ctx.fillRect(0, 0, view.w, view.h);
    ctx.save();
    ctx.translate(sh.x - 0, sh.y - S.pageY);
    R.web.draw(ctx, t, { y: S.pageY }, view);
    R.hole.draw(ctx, R.step === 'intro' ? R.T : 99);
    R.pool.draw(ctx);
    for (const w of R.workers) {
      w.scan.draw(ctx, t);
      const r = w.id && w.scan.rec && w.scan.rec.rect; // tether from a hatchling to the element it is scraping, in its colour
      if (r) {
        const p = w.spider.pos, tx = clamp(p.x, r.x, r.x + r.w), ty = clamp(p.y, r.y, r.y + r.h);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(${w.pal.main},0.7)`; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -t * 30;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.restore();
      }
    }
    if (R.step !== 'intro' || R.T >= 1.5) {
      for (const w of R.workers) {
        if (w.step !== 'birth') R.web.drawDragline(ctx, w.spider.rear(), t, w.id, w.id ? w.pal.light : '215,244,255');
        w.spider.draw(ctx, t);
      }
    }
    for (const w of R.workers) w.snip.draw(ctx);
    ctx.restore();
    R.web.drawFixed(ctx, view);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    window.__f = (window.__f|0) + 1; if (S.autotest && window.__f % 120 === 1) api.log('frames ' + window.__f + ' vis=' + document.visibilityState + ' R=' + !!R);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    if (!R) return;
    try { update(dt); draw(); } catch (e) { if (!R.err) { R.err = 1; api.log('FRAME ERROR ' + e.stack); } }
  }

  /* ---------------- boot ---------------- */
  (async function boot() {
    info = await api.info();
    S.outDir = null;
    resize();
    createWebview(info.demoUrl);
    urlInput.value = info.demoUrl;
    requestAnimationFrame(frame);
    if (info.autotest) setInterval(() => api.log('tick vis=' + document.visibilityState + ' f=' + window.__f), 3000);
    if (info.autotest) { S.autotest = true; S.speed = 20; S.brood = 4; setTimeout(() => { S.robots = false; summon(); }, 2500); }
  })();
})();
