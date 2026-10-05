/* hole.js - the cracked, irising hole the spider climbs out of. */
(function (WS) {
  'use strict';
  const { clamp, easeOut } = WS.util;
  const TAU = Math.PI * 2;

  class Hole {
    constructor(x, y, r, pool) {
      this.x = x; this.y = y; this.r = r; this.pool = pool;
      this.cur = 0; this.bump = 0; this.debrisAcc = 0;
      const N = 56;
      this.verts = Array.from({ length: N }, (_, i) => ({
        a: (i / N) * TAU,
        k: 1 + (Math.random() - 0.5) * 0.14 + (i % 7 === 0 ? 0.12 : 0), // jagged edge
        delay: Math.random() * 0.45                                       // staggered iris blades
      }));
      this.cracks = Array.from({ length: 18 }, () => {
        const a = Math.random() * TAU, len = r * (0.3 + Math.random() * 0.55), pts = [];
        let aa = a;
        for (let s = 0; s <= 4; s++) { aa += (Math.random() - 0.5) * 0.35; pts.push([Math.cos(aa) * (r * 0.95 + (len * s) / 4), Math.sin(aa) * (r * 0.95 + (len * s) / 4)]); }
        return pts;
      });
    }
    shakeBump(v) { this.bump = Math.max(this.bump, v); }
    shake(t) {
      const amp = (t < 1.8 ? 5 * (1 - t / 1.8) : 0) + this.bump * 4;
      return { x: (Math.random() - 0.5) * amp, y: (Math.random() - 0.5) * amp };
    }
    update(t, dt) {
      this.cur = this.r * easeOut(clamp(t / 1.5, 0, 1));
      this.bump = Math.max(0, this.bump - dt * 3);
      if (t > 0 && t < 4.5) {
        this.debrisAcc += dt * (t < 1.6 ? 70 : 22);
        while (this.debrisAcc >= 1) {
          this.debrisAcc -= 1;
          const a = Math.random() * TAU, rr = this.cur * (0.9 + Math.random() * 0.25);
          const px = this.x + Math.cos(a) * rr, py = this.y + Math.sin(a) * rr;
          const inward = Math.random() < 0.65;
          this.pool.emit({
            x: px, y: py, kind: Math.random() < 0.6 ? 'chunk' : 'spark',
            vx: (inward ? -Math.cos(a) : Math.cos(a)) * (20 + Math.random() * 60), vy: (inward ? -Math.sin(a) : Math.sin(a)) * (20 + Math.random() * 60) + 10,
            g: inward ? 0 : 160, life: 0.6 + Math.random() * 0.9, size: 2 + Math.random() * 4, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8,
            color: Math.random() < 0.5 ? '34,243,255' : '255,43,214'
          });
        }
      }
    }
    draw(ctx, t) {
      if (this.cur < 1) return;
      const R = this.cur, q = clamp(t / 1.5, 0, 1);
      ctx.save(); ctx.translate(this.x, this.y);
      // cracks radiate beyond the rim
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 2;
      for (const c of this.cracks) {
        ctx.beginPath();
        c.forEach((p, i) => { const s = (R / this.r); i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s); });
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(34,243,255,0.22)'; ctx.lineWidth = 0.8;
      for (const c of this.cracks) {
        ctx.beginPath();
        c.forEach((p, i) => { const s = (R / this.r); i ? ctx.lineTo(p[0] * s + 1, p[1] * s + 1) : ctx.moveTo(p[0] * s + 1, p[1] * s + 1); });
        ctx.stroke();
      }
      ctx.beginPath();
      this.verts.forEach((v, i) => {
        const open = clamp((q * 1.45 - v.delay) / 0.6, 0, 1), rr = R * v.k * (0.05 + 0.95 * easeOut(open));
        const px = Math.cos(v.a) * rr, py = Math.sin(v.a) * rr;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.closePath();
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.1);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(2,2,8,1)'); g.addColorStop(0.9, 'rgba(10,6,24,0.97)'); g.addColorStop(1, 'rgba(0,0,0,0.9)');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(34,243,255,0.5)'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(34,243,255,0.8)'; ctx.shadowBlur = 12; ctx.stroke();
      ctx.shadowBlur = 0;
      // swirling depth rings
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 3; i++) {
        ctx.strokeStyle = `rgba(120,60,255,${0.12 / i})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(0, 0, R * (0.25 + i * 0.2), R * (0.25 + i * 0.2) * 0.9, t * 0.3 * i, 0, TAU * 0.8); ctx.stroke();
      }
      ctx.restore();
    }
  }
  WS.Hole = Hole;
})((window.WS = window.WS || {}));
