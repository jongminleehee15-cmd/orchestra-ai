# OrchestraAI — Work Hand-off (resume point)

> **For the next Claude session / account.** This documents everything built so
> far, the one open blocker, and exactly where to resume. Read this together
> with `README.md` (setup) and the original project brief. The user's stated
> priority is **melody accuracy across all generated parts** — keep that the
> north star.

Last worked: 2026-07-01. Repo is local-only (git initialized, not pushed).

---

## 1. TL;DR — current state

The original Claude.ai artifact (`OrchestraAI.jsx`, a 900-line single file) has
been turned into a **real, runnable Vite + React app with an Express proxy**.
**Phase 1 is complete** — the model-ID blocker is resolved and the full flow was
verified live against the real API (see §2).

| Phase 1 step | Status |
| --- | --- |
| 1. Scaffold Vite + React + Express, single repo, `git init` | ✅ done, committed |
| 2. Port artifact into `src/` component structure | ✅ done |
| 3. Build API proxy (key server-side, headers, rate limit) | ✅ done |
| 4. Replace abcjs CDN hack with npm import | ✅ done |
| 5. Verify full flow end-to-end (search→blueprint→parts) | ✅ **done — verified live 2026-07-01** |

**First melody-accuracy improvement is already in** (see §5): melody-carrying
parts now receive the **exact per-measure notes** of the canonical melody, not
just a prose "play the melody" instruction. This was confirmed empirically in the
step-5 verification below.

---

## 2. ✅ RESOLVED — model-ID 404 (was the open blocker)

**Was:** generating anything threw `Anthropic API 404: model: claude-sonnet-4-20250514`
— that model string was not available to this API account.

**Fix applied (2026-07-01):** set `MODEL=claude-opus-4-8` (Opus 4.8 — chosen for
the melody-accuracy north star). Changed in three places so it's consistent and
nobody hits the stale default again:
- `server/.env` (live secret file — Opus 4.8)
- `server/config.js` default (`process.env.MODEL || "claude-opus-4-8"`)
- `server/.env.example` template

To switch models later, edit **only** `server/.env` (`MODEL=<id>`) and restart
the server — `config.js` reads `process.env.MODEL`. The `node --watch` dev runner
does **not** reload on `.env` edits: kill node and re-run `npm run dev`. Valid IDs
per the `claude-api` skill: `claude-opus-4-8` (current), `claude-sonnet-4-6`
(cheaper), `claude-haiku-4-5` (cheapest). **Do not** append date suffixes.

**Step-5 live verification (2026-07-01, String Quartet, 8 measures, "Ode to Joy"):**
- `GET /api/health` → `{ok:true, model:"claude-opus-4-8", hasKey:true}`
- `POST /api/blueprint` → 200. `instrumentRoles` correctly keyed to the exact 4
  requested instruments; `melodyAbc` was a correct, recognizable Ode to Joy line.
- `POST /api/part` (Violin I, the melody carrier for mm.1-4) → 200. The returned
  ABC **reproduced the canonical melody note-for-note** in its melody measures
  (`F2 F2 G2 A2 | A2 G2 F2 E2 | D2 D2 E2 F2 | F3 E E4`), and switched to a higher
  descant in mm.5-8 where its role was countermelody, not main tune. The
  melody-accuracy injection (§5) works as designed.
- Cello (bass role) → 200, played chord roots (D, A) in bass clef.

> ⚠️ **Test-harness gotcha (not an app bug):** `buildBlueprintPrompt` expects
> `instruments` as an array of `{name, count}` objects (see `prompts.js:37`). A
> manual test that sends plain strings makes `i.name` undefined and the model
> invents a generic ensemble (Flute/Clarinet appeared). The real client
> (`App.jsx:71`) sends `{name, count}`, so this only bites ad-hoc curl tests —
> mirror the `{name, count}` shape when testing by hand.

> **Node note (dev machine):** `node` is installed at
> `C:\Program Files\nodejs\node.exe` but was **not on PATH** in the Git Bash /
> PowerShell sessions used here (installed after the shells launched). `npm run
> dev` from a fresh terminal works; if a shell can't find `node`, open a new one
> or call the full path.

---

## 3. How to run (fresh machine)

Prereqs: **Node 18+** (this machine used Node 24.18.0, installed via
`winget install OpenJS.NodeJS.LTS`). Git Bash + PowerShell both available on the
dev machine (Windows 11).

```bash
npm run setup          # installs root (frontend) + server deps
cp server/.env.example server/.env
#   then edit server/.env: set ANTHROPIC_API_KEY and a valid MODEL (see §2)
npm run dev            # frontend :5173, proxy :3001 (concurrently)
```

Open http://localhost:5173. Health check: `GET http://localhost:3001/api/health`
returns `{ ok, model, hasKey }`.

> **Windows note:** if `npm install` warns about blocked install scripts
> (esbuild postinstall), run `npm approve-scripts esbuild`. Already approved in
> the committed `package.json` (`allowScripts` field).

---

## 4. Architecture (do NOT refactor this away)

**Blueprint-first generation** is the heart of the app and must be preserved:

1. **`POST /api/blueprint`** — ONE call produces the single source of truth:
   - `melodyAbc` — canonical main melody, single ABC line, concert pitch, `L:1/8`
   - `chords` — one chord symbol per measure
   - `sections` — which instrument carries melody in which measures
   - `instrumentRoles` — per-instrument role + `melodySections` + instruction
2. **`POST /api/part`** (once per instrument) — each call **receives** the
   canonical melody + chords. Melody carriers reproduce that exact tune; non-melody
   parts harmonize the chords and stay out of the melody register.
3. If the blueprint call fails, parts fall back to independent generation
   (graceful degradation) — `planStatus === "error"` path in the UI.

**The API key lives only on the server.** The browser calls `/api/*`; Vite
proxies `/api` → `localhost:3001` in dev (`vite.config.js`). Prompt construction
also lives server-side (`server/prompts.js`) so melody logic is centralized.

---

## 5. Melody-accuracy work (the user's priority)

### What's done
`server/lib/abcMelody.js` slices the canonical `melodyAbc` into per-measure
chunks. When building a part prompt (`server/prompts.js → buildPartPrompt`), for
every range in that instrument's `melodySections` we inject the **exact notes
for each measure** under an `EXACT MELODY YOU MUST PLAY` block:

```
EXACT MELODY YOU MUST PLAY (reproduce these pitches/rhythms, transposed only to fit your range):
mm.1-8:
  measure 1: C2 D2 E2 F2
  measure 2: G4 G4
  ...
```

This replaces the prototype's weaker "play the shared melody transposed"
instruction. The blueprint prompt also now requires that every instrument's
`melodySections` **tile all measures with no gaps/overlaps** and that each
measure's durations sum to a full bar.

### Where to take it next (ideas, unverified — needs real output first)
- **Verify empirically:** generate a quartet, read each part's ABC, check that
  melody-carrier measures actually match `melodyAbc` (transposed). This is step 5
  and hasn't run yet because of §2.
- **Programmatic transposition:** the model is asked to transpose by ear, which
  drifts. Consider transposing the canonical melody to each instrument's octave
  in code (abcjs supports visual transpose; or compute octave shift from
  clef/range) and injecting the already-transposed notes.
- **Post-generation validation:** parse each returned part with abcjs, compare
  melody measures against the canonical pitches, and auto-retry/repair on
  mismatch. Surfaces as part of Phase 2 item 9 (better error states).
- **Measure-count enforcement:** validate the part has exactly `measures` bars
  before accepting it.

---

## 6. File map

```
package.json            frontend deps + scripts (dev/build/setup); allowScripts:esbuild
vite.config.js          /api → localhost:3001 dev proxy
index.html              Vite entry
README.md               setup + architecture
HANDOFF.md              this file

src/
  main.jsx              React root
  index.css             global reset + keyframes (pulse/spin) + scrollbar; design palette
  App.jsx               TOP-LEVEL STATE: song, ensemble, params, melodyPlan, scoreParts;
                        tabs; calls api/client; owns generatePart/generateAll/initScore
  api/client.js         postJson → /api/search, /api/blueprint, /api/part (NO key here)
  lib/
    constants.js        INSTRUMENT_GROUPS, ENSEMBLE_PRESETS, STYLES, DENSITIES, INSTR_META,
                        groupColor/genreColor, design tokens S, SERIF
    abcHelpers.js       buildLeadSheetAbc (wrap melody body in headers), buildScoreAbc
  components/
    SongSearchPanel.jsx search box + results grid + suggestions
    SongCard.jsx        one search result card
    OrchestraBuilder.jsx presets + instrument browser + "your orchestra" list
    ParamsPanel.jsx     style/density/tempo/measures/notes + summary + generate button
    ScoreView.jsx       score tab: lead-sheet render, plan status, part list, download .abc
    PartCard.jsx        one instrument row: status, generate/retry, ABC render, source
    AbcRenderer.jsx     abcjs.renderAbc wrapper (npm import — no CDN)
    ui.jsx              shared SecH / Chip / NavBtn / inputStyle

server/
  index.js              express app, rate limit (30/min/IP), 64kb body cap,
                        routes /api/health /api/search /api/blueprint /api/part, cleanAbc
  config.js             MODEL, ANTHROPIC_API_KEY, PORT, tokensForMeasures (from env)
  anthropic.js          callAnthropic (adds x-api-key, anthropic-version), extractJson
  prompts.js            buildSearchPrompt / buildBlueprintPrompt / buildPartPrompt
  lib/
    abcMelody.js        splitMelodyIntoMeasures, parseMeasureRange, sliceMelody,
                        buildMelodyExcerpts  ← melody-accuracy core
    instrMeta.js        clef per instrument (strips "Trumpet 2"→"Trumpet"), guardrails
    transpose.js        conventionalKey + writtenKeyFor: circle-of-fifths key math
                        for transposing instruments (B♭/F/E♭)  ← read-key core
  .env.example          template (ANTHROPIC_API_KEY, MODEL, PORT)
  .env                  REAL secrets, gitignored — NOT in repo, recreate on new machine
```

---

## 6b. Design system (preserve — do not swap for default look)
Dark warm bg `#0d0b08`, surfaces `#181410`/`#201c14`, border `#2c2418`,
gold `#c8a050` (dim `#7a6030`), text `#ece0c8`, muted `#9a8868`. Palatino serif
throughout. Sheet music on cream paper `#fffef8`. Instrument-family color coding
in `groupColor()`. Tokens centralized in `src/lib/constants.js` (`S`, `SERIF`).

---

## 7. Remaining work (from the brief)

**Phase 1:** ✅ complete (blocker resolved + end-to-end verified — see §2).
Next natural step: browser smoke test of the actual UI (`npm run dev`, open
http://localhost:5173, run a String Quartet through search → generate → render)
to confirm the abcjs rendering path, not just the API responses.

**Phase 2 — pre-launch hardening:**
- Rate limit + body cap → ✅ already on the proxy (revisit limits before deploy)
- Manual song entry fallback (type title/key/time/BPM when search misses)
- localStorage persistence of ensemble/params/arrangements (now allowed)
- Better error states (malformed ABC → currently generic; see §5 validation idea)

**Phase 3 — features (in priority order):**
1. ✅ **Audio playback — DONE (2026-07-10).** `src/components/AudioPlayer.jsx`:
   a custom-styled play/pause/stop/seek bar over `abcjs.synth.CreateSynth`
   (lazy — the synth + soundfont download happen on first ▶; soundfonts stream
   from abcjs's default CDN so playback needs network; only one player sounds
   at a time via a module-level registry). Wired into: the canonical melody
   (ScoreView), every generated part (PartCard — each part plays with its real
   instrument sound from `INSTR_META.midi` GM programs, and transposing parts
   are shifted back to concert pitch at playback via `INSTR_META.shift`:
   B♭ −2, F −7, alto sax −9; tenor sax −2 because this app writes it only a
   2nd up), and the visual melody editor (hear the edit before "Apply &
   regenerate"). Verified via `npm run build` + `npm test`; audio itself needs
   a manual browser pass.
2. Web-search-enabled song lookup (Anthropic `web_search` tool, server-side, on
   `/api/search`) for recent songs
3. ✅ **Combined full score + ensemble recording — DONE (2026-07-11).**
   `buildFullScoreAbc()` in `src/lib/abcHelpers.js` stacks every finished part
   into ONE multi-voice ABC tune (`%%score` + `V:` per part). Each voice keeps
   its own written key/clef on the page (full-score convention) but carries
   per-voice `%%MIDI program` + `%%MIDI transpose` so playback sounds at
   concert pitch with real instrument sounds — abcjs honors all three per
   voice (probe-verified, and locked in by `server/test/fullScore.test.js`,
   which engraves AND flattens the score through abcjs itself). The "Full
   Score" section in ScoreView appears once ≥2 parts (or a solo's only part)
   are done, updates as more finish, and its AudioPlayer has a **⬇ wav**
   button (`downloadName` prop → `synth.download()`) that saves a recording
   of the whole ensemble. MIDI-file export is still open if ever wanted
   (`abcjs.synth.getMidiFile`).
4. PDF export
5. ✅ **Transposing-instrument support — DONE (2026-07-01).** Each part is now
   written in its correct read key (Trumpet/Clarinet in B♭, Horn/English Horn in
   F, Alto/Tenor Sax in E♭) with a proper K: signature and an "in B♭" label on the
   T: line. Keys are respelled to conventional low-accidental spellings for casual
   players. See `server/lib/transpose.js` (circle-of-fifths key math) and §5.

**Also done 2026-07-12:**
- **Print** — `src/lib/print.js` `printAbc(items, docTitle)`: renders ABC to
  SVG off-screen, opens a white print window (one tune per page, measure
  numbers on, Palatino, @page margins) and calls window.print(). Wired to:
  🖨 on each done PartCard (single part), "🖨 Print parts" in the ScoreView
  header (lead-sheet melody + every finished part — the rehearsal handout),
  and 🖨 Print on the Full Score section. Needs pop-ups allowed (alert says
  so if blocked).

**Also done 2026-07-11 (from user feedback):**
- **Chunked generation for long parts** — a 64-bar single call came back with
  12–20 bars (observed live), so `/api/part` now writes parts longer than 24
  measures in ~16-measure sections (`server/lib/chunking.js`: chunkRanges /
  intersectSections / headerOf / stitchBody, all tested). Each section call
  keeps the FULL context (whole melody, all chords, role) plus the previous
  section's 2-bar tail for seamless voice-leading, and is validated
  individually — measure count (the actual failure mode), melody, range —
  with its own repair retry; `checkPartMelody`/`checkPartRange` grew a
  `measureOffset` param so chunk reports still use piece measure numbers.
  Sections are stitched under one header, 4 bars per line. Live-verified
  (32-bar cello, melody mm.1-8 + 17-24): exactly 32 measures, melody resumes
  note-for-note at the m.17 seam, zero warnings, ~16s for 2 sections.
- **Realistic instrument ranges** — `server/lib/ranges.js`: sounding-pitch
  ranges (hard lo/hi + comfortable core, MIDI numbers) for all 39 catalog
  instruments, converted to each part's WRITTEN pitch via the same shifts the
  prompts use (B♭ +2, F +7, alto sax +9, tenor sax +2 — app convention). The
  part prompt now carries a PLAYABLE RANGE block (absolute limits + comfort
  band + ABC octave-mark reminder + "shift the passage an octave, never clip
  notes"), and `/api/part` validates EVERY note (chord notes included) with
  `checkPartRange`, ±1 semitone slack because the parser ignores key
  signatures. Range + melody problems now share ONE combined repair retry
  (tagged `[melody]`/`[range]` diffs); leftovers surface as `rangeWarnings`
  (red box in PartCard, separate from melody warnings). 7 new tests
  (`server/test/ranges.test.js`) incl. a sanity check that every INSTR_META
  instrument has range data — extend both together.
- **User-settable tempo** — ParamsPanel "Tempo" control (slider 40–208 +
  numeric input clamped 30–240 + live classical term via `tempoTerm()` in
  constants.js + "↺ song default" reset that reappears whenever bpm ≠ the
  song's documented bpm). `setBpm`/`songBpm` are passed from App. bpm already
  flowed into prompts/Q:/playback/duration everywhere, so only the UI was new.

**Also done 2026-07-01 (arranging quality, from user feedback):**
- **Distinct parts for duplicate instruments** — 2 Trumpets now become Trumpet 1
  and Trumpet 2 with complementary roles, not one shared line. `expandVoices()` in
  `src/App.jsx` splits `{name,count}` into numbered voices before the blueprint.
- **Less flat / more musical** — part prompt now demands moving accompaniment
  (arpeggiation, countermelody, passing tones) instead of static held roots,
  variation between repeated sections, a dynamic arc, and no unison doubling of a
  shared instrument. Blueprint requires development across sections.
- **Even melody distribution** — removed the "bass/percussion never melody" ban.
  The blueprint now rotates the melody through ALL instruments (trombone, tuba,
  cello, mallet percussion included), sizes sections by instrument count so the
  tune has room to travel, and shifts the bass to another low voice when a bass
  instrument is featured. Verified: an 8-bar brass quintet gave the trombone the
  melody in mm.5-6. Only truly unpitched perc (Timpani) stays rhythmic.
- **Playing-time estimate** — `estimateDuration()` in `src/lib/constants.js`
  (measures × beats/measure ÷ bpm) shows a live "≈ m:ss" under the Measures
  selector and in the summary in `ParamsPanel.jsx`. Handles compound meters (6/8).
- **Melody accuracy pass** — the from-memory melody used to slip through with
  wrong rhythms (e.g. Ode to Joy came back with every note doubled → overfull
  bars). Now `/api/blueprint` runs `refineMelody()`: a focused verification call
  (`buildMelodyCheckPrompt`) re-checks pitches against the real song + fixes bar
  rhythms, then `analyzeMelody()` in `abcMelody.js` validates every bar sums to the
  meter and the measure count is right, retrying up to 2×. Costs +1–2 Opus calls
  per generation. Verified: Ode to Joy / Twinkle / Mary / Happy Birthday all come
  back correct. Also un-scattered the melody — handoffs are now at PHRASE
  boundaries (≥4 bars, `sectionSize` in `prompts.js`), not 2-bar fragments.
  STILL model-from-memory (no score DB) → obscure/complex songs remain shakier;
  anacrusis/pickup tunes make the bar count n+1 (validator tolerates, best-effort).
  Later tuned to preserve real eighth-note/dotted rhythms (was over-flattening to
  quarters); still can't nail exact per-measure rhythm on invented/extended
  sections — that's what the manual editor below is for.
- **Visual melody editor (the accuracy escape hatch)** — `VisualMelodyEditor.jsx`.
  In Score view, "✎ Edit melody" opens an INTERACTIVE score (not raw ABC — the ABC
  is the hidden data model). Click a note to select → toolbar for pitch ▲▼, octave,
  duration (♪♩♩.𝅗𝅥○), ♯♮♭, delete (→rest), ＋note; or drag a note vertically to
  change pitch. Built on abcjs `clickListener` + `dragging:true` (verified in
  node_modules: callback is `(abcelem, tune, classes, analysis, {step,...}, ev)`
  with `abcelem.startChar/endChar`; up-drag reports negative `step`). Edits mutate
  the ABC at the clicked note's char range via helpers (`shiftPitch`/`setLen`/etc.,
  all unit-tested). Live validation (`src/lib/melodyCheck.js`) + an "⌨ ABC text"
  advanced fallback toggle. "Apply & regenerate all parts" → `applyMelodyEdit()` in
  `App.jsx` overwrites `melodyPlan.melodyAbc` and re-runs every part against the
  user's exact tune (`generatePart(idx, plan)` takes an explicit plan to dodge
  stale state). Note-level accuracy is now user-guaranteed, no ABC knowledge needed.
  NOTE: click/drag UX verified only against the abcjs API + unit tests, not a live
  browser — worth a manual pass.

**Deploy targets:** frontend → Vercel/Netlify; backend → Render/Railway (or
Vercel serverless). Set `ANTHROPIC_API_KEY` in the host dashboard. Point the
frontend's `/api/*` at the deployed backend.

---

## 8. Security / housekeeping
- `server/.env` is gitignored and was **not** committed. On a new account,
  recreate it from `server/.env.example`.
- During this session the API key was pasted into the chat. **Recommend rotating
  that key** at console.anthropic.com and keeping the replacement only in
  `server/.env`.
- Git: one commit so far on the default branch. Nothing pushed to a remote.

---

## 9. Known limitations (by design, not bugs)
- "Search" is model knowledge, not a licensed catalog — new/obscure songs may be
  missing or have approximate key/BPM; melodies are reconstructions from memory.
- Copyright/licensing intentionally out of scope for this prototype phase.
- Long pieces are handled by chunked generation (2026-07-11, see §7): parts
  above 24 measures are written in validated ~16-bar sections, so 64–128
  measure parts now come back full length. Cost scales with length (one model
  call per section, plus per-section repair retries when checks fail).
```

---

## 10. Score library pivot (2026-07-07, branch `feature/score-library`)

**Melody accuracy is now deterministic for public-domain works.** The catalog
in `data/scores/*.abc` (7 starter works: Ode to Joy, Canon in D, Twinkle,
Mary, Frère Jacques, Row Your Boat, Jingle Bells) holds REAL symbolic melody
data with per-measure chords. For these works:

- `/api/search` returns library hits instantly (no LLM, `source:"library"`,
  green "✓ Exact score" badge in the UI; library browses on the search tab).
- `/api/blueprint` + `libraryId` → melody used VERBATIM (`plan.melodyAbc` is
  byte-identical to the score file); the LLM only plans orchestration via
  `buildLibraryBlueprintPrompt`. No refine pass, no web lookup.
- `/api/part` now validates melody measures against the canonical tune
  (rhythm-exact + contour-exact, transposition-invariant —
  `server/lib/partCheck.js`), retries once with precise diffs, and surfaces
  remaining problems as `melodyWarnings` (shown in PartCard).
- `npm test` (15 tests) validates the whole library + the validator. Musical
  judgment calls documented in `ENGINE_NOTES.md`.
- Library curation rules: L:1/8, downbeat start (no anacrusis v1), native key,
  chords annotated per measure. Verified e2e 2026-07-07 (Ode to Joy quartet:
  blueprint byte-identical, Viola part reproduced mm.5-8 note-for-note).

Non-library songs keep the web-ground-truth + refine pipeline (§ commit
5cedd5e). Next steps: grow the catalog, anacrusis support, MusicXML/kern
ingestion behind the same interface.
