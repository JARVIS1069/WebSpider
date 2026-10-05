'use strict';
// Local extractive summarizer (TF-IDF + TextRank, offline) and output builders.
// Optional LLM hook: set WEBSPIDER_LLM=1 and provide ./llm-hook.js (see llm-hook.example.js).

const STOP = new Set('a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with you your'.split(' '));

const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9\u00c0-\u024f']+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));

function splitSentences(text) {
  const raw = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [];
  return raw.map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 400 && s.split(' ').length >= 5);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, v] of s) { const o = l.get(k); if (o) dot += v * o; }
  return dot / (Math.sqrt(na * nb) || 1);
}

function summarize(text, { count } = {}) {
  let sents = splitSentences(text);
  if (!sents.length) return [];
  const toks = sents.map(tokenize);
  const N = sents.length, df = new Map();
  toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const vecs = toks.map((t) => {
    const tf = new Map(); t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    const v = new Map();
    for (const [w, c] of tf) v.set(w, (c / (t.length || 1)) * (Math.log(N / (1 + df.get(w))) + 1));
    return v;
  });
  // Cap quadratic TextRank work: keep the 400 best TF-IDF sentences.
  const tfidf = vecs.map((v, i) => { let s = 0; for (const [, x] of v) s += x; return s / Math.sqrt(toks[i].length || 1); });
  let idx = sents.map((_, i) => i);
  if (idx.length > 400) idx = idx.sort((a, b) => tfidf[b] - tfidf[a]).slice(0, 400).sort((a, b) => a - b);

  // TextRank: PageRank over the sentence cosine-similarity graph.
  const n = idx.length;
  const sim = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = cosine(vecs[idx[i]], vecs[idx[j]]); sim[i][j] = sim[j][i] = c;
  }
  const rowSum = sim.map((r) => r.reduce((a, b) => a + b, 0) || 1);
  let pr = new Float32Array(n).fill(1 / n);
  for (let it = 0; it < 30; it++) {
    const nx = new Float32Array(n).fill(0.15 / n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (sim[i][j]) nx[j] += 0.85 * pr[i] * sim[i][j] / rowSum[i];
    pr = nx;
  }
  const norm = (arr) => { const m = Math.max(...arr) || 1; return Array.from(arr, (x) => x / m); };
  const a = norm(idx.map((i) => tfidf[i])), b = norm(pr);
  const scored = idx.map((si, k) => ({ si, k, score: 0.5 * a[k] + 0.5 * b[k] + (k < n * 0.1 ? 0.08 : 0) }));
  scored.sort((x, y) => y.score - x.score);

  const want = count || Math.max(5, Math.min(8, Math.round(N / 8)));
  const chosen = [];
  for (const s of scored) { // skip near-duplicates
    if (chosen.every((c) => cosine(vecs[c.si], vecs[s.si]) < 0.6)) chosen.push(s);
    if (chosen.length >= want) break;
  }
  return chosen.sort((x, y) => x.si - y.si).map((c) => sents[c.si]);
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }

function buildOverview(data, prose) {
  const lead = data.paragraphs.slice(0, 3).join(' ') || prose;
  let sentences = summarize(lead, { count: 3 });
  if (sentences.length < 2) sentences = splitSentences(lead).slice(0, 3);
  const description = data.metadata.meta.description || '';
  if (description.length >= 45 && !/\b(demo page|sample page)\b/i.test(description)) {
    sentences.unshift(description);
  }
  return [...new Set(sentences)].slice(0, 3).join(' ');
}

function distinctInsights(points, overview) {
  const overviewWords = splitSentences(overview).map((sentence) => new Set(tokenize(sentence)));
  const distinct = points.filter((point) => {
    const words = new Set(tokenize(point));
    return overviewWords.every((prior) => {
      const overlap = [...words].filter((word) => prior.has(word)).length;
      return overlap / (Math.min(words.size, prior.size) || 1) < 0.65;
    });
  });
  return distinct.length ? distinct : points;
}


function topTopics(data, limit = 8) {
  const score = new Map();
  const add = (text, w) => {
    const t = tokenize(text || '');
    t.forEach((x) => score.set(x, (score.get(x) || 0) + w));
    for (let i = 0; i < t.length - 1; i++) score.set(t[i] + ' ' + t[i + 1], (score.get(t[i] + ' ' + t[i + 1]) || 0) + w * 1.5);
  };
  add(data.metadata.title, 6);
  add(data.metadata.meta.description, 4); add(data.metadata.meta.keywords, 4);
  data.headings.forEach((h) => add(h.text, 4));
  data.paragraphs.forEach((p) => add(p, 1));
  data.lists.forEach((l) => l.items.forEach((i) => add(i, 1)));
  const ranked = [...score].filter(([, v]) => v >= 4).sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [term] of ranked) { // drop words already covered by a chosen phrase
    const sub = out.findIndex((o) => !o.includes(' ') && term.includes(' ') && term.split(' ').includes(o));
    if (sub >= 0) { out[sub] = term; continue; }
    if (out.some((o) => o.includes(term) || term.includes(o))) continue;
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function siteKind(data) {
  const blob = (data.metadata.title + ' ' + data.headings.map((h) => h.text).join(' ') + ' ' + data.paragraphs.slice(0, 8).join(' ')).toLowerCase();
  const has = (re) => (blob.match(re) || []).length;
  const kinds = [
    ['an online store or product page', has(/\b(price|cart|buy|shop|checkout|shipping|add to)\b/g) + (/[$€£]\s?\d/.test(blob) ? 2 : 0)],
    ['technical documentation', has(/\b(api|install|usage|function|parameter|sdk|documentation|config|command)\b/g) + data.code.length],
    ['a news or magazine article', has(/\b(reported|according to|said|announced|breaking|news|editor)\b/g)],
    ['a reference or encyclopedia page', has(/\b(history|etymology|references|see also|overview|definition)\b/g)],
    ['a blog post or long-form article', has(/\b(i think|my |we |posted|comments|author|read more)\b/g) + (data.paragraphs.length > 6 ? 1 : 0)],
    ['a landing or company page', has(/\b(our |features|pricing|contact|get started|sign up|customers|solutions)\b/g)]
  ].sort((a, b) => b[1] - a[1]);
  return kinds[0][1] >= 2 ? kinds[0][0] : 'an informational web page';
}

function sectionDigest(data) {
  return (data.sections || []).slice(0, 12).map((s) => {
    const text = s.body.join(' ');
    const pick = summarize(text, { count: 1 })[0] || splitSentences(text)[0] || text.slice(0, 200);
    return `- **${s.heading}** — ${pick}`;
  });
}

function buildAbout(data) {
  const m = data.metadata, host = hostOf(m.url), topics = topTopics(data);
  const parts = [];
  parts.push(`**${m.title || host || 'This page'}**${host ? ` (${host})` : ''} is ${siteKind(data)}${topics.length ? ` focused on ${topics.slice(0, 4).join(', ')}` : ''}.`);
  const desc = m.meta.description || '';
  if (desc.length >= 45 && !/\b(demo page|sample page)\b/i.test(desc)) parts.push(desc.replace(/\s+/g, ' ').trim());
  const heads = data.headings.filter((h) => h.level >= 2).slice(0, 6).map((h) => h.text);
  if (heads.length) parts.push(`It is organised into ${data.headings.filter((h) => h.level >= 2).length} sections, including ${heads.join('; ')}.`);
  return { text: parts.join(' '), topics };
}
function describeTables(tables) {
  return tables.map((table, index) => {
    const [header = [], ...rows] = table.rows || [];
    const columns = header.filter(Boolean).join(', ');
    const examples = rows.slice(0, 3).map((row) => row.filter(Boolean).join(' — ')).filter(Boolean);
    const title = columns ? `compares ${columns}` : 'presents structured data';
    return `- **Table ${index + 1}:** ${title} across ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${examples.length ? `; examples: ${examples.join('; ')}.` : '.'}`;
  });
}

function tableInsights(tables) {
  const insights = [];
  for (const table of tables) {
    const [headers = [], ...rows] = table.rows || [];
    for (let column = 1; column < headers.length; column++) {
      const values = rows.map((row) => ({
        label: row[0],
        text: row[column],
        number: Number.parseFloat(String(row[column] || '').replace(/,/g, ''))
      })).filter((entry) => entry.label && entry.text && Number.isFinite(entry.number));
      if (values.length < 2) continue;
      const lowest = values.reduce((a, b) => b.number < a.number ? b : a);
      const highest = values.reduce((a, b) => b.number > a.number ? b : a);
      if (lowest.number === highest.number) continue;
      insights.push(`For **${headers[column] || `column ${column + 1}`}**, values range from ${lowest.label} (${lowest.text}) to ${highest.label} (${highest.text}) across ${values.length} entries.`);
    }
  }
  return insights;
}

function aggregate(p) {
  const recs = p.records || [];
  const data = { metadata: { url: p.url, title: p.title || '', scrapedAt: new Date(p.scrapedAt || Date.now()).toISOString(), lang: p.lang || '', meta: {} },
    headings: [], paragraphs: [], lists: [], links: [], images: [], tables: [], code: [], stats: {} };
  const lists = new Map(), linkSeen = new Set(), pageHost = hostOf(p.url);
  const addLinks = (arr) => (arr || []).forEach((l) => {
    const k = l.href + '|' + l.text; if (linkSeen.has(k)) return; linkSeen.add(k);
    const h = hostOf(l.href);
    data.links.push({ text: l.text, href: l.href, external: !!h && h !== pageHost, domain: h });
  });
  const lines = [], sections = [];
  let sec = { heading: '', level: 0, body: [] }; sections.push(sec);
  for (const r of recs) {
    addLinks(r.links);
    switch (r.kind) {
      case 'title': data.metadata.title = data.metadata.title || r.text; break;
      case 'meta': data.metadata.meta[r.name] = r.text; break;
      case 'h': data.headings.push({ level: r.level, text: r.text }); sec = { heading: r.text, level: r.level, body: [] }; sections.push(sec); lines.push('', r.text.toUpperCase(), ''); break;
      case 'p': data.paragraphs.push(r.text); sec.body.push(r.text); lines.push(r.text, ''); break;
      case 'li': {
        let l = lists.get(r.listId);
        if (!l) { l = { type: r.listType || 'ul', items: [] }; lists.set(r.listId, l); data.lists.push(l); }
        l.items.push(r.text); sec.body.push(r.text); lines.push('• ' + r.text); break;
      }
      case 'table': data.tables.push({ rows: r.rows }); lines.push('', ...r.rows.map((x) => x.join(' | ')), ''); break;
      case 'pre': data.code.push(r.text); lines.push('', ...r.text.split('\n').map((x) => '    ' + x), ''); break;
      case 'img': data.images.push({ alt: r.alt, src: r.src }); lines.push(`[Image: ${r.alt || r.src}]`); break;
      case 'a': lines.push(`${r.text} (${r.href})`); break;
    }
  }
  const textForWords = recs.filter((r) => ['h', 'p', 'li', 'table', 'pre'].includes(r.kind)).map((r) => r.text).join(' ');
  const words = textForWords.split(/\s+/).filter(Boolean).length;
  const domains = new Map();
  data.links.filter((l) => l.external).forEach((l) => domains.set(l.domain, (domains.get(l.domain) || 0) + 1));
  data.stats = {
    words, links: data.links.length, images: data.images.length, headings: data.headings.length,
    readTimeMinutes: Math.max(1, Math.round(words / 225)),
    elementsScraped: recs.length,
    topExternalDomains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, count]) => ({ domain, count }))
  };
  const contentTxt = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  data.sections = sections.filter((x) => x.heading && x.body.length);
  return { data, contentTxt, prose: [...data.paragraphs, ...data.lists.flatMap((l) => l.items)].join(' ') };
}

async function buildOutputs(payload, llmHook) {
  const { data, contentTxt, prose } = aggregate(payload);
  let points = [];
  if (llmHook) {
    try { points = await llmHook(contentTxt, { title: data.metadata.title, url: data.metadata.url }); } catch (e) { console.warn('LLM hook failed:', e.message); }
  }
  if (!points || !points.length) points = summarize(prose || contentTxt);
  data.summaryOverview = buildOverview(data, prose || contentTxt);
  const about = buildAbout(data); data.about = about.text; data.topics = about.topics; data.sectionSummaries = sectionDigest(data);
  points = [...distinctInsights(points, data.summaryOverview), ...tableInsights(data.tables)];
  data.summary = points;
  data.insights = points;
  const s = data.stats, m = data.metadata;
  const md = [
    `# ${m.title || m.url}`, '',
    `- **URL:** ${m.url}`,
    `- **Scraped:** ${m.scrapedAt}`,
    payload.partial ? '- **Note:** scrape was cancelled; results are partial' : null,
    '', '## What this website is about', '', data.about, '',
    data.topics.length ? '**Main topics:** ' + data.topics.map((t) => '' + t + '').join(', ') : null,
    '', '## Overview', '',
    data.summaryOverview || 'The page did not contain enough prose for an overview.',
    '', '## Section by section', '',
    ...(data.sectionSummaries.length ? data.sectionSummaries : ['- (no sections with text)']),
    '', '## Key insights', '',
    ...(points.length ? points.map((x) => `- ${x}`) : ['- (not enough prose text to summarize)']),
    '', '## Evidence on the page', '',
    ...(data.tables.length ? describeTables(data.tables) : ['- No tables were found.']),
    data.lists.length ? `- **Lists:** ${data.lists.length} list${data.lists.length === 1 ? '' : 's'} containing ${data.lists.reduce((n, list) => n + list.items.length, 0)} items.` : '- No lists were found.',
    `- **Media and code:** ${data.images.length} image${data.images.length === 1 ? '' : 's'} and ${data.code.length} code block${data.code.length === 1 ? '' : 's'}.`,
    '', '## Outline', '',
    ...(data.headings.length ? data.headings.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`) : ['- (no headings)']),
    '', '## Stats', '',
    `- Words: ${s.words}`, `- Links: ${s.links}`, `- Images: ${s.images}`, `- Headings: ${s.headings}`,
    `- Estimated read time: ${s.readTimeMinutes} min`,
    '', '## Top external domains', '',
    ...(s.topExternalDomains.length ? s.topExternalDomains.map((d) => `- ${d.domain} (${d.count})`) : ['- (none)']), ''
  ].filter((x) => x !== null).join('\n');
  return { summaryMd: md, data, contentTxt };
}

module.exports = { summarize, aggregate, buildOutputs };
