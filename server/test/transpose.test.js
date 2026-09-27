// Chord symbols handed to transposing parts in WRITTEN pitch. Live, 3 of 12
// transposing parts built their accompaniment on wrong chords when left to
// transpose concert symbols themselves (ENGINE_NOTES.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { transposeChordSymbol as t, writtenChordsFor, writtenKeyFor, keyFifths } from "../lib/transpose.js";
import { parseChordSymbol } from "../lib/harmony.js";
import { buildPartPrompt } from "../prompts.js";

const TRANSPOSING = { Trumpet: 2, Clarinet: 2, Flugelhorn: 2, "Tenor Sax": 2, "French Horn": 7, "English Horn": 7, "Alto Sax": 9 };

test("named cases, including keys the written part has to respell", () => {
  const cases = [
    ["D", "Trumpet", { D: "E", Bm: "C#m", "F#m": "G#m", G: "A", A7: "B7", Bb: "C", "G7/B": "A7/C#", "C#dim7": "D#dim7" }],
    ["D", "French Horn", { D: "A", Bm: "F#m", Bb: "F", "F#": "C#", Eb: "Bb" }],
    ["D", "Alto Sax", { D: "B", C: "A", Eb: "C", "F#": "D#", Bb: "G" }],
    // Concert F# on a B-flat part would read in G# (8 sharps); it reads in Ab.
    ["F#", "Trumpet", { "F#": "Ab", "C#": "Eb", "D#m": "Fm", B: "Db", "G#m7": "Bbm7", "C#7/E#": "Eb7/G" }],
    // Concert B on alto sax would read in G# too; it reads in Ab.
    ["B", "Alto Sax", { B: "Ab", "F#": "Eb", "G#m": "Fm", E: "Db", "C#m": "Bbm" }],
    // Keys spelled the far way round (a library work keeps its source's
    // spelling): the chords follow that spelling, and still land in the key
    // the player reads. Concert C# on a trumpet reads in Eb, not D#.
    ["C#", "Trumpet", { "C#": "Eb", "F#": "Ab", "G#7": "Bb7", "A#m": "Cm", "D#m7/C#": "Fm7/Eb" }],
    ["D#m", "Trumpet", { "D#m": "Fm", "G#m": "Bbm", "A#7": "C7", B: "Db", "C#": "Eb" }],
    ["A#", "French Horn", { "A#": "F", "D#": "Bb", F: "C", "E#": "C" }],
    ["G#", "Clarinet", { "G#": "Bb", "C#": "Eb", "D#7": "F7", "E#m": "Gm" }],
    ["Cb", "Trumpet", { Cb: "Db", Fb: "Gb", Gb: "Ab", "Abm": "Bbm" }],
    // The same pitch spelled the conventional way is unchanged by the fix.
    ["Db", "Trumpet", { Db: "Eb", Gb: "Ab", Ab7: "Bb7", Bbm: "Cm" }],
  ];
  for (const [key, instr, map] of cases) {
    for (const [from, to] of Object.entries(map)) assert.equal(t(from, key, instr), to, `${instr} in concert ${key}: ${from}`);
  }
});

test("non-transposing parts, N.C. and unreadable symbols pass through unchanged", () => {
  for (const s of ["C", "F#m7", "Bb/D", "N.C."]) assert.equal(t(s, "D", "Violin"), s);
  for (const s of ["N.C.", "NC", "", "I", "xyz", "7"]) assert.equal(t(s, "D", "Trumpet"), s);
  assert.equal(t(undefined, "D", "Trumpet"), undefined);
  assert.deepEqual(writtenChordsFor(["D A", "Bm, F#m", "N.C.", 7, "G"], "D", "Trumpet"), ["E B", "C#m, G#m", "N.C.", 7, "A"]);
  // "|" separates symbols too: "G|C" is two chords, not G with quality "|C".
  assert.deepEqual(writtenChordsFor(["G|C", "D | A | Bm"], "D", "Trumpet"), ["A|D", "E | B | C#m"]);
});

const ROOTS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
const QUALITIES = ["", "m", "7", "maj7", "m7", "dim", "dim7", "ø7", "m7b5", "aug", "+", "sus2", "sus4", "7sus4", "6", "m6", "6/9", "9", "maj9", "11", "13", "add9", "m(maj7)", "5", "7b9", "7#9", "7b5"];
const CONCERT_KEYS = ["C", "G", "D", "A", "E", "B", "F#", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Am", "Em", "Bm", "F#m", "C#m", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm",
  // spelled the far way round, as a library work's source may spell them
  "C#", "G#", "D#", "A#", "Cb", "Fb", "G#m", "D#m", "A#m", "Abm"];

test("every symbol keeps its exact chord, moved by the instrument's interval (exhaustive)", () => {
  // The transposed symbol must parse to the original pitch classes plus the
  // written shift, for every root spelling, quality, slash bass, instrument
  // and concert key (so every respelled written key is covered too).
  let n = 0;
  for (const [instr, semis] of Object.entries(TRANSPOSING)) {
    for (const key of CONCERT_KEYS) {
      for (const root of ROOTS) {
        for (const q of QUALITIES) {
          for (const bass of ["", "/E", "/Bb", "/F#"]) {
            const sym = `${root}${q}${bass}`;
            const before = parseChordSymbol(sym);
            assert.ok(before, `the test symbol ${sym} must itself be readable`);
            const moved = t(sym, key, instr);
            const after = parseChordSymbol(moved);
            assert.ok(after, `${instr} in ${key}: ${sym} → ${moved} is unreadable`);
            const want = [...before].map((pc) => (pc + semis) % 12).sort((a, b) => a - b);
            assert.deepEqual([...after].sort((a, b) => a - b), want, `${instr} in ${key}: ${sym} → ${moved}`);
            n++;
          }
        }
      }
    }
  }
  assert.equal(n, 7 * CONCERT_KEYS.length * 17 * 27 * 4);
});

test("a key's own chords are spelled in the written key signature's direction", () => {
  // Diatonic chords of each concert key, spelled in that key. Each written
  // root must be exactly the note the player's key signature gives its letter
  // (in Eb: E is Eb, F is F), so the chords match the signature they see.
  const DIATONIC = {
    C: ["C", "Dm", "Em", "F", "G", "Am"], G: ["G", "Am", "Bm", "C", "D", "Em"], D: ["D", "Em", "F#m", "G", "A", "Bm"],
    A: ["A", "Bm", "C#m", "D", "E", "F#m"], E: ["E", "F#m", "G#m", "A", "B", "C#m"], B: ["B", "C#m", "D#m", "E", "F#", "G#m"],
    "F#": ["F#", "G#m", "A#m", "B", "C#", "D#m"], F: ["F", "Gm", "Am", "Bb", "C", "Dm"], Bb: ["Bb", "Cm", "Dm", "Eb", "F", "Gm"],
    Eb: ["Eb", "Fm", "Gm", "Ab", "Bb", "Cm"], Ab: ["Ab", "Bbm", "Cm", "Db", "Eb", "Fm"], Db: ["Db", "Ebm", "Fm", "Gb", "Ab", "Bbm"],
    Gb: ["Gb", "Abm", "Bbm", "Cb", "Db", "Ebm"],
    // spelled the far way round: the chords carry that spelling
    "C#": ["C#", "D#m", "E#m", "F#", "G#", "A#m"], "G#": ["G#", "A#m", "B#m", "C#", "D#", "E#m"],
    // (D#, A# and Fb have diatonic chords on double accidentals, which a chord
    // symbol can't carry here; their single-accidental triads are listed.)
    "D#": ["D#", "E#m", "G#", "A#", "B#m"], "A#": ["A#", "D#", "E#"],
    Cb: ["Cb", "Dbm", "Ebm", "Fb", "Gb", "Abm"], Fb: ["Fb", "Gbm", "Abm", "Cb", "Dbm"],
    // minor keys: i, iv, V, VI, III
    "D#m": ["D#m", "G#m", "A#", "B", "F#"], "A#m": ["A#m", "D#m", "E#", "F#", "C#"], "G#m": ["G#m", "C#m", "D#", "E", "B"],
    Abm: ["Abm", "Dbm", "Eb", "Fb", "Cb"], Ebm: ["Ebm", "Abm", "Bb", "Cb", "Gb"],
  };
  const inSignature = (letter, fifths) => letter +
    (fifths > 0 && "FCGDAEB".indexOf(letter) < fifths ? "#" : "") +
    (fifths < 0 && "BEADGCF".indexOf(letter) < -fifths ? "b" : "");
  for (const instr of Object.keys(TRANSPOSING)) {
    for (const [key, triads] of Object.entries(DIATONIC)) {
      const { fifths, writtenKey } = writtenKeyFor(key, instr);
      for (const sym of triads) {
        const root = t(sym, key, instr).match(/^[A-G][#b]?/)[0];
        assert.equal(root, inSignature(root[0], fifths), `${instr}, concert ${key} (reads ${writtenKey}): ${sym} → ${root}`);
      }
    }
  }
  assert.equal(keyFifths("F#") + 2, 8, "the F# trumpet case really is a respelled key");
});

test("a transposing part's prompt carries written-pitch chords, never the concert list", () => {
  const base = {
    songTitle: "T", style: "Baroque", density: "Full", tempoFeel: "Moderate", key: "D", timeSignature: "4/4",
    bpm: 90, measures: 2, otherInstruments: "x", role: null, melodyAbc: "F2 G2 A2 B2 | d8 |]", chords: ["D A", "Bm"],
  };
  const trumpet = buildPartPrompt({ ...base, instrName: "Trumpet" });
  assert.match(trumpet, /CHORDS AS YOU READ THEM \(one per measure, ALREADY transposed into your written key of E; do NOT transpose them again\): E B \| C#m/);
  assert.ok(!trumpet.includes("CHORDS (one per measure): D A"), "the concert list is replaced, not added to");
  assert.match(trumpet, /do NOT transpose them again/);
  assert.ok(!/transpose all notes/.test(trumpet), "the old blanket 'transpose everything' instruction is gone");
  const violin = buildPartPrompt({ ...base, instrName: "Violin" });
  assert.match(violin, /CHORDS \(one per measure\): D A \| Bm/);
  assert.ok(!violin.includes("AS YOU READ THEM"));
});

test("a chord list that arrives as one string is still transposed, not mislabelled", () => {
  const base = {
    songTitle: "T", style: "Baroque", density: "Full", tempoFeel: "Moderate", key: "D", timeSignature: "4/4",
    bpm: 90, measures: 3, otherInstruments: "x", role: null, melodyAbc: "F2 G2 A2 B2 | d8 | d8 |]", chords: "D | A | Bm",
  };
  const trumpet = buildPartPrompt({ ...base, instrName: "Trumpet" });
  assert.match(trumpet, /do NOT transpose them again\): E \| B \| C#m\n/);
  const violin = buildPartPrompt({ ...base, instrName: "Violin" });
  assert.match(violin, /CHORDS \(one per measure\): D \| A \| Bm\n/);
});

test("the interval line keeps the Tenor Sax's octave note; other intervals read as before", () => {
  const base = {
    songTitle: "T", style: "Baroque", density: "Full", tempoFeel: "Moderate", key: "D", timeSignature: "4/4",
    bpm: 90, measures: 2, otherInstruments: "x", role: null, melodyAbc: "F2 G2 A2 B2 | d8 |]", chords: ["D", "A"],
  };
  const tenor = buildPartPrompt({ ...base, instrName: "Tenor Sax" });
  assert.match(tenor, /sounds a major 2nd \(an octave-and-a-tone in sound\) LOWER than written\./);
  const trumpet = buildPartPrompt({ ...base, instrName: "Trumpet" });
  assert.match(trumpet, /sounds a major 2nd \(whole step\) LOWER than written\./);
  const horn = buildPartPrompt({ ...base, instrName: "French Horn" });
  assert.match(horn, /sounds a perfect 5th LOWER than written\./);
});

test("a transposing part is handed the melody in written pitch and never told to transpose it", () => {
  const base = {
    songTitle: "T", style: "Baroque", density: "Full", tempoFeel: "Moderate", key: "D", timeSignature: "4/4",
    bpm: 90, measures: 2, otherInstruments: "x", melodyAbc: "F2 G2 A2 B2 | d8 |]", chords: ["D", "A"],
    role: { primaryRole: "melody", melodySections: ["mm.1-2"] },
  };
  const trumpet = buildPartPrompt({ ...base, instrName: "Trumpet" });
  // Concert F# G A B | d is written a tone up in E: G# A B C# | e.
  assert.match(trumpet, /MAIN MELODY AS YOU WRITE IT \(already transposed into your written key of E; do NOT transpose it again; 4\/4, L:1\/8\):\nG2 A2 B2 c2 \| e8 \|\]/);
  assert.match(trumpet, /EXACT MELODY YOU MUST PLAY \(already in your written key of E: play these pitches and rhythms exactly as shown/);
  assert.match(trumpet, / {2}measure 1: G2 A2 B2 c2\n {2}measure 2: e8/);
  assert.match(trumpet, /Everything below is ALREADY in your written key of E, converted for you: the MAIN MELODY, your melody excerpts, the CHORDS and the ensemble\./);
  for (const gone of [/concert pitch, L:1\/8/, /CONCERT pitches/, /transpose each of those notes/, /rewrite each/, /transposed a major 2nd/]) {
    assert.ok(!gone.test(trumpet), `a transposing part is never told ${gone}`);
  }
  // A non-transposing part still gets the concert melody and its old wording.
  const violin = buildPartPrompt({ ...base, instrName: "Violin" });
  assert.match(violin, /MAIN MELODY \(concert key of D, 4\/4, concert pitch, L:1\/8\):\nF2 G2 A2 B2 \| d8 \|\]/);
  assert.match(violin, /reproduce these pitches\/rhythms, transposed only to fit your range/);
});

// ── The melody in written pitch ─────────────────────────────────────────────
import { writtenMelodyFor } from "../lib/transpose.js";
import { measurePitchEvents } from "../lib/partCheck.js";
import { splitMelodyIntoMeasures, scanMeasure } from "../lib/abcMelody.js";
import { readFileSync as readFileSyncM, readdirSync as readdirSyncM } from "node:fs";

// Read a melody with the repo's own parser: per bar, [{ len, pitches }].
const readBars = (abc, fifths, ts) => splitMelodyIntoMeasures(abc).map((bar) =>
  measurePitchEvents(bar, ts, fifths).map((e) => ({ len: e.len, pitches: e.pitches })));

function assertWrittenMelody(melodyAbc, key, instr, ts, where) {
  const written = writtenMelodyFor(melodyAbc, key, instr);
  const a = readBars(melodyAbc, keyFifths(key), ts);
  const b = readBars(written, writtenKeyFor(key, instr).fifths, ts);
  const semis = TRANSPOSING[instr];
  assert.equal(b.length, a.length, `${where}: bar count`);
  a.forEach((bar, i) => {
    assert.equal(b[i].length, bar.length, `${where} bar ${i + 1}: event count\n  ${melodyAbc}\n  ${written}`);
    bar.forEach((e, j) => {
      assert.equal(b[i][j].len, e.len, `${where} bar ${i + 1} event ${j + 1}: length`);
      assert.deepEqual(b[i][j].pitches, e.pitches.map((p) => p + semis), `${where} bar ${i + 1} event ${j + 1}: ${splitMelodyIntoMeasures(melodyAbc)[i]} -> ${splitMelodyIntoMeasures(written)[i]}`);
    });
    assert.equal(scanMeasure(splitMelodyIntoMeasures(written)[i], ts).length, scanMeasure(splitMelodyIntoMeasures(melodyAbc)[i], ts).length);
  });
  assert.ok(!/[\^_]{3}|=[\^_]|[\^_]=/.test(written), `${where}: no malformed accidentals in ${written}`);
  return written;
}

test("named melodies in written pitch, each checked by hand", () => {
  const cases = [
    ["f4 e4 | d4 c4 | B4 A4 |]", "D", "Trumpet", "g4 f4 | e4 d4 | c4 B4 |]"], // reads E: G# F# E D# C# B
    ["c2 d2 e2 f2 | ^f2 g2 f2 e2 |]", "C", "Clarinet", "d2 e2 f2 g2 | ^g2 a2 g2 f2 |]"], // the ^ holds to the barline
    ["A z/ C/E/A/ | ^G z/ E/^G/B/ |]", "Am", "English Horn", "e z/ G/B/e/ | ^d z/ B/d/f/ |]"],
    ["!mf!\"Am\"(3cde [CEG]2 {g}f2- f2 | _B,4 z4 |]", "F", "Alto Sax", "!mf!\"Am\"(3abc' [Ace]2 {e'}d'2- d'2 | G4 z4 |]"],
    ["c2 d2 e2 f2 |]", "C", "Violin", "c2 d2 e2 f2 |]"], // not transposing: unchanged
    // Concert "C#" is READ with Db's signature by the whole system (keyFifths),
    // so its melody is respelled from Db, not C#: plain letters, no E-double-flat.
    ["{d'}C'2 {C,}f2 C [G,C,C]2 |]", "C#", "Trumpet", "{e'}d2 {D,}g2 D [A,=D,D]2 |]"], // =D,: a grace note touched D3 in this bar
    // A grace note's accidental never carries: the main note states its own.
    ["{^c}c2 c2 |]", "C", "Clarinet", "{^d}=d2 d2 |]"],
  ];
  for (const [m, k, i, want] of cases) assert.equal(writtenMelodyFor(m, k, i), want, `${i} in ${k}`);
});

test("every real melody sounds exactly the same in written pitch (library + every saved plan)", () => {
  const seen = new Set();
  const melodies = [];
  for (const dir of ["../../data/scores/"]) {
    for (const f of readdirSyncM(new URL(dir, import.meta.url)).filter((x) => x.endsWith(".abc"))) {
      const text = readFileSyncM(new URL(dir + f, import.meta.url), "utf8");
      const key = (text.match(/^K:\s*(\S+)/m) || [])[1];
      const ts = (text.match(/^M:\s*(\S+)/m) || [])[1];
      const body = text.split("\n").filter((l) => !/^[A-Za-z]:|^%/.test(l.trim())).join("\n");
      melodies.push([body, key, ts, f]);
    }
  }
  const runs = new URL("../../eval/runs/", import.meta.url);
  for (const l of readdirSyncM(runs)) for (const f of readdirSyncM(new URL(`${l}/`, runs)).filter((x) => x.endsWith(".json"))) {
    const run = JSON.parse(readFileSyncM(new URL(`${l}/${f}`, runs), "utf8"));
    if (seen.has(run.plan.melodyAbc)) continue;
    seen.add(run.plan.melodyAbc);
    melodies.push([run.plan.melodyAbc, run.common.key, run.common.timeSignature, `${l}/${f}`]);
  }
  assert.ok(melodies.length >= 25, `found ${melodies.length} melodies`);
  for (const [m, key, ts, where] of melodies) for (const instr of Object.keys(TRANSPOSING)) assertWrittenMelody(m, key, instr, ts, `${where} ${instr}`);
});

test("random melodies in every concert key sound exactly the same in written pitch", () => {
  // Accidentals (held to the barline, cancelled, doubled), octaves, chords,
  // tuplets, ties, grace notes and decorations, in all 34 concert keys.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const LET = "CDEFGABcdefgab";
  const note = () => ["", "", "", "^", "_", "=", "^^", "__"][rnd(8)] + LET[rnd(14)] + ["", "", "", ",", "'"][rnd(5)];
  const bar = () => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const r = rnd(10);
      if (r === 0) out.push(`[${note()}${note()}${note()}]2`);
      else if (r === 1) out.push(`(3${note()}${note()}${note()}`);
      else if (r === 2) out.push(`{${note()}}${note()}2`);
      else if (r === 3) out.push(`!mf!${note()}-${note()}`);
      else if (r === 4) out.push("z2");
      else out.push(`${note()}${["", "2", "/", "3/2"][rnd(4)]}`);
    }
    return out.join(" ");
  };
  let n = 0;
  for (const instr of Object.keys(TRANSPOSING)) for (const key of CONCERT_KEYS) for (let t = 0; t < 40; t++) {
    assertWrittenMelody(`${bar()} | ${bar()} | ${bar()} |]`, key, instr, "4/4", `${instr} in ${key} #${t}`);
    n++;
  }
  assert.equal(n, 7 * CONCERT_KEYS.length * 40);
});
