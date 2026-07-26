// ─────────────────────────────────────────────────────────────────────────────
// abcPitch.js — parse ABC pitches, apply key signatures, transpose correctly.
//
// This is the piece OrchestraAI is missing. Today the concert-pitch melody is
// handed to the model with "transpose this up a major 2nd into Bb" in prose,
// and the model does it by ear — which is exactly where accuracy leaks. Doing
// it in code makes transposition exact and removes a whole class of failure.
// ─────────────────────────────────────────────────────────────────────────────

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SEMIS      = [0, 2, 4, 5, 7, 9, 11];        // semitone of each natural
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER  = ["B", "E", "A", "D", "G", "C", "F"];

const MAJOR_FIFTHS = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  "A#": -2, "D#": -3, "G#": -4, "E#": -1, "B#": 0, Fb: 4,
};

// Key name -> { [letter]: -1|0|1 } accidentals implied by the signature.
export function keyAccidentals(key) {
  const m = String(key || "C").trim().match(/^([A-Ga-g])([#b]?)/);
  const root = m ? m[1].toUpperCase() + (m[2] || "") : "C";
  const minor = m ? /^\s*m(?!aj)/i.test(String(key).slice(m[0].length)) : false;
  let f = MAJOR_FIFTHS[root] ?? 0;
  if (minor) f -= 3;
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  const acc = {};
  for (const L of LETTERS) acc[L] = 0;
  if (f > 0) for (let i = 0; i < f; i++) acc[SHARP_ORDER[i]] = 1;
  if (f < 0) for (let i = 0; i < -f; i++) acc[FLAT_ORDER[i]] = -1;
  return acc;
}

const ACC_VAL = { "^^": 2, "^": 1, "=": 0, _: -1, __: -2 };
const ACC_STR = { 2: "^^", 1: "^", 0: "=", "-1": "_", "-2": "__" };

// "^F,2" -> { acc:"^", letter:"F", oct:",", len:"2" }
const NOTE_RE = /^([_^=]{0,2})([A-Ga-g])([,']*)([\d/]*)$/;
export function parseNoteToken(tok) {
  const m = String(tok).match(NOTE_RE);
  if (!m) return null;
  const letter = m[2].toUpperCase();
  let octave = m[2] === m[2].toLowerCase() ? 5 : 4;
  for (const ch of m[3]) octave += ch === "'" ? 1 : -1;
  return { accStr: m[1], letter, octave, len: m[4] || "" };
}

export function renderNoteToken({ letter, octave, len, explicitAcc }) {
  let s = explicitAcc || "";
  s += octave >= 5 ? letter.toLowerCase() : letter;
  if (octave > 5) s += "'".repeat(octave - 5);
  if (octave < 4) s += ",".repeat(4 - octave);
  return s + (len || "");
}

// Transpose a whole ABC body from one key to another by a named interval.
//   diatonic: how many letter-names up (major 2nd = 1, perfect 5th = 4)
//   semitones: how many half steps up (major 2nd = 2, perfect 5th = 7)
// Bar-local accidentals are tracked the way a reader would, and the output only
// spells accidentals that differ from the destination key signature.
export function transposeAbcBody(body, { fromKey, toKey, diatonic, semitones }) {
  if (!body) return body;
  const fromSig = keyAccidentals(fromKey);
  const toSig = keyAccidentals(toKey);
  let barAcc = {};                       // letter+octave -> accidental this bar

  // Ordered alternation. The catch-all deliberately excludes accidental
  // characters so it cannot swallow the "_" of a "_B" before the note
  // alternative gets a chance to match it.
  const TOKEN = /(\[[^\]]*\]|[_^=]{0,2}[A-Ga-g][,']*[\d/]*|\|+[\]:]?|:\|+|[^A-Ga-g|_^=[\]]+|[\s\S])/g;
  return body.replace(TOKEN, (tok) => {
    if (/^\|/.test(tok) || /^:\|/.test(tok)) { barAcc = {}; return tok; }   // barline resets
    if (tok.startsWith("[")) {
      return "[" + tok.slice(1, -1).replace(/[_^=]{0,2}[A-Ga-g][,']*[\d/]*/g, (n) => shift(n)) + "]";
    }
    if (!NOTE_RE.test(tok)) return tok;
    return shift(tok);
  });

  function shift(tok) {
    const p = parseNoteToken(tok);
    if (!p) return tok;
    const slot = p.letter + p.octave;

    // Sounding accidental: explicit > earlier-in-bar > key signature.
    let acc;
    if (p.accStr) { acc = ACC_VAL[p.accStr]; barAcc[slot] = acc; }
    else if (slot in barAcc) acc = barAcc[slot];
    else acc = fromSig[p.letter];

    const dIdx = LETTER_IDX[p.letter] + 7 * p.octave;
    const cIdx = SEMIS[LETTER_IDX[p.letter]] + 12 * p.octave + acc;

    const nd = dIdx + diatonic;
    const nc = cIdx + semitones;
    const nLetter = LETTERS[((nd % 7) + 7) % 7];
    const nOct = Math.floor(nd / 7);
    const nAcc = nc - (SEMIS[LETTER_IDX[nLetter]] + 12 * nOct);

    // Only print an accidental when it differs from the destination signature.
    const explicitAcc = nAcc === toSig[nLetter] ? "" : (ACC_STR[String(nAcc)] ?? "");
    return renderNoteToken({ letter: nLetter, octave: nOct, len: p.len, explicitAcc });
  }
}

// Interval each transposing family reads above concert pitch.
export const TRANSPOSITIONS = {
  Trumpet:       { label: "in B♭", diatonic: 1, semitones: 2,  fifths: 2 },
  Flugelhorn:    { label: "in B♭", diatonic: 1, semitones: 2,  fifths: 2 },
  Clarinet:      { label: "in B♭", diatonic: 1, semitones: 2,  fifths: 2 },
  "Tenor Sax":   { label: "in B♭", diatonic: 8, semitones: 14, fifths: 2 },
  "French Horn": { label: "in F",       diatonic: 4, semitones: 7,  fifths: 1 },
  "English Horn":{ label: "in F",       diatonic: 4, semitones: 7,  fifths: 1 },
  "Alto Sax":    { label: "in E♭", diatonic: 5, semitones: 9,  fifths: 3 },
  Piccolo:       { label: "sounds 8va", diatonic: -7, semitones: -12, fifths: 0 },
  "Double Bass": { label: "sounds 8vb", diatonic: 7,  semitones: 12,  fifths: 0 },
};
