import { buildMelodyExcerpts, sliceMelody, splitMelodyIntoMeasures, barUnitsFor } from "./lib/abcMelody.js";
import { writtenKeyFor, conventionalKey, writtenChordsFor } from "./lib/transpose.js";
import { writtenRangeInfo } from "./lib/ranges.js";
import { styleBlock } from "./lib/styles.js";
import { suggestedSections } from "./lib/planCheck.js";
import { renderEnsembleContext } from "./lib/ensemble.js";

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
  const sections = suggestedSections(measures, voiceCount).map((s) => `mm.${s.start}-${s.end}`);

  return `You are a professional orchestrator. FIRST write the actual main melody of the song, THEN plan how it travels through the ensemble.

SONG: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
${songNotes ? `NOTES: ${songNotes}` : ""}
KEY: ${key} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density}
TOTAL MEASURES: ${measures}
SECTIONS: ${sections.join(", ")}
INSTRUMENTS: ${instrList}
${groundTruthBlock(groundTruth)}
${styleBlock(style, density)}The STYLE and DENSITY directives shape the ORCHESTRATION — section plans, role assignments, and every "instruction"/"notes" field must concretely reflect them. The melodyAbc itself stays the song's REAL tune regardless of style.

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
- DYNAMIC BALANCE: whenever a section's "notes" or an instrument's "instruction" names a dynamic level (p, mp, mf, f, ff…), the melody carrier's dynamic for that passage must be AT LEAST as loud as every other instrument sounding at the same time — never write a hushed melody carrier ("!p!") alongside an accompaniment/harmony instruction implying anything louder. If a passage should be quiet overall, say so for EVERY instrument in it together, not just the melody carrier alone.
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
  const sections = suggestedSections(measures, voiceCount).map((s) => `mm.${s.start}-${s.end}`);
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

${styleBlock(style, density)}The STYLE and DENSITY directives shape the ORCHESTRATION — section plans, roles, and every "instruction"/"notes" field must concretely reflect them. The melody notes stay exactly as given.

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
- DYNAMIC BALANCE: whenever a section's "notes" or an instrument's "instruction" names a dynamic level (p, mp, mf, f, ff…), the melody carrier's dynamic for that passage must be AT LEAST as loud as every other instrument sounding at the same time — never write a hushed melody carrier ("!p!") alongside an accompaniment/harmony instruction implying anything louder. If a passage should be quiet overall, say so for EVERY instrument in it together, not just the melody carrier alone.
- Return ONLY the JSON, no markdown, no explanation`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2c. LIBRARY MELODY EXTENSION
//     Library works carry only the tune's literal statement (often 8-16
//     measures). When the user requests a longer arrangement, the app must
//     reach that length through legitimate arrangement technique — repetition
//     with variation, development, modulation, intro/outro material — rather
//     than truncating the request down to the source melody's length. The
//     literal theme (measures 1..themeMeasures.length) is never altered; this
//     prompt only asks for the ADDITIONAL measures that follow it.
// ─────────────────────────────────────────────────────────────────────────────
export function buildLibraryExtensionPrompt({
  songTitle, songArtist, key, timeSignature, bpm, style, density,
  themeMelodyAbc, themeChords, extraMeasures, isFinalSection,
}) {
  const themeList = splitMelodyIntoMeasures(themeMelodyAbc)
    .map((m, i) => `  measure ${i + 1}: ${m}   [${themeChords[i] || ""}]`)
    .join("\n");

  return `You are a professional arranger. Below is the EXACT, real theme of "${songTitle}"${songArtist ? ` by ${songArtist}` : ""} — verified public-domain melody data, not to be altered.

KEY: ${key} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density}

THE THEME (concert pitch, L:1/8), exact notes and chords:
${themeList}

The user asked for a longer arrangement than the theme's literal length. Your job: compose exactly ${extraMeasures} ADDITIONAL measures that continue directly after the theme above, using legitimate arrangement technique — NOT a verbatim copy-paste repeat. Use real developmental variation: melodic sequence, rhythmic diminution/augmentation, a countermelody-led restatement, a key change (e.g. to the relative or dominant) with a return, a written-out ornamented repeat, or new but idiomatic transition/interlude material that still clearly belongs to the same piece. The result must still sound like an arrangement of THIS song, not a different tune.
${isFinalSection ? "This is the LAST section — end with a clear, satisfying cadence in the home key." : "This is not the final section — end on a chord/note that can lead onward, not necessarily a final cadence."}

Return ONLY a JSON object:
{
  "melodyAbc": "the ${extraMeasures} ADDITIONAL measures only (do not repeat the theme measures above) as ABC note text, ONE single line, NO line breaks, NO headers, concert pitch, L:1/8 lengths, exactly ${extraMeasures} measures separated by | and ending with |]",
  "chords": ["${extraMeasures} chord symbols, one per measure"]
}

Rules:
- Each measure MUST sum to a full ${timeSignature} bar in L:1/8 units (eighth=1, quarter=2, dotted-quarter=3, half=4, dotted-half=6, whole=8)
- chords array length MUST equal ${extraMeasures}
- melodyAbc MUST be a single line with NO raw line breaks (so the JSON stays valid) and NO barline before the first measure
- Return ONLY the JSON, no markdown, no explanation`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2d. HARMONIZATION (external works only)
//     Tunes from public archives arrive as melody-only ABC. The melody is
//     verified data and stays untouched; this call ONLY assigns one chord per
//     measure so the arrangement pipeline (which assumes per-bar chords) works.
// ─────────────────────────────────────────────────────────────────────────────
export function buildHarmonizePrompt({ songTitle, key, timeSignature, melodyAbc, measures }) {
  const list = splitMelodyIntoMeasures(melodyAbc)
    .map((m, i) => `  measure ${i + 1}: ${m}`)
    .join("\n");

  return `You are a harmony expert. Below is the EXACT melody of "${songTitle}" (key ${key}, ${timeSignature}, L:1/8) — ${measures} measures of verified score data. The notes are final; do NOT alter or comment on them.

${list}

Assign ONE chord symbol per measure that harmonizes this melody idiomatically in ${key} — functional, natural progressions that fit the melody notes of each bar. If the harmony truly moves mid-bar you may write two symbols separated by a space (e.g. "G D"), but prefer one per bar.

Return ONLY a JSON object: { "chords": ["${measures} chord symbols, one per measure"] }
Rules:
- chords array length MUST equal ${measures}
- Plain symbols only: C, G7, Am, Dm7, F#m, Bb…
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
  // Parts already finished ([{ instrName, abc }]) and the plan's roles, so
  // this part is written hearing the others. Absent → the prompt is unchanged.
  contextParts = null, instrumentRoles = null,
}) {
  const writeCount = chunk ? chunk.end - chunk.start + 1 : measures;
  // The arrangement is stored at concert pitch; work out the key THIS instrument
  // reads in (e.g. a Bb trumpet in a concert-Bb piece reads in C).
  const concertKey = conventionalKey(key);
  const { writtenKey, label, interval, transposes } = writtenKeyFor(key, instrName);
  // The model returns bare measures; the ABC header (including clef) is built
  // server-side in index.js, so nothing here needs the clef any more.
  const barUnits = barUnitsFor(timeSignature);
  // A shape example that actually adds up IN THIS METER — showing a 4/4
  // example to a 3/4 part would be demonstrating a wrong-length bar.
  const halfBar = barUnits / 2;
  const exampleMeasures = Number.isInteger(halfBar)
    ? `["!mf!C${halfBar} E${halfBar}", "G${barUnits}"]`
    : `["!mf!C${barUnits}", "G${barUnits}"]`;
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
  // Drop only the word "up", keeping any note after it: the Tenor Sax's
  // "(an octave-and-a-tone in sound)" is what tells the model about the octave.
  const intervalName = transposes ? interval.replace(/ up\b/, "") : "";
  const transposeBlock = transposes
    ? `TRANSPOSING INSTRUMENT — ${instrName} is a transposing instrument (${label}); the concert key is ${concertKey}:
- Write every pitch of this part in ${writtenKey}. (The K:${writtenKey} key signature is attached for you — you write only the notes.)
- Every pitch you write sounds ${intervalName} LOWER than written. The MAIN MELODY and the melody excerpts are at CONCERT pitch: transpose each of those notes UP by ${intervalName}. Keep shapes and rhythms identical — only the written pitch/key changes.
- The CHORDS are ALREADY in your written key of ${writtenKey} (transposed for you). Build your accompaniment directly from them and do NOT transpose them again.
- Use the ${writtenKey} key signature and spell accidentals conventionally so the part is easy to read.
`
    : "";

  const sharedContext = melodyAbc
    ? `
SHARED ARRANGEMENT REFERENCE (every part is built from this — do not contradict it):
MAIN MELODY (concert key of ${concertKey}, ${timeSignature}, concert pitch, L:1/8):
${melodyAbc}
${transposes
    // Transposing parts get the chords in WRITTEN pitch, converted in code
    // (transpose.js), instead of transposing concert symbols in their head.
    // A chord list that isn't an array is transposed too (as one string), so
    // the "ALREADY transposed" label is never put on concert chords.
    ? `CHORDS AS YOU READ THEM (one per measure, ALREADY transposed into your written key of ${writtenKey}; do NOT transpose them again): ${Array.isArray(chords) ? writtenChordsFor(chords, key, instrName).join(" | ") : writtenChordsFor([String(chords || "")], key, instrName)[0]}`
    : `CHORDS (one per measure): ${Array.isArray(chords) ? chords.join(" | ") : chords || ""}`}

USING THE REFERENCE:
- In measures where YOU carry the melody, play THE EXACT MELODY shown below${transposes ? `, transposed ${interval} into your written key of ${writtenKey}` : ", transposed only as needed to sit in your instrument's range"} — keep every pitch and rhythm recognizable (light ornamentation OK), do NOT substitute a different tune.
- In all other measures, write a MOVING, idiomatic accompaniment from the chords — do NOT sit on static held roots. Use arpeggiation, stepwise or walking motion, a rhythmic or harmonic countermelody, passing tones and suspensions — while staying register-clear of the melody so the tune still sings through: sit BELOW it, or ABOVE it when your instrument's range lies over the melody (flute, piccolo, violin, mallet percussion…). NEVER go outside your playable range just to get clear of the melody.
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
- Return exactly ${writeCount} measure strings for THIS section only — not the whole piece.
`
    : "";

  // The parts already written, bar by bar at SOUNDING pitch, so this part is
  // composed against what the others actually play rather than blind to it.
  const ensembleGrid = renderEnsembleContext({
    contextParts, forInstr: instrName, instrumentRoles, melodyAbc,
    concertKey: key, timeSignature,
    from: chunk ? chunk.start : 1, to: chunk ? chunk.end : measures,
  });
  const ensembleBlock = ensembleGrid
    ? `
ENSEMBLE SO FAR — the parts already written, bar by bar, as they SOUND (concert pitch; C4 = middle C; lengths: s sixteenth, e eighth, q quarter, h half, w whole, "." dotted):
${ensembleGrid}

Write your part to sound WITH these:
- Against the MELODY, do not move in 2nds, major 7ths or minor 9ths with it (a brief passing note is fine); prefer 3rds, 6ths, octaves and contrary motion.
- Do not copy another part's line; fill the registers and rhythms the others leave open, and answer them rather than collide.
- These are SOUNDING pitches. Your own notes are still written exactly as instructed in this prompt${transposes ? `: in ${writtenKey}, ${interval.replace(/ up.*/, "")} above how they sound` : ""}.
`
    : "";

  return `You are a professional music engraver. Output ONLY valid ABC notation for the ${instrName} part.

SONG: "${songTitle}"${songArtist ? ` by ${songArtist}` : ""}${songGenre ? ` (${songGenre})` : ""}
${songNotes ? `NOTES: ${songNotes}` : ""}
KEY: concert ${concertKey}${transposes ? ` — you READ in ${writtenKey} (${label})` : ""} | TIME: ${timeSignature} | TEMPO: ${bpm} BPM | STYLE: ${style} | DENSITY: ${density} | FEEL: ${tempoFeel}
FULL ENSEMBLE: ${otherInstruments}
TOTAL MEASURES: ${measures}
${chunkBlock}${sharedContext}${excerptBlock}${ensembleBlock}
${roleBlock}

${arrangingBlock}

${styleBlock(style, density)}
${transposeBlock}
${rangeBlock}
CRITICAL MELODY RULE: When this instrument has the melody, those measures MUST match the exact melody PITCHES and RHYTHMS given above (${transposes ? `transposed ${interval} into ${writtenKey}` : "transposed to range"}), clear and singable in the upper register. Keep the tune exact, but you MAY vary dynamics and articulation between repeated statements so it stays expressive. When it does NOT have the melody, stay out of the melody register — sit lower (or higher, for instruments whose range is above the tune), remain inside your playable range, and play the moving accompaniment described above, never a static drone.

OUTPUT FORMAT — return ONLY this JSON object and nothing else:
{"measures": ["<measure 1>", "<measure 2>", ...]}

- The array MUST hold EXACTLY ${writeCount} strings, one per measure${chunk ? ` (piece measures ${chunk.start}–${chunk.end})` : ""}. The array's length IS the part's length, so count them before you answer.
- Each string is ONE measure of ABC note text and nothing else. Do NOT write barlines (| or |]), headers (X: T: M: L: Q: K:), measure numbers, or "chord symbol" annotations — the header and barlines are attached automatically.
- Note lengths are in L:1/8 units: C = eighth, C2 = quarter, C3 = dotted quarter, C4 = half, C6 = dotted half, C8 = whole, C/2 = sixteenth. A rest is z (z4 = half rest).
- EVERY measure MUST total EXACTLY ${barUnits} of those units — a full ${timeSignature} bar. Add up each bar before moving to the next: a bar that is short or overfull pushes this part out of time with the entire ensemble and is the single most damaging mistake you can make here.
- Write every pitch in ${writtenKey}${transposes ? ` — the ${String(label).replace(/^in /, "")} written key, NOT concert ${concertKey}` : ""}.
- Dynamics: !p! !mp! !mf! !f! !ff! immediately before a note. Slurs: (notes). Ties: note-note.
- Every note must sit inside the PLAYABLE RANGE stated above — re-check your extremes before finishing.
- NO markdown, NO backticks, NO commentary — just the JSON object.

Example shape for a 2-measure ${timeSignature} answer: {"measures": ${exampleMeasures}}`;
}

// Build the role instruction text from a blueprint role + sections.
// (Mirrors the prototype's getRoleInstruction, server-side.)
function buildRoleInstruction(instrName, role) {
  if (!role) return `ROLE: independent voice appropriate for ${instrName}`;

  const lines = ["ROLE ASSIGNMENT (follow precisely):"];
  lines.push(`Primary role: ${role.primaryRole}`);
  if (role.melodySections?.length > 0) {
    lines.push(
      `YOU carry the MAIN MELODY in: ${role.melodySections.join(", ")} — play the exact melody for those measures (transposed to your range), clear and singable in the upper part of your range. Default to marked !mf! or !f! there UNLESS the Style note below explicitly calls for something quieter (e.g. a hushed opening) — either way, your dynamic in those measures is the LOUDEST voice sounding: never mark yourself quieter than the accompaniment underneath you, even in a soft passage.`,
    );
  } else {
    lines.push(
      "You do NOT carry the main melody here — stay out of the melody's register (below it, or above it if your instrument lives higher than the tune) and leave it clear, but keep your OWN line moving and musical (a countermelody, arpeggios, walking motion), never a static repeated figure. Staying inside your playable range ALWAYS beats staying out of the melody's way. DYNAMICS: mark yourself AT OR BELOW the melody carrier's dynamic for these measures — never louder than the tune, even in a full/loud passage.",
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
