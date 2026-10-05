/* spider.js - procedural IK spider: FABRIK legs + alternating-tetrapod gait. */
(function (WS) {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

  /* ---------------------------------------------------------------------
   * FABRIK (Forward And Backward Reaching Inverse Kinematics)
   * p[0] is the fixed root, p[n-1] the end effector (foot).
   *  1. If the target is out of reach, lay the chain straight toward it.
   *  2. Otherwise iterate: BACKWARD pass pins the tip on the target and walks
   *     toward the root keeping each bone length; FORWARD pass re-pins the
   *     root and walks to the tip. A few iterations converge for 3 bones.
   * Joints are kept between frames (temporal coherence keeps knees stable).
   * ------------------------------------------------------------------- */
  function fabrik(p, lens, target, iters, tol) {
    const n = p.length, rx = p[0].x, ry = p[0].y;
    let total = 0; for (let i = 0; i < lens.length; i++) total += lens[i];
    const dx = target.x - rx, dy = target.y - ry, dist = Math.hypot(dx, dy);
    if (dist >= total - 1e-3) {
      const ux = dx / (dist || 1), uy = dy / (dist || 1);
      let acc = 0;
      for (let i = 1; i < n; i++) { acc += lens[i - 1]; p[i].x = rx + ux * acc; p[i].y = ry + uy * acc; }
      return;
    }
    for (let it = 0; it < iters; it++) {
      p[n - 1].x = target.x; p[n - 1].y = target.y;
      for (let i = n - 2; i >= 0; i--) {
        const a = p[i], b = p[i + 1];
        const vx = a.x - b.x, vy = a.y - b.y, k = lens[i] / (Math.hypot(vx, vy) || 1e-6);
        a.x = b.x + vx * k; a.y = b.y + vy * k;
      }
      p[0].x = rx; p[0].y = ry;
      for (let i = 1; i < n; i++) {
        const a = p[i - 1], b = p[i];
        const vx = b.x - a.x, vy = b.y - a.y, k = lens[i - 1] / (Math.hypot(vx, vy) || 1e-6);
        b.x = a.x + vx * k; b.y = a.y + vy * k;
      }
      if (Math.hypot(p[n - 1].x - target.x, p[n - 1].y - target.y) < tol) break;
    }
  }

  // Leg layout. side +1 = right of heading. Alternating tetrapod: group 0 and group 1
  // never step together (R1,R3,L2,L4 vs R2,R4,L1,L3), so at least 4 feet are planted.
  const LEG_DEFS = [
    { side: 1, ang: 36, grp: 0 }, { side: 1, ang: 72, grp: 1 }, { side: 1, ang: 108, grp: 0 }, { side: 1, ang: 144, grp: 1 },
    { side: -1, ang: 36, grp: 1 }, { side: -1, ang: 72, grp: 0 }, { side: -1, ang: 108, grp: 1 }, { side: -1, ang: 144, grp: 0 }
  ];
  const EMERGE_ORDER = [0.0, 0.14, 0.26, 0.38, 0.5, 0.58, 0.68, 0.78]; // grip start per leg (R1,R2,R3,R4,L1..)
  const EMERGE_LEG_ORDER = [0, 4, 1, 5, 2, 6, 3, 7];

  function glowSprite(color, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.18, color); gr.addColorStop(0.45, color.replace(/[\d.]+\)$/, '0.25)'));
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    return c;
  }

  class Spider {
    constructor(opts = {}) {
      this.S = opts.scale || 0.75;
      const S = this.S;
      this.lens = [30 * S, 42 * S, 38 * S];
      this.reach = this.lens[0] + this.lens[1] + this.lens[2];
      this.pos = { x: opts.x || 0, y: opts.y || 0 };
      this.vel = { x: 0, y: 0 };
      this.target = { x: this.pos.x, y: this.pos.y };
      this.heading = opts.heading || 0;
      this.headingOverride = null;
      this.baseSpeed = 340;      // px/s, scaled by speedMul
      this.speedMul = 1;
      this.behaviorOn = false;   // random skitter/pause when true
      this.beh = { mult: 1, t: 1 };
      this.twitch = 0;
      this.surfaces = [];        // DOM rects (doc coords) that feet snap to
      this.alpha = 1;
      this.time = 0;
      this.emerge = null;
      this.onGrip = null; this.onLand = null;
      // Colour palette (r,g,b strings). Defaults give the neon cyan/magenta mother; children pass their own.
      this.pal = Object.assign({ main: '0,190,255', light: '110,250,255', stroke: '70,245,255', accent: '255,60,220' }, opts.palette);
      this.sprites = { cyan: glowSprite(`rgba(${this.pal.light},1)`, 64), magenta: glowSprite(`rgba(${this.pal.accent},1)`, 64), white: glowSprite('rgba(235,255,255,1)', 64) };
      this.baseSpeedScale = opts.speedScale || 1;
      this.legs = LEG_DEFS.map((d, i) => {
        const idx = i % 4;
        const leg = {
          side: d.side, ang: d.ang * Math.PI / 180, grp: d.grp, idx,
          rootLocal: { x: (9 - idx * 4.5) * S, y: d.side * 5 * S },
          restR: this.reach * [0.84, 0.8, 0.8, 0.82][idx],
          root: { x: 0, y: 0 }, foot: { x: 0, y: 0 },
          stepping: false, t: 0, dur: 0.15, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, lift: 0,
          joints: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
          hidden: false, pinned: false, gripT: 0, gripFired: false, grip: { x: 0, y: 0 }, started: false
        };
        return leg;
      });
      this._roots();
      for (const l of this.legs) { this._rest(l, l.foot); this._seedJoints(l); }
    }

    /* ---- geometry helpers ---- */
    _roots() {
      const c = Math.cos(this.heading), s = Math.sin(this.heading);
      for (const l of this.legs) {
        l.root.x = this.pos.x + c * l.rootLocal.x - s * l.rootLocal.y;
        l.root.y = this.pos.y + s * l.rootLocal.x + c * l.rootLocal.y;
        l.joints[0].x = l.root.x; l.joints[0].y = l.root.y;
      }
    }
    _rest(l, out, lead = 0) {
      const a = this.heading + l.side * l.ang;
      out.x = this.pos.x + Math.cos(a) * l.restR + this.vel.x * lead;
      out.y = this.pos.y + Math.sin(a) * l.restR + this.vel.y * lead;
      return out;
    }
    _seedJoints(l) {
      const a = this.heading + l.side * l.ang;
      for (let i = 1; i < 4; i++) {
        const f = i / 3;
        l.joints[i].x = lerp(l.root.x, l.foot.x, f) + Math.cos(a) * 4 * Math.sin(f * Math.PI);
        l.joints[i].y = lerp(l.root.y, l.foot.y, f) + Math.sin(a) * 4 * Math.sin(f * Math.PI);
      }
    }
    mouth() {
      const d = 19 * this.S;
      return { x: this.pos.x + Math.cos(this.heading) * d, y: this.pos.y + Math.sin(this.heading) * d };
    }
    rear() {
      const d = 30 * this.S;
      return { x: this.pos.x - Math.cos(this.heading) * d, y: this.pos.y - Math.sin(this.heading) * d };
    }
    teleport(x, y) {
      const dx = x - this.pos.x, dy = y - this.pos.y;
      this.pos.x = x; this.pos.y = y; this.target.x = x; this.target.y = y;
      for (const l of this.legs) {
        l.foot.x += dx; l.foot.y += dy; l.from.x += dx; l.from.y += dy; l.to.x += dx; l.to.y += dy;
        for (const j of l.joints) { j.x += dx; j.y += dy; }
      }
    }

    /* Snap a candidate foot point onto the nearest DOM rect (so legs land on text/links). */
    _snap(x, y) {
      const R = 38 * this.S + 10;
      let best = null, bd = R;
      for (const r of this.surfaces) {
        if (x < r.x - R || x > r.x + r.w + R || y < r.y - R || y > r.y + r.h + R) continue;
        let px = clamp(x, r.x + 2, r.x + r.w - 2), py = clamp(y, r.y + 2, r.y + r.h - 2);
        if (r.kind !== 'img' && r.h > 22) { // land on a text-line centre
          const lh = 20, line = clamp(Math.floor((py - r.y) / lh), 0, Math.max(0, Math.floor(r.h / lh) - 1));
          py = Math.min(r.y + r.h - 3, r.y + (line + 0.5) * lh);
        }
        const d = Math.hypot(px - x, py - y);
        if (d < bd) { bd = d; best = { x: px, y: py }; }
      }
      return best;
    }

    /* ---- per-frame update ---- */
    update(dt) {
      this.time += dt;
      const spdNorm = Math.hypot(this.vel.x, this.vel.y) / (200 * this.S + 1);
      if (this.emerge) this._updateEmerge(dt); else this._move(dt);
      this._roots();
      this._gait(dt, spdNorm);
      this._ik();
      this.twitch = Math.max(0, this.twitch - dt * 4);
    }

    /* Body: spring-damper toward target, speed capped by burst/pause behaviour. */
    _move(dt) {
      this.beh.t -= dt;
      if (this.beh.t <= 0) this._nextBehavior();
      const k = 14, c = 2 * Math.sqrt(k) * 0.92;
      const dx = this.target.x - this.pos.x, dy = this.target.y - this.pos.y;
      this.vel.x += (dx * k - this.vel.x * c) * dt;
      this.vel.y += (dy * k - this.vel.y * c) * dt;
      const maxSp = this.baseSpeed * this.baseSpeedScale * this.speedMul * this.beh.mult;
      const sp = Math.hypot(this.vel.x, this.vel.y);
      if (sp > maxSp) { this.vel.x *= maxSp / sp; this.vel.y *= maxSp / sp; }
      if (this.beh.mult === 0) { const f = Math.exp(-dt * 12); this.vel.x *= f; this.vel.y *= f; }
      this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt;
      let want = this.heading;
      if (this.headingOverride !== null) want = this.headingOverride;
      else if (sp > 28) want = Math.atan2(this.vel.y, this.vel.x);
      this.heading += angDiff(this.heading, want) * Math.min(1, dt * (this.beh.mult === 0 ? 14 : 7));
    }
    _nextBehavior() {
      if (!this.behaviorOn) { this.beh = { mult: 1, t: 0.5 }; return; }
      const r = Math.random();
      if (r < 0.22) this.beh = { mult: 1.9, t: 0.3 + Math.random() * 0.4 };           // skitter burst
      else if (r < 0.38) { this.beh = { mult: 0, t: 0.12 + Math.random() * 0.25 }; this.twitch = 1; this.heading += (Math.random() - 0.5) * 0.5; }
      else this.beh = { mult: 1, t: 0.6 + Math.random() * 1.0 };
    }

    /* Emergence: the body is dragged out of the hole while legs are IK-pinned to the rim in sequence. */
    _updateEmerge(dt) {
      const e = this.emerge, p = clamp(e.p, 0, 1);
      const dist = easeInOut(p) * e.r * 1.2;
      const nx = e.cx + Math.cos(e.dir) * dist, ny = e.cy + Math.sin(e.dir) * dist;
      this.vel.x = (nx - this.pos.x) / Math.max(dt, 1e-3); this.vel.y = (ny - this.pos.y) / Math.max(dt, 1e-3);
      this.pos.x = nx; this.pos.y = ny; this.target.x = nx; this.target.y = ny;
      this.heading = e.dir + Math.sin(p * 9) * 0.06;
      this.alpha = clamp(0.15 + p * 3, 0, 1);
      this._roots();
      EMERGE_LEG_ORDER.forEach((li, order) => {
        const l = this.legs[li];
        if (p < EMERGE_ORDER[order]) { l.hidden = true; l.foot.x = e.cx; l.foot.y = e.cy; return; }
        if (!l.started) {
          l.started = true; l.hidden = false; l.pinned = true; l.gripT = 0; l.gripFired = false;
          const a = e.dir + l.side * l.ang;
          l.grip.x = e.cx + Math.cos(a) * e.r * 0.97; l.grip.y = e.cy + Math.sin(a) * e.r * 0.97;
          l.from.x = e.cx; l.from.y = e.cy;
          for (const j of l.joints) { j.x = e.cx; j.y = e.cy; }
        }
        if (l.pinned) {
          l.gripT += dt / 0.5;
          const t = easeOut(Math.min(1, l.gripT));
          l.foot.x = lerp(l.from.x, l.grip.x, t); l.foot.y = lerp(l.from.y, l.grip.y, t);
          l.lift = 1 - Math.min(1, l.gripT);
          if (l.gripT >= 1 && !l.gripFired) { l.gripFired = true; if (this.onGrip) this.onGrip(l.grip.x, l.grip.y); }
          // Release once the body has moved far enough that the leg is fully stretched.
          if (l.gripT >= 1 && Math.hypot(l.root.x - l.foot.x, l.root.y - l.foot.y) > this.reach * 0.95) l.pinned = false;
        }
      });
      if (p >= 1) { this.emerge = null; this.legs.forEach((l) => { l.pinned = false; l.hidden = false; l.started = true; }); }
    }

    /* Gait: a foot swings only when it is farther than a threshold from its ideal rest point
     * AND no leg of the opposite tetrapod group is mid-swing. Over-stretched legs override. */
    _gait(dt, spdNorm) {
      const tmp = { x: 0, y: 0 };
      const thresh = this.reach * (0.2 + Math.min(spdNorm, 1.5) * 0.07);
      const swinging = [0, 0];
      for (const l of this.legs) if (l.stepping) swinging[l.grp]++;
      for (const l of this.legs) {
        if (l.hidden || l.pinned) continue;
        if (l.stepping) {
          l.t += dt / l.dur;
          // re-aim the landing spot slightly so a moving body doesn't outrun the swing
          this._rest(l, tmp, 0.12); const sn = this._snap(tmp.x, tmp.y) || tmp;
          l.to.x = lerp(l.to.x, sn.x, 0.15); l.to.y = lerp(l.to.y, sn.y, 0.15);
          const k = easeInOut(Math.min(1, l.t));
          l.foot.x = lerp(l.from.x, l.to.x, k); l.foot.y = lerp(l.from.y, l.to.y, k);
          l.lift = Math.sin(Math.PI * Math.min(1, l.t));          // arc: lifted midpoint
          if (l.t >= 1) {
            l.stepping = false; l.lift = 0; swinging[l.grp]--;
            if (this.onLand) this.onLand(l.foot.x, l.foot.y, !!this._snap(l.foot.x, l.foot.y));
          }
          continue;
        }
        l.lift = Math.max(0, l.lift - dt * 6);
        this._rest(l, tmp, 0.1);
        const d = Math.hypot(l.foot.x - tmp.x, l.foot.y - tmp.y);
        const over = Math.hypot(l.foot.x - l.root.x, l.foot.y - l.root.y) > this.reach * 0.97;
        const otherBusy = swinging[1 - l.grp] > 0;
        if ((d > thresh && !otherBusy) || over) {
          const sn = this._snap(tmp.x, tmp.y) || { x: tmp.x, y: tmp.y };
          l.stepping = true; l.t = 0; swinging[l.grp]++;
          l.from.x = l.foot.x; l.from.y = l.foot.y; l.to.x = sn.x; l.to.y = sn.y;
          l.dur = clamp(0.17 / (1 + spdNorm * 0.7), 0.075, 0.2);
        }
      }
    }

    _ik() {
      const bx = -Math.sin(this.heading), by = Math.cos(this.heading); // body "right" vector
      for (const l of this.legs) {
        if (l.hidden) continue;
        const j = l.joints, rx = l.root.x, ry = l.root.y;
        const dx = l.foot.x - rx, dy = l.foot.y - ry;
        // Pole bias: nudge knees outward so they bow away from the body (and more when lifted).
        const bend = this.reach * (0.26 + l.lift * 0.14);
        const ox = bx * l.side * bend, oy = by * l.side * bend;
        j[1].x = lerp(j[1].x, rx + dx * 0.33 + ox, 0.35); j[1].y = lerp(j[1].y, ry + dy * 0.33 + oy, 0.35);
        j[2].x = lerp(j[2].x, rx + dx * 0.72 + ox * 0.55, 0.3); j[2].y = lerp(j[2].y, ry + dy * 0.72 + oy * 0.55, 0.3);
        fabrik(j, this.lens, l.foot, 6, 0.3);
      }
    }

    /* ---- rendering (additive neon skeleton) ---- */
    draw(ctx, t) {
      const S = this.S, sp = this.sprites, pal = this.pal;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'lighter';
      const widths = [2.8 * S + 0.6, 2.0 * S + 0.5, 1.3 * S + 0.4];
      for (const l of this.legs) {
        if (l.hidden) continue;
        const j = l.joints, lw = 1 + l.lift * 0.35;
        ctx.strokeStyle = `rgba(${pal.main},0.11)`; ctx.lineWidth = 11 * S * lw;
        ctx.beginPath(); ctx.moveTo(j[0].x, j[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(j[i].x, j[i].y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${pal.light},0.95)`;
        for (let i = 0; i < 3; i++) {
          ctx.lineWidth = widths[i] * lw;
          ctx.beginPath(); ctx.moveTo(j[i].x, j[i].y); ctx.lineTo(j[i + 1].x, j[i + 1].y); ctx.stroke();
        }
        const ks = (16 + l.lift * 8) * S + 4;
        ctx.drawImage(sp.cyan, j[1].x - ks / 2, j[1].y - ks / 2, ks, ks);
        ctx.drawImage(sp.white, j[2].x - ks * 0.4, j[2].y - ks * 0.4, ks * 0.8, ks * 0.8);
        const fs = 11 * S + 3;
        ctx.drawImage(sp.magenta, j[3].x - fs / 2, j[3].y - fs / 2, fs, fs);
      }
      // Body, drawn in local space. Tilt/bob derive from how many feet are airborne.
      let lift = 0, tilt = 0;
      for (const l of this.legs) { lift += l.lift; tilt += l.lift * l.side; }
      const bob = 1 + (lift / 8) * 0.07 + Math.sin(t * 2.2) * 0.022; // breathing + gait bob
      const jit = this.twitch * 1.2;
      ctx.translate(this.pos.x + (Math.random() - 0.5) * jit, this.pos.y + (Math.random() - 0.5) * jit);
      ctx.rotate(this.heading);
      ctx.scale(S * bob, S * bob);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(2,14,22,0.94)';
      ctx.strokeStyle = `rgba(${pal.stroke},0.95)`; ctx.lineWidth = 1.6;
      ctx.save(); ctx.translate(-17, 0); ctx.rotate(tilt * 0.035);
      ctx.beginPath(); ctx.ellipse(0, 0, 18, 13.5, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(${pal.accent},0.55)`; ctx.lineWidth = 1.1;
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(10 - i * 0, 0); ctx.moveTo(i * 5.5 + 4, -6 + Math.abs(i)); ctx.lineTo(i * 5.5 - 1, 0); ctx.lineTo(i * 5.5 + 4, 6 - Math.abs(i)); ctx.stroke(); }
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(${pal.stroke},0.95)`; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(6, 0, 11.5, 9, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.2;       // chelicerae
      ctx.beginPath(); ctx.moveTo(17, -1.6); ctx.lineTo(21, -2.4); ctx.moveTo(17, 1.6); ctx.lineTo(21, 2.4); ctx.stroke();
      const eyes = [[13, 2.5, 4.2], [13, -2.5, 4.2], [11, 5.4, 3.2], [11, -5.4, 3.2], [8.2, 3.4, 2.6], [8.2, -3.4, 2.6], [7.5, 6.6, 2.4], [7.5, -6.6, 2.4]];
      eyes.forEach((e, i) => {
        const a = 0.65 + 0.35 * Math.sin(t * 3 + i * 1.7);
        ctx.globalAlpha = this.alpha * a;
        const s = e[2] * 3;
        ctx.drawImage(sp.magenta, e[0] - s / 2, e[1] - s / 2, s, s);
      });
      ctx.restore();
    }
  }

  WS.Spider = Spider;
  WS.util = { clamp, lerp, easeInOut, easeOut, angDiff, glowSprite };
})((window.WS = window.WS || {}));
