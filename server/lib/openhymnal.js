// Runtime ABC source — the Open Hymnal Project (github.com/mzealey/openhymnal,
// mirroring the now-defunct openhymnal.org), ~300 public-domain Christian
// hymns as multi-voice "ABC Plus" (abcm2ps-flavored) scores with full SATB
// harmony, not just a melody line.
//
// This is a DIFFERENT ABC dialect from the hand-curated library's (see
// server/lib/library.js — single voice, L:1/8). These files are multi-voice
// (V:/%%staves), typically L:1/4, and use abcm2ps-specific decorations. The
// top/soprano voice — always the first one declared, standard SATB engraving
// convention — is extracted as the melody and re-encoded into the pipeline's
// canonical L:1/8 form via the same eventsToMeasures() engine musicxml.js and
// midi.js use. Same accuracy contract as every other verified source: only
// offered if it converts AND passes bar-math validation.
//
// License gate: unlike a single-license MusicXML corpus, this project's own
// inclusion policy is "public domain OR freely distributable" (its README),
// which is not uniformly commercial-safe. Every file carries a
// "C: copyright: ..." line; a work is only offered here if that line contains
// "public domain" — checked against a spread sample of the collection at
// integration time (~95%+ pass). Anything else (e.g. "freely distributable
// for worship use") is silently skipped, never offered.
//
// Reliability caveat: the ORIGINAL openhymnal.org site appears defunct (its
// TLS cert resolves to an unrelated domain) and this GitHub mirror is one
// person's personal fork, last touched in 2017 — fork it to a repo you
// control before depending on it long-term; a stranger's dormant account is a
// weaker foundation than music21/OpenScore's institutional homes.
//
// Known simplification: the melody voice is always "whichever voice is
// declared first" — correct for standard SATB (soprano on top) but not
// re-verified per file. A wrong pick would still be real, valid music (just
// not literally the tune), and would still need to pass bar-math validation.
//
// Known false-negative in the license gate: a handful of files split the
// copyright note across multiple "C:" lines — e.g. "C: copyright: Words:
// Copyright 2011, ...  All other rights reserved." followed by a separate
// "C: Music and Setting: public domain." line. isPublicDomain() only reads
// the first matching line, so it rejects these even though the MUSIC is
// genuinely PD (~2% of a sampled spread, verified by hand). Erring toward
// rejecting a usable hymn is the safe direction — left as-is rather than
// building a more elaborate multi-line scan for a rare case.

import { eventsToMeasures, keyAlters, midiOf, STEP_SEMIS } from "./symbolic.js";
import { splitMelodyIntoMeasures, analyzeMelody } from "./abcMelody.js";

const REPO = "mzealey/openhymnal"; // TODO: point at your own fork once made (see caveat above)
const BRANCH = "master";
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

// "A_Mighty_Fortress_Is_Our_God-Ein_Feste_Burg_Rhythmic.abc" → title "A Mighty
// Fortress Is Our God", tune "Ein Feste Burg Rhythmic". Only the title is
// shown; the tune name (after the first "-") disambiguates multiple settings
// of the same hymn text (kept in `hay` so it's still searchable).
function prettify(segment) {
  return segment.replace(/\.abc$/i, "").replace(/_+/g, " ").trim();
}

// Turn repo paths into searchable catalog entries. Pure — unit-testable.
export function buildEntries(paths) {
  const entries = [];
  for (const p of paths) {
    const m = /^Complete\/([^/]+)\/([^/]+\.abc)$/i.exec(p);
    if (!m) continue;
    const [, folderSeg, fileSeg] = m;
    const title = prettify(folderSeg);
    const fileBase = fileSeg.replace(/\.abc$/i, "");
    const tune = fileBase.startsWith(folderSeg) ? prettify(fileBase.slice(folderSeg.length).replace(/^-/, "")) : prettify(fileBase);
    entries.push({
      path: p,
      title,
      tune,
      label: tune ? `${title} (${tune})` : title,
      hay: norm(`${title} ${tune}`),
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

export async function loadOpenHymnalIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const data = await (await fetchWithTimeout(TREE_URL)).json();
      const entries = buildEntries((data.tree || []).map((e) => e.path));
      console.log(`[openhymnal] indexed ${entries.length} hymn(s) from the Open Hymnal Project`);
      return entries;
    })().catch((err) => {
      indexPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return indexPromise;
}

// ── ABC (multi-voice, "ABC Plus") → canonical melody conversion ─────────────

const MAJOR_KEYS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINOR_KEYS = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"];

// "Eb" / "Am" / "F#" (trailing " % comment" already stripped by the caller) →
// fifths for keyAlters(). Modal spellings (e.g. "Ador") fall back to 0 (C/Am)
// rather than guessing wrong — rare in this repertoire, and a wrong guess
// here isn't caught by bar-math validation (it only checks duration, not
// pitch spelling), so a silent fallback is safer than a silent misspelling.
export function keyStringToFifths(raw) {
  // Fully anchored (not just a prefix match): "Ddor" or "bogus" must not
  // parse as a plausible-looking prefix ("D", or "B" via the a-g lowercase
  // range) with the rest silently ignored — either falls back to 0 instead.
  const m = /^([A-Ga-g])([#b]?)(m(?:in(?:or)?)?)?$/.exec(String(raw || "C").trim());
  if (!m) return 0;
  const key = m[1].toUpperCase() + (m[2] || "") + (m[3] ? "m" : "");
  const table = m[3] ? MINOR_KEYS : MAJOR_KEYS;
  const idx = table.indexOf(key);
  return idx === -1 ? 0 : idx - 7;
}

// A note/rest length suffix (e.g. "", "2", "/2", "/", "3/2") → a multiple of
// the file's unit note length (L:). Mirrors abcMelody.js's private parseLen.
function parseAbcLen(s) {
  if (!s) return 1;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\/+$/.test(s)) return 1 / Math.pow(2, s.length);
  const m = s.match(/^(\d*)\/(\d+)$/);
  if (m) return (m[1] ? parseInt(m[1], 10) : 1) / parseInt(m[2], 10);
  return 1;
}

// Strip a trailing "% comment" (but not a leading "%%directive" line, which
// callers check for separately) and normalize whitespace.
function stripComment(line) {
  return line.replace(/(?<!%)%(?!%).*$/, "").trim();
}

// Only offered if the file itself asserts its MUSIC is public domain. Every
// sampled file uses a "C: copyright: ..." line for this; a work with no such
// line, or one that doesn't say "public domain" (e.g. a restricted "freely
// distributable for worship use" grant), is rejected — fail closed.
export function isPublicDomain(text) {
  const m = /^C:\s*copyright:\s*(.*)$/im.exec(text);
  return Boolean(m && /public domain/i.test(m[1]));
}

// Matches one note/rest/chord token plus its optional length suffix: a
// bracketed chord "[GB]2", a plain note "^F/4", or a rest "z2".
const TOKEN_RE = /(\[[^\]]*\])(\d+\/\d+|\d+|\/\d+|\/+)?|([_^=]*)([A-Ga-g])([,']*)(\d+\/\d+|\d+|\/\d+|\/+)?|([xzXZ])(\d+\/\d+|\d+|\/\d+|\/+)?/g;

function pitchFromMatch(acc, letter, octMarks) {
  const step = letter.toUpperCase();
  const alterMarks = (acc.match(/\^/g) || []).length - (acc.match(/_/g) || []).length;
  const explicit = acc.length > 0; // includes "=" (natural) — length>0 either way
  const isLower = letter === letter.toLowerCase() && letter !== letter.toUpperCase();
  const apostrophes = (octMarks.match(/'/g) || []).length;
  const commas = (octMarks.match(/,/g) || []).length;
  const octave = (isLower ? 5 : 4) + apostrophes - commas;
  return { step, explicitAlter: explicit ? alterMarks : null, octave };
}

// Parse one already-cleaned measure (decorations/grace-notes/chord-symbols/
// slur-parens already stripped by the caller) into eighth-unit events for
// eventsToMeasures(). `barState` carries accidental carry-over within the
// measure (reset by the caller between measures, per standard notation).
// Returns null if the measure contains something this parser doesn't
// understand (tuplets, broken rhythm) — the caller rejects the whole work
// rather than risk a silently wrong duration.
export function tokenizeMeasure(measureText, unitEighths, fifths, barState) {
  if (/\(\d/.test(measureText) || /[<>]/.test(measureText)) return null; // tuplet / broken rhythm — not handled
  const keyAlt = keyAlters(fifths);
  const events = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(measureText)) !== null) {
    const [, chord, chordLen, acc, letter, octMarks, noteLen, rest, restLen] = m;
    let tieNext = false;
    if (chord !== undefined) {
      // Melody is the TOP note — same convention as this pipeline's MusicXML
      // chord handling. Each inner note may carry its own length suffix; if
      // the whole chord has a trailing suffix instead, that wins for all.
      const inner = [...chord.matchAll(/([_^=]*)([A-Ga-g])([,']*)(\d+\/\d+|\d+|\/\d+|\/+)?/g)];
      if (inner.length === 0) continue;
      let best = null, bestMidi = -Infinity;
      for (const im of inner) {
        const [, iacc, iletter, ioct, ilen] = im;
        const p = pitchFromMatch(iacc, iletter, ioct);
        const alter = p.explicitAlter !== null ? p.explicitAlter : (barState[`${p.step}${p.octave}`] ?? keyAlt[p.step] ?? 0);
        const midi = midiOf({ step: p.step, alter, octave: p.octave });
        if (midi > bestMidi) { bestMidi = midi; best = { ...p, alter, len: chordLen || ilen }; }
      }
      if (best.explicitAlter !== null) barState[`${best.step}${best.octave}`] = best.alter;
      events.push({ step: best.step, alter: best.alter, octave: best.octave, dur: parseAbcLen(best.len) * unitEighths });
    } else if (rest !== undefined) {
      events.push({ rest: true, dur: parseAbcLen(restLen) * unitEighths });
    } else if (letter !== undefined) {
      const p = pitchFromMatch(acc, letter, octMarks);
      const key = `${p.step}${p.octave}`;
      const alter = p.explicitAlter !== null ? p.explicitAlter : (barState[key] ?? keyAlt[p.step] ?? 0);
      if (p.explicitAlter !== null) barState[key] = p.explicitAlter;
      // A tie ("-") immediately after this token is not part of TOKEN_RE —
      // peek at the next character.
      if (measureText[TOKEN_RE.lastIndex] === "-") { tieNext = true; TOKEN_RE.lastIndex += 1; }
      events.push({ step: p.step, alter, octave: p.octave, dur: parseAbcLen(noteLen) * unitEighths, tie: tieNext });
    }
  }
  return events;
}

// Extract the first-declared voice's raw body text (concatenated across every
// line where it's active) from the tune body (everything after K:). Supports
// both this repertoire's actual style — a "[V: id]" tag inline at the start
// of each line — and the general ABC fallback of a standalone "V: id" line
// switching the active voice for subsequent untagged lines. The melody voice
// is whichever voice appears FIRST in the body — voices are always written
// in the same top-to-bottom engraving order every system, so "first
// encountered" and "first in %%staves" are the same voice in a well-formed
// file (the %%staves line itself lives in the header, before K:, so it isn't
// available here — this module never receives it, and doesn't need to).
export function extractMelodyVoiceText(bodyLines) {
  let melodyVoiceId = null;
  let currentVoice = null;
  const parts = [];
  for (const raw of bodyLines) {
    const line = stripComment(raw);
    if (!line || line.startsWith("%") || /^[wW]:/.test(line)) continue;
    const inline = /^\[V:\s*([^\]]+)\]\s*(.*)$/.exec(line);
    if (inline) {
      currentVoice = inline[1].trim();
      if (melodyVoiceId === null) melodyVoiceId = currentVoice; // first voice seen, if %%staves was absent
      if (currentVoice === melodyVoiceId) parts.push(inline[2]);
      continue;
    }
    const standalone = /^V:\s*(\S+)\s*$/.exec(line);
    if (standalone) {
      currentVoice = standalone[1].trim();
      if (melodyVoiceId === null) melodyVoiceId = currentVoice;
      continue;
    }
    if (currentVoice === melodyVoiceId && currentVoice !== null) parts.push(line);
  }
  return parts.join(" ");
}

// Full file text → { title, composer, key, timeSignature, bpm, melodyMeasures }.
// Throws (never returns a half-good result) on: not public domain, missing
// required headers, a construct tokenizeMeasure() can't handle, or a failed
// bar-math validation — mirrors parseMusicXml's contract exactly.
export function convertHymnAbc(text, fallbackTitle) {
  if (!isPublicDomain(text)) throw new Error("not asserted public domain (or no copyright line found)");

  const lines = text.split(/\r?\n/);
  const kIdx = lines.findIndex((l) => /^K:/.test(l.trim()));
  if (kIdx === -1) throw new Error("no K: (key) header found");
  const headerLines = lines.slice(0, kIdx + 1);
  const bodyLines = lines.slice(kIdx + 1);

  const header = {};
  for (const raw of headerLines) {
    const line = stripComment(raw);
    const m = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (m) header[m[1]] = m[2];
  }
  const title = (header.T || fallbackTitle || "").trim() || fallbackTitle;
  const composerMatch = /%OHCOMPOSER\s+(.*)/.exec(text);
  const composer = composerMatch ? composerMatch[1].trim() : "Traditional";
  const fifths = keyStringToFifths(header.K);
  const timeSignature = (header.M || "4/4").replace(/\s.*/, "").trim() || "4/4";
  const [lNum, lDen] = (header.L || "1/8").split("/").map(Number);
  const unitEighths = ((lNum || 1) / (lDen || 8)) * 8;
  const tempoMatch = /Q:\s*(\d+)\/(\d+)\s*=\s*(\d+)/.exec(text);
  const bpm = tempoMatch
    ? Math.round(Number(tempoMatch[3]) * (Number(tempoMatch[1]) / Number(tempoMatch[2])) * 4)
    : 100;

  const melodyText = extractMelodyVoiceText(bodyLines);
  if (!melodyText.trim()) throw new Error("could not isolate a melody voice");
  const rawMeasures = splitMelodyIntoMeasures(melodyText);

  const measures = [];
  for (const raw of rawMeasures) {
    // Checked on the RAW text, before slur parens are stripped below — a
    // tuplet's "(3" would otherwise have its "(" removed first and slip
    // through undetected.
    if (/\(\d/.test(raw) || /[<>]/.test(raw)) {
      throw new Error(`measure "${raw}" uses a construct this parser doesn't handle (tuplet/broken rhythm)`);
    }
    const cleaned = raw
      .replace(/![^!]*!/g, "")
      .replace(/"[^"]*"/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/[()]/g, "");
    const barState = {};
    const events = tokenizeMeasure(cleaned, unitEighths, fifths, barState);
    // Unreachable in practice (the raw-text check above already screens out
    // tuplets/broken-rhythm), but tokenizeMeasure is exported and keeps its
    // own defensive check — honor its documented null contract rather than
    // let a null slip through to `.length` and throw an opaque TypeError.
    if (events === null) throw new Error(`measure "${raw}" uses a construct this parser doesn't handle (tuplet/broken rhythm)`);
    if (events.length > 0) measures.push(events); // drop fully-empty (e.g. stray blank) measures
  }
  if (measures.length < 4) throw new Error("melody too short after conversion (fewer than 4 measures)");

  const melodyMeasures = eventsToMeasures({ measures, timeSignature, fifths });
  const analysis = analyzeMelody(`${melodyMeasures.join(" | ")} |]`, timeSignature, melodyMeasures.length);
  if (!analysis.ok) throw new Error(`converted melody failed validation — ${analysis.problems.slice(0, 3).join("; ")}`);

  return { title, composer, key: header.K ? header.K.replace(/\s.*/, "") : "C", timeSignature, bpm, melodyMeasures };
}

// ── Network + catalog ─────────────────────────────────────────────────────

export async function getOpenHymnalWork(path) {
  const key = String(path);
  if (workCache.has(key)) return workCache.get(key);
  const entries = await loadOpenHymnalIndex();
  const entry = entries.find((e) => e.path === key);
  if (!entry) return null;

  let work = null;
  try {
    const resp = await fetchWithTimeout(RAW_BASE + key);
    const text = await resp.text();
    const parsed = convertHymnAbc(text, entry.title);
    work = {
      id: `openhymnal-${key}`,
      corpusId: key,
      title: parsed.title,
      composer: parsed.composer,
      key: parsed.key,
      timeSignature: parsed.timeSignature,
      bpm: parsed.bpm,
      measures: parsed.melodyMeasures.length,
      melodyMeasures: parsed.melodyMeasures,
      melodyAbc: `${parsed.melodyMeasures.join(" | ")} |]`,
      chords: null, // full SATB exists in the source but isn't extracted (v1) — harmonized once, cached, like other corpora
      genre: "Hymn",
      mood: "",
      description: `Melody converted note-for-note from a public-domain hymn score (Open Hymnal Project: ${entry.label}).`,
      sourceUrl: `https://github.com/${REPO}/blob/${BRANCH}/${key}`,
      sourceType: "hymnal",
    };
  } catch (err) {
    console.warn(`[openhymnal] ${key}: ${err.message}`);
  }
  workCache.set(key, work);
  return work;
}

export async function searchOpenHymnal(query) {
  const entries = await loadOpenHymnalIndex();
  const matches = matchEntries(entries, query, 6);
  const works = await Promise.all(matches.map((m) => getOpenHymnalWork(m.path).catch(() => null)));
  return works.filter(Boolean).slice(0, 4).map(openHymnalToSong);
}

export function openHymnalToSong(w) {
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
    source: "hymnal",
    corpusId: w.corpusId,
    measures: w.measures,
  };
}
