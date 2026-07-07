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
