'use strict';
// In-page scraper. Loaded by webview-preload.js. Reads the DOM only; the real
// page is never styled or mutated. The renderer talks to it via IPC:
//   host -> guest: 'ws:cmd' {id, cmd, args}   guest -> host: 'ws:res' {id, result}
//   guest -> host: 'ws:scroll' {y, docH, vh}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const SKIP_ANCESTORS = 'script,style,noscript,template,svg,head';
const INLINE_HOST = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,figcaption';

function install(ipc) {
  const els = new Map();
  let nextId = 1;
  const styleCache = new WeakMap();

  const style = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };

  function isVisible(el) {
    if (el.hidden) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function isFixed(el) {
    for (let n = el, d = 0; n && n !== document.documentElement && d < 12; n = n.parentElement, d++) {
      if (style(n).position === 'fixed') return true;
    }
    return false;
  }

  function docRect(el) {
    const r = el.getBoundingClientRect();
    const W = Math.max(document.documentElement.scrollWidth, innerWidth);
    const x = Math.max(0, r.left + scrollX);
    return { x, y: r.top + scrollY, w: Math.min(r.width, W - x), h: r.height };
  }

  function linksOf(el) {
    const out = [];
    for (const a of el.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href || href.startsWith('javascript:')) continue;
      out.push({ text: clean(a.innerText || a.getAttribute('aria-label') || a.title), href });
      if (out.length >= 60) break;
    }
    return out;
  }

  function tableRows(t) {
    const rows = [];
    for (const tr of t.querySelectorAll('tr')) {
      rows.push(Array.from(tr.children).slice(0, 12).map((c) => clean(c.innerText)));
      if (rows.length >= 80) break;
    }
    return rows;
  }

  function build({ max = 500 } = {}) {
    els.clear(); nextId = 1;
    const out = [];
    const push = (rec, el) => {
      rec.id = nextId++;
      if (el) els.set(rec.id, el);
      out.push(rec);
    };

    push({ kind: 'title', tag: 'title', text: clean(document.title), virtual: true, words: clean(document.title).split(' ').filter(Boolean).length, links: [] });
    const metaNames = ['description', 'keywords', 'author', 'og:title', 'og:description', 'og:site_name', 'twitter:title'];
    for (const m of document.querySelectorAll('meta[name],meta[property]')) {
      const key = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
      const val = clean(m.getAttribute('content'));
      if (val && metaNames.includes(key)) push({ kind: 'meta', tag: 'meta', name: key, text: val, virtual: true, words: val.split(' ').length, links: [] });
    }

    const seenImg = new Set();
    const listIds = new Map();
    const nodes = document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,table,a[href],img,pre,blockquote,div');
    for (const el of nodes) {
      if (out.length >= max) break;
      const tag = el.tagName.toLowerCase();
      if (el.closest(SKIP_ANCESTORS)) continue;
      if (tag !== 'table' && el.closest('table') && !el.closest('table').isSameNode(el)) continue;

      let rec = null;
      if (tag === 'div') {
        if (el.children.length > 8) continue;
        const own = clean(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
        if (own.length < 40 || el.querySelector('p,li,h1,h2,h3,h4,h5,h6,table,pre')) continue;
        if (!isVisible(el)) continue;
        const text = clean(el.innerText);
        rec = { kind: 'p', tag, text: text.slice(0, 4000), links: linksOf(el) };
      } else if (/^h[1-6]$/.test(tag)) {
        if (!isVisible(el)) continue;
        const text = clean(el.innerText); if (!text) continue;
        rec = { kind: 'h', tag, level: +tag[1], text, links: linksOf(el) };
      } else if (tag === 'p' || tag === 'blockquote') {
        if (tag === 'blockquote' && el.querySelector('p')) continue;
        if (!isVisible(el)) continue;
        const text = clean(el.innerText); if (!text) continue;
        rec = { kind: 'p', tag, text: text.slice(0, 4000), links: linksOf(el) };
      } else if (tag === 'li') {
        if (el.querySelector('li,p,table,pre,h1,h2,h3,h4,h5,h6')) continue;
        if (!isVisible(el)) continue;
        const text = clean(el.innerText); if (!text) continue;
        const list = el.parentElement;
        if (!listIds.has(list)) listIds.set(list, listIds.size + 1);
        rec = { kind: 'li', tag, text: text.slice(0, 2000), links: linksOf(el), listId: listIds.get(list), listType: list && list.tagName.toLowerCase() };
      } else if (tag === 'table') {
        if (!isVisible(el)) continue;
        const rows = tableRows(el); if (!rows.length) continue;
        rec = { kind: 'table', tag, rows, text: rows.map((r) => r.join(' | ')).join('\n').slice(0, 6000), links: linksOf(el) };
      } else if (tag === 'pre') {
        if (!isVisible(el)) continue;
        const text = (el.innerText || '').trim(); if (!text) continue;
        rec = { kind: 'pre', tag, text: text.slice(0, 6000), links: [] };
      } else if (tag === 'a') {
        if (el.closest(INLINE_HOST) && !el.closest(INLINE_HOST).isSameNode(el)) continue;
        const href = el.href;
        if (!href || href.startsWith('javascript:')) continue;
        if (!isVisible(el)) continue;
        const text = clean(el.innerText || el.getAttribute('aria-label') || el.title);
        if (!text && !el.querySelector('img')) continue;
        rec = { kind: 'a', tag, text: text || href, href, links: [{ text, href }] };
      } else if (tag === 'img') {
        const src = el.currentSrc || el.src;
        if (!src || seenImg.has(src)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || !isVisible(el)) continue;
        seenImg.add(src);
        rec = { kind: 'img', tag, src: src.startsWith('data:') ? src.slice(0, 80) + '…' : src, alt: clean(el.alt), text: clean(el.alt) || '[image]', links: [] };
      }
      if (!rec) continue;

      rec.words = rec.kind === 'img' ? 0 : rec.text.split(/\s+/).filter(Boolean).length;
      rec.hasId = !!el.id;
      if (isFixed(el)) rec.virtual = true; else rec.rect = docRect(el);
      push(rec, el);
    }
    return { records: out, docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth };
  }

  async function prepare() {
    // Wait for load, scroll through the page to trigger lazy content, wait for DOM/network quiet.
    const t0 = Date.now();
    if (document.readyState !== 'complete') {
      await Promise.race([new Promise((r) => addEventListener('load', r, { once: true })), sleep(6000)]);
    }
    let lastMut = Date.now();
    const mo = new MutationObserver(() => { lastMut = Date.now(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    let y = 0, steps = 0, lastH = 0;
    while (steps < 25 && Date.now() - t0 < 10000) {
      const h = document.documentElement.scrollHeight;
      scrollTo({ top: y, behavior: 'instant' });
      await sleep(140);
      steps++;
      if (y + innerHeight >= h - 2 && h === lastH) break;
      lastH = h;
      y += innerHeight * 0.85;
    }
    let resCount = -1;
    for (let i = 0; i < 12; i++) {
      const n = performance.getEntriesByType('resource').length;
      if (Date.now() - lastMut > 350 && n === resCount) break;
      resCount = n;
      await sleep(180);
    }
    mo.disconnect();
    scrollTo({ top: 0, behavior: 'instant' });
    await sleep(120);
    return true;
  }

  const handlers = {
    prepare,
    build,
    info: () => ({ docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight, y: scrollY, url: location.href, title: document.title, lang: document.documentElement.lang || '' }),
    rect: ({ id }) => { const el = els.get(id); return el && el.isConnected ? { rect: docRect(el), docH: document.documentElement.scrollHeight } : null; },
    scrollTo: ({ y }) => { scrollTo({ top: y, behavior: 'instant' }); return scrollY; }
  };

  ipc.on('ws:cmd', async (_e, { id, cmd, args }) => {
    let result = null;
    try { result = await handlers[cmd](args || {}); } catch (err) { result = { error: String(err) }; }
    ipc.sendToHost('ws:res', { id, result });
  });

  let pending = false;
  const report = () => {
    if (pending) return; pending = true;
    requestAnimationFrame(() => {
      pending = false;
      ipc.sendToHost('ws:scroll', { y: scrollY, docH: document.documentElement.scrollHeight, vh: innerHeight });
    });
  };
  addEventListener('scroll', report, { passive: true });
  addEventListener('resize', report);
}

module.exports = { install };
