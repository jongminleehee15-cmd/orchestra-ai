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

## Length is a retryable problem, not just a padding fallback (2026-08-23)

Bug: a part that stopped writing early (or ran long) skipped the repair
retry entirely on the non-chunked `/api/part` path (parts ≤24 measures —
i.e. every normal-length arrangement, not the long-piece chunked path).
The retry loop only ever checked melody/range; a wrong-length part went
straight to `fitMeasureCount`'s fallback with no chance for the model to
fix it first. Diagnosed FROM A REAL RUN, not guessed: a live 8-measure
Brass Quintet had Trumpet 2 and French Horn both come back 9 measures and
get auto-trimmed — `fitMeasureCount`'s `measureArr.slice(0, target)`
deletes the LAST measure, i.e. the cadence, while the 3 parts that wrote
exactly 8 keep theirs. That's a direct, observed mechanism for "some parts
continue after other parts are finished": the trimmed parts' ending is
gone while the untrimmed parts' real ending plays on. The chunked path
(`generatePartChunked`) already treated a wrong section length as a
`structure` problem and retried it BEFORE padding/trimming; `checkAll` in
`/api/part` now does the same — measure count is checked alongside
melody/range on the first pass, and a mismatch is included in the single
repair retry ("you wrote X measures but need Y — continue to the real
end" / "you went past the end"). `fitMeasureCount` is still the
last-resort safety net after that retry, unchanged — it just no longer
fires as the FIRST response to a wrong-length part.

Tie-break bug caught before shipping: the retry-acceptance check was
`if (second.total < issues.total)`, a flat sum across structure+melody+
range. Once structure counted toward `total`, a retry that fixed the
length but left an equal melody/range count (`second.total === issues.total`)
would NOT strictly improve, so the WRONG-LENGTH original would be kept —
making the fix a no-op in exactly the case it exists for (a French Horn
run hit this: 1 structure problem traded for 1 contour problem). Fixed by
making structure dominate the comparison: fewer structure problems always
wins; melody+range only break ties when structure is equal.

Separate, pre-existing issue found while investigating (NOT fixed here,
scope: pickup-measure support, per the anacrusis note in §Score library
above): one live blueprint for "Amazing Grace" (3/4, pickup opening) came
back with `melodyAbc` split into 9 measure-segments against `chords` of
length 8, for a requested 8-measure piece — the pickup beat becomming an
uncounted extra segment. `analyzeMelody`'s bar-math check + `refineMelody`
try to correct this but are best-effort, not guaranteed (documented
limitation, not new). If this fires, every downstream part is handed a
melody reference one measure out of phase with the chords/measure count
it's told to target — a worse, different failure (harmonic misalignment)
than the trim-based one above. This did NOT reproduce on a second live run
of the same song, so it's intermittent (model-dependent), not deterministic;
mention it if trim-avoidance alone doesn't fully resolve a user's report,
especially for pickup-beat songs.

Live-verified 2026-08-23: a 24-measure Brass Quintet (the non-chunked
boundary case, post-fix) came back with all 5 parts at exactly 24
measures with no length-retry needed — confirms no regression, not that
the retry path fired (the model didn't happen to under/over-write that
run). The retry logic itself mirrors the chunked path's already-tested
pattern (`server/test/chunking.test.js`), just applied one layer earlier;
the trim-deletes-the-cadence mechanism was directly observed pre-fix, not
inferred.

## Chunked-path retry tie-break never got the length-retryable fix (2026-09-24)

Bug: the §"Length is a retryable problem" fix above landed only on the
non-chunked `/api/part` path. `generatePartChunked`'s own retry-acceptance
check was still the original flat-sum comparison (`second.total <
issues.total`) — the exact bug already diagnosed and fixed once, just not
propagated to its sibling code path. Consequence: on any arrangement long
enough to chunk (>24 measures — i.e. most real arrangements), a section
retry that fixed the wrong measure count but traded it for an
equal-or-worse melody/range problem got REJECTED, keeping the wrong-length
section, which then fell through to `fitMeasureCount`'s rest-padding — a
block of silence mid-piece. User-reported as "musical lines not generating
fully, lines getting cut off."

Fixed by pulling the comparison out into one shared, tested function
(`isBetterAttempt` in `server/lib/chunking.js`, covered in
`chunking.test.js`) that both `/api/part` paths now call, instead of two
copies of the same logic that can silently drift apart again.

**Live-verified 2026-09-24**: a real 48-measure Epic/Lush trio (library
Canon in D theme extended via `extendLibraryMelody`, Violin/Cello/Trumpet)
hit the exact failure mode live — Trumpet's section 33-48 failed its first
attempt (`1 structure, 0 melody, 0 range`). The corrected retry logic
accepted the repair; all three parts shipped at exactly 48 measures with
zero warnings. No `max_tokens` truncation occurred in this run (see next
item) — the failure was the model under-writing a section on the first
pass, not a token-ceiling cutoff, and the retry alone resolved it once the
tie-break stopped rejecting valid fixes.

## Silent failure when a part response has no ABC header at all (2026-09-24)

Bug, found by inspection while investigating the above (not yet observed
live): both `/api/part` paths derive the response's header via
`headerOf(abc)`, which falls back to returning the ENTIRE input string
when no `K:` line is found (empty response, a refusal/prose reply, or
truncation before ever reaching a header). The non-chunked path's
length-fix guard was `if (got.length !== measures && headerOf(abc) !==
abc)` — when there's no header at all, `headerOf(abc) === abc`, so this
condition is false and the WHOLE length-repair block is skipped: no
padding, no `lengthNote` warning, and whatever garbage/empty text came
back ships to the client as a "done" part with no indication anything
went wrong. The chunked path had a related but worse variant:
`if (!header) header = headerOf(abcChunk)` accepted the first chunk's
`headerOf()` result unconditionally — a headerless first chunk would make
the ENTIRE assembled part's header the garbage/empty text, corrupting
every section, not just one.

Fixed: both paths now check for an actual `K:` line before trusting a
`headerOf()` result; if none is found (immediately on the non-chunked
path, or after every chunk on the chunked path), a minimal valid ABC
header is synthesized from the request's own key/instrument/tempo data so
the part can still be padded into a playable (all-rests) fallback, and a
`lengthNote` warning is always set so this is never silent.

Not yet live-verified (no real run has hit a headerless response) — this
is a defense against a failure mode the code path made possible, found by
reading the guard condition against what `headerOf()` actually returns on
its fallback branch, not from an observed incident. Mention if a user
reports a part that renders as completely blank/empty with no warning at
all, distinct from the partial-cutoff pattern above.

## Generated bars were never checked for length (2026-09-24)

**The biggest real defect found so far, and the direct cause of "lines don't
finish / get cut off."** Nothing validated that a generated part's bars hold
the right number of beats. `checkPartMelody` only inspects measures where the
part carries the MELODY; `checkPartRange` only inspects pitches; the structure
check only counts measures. `measureUnits`/`analyzeMelody` did bar math, but
were applied ONLY to the canonical melody, never to the parts built from it.
abcjs does not help: `parseOnly` accepts a wrong-length bar with
`warnings === undefined`. So a bar with an extra or missing beat shipped
completely silently.

Why that presents as the user's symptom: a wrong-length bar shifts everything
after it in that part. Measured directly with abcjs's own audio sequencer —
in a 4-bar, 2-part score, a single 9-unit bar in 4/4 makes that part end
**0.125 beats after** the other. Over a real arrangement the error compounds
every time it recurs, so one line runs past the others, ends in the wrong
place, or drifts audibly out of time. It is not cosmetic and it is not a
rendering issue.

Fixed with three layers:
1. `checkPartBars` (`server/lib/partCheck.js`) validates EVERY measure of
   every generated part against the meter, on both `/api/part` paths. Its
   conventions deliberately mirror `analyzeMelody` exactly (same 0.01
   tolerance, same `(3` tuplet skip) so part-level and melody-level checks
   can never disagree about what a valid bar is.
2. Bar problems join the existing repair retry with precise per-bar diffs,
   and count as STRUCTURAL in `isBetterAttempt` — a retry that fixes bar
   lengths beats one that merely trades problem types.
3. `repairPartBars` (`server/lib/chunking.js`) is the deterministic last
   resort. **Asymmetric by design**: accompaniment bars are padded with rests
   or trimmed (the straddling event is shortened to fill the bar, not
   dropped), but a bar where the part carries the MELODY is never rewritten —
   altering it would change the tune and manufacture a `checkPartMelody`
   failure on a part that had none, the same self-inflicted damage as
   `fitMeasureCount`'s cadence-deleting trim. Melody bars are surfaced as
   warnings so the user can regenerate instead.

**Live-verified 2026-09-24, and it fired immediately.** An 8-measure
Baroque/Moderate Flute + Clarinet arrangement of the Canon in D theme: the
Flute's first attempt came back with **7 of its 8 bars malformed** (six at 9
eighth-units, one at 12, all in 4/4 — e.g. `!f!f2 (g f e) e2 f e`), and the
Clarinet's with one 10-unit bar. Every one of those would previously have
shipped silently. The retry resolved both parts completely; the final parts
had 0 malformed bars, 0 melody warnings, 0 range warnings, and both tracks
ended at exactly 8.000 beats. A 48-measure Epic/Lush trio (the chunked path)
came back clean on the first pass with all three tracks ending at exactly
48.000.

Ordering note: `enforceRange` runs BEFORE `repairPartBars`. That is safe
because octave shifts preserve note durations — verified directly on a part
whose measure was both out of range and overfull: unit counts were identical
before and after (`[8,9,8]` → `[8,9,8]`) and the bad bar was still detected.

### Tuplets are measured, not skipped (closed 2026-09-25)

Originally every bar containing `(3` was SKIPPED by every bar-math check —
`analyzeMelody`, `checkPartBars`, `checkPartMelody` and `repairPartBars` all
bailed on it — so a wrong-length triplet bar shipped unvalidated: the same
silent failure this whole section exists to remove. `scanMeasure` now
implements the ABC tuplet contract properly: `(p`, `(p:q` and `(p:q:r` scale
the next `r` events by `q/p`, with the standard defaults (2→3, 3→2, 4→3, 6→2,
8→3; 5/7/9 follow the meter — 3 in compound time, 2 in simple). `(3CDE`
measures 2 eighth-units, not 3. Every skip is gone. A `(` not followed by a
digit is still just a slur and carries no ratio.

Repair stays conservative where it must: a SHORT tuplet bar may be padded
(rests append after the group, never inside it), but an OVERFULL one is
reported rather than trimmed — cutting into a tuplet would orphan the group,
leaving a `(3` whose remaining notes no longer add up.

### One duration parser, finally (closed 2026-09-25)

`tokenizeMeasure` in `partCheck.js` had its own third duration parser, which
knew neither tuplets nor chords whose length is written inside the bracket
(`[C2E2G2]`), so melody rhythm comparison mis-measured both. It now reads
durations off `scanMeasure` like everything else and derives only pitch
itself. Duration is computed in exactly one place in the codebase — the same
drift that left the chunked retry path broken, closed structurally.

Verified: numerically identical on all 229 real library and generated-part
measures; `[C2E2G2]` and `[CEG]2` now agree; a part that flattens a canonical
triplet bar into even notes is caught instead of waved through.

### The tolerance was hiding real errors (closed 2026-09-25)

The bar comparison used `> 0.01`. Every ABC duration is a rational whose
denominator divides 16 × 9, so the SMALLEST error a real notation mistake can
produce is 1/144 ≈ 0.0069 — which is **smaller than the tolerance**. A
genuinely wrong bar could pass as "close enough". Measured float error from
summing tuplet thirds is only 8.9e-16, so the tolerance was three orders of
magnitude larger than it needed to be.

Replaced by one shared `UNIT_EPSILON = 1e-9` (`abcMelody.js`), used by every
duration comparison: six orders of magnitude above the float noise, seven
below the smallest real error. It cannot mask a mistake and cannot fire on
arithmetic. A test pins both bounds so neither can drift.

### Melody validation is interval-exact, not just contour (closed 2026-09-25)

The melody check compared RHYTHM exactly but pitch only by CONTOUR
(rise/fall/repeat), so a part with the right shape but the wrong interval
sizes — "everything a third off" — passed. `tokenizeMeasure` now resolves
each note to a true semitone by applying the key signature, plus explicit
accidentals with the bar-long carry a player reads, and `compareMeasure`
compares each note's interval from the bar's first pitched note.

Measuring from the bar's own first note keeps this transposition-invariant: a
B♭/F/E♭ part and an octave shift move every pitch equally, so both still pass,
while a wrong interval does not.

**It requires BOTH key signatures** (the canonical tune is at concert pitch,
the part is written in its own key) and is therefore OPT-IN: called without
them it falls back to exactly the old rhythm+contour behaviour. This matters
— an early version defaulted the keys to 0 and produced 11–15 false positives
on a known-good B♭ trumpet part, because reading keyed music as if it were in
C mis-resolves every accidental. `writtenKeyFor` now returns its `fifths`
alongside the key name so the two can never disagree.

Verified against real output, not just fixtures: **zero** false positives
across six known-good live-generated parts (two runs × Violin/Cello/Trumpet,
288 melody-section measures), while catching a constructed wrong-interval bar
that contour reported as clean. A full live regeneration afterwards produced
0 melody warnings on all three parts.

### What is and isn't claimed

Checkable, and now verified end to end:
- **Every shipped bar either sums to the meter, was repaired to it, or is
  reported as a warning** — tuplet bars included.
- **Every melody-carrying bar is checked for exact rhythm AND exact
  intervals**, not merely melodic direction.

This still is not a claim that no notation error is possible. What remains is
a stated design boundary rather than an unchecked gap: the comparison is
interval-exact rather than absolute-pitch-exact (by design — it must accept
transposing instruments and octave placement), and a part may legitimately
differ from the canonical tune anywhere it does not carry the melody, which is
the arranger's job and not validated note-by-note.

## Parts are requested as a JSON envelope, not raw ABC (2026-09-24)

Part generation asks for `{"measures": ["<bar>", ...]}` — one string per bar —
instead of a complete free-text ABC tune (`server/lib/partFormat.js`,
`buildPartPrompt`'s OUTPUT FORMAT block). Two responsibilities moved off the
model and onto the server:

- **The header is built server-side** (`partHeader`) from the request's own
  key, meter, tempo and instrument data. A part can no longer be notated in
  the wrong key — a real hazard for transposing instruments, which read in a
  different key than concert pitch — nor arrive with no header at all. The
  header-synthesis fallbacks added earlier the same day are deleted rather
  than left as unreachable branches in `/api/part`. One related guard does
  remain, deliberately: `enforceRange`'s `header === String(partAbc)` early
  return in `ranges.js`. It is unreachable from the part flow now, but
  `enforceRange` is a shared helper and rebuilding around a header it could
  not find would corrupt the part, so it is kept and commented rather than
  removed.
- **The measure count is the array's length**, stated outright, instead of
  being inferred by splitting on barlines.

`parsePartMeasures` is deliberately strict about what may reach the stave.
`extractJson` salvages a truncated array by walking back to the last `]`,
which can turn a cut-off response into a valid-looking SHORT one — so a
response that was clearly attempting the envelope but got truncated returns
`[]` (→ explicit rests + a warning) rather than letting raw JSON text be read
as notation. Prose (a refusal, commentary) is rejected the same way by a
notation-shape test. Raw ABC is still accepted as a fallback, so a response
that ignores the format degrades instead of failing.

Not claimed: this does not make notation errors impossible. What it
guarantees is narrower and checkable — every shipped non-tuplet bar either
sums to the meter, or was repaired to, or is reported as a warning; and the
header always matches the request. Live A/B against the saved pre-change
baseline (same plan, same 48-measure trio) showed identical measure counts,
identical zero-warning results, melody measures still reproduced note-for-note
from the canonical tune, and no quality regression.

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

## Cross-part orchestration checks (`src/lib/voicing.js`)

Every check above validates ONE part at a time — melody accuracy, playable
range. But some orchestration problems only exist once every instrument's
part is on the page together (a part is generated without seeing what any
other instrument plays), so this runs client-side, once ≥2 parts are done,
over the finished ABC of every part:

- **Register crowding ("mud"):** flags a measure where 2+ NON-melody,
  NON-bass instruments both sit strictly below **C3 (MIDI 48, not
  inclusive)** within 1–3 semitones of each other (a minor third or closer,
  but NOT unison/octave — see below), in concert pitch (written pitch + the
  same `INSTR_META.shift` playback already uses). Melody-carrying measures
  are exempt (a featured low melody isn't mud); the designated bass
  instrument (`primaryRole === "bass"`) is exempt entirely, since it's
  *supposed* to sit down there every measure — without this exemption the
  check fired on nearly any pairing involving the bass. Unison/octave
  doubling (distance 0) is excluded too — that's normal low-register
  scoring, not mud. *(Correction wanted: C3 and "1–3 semitones" are a
  reasonable first cut, not a rule from a texture-theory source — a
  musician may want the floor higher/lower per ensemble size, or the
  interval widened for larger groups where 2+ low parts is normal. Also:
  this only compares ACROSS parts — a single part's own close-position
  chord voicing, e.g. a piano left-hand cluster `[C,,E,,G,,]`, is still
  unchecked; that was likely the original intent behind "no muddy close
  voicings below C3" in the note above, so this does not fully close that
  gap, only the ensemble-level half of it. Also: the bass exemption only
  engages when the blueprint actually assigns `primaryRole: "bass"` to
  someone — it doesn't always (the live-verified string quartet below gave
  Cello "melody" and Viola "harmony" with a plain-text instruction to play
  "walking bass," so neither was exempt); ensembles without an explicit
  bass role carry more false-positive risk from this check.)*
- **Unison doubling:** flags a pair of players sharing an instrument (e.g.
  Violin 1/2) whose NON-melody measures are pitch-identical ≥50% of the time
  they're both compared — the prompt already asks for distinct material
  (`prompts.js` "DISTINCT VOICES") but nothing enforced it.
- **Dynamic imbalance (2026-08-23, user-reported):** flags a measure where a
  NON-melody instrument's written dynamic mark (`!p! !mp! !mf! !f! !ff!`,
  fff/pp included defensively) is LOUDER than the melody carrier's, using
  the same "sticky until the next mark" reading a player would give the
  page. Real report: a Canon in D brass arrangement had French Horn carry
  the melody at `!p!` while the (non-melody) Trumpet parts sat at `!mp!` —
  louder than the tune it was supposedly under. Root cause: each
  instrument's dynamic came from an independent per-part model call with no
  visibility into what any other instrument was marked, so a section
  described as "hushed" for the melody carrier alone (in the blueprint's
  per-instrument `instruction` text) could sit next to an unrelated,
  louder accompaniment instruction. Fixed at the SOURCE first — both
  blueprint prompts (`buildBlueprintPrompt`, `buildLibraryBlueprintPrompt`)
  now carry an explicit "DYNAMIC BALANCE" rule (melody's dynamic must be
  >= every simultaneous instrument's; a quiet passage must be quiet for
  everyone in it, not just the melody carrier), and `buildRoleInstruction`
  in `prompts.js` reinforces it per-part (melody: loudest voice present,
  even when quiet; non-melody: at or below the melody). This check is the
  safety net for when that's not followed, same relationship `findMud`/
  `findUnison` have to their own prompt rules. Equal dynamics (bass marked
  the same `!f!` as an `!f!` melody) are NOT flagged — only strictly
  louder — since a bass doubling the melody's dynamic is normal scoring,
  not the reported problem.

The mud and unison checks above compare notes per-measure, not beat-aligned — two parts with
different rhythms can share a "close low measure" flag without literally
sounding at the same instant. Coarser than the per-note range/melody
checks, by design (beat alignment across independent model calls would
need durations lined up on a shared clock, which this ABC doesn't carry).
Read a flag as "worth listening to together," not a proven collision.

**Live-verified 2026-08-23** against real model output (not just synthetic
fixtures) on two arrangements chosen to stress-test false positives — a
Brass Quintet (Amazing Grace, F, 3/4, 8 measures — Tuba on bass, Trombone
carrying melody in mm.5-6, everything else genuinely low-register brass)
and a Lush string quartet (Ode to Joy, D, 4/4, 8 measures — duplicate
Violin 1/2, Cello alternating bass-arpeggio and melody roles). Both
generated cleanly (no melody/range warnings worth noting) and
`analyzeVoicing` correctly returned zero warnings on both — manually
verified the zero was correct (no other part's notes actually crowded the
Cello's low arpeggio in mm.1-4 of the quartet, for example) rather than
the check silently missing something. Sensitivity (does it fire on a real
mud case) is unverified — both checks were confirmed to fire correctly
only on constructed fixtures — the threshold may still need tuning if it
turns out too quiet in practice. (A `Math.min`-vs-`some` bug in the mud
predicate — a coincidental unison note elsewhere in a measure could mask a
real close pair — was found and fixed via fixture AFTER these two runs.
The saved output was not re-analyzed post-fix; by inspection neither
ensemble ever had 2+ simultaneous low non-exempt parts, so the predicate
never ran regardless of which version — but this was not re-verified by
rerunning, to avoid spending API credits on a case that short-circuits on
a length check.)

**Dynamic-imbalance fix live-verified 2026-08-23**: regenerated the exact
reported scenario — Canon in D (library melody, D, 4/4, 8 measures) with a
brass ensemble including French Horn and 2 Trumpets. Post-fix, the
blueprint's own instrument instructions came back self-coordinated
("never overpowering the French Horn melody", "never louder than the
current melody carrier") and the generated parts' written dynamics matched
(melody carriers consistently `!f!`, accompaniment at or below) —
`analyzeVoicing` returned zero dynamic-imbalance warnings on that run. This
confirms the blueprint-prompt fix engaged and produced coordinated output
on a real regeneration of the reported case, not just a synthetic fixture.
It does not prove the detector fires on a genuine imbalance in real
(non-synthetic) output — that predicate was only confirmed via the
constructed fixture reproducing the user's exact report (French Horn `!p!`
melody vs `!mp!` Trumpet). If dynamic imbalance recurs after this fix, it
either slipped past the strengthened prompts on a different run, or is a
case (see the "no gap/no unmarked" pattern in the other two checks above)
outside what this coarse, per-measure, sticky-mark comparison can see.

**Deliberately informational, not auto-fixed** (unlike `enforceRange`,
which does auto-correct): mud is a 3-way relationship — shifting part A to
clear part B can create a new collision with part C — and
`checkPartMelody` intentionally flags mid-phrase octave breaks as contour
violations, so a blind auto-shift could manufacture a NEW melody warning on
a part that had none. Surfaces as a warning panel in `ScoreView.jsx` instead
(same non-blocking pattern as `melodyWarnings`/`rangeWarnings`); the user
decides whether to regenerate a part or re-voice it manually.

Known limitation: notes are compared per-measure, not beat-aligned — two
parts with different rhythms can share a "close low measure" flag without
literally sounding at the same instant. This is a coarser signal than the
per-note range/melody checks, by design (beat alignment across independent
model calls would need durations lined up on a shared clock, which the ABC
here doesn't carry). Treat it as "these two are worth listening to
together," not a hard collision proof.

## Open Hymnal source (`server/lib/openhymnal.js`, 2026-09-14)

A runtime-fetched corpus, same verbatim-melody contract as the library and
the music21/OpenScore corpora: ~300 public-domain hymns from the (now
apparently defunct) Open Hymnal Project, mirrored at
`github.com/mzealey/openhymnal`. Wired into `/api/search` (tried after
music21/OpenScore, before the LLM) and `/api/blueprint`'s `corpusId` branch.

**Why this needed its own parser, unlike the MusicXML corpora:** these files
are a different ABC dialect from the hand-curated library's — multi-voice
(`V:`/`%%staves`), `L:1/4` (not `L:1/8`), abcm2ps-flavored. The melody voice
is extracted as "whichever voice is declared first" (standard SATB
engraving — soprano on top), rescaled into the pipeline's canonical `L:1/8`
form via the same `eventsToMeasures()` engine `musicxml.js`/`midi.js` use.
Chords are not extracted from the source's real 4-part harmony in v1 —
harmonized once via the LLM and cached, same as every other corpus. Full
SATB extraction would be a real accuracy upgrade if revisited later.

**License gate — this is the one judgment call worth a musician/maintainer's
attention.** Unlike a single-license corpus, this project's own README
allows "public domain OR freely distributable" works — not uniformly
commercial-safe. Every file is checked for a `C: copyright: ...` line
containing "public domain"; anything else is silently skipped. Verified
against a ~50-file spread sample: 98% converts and passes (measured after
fixing two parser bugs found in that same pass — see below), with the one
rejection being a **known false negative**: a file that splits "Words:
Copyright ... All rights reserved" and "Music and Setting: public domain"
across separate `C:` lines. The gate only reads the first matching line, so
it conservatively rejects a hymn whose music is genuinely PD. Left as-is —
erring toward discarding a usable hymn is the safe direction, and it's a
small fraction of the collection.

**Two real parsing bugs found and fixed during integration** (both caught by
the bar-math validation gate every source goes through, exactly as designed):
1. The length-suffix regex didn't handle ABC's `/4` shorthand (a slash
   directly followed by digits, implied numerator 1) — `/4` was silently
   mis-split into `/` (parsed as 0.5) with the `4` dropped, corrupting
   duration math on any hymn using explicit dotted-rhythm fractions (found
   via two real files with 8.5/9-unit bars instead of 8).
2. Tuplet detection (`"(3"`) was checked on text that had already had its
   slur parens stripped, so the `(` was gone before the check ever ran —
   moved the check to run on the raw measure text first.

**Reliability caveat, not yet acted on:** the original openhymnal.org site's
TLS cert is broken (resolves to an unrelated domain) — the project looks
abandoned. The GitHub mirror this integration points at (`mzealey/openhymnal`)
is one person's personal fork, last touched in 2017, not an institutional
home like `cuthbertLab/music21`. **Fork it to a repo you control** and update
the `REPO` constant in `openhymnal.js` before treating this as a permanent
dependency — a stranger's dormant account is a weak foundation.

## Non-library songs

Anything not in the library still uses the previous pipeline: web-search
ground truth (chords/structure researched from public sources) + model melody
reconstruction + verification/repair passes + the manual melody editor as the
user's final authority. The library path is the accuracy gold standard; the
long-term direction is growing the library (MusicXML/kern ingestion, audio
transcription later) behind the same interface.
