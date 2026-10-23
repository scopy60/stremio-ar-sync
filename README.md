# Arabic Auto-Sync Subtitles (Stremio addon)

Fetches Arabic + English subtitles from SubDL by IMDb id, re-times the Arabic file to match
the English one (offset + frame-rate correction by matching cue start times), and serves it to
Stremio as **Arabic [Auto-Synced]**.

## Deploy on Render
1. Push this repo to GitHub.
2. Render → New → Blueprint (uses `render.yaml`) or New → Web Service (build `npm install`, start `npm start`, Free plan).
3. Set env var `SUBDL_API_KEY` to your SubDL API key.
4. In Stremio → Addons, paste `https://<your-service>.onrender.com/manifest.json`.

Routes: `/`, `/health`, `/manifest.json`, `/subtitles/:type/:id(.json|/:extra.json)`, `/srt/:id.srt`.
