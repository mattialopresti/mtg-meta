/*!
 * MTG Stats - core
 * Parser archetipi (port JS di MTGOArchetypeParser, regole MTGOFormatData),
 * conversione tornei in formato compatto e calcolo statistiche.
 * Nessuna dipendenza dal DOM: gira sia nel browser sia in Node (per i test).
 *
 * Copyright (C) 2026 Mattia Lopresti - GPL-2.0-or-later
 * Il riconoscimento degli archetipi e un port di MTGOArchetypeParser
 * (https://github.com/Badaro/MTGOArchetypeParser), Copyright (c) 2025 Filipe Badaro, licenza MIT.
 * Vedi THIRD-PARTY.md per il testo completo della licenza.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MTGStatsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT_DATA_REPO = 'Badaro/MTGOFormatData';
  var FORMAT_DATA_BRANCH = 'main';
  var CACHE_REPO = 'Jiliac/MTGODecklistCache';
  var CACHE_BRANCH = 'master';

  // Traduzione dei messaggi mostrati nel pannello admin (MTGStatsI18n e presente solo nel browser)
  var tr = function (s, v) { var I = typeof self !== 'undefined' && self.MTGStatsI18n; return I ? I.t(s, v) : s.replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? v[k] : m; }); };

  // ---------------------------------------------------------------------------
  // Utilita
  // ---------------------------------------------------------------------------

  function normCardName(s) {
    return String(s || '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/\s*\/\/?\s*/g, ' // ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function frontFace(name) {
    var i = name.indexOf(' // ');
    return i > 0 ? name.slice(0, i) : name;
  }

  // Alcuni file di MTGOFormatData hanno virgole finali: JSON.parse le rifiuta.
  function parseLenientJson(text) {
    text = String(text).replace(/^﻿/, '');
    try { return JSON.parse(text); } catch (e) {
      return JSON.parse(text.replace(/,(\s*[\]}])/g, '$1'));
    }
  }

  function isoDate(d) {
    return d ? String(d).slice(0, 10) : '';
  }

  function slugify(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  // ---------------------------------------------------------------------------
  // Statistica: quantili della distribuzione Beta (per lo smoothing bayesiano)
  // ---------------------------------------------------------------------------

  function lnGamma(z) {
    var g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    z -= 1;
    var x = 0.99999999999980993;
    for (var i = 0; i < 8; i++) x += g[i] / (z + i + 1);
    var t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function betacf(a, b, x) {
    var MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  // Funzione beta incompleta regolarizzata I_x(a, b) = pbeta(x, a, b)
  function pbeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }

  function qbeta(p, a, b) {
    var lo = 0, hi = 1;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (pbeta(mid, a, b) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------------------------------------------------------------------------
  // Parser archetipi
  // ---------------------------------------------------------------------------

  var COLOR_NAMES = {
    W: 'MonoWhite', U: 'MonoBlue', B: 'MonoBlack', R: 'MonoRed', G: 'MonoGreen',
    WU: 'Azorius', WB: 'Orzhov', WR: 'Boros', WG: 'Selesnya', UB: 'Dimir', UR: 'Izzet',
    UG: 'Simic', BR: 'Rakdos', BG: 'Golgari', RG: 'Gruul',
    WUB: 'Esper', WUR: 'Jeskai', WUG: 'Bant', WBR: 'Mardu', WBG: 'Abzan', WRG: 'Naya',
    UBR: 'Grixis', UBG: 'Sultai', URG: 'Temur', BRG: 'Jund',
    WUBR: 'WUBR', WBRG: 'WBRG', WUBG: 'WUBG', WURG: 'WURG', UBRG: 'UBRG', WUBRG: '5Color'
  };

  var COMPANIONS = ['Gyruda, Doom of Depths', 'Jegantha, the Wellspring', 'Kaheera, the Orphanguard',
    'Keruga, the Macrosage', 'Lurrus of the Dream-Den', 'Lutri, the Spellchaser', 'Obosh, the Preypiercer',
    'Umori, the Collector', 'Yorion, Sky Nomad', 'Zirda, the Dawnwaker'];

  function archetypeDisplayName(arch, color) {
    var name = String(arch.Name || '').replace('Generic', '');
    if (arch.IncludeColorInName) name = (COLOR_NAMES[color] || '') + name;
    // Stessa regex del parser C#: spezza il PascalCase in parole
    name = name.replace(/(?<=[A-Z])(?=[A-Z][a-z])|(?<=[^A-Z])(?=[A-Z])|(?<=[A-Za-z])(?=[^A-Za-z])/g, ' ');
    return name.replace(/\s+/g, ' ').trim();
  }

  /**
   * bundle: { format, lands: {nome: 'WU'}, nonLands: {...}, archetypes: [...], fallbacks: [...] }
   * opts: { minSimilarity: 0.1, conflict: 'simpler' | 'none', aliases: {da: a}, customRules: [archetipi] }
   */
  function ArchetypeParser(bundle, opts) {
    this.bundle = bundle;
    this.opts = Object.assign({ minSimilarity: 0.1, conflict: 'simpler', aliases: {} }, opts || {});
    var custom = (this.opts.customRules || []).map(function (a) { return Object.assign({}, a, { _custom: true }); });
    this.archetypes = custom.concat(bundle.archetypes || []).filter(function (a) { return a.Conditions && a.Conditions.length; });
    this.fallbacks = (bundle.fallbacks || []).filter(function (a) { return a.CommonCards && a.CommonCards.length; })
      .map(function (f) { return Object.assign({}, f, { _set: new Set(f.CommonCards) }); });
  }

  ArchetypeParser.prototype.lookupColor = function (map, name) {
    if (map[name] !== undefined) return map[name];
    var f = frontFace(name);
    return map[f];
  };

  ArchetypeParser.prototype.getColors = function (main, side) {
    var inLands = { W: 0, U: 0, B: 0, R: 0, G: 0 }, inSpells = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    var self = this;
    main.concat(side).forEach(function (c) {
      var lc = self.lookupColor(self.bundle.lands, c.name);
      if (lc) for (var i = 0; i < lc.length; i++) if (inLands[lc[i]] !== undefined) inLands[lc[i]] += c.count;
      var nc = self.lookupColor(self.bundle.nonLands, c.name);
      if (nc) for (var j = 0; j < nc.length; j++) if (inSpells[nc[j]] !== undefined) inSpells[nc[j]] += c.count;
    });
    var out = '';
    'WUBRG'.split('').forEach(function (k) { if (inLands[k] > 0 && inSpells[k] > 0) out += k; });
    return out || 'C';
  };

  function testConditions(conditions, mainSet, sideSet) {
    for (var i = 0; i < conditions.length; i++) {
      var cond = conditions[i], cards = cond.Cards;
      if (!cards || !cards.length) continue;
      var first = cards[0];
      var countIn = function (set) { var n = 0; for (var k = 0; k < cards.length; k++) if (set.has(cards[k])) n++; return n; };
      switch (cond.Type) {
        case 'InMainboard': if (!mainSet.has(first)) return false; break;
        case 'InSideboard': if (!sideSet.has(first)) return false; break;
        case 'InMainOrSideboard': if (!mainSet.has(first) && !sideSet.has(first)) return false; break;
        case 'OneOrMoreInMainboard': if (countIn(mainSet) < 1) return false; break;
        case 'OneOrMoreInSideboard': if (countIn(sideSet) < 1) return false; break;
        case 'OneOrMoreInMainOrSideboard': if (countIn(mainSet) + countIn(sideSet) < 1) return false; break;
        case 'TwoOrMoreInMainboard': if (countIn(mainSet) < 2) return false; break;
        case 'TwoOrMoreInSideboard': if (countIn(sideSet) < 2) return false; break;
        case 'TwoOrMoreInMainOrSideboard': if (countIn(mainSet) + countIn(sideSet) < 2) return false; break;
        case 'DoesNotContain': if (mainSet.has(first) || sideSet.has(first)) return false; break;
        case 'DoesNotContainMainboard': if (mainSet.has(first)) return false; break;
        case 'DoesNotContainSideboard': if (sideSet.has(first)) return false; break;
        default: return false;
      }
    }
    return true;
  }

  /**
   * main/side: array di {name, count}
   * Ritorna { archetype, color, companion, method: 'rule'|'variant'|'fallback'|'conflict'|'unknown', candidates, similarity }
   */
  ArchetypeParser.prototype.detect = function (main, side) {
    var mainSet = new Set(main.map(function (c) { return c.name; }));
    var sideSet = new Set(side.map(function (c) { return c.name; }));
    var color = this.getColors(main, side);
    var companion = null;
    COMPANIONS.forEach(function (n) { if (sideSet.has(n)) companion = n; });

    var matches = [];
    this.archetypes.forEach(function (arch) {
      if (!testConditions(arch.Conditions, mainSet, sideSet)) return;
      var isVariant = false;
      (arch.Variants || []).forEach(function (v) {
        if (v.Conditions && v.Conditions.length && testConditions(v.Conditions, mainSet, sideSet)) {
          isVariant = true;
          matches.push({ arch: arch, variant: v, complexity: arch.Conditions.length + v.Conditions.length });
        }
      });
      if (!isVariant) matches.push({ arch: arch, variant: null, complexity: arch.Conditions.length });
    });

    // Le regole personalizzate (impostazioni del plugin) hanno priorita su quelle della community
    var custom = matches.filter(function (m) { return m.arch._custom; });
    if (custom.length) matches = custom;

    var result = { color: color, companion: companion, candidates: [], similarity: 1 };

    if (matches.length === 0) {
      var best = null, bestW = 0;
      var cards = main.concat(side);
      this.fallbacks.forEach(function (fb) {
        var w = 0;
        cards.forEach(function (c) { if (fb._set.has(c.name)) w += c.count; });
        if (w > bestW || (w === bestW && w > 0 && best && fb.CommonCards.length < best.CommonCards.length)) { best = fb; bestW = w; }
      });
      var sim = best ? bestW / (main.length + side.length) : 0;
      if (best && sim > this.opts.minSimilarity) {
        result.archetype = archetypeDisplayName(best, color);
        result.method = 'fallback';
        result.similarity = sim;
      } else {
        result.archetype = 'Unknown';
        result.method = 'unknown';
        result.similarity = sim;
      }
    } else {
      result.candidates = matches.map(function (m) { return archetypeDisplayName(m.variant || m.arch, color); });
      var pick = matches[0];
      if (matches.length > 1) {
        if (this.opts.conflict === 'simpler') {
          pick = matches.slice().sort(function (a, b) { return a.complexity - b.complexity; })[0];
          result.method = 'conflict';
        } else {
          result.archetype = 'Conflict(' + result.candidates.join(',') + ')';
          result.method = 'conflict';
          return this.applyAlias(result);
        }
      } else {
        result.method = pick.variant ? 'variant' : 'rule';
      }
      result.archetype = archetypeDisplayName(pick.variant || pick.arch, color);
    }
    return this.applyAlias(result);
  };

  ArchetypeParser.prototype.applyAlias = function (result) {
    var al = this.opts.aliases || {};
    if (al[result.archetype]) { result.original = result.archetype; result.archetype = al[result.archetype]; }
    return result;
  };

  // ---------------------------------------------------------------------------
  // Caricamento regole da GitHub (MTGOFormatData)
  // ---------------------------------------------------------------------------

  /**
   * Sceglie la cartella formato. Per lo Standard esistono cartelle datate
   * (es. "Standard-20240803-20250730") da usare per i tornei di quel periodo.
   */
  function pickFormatFolder(folders, format, date) {
    var f = String(format || '').toLowerCase();
    var day = String(date || '').replace(/-/g, '').slice(0, 8);
    var dated = folders.filter(function (n) { return n.toLowerCase().indexOf(f + '-') === 0; });
    for (var i = 0; i < dated.length; i++) {
      var m = dated[i].match(/-(\d{8})-(\d{8})$/);
      if (m && day && day >= m[1] && day <= m[2]) return dated[i];
    }
    var exact = folders.filter(function (n) { return n.toLowerCase() === f; });
    return exact[0] || null;
  }

  /**
   * Carica le regole di un formato. http = { json(url), text(url) } (iniettato per Node/browser).
   * Ritorna il bundle usato da ArchetypeParser.
   */
  async function loadFormatBundle(http, format, date, onProgress) {
    var raw = 'https://raw.githubusercontent.com/' + FORMAT_DATA_REPO + '/' + FORMAT_DATA_BRANCH + '/';
    var tree = await http.json('https://api.github.com/repos/' + FORMAT_DATA_REPO + '/git/trees/' + FORMAT_DATA_BRANCH + '?recursive=1');
    var paths = tree.tree.map(function (t) { return t.path; });
    var folders = paths.filter(function (p) { return /^Formats\/[^/]+$/.test(p) && !/\.json$/.test(p); })
      .map(function (p) { return p.split('/')[1]; });
    var folder = pickFormatFolder(folders, format, date);
    if (!folder) throw new Error(tr('Format "{format}" is not in MTGOFormatData (available: {list})', { format: format, list: folders.join(', ') }));

    var archFiles = paths.filter(function (p) { return p.indexOf('Formats/' + folder + '/Archetypes/') === 0 && /\.json$/i.test(p); });
    var fbFiles = paths.filter(function (p) { return p.indexOf('Formats/' + folder + '/Fallbacks/') === 0 && /\.json$/i.test(p); });
    var total = archFiles.length + fbFiles.length + 2, done = 0;
    var tick = function () { done++; if (onProgress) onProgress(done, total); };

    async function getAll(list) {
      var out = [], i = 0;
      async function worker() {
        while (i < list.length) {
          var p = list[i++];
          try { out.push(parseLenientJson(await http.text(raw + encodeURI(p)))); }
          catch (e) { out.push({ _error: p + ': ' + e.message }); }
          tick();
        }
      }
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      return out;
    }

    var colors = parseLenientJson(await http.text(raw + 'Formats/card_colors.json')); tick();
    var overrides = { Lands: null, NonLands: null };
    try { overrides = parseLenientJson(await http.text(raw + 'Formats/' + folder + '/color_overrides.json')); } catch (e) { /* opzionale */ }
    tick();

    var lands = {}, nonLands = {};
    (colors.Lands || []).forEach(function (c) { lands[c.Name] = c.Color; });
    (colors.NonLands || []).forEach(function (c) { nonLands[c.Name] = c.Color; });
    (overrides.Lands || []).forEach(function (c) { lands[c.Name] = c.Color; });
    (overrides.NonLands || []).forEach(function (c) { nonLands[c.Name] = c.Color; });

    var archetypes = await getAll(archFiles);
    var fallbacks = await getAll(fbFiles);
    var errors = archetypes.concat(fallbacks).filter(function (a) { return a._error; }).map(function (a) { return a._error; });

    return {
      format: format,
      folder: folder,
      loadedAt: new Date().toISOString(),
      lands: lands,
      nonLands: nonLands,
      archetypes: archetypes.filter(function (a) { return !a._error; }),
      fallbacks: fallbacks.filter(function (a) { return !a._error; }),
      errors: errors
    };
  }

  /**
   * Completa i colori delle carte sconosciute (es. set appena usciti) con Scryfall.
   * Modifica bundle.lands / bundle.nonLands. Ritorna { added, notFound }.
   */
  async function enrichColorsFromScryfall(http, bundle, cardNames) {
    // _checked evita di richiedere di nuovo carte incolori o gia cercate
    bundle._checked = bundle._checked || new Set();
    var known = function (n) {
      return bundle.lands[n] !== undefined || bundle.nonLands[n] !== undefined ||
        bundle.lands[frontFace(n)] !== undefined || bundle.nonLands[frontFace(n)] !== undefined;
    };
    var missing = cardNames.filter(function (n) { return !known(n) && !bundle._checked.has(n); });
    var added = 0, notFound = [];
    for (var i = 0; i < missing.length; i += 75) {
      var chunk = missing.slice(i, i + 75);
      chunk.forEach(function (n) { bundle._checked.add(n); });
      var res = await http.postJson('https://api.scryfall.com/cards/collection', {
        identifiers: chunk.map(function (n) { return { name: frontFace(n) }; })
      });
      (res.not_found || []).forEach(function (nf) { notFound.push(nf.name); });
      (res.data || []).forEach(function (card) {
        var key = chunk.filter(function (n) { return frontFace(n).toLowerCase() === String(card.name).split(' // ')[0].toLowerCase(); })[0] || card.name;
        var face = card.card_faces && card.card_faces[0] ? card.card_faces[0] : card;
        var type = face.type_line || card.type_line || '';
        if (/\bLand\b/.test(type)) {
          var prod = (card.produced_mana || []).filter(function (c) { return 'WUBRG'.indexOf(c) >= 0; });
          var col = 'WUBRG'.split('').filter(function (c) { return prod.indexOf(c) >= 0; }).join('');
          if (col) { bundle.lands[key] = col; added++; }
        } else {
          var cols = card.colors || face.colors || [];
          var c2 = 'WUBRG'.split('').filter(function (c) { return cols.indexOf(c) >= 0; }).join('');
          if (c2) { bundle.nonLands[key] = c2; added++; }
        }
      });
      if (i + 75 < missing.length) await new Promise(function (r) { setTimeout(r, 120); });
    }
    return { checked: missing.length, added: added, notFound: notFound };
  }

  // ---------------------------------------------------------------------------
  // Cache tornei (Jiliac/MTGODecklistCache)
  // ---------------------------------------------------------------------------

  /** Elenca i tornei di un mese: source = 'melee.gg' | 'CardsRealm' | ... */
  async function listCacheMonth(http, source, year, month) {
    var mm = String(month).padStart(2, '0');
    var base = 'https://api.github.com/repos/' + CACHE_REPO + '/contents/Tournaments/' + source + '/' + year;
    var months = await http.json(base + '?ref=' + CACHE_BRANCH);
    var dir = months.filter(function (m) { return m.name === mm; })[0];
    if (!dir) return [];
    var tree = await http.json('https://api.github.com/repos/' + CACHE_REPO + '/git/trees/' + dir.sha + '?recursive=1');
    return tree.tree.filter(function (t) { return t.type === 'blob' && /\.json$/.test(t.path); }).map(function (t) {
      var file = t.path.split('/').pop();
      var m = file.match(/^(.*?)-(\d+)-(\d{4}-\d{2}-\d{2})\.json$/);
      return {
        path: 'Tournaments/' + source + '/' + year + '/' + mm + '/' + t.path,
        url: 'https://raw.githubusercontent.com/' + CACHE_REPO + '/' + CACHE_BRANCH + '/Tournaments/' + source + '/' + year + '/' + mm + '/' + t.path,
        file: file,
        title: (m ? m[1] : file.replace(/\.json$/, '')).replace(/-/g, ' '),
        sourceId: m ? m[2] : null,
        date: m ? m[3] : year + '-' + mm + '-' + t.path.split('/')[0],
        size: t.size,
        source: source
      };
    }).sort(function (a, b) { return b.date.localeCompare(a.date) || b.size - a.size; });
  }

  var KNOWN_FORMATS = ['Standard', 'Pioneer', 'Modern', 'Legacy', 'Vintage', 'Pauper', 'Premodern', 'Commander', 'Explorer', 'Historic', 'Timeless', 'Alchemy'];

  function guessFormat(text) {
    var t = String(text || '').toLowerCase();
    for (var i = 0; i < KNOWN_FORMATS.length; i++) {
      if (t.indexOf(KNOWN_FORMATS[i].toLowerCase()) >= 0) return KNOWN_FORMATS[i];
    }
    if (/\bcedh\b|\bedh\b/.test(t)) return 'Commander';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Formato compatto
  // ---------------------------------------------------------------------------
  // {
  //   v: 1, id, name, date, format, source, uri,
  //   cards: [nome carta, ...],
  //   players: [{ n, a, col, m, rank, w, l, d, pts, mb: [[idx, qty]], sb: [[idx, qty]], dn }],
  //   rounds: [{ name, fmt, ex, m: [[i1, i2 | -1, g1, g2, gd]] }]
  // }
  //   a = archetipo, col = colori, m = metodo riconoscimento, dn = nome dichiarato (Melee)
  //   ex = round escluso dalle statistiche (es. draft al Pro Tour)

  function parseResult(str) {
    var m = String(str || '').match(/(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0];
  }

  function recordFromResult(result) {
    // MTGO: "5-0" / "3-1-1" ; Melee: "1st Place" ecc.
    var r = parseResult(result);
    return r ? { w: r[0], l: r[1], d: r[2] } : null;
  }

  /**
   * Converte un torneo nel formato della cache (CacheItem) in formato compatto.
   * raw: { Tournament, Decks, Standings, Rounds }
   * meta: { source, format (opzionale), id (opzionale) }
   */
  function compactFromCache(raw, meta) {
    meta = meta || {};
    var t = raw.Tournament || {};
    var cards = [], cardIdx = new Map();
    function ci(name) {
      name = normCardName(name);
      if (!cardIdx.has(name)) { cardIdx.set(name, cards.length); cards.push(name); }
      return cardIdx.get(name);
    }
    function list(items) {
      var acc = new Map();
      (items || []).forEach(function (it) {
        var name = it.CardName || it.Card || it.Name;
        var idx = ci(name);
        acc.set(idx, (acc.get(idx) || 0) + (it.Count || 0));
      });
      return Array.from(acc.entries());
    }

    var players = [], byName = new Map();
    function key(n) { return String(n || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    function getPlayer(name) {
      var k = key(name);
      if (!byName.has(k)) { byName.set(k, players.length); players.push({ n: String(name).replace(/\s+/g, ' ').trim() }); }
      return byName.get(k);
    }

    (raw.Standings || []).forEach(function (s) {
      var p = players[getPlayer(s.Player)];
      p.rank = s.Rank; p.w = s.Wins; p.l = s.Losses; p.d = s.Draws; p.pts = s.Points;
    });
    (raw.Decks || []).forEach(function (d, i) {
      var p = players[getPlayer(d.Player || ('Player ' + (i + 1)))];
      p.mb = list(d.Mainboard);
      p.sb = list(d.Sideboard);
      if (d.AnchorUri) p.u = d.AnchorUri;
      if (p.w === undefined) {
        var rec = recordFromResult(d.Result);
        if (rec) { p.w = rec.w; p.l = rec.l; p.d = rec.d; p.pts = rec.w * 3 + rec.d; }
        else if (d.Result) p.res = d.Result;
      }
    });

    var rounds = (raw.Rounds || []).map(function (r) {
      return {
        name: r.RoundName,
        m: (r.Matches || []).map(function (m) {
          var g = parseResult(m.Result) || [0, 0, 0];
          var p2 = m.Player2 && m.Player2 !== '-' && !/^bye$/i.test(m.Player2) ? getPlayer(m.Player2) : -1;
          return [getPlayer(m.Player1), p2, g[0], g[1], g[2]];
        })
      };
    });

    var format = meta.format || t.Formats || guessFormat(t.Name) || guessFormat(meta.file);
    var date = isoDate(t.Date) || meta.date || '';
    var sourceId = meta.sourceId || ((t.Uri || '').match(/(\d+)\/?$/) || [])[1] || '';
    return {
      v: 1,
      id: meta.id || slugify((meta.source || 'evt') + '-' + (sourceId || '') + '-' + date + '-' + (sourceId ? '' : t.Name)),
      name: t.Name || meta.title || 'Tournament',
      date: date,
      format: format,
      source: meta.source || '',
      uri: t.Uri || '',
      cards: cards,
      players: players,
      rounds: rounds
    };
  }

  function deckOf(t, p) {
    var toList = function (arr) { return (arr || []).map(function (e) { return { name: t.cards[e[0]], count: e[1] }; }); };
    return { main: toList(p.mb), side: toList(p.sb) };
  }

  /** Assegna/aggiorna gli archetipi in un torneo compatto (sovrascritture manuali preservate se keepManual). */
  function classifyTournament(t, parser, opts) {
    opts = opts || {};
    var summary = { rule: 0, variant: 0, fallback: 0, conflict: 0, unknown: 0, nolist: 0, manual: 0 };
    var aliases = parser.opts.aliases || {};
    var declared = function (p) { return p.dn ? (aliases[p.dn] || p.dn) : null; };
    t.players.forEach(function (p) {
      if (opts.keepManual && p.m === 'manual') { summary.manual++; return; }
      if (!p.mb || !p.mb.length) {
        p.a = declared(p) || 'Unknown'; p.col = ''; p.m = 'nolist'; summary.nolist++;
        return;
      }
      var deck = deckOf(t, p);
      var r = parser.detect(deck.main, deck.side);
      p.a = r.archetype; p.col = r.color; p.m = r.method;
      if (r.method === 'conflict') p.cand = r.candidates; else delete p.cand;
      if (r.method === 'unknown' && p.dn) { p.a = declared(p); }
      summary[r.method] = (summary[r.method] || 0) + 1;
    });
    t.arch = { folder: parser.bundle.folder, at: new Date().toISOString() };
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Statistiche
  // ---------------------------------------------------------------------------

  function isPlayoffRound(r, playersInRound) {
    return /quarter|semi|final|top ?\d|playoff/i.test(r.name || '') || playersInRound <= 8;
  }

  /**
   * Analizza la struttura dei round: giocatori per round, inizio del Day 2, top cut.
   */
  function roundStructure(t) {
    var counts = t.rounds.map(function (r) {
      var s = new Set();
      r.m.forEach(function (m) { if (m[1] >= 0) { s.add(m[0]); s.add(m[1]); } });
      return s.size;
    });
    var playoff = t.rounds.map(function (r, i) { return isPlayoffRound(r, counts[i]); });
    var day2Start = -1;
    for (var i = 4; i < counts.length; i++) {
      if (playoff[i]) break;
      if (counts[i] < 0.75 * counts[i - 1] && counts[i] > 16) { day2Start = i; break; }
    }
    return { counts: counts, playoff: playoff, day2Start: day2Start };
  }

  /**
   * Costruisce la tabella "giocatore-torneo" con i record ricalcolati dai match
   * (rispettando i round esclusi) o, in assenza di match, dalla classifica.
   */
  function playerRows(tournaments, opts) {
    opts = opts || {};
    var rows = [];
    tournaments.forEach(function (t, ti) {
      var struct = roundStructure(t);
      var rec = t.players.map(function () { return { w: 0, l: 0, d: 0, played: 0, rounds: new Set() }; });
      var hasMatches = t.rounds && t.rounds.some(function (r) { return r.m && r.m.length; });
      t.rounds.forEach(function (r, ri) {
        if (r.ex) return;
        if (opts.excludePlayoffs && struct.playoff[ri]) return;
        r.m.forEach(function (m) {
          var a = rec[m[0]];
          if (a) a.rounds.add(ri);
          if (m[1] < 0) return; // bye
          var b = rec[m[1]];
          b.rounds.add(ri);
          a.played++; b.played++;
          if (m[2] > m[3]) { a.w++; b.l++; } else if (m[2] < m[3]) { a.l++; b.w++; } else { a.d++; b.d++; }
        });
      });
      t.players.forEach(function (p, pi) {
        var r = rec[pi];
        var useStand = !hasMatches;
        if (useStand && p.w === undefined && !p.res) return;
        if (!useStand && r.played === 0 && !p.mb) return;
        rows.push({
          t: ti, tid: t.id, date: t.date, pi: pi, player: p.n, archetype: p.a || 'Unknown', color: p.col || '',
          hasList: !!(p.mb && p.mb.length),
          w: useStand ? (p.w || 0) : r.w, l: useStand ? (p.l || 0) : r.l, d: useStand ? (p.d || 0) : r.d,
          rank: p.rank || null,
          day2: struct.day2Start >= 0 ? r.rounds.has(struct.day2Start) : null
        });
      });
    });
    return rows;
  }

  function betaStats(w, l, alpha, beta) {
    var a = alpha + w, b = beta + l;
    return { mean: a / (a + b), median: qbeta(0.5, a, b), lo: qbeta(0.025, a, b), hi: qbeta(0.975, a, b) };
  }

  /** Meta: presenza e winrate per archetipo (con smoothing bayesiano Beta(alpha, beta)) */
  function metaStats(rows, opts) {
    opts = Object.assign({ alpha: 10, beta: 10 }, opts || {});
    var total = rows.length, by = new Map();
    rows.forEach(function (r) {
      if (!by.has(r.archetype)) by.set(r.archetype, { archetype: r.archetype, players: 0, w: 0, l: 0, d: 0, colors: {} });
      var s = by.get(r.archetype);
      s.players++; s.w += r.w; s.l += r.l; s.d += r.d;
      if (r.color) s.colors[r.color] = (s.colors[r.color] || 0) + 1;
    });
    return Array.from(by.values()).map(function (s) {
      var bs = betaStats(s.w, s.l, opts.alpha, opts.beta);
      return Object.assign(s, {
        share: s.players / total,
        matches: s.w + s.l + s.d,
        wrObs: s.w + s.l > 0 ? s.w / (s.w + s.l) : null,
        wr: bs.median, wrMean: bs.mean, lo: bs.lo, hi: bs.hi
      });
    }).sort(function (a, b) { return b.players - a.players || a.archetype.localeCompare(b.archetype); });
  }

  /**
   * Conversione: mode = 'day2' | 'top8' | 'top16' | 'top32' | 'positive'
   */
  function conversionStats(rows, mode) {
    var ok = function (r) {
      if (mode === 'day2') return r.day2;
      if (mode === 'positive') return r.w > r.l;
      var n = parseInt(String(mode).replace('top', ''), 10);
      return r.rank != null && r.rank <= n;
    };
    var eligible = rows.filter(function (r) {
      if (mode === 'day2') return r.day2 !== null;
      if (mode === 'positive') return true;
      return r.rank != null;
    });
    var by = new Map(), conv = 0;
    eligible.forEach(function (r) {
      if (!by.has(r.archetype)) by.set(r.archetype, { archetype: r.archetype, start: 0, conv: 0 });
      var s = by.get(r.archetype);
      s.start++;
      if (ok(r)) { s.conv++; conv++; }
    });
    var overall = eligible.length ? conv / eligible.length : null;
    return {
      eligible: eligible.length, converted: conv, overall: overall,
      rows: Array.from(by.values()).map(function (s) {
        var bs = betaStats(s.conv, s.start - s.conv, 1, 1);
        return Object.assign(s, { rate: s.conv / s.start, lo: bs.lo, hi: bs.hi, delta: s.conv - overall * s.start });
      }).sort(function (a, b) { return b.start - a.start; })
    };
  }

  /** Matrice matchup tra gli archetipi in `archetypes` (mirror esclusi). */
  function matchupStats(tournaments, archetypes, opts) {
    opts = opts || {};
    var idx = new Map(archetypes.map(function (a, i) { return [a, i]; }));
    var n = archetypes.length;
    var cell = function () { return { w: 0, l: 0, d: 0, gw: 0, gl: 0 }; };
    var M = [];
    for (var i = 0; i < n; i++) { M.push([]); for (var j = 0; j < n; j++) M[i].push(cell()); }
    var draws = new Map(), totals = new Map();
    var bump = function (map, k) { map.set(k, (map.get(k) || 0) + 1); };
    tournaments.forEach(function (t) {
      var struct = roundStructure(t);
      t.rounds.forEach(function (r, ri) {
        if (r.ex) return;
        if (opts.excludePlayoffs && struct.playoff[ri]) return;
        r.m.forEach(function (m) {
          if (m[1] < 0) return;
          var a = t.players[m[0]].a || 'Unknown', b = t.players[m[1]].a || 'Unknown';
          bump(totals, a); bump(totals, b);
          if (m[2] === m[3]) { bump(draws, a); bump(draws, b); }
          if (a === b) return;
          var ia = idx.get(a), ib = idx.get(b);
          if (ia === undefined || ib === undefined) return;
          var x = M[ia][ib], y = M[ib][ia];
          x.gw += m[2]; x.gl += m[3]; y.gw += m[3]; y.gl += m[2];
          if (m[2] > m[3]) { x.w++; y.l++; } else if (m[2] < m[3]) { x.l++; y.w++; } else { x.d++; y.d++; }
        });
      });
    });
    var drawRows = Array.from(totals.entries()).map(function (e) {
      var d = draws.get(e[0]) || 0;
      return { archetype: e[0], matches: e[1], draws: d, rate: d / e[1] };
    });
    return { archetypes: archetypes, matrix: M, draws: drawRows };
  }

  /** Analisi carte per un archetipo (o tutti, se archetype nullo). */
  function cardStats(tournaments, rows, archetype, opts) {
    opts = Object.assign({ alpha: 10, beta: 10, minDecks: 3 }, opts || {});
    var decks = rows.filter(function (r) { return r.hasList && (!archetype || r.archetype === archetype); });
    var nDecks = decks.length;
    var sections = { main: new Map(), side: new Map() };
    decks.forEach(function (r) {
      var t = tournaments[r.t], p = t.players[r.pi];
      [['main', p.mb], ['side', p.sb]].forEach(function (pair) {
        (pair[1] || []).forEach(function (e) {
          var name = t.cards[e[0]], map = sections[pair[0]];
          if (!map.has(name)) map.set(name, { card: name, decks: 0, copies: 0, byQty: {} });
          var s = map.get(name);
          s.decks++; s.copies += e[1];
          var q = String(e[1]);
          if (!s.byQty[q]) s.byQty[q] = { decks: 0, w: 0, l: 0, d: 0 };
          var bq = s.byQty[q];
          bq.decks++; bq.w += r.w; bq.l += r.l; bq.d += r.d;
        });
      });
    });
    // Winrate dei mazzi che NON giocano la carta, per confronto
    var totW = 0, totL = 0;
    decks.forEach(function (r) { totW += r.w; totL += r.l; });
    var finish = function (map) {
      return Array.from(map.values()).map(function (s) {
        var w = 0, l = 0;
        Object.keys(s.byQty).forEach(function (q) {
          var bq = s.byQty[q];
          w += bq.w; l += bq.l;
          var b = betaStats(bq.w, bq.l, opts.alpha, opts.beta);
          bq.wr = bq.w + bq.l > 0 ? bq.w / (bq.w + bq.l) : null; bq.wrS = b.median; bq.lo = b.lo; bq.hi = b.hi;
        });
        var withS = betaStats(w, l, opts.alpha, opts.beta), withoutS = betaStats(totW - w, totL - l, opts.alpha, opts.beta);
        return Object.assign(s, {
          inclusion: s.decks / nDecks,
          avgWhenPlayed: s.copies / s.decks,
          avgOverall: s.copies / nDecks,
          variable: Object.keys(s.byQty).length > 1 || s.decks < nDecks,
          wrWith: withS.median, wrWithout: s.decks < nDecks ? withoutS.median : null
        });
      }).sort(function (a, b) { return b.avgOverall - a.avgOverall || a.card.localeCompare(b.card); });
    };
    return { decks: nDecks, main: finish(sections.main), side: finish(sections.side) };
  }

  // ---------------------------------------------------------------------------
  // Export CSV (classifica, match, decklist)
  // ---------------------------------------------------------------------------

  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(header, rows) {
    return [header.map(csvEscape).join(',')].concat(rows.map(function (r) { return r.map(csvEscape).join(','); })).join('\n');
  }

  /** Classifica finale: Rank,Player,Deck,W,L,D,Winrate,Points (come data/*.csv) */
  function standingsCsv(t) {
    var rows = playerRows([t]).sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
    return toCsv(['Rank', 'Player', 'Deck', 'W', 'L', 'D', 'Winrate', 'Points'], rows.map(function (r, i) {
      var tot = r.w + r.l + r.d;
      return [r.rank || i + 1, r.player, r.archetype, r.w, r.l, r.d, tot ? Math.round(1000 * r.w / tot) / 10 : '', r.w * 3 + r.d];
    }));
  }

  /** Tutti i match: Round,Table,Player1,Player2,Deck1,Deck2,Games1,Games2,GameDraws */
  function matchesCsv(t) {
    var out = [];
    t.rounds.forEach(function (r) {
      r.m.forEach(function (m, i) {
        var p1 = t.players[m[0]], p2 = m[1] >= 0 ? t.players[m[1]] : null;
        out.push([r.name, i + 1, p1.n, p2 ? p2.n : 'BYE', p1.a, p2 ? p2.a : '', m[2], m[3], m[4]]);
      });
    });
    return toCsv(['Round', 'Table', 'Player1', 'Player2', 'Deck1', 'Deck2', 'Games1', 'Games2', 'GameDraws'], out);
  }

  /** Decklist in formato lungo: Player,Deck,Section,Card,Qty */
  function decklistsCsv(t) {
    var out = [];
    t.players.forEach(function (p) {
      (p.mb || []).forEach(function (e) { out.push([p.n, p.a, 'Maindeck', t.cards[e[0]], e[1]]); });
      (p.sb || []).forEach(function (e) { out.push([p.n, p.a, 'Sideboard', t.cards[e[0]], e[1]]); });
    });
    return toCsv(['Player', 'Deck', 'Section', 'Card', 'Qty'], out);
  }

  return {
    version: '1.0.0',
    normCardName: normCardName,
    parseLenientJson: parseLenientJson,
    slugify: slugify,
    guessFormat: guessFormat,
    KNOWN_FORMATS: KNOWN_FORMATS,
    qbeta: qbeta,
    pbeta: pbeta,
    ArchetypeParser: ArchetypeParser,
    archetypeDisplayName: archetypeDisplayName,
    pickFormatFolder: pickFormatFolder,
    loadFormatBundle: loadFormatBundle,
    enrichColorsFromScryfall: enrichColorsFromScryfall,
    listCacheMonth: listCacheMonth,
    compactFromCache: compactFromCache,
    classifyTournament: classifyTournament,
    deckOf: deckOf,
    roundStructure: roundStructure,
    playerRows: playerRows,
    metaStats: metaStats,
    conversionStats: conversionStats,
    matchupStats: matchupStats,
    cardStats: cardStats,
    standingsCsv: standingsCsv,
    matchesCsv: matchesCsv,
    decklistsCsv: decklistsCsv
  };
});
