// The library is the app's accuracy promise: every work must parse, every bar
// must sum to its meter, every measure must carry a chord. A failing test here
// means bad data reached data/scores — treat as a build failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLibrary, searchLibrary, getWork, parseAbcWork } from "../lib/library.js";
import { analyzeMelody } from "../lib/abcMelody.js";

test("library loads at least the starter catalog", () => {
  const works = loadLibrary();
  assert.ok(works.length >= 7, `expected >= 7 works, got ${works.length}`);
});

test("every work passes bar-math validation and has full chord coverage", () => {
  for (const w of loadLibrary()) {
    const analysis = analyzeMelody(w.melodyAbc, w.timeSignature, w.measures);
    assert.deepEqual(analysis.problems, [], `${w.id}: ${analysis.problems.join("; ")}`);
    assert.equal(w.chords.length, w.measures, `${w.id}: chords/measures mismatch`);
    assert.ok(w.chords.every(Boolean), `${w.id}: empty chord annotation`);
    assert.ok(w.title && w.composer && w.key, `${w.id}: missing metadata`);
  }
});

test("search is diacritic- and case-insensitive and matches aliases", () => {
  assert.equal(searchLibrary("frere jacques")[0]?.id, "frere-jacques");
  assert.equal(searchLibrary("FRÈRE")[0]?.id, "frere-jacques");
  assert.equal(searchLibrary("beethoven")[0]?.id, "ode-to-joy");
  assert.ok(searchLibrary("brother john").some((w) => w.id === "frere-jacques"));
  assert.equal(searchLibrary("zzzz nonexistent").length, 0);
});

test("getWork returns melody measures that reassemble into melodyAbc", () => {
  const w = getWork("ode-to-joy");
  assert.ok(w);
  assert.equal(w.measures, 16);
  assert.equal(`${w.melodyMeasures.join(" | ")} |]`, w.melodyAbc);
  assert.ok(!w.melodyAbc.includes('"'), "chord annotations must be stripped from melodyAbc");
});

test("parseAbcWork rejects malformed input", () => {
  assert.throws(() => parseAbcWork("X:1\nT:Bad\nM:4/4\nL:1/4\nK:C\nC4|", "bad"), /L: must be 1\/8/);
  assert.throws(
    () => parseAbcWork('X:1\nT:Short bar\nM:4/4\nL:1/8\nK:C\n"C" C2 C2 |]', "short"),
    /bar-math/,
  );
  assert.throws(
    () => parseAbcWork("X:1\nT:No chords\nM:4/4\nL:1/8\nK:C\nC2 C2 C2 C2 |]", "nochord"),
    /no chord annotation/,
  );
});
