// Catalog logic for the OpenScore Lieder corpus source (pure — no network).
// Fetch + conversion correctness is covered by the MusicXML tests; here we
// pin down how repo paths become searchable entries and how queries match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntries, matchEntries } from "../lib/openscore.js";

const PATHS = [
  "scores/Schubert,_Franz/Die_schöne_Müllerin,_D.795/10_Tränenregen/lc5025985.mxl",
  "scores/Schubert,_Franz/4_Lieder,_Op.96/3_Wandrers_Nachtlied,_D.768/lc6486443.mxl",
  "scores/Abrams,_Harriett/_/Crazy_Jane/lc6583907.mxl",
  "scores/Elgar,_Edward/7_Lieder/1_Like_to_the_Damask_Rose/lc6236149.mxl",
  "scores/Schubert,_Franz/Die_schöne_Müllerin,_D.795/README.md",           // not .mxl — excluded
  "data/composers.tsv",                                                    // outside scores/ — excluded
];

test("buildEntries keeps only real Lieder MusicXML and prettifies names", () => {
  const entries = buildEntries(PATHS);
  assert.equal(entries.length, 4);
  const tranenregen = entries.find((e) => e.path.endsWith("lc5025985.mxl"));
  assert.equal(tranenregen.composer, "Schubert, Franz");
  assert.equal(tranenregen.label, "Die schöne Müllerin, D.795: Tränenregen");
  const crazyJane = entries.find((e) => e.path.includes("Abrams"));
  assert.equal(crazyJane.composer, "Abrams, Harriett");
  assert.equal(crazyJane.label, "Crazy Jane"); // "_" collection segment dropped
  const elgar = entries.find((e) => e.path.includes("Elgar"));
  assert.equal(elgar.label, "7 Lieder: Like to the Damask Rose");
});

test("matchEntries requires every query token", () => {
  const entries = buildEntries(PATHS);
  assert.equal(matchEntries(entries, "schubert").length, 2);
  assert.equal(matchEntries(entries, "schubert tranenregen").length, 1); // diacritics folded, like corpus.js
  assert.equal(matchEntries(entries, "schubert tränenregen").length, 1);
  assert.equal(matchEntries(entries, "crazy jane").length, 1);
  assert.equal(matchEntries(entries, "elgar damask rose").length, 1);
  assert.equal(matchEntries(entries, "brahms").length, 0);
  assert.equal(matchEntries(entries, "").length, 0);
});
