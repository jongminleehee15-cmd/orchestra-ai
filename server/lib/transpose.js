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
