/*!
 * MTG Stats - statistiche avanzate
 * Posizionamento (matchup bayesiani, winrate atteso, meta di equilibrio), trend nel tempo,
 * varianti e impatto delle carte, giocatori (modello pilota + mazzo).
 * Funzioni pure, senza DOM: testabili in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.MTGStatsAdvanced = factory(root.MTGStatsCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Strumenti numerici
  // ---------------------------------------------------------------------------

  // Generatore con seme: le simulazioni danno lo stesso risultato a ogni render
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randNormal(r) {
    var u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }

  // Marsaglia-Tsang
  function randGamma(k, r) {
    if (k < 1) return randGamma(k + 1, r) * Math.pow(r() || 1e-12, 1 / k);
    var d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      var x, v;
      do { x = randNormal(r); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      var u = r();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function randBeta(a, b, r) {
    var x = randGamma(a, r), y = randGamma(b, r);
    return x / (x + y);
  }

  // Funzione di ripartizione normale standard (Abramowitz-Stegun 7.1.26)
  function normCdf(z) {
    var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    var erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function logit(p) { p = Math.min(Math.max(p, 0.01), 0.99); return Math.log(p / (1 - p)); }
  function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]; }

  function shares(rows) {
    var m = {};
    rows.forEach(function (r) { m[r.archetype] = (m[r.archetype] || 0) + 1; });
    Object.keys(m).forEach(function (k) { m[k] /= rows.length; });
    return m;
  }

  // ---------------------------------------------------------------------------
  // Posizionamento
  // ---------------------------------------------------------------------------

  /**
   * Stima bayesiana dei matchup. Ogni cella parte da quello che ci si aspetta dalla forza
   * generale dei due archetipi (prior), pesato come `strength` match, e si sposta coi dati.
   * mu: risultato di Core.matchupStats; overall: winrate generale (0-1) per archetipo, stesso ordine.
   */
  function matchupPosterior(mu, overall, strength) {
    var s = strength === undefined ? 6 : strength;
    var n = mu.archetypes.length, out = [];
    for (var i = 0; i < n; i++) {
      out.push([]);
      for (var j = 0; j < n; j++) {
        if (i === j) { out[i].push(null); continue; }
        var c = mu.matrix[i][j];
        var p0 = sigmoid(logit(overall[i]) - logit(overall[j]));
        var a = s * p0 + c.w, b = s * (1 - p0) + c.l;
        out[i].push({
          w: c.w, l: c.l, d: c.d, n: c.w + c.l, prior: p0, a: a, b: b,
          mean: a / (a + b), lo: Core.qbeta(0.05, a, b), hi: Core.qbeta(0.95, a, b),
          pFav: 1 - Core.pbeta(0.5, a, b)
        });
      }
    }
    return out;
  }

  /**
   * Winrate atteso di ogni archetipo contro un meta di riferimento.
   * field: {archetipo: quota}; overall: [{p, a, b}] winrate generale con parametri Beta,
   * usato contro gli archetipi che non sono nella matrice.
   */
  function expectedVsField(archs, post, overall, field, opts) {
    opts = Object.assign({ draws: 1000, seed: 7 }, opts || {});
    var n = archs.length;
    var share = archs.map(function (a) { return field[a] || 0; });
    var covered = share.reduce(function (x, y) { return x + y; }, 0);
    var other = Math.max(0, 1 - covered);
    var r = rng(opts.seed);
    return archs.map(function (a, i) {
      var mean = other * overall[i].p, j;
      for (j = 0; j < n; j++) mean += share[j] * (i === j ? 0.5 : post[i][j].mean);
      var sims = new Float64Array(opts.draws);
      for (var k = 0; k < opts.draws; k++) {
        var e = other > 0 ? other * randBeta(overall[i].a, overall[i].b, r) : 0;
        for (j = 0; j < n; j++) {
          if (!share[j]) continue;
          e += share[j] * (i === j ? 0.5 : randBeta(post[i][j].a, post[i][j].b, r));
        }
        sims[k] = e;
      }
      sims.sort();
      return { archetype: a, expected: mean, lo: quantile(sims, 0.05), hi: quantile(sims, 0.95), share: share[i], covered: covered };
    });
  }

  /**
   * Equilibrio di un gioco simmetrico a somma zero (payoff P antisimmetrico) con
   * pesi moltiplicativi: la media delle strategie converge a un mix che nessun mazzo batte.
   */
  function solveSymmetric(P, iterations) {
    var n = P.length, T = iterations || 20000;
    var eta = Math.sqrt(8 * Math.log(Math.max(n, 2)) / T);
    var cum = new Float64Array(n), x = new Float64Array(n), avg = new Float64Array(n);
    x.fill(1 / n);
    for (var t = 0; t < T; t++) {
      var max = -Infinity, i, j;
      for (i = 0; i < n; i++) {
        avg[i] += x[i];
        var u = 0, row = P[i];
        for (j = 0; j < n; j++) u += row[j] * x[j];
        cum[i] += u;
        if (cum[i] > max) max = cum[i];
      }
      var sum = 0;
      for (i = 0; i < n; i++) { x[i] = Math.exp(eta * (cum[i] - max)); sum += x[i]; }
      for (i = 0; i < n; i++) x[i] /= sum;
    }
    var mix = Array.prototype.map.call(avg, function (v) { return v / T; });
    var value = P.map(function (row) { return 0.5 + row.reduce(function (acc, p, j) { return acc + p * mix[j]; }, 0); });
    return { mix: mix, value: value };
  }

  /**
   * Meta di equilibrio dalla matrice bayesiana, piu la "stabilita": quante volte, ricampionando
   * i matchup dalla loro incertezza, l'archetipo resta nel mix con almeno il 3%.
   */
  function metaEquilibrium(post, opts) {
    opts = Object.assign({ samples: 60, seed: 11 }, opts || {});
    var n = post.length;
    var P = post.map(function (row, i) { return row.map(function (c, j) { return i === j ? 0 : c.mean - 0.5; }); });
    var base = solveSymmetric(P, 20000);
    var r = rng(opts.seed), inMix = new Float64Array(n);
    for (var s = 0; s < opts.samples; s++) {
      var Q = [];
      for (var i = 0; i < n; i++) Q.push(new Float64Array(n));
      for (i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var p = randBeta(post[i][j].a, post[i][j].b, r) - 0.5;
          Q[i][j] = p; Q[j][i] = -p;
        }
      }
      var sol = solveSymmetric(Q, 3000);
      sol.mix.forEach(function (v, k) { if (v >= 0.03) inMix[k]++; });
    }
    return base.mix.map(function (v, i) {
      return { share: v < 0.005 ? 0 : v, wrVsEq: base.value[i], stability: inMix[i] / opts.samples };
    });
  }

  // ---------------------------------------------------------------------------
  // Trend nel tempo
  // ---------------------------------------------------------------------------

  function weekStart(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    var day = (d.getUTCDay() + 6) % 7; // lunedi = 0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }

  function diversity(countMap, total) {
    var ps = Object.keys(countMap).map(function (k) { return countMap[k] / total; }).sort(function (a, b) { return b - a; });
    var h = ps.reduce(function (acc, p) { return p > 0 ? acc - p * Math.log(p) : acc; }, 0);
    return { effective: Math.exp(h), top3: ps.slice(0, 3).reduce(function (a, b) { return a + b; }, 0) };
  }

  /**
   * Divide la selezione in periodi (settimana, mese o torneo) e calcola presenza,
   * winrate smoothed e diversita per periodo, piu chi sale e chi scende.
   */
  function trendStats(tournaments, rows, opts) {
    opts = Object.assign({ bucket: 'week', alpha: 10 }, opts || {});
    var keyOf = function (t, ti) {
      if (opts.bucket === 'tournament') return { key: t.date + '#' + ti, start: t.date, label: t.name };
      if (opts.bucket === 'month') return { key: t.date.slice(0, 7), start: t.date.slice(0, 7) + '-01', label: t.date.slice(5, 7) + '/' + t.date.slice(0, 4) };
      var ws = weekStart(t.date);
      return { key: ws, start: ws, label: 'sett. ' + ws.slice(8, 10) + '/' + ws.slice(5, 7) };
    };
    var bmap = new Map();
    var tKey = tournaments.map(function (t, ti) {
      var k = keyOf(t, ti);
      if (!bmap.has(k.key)) bmap.set(k.key, { key: k.key, start: k.start, label: k.label, players: 0, events: 0, arch: {} });
      bmap.get(k.key).events++;
      return k.key;
    });
    rows.forEach(function (r) {
      var b = bmap.get(tKey[r.t]);
      b.players++;
      var a = b.arch[r.archetype] || (b.arch[r.archetype] = { n: 0, w: 0, l: 0 });
      a.n++; a.w += r.w; a.l += r.l;
    });
    var buckets = Array.from(bmap.values()).filter(function (b) { return b.players > 0; })
      .sort(function (a, b) { return a.start.localeCompare(b.start) || a.key.localeCompare(b.key); });
    buckets.forEach(function (b) {
      var counts = {};
      Object.keys(b.arch).forEach(function (k) { counts[k] = b.arch[k].n; });
      var dv = diversity(counts, b.players);
      b.effective = dv.effective; b.top3 = dv.top3;
    });

    var series = function (archetype) {
      return buckets.map(function (b) {
        var a = b.arch[archetype] || { n: 0, w: 0, l: 0 };
        var pa = opts.alpha + a.w, pb = opts.alpha + a.l;
        return { share: a.n / b.players, n: a.n, w: a.w, l: a.l, wr: a.w + a.l ? pa / (pa + pb) : null, total: b.players };
      });
    };

    // Primo periodo contro secondo periodo (il bucket centrale, se dispari, resta fuori)
    var half = Math.floor(buckets.length / 2);
    var firstB = buckets.slice(0, half), lastB = buckets.slice(buckets.length - half);
    var agg = function (list, archetype) {
      var n = 0, tot = 0, w = 0, l = 0;
      list.forEach(function (b) { tot += b.players; var a = b.arch[archetype]; if (a) { n += a.n; w += a.w; l += a.l; } });
      var pa = opts.alpha + w, pb = opts.alpha + l;
      return { share: tot ? n / tot : 0, n: n, wr: pa / (pa + pb), w: w, l: l };
    };
    var all = {};
    rows.forEach(function (r) { all[r.archetype] = (all[r.archetype] || 0) + 1; });
    var movers = half > 0 ? Object.keys(all).filter(function (a) { return a !== 'Unknown'; }).map(function (a) {
      var f = agg(firstB, a), s = agg(lastB, a);
      return { archetype: a, players: all[a], before: f, after: s, dShare: s.share - f.share, dWr: s.wr - f.wr };
    }) : [];
    return { buckets: buckets, series: series, movers: movers, halves: [firstB.length, lastB.length] };
  }

  /** Quote di ogni archetipo tra tutti i giocatori, al Day 2 e in Top 8 */
  function metaShift(rows) {
    var stages = [
      { id: 'all', label: 'Tutti', rows: rows },
      { id: 'day2', label: 'Day 2', rows: rows.filter(function (r) { return r.day2 === true; }) },
      { id: 'top8', label: 'Top 8', rows: rows.filter(function (r) { return r.rank !== null && r.rank <= 8; }) }
    ].filter(function (s) { return s.rows.length >= 8; });
    var sh = stages.map(function (s) { return shares(s.rows); });
    var counts = stages.map(function (s) {
      var m = {};
      s.rows.forEach(function (r) { m[r.archetype] = (m[r.archetype] || 0) + 1; });
      return m;
    });
    var archs = Object.keys(sh[0] || {}).filter(function (a) { return a !== 'Unknown'; });
    return {
      stages: stages.map(function (s) { return { id: s.id, label: s.label, total: s.rows.length }; }),
      rows: archs.map(function (a) {
        return { archetype: a, values: sh.map(function (m) { return m[a] || 0; }), counts: counts.map(function (m) { return m[a] || 0; }) };
      }).sort(function (x, y) { return y.values[0] - x.values[0]; })
    };
  }

  // ---------------------------------------------------------------------------
  // Varianti e carte
  // ---------------------------------------------------------------------------

  function archetypeDecks(tournaments, rows, archetype) {
    return rows.filter(function (r) { return r.hasList && r.archetype === archetype; }).map(function (r) {
      var t = tournaments[r.t], p = t.players[r.pi];
      var main = new Map(), side = new Map();
      (p.mb || []).forEach(function (e) { main.set(t.cards[e[0]], (main.get(t.cards[e[0]]) || 0) + e[1]); });
      (p.sb || []).forEach(function (e) { side.set(t.cards[e[0]], (side.get(t.cards[e[0]]) || 0) + e[1]); });
      return { row: r, main: main, side: side };
    });
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  /**
   * Lista media: per ogni carta e numero di copie k conta i mazzi che ne hanno almeno k,
   * poi prende le combinazioni piu diffuse fino alla dimensione tipica della sezione.
   */
  function consensusDeck(tournaments, rows, archetype) {
    var decks = archetypeDecks(tournaments, rows, archetype);
    if (!decks.length) return null;
    var build = function (section) {
      var size = median(decks.map(function (d) { var s = 0; d[section].forEach(function (q) { s += q; }); return s; }));
      var atLeast = new Map();
      decks.forEach(function (d) {
        d[section].forEach(function (q, card) {
          if (!atLeast.has(card)) atLeast.set(card, []);
          var arr = atLeast.get(card);
          for (var k = 1; k <= q; k++) arr[k] = (arr[k] || 0) + 1;
        });
      });
      var entries = [];
      atLeast.forEach(function (arr, card) { for (var k = 1; k < arr.length; k++) entries.push({ card: card, k: k, count: arr[k] }); });
      entries.sort(function (a, b) { return b.count - a.count || a.k - b.k || a.card.localeCompare(b.card); });
      var out = new Map();
      entries.slice(0, size).forEach(function (e) { out.set(e.card, { card: e.card, qty: e.k, support: e.count / decks.length }); });
      return Array.from(out.values()).sort(function (a, b) { return b.qty - a.qty || a.card.localeCompare(b.card); });
    };
    return { decks: decks.length, main: build('main'), side: build('side') };
  }

  /** Distanza di Jaccard pesata tra due liste (sideboard con peso dimezzato) */
  function deckDistance(a, b) {
    var mn = 0, mx = 0;
    var acc = function (A, B, wgt) {
      A.forEach(function (q, card) { var o = B.get(card) || 0; mn += wgt * Math.min(q, o); mx += wgt * Math.max(q, o); });
      B.forEach(function (q, card) { if (!A.has(card)) mx += wgt * q; });
    };
    acc(a.main, b.main, 1);
    acc(a.side, b.side, 0.5);
    return mx ? 1 - mn / mx : 0;
  }

  function kMedoids(D, n, k, r) {
    var best = null;
    for (var restart = 0; restart < 5; restart++) {
      // inizializzazione stile k-means++
      var med = [Math.floor(r() * n)];
      while (med.length < k) {
        var dist = new Float64Array(n), tot = 0;
        for (var i = 0; i < n; i++) {
          var dm = Infinity;
          med.forEach(function (m) { dm = Math.min(dm, D[i * n + m]); });
          dist[i] = dm * dm; tot += dist[i];
        }
        var pick = r() * tot, acc = 0, chosen = n - 1;
        for (i = 0; i < n; i++) { acc += dist[i]; if (acc >= pick) { chosen = i; break; } }
        if (med.indexOf(chosen) >= 0) chosen = (chosen + 1) % n;
        med.push(chosen);
      }
      var assign = new Int32Array(n), cost = Infinity;
      for (var iter = 0; iter < 30; iter++) {
        var newCost = 0;
        for (i = 0; i < n; i++) {
          var bi = 0, bd = Infinity;
          for (var c = 0; c < k; c++) { var d = D[i * n + med[c]]; if (d < bd) { bd = d; bi = c; } }
          assign[i] = bi; newCost += bd;
        }
        var changed = false;
        for (c = 0; c < k; c++) {
          var members = [];
          for (i = 0; i < n; i++) if (assign[i] === c) members.push(i);
          if (!members.length) continue;
          var bestM = med[c], bestS = Infinity;
          members.forEach(function (m) {
            var s = 0;
            members.forEach(function (o) { s += D[m * n + o]; });
            if (s < bestS) { bestS = s; bestM = m; }
          });
          if (bestM !== med[c]) { med[c] = bestM; changed = true; }
        }
        cost = newCost;
        if (!changed) break;
      }
      if (!best || cost < best.cost) best = { cost: cost, medoids: med.slice(), assign: Int32Array.from(assign) };
    }
    return best;
  }

  function silhouette(D, n, assign, k) {
    var total = 0;
    for (var i = 0; i < n; i++) {
      var sum = new Float64Array(k), cnt = new Float64Array(k);
      for (var j = 0; j < n; j++) { if (i === j) continue; sum[assign[j]] += D[i * n + j]; cnt[assign[j]]++; }
      var own = assign[i];
      if (cnt[own] === 0) continue;
      var a = sum[own] / cnt[own], b = Infinity;
      for (var c = 0; c < k; c++) if (c !== own && cnt[c]) b = Math.min(b, sum[c] / cnt[c]);
      if (b === Infinity) continue;
      total += (b - a) / Math.max(a, b);
    }
    return total / n;
  }

  /**
   * Trova sotto-varianti di un archetipo raggruppando le liste simili (k-medoids, k scelto
   * con la silhouette). Ritorna null se le liste sono poche, k = 1 se non ci sono gruppi netti.
   */
  function variantClusters(tournaments, rows, archetype, opts) {
    opts = Object.assign({ maxK: 4, minDecks: 12, maxDecks: 500, alpha: 10, seed: 3 }, opts || {});
    var decks = archetypeDecks(tournaments, rows, archetype);
    if (decks.length < opts.minDecks) return null;
    var r = rng(opts.seed);
    if (decks.length > opts.maxDecks) {
      for (var s = decks.length - 1; s > 0; s--) { var j = Math.floor(r() * (s + 1)); var tmp = decks[s]; decks[s] = decks[j]; decks[j] = tmp; }
      decks = decks.slice(0, opts.maxDecks);
    }
    var n = decks.length, D = new Float64Array(n * n);
    for (var i = 0; i < n; i++) for (j = i + 1; j < n; j++) { var d = deckDistance(decks[i], decks[j]); D[i * n + j] = d; D[j * n + i] = d; }

    var best = { k: 1, sil: 0, assign: new Int32Array(n) };
    var minSize = Math.max(3, Math.ceil(n * 0.05));
    for (var k = 2; k <= Math.min(opts.maxK, Math.floor(n / minSize)); k++) {
      var res = kMedoids(D, n, k, r);
      var sizes = new Int32Array(k);
      res.assign.forEach(function (c) { sizes[c]++; });
      if (Array.prototype.some.call(sizes, function (x) { return x < minSize; })) continue;
      var sil = silhouette(D, n, res.assign, k);
      if (sil > best.sil) best = { k: k, sil: sil, assign: res.assign, medoids: res.medoids };
    }
    if (best.sil < 0.12) best = { k: 1, sil: best.sil, assign: new Int32Array(n) };

    var avgCopies = function (list, section, card) {
      var s = 0;
      list.forEach(function (dk) { s += dk[section].get(card) || 0; });
      return list.length ? s / list.length : 0;
    };
    var clusters = [];
    for (var c = 0; c < best.k; c++) {
      var inC = decks.filter(function (_, idx) { return best.assign[idx] === c; });
      var outC = decks.filter(function (_, idx) { return best.assign[idx] !== c; });
      var w = 0, l = 0, dr = 0;
      inC.forEach(function (dk) { w += dk.row.w; l += dk.row.l; dr += dk.row.d; });
      var a = opts.alpha + w, b = opts.alpha + l;
      var signature = [];
      if (best.k > 1) {
        ['main', 'side'].forEach(function (section) {
          var cards = new Set();
          decks.forEach(function (dk) { dk[section].forEach(function (_, card) { cards.add(card); }); });
          cards.forEach(function (card) {
            var x = avgCopies(inC, section, card), y = avgCopies(outC, section, card);
            if (Math.abs(x - y) >= 0.75) signature.push({ card: card, section: section, inside: x, outside: y, diff: x - y });
          });
        });
        signature.sort(function (p, q) { return Math.abs(q.diff) - Math.abs(p.diff); });
      }
      clusters.push({
        size: inC.length, share: inC.length / n, w: w, l: l, d: dr,
        wr: a / (a + b), lo: Core.qbeta(0.05, a, b), hi: Core.qbeta(0.95, a, b),
        signature: signature.slice(0, 8),
        example: best.medoids ? decks[best.medoids[c]].row : inC[0].row
      });
    }
    clusters.sort(function (p, q) { return q.size - p.size; });
    return { decks: n, k: best.k, silhouette: best.sil, clusters: clusters };
  }

  /**
   * Impatto delle carte: winrate dei mazzi che giocano la carta contro quelli che non la giocano,
   * con intervallo al 95% (approssimazione normale delle due posteriori Beta).
   */
  function cardImpact(tournaments, rows, archetype, opts) {
    opts = Object.assign({ alpha: 10, minDecks: 5 }, opts || {});
    var decks = archetypeDecks(tournaments, rows, archetype);
    var totW = 0, totL = 0;
    decks.forEach(function (dk) { totW += dk.row.w; totL += dk.row.l; });
    var stats = new Map();
    decks.forEach(function (dk) {
      [['main', 'Main'], ['side', 'Side']].forEach(function (sec) {
        dk[sec[0]].forEach(function (_, card) {
          var key = sec[1] + '|' + card;
          var s = stats.get(key) || { card: card, section: sec[1], n: 0, w: 0, l: 0 };
          s.n++; s.w += dk.row.w; s.l += dk.row.l;
          stats.set(key, s);
        });
      });
    });
    var beta = function (w, l) {
      var a = opts.alpha + w, b = opts.alpha + l, m = a / (a + b);
      return { mean: m, v: a * b / ((a + b) * (a + b) * (a + b + 1)) };
    };
    var out = [];
    stats.forEach(function (s) {
      var without = decks.length - s.n;
      if (s.n < opts.minDecks || without < opts.minDecks) return;
      var x = beta(s.w, s.l), y = beta(totW - s.w, totL - s.l);
      var diff = x.mean - y.mean, sd = Math.sqrt(x.v + y.v);
      out.push({
        card: s.card, section: s.section, decks: s.n, without: without, inclusion: s.n / decks.length,
        wrWith: x.mean, wrWithout: y.mean, diff: diff, lo: diff - 1.96 * sd, hi: diff + 1.96 * sd,
        pBetter: normCdf(diff / sd), credible: diff - 1.96 * sd > 0 || diff + 1.96 * sd < 0
      });
    });
    return out.sort(function (a, b) { return Math.abs(b.diff) / (b.hi - b.lo) - Math.abs(a.diff) / (a.hi - a.lo); });
  }

  // ---------------------------------------------------------------------------
  // Giocatori
  // ---------------------------------------------------------------------------

  function playerKey(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Riepilogo per giocatore su tutti i tornei della selezione */
  function playerStats(tournaments, rows, opts) {
    opts = Object.assign({ alpha: 10 }, opts || {});
    var by = new Map();
    rows.forEach(function (r) {
      var k = playerKey(r.player);
      var p = by.get(k);
      if (!p) { p = { key: k, name: r.player, events: 0, w: 0, l: 0, d: 0, bestRank: null, bestEvent: '', top8: 0, archetypes: {}, lastDate: '' }; by.set(k, p); }
      p.events++; p.w += r.w; p.l += r.l; p.d += r.d;
      p.archetypes[r.archetype] = (p.archetypes[r.archetype] || 0) + 1;
      if (r.rank !== null && (p.bestRank === null || r.rank < p.bestRank)) { p.bestRank = r.rank; p.bestEvent = tournaments[r.t].name; }
      if (r.rank !== null && r.rank <= 8) p.top8++;
      if (r.date >= p.lastDate) { p.lastDate = r.date; p.name = r.player; }
    });
    var list = Array.from(by.values()).map(function (p) {
      var a = opts.alpha + p.w, b = opts.alpha + p.l;
      var archs = Object.keys(p.archetypes).sort(function (x, y) { return p.archetypes[y] - p.archetypes[x]; });
      return Object.assign(p, {
        matches: p.w + p.l + p.d, wrObs: p.w + p.l ? p.w / (p.w + p.l) : null, wr: a / (a + b),
        mainArchetype: archs[0], archetypeList: archs, switched: archs.length > 1
      });
    });
    var repeat = list.filter(function (p) { return p.events > 1; });
    return {
      players: list,
      unique: list.length,
      repeat: repeat.length,
      switched: repeat.filter(function (p) { return p.switched; }).length
    };
  }

  /**
   * Modello pilota + mazzo (Bradley-Terry con penalita ridge):
   *   P(A batte B) = sigmoid(abilita_A + forza_mazzoA - abilita_B - forza_mazzoB)
   * Stimato con aggiornamenti di Newton alternati. I pareggi sono esclusi.
   */
  function ratingModel(tournaments, opts) {
    opts = Object.assign({ sigmaPlayer: 0.5, sigmaDeck: 0.3, iterations: 60, excludePlayoffs: false }, opts || {});
    var pIdx = new Map(), dIdx = new Map(), pNames = [], dNames = [];
    var pid = function (name) { var k = playerKey(name); if (!pIdx.has(k)) { pIdx.set(k, pNames.length); pNames.push(name); } return pIdx.get(k); };
    var did = function (a) { if (!dIdx.has(a)) { dIdx.set(a, dNames.length); dNames.push(a); } return dIdx.get(a); };
    var A = [], B = [], DA = [], DB = [], Y = [];
    tournaments.forEach(function (t) {
      var struct = Core.roundStructure(t);
      t.rounds.forEach(function (r, ri) {
        if (r.ex || (opts.excludePlayoffs && struct.playoff[ri])) return;
        r.m.forEach(function (m) {
          if (m[1] < 0 || m[2] === m[3]) return;
          var p1 = t.players[m[0]], p2 = t.players[m[1]];
          A.push(pid(p1.n)); B.push(pid(p2.n));
          DA.push(did(p1.a || 'Unknown')); DB.push(did(p2.a || 'Unknown'));
          Y.push(m[2] > m[3] ? 1 : 0);
        });
      });
    });
    var nP = pNames.length, nD = dNames.length, N = Y.length;
    var th = new Float64Array(nP), be = new Float64Array(nD);
    var lp = 1 / (opts.sigmaPlayer * opts.sigmaPlayer), ld = 1 / (opts.sigmaDeck * opts.sigmaDeck);
    var g, hh, k;
    var pass = function (target) {
      var size = target === 'p' ? nP : nD;
      g = new Float64Array(size); hh = new Float64Array(size);
      for (k = 0; k < N; k++) {
        var p = sigmoid(th[A[k]] + be[DA[k]] - th[B[k]] - be[DB[k]]);
        var res = Y[k] - p, h = p * (1 - p);
        if (target === 'p') { g[A[k]] += res; g[B[k]] -= res; hh[A[k]] += h; hh[B[k]] += h; }
        else if (DA[k] !== DB[k]) { g[DA[k]] += res; g[DB[k]] -= res; hh[DA[k]] += h; hh[DB[k]] += h; }
      }
      var arr = target === 'p' ? th : be, lam = target === 'p' ? lp : ld;
      for (k = 0; k < size; k++) arr[k] += (g[k] - lam * arr[k]) / (hh[k] + lam);
    };
    for (var it = 0; it < opts.iterations; it++) { pass('p'); pass('d'); }
    // Curvatura finale per gli intervalli sulla forza dei mazzi
    pass('d');
    var deckH = hh;

    // Statistiche per mazzo: forza media del campo (pesata per partite), abilita media dei piloti
    var deckGames = new Float64Array(nD), deckWins = new Float64Array(nD), pilotSum = new Float64Array(nD);
    for (k = 0; k < N; k++) {
      deckGames[DA[k]]++; deckGames[DB[k]]++;
      deckWins[Y[k] ? DA[k] : DB[k]]++;
      pilotSum[DA[k]] += th[A[k]]; pilotSum[DB[k]] += th[B[k]];
    }
    var fieldBeta = 0, totG = 0, fieldPilot = 0;
    for (k = 0; k < nD; k++) { fieldBeta += be[k] * deckGames[k]; totG += deckGames[k]; fieldPilot += pilotSum[k]; }
    fieldBeta = totG ? fieldBeta / totG : 0;
    fieldPilot = totG ? fieldPilot / totG : 0; // abilita media del pilota "tipico" in un match

    var decks = dNames.map(function (name, i) {
      var sd = 1 / Math.sqrt(deckH[i] + ld);
      var avgPilot = deckGames[i] ? pilotSum[i] / deckGames[i] : 0;
      return {
        archetype: name, games: deckGames[i], wins: deckWins[i], rawWr: deckGames[i] ? deckWins[i] / deckGames[i] : null,
        adjWr: sigmoid(be[i] - fieldBeta), lo: sigmoid(be[i] - fieldBeta - 1.96 * sd), hi: sigmoid(be[i] - fieldBeta + 1.96 * sd),
        pilotWr: sigmoid(avgPilot - fieldPilot)
      };
    });
    var pGames = new Float64Array(nP);
    for (k = 0; k < N; k++) { pGames[A[k]]++; pGames[B[k]]++; }
    var players = pNames.map(function (name, i) { return { key: playerKey(name), name: name, skill: sigmoid(th[i] - fieldPilot), games: pGames[i] }; });
    return { matches: N, decks: decks, players: players, byPlayer: new Map(players.map(function (p) { return [p.key, p]; })) };
  }

  return {
    rng: rng,
    randBeta: randBeta,
    normCdf: normCdf,
    shares: shares,
    matchupPosterior: matchupPosterior,
    expectedVsField: expectedVsField,
    solveSymmetric: solveSymmetric,
    metaEquilibrium: metaEquilibrium,
    trendStats: trendStats,
    metaShift: metaShift,
    consensusDeck: consensusDeck,
    variantClusters: variantClusters,
    cardImpact: cardImpact,
    playerKey: playerKey,
    playerStats: playerStats,
    ratingModel: ratingModel
  };
});
