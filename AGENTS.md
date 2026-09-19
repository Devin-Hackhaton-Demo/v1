# MCP fejlesztési szabályok

- Az aktuális scope helyi MCP-szerverváz: `apps/api` és `packages/contracts`. UI, adatbázis, OAuth és üzleti MCP-eszközök külön jóváhagyott körben készülnek.
- A `PROJECT_CONTEXT.md` a teljes célrendszer terve, nem a jelenlegi implementáció bizonyítéka.
- npm workspaces, ESM TypeScript, Fastify és a hivatalos MCP SDK v2 használatos. A contracts csomag a fordított `dist` fájlokat exportálja.
- A manifest Node >=24-et kér; a helyi ellenőrzés Node 26.0.0 és npm 11.12.1 alatt történt.
- Függőségek: `npm ci --ignore-scripts`. Új közvetlen függőséget pontos, legalább hét napja kiadott verzióval rögzíts; tartsd meg a lockfile-t.
- Kötelező ellenőrzés: `npm run check` — típusellenőrzés, Node tesztfuttató és build. Audit: `npm audit`.
- Fejlesztés: `npm run dev`. A contracts csomag induláskor fordul; contracts-módosítás után indítsd újra, vagy futtasd az `npm run build -w @demo/contracts` parancsot.
- Fordított futtatás: `npm run build`, majd `npm start`. A belépési pont kezeli a `SIGINT` és `SIGTERM` jeleket; a watcher leállítását külön kezeli a tsx.
- Konfiguráció környezeti változókból: `HOST` csak `127.0.0.1`; `PORT` alapértéke 3000; `NODE_ENV` csak `development` vagy `test`; `LOG_LEVEL` alapértéke `info`. Nincs automatikus dotenv-betöltés.
- A `/health` csak folyamat-életjelet ad. A `/mcp` kizárólag a csak olvasó `server_info` diagnosztikai eszközt publikálja; nincs adattárolás vagy külső művelet.
- A Host/Origin-ellenőrzés, szerveroldali kérésazonosító, kérésméret-korlát és tisztított hibák/naplók kötelezők. Payloadot, URL-paramétert, tokent, cookie-t és nyers hibát ne naplózz.
- Ne olvasd be a `.env`-et. Ne érintsd a párhuzamosan dolgozó agent munkakönyvtárát vagy Git-indexét. Ez az MCP-munka független helyi klónban történik.
- A `source` remote a másik agent helyi repójára mutat, nem publikálási cél. A commitolt DB-alap integrációja külön feladat; push és deploy csak kifejezett kérésre történhet.
