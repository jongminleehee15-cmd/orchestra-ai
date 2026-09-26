// The deterministic melody validator must never regress: it is what turns
// "the model promised to play the tune" into a checked guarantee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPartMelody, tokenizeMeasure, partMeasures } from "../lib/partCheck.js";

const MELODY = "F2 F2 G2 A2 | A2 G2 F2 E2 | D2 D2 E2 F2 | F3 E E4 |]"; // Ode mm.1-4 (concert D)

function wrap(body, key = "D") {
  return `X:1\nT:Test\nM:4/4\nL:1/8\nQ:1/4=120\nK:${key}\n${body}`;
}

test("verbatim reproduction passes", () => {
  const part = wrap("F2 F2 G2 A2 | A2 G2 F2 E2 | D2 D2 E2 F2 | F3 E E4 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.deepEqual(r.problems, []);
});

test("transposed reproduction passes (contour is transposition-invariant)", () => {
  // Up a whole step (written for Bb instrument): F->G, G->A, A->B, E->F, D->E
  const part = wrap("G2 G2 A2 B2 | B2 A2 G2 F2 | E2 E2 F2 G2 | G3 F F4 |]", "E");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.deepEqual(r.problems, []);
});

test("octave-shifted reproduction passes", () => {
  const part = wrap("f2 f2 g2 a2 | a2 g2 f2 e2 | d2 d2 e2 f2 | f3 e e4 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.deepEqual(r.problems, []);
});

test("dynamics, slurs, and annotations are ignored", () => {
  const part = wrap('!mf!"D"(F2 F2) G2 A2 | A2 G2 F2 E2 | !f!D2 D2 E2 F2 | F3 E E4 |]');
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.deepEqual(r.problems, []);
});

test("flattened rhythm is caught", () => {
  // Measure 4 dotted figure flattened to even quarters
  const part = wrap("F2 F2 G2 A2 | A2 G2 F2 E2 | D2 D2 E2 F2 | F2 E2 E4 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /measure 4/);
  assert.match(r.problems[0], /rhythm/);
});

test("wrong contour (different tune) is caught", () => {
  // Measure 1 inverted: falls instead of rises
  const part = wrap("F2 F2 E2 D2 | A2 G2 F2 E2 | D2 D2 E2 F2 | F3 E E4 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /measure 1/);
  assert.match(r.problems[0], /contour/);
});

test("dropped notes are caught", () => {
  const part = wrap("F2 F2 G4 | A2 G2 F2 E2 | D2 D2 E2 F2 | F3 E E4 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-4"]);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /expected 4 notes/);
});

test("only assigned melody measures are checked", () => {
  // mm.3-4 are free accompaniment — deviations there must NOT be flagged
  const part = wrap("F2 F2 G2 A2 | A2 G2 F2 E2 | D8 | A,8 |]");
  const r = checkPartMelody(part, MELODY, ["mm.1-2"]);
  assert.deepEqual(r.problems, []);
});

test("chords contribute their top note", () => {
  const toks = tokenizeMeasure("[DF]2 [DF]2 [EG]2 [FA]2");
  assert.deepEqual(toks.map((t) => t.len), [2, 2, 2, 2]);
  // top notes F F G A rise: F<G<A
  assert.ok(toks[2].st > toks[1].st && toks[3].st > toks[2].st);
});

test("partMeasures strips headers and joins wrapped body lines", () => {
  const part = wrap("F2 F2 G2 A2 |\nA2 G2 F2 E2 |]");
  assert.equal(partMeasures(part).length, 2);
});

test("interval-exact checking catches a wrong interval that contour accepts", () => {
  // Concert D: the tune is F# F# G A — it rises a SEMITONE from note 2 to 3.
  const tune = "F2 F2 G2 A2 |]";
  // Same shape (up, up) but the wrong distances. Contour only sees direction,
  // so this passes it; interval sizes expose it.
  const wrongSizes = wrap("F2 F2 A2 B2 |]", "D");
  assert.deepEqual(
    checkPartMelody(wrongSizes, tune, ["mm.1-1"], 0, "4/4").problems, [],
    "contour alone cannot see this",
  );
  const caught = checkPartMelody(wrongSizes, tune, ["mm.1-1"], 0, "4/4", 2, 2);
  assert.equal(caught.problems.length, 1);
  assert.match(caught.problems[0], /note 3 sits 2 semitones too high/);

  // Still transposition-invariant: a Bb instrument reading in E (4 sharps)
  // plays the identical tune and must pass.
  assert.deepEqual(
    checkPartMelody(wrap("G2 G2 A2 B2 |]", "E"), tune, ["mm.1-1"], 0, "4/4", 2, 4).problems, [],
    "a genuine Bb transposition is not an error",
  );
  // And an octave shift, which moves every pitch equally.
  assert.deepEqual(
    checkPartMelody(wrap("f2 f2 g2 a2 |]", "D"), tune, ["mm.1-1"], 0, "4/4", 2, 2).problems, [],
  );

  // The check is OPT-IN: without both key signatures it must not fire, since
  // reading keyed music as if it were in C would mis-resolve every accidental.
  assert.deepEqual(
    checkPartMelody(wrap("G2 G2 A2 B2 |]", "E"), tune, ["mm.1-1"], 0, "4/4").problems, [],
  );
});

test("accidentals carry to the end of the bar, as a player reads them", () => {
  // An explicit ^F applies to every later F in that bar, and "=" cancels it.
  const withCarry = tokenizeMeasure("^F2 F2", "4/4", 0).map((n) => n.st);
  assert.equal(withCarry[0], withCarry[1], "the second F inherits the sharp");
  const cancelled = tokenizeMeasure("^F2 =F2", "4/4", 0).map((n) => n.st);
  assert.equal(cancelled[0] - cancelled[1], 1, "the natural cancels it");
  // The key signature supplies the sharp when nothing is written.
  const keyed = tokenizeMeasure("F2", "4/4", 2).map((n) => n.st);
  const plain = tokenizeMeasure("F2", "4/4", 0).map((n) => n.st);
  assert.equal(keyed[0] - plain[0], 1, "D major sharpens F");
});

test("a chord's length counts the same written inside or outside the bracket", () => {
  // tokenizeMeasure used to run its own duration parser that only understood
  // "[CEG]2", so "[C2E2G2]" measured as a single eighth and a part spelling a
  // chord that way was reported as a phantom rhythm difference.
  assert.equal(tokenizeMeasure("[C2E2G2]")[0].len, 2);
  assert.equal(tokenizeMeasure("[CEG]2")[0].len, 2);
  assert.equal(tokenizeMeasure("[C2E2G2]")[0].st, tokenizeMeasure("[CEG]2")[0].st);
});

test("tuplet measures are compared instead of being skipped", () => {
  // Both the canonical melody and the part used to be waved through whenever
  // either contained "(3", so a part that replaced a triplet figure with
  // something else entirely passed melody validation unchecked.
  const triplets = "(3CDE (3FGA (3Bcd (3efg";
  const matching = checkPartMelody(wrap(`${triplets} |]`), triplets, ["mm.1-1"], 0, "4/4");
  assert.deepEqual(matching.problems, [], "an identical triplet bar still passes");

  const flattened = checkPartMelody(wrap("C2 E2 G2 E2 |]"), triplets, ["mm.1-1"], 0, "4/4");
  assert.equal(flattened.problems.length, 1, "a flattened rhythm is now caught");
  assert.match(flattened.problems[0], /expected 12 notes/);
});
