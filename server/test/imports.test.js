// The import pipeline is the top of the source-quality hierarchy: MusicXML
// and MIDI files must convert into canonical melody measures that pass the
// same validation gate as the curated library — or be rejected loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { parseMusicXml, unzipMxl } from "../lib/musicxml.js";
import { parseMidi } from "../lib/midi.js";
import { eventsToMeasures, keyName, lenSuffix, spellMidi } from "../lib/symbolic.js";
import { serializeImport } from "../lib/imports.js";
import { parseAbcWork } from "../lib/library.js";
import { analyzeMelody } from "../lib/abcMelody.js";

// ── symbolic core ────────────────────────────────────────────────────────────
test("keyName covers majors, minors, and clamps", () => {
  assert.equal(keyName(0), "C");
  assert.equal(keyName(1), "G");
  assert.equal(keyName(-1), "F");
  assert.equal(keyName(0, true), "Am");
  assert.equal(keyName(3, true), "F#m");
});

test("lenSuffix maps eighth-unit durations to ABC lengths", () => {
  assert.equal(lenSuffix(1), "");
  assert.equal(lenSuffix(2), "2");
  assert.equal(lenSuffix(0.5), "/");
  assert.equal(lenSuffix(1.5), "3/2");
  assert.equal(lenSuffix(0.25), "1/4");
  // Triplets are unrepresentable as a fractional note length — abcjs's parser
  // rejects "2/3"-style durations outright, so this must stay null (the
  // caller's grid-snap + bar-math rejection is the correct, safe behavior).
  assert.equal(lenSuffix(2 / 3), null);
});

test("spellMidi prefers sharps in sharp keys and flats in flat keys", () => {
  assert.deepEqual(spellMidi(61, 2), { step: "C", alter: 1, octave: 4 });  // C#4 in D
  assert.deepEqual(spellMidi(61, -2), { step: "D", alter: -1, octave: 4 }); // Db4 in Bb
  assert.deepEqual(spellMidi(60, 0), { step: "C", alter: 0, octave: 4 });
});

test("eventsToMeasures spells accidentals against the key signature", () => {
  // Key D (2 sharps): F# needs no accidental, F-natural needs "=", C# none.
  const bars = eventsToMeasures({
    measures: [[
      { dur: 2, step: "F", alter: 1, octave: 4 },
      { dur: 2, step: "F", alter: 0, octave: 4 },
      { dur: 2, step: "F", alter: 1, octave: 4 },
      { dur: 2, step: "C", alter: 1, octave: 5 },
    ]],
    timeSignature: "4/4",
    fifths: 2,
  });
  assert.equal(bars[0], "F2=F2^F2c2");
});

test("eventsToMeasures pads a pickup bar with leading rests", () => {
  const bars = eventsToMeasures({
    measures: [
      [{ dur: 2, midi: 67 }],
      [{ dur: 8, midi: 72 }],
    ],
    timeSignature: "4/4",
    fifths: 0,
  });
  assert.equal(bars[0], "z4z2G2");
  assert.equal(bars[1], "c8");
});

// ── MusicXML ─────────────────────────────────────────────────────────────────
const XML = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <work><work-title>Test Tune</work-title></work>
  <identification><creator type="composer">A. Composer</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><rest/><duration>3</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><alter>0</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="3">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><tie type="start"/></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
    <measure number="4">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

test("parseMusicXml extracts melody with chord-top, ties, and key spelling", () => {
  const w = parseMusicXml(XML);
  assert.equal(w.title, "Test Tune");
  assert.equal(w.composer, "A. Composer");
  assert.equal(w.key, "G");
  assert.equal(w.timeSignature, "4/4");
  // chord [B,d] keeps top note d; rest fills the bar
  assert.equal(w.melodyMeasures[0], "G2A2dz3");
  // F natural then F# — in G major (F# in signature) the natural needs "="
  assert.equal(w.melodyMeasures[1], "=F4^F4");
  // tie across the written notes
  assert.ok(w.melodyMeasures[2].includes("-"));
  const analysis = analyzeMelody(`${w.melodyMeasures.join(" | ")} |]`, "4/4", 4);
  assert.deepEqual(analysis.problems, []);
});

test("unzipMxl extracts and inflates the score entry", () => {
  const w = parseMusicXml(unzipMxl(makeMxl(XML)));
  assert.equal(w.title, "Test Tune");
});

// A voice+piano score where the Voice part fails validation (bad duration
// math) must NOT silently fall back to the Piano part — that would ship the
// accompaniment as "the melody" with the same confidence as a correct
// extraction. Regression for a real bug found in an OpenScore Lieder file
// (Fauré's "Après un rêve": a failing tied vocal line fell through to the
// piano's repeated broken-chord figure, which validated fine but was wrong).
const VOICE_PIANO_XML = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <work><work-title>Broken Vocal Line</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice></note>
    </measure>
    <!-- overfilled bar (10 units where 8 is expected) — not a pickup, a genuine error -->
    <measure number="2"><note><pitch><step>D</step><octave>5</octave></pitch><duration>10</duration><voice>1</voice></note></measure>
    <measure number="3"><note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
    <measure number="4"><note><pitch><step>F</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="2"><note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
    <measure number="3"><note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
    <measure number="4"><note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
  </part>
</score-partwise>`;

test("parseMusicXml fails closed instead of falling back from a broken Voice part to Piano", () => {
  assert.throws(() => parseMusicXml(VOICE_PIANO_XML), /validation/);
});

test("parseMusicXml still falls back among parts when none are tagged as accompaniment", () => {
  // Two non-accompaniment-named parts, the first genuinely empty — the
  // original "may lead with an empty/percussion part" fallback must still work.
  const xml = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Flute</part-name></score-part>
    <score-part id="P2"><part-name>Cello</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"></measure></part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
    <measure number="3"><note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
    <measure number="4"><note><pitch><step>F</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note></measure>
  </part>
</score-partwise>`;
  const w = parseMusicXml(xml);
  assert.equal(w.melodyMeasures[0], "C4C4");
});

// Build a minimal one-entry zip (deflate) around the XML, as MuseScore does.
function makeMxl(xml) {
  const name = Buffer.from("score.xml");
  const data = deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

// ── MIDI ─────────────────────────────────────────────────────────────────────
// Build a tiny format-0 file: 4/4, key G major, C4 D4 quarters, E4 half, F4 whole.
function makeMidi() {
  const events = [];
  const push = (...bytes) => events.push(...bytes);
  push(0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8);       // 4/4
  push(0x00, 0xff, 0x59, 0x02, 1, 0);              // 1 sharp, major
  push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);  // 120 bpm
  const note = (delta, pitch, dur) => {
    push(...varint(delta), 0x90, pitch, 80, ...varint(dur), 0x80, pitch, 0);
  };
  note(0, 60, 96);   // C4 quarter (tpq=96)
  note(0, 62, 96);   // D4 quarter
  note(0, 64, 192);  // E4 half
  note(0, 66, 384);  // F#4 whole (diatonic in G — no accidental expected)
  note(0, 67, 384);  // G4 whole (bar 3, so we clear the 4-bar minimum)
  note(0, 69, 384);  // A4 whole (bar 4)
  push(0x00, 0xff, 0x2f, 0x00);
  const track = Buffer.from(events);
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "latin1");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(96, 12);
  const th = Buffer.alloc(8);
  th.write("MTrk", 0, "latin1");
  th.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, th, track]);
}
function varint(v) {
  if (v < 0x80) return [v];
  return [0x80 | (v >> 7), v & 0x7f];
}

test("parseMidi converts a simple file with meta events", () => {
  const w = parseMidi(makeMidi());
  assert.equal(w.timeSignature, "4/4");
  assert.equal(w.key, "G");
  assert.equal(w.bpm, 120);
  assert.equal(w.melodyMeasures[0], "C2D2E4");
  assert.equal(w.melodyMeasures[1], "F8");
  const analysis = analyzeMelody(`${w.melodyMeasures.join(" | ")} |]`, "4/4", w.melodyMeasures.length);
  assert.deepEqual(analysis.problems, []);
});

test("parseMidi rejects non-MIDI data", () => {
  assert.throws(() => parseMidi(Buffer.from("not a midi file")), /MThd/);
});

// ── canonical round-trip ─────────────────────────────────────────────────────
test("serializeImport round-trips through parseAbcWork (chords optional)", () => {
  const w = parseMusicXml(XML);
  const text = serializeImport({ ...w, sourceFile: "test.xml" });
  const back = parseAbcWork(text, "import-test-tune", { requireChords: false });
  assert.equal(back.title, "Test Tune");
  assert.equal(back.key, "G");
  assert.deepEqual(back.melodyMeasures, w.melodyMeasures);

  // and with chords persisted (solved once), the strict parse also passes
  const chords = w.melodyMeasures.map(() => "G");
  const text2 = serializeImport({ ...w, chords, sourceFile: "test.xml" });
  const back2 = parseAbcWork(text2, "import-test-tune", { requireChords: true });
  assert.deepEqual(back2.chords, chords);
});
