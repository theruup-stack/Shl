# SHL-samlingen

Klubbarnas YouTube-videor, hockeypoddar, Fimpens Resa, SHL-kalender och live-resultat på en sida.

- `public/index.html` – hela sidan (byggs från `build/`)
- `src/worker.js` – `/api/schedule` hämtar SHL:s spelschema med live-ställning (cache 20 s), `/api/debug` för felsökning
- `build/` – mall och data (`python3 build/build.py` bygger om sidan)

Deployas automatiskt till Cloudflare Workers vid push till `main`.
