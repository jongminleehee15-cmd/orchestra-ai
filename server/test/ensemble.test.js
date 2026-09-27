// Parts heard together: sounding pitch, the melody-clash check, and the
// context grid shown to the model writing the next part.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  soundingEvents, writtenShiftFor, findMelodyClashes, renderEnsembleContext, describeBar, CLASH_SHARE,
} from "../lib/ensemble.js";
import { writtenKeyFor } from "../lib/transpose.js";
import { buildPartPrompt } from "../prompts.js";

const abc = (body, key = "C", ts = "4/4") => `X:1\nT:T\nM:${ts}\nL:1/8\nQ:1/4=100\nK:${key}\n${body}`;
const pitches = (bar, instr, key = "C") =>
  soundingEvents(bar, "4/4", writtenKeyFor(key, instr).fifths, writtenShiftFor(instr)).map((e) => e.pitches);

test("written notes are read at the pitch they SOUND, octave included", () => {
  // Concert middle C (60) as each instrument writes it in this app.
  assert.deepEqual(pitches("C2", "Violin"), [[60]]);
  assert.deepEqual(pitches("^C2", "Trumpet"), [[59]], "B-flat: written a 2nd up");
  assert.deepEqual(pitches("D2", "Trumpet"), [[60]]);
  assert.deepEqual(pitches("D2", "Tenor Sax"), [[60]], "tenor sax is written only a 2nd up here");
  assert.deepEqual(pitches("G2", "French Horn"), [[60]], "F: a 5th up");
  assert.deepEqual(pitches("A2", "Alto Sax"), [[60]], "E-flat: a 6th up");
  assert.deepEqual(pitches("C,,2", "Tuba"), [[36]], "bass-clef parts are still absolute pitch");
  // The written key signature applies: a trumpet reads concert C major in D.
  assert.deepEqual(pitches("F2", "Trumpet"), [[64]], "written F is F# in D major, sounding E");
});

// Two parts: the melody carrier (Violin, mm.1) and one accompanist.
function clashes(melodyBody, partBody, chord = "C", partInstr = "Viola", key = "C") {
  return findMelodyClashes({
    parts: [
      { instrName: "Violin", abc: abc(melodyBody, key) },
      { instrName: partInstr, abc: abc(partBody, writtenKeyFor(key, partInstr).writtenKey) },
    ],
    instrumentRoles: { Violin: { melodySections: ["mm.1"] }, [partInstr]: { melodySections: [] } },
    chords: [chord], concertKey: key, timeSignature: "4/4",
  });
}

// Diatonic letters in C major, low enough for a line a 7th below.
const L = ["C,", "D,", "E,", "F,", "G,", "A,", "B,", "C", "D", "E", "F", "G", "A", "B", "c", "d", "e", "f", "g", "a", "b", "c'", "d'", "e'"];
const TRIADS = ["C", "Dm", "Em", "F", "G", "Am", "Bdim"];

test("parallel unisons, 3rds, 6ths and octaves are never flagged, over any triad", () => {
  // Their interval classes (0, 3, 4) are never dissonant, whatever the line.
  let n = 0;
  for (const [count, len] of [[8, ""], [4, "2"]]) {
    for (let start = 7; start < 14; start++) {
      const up = L.slice(start, start + count);
      for (const tune of [up, [...up].reverse()]) {
        for (const steps of [0, -2, -5, -7, 2]) { // unison, 3rd/6th/octave below, 3rd above
          const part = tune.map((x) => L[L.indexOf(x) + steps]);
          for (const chord of TRIADS) {
            const r = clashes(tune.map((x) => x + len).join(" "), part.map((x) => x + len).join(" "), chord);
            assert.deepEqual(r, [], `${part.join(" ")} under ${tune.join(" ")} over ${chord}`);
            n++;
          }
        }
      }
    }
  }
  assert.equal(n, 2 * 7 * 2 * 5 * 7);
});

test("a stepwise tune shadowed in parallel 2nds or 7ths is always flagged, over any triad", () => {
  // Any 4 (or 8) consecutive scale steps hold at most 2 (or 4) tones of one
  // triad, so the shadowing part is off the chord at least half the time,
  // and every one of those notes is a 2nd/7th from the tune.
  let n = 0;
  for (const [count, len] of [[8, ""], [4, "2"]]) {
    for (let start = 7; start < 14; start++) {
      const up = L.slice(start, start + count);
      for (const tune of [up, [...up].reverse()]) {
        for (const steps of [-1, 1, -6]) { // 2nd below, 2nd above, 7th below
          const part = tune.map((x) => L[L.indexOf(x) + steps]);
          for (const chord of TRIADS) {
            const r = clashes(tune.map((x) => x + len).join(" "), part.map((x) => x + len).join(" "), chord);
            assert.equal(r.length, 1, `${part.join(" ")} against ${tune.join(" ")} over ${chord}`);
            assert.ok(r[0].share >= CLASH_SHARE);
            n++;
          }
        }
      }
    }
  }
  assert.equal(n, 2 * 7 * 2 * 3 * 7);
});

test("a single passing collision, or a rub caused by the melody's own passing tone, is not flagged", () => {
  // The part's D (off the chord) rubs against the tune's E for one beat: 25%.
  assert.deepEqual(clashes("E2 E2 G2 E2", "C2 D2 E2 C2"), []);
  // The part sits on chord tones; the rub is the TUNE's passing A against
  // the part's G (live: a Tuba under Yankee Doodle was flagged for this).
  assert.deepEqual(clashes("g2 g2 a2 b2", "C,,2 z2 G,,2 z2", "C", "Tuba"), []);
  // Less than a quarter note of shared sounding time says nothing.
  assert.deepEqual(clashes("E8", "D z7"), []);
});

test("transposing parts are compared at sounding pitch", () => {
  // Concert C major, tune E F G A over C. A B-flat trumpet a 2nd below
  // sounds D E F G, written E F# G A (it reads in D).
  assert.equal(clashes("E2 F2 G2 A2", "E2 ^F2 G2 A2", "C", "Trumpet").length, 1);
  // The same trumpet a 3rd below sounds C D E F, written D E F# G.
  assert.deepEqual(clashes("E2 F2 G2 A2", "D2 E2 ^F2 G2", "C", "Trumpet"), []);
});

test("bars with no carrier, or no readable chord, are skipped", () => {
  const parts = [{ instrName: "Violin", abc: abc("E2 F2 G2 A2") }, { instrName: "Viola", abc: abc("D2 E2 F2 G2") }];
  const roles = { Violin: { melodySections: ["mm.1"] } };
  const run = (extra) => findMelodyClashes({ parts, instrumentRoles: roles, chords: ["C"], concertKey: "C", timeSignature: "4/4", ...extra });
  assert.equal(run({}).length, 1, "the baseline does flag");
  assert.deepEqual(run({ chords: ["Xyz"] }), []);
  assert.deepEqual(run({ chords: ["N.C."] }), []);
  assert.deepEqual(run({ chords: undefined }), []);
  assert.deepEqual(run({ instrumentRoles: {} }), []);
});

test("live pins (2026-09-26): real clashes flagged, consonant lines pass", () => {
  // Verbatim bars from the live runs, each against the part that ACTUALLY
  // carried the melody there. These are the bars that shaped the rule, so
  // they pin it; they are not independent evidence for it.
  const pair = (carrier, carrierBar, instr, bar, chord) => findMelodyClashes({
    parts: [
      { instrName: carrier, abc: abc(carrierBar, writtenKeyFor("D", carrier).writtenKey) },
      { instrName: instr, abc: abc(bar, writtenKeyFor("D", instr).writtenKey) },
    ],
    instrumentRoles: { [carrier]: { melodySections: ["mm.1"] } },
    chords: [chord], concertKey: "D", timeSignature: "4/4",
  });
  // Canon in D bars 10-11: the Trumpet shadows the Alto Sax a 7th above.
  assert.equal(pair("Alto Sax", "B2AG FG AF", "Trumpet", "d2cB AB cA", "Bm").length, 1);
  assert.equal(pair("Alto Sax", "G2FE DE FD", "Trumpet", "B2AG FG AF", "G").length, 1);
  // Canon bar 14: the Trumpet in consonance with the Bassoon's tune.
  assert.deepEqual(pair("Bassoon", "G,A,B,C DCB,A,", "Trumpet", "FGAB cBAG", "Bm"), []);
  // Ode to Joy bar 19: Violin 2 in unisons and 3rds with the Clarinet's tune.
  assert.deepEqual(pair("Clarinet", "!f!(c2 c2 d2 e2)", "Violin 2", "!mf!(B2 d2) c2 B2", "D"), []);
});

test("describeBar names sounding pitches and lengths", () => {
  const ev = soundingEvents("[CEG]2 d/ e/ z2 F3 G", "4/4", 0, 0);
  assert.equal(describeBar(ev), "[C4 E4 G4] q, D5 s, E5 s, rest q, F4 q., G4 e");
});

test("the context grid shows finished parts at sounding pitch, and the tune where its carrier is unwritten", () => {
  const grid = renderEnsembleContext({
    contextParts: [
      { instrName: "Trumpet", abc: abc("F2 G2 A2 B2 | z8 |]", "D") }, // written in D, sounds C major
      { instrName: "Viola", abc: abc("C8 | C8 |]") },
      { instrName: "Cello", abc: abc("C,8 | C,8 |]") }, // this is the part being written: excluded
    ],
    forInstr: "Cello",
    instrumentRoles: { Trumpet: { melodySections: ["mm.1"] }, Flute: { melodySections: ["mm.2"] } },
    melodyAbc: "E2 F2 G2 A2 | c8 |]", concertKey: "C", timeSignature: "4/4", from: 1, to: 2,
  });
  const lines = grid.split("\n");
  assert.equal(lines[0], "m1:");
  assert.equal(lines[1], "  Trumpet (MELODY): E4 q, F4 q, G4 q, A4 q", "the trumpet's written F# G A B sounds E F G A");
  assert.equal(lines[2], "  Viola: C4 w");
  assert.equal(lines[3], "m2:");
  assert.match(lines[4], /^ {2}melody \(Flute, not written yet; canonical tune, its octave may differ\): C5 w$/);
  assert.ok(!grid.includes("Cello"), "a part never sees itself");
  assert.equal(renderEnsembleContext({ contextParts: [], forInstr: "Cello", concertKey: "C", timeSignature: "4/4", from: 1, to: 1 }), "");
  assert.equal(renderEnsembleContext({ contextParts: null, forInstr: "Cello", concertKey: "C", timeSignature: "4/4", from: 1, to: 1 }), "");
});

test("the part prompt carries the grid only when there are finished parts", () => {
  const base = {
    songTitle: "T", instrName: "Clarinet", style: "Baroque", density: "Moderate", tempoFeel: "Moderate",
    key: "C", timeSignature: "4/4", bpm: 100, measures: 2, otherInstruments: "Flute, Clarinet",
    role: { primaryRole: "harmony", melodySections: [] }, melodyAbc: "E2 F2 G2 A2 | c8 |]", chords: ["C", "C"],
  };
  const without = buildPartPrompt(base);
  assert.ok(!without.includes("ENSEMBLE SO FAR"));
  assert.equal(buildPartPrompt({ ...base, contextParts: [] }), without, "empty context changes nothing");
  const withCtx = buildPartPrompt({
    ...base,
    contextParts: [{ instrName: "Flute", abc: abc("e2 f2 g2 a2 | c'8 |]") }],
    instrumentRoles: { Flute: { melodySections: ["mm.1-2"] } },
  });
  assert.match(withCtx, /ENSEMBLE SO FAR/);
  assert.match(withCtx, / {2}Flute \(MELODY\): E5 q, F5 q, G5 q, A5 q/);
  assert.match(withCtx, /in D, a major 2nd \(whole step\) above how they sound/, "the transposing part is told how its own notes relate");
  // A chunked prompt shows only its own window.
  const chunked = buildPartPrompt({
    ...base, measures: 2, chunk: { start: 2, end: 2, prevTail: null },
    contextParts: [{ instrName: "Flute", abc: abc("e2 f2 g2 a2 | c'8 |]") }],
    instrumentRoles: { Flute: { melodySections: ["mm.1-2"] } },
  });
  assert.ok(!/\nm1:/.test(chunked) && /\nm2:/.test(chunked));
});
