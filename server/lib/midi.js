// MIDI → canonical melody. Second tier of the source-quality hierarchy:
// pitches and rhythms are exact, but there is no engraved spelling, so we
// quantize onto a sixteenth grid, extract the melody by skyline (highest
// sounding note wins), and spell pitches from the file's key signature.

import { analyzeMelody } from "./abcMelody.js";
import { eventsToMeasures, keyName } from "./symbolic.js";

function readVarint(buf, pos) {
  let value = 0, p = pos;
  for (let i = 0; i < 4; i++) {
    const b = buf[p++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [value, p];
}

export function parseMidi(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 14 || buf.toString("latin1", 0, 4) !== "MThd") {
    throw new Error("not a MIDI file (missing MThd header)");
  }
  const headerLen = buf.readUInt32BE(4);
  const ntrks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported");
  const tpq = division; // ticks per quarter note

  let pos = 8 + headerLen;
  const tracks = []; // per track: [{ tick, dur, pitch }]
  let tempoBpm = 0, timeSig = null, fifths = 0, minor = false;

  for (let t = 0; t < ntrks && pos + 8 <= buf.length; t++) {
    if (buf.toString("latin1", pos, pos + 4) !== "MTrk") break;
    const len = buf.readUInt32BE(pos + 4);
    let p = pos + 8;
    const end = p + len;
    pos = end;

    let tick = 0, status = 0;
    const open = new Map(); // channel<<8|pitch → start tick
    const notes = [];
    const closeNote = (ch, pitch) => {
      const key = (ch << 8) | pitch;
      const start = open.get(key);
      if (start !== undefined) {
        open.delete(key);
        if (tick > start) notes.push({ tick: start, dur: tick - start, pitch });
      }
    };

    while (p < end) {
      let delta;
      [delta, p] = readVarint(buf, p);
      tick += delta;
      let b = buf[p];
      if (b & 0x80) { status = b; p++; }
      b = status;

      if (b === 0xff) {
        const type = buf[p++];
        let mlen;
        [mlen, p] = readVarint(buf, p);
        if (type === 0x51 && mlen === 3 && !tempoBpm) {
          const usPerQ = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
          if (usPerQ > 0) tempoBpm = Math.round(60000000 / usPerQ);
        } else if (type === 0x58 && mlen >= 2 && !timeSig) {
          timeSig = `${buf[p]}/${1 << buf[p + 1]}`;
        } else if (type === 0x59 && mlen >= 2 && fifths === 0) {
          fifths = buf.readInt8(p);
          minor = buf[p + 1] === 1;
        }
        p += mlen;
      } else if (b === 0xf0 || b === 0xf7) {
        let slen;
        [slen, p] = readVarint(buf, p);
        p += slen;
      } else {
        const type = b & 0xf0, ch = b & 0x0f;
        if (type === 0x90) {
          const pitch = buf[p], vel = buf[p + 1];
          p += 2;
          if (ch === 9) continue; // drums
          if (vel > 0) { closeNote(ch, pitch); open.set((ch << 8) | pitch, tick); }
          else closeNote(ch, pitch);
        } else if (type === 0x80) {
          const pitch = buf[p];
          p += 2;
          if (ch !== 9) closeNote(ch, pitch);
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) p += 2;
        else if (type === 0xc0 || type === 0xd0) p += 1;
        else throw new Error(`corrupt MIDI track (status 0x${b.toString(16)})`);
      }
    }
    if (notes.length) tracks.push(notes);
  }
  if (tracks.length === 0) throw new Error("MIDI file contains no notes");

  // Melody track = highest average pitch among tracks with enough notes
  // (a lone track — e.g. format-0 piano — is skylined as a whole).
  const candidates = tracks.filter((n) => n.length >= 8);
  const pool = candidates.length ? candidates : tracks;
  const meanPitch = (ns) => ns.reduce((s, n) => s + n.pitch, 0) / ns.length;
  const chosen = pool.sort((a, b) => meanPitch(b) - meanPitch(a))[0];

  // Skyline: at any moment keep only the highest sounding note.
  const grid = Math.max(1, Math.round(tpq / 4)); // sixteenth-note ticks
  const sorted = [...chosen].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
  const line = [];
  for (const n of sorted) {
    const last = line[line.length - 1];
    if (!last || n.tick >= last.tick + last.dur - grid / 2) {
      line.push({ ...n });
    } else if (n.pitch > last.pitch) {
      last.dur = n.tick - last.tick;
      if (last.dur <= 0) line.pop();
      line.push({ ...n });
    } // lower note under a sustained higher one → drop
  }

  // Quantize to the sixteenth grid, then express in L:1/8 units (grid/2).
  const q = line
    .map((n) => {
      const start = Math.round(n.tick / grid);
      const dur = Math.max(1, Math.round((n.tick + n.dur) / grid) - start);
      return { start, dur, pitch: n.pitch };
    })
    .filter((n, i, a) => i === 0 || n.start >= a[i - 1].start + a[i - 1].dur || n.start > a[i - 1].start);

  const timeSignature = timeSig || "4/4";
  const [num, den] = timeSignature.split("/").map(Number);
  const barSixteenths = Math.round((num * 8 / den) * 2);
  if (!(barSixteenths > 0)) throw new Error(`unsupported time signature ${timeSignature}`);

  // Lay the line into bars, filling gaps with rests and tying notes that
  // cross a barline.
  const measures = [];
  const barOf = (sx) => Math.floor(sx / barSixteenths);
  const push = (startSx, lenSx, payload) => {
    let s = startSx, remaining = lenSx;
    while (remaining > 0) {
      const bar = barOf(s);
      while (measures.length <= bar) measures.push([]);
      const inBar = Math.min(remaining, (bar + 1) * barSixteenths - s);
      const ev = { dur: inBar / 2, ...payload };
      if (!payload.rest) ev.tie = remaining > inBar;
      measures[bar].push(ev);
      s += inBar;
      remaining -= inBar;
    }
  };

  let cursor = 0;
  for (const n of q) {
    if (n.start > cursor) push(cursor, n.start - cursor, { rest: true });
    const startSx = Math.max(n.start, cursor);
    const endSx = n.start + n.dur;
    if (endSx > startSx) push(startSx, endSx - startSx, { midi: n.pitch });
    cursor = Math.max(cursor, endSx);
  }

  const melodyMeasures = eventsToMeasures({ measures, timeSignature, fifths });
  if (melodyMeasures.length < 4) throw new Error("melody too short after conversion (fewer than 4 measures)");

  const analysis = analyzeMelody(`${melodyMeasures.join(" | ")} |]`, timeSignature, melodyMeasures.length);
  if (!analysis.ok) {
    throw new Error(`converted melody failed validation — ${analysis.problems.slice(0, 3).join("; ")}`);
  }

  return {
    title: "",
    composer: "",
    key: keyName(fifths, minor),
    timeSignature,
    bpm: tempoBpm || 100,
    melodyMeasures,
  };
}
