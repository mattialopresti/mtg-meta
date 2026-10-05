# Contributing

Thanks for your interest in MTG Stats! Bug reports, archetype feedback, translations and code are all welcome.

## Reporting a problem

Open an [issue](https://github.com/mattialopresti/mtg-meta/issues) and include:

- the WordPress and PHP versions, the theme, and the browser;
- the tournament URL (Melee or cache path), if the problem concerns an import;
- what you expected and what happened, with any error from the admin log or the browser console.

## Archetype classification

Archetype rules are not part of this repository. They come from
[MTGOFormatData](https://github.com/Badaro/MTGOFormatData). If a deck is misclassified for **everyone**, the fix
belongs there; contribute the rule upstream so every tool that uses it benefits. For a quick fix on your own site,
use aliases or custom rules (see the [user guide](docs/user-guide.md#aliases-and-custom-rules)).

Open an issue here if the plugin classifies a deck **differently from the original parser** with the same rules:
that is a bug in the port.

## Translations

The interface is available in English and Italian. English is the source language:
- **Dashboard and admin panel.** Every string goes through `t('English text', { placeholders })`. The Italian
  translations live in `mtgstats/assets/i18n.js`, keyed by the English text.
- **PHP messages.** These use the WordPress text domain `mtgstats`, with translations in
  `mtgstats/languages/mtgstats-it_IT.po` and the compiled `.mo` file next to it.

To add a language:
1. Add a dictionary next to `IT` in `i18n.js`.
2. Extend `setLang()`, `locale()` and `ordinal()` for it.
3. Map its WordPress locale in `MTGStats_Plugin::language()`.
4. Add the matching `.po` and `.mo` files.

When you add or change a user-facing string, update the Italian translation in the same pull request.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each change focused: one feature or fix per pull request.
3. Follow the code conventions below.
4. Before opening the pull request:
   - check that `php -l mtgstats/mtgstats.php` reports no errors;
   - try the change in a WordPress install, with both a light and a dark theme if it touches the dashboard.
5. If the change affects a statistic, update [docs/methodology.md](docs/methodology.md).
6. Add a line under an "Unreleased" heading in [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree that your contributions are licensed under the project's license (GPL-2.0-or-later).

### Code conventions

- **No build step and no runtime dependencies.** The files in `mtgstats/assets/` are served as they are.
- **Statistics stay pure.** `core.js` and `advanced.js` must not touch the DOM. Anything random uses the seeded
  generator (`MTGStatsAdvanced.rng`), so the dashboard always shows the same numbers for the same data.
- **Untrusted text is inserted as text.** Tournament data (player, deck and event names) goes into the page with
  `textContent` or the `h()` helper, never with `innerHTML`.
- **The dashboard follows the host theme.** Use the CSS custom properties in `viewer.css` (`--mtgs-accent`,
  `--mtgs-fg-2`, `--mtgs-line`, …) rather than fixed colors. The diverging matchup scale is the one intentional
  exception.
- **Components are scoped.** Every selector is prefixed with `.mtgs`, so theme styles do not leak in and plugin
  styles do not leak out.

## Being a good citizen

The plugin relies on services run by volunteers and companies that offer them for free. When testing imports:

- use small events;
- do not run imports in loops;
- keep the existing request pacing: 4 parallel requests to Melee, 120 ms between Scryfall batches.
