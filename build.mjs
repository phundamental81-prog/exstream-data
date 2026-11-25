// ExStream streaming-service list builder (runs every day on GitHub Actions)
//
// For each streaming service, asks Wikidata (free, CC0) which TV shows it MADE or FIRST AIRED: the
// show's "original broadcaster" (P449) is the service itself, or one of the TV channels it owns
// whose shows stream on it (NBC -> Peacock, ABC and FX -> Hulu, CBS -> Paramount+, CTV -> Crave,
// CBC -> CBC Gem...). Channel shows only count from 2000 on: a service carries its channels' recent
// shows, not everything they ever aired. ("Distributed by" (P750) is NOT used: that's "somewhere in
// the world", and put shows like Heartland under Netflix, where they aren't for Canadian viewers.)
//
// Then how popular each show is right now: its English Wikipedia page's views over the last 30 days
// (Wikimedia's free pageviews API). The app puts each service's most popular shows first.
//
// Writes services.json:
//   {v, built, services: ["Netflix", ...], shows: [[title, firstYear, serviceIndex, views30d], ...]}
// The ExStream app checks for a new one once a day (downloaded only when it changed) and matches
// shows by title + year on the device. Nothing about any user, provider or app is in here.
//
// How it asks (light questions, so a busy Wikidata doesn't time out): one small question first finds
// the ID of every service and channel; then each service's shows are fetched by those IDs.
//
// Safety: if one service can't be fetched (Wikidata busy), it keeps its shows from the last good list
// and the others still update. A service that comes back empty is left out (with a warning). If the
// list as a whole looks wrong (under 800 shows, or 30% fewer than last time), the old services.json
// is kept and the job fails, so the app never gets a broken list.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const UA = 'ExStreamDataBot/1.0 (https://github.com/phundamental81-prog/exstream-data)';
const SPARQL = 'https://query.wikidata.org/sparql';
const VIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';
const V = 3; // v3: + owning channels, + popularity. A new version isn't compared with the old.
const CHANNEL_FROM = 2000;

// labels: the service's own names in Wikidata; wiki: its English Wikipedia article(s);
// channels: the English Wikipedia articles of the TV channels it owns whose shows stream on it
// (exact article titles: a short name like "ABC" would also match Australia's ABC)
const SERVICES = [
  {name: 'Netflix', labels: ['Netflix']},
  {name: 'HBO Max', labels: ['HBO Max', 'Max'], channels: ['HBO', 'Cinemax', 'TLC (TV network)', 'Discovery Channel', 'HGTV', 'Food Network']},
  {name: 'Disney+', labels: ['Disney+', 'Disney Plus'], channels: ['Disney Channel', 'Disney Jr.', 'Disney XD', 'National Geographic (American TV channel)']},
  {name: 'Prime Video', labels: ['Prime Video', 'Amazon Prime Video', 'Amazon Video'], channels: ['Amazon Freevee']},
  // renamed from Apple TV+ in Oct 2025: found through its Wikipedia article so a new name can't lose it
  {name: 'Apple TV', labels: ['Apple TV+'], wiki: ['Apple TV (streaming service)', 'Apple TV+']},
  {name: 'Hulu', labels: ['Hulu'], channels: ['American Broadcasting Company', 'FX (TV channel)', 'Freeform (TV channel)']},
  {name: 'Paramount+', labels: ['Paramount+', 'CBS All Access'], channels: ['CBS', 'Showtime (TV network)', 'Comedy Central', 'MTV', 'Nickelodeon']},
  {name: 'Peacock', labels: ['Peacock TV'], wiki: ['Peacock (streaming service)'], channels: ['NBC', 'Bravo (American TV network)', 'USA Network']},
  // Canada (the app also shows HBO's shows under Crave on Canadian boxes: HBO streams on Crave there)
  {name: 'Crave', labels: ['CraveTV'], wiki: ['Crave (streaming service)'], channels: ['CTV Television Network']},
  {name: 'CBC Gem', labels: ['CBC Gem'], wiki: ['CBC Gem'], channels: ['CBC Television']},
];

// what counts as a show: television series, miniseries, animated series, web series
const TYPES = ['Q5398426', 'Q1259759', 'Q581714', 'Q526877'];

const lit = s => `"${s.replace(/"/g, '\\"')}"@en`;
const EN_WIKI = '<https://en.wikipedia.org/>';

// step A: the Wikidata IDs of every service ("s3") and of the channels it owns ("c3"), in ONE question.
// A name match only counts if something actually aired on it ("Max" is also lots of other things).
function idQuery() {
  const names = [], pages = [];
  SERVICES.forEach((svc, i) => {
    for (const l of svc.labels) names.push(`("s${i}" ${lit(l)})`);
    for (const w of svc.wiki || []) pages.push(`("s${i}" ${lit(w)})`);
    for (const c of svc.channels || []) pages.push(`("c${i}" ${lit(c)})`);
  });
  return `
SELECT DISTINCT ?k ?item WHERE {
  { VALUES (?k ?l) { ${names.join(' ')} } ?item rdfs:label|skos:altLabel ?l . FILTER EXISTS { ?x wdt:P449 ?item } }
  UNION
  { VALUES (?k ?w) { ${pages.join(' ')} } ?a schema:name ?w ; schema:isPartOf ${EN_WIKI} ; schema:about ?item . }
}`;
}

// step B: one service's shows, by ID (own = 1: the service itself, 0: a channel it owns)
function showQuery(own, chans) {
  const vals = [...own.map(q => `(wd:${q} 1)`), ...chans.map(q => `(wd:${q} 0)`)].join(' ');
  return `
SELECT DISTINCT ?show ?title ?year ?wp ?own WHERE {
  VALUES (?svc ?own) { ${vals} }
  ?show wdt:P449 ?svc .
  VALUES ?type { ${TYPES.map(t => 'wd:' + t).join(' ')} }
  ?show wdt:P31 ?type .
  ?show rdfs:label ?title . FILTER(LANG(?title) = "en")
  OPTIONAL { ?show wdt:P580 ?start }
  OPTIONAL { ?show wdt:P577 ?pub }
  BIND(YEAR(COALESCE(?start, ?pub)) AS ?year)
  OPTIONAL { ?pa schema:about ?show ; schema:isPartOf ${EN_WIKI} ; schema:name ?wp . }
}`;
}

// "Scrubs (2026)" / "Ghosts (American TV series)" -> "Scrubs" / "Ghosts" (the tag isn't part of the
// name people know; a year in it is kept as the year)
function tidyTitle(raw) {
  let title = String(raw || '').trim();
  let tagYear = 0;
  const m = title.match(/\s*\(([^()]*)\)\s*$/);
  if (m && (/^\d{4}$/.test(m[1].trim()) || /\b(mini)?series$/i.test(m[1].trim()))) {
    title = title.slice(0, m.index).trim();
    tagYear = Number(m[1].match(/\b(?:19|20)\d{2}\b/)?.[0]) || 0;
  }
  return {title, tagYear};
}

const sleep = ms => new Promise(res => setTimeout(res, ms));
async function ask(sparql, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(SPARQL, {
        method: 'POST',
        headers: {'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'query=' + encodeURIComponent(sparql),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).results.bindings;
    } catch (e) {
      console.log(`  try ${i} failed: ${e.message}`);
      if (i === tries) throw e;
      await sleep(30000 * i); // Wikidata asks us to back off: 30 s, then 60 s
    }
  }
}

// ---- 1. the shows of each service ----
// the last good list (same version): a service that can't be fetched today keeps its shows from it
let old = null;
if (existsSync('services.json')) {
  try {
    const o = JSON.parse(readFileSync('services.json', 'utf8'));
    if (o.v === V) old = o;
  } catch {}
}

console.log('finding the services and their channels...');
const ids = SERVICES.map(() => ({own: new Set(), chans: new Set()}));
for (const b of await ask(idQuery())) {
  const k = b.k.value, q = b.item.value.split('/').pop();
  const i = Number(k.slice(1));
  (k[0] === 's' ? ids[i].own : ids[i].chans).add(q);
}

const shows = new Map(); // "title|year|svc" -> {title, year, svc, wp, views?}
const counts = {};
const kept = [];
for (let s = 0; s < SERVICES.length; s++) {
  const svc = SERVICES[s];
  const {own, chans} = ids[s];
  console.log(`${svc.name}... (${own.size} service ID, ${chans.size} of ${svc.channels?.length || 0} channels found)`);
  if (svc.channels?.length && chans.size < svc.channels.length) console.log(`::warning::${svc.name}: a channel's Wikipedia page wasn't found (renamed?)`);
  let rows = null;
  if (own.size || chans.size) {
    try {
      rows = await ask(showQuery([...own], [...chans]));
    } catch {}
  } else {
    rows = []; // not found at all: left out below (with a warning)
  }
  if (rows === null) {
    // Wikidata didn't answer: keep this service's shows from the last good list
    const oi = old ? old.services.indexOf(svc.name) : -1;
    const prev = oi < 0 ? [] : old.shows.filter(x => x[2] === oi);
    for (const [title, year, , v] of prev) shows.set(`${title}|${year}|${s}`, {title, year, svc: s, wp: '', views: v});
    counts[svc.name] = prev.length;
    kept.push(svc.name);
    console.log(`::warning::${svc.name}: Wikidata didn't answer, kept ${prev.length} shows from the last list`);
    continue;
  }
  const seen = new Set();
  let fromChannels = 0;
  for (const b of rows) {
    const {title, tagYear} = tidyTitle(b.title?.value);
    if (!title) continue;
    const year = (b.year ? Number(b.year.value) || 0 : 0) || tagYear;
    const isOwn = b.own?.value === '1';
    if (!isOwn && year < CHANNEL_FROM) continue; // channel shows: recent ones only
    const id = b.show.value;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!isOwn) fromChannels++;
    shows.set(`${title}|${year}|${s}`, {title, year, svc: s, wp: b.wp?.value || ''});
  }
  counts[svc.name] = seen.size;
  console.log(`  ${seen.size} shows (${fromChannels} from its channels)`);
  await sleep(3000); // be polite to Wikidata
}
if (kept.length === SERVICES.length) throw new Error('Wikidata never answered: keeping the old list');

// ---- 2. how popular each show is (Wikipedia views, last 30 days) ----
const day = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const end = new Date(Date.now() - 86400000); // yesterday (today isn't counted yet)
const start = new Date(end.getTime() - 29 * 86400000);
const articles = [...new Set([...shows.values()].map(x => x.wp).filter(Boolean))];
const views = new Map();
let slowDowns = 0; // how often Wikimedia asked us to slow down (429)
console.log(`popularity: ${articles.length} Wikipedia pages...`);
let next = 0;
async function worker() {
  while (next < articles.length) {
    const a = articles[next++];
    const url = `${VIEWS}/${encodeURIComponent(a.replace(/ /g, '_'))}/daily/${day(start)}/${day(end)}`;
    for (let tryN = 0; tryN < 3; tryN++) {
      try {
        const r = await fetch(url, {headers: {'User-Agent': UA}});
        if (r.status === 404) break; // no views recorded
        if (r.status === 429) {
          slowDowns++;
          await sleep(2000 * (tryN + 1));
          continue;
        }
        if (!r.ok) break;
        const j = await r.json();
        views.set(a, (j.items || []).reduce((n, it) => n + (it.views || 0), 0));
        break;
      } catch {
        await sleep(1000);
      }
    }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({length: 24}, worker)); // 24 at a time (Wikimedia allows far more from a named bot)
console.log(`  views for ${views.size} pages in ${Math.round((Date.now() - t0) / 1000)} s (asked to slow down ${slowDowns} times)`);

// ---- 3. the safety check (keep the last good list if this run looks wrong) ----
const total = shows.size;
const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
const before = old ? old.shows.length : 0;
console.log(`total ${total} (last list ${before || 'n/a'})`);
if (empty.length) console.log(`::warning::no shows for ${empty.join(', ')} this time (left out)`);
if (total < 800) throw new Error(`only ${total} shows in all: keeping the old list`);
if (before && total < before * 0.7) throw new Error(`only ${total} shows (was ${before}): keeping the old list`);
if (articles.length && views.size < articles.length * 0.5) throw new Error(`views for only ${views.size} of ${articles.length} pages: keeping the old list`);

const out = {
  v: V,
  built: new Date().toISOString().slice(0, 10),
  source: "Wikidata (CC0): original broadcaster (P449), the service or a channel it owns; popularity: English Wikipedia views, last 30 days",
  services: SERVICES.map(s => s.name),
  counts,
  shows: [...shows.values()]
    .map(x => [x.title, x.year, x.svc, views.get(x.wp) || x.views || 0])
    .sort((a, b) => a[2] - b[2] || b[3] - a[3] || a[0].localeCompare(b[0])),
};
writeFileSync('services.json', JSON.stringify(out));
// the most popular per service, for the log
for (let s = 0; s < SERVICES.length; s++) {
  console.log(`${SERVICES[s].name}: ${out.shows.filter(x => x[2] === s).slice(0, 5).map(x => x[0]).join(', ')}`);
}
console.log('services.json written');
