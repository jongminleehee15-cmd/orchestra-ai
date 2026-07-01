// Server-side instrument metadata: clef per instrument, plus role guardrails
// (which instruments must never carry the melody). Used when building prompts.

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

// Numbered voices ("Trumpet 1", "Violin 2") share the base instrument's metadata.
export const baseName = (name) => String(name || "").replace(/\s+\d+$/, "");
export const getMeta = (name) => INSTR_META[baseName(name)] || INSTR_META[name] || { clef: "treble" };

// Instruments that should never be assigned the main melody.
export const BASS_INSTRUMENTS = new Set([
  "Tuba", "Double Bass", "Bass Guitar", "Bassoon", "Trombone",
]);
export const PERCUSSION_INSTRUMENTS = new Set([
  "Timpani", "Xylophone", "Marimba", "Vibraphone", "Glockenspiel", "Tubular Bells",
]);
