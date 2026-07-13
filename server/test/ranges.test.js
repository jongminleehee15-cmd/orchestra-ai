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

test("checkPartRange tolerates a boundary semitone (key signature is not parsed)", () => {
  // Flute bottom is C4 (60). A written B3 (59) reads one semitone low — could
  // be a key-signature artifact, so it must NOT be flagged…
  assert.ok(checkPartRange(part("C clef=treble", "B,8 |]"), "Flute").ok);
  // …but a clear violation (Bb3 → 58) must be.
  assert.equal(checkPartRange(part("C clef=treble", "_B,8 |]"), "Flute").ok, false);
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
