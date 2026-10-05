=== MTG Stats ===
Contributors: mattialopresti
Tags: magic the gathering, mtg, metagame, tournament, statistics
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Metagame analytics for Magic: The Gathering tournaments. Import events from Melee, detect archetypes automatically, publish an interactive dashboard.

== Description ==

MTG Stats turns Melee tournament results into a metagame dashboard on your site.

* Import events from MTGODecklistCache (browse by month, bulk import) or directly from a melee.gg URL.
* Archetypes are detected from decklists with the community rules of MTGOFormatData (a port of MTGOArchetypeParser).
* Aliases, custom rules and manual overrides.
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

* GitHub (api.github.com, raw.githubusercontent.com): lists and downloads tournament files from the public MTGODecklistCache repository and archetype rules from MTGOFormatData. Requests come from the administrator's browser. Terms: https://docs.github.com/site-policy/github-terms/github-terms-of-service - Privacy: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement
* Scryfall (api.scryfall.com): sends the names of cards whose colors are unknown, to retrieve their colors. Requests come from the administrator's browser. Terms: https://scryfall.com/docs/terms - Privacy: https://scryfall.com/docs/privacy
* Melee (melee.gg): downloads public tournament pages, pairings, standings and decklists when the administrator uses the direct import. Requests come from the site's server. Terms: https://melee.gg/Policy/Terms - Privacy: https://melee.gg/Policy/Privacy

== Frequently Asked Questions ==

= Where is the data stored? =

In wp-content/uploads/mtgstats/: index.json, one JSON file per tournament, and a cache of archetype rules.

= A deck is classified wrongly. =

Fix it on the tournament's review page, add an alias or a custom rule in "Archetipi e regole", then reclassify. Rules that are wrong for everyone should be fixed upstream in MTGOFormatData.

== Changelog ==

= 1.0.0 =
* First public release.

== Disclaimer ==

MTG Stats is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
