// ─────────────────────────────────────────────────────────────────────────────
// singable.js — turn a notated melody into text a person can actually sing.
//
// Answers "can sheet music become a singable text version?" with: yes, for the
// pitch/rhythm layer, and deterministically — no model call needed. The ABC the
// app already produces is a complete symbolic score, so movable-do solfege,
// tonic sol-fa and scale degrees are a pure function of (notes, key).
//
// Emits an ABC `w:` lyric line, which abcjs already renders under the staff,
// so this drops straight into the existing renderer with no new dependency.
// ─────────────────────────────────────────────────────────────────────────────
import { keyAccidentals, parseNoteToken } from "./abcPitch.js";

const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SEMIS = [0, 2, 4, 5, 7, 9, 11];

// Chromatic scale degree (0-11 above the tonic) -> syllable, by direction.
// Base syllable per diatonic degree, then altered by the accidental. Deriving
// the syllable from SPELLING (letter distance + alteration) rather than from
// melodic direction is what makes minor keys come out right: in natural minor
// the flat 3rd is always "me", never "ri", regardless of which way the line moves.
const BASE = {
  solfege: ["do", "re", "mi", "fa", "sol", "la", "ti"],
  solfa:   ["d", "r", "m", "f", "s", "l", "t"],
  degrees: ["1", "2", "3", "4", "5", "6", "7"],
};
const RAISED = {
  solfege: ["di", "ri", "mi\u266F", "fi", "si", "li", "ti\u266F"],
  solfa:   ["de", "re", "me", "fe", "se", "le", "te"],
  degrees: ["#1", "#2", "#3", "#4", "#5", "#6", "#7"],
};
const LOWERED = {
  solfege: ["do\u266D", "ra", "me", "fa\u266D", "se", "le", "te"],
  solfa:   ["da", "ra", "ma", "fa", "sa", "la", "ta"],
  degrees: ["b1", "b2", "b3", "b4", "b5", "b6", "b7"],
};

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]; // semitones above tonic, major scale

function keyRoot(key) {
  const m = String(key || "C").trim().match(/^([A-Ga-g])([#b]?)/);
  return m ? m[1].toUpperCase() + (m[2] || "") : "C";
}
function tonicSemitone(key) {
  const r = keyRoot(key);
  const base = SEMIS[LETTER_IDX[r[0]]] + (r[1] === "#" ? 1 : r[1] === "b" ? -1 : 0);
  return ((base % 12) + 12) % 12;
}
export function isMinorKey(key) {
  const m = String(key || "").match(/^([A-Ga-g])([#b]?)/);
  return m ? /^\s*m(?!aj)/i.test(String(key).slice(m[0].length)) : false;
}

function syllableFor(system, degree, alteration) {
  const sys = BASE[system] ? system : "solfege";
  if (alteration > 0) return RAISED[sys][degree];
  if (alteration < 0) return LOWERED[sys][degree];
  return BASE[sys][degree];
}

// Walk an ABC melody body and emit one syllable per sounded note.
//   system: "solfege" | "solfa" | "degrees"
//   la_based: minor keys sung with "la" on the tonic (common in Kodaly teaching)
export function melodyToSyllables(body, { key = "C", system = "solfege", la_based = false } = {}) {
  const sig = keyAccidentals(key);
  const minor = isMinorKey(key);
  // la-based minor reads syllables from the relative major, so "la" lands on the
  // minor tonic (the convention in Kodaly and most British/African sol-fa teaching).
  const shiftToRelative = minor && la_based;
  const tonicChroma = (tonicSemitone(key) + (shiftToRelative ? 3 : 0) + 12) % 12;
  const tonicLetterIdx = (LETTER_IDX[keyRoot(key)[0]] + (shiftToRelative ? 2 : 0) + 7) % 7;

  const bars = [];
  let cur = [];
  let barAcc = {};

  const TOKEN = /(\[[^\]]*\]|[_^=]{0,2}[A-Ga-g][,']*[\d/]*|[zx][\d/]*|Z\d*|\|+[\]:]?|:\|+|[^A-Ga-gzxZ|_^=[\]]+|[\s\S])/g;
  let m;
  while ((m = TOKEN.exec(body)) !== null) {
    const tok = m[0];
    if (/^\|/.test(tok) || /^:\|/.test(tok)) { bars.push(cur); cur = []; barAcc = {}; continue; }
    if (/^[zxZ]/.test(tok)) { cur.push({ syl: "\u2013", rest: true }); continue; }

    // A chord sings its top note (the one a singer would actually take).
    const noteText = tok.startsWith("[")
      ? (tok.slice(1, -1).match(/[_^=]{0,2}[A-Ga-g][,']*[\d/]*/g) || []).slice(-1)[0]
      : tok;
    const p = parseNoteToken(noteText || "");
    if (!p) continue;

    let acc;
    const slot = p.letter + p.octave;
    if (p.accStr) { acc = { "^^":2, "^":1, "=":0, "_":-1, "__":-2 }[p.accStr]; barAcc[slot] = acc; }
    else if (slot in barAcc) acc = barAcc[slot];
    else acc = sig[p.letter];

    const chroma = SEMIS[LETTER_IDX[p.letter]] + 12 * p.octave + acc;
    const degree = ((LETTER_IDX[p.letter] - tonicLetterIdx) % 7 + 7) % 7;
    const actual = (((chroma - tonicChroma) % 12) + 12) % 12;
    let alteration = actual - MAJOR_STEPS[degree];
    if (alteration > 6) alteration -= 12;
    if (alteration < -6) alteration += 12;
    cur.push({ syl: syllableFor(system, degree, alteration), rest: false, octave: p.octave, len: p.len });
  }
  if (cur.length) bars.push(cur);
  return bars.filter((b) => b.length);
}

// ABC `w:` lyric line — renders under the staff in abcjs with zero new deps.
// "*" tells abcjs to skip a note (used for rests), "|" aligns to barlines.
export function toAbcLyricLine(bars) {
  return "w: " + bars.map((b) => b.map((n) => (n.rest ? "*" : n.syl)).join(" ")).join(" | ");
}

// Plain-text singable sheet: one line per 4 bars, syllables grouped by bar.
export function toSingableText(bars, { perLine = 4 } = {}) {
  const out = [];
  for (let i = 0; i < bars.length; i += perLine) {
    out.push(
      bars.slice(i, i + perLine)
        .map((b) => b.map((n) => n.syl).join(" "))
        .join("  |  "),
    );
  }
  return out.join("\n");
}

// Insert the syllable line into a full ABC tune so it renders under the notes.
export function annotateAbcWithSyllables(fullAbc, opts = {}) {
  const lines = String(fullAbc).split(/\r?\n/);
  const kIdx = lines.findIndex((l) => /^K:/.test(l));
  if (kIdx === -1) return fullAbc;
  const head = lines.slice(0, kIdx + 1);
  const body = lines.slice(kIdx + 1);
  const out = [...head];
  for (const line of body) {
    out.push(line);
    if (line.trim() && !/^[A-Za-z]:/.test(line) && !/^%%/.test(line)) {
      out.push(toAbcLyricLine(melodyToSyllables(line, opts)));
    }
  }
  return out.join("\n");
}
