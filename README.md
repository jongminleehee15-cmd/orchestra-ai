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

| var                 | default                   | purpose                          |
| ------------------- | ------------------------- | -------------------------------- |
| `ANTHROPIC_API_KEY` | —                         | required; never commit it        |
| `MODEL`             | `claude-sonnet-4-20250514` | model used for all generation    |
| `PORT`              | `3001`                    | proxy port (Vite dev proxies here) |

## Deployment

- **Frontend** → Vercel / Netlify (build: `npm run build`, output `dist/`).
- **Backend** → Render / Railway (`npm --prefix server start`), with
  `ANTHROPIC_API_KEY` set in the host dashboard.
- Point the frontend's `/api/*` at the deployed backend (rewrite or env-based
  base URL).

## Known limitations

Song "search" is the model's knowledge, not a licensed catalog — very new or
obscure songs may be missing or approximate. Generated melodies are
reconstructions from model memory. Copyright/licensing is out of scope for this
prototype (private/personal use).
