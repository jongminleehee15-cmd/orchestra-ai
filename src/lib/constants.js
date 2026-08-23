// ── Instrument catalogue ──────────────────────────────────────────────────────
export const INSTRUMENT_GROUPS = {
  Strings:      ["Violin", "Viola", "Cello", "Double Bass", "Harp", "Classical Guitar"],
  Brass:        ["French Horn", "Trumpet", "Trombone", "Tuba", "Flugelhorn"],
  Woodwinds:    ["Flute", "Oboe", "Clarinet", "Bassoon", "Piccolo", "English Horn", "Alto Sax", "Tenor Sax"],
  Percussion:   ["Timpani", "Xylophone", "Marimba", "Vibraphone", "Glockenspiel", "Tubular Bells"],
  Keyboard:     ["Piano", "Harpsichord", "Organ", "Celesta"],
  Voice:        ["Soprano", "Mezzo-soprano", "Tenor", "Baritone", "Bass"],
  "Guitar/Bass": ["Electric Guitar", "Bass Guitar", "Acoustic Guitar"],
  Electronic:   ["Synthesizer", "Electric Piano"],
};
export const ALL_INSTRUMENTS = Object.values(INSTRUMENT_GROUPS).flat();

export const ENSEMBLE_PRESETS = [
  { name: "String Quartet",    instruments: [{ name: "Violin", count: 2 }, { name: "Viola", count: 1 }, { name: "Cello", count: 1 }] },
  { name: "Piano Trio",        instruments: [{ name: "Piano", count: 1 }, { name: "Violin", count: 1 }, { name: "Cello", count: 1 }] },
  { name: "Chamber Orchestra", instruments: [{ name: "Violin", count: 4 }, { name: "Viola", count: 2 }, { name: "Cello", count: 2 }, { name: "Flute", count: 1 }, { name: "Oboe", count: 1 }, { name: "French Horn", count: 2 }, { name: "Piano", count: 1 }] },
  { name: "Jazz Combo",        instruments: [{ name: "Alto Sax", count: 1 }, { name: "Trumpet", count: 1 }, { name: "Piano", count: 1 }, { name: "Bass Guitar", count: 1 }] },
  { name: "Brass Quintet",     instruments: [{ name: "Trumpet", count: 2 }, { name: "French Horn", count: 1 }, { name: "Trombone", count: 1 }, { name: "Tuba", count: 1 }] },
  { name: "Woodwind Quintet",  instruments: [{ name: "Flute", count: 1 }, { name: "Oboe", count: 1 }, { name: "Clarinet", count: 1 }, { name: "French Horn", count: 1 }, { name: "Bassoon", count: 1 }] },
  { name: "Rock Band",         instruments: [{ name: "Electric Guitar", count: 2 }, { name: "Bass Guitar", count: 1 }, { name: "Piano", count: 1 }] },
];

export const STYLES      = ["Original", "Cinematic", "Romantic", "Baroque", "Jazz", "Minimalist", "Epic", "Playful", "Mysterious", "Impressionist"];
export const DENSITIES   = ["Sparse", "Moderate", "Full", "Lush"];
export const TEMPOS_FEEL  = ["Slow", "Moderate", "Upbeat", "Fast"];
// Keep in sync with server/lib/limits.js ALLOWED_MEASURES — the server 400s
// any value not in that list, so an out-of-sync UI could offer a value the
// API rejects.
export const MEASURE_OPTIONS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];

// Rough playing time from measures + time signature + tempo. bpm is the
// quarter-note tempo (Q:1/4=bpm), so seconds = totalQuarterBeats / bpm * 60.
export function estimateDuration(measures, timeSig, bpm) {
  const [num, den] = String(timeSig || "4/4").split("/").map((n) => parseInt(n, 10));
  const beatsPerMeasure = (num || 4) * (4 / (den || 4)); // in quarter-note beats
  const b = Number(bpm) || 100;
  const seconds = (Number(measures) || 0) * beatsPerMeasure / b * 60;
  let mm = Math.floor(seconds / 60);
  let ss = Math.round(seconds % 60);
  if (ss === 60) { mm += 1; ss = 0; }
  return { seconds, clock: `${mm}:${String(ss).padStart(2, "0")}` };
}

// Classical tempo term for a BPM — display only, rough boundaries.
export function tempoTerm(bpm) {
  if (bpm < 55) return "Largo";
  if (bpm < 70) return "Adagio";
  if (bpm < 90) return "Andante";
  if (bpm < 112) return "Moderato";
  if (bpm < 140) return "Allegro";
  if (bpm < 170) return "Vivace";
  return "Presto";
}

// clef: how the part is engraved.  midi: General MIDI program for playback.
// shift: playback-only semitone offset for transposing instruments — their
// parts are WRITTEN above concert pitch (see server/lib/transpose.js), so
// playback shifts them back down to sound in concert with the other parts.
// The shift mirrors the interval the part prompt asks for (B♭ = written a
// major 2nd up → −2; F = a 5th up → −7; alto sax in E♭ = a 6th up → −9;
// tenor sax is written only a 2nd up in this app, so −2, not −14).
export const INSTR_META = {
  Violin: { clef: "treble", midi: 40 }, Viola: { clef: "alto", midi: 41 }, Cello: { clef: "bass", midi: 42 },
  "Double Bass": { clef: "bass", midi: 43 }, Harp: { clef: "treble", midi: 46 }, "Classical Guitar": { clef: "treble", midi: 24 },
  "French Horn": { clef: "treble", midi: 60, shift: -7 }, Trumpet: { clef: "treble", midi: 56, shift: -2 }, Flugelhorn: { clef: "treble", midi: 56, shift: -2 },
  Trombone: { clef: "bass", midi: 57 }, Tuba: { clef: "bass", midi: 58 },
  Flute: { clef: "treble", midi: 73 }, Piccolo: { clef: "treble", midi: 72 }, Oboe: { clef: "treble", midi: 68 },
  Clarinet: { clef: "treble", midi: 71, shift: -2 }, Bassoon: { clef: "bass", midi: 70 }, "English Horn": { clef: "treble", midi: 69, shift: -7 },
  "Alto Sax": { clef: "treble", midi: 65, shift: -9 }, "Tenor Sax": { clef: "treble", midi: 66, shift: -2 },
  Timpani: { clef: "bass", midi: 47 }, Xylophone: { clef: "treble", midi: 13 }, Marimba: { clef: "treble", midi: 12 },
  Vibraphone: { clef: "treble", midi: 11 }, Glockenspiel: { clef: "treble", midi: 9 }, "Tubular Bells": { clef: "treble", midi: 14 },
  Piano: { clef: "treble", midi: 0 }, Harpsichord: { clef: "treble", midi: 6 }, Organ: { clef: "treble", midi: 19 }, Celesta: { clef: "treble", midi: 8 },
  Soprano: { clef: "treble", midi: 52 }, "Mezzo-soprano": { clef: "treble", midi: 52 }, Tenor: { clef: "treble", midi: 52 },
  Baritone: { clef: "bass", midi: 52 }, Bass: { clef: "bass", midi: 52 },
  "Electric Guitar": { clef: "treble", midi: 27 }, "Acoustic Guitar": { clef: "treble", midi: 25 }, "Bass Guitar": { clef: "bass", midi: 33 },
  Synthesizer: { clef: "treble", midi: 81 }, "Electric Piano": { clef: "treble", midi: 4 },
};
export const getMeta = (name) => INSTR_META[name] || { clef: "treble", midi: 0 };

// ── Colour helpers ────────────────────────────────────────────────────────────
export function groupColor(g) {
  return (
    {
      Strings: "#b8935a", Brass: "#d4834a", Woodwinds: "#6ab898", Percussion: "#c46878",
      Keyboard: "#7aa4c4", Voice: "#b48ac0", "Guitar/Bass": "#98b86a", Electronic: "#6ab8b8",
    }[g] || "#888"
  );
}

export function genreColor(genre = "") {
  const g = genre.toLowerCase();
  if (g.includes("classic") || g.includes("baroque") || g.includes("romantic")) return "#b48ac0";
  if (g.includes("jazz")) return "#d4834a";
  if (g.includes("rock") || g.includes("pop")) return "#c46878";
  if (g.includes("folk") || g.includes("count")) return "#98b86a";
  if (g.includes("electronic") || g.includes("synth")) return "#6ab8b8";
  if (g.includes("film") || g.includes("cinema")) return "#7aa4c4";
  return "#9a8868";
}

// ── Design system tokens ──────────────────────────────────────────────────────
export const S = {
  bg: "#0d0b08", surface: "#181410", surface2: "#201c14",
  border: "#2c2418", gold: "#c8a050", goldDim: "#7a6030",
  text: "#ece0c8", muted: "#9a8868",
};

export const SERIF = "'Palatino Linotype',Palatino,serif";
