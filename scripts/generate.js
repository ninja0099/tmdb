// Generates static data/{catalogId}.json files for every GitHub-backed
// catalog in the Worker's saved config — TMDB collections, combined
// (multi-collection) groups, keyword-based discover lists, and fully
// custom multi-filter Discover lists (genre/keyword/company/release-type/
// collection include+exclude). Mirrors the Worker's own fetchMergedParts()
// / keyword-discover / discover-filter logic exactly so what gets stored
// here is indistinguishable from what a live TMDB fetch would have
// returned — the Worker's sortParts()/skip-slice logic runs unchanged
// against whatever is in these files, live or generated.
//
// Usage (env vars):
//   WORKER_ORIGIN            e.g. https://tmdb-collection.freepg0099.workers.dev
//   TMDB_READ_ACCESS_TOKEN   TMDB v4 read access token
//   MODE                     'fill' (only generate missing/changed lists) or
//                             'full' (always regenerate everything) — defaults
//                             to 'full'
//
// "fill" mode does NOT mean "only brand new lists" — it means "only lists
// whose generation-relevant config has actually changed since they were last
// generated." Each data file stores a sourceHash fingerprint of the inputs
// that affect its content (member ids/keywords + exclude filters — NOT sort,
// since sort is applied client-side by the Worker against the stored raw
// parts, so a sort-only edit never needs a regenerate). A missing file has no
// hash to match, so it's generated same as before; an existing file whose
// current config hashes differently than what's stored is now ALSO
// regenerated, not skipped — this is what makes "I added a keyword to an
// existing list" or "I changed its exclude filters" actually take effect on
// the next Save, instead of silently waiting for the next full regenerate.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const MODE = process.env.MODE === 'fill' ? 'fill' : 'full';
const DEFAULT_SORT = 'release_asc';

const SORT_BY_MOVIE = {
  release_desc:    'primary_release_date.desc',
  release_asc:     'primary_release_date.asc',
  popularity_desc: 'popularity.desc',
  vote_desc:       'vote_average.desc',
  title_asc:       'original_title.asc',
};
const SORT_BY_TV = {
  release_desc:    'first_air_date.desc',
  release_asc:     'first_air_date.asc',
  popularity_desc: 'popularity.desc',
  vote_desc:       'vote_average.desc',
  title_asc:       'popularity.desc',
};

function discoverSortBy(entry, mediaType) {
  const sortMap = mediaType === 'series' ? SORT_BY_TV : SORT_BY_MOVIE;
  return sortMap[entry.sort] || sortMap[DEFAULT_SORT];
}
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

// Fingerprints exactly the inputs that change what gets fetched from TMDB.
// Order-independent (sorts arrays before hashing) so re-adding the same
// members in a different order, or the config round-tripping through
// JSON in a different key order, doesn't produce a spurious "changed"
// result and trigger a needless regenerate.
function computeSourceHash(inputs) {
  const normalized = JSON.stringify(inputs, (key, value) => {
    if (Array.isArray(value)) return [...value].sort();
    return value;
  });
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function readExistingHash(catalogId) {
  const filePath = path.join(DATA_DIR, `${catalogId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.sourceHash || null;
  } catch (e) {
    return null; // corrupt/unreadable file — treat as "no hash," so it regenerates
  }
}

function writeCatalogFile(catalogId, parts, sourceHash) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { catalogId, generatedAt: new Date().toISOString(), sourceHash, parts };
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
  // Pipe-separated (OR), not comma (AND) — TMDB's with_keywords treats
  // commas as "must have ALL of these keywords," which returns zero results
  // for almost any multi-keyword include list. Same fix as the Worker's own
  // fetchDiscoverPage()/handlePreviewKeyword() — see worker.js for the full
  // explanation.
  const keywordParam = [...new Set(keywordIds)].join('|');
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

// ── Discover lists (4th Worker page) ────────────────────────────────────────
// Mirrors the Worker's buildIncludeParams()/buildDiscoverExcludeParams()/
// fetchDiscoverFilteredPage() exactly — every include/exclude id list joins
// with a pipe (OR), Release Type and "part of collection" are movie-only
// and silently omitted for series, and collection membership is a
// post-filter (fetched separately, since TMDB's /discover has no native
// "belongs to collection" parameter at all).
//
// Unlike the Worker (which caches a collection's member-id set in KV across
// many separate requests), this script fetches each needed collection's
// member ids fresh once per run — there's no persistent cache here, but
// that's fine: this only runs once per scheduled/triggered generation, not
// once per Stremio catalog request.
function buildDiscoverIncludeParams(entry, mediaType) {
  let qs = '';
  const includeGenres = entry.includeGenres || [];
  const includeKeywords = entry.includeKeywords || [];
  const includeCompanies = entry.includeCompanies || [];
  const includeReleaseTypes = entry.includeReleaseTypes || [];
  if (includeGenres.length > 0) qs += `&with_genres=${encodeURIComponent([...new Set(includeGenres)].join('|'))}`;
  if (includeKeywords.length > 0) qs += `&with_keywords=${encodeURIComponent([...new Set(includeKeywords)].join('|'))}`;
  if (includeCompanies.length > 0) qs += `&with_companies=${encodeURIComponent([...new Set(includeCompanies)].join('|'))}`;
  if (mediaType !== 'series' && includeReleaseTypes.length > 0) {
    qs += `&with_release_type=${encodeURIComponent([...new Set(includeReleaseTypes)].join('|'))}`;
  }
  return qs;
}

function buildDiscoverExcludeParams(entry) {
  let qs = '';
  const excludeGenres = entry.excludeGenres || [];
  const excludeKeywords = entry.excludeKeywords || [];
  const excludeCompanies = entry.excludeCompanies || [];
  if (excludeGenres.length > 0) qs += `&without_genres=${encodeURIComponent([...new Set(excludeGenres)].join('|'))}`;
  if (excludeKeywords.length > 0) qs += `&without_keywords=${encodeURIComponent([...new Set(excludeKeywords)].join('|'))}`;
  if (excludeCompanies.length > 0) qs += `&without_companies=${encodeURIComponent([...new Set(excludeCompanies)].join('|'))}`;
  return qs;
}

async function fetchCollectionIdSetOnce(collectionIds) {
  if (!collectionIds || collectionIds.length === 0) return new Set();
  const uniqueIds = [...new Set(collectionIds)];
  const results = await Promise.allSettled(uniqueIds.map(id => tmdbFetch(`/collection/${id}`)));
  const idSet = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const parts = Array.isArray(r.value.parts) ? r.value.parts : [];
    for (const p of parts) idSet.add(p.id);
  }
  return idSet;
}

// Like fetchCollectionIdSetOnce but returns the raw parts[] (full movie
// objects with title/release_date/popularity) — needed for OR-mode include
// handling where the collection's parts are one of the OR'd sources and
// have to be sorted alongside the /discover results.
async function fetchCollectionPartsOnce(collectionIds) {
  if (!collectionIds || collectionIds.length === 0) return [];
  const uniqueIds = [...new Set(collectionIds)];
  const results = await Promise.allSettled(uniqueIds.map(id => tmdbFetch(`/collection/${id}`)));
  const parts = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    if (Array.isArray(r.value.parts)) parts.push(...r.value.parts);
  }
  return parts;
}

async function buildDiscoverParts(entry, mediaType) {
  const endpoint = mediaType === 'series' ? '/discover/tv' : '/discover/movie';
  const excludeQs = buildDiscoverExcludeParams(entry);
  const maxPages = Math.ceil(MAX_ITEMS / 20);

  // Mirrors the Worker's fetchDiscoverFilteredPage exactly — see that
  // function for the full source/dedup rationale. The only differences:
  // no KV cache here, and a hard MAX_ITEMS cap instead of skip/slice.
  const includeCollections = entry.includeCollections || [];
  const excludeCollections = entry.excludeCollections || [];
  const includeGenres = entry.includeGenres || [];
  const includeKeywords = entry.includeKeywords || [];
  const includeCompanies = entry.includeCompanies || [];
  const includeReleaseTypes = entry.includeReleaseTypes || [];

  // includeReleaseTypes is intentionally NOT a separate OR source: it's a
  // narrowing constraint (e.g. "Theatrical" should reduce matches, not
  // explode them), so it gets AND'd into every discover source AND into
  // AND-mode's combined call (via buildDiscoverIncludeParams). This matches
  // user expectation — "DC movies that had a theatrical release" should
  // narrow, not OR-broaden to "any theatrical release".
  const releaseTypeQs = (mediaType !== 'series' && includeReleaseTypes.length > 0)
    ? `&with_release_type=${encodeURIComponent([...new Set(includeReleaseTypes)].join('|'))}`
    : '';

  const sources = [];
  if (includeGenres.length > 0) {
    sources.push({ kind: 'discover', qs: `&with_genres=${encodeURIComponent([...new Set(includeGenres)].join('|'))}${releaseTypeQs}` });
  }
  if (includeKeywords.length > 0) {
    sources.push({ kind: 'discover', qs: `&with_keywords=${encodeURIComponent([...new Set(includeKeywords)].join('|'))}${releaseTypeQs}` });
  }
  if (includeCompanies.length > 0) {
    sources.push({ kind: 'discover', qs: `&with_companies=${encodeURIComponent([...new Set(includeCompanies)].join('|'))}${releaseTypeQs}` });
  }
  if (mediaType !== 'series' && entry.includeMode === 'or' && includeCollections.length > 0) {
    sources.push({ kind: 'collection', ids: includeCollections });
  }

  const andMode = entry.includeMode === 'and';
  const allIncludeQs = andMode ? buildDiscoverIncludeParams(entry, mediaType) : null;

  const dedup = new Map();
  const excludeSet = await fetchCollectionIdSetOnce(excludeCollections);

  if (andMode || sources.length === 0) {
    let page = 1;
    let totalPages = 1;
    do {
      const includeStr = andMode ? allIncludeQs.replace(/^&/, '') : '';
      const sortBy = discoverSortBy(entry, mediaType);
      const path = `${endpoint}?${includeStr}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}`;
      const data = await tmdbFetch(path);
      for (const item of (data.results || [])) if (!dedup.has(item.id)) dedup.set(item.id, item);
      totalPages = Number.isFinite(data.total_pages) ? data.total_pages : page;
      page++;
    } while (page <= totalPages && page <= maxPages && dedup.size < MAX_ITEMS);
  } else {
    for (const src of sources) {
      if (src.kind === 'collection') {
        const parts = await fetchCollectionPartsOnce(src.ids);
        for (const p of parts) if (!dedup.has(p.id)) dedup.set(p.id, p);
      }
    }
    const discoverSources = sources.filter(s => s.kind === 'discover');
    let page = 1;
    let totalPages = 1;
    do {
      const round = await Promise.all(discoverSources.map(src => {
        const sortBy = discoverSortBy(entry, mediaType);
        const path = `${endpoint}?${src.qs.replace(/^&/, '')}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}`;
        return tmdbFetch(path);
      }));
      let maxTotal = page;
      for (const data of round) {
        maxTotal = Math.max(maxTotal, Number.isFinite(data.total_pages) ? data.total_pages : page);
        for (const item of (data.results || [])) if (!dedup.has(item.id)) dedup.set(item.id, item);
      }
      totalPages = maxTotal;
      page++;
    } while (page <= totalPages && page <= maxPages && dedup.size < MAX_ITEMS);
  }

  let items = [...dedup.values()];
  if (excludeSet.size > 0) items = items.filter(p => !excludeSet.has(p.id));

  if (andMode && mediaType !== 'series' && includeCollections.length > 0) {
    const includeSet = await fetchCollectionIdSetOnce(includeCollections);
    if (includeSet.size > 0) items = items.filter(p => includeSet.has(p.id));
  }

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
  const discoverLists = Array.isArray(config.discoverLists) ? config.discoverLists : [];

  const githubCollections = collections.filter(c => c.source === 'github');
  const githubKeywordLists = keywordLists.filter(k => k.source === 'github');
  const githubDiscoverLists = discoverLists.filter(d => d.source === 'github');

  console.log(`Config has ${collections.length} collection(s)/group(s) total, ${githubCollections.length} marked source:"github".`);
  console.log(`Config has ${keywordLists.length} keyword list(s) total, ${githubKeywordLists.length} marked source:"github".`);
  console.log(`Config has ${discoverLists.length} discover list(s) total, ${githubDiscoverLists.length} marked source:"github".`);

  if (githubCollections.length === 0 && githubKeywordLists.length === 0 && githubDiscoverLists.length === 0) {
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

    const sourceHash = computeSourceHash({ ids });
    if (MODE === 'fill' && readExistingHash(catalogId) === sourceHash) {
      console.log(`skip (unchanged, fill mode): ${catalogId}`);
      continue;
    }
    try {
      const parts = await buildCollectionParts(ids);
      writeCatalogFile(catalogId, parts, sourceHash);
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

      // mediaType is included so switching a list between movie/series/all
      // also triggers a regenerate (different /discover endpoint entirely,
      // not just a different filter on the same data).
      const sourceHash = computeSourceHash({
        keywordIds: k.keywordIds,
        mediaType,
        excludeGenres: k.excludeGenres || [],
        excludeKeywords: k.excludeKeywords || [],
      });
      if (MODE === 'fill' && readExistingHash(catalogId) === sourceHash) {
        console.log(`skip (unchanged, fill mode): ${catalogId}`);
        continue;
      }
      try {
        const parts = await buildKeywordParts(k.keywordIds, mediaType, k.excludeGenres, k.excludeKeywords);
        writeCatalogFile(catalogId, parts, sourceHash);
        console.log(`wrote ${catalogId} (${parts.length} items)`);
      } catch (e) {
        errors.push(`${catalogId}: ${e.message}`);
        console.error(`FAILED ${catalogId}: ${e.message}`);
      }
    }
  }

  // Discover lists (4th Worker page) — 'all' expands to two catalogs (movie
  // + series), same as keyword lists. The source hash covers every filter
  // field across all 5 dimensions plus mediaType (since switching movie/
  // series/all changes which /discover endpoint is hit entirely) — but
  // deliberately NOT sort, for the same reason as everywhere else in this
  // script: sort is applied client-side by the Worker against the stored
  // raw parts, so a sort-only edit never needs a regenerate.
  for (const dl of discoverLists) {
    if (dl.source !== 'github') continue;
    const mediaTypes = dl.mediaType === 'all' ? ['movie', 'series'] : [dl.mediaType];

    for (const mediaType of mediaTypes) {
      const catalogId = `tmdb_discover_${mediaType}_${dl.discoverListId}`;
      wanted.add(catalogId);

      const sourceHash = computeSourceHash({
        mediaType,
        includeMode: dl.includeMode || 'or',
        includeGenres: dl.includeGenres || [],
        excludeGenres: dl.excludeGenres || [],
        includeKeywords: dl.includeKeywords || [],
        excludeKeywords: dl.excludeKeywords || [],
        includeCompanies: dl.includeCompanies || [],
        excludeCompanies: dl.excludeCompanies || [],
        includeReleaseTypes: dl.includeReleaseTypes || [],
        includeCollections: dl.includeCollections || [],
        excludeCollections: dl.excludeCollections || [],
      });
      if (MODE === 'fill' && readExistingHash(catalogId) === sourceHash) {
        console.log(`skip (unchanged, fill mode): ${catalogId}`);
        continue;
      }
      try {
        const parts = await buildDiscoverParts(dl, mediaType);
        writeCatalogFile(catalogId, parts, sourceHash);
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
