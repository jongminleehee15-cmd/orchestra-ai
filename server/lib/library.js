// The public-domain score library — the app's source of REAL symbolic melody
// data. Works live in data/scores/*.abc (standard ABC with inline "chord"
// annotations and %% metadata directives). The arrangement pipeline consumes
// these melodies VERBATIM: for library works the model never recalls notes
// from memory, it only plans orchestration around them.
//
// Curation rules (see ENGINE_NOTES.md): L:1/8, melody starts on the downbeat
// (no anacrusis in v1), one file = one work in its customary key, every bar
// sums to the meter, chords annotated per measure ("C" or "C G" when the
// harmony moves mid-bar).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMelody, splitMelodyIntoMeasures } from "./abcMelody.js";

const SCORES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/scores",
);

let cache = null; // [{ id, title, composer, ...work }]

// Parse one .abc file into a work record. Throws with a descriptive message on
// malformed input — the loader surfaces these at startup so bad data never
// silently enters the catalog.
export function parseAbcWork(text, id) {
  const headers = {};
  const meta = {};
  const bodyLines = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const metaMatch = line.match(/^%%(\w+)\s+(.*)$/);
    if (metaMatch) { meta[metaMatch[1]] = metaMatch[2].trim(); continue; }
    if (line.startsWith("%")) continue; // plain comment
    const headMatch = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (headMatch && !line.includes("|")) { headers[headMatch[1]] = headMatch[2].trim(); continue; }
    bodyLines.push(line);
  }

  if (!headers.T) throw new Error(`${id}: missing T: title header`);
  if ((headers.L || "").replace(/\s/g, "") !== "1/8") {
    throw new Error(`${id}: L: must be 1/8 (got "${headers.L}") — the whole pipeline assumes eighth-note units`);
  }

  const body = bodyLines.join(" ");
  const rawMeasures = splitMelodyIntoMeasures(body);

  // Pull the chord annotation(s) out of each measure; what remains is the
  // clean melody. Multiple annotations in one bar join to "C G" style strings.
  const chords = [];
  const melodyMeasures = rawMeasures.map((m) => {
    const anns = [...m.matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean);
    chords.push(anns.join(" "));
    return m.replace(/"[^"]*"/g, "").replace(/\s+/g, " ").trim();
  });

  const timeSignature = headers.M || "4/4";
  const melodyAbc = `${melodyMeasures.join(" | ")} |]`;
  const analysis = analyzeMelody(melodyAbc, timeSignature, melodyMeasures.length);
  if (!analysis.ok) {
    throw new Error(`${id}: melody failed bar-math validation — ${analysis.problems.join("; ")}`);
  }
  if (chords.some((c) => !c)) {
    const missing = chords.map((c, i) => (c ? null : i + 1)).filter(Boolean);
    throw new Error(`${id}: measures ${missing.join(", ")} have no chord annotation`);
  }

  const bpmMatch = (headers.Q || "").match(/=\s*(\d+)/);

  return {
    id,
    title: headers.T,
    composer: headers.C || "Traditional",
    key: (headers.K || "C").split(/\s/)[0],
    timeSignature,
    bpm: bpmMatch ? parseInt(bpmMatch[1], 10) : 100,
    measures: melodyMeasures.length,
    melodyMeasures,
    melodyAbc,
    chords,
    year: meta.year || "",
    genre: meta.genre || "Traditional",
    mood: meta.mood || "",
    description: meta.description || "",
    aliases: (meta.aliases || "").split(";").map((s) => s.trim()).filter(Boolean),
  };
}

export function loadLibrary() {
  if (cache) return cache;
  const works = [];
  let files = [];
  try {
    files = readdirSync(SCORES_DIR).filter((f) => f.endsWith(".abc"));
  } catch {
    console.warn(`[library] scores directory not found at ${SCORES_DIR}`);
  }
  for (const file of files.sort()) {
    const id = file.replace(/\.abc$/, "");
    try {
      works.push(parseAbcWork(readFileSync(path.join(SCORES_DIR, file), "utf8"), id));
    } catch (err) {
      // A bad file must be loud (it violates the accuracy promise) but must
      // not take the whole catalog down.
      console.error(`[library] SKIPPING ${file}: ${err.message}`);
    }
  }
  cache = works;
  console.log(`[library] loaded ${works.length} public-domain work(s) from ${SCORES_DIR}`);
  return cache;
}

export function getWork(id) {
  return loadLibrary().find((w) => w.id === id) || null;
}

// Diacritic/punctuation-insensitive search: every query token must appear in
// the work's searchable text (title + composer + aliases + genre).
const norm = (s) => String(s).toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export function searchLibrary(query) {
  const tokens = norm(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return loadLibrary().filter((w) => {
    const hay = norm([w.title, w.composer, w.genre, ...w.aliases].join(" "));
    return tokens.every((t) => hay.includes(t));
  });
}

// Shape a work as a search-result "song" the existing frontend understands,
// plus the fields that mark it as exact library data.
export function workToSong(w) {
  return {
    title: w.title,
    artist: w.composer,
    year: w.year,
    genre: w.genre,
    key: w.key,
    timeSignature: w.timeSignature,
    bpm: w.bpm,
    mood: w.mood,
    description: w.description,
    source: "library",
    libraryId: w.id,
    measures: w.measures,
  };
}
