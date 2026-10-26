=== MTG Stats ===
Contributors: mattialopresti
Tags: magic the gathering, mtg, metagame, tournament, statistics
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.10.2026.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Metagame analytics for Magic: The Gathering tournaments. Import events from Melee, detect archetypes automatically, publish an interactive dashboard.

== Description ==

MTG Stats turns Melee tournament results into a metagame dashboard on your site.

* Import events from MTGODecklistCache (melee.gg, MTGO, CardsRealm; browse by month, bulk import) or directly from a melee.gg URL.
* Archetypes are detected from decklists with the community rules of MTGOFormatData (a port of MTGOArchetypeParser).
* Supplementary rules for recent archetypes, house rules with a visual editor and a test on saved tournaments, aliases and manual overrides.
* Dashboard tabs: metagame share and smoothed win rates; matchup matrix (observed or Bayesian); expected win rate against a field and equilibrium metagame; trends; Day 2 / Top N conversion; average decklist, variants and card impact; players and a deck-or-pilot model; CSV export.
* Archetype profile in a side panel, shareable links, and a design that follows your theme's font, colors and light/dark mode.
* Charts are plain SVG, with no external libraries. Visitors only download static JSON from your uploads folder.

The dashboard and the admin panel are in English and Italian, following the site language.

Documentation: https://github.com/mattialopresti/mtg-meta

== Installation ==

1. Upload the plugin zip from Plugins > Add New > Upload Plugin, then activate it.
2. Open MTG Stats in the admin menu and import some tournaments.
3. Add the [mtgstats] shortcode to a page.

Shortcode attributes: format, days, tournaments, tabs (meta, mu, pos, trend, conv, cards, players, data), theme (auto, light, dark), accent, prior, lang (en, it).

== External services ==

This plugin connects to third-party services only when an administrator imports tournaments from the plugin's admin page. The site's visitors never contact them.

* GitHub (api.github.com, raw.githubusercontent.com): lists and downloads tournament files from the public MTGODecklistCache and MTG_decklistcache repositories and archetype rules from MTGOFormatData. Requests come from the administrator's browser. Terms: https://docs.github.com/site-policy/github-terms/github-terms-of-service - Privacy: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement
* Scryfall (api.scryfall.com): sends the names of cards whose colors are unknown, to retrieve their colors, and, in the rule editor, the card names being typed, for suggestions and spelling checks. Requests come from the administrator's browser. Terms: https://scryfall.com/docs/terms - Privacy: https://scryfall.com/docs/privacy
* Melee (melee.gg): downloads public tournament pages, pairings, standings and decklists when the administrator uses the direct import. Requests come from the site's server. Terms: https://melee.gg/Policy/Terms - Privacy: https://melee.gg/Policy/Privacy

== Frequently Asked Questions ==

= Where is the data stored? =

In wp-content/uploads/mtgstats/: index.json, one JSON file per tournament, and a cache of archetype rules.

= A deck is classified wrongly. =

Fix it on the tournament's review page, add an alias or a house rule in "Archetypes and rules", then reclassify. Rules that are wrong for everyone should be fixed upstream in MTGOFormatData.

== Changelog ==

= 1.10.2026.1 =
* Supplementary rules for archetypes missing from the community rules (e.g. Jund Sacrifice and Boros Dwarves in Standard).
* House rules: visual editor with Scryfall suggestions, test on saved tournaments, list with status and errors, archetype catalog per format.
* Select-all checkboxes and bulk actions for imported and saved tournaments.
* New formats: Duel Commander, Centurion, Limited; Premodern is no longer detected as Modern.
* Fixed: house rules that silently matched nothing.

= 1.10.26 =
* New cache sources: MTGO (from the fbettega/MTG_decklistcache fork), plus the topdeck.gg and Manatraders archives.
* Fixed: MTGO Challenges, which publish only the top 8 pairings, take player records from the standings.

= 1.0.0 =
* First public release.

== Disclaimer ==

MTG Stats is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
