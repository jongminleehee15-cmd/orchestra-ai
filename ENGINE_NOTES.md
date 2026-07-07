# ENGINE_NOTES — musical judgment calls for review

This file records the musical decisions baked into the arrangement pipeline so
a musician can review and correct them. Code references are given per item.

## Score library (`data/scores/*.abc`)

**Core principle:** for library works the melody is REAL symbolic data consumed
verbatim — the LLM never writes, recalls, or "corrects" melody notes. It only
plans orchestration (who plays what, when). Enforced in `/api/blueprint`
(`server/index.js`): the plan's `melodyAbc` is overwritten with library data
unconditionally.

Curation rules for library files:
- **`L:1/8` mandatory.** The whole pipeline counts durations in eighth-note
  units (quarter = 2, dotted quarter = 3, half = 4…).
- **No anacrusis (pickup) in v1.** Every work starts on the downbeat, because
  measure indexing (melody sections "mm.1-8", per-measure chords, bar-sum
  validation) assumes measure 1 is full. Tunes like Amazing Grace and
  Greensleeves are excluded until pickup support exists. *(Correction wanted:
  a musician may prefer notating the pickup bar as bar 0 — that requires
  touching `abcMelody.js`, the prompts, and the frontend measure display.)*
- **Native key.** Each work is stored in its customary key (Ode to Joy in D,
  etc.). The arrangement locks to this key; there is no melody transposition
  in v1 (only the existing written-key handling for transposing instruments).
- **Chords are annotated per measure** with inline `"C"` strings. When the
  harmony moves inside a bar the annotation holds both chords (`"G C"`).
  These are my (AI) harmonizations of well-known progressions — reasonable,
  but exactly the kind of thing a musician should review. Known
  simplifications: Frère Jacques marked all-C (it is a round over a pedal);
  Twinkle uses G7/C alternations in bars 5–8 where some sources prefer C/G.
- Every file is validated at load (`server/lib/library.js`): bar sums, chord
  coverage, L:1/8. Bad files are skipped loudly. `npm test` re-checks all of
  this and must stay green.

## Part melody validation (`server/lib/partCheck.js`)

Generated parts are checked measure-by-measure wherever they carry the melody:

- **Rhythm must match exactly** (sequence of durations).
- **Contour must match exactly** (rise/fall/repeat between consecutive notes).
- The check is **transposition-invariant** (works for B♭/E♭/F instruments and
  whole-octave shifts) because it compares interval *directions*, not pitches.
- **What it can miss:** a part transposed by a wrong interval but with correct
  contour (e.g. everything a third off) passes; exact-pitch checking would
  need key-signature bookkeeping on both the concert and written sides.
  Accepted for v1 — wrong-interval-but-right-shape is rare and still musical.
- **What it intentionally flags:** mid-phrase octave breaks (they change
  contour), which the prompt forbids ("keep the shape").
- Chords `[DF]` contribute their **top** note (melody-on-top convention).
- Tuplet measures are skipped (their duration math differs).
- On failure the server retries generation ONCE with the exact per-measure
  diffs, keeps whichever attempt is cleaner, and surfaces remaining problems
  to the UI as warnings (never blocks the user).

## LLM-side rules that shape musicality (in `server/prompts.js`)

- Melody handoffs happen at phrase boundaries, sections ≥ 4 bars.
- Melody is spread evenly across the ensemble, including low instruments and
  mallet percussion; the bass line relocates when a bass instrument leads.
- Duplicate players (Violin 1/2) must get different material; harmony
  preference is 3rds/6ths below the lead.
- Accompaniment must move (arpeggiation, passing tones, countermelody) —
  static held roots are prompted against.
- "No muddy close voicings below C3" is NOT yet enforced in code — prompt-only.
  *(Future: deterministic register-spacing check.)*

## Non-library songs

Anything not in the library still uses the previous pipeline: web-search
ground truth (chords/structure researched from public sources) + model melody
reconstruction + verification/repair passes + the manual melody editor as the
user's final authority. The library path is the accuracy gold standard; the
long-term direction is growing the library (MusicXML/kern ingestion, audio
transcription later) behind the same interface.
