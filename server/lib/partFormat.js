// The wire format for a generated instrument part.
//
// Parts are requested as a JSON envelope — {"measures": ["<bar>", ...]}, one
// string per bar — rather than as a free-text ABC tune. Two things that used
// to be the model's responsibility are now the server's:
//
//   1. The HEADER (key, meter, unit length, tempo, clef) is built here from
//      the request's own data. A part can no longer ship with the wrong key
//      signature — a real hazard for transposing instruments, which read in a
//      different key than concert pitch — or with no header at all when a
//      response came back empty, refused, or truncated early.
//   2. The MEASURE COUNT is the array's length, stated outright, instead of
//      something inferred by splitting on barlines.
//
// Raw ABC is still accepted as a fallback, so a response that ignores the
// format degrades to the old behaviour instead of failing outright.

import { extractJson } from "../anthropic.js";
import { partMeasures } from "./partCheck.js";
import { stitchBody } from "./chunking.js";
import { writtenKeyFor } from "./transpose.js";
import { getMeta } from "./instrMeta.js";

// Strip any stray fences/prose before the leading X: header.
export function cleanAbc(text) {
  let t = (text || "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
  const idx = t.indexOf("X:");
  if (idx > 0) t = t.slice(idx);
  return t;
}

// The ABC header for a part, built entirely from the request's own key,
// meter, tempo and instrument data — never from model output.
export function partHeader({ key, timeSignature, bpm }, instrName) {
  const { writtenKey, label } = writtenKeyFor(key, instrName);
  const { clef } = getMeta(instrName);
  return [
    "X:1",
    `T:${instrName}${label ? ` (${label})` : ""}`,
    `M:${timeSignature}`,
    "L:1/8",
    `Q:1/4=${bpm}`,
    `K:${writtenKey} clef=${clef}`,
  ].join("\n");
}

// Every ABC barline spelling, longest first so "|]" is consumed whole rather
// than leaving a stray "]" behind (which would look like a broken chord).
const BARLINES = /\|\]|\[\||\|\||::|:\||\|:|\|/g;

function stripBarlines(measure) {
  return measure.replace(BARLINES, " ").replace(/\s+/g, " ").trim();
}

// Does this text read as a bar of ABC, rather than prose or leftover JSON?
// Decorations and annotations are set aside first, then the remainder must
// contain at least one note/rest and nothing but ABC-legal characters. Without
// this, a refusal sentence ("I cannot help with that.") or a fragment of a
// truncated response would be spliced into the score as if it were music.
function looksLikeMeasure(text) {
  if (!text) return false;
  const bare = text
    .replace(/![^!]*!/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\{[^}]*\}/g, "");
  if (!/[A-Ga-gxzZ]/.test(bare)) return false;
  return !/[^A-Ga-gxzZ0-9\s,'^_=/[\]()<>~.:-]/.test(bare);
}

// Pull the per-measure note strings out of a part response.
export function parsePartMeasures(text) {
  const raw = String(text || "");
  let parsed = null;
  try {
    parsed = extractJson(raw);
  } catch {
    // Not JSON — handled below.
  }

  // The envelope came back: it IS the answer, even when empty. A short array
  // is reported honestly so the caller's structure check can retry, rather
  // than being topped up from some other reading of the same response.
  if (parsed && Array.isArray(parsed.measures)) {
    return parsed.measures
      .filter((m) => typeof m === "string")
      .map(stripBarlines)
      .filter(looksLikeMeasure);
  }

  // The response was ATTEMPTING the envelope but was cut off mid-array, so
  // extractJson couldn't salvage it. Treat it as unusable rather than letting
  // the raw JSON text be read as notation — the caller then pads to explicit
  // rests and says so, instead of shipping gibberish on the stave.
  if (/"measures"\s*:/.test(raw)) return [];

  // Genuine raw ABC (a model that ignored the format, or an older response).
  return partMeasures(cleanAbc(raw)).filter(looksLikeMeasure);
}

// One model response → a complete, well-formed ABC part. An empty or garbage
// response yields just the header, which the caller's length check then pads
// into an explicit all-rests part with a warning attached.
export function responseToPartAbc(text, header) {
  const measures = parsePartMeasures(text);
  return measures.length > 0 ? `${header}\n${stitchBody(measures)}` : header;
}
