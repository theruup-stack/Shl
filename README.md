# SHL-samlingen

Klubbarnas YouTube-videor, hockeypoddar, Fimpens Resa, SHL-kalender, live-resultat och "Mitt lag" på en sida.

- `public/index.html` – hela sidan (byggs från `build/`)
- `src/worker.js`
  - `/api/schedule` – SHL:s spelschema med live-ställning (cache 20 s)
  - `/api/videos` – senaste videorna från alla 27 YouTube-kanaler via RSS (cache 10 min)
  - `/api/debug`, `/api/vdebug` – felsökning
- `build/` – mall och data (`python3 build/build.py` bygger om sidan)

Deployas automatiskt till Cloudflare Workers vid push till `main` → https://shl.theruup.workers.dev
