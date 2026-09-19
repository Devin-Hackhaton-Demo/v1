# AGENTS.md — közös szabályok és a kész DB-réteg használata

Terv és szerződések: `PROJECT_CONTEXT.md` (a §14 tartalmazza a jóváhagyott
v1 eltéréseket). Ez a fájl a gyakorlati tudnivalókat rögzíti.

## Munkamegosztás és branchek

- `main` — közös alap, tartalmazza a kész DB-réteget
- `feat/mcp-server` — MCP-szerver (külön agent építi)
- `codex/munka-2026-09-19` — UI (külön fejlesztő)
- A DB-séma és a `packages/db` a DB-kör tulajdona: sémaigényt közös
  egyeztetéssel, ÚJ migrációs fájllal kell bevinni (lásd lent).

## Parancsok

| Parancs | Mit csinál |
| --- | --- |
| `npm run build` | `packages/db` typecheck + build (tsc) |
| `npm run seed` | Idempotens seed: teszt userek + demo projektek |
| `npm run smoke` | 19 élő ellenőrzés a Supabase DB ellen (RLS, trigger, hash) |
| `npm run db:push` | Új migrációk alkalmazása az élő DB-re |
| `npm run db:types` | Típusgenerálás — Dockert igényel, ezen a gépen nincs! |

Env: `.env` a gyökérben (minta: `.env.example`). `SUPABASE_URL` = https URL;
a Postgres kapcsolat `SUPABASE_DB_URL` (session pooler — a direkt
`db.<ref>.supabase.co` host IPv6-only, erről a hálózatról NEM elérhető).

## A DB-réteg használata (`packages/db`, import: `@demo/db`)

- `createAnonClient()` — RLS-sel védett kliens; bejelentkezett felhasználói
  műveletekhez. UI és minden felhasználó nevében futó hívás ezt használja.
- `createServiceClient()` — RLS-t megkerüli. KIZÁRÓLAG szerveroldali
  folyamatban (MCP-szerver backend, worker, seed). Soha nem kerülhet UI
  bundle-be vagy kliens felé kiadott kódba.
- Helperök: `saveContext`, `getContext`, `listTasks`, `prepareRun`,
  `approveRun`, `uploadArtifact`/`downloadArtifact` (SHA-256 ellenőrzéssel),
  `listProjects`, `createProject`, `addMember`. Új adatelérési igényt ide
  (helper) tegyél, ne inline query-ként — ez a közös konzisztencia-réteg.

## DB-szabályok, amiket a séma kikényszerít (ne kerüld meg!)

- `context_entries.revision`-t trigger tölti ki és lépteti a projekt
  revíziót atomikusan — kliensről beküldött revision értéket felülír.
- `context_entries` és `decisions` IMMUTÁBILIS (a service role-nak is);
  javítás új bejegyzéssel + `supersedes_decision_ids`-szel.
- Kliensről (authenticated) `runs`/`external_actions` csak
  `awaiting_approval` állapotban szúrható be; minden állapotátmenet
  service role-lal történik (worker/API).
- Approvalt csak owner hozhat létre; nincs modellnek kiadható "approve"
  művelet (PROJECT_CONTEXT.md §7).
- Artifact bájtok: privát `artifacts` Storage bucket,
  `project_id/artifact_id/fájlnév` útvonalon; limitek: 1 MiB/fájl (DB
  CHECK), 20 MiB/projekt és 5 fájl/mentés (helper rétegben).

## Sémamódosítás

- MÁR ALKALMAZOTT migrációs fájlt (`supabase/migrations/*.sql`) TILOS
  módosítani — mindig új, időbélyeges fájl + `npm run db:push`.
- Sémaváltozásnál a `packages/db/src/types.ts`-t kézzel kell frissíteni
  (a generátor Dockert igényelne), és a `npm run smoke`-nak zöldnek kell
  maradnia.
- Titok (token, jelszó, kulcs) SOHA nem kerülhet táblába — a
  `connections.secret_ref` csak titoktári hivatkozás.

## Teszthozzáférés

- Userek: `owner@demo.test` (owner @ "Demo projekt"), `member@demo.test`
  (member @ "Demo projekt", owner @ "Zárt projekt"). Jelszó:
  `DEMO_USER_PASSWORD` az `.env`-ben.
- A "Zárt projekt" a jogosultsági negatív tesztekhez van — az
  `owner@demo.test` felől semminek nem szabad látszania belőle.
