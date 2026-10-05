# Architecture

- [Overview](#overview)
- [Components](#components)
- [Data flow](#data-flow)
- [Storage layout](#storage-layout)
- [Compact tournament format](#compact-tournament-format)
- [REST API](#rest-api)
- [Settings](#settings)
- [Security model](#security-model)
- [External services](#external-services)

## Overview

MTG Stats is built around one constraint: it must run on ordinary shared WordPress hosting. Those hosts have short
PHP time limits, no cron you can rely on, and often blocked or rate-limited outbound requests. The design therefore
splits the work three ways:

| Where | What |
|---|---|
| **Administrator's browser** | Downloads tournaments, detects archetypes, builds the compact JSON |
| **WordPress (PHP)** | Validates and stores JSON files, proxies Melee requests, renders the shortcode |
| **Visitor's browser** | Loads static JSON and computes every statistic on the fly |

The server never parses decklists or runs statistics, and visitors never touch third-party services.

## Components

```
mtgstats/
├── mtgstats.php          WordPress glue: storage, REST API, Melee proxy, shortcode, admin page
├── languages/            Italian translation of the PHP strings (mtgstats-it_IT.po / .mo)
└── assets/
    ├── i18n.js           Translations for the dashboard and the admin panel (English source, Italian dictionary)
    ├── core.js           Archetype parser, rule loader, cache client, compact format, base statistics, CSV export
    ├── melee.js          Direct melee.gg importer (pages + DataTables endpoints)
    ├── advanced.js       Positioning, trends, variants, card impact, player rating model
    ├── viewer.js/.css    Public dashboard (SVG charts, tabs, tables, archetype profile, theme adaptation)
    └── admin.js/.css     Admin panel (import, review, rules, preview)
```

The JavaScript files are UMD modules: in the browser they attach `MTGStatsI18n`, `MTGStatsCore`, `MTGStatsMelee`
and `MTGStatsAdvanced` to `window`, and in Node `require()` works. Dependencies run one way:
`i18n ← core ← melee`, `core ← advanced ← viewer ← admin`. There is no build step and no runtime dependency.

Scripts are registered in `register_assets()`. WordPress enqueues `viewer.js` and its dependencies only on pages
that contain the shortcode, and `admin.js` only on the plugin's admin page. Each asset's version string is the
plugin version followed by the file's modification time (`?ver=1.0.0.<mtime>`). Browsers and caching plugins
therefore pick up updated files right after an upgrade, even when the plugin version number does not change.

## Data flow

### Import from the cache

```
admin.js
  ├─ GitHub API: list Tournaments/<source>/<year>/<month>   (2 calls: month dir, then its tree)
  ├─ raw.githubusercontent.com: download the event JSON
  ├─ core.compactFromCache()          → compact tournament (no archetypes yet)
  ├─ getBundle(format)                → uploads/mtgstats/rules/<format>.json if newer than 7 days,
  │                                     otherwise MTGOFormatData via GitHub, then POST /rules/<format>
  ├─ core.enrichColorsFromScryfall()  → colors of cards missing from card_colors.json
  ├─ core.classifyTournament()        → archetype, colors and method per player
  └─ POST /mtgstats/v1/tournaments    → t/<id>.json + index.json entry
```

### Direct Melee import

`melee.importTournament()` uses the same endpoints as the public tournament page on melee.gg:

1. `GET /Tournament/View/{id}`: event name, date, and the round IDs from the pairings round selector.
2. `POST /Match/GetRoundMatches/{roundId}` for every round, paged 500 at a time: competitors, game wins, declared
   deck names, and the format of each match.
3. `POST /Standing/GetRoundStandings` (`roundId=`): Swiss standings of the last round that has them.
4. Optionally, `GET /Decklist/View/{guid}` for every decklist, 4 requests at a time. Lists are read from the
   page's hidden `<pre id="decklist-text">` block.

All four requests go through the plugin's proxy. The result is reshaped into the cache format, so it reuses
`compactFromCache()`. The format of each round is the most common match format in that round. Rounds whose
format differs from the event's main format are marked `ex: 1`.

### Viewing

`viewer.js` fetches `index.json`, filters it by format and period, then fetches the selected `t/<id>.json` files and
keeps them in memory. On every change of selection it recomputes the player rows with `playerRows()`. Expensive
results (equilibrium, variants, the rating model) are memoized until the selection changes. File URLs carry
`?v=<index.updated>`, which busts caches after each import.

**Theme adaptation.** The dashboard sets no font and no text color: it inherits both from the page. At start-up,
`viewer.js` walks up from the shortcode container to the first opaque background:

- that color becomes `--mtgs-page`, used for the sticky bar, popovers and the side panel;
- its luminance decides light or dark mode when `theme="auto"`;
- if no element declares a background, the page is treated as white, which is what the browser paints. The only
  exception is a page that opts into a dark `color-scheme` while the visitor's system is in dark mode. The visitor's
  dark-mode setting alone never darkens the dashboard on a light site;
- the accent color comes from `data-accent`, then the theme's `--wp--preset--color--primary` (or `accent`). It is
  discarded when its contrast with the page is too low.

Greys, lines and tinted surfaces are derived from `currentColor` with `color-mix()`, so they suit any palette:

| Token | Mix of the text color | Used for |
|---|---|---|
| `--mtgs-fg-2` | 84% | secondary text, chart values |
| `--mtgs-fg-3` | 70% | captions, axis labels, notes |
| `--mtgs-line` | 18% | borders, grid lines |
| `--mtgs-line-strong` | 32% | control borders, muted bars |
| `--mtgs-fill` / `--mtgs-fill-2` | 5% / 11% | section backgrounds, hover and segmented controls |

On a dark page the same percentages move the greys toward the light text color, so contrast stays the same in both
modes. To make the greys darker or lighter, change these six values in `viewer.css`. Every
selector in `viewer.css` is prefixed with `.mtgs`, and a scoped reset neutralizes the theme's global rules for
buttons, lists and tables.

**URL state.** The first dashboard on a page mirrors its view in the URL fragment, for example
`#tab=mu&format=Modern&days=30&arch=Broodscale`. The supported keys are `tab`, `format`, `days`, `ev`
(event IDs), `top` (top cut excluded), `arch` (open profile) and `card` (archetype on the Cards tab). The
fragment is written with `history.replaceState`, so the back button is not flooded, and it is read again on
`hashchange`. Per-visitor preferences, such as the matrix size or the trend metric, are kept in `localStorage`.

**Language.** The shortcode writes `data-lang` from its `lang` attribute or, by default, from the site locale
(`determine_locale()`): `it` for `it_*` locales, `en` otherwise. The admin panel uses the user's admin language
(`get_user_locale()`). `i18n.js` translates by English source text (`t('Copy link')`) with `{placeholder}`
substitution; numbers and dates use `Intl` with `en-US` or `it-IT`. All dashboards on a page share the language of
the first one. PHP strings go through the `mtgstats` text domain.

**Archetype profile.** A modal side panel (`role="dialog"`), appended to the dashboard container. It traps focus
while open, closes on Esc or on a backdrop click, and returns focus to the element that opened it. On narrow
screens it becomes a bottom sheet.

## Storage layout

```
wp-content/uploads/mtgstats/
├── index.json            Catalog of stored tournaments (read by the dashboard)
├── t/<id>.json           One compact tournament per file
├── rules/<format>.json   Cached rule bundle (archetypes, fallbacks, card colors) per format
├── index.php             Empty files that block directory listing
└── .lock                 Lock file for index updates
```

Writes are atomic: each file is written to `*.tmp`, then renamed. Index updates take an exclusive `flock`.

### `index.json`

```json
{
  "updated": "2026-10-05T18:08:20+00:00",
  "tournaments": [
    {
      "id": "melee-gg-405590-2026-09-05",
      "name": "Magic Spotlight: The Hobbit™ - SCG CON Dallas - Saturday - 9:00 am",
      "date": "2026-09-05",
      "format": "Modern",
      "source": "melee.gg",
      "uri": "https://melee.gg/Tournament/View/405590",
      "players": 932,
      "unknown": 23,
      "file": "t/melee-gg-405590-2026-09-05.json",
      "saved": "2026-10-05T18:08:20+00:00"
    }
  ]
}
```

## Compact tournament format

Card names are stored once and referenced by index, and player and match data use arrays. A 932-player event
shrinks from 3.3 MB (cache format) to about 480 KB.

```jsonc
{
  "v": 1,                                   // format version
  "id": "melee-gg-405590-2026-09-05",       // [a-z0-9-], 3–140 chars
  "name": "…", "date": "YYYY-MM-DD", "format": "Modern",
  "source": "melee.gg", "uri": "https://melee.gg/Tournament/View/405590",
  "cards": ["Forest", "Eldrazi Temple", "…"],
  "players": [
    {
      "n": "Player Name",
      "a": "Broodscale",          // archetype
      "col": "G",                 // detected colors (WUBRG letters or "C")
      "m": "rule",                // method: rule | variant | fallback | conflict | unknown | nolist | declared | manual
      "cand": ["A", "B"],         // candidates, only for conflicts
      "dn": "Mono-Green Broodscale", // declared deck name (direct Melee import)
      "rank": 1, "w": 15, "l": 3, "d": 0, "pts": 45,   // final standings (if published)
      "res": "5-0",               // raw result string when no standings exist
      "mb": [[0, 5], [1, 4]],     // main deck: [card index, quantity]
      "sb": [[42, 2]],            // sideboard
      "u": "https://melee.gg/Decklist/View/…"
    }
  ],
  "rounds": [
    {
      "name": "Round 1",
      "fmt": "Modern",            // format played in that round (direct import)
      "ex": 1,                    // excluded from statistics (optional)
      "m": [[0, 17, 2, 1, 0]]     // [player1 index, player2 index or -1 for a bye, games1, games2, game draws]
    }
  ],
  "arch": { "folder": "Modern", "at": "2026-10-05T18:05:11Z" }   // rules used for the last classification
}
```

Records are recomputed from `rounds` whenever pairings exist (see [methodology](methodology.md#records-and-win-rates)).
The `w/l/d/rank` fields are used for standings-only events and for Top N conversion.

## REST API

Namespace: `/wp-json/mtgstats/v1`. Every route requires the `manage_options` capability and a valid `wp_rest`
nonce, sent in the `X-WP-Nonce` header. Public data is served as static files, not through the API.

| Method | Route | Body | Effect |
|---|---|---|---|
| `GET` | `/settings` | — | Current settings |
| `POST` | `/settings` | settings JSON | Validates and saves the settings |
| `POST` | `/tournaments` | compact tournament JSON | Writes `t/<id>.json` and upserts the index entry |
| `DELETE` | `/tournaments/<id>` | — | Deletes the file and the index entry |
| `POST` | `/rules/<format>` | rule bundle JSON | Caches the rule bundle |
| `POST` | `/melee` | `{ "method": "GET"\|"POST", "path": "…", "body": "…" }` | Proxies one request to melee.gg; returns `{ status, body }` |

## Settings

Stored in the `mtgstats_settings` option (not autoloaded):

```json
{
  "aliases": { "Simic Birthing Ritual": "Simic Ritual" },
  "customRules": [ { "Name": "…", "Format": "Modern", "IncludeColorInName": false, "Conditions": [ … ] } ],
  "conflict": "simpler",
  "prior": 10,
  "accent": "#2a78d6"
}
```

The admin panel uses `aliases`, `customRules` and `conflict` at classification time, so they are not needed by the
dashboard. `prior` and `accent` (empty = use the theme's color) are the defaults for the shortcode's `data-prior` and
`data-accent` attributes.

## Security model

- **Writes are admin-only.** Every REST route checks `current_user_can('manage_options')`, and WordPress checks the
  nonce.
- **Path safety.** Tournament IDs must match `^[a-z0-9][a-z0-9-]{2,139}$`, and rule bundle names are reduced to
  `[A-Za-z0-9_-]`. This rules out path traversal from either.
- **Stored fields are sanitized.** `name`, `format` and `source` go through `sanitize_text_field`. `uri` goes through
  `esc_url_raw` restricted to http and https, and the viewer also refuses to link anything else. Shortcode attributes
  are escaped with `esc_attr`, `theme` and `lang` are checked against whitelists and `accent` must be a valid hex color
  (`sanitize_hex_color`).
- **The Melee proxy is not an open proxy.** It only forwards to `https://melee.gg`, and only these paths:
  `/Tournament/View/<digits>`, `/Match/GetRoundMatches/<digits>`, `/Standing/GetRoundStandings` and
  `/Decklist/View/<guid>`.
- **The dashboard renders data as text.** Strings from tournament files are inserted with `textContent`, and
  tooltip HTML escapes every interpolated value. A crafted tournament file cannot inject script.
- **Visitors never call third-party services.** They only load files from the site's uploads folder.

## External services

| Service | Called from | When | Purpose |
|---|---|---|---|
| `api.github.com` | admin browser | listing a month; first import of a format every 7 days | Directory listings (60 requests/hour per IP without authentication) |
| `raw.githubusercontent.com` | admin browser | each import | Tournament files, archetype rules, card colors |
| `api.scryfall.com` | admin browser | import, only for cards with unknown colors | `/cards/collection`, 75 cards per request, 120 ms apart |
| `melee.gg` | WordPress server | direct import only | Tournament pages, pairings, standings, decklists |

See [THIRD-PARTY.md](../THIRD-PARTY.md) for the terms of these sources.
