// User-imported scores — the canonical symbolic store. When someone uploads a
// MusicXML/MIDI file, it is converted ONCE into the same validated ABC form
// the curated library uses and persisted to data/imported/. Every future
// arrangement of that song starts from this verified representation; the
// melody is never solved twice. Chords assigned by the harmonization pass are
// written back here too, so that is also solved once.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbcWork } from "./library.js";
import { parseMusicXml, unzipMxl } from "./musicxml.js";
import { parseMidi } from "./midi.js";

const IMPORTS_DIR = process.env.IMPORTS_DIR || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/imported",
);

let cache = null;

export function loadImports() {
  if (cache) return cache;
  const works = [];
  let files = [];
  try {
    files = readdirSync(IMPORTS_DIR).filter((f) => f.endsWith(".abc"));
  } catch {
    // no imports yet — that's fine
  }
  for (const file of files.sort()) {
    const id = `import-${file.replace(/\.abc$/, "")}`;
    try {
      const w = parseAbcWork(readFileSync(path.join(IMPORTS_DIR, file), "utf8"), id, { requireChords: false });
      // Partial/absent chords → null so the blueprint knows to harmonize once.
      if (!w.chords.every(Boolean)) w.chords = null;
      w.sourceType = "import";
      works.push(w);
    } catch (err) {
      console.error(`[imports] SKIPPING ${file}: ${err.message}`);
    }
  }
  cache = works;
  if (works.length) console.log(`[imports] loaded ${works.length} imported score(s) from ${IMPORTS_DIR}`);
  return cache;
}

export function getImportedWork(id) {
  return loadImports().find((w) => w.id === id) || null;
}

const norm = (s) => String(s).toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export function searchImports(query) {
  const tokens = norm(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return loadImports().filter((w) => {
    const hay = norm([w.title, w.composer, w.genre].join(" "));
    return tokens.every((t) => hay.includes(t));
  });
}

// Convert an uploaded score file (by extension) and persist it canonically.
// Returns the freshly loaded work. Throws 400-ish errors with clear reasons.
export function ingestScore(filename, buffer) {
  const base = path.basename(String(filename || ""));
  const ext = (base.toLowerCase().match(/\.(musicxml|xml|mxl|midi?)$/) || [])[1];
  if (!ext) {
    throw Object.assign(
      new Error("unsupported file type — upload .musicxml, .xml, .mxl, or .mid"),
      { status: 400 },
    );
  }

  const isMidi = ext === "mid" || ext === "midi";
  let parsed;
  if (isMidi) parsed = parseMidi(buffer);
  else if (ext === "mxl") parsed = parseMusicXml(unzipMxl(buffer));
  else parsed = parseMusicXml(buffer);

  const title = (parsed.title || base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ")).trim();
  const slug = norm(title).replace(/\s+/g, "-").slice(0, 60) || "imported-score";

  // MIDI has no engraved voice/staff separation, so the melody is guessed by
  // skyline (highest sounding note wins). That is reliable for a clearly
  // voice-led line (a hymn, a chorale, a simple tune) but can pick up
  // accompaniment or arpeggio peaks in denser piano/guitar textures — so it is
  // NOT given the same "guaranteed accurate" confidence as MusicXML, which
  // preserves the file's own melody voice explicitly. Always spot-check a MIDI
  // import against the original before trusting it.
  mkdirSync(IMPORTS_DIR, { recursive: true });
  writeFileSync(path.join(IMPORTS_DIR, `${slug}.abc`), serializeImport({
    ...parsed, title, sourceFile: base, format: isMidi ? "midi" : "musicxml",
  }), "utf8");
  cache = null;

  const work = getImportedWork(`import-${slug}`);
  if (!work) {
    throw new Error("imported score was converted but failed canonical re-validation");
  }
  return work;
}

// Persist harmonization results back into the canonical file — solved once.
export function saveImportChords(id, chords) {
  const work = getImportedWork(id);
  if (!work || !Array.isArray(chords) || chords.length !== work.measures) return;
  const file = path.join(IMPORTS_DIR, `${id.replace(/^import-/, "")}.abc`);
  writeFileSync(file, serializeImport({ ...work, chords }), "utf8");
  cache = null;
}

// Same on-disk format as data/scores so parseAbcWork reads it back.
export function serializeImport(w) {
  const isMidi = w.format === "midi";
  const lines = [
    "X:1",
    `T:${w.title}`,
    `C:${w.composer || "Imported score"}`,
    `M:${w.timeSignature}`,
    "L:1/8",
    `Q:1/4=${w.bpm || 100}`,
    `K:${w.key}`,
    `%%genre ${w.genre || "Imported score"}`,
    w.year ? `%%year ${w.year}` : null,
    w.sourceFile ? `%%source ${w.sourceFile}` : null,
    w.format ? `%%format ${w.format}` : null,
    isMidi
      ? `%%description Converted from an uploaded MIDI file — melody guessed by highest-note extraction; reliable for simple, clearly voice-led tunes but can mistake accompaniment for melody in denser textures. Spot-check before trusting.`
      : `%%description Converted from an uploaded MusicXML score — exact symbolic data.`,
  ].filter(Boolean);

  const chords = Array.isArray(w.chords) ? w.chords : [];
  const body = w.melodyMeasures.map((m, i) => (chords[i] ? `"${chords[i]}" ${m}` : m));
  for (let i = 0; i < body.length; i += 4) {
    lines.push(`${body.slice(i, i + 4).join(" | ")} |${i + 4 >= body.length ? "]" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// Shape an imported work as a search-result song.
export function importToSong(w) {
  return {
    title: w.title,
    artist: w.composer,
    year: w.year || "",
    genre: w.genre,
    key: w.key,
    timeSignature: w.timeSignature,
    bpm: w.bpm,
    mood: w.mood || "",
    description: w.description,
    source: "import",
    format: w.format || "musicxml",
    libraryId: w.id, // addressed through the same blueprint path as the library
    measures: w.measures,
  };
}
