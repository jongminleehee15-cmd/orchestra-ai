// Chunked part generation for long pieces.
//
// A single call asked for 64 measures reliably under-writes (12–20 bars came
// back in practice) — long generations degrade. So above CHUNK_THRESHOLD
// measures, /api/part writes the part in sections of ~CHUNK_SIZE measures:
// every call still sees the full musical context (song, role, whole melody,
// all chords) plus the tail of what's already written, but only has to
// produce one section, which stays inside the model's reliable window. The
// sections are validated/repaired individually and stitched back into one
// part. These pure helpers do the splitting/stitching; the orchestration
// lives in server/index.js.

import { parseMeasureRange } from "./abcMelody.js";

export const CHUNK_THRESHOLD = 24; // single-call parts up to here
export const CHUNK_SIZE = 16; // target measures per chunk
const MIN_TAIL = 8; // a final chunk smaller than this folds into the previous one

// 1-based inclusive [start, end] ranges covering 1..measures.
export function chunkRanges(measures) {
  const ranges = [];
  let start = 1;
  while (start <= measures) {
    let end = Math.min(start + CHUNK_SIZE - 1, measures);
    if (measures - end > 0 && measures - end < MIN_TAIL) end = measures;
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

// Clip section labels ("mm.5-12") to a chunk window. `toLocal` re-numbers the
// result relative to the chunk (piece measure `start` → 1) for validators that
// only see the chunk's measures; otherwise piece numbering is kept for prompts.
export function intersectSections(sections, start, end, toLocal = false) {
  const out = [];
  for (const label of sections || []) {
    const r = parseMeasureRange(label);
    if (!r) continue;
    const a = Math.max(r.start, start);
    const b = Math.min(r.end, end);
    if (a > b) continue;
    out.push(toLocal ? `mm.${a - start + 1}-${b - start + 1}` : `mm.${a}-${b}`);
  }
  return out;
}

// The ABC header of a part: everything up to and including the K: line.
export function headerOf(abc) {
  const lines = String(abc).split(/\r?\n/);
  const kIdx = lines.findIndex((l) => /^K:/.test(l.trim()));
  return kIdx >= 0 ? lines.slice(0, kIdx + 1).join("\n") : String(abc);
}

// Reassemble stitched measures into a body: 4 bars per line, final |].
export function stitchBody(measures) {
  const lines = [];
  for (let i = 0; i < measures.length; i += 4) {
    const last = i + 4 >= measures.length;
    lines.push(measures.slice(i, i + 4).join(" | ") + (last ? " |]" : " |"));
  }
  return lines.join("\n");
}
