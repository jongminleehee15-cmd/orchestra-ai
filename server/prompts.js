import { getMeta } from "./lib/instrMeta.js";
import { buildMelodyExcerpts, sliceMelody, splitMelodyIntoMeasures } from "./lib/abcMelody.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. SONG SEARCH
// ─────────────────────────────────────────────────────────────────────────────
export function buildSearchPrompt(query) {
  return `You are a music knowledge database. The user searched for: "${query}"

Return ONLY a JSON array of up to 6 matching songs. Each object must have exactly these fields:
{
  "title": "exact song title",
  "artist": "composer or artist name",
  "year": "year as string e.g. 1995",
  "genre": "specific genre e.g. Romantic Classical, Jazz Standard, Pop Rock",
  "key": "musical key e.g. C, G, Dm, F#m",
  "timeSignature": "e.g. 4/4 or 3/4",
  "bpm": number between 40-220,
  "mood": "2-4 word mood description e.g. Melancholic and dreamy",
  "description": "one sentence about the song"
}

Rules:
- Only include real, well-known songs
- Be accurate about key, time signature, and BPM
- Return ONLY the JSON array, no markdown, no explanation`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ARRANGEMENT BLUEPRINT (canonical melody + chords + distribution)
//    ONE call up front. Its melody/chords become the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────
export function buildBlueprintPrompt({
  songTitle, songArtist, songGenre, songNotes,
  instruments, style, density, key, timeSignature, bpm, measures,
}) {
  const instrList = instruments
    .map((i) => `${i.name}${i.count > 1 ? ` (×${i.count})` : ""}`)
    .join(", ");

  const sectionSize = Math.max(4, Math.floor(measures / 4));
  const sections = [];
  for (let m = 1; m <= measures; m += sectionSize) {
    const end = Math.min(m + sectionSize - 1, measures);
    sections.push(`mm.${m}-${end}`);
  }

  return `You are a professional orchestrator. FIRST write the actual main melody of the song, THEN plan how it travels through the ensemble.

SONG: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
${songNotes ? `NOTES: ${songNotes}` : ""}
KEY: ${key} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density}
TOTAL MEASURES: ${measures}
SECTIONS: ${sections.join(", ")}
INSTRUMENTS: ${instrList}

Return ONLY a JSON object with this exact structure:
{
  "melodyAbc": "the real, recognizable main melody as ABC note text — ONE single line, NO line breaks, NO headers, concert pitch, L:1/8 lengths (C4=half C2=quarter C=eighth), exactly ${measures} measures separated by | and ending with |]",
  "chords": ["${measures} chord symbols, one per measure, e.g. C, G, Am, F"],
  "melodySummary": "2-sentence description of how the melody moves through the ensemble",
  "sections": [
    {
      "label": "section name e.g. Intro / Verse A / Chorus / Bridge",
      "measures": "e.g. mm.1-8",
      "melodyCarrier": "instrument name that carries the main melody",
      "countermelody": "instrument name for countermelody, or null",
      "harmony": ["list", "of", "instruments", "on", "harmonic", "support"],
      "bass": "instrument name for bass line",
      "rhythm": "instrument name for rhythmic support, or null",
      "rests": ["instruments", "tacet", "here"],
      "notes": "brief instruction for the melody carrier e.g. sing out the main theme, dolce e legato"
    }
  ],
  "instrumentRoles": {
    "InstrumentName": {
      "primaryRole": "melody|countermelody|harmony|bass|rhythm|color",
      "melodySections": ["mm.1-8","mm.17-24"],
      "instruction": "specific playing instruction for the whole piece"
    }
  }
}

Rules:
- melodyAbc is the CANONICAL tune EVERY melody-carrying instrument will play — it must be real and recognizable, exactly ${measures} measures, and fit the chords array
- Each measure of melodyAbc MUST contain note durations that sum to a full ${timeSignature} measure — no short or overfull measures
- chords array length MUST equal ${measures}
- melodyAbc MUST be a single line with NO raw line breaks (so the JSON stays valid)
- melodySections lists only the measures where this instrument has THE MAIN MELODY
- Pass the melody between instruments at section boundaries so it is always present in exactly ONE voice
- The union of every instrument's melodySections MUST cover all ${measures} measures with no gaps and no measure carried by two instruments at once
- Bass instruments (Tuba, Double Bass, Bass Guitar, Cello, Bassoon, Trombone) must always be bass or harmony, never melody
- Percussion instruments must be rhythm or color, never melody
- Every instrument must appear in instrumentRoles
- Return ONLY the JSON, no markdown, no explanation`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PER-INSTRUMENT PART
//    Receives the canonical melody + chords. For measures this part carries the
//    melody, we inject the EXACT per-measure notes so it reproduces the tune
//    faithfully instead of reinventing it.
// ─────────────────────────────────────────────────────────────────────────────
export function buildPartPrompt({
  songTitle, songArtist, songGenre, songNotes,
  instrName, style, density, tempoFeel, key, timeSignature, bpm, measures,
  otherInstruments, role, melodyAbc, chords,
}) {
  const { clef } = getMeta(instrName);
  const melodySections = role?.melodySections || [];
  const hasMelody = melodySections.length > 0;

  // Per-measure exact notes for the measures THIS part must play as melody.
  const excerpts = hasMelody ? buildMelodyExcerpts(melodyAbc, melodySections) : "";

  const roleBlock = buildRoleInstruction(instrName, role);

  const sharedContext = melodyAbc
    ? `
SHARED ARRANGEMENT REFERENCE (every part is built from this — do not contradict it):
MAIN MELODY (key of ${key}, ${timeSignature}, concert pitch, L:1/8):
${melodyAbc}
CHORDS (one per measure): ${Array.isArray(chords) ? chords.join(" | ") : chords || ""}

USING THE REFERENCE:
- In measures where YOU carry the melody, play THE EXACT MELODY shown below transposed only as needed to sit in your instrument's range — keep every pitch and rhythm recognizable (light ornamentation OK), do NOT substitute a different tune.
- In all other measures, harmonize with the chords and stay register-clear of the melody (sit below it), using longer notes and space so the tune sings through.
`
    : "";

  const excerptBlock = excerpts
    ? `
EXACT MELODY YOU MUST PLAY (reproduce these pitches/rhythms, transposed only to fit your range):
${excerpts}
Each "measure N" above must appear as that same measure number in your output, melody intact.
`
    : "";

  return `You are a professional music engraver. Output ONLY valid ABC notation for the ${instrName} part.

SONG: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
${songNotes ? `NOTES: ${songNotes}` : ""}
KEY: ${key} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density} | FEEL: ${tempoFeel}
FULL ENSEMBLE: ${otherInstruments}
TOTAL MEASURES: ${measures}
${sharedContext}${excerptBlock}
${roleBlock}

CRITICAL MELODY RULE: When this instrument has the melody, those measures MUST match the exact melody notes given above (transposed to range), clear and singable in the upper register, marked !mf! or !f!. When it does not, stay out of the melody register entirely — sit lower, use longer note values, and leave space.

ABC NOTATION RULES:
- Start: X:1
- T:${instrName}
- M:${timeSignature}
- L:1/8
- Q:1/4=${bpm}
- K:${key} clef=${clef}
- Write exactly ${measures} measures, barlines |, end with |]
- Every measure's note durations MUST sum to a full ${timeSignature} measure
- Note durations as multiples of L (C4=half, C2=quarter, C=eighth, C/2=sixteenth)
- Dynamics: !p! !mp! !mf! !f! !ff! placed before a note
- Slurs: (notes), ties: note-note
- Stay in idiomatic range for ${instrName}
- NO markdown, NO backticks, NO explanations — raw ABC only, starting with X:1`;
}

// Build the role instruction text from a blueprint role + sections.
// (Mirrors the prototype's getRoleInstruction, server-side.)
function buildRoleInstruction(instrName, role) {
  if (!role) return `ROLE: independent voice appropriate for ${instrName}`;

  const lines = ["ROLE ASSIGNMENT (follow precisely):"];
  lines.push(`Primary role: ${role.primaryRole}`);
  if (role.melodySections?.length > 0) {
    lines.push(
      `YOU carry the MAIN MELODY in: ${role.melodySections.join(", ")} — play the exact melody for those measures (transposed to your range), marked !mf! or !f!, clear and singable in the upper part of your range`,
    );
  } else {
    lines.push(
      "You do NOT carry the main melody at any point — stay subordinate, use longer note values, leave the upper register clear",
    );
  }
  if (role.instruction) lines.push(`Style note: ${role.instruction}`);
  return lines.join("\n");
}

// Re-export for any caller that wants raw slices.
export { sliceMelody, splitMelodyIntoMeasures };
