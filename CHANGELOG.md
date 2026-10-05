# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/mattialopresti/mtg-meta/releases/tag/v1.0.0
