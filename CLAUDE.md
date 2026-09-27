# OrchestraAI — working notes for Claude

`README.md` has the architecture and setup. `ENGINE_NOTES.md` has the musical
judgment calls, why each one was made, and what is and isn't claimed — **read
it before changing anything in the generation or validation path.** It is the
memory of this project; keep it current when you change behaviour there.

`HANDOFF.md` is stale (last touched 2026-07-23, and its "repo is local-only,
not pushed" line is no longer true). Treat it as history, not current state.

## Commands

```bash
npm test                  # 131 tests, all pure/offline. Must stay green.
npm run dev               # Vite (5173) + API (3001)
npm run build
```

Live API runs cost real money and need `server/.env`. Before trusting one, see
the port-3001 caveat under "Environment" below.

## Invariants — do not break these

- **Library/corpus melodies are consumed verbatim.** For a work from
  `data/scores`, music21/OpenScore, Open Hymnal, or a user import, the LLM
  never writes, recalls, or "corrects" melody notes — it only plans
  orchestration. `/api/blueprint` overwrites the plan's `melodyAbc` with the
  real data unconditionally. This is the accuracy guarantee the product sells.
- **A requested length is never truncated to the source melody's length.**
  `extendLibraryMelody` composes real additional material instead.
- **Duration is computed in exactly one place**: `scanMeasure` in
  `server/lib/abcMelody.js`. `measureUnits`, `tokenizeMeasure`, and the bar
  repair all read from it. Three parsers once drifted apart and left the
  chunked retry path broken for a month; do not add a fourth.
- **Bar repair is asymmetric.** `repairPartBars` fits accompaniment bars but
  never rewrites a bar where the part carries the melody, and never trims a
  tuplet bar. Rewriting those alters the tune (or orphans the group) and
  manufactures a validation failure on a part that had none.
- **Validation failures are surfaced, never silently swallowed.** A part that
  was padded, trimmed, or left wrong tells the user so, with a Regenerate hint.

## Conventions

- **No em dashes in user-facing copy.** Applies to UI text and to warning
  strings the server sends to the client. Prompt text and `console.warn` server
  logs are exempt — the user never sees them.
- **The visual design is deliberate** (dark indigo + gold, Cormorant Garamond
  headings, Libre Baskerville body). It has been revised once on purpose; don't
  swap the palette or fonts without an explicit request.
- Claims in `ENGINE_NOTES.md` are deliberately hedged and evidence-backed.
  Keep that style: state what is checkable, name the residuals, don't
  over-claim.

## Environment

The repo sits in a OneDrive-synced folder on Windows. Two consequences:

- OneDrive's sync fires spurious `fs.watch` events, so `node --watch` (used by
  `npm run dev`) restarts at random and can kill an in-flight request. For a
  verification run, start the API with plain `node index.js` from `server/`.
- A stale server on port 3001 answers the health check, so a failed
  `EADDRINUSE` launch looks fine while requests silently hit OLD code. Kill
  listeners and confirm the PID is yours before trusting any live A/B run.
