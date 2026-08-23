# OrchestraAI

Search a song → pick your exact ensemble → get AI-generated sheet music, one
coherent ABC part per instrument, rendered with [abcjs](https://www.abcjs.net/).

## Architecture

**Blueprint-first generation** keeps the arrangement coherent:

1. **`POST /api/blueprint`** — one call produces the canonical `melodyAbc`
   (single-line, concert pitch), one `chord` per measure, section assignments,
   and a per-instrument role map.
2. **`POST /api/part`** — per-instrument calls that each *receive* the canonical
   melody + chords. For measures a part carries the melody, the server injects
   the **exact per-measure notes** so the tune is reproduced, not reinvented.
   Other measures harmonize the chords and stay out of the melody register.

The Anthropic API key lives **only** on the server (`server/.env`). The browser
talks to `/api/*`; it never sees the key.

```
src/            Vite + React frontend
  api/client.js   calls the proxy
  components/      SongSearch, OrchestraBuilder, ParamsPanel, ScoreView, ...
  lib/             constants (instruments, theme), abc helpers
server/         Express proxy + prompt construction
  index.js         routes + rate limiting
  prompts.js       search / blueprint / part prompts (melody logic)
  lib/abcMelody.js per-measure melody slicing
```

## Setup

Requires Node 18+.

```bash
# 1. install frontend + backend deps
npm run setup

# 2. add your Anthropic key
cp server/.env.example server/.env
#   then edit server/.env and set ANTHROPIC_API_KEY

# 3. run both (frontend :5173, proxy :3001)
npm run dev
```

Open http://localhost:5173.

### Config

`server/.env`:

| var                 | default                    | purpose                                      |
| ------------------- | --------------------------- | -------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                            | required; never commit it                    |
| `MODEL`             | `claude-opus-4-8`            | model used for composition (blueprint/parts) |
| `RETRIEVAL_MODEL`   | `claude-sonnet-5`            | cheaper model for search + ground-truth lookup |
| `FRONTEND_ORIGIN`   | `http://localhost:5173`      | CORS is locked to this — **must** be the real deployed frontend URL in production, or the deployed frontend gets blocked (see Deployment below) |
| `PORT`              | `3001`                       | proxy port (Vite dev proxies here; hosts like Render inject this themselves — do not set it manually, and don't set it in `render.yaml`) |

`VITE_API_BASE_URL` (frontend build-time, set in the Vercel project settings —
not in `server/.env`): the deployed Render backend's base URL, e.g.
`https://orchestra-ai-backend-xxxx.onrender.com`. Left unset, it defaults to
`""` and the frontend calls relative `/api/*` paths, which is what local dev
wants (Vite proxies those to `:3001`). Set in production so the browser makes
real cross-origin requests to Render — this is what makes `FRONTEND_ORIGIN`
CORS enforcement on the backend actually take effect; a proxy/rewrite
approach would make those requests same-origin from Vercel's edge and the
CORS check would never see a real browser `Origin` to compare against.

## Deployment

Two separate services — frontend (Vercel) and backend (Render) — talking
to each other as genuine cross-origin requests, so the backend's CORS
allowlist (`FRONTEND_ORIGIN`) is a real, browser-enforced control and not
just a config value that happens to be unused. Config lives at the repo
root: `render.yaml` for the backend.

**Do this in order** — each step needs a URL from the previous one:

1. **Deploy the backend to Render.** Connect this repo; Render reads
   `render.yaml` (a "Blueprint") and configures the service automatically —
   root dir `server/`, `npm install`, `npm start`, free plan. In the Render
   dashboard, set the secret env vars it prompts for: `ANTHROPIC_API_KEY`
   (your key) and `FRONTEND_ORIGIN` (leave a placeholder for now — you'll
   come back to this in step 3). Note the resulting URL, e.g.
   `https://orchestra-ai-backend-xxxx.onrender.com`.
   - Free-tier caveat: the service sleeps after inactivity and cold-starts
     slowly on the next request — expect a slow first generation after idle.
   - `NODE_ENV=production` is set by `render.yaml`, which means
     `/api/import` (score upload) is disabled from the moment this deploys —
     expected, not a bug (see "Known gaps" below).
2. **Deploy the frontend to Vercel.** Import this repo; Vercel auto-detects
   the Vite app (build `npm run build`, output `dist/`). Before or during
   this step, set the project env var `VITE_API_BASE_URL` to the Render URL
   from step 1 (Vercel dashboard → Settings → Environment Variables — it
   must be set at build time, since Vite bakes `VITE_*` vars into the
   built JS, not read at runtime). Note the resulting Vercel URL, e.g.
   `https://your-app.vercel.app`.
3. **Close the loop.** Back in the Render dashboard, set `FRONTEND_ORIGIN`
   to the real Vercel URL from step 2 and redeploy the backend. Until this
   is set correctly, the backend's CORS check rejects every request from
   the deployed frontend (the app will look broken, not insecure — that's
   the intended fail-closed direction).
4. **Rotate the API key** if it was ever pasted into a chat session or
   committed — check before going further, not after.

Known gaps before this should be treated as a real public deployment (not
hidden — see `ENGINE_NOTES.md`): no bot/abuse gate beyond a per-IP,
per-minute rate limit (no daily quota, no CAPTCHA yet), and `/api/import`
(score upload) is deliberately disabled whenever `NODE_ENV=production`
until that gate exists.

## Known limitations

Song "search" is the model's knowledge, not a licensed catalog — very new or
obscure songs may be missing or approximate. Generated melodies are
reconstructions from model memory. Copyright/licensing is out of scope for this
prototype (private/personal use).
