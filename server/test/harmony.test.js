// The chord-fit check is informational, so its main duty is not to cry wolf:
// ordinary passing motion must pass, and only a line that is really outlining
// some other chord gets flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChordSymbol, parseBarChords, checkPartHarmony, harmonyWarnings, writtenToConcertShift, FLAG_BELOW } from "../lib/harmony.js";
import { tokenizeMeasure, measurePitchEvents } from "../lib/partCheck.js";
import { loadLibrary } from "../lib/library.js";
import { keyFifths, writtenKeyFor } from "../lib/transpose.js";

const PCS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const names = (set) => [...set].sort((a, b) => a - b).map((pc) => PCS[pc]).join(" ");

function part(body, key = "C", ts = "4/4") {
  return `X:1\nT:Test\nM:${ts}\nL:1/8\nQ:1/4=100\nK:${key}\n${body}`;
}

test("chord symbols parse to the right pitch classes", () => {
  const cases = {
    C: "C E G", Cm: "C Eb G", C7: "C E G Bb", Cmaj7: "C E G B", CM7: "C E G B",
    Cm7: "C Eb G Bb", Cdim: "C Eb Gb", Cdim7: "C Eb Gb A", "Cø7": "C Eb Gb Bb",
    Cm7b5: "C Eb Gb Bb", Caug: "C E Ab", Csus4: "C F G", Csus2: "C D G",
    C7sus4: "C F G Bb", C6: "C E G A", "C6/9": "C D E G A", C9: "C D E G Bb",
    Cmaj9: "C D E G B", Cadd9: "C D E G", "Cm(maj7)": "C Eb G B", C5: "C G",
    "G7/B": "D F G B", "Am/G": "C E G A", "F#m": "Db Gb A", Bb: "D F Bb",
    "E7#9": "D E G Ab B", "G7(b9)": "D F G Ab B", "B♭7": "D F Ab Bb",
  };
  for (const [sym, want] of Object.entries(cases)) {
    assert.equal(names(parseChordSymbol(sym)), want, sym);
  }
});

test("unreadable symbols make no claim instead of guessing", () => {
  for (const sym of ["N.C.", "NC", "", "I", "V7", "c", "C7M", "Xyz", null, 7, undefined]) {
    assert.equal(parseChordSymbol(sym), null, String(sym));
  }
  assert.equal(parseBarChords("G Xyz"), null, "one bad symbol voids the whole bar");
  assert.equal(parseBarChords("G C").length, 2);
  assert.equal(parseBarChords("G, C").length, 2);
});

test("measurePitchEvents keeps every chord note; tokenizeMeasure still reports the top one", () => {
  const ev = measurePitchEvents("[CEG]2 [C2E2G2] z4", "4/4", 0);
  assert.deepEqual(ev.map((e) => e.len), [2, 2, 4]);
  assert.deepEqual(ev[0].pitches, [0, 4, 7]);
  assert.deepEqual(ev[1].pitches, [0, 4, 7]);
  assert.deepEqual(ev[2].pitches, []);
  assert.equal(tokenizeMeasure("[CEG]2", "4/4", 0)[0].st, 7);
  // Accidentals still carry through the bar across chord and single notes.
  assert.deepEqual(measurePitchEvents("[^FA]2 F2", "4/4", 0).map((e) => e.pitches), [[6, 9], [6]]);
});

test("ordinary accompaniment passes", () => {
  const ok = [
    ["C2 E2 G2 c2", "C", "arpeggio"],
    ["C D E F G A B c", "C", "scale: half chord tones"],
    ["C,2 D,2 E,2 G,2", "C", "walking bass"],
    ["[CEG]8", "C", "block chord"],
    ["F4 E4", "C", "4-3 suspension resolving"],
    ["G,2 B,2 D2 F2", "G7", "dominant seventh"],
    ["C2 E2 D2 B,2", "C G", "chord change mid-bar"],
    ["z8", "C", "rest bar"],
    ["!mf!\"C\"(C2 E2) G2 c2", "C", "decorations and annotations ignored"],
  ];
  for (const [body, chord, why] of ok) {
    const r = checkPartHarmony({ partAbc: part(body), chords: [chord], timeSignature: "4/4" });
    assert.deepEqual(r.problems, [], why);
  }
});

test("a line outlining a different chord is flagged", () => {
  const r = checkPartHarmony({ partAbc: part("D2 F2 A2 d2"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(r.flagged, 1);
  assert.match(r.problems[0], /^measure 1: only 0% of this bar's notes \(by length\) belong to the chord C/);
  assert.ok(!r.problems[0].includes("—"), "no em dash in user-facing copy");

  // A mid-bar change is honoured: the same notes fit "C G" but not "G C".
  const fits = checkPartHarmony({ partAbc: part("C2 E2 D2 B,2"), chords: ["C G"], timeSignature: "4/4" });
  const clashes = checkPartHarmony({ partAbc: part("C2 E2 D2 B,2"), chords: ["G C"], timeSignature: "4/4" });
  assert.equal(fits.flagged, 0);
  assert.equal(clashes.flagged, 1);
});

test("known blind spot: a wrong chord that shares tones can pass", () => {
  // Pinned so the limitation stays documented (ENGINE_NOTES.md): a G major
  // arpeggio over C doubles the shared G and lands at exactly 50%. The check
  // finds lines mostly OUTSIDE the chord, not wrong chords in general.
  const g = checkPartHarmony({ partAbc: part("G2 B2 d2 g2"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(g.flagged, 0);
  // A chord sharing no tones is always caught.
  const bb = checkPartHarmony({ partAbc: part("_B,2 D2 F2 _B2"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(bb.flagged, 1);
});

test("exactly 3/8 is not flagged; less than 3/8 is", () => {
  assert.equal(FLAG_BELOW, 3 / 8);
  const atBound = checkPartHarmony({ partAbc: part("D E F G A B c d"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(atBound.checked, 1);
  assert.equal(atBound.flagged, 0, "E G c = 3 of 8");
  const under = checkPartHarmony({ partAbc: part("C2 D2 F2 A2"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(under.flagged, 1, "C alone = 1 of 4");
});

// Diatonic letters from C4 upward, enough for a 16-note run from any degree.
const LETTERS = ["C", "D", "E", "F", "G", "A", "B", "c", "d", "e", "f", "g", "a", "b", "c'", "d'", "e'", "f'", "g'", "a'", "b'", "c''", "d''"];

test("no stepwise diatonic run is ever flagged over any diatonic triad (the 3/8 derivation)", () => {
  // Any 8 consecutive scale steps contain all 7 degrees, so every triad of
  // the key has at least 3 of its tones among them. Checked exhaustively:
  // every start degree, up and down, eighths (8) and sixteenths (16), over
  // every diatonic triad, in C major and in D major (key signature applied).
  const keys = [
    { key: "C", fifths: 0, triads: ["C", "Dm", "Em", "F", "G", "Am", "Bdim"] },
    { key: "D", fifths: 2, triads: ["D", "Em", "F#m", "G", "A", "Bm", "C#dim"] },
  ];
  let runs = 0;
  for (const { key, fifths, triads } of keys) {
    for (const [count, len] of [[8, ""], [16, "/"]]) {
      for (let start = 0; start < 7; start++) {
        const up = LETTERS.slice(start, start + count).map((l) => l + len);
        for (const notes of [up, [...up].reverse()]) {
          for (const chord of triads) {
            const r = checkPartHarmony({
              partAbc: part(notes.join(" "), key), chords: [chord], timeSignature: "4/4",
              writtenFifths: fifths, concertFifths: fifths,
            });
            assert.equal(r.checked, 1);
            assert.equal(r.flagged, 0, `${key} major, ${notes.join(" ")} over ${chord}: ${r.problems[0]}`);
            runs++;
          }
        }
      }
    }
  }
  assert.equal(runs, 2 * 2 * 7 * 2 * 7);
});

test("known limitation: a scale run across a two-chord bar can be flagged", () => {
  // The derivation assumes one chord per bar. Split in half, each chord only
  // gets 4 consecutive steps, which can hold a single chord tone: A B c d
  // over C, then e f g a over G, is 1/4 each.
  const r = checkPartHarmony({ partAbc: part("A B c d e f g a"), chords: ["C G"], timeSignature: "4/4" });
  assert.equal(r.flagged, 1);
});

test("a chord that contradicts its own melody does not blame the part", () => {
  // Live, 2026-09-26: the plan put chord A under its own extension melody
  // E F# G (only E fits). The French Horn doubled that melody and was
  // flagged for following it. Judged against the tune, the bar is skipped.
  const horn = writtenKeyFor("D", "French Horn");
  const args = {
    partAbc: part("B2 c2 d4", horn.writtenKey), chords: ["A"], timeSignature: "4/4",
    writtenFifths: horn.fifths, concertFifths: keyFifths("D"),
  };
  assert.equal(checkPartHarmony(args).flagged, 1, "without the melody, the doubling is flagged");
  const withTune = checkPartHarmony({ ...args, melodyAbc: "e2 f2 g4 |]" });
  assert.deepEqual([withTune.flagged, withTune.checked, withTune.chordSuspect], [0, 0, 1]);
  // A melody that DOES fit its chord leaves the part check fully in force.
  const fits = checkPartHarmony({ ...args, chords: ["D"], melodyAbc: "d2 f2 a4 |]", partAbc: part("_B,2 E2 G2 _B2", horn.writtenKey) });
  assert.equal(fits.chordSuspect, 0);
  assert.equal(fits.checked, 1);
});

test("live regression bars (2026-09-26): real clashes stay flagged, scale runs pass", () => {
  // Verbatim bars from the first live run (concert D). These are the SAME
  // bars that motivated the 3/8 threshold and the chord-suspect skip, so they
  // pin the behaviour; they are not independent evidence that it is right.
  const bar = (instr, body, chord, melodyAbc = null) => {
    const w = writtenKeyFor("D", instr);
    return checkPartHarmony({
      partAbc: part(body, w.writtenKey), chords: [chord], timeSignature: "4/4", melodyAbc,
      writtenFifths: w.fifths, concertFifths: keyFifths("D"),
    });
  };
  const mustFlag = [
    ["Clarinet", "!p!(A,2 E2 A2 c2)", "D"], // whole part a fourth off the harmony
    ["Clarinet", "!p!(^c2 e2 ^c2 e2)", "A"],
    ["Clarinet", "!mp!(^c2 e2 ^c2 A2)", "A"],
    ["Trumpet", "d2cB AB cA", "Bm"], // shadows the melody in parallel 7ths (a 7th above the Alto Sax)
    ["Trumpet", "B2AG FG AF", "G"],
    ["Alto Sax", "!p!z4 D2E2", "D A"],
    ["Alto Sax", "F4 E2D2", "Bm F#m"],
    ["Alto Sax", "c4 B2A2", "G A"],
  ];
  for (const [instr, body, chord] of mustFlag) {
    assert.equal(bar(instr, body, chord).flagged, 1, `${instr} ${body} over ${chord}`);
  }
  const mustPass = [
    ["Flute", "!mp!(fedc) defg", "D A"], // Baroque scale runs, all at exactly 3/8
    ["Flute", "(agfe) dcBA", "Bm F#m"],
    ["Flute", "!mf!fedc BAGB", "D"],
    ["Flute", "(defg) agfe", "Bm"],
    ["Flute", "!f!(fgab) c'bag", "D"],
    ["Flute", "(cBAG) FADF", "G"],
    ["Trumpet", "FGAB cBAG", "Bm"], // parallel thirds under the melody
    ["Trumpet", "AGFE GFED", "G"], // doubling the melody
    ["Violin 1", "e3 d d4", "A"], // doubling the melody
  ];
  for (const [instr, body, chord] of mustPass) {
    const r = bar(instr, body, chord);
    assert.equal(r.checked, 1);
    assert.equal(r.flagged, 0, `${instr} ${body} over ${chord}: ${r.problems[0]}`);
  }
});

test("melody bars, missing chords and unreadable chords are skipped", () => {
  const clash = "D2 F2 A2 d2";
  const body = `${clash} | ${clash} | ${clash} | ${clash} |]`;
  const r = checkPartHarmony({
    partAbc: part(body), chords: ["C", "C", "Xyz"], timeSignature: "4/4", melodySections: ["mm.1"],
  });
  assert.equal(r.checked, 1, "only measure 2 is an accompaniment bar with a readable chord");
  assert.equal(r.flagged, 1);
  assert.match(r.problems[0], /^measure 2:/);
  assert.equal(r.unreadable, 1, "measure 3's chord is unreadable; measure 4 has none");
  // "N.C." is a readable instruction ("no chord"), not an unreadable symbol.
  const nc = checkPartHarmony({ partAbc: part(clash), chords: ["N.C."], timeSignature: "4/4" });
  assert.deepEqual([nc.checked, nc.flagged, nc.unreadable], [0, 0, 0]);
  assert.deepEqual(checkPartHarmony({ partAbc: part(body), chords: undefined, timeSignature: "4/4" }).problems, []);
});

test("the part's written key signature is applied before judging", () => {
  // In D major an unmarked F is F#, which IS in a D chord. Reading it as F
  // natural (as if the part were in C) would be a false clash.
  const r = checkPartHarmony({
    partAbc: part("D2 F2 A2 d2", "D"), chords: ["D"], timeSignature: "4/4", writtenFifths: 2, concertFifths: 2,
  });
  assert.equal(r.flagged, 0);
});

test("transposing instruments are judged at concert pitch", () => {
  // Concert C chord. Each instrument writes its concert C-E-G arpeggio in its
  // own written key, which must read as a fit, not a clash.
  const cases = [
    ["Trumpet", "D2 ^F2 A2 d2"], // B♭: written a major 2nd up
    ["French Horn", "B2 d2 B2 d2"], // F: written a perfect 5th up (sounds E G E G)
    ["Alto Sax", "A2 ^c2 e2 a2"], // E♭: written a major 6th up
  ];
  for (const [instr, body] of cases) {
    const w = writtenKeyFor("C", instr);
    const concertFifths = keyFifths("C");
    assert.equal(writtenToConcertShift(w.fifths, concertFifths), { Trumpet: 2, "French Horn": 7, "Alto Sax": 9 }[instr]);
    // Accidentals are written out, and the part is read in its real written key.
    const r = checkPartHarmony({
      partAbc: part(body, w.writtenKey), chords: ["C"], timeSignature: "4/4",
      writtenFifths: w.fifths, concertFifths,
    });
    assert.equal(r.checked, 1);
    assert.equal(r.flagged, 0, `${instr} arpeggio in ${w.writtenKey} fits concert C`);
    // Judged WITHOUT the transposition, the same written notes would clash.
    const untransposed = checkPartHarmony({ partAbc: part(body), chords: ["C"], timeSignature: "4/4" });
    assert.equal(untransposed.flagged, 1, `${instr}: the shift is what makes it fit`);
  }
  // Real written key: B♭ trumpet in concert C reads in D, so "F" is F#.
  const t = writtenKeyFor("C", "Trumpet");
  const inKey = checkPartHarmony({
    partAbc: part("D2 F2 A2 d2", t.writtenKey), chords: ["C"], timeSignature: "4/4",
    writtenFifths: t.fifths, concertFifths: keyFifths("C"),
  });
  assert.equal(inKey.flagged, 0, "trumpet's written D major arpeggio sounds concert C");
  const misread = checkPartHarmony({
    partAbc: part("D2 F2 A2 d2"), chords: ["C"], timeSignature: "4/4",
  });
  assert.equal(misread.flagged, 1, "the same notes at concert pitch really are a D minor clash");
});

test("the shift survives a respelled written key", () => {
  // Concert F# (6 sharps): a B♭ part would be G# (8), respelled to A♭ (-4).
  const t = writtenKeyFor("F#", "Trumpet");
  assert.equal(t.fifths, -4);
  assert.equal(writtenToConcertShift(t.fifths, keyFifths("F#")), 2);
});

test("tuplet and compound-meter durations come from the shared parser", () => {
  // (3 D E F takes one quarter (2 units); the rest of the bar is chord tones.
  const r = checkPartHarmony({ partAbc: part("(3DEF C2 E2 G2"), chords: ["C"], timeSignature: "4/4" });
  assert.equal(r.flagged, 0);
  const six8 = checkPartHarmony({ partAbc: part("C3 E3", "C", "6/8"), chords: ["C"], timeSignature: "6/8" });
  assert.equal(six8.checked, 1);
  assert.equal(six8.flagged, 0);
});

test("the warning list is capped with a count", () => {
  const many = { problems: Array.from({ length: 11 }, (_, i) => `measure ${i + 1}: x`) };
  const w = harmonyWarnings(many);
  assert.equal(w.length, 9);
  assert.equal(w[8], "and 3 more bars like these");
  assert.equal(harmonyWarnings({ problems: ["a"] }).length, 1);
});

test("calibration: every library melody fits its own chords", () => {
  // A melody carries MORE passing and neighbour tones than a typical
  // accompaniment line, so a near-zero flag rate here is evidence the
  // threshold is not trigger-happy. Checked as if it were an accompaniment.
  let checked = 0;
  let flagged = 0;
  const detail = [];
  for (const work of loadLibrary()) {
    const r = checkPartHarmony({
      partAbc: part(`${work.melodyMeasures.join(" | ")} |]`, work.key, work.timeSignature),
      chords: work.chords, timeSignature: work.timeSignature,
      writtenFifths: keyFifths(work.key), concertFifths: keyFifths(work.key),
    });
    checked += r.checked;
    flagged += r.flagged;
    if (r.flagged) detail.push(`${work.title}: ${r.problems.join("; ")}`);
    assert.equal(r.unreadable, 0, `${work.title}: every library chord symbol is readable`);
  }
  assert.ok(checked > 50, `enough bars to mean something (${checked})`);
  // The lowest library bars sit at exactly 50% (measured 2026-09-26), above
  // the 3/8 threshold. If a new, correct score trips this, recalibrate the
  // threshold in harmony.js (see ENGINE_NOTES.md); it does not mean the
  // score is wrong.
  assert.equal(flagged, 0, `library melodies flagged against their own chords. This means the harmony threshold needs recalibrating, not that the score data is bad:\n${detail.join("\n")}`);
});
