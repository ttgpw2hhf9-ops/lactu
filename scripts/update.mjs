// Robot de L'actu — Node 20, sans dépendance.
// Lit sources.json, récupère les articles (RSS, puis secours Google Actualités → Bing Actualités),
// fusionne avec l'historique déjà publié et écrit site/data.json (+ site/logos/).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCES_FILE = process.env.LACTU_SOURCES || path.join(ROOT, 'sources.json');
const SITE_DIR = process.env.LACTU_SITE || path.join(ROOT, 'site');
const NOW = process.env.LACTU_NOW ? Date.parse(process.env.LACTU_NOW) : Date.now();
const REPO = process.env.GITHUB_REPOSITORY || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

// Pour les tests uniquement : LACTU_FIXTURES = fichier JSON { "adresse": "fichier local" | null }
let FIXTURES = null;
if (process.env.LACTU_FIXTURES) {
  FIXTURES = JSON.parse(await readFile(process.env.LACTU_FIXTURES, 'utf8'));
  FIXTURES.__dir = path.dirname(process.env.LACTU_FIXTURES);
}

function pagesUrl() {
  if (process.env.LACTU_PAGES_URL) return process.env.LACTU_PAGES_URL.replace(/\/?$/, '/');
  if (!REPO) return '';
  const [owner, name] = REPO.split('/');
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

// ---------- Réseau ----------
async function fetchBuf(url, { tries = 2, timeout = 20000 } = {}) {
  if (FIXTURES) {
    const f = FIXTURES[url];
    if (!f) throw new Error('HTTP 403 (fixture)');
    const buf = await readFile(path.join(FIXTURES.__dir, f));
    return { buf, type: f.endsWith('.png') ? 'image/png' : 'application/xml' };
  }
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', 'Accept-Language': 'fr-FR,fr;q=0.9' },
        redirect: 'follow', signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
    } catch (e) { last = e; if (i < tries - 1) await new Promise(r => setTimeout(r, 1500)); }
  }
  throw last;
}

async function fetchText(url) {
  const { buf, type } = await fetchBuf(url);
  let cs = (type.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 200).toString('latin1').match(/encoding=["']([\w-]+)["']/i) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

// ---------- Lecture des flux ----------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', euro: '€' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const unCdata = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
const clean = s => decode(stripTags(decode(unCdata(s || '')))).replace(/\s+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'i'));
  return m ? m[1] : '';
}
function attr(xml, tagName, attrName, where = null) {
  const re = new RegExp(`<${esc(tagName)}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    if (where && !where.test(m[1])) continue;
    const a = m[1].match(new RegExp(`\\b${esc(attrName)}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (a) return decode(a[1]);
  }
  return '';
}

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const title = clean(tag(b, 'title'));
    let link = clean(tag(b, 'link'));
    if (!/^https?:/.test(link)) link = attr(b, 'link', 'href', /rel=["']alternate|^(?![\s\S]*rel=)/i) || attr(b, 'link', 'href');
    if (!/^https?:/.test(link)) { const g = clean(tag(b, 'guid')); if (/^https?:/.test(g)) link = g; }
    const date = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const rawDesc = unCdata(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'));
    const image = attr(b, 'media:content', 'url', /image|\.(jpe?g|png|webp)/i) || attr(b, 'media:thumbnail', 'url')
      || attr(b, 'enclosure', 'url', /image/i) || (decode(rawDesc).match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
    const cat = (b.match(/<(category|dc:subject)[^>]*>([\s\S]*?)<\/(category|dc:subject)>/gi) || []).map(c => clean(c.replace(/<\/?(category|dc:subject)[^>]*>/gi, ''))).filter(Boolean).slice(0, 4).join(', ');
    const source = clean(tag(b, 'source'));
    const summary = clean(rawDesc).replace(/^L[’']ESSENTIEL\s*/i, '').slice(0, 220);
    return { title, link, date, summary, image, cat, source };
  }).filter(it => it.title && /^https?:/.test(it.link));
}

// ---------- Outils ----------
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function canonical(u) {
  try {
    const x = new URL(u); x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|xtor|at_|fbclid|gclid)/i.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}
function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const asList = v => v == null ? [] : Array.isArray(v) ? v : [v];

function compileKeywords(list) {
  return asList(list).map(k => {
    const words = norm(k.replace(/\*/g, ' STAR ')).split(' ').filter(Boolean);
    const parts = []; for (const w of words) { if (w === 'star') { if (parts.length) parts[parts.length - 1] += '[a-z0-9]*'; } else parts.push(esc(w)); }
    return parts.length ? new RegExp(`(?:^| )${parts.join(' ')}(?= |$)`) : null;
  }).filter(Boolean);
}
const countHits = (res, text) => res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

// ---------- Récupération d'une source ----------
const fallbackCache = new Map();
async function fallback(kind, query) {
  const key = kind + '|' + query;
  if (!fallbackCache.has(key)) fallbackCache.set(key, (async () => {
    const url = kind === 'google'
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:3d')}&hl=fr&gl=FR&ceid=FR:fr`
      : `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=fr-FR&cc=FR&count=50`;
    const items = parseFeed(await fetchText(url));
    return items.map(it => {
      let link = it.link, title = it.title;
      if (kind === 'bing') { try { const real = new URL(link).searchParams.get('url'); if (real) link = real; } catch {} }
      if (kind === 'google') { const src = it.source || ''; if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3)); else title = title.replace(/ - [^-]{2,40}$/, ''); }
      return { ...it, title, link, image: kind === 'google' ? '' : it.image };
    });
  })());
  return fallbackCache.get(key);
}

async function collect(src) {
  const st = { id: src.id, via: 'rss', n: 0, errors: [] };
  let items = [];
  for (const url of asList(src.rss)) {
    try { const got = parseFeed(await fetchText(url)); if (!got.length) st.errors.push(`${url} : flux vide`); items.push(...got); }
    catch (e) { st.errors.push(`${url} : ${e.message || e}`); }
  }
  if (!items.length && src.fallback !== false) {
    const q = src.fallbackQuery || `site:${domainOf(src.site || asList(src.rss)[0])}`;
    for (const kind of ['google', 'bing']) {
      try { const got = await fallback(kind, q); if (got.length) { items = got; st.via = kind; break; } st.errors.push(`${kind} : aucun résultat`); }
      catch (e) { st.errors.push(`${kind} : ${e.message || e}`); }
    }
    if (!items.length) st.via = 'échec';
  }
  return { st, items };
}

// ---------- Logos ----------
async function saveLogo(id, url, pages) {
  const dir = path.join(SITE_DIR, 'logos'); await mkdir(dir, { recursive: true });
  const tryGet = async u => { const { buf, type } = await fetchBuf(u, { tries: 1, timeout: 15000 }); if (buf.length < 50) throw new Error('trop petit'); return { buf, type }; };
  let got = null;
  try { got = await tryGet(url); } catch {}
  if (!got && pages) { try { got = await tryGet(`${pages}logos/${id}.png`); } catch {} }
  if (!got) return '';
  await writeFile(path.join(dir, `${id}.png`), got.buf);
  return `logos/${id}.png`;
}

// ---------- Programme principal ----------
async function main() {
  const cfg = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
  const settings = { historyDays: 14, maxItems: 500, ...(cfg.settings || {}) };
  const themes = cfg.themes || [];
  const sources = (cfg.sources || []).filter(s => s.on !== false);
  const pages = pagesUrl();
  const themeRes = Object.fromEntries(themes.map(t => [t.id, compileKeywords(t.keywords)]));
  const themeIds = new Set(themes.map(t => t.id));
  const journals = (cfg.journals || []).map(j => ({ ...j, _res: (j.sections || []).map(s => [s.id, compileKeywords(s.keywords)]) }));

  // Historique déjà publié
  let prev = { items: [] };
  try {
    if (process.env.LACTU_PREV_FILE) prev = JSON.parse(await readFile(process.env.LACTU_PREV_FILE, 'utf8'));
    else if (pages) prev = JSON.parse(await fetchText(`${pages}data.json?t=${NOW}`));
    console.log(`Historique publié : ${prev.items?.length || 0} articles`);
  } catch (e) { console.log(`Pas d'historique publié (${e.message || e}) — on part de zéro.`); }
  const prevById = new Map((prev.items || []).map(it => [it.id, it]));

  // Collecte en parallèle
  const results = await Promise.all(sources.map(collect));

  // Assemblage : nouvelles entrées d'abord, puis l'historique, source par source (l'ordre de sources.json fait foi)
  const seenTitle = new Set(), seenId = new Set(), out = [];
  const minDate = NOW - settings.historyDays * 864e5;
  const statusOut = [];
  sources.forEach((src, i) => {
    const { st, items } = results[i];
    const fresh = items.map(it => ({ ...it, _fresh: true, _fallback: st.via !== 'rss' }));
    fresh.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    const freshKept = src.keep ? fresh.slice(0, src.keep) : fresh;
    const old = (prev.items || []).filter(p => p.src === src.id).map(p => ({ title: p.t, link: p.u, date: new Date(p.d).toUTCString(), summary: p.s || '', image: p.img || '', cat: p.cat || '', _first: p.f, _old: true }));
    const urlMatch = asList(src.urlMatch).map(r => new RegExp(r, 'i'));
    const urlExclude = asList(src.urlExclude).map(r => new RegExp(r, 'i'));
    const titleStart = asList(src.titleStartExclude).map(norm);
    const exclude = compileKeywords(src.exclude);
    const titleStrip = asList(src.titleStrip).map(r => new RegExp('^\\s*(?:' + r + ')\\s*', 'i'));
    const themeByUrl = Object.entries(src.themeByUrl || {}).map(([r, t]) => [new RegExp(r, 'i'), t]);
    const journal = journals.find(j => j.id === src.journal);
    const extraRes = compileKeywords(src.keywords);
    let kept = 0;
    for (const it of [...freshKept, ...old]) {
      const link = canonical(it.link);
      const id = hash(link);
      for (const r of titleStrip) it.title = it.title.replace(r, '');
      const tkey = norm(it.title);
      if (!tkey || seenId.has(id) || seenTitle.has(tkey)) continue;
      if (urlMatch.length && !urlMatch.some(r => r.test(link))) continue;
      if (urlExclude.some(r => r.test(link))) continue;
      if (titleStart.some(p => p && tkey.startsWith(p))) continue;
      const text = norm(`${it.title} ${it.title} ${it.summary} ${it.cat}`);
      if (exclude.length && countHits(exclude, text)) continue;

      // Classement par thème
      const score = id => countHits(themeRes[id] || [], text);
      let theme = themeIds.has(src.theme) ? src.theme : null;
      for (const [r, t] of themeByUrl) if (r.test(link) && themeIds.has(t)) { theme = t; break; }
      const best = () => { let b = null, bs = 0; for (const t of themes) { if (t.id === src.theme) continue; const s = score(t.id); if (s > bs) { b = t.id; bs = s; } } return b; };
      if (src.dispatch) theme = best() || theme;
      else if (!theme) theme = best();
      if (!theme && !journal) continue;
      if (theme && (src.filter || it._fallback) && !src.dispatch && (themeRes[theme] || []).length && !score(theme) && !countHits(extraRes, text)) continue;

      // Dates
      const prevIt = prevById.get(id);
      const first = Math.min(it._first || prevIt?.f || NOW, NOW);
      let d = Date.parse(it.date);
      if (src.trustDates === false || !d) d = first;
      if (d > NOW) d = NOW;
      if (d < minDate) continue;

      seenId.add(id); seenTitle.add(tkey);
      let sec;
      if (journal) {
        let bs = 0; sec = journal.defaultSection;
        for (const [sid, res] of journal._res) { const sc = countHits(res, text); if (sc > bs) { bs = sc; sec = sid; } }
      }
      out.push({ id, t: it.title, u: link, d, f: first, s: it.summary || undefined, img: it.image || undefined, cat: it.cat || undefined, th: theme || undefined, j: journal?.id, sec, src: src.id });
      if (it._fresh) kept++;
    }
    statusOut.push({ id: src.id, via: st.via, n: items.length, kept, errors: st.errors.slice(0, 4) });
  });
  out.sort((a, b) => b.d - a.d);
  const items = out.slice(0, settings.maxItems);

  // Logos (téléchargés par le robot, jamais recopiés à la main)
  const logoCache = new Map();
  const logoFor = async (id, url) => { if (!url) return ''; if (!logoCache.has(url)) logoCache.set(url, saveLogo(id, url, pages)); return logoCache.get(url); };
  const themesOut = [];
  for (const t of themes) themesOut.push({ id: t.id, name: t.name, short: t.short, color: t.color, logo: await logoFor('theme-' + t.id, t.logo) || undefined });
  const journalsOut = [];
  for (const j of journals) {
    const used = new Set(items.filter(i => i.j === j.id).map(i => i.sec));
    journalsOut.push({ id: j.id, name: j.name, short: j.short, color: j.color, logo: await logoFor('journal-' + j.id, j.logo) || undefined,
      sections: (j.sections || []).map(s => ({ id: s.id, name: s.name })).filter(s => used.has(s.id)) });
  }
  const sourcesOut = [];
  for (const s of sources) {
    const url = s.logo || (s.site ? `https://www.google.com/s2/favicons?domain=${domainOf(s.site)}&sz=128` : '');
    sourcesOut.push({ id: s.id, name: s.name, chip: s.chip, site: s.site, logo: await logoFor('src-' + s.id, url) || undefined, status: statusOut.find(x => x.id === s.id) });
  }

  const data = { app: cfg.app || {}, generated: NOW, repo: REPO, themes: themesOut, journals: journalsOut, sources: sourcesOut, items };
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, 'data.json'), JSON.stringify(data));

  // Compte rendu (visible dans l'onglet Actions)
  const lines = ['| Source | Voie | Reçus | Nouveaux gardés | Problème |', '|---|---|---|---|---|',
    ...statusOut.map(s => `| ${s.id} | ${s.via} | ${s.n} | ${s.kept} | ${(s.errors[0] || '').replace(/\|/g, '/')} |`),
    '', `**${items.length} articles publiés** — thèmes : ${Object.entries(items.reduce((m, it) => (it.th && (m[it.th] = (m[it.th] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ')} — journaux : ${Object.entries(items.reduce((m, it) => (it.j && (m[it.j + '/' + it.sec] = (m[it.j + '/' + it.sec] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, '## L\'actu — passage du robot\n\n' + lines.join('\n') + '\n', { flag: 'a' });
}

main().catch(e => { console.error(e); process.exit(1); });
