// Runtime MusicXML source — engraved public-domain scores fetched on demand.
// The music21 corpus (github.com/cuthbertLab/music21) is the one large
// MusicXML collection with a stable, legally fetchable URL scheme: ~650
// professionally engraved public-domain works (Bach chorales, Beethoven and
// Mozart chamber music, Haydn, Monteverdi madrigals, Schumann, Joplin…).
//
// Same accuracy contract as every other verified source: a score is only
// offered if its MusicXML converts through the shared parser AND passes
// bar-math validation. The pipeline then uses the melody VERBATIM.

import { parseMusicXml, unzipMxl } from "./musicxml.js";

const REPO = "cuthbertLab/music21";
const BRANCH = "master";
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const FETCH_TIMEOUT_MS = 15000;
const SKIP_DIRS = new Set(["demos", "theoryExercises"]); // not real repertoire

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

// "opus18no1" → "opus 18 no 1", "bwv66.6" → "bwv 66.6", "movement1" → "movement 1"
function prettify(segment) {
  return segment
    .replace(/\.(mxl|xml|musicxml)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .trim();
}
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bBwv\b/g, "BWV");

// Turn repo paths into searchable catalog entries. Pure — unit-testable.
export function buildEntries(paths) {
  const entries = [];
  for (const p of paths) {
    const m = /^music21\/corpus\/(.+\.(mxl|xml|musicxml))$/i.exec(p);
    if (!m) continue;
    const segs = m[1].split("/");
    if (SKIP_DIRS.has(segs[0])) continue;
    const composer = titleCase(prettify(segs[0].replace(/_/g, " ")));
    const workLabel = titleCase(segs.slice(1).map(prettify).join(" — "));
    entries.push({
      path: p,
      composer,
      label: workLabel,
      hay: norm(`${composer} ${segs.slice(1).map(prettify).join(" ")}`),
    });
  }
  return entries;
}

// Every query token must appear in the entry's searchable text. The query
// gets the same letter↔digit splitting as the catalog ("bwv66.6" → "bwv 66.6")
// so both spellings match. Pure.
export function matchEntries(entries, query, limit = 5) {
  const tokens = norm(prettify(String(query))).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return entries.filter((e) => tokens.every((t) => e.hay.includes(t))).slice(0, limit);
}

export async function loadCorpusIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const data = await (await fetchWithTimeout(TREE_URL)).json();
      const entries = buildEntries((data.tree || []).map((e) => e.path));
      console.log(`[corpus] indexed ${entries.length} MusicXML score(s) from the music21 corpus`);
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
export async function getCorpusWork(path) {
  const key = String(path);
  if (workCache.has(key)) return workCache.get(key);
  const entries = await loadCorpusIndex();
  const entry = entries.find((e) => e.path === key);
  if (!entry) return null;

  let work = null;
  try {
    const resp = await fetchWithTimeout(RAW_BASE + key);
    const buf = Buffer.from(await resp.arrayBuffer());
    const parsed = /\.mxl$/i.test(key) ? parseMusicXml(unzipMxl(buf)) : parseMusicXml(buf);
    // Some corpus files carry their FILENAME as the movement title — prefer
    // the prettified catalog label over anything that looks like a file.
    const rawTitle = String(parsed.title || "").trim();
    const goodTitle = rawTitle && !/\.(mxl|xml|musicxml)$/i.test(rawTitle);
    work = {
      id: `corpus-${key}`,
      corpusId: key,
      title: goodTitle ? rawTitle : `${entry.composer}: ${entry.label}`,
      composer: parsed.composer || entry.composer,
      key: parsed.key,
      timeSignature: parsed.timeSignature,
      bpm: parsed.bpm,
      measures: parsed.melodyMeasures.length,
      melodyMeasures: parsed.melodyMeasures,
      melodyAbc: `${parsed.melodyMeasures.join(" | ")} |]`,
      chords: null, // engraved parts carry no chord symbols — harmonized once, cached
      genre: "Classical (engraved score)",
      mood: "",
      description: `Melody converted note-for-note from an engraved MusicXML score (music21 corpus: ${key.replace("music21/corpus/", "")}).`,
      sourceUrl: `https://github.com/${REPO}/blob/${BRANCH}/${key}`,
      sourceType: "corpus",
    };
  } catch (err) {
    console.warn(`[corpus] ${key}: ${err.message}`);
  }
  workCache.set(key, work);
  return work;
}

// Search the catalog; fetch + validate each candidate up front so every card
// shown to the user is guaranteed usable.
export async function searchCorpus(query) {
  const entries = await loadCorpusIndex();
  const matches = matchEntries(entries, query, 5);
  const works = await Promise.all(matches.map((m) => getCorpusWork(m.path).catch(() => null)));
  return works.filter(Boolean).slice(0, 4).map(corpusToSong);
}

export function corpusToSong(w) {
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
