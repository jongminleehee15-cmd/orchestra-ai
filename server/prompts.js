import { getMeta } from "./lib/instrMeta.js";
import { buildMelodyExcerpts, sliceMelody, splitMelodyIntoMeasures } from "./lib/abcMelody.js";
import { writtenKeyFor, conventionalKey } from "./lib/transpose.js";
import { writtenRangeInfo } from "./lib/ranges.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. SONG SEARCH
// ─────────────────────────────────────────────────────────────────────────────
export function buildSearchPrompt(query) {
  return `You are a music knowledge database with web search access. The user searched for: "${query}"

If the song is recent, obscure, or you are not fully certain of its key/time signature/BPM, use web search to verify before answering — accuracy matters more than speed. For songs you know with certainty, answer directly without searching.

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
// 1b. SONG GROUND TRUTH (web-search research pass)
//     Runs BEFORE the blueprint with the web_search tool enabled. Looks up the
//     song on open chord/tab repositories so the blueprint works from verified
//     key/chords/structure instead of the model's memory of the tune.
// ─────────────────────────────────────────────────────────────────────────────
export function buildGroundTruthPrompt({ songTitle, songArtist, key, timeSignature, bpm }) {
  return `You are a music researcher with web search access. Research the song "${songTitle}"${songArtist ? ` by ${songArtist}` : ""} and extract its REAL, documented musical structure.

Search open, user-contributed chord and tab repositories (Ultimate Guitar, e-chords, Chordify, AZChords, hooktheory, public ABC/folk tune databases) plus reliable references (Wikipedia, songbook listings). Prefer highly-rated/verified versions when sources disagree.

The app currently believes: key ${key || "unknown"}, time ${timeSignature || "unknown"}, ${bpm || "unknown"} BPM — verify or correct these.

Return ONLY a JSON object (no markdown, no prose) with exactly these fields:
{
  "found": true/false — false if you could not find reliable data for this exact song,
  "key": "the documented original key, e.g. C, G, F#m",
  "timeSignature": "e.g. 4/4, 3/4, 6/8",
  "bpm": number,
  "structure": ["ordered section list, e.g. Intro", "Verse", "Chorus", "Verse", "Chorus", "Bridge", "Chorus"],
  "chordProgressions": { "Verse": ["C", "G", "Am", "F"], "Chorus": ["F", "C", "G", "C"] } — one chord per bar as documented, keyed by section name,
  "melodyNotes": "concise factual notes on the melody itself: which section it starts in, pickup/anacrusis, characteristic rhythm (e.g. 'verse melody moves in eighth notes, dotted figure at phrase ends'), range, any documented riffs/hooks. Empty string if nothing found.",
  "confidence": "high|medium|low — how well the sources agree",
  "sources": ["url1", "url2"]
}

Rules:
- Report what the sources actually say — do NOT fill gaps from memory. If sources are missing or contradictory, lower confidence or set found=false.
- chordProgressions must contain real chord symbols in the documented key (transposing to the app's key happens later — do NOT transpose).
- Keep the whole response under 400 words. Return ONLY the JSON.`;
}

// Render verified web data as a prompt block. Returns "" when there's nothing usable.
export function groundTruthBlock(gt) {
  if (!gt || gt.found === false) return "";
  const progs = gt.chordProgressions && typeof gt.chordProgressions === "object"
    ? Object.entries(gt.chordProgressions)
      .map(([sec, chords]) => `  ${sec}: ${Array.isArray(chords) ? chords.join(" ") : chords}`)
      .join("\n")
    : "";
  return `
VERIFIED SONG DATA (researched from public chord/tab sources — confidence: ${gt.confidence || "unknown"}. Treat as authoritative over your memory):
- Documented key: ${gt.key || "n/a"} | time: ${gt.timeSignature || "n/a"} | ~${gt.bpm || "n/a"} BPM
- Song structure: ${Array.isArray(gt.structure) ? gt.structure.join(" → ") : "n/a"}
- Chord progressions (per bar, in the documented key — transpose to the arrangement key as needed):
${progs || "  n/a"}
${gt.melodyNotes ? `- Melody facts: ${gt.melodyNotes}` : ""}
Base your chords and melody on this data. Where the arrangement key differs from the documented key, transpose the progressions; keep the harmonic functions identical.
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ARRANGEMENT BLUEPRINT (canonical melody + chords + distribution)
//    ONE call up front. Its melody/chords become the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────
export function buildBlueprintPrompt({
  songTitle, songArtist, songGenre, songNotes,
  instruments, style, density, key, timeSignature, bpm, measures,
  groundTruth,
}) {
  const instrList = instruments
    .map((i) => `${i.name}${i.count > 1 ? ` (×${i.count})` : ""}`)
    .join(", ");

  // Anchor the whole arrangement to a conventional, low-accidental concert key.
  key = conventionalKey(key);

  // Hand the melody off at PHRASE boundaries (>= 4 bars) so each carrier plays a
  // coherent, recognizable chunk of the tune — not choppy 2-bar fragments — while
  // still spreading it across as many instruments as the length allows.
  const voiceCount = instruments.length || 1;
  const [tsNum, tsDen] = String(timeSignature || "4/4").split("/").map((n) => parseInt(n, 10));
  const barUnits = (tsNum || 4) * 8 / (tsDen || 4);
  const targetSections = Math.max(1, Math.min(voiceCount, Math.floor(measures / 4)));
  const sectionSize = Math.max(4, Math.round(measures / Math.max(1, targetSections)));
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
${groundTruthBlock(groundTruth)}
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
- Each measure of melodyAbc MUST sum to a full ${timeSignature} bar = ${barUnits} eighth-note units (eighth=1, quarter=2, dotted-quarter=3, half=4, dotted-half=6, whole=8). Use the REAL note values of the song — INCLUDING eighth notes (length 1) and dotted rhythms wherever the actual tune has them (faster turns/runs, pickups, dotted phrase-endings like "E3 D1 D4"). Do NOT flatten an active passage into equal quarter notes, do NOT replace it with a long held/whole note, and do NOT double every value (writing halves where the tune moves in quarters)
- chords array length MUST equal ${measures}
- melodyAbc MUST be a single line with NO raw line breaks (so the JSON stays valid)
- melodySections lists only the measures where this instrument has THE MAIN MELODY
- Pass the melody between instruments at section boundaries so it is always present in exactly ONE voice
- The union of every instrument's melodySections MUST cover all ${measures} measures with no gaps and no measure carried by two instruments at once
- SPREAD THE MELODY EVENLY across ALL instruments. Low instruments (Trombone, Tuba, Cello, Bassoon, Double Bass, Bass Guitar) and pitched/mallet percussion (Xylophone, Marimba, Vibraphone, Glockenspiel) CAN and SHOULD take the main melody or a prominent countermelody in some sections — feature them, do not lock them onto a bass/harmony line for the whole piece
- Aim for a roughly EQUAL share of melody per instrument: with ${sections.length} sections and ${voiceCount} instruments, give each instrument about ${Math.max(1, Math.round(sections.length / voiceCount))} melody section(s), and always hand the tune to an instrument that has NOT recently had it. When measures are few, still rotate so as many different instruments as possible get a turn
- When a low/bass instrument takes the melody, move the bass line to a different low voice (or lighten it) for those measures so the harmony stays grounded
- NO instrument may play the same repeated figure (e.g. steady quarter-note roots) for the whole piece — give every part varied, evolving material even when accompanying. Only truly unpitched percussion (Timpani, drum kit) stays purely rhythmic
- Every instrument must appear in instrumentRoles
- DISTINCT VOICES: when two players share an instrument (e.g. "Trumpet 1" and "Trumpet 2", "Violin 1" and "Violin 2"), give them DIFFERENT roles and DIFFERENT material — one leads or takes the melody while the other harmonizes (a 3rd or 6th below) or plays a countermelody. NEVER assign both players the identical line.
- DEVELOP, don't restate: vary the texture from section to section, hand the melody to a different instrument at each section boundary, and add countermelody plus moving inner voices. When a section repeats, treat it differently the second time (fuller scoring, an added counterline, or re-voiced harmony) — not an identical copy.
- Plan a dynamic arc across the whole piece (build toward a high point, then resolve) and describe it in melodySummary.
- Return ONLY the JSON, no markdown, no explanation`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. LIBRARY BLUEPRINT (orchestration plan ONLY — melody is given, verbatim)
//     For public-domain works from data/scores the melody and chords are REAL
//     symbolic data. The model never writes or "corrects" notes here; it only
//     decides how the given tune travels through the ensemble.
// ─────────────────────────────────────────────────────────────────────────────
export function buildLibraryBlueprintPrompt({
  songTitle, songArtist, songGenre,
  instruments, style, density, key, timeSignature, bpm, measures,
  melodyAbc, chords,
}) {
  const instrList = instruments
    .map((i) => `${i.name}${i.count > 1 ? ` (×${i.count})` : ""}`)
    .join(", ");
  const voiceCount = instruments.length || 1;
  const targetSections = Math.max(1, Math.min(voiceCount, Math.floor(measures / 4)));
  const sectionSize = Math.max(4, Math.round(measures / Math.max(1, targetSections)));
  const sections = [];
  for (let m = 1; m <= measures; m += sectionSize) {
    sections.push(`mm.${m}-${Math.min(m + sectionSize - 1, measures)}`);
  }
  const measureList = splitMelodyIntoMeasures(melodyAbc)
    .map((m, i) => `  measure ${i + 1}: ${m}   [${chords[i] || ""}]`)
    .join("\n");

  return `You are a professional orchestrator. The melody and chords below come from a verified public-domain score — they are EXACT and FINAL. Your job is ONLY to plan how this fixed tune travels through the ensemble. Do NOT write, alter, or "improve" any melody notes.

WORK: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
KEY: ${key} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density}
TOTAL MEASURES: ${measures}
SUGGESTED SECTION BOUNDARIES: ${sections.join(", ")} (you may adjust to phrase boundaries, but sections must be >= 4 measures where possible)
INSTRUMENTS: ${instrList}

THE MELODY (concert pitch, L:1/8) with its chord(s) per measure:
${measureList}

Return ONLY a JSON object with this exact structure:
{
  "melodySummary": "2-sentence description of how the melody moves through the ensemble and the dynamic arc of the arrangement",
  "sections": [
    {
      "label": "section name e.g. Phrase A / Phrase B",
      "measures": "e.g. mm.1-8",
      "melodyCarrier": "instrument name that carries the main melody",
      "countermelody": "instrument name for countermelody, or null",
      "harmony": ["instruments", "on", "harmonic", "support"],
      "bass": "instrument name for bass line",
      "rhythm": "instrument name for rhythmic support, or null",
      "rests": ["instruments", "tacet", "here"],
      "notes": "brief instruction for the melody carrier"
    }
  ],
  "instrumentRoles": {
    "InstrumentName": {
      "primaryRole": "melody|countermelody|harmony|bass|rhythm|color",
      "melodySections": ["mm.1-8"],
      "instruction": "specific playing instruction for the whole piece"
    }
  }
}

Rules:
- Every instrument must appear in instrumentRoles
- melodySections lists only the measures where that instrument has THE MAIN MELODY, and the union of all melodySections MUST cover all ${measures} measures with no gaps and no measure carried by two instruments at once
- Hand the melody between instruments at section boundaries; spread it EVENLY — low instruments and mallet percussion may carry it too, with the bass line moving elsewhere for those measures
- DISTINCT VOICES: players sharing an instrument (e.g. "Violin 1"/"Violin 2") get different roles/material, never the identical line
- Vary the texture from section to section and plan a dynamic arc (build to a high point, then resolve)
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
  // Long pieces are generated in sections: { start, end, prevTail } — write
  // ONLY piece measures start..end; prevTail is how the previous section ended.
  chunk = null,
}) {
  const writeCount = chunk ? chunk.end - chunk.start + 1 : measures;
  const { clef } = getMeta(instrName);
  // The arrangement is stored at concert pitch; work out the key THIS instrument
  // reads in (e.g. a Bb trumpet in a concert-Bb piece reads in C).
  const concertKey = conventionalKey(key);
  const { writtenKey, label, interval, transposes } = writtenKeyFor(key, instrName);
  const melodySections = role?.melodySections || [];
  const hasMelody = melodySections.length > 0;

  // Per-measure exact notes for the measures THIS part must play as melody.
  const excerpts = hasMelody ? buildMelodyExcerpts(melodyAbc, melodySections) : "";

  const roleBlock = buildRoleInstruction(instrName, role);

  // Arranging directives that fight the "flat, one bar repeated 8×" failure mode.
  const arrangingBlock = `ARRANGING — make this musical, not mechanical (important):
- Do NOT repeat the same bar or the same 2-bar cell over and over. When the harmony repeats, VARY your line the next time — add motion, change the rhythm, add or thin a countermelody, re-voice the chord, or shift octave.
- Shape a dynamic arc across each phrase (grow toward the cadence, ease afterwards); never a single flat dynamic for the whole part.
- Phrase in 2- and 4-bar arcs with direction toward cadence points; use anticipations, suspensions, and tasteful space.
- If another player shares your instrument (e.g. Trumpet 1 vs Trumpet 2), do NOT double them in unison — play a complementary voice (harmony a 3rd or 6th away, or a countermelody).`;

  // Realistic playable range, in the pitch this part is WRITTEN in. Generated
  // notes outside it are physically unplayable and get flagged by the server's
  // range validator, so state the limits explicitly up front.
  const range = writtenRangeInfo(instrName);
  const rangeBlock = range
    ? `PLAYABLE RANGE — hard physical limit for ${instrName}${transposes ? " (already converted to your WRITTEN pitch)" : ""}:
- Absolute range: ${range.lo.name} to ${range.hi.name} — in ABC: "${range.lo.abc}" up to "${range.hi.abc}". NEVER write any note (chord notes included) outside this.
- Comfortable core: ${range.comfortLo.name}–${range.comfortHi.name} (ABC "${range.comfortLo.abc}"–"${range.comfortHi.abc}") — keep most of the part here; touch the extremes only briefly at phrase peaks.
- If the melody or an accompaniment figure would leave this range, shift that passage by a whole octave to fit — never clip single notes.
- ABC octave reminder: middle C (C4) = "C"; "c" = C5, "c'" = C6, "C," = C3, "C,," = C2. Count the marks carefully.
`
    : "";

  // Transposing instruments read in a different key than concert pitch.
  const transposeBlock = transposes
    ? `TRANSPOSING INSTRUMENT — ${instrName} is a transposing instrument (${label}); the concert key is ${concertKey}:
- Write this WHOLE part in ${writtenKey} and put K:${writtenKey} in the header.
- Every pitch you write sounds ${interval.replace(/ up.*/, "")} LOWER than written, so transpose all notes (melody excerpts included) UP by ${interval} from the concert pitches in the reference. Keep shapes and rhythms identical — only the written pitch/key changes.
- Use the ${writtenKey} key signature and spell accidentals conventionally so the part is easy to read.
`
    : "";

  const sharedContext = melodyAbc
    ? `
SHARED ARRANGEMENT REFERENCE (every part is built from this — do not contradict it):
MAIN MELODY (concert key of ${concertKey}, ${timeSignature}, concert pitch, L:1/8):
${melodyAbc}
CHORDS (one per measure): ${Array.isArray(chords) ? chords.join(" | ") : chords || ""}

USING THE REFERENCE:
- In measures where YOU carry the melody, play THE EXACT MELODY shown below${transposes ? `, transposed ${interval} into your written key of ${writtenKey}` : ", transposed only as needed to sit in your instrument's range"} — keep every pitch and rhythm recognizable (light ornamentation OK), do NOT substitute a different tune.
- In all other measures, write a MOVING, idiomatic accompaniment from the chords — do NOT sit on static held roots. Use arpeggiation, stepwise or walking motion, a rhythmic or harmonic countermelody, passing tones and suspensions — while staying register-clear of the melody (sit below it) so the tune still sings through.
`
    : "";

  const excerptBlock = excerpts
    ? `
EXACT MELODY YOU MUST PLAY (${transposes ? `these are CONCERT pitches — rewrite each ${interval} into ${writtenKey}, keeping the shape and rhythm identical` : "reproduce these pitches/rhythms, transposed only to fit your range"}):
${excerpts}
${chunk
    ? `"measure N" above is a PIECE measure number — since this response starts at piece measure ${chunk.start}, piece measure N is measure N−${chunk.start - 1} of your output. Keep the melody intact${transposes ? ", transposed into your written key" : ""}.`
    : `Each "measure N" above must appear as that same measure number in your output, melody intact${transposes ? ", transposed into your written key" : ""}.`}
`
    : "";

  // Long pieces are written a section at a time — scope this response to its
  // measure window and hand over the previous section's tail for continuity.
  const chunkBlock = chunk
    ? `SECTION TO WRITE NOW — the piece is ${measures} measures long and is being written in sections:
- This response: ONLY piece measures ${chunk.start}–${chunk.end} — exactly ${writeCount} measures of music, nothing before or after.
- Your output's FIRST measure is piece measure ${chunk.start}. All measure numbers elsewhere in this prompt are PIECE measure numbers.
${chunk.prevTail ? `- Your part so far ends with (piece measure${chunk.start > 2 ? `s ${chunk.start - 2}–` : " "}${chunk.start - 1}): ${chunk.prevTail}
- Continue seamlessly from that ending — connect the voice-leading and register, don't restart the figuration from scratch.` : "- This is the OPENING section of the part."}
- Still output a complete ABC tune (X:1 through K: headers, then the ${writeCount} measures, ending with |]).
`
    : "";

  return `You are a professional music engraver. Output ONLY valid ABC notation for the ${instrName} part.

SONG: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
${songNotes ? `NOTES: ${songNotes}` : ""}
KEY: concert ${concertKey}${transposes ? ` — you READ in ${writtenKey} (${label})` : ""} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density} | FEEL: ${tempoFeel}
FULL ENSEMBLE: ${otherInstruments}
TOTAL MEASURES: ${measures}
${chunkBlock}${sharedContext}${excerptBlock}
${roleBlock}

${arrangingBlock}

${transposeBlock}
${rangeBlock}
CRITICAL MELODY RULE: When this instrument has the melody, those measures MUST match the exact melody PITCHES and RHYTHMS given above (${transposes ? `transposed ${interval} into ${writtenKey}` : "transposed to range"}), clear and singable in the upper register. Keep the tune exact, but you MAY vary dynamics and articulation between repeated statements so it stays expressive. When it does NOT have the melody, stay out of the melody register — sit lower and play the moving accompaniment described above, never a static drone.

ABC NOTATION RULES:
- Start: X:1
- T:${instrName}${label ? ` (${label})` : ""}
- M:${timeSignature}
- L:1/8
- Q:1/4=${bpm}
- K:${writtenKey} clef=${clef}
- Write the ENTIRE part in ${writtenKey}${transposes ? ` — this is the ${label} written key, NOT concert ${concertKey}` : ""}
- Write exactly ${writeCount} measures${chunk ? ` (piece measures ${chunk.start}–${chunk.end})` : ""}, barlines |, end with |]
- Every measure's note durations MUST sum to a full ${timeSignature} measure
- Note durations as multiples of L (C4=half, C2=quarter, C=eighth, C/2=sixteenth)
- Dynamics: !p! !mp! !mf! !f! !ff! placed before a note
- Slurs: (notes), ties: note-note
- Every note must sit inside the PLAYABLE RANGE stated above — re-check your extremes before finishing
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
      "You do NOT carry the main melody here — stay out of the melody's register (sit lower) and leave it clear, but keep your OWN line moving and musical (a countermelody, arpeggios, walking motion), never a static repeated figure",
    );
  }
  if (role.instruction) lines.push(`Style note: ${role.instruction}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MELODY VERIFICATION (accuracy pass)
//    Second, focused call: re-check the transcription against the REAL song and
//    fix wrong pitches + malformed rhythms before it becomes the canonical tune.
// ─────────────────────────────────────────────────────────────────────────────
export function buildMelodyCheckPrompt({
  songTitle, songArtist, key, timeSignature, measures, melodyAbc, problems, groundTruth,
}) {
  const ts = timeSignature || "4/4";
  const [num, den] = String(ts).split("/").map((n) => parseInt(n, 10));
  const barUnits = (num || 4) * 8 / (den || 4);
  const problemBlock = problems && problems.length
    ? `\nAUTOMATICALLY-DETECTED PROBLEMS YOU MUST FIX:\n- ${problems.join("\n- ")}\n`
    : "";

  return `You are a meticulous music editor. Below is an ABC transcription of the MAIN MELODY of "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}, in the key of ${key}, ${ts}, written with L:1/8, and it must be EXACTLY ${measures} measures at concert pitch.

MELODY TO CHECK (single line):
${melodyAbc}
${groundTruthBlock(groundTruth)}${problemBlock}
Produce a corrected melody where ALL of these hold:
1. PITCH — Compare against the actual, well-known melody of this song and fix any wrong pitches so the tune is recognizably correct. Stay in ${key}, concert pitch, same overall contour and length.
2. RHYTHM — Every bar MUST sum to exactly one ${ts} measure = ${barUnits} eighth-note units. With L:1/8: eighth=1 ("C"), quarter=2 ("C2"), dotted-quarter=3 ("C3"), half=4 ("C4"), dotted-half=6 ("C6"), whole=8 ("C8"). Fix BOTH of these: (a) if the whole line looks DOUBLED (halves where the tune moves in quarters), halve every duration; (b) RESTORE the song's characteristic shorter/faster notes — real EIGHTH-note runs and turns (length 1, e.g. "E F" not "E2 F2") and dotted figures — that were wrongly flattened into equal quarter notes or replaced by long held/whole notes. Match the tune's actual rhythm, not a simplified version.
3. LENGTH — EXACTLY ${measures} measures separated by | and ending with |].
4. FORMAT — ONE single line, concert pitch, NO headers (no X:/T:/K:/M:/L:), NO line breaks, NO markdown, NO commentary.

Return ONLY the corrected ABC melody line — nothing else.`;
}

// Re-export for any caller that wants raw slices.
export { sliceMelody, splitMelodyIntoMeasures };
