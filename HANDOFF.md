# OrchestraAI — Work Hand-off (resume point)

> **For the next Claude session / account.** This documents everything built so
> far, the one open blocker, and exactly where to resume. Read this together
> with `README.md` (setup) and the original project brief. The user's stated
> priority is **melody accuracy across all generated parts** — keep that the
> north star.

Last worked: 2026-06-30. Repo is local-only (git initialized, not pushed).

---

## 1. TL;DR — current state

The original Claude.ai artifact (`OrchestraAI.jsx`, a 900-line single file) has
been turned into a **real, runnable Vite + React app with an Express proxy**.
Phase 1 of the brief is essentially complete **except live end-to-end
verification**, which is blocked by a model-ID 404 (see §2).

| Phase 1 step | Status |
| --- | --- |
| 1. Scaffold Vite + React + Express, single repo, `git init` | ✅ done, committed |
| 2. Port artifact into `src/` component structure | ✅ done |
| 3. Build API proxy (key server-side, headers, rate limit) | ✅ done |
| 4. Replace abcjs CDN hack with npm import | ✅ done |
| 5. Verify full flow end-to-end (search→blueprint→parts) | ⛔ **blocked by §2** |

**First melody-accuracy improvement is already in** (see §5): melody-carrying
parts now receive the **exact per-measure notes** of the canonical melody, not
just a prose "play the melody" instruction.

---

## 2. ⛔ OPEN BLOCKER — fix this first

**Symptom:** generating anything throws `Anthropic API 404: model: claude-sonnet-4-20250514`.

**Cause:** the model string inherited from the brief
(`claude-sonnet-4-20250514`) is not available to this API account, so the
Messages API returns 404.

**Fix:** set `MODEL` in `server/.env` to a model ID that the account can access.
Do **not** guess the ID from memory — confirm the current Sonnet model ID from
the `claude-api` skill (run `/claude-api`) or the Anthropic docs/console, then:

```
# server/.env
MODEL=<current-valid-model-id>
```

`MODEL` is already wired as a single server-side config value
(`server/config.js` reads `process.env.MODEL`), so this is the only change
needed. Restart the server afterward (the `node --watch` dev runner does **not**
reload on `.env` edits — kill node and re-run `npm run dev`).

Once generation returns 200, finish Phase 1 step 5: run a small ensemble (String
Quartet, 8 measures) and confirm search → blueprint → per-part generation all
render.

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
    instrMeta.js        clef per instrument, BASS/PERCUSSION guardrail sets
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

**Finish Phase 1:** resolve §2, then verify end-to-end (step 5).

**Phase 2 — pre-launch hardening:**
- Rate limit + body cap → ✅ already on the proxy (revisit limits before deploy)
- Manual song entry fallback (type title/key/time/BPM when search misses)
- localStorage persistence of ensemble/params/arrangements (now allowed)
- Better error states (malformed ABC → currently generic; see §5 validation idea)

**Phase 3 — features (in priority order):**
1. MIDI playback/export via `abcjs.synth` (no new dep)
2. Web-search-enabled song lookup (Anthropic `web_search` tool, server-side, on
   `/api/search`) for recent songs
3. Combined full-score view (all parts stacked, aligned by measure)
4. PDF export
5. Transposing-instrument support (Clarinet/Trumpet B♭, Alto Sax E♭, Horn F) —
   abcjs supports visual transposition

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
- Long pieces (96–128 measures) push token limits; `tokensForMeasures()` scales
  `max_tokens` but quality degrades on very long generations — consider chunked
  generation later.
```
