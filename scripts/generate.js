// Generates static data/{catalogId}.json files for every GitHub-backed
// catalog in the Worker's saved config. Mirrors the Worker's own
// fetchMergedParts() / keyword-discover logic so what gets stored here is
// exactly what a live TMDB fetch would have returned — the Worker's
// sortParts()/skip-slice logic runs unchanged against whatever is in these
// files, live or generated.
//
// Usage (env vars):
//   WORKER_ORIGIN            e.g. https://tmdb-collection.freepg0099.workers.dev
//   TMDB_READ_ACCESS_TOKEN   TMDB v4 read access token
//   MODE                     'fill' (skip files that already exist) or
//                             'full' (always regenerate) — defaults to 'full'

const fs = require('fs');
const path = require('path');

const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const MODE = process.env.MODE === 'fill' ? 'fill' : 'full';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MAX_ITEMS = 500; // same cap the Worker's own keyword preview uses

if (!WORKER_ORIGIN) {
  console.error('WORKER_ORIGIN is not set — cannot fetch /export-config.');
  process.exit(1);
}
if (!TMDB_TOKEN) {
  console.error('TMDB_READ_ACCESS_TOKEN is not set.');
  process.exit(1);
}

async function tmdbFetch(pathAndQuery) {
  const res = await fetch(`https://api.themoviedb.org/3${pathAndQuery}`, {
    headers: {
      'Authorization': `Bearer ${TMDB_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB ${res.status} on ${pathAndQuery}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function fileExists(catalogId) {
  return fs.existsSync(path.join(DATA_DIR, `${catalogId}.json`));
}

function writeCatalogFile(catalogId, parts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { catalogId, generatedAt: new Date().toISOString(), parts };
  fs.writeFileSync(path.join(DATA_DIR, `${catalogId}.json`), JSON.stringify(payload));
}

// ── Collections & combined groups ───────────────────────────────────────────
// Same shape and dedupe logic as the Worker's fetchMergedParts(): fetch every
// member collection, merge, dedupe by movie id, first occurrence wins.
async function buildCollectionParts(ids) {
  const uniqueIds = [...new Set(ids)];
  const results = await Promise.allSettled(uniqueIds.map(id => tmdbFetch(`/collection/${id}`)));

  const seen = new Map();
  let anySucceeded = false;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    anySucceeded = true;
    const parts = Array.isArray(r.value.parts) ? r.value.parts : [];
    for (const p of parts) {
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
  }
  if (!anySucceeded) {
    throw new Error(`All TMDB collection fetches failed for ids: ${uniqueIds.join(',')}`);
  }
  return [...seen.values()].slice(0, MAX_ITEMS);
}

// ── Keyword lists (discover) ────────────────────────────────────────────────
// Paginates /discover the same way the Worker's handlePreviewKeyword() does,
// capped at MAX_ITEMS (25 pages * 20/page). TV items get title/release_date
// ALIASED from name/first_air_date (originals kept too) so the Worker's
// sortParts() — which only knows title/release_date/popularity/vote_average
// — sorts series catalogs correctly. Movie items already use those field
// names natively, so they need no aliasing.
//
// excludeGenres/excludeKeywords are applied here at generation time (pipe-
// separated OR, same as the Worker's live-fetch buildExcludeParams()) since
// a GitHub-backed catalog has no live TMDB connection to filter against —
// the exclusion has to already be baked into the stored file. Changing a
// GitHub-backed list's exclude filters only takes effect on the next
// regenerate (Save or Refresh Catalogue), not immediately.
function buildExcludeParams(excludeGenres, excludeKeywords) {
  let qs = '';
  if (Array.isArray(excludeGenres) && excludeGenres.length > 0) {
    qs += `&without_genres=${encodeURIComponent([...new Set(excludeGenres)].join('|'))}`;
  }
  if (Array.isArray(excludeKeywords) && excludeKeywords.length > 0) {
    qs += `&without_keywords=${encodeURIComponent([...new Set(excludeKeywords)].join('|'))}`;
  }
  return qs;
}

async function buildKeywordParts(keywordIds, mediaType, excludeGenres, excludeKeywords) {
  const endpoint = mediaType === 'series' ? '/discover/tv' : '/discover/movie';
  const keywordParam = [...new Set(keywordIds)].join(',');
  const maxPages = Math.ceil(MAX_ITEMS / 20);
  const excludeQs = buildExcludeParams(excludeGenres, excludeKeywords);

  let items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await tmdbFetch(`${endpoint}?with_keywords=${encodeURIComponent(keywordParam)}&sort_by=popularity.desc&page=${page}${excludeQs}`);
    const results = Array.isArray(data.results) ? data.results : [];
    items.push(...results);
    totalPages = Number.isFinite(data.total_pages) ? data.total_pages : page;
    page++;
  } while (page <= totalPages && page <= maxPages);

  items = items.slice(0, MAX_ITEMS);

  if (mediaType === 'series') {
    items = items.map(item => ({
      ...item,
      title: item.name,
      release_date: item.first_air_date,
    }));
  }
  return items;
}

async function main() {
  const exportUrl = `${WORKER_ORIGIN.replace(/\/+$/, '')}/export-config`;
  console.log(`Mode: ${MODE}`);
  console.log(`Fetching config from: ${exportUrl}`);

  const configRes = await fetch(exportUrl);
  if (!configRes.ok) {
    console.error(`/export-config returned HTTP ${configRes.status} — is WORKER_ORIGIN correct and is the Worker deployed with the /export-config route?`);
    process.exit(1);
  }
  const config = await configRes.json();
  const collections = Array.isArray(config.collections) ? config.collections : [];
  const keywordLists = Array.isArray(config.keywordLists) ? config.keywordLists : [];

  const githubCollections = collections.filter(c => c.source === 'github');
  const githubKeywordLists = keywordLists.filter(k => k.source === 'github');

  console.log(`Config has ${collections.length} collection(s)/group(s) total, ${githubCollections.length} marked source:"github".`);
  console.log(`Config has ${keywordLists.length} keyword list(s) total, ${githubKeywordLists.length} marked source:"github".`);

  if (githubCollections.length === 0 && githubKeywordLists.length === 0) {
    console.log('\nNothing to generate — no entries have "source": "github" set yet.');
    console.log('This is expected until you mark at least one list as GitHub-backed in /configure.');
    console.log('Raw config for reference:');
    console.log(JSON.stringify(config, null, 2));
  }

  const wanted = new Set(); // every catalogId that should exist after this run
  const errors = [];

  // Collections + combined groups — only those explicitly marked source: 'github'
  for (const c of collections) {
    if (c.source !== 'github') continue;
    const catalogId = c.groupId ? `tmdb_group_${c.groupId}` : `tmdb_collection_${c.id}`;
    const ids = c.groupId ? c.ids : [c.id];
    wanted.add(catalogId);

    if (MODE === 'fill' && fileExists(catalogId)) {
      console.log(`skip (exists, fill mode): ${catalogId}`);
      continue;
    }
    try {
      const parts = await buildCollectionParts(ids);
      writeCatalogFile(catalogId, parts);
      console.log(`wrote ${catalogId} (${parts.length} items)`);
    } catch (e) {
      errors.push(`${catalogId}: ${e.message}`);
      console.error(`FAILED ${catalogId}: ${e.message}`);
    }
  }

  // Keyword lists — 'all' expands to two catalogs (movie + series), same as
  // the Worker's keywordCatalogIds().
  for (const k of keywordLists) {
    if (k.source !== 'github') continue;
    const mediaTypes = k.mediaType === 'all' ? ['movie', 'series'] : [k.mediaType];

    for (const mediaType of mediaTypes) {
      const catalogId = `tmdb_keyword_${mediaType}_${k.keywordListId}`;
      wanted.add(catalogId);

      if (MODE === 'fill' && fileExists(catalogId)) {
        console.log(`skip (exists, fill mode): ${catalogId}`);
        continue;
      }
      try {
        const parts = await buildKeywordParts(k.keywordIds, mediaType, k.excludeGenres, k.excludeKeywords);
        writeCatalogFile(catalogId, parts);
        console.log(`wrote ${catalogId} (${parts.length} items)`);
      } catch (e) {
        errors.push(`${catalogId}: ${e.message}`);
        console.error(`FAILED ${catalogId}: ${e.message}`);
      }
    }
  }

  // Cleanup: remove data files for catalogs no longer in the config (removed
  // lists, or lists switched back to source: 'live'). Runs in both modes —
  // an orphaned file serving stale data forever is worse than a moment of
  // extra work here.
  if (fs.existsSync(DATA_DIR)) {
    for (const filename of fs.readdirSync(DATA_DIR)) {
      if (!filename.endsWith('.json')) continue;
      const catalogId = filename.slice(0, -'.json'.length);
      if (!wanted.has(catalogId)) {
        fs.unlinkSync(path.join(DATA_DIR, filename));
        console.log(`removed orphaned ${filename}`);
      }
    }
  }

  if (errors.length > 0) {
    // Non-zero exit fails the Action run visibly (shows up red in the
    // Actions tab) without discarding whatever DID succeed above — files
    // that wrote successfully are still committed by the workflow's next
    // step, only the failures are surfaced.
    console.error(`\n${errors.length} catalog(s) failed to generate:\n` + errors.join('\n'));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
