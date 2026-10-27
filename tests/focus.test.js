// Tests for the deck focus statistics (advanced.js) and the rule selector (core.js). Run from the repository root: node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mtgstats/assets/core.js');
const Adv = require('../mtgstats/assets/advanced.js');

const OMNATH = {
  name: 'Omnath',
  cards: ['Omnath, Locus of Creation'],
  versions: [
    { Name: 'Ritual', Conditions: [{ Type: 'InMainboard', Cards: ['Birthing Ritual'] }] },
    { Name: 'Paradox', Conditions: [{ Type: 'OneOrMoreInMainboard', Cards: ['Way of the Paradox', 'Wrenn and Six'] }] }
  ]
};

/** Compact tournament from { player: [main cards] }, with optional rounds [[p1, p2, games1, games2]] */
function tournament(id, date, decks, rounds, records) {
  const cards = [];
  const idx = (c) => { if (!cards.includes(c)) cards.push(c); return cards.indexOf(c); };
  const players = Object.entries(decks).map(([n, main]) => Object.assign({ n, a: 'Pile', mb: main.map((c) => [idx(c), 4]), sb: [] }, (records || {})[n]));
  const names = players.map((p) => p.n);
  return {
    v: 1, id, name: id, date, format: 'Modern', cards, players,
    rounds: rounds ? [{ name: 'Round 1', m: rounds.map(([a, b, g1, g2]) => [names.indexOf(a), names.indexOf(b), g1, g2, 0]) }] : []
  };
}

test('ruleSelector: the first matching rule wins and invalid rules are skipped', () => {
  const sel = Core.ruleSelector([
    { Name: 'Broken', Conditions: [] },
    ...OMNATH.versions
  ]);
  const keys = (list) => new Set(list.map(Core.cardKey));
  assert.equal(sel.invalid.length, 1);
  assert.equal(sel.match(keys(['Birthing Ritual', 'Wrenn and Six']), keys([])), 'Ritual');
  assert.equal(sel.match(keys(['Way of the Paradox']), keys([])), 'Paradox');
  assert.equal(sel.match(keys(['Risen Reef']), keys([])), null);
});

test('focusTournaments relabels only decks with a key card, without touching the input', () => {
  const t = tournament('evt-1', '2026-10-01', {
    a: ['Omnath, Locus of Creation', 'Birthing Ritual'],
    b: ['Omnath, Locus of Creation', 'Wrenn and Six'],
    c: ['Omnath, Locus of Creation', 'Risen Reef'],
    d: ['Birthing Ritual'],
    e: ['Omnath, Locus of Creation']
  }, [['a', 'd', 2, 0]]);
  t.players[4].mb = []; // no list: cannot be placed
  const F = Adv.focusTournaments([t], OMNATH, { otherName: 'Other' });
  assert.deepEqual(F.tournaments[0].players.map((p) => p.a), ['Omnath · Ritual', 'Omnath · Paradox', 'Omnath · Other', 'Pile', 'Pile']);
  assert.deepEqual(F.labels, ['Omnath · Ritual', 'Omnath · Paradox', 'Omnath · Other']);
  assert.equal(F.tournaments[0].players[0].orig, 'Pile');
  assert.deepEqual(F.decks, { 'Omnath · Ritual': 1, 'Omnath · Paradox': 1, 'Omnath · Other': 1 });
  assert.equal(t.players[0].a, 'Pile', 'input tournament unchanged');
  assert.deepEqual(F.listOnly, [false]);
});

test('isListOnly spots events that only publish perfect records', () => {
  const league = tournament('league', '2026-10-02', { a: ['X'], b: ['Y'] }, null, { a: { w: 5, l: 0, d: 0 }, b: { w: 5, l: 0, d: 0 } });
  const standings = tournament('swiss', '2026-10-02', { a: ['X'], b: ['Y'] }, null, { a: { w: 5, l: 0, d: 0 }, b: { w: 3, l: 2, d: 0 } });
  const paired = tournament('paired', '2026-10-02', { a: ['X'], b: ['Y'] }, [['a', 'b', 2, 1]]);
  assert.equal(Adv.isListOnly(league), true);
  assert.equal(Adv.isListOnly(standings), false);
  assert.equal(Adv.isListOnly(paired), false);
});

test('rankOptions: probabilities of being best add up and follow the evidence', () => {
  // Version A beats the field clearly, version B loses to it
  const archs = ['A', 'B', 'Field'];
  const mu = { archetypes: archs, matrix: archs.map(() => archs.map(() => ({ w: 0, l: 0, d: 0 }))) };
  mu.matrix[0][2] = { w: 60, l: 30, d: 0 }; mu.matrix[2][0] = { w: 30, l: 60, d: 0 };
  mu.matrix[1][2] = { w: 30, l: 60, d: 0 }; mu.matrix[2][1] = { w: 60, l: 30, d: 0 };
  const post = Adv.matchupPosterior(mu, [0.65, 0.35, 0.5]);
  const overall = [{ p: 0.65, a: 70, b: 40 }, { p: 0.35, a: 40, b: 70 }, { p: 0.5, a: 100, b: 100 }];
  const rank = Adv.rankOptions(archs, post, overall, { Field: 1 }, [0, 1]);
  assert.equal(rank[0].archetype, 'A');
  assert.ok(rank[0].pBest > 0.95);
  assert.ok(Math.abs(rank[0].pBest + rank[1].pBest - 1) < 1e-9);
  assert.ok(rank[0].lo < rank[0].expected && rank[0].expected < rank[0].hi);
});

test('cardAdoption finds the cards entering a version', () => {
  const ts = [];
  for (let i = 0; i < 4; i++) ts.push(tournament(`old-${i}`, `2026-09-0${i + 1}`, { [`p${i}`]: ['Omnath, Locus of Creation', 'Wrenn and Six', 'Fable of the Mirror-Breaker'] }, null, { [`p${i}`]: { w: 3, l: 1, d: 0 } }));
  for (let i = 0; i < 4; i++) ts.push(tournament(`new-${i}`, `2026-10-2${i}`, { [`q${i}`]: ['Omnath, Locus of Creation', 'Wrenn and Six', 'Way of the Paradox'] }, null, { [`q${i}`]: { w: 3, l: 1, d: 0 } }));
  const F = Adv.focusTournaments(ts, OMNATH);
  const rows = Core.playerRows(F.tournaments, {});
  const ad = Adv.cardAdoption(F.tournaments, rows, 'Omnath · Paradox', { recentDays: 21 });
  assert.equal(ad.recent, 4);
  assert.equal(ad.before, 4);
  const way = ad.cards.find((c) => c.card === 'Way of the Paradox');
  const fable = ad.cards.find((c) => c.card === 'Fable of the Mirror-Breaker');
  assert.equal(way.isNew, true);
  assert.equal(way.delta, 1);
  assert.equal(fable.delta, -1);
  assert.equal(ad.cards[0].card, 'Way of the Paradox');
});
