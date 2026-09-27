import { keyAlters } from "./symbolic.js";

// Transposing-instrument support.
//
// The arrangement is planned and stored at CONCERT pitch (the blueprint melody,
// the chords, every injected excerpt). This module figures out, for each part,
// the KEY that instrument must READ in — e.g. a piece in concert Bb hands the
// trumpet a part written in C, the horn a part in F. Keys are always respelled
// to the conventional, low-accidental spelling so casual players get friendly
// key signatures (Bb, Eb, F, C, G — never A# or Cb).
//
// Everything is done on the circle of fifths: a key is one integer (# of fifths
// from C; positive = sharps, negative = flats). Transposing an instrument's part
// shifts that integer by a fixed amount; we then respell into [-6, +6].

// Circle-of-fifths position for each MAJOR key spelling (the signature).
const MAJOR_FIFTHS = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  // enharmonic / awkward inputs → same pitch, friendly signature
  "A#": -2, "D#": -3, "G#": -4, "E#": -1, "B#": 0, Fb: 4,
};

// fifths (signature) → conventional key name, major and minor.
const MAJOR_NAME = {
  "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F",
  0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#",
};
const MINOR_NAME = {
  "-6": "Ebm", "-5": "Bbm", "-4": "Fm", "-3": "Cm", "-2": "Gm", "-1": "Dm",
  0: "Am", 1: "Em", 2: "Bm", 3: "F#m", 4: "C#m", 5: "G#m", 6: "D#m",
};

// Written key sits N fifths ABOVE concert (octaves ignored — they don't affect
// the key signature). label + interval are shown to the player and the model.
//   B♭ instruments  → +2 fifths (written a major 2nd up):   concert Bb → C
//   F  instruments  → +1 fifth  (written a perfect 5th up): concert C  → G
//   E♭ instruments  → +3 fifths (written a major 6th up):   concert Eb → C
const TRANSPOSE = {
  Trumpet:        { label: "in B♭", fifths: 2, interval: "a major 2nd (whole step) up" },
  Flugelhorn:     { label: "in B♭", fifths: 2, interval: "a major 2nd (whole step) up" },
  Clarinet:       { label: "in B♭", fifths: 2, interval: "a major 2nd (whole step) up" },
  "Tenor Sax":    { label: "in B♭", fifths: 2, interval: "a major 2nd up (an octave-and-a-tone in sound)" },
  "French Horn":  { label: "in F",  fifths: 1, interval: "a perfect 5th up" },
  "English Horn": { label: "in F",  fifths: 1, interval: "a perfect 5th up" },
  "Alto Sax":     { label: "in E♭", fifths: 3, interval: "a major 6th up" },
};

// Parse "Bb", "F#m", "Dm", "C", "A# minor" → { fifths (signature), minor }.
function parseKey(key) {
  const raw = String(key || "C").trim();
  const m = raw.match(/^([A-Ga-g])([#b]?)/);
  const root = m ? m[1].toUpperCase() + (m[2] || "") : "C";
  const rest = m ? raw.slice(m[0].length) : raw;
  const minor = /^\s*m(?!aj)/i.test(rest); // "m", "min", "minor" — but not "maj"
  let f = MAJOR_FIFTHS[root];
  if (f === undefined) f = 0;
  if (minor) f -= 3; // minor signature = relative major minus 3 fifths
  return { fifths: respell(f), minor };
}

// Fold a fifths value into the conventional [-6, +6] window (7 sharps/flats →
// its 5-accidental enharmonic: C#→Db, Cb→B, etc.).
function respell(f) {
  while (f > 6) f -= 12;
  while (f < -6) f += 12;
  return f;
}

function nameFor(fifths, minor) {
  return (minor ? MINOR_NAME : MAJOR_NAME)[respell(fifths)];
}

// Normalize any concert-key spelling to its conventional form (same pitch).
export function conventionalKey(key) {
  const { fifths, minor } = parseKey(key);
  return nameFor(fifths, minor);
}

// The key SIGNATURE of a concert key, as fifths (C/Am = 0, D = 2, Eb = -3).
// Minor keys already carry their relative-major signature from parseKey.
// Used by melody validation to resolve written notes to true pitches.
export function keyFifths(key) {
  const { fifths } = parseKey(key);
  return respell(fifths);
}

// Strip a numbered-voice suffix: "Trumpet 2" → "Trumpet".
const baseInstrument = (name) => String(name || "").replace(/\s+\d+$/, "");

// ── Chord symbols in written pitch ───────────────────────────────────────────
// A transposing part used to be handed the CONCERT chord list and left to
// transpose it in its head. Live, 3 of 12 transposing parts got that wrong and
// built their whole accompaniment on the wrong chords (ENGINE_NOTES.md). The
// symbols are now transposed here, deterministically.
//
// By LETTER, so spelling follows the interval: a B-flat part turns F#m into
// G#m, never Abm. Then, when writtenKeyFor had to respell the written key
// (concert F# on a B-flat trumpet would be G# major, 8 sharps, and is read in
// Ab instead), every chord letter is respelled the same way, so the chords
// match the key signature the player actually sees. That respelling is
// measured from the concert key AS SPELLED: a library work in concert C#
// carries chords spelled in C#, while writtenKeyFor has already folded the key
// to Db, so measuring from the folded key would hand a trumpet reading in Eb
// the chords D#, G#, B#m. Only the root and any slash bass change; the chord's
// quality text is copied as-is.

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Spell pitch class `pc` on letter index `li` ("C#", "Bb", "Fbb"…), or null
// when that would need more than a double accidental.
function spellOn(li, pc) {
  const letter = LETTERS[((li % 7) + 7) % 7];
  let acc = (((pc - LETTER_PC[letter]) % 12) + 12) % 12;
  if (acc > 6) acc -= 12;
  if (Math.abs(acc) > 2) return null;
  return letter + (acc > 0 ? "#".repeat(acc) : "b".repeat(-acc));
}

// "F#" → moved `steps` letters and `semis` semitones, plus `flip` extra
// letters for a respelled key (+1: sharps became flats, G# → Ab). Never
// emits a double accidental: a chord from outside the key can land on one
// (C on a trumpet in concert B, read in Db, would be "Ebb"), and then the
// nearest single-accidental or natural spelling is used instead ("D").
function moveNote(note, steps, semis, flip) {
  const li = LETTERS.indexOf(note[0]);
  const acc = note.slice(1).replace(/♯/g, "#").replace(/♭/g, "b");
  const pc = LETTER_PC[note[0]] + (acc === "#" ? 1 : acc === "b" ? -1 : 0);
  const target = li + steps;
  for (const letter of [target + flip, target, target - 1, target + 1]) {
    const s = spellOn(letter, pc + semis);
    if (s && s.length <= 2) return s;
  }
  return null;
}

// Circle-of-fifths position of a key exactly as spelled, never folded the way
// parseKey folds it: "C#" = 7, "A#" = 10, "D#m" = 6, "Fb" = -8. Always the
// same pitch as parseKey's value, so the two differ by a whole multiple of 12
// fifths, and each 12 is one letter of respelling (C# → Db).
const LETTER_FIFTHS = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
function spelledFifths(key) {
  const raw = String(key || "C").trim();
  const m = raw.match(/^([A-Ga-g])([#b]?)/);
  if (!m) return parseKey(key).fifths; // unreadable: whatever parseKey decided
  const minor = /^\s*m(?!aj)/i.test(raw.slice(m[0].length));
  const acc = m[2] === "#" ? 7 : m[2] === "b" ? -7 : 0;
  return LETTER_FIFTHS[m[1].toUpperCase()] + acc - (minor ? 3 : 0);
}

// How a concert chord symbol moves for this instrument in this concert key:
// { steps, semis, flip }, or null for a non-transposing instrument.
function chordMove(concertKey, instrName) {
  const t = TRANSPOSE[baseInstrument(instrName)];
  if (!t) return null;
  // The written key as the chords' own spelling would put it, vs the key the
  // player reads (writtenKeyFor's). Every 12 fifths between them is a letter.
  const spelled = spelledFifths(concertKey) + t.fifths;
  const read = writtenKeyFor(concertKey, instrName).fifths;
  return {
    steps: (((4 * t.fifths) % 7) + 7) % 7, // letters: 2nd = 1, 5th = 4, 6th = 5
    semis: (((7 * t.fifths) % 12) + 12) % 12, // semitones: 2, 7, 9
    flip: (spelled - read) / 12,
  };
}

// One chord symbol ("F#m7/C#") into the instrument's written pitch. Anything
// that isn't a root-first symbol ("N.C.", junk) is returned unchanged, as is
// every symbol for a non-transposing instrument.
export function transposeChordSymbol(symbol, concertKey, instrName) {
  const move = chordMove(concertKey, instrName);
  if (!move || typeof symbol !== "string") return symbol;
  let body = symbol;
  let bass = "";
  const slash = symbol.match(/^(.+)\/([A-G][#b♯♭]?)$/);
  if (slash) { body = slash[1]; bass = slash[2]; }
  const m = body.match(/^([A-G][#b♯♭]?)(.*)$/);
  if (!m) return symbol;
  const root = moveNote(m[1], move.steps, move.semis, move.flip);
  const newBass = bass ? moveNote(bass, move.steps, move.semis, move.flip) : "";
  if (!root || (bass && !newBass)) return symbol;
  return `${root}${m[2]}${bass ? `/${newBass}` : ""}`;
}

// ── The melody in written pitch ──────────────────────────────────────────────
// Transposing parts were handed the canonical melody at CONCERT pitch and told
// to transpose it in their heads: the last thing they still had to, once the
// chords and the ensemble grid came pre-transposed. Their melody bars were
// wrong about twice as often as other parts' (13.3% vs 7.1% over 20 eval
// runs, ENGINE_NOTES.md). This rewrites the melody text into the part's
// written pitch, for the PROMPT only: the plan's melody stays concert, and
// the melody check still compares the part against it.
//
// Only pitch tokens change; lengths, rests, ties, slurs, tuplets, barlines
// and decorations are copied as they are. Pitches are moved by letter (the
// same move as the chord symbols, so melody and chords agree) and each note
// gets exactly the accidental the WRITTEN key signature and the bar so far
// need, following ABC's rule that an accidental holds for that letter and
// octave until the barline, as partCheck.js reads it.

const LETTER_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Regions that carry no pitch: decorations, annotations/chord symbols,
// +decorations+, inline fields ([K:G]); then a barline; then a pitch token.
const MELODY_TOKEN = /(![^!]*!|"[^"]*"|\+[^+\s]*\+|\[[A-Za-z]:[^\]]*\])|(\|)|([{}])|(\^\^|__|\^|_|=)?([A-Ga-g])([,']*)/g;

// ABC token → { letter, oct, midi } read against key signature `sig` and the
// bar's accidentals so far `acc` (updated for an explicit accidental).
function readPitch(accTok, letterTok, marks, sig, acc) {
  const letter = letterTok.toUpperCase();
  let oct = letterTok === letterTok.toLowerCase() ? 1 : 0; // "C" = C4 = octave 0
  for (const c of marks) oct += c === "'" ? 1 : -1;
  const id = `${letter}${oct}`;
  let alter;
  if (accTok) {
    alter = { "^^": 2, "^": 1, "=": 0, _: -1, __: -2 }[accTok];
    acc[id] = alter;
  } else {
    alter = id in acc ? acc[id] : sig[letter] || 0;
  }
  return { letter, oct, midi: 60 + 12 * oct + LETTER_SEMI[letter] + alter };
}

// Spell `midi` on letter index `li` (moved, may wrap octaves): the letter,
// its octave and the alteration it needs, or null when that would be more
// than a double accidental.
function spellPitch(li, midi) {
  const letter = LETTERS[((li % 7) + 7) % 7];
  // The octave whose natural `letter` sits within 2 semitones of midi.
  const oct = Math.round((midi - 60 - LETTER_SEMI[letter]) / 12);
  const alter = midi - (60 + 12 * oct + LETTER_SEMI[letter]);
  return Math.abs(alter) > 2 ? null : { letter, oct, alter, id: `${letter}${oct}` };
}

// A spelled pitch as an ABC token. The accidental is written only when the
// note differs from what a reader already assumes (`acc`, the bar so far,
// else the signature `sig`), or always when `force`; a written accidental is
// recorded in `acc`. Pass acc = null for a grace note: against the signature
// alone, and recording nothing.
function renderPitch({ letter, oct, alter, id }, sig, acc, force = false) {
  const assumed = acc && id in acc ? acc[id] : sig[letter] || 0;
  let accTok = "";
  if (force || alter !== assumed) {
    accTok = { 2: "^^", 1: "^", 0: "=", [-1]: "_", [-2]: "__" }[alter];
    if (acc) acc[id] = alter;
  }
  const name = oct >= 1 ? letter.toLowerCase() + "'".repeat(oct - 1) : letter + ",".repeat(-oct);
  return accTok + name;
}

// The canonical melody (concert pitch, spelled in concertKey) as `instrName`
// writes it. A non-transposing instrument gets the text back unchanged.
//
// Two rules keep it in step with how the rest of the system reads a melody:
// - Letters are read with the signature the system reads the melody with
//   (keyFifths: concert C# is read with Db's), so the respelling is measured
//   from that signature, not from the key's literal spelling as chord
//   symbols (which carry their own accidentals) are.
// - Grace notes {...} are ignored by partCheck's parser, so they neither set
//   nor rely on the bar's accidentals here: each is written against the key
//   signature alone, and a main note on a letter+octave a grace note touched
//   states its accidental outright, so every reader agrees on it.
export function writtenMelodyFor(melodyAbc, concertKey, instrName) {
  const t = TRANSPOSE[baseInstrument(instrName)];
  if (!t || typeof melodyAbc !== "string") return melodyAbc;
  const readFifths = keyFifths(concertKey);
  const writtenFifths = writtenKeyFor(concertKey, instrName).fifths;
  const steps = (((4 * t.fifths) % 7) + 7) % 7; // letters: 2nd = 1, 5th = 4, 6th = 5
  const semis = (((7 * t.fifths) % 12) + 12) % 12; // semitones: 2, 7, 9
  const flip = (readFifths + t.fifths - writtenFifths) / 12; // letters of respelling
  const inSig = keyAlters(readFifths);
  const outSig = keyAlters(writtenFifths);
  let inAcc = {};
  let outAcc = {};
  let graceTouched = new Set();
  let inGrace = false;
  return melodyAbc.split("\n").map((line) => {
    // Field and lyric lines ("w:", "K:") hold no melody.
    if (/^\s*[A-Za-z]:/.test(line)) return line;
    return line.replace(MELODY_TOKEN, (all, skip, bar, brace, accTok, letterTok, marks) => {
      if (skip) return all;
      if (bar) { inAcc = {}; outAcc = {}; graceTouched = new Set(); return all; }
      if (brace) { inGrace = brace === "{"; return all; }
      const p = readPitch(accTok, letterTok, marks, inSig, inGrace ? {} : inAcc);
      const target = LETTERS.indexOf(p.letter) + 7 * (p.oct + 10) + steps;
      // The spelling a respelled key wants first, then the plain move, then
      // a neighbour letter: never more than a double accidental.
      for (const li of [target + flip, target, target - 1, target + 1]) {
        const s = spellPitch(li, p.midi + semis);
        if (!s) continue;
        if (inGrace) { graceTouched.add(s.id); return renderPitch(s, outSig, null); }
        const force = graceTouched.delete(s.id);
        return renderPitch(s, outSig, outAcc, force);
      }
      return all; // unreachable for real pitches; never corrupt the text
    });
  }).join("\n");
}

// ── Moving notes by whole octaves ────────────────────────────────────────────
// Move chosen notes of ABC text up or down by octaves without changing any
// pitch class: each note keeps its letter and alteration, and accidentals are
// rewritten so every note, moved or not, still reads correctly under ABC's
// rule that an accidental holds for its letter AND octave until the barline.
// Naively editing one token breaks that: in "^F2 F2", moving the second F up
// gives "^F2 f2", and the f loses its sharp. Grace notes follow the same
// rules as writtenMelodyFor.
//
// `fifths` is the key signature the text is written in. `shiftFor(midi,
// inGrace)` is called for every note in order and returns whole octaves to
// move it (0 to leave it). Returns { text, moved } (moved = notes changed).
export function moveOctaves(text, fifths, shiftFor) {
  if (typeof text !== "string") return { text, moved: 0 };
  const sig = keyAlters(fifths);
  let inAcc = {};
  let outAcc = {};
  let graceTouched = new Set();
  let inGrace = false;
  let moved = 0;
  const out = text.split("\n").map((line) => {
    if (/^\s*[A-Za-z]:/.test(line)) return line;
    return line.replace(MELODY_TOKEN, (all, skip, bar, brace, accTok, letterTok, marks) => {
      if (skip) return all;
      if (bar) { inAcc = {}; outAcc = {}; graceTouched = new Set(); return all; }
      if (brace) { inGrace = brace === "{"; return all; }
      const p = readPitch(accTok, letterTok, marks, sig, inGrace ? {} : inAcc);
      const k = shiftFor(p.midi, inGrace) || 0;
      if (k) moved++;
      const oct = p.oct + k;
      const s = { letter: p.letter, oct, alter: p.midi - (60 + 12 * p.oct + LETTER_SEMI[p.letter]), id: `${p.letter}${oct}` };
      if (inGrace) { graceTouched.add(s.id); return renderPitch(s, sig, null); }
      return renderPitch(s, sig, outAcc, graceTouched.delete(s.id));
    });
  }).join("\n");
  // Nothing moved: hand back the input untouched (rendering would otherwise
  // drop redundant accidentals, a change no one asked for).
  return moved ? { text: out, moved } : { text, moved: 0 };
}

// A whole chord list (one annotation per bar, possibly "G C") in written pitch.
// Also splits on "|", so a list that arrives as one "D | A | Bm" string works,
// and "G|C" is never read as G with the quality "|C".
export function writtenChordsFor(chords, concertKey, instrName) {
  if (!Array.isArray(chords)) return chords;
  return chords.map((bar) => (typeof bar === "string"
    ? bar.split(/(\s+|,|\|)/).map((tok) => (/^[A-G]/.test(tok) ? transposeChordSymbol(tok, concertKey, instrName) : tok)).join("")
    : bar));
}

// For a given concert key + instrument, return how the part should be written.
//   { writtenKey, label, interval, transposes }
// Non-transposing (C) instruments read in the concert key with transposes:false.
export function writtenKeyFor(concertKey, instrName) {
  const { fifths, minor } = parseKey(concertKey);
  const t = TRANSPOSE[baseInstrument(instrName)];
  if (!t) {
    // `fifths` is the written key's SIGNATURE, returned alongside its name so
    // the two can never disagree — melody validation needs it to resolve
    // written notes to true pitches.
    return {
      writtenKey: nameFor(fifths, minor), fifths: respell(fifths),
      label: null, interval: null, transposes: false,
    };
  }
  return {
    writtenKey: nameFor(fifths + t.fifths, minor),
    fifths: respell(fifths + t.fifths),
    label: t.label,
    interval: t.interval,
    transposes: true,
  };
}
