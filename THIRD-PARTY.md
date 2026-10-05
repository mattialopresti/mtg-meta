# Third-party code, data and services

MTG Stats builds on the work of several community projects and services. Thank you to their authors and maintainers.

## Code

### MTGOArchetypeParser

The archetype detection in [`mtgstats/assets/core.js`](mtgstats/assets/core.js) (`ArchetypeParser`,
`archetypeDisplayName`) is a JavaScript port of
[MTGOArchetypeParser](https://github.com/Badaro/MTGOArchetypeParser), which is distributed under the MIT License:

```
The MIT License (MIT)

Copyright © 2025 Filipe Badaró (Phelps-san)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

## Data downloaded at run time

None of the following data is bundled with the plugin. The administrator's browser, or for Melee the site's server,
downloads it when importing. Its use is subject to each source's own terms.

| Source | What | Maintainers |
|---|---|---|
| [MTGOFormatData](https://github.com/Badaro/MTGOFormatData) | Archetype rules, fallbacks, card colors | Badaro, Jiliac and contributors |
| [MTGODecklistCache](https://github.com/Jiliac/MTGODecklistCache) | Tournament results, pairings and decklists collected from Melee and other sites | Jiliac (fork of Badaro's original) |
| [melee.gg](https://melee.gg) | Public tournament pages (direct import) | Melee |
| [Scryfall API](https://scryfall.com/docs/api) | Colors and types of cards missing from the rule data | Scryfall |

When using these sources:

- **MTGOFormatData and MTGODecklistCache** do not declare a license. They are used as their maintainers intend,
  as input for metagame analysis, and no copy of their data is included in this repository.
- **Scryfall** asks API users to keep request rates reasonable. The plugin sends at most one batch of 75 cards every
  120 ms, and only for cards it cannot find in MTGOFormatData. See the
  [Scryfall API guidelines](https://scryfall.com/docs/api).
- **melee.gg** pages are read the same way a visitor's browser reads them. Requests go out only on an
  administrator's explicit action, at most 4 at a time. Please respect Melee's terms of service when importing.
- **Tournament data includes player names** as published by the organizers. If you publish statistics, honor any
  removal request from a player.

## Trademarks

Magic: The Gathering, its card names and its mana symbols are property of Wizards of the Coast LLC.

MTG Stats is unofficial Fan Content permitted under the
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). It is not approved or endorsed by
Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
