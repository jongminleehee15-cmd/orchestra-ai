// Instrument range data + validator: pitch math, written-pitch shifts for
// transposing instruments, and out-of-range detection in generated parts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SOUNDING_RANGES, WRITTEN_SHIFT, midiToName, midiToAbc, writtenRangeInfo, checkPartRange, enforceRange,
} from "../lib/ranges.js";
import { INSTR_META } from "../lib/instrMeta.js";

const part = (key, body) => `X:1\nT:Test\nM:4/4\nL:1/8\nQ:1/4=90\nK:${key}\n${body}`;

test("every catalog instrument has range data, and every range is sane", () => {
  for (const name of Object.keys(INSTR_META)) {
    const r = SOUNDING_RANGES[name];
    assert.ok(r, `${name} is missing from SOUNDING_RANGES`);
    assert.ok(r.lo < r.hi, `${name}: lo < hi`);
    assert.ok(r.lo <= r.comfortLo && r.comfortLo < r.comfortHi && r.comfortHi <= r.hi, `${name}: comfort band inside hard range`);
  }
  for (const name of Object.keys(WRITTEN_SHIFT)) {
    assert.ok(SOUNDING_RANGES[name], `WRITTEN_SHIFT entry ${name} has no range`);
  }
});

test("midi ↔ name/abc formatting", () => {
  assert.equal(midiToName(60), "C4");
  assert.equal(midiToName(54), "F#3");
  assert.equal(midiToAbc(60), "C");
  assert.equal(midiToAbc(72), "c");
  assert.equal(midiToAbc(84), "c'");
  assert.equal(midiToAbc(48), "C,");
  assert.equal(midiToAbc(36), "C,,");
  assert.equal(midiToAbc(54), "^F,");
  assert.equal(midiToAbc(91), "g'");
});

test("writtenRangeInfo shifts transposing instruments and strips voice numbers", () => {
  // Trumpet sounds E3 (52) at the bottom; written a major 2nd up → F#3 (54).
  const t = writtenRangeInfo("Trumpet 2");
  assert.equal(t.lo.midi, 54);
  assert.equal(t.lo.name, "F#3");
  assert.equal(t.lo.abc, "^F,");
  assert.ok(t.shifted);
  // Cello is non-transposing: written = sounding C2.
  const c = writtenRangeInfo("Cello");
  assert.equal(c.lo.midi, 36);
  assert.equal(c.lo.abc, "C,,");
  assert.ok(!c.shifted);
  // Unknown instruments fail open.
  assert.equal(writtenRangeInfo("Kazoo"), null);
});

test("checkPartRange passes an in-range part", () => {
  const res = checkPartRange(part("C clef=treble", "G,2 A,2 B,2 C2 | d2 e2 f2 g2 |]"), "Violin");
  assert.deepEqual(res.problems, []);
  assert.ok(res.ok);
});

test("checkPartRange flags notes below and above the range, chords included", () => {
  // Violin bottom is G3 ("G,"): G,, (G2) is below; b''' is stratospheric.
  const res = checkPartRange(part("C clef=treble", "G,,2 A2 B2 c2 | [C,eg]2 b'''2 c4 |]"), "Violin");
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes("measure 1") && p.includes("BELOW")), `low note flagged: ${res.problems}`);
  assert.ok(res.problems.some((p) => p.includes("measure 2") && p.includes("BELOW")), `chord bottom note flagged: ${res.problems}`);
  assert.ok(res.problems.some((p) => p.includes("measure 2") && p.includes("ABOVE")), `high note flagged: ${res.problems}`);
});

test("checkPartRange reads the key signature and bar accidentals, with no slack", () => {
  // The live case (2026-09-27): a Cello part in D with the tune at the
  // violin's octave. "f" is F#5 in D major, above the Cello's E5; the old
  // key-blind reader saw F5 and let it through on a semitone of slack.
  const cello = checkPartRange(part("D clef=bass", "f4 e4 | d4 c4 |]"), "Cello");
  assert.equal(cello.ok, false);
  assert.match(cello.problems[0], /measure 1: "f4" \(F#5\) is ABOVE Cello's playable range/);
  assert.equal(cello.problems.length, 1, "E5 is the Cello's top: e4 is in range");
  // Flute bottom is C4: a written B3 is below it. No semitone of slack now.
  assert.equal(checkPartRange(part("C clef=treble", "B,8 |]"), "Flute").ok, false);
  // A flat key lowers a letter out of range: C in Gb major is Cb4 (B3).
  assert.equal(checkPartRange(part("Gb clef=treble", "C8 |]"), "Flute").ok, false);
  assert.ok(checkPartRange(part("G clef=treble", "C8 |]"), "Flute").ok);
  // An accidental holds to the barline: both C's in bar 1 are Cb4, bar 2's is C4.
  const held = checkPartRange(part("C clef=treble", "_C4 C4 | C8 |]"), "Flute");
  assert.equal(held.problems.length, 2);
  assert.ok(held.problems.every((p) => p.startsWith("measure 1:")));
});

test("enforceRange moving one note never changes another note's pitch", () => {
  // Flute, too wide to shift whole: F#3 goes up to F#4, and the F natural
  // after it in that octave must now say so (=F), or it would read as F#4.
  const res = enforceRange(part("C clef=treble", "^F,2 F2 c''4 |]"), "Flute");
  assert.ok(res.changed);
  assert.match(res.abc, /\n\^F2 =F2 c''4 \|\]/, res.abc);
  assert.ok(checkPartRange(res.abc, "Flute").ok);
});

test("enforceRange shifts a too-low measure up an octave, whole and intact", () => {
  // Flute floor is C4: this measure sits around G3 → whole measure goes up 8va.
  const res = enforceRange(part("C clef=treble", "!mf! G,2 A,2 B,2 C2 | c2 d2 e2 f2 |]"), "Flute");
  assert.ok(res.changed);
  assert.match(res.changes[0], /measure 1: shifted the whole measure up 1 octave/);
  assert.match(res.abc, /!mf! G2 A2 B2 c2/, `contour and dynamics preserved: ${res.abc}`);
  assert.match(res.abc, /c2 d2 e2 f2/, "in-range measure untouched");
  assert.ok(checkPartRange(res.abc, "Flute").ok, "result is fully in range");
  assert.match(res.abc, /^X:1\n/, "header preserved");
});

test("enforceRange moves single offenders when the measure spans too wide", () => {
  // C3 is below the flute floor but the measure also holds a note near the
  // ceiling, so the whole measure can't shift — only the low note moves.
  const res = enforceRange(part("C clef=treble", "C,2 c''6 |]"), "Flute");
  assert.ok(res.changed);
  assert.match(res.changes[0], /moved 1 out-of-range note/);
  assert.match(res.abc, /C2 c''6/, `only the low note moved: ${res.abc}`);
});

test("enforceRange pulls a stratospheric note down and leaves clean parts alone", () => {
  const high = enforceRange(part("C clef=treble", "b'''8 |]"), "Violin");
  assert.ok(high.changed);
  assert.match(high.abc, /\nb8 \|\]/, `two octaves down into range (B5): ${high.abc}`);
  assert.ok(checkPartRange(high.abc, "Violin").ok);
  const clean = part("C clef=treble", "G,2 A,2 B,2 C2 | d8 |]");
  const res = enforceRange(clean, "Violin");
  assert.equal(res.changed, false);
  assert.equal(res.abc, clean, "untouched ABC is returned byte-identical");
});

test("checkPartRange validates the transposing instrument's WRITTEN range", () => {
  // Trumpet written range bottom is F#3 (54). Written C4 ("C") is fine even
  // though it *sounds* Bb3; written G3 with tolerance… G3=55 ok; E3 (52 < 53) flagged.
  assert.ok(checkPartRange(part("D clef=treble", "C8 |]"), "Trumpet").ok);
  assert.equal(checkPartRange(part("D clef=treble", "E,8 |]"), "Trumpet").ok, false);
});

// ── Octave moves, melody placement ──────────────────────────────────────────
import { moveOctaves, keyFifths } from "../lib/transpose.js";
import { phraseOctave, melodyPlacement, placeMelodyPhrases, shiftOctaves, partKey } from "../lib/ranges.js";
import { measurePitchEvents, partMeasures } from "../lib/partCheck.js";
import { scanMeasure } from "../lib/abcMelody.js";

const readBar = (bar, fifths) => measurePitchEvents(bar, "4/4", fifths).map((e) => ({ len: e.len, pitches: e.pitches }));

test("moveOctaves: every note reads as the original moved by its octaves, nothing else changes", () => {
  // Random bars with accidentals (held, cancelled, doubled), chords, grace
  // notes and decorations, in every key; each note moved -2..+2 octaves at
  // random. Read back by the repo's own parser.
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const note = () => ["", "", "", "^", "_", "=", "^^", "__"][rnd(8)] + "CDEFGABcdefgab"[rnd(14)] + ["", "", ",", "'"][rnd(4)];
  const bar = () => Array.from({ length: 5 }, () => {
    const r = rnd(8);
    if (r === 0) return `[${note()}${note()}]2`;
    if (r === 1) return `{${note()}}${note()}`;
    if (r === 2) return `!f!${note()}2`;
    if (r === 3) return "z";
    return `${note()}${["", "2", "/"][rnd(3)]}`;
  }).join(" ");
  for (let fifths = -7; fifths <= 7; fifths++) {
    for (let t = 0; t < 60; t++) {
      const src = bar();
      const shifts = [];
      const { text } = moveOctaves(src, fifths, (midi, inGrace) => { const k = inGrace ? 0 : rnd(5) - 2; if (!inGrace) shifts.push(k); return k; });
      const a = readBar(src, fifths);
      const b = readBar(text, fifths);
      assert.equal(b.length, a.length, `${src} -> ${text}`);
      let i = 0;
      a.forEach((e, j) => {
        assert.equal(b[j].len, e.len);
        assert.deepEqual(b[j].pitches, e.pitches.map((p) => p + 12 * shifts[i++]), `key ${fifths}: ${src} -> ${text}`);
      });
      assert.equal(scanMeasure(text, "4/4").length, scanMeasure(src, "4/4").length);
    }
  }
});

test("moveOctaves with no move returns the text byte-identical", () => {
  const src = "^F2 ^F2 =F2 [ceg]2 {a}b2 |";
  assert.equal(moveOctaves(src, 0, () => 0).text, src);
});

test("phraseOctave: most notes in the comfortable band, smallest move, never out of the hard range", () => {
  // Canon in D's opening, F#5 down to A4, at the canonical octave.
  const canon = [78, 76, 74, 73, 71, 69, 71, 73];
  assert.equal(phraseOctave(canon, "Violin"), 0, "already comfortable: left alone");
  assert.equal(phraseOctave(canon, "Cello"), -1, "down an octave to F#4-A3");
  assert.equal(phraseOctave(canon, "Tuba"), -2);
  assert.equal(phraseOctave(canon, "Piccolo"), 1, "a piccolo moves UP");
  // Nothing fits the hard range at any octave (a 4-octave span): leave it,
  // the hard-range fix handles it.
  assert.equal(phraseOctave([36, 84], "Flute"), 0);
  assert.equal(phraseOctave([], "Cello"), 0);
  assert.equal(phraseOctave([60], "Kazoo"), 0, "no range data: no move");
});

test("placeMelodyPhrases: the live Cello part's melody moves down a whole octave, accompaniment untouched", () => {
  const cello = "X:1\nT:Cello\nM:4/4\nL:1/8\nQ:1/4=56\nK:D clef=bass\n!p!(f4 e4) | !mp!(d4 c4) | !mf!(B4 A4) | !mf!(B4 c4) |\n!ff!D,,4 A,,4 | !ff!B,,2 D,2 F,2 A,2 | !f!G,,2 B,,2 D,2 G,2 | !mp!G,,2 A,,2 D,2 C2 |]";
  const r = placeMelodyPhrases(cello, "Cello", ["mm.1-4"]);
  assert.deepEqual(r.changes, ["measures 1-4: the melody was moved down 1 octave so it sits in the Cello's comfortable range"]);
  const bars = partMeasures(r.abc);
  assert.deepEqual(bars.slice(0, 4).map((b) => b.trim()), ["!p!(F4 E4)", "!mp!(D4 C4)", "!mf!(B,4 A,4)", "!mf!(B,4 C4)"]);
  assert.deepEqual(bars.slice(4), partMeasures(cello).slice(4), "accompaniment bars byte-identical");
  assert.ok(checkPartRange(r.abc, "Cello").ok);
  // Idempotent: a placed part stays put.
  assert.deepEqual(placeMelodyPhrases(r.abc, "Cello", ["mm.1-4"]).changes, []);
  // A Violin with the same tune is already comfortable: nothing moves.
  const violin = cello.replace("clef=bass", "clef=treble");
  assert.equal(placeMelodyPhrases(violin, "Violin", ["mm.1-4"]).abc, violin);
});

test("melodyPlacement reads the melody the part is handed, section by section", () => {
  const canon = "f4 e4 | d4 c4 | B4 A4 | B4 c4 | d4 c4 | B4 A4 | G4 F4 | G4 E4 |]";
  assert.deepEqual(melodyPlacement(canon, keyFifths("D"), "4/4", ["mm.1-4", "mm.5-8"], "Cello").map((s) => s.k), [-1, -1]);
  assert.deepEqual(melodyPlacement(canon, keyFifths("D"), "4/4", ["mm.1-4"], "Violin").map((s) => s.k), [0]);
  assert.equal(shiftOctaves("f4 e4", keyFifths("D"), -1), "F4 E4");
  assert.deepEqual(partKey("X:1\nM:3/8\nK:Em clef=treble\nE3 |]"), { fifths: 1, timeSignature: "3/8" });
});
