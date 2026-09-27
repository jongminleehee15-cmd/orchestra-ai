# Evaluation harness

Measures whether an engine change made arrangements better, worse, or no
different, so changes stop resting on one run each. Read "What it does not
measure" before trusting a number.

## The loop

```bash
# 1. Commit the change you want to measure (generate refuses a dirty tree).
# 2. Check the setup for free: starts its own server, checks health + library.
node eval/generate.mjs --dry-run
# 3. Generate. COSTS MONEY. Without --yes it only prints the plan and call count.
node eval/generate.mjs --label <name> --yes                  # all 6 cases x 2 repeats
node eval/generate.mjs --label <name> --cases canon-baroque-16 --repeats 1 --yes  # a cheap first run
# A change to how PARTS are written: rerun on another label's saved plans, so
# both sides share melody, chords and roles and only the parts differ.
node eval/generate.mjs --label <name> --plans-from <label> --yes
# 4. Score and compare. Offline, free, re-runnable any time.
node eval/report.mjs <baseline-label> <new-label>
# 5. Once in a while, listen blind.
node eval/blind.mjs make <baseline-label> <new-label>
node eval/blind.mjs score eval/blind/<timestamp>
```

`npm run eval:generate -- ...`, `eval:report`, `eval:blind` are the same commands.

## Files

| Path | What |
|---|---|
| `suite.json` | The fixed cases. Add a case with a NEW id; never edit one in place, or old runs stop being comparable. |
| `runs/<label>/<case>-r<n>.json` | Saved runs: `meta` (commit, dirty flag, model, date, context on/off), the plan, every part's ABC and the warnings the server returned. |
| `score.js` | Rescores a run with the checks as they are NOW. Pure; tested in `server/test/evalScore.test.js`. |
| `compare.js` | Repeat aggregation and the A/B verdict rule. |
| `generate.mjs` | Live runs through the real API, one arrangement at a time, as the app makes them. |
| `report.mjs` | Tables per case, plus an A/B summary. |
| `blind.mjs`, `blindAbc.js` | Blind listening pages. Sessions go to `eval/blind/` (git-ignored). |

## Reading a report

- Every count is normalised so a 16-bar and a 32-bar case compare: per 100
  part-bars, or as a % of the bars that could fail (melody bars owed,
  accompaniment bars checked). Lower is always better.
- `better` / `worse` only when the two versions' ranges across repeats do not
  overlap. One run on either side gives `no verdict (n=1)`. LLM output varies a
  lot: Canon's off-chord bars went 5 then 8 on the SAME plan.
- Two melody measures, on purpose: `melody mismatch` compares intervals and
  rhythm (it flags an octave jump inside a bar), `melody wrong pitch` compares
  the sounding notes octave-free (it flags a tune played in the wrong key or
  at the wrong transposition, which intervals cannot see).
- Fresh plans differ run to run. To compare changes to part writing, pair the
  runs with `--plans-from`; plan-level metrics then match by construction.
- There is deliberately no single overall score. A change that fixes chords but
  breaks melodies should look like exactly that.
- `plan: tune off its own chords` scores the plan, not the parts: bars where
  the plan's melody does not fit the plan's chord. The library works score 0
  (a test pins this), so anything above 0 is harmony the model wrote.

## What it does not measure

These checks measure **consistency with the plan**: the right melody, chords
the accompaniment fits, the right length, playable range, no rubbing against
the tune. They cannot tell a dull arrangement from a beautiful one, and they
share the checks' known false alarms (ENGINE_NOTES.md: parallel sixths under
the tune, suspensions). Pair them with the blind listening test, and treat one
listener on a handful of pairs as a direction, not proof.

## Legacy runs

`runs/legacy-noctx` and `runs/legacy-ctx` are the 2026-09-26 runs the notes in
ENGINE_NOTES.md were written from, copied from a temp folder so they are not
lost. They predate this harness: no commit recorded, and they predate the
written-pitch chord fix (and `legacy-noctx` the ensemble context). Use them
as history, not as the baseline for new work. Generate a fresh baseline on a
clean commit first. `meta.note` in each file says exactly what it is.
