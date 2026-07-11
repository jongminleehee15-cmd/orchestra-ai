import { getMeta } from "./constants.js";

// Wrap the bare canonical melody body (single ABC note line from the blueprint)
// in proper ABC headers so abcjs can render the lead-sheet preview.
export function buildLeadSheetAbc(melodyAbc, { key, timeSig, bpm }) {
  if (!melodyAbc) return null;
  return `X:1\nT:Main Melody\nM:${timeSig}\nL:1/8\nQ:1/4=${bpm}\nK:${key}\n${melodyAbc}`;
}

// Short staff label for systems after the first: "Violin 1" → "Vio. 1".
function shortName(name) {
  const m = String(name).match(/^(.*?)(\s+\d+)?$/) || [];
  const words = (m[1] || "").trim().split(/\s+/);
  return words.map((w) => (w.length > 4 ? w.slice(0, 3) + "." : w)).join(" ") + (m[2] || "");
}

// Stack every generated part into ONE multi-voice ABC tune — the full score.
// Each voice keeps its own written key and clef (transposing parts stay in
// their read key on the page, per full-score convention) and carries
// playback-only %%MIDI directives: the instrument's General MIDI program,
// plus — for transposing instruments — the shift back down to concert pitch
// so the whole ensemble SOUNDS in tune together. abcjs honors K:, %%MIDI
// program, and %%MIDI transpose per voice (verified against abcjs 6.4.4).
export function buildFullScoreAbc(parts, { title, timeSig, bpm, key }) {
  const done = (parts || []).filter((p) => p.status === "done" && p.abcText);
  const vids = [];
  const defs = [];
  const bodies = [];

  for (const part of done) {
    const meta = getMeta(part.baseName || part.instrName);
    const lines = String(part.abcText).split(/\r?\n/);
    const kIdx = lines.findIndex((l) => /^K:/.test(l.trim()));
    const kLine = kIdx >= 0 ? lines[kIdx].trim() : `K:${key} clef=${meta.clef || "treble"}`;
    const clef = (kLine.match(/clef=([\w+-]+)/) || [])[1] || meta.clef || "treble";
    // Music = everything after the K: line, minus stray header/directive lines
    // (keep w: lyric lines — they belong to the music).
    const music = lines.slice(kIdx + 1).filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("%") && (!/^[A-Za-z]:/.test(t) || /^w:/.test(t));
    });
    if (!music.length) continue;

    const vid = `V${vids.length + 1}`;
    const name = String(part.instrName).replace(/"/g, "'");
    vids.push(vid);
    defs.push(`V:${vid} name="${name}" snm="${shortName(name).replace(/"/g, "'")}" clef=${clef}`);
    const midi = [`%%MIDI program ${meta.midi ?? 0}`];
    if (meta.shift) midi.push(`%%MIDI transpose ${meta.shift}`);
    bodies.push([`V:${vid}`, kLine, ...midi, ...music].join("\n"));
  }
  if (!bodies.length) return null;

  return [
    "X:1",
    `T:${title} — Full Score`,
    `M:${timeSig}`,
    "L:1/8",
    `Q:1/4=${bpm}`,
    `%%score ${vids.join(" ")}`,
    `K:${key}`,
    ...defs,
    ...bodies,
  ].join("\n");
}

// Concatenate the lead sheet + every generated part into one downloadable .abc.
export function buildScoreAbc(leadSheetAbc, parts) {
  const header = leadSheetAbc ? leadSheetAbc + "\n\n" : "";
  return header + parts.filter((p) => p.abcText).map((p) => p.abcText).join("\n\n");
}
