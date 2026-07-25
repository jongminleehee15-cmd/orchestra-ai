// Shared conversion core for imported symbolic scores (MusicXML, MIDI).
// Parsers hand this module per-measure note events; it emits the pipeline's
// canonical ABC melody measures (L:1/8 units) with key-signature-aware
// accidental spelling, pickup/short-bar rest padding, and duration encoding.
// The output must then pass analyzeMelody — the same gate every other
// verified source goes through.

// ── Keys ─────────────────────────────────────────────────────────────────────
const MAJORS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINORS = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"];
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
export const STEP_SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// fifths (-7..7) + minor flag → the compact key string the pipeline uses.
export function keyName(fifths, minor = false) {
  const i = Math.max(0, Math.min(14, (Number(fifths) || 0) + 7));
  return (minor ? MINORS : MAJORS)[i];
}

// step → default alter under this key signature.
export function keyAlters(fifths) {
  const f = Number(fifths) || 0;
  const map = {};
  if (f > 0) for (let i = 0; i < Math.min(f, 7); i++) map[SHARP_ORDER[i]] = 1;
  if (f < 0) for (let i = 0; i < Math.min(-f, 7); i++) map[FLAT_ORDER[i]] = -1;
  return map;
}

// The tonic triad for a key string — the deterministic chord fallback when
// harmonization fails. Modal keys collapse to their nearest tonal triad.
export function tonicChord(key) {
  const m = String(key || "C").match(/^([A-G][b#]?)(m(?![i])|dor|phr|loc|mix|lyd)?/);
  if (!m) return "C";
  const minorish = m[2] && ["m", "dor", "phr", "loc"].includes(m[2]);
  return m[1] + (minorish ? "m" : "");
}

// MIDI number for a spelled pitch (C4 = 60).
export function midiOf({ step, alter = 0, octave }) {
  return (octave + 1) * 12 + STEP_SEMIS[step] + alter;
}

// Spell a raw MIDI pitch in a key: sharps in sharp keys, flats in flat keys.
const SHARP_SPELL = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const FLAT_SPELL = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];
export function spellMidi(midi, fifths = 0) {
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] = (fifths < 0 ? FLAT_SPELL : SHARP_SPELL)[pc];
  const octave = Math.round((midi - alter - STEP_SEMIS[step]) / 12) - 1;
  return { step, alter, octave };
}

// ABC pitch letter with octave marks (C4 = "C", C5 = "c", C6 = "c'", C3 = "C,").
export function abcPitch(step, octave) {
  if (octave >= 5) return step.toLowerCase() + "'".repeat(octave - 5);
  return step.toUpperCase() + ",".repeat(Math.max(0, 4 - octave));
}

// ABC length suffix for a duration in L:1/8 units. null = unrepresentable
// (true tuplet values — the caller decides whether to round or reject).
//
// Tried representing exact thirds/sixths as literal "2/3"-style fractions
// (a genuine MusicXML triplet duration) — abcjs's own parser rejects that
// syntax outright ("Duration not representable"), so a bar that passed our
// bar-math validator would still fail to render/play in the app. Real ABC
// tuplets need "(3"-prefixed note groups at NORMAL length, not fractional
// note lengths — a bigger, separate feature (would also need to read each
// note's MusicXML <time-modification>, which the parser currently discards).
// Not attempted here; grid-snapping (with its bar-math rejection as the
// safety net) stays the correct, safe behavior until that's built.
export function lenSuffix(u) {
  const near = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  if (near(u)) { const n = Math.round(u); return n === 1 ? "" : String(n); }
  if (near(u * 2)) { const n = Math.round(u * 2); return n === 1 ? "/" : `${n}/2`; }
  if (near(u * 4)) return `${Math.round(u * 4)}/4`;
  if (near(u * 8)) return `${Math.round(u * 8)}/8`;
  return null;
}

// Rest token(s) totalling `u` eighth-units.
export function restTokens(u) {
  const out = [];
  for (const size of [8, 4, 2, 1, 0.5, 0.25]) {
    while (u >= size - 1e-6) {
      out.push(`z${lenSuffix(size)}`);
      u -= size;
    }
  }
  return out;
}

// ── The converter ────────────────────────────────────────────────────────────
// measures: array of bars; each bar an ordered event list
//   { dur (eighth-units), rest?, tie?, midi? } or { dur, step, alter, octave, tie? }
// Durations that don't sit on the 32nd grid are rounded onto it (tuplets) —
// the caller's final analyzeMelody validation rejects bars that drift.
export function eventsToMeasures({ measures, timeSignature, fifths = 0 }) {
  const [num, den] = String(timeSignature).split("/").map(Number);
  const barUnits = (num || 4) * 8 / (den || 4);
  const keyAlt = keyAlters(fifths);
  const out = [];

  measures.forEach((events, mi) => {
    const state = {}; // "step+octave" → alter active for the rest of this bar
    const toks = [];
    let used = 0;

    for (const ev of events) {
      let dur = ev.dur;
      let suf = lenSuffix(dur);
      if (suf === null) {
        dur = Math.round(dur * 4) / 4; // snap tuplets to the 32nd grid
        suf = lenSuffix(dur);
        if (suf === null || dur <= 0) continue;
      }
      if (ev.rest) { toks.push(`z${suf}`); used += dur; continue; }

      const sp = ev.step ? ev : spellMidi(ev.midi, fifths);
      const id = `${sp.step}${sp.octave}`;
      const alter = sp.alter || 0;
      const current = id in state ? state[id] : (keyAlt[sp.step] || 0);
      let acc = "";
      if (alter !== current) {
        acc = alter === 0 ? "=" : alter > 0 ? "^".repeat(alter) : "_".repeat(-alter);
        state[id] = alter;
      }
      toks.push(acc + abcPitch(sp.step, sp.octave) + suf + (ev.tie ? "-" : ""));
      used += dur;
    }

    // Pickup bars get leading rests; a short final/other bar gets trailing
    // rests. Overfull bars are left for the validation gate to reject.
    if (used < barUnits - 1e-6) {
      const pad = restTokens(barUnits - used);
      if (mi === 0) toks.unshift(...pad);
      else toks.push(...pad);
    }
    out.push(toks.join(""));
  });

  // Silence at the edges (a melody part that waits out an intro) is not tune.
  const isRestBar = (m) => !/[a-gA-G]/.test(m);
  while (out.length && isRestBar(out[0])) out.shift();
  while (out.length && isRestBar(out[out.length - 1])) out.pop();
  return out;
}
