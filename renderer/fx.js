/* fx.js - pooled particles, scan box + glitch text, flying text snippets. */
(function (WS) {
  'use strict';
  const { clamp, lerp, easeInOut } = WS.util;

  class ParticlePool {
    constructor(n = 700) {
      this.items = Array.from({ length: n }, () => ({ alive: false }));
      this.cursor = 0;
    }
    emit(o) {
      const n = this.items.length;
      for (let i = 0; i < n; i++) {
        const p = this.items[(this.cursor + i) % n];
        if (!p.alive) {
          this.cursor = (this.cursor + i + 1) % n;
          Object.assign(p, { alive: true, vx: 0, vy: 0, g: 0, rot: 0, vr: 0, size: 3, kind: 'spark', color: '120,250,255', shrink: true, drag: 0 }, o);
          p.max = p.life;
          return p;
        }
      }
      return null;
    }
    update(dt) {
      for (const p of this.items) {
        if (!p.alive) continue;
        p.life -= dt;
        if (p.life <= 0) { p.alive = false; continue; }
        p.vy += p.g * dt;
        if (p.drag) { const f = Math.exp(-p.drag * dt); p.vx *= f; p.vy *= f; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      }
    }
    draw(ctx) {
      for (const p of this.items) {
        if (!p.alive) continue;
        const k = p.life / p.max, s = p.shrink ? p.size * (0.3 + 0.7 * k) : p.size;
        if (p.kind === 'chunk') {
          ctx.globalCompositeOperation = 'source-over';
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = `rgba(6,8,12,${0.95 * clamp(k * 2, 0, 1)})`;
          ctx.strokeStyle = `rgba(${p.color},${0.5 * k})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(-s, -s * 0.4); ctx.lineTo(s * 0.8, -s * 0.7); ctx.lineTo(s, s * 0.6); ctx.lineTo(-s * 0.5, s); ctx.closePath();
          ctx.fill(); ctx.stroke(); ctx.restore();
        } else {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(${p.color},${clamp(k * 1.4, 0, 1)})`;
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  const GLYPHS = '▓▒░#%&@01<>/\\|=+*~';
  function scramble(text, prog) {
    const n = text.length, keep = Math.floor(n * prog);
    let out = text.slice(0, keep);
    for (let i = keep; i < n; i++) out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    return out;
  }

  const COLORS = { cyan: '34,243,255', magenta: '255,43,214', orange: '255,154,31', green: '57,255,122' };
  function colorFor(rec) {
    if (rec.kind === 'h' || rec.kind === 'title' || rec.kind === 'meta') return 'cyan';
    if (rec.kind === 'a') return 'magenta';
    if (rec.kind === 'img' || rec.hasId) return 'green';
    return 'orange';
  }

  /* The box + glitch overlay for the element currently being scraped. */
  class ScanFx {
    constructor() { this.rec = null; this.t = 0; this.prog = 0; this.label = ''; }
    start(rec) { this.rec = rec; this.t = 0; this.prog = 0; this.color = COLORS[colorFor(rec)]; this.full = (rec.text || '').replace(/\s+/g, ' ').slice(0, 70); }
    stop() { this.rec = null; }
    setProgress(p) { this.prog = p; }
    draw(ctx, time) {
      const r = this.rec && this.rec.rect; if (!r) return;
      const c = this.color, pad = 3;
      const x = r.x - pad, y = r.y - pad, w = r.w + pad * 2, h = r.h + pad * 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${c},0.07)`; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = `rgba(${c},0.95)`; ctx.lineWidth = 1.5;
      ctx.shadowColor = `rgba(${c},0.9)`; ctx.shadowBlur = 8;
      ctx.setLineDash([7, 4]); ctx.lineDashOffset = -time * 40;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]); ctx.shadowBlur = 0;
      const b = Math.min(10, w / 3, h / 3);
      ctx.lineWidth = 2.5; ctx.beginPath();
      [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, sx, sy]) => {
        ctx.moveTo(cx + sx * b, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * b);
      });
      ctx.stroke();
      // scan line
      const sy = y + ((time * 1.6) % 1) * h;
      ctx.fillStyle = `rgba(${c},0.35)`; ctx.fillRect(x, sy, w, 2);
      // glitch slices while scrambling
      if (this.prog < 1) {
        for (let i = 0; i < 4; i++) {
          const gy = y + Math.random() * h, gh = 2 + Math.random() * Math.min(10, h / 3), off = (Math.random() - 0.5) * 16;
          ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,43,214,0.28)' : 'rgba(34,243,255,0.28)';
          ctx.fillRect(x + off, gy, w * (0.3 + Math.random() * 0.7), gh);
        }
      }
      // label chip with scrambled -> resolved text
      const txt = (this.prog < 1 ? scramble(this.full, this.prog) : this.full) || this.rec.tag;
      ctx.font = '11px Consolas, monospace';
      const tw = Math.min(ctx.measureText(txt).width + 14, 460), ly = y - 20 < r.y - 80 ? y + h + 4 : y - 20;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(4,8,12,0.9)'; ctx.fillRect(x, ly, tw, 17);
      ctx.strokeStyle = `rgba(${c},0.9)`; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, ly + 0.5, tw, 16);
      ctx.fillStyle = `rgb(${c})`; ctx.textBaseline = 'middle';
      ctx.save(); ctx.beginPath(); ctx.rect(x, ly, tw, 17); ctx.clip();
      ctx.fillText(`<${this.rec.tag}> ${txt}`, x + 6, ly + 9); ctx.restore();
      ctx.restore();
    }
  }

  /* Text snippets that fly from the scraped element into the spider's mouth. */
  class Snippets {
    constructor() { this.list = []; }
    spawn(text, x, y, color, delay) { this.list.push({ text, x, y, color, delay, t: 0, dur: 0.75 + Math.random() * 0.25, bend: (Math.random() - 0.5) * 120 }); }
    update(dt, mouth, onArrive) {
      for (const s of this.list) {
        if (s.delay > 0) { s.delay -= dt; continue; }
        s.t += dt / s.dur;
        if (s.t >= 1 && !s.done) { s.done = true; if (onArrive) onArrive(mouth.x, mouth.y); }
      }
      this.list = this.list.filter((s) => !s.done);
      this.mouth = mouth;
    }
    draw(ctx) {
      if (!this.mouth) return;
      ctx.save(); ctx.font = '12px Consolas, monospace'; ctx.textBaseline = 'middle';
      for (const s of this.list) {
        if (s.delay > 0) continue;
        const k = easeInOut(clamp(s.t, 0, 1));
        const x = lerp(s.x, this.mouth.x, k), y = lerp(s.y, this.mouth.y, k) + Math.sin(k * Math.PI) * s.bend;
        const a = clamp(1 - Math.pow(k, 4), 0, 1), sc = 1 - k * 0.55;
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${COLORS[s.color]})`; ctx.shadowColor = `rgb(${COLORS[s.color]})`; ctx.shadowBlur = 6;
        ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); ctx.fillText(s.text, 0, 0); ctx.restore();
      }
      ctx.restore();
    }
  }

  WS.fx = { ParticlePool, ScanFx, Snippets, colorFor, COLORS };
})((window.WS = window.WS || {}));
