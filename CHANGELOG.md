# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From 1.26.3, versions read
**major.year.release**: 1.26.3 is the third release of 2026 (after 1.10.26 and 1.10.2026.1).

## Unreleased

### Fixed
- Nightly import: when Scryfall answers "too many requests" (the GitHub runners share their IP addresses), the
  importer waits and tries again, up to three times, instead of skipping the colors of the newest cards.
- Nightly import: network errors ("fetch failed") are retried three times, with pauses of 5, 15 and 45 seconds, and
  the log now names the cause (refused connection, timeout, DNS, certificate).
- Nightly import: the workflow uses actions/checkout and actions/setup-node v5 on Node 24 (Node 20 is deprecated on
  GitHub runners).
- Nightly import: four daily runs (00:30, 06:30, 12:30, 18:45 UTC). GitHub can delay or skip scheduled runs, and
  some hosting firewalls drop part of the GitHub runners' addresses; each run catches up on what was missed.
- Nightly import: when the site cannot be reached, the log lists the addresses tried and the runner's public
  address, to report to the host.

## [1.26.3] - 2026-10-27

### Deck focus
- New **Deck focus** tab in the admin panel. A focus gathers the lists that play a deck's key cards across the
  archetypes the rules give them, and splits them into versions defined with the house-rule editor (ordered, first
  match wins). It ships with an Omnath (Modern) preset: Ritual, Paradox / W6 and Elementals. **Test on saved
  tournaments** shows the lists each version takes.
- `[mtgstats focus="<id>"]` adds the focus tab to the dashboard, first in line. It shows:
  - which version to play against the chosen field, with the probability of being the best choice;
  - the best version against each of the most played archetypes;
  - per version: average list, the cards gaining ground in the last 21 days (new ones marked), variants, card impact
    and best results;
  - each version's share over time;
  - groups among the lists that match no version.
- MTGO League events (5-0 lists only) feed the focus lists but not its win rates, shares and matchups.

### Scheduled import
- `tools/sync.js`: headless importer (Node 18+, no dependencies) that reuses `core.js`, the site's house rules and
  aliases, and saves events through the REST API with a WordPress Application Password.
- `.github/workflows/sync.yml` runs it every night. Formats, sources, look-back window, events per run and leagues are
  configurable; it supports a dry run, and it is skipped when the site address is not configured.
- New REST route `GET /mtgstats/v1/status` (admin only): plugin version, data and assets URLs.

### Other
- `Core.ruleSelector()`: ordered rules, first match wins, reused by the focus versions.
- `Adv.expectedVsField()` can return the raw simulations (`keepSims`).
- Node tests for the new functions: `node --test`.
- When only one version has enough matches to be compared, the focus says so instead of calling it the best choice
  in 100% of the simulations.

## [1.10.2026.1] - 2026-10-26

### Archetype detection
- Supplementary rules shipped with the plugin (`assets/rules-extra.json`) for archetypes missing from the community
  rules, found in September-October 2026 events. They apply only when no community rule matches. Examples: Jund
  Sacrifice, Boros Dwarves, Dimir Uldaros, Izzet Fling and Azorius Artifacts (Standard); Devoted Combo, Affinity, Loki,
  Hollow One and Esper Ketramose (Modern); Tempo variants and Mystic Forge Combo (Legacy); Jeskai Lurrus, Natural Order
  and Midrange (Vintage); Sacrifice and Control (Pioneer); Pestilence (Pauper). On those events, the share of decks
  unrecognized or matched only by similarity dropped from 39.6% to 20.7% in Standard and from 12.7% to 2.7% in Modern.
- New formats: Duel Commander, Centurion and Limited. The event name refines the source's format, so a Duel Commander
  event filed as Commander, or a Premodern event (detected as Modern before), gets the right format.
- In formats without community rules, house and supplementary rules now apply before the declared deck names.

### House rules (formerly custom rules)
- Visual editor: archetype name, format, color prefix and conditions in plain words, with Scryfall card suggestions and
  spelling checks. Pasting a list adds one card per line.
- **Test on saved tournaments** shows which decks a rule takes and how they are classified now.
- List of saved house rules with format, definition and status (active, off, ignored because of errors, with the
  errors), plus switch on/off, edit and delete. Import from JSON files, download as JSON, and a JSON editor for bulk
  changes and variants.
- Archetype catalog per format: house, community, supplementary and similarity archetypes with their definitions and
  the date of the community rules, a search by archetype or card, **Update community rules now**, and **Customize** to
  start a house rule from any archetype.
- After saving rules or aliases, the panel offers to reclassify the saved tournaments.

### Admin
- Select-all checkboxes in the import list and in the saved tournaments, which can also be filtered by name and
  format. Saved tournaments are reclassified or deleted in bulk.

### Fixed
- House rules that silently matched nothing: condition types are accepted in any letter case, card names ignore case,
  accents and the back face of double-faced cards, and a single-card condition with several cards now requires all of
  them instead of only the first. Invalid rules are shown with their errors instead of being dropped.
- House rule names written with spaces, hyphens or digits ("Mono-Green Devotion") are displayed as written.
- The server no longer discards incomplete house rules without telling, and keeps only the rule fields.

## [1.10.26] - 2026-10-25

### Import
- New cache sources: MTGO (from the fbettega/MTG_decklistcache fork, which still collects it), plus the topdeck.gg
  and Manatraders archives.
- MTGO events published twice under different links are listed once, dated by the cache folder.

### Fixed
- Events whose only rounds are the top cut (MTGO Challenges) take records from the standings, minus any excluded
  round. Before, players outside the top 8 counted as 0-0.

## [1.0.0] - 2026-10-05

First public release.

### Import
- Import from MTGODecklistCache: browse by month, filter by name or format, bulk import.
- Direct import from melee.gg through an admin-only, path-restricted proxy. Rounds played in a different format,
  such as Pro Tour drafts, are excluded automatically.
- Compact storage in `wp-content/uploads/mtgstats/`. Visitors only download static JSON.

### Archetype detection
- JavaScript port of MTGOArchetypeParser using the MTGOFormatData rules.
- Scryfall color lookup for cards too new to be in the rules.
- Aliases, custom rules, conflict handling, per-player manual overrides and re-classification.

### Dashboard
- Tabs:
  - **Metagame**;
  - **Matchups**, observed or Bayesian, with clear-cut matchups flagged;
  - **Positioning**: expected win rate against a field, equilibrium metagame;
  - **Trends**;
  - **Conversion**, including the shift from all players to Day 2 to Top 8;
  - **Cards**: average list, automatic variants, card impact;
  - **Players**: leaderboard and a player + deck rating model;
  - **Data**: CSV export.
- Archetype profile in a side panel, reachable from every chart, table and matrix.
- Shareable views: tab, format, period, events and open archetype are kept in the URL.
- Adapts to the host theme: inherited font and text color, light or dark detected from the page, accent color from
  the theme, the settings or the shortcode.
- Sticky filter bar with segmented period control, searchable event picker and removable filter chips.
- One-line descriptions with an ⓘ button for full explanations; skeleton loading; empty states with actions.
- Keyboard and touch support, focus management in dialogs, reduced-motion support.
- English and Italian interface (dashboard, admin panel and server messages), following the site language or the
  `lang` shortcode attribute, with localized number and date formatting.

[1.26.3]: https://github.com/mattialopresti/mtg-meta/releases/tag/v1.26.3
[1.10.2026.1]: https://github.com/mattialopresti/mtg-meta/releases/tag/v1.10.2026.1
[1.10.26]: https://github.com/mattialopresti/mtg-meta/releases/tag/v1.10.26
[1.0.0]: https://github.com/mattialopresti/mtg-meta/releases/tag/v1.0.0
