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

export const STYLES      = ["Cinematic", "Romantic", "Baroque", "Jazz", "Minimalist", "Epic", "Playful", "Mysterious", "Impressionist"];
export const DENSITIES   = ["Sparse", "Moderate", "Full", "Lush"];
export const TEMPOS_FEEL  = ["Slow", "Moderate", "Upbeat", "Fast"];
export const MEASURE_OPTIONS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];

export const INSTR_META = {
  Violin: { clef: "treble" }, Viola: { clef: "alto" }, Cello: { clef: "bass" },
  "Double Bass": { clef: "bass" }, Harp: { clef: "treble" }, "Classical Guitar": { clef: "treble" },
  "French Horn": { clef: "treble" }, Trumpet: { clef: "treble" }, Flugelhorn: { clef: "treble" },
  Trombone: { clef: "bass" }, Tuba: { clef: "bass" },
  Flute: { clef: "treble" }, Piccolo: { clef: "treble" }, Oboe: { clef: "treble" },
  Clarinet: { clef: "treble" }, Bassoon: { clef: "bass" }, "English Horn": { clef: "treble" },
  "Alto Sax": { clef: "treble" }, "Tenor Sax": { clef: "treble" },
  Timpani: { clef: "bass" }, Xylophone: { clef: "treble" }, Marimba: { clef: "treble" },
  Vibraphone: { clef: "treble" }, Glockenspiel: { clef: "treble" }, "Tubular Bells": { clef: "treble" },
  Piano: { clef: "treble" }, Harpsichord: { clef: "treble" }, Organ: { clef: "treble" }, Celesta: { clef: "treble" },
  Soprano: { clef: "treble" }, "Mezzo-soprano": { clef: "treble" }, Tenor: { clef: "treble" },
  Baritone: { clef: "bass" }, Bass: { clef: "bass" },
  "Electric Guitar": { clef: "treble" }, "Acoustic Guitar": { clef: "treble" }, "Bass Guitar": { clef: "bass" },
  Synthesizer: { clef: "treble" }, "Electric Piano": { clef: "treble" },
};
export const getMeta = (name) => INSTR_META[name] || { clef: "treble" };

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
