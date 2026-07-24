// Catalog logic for the runtime MusicXML corpus source (pure — no network).
// Fetch + conversion correctness is covered by the MusicXML tests; here we
// pin down how repo paths become searchable entries and how queries match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntries, matchEntries } from "../lib/corpus.js";
import { tonicChord } from "../lib/symbolic.js";

const PATHS = [
  "music21/corpus/bach/bwv66.6.mxl",
  "music21/corpus/bach/bwv269.mxl",
  "music21/corpus/beethoven/opus18no1/movement1.mxl",
  "music21/corpus/mozart/k155/movement1.mxl",
  "music21/corpus/schumann_clara/opus17/movement3.mxl",
  "music21/corpus/demos/two-parts.xml",          // demo dir — excluded
  "music21/corpus/bach/bwv1080/art_of_fugue.krn", // not MusicXML — excluded
  "music21/somewhere-else/file.mxl",              // outside corpus — excluded
];

test("buildEntries keeps only real corpus MusicXML and prettifies names", () => {
  const entries = buildEntries(PATHS);
  assert.equal(entries.length, 5);
  const bach = entries.find((e) => e.path.endsWith("bwv66.6.mxl"));
  assert.equal(bach.composer, "Bach");
  assert.equal(bach.label, "BWV 66.6");
  const clara = entries.find((e) => e.path.includes("schumann_clara"));
  assert.equal(clara.composer, "Schumann Clara");
  const lvb = entries.find((e) => e.path.includes("beethoven"));
  assert.equal(lvb.label, "Opus 18 No 1 — Movement 1");
});

test("matchEntries requires every query token", () => {
  const entries = buildEntries(PATHS);
  assert.equal(matchEntries(entries, "bach bwv 66.6").length, 1);
  assert.equal(matchEntries(entries, "bwv66.6").length, 1);
  assert.equal(matchEntries(entries, "beethoven opus 18").length, 1);
  assert.equal(matchEntries(entries, "mozart k 155")[0].path, "music21/corpus/mozart/k155/movement1.mxl");
  assert.equal(matchEntries(entries, "bach").length, 2);
  assert.equal(matchEntries(entries, "dvorak new world").length, 0);
  assert.equal(matchEntries(entries, "").length, 0);
});

test("tonicChord collapses modal keys to a usable triad", () => {
  assert.equal(tonicChord("D"), "D");
  assert.equal(tonicChord("Am"), "Am");
  assert.equal(tonicChord("Ador"), "Am");
  assert.equal(tonicChord("Gmix"), "G");
  assert.equal(tonicChord(""), "C");
});
