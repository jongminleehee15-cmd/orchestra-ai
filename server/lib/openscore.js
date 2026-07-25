// Runtime MusicXML source — OpenScore Lieder Corpus (github.com/OpenScore/Lieder),
// ~1,460 German/English/French art songs (voice + piano) engraved from IMSLP
// public-domain originals and released under CC0 (no restriction, unlike a
// research dataset's CC-BY-NC-SA terms — safe for a commercial product).
//
// Same accuracy contract as every other verified source: a score is only
// offered if its MusicXML converts through the shared parser AND passes
// bar-math validation. A Lied's own structure (a dedicated vocal part,
// separate from the piano part) is the best case for this pipeline — there is
// no melody-vs-accompaniment ambiguity to resolve, unlike a single piano staff.
//
// OpenScore's companion "String Quartets" corpus was evaluated too, but its
// scores are stored as .mscx (MuseScore's native format, not MusicXML) — a
// different schema this parser does not read — so it is not included here.

import { parseMusicXml, unzipMxl } from "./musicxml.js";

const REPO = "OpenScore/Lieder";
const BRANCH = "main";
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const FETCH_TIMEOUT_MS = 15000;

let indexPromise = null;      // one tree fetch per server process
const workCache = new Map();  // path → work | null (null = known-unusable)

async function fetchWithTimeout(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "OrchestraAI/0.1 (sheet-music arranger)", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
  return resp;
}

const norm = (s) => String(s).toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/['’]/g, "")
  .replace(/[^a-z0-9\s.]/g, " ").replace(/\s+/g, " ").trim();

// "Die_schöne_Müllerin,_D.795" → "Die schöne Müllerin, D.795".
function prettifyCollection(segment) {
  return segment.replace(/_+/g, " ").trim();
}
// Same, but also strips a leading track number ("1_Mignon..." → "Mignon...")
// since that is filing order within a collection, not part of the title. Only
// applied to the title segment — a collection's own leading digit is part of
// its real name ("7_Lieder" → "7 Lieder", i.e. a set of seven songs).
function prettifyTitle(segment) {
  return prettifyCollection(segment.replace(/\.mxl$/i, "").replace(/^\d+_/, ""));
}
// "Schubert,_Franz" → "Schubert, Franz" (kept in "Last, First" form — unambiguous
// and avoids mis-splitting multi-part surnames).
const composerName = (segment) => segment.replace(/_+/g, " ").trim();

// Turn repo paths into searchable catalog entries. Pure — unit-testable.
export function buildEntries(paths) {
  const entries = [];
  for (const p of paths) {
    const m = /^scores\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+\.mxl)$/i.exec(p);
    if (!m) continue;
    const [, composerSeg, collectionSeg, titleSeg] = m;
    const composer = composerName(composerSeg);
    const collection = collectionSeg === "_" ? "" : prettifyCollection(collectionSeg);
    const title = prettifyTitle(titleSeg);
    const label = collection ? `${collection}: ${title}` : title;
    entries.push({
      path: p,
      composer,
      label,
      hay: norm(`${composer} ${collection} ${title}`),
    });
  }
  return entries;
}

// Every query token must appear in the entry's searchable text. Pure.
export function matchEntries(entries, query, limit = 5) {
  const tokens = norm(String(query)).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return entries.filter((e) => tokens.every((t) => e.hay.includes(t))).slice(0, limit);
}

export async function loadOpenScoreIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const data = await (await fetchWithTimeout(TREE_URL)).json();
      const entries = buildEntries((data.tree || []).map((e) => e.path));
      console.log(`[openscore] indexed ${entries.length} Lieder score(s) from OpenScore/Lieder`);
      return entries;
    })().catch((err) => {
      indexPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return indexPromise;
}

// Fetch + convert one score. Only paths present in the index are fetched
// (never caller-controlled URLs). Returns null when conversion/validation
// fails — that score is simply not offered.
export async function getOpenScoreWork(path) {
  const key = String(path);
  if (workCache.has(key)) return workCache.get(key);
  const entries = await loadOpenScoreIndex();
  const entry = entries.find((e) => e.path === key);
  if (!entry) return null;

  let work = null;
  try {
    const resp = await fetchWithTimeout(RAW_BASE + key);
    const buf = Buffer.from(await resp.arrayBuffer());
    const parsed = parseMusicXml(unzipMxl(buf));
    const rawTitle = String(parsed.title || "").trim();
    work = {
      id: `openscore-${key}`,
      corpusId: key,
      title: rawTitle || entry.label,
      composer: entry.composer, // OpenScore's own creator tagging is inconsistent (see musicxml.js note); the catalog name is reliable
      key: parsed.key,
      timeSignature: parsed.timeSignature,
      bpm: parsed.bpm,
      measures: parsed.melodyMeasures.length,
      melodyMeasures: parsed.melodyMeasures,
      melodyAbc: `${parsed.melodyMeasures.join(" | ")} |]`,
      chords: null, // engraved parts carry no chord symbols — harmonized once, cached
      genre: "Art song (Lied) — engraved score",
      mood: "",
      description: `Melody converted note-for-note from an engraved MusicXML score (OpenScore Lieder Corpus, CC0: ${key}).`,
      sourceUrl: `https://github.com/${REPO}/blob/${BRANCH}/${key}`,
      sourceType: "corpus",
    };
  } catch (err) {
    console.warn(`[openscore] ${key}: ${err.message}`);
  }
  workCache.set(key, work);
  return work;
}

// Search the catalog; fetch + validate each candidate up front so every card
// shown to the user is guaranteed usable.
export async function searchOpenScore(query) {
  const entries = await loadOpenScoreIndex();
  const matches = matchEntries(entries, query, 6);
  const works = await Promise.all(matches.map((m) => getOpenScoreWork(m.path).catch(() => null)));
  return works.filter(Boolean).slice(0, 4).map(openScoreToSong);
}

export function openScoreToSong(w) {
  return {
    title: w.title,
    artist: w.composer,
    year: "",
    genre: w.genre,
    key: w.key,
    timeSignature: w.timeSignature,
    bpm: w.bpm,
    mood: w.mood,
    description: w.description,
    source: "corpus",
    corpusId: w.corpusId,
    measures: w.measures,
  };
}
