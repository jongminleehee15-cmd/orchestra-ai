// Open Hymnal Project source: catalog logic (pure, no network) plus the ABC
// conversion correctness this source needs of its own (unlike corpus.js/
// openscore.js, this isn't MusicXML — it's a different, multi-voice ABC
// dialect this module parses itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEntries, matchEntries, isPublicDomain, keyStringToFifths,
  convertHymnAbc, extractMelodyVoiceText,
} from "../lib/openhymnal.js";

const PATHS = [
  "Complete/Abide_With_Me/Abide_With_Me-Eventide.abc",
  "Complete/A_Mighty_Fortress_Is_Our_God/A_Mighty_Fortress_Is_Our_God-Ein_Feste_Burg_Rhythmic.abc",
  "Complete/A_Mighty_Fortress_Is_Our_God/A_Mighty_Fortress_Is_Our_God-Ein_Feste_Burg_Isorhythmic.abc",
  "Choir/Canon/Canon-Kanon.abc",             // outside Complete/ — excluded
  "Complete/Abide_With_Me/README.md",        // not .abc — excluded
];

test("buildEntries keeps only Complete/*.abc and prettifies title/tune", () => {
  const entries = buildEntries(PATHS);
  assert.equal(entries.length, 3);
  const abide = entries.find((e) => e.path.includes("Eventide"));
  assert.equal(abide.title, "Abide With Me");
  assert.equal(abide.tune, "Eventide");
  assert.equal(abide.label, "Abide With Me (Eventide)");
  const rhythmic = entries.find((e) => e.path.includes("Rhythmic") && !e.path.includes("Iso"));
  assert.equal(rhythmic.title, "A Mighty Fortress Is Our God");
  assert.equal(rhythmic.tune, "Ein Feste Burg Rhythmic");
});

test("matchEntries requires every query token, and distinguishes same-title settings by tune", () => {
  const entries = buildEntries(PATHS);
  assert.equal(matchEntries(entries, "abide").length, 1);
  assert.equal(matchEntries(entries, "mighty fortress").length, 2);
  assert.equal(matchEntries(entries, "mighty fortress isorhythmic").length, 1);
  assert.equal(matchEntries(entries, "handel").length, 0);
  assert.equal(matchEntries(entries, "").length, 0);
});

test("isPublicDomain reads the C: copyright line", () => {
  assert.equal(isPublicDomain("C: copyright: public domain.  Open Hymnal."), true);
  assert.equal(isPublicDomain("C: copyright: music and setting public domain.  Words: Copyright 2010."), true);
  assert.equal(isPublicDomain("C: copyright: 2011, Someone. All rights reserved."), false);
  assert.equal(isPublicDomain("T: No copyright line at all"), false);
});

test("keyStringToFifths matches the pipeline's fifths convention", () => {
  assert.equal(keyStringToFifths("C"), 0);
  assert.equal(keyStringToFifths("Eb"), -3);
  assert.equal(keyStringToFifths("D"), 2);
  assert.equal(keyStringToFifths("Am"), 0);
  assert.equal(keyStringToFifths("F#"), 6);
  assert.equal(keyStringToFifths("bogus"), 0); // unrecognized/modal — safe fallback
});

// A compact, self-contained 2-voice fixture (S1 = melody, per %%staves) that
// exercises: plain notes, a chord (melody = top note), an explicit accidental
// followed by an explicit natural in the SAME measure (carry-over state), and
// a long note. Hand-verified against eventsToMeasures's own formatting rules
// (see server/lib/symbolic.js) — L:1/4 quarters become L:1/8 "2"-suffixed.
const FIXTURE = `X: 1
T: Test Hymn
C: copyright: public domain.  Test fixture only.
M: 4/4
L: 1/4
%%staves S1 | S2
V: S1 clef=treble
V: S2 clef=bass
K: C
[V: S1] C D E F | [CE] G A B | ^F G =F G | c4 |]
[V: S2] C, D, E, F, | C, G, A, B, | F, G, F, G, | C,4 |]
`;

test("convertHymnAbc extracts the first-declared voice and rescales L:1/4 into L:1/8", () => {
  const w = convertHymnAbc(FIXTURE, "fallback title");
  assert.equal(w.title, "Test Hymn");
  assert.equal(w.composer, "Traditional"); // no %OHCOMPOSER in the fixture
  assert.equal(w.key, "C");
  assert.equal(w.timeSignature, "4/4");
  assert.equal(w.bpm, 100); // no Q: in the fixture — default
  assert.deepEqual(w.melodyMeasures, ["C2D2E2F2", "E2G2A2B2", "^F2G2=F2G2", "c8"]);
});

test("convertHymnAbc rejects a file that never asserts public domain", () => {
  const restricted = FIXTURE.replace("copyright: public domain.  Test fixture only.", "copyright: 2020, Someone. All rights reserved.");
  assert.throws(() => convertHymnAbc(restricted, "x"), /public domain/);
});

test("convertHymnAbc rejects a tuplet/broken-rhythm measure rather than mis-time it", () => {
  const withTuplet = FIXTURE.replace("[V: S1] C D E F |", "[V: S1] (3CDE F |");
  assert.throws(() => convertHymnAbc(withTuplet, "x"), /doesn't handle/);
});

test("extractMelodyVoiceText follows the first voice encountered across multi-line voice blocks", () => {
  const body = [
    "[V: S1] C D E F |",
    "[V: S2] C, D, E, F, |",
    "[V: S1] G A B c |",
    "[V: S2] G, A, B, C |",
  ];
  assert.equal(extractMelodyVoiceText(body), "C D E F | G A B c |");
});

test("extractMelodyVoiceText also follows a standalone 'V: id' line switching voices", () => {
  const body = [
    "V: S1",
    "C D E F |",
    "V: S2",
    "C, D, E, F, |",
    "V: S1",
    "G A B c |",
  ];
  assert.equal(extractMelodyVoiceText(body), "C D E F | G A B c |");
});
