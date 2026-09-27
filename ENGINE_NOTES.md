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
- "Every measure has exactly one melody carrier" IS enforced in code since
  2026-09-26 (see §Melody coverage below); the prompt rule remains as the
  first line of defence.
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

## Melody coverage is enforced, not just requested (`server/lib/planCheck.js`, 2026-09-26)

Both blueprint prompts say every measure must be carried by exactly one
instrument. Nothing checked it. Three silent failures were possible: a measure
nobody was given has no melody in ANY part; a measure given twice has two
instruments playing the tune in parallel; and a role keyed by a name that is
not one of the selected voices ("Violin" when the voices are "Violin 1" and
"Violin 2") reaches no part at all, because the client looks roles up by exact
voice name. A blueprint response with no `instrumentRoles` at all (the library
path falls back to `{}`) dropped the melody from every part.

`repairMelodyCoverage` now runs on both blueprint paths (`enforceMelodyCoverage`
in `index.js`) against the SELECTED voice names. Deterministic repair only, no
second blueprint call: the blueprint blocks everything else and costs money,
and the repair changes only who carries the melody, never which notes. Every
change is sent as `plan.planWarnings` and shown above the part cards. A valid
plan comes back as the same object with no warnings.

Judgment calls *(correction wanted)*:
- **Overlap:** the measure goes to the carrier whose claimed range starts
  LATEST (ties: shorter range, then voice order). It honours the hand-off the
  incoming section declared, and keeps a short feature nested inside a long
  section instead of erasing it. "Earliest wins" is equally defensible.
- **Gap:** the preceding carrier continues through it; a gap at the start goes
  to the first carrier after it. Extending a phrase felt safer than handing the
  tune to an instrument that was never planned to have it.
- **No carriers at all:** rotate through the voices on the prompt's own
  suggested sections (`suggestedSections`, now shared with both prompts). That
  arithmetic can leave a one-measure runt section (16 measures, 3 voices →
  mm.1-5, 6-10, 11-15, 16-16); it was already what the prompts suggested and is
  kept identical rather than changed silently.
- Name matching is exact, then trimmed and case-insensitive. It never guesses
  "Violin" → "Violin 1". A case-variant key is moved to the exact voice name
  without a warning: that is a fix, not a problem the user can act on.
- Unparseable labels are dropped; ranges are clipped to the piece.

Not claimed: this guarantees the PLAN covers every measure once. Whether a
part then actually plays the melody there is still `checkPartMelody`'s job.
Not live-verified: tested offline only (`planCheck.test.js`).

## Accompaniment is checked against the chords (`server/lib/harmony.js`, 2026-09-26)

The first check on harmony itself. Every earlier part check is about form
(tune reproduced, notes playable, bars add up). Each part is written by its own
model call, and the shared chord list is the only thing holding the ensemble
together, but nothing verified that an accompaniment line fits it.

Rule, per bar where the part does NOT carry the melody: weight each sounding
note by its duration (from `scanMeasure`), convert written pitch to concert
pitch class (shift = `(writtenFifths − concertFifths) × 7` mod 12, which holds
for B♭/F/E♭ parts and for respelled written keys), and flag the bar when chord
tones make up **less than 3/8** of the sounding time (`FLAG_BELOW`). A bar with
two chords ("G C") splits evenly and each note is judged against the chord(s)
it overlaps. A chord-note event counts by the fraction of its notes in the chord.

**Why 3/8.** Any 8 consecutive steps of a diatonic scale contain all 7 scale
degrees, so a stepwise run over any diatonic triad holds at least 3 of its
tones in 8 notes (16 sixteenths: at least 6 in 16). Below 3/8 therefore cannot
be plain scale motion over the right chord. `harmony.test.js` checks this
exhaustively: every start degree, up and down, eighths and sixteenths, over
every diatonic triad, in C and D major (392 runs, none flagged). The first
version used 1/2; the first live run showed why that was wrong (Baroque scale
runs landing at exactly 3/8, all flagged).

**Exception, known and pinned in a test:** the derivation assumes one chord
per bar. In a two-chord bar each chord only covers 4 steps, which can hold a
single chord tone (A B c d over C, then e f g a over G: 25%, flagged). Canon
in D has two chords per bar throughout. Not lowered further: 25% is where the
real clashes found live sit.

**A chord that contradicts its own melody is not held against the part.** When
the canonical melody bar ITSELF scores below 3/8 against the plan's chord, the
part bar is skipped and counted as `chordSuspect` in the log. Seen live: the
model-written extension chords put an A chord under the extension melody's own
E F♯ G, and a French Horn doubling that tune was flagged for following it. The
real defect there is in the plan, not the part; it is logged, not shown in the
UI (see "extension chords" below).

Skipped, never guessed: melody bars, rest bars, bars with no chord, "N.C.",
chord-suspect bars, and any bar whose annotation contains a symbol the parser
does not understand (counted as `unreadable`). The parser covers triads, 6,
6/9, 7, maj7, m7, dim/dim7/°, ø/m7b5, aug/+, sus2/sus4, 9/11/13, add-tones,
altered 5ths/9ths/11ths/13ths, power chords and slash basses.

**Informational only, deliberately.** It is not in `checkAll`, not in
`isBetterAttempt`, not in the retry prompt, and it never changes a note. The
part prompt explicitly asks for suspensions, anticipations and passing tones,
and three live runs are not enough to trust it with regeneration. It returns
`harmonyWarnings` (shown on the part card) and logs `[part:X] harmony: F of C
accompaniment bar(s) flagged`. That log line is the measurement that should
decide whether it ever drives regeneration.

**What it detects is narrower than "wrong chord".** Measured, quarter-note
arpeggios over a C chord:

| Line over C | Share | Result |
|---|---|---|
| Dm (D F A d), Dm (D F A4), B° , B♭ | 0% | flagged |
| G (G B d4), G7, F (F A c f), C♯m | 25% | flagged |
| G (G B d g), F (F A c4), Am (A c e a) | 50% | passes |
| Em (E G B e) | 75% | passes |

A chord that shares NO tones with the written one is always caught. A chord
that shares tones (V, IV, vi, iii over I) passes or fails depending on which
shared note the rhythm happens to hold, so this detects lines that are mostly
outside the chord, not wrong chords in general. It also does not compare a
part with the MELODY: a line shadowing the tune in parallel 2nds or 7ths is
only caught here when it also misses the chord (Trumpet bars 10-11 below were;
the same clash in even eighths would score at least 3/8 and pass). The
separate part-against-melody check is `findMelodyClashes` (§Parts heard
together, below).

### Live results (2026-09-26, three runs)

Measured on real output, verified bar by bar against the melody and chords.

- **Ode to Joy, 32 bars, Romantic/Full** (Violin 1, Violin 2, Clarinet, French
  Horn, Cello) and **Canon in D, 16 bars, Baroque/Moderate** (Flute, Trumpet,
  Alto Sax, Bassoon), both library. Scored with the first version (1/2, no
  chord-suspect skip): 33 flagged bars. Rescored offline with the current rule:
  **21**. Of the 12 removed, 11 were false alarms (6 Flute scale runs, 4 bars
  doubling the melody, one parallel-thirds line) and one was borderline (Alto
  Sax bar 8, a run against a held melody note, at 3/8). All clear clashes stay
  flagged:
  - The **Clarinet** part was genuinely broken: its accompaniment outlined the
    wrong chords throughout bars 1-16 (G major over D, B-D over A; 13 bars at
    0-25%), and in its melody bars it replayed the original theme a third low
    instead of the plan's extension melody. The melody check caught 5 of those
    6 bars. *(Corrected 2026-09-27: this said bar 20 "slipped through because
    its intervals match at the wrong pitch level". Read at sounding pitch,
    bar 20 is E D D, exactly the extension tune: the one right bar, not a
    missed one. Found by the evaluation's pitch-level melody check, which
    pins it in a test.)*
  - **Trumpet** bars 10-11 shadow the melody in parallel 7ths, a 7th ABOVE
    the Alto Sax carrying it. *(Corrected 2026-09-26: first written as "a
    whole step under the melody in parallel seconds". That compared against
    the canonical melody's octave; the Alto Sax plays the tune an octave
    lower, and the sounding interval is a 7th. Same clash class, wrong
    description.)* **Alto Sax** bars 1, 2, 4 clash with the melody.
  - Remaining false alarm: **Violin 2 bar 19**, a parallel-sixths line under the
    tune. Bars 9 and 11 (an E minor shape over an A chord) are borderline.
- **Yankee Doodle, 16 bars, Playful/Moderate** (Flute, Clarinet, Viola, Tuba),
  free-text path, generated AFTER the rule change, so not data it was tuned on:
  **3 of 48** accompaniment bars flagged, all Clarinet at 0% (C-A over G7, an A
  minor triad over G7), all real. Flute, Viola and Tuba: none.
- Transposition was confirmed independently: every correctly written
  transposing part scores far better read with the shift than without it
  (at 3/8, before the chord-suspect skip: French Horn 1 vs 10 flagged of 26,
  Trumpet 2 vs 6 of 8, Alto Sax 3 vs 9 of 12, Yankee Doodle Clarinet 3 vs 9 of
  12). The broken Ode to Joy Clarinet is bad either way (13 vs 11), which is
  what a part outlining the wrong chords looks like.

Library calibration: the 8 library melodies against their own chords, 85
bars, 0 flagged; the lowest bars sit at exactly 50%, comfortably above 3/8.

**Extension chords contradict their own melody** (pre-existing, not fixed):
in the Ode to Joy run, bars composed by `extendLibraryMelody` came with chords
that the new melody does not fit (an A chord under E F♯ G; an A chord under the
cadence E D D that the theme itself harmonizes as "A D"). The chord-suspect
skip stops parts being blamed for it, but the plan's harmony there is still
wrong, and nothing checks the extension's melody against its chords.

The chords themselves are often the model's (`harmonizeWork`, the free-text
blueprint, the extension), so this checks consistency with the plan, not that
the plan's harmony is good.

## Parts heard together (`server/lib/ensemble.js`, 2026-09-26)

Two changes that read every part at its SOUNDING pitch (octave included, via
`WRITTEN_SHIFT` from ranges.js, durations from `scanMeasure`). The module is
imported by the browser (`src/lib/voicing.js`), so it must stay free of
anything Node-only; a build of the client contains no `process.env` or
Anthropic code (checked by grepping the bundle).

### 1. Each part is written hearing the finished parts

`/api/part` accepts `contextParts` (the other finished parts) and
`instrumentRoles`. The prompt gets an ENSEMBLE SO FAR grid: bar by bar, every
finished part as sounding note names ("F#5 q, E5 e"), the melody carrier
marked, and the canonical tune in bars whose carrier is not written yet. It is
converted in code so the model never transposes another part in its head.
Without context the prompt is byte-identical to before (72 prompts compared
against the previous commit).

Client: "Generate All" ran its loop inside one render's closure, so it could
never see parts finished during the loop. Every part update now goes through
`updateParts`, which keeps a ref current synchronously; `generatePart` reads
the part and its context from the ref. `/api/part` alone takes bodies up to
512kb (every other route keeps 64kb, verified over HTTP); the client trims
context to 400k characters first, and the server drops malformed entries
instead of failing (`sanitizeContextParts`, `fitContext`, both tested).

**Evidence that it helps: none yet that would survive a second run.** A/B on
the three saved plans (same melody, chords and roles; parts generated one at a
time, in order), one run per song, plus one no-context rerun of Canon to see
run-to-run variance:

| Run | Chord flags | Melody clashes | Dynamics warnings | Notes |
|---|---|---|---|---|
| Canon, first run / no-context rerun / **context** | 5 / 8 / **2** | 8 / 6 / **3** | 4 / 5 / 8 | only clear gain, beyond the no-context spread |
| Yankee Doodle, first / **context** | 3 / **2** | 4 / **2** | 3 / 4 | Viola copied a Clarinet rhythm from the grid and dropped a rest: 12 short bars, padded and reported |
| Ode to Joy, first / **context** | 16 / **20** | 5 / **21** | 8 / 8 | 17 of 21 clashes are the Clarinet, broken in both runs; says nothing about context |

- **Contamination is real.** In the Ode context run the French Horn was
  written after the broken Clarinet, with it in its context, and went from 0
  melody clashes to 4. Context can spread one bad part into later ones.
- **Dynamics are not evidence either way.** `describeBar` drops dynamic marks,
  so the grid shows none and cannot have changed them. Candidate follow-up:
  include each part's current dynamic in its row.

### 2. Melody clashes (`findMelodyClashes`)

Every non-melody part against the part that ACTUALLY carries the melody in
each bar, shown in the orchestration panel. Informational, like the rest of
`analyzeVoicing`. A bar is flagged when, for at least half of the time both
sound (and at least a quarter note of it), the part's note is OUTSIDE the
chord AND a 2nd or 7th, in any octave, from the tune.

- **Interval classes, not absolute sizes.** The first version used an absolute
  set (2nds, M7, m9). The live Trumpet it was built for was then missed: it
  sits a 7th above the Alto Sax, which plays the tune an octave below the
  canonical melody's octave. The octave a carrier uses is its own choice.
- **Only dissonance the part creates counts.** Without the chord-tone filter,
  most flags were the melody's OWN passing tones against an accompaniment
  sitting correctly on a chord tone (a Tuba on the root under Yankee Doodle's
  passing A). 36 flags on the three first runs became 17 with the filter.
- **Both derivations are tested exhaustively.** Parallel unisons, 3rds, 6ths
  and octaves are never flagged, over any diatonic triad (their classes are
  never dissonant). A stepwise tune shadowed in parallel 2nds or 7ths is
  always flagged: any 4 or 8 consecutive scale steps hold at most half of
  their notes in one triad, so the shadow is off the chord at least half the
  time.
- The live pins (Trumpet bars 10-11 flagged; Trumpet 14 and Violin 2 bar 19
  pass) come from the data that shaped the rule. They pin it; they don't
  validate it.
- On the three first runs, all 17 remaining flags were judged by hand: clear
  clashes (the broken Clarinet, the Trumpet and Flute shadowing in 7ths, a
  Flute in parallel 9ths, Violin 2 in parallel 2nds, a Bassoon not following
  the chord change) or borderline. No clear false alarm. A dominant 7th held
  against the tune for half a bar is a known risk the rule allows.

### Mis-transposed accompaniment: fixed by handing over written-pitch chords

In 3 of 12 transposing-part runs, the accompaniment was built on the wrong
chords: both runs of the Ode to Joy Clarinet, and the Canon Trumpet in the
no-context rerun (it was fine with context, so context did not cause it).
*(Corrected: first recorded as "3 of 11", and the Trumpet as writing "each
chord a 5th up, a horn's transposition". The data does not support a single
interval: D → A is a 5th, G → E a 6th, and Bm → B kept its root with the key
signature turning it major. The model simply wrote wrong chords in the written
key.)* Melody bars were unaffected: the prompt hands them exact notes.
Detected by reading each part's accompaniment with the correct shift,
unshifted, and shifted twice: correctly written parts fit best shifted.

**Fix (`writtenChordsFor` in transpose.js, 2026-09-26).** A transposing part
is no longer given the concert chord list. It gets "CHORDS AS YOU READ THEM",
transposed in code into its written key, and is told not to transpose them
again; the instruction to transpose concert pitch now names only the melody.
Symbols move by letter, so spelling follows the interval (a B-flat part turns
F#m into G#m). When the written key had to be respelled (concert F# on a
B-flat part reads in Ab, not G#), chord letters are respelled with it, and a
chord from outside the key never gets a double accidental (C there is written
D, not Ebb, a case the exhaustive test caught). The respelling is measured
from the concert key as SPELLED, not as folded: a library work in concert C#
keeps C#-spelled chords while the written key is folded (a trumpet reads in
Eb), and measuring from the folded key had given that trumpet D#, G#, B#m.
*(Found in review before commit, 2026-09-26.)* Tested over every root
spelling × 27 qualities × slash basses × 7 transposing instruments × 34
concert keys (the 24 conventional ones plus C#, G#, D#, A#, Cb, Fb, G#m, D#m,
A#m, Abm): each written symbol parses to exactly the original chord moved by
the instrument's interval. For each key's own diatonic chords, every written
root must also be the note the player's key signature gives that letter.
Non-transposing prompts are byte-identical to before (checked against HEAD).
Residual: the respelling follows the key's spelling, so a source whose chords
are spelled against its own key (key "Db", chords C#) still reads awkwardly;
the pitches stay right.

**Live-verified 2026-09-26**, against success criteria written down BEFORE the
run, each part regenerated on its saved plan with no context:

| Part | Before | After |
|---|---|---|
| Ode to Joy Clarinet, 4 runs | wrong 2 of 2 (38-39% fit) | correct 4 of 4 (78-88%) |
| Canon Trumpet, 3 runs | wrong 1 of 3 | correct 3 of 3 (69-100%) |
| Controls: Ode Horn, Canon Alto Sax, Yankee Clarinet | correct | still correct (75-100%) |

Double transposition, the risk of handing over pre-transposed chords, never
fit best. The Ode Clarinet's chord flags fell from 13-17 of 25 to 0-3. n is at
most 4 per part: strong evidence, not proof.

**Still open, a different problem:** in all 4 Ode runs the Clarinet's MELODY
bars 19-24 (melody composed to extend the piece) failed their first attempt,
drifting back toward the familiar Ode to Joy tune, and 2 runs still carried
5-6 melody warnings after the retry. Surfaced to the user as warnings; not
addressed by this fix.

Not verified in a browser: the score view was not loaded in dev. The client
build is clean, and `voicing.js` was run end to end in Node over every saved
run.

## Evaluation harness (`eval/`, 2026-09-27)

Every result above rests on 1 to 4 runs per part. `eval/` makes comparisons
repeatable: a fixed suite of 6 cases (`eval/suite.json`: library works
extended past their source, the free-text path, minor key, 3/8 and 6/8, Bb,
F and Eb parts, a low-brass ensemble), saved runs with provenance, and an
offline scorer that rescores any run with the checks as they are now. Usage
and caveats: `eval/README.md`.

**The scorer reproduces this file's numbers.** Run on the saved 2026-09-26
files (now `eval/runs/legacy-*`), it gives exactly what was recorded above:
chord flags 5 / 8 / 2 (Canon), 3 of 48 and 2 (Yankee Doodle), 16 / 20 (Ode);
melody clashes 8 / 6 / 3, 4 / 2, 5 / 21; the three mis-transposed parts; the
Ode Clarinet's 5 caught melody bars; one Ode bar where the plan's chord
contradicts its own extension melody. A test pins these, so a change to a
check that moves them is noticed, not silently re-baselined.

**Correction: dynamics counts were capped.** `analyzeVoicing` stops at 8
mud and 8 dynamics warnings (right for the UI). The "8 / 8" dynamics warnings
for Ode above, and Canon's context run's 8, were that cap: uncapped they are
12 / 13 and 13. The conclusion stands (dynamics are not evidence for or
against context), but the numbers were floors. The scorer passes a limit of
Infinity; the UI still stops at 8.

**What it measures and doesn't.** Consistency with the plan (melody, chord
fit, length, range, melody clashes, coverage, transposition, mud, unison,
dynamics), per 100 part-bars or per bar that could fail, with no composite
score. It inherits the checks' false alarms and says nothing about whether an
arrangement is musically good; `eval/blind.mjs` makes blind A/B listening
pages for that. A/B verdicts count only when the repeat ranges don't overlap.

**Not yet exercised: live generation.** `eval/generate.mjs` was run only on
its free paths (the plan and call estimate, the dirty-tree refusal, and a dry
run that started its own server on a free port and checked health and the
library). No arrangement has been generated through it yet, so the first
paid run is also its first real test: start with one case, one repeat. It
refuses to run on uncommitted code unless `--allow-dirty`, and records the
commit and model in every run.

### First baseline (`eval/runs/baseline`, 2026-09-27)

All 6 cases x 2 repeats on commit 10a45ae (clean tree), claude-opus-4-8,
ensemble context on. 12 of 12 arrangements, no failed part. Pooled over
1,264 part-bars (`node eval/report.mjs baseline` for per-case ranges):

| Measure | Baseline |
|---|---|
| Melody bars not matching the tune | 21 of 288 (7.3%); Twinkle 8-29%, Canon 6-25% |
| Accompaniment bars off their chord | 80 of 818 (9.8%); Ode 16-18%, Elise 11-17% |
| Melody clashes | 4.0 per 100 part-bars; Ode 6-9 |
| Plan's tune off its own chords | 9 of 288 bars (3.1%), Canon and Yankee up to 19% in one run |
| Melody marked softer than accompaniment | 93 bars, the most frequent flag in every case |
| Range, bar length, part length, coverage, mud, unison | 0 (one bad bar in one Twinkle run) |

What this suggests, to be tested rather than assumed: the structural checks
(length, range, coverage) now hold; the open problems are melody accuracy in
the carriers, chord fit in accompaniment, written dynamics, and the plan's
own harmony (the item already open above).

**Transposition suspects: 6 of 20 transposing parts, 1 confirmed by hand.**
The metric flags a suspect, not an error (see TRANSPOSED_OK_MIN in
eval/score.js). Read bar by bar:
- Elise English Horn r2: bars 14-17 are written at CONCERT pitch (`C E A`
  over Am, `E G# B` over E7, 100% fit unshifted), bar 13 correctly. The old
  defect, back in an F part, even with written-pitch chords in its prompt.
  Unverified hypothesis: the ENSEMBLE SO FAR grid lists finished parts in
  sounding note names, and the English Horn was written right after the Oboe.
- Elise English Horn r1: 3 bars only, one of each outcome. Not evidence.
- Ode French Horn (both runs): a tie, 56% = 56%. Not evidence.
- Ode Clarinet (both runs): correct reading best, but 44-45%, under the 45%
  bar: poor chord fit, not a transposition error. Note that the no-context
  verification runs of this same part fit at 78-88%. Whether ensemble context
  lowers transposing parts' chord fit: tested next.

### Context A/B on transposing parts (`eval/runs/noctx`, 2026-09-27)

Ode and Elise, 2 repeats each, `--no-context`, against the baseline's same
cases (context on). Engine code identical (56d0c61 changed only eval/).
Criteria written down BEFORE the run: "context hurts transposing parts" is
supported only if the Ode Clarinet's correct-reading chord fit is higher in
both no-context runs than in both baseline runs, AND the no-context runs
have fewer transposition suspects in total.

| | Context on | Context off |
|---|---|---|
| Ode Clarinet, chord fit read correctly | 44%, 45% | 54%, 63% |
| Ode French Horn | 56%, 58% (ties) | 75%, 61% |
| Elise English Horn | 53%, 45% (r2 partly at concert pitch) | 53%, 89% |
| Transposition suspects, 4 runs | 6 | 0 |

**Supported, at n = 2 per side.** The report's own rule (ranges must not
overlap) also calls context-off better on Elise off-chord bars (14.0% vs
6.7%), Ode dynamics (11 vs 6.5 flagged bars) and suspects in both cases.
Caveats, all real:
- Each run makes its own plan, so the two sides are not on the same plans.
  The one "worse" verdict, Ode's plan tune-off-its-chords (0% vs 7.8%), is a
  plan property that context cannot touch: it measures how much plans vary.
- Melody mismatch was higher with context off (Ode 0% vs 12.5%, Elise 8.3%
  vs 22.9%), within spread, so not a verdict, but it points the other way:
  context may help melody carriers while hurting transposing accompaniment.
- The mechanism is still a hypothesis: the ENSEMBLE SO FAR grid lists other
  parts in SOUNDING note names, which a transposing part can copy at concert
  pitch (the Elise English Horn r2 bars match that). Not yet tested directly.

### Written-pitch grid for transposing parts (`eval/runs/writtenctx`, 2026-09-27)

Built (fe1feec): a transposing part now sees ENSEMBLE SO FAR, tune included,
as it would WRITE it (shifted by its written interval, octave included,
spelled in its key signature's direction), matching its written-pitch
chords. Other parts' prompts are byte-identical. Criteria were fixed in that
commit's message before the run; all three are met, so the fix stays.

| Ode + Elise, 4 runs each | Old grid | No context | Written-pitch grid |
|---|---|---|---|
| Ode Clarinet, chord fit read correctly | 44%, 45% | 54%, 63% | 62%, 79% |
| Ode French Horn | 56%, 58% | 75%, 61% | 89%, 80% |
| Transposition suspects | 6 | 0 | 0 |
| Accompaniment off-chord | 16.2% | 13.3% | 7.4% |
| Melody clashes per 100 part-bars | 5.1 | 4.9 | 0.6 |
| Melody mismatch | 4 of 112 | 19 of 112 | 10 of 106 |

Against the old grid the report calls it better on off-chord bars (both
cases), melody clashes (Ode), dynamics (Elise) and suspects (both). Three
"worse": two are the plan's tune off its own chords, which the plan decides
before any part is written, so plan-to-plan variance, not this change. The
third is real and open: **Ode melody mismatch 0% vs 3-12%** (the Clarinet
slipping a semitone in 4 melody bars, Violin 1 in 1). No-context runs slipped
too (12.5%), so the baseline's 0% may be luck; n = 2 cannot say. Watch it.

**A pipeline bug found by this run (fixed).** One English Horn part shipped
as 24 bars of rests. Its first attempt was real music with 8 bars half an
eighth short (which the bar repair pads) and some low notes; the repair
retry returned nothing usable. `isBetterAttempt` counted structural problems
per MESSAGE, so the empty retry ("you wrote 0 measures": 1) beat the real
attempt (8 short bars) and silence shipped. A wrong length now counts once
per measure to pad or cut (`lengthOff`), so that retry scores 24 and loses.
The first such case in 118 saved parts; the grid change did not cause it.
The scorer also now counts an all-rests part as missing, not as clean.

### Paired runs, and the melody in written pitch (2026-09-27)

Two measurement changes first (9652351). `--plans-from` reruns only the parts
on another label's saved plans, so an A/B shares melody, chords and roles;
fresh plans vary enough to swamp small effects. And the scorer now checks
melody bars by SOUNDING PITCH as well as by intervals: the interval check
cannot see a tune played at the wrong transposition. (It also corrected a
claim above: the legacy Ode Clarinet's bar 20 was right, not missed.)

All numbers below share the baseline's 12 plans: "baseline" (10a45ae),
"head" (9652351: written-pitch grid + the retry fix), "melodywritten"
(27f3524: the melody handed to transposing parts in written pitch too).

| Same 12 plans | baseline | head | melodywritten |
|---|---|---|---|
| Transposing parts' melody bars wrong (either check) | 15/136, 11.0% | 43/136, 31.6% | 14/136, 10.3% |
| Other parts' melody bars wrong (the control, see below) | 3.9% | 2.6% | 3.3% |
| Transposition suspects | 6 | 2 | 1 |
| Accompaniment off-chord | 9.8% | 7.8% | 6.4% |

**Correction to the written-pitch grid's verdict above.** Measured on only
Ode and Elise with fresh plans, it looked like a clean win. Paired across all
6 cases it more than doubled transposing parts' melody errors (11.0% to
31.6%; Twinkle's Flugelhorn 9 of its bars, Rowboat's Clarinet 2 bars at the
wrong pitch that intervals pass). Likely mechanism: the grid and chords came
in written pitch while the melody still came at concert pitch with orders to
transpose, a mixed prompt. The melody change was measured against criteria
committed before its run (27f3524's message): transposing melody errors fell
21.3 points against a 0.7-point change in the other parts, guards held.
**Kept.** (That control is not pure noise, as the criteria called it: the
other parts' own prompt text is unchanged, but with context on they also see
the transposing parts' new output in their grid. Either way it moved 0.7.) But read the
net honestly: against the original baseline, transposing melody accuracy is
back to where it was (11.0% to 10.3%), not better; the gains that remain are
transposition suspects (6 to 1), off-chord bars (9.8% to 6.4%) and melody
clashes (Ode 7.8 to 0.3, Twinkle 3.8 to 0.8 per 100 part-bars).

**Open, all seen against the baseline on the same plans:**
- "Melody drowned by dynamics" worse in 3 of 6 cases (Ode 11 to 13.5,
  Rowboat 11.5 to 17, Twinkle 6 to 11), already present in "head". Not a
  target of any change here; the mechanism is unknown. The grid never showed
  dynamics, before or after.
- Twinkle: muddy low voicings 0 to 1-3.
- Ode melody mismatch 0% to 3-12% (the item recorded above).
- The retry prompt's melody messages now quote written pitch for transposing
  parts (the check reads the written melody; verdicts are identical, 59 saved
  parts), but nothing has checked how often retries fix melody bars.

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
