// MusicXML → canonical melody. The top of the source-quality hierarchy:
// professionally engraved public-domain scores (MuseScore, Mutopia, OpenScore,
// IMSLP exports) carry exact pitches and rhythms. We extract the melody line
// (staff 1, dominant voice, top note of chords) and convert it to the
// pipeline's validated ABC measure format — no model involvement anywhere.

import { XMLParser } from "fast-xml-parser";
import { inflateRawSync } from "node:zlib";
import { analyzeMelody } from "./abcMelody.js";
import { eventsToMeasures, keyName, midiOf } from "./symbolic.js";

const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x && typeof x === "object" ? x["#text"] : x);

// ── .mxl (compressed MusicXML) ───────────────────────────────────────────────
// Minimal ZIP reader: locate the End Of Central Directory, walk the central
// directory, inflate the first real score entry (META-INF excluded).
export function unzipMxl(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .mxl (zip) file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.startsWith("META-INF") || !/\.(xml|musicxml)$/i.test(name)) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    return (method === 8 ? inflateRawSync(data) : Buffer.from(data)).toString("utf8");
  }
  throw new Error("no MusicXML document found inside the .mxl archive");
}

// ── MusicXML parsing ─────────────────────────────────────────────────────────
export function parseMusicXml(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  }).parse(text);

  const score = doc["score-partwise"];
  if (!score) {
    if (doc["score-timewise"]) throw new Error("score-timewise MusicXML is not supported — export as score-partwise (the default in most editors)");
    throw new Error("not a MusicXML document");
  }

  const title = txt(score.work?.["work-title"]) || txt(score["movement-title"]) || "";
  const composer = arr(score.identification?.creator)
    .map((c) => txt(c))
    .filter(Boolean)[0] || "";

  const parts = arr(score.part);
  if (parts.length === 0) throw new Error("MusicXML file contains no parts");

  // The melody is almost always in the first part, but a file may lead with
  // an empty/percussion part — try each until one converts and validates.
  let lastErr = null;
  for (const part of parts) {
    try {
      return extractPart(part, { title, composer });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const pitchOf = (n) => ({
  step: String(txt(n.pitch.step)).toUpperCase(),
  alter: Number(txt(n.pitch.alter) || 0),
  octave: Number(txt(n.pitch.octave)),
});

function extractPart(part, meta) {
  const rawMeasures = arr(part.measure);
  if (rawMeasures.length === 0) throw new Error("part has no measures");

  // The melody voice = the voice with the most staff-1 notes.
  const voiceCount = {};
  for (const m of rawMeasures) {
    for (const n of arr(m.note)) {
      if (n.grace !== undefined || Number(txt(n.staff) || 1) !== 1) continue;
      const v = String(txt(n.voice) ?? "1");
      voiceCount[v] = (voiceCount[v] || 0) + 1;
    }
  }
  const voice = Object.entries(voiceCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!voice) throw new Error("no notes on staff 1 of this part");

  let divisions = 1, fifths = 0, minor = false, beats = 4, beatType = 4, bpm = 0;
  const measures = [];

  for (const m of rawMeasures) {
    for (const a of arr(m.attributes)) {
      if (a.divisions !== undefined) divisions = Number(txt(a.divisions)) || divisions;
      const k = arr(a.key)[0];
      if (k && k.fifths !== undefined) {
        fifths = Number(txt(k.fifths)) || 0;
        minor = String(txt(k.mode) || "").toLowerCase() === "minor";
      }
      const t = arr(a.time)[0];
      if (t) { beats = Number(txt(t.beats)) || beats; beatType = Number(txt(t["beat-type"])) || beatType; }
    }
    if (!bpm) {
      for (const d of [...arr(m.direction), m]) {
        const s = arr(d.sound)[0] || (d.sound === undefined ? null : d.sound);
        const tempo = s && s["@_tempo"];
        if (tempo) { bpm = Math.round(Number(tempo)); break; }
      }
    }

    const events = [];
    for (const n of arr(m.note)) {
      if (n.grace !== undefined) continue;
      if (Number(txt(n.staff) || 1) !== 1) continue;
      if (String(txt(n.voice) ?? "1") !== voice) continue;
      const dur = (Number(txt(n.duration)) / divisions) * 2; // → L:1/8 units
      if (!(dur > 0)) continue;

      if (n.chord !== undefined) {
        // Chord member: melody is the TOP note; no extra time is consumed.
        const prev = events[events.length - 1];
        if (prev && !prev.rest && n.pitch) {
          const cand = pitchOf(n);
          if (midiOf(cand) > midiOf(prev)) Object.assign(prev, cand);
        }
        continue;
      }
      if (n.rest !== undefined || !n.pitch) {
        events.push({ rest: true, dur });
        continue;
      }
      const tie = arr(n.tie).some((t) => t["@_type"] === "start");
      events.push({ ...pitchOf(n), dur, tie });
    }
    measures.push(events);
  }

  const timeSignature = `${beats}/${beatType}`;
  const melodyMeasures = eventsToMeasures({ measures, timeSignature, fifths });
  if (melodyMeasures.length < 4) throw new Error("melody too short after conversion (fewer than 4 measures)");

  const analysis = analyzeMelody(`${melodyMeasures.join(" | ")} |]`, timeSignature, melodyMeasures.length);
  if (!analysis.ok) {
    throw new Error(`converted melody failed validation — ${analysis.problems.slice(0, 3).join("; ")}`);
  }

  return {
    title: meta.title,
    composer: meta.composer,
    key: keyName(fifths, minor),
    timeSignature,
    bpm: bpm || 100,
    melodyMeasures,
  };
}
