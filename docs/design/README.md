# Design-rendszer alap — v0.1

Állapot: tervezet, 2026-09-19. A `PROJECT_CONTEXT.md` 3., 6., 7. és 8. fejezetére épül. Nem tartalmaz alkalmazáskódot; a `tokens.css` referenciaérték-készlet, amelyet az `apps/api` szerveroldali oldalai betölthetnek.

## 1. Hatókör

A rendszer kizárólag az MVP szerveroldali, bejelentkezett oldalaira vonatkozik:

| Oldal | Cél | Fő komponensek |
| --- | --- | --- |
| Bejelentkezés | Auth0 átirányítás indítása | Page shell, primary button |
| Jóváhagyó — helyi run | `run_prepare` eredményének emberi jóváhagyása/elutasítása | Payload-kártya, hash-blokk, státusz-jelvény, approve/reject űrlap |
| Jóváhagyó — GitHub issue | `github_issue_prepare` végleges title/body/repó jóváhagyása | Payload-kártya, előnézet-blokk, approve/reject űrlap |
| Fájlfeltöltés | `POST /v1/projects/{id}/artifacts` | Feltöltő űrlap, limit-tájékoztató, eredmény-kártya |
| Állapot/hiba | 403/404/lejárt approval | Alert, empty state |

Nem tartozik ide: saját chatfelület, dashboard, adminfelület, mobilalkalmazás. A ChatGPT-oldali szövegeket az MCP `content` mező adja, azokra a 7. fejezet copy-szabályai vonatkoznak, vizuális rendszer nem.

## 2. Alapelvek

1. **Bizonyíték előrébb, mint díszítés.** A jóváhagyó azt látja, amit ténylegesen jóváhagy: projekt, művelettípus, `run_id`/`action_id`, `payload_hash`, célpont/preset, `run_at`, lejárat. Ezek soha nem rejthetők összecsukható panelbe.
2. **Nincs GET-mellékhatás.** Egyetlen link, ikon vagy automatikus átirányítás sem hajt végre jóváhagyást. Minden állapotváltoztató elem `<form method="post">` + CSRF token.
3. **Szerveroldali HTML az alap.** Az oldalaknak JavaScript nélkül működniük kell. JS csak progresszív kiegészítés (pl. „hash másolása”).
4. **Állapot mindig látható.** A run/action állapotgép minden állapotának saját, egyértelmű jelvénye van (5. fejezet). Nincs „feldolgozás alatt” általános címke.
5. **Titok soha nem jelenik meg.** Token, PAT, letöltési URL, nyers providerhiba nem kerül HTML-be, sem `title`/`data-*` attribútumba, sem hibaüzenetbe.
6. **Hozzáférhetőség alapból.** WCAG 2.2 AA kontraszt, billentyűzettel bejárható űrlapok, státusz nem csak színnel jelölt (ikon/szöveg is).

## 3. Tokenek

Forrás: `tokens.css`. Az alábbi értékek a CSS custom property-k emberi leírásai.

### 3.1 Szín

Semleges alap + négy szemantikus szín. A világos téma az elsődleges; a sötét téma `prefers-color-scheme` alapján ugyanazokat a szemantikus neveket kapja.

| Token | Világos | Sötét | Használat |
| --- | --- | --- | --- |
| `--color-bg` | `#F7F8FA` | `#0F1115` | Oldalháttér |
| `--color-surface` | `#FFFFFF` | `#181B22` | Kártya, űrlap |
| `--color-surface-muted` | `#EEF0F4` | `#20242D` | Hash-blokk, kód, táblázat fejléc |
| `--color-border` | `#D5D9E2` | `#2E3340` | Keret, elválasztó |
| `--color-text` | `#161A22` | `#E8EAEF` | Törzsszöveg |
| `--color-text-muted` | `#5B6370` | `#9AA3B2` | Másodlagos szöveg, címke |
| `--color-primary` | `#1F4FD8` | `#6C8EFF` | Elsődleges gomb, link, fókusz |
| `--color-success` | `#1B7F4A` | `#4CC38A` | `succeeded`, `done` |
| `--color-warning` | `#B26A00` | `#F2B94B` | `awaiting_approval`, `outcome_unknown` |
| `--color-danger` | `#B3261E` | `#F2837B` | `failed`, `blocked`, reject/revoke |
| `--color-info` | `#0B6E8A` | `#5AC8E8` | `scheduled`, `queued`, `running`, `executing` |

Minden szemantikus színhez tartozik `-bg` (halvány háttér) és `-fg` (előtér) változat a jelvényekhez; a párok kontrasztja legalább 4.5:1.

### 3.2 Tipográfia

| Token | Érték | Használat |
| --- | --- | --- |
| `--font-sans` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | Minden szöveg |
| `--font-mono` | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` | UUID, hash, `run_at`, fájlnév, kód |
| `--text-xs` | 12px / 16px | Címke, jelvény |
| `--text-sm` | 14px / 20px | Másodlagos szöveg, táblázat |
| `--text-md` | 16px / 24px | Törzsszöveg, űrlapmező |
| `--text-lg` | 20px / 28px | Kártya cím |
| `--text-xl` | 28px / 36px | Oldalcím |

Nincs webfont-letöltés: a rendszer-betűkészlet gyorsabb és nem igényel külső hálózatot. Hash és azonosító **mindig** monospace, nem törhető szóközzel, `overflow-wrap: anywhere`.

### 3.3 Térköz, sugár, árnyék

- Térköz-skála (4px alap): `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-6` 24 · `--space-8` 32 · `--space-12` 48.
- Sugár: `--radius-sm` 4px (jelvény, input) · `--radius-md` 8px (kártya, gomb).
- Árnyék: egyetlen finom `--shadow-card`; sötét témában keret helyettesíti.
- Tartalomszélesség: `--content-max` 720px. A jóváhagyó oldal egyoszlopos; nincs reszponzív töréspont-logika a mobilon túl (`< 480px`: teljes szélességű gombok).

## 4. Komponensek

Minden komponens szerveroldali HTML-partial. Az osztálynevek `ds-` előtaggal, BEM-szerű módosítókkal.

### 4.1 Page shell
Fejléc: terméknév, aktuális projekt neve, bejelentkezett felhasználó (Auth0 `name`/`email`), kijelentkezés (POST). Törzs: `main` elem `--content-max` szélességgel. Lábléc: verzió és `request_id` (hibajelentéshez).

### 4.2 Kártya (`ds-card`)
Fehér felület, keret, `--radius-md`, belső térköz `--space-6`. Fejléce cím + opcionális státusz-jelvény jobbra.

### 4.3 Kulcs–érték lista (`ds-kv`)
Kétoszlopos definíciós lista (`<dl>`). Címke `--text-sm` muted, érték `--text-md`. Azonosító/hash értékek `ds-mono` osztályt kapnak. Ez a jóváhagyó oldal magja:

```
Projekt            Demo projekt
Művelet            Helyi futás — draft_brief
Run ID             3f2c…-… (mono, teljes érték)
Kontextus revízió  R2
Snapshot hash      sha256:… (mono, tördelhető)
Payload hash       sha256:… (mono, tördelhető)
Ütemezés (UTC)     2026-09-19T12:34:56Z
Engedély lejár     2026-09-19T13:34:56Z
Próbálkozások      legfeljebb 2
```

### 4.4 Hash-blokk (`ds-hash`)
`--color-surface-muted` háttér, mono, teljes érték látható. Opcionális „Másolás” gomb JS-sel; JS nélkül a szöveg kijelölhető marad. Soha nem rövidítjük csak ellipszisre látható másolható teljes érték nélkül.

### 4.5 Státusz-jelvény (`ds-badge`)
Pirula alak, `--text-xs`, ikon (Unicode vagy inline SVG) + szöveg. Színkulcs az 5. fejezet táblázata szerint. Az állapot gépi neve `title` attribútumban is szerepel (pl. `awaiting_approval`).

### 4.6 Gombok (`ds-btn`)
| Módosító | Használat | Szabály |
| --- | --- | --- |
| `--primary` | Jóváhagyás | Csak `<form method="post">` submitként; szöveg pontosan megnevezi a műveletet: „Futás jóváhagyása”, „Issue létrehozásának jóváhagyása” |
| `--danger` | Elutasítás / visszavonás | Külön form, külön CSRF token; nem lehet az elsődleges gomb mellett azonos súlyú |
| `--secondary` | Vissza, mégse, másolás | Nincs mellékhatása |

Minimum érintési méret 44×44px. Fókuszgyűrű `--color-primary` 2px outline + 2px offset. Letiltott állapot csak akkor, ha a szerver már eldöntötte, hogy a művelet nem végezhető el (pl. lejárt) — ekkor a gomb helyett magyarázó alert jelenik meg.

### 4.7 Űrlap (`ds-field`)
Címke felül, mező, súgószöveg, hibaüzenet a mező alatt (`aria-describedby`). Fájlfeltöltésnél a limitek a mező mellett előre olvashatók: `.txt/.md/.json`, UTF-8, ≤ 1 MiB/fájl, ≤ 5 fájl, ≤ 20 MiB/projekt.

### 4.8 Alert (`ds-alert`)
Négy változat a szemantikus színekkel. Tartalma: rövid cím + egy mondat + opcionálisan hibakód monóban. Nyers providerhiba, stack trace, URL nem kerülhet bele.

### 4.9 Előnézet-blokk (`ds-preview`)
GitHub issue jóváhagyáshoz: célrepó (`owner/repo`), title, teljes body **nyers Markdownként**, monospace, görgethető, nem renderelt. Az `<!-- context-action: UUID -->` jelölés látható marad, mert az is a jóváhagyott tartalom része.

### 4.10 Ellenőrzés-lista (`ds-checks`)
Run eredményéhez: determinisztikus ellenőrzések sorai (H1 cím egyezik · lista-elemszám · marker jelen · nincs tiltott fájl), soronként ✓/✗ ikon + szöveg + a mért érték.

### 4.11 Üres állapot (`ds-empty`)
Központosított rövid szöveg + egy másodlagos gomb. Használat: nincs jogosultság (`NOT_FOUND` — nem fedjük fel, hogy létezik-e), lejárt link, nincs feltöltött fájl.

## 5. Állapot → megjelenés

### 5.1 Helyi run (`runs.state`)

| Állapot | Szín | Címke | Jóváhagyó oldalon elérhető művelet |
| --- | --- | --- | --- |
| `awaiting_approval` | warning | Jóváhagyásra vár | Jóváhagyás · Elutasítás |
| `scheduled` | info | Ütemezve (UTC időpont) | Visszavonás |
| `queued` | info | Sorban | Visszavonás |
| `running` | info | Fut (attempt N/2, runner utoljára látva) | — |
| `succeeded` | success | Sikeres | Artifact megtekintése, ellenőrzés-lista |
| `failed` | danger | Sikertelen | Hibakód + biztonságos üzenet |
| `cancelled` | neutral | Visszavonva | — |
| `blocked` | danger | Blokkolva (engedély lejárt) | Új előkészítés szükséges — magyarázat |

### 5.2 GitHub-művelet (`external_actions.state`)

| Állapot | Szín | Címke | Művelet |
| --- | --- | --- | --- |
| `awaiting_approval` | warning | Jóváhagyásra vár | Jóváhagyás · Elutasítás |
| `queued` | info | Sorban | Visszavonás |
| `executing` | info | Végrehajtás alatt | — |
| `succeeded` | success | Létrehozva (#szám, link) | Issue megnyitása (külső link, `rel="noopener"`) |
| `failed` | danger | Sikertelen | Hibakód |
| `outcome_unknown` | warning | Eredmény bizonytalan | Magyarázat: nincs automatikus ismétlés, emberi egyeztetés |
| `cancelled` | neutral | Visszavonva | — |
| `blocked` | danger | Blokkolva | Magyarázat |

### 5.3 Feladat (`tasks.status`)
`open` neutral · `running` info · `done` success · `blocked` danger.

## 6. Hibakód → felhasználói szöveg

A 6. fejezet hibakódjai a szerveroldali oldalakon így jelennek meg (a kód monóban, a szöveg mellett):

| Kód | Alert | Szöveg |
| --- | --- | --- |
| `UNAUTHENTICATED` | info | Jelentkezz be a folytatáshoz. |
| `NOT_FOUND` / `FORBIDDEN` | neutral empty state | Ez az elem nem érhető el ezzel a fiókkal. |
| `VALIDATION_ERROR` | danger (mezőnél) | A megadott érték nem megfelelő. (+ mezőspecifikus mondat) |
| `REVISION_CONFLICT` | warning | A projekt közben változott. Frissítsd az oldalt. |
| `APPROVAL_REQUIRED` | warning | Ehhez a művelethez owner jóváhagyás kell. |
| `APPROVAL_EXPIRED` | danger | Az engedély lejárt. Új előkészítés szükséges. |
| `INVALID_STATE` | warning | A művelet ebben az állapotban nem végezhető el. |
| `LIMIT_EXCEEDED` | danger | A fájl vagy a projekt túllépi a limitet. (+ konkrét limit) |
| `SECRET_DETECTED` | danger | A tartalom titoknak látszó mintát tartalmaz, ezért nem tároltuk. |
| `FILE_UNAVAILABLE` | danger | A fájl nem tölthető le vagy sérült. |
| `PROVIDER_ERROR` | danger | Külső szolgáltatás hibája. Próbáld újra később. |
| `OUTCOME_UNKNOWN` | warning | A művelet eredménye bizonytalan; nem ismételjük automatikusan. |

A `SECRET_DETECTED` üzenet soha nem idézi vissza az észlelt értéket vagy annak részletét.

## 7. Copy-irányelvek

- Magyar, tegező, rövid mondatok. Gombfelirat = ige + tárgy („Futás jóváhagyása”), nem „OK”/„Igen”.
- Időpont mindig ISO 8601 UTC monóban, mellette opcionálisan relatív („12 perc múlva”). A relatív érték csak kiegészítés.
- Az állapot gépi neve nem fordítás nélkül jelenik meg főszövegben, de `title`/`code` elemben elérhető.
- Nem használunk sürgető vagy „sötét” mintát: nincs előre bejelölt jóváhagyás, nincs visszaszámláló gombon, nincs eltérő méretű „Elutasítás”.
- A jóváhagyó oldal nem állítja, hogy „sikerült” — csak azt, hogy „jóváhagyva; a végrehajtás a workernél/runnernél sorban”.

## 8. Hozzáférhetőség

- Kontraszt: szöveg ≥ 4.5:1, jelvény háttér/előtér ≥ 4.5:1, keret ≥ 3:1.
- Minden űrlapmezőnek `<label for>`; hibák `aria-live="polite"` régióban.
- Státusz-jelvény: szín + ikon + szöveg; a `title` a gépi név.
- Fókusz sorrend: kártya tartalom → Elutasítás → Jóváhagyás (az elsődleges az utolsó, hogy véletlen Enter ne hagyjon jóvá űrlapmező-fókuszból; a submit gomb `type="submit"` csak az approve formban).
- Nincs automatikus frissítés vagy átirányítás időzítőre a jóváhagyó oldalon.

## 9. Nyitott tételek

- Ikonkészlet: Unicode vs. inline SVG — döntés implementációkor, függőség nélkül.
- Sötét téma: tokenek megvannak, vizuális ellenőrzés még nem történt.
- Auth0 hosztolt bejelentkezési oldal színezése nem része ennek a rendszernek; alapértelmezett Auth0 UI elfogadott az MVP-ben.
- A ChatGPT-oldali `content` szövegek sablonjai (siker/hiba rövid összefoglaló) külön dokumentumban készülnek, ha a contracts csomag rögzíti a válaszformát.
