/* web.js - silk threads, cobweb corner decals, drained overlays, final orb web.
 * Heavy shapes (corner fans, orb web) are rendered ONCE into cached offscreen
 * canvases and blitted; only the thin sagging threads are drawn live. */
(function (WS) {
  'use strict';
  const { clamp, lerp, easeOut, glowSprite } = WS.util;
  const TAU = Math.PI * 2;
  const MAX_THREADS = 450;

  const cache = new Map();
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // Quarter-fan cobweb anchored at (0,0), extending +x/+y.
  function cornerSprite(size) {
    size = Math.max(24, Math.round(size / 16) * 16);
    const key = 'c' + size; if (cache.has(key)) return cache.get(key);
    const c = makeCanvas(size, size), g = c.getContext('2d');
    const spokes = 6, ang = [];
    for (let i = 0; i <= spokes; i++) ang.push((i / spokes) * Math.PI / 2 + (i && i < spokes ? (Math.random() - 0.5) * 0.12 : 0));
    const len = ang.map(() => size * (0.88 + Math.random() * 0.12));
    for (const pass of [[3, 'rgba(160,230,255,0.07)'], [0.9, 'rgba(225,246,255,0.5)']]) {
      g.lineWidth = pass[0]; g.strokeStyle = pass[1];
      g.beginPath();
      ang.forEach((a, i) => { g.moveTo(0, 0); g.lineTo(Math.cos(a) * len[i], Math.sin(a) * len[i]); });
      const rings = 6;
      for (let j = 1; j <= rings; j++) {
        const f = j / rings;
        for (let i = 0; i < spokes; i++) {
          const ax = Math.cos(ang[i]) * len[i] * f, ay = Math.sin(ang[i]) * len[i] * f;
          const bx = Math.cos(ang[i + 1]) * len[i + 1] * f, by = Math.sin(ang[i + 1]) * len[i + 1] * f;
          g.moveTo(ax, ay); g.quadraticCurveTo((ax + bx) / 2 * 0.86, (ay + by) / 2 * 0.86, bx, by); // sagging arcs
        }
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(235,252,255,0.9)';
    for (let k = 0; k < 7; k++) { const a = Math.random() * Math.PI / 2, r = size * (0.2 + Math.random() * 0.7); g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 1.3, 0, TAU); g.fill(); }
    cache.set(key, c); return c;
  }

  function orbSprite(R) {
    const key = 'o' + R; if (cache.has(key)) return cache.get(key);
    const c = makeCanvas(R * 2, R * 2), g = c.getContext('2d');
    g.translate(R, R);
    const N = 15, ang = [];
    for (let i = 0; i < N; i++) ang.push((i / N) * TAU + (Math.random() - 0.5) * 0.18);
    const len = ang.map(() => R * (0.9 + Math.random() * 0.1));
    for (const pass of [[3.5, 'rgba(160,230,255,0.07)'], [1, 'rgba(230,248,255,0.62)']]) {
      g.lineWidth = pass[0]; g.strokeStyle = pass[1]; g.beginPath();
      ang.forEach((a, i) => { g.moveTo(0, 0); g.lineTo(Math.cos(a) * len[i], Math.sin(a) * len[i]); });
      const rings = 16;
      for (let j = 1; j <= rings; j++) {
        const f = Math.pow(j / rings, 1.15);
        for (let i = 0; i < N; i++) {
          const i2 = (i + 1) % N;
          const ax = Math.cos(ang[i]) * len[i] * f, ay = Math.sin(ang[i]) * len[i] * f;
          const bx = Math.cos(ang[i2]) * len[i2] * f, by = Math.sin(ang[i2]) * len[i2] * f;
          g.moveTo(ax, ay); g.quadraticCurveTo((ax + bx) / 2 * 0.93, (ay + by) / 2 * 0.93, bx, by);
        }
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(235,252,255,0.95)';
    for (let k = 0; k < 40; k++) { const a = Math.random() * TAU, r = R * (0.1 + Math.random() * 0.85); g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 1.4, 0, TAU); g.fill(); }
    cache.set(key, c); return c;
  }

  class WebLayer {
    constructor() {
      this.threads = [];
      this.drained = [];
      this.dew = glowSprite('rgba(190,240,255,1)', 32);
      this.anchors = new Map();   // per-spider silk dragline anchor
      this.finale = 0;      // 0..1 fade of the final web
    }
    reset() { this.threads.length = 0; this.drained.length = 0; this.anchors.clear(); this.finale = 0; }

    addThread(ax, ay, bx, by, t) {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 40 || len > 700) return;
      if (this.threads.length >= MAX_THREADS) this.threads.shift();
      this.threads.push({
        ax, ay, bx, by, born: t, phase: Math.random() * TAU, sag: clamp(len * 0.1, 4, 42),
        drops: Array.from({ length: len > 90 ? 2 + ((Math.random() * 2) | 0) : 0 }, () => 0.15 + Math.random() * 0.7),
        minX: Math.min(ax, bx) - 10, maxX: Math.max(ax, bx) + 10, minY: Math.min(ay, by) - 50, maxY: Math.max(ay, by) + 60
      });
    }

    /* Dragline: the spider leaves silk anchored behind it; commit a strand every ~130px. */
    trail(rear, t, key = 0, step = 130) {
      const a = this.anchors.get(key);
      if (!a) { this.anchors.set(key, { x: rear.x, y: rear.y }); return; }
      if (Math.hypot(rear.x - a.x, rear.y - a.y) > step) {
        this.addThread(a.x, a.y, rear.x, rear.y, t);
        a.x = rear.x; a.y = rear.y;
      }
    }

    /* After an element is drained, bridge it to a nearby block or the viewport edge. */
    bridge(rec, surfaces, view, t) {
      const r = rec.rect; if (!r) return;
      const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
      const a = corners[(Math.random() * 4) | 0];
      let best = null, bd = 1e9;
      for (const s of surfaces) {
        if (s === r || s === rec.rect) continue;
        const c = [s.x + (Math.random() < 0.5 ? 0 : s.w), s.y + (Math.random() < 0.5 ? 0 : s.h)];
        const d = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (d > 70 && d < bd) { bd = d; best = c; }
      }
      if (best && bd < 420 && Math.random() < 0.7) this.addThread(a[0], a[1], best[0], best[1], t);
      else { // viewport edge anchor
        const ex = a[0] < view.w / 2 ? 0 : view.w;
        this.addThread(a[0], a[1], ex, a[1] + (Math.random() - 0.3) * 60, t);
      }
    }

    drain(rec, t) {
      const r = rec.rect; if (!r) return;
      const s = clamp(Math.min(r.w, r.h) * 0.9, 28, 110);
      this.drained.push({ x: r.x, y: r.y, w: r.w, h: r.h, born: t, size: s, flip: (Math.random() * 4) | 0 });
      if (this.drained.length > 400) this.drained.shift();
    }

    draw(ctx, t, cam, view) {
      const top = cam.y - 80, bot = cam.y + view.h + 80;
      // drained overlays + cobweb corner decals
      for (const d of this.drained) {
        if (d.y > bot || d.y + d.h < top) continue;
        const a = clamp((t - d.born) / 0.8, 0, 1);
        ctx.fillStyle = `rgba(8,10,16,${0.34 * a})`;
        ctx.fillRect(d.x - 2, d.y - 2, d.w + 4, d.h + 4);
        ctx.globalAlpha = a * 0.9;
        const spr = cornerSprite(d.size);
        for (let k = 0; k < 2; k++) {
          const corner = (d.flip + k * 3) % 4, sx = corner & 1 ? -1 : 1, sy = corner & 2 ? -1 : 1;
          ctx.save(); ctx.translate(d.x + (sx < 0 ? d.w : 0), d.y + (sy < 0 ? d.h : 0)); ctx.scale(sx, sy);
          ctx.drawImage(spr, 0, 0); ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
      // silk threads
      ctx.lineWidth = 0.9; ctx.lineCap = 'round';
      for (const th of this.threads) {
        if (th.maxY < top || th.minY > bot) continue;
        const g = easeOut(clamp((t - th.born) / 0.5, 0, 1));
        const bx = lerp(th.ax, th.bx, g), by = lerp(th.ay, th.by, g);
        const cx = (th.ax + bx) / 2 + Math.sin(t * 0.8 + th.phase) * 3;
        const cy = (th.ay + by) / 2 + th.sag * g + Math.sin(t * 1.1 + th.phase) * 2;
        ctx.strokeStyle = 'rgba(215,244,255,0.42)';
        ctx.beginPath(); ctx.moveTo(th.ax, th.ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
        if (g >= 1) for (const u of th.drops) { // dew drops sit on the curve
          const v = 1 - u, x = v * v * th.ax + 2 * v * u * cx + u * u * bx, y = v * v * th.ay + 2 * v * u * cy + u * u * by;
          const tw = 0.6 + 0.4 * Math.sin(t * 2 + th.phase + u * 9);
          ctx.globalAlpha = tw; ctx.drawImage(this.dew, x - 4, y - 4, 8, 8); ctx.globalAlpha = 1;
        }
      }
      // live dragline from the last anchor is drawn by the renderer (needs spider position)
    }

    drawDragline(ctx, rear, t, key = 0, color = '215,244,255') {
      const a = this.anchors.get(key);
      if (!a) return;
      ctx.strokeStyle = `rgba(${color},0.35)`; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo((a.x + rear.x) / 2, (a.y + rear.y) / 2 + 5 + Math.sin(t * 2) * 1.5, rear.x, rear.y); ctx.stroke();
    }

    /* Final state in viewport space: thick corner webs and the big orb web. */
    drawFixed(ctx, view) {
      if (this.finale <= 0) return;
      ctx.save(); ctx.globalAlpha = clamp(this.finale, 0, 1);
      const cs = Math.min(view.w, view.h) * 0.42, spr = cornerSprite(cs);
      [[0, 0, 1, 1], [view.w, 0, -1, 1], [0, view.h, 1, -1], [view.w, view.h, -1, -1]].forEach(([x, y, sx, sy]) => {
        ctx.save(); ctx.translate(x, y); ctx.scale(sx, sy); ctx.drawImage(spr, 0, 0); ctx.restore();
      });
      const R = Math.round(Math.min(view.w, view.h) * 0.3 / 16) * 16, orb = orbSprite(R);
      ctx.drawImage(orb, view.w / 2 - R, view.h / 2 - R);
      ctx.restore();
    }
  }
  WS.WebLayer = WebLayer;
})((window.WS = window.WS || {}));
