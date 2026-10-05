# Methodology

This document explains how MTG Stats detects archetypes and computes each statistic on the dashboard. The archetype
logic lives in [`core.js`](../mtgstats/assets/core.js) and the advanced statistics in
[`advanced.js`](../mtgstats/assets/advanced.js). Both are pure functions with no DOM access, so they can be
tested in Node.

- [Archetype detection](#archetype-detection)
- [Records and win rates](#records-and-win-rates)
- [Metagame](#metagame)
- [Matchups](#matchups)
- [Positioning](#positioning)
- [Trends](#trends)
- [Conversion](#conversion)
- [Cards](#cards)
- [Players](#players)
- [Known caveats](#known-caveats)

## Archetype detection

The detector is a faithful port of [MTGOArchetypeParser](https://github.com/Badaro/MTGOArchetypeParser) (C#, MIT),
the engine behind several community metagame reports. It uses the same rule files, from
[MTGOFormatData](https://github.com/Badaro/MTGOFormatData). On the same decklists and the same rules, it gives the
same results as the original.

### Rules

Each archetype is a JSON file with a list of `Conditions`. Every condition must hold for the archetype to match.

| Condition | Holds when |
|---|---|
| `InMainboard` / `InSideboard` / `InMainOrSideboard` | the first listed card is present in that section |
| `OneOrMoreInMainboard` / `…InSideboard` / `…InMainOrSideboard` | at least one listed card is present |
| `TwoOrMoreInMainboard` / `…InSideboard` / `…InMainOrSideboard` | at least two *different* listed cards are present |
| `DoesNotContain` / `DoesNotContainMainboard` / `DoesNotContainSideboard` | the first listed card is absent |

An archetype can have `Variants`, which use the same structure. A variant is tested only when its parent matches,
and the variant's name replaces the parent's.

### Fallbacks

If no rule matches, the deck is compared with each *fallback*: a generic archetype such as Midrange or Control,
defined by a list of common cards. The score is the total number of copies of those common cards in the deck.
The highest score wins, and ties go to the fallback with the shorter card list. Similarity is the score divided by
the number of distinct card entries in the deck. The match is accepted only when similarity is above 0.1;
otherwise the deck is **Unknown**.

### Colors

A color counts only when it appears **both** in a land and in a non-land card, main deck and sideboard included.
This keeps fetch lands and splash cards from adding colors. Card colors come from MTGOFormatData's
`card_colors.json` plus per-format overrides. Double-faced and adventure cards are looked up by their front face.
Cards missing from that file, typically from a set released in the last few days, are looked up on Scryfall
during import:

- lands get their produced mana (W, U, B, R or G);
- other cards get their colors.

When `IncludeColorInName` is true, the color combination is prepended to the name: Azorius, Jund, 5 Color, and so
on. The four-color combinations have no common name and are written as color codes, such as *WBRG Ponza*.

### Conflicts

When several rules match, the plugin keeps the rule with the fewest conditions, counting parent and variant
together. This is the original parser's `PreferSimpler` mode. The other candidates are stored and shown on the
review page. Alternatively, the plugin settings can label the deck `Conflict(A,B)`.

### Customization

The processing order is:
1. **Custom rules** from the plugin settings. When one of them matches, community rules are ignored for that deck.
2. Community rules, then fallbacks.
3. **Aliases** rename the result.
4. If the deck is still Unknown, or has no decklist, the **declared** deck name from Melee is used, when available.
5. **Manual overrides** (method `manual`) are never touched by re-classification.

### Validation

The detector was tested on the 928 decklists of a Modern event with 932 players (Magic Spotlight, SCG CON Dallas,
September 2026):

- 98% of decks received an archetype; 19 were Unknown;
- classification took 25 ms;
- results were then compared with the 877 deck names declared on Melee by the same players.

| Outcome | Decks |
|---|---|
| Identical name | 221 |
| Shares the key word (e.g. *Goryo Reanimator* / *Goryo's Vengeance*) | 495 |
| Different | 161 |

Nearly all the "different" cases are synonyms (*Neobrand* = *Simic Neoform*, *Ponza* = *Land Destruction*). The
genuine misses were brand-new archetypes not yet covered by the rules, which is the case for custom rules. In at
least one case the detector was right and the player had declared the wrong deck.

## Records and win rates

A player's match record is recomputed from the pairings whenever pairings exist. Only standings are used otherwise,
for example in leagues that publish only final records. Recomputing makes the record consistent with the round
filters:

- a match is won by whoever won more games; equal games make a draw;
- byes are ignored;
- rounds flagged as excluded (`ex`, e.g. draft rounds) are ignored;
- when **Exclude top cut** is on, playoff rounds are ignored too. A round counts as playoff when its name contains
  *quarter*, *semi*, *final*, *top N* or *playoff*, or when it has 8 players or fewer.

**Win rate** is always `W / (W + L)`: draws are excluded, as in most metagame reports.

**Smoothed win rate.** With *W* wins and *L* losses and a Beta(α, α) prior, where α = 10 by default (configurable
per site and per shortcode), the posterior is Beta(α + W, α + L). The dashboard shows:

- the posterior **median** as the smoothed win rate;
- the 2.5% and 97.5% quantiles as the 95% credible interval.

Quantiles are computed exactly: the regularized incomplete beta function is evaluated with a continued fraction,
then inverted by bisection. With α = 10, an archetype at 3–0 shows about 57%, while one at 300–200 stays close to
its observed 60%.

## Metagame

- **Share** = players of the archetype / players in the selection.
- **Presence vs win rate** shows archetypes with at least max(3, 1% of players). Dotted lines mark the 50% win rate
  and the median share.

## Matchups

Matchups are counted from pairings, with mirrors excluded. Each cell keeps W-L-D and games won and lost.

**Bayesian estimate.** A cell with few matches should not read 100% or 0%. Each cell gets a prior centered on the
outcome expected from the two archetypes' overall strength, using a Bradley-Terry combination:

```
p0 = sigmoid( logit(WR_A) - logit(WR_B) )        WR = overall smoothed win rate
cell ~ Beta( s·p0 + W,  s·(1 − p0) + L )          s = 6 (prior weight, in matches)
```

The displayed estimate is the posterior mean. The interval runs from the 5% to the 95% quantile, and
`P(favored) = 1 − I₀.₅(a, b)`. A cell is flagged as a **clear-cut matchup** when P(favored) ≥ 95% or ≤ 5%.
Because p0(A,B) = 1 − p0(B,A), the estimated matrix stays consistent: A vs B + B vs A = 100%.

**Draw rate** = draws / matches for archetypes with at least max(10, 1% of matches) matches.

## Positioning

### Expected win rate against a field

For a reference field with shares *fⱼ* (all players, Day 2, Top 8, or the latest event):

```
E[WR_i] = Σⱼ fⱼ · m̂ᵢⱼ  +  f_other · WR_i
```

- m̂ᵢⱼ is the Bayesian matchup estimate (0.5 for the mirror).
- *f_other* is the share of the field outside the top-N archetypes. Against those decks the archetype's overall win
  rate is used.
- The 90% interval comes from 1,000 Monte Carlo draws. Each draw samples every matchup and the overall win rate from
  their Beta posteriors. A seeded generator (mulberry32) keeps the numbers stable between page loads.

### Equilibrium metagame

The estimated matrix defines a symmetric zero-sum game with payoff `P[i][j] = m̂ᵢⱼ − 0.5`. Its Nash equilibrium is a
deck mix *x* that no archetype beats: `(P·x)ᵢ ≤ 0` for every *i*. In plain terms, it is the metagame that this
matchup matrix rewards.

It is computed with multiplicative weights (Hedge) in self-play, for 20,000 iterations with
η = √(8 ln n / T). Because P is antisymmetric, the regret bound guarantees that the **average** strategy is an
ε-equilibrium, with ε ≈ 0.01. Shares below 0.5% are shown as 0.

**Stability** is the share of 60 simulations in which the archetype keeps at least 3% of the mix. In each
simulation the whole matrix is resampled from its posterior and solved again, with 3,000 iterations. A deck at 100%
stability belongs in the mix whatever the matchup uncertainty; one at 20% depends on lucky estimates.

Read the equilibrium as a reading of the matchup matrix, not a forecast. It ignores everything the matrix cannot
see: pilot preferences, card availability, and the next set.

## Trends

Events are grouped by week (Monday to Sunday), by month or by event. *Automatico* picks per-event grouping for up to
8 events, then weekly, then monthly for spans over 75 days. For each period and archetype the dashboard shows:

- share = players / players in the period;
- smoothed win rate, Beta(α + W, α + L) posterior mean, left blank under 5 players;
- **effective number of archetypes** = exp(H), where H = −Σ pₖ ln pₖ is the Shannon entropy of the shares. A value
  of 12 means the metagame is as varied as 12 equally popular decks;
- **top-3 share**.

**Risers and fallers** compare the first half of the periods with the last half. With an odd number of periods,
the middle one is left out. Only archetypes with at least max(5, 1% of players) players appear.

## Conversion

| Target | A player converts when |
|---|---|
| Day 2 | they played the first Day 2 round |
| Top N | their final Swiss rank is ≤ N |
| Winning record | W > L |

The **Day 2 round is detected automatically**. It is the first round, from round 5 on, where the number of players
falls below 75% of the previous round, provided more than 16 players remain and it is not a playoff round.

Conversion intervals use a Beta(1, 1) prior. *Above/below expectations* is converted players minus overall rate ×
starting players.

**Metagame shift** compares shares among all players, Day 2 players and Top 8 players. A stage is shown only when it
has at least 8 players.

## Cards

The same smoothing prior α applies throughout this section.

- **Average copies**: copies of the card / all decklists of the archetype. *Copies when played* divides by the
  lists that include the card instead.
- **Win rate by copies** compares lists playing 0, 1, 2, 3 or 4 copies of the same card. Each group needs at least
  3 lists. Cells are colored on a diverging scale around 50%.

### Average decklist

This follows the "aggregate deck" method. For every card and every count *k*, count the lists that play **at least**
*k* copies. Sort these (card, k) pairs by frequency and take the most common ones until reaching the median main
deck size, then the median sideboard size. The percentage next to each line is the share of lists playing at least
that many copies.

### Variants

Lists of the same archetype are clustered by content:

- **Distance**: weighted Jaccard distance on card counts, `1 − Σ min(qᵃ, qᵇ) / Σ max(qᵃ, qᵇ)`. Sideboard cards
  count half.
- **Clustering**: k-medoids for k = 2…4, with k-means++ seeding, 5 restarts and a seeded generator. At most 500
  lists are used, sampled at random beyond that.
- **Choosing k**: the k with the highest mean silhouette. Every group must hold at least max(3, 5%) of the lists.
  When the best silhouette is below 0.12, the lists are reported as one group with no clear variants.
- **Signature**: the cards whose average copies differ by at least 0.75 between the group and the other lists.
- **Win rate**: smoothed, with a 90% interval. The "typical list" is the group's medoid.

Variants need at least 12 lists.

### Card impact

For each card, both main deck and sideboard, played by at least 5 lists and missing from at least 5, the matches of
the lists with the card are compared with those of the lists without it. The two Beta posteriors are approximated as
normal:

```
diff = mean_with − mean_without          sd = √(var_with + var_without)
95% interval = diff ± 1.96·sd            P(better) = Φ(diff / sd)
```

A card is **credible** when the interval excludes 0. The 20 cards with the largest |diff| / interval width are shown.

This is a correlation, not a causal effect. Cards often mark a variant, or a better pilot. With dozens of cards
tested, a few will look credible by chance.

## Players

Players are identified by name across events: lower-cased, with accents stripped and spaces collapsed.

The **leaderboard** sums records across the selected events. It shows best Swiss finish, Top 8 count and the
archetypes played.

### Deck or pilot? (rating model)

Win rates mix deck strength with pilot skill. A Bradley-Terry model separates the two:

```
P(A beats B) = sigmoid( θ_playerA + β_deckA − θ_playerB − β_deckB )
```

- θ are player skills and β are deck strengths, with Gaussian (ridge) priors: σ = 0.5 for players and 0.3 for decks.
- The model is fitted by maximum a posteriori, with alternating diagonal Newton updates over 60 rounds. That takes
  about 40 ms for 11,000 matches.
- Draws and byes are excluded. Mirror matches add nothing to β.

Outputs:
- **Adjusted win rate** = sigmoid(β_deck − β̄). β̄ is the match-weighted average deck strength, so this is the win
  rate the deck would have with an average pilot against an average field. Its 95% interval uses the curvature at
  the optimum, 1/√(Hessian + λ).
- **Pilot effect** = raw win rate − adjusted win rate. A positive value means stronger players than average chose the
  deck.
- **Average pilot skill** = sigmoid(mean θ of its pilots − θ̄), where θ̄ is the field's match-weighted average.
- **Estimated strength** of a player = sigmoid(θ − θ̄): the probability of beating an average player when both play
  the same deck.

Within a single event, each player has played about 8 to 15 matches, so player estimates stay close to the average
by design. They become informative across several events.

## Known caveats

- **Selection effects.** Dropped players leave the data early, and Day 2 metagames are not random samples.
- **Shared opponents.** Matches between players are not independent, and every model above treats them as if they
  were.
- **Rules lag new sets.** Expect more Unknown and fallback results in the first days after a release.
- **Name-based identity.** It merges namesakes and splits players whose name is spelled differently.
