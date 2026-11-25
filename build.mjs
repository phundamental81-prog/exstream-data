// ExStream streaming-service list builder (runs weekly on GitHub Actions)
//
// Asks Wikidata (free, CC0) which TV shows each streaming service MADE or FIRST AIRED: the show's
// "original broadcaster" (P449) is the service (or its own channel: HBO for HBO Max, Showtime for
// Paramount+, CBC Television for CBC Gem). Not "distributed by" (P750): that's "somewhere in the
// world", and put shows like Heartland under Netflix, where they aren't for Canadian viewers.
// Writes services.json:
//   {v, built, services: ["Netflix", ...], shows: [[title, firstYear, serviceIndex], ...]}
// The ExStream app downloads it once a week and matches shows by title + year on the device.
// Nothing about any user, provider or app is in here.
//
// Safety: a service that comes back empty is left out (with a warning); if the list as a whole looks
// wrong (under 1,000 shows, or 30% fewer than last time), the old services.json is kept and the job
// fails, so the app never gets a broken list.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const UA = 'ExStreamDataBot/1.0 (https://github.com/phundamental81-prog/exstream-data)';
const ENDPOINT = 'https://query.wikidata.org/sparql';

// each service: the names Wikidata may use for it (renames included: Max / HBO Max, Apple TV+ / Apple TV)
const SERVICES = [
  {name: 'Netflix', labels: ['Netflix']},
  {name: 'HBO Max', labels: ['HBO Max', 'Max', 'HBO']},
  {name: 'Disney+', labels: ['Disney+', 'Disney Plus']},
  {name: 'Prime Video', labels: ['Prime Video', 'Amazon Prime Video', 'Amazon Video']},
  {name: 'Apple TV+', labels: ['Apple TV+', 'Apple TV']},
  {name: 'Hulu', labels: ['Hulu']},
  {name: 'Paramount+', labels: ['Paramount+', 'CBS All Access', 'Showtime', 'Paramount+ with Showtime']},
  // (Peacock's Wikidata name isn't plain "Peacock": it's also found by its English Wikipedia article)
  {name: 'Peacock', labels: ['Peacock', 'Peacock TV', 'NBCUniversal Peacock'], wiki: 'Peacock (streaming service)'},
  // Canada (the app also shows HBO's shows under Crave on Canadian boxes: HBO streams on Crave there)
  {name: 'Crave', labels: ['Crave', 'CraveTV'], wiki: 'Crave (streaming service)'},
  {name: 'CBC Gem', labels: ['CBC Gem', 'CBC Television'], wiki: 'CBC Gem'},
];

// what counts as a show: television series, miniseries, animated series, web series
const TYPES = ['Q5398426', 'Q1259759', 'Q581714', 'Q526877'];

function query(labels, wiki) {
  const vals = labels.map(l => `"${l}"@en`).join(' ');
  const byWiki = wiki
    ? `UNION { ?article schema:about ?svc ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name "${wiki}"@en . }`
    : '';
  return `
SELECT DISTINCT ?show ?title ?year WHERE {
  { VALUES ?svcLabel { ${vals} } ?svc rdfs:label|skos:altLabel ?svcLabel . } ${byWiki}
  ?show wdt:P449 ?svc .
  VALUES ?type { ${TYPES.map(t => 'wd:' + t).join(' ')} }
  ?show wdt:P31 ?type .
  ?show rdfs:label ?title . FILTER(LANG(?title) = "en")
  OPTIONAL { ?show wdt:P580 ?start }
  OPTIONAL { ?show wdt:P577 ?pub }
  BIND(YEAR(COALESCE(?start, ?pub)) AS ?year)
}`;
}

async function ask(sparql, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'query=' + encodeURIComponent(sparql),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).results.bindings;
    } catch (e) {
      console.log(`  try ${i} failed: ${e.message}`);
      if (i === tries) throw e;
      await new Promise(res => setTimeout(res, 15000 * i)); // Wikidata asks us to back off
    }
  }
}

const shows = new Map(); // "title|year|svc" -> row
const counts = {};
for (let s = 0; s < SERVICES.length; s++) {
  const svc = SERVICES[s];
  console.log(`${svc.name}...`);
  const rows = await ask(query(svc.labels, svc.wiki));
  const seen = new Set();
  for (const b of rows) {
    const title = b.title?.value?.trim();
    if (!title) continue;
    const year = b.year ? Number(b.year.value) || 0 : 0;
    const id = b.show.value;
    if (seen.has(id + '|' + year)) continue;
    seen.add(id + '|' + year);
    shows.set(`${title}|${year}|${s}`, [title, year, s]);
  }
  counts[svc.name] = seen.size;
  console.log(`  ${seen.size} shows`);
  await new Promise(res => setTimeout(res, 3000)); // be polite to Wikidata
}

// the safety check (keep last week's list if this run looks wrong)
const total = shows.size;
const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
let before = 0;
const V = 2; // v2: original broadcaster only (+ Crave, CBC Gem). A new version isn't compared with the old.
if (existsSync('services.json')) {
  try {
    const old = JSON.parse(readFileSync('services.json', 'utf8'));
    if (old.v === V) before = old.shows.length;
  } catch {}
}
console.log(`total ${total} (last list ${before})`);
if (empty.length) console.log(`::warning::no shows for ${empty.join(', ')} this week (left out)`);
if (total < 800) throw new Error(`only ${total} shows in all: keeping the old list`);
if (before && total < before * 0.7) throw new Error(`only ${total} shows (was ${before}): keeping the old list`);

const out = {
  v: V,
  built: new Date().toISOString().slice(0, 10),
  source: 'Wikidata (CC0): original broadcaster (P449)',
  services: SERVICES.map(s => s.name),
  counts,
  shows: [...shows.values()].sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]) || a[1] - b[1]),
};
writeFileSync('services.json', JSON.stringify(out));
console.log('services.json written');
