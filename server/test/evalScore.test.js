// The offline evaluation harness (eval/): scoring, comparison, the suite and
// the blind-test pages. All offline: saved runs are read from eval/runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import abcjs from "abcjs";
import { scoreRun, planChordFit, metricValue, REPORT_METRICS } from "../../eval/score.js";
import { summarize, verdict, fmt } from "../../eval/compare.js";
import { blindAbc } from "../../eval/blindAbc.js";
import { loadLibrary } from "../lib/library.js";
import { ALL_INSTRUMENTS } from "../../src/lib/constants.js";

const hdr = (name, key = "C", clef = "treble") => `X:1\nT:${name}\nM:4/4\nL:1/8\nQ:1/4=100\nK:${key} clef=${clef}\n`;
const RUNS = new URL("../../eval/runs/", import.meta.url);
const loadRun = (label, file) => JSON.parse(readFileSync(new URL(`${label}/${file}`, RUNS), "utf8"));

// One known defect per part, each counted by hand.
const faulty = () => ({
  common: { key: "C", timeSignature: "4/4", measures: 4 },
  voices: ["Flute", "Cello", "Clarinet"],
  plan: {
    measures: 4, chords: ["C", "F", "G", "C"],
    melodyAbc: "c2 d2 e2 f2 | a2 g2 f2 e2 | d2 B2 G2 B2 | c8 |]",
    instrumentRoles: { Flute: { melodySections: ["mm.1-4"] }, Cello: { primaryRole: "bass", melodySections: [] }, Clarinet: { melodySections: [] } },
  },
  parts: [
    { instrName: "Flute", abc: hdr("Flute") + "c2 d2 e2 f2 | a2 g2 f2 d2 | d2 B2 G2 B2 | c8 |]" }, // bar 2: wrong last note
    // bar 2: D E G B over F (no chord tone); bar 3: 6 units, not 8; bar 4: C1, below the cello
    { instrName: "Cello", abc: hdr("Cello", "C", "bass") + "C,8 | D,2 E,2 G,2 B,,2 | G,,6 | C,,,8 |]" },
    // concert C F G C, correctly written a tone up (reads in D)
    { instrName: "Clarinet", abc: hdr("Clarinet", "D") + "D2 F2 A2 F2 | G2 B2 d2 B2 | A2 c2 e2 c2 | D2 F2 A2 F2 |]" },
  ],
});

test("each kind of defect is counted exactly once, where it is", () => {
  const { metrics: m } = scoreRun(faulty());
  assert.equal(m.melodyMismatch, 1, "Flute bar 2");
  assert.equal(m.melodyBars, 4);
  assert.equal(m.barErrors, 1, "Cello bar 3");
  assert.equal(m.rangeNotes, 1, "Cello bar 4 (B,, in bar 2 is B2, inside the range)");
  assert.equal(m.harmonyFlagged, 1, "Cello bar 2");
  assert.equal(m.harmonyChecked, 8, "Cello and Clarinet, 4 accompaniment bars each");
  assert.equal(m.mistransposed, 0);
  assert.equal(m.transposingParts, 1);
  assert.equal(m.lengthErrors, 0);
  assert.equal(m.missingParts, 0);
  assert.equal(m.uncoveredBars, 0);
  assert.equal(m.planChordFlagged, 0);
});

test("a transposing part written at concert pitch by mistake is caught", () => {
  const run = faulty();
  run.parts[2].abc = hdr("Clarinet", "D") + "C2 E2 G2 E2 | F2 A2 c2 A2 | G2 B2 d2 B2 | C2 E2 G2 E2 |]";
  const r = scoreRun(run);
  assert.equal(r.metrics.mistransposed, 1);
  const t = r.perPart.find((p) => p.instrName === "Clarinet").transposition;
  assert.ok(t.none > t.right, "it fits the chords better read unshifted");
});

test("a failed or missing part is counted, and scoring still works", () => {
  const run = faulty();
  run.parts[1] = { instrName: "Cello", abc: null, error: "POST /api/part -> 500" };
  const { metrics: m } = scoreRun(run);
  assert.equal(m.missingParts, 1);
  assert.equal(m.barErrors, 0, "the Cello's bad bar went with it");
  assert.equal(m.partBars, 8);
});

test("counts are not capped at the UI's 8 warnings, and every voicing warning has a kind", () => {
  const bars = (first, rest) => [first, ...Array(9).fill(rest)].join(" | ") + " |]";
  const none = { melodySections: [] };
  const run = {
    common: { key: "C", timeSignature: "4/4", measures: 10 },
    voices: ["Flute", "Violin 1", "Violin 2", "Bassoon", "Trombone"],
    plan: {
      measures: 10, chords: Array(10).fill("C"), melodyAbc: bars("c8", "c8"),
      instrumentRoles: { Flute: { melodySections: ["mm.1-9"] }, "Violin 1": none, "Violin 2": none, Bassoon: none, Trombone: none },
    },
    parts: [
      { instrName: "Flute", abc: hdr("Flute") + bars("!p!c8", "c8") },
      { instrName: "Violin 1", abc: hdr("Violin 1") + bars("!f!B8", "B8") }, // louder than the tune, a 7th under it
      { instrName: "Violin 2", abc: hdr("Violin 2") + bars("!f!B8", "B8") }, // ...and identical to Violin 1
      { instrName: "Bassoon", abc: hdr("Bassoon", "C", "bass") + bars("B,,8", "B,,8") }, // B2 and A2: close and low
      { instrName: "Trombone", abc: hdr("Trombone", "C", "bass") + bars("A,,8", "A,,8") },
    ],
  };
  const { metrics: m } = scoreRun(run);
  assert.equal(m.clashes, 27, "both Violins and the Bassoon, bars 1-9; the Trombone's A is a 3rd, not a clash");
  assert.equal(m.mud, 10, "all 10 bars, past the UI's cap of 8");
  assert.equal(m.dynamics, 9, "bars 1-9 (bar 10 has no melody to drown)");
  assert.equal(m.unison, 1);
  assert.equal(m.uncoveredBars, 1, "bar 10");
  assert.equal(m.voicingOther, 0, "a voicing warning no kind matched: its wording changed, update VOICING_KINDS");
});

test("library calibration: every library melody fits its own chords", () => {
  // The same 3/8 rule as the part check. A plan built from real data must
  // score 0 here; if it doesn't, the rule (or the data) changed.
  for (const w of loadLibrary()) {
    const fit = planChordFit({ melodyAbc: `${w.melodyMeasures.join(" | ")} |]`, chords: w.chords }, w.key, w.timeSignature);
    assert.equal(fit.flagged, 0, `${w.id}: bars ${fit.bars.join(", ")}`);
    assert.equal(fit.checked, w.melodyMeasures.length, `${w.id}: every bar has a readable chord`);
  }
});

test("the saved legacy runs reproduce the numbers ENGINE_NOTES.md recorded", () => {
  // If a check changes on purpose these move: update ENGINE_NOTES.md too,
  // since every earlier comparison was made with the old ruler.
  const want = {
    "legacy-noctx/canon-baroque-16-r1.json": { harmonyFlagged: 5, clashes: 8, mistransposed: 0 },
    "legacy-noctx/canon-baroque-16-r2.json": { harmonyFlagged: 8, clashes: 6, mistransposed: 1 },
    "legacy-ctx/canon-baroque-16-r1.json": { harmonyFlagged: 2, clashes: 3, mistransposed: 0 },
    "legacy-noctx/yankee-free-16-r1.json": { harmonyFlagged: 3, harmonyChecked: 48, clashes: 4, mistransposed: 0 },
    "legacy-ctx/yankee-free-16-r1.json": { harmonyFlagged: 2, clashes: 2, mistransposed: 0 },
    "legacy-noctx/ode-romantic-32-r1.json": { harmonyFlagged: 16, clashes: 5, mistransposed: 1, melodyMismatch: 5, planChordFlagged: 1 },
    "legacy-ctx/ode-romantic-32-r1.json": { harmonyFlagged: 20, clashes: 21, mistransposed: 1 },
  };
  for (const [path, expected] of Object.entries(want)) {
    const [label, file] = path.split("/");
    const { metrics } = scoreRun(loadRun(label, file));
    for (const [k, v] of Object.entries(expected)) assert.equal(metrics[k], v, `${path}: ${k}`);
  }
});

test("saved runs carry provenance", () => {
  for (const label of readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const f of readdirSync(new URL(`${label}/`, RUNS)).filter((x) => x.endsWith(".json"))) {
      const { meta } = loadRun(label, f);
      assert.ok(meta, `${label}/${f} has no meta`);
      assert.equal(meta.label, label, `${label}/${f}: meta.label`);
      assert.equal(`${meta.caseId}-r${meta.repeat}.json`, f, `${label}/${f}: file name matches meta`);
      assert.equal(typeof meta.context, "boolean");
      assert.ok(meta.legacy ? meta.note : meta.gitSha, `${label}/${f}: a new run must name its commit`);
    }
  }
});

test("metrics normalise per bar, and lower is always better", () => {
  const spec = (key) => REPORT_METRICS.find((s) => s.key === key);
  const m = { barErrors: 3, partBars: 60, harmonyFlagged: 0, harmonyChecked: 0, missingParts: 2 };
  assert.equal(metricValue(m, spec("barErrors")), 5);
  assert.equal(metricValue(m, spec("harmonyFlagged")), null, "nothing checked: no value, not 0");
  assert.equal(metricValue(m, spec("missingParts")), 2);
});

test("a difference counts only when the repeat ranges don't overlap", () => {
  const s = (...v) => summarize(v);
  assert.equal(verdict(s(5, 8), s(2, 3)), "better");
  assert.equal(verdict(s(2, 3), s(5, 8)), "worse");
  assert.equal(verdict(s(5, 8), s(4, 6)), "within spread");
  assert.equal(verdict(s(5, 8), s(2)), "no verdict (n=1)", "one run has no spread");
  assert.equal(verdict(s(0, 0), s(0)), "same");
  assert.equal(verdict(s(), s(1, 2)), "no data");
  assert.deepEqual(summarize([null, 4, undefined, 2]), { n: 2, mean: 3, min: 2, max: 4 });
  assert.equal(fmt(s(5, 8)), "6.5 [5-8] (n=2)");
  assert.equal(fmt(s(3)), "3 (n=1)");
});

test("the suite is well-formed: unique ids, real library works, real instruments", () => {
  const suite = JSON.parse(readFileSync(new URL("../../eval/suite.json", import.meta.url), "utf8"));
  const ids = suite.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const library = new Set(loadLibrary().map((w) => w.id));
  for (const c of suite.cases) {
    assert.ok(/^[\w-]+$/.test(c.id), c.id);
    assert.ok(c.libraryId ? library.has(c.libraryId) : c.free?.title, `${c.id}: needs a library work or a free-text song`);
    for (const i of c.instruments) assert.ok(ALL_INSTRUMENTS.includes(i.name), `${c.id}: ${i.name}`);
    assert.ok(Number.isInteger(c.measures) && c.measures > 0);
  }
});

test("blind-test scores parse, play the right parts, and name no version or song", () => {
  const run = loadRun("legacy-ctx", "ode-romantic-32-r1.json");
  const abc = blindAbc(run, "Pair 2, version X");
  assert.match(abc, /^T:Pair 2, version X$/m);
  assert.equal((abc.match(/^T:/gm) || []).length, 1);
  for (const leak of [/legacy/i, /ctx/i, /Ode/, /Joy/, /Beethoven/, /—/]) assert.ok(!leak.test(abc), `leaks ${leak}`);
  for (const v of run.voices) assert.ok(abc.includes(`name="${v}"`), `plays ${v}`);
  // abcjs warns about score structure (a voice missing from %%score, bad
  // headers), not about wrong notes; that is the part the blind page adds.
  const [tune] = abcjs.parseOnly(abc);
  assert.ok(tune.lines.length > 0);
  assert.deepEqual(tune.warnings || [], [], "abcjs reads the assembled score without structural warnings");
});

test("a part the server filled with rests counts as missing, not as a clean part", () => {
  const run = faulty();
  run.parts[1] = { instrName: "Cello", abc: hdr("Cello", "C", "bass") + "z8 | z8 | z8 | z8 |]" };
  const { metrics: m } = scoreRun(run);
  assert.equal(m.missingParts, 1);
  assert.equal(m.harmonyChecked, 4, "only the Clarinet's bars are checked");
  // The one live case (writtenctx Elise r1 English Horn) is counted.
  assert.equal(scoreRun(loadRun("writtenctx", "elise-minor-24-r1.json")).metrics.missingParts, 1);
});
