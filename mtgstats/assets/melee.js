/*!
 * MTG Stats - importatore diretto da melee.gg
 * Usa gli stessi endpoint della pagina pubblica del torneo (abbinamenti, classifiche, decklist).
 * http = { meleeGet(path) -> testo, meleePost(path, formBody) -> testo }
 *   nel browser passa dal proxy del plugin WordPress (melee.gg non consente CORS),
 *   in Node chiama melee.gg direttamente.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.MTGStatsMelee = factory(root.MTGStatsCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // Traduzione dei messaggi mostrati nel pannello admin (MTGStatsI18n e presente solo nel browser)
  var tr = function (s, v) { var I = typeof self !== 'undefined' && self.MTGStatsI18n; return I ? I.t(s, v) : s.replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? v[k] : m; }); };

  function decodeEntities(s) {
    return String(s)
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  function parseTournamentId(input) {
    var m = String(input || '').match(/(?:Tournament\/View\/)?(\d{4,})/i);
    return m ? m[1] : null;
  }

  /** Estrae nome, data e round dalla pagina del torneo */
  function parseTournamentPage(html) {
    var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    title = decodeEntities(title).replace(/\s*\|\s*Melee\s*$/i, '').trim();
    var start = html.indexOf('id="pairings-round-selector-container"');
    if (start < 0) start = html.indexOf('round-selector-container');
    var end = html.indexOf('</div>', start);
    var block = start >= 0 ? html.slice(start, end > start ? end : start + 20000) : html;
    var rounds = [], re = /round-selector"[^>]*data-id="(\d+)"[^>]*data-name="([^"]*)"[^>]*?(?:data-is-completed="(True|False)")?[^>]*>/g, m;
    while ((m = re.exec(block))) rounds.push({ id: m[1], name: decodeEntities(m[2]), completed: m[3] !== 'False' });
    var date = (html.match(/data-toggle="datetime"[^>]*data-value="(\d{4}-[^"]+)"/) || html.match(/"startDate"\s*:\s*"([^"]+)"/) || [])[1] || '';
    var fmt = (html.match(/Format[^<]{0,40}<\/[^>]+>\s*<[^>]+>\s*([A-Za-z]+)/) || [])[1] || '';
    return { title: title, rounds: rounds, date: date, format: fmt };
  }

  function dtBody(columns, start, length, extra) {
    var p = [];
    var add = function (k, v) { p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); };
    add('draw', '1');
    columns.forEach(function (c, i) {
      add('columns[' + i + '][data]', c); add('columns[' + i + '][name]', c);
      add('columns[' + i + '][searchable]', 'true'); add('columns[' + i + '][orderable]', 'true');
      add('columns[' + i + '][search][value]', ''); add('columns[' + i + '][search][regex]', 'false');
    });
    add('order[0][column]', '0'); add('order[0][dir]', 'asc');
    add('start', String(start)); add('length', String(length));
    add('search[value]', ''); add('search[regex]', 'false');
    Object.keys(extra || {}).forEach(function (k) { add(k, extra[k]); });
    return p.join('&');
  }

  async function pagedPost(http, path, columns, extra) {
    var all = [], start = 0, page = 500, total = Infinity;
    while (start < total) {
      var res = JSON.parse(await http.meleePost(path, dtBody(columns, start, page, extra)));
      total = res.recordsTotal || 0;
      all = all.concat(res.data || []);
      if (!res.data || !res.data.length) break;
      start += res.data.length;
    }
    return all;
  }

  /** Estrae la lista dal blocco testuale <pre id="decklist-text"> della pagina decklist */
  function parseDecklistPage(html) {
    var m = html.match(/<pre[^>]*id="decklist-text"[^>]*>([\s\S]*?)<\/pre>/i);
    if (!m) return null;
    var main = [], side = [], target = main;
    decodeEntities(m[1]).split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (/^(main ?deck|deck|commander)$/i.test(line)) { target = main; return; }
      if (/^(sideboard|companion)$/i.test(line)) { target = side; return; }
      var q = line.match(/^(\d+)\s+(.+)$/);
      if (q) target.push({ CardName: Core.normCardName(q[2]), Count: parseInt(q[1], 10) });
    });
    return { Mainboard: main, Sideboard: side };
  }

  function teamName(team) {
    if (!team) return '';
    if (team.Name) return team.Name;
    return (team.Players || []).map(function (p) { return String(p.DisplayName || p.Username || '').replace(/\s+/g, ' ').trim(); }).join(' / ');
  }

  /**
   * Importa un torneo Melee e ritorna un torneo in formato compatto (senza archetipi:
   * va poi passato a Core.classifyTournament).
   * opts: { decklists: true, concurrency: 4, onProgress(msg, done, total) }
   */
  async function importTournament(http, idOrUrl, opts) {
    opts = Object.assign({ decklists: true, concurrency: 4 }, opts || {});
    var progress = opts.onProgress || function () {};
    var id = parseTournamentId(idOrUrl);
    if (!id) throw new Error(tr('Invalid Melee tournament ID'));

    progress(tr('Tournament page'), 0, 1);
    var info = parseTournamentPage(await http.meleeGet('/Tournament/View/' + id));
    if (!info.rounds.length) throw new Error(tr('No rounds found: is the tournament public and started?'));

    var matchCols = ['TableNumber', 'PodNumber', 'Teams', 'Decklists', 'ResultString'];
    var rounds = [], formats = {};
    for (var i = 0; i < info.rounds.length; i++) {
      var r = info.rounds[i];
      progress(tr('Pairings {round}', { round: r.name }), i + 1, info.rounds.length);
      var data = await pagedPost(http, '/Match/GetRoundMatches/' + r.id, matchCols, {});
      var fmtCount = {};
      data.forEach(function (m) { if (m.Format) fmtCount[m.Format] = (fmtCount[m.Format] || 0) + 1; });
      var fmt = Object.keys(fmtCount).sort(function (a, b) { return fmtCount[b] - fmtCount[a]; })[0] || '';
      formats[fmt] = (formats[fmt] || 0) + data.length;
      rounds.push({ id: r.id, name: r.name, fmt: fmt, data: data });
    }
    var mainFormat = Object.keys(formats).sort(function (a, b) { return formats[b] - formats[a]; })[0] || info.format;

    // Classifica swiss: ultimo round con classifica pubblicata
    var standCols = ['Rank', 'Player', 'Decklists', 'MatchRecord', 'GameRecord', 'Points', 'OpponentMatchWinPercentage',
      'TeamGameWinPercentage', 'OpponentGameWinPercentage', 'FinalTiebreaker', 'OpponentCount'];
    var standings = [];
    for (var k = rounds.length - 1; k >= 0 && !standings.length; k--) {
      try {
        progress(tr('Standings'), 0, 1);
        standings = await pagedPost(http, '/Standing/GetRoundStandings', standCols, { roundId: rounds[k].id });
      } catch (e) { standings = []; }
    }

    // Costruisce l'oggetto nel formato della cache, cosi riusa Core.compactFromCache
    var declared = {}, decklistIds = {};
    var registerDeck = function (name, dl) {
      if (!dl || !dl.length) return;
      var main = dl.filter(function (d) { return !mainFormat || d.Format === mainFormat; })[0] || dl[0];
      declared[name] = main.DecklistName;
      decklistIds[name] = main.DecklistId;
    };
    var cacheRounds = rounds.map(function (r) {
      return {
        RoundName: r.name,
        Format: r.fmt,
        Matches: r.data.filter(function (m) { return m.HasResult !== false; }).map(function (m) {
          var c = m.Competitors || [];
          var n1 = teamName(c[0] && c[0].Team), n2 = c[1] ? teamName(c[1].Team) : '-';
          if (c[0]) registerDeck(n1, c[0].Decklists);
          if (c[1]) registerDeck(n2, c[1].Decklists);
          var g1 = c[0] ? (c[0].GameWins || 0) : 0, g2 = c[1] ? (c[1].GameWins || 0) : 0, gd = m.GameDraws || 0;
          if (g1 === g2 && c[1]) {
            // Vittorie senza game (es. no-show, doppia sconfitta): usa la stringa risultato
            var w = (String(m.ResultString || '').match(/^(.*) won /) || [])[1];
            if (w && w.trim() === n1) g1 = 1; else if (w && w.trim() === n2) g2 = 1;
          }
          return { Player1: n1, Player2: n2, Result: g1 + '-' + g2 + '-' + gd };
        })
      };
    });

    var cacheStandings = standings.map(function (s) {
      var name = teamName(s.Team);
      registerDeck(name, s.Decklists);
      return { Rank: s.Rank, Player: name, Points: s.Points, Wins: s.MatchWins, Losses: s.MatchLosses, Draws: s.MatchDraws };
    });

    var decks = [];
    var names = Object.keys(decklistIds);
    if (opts.decklists) {
      var idx = 0, done = 0;
      var worker = async function () {
        while (idx < names.length) {
          var name = names[idx++];
          try {
            var list = parseDecklistPage(await http.meleeGet('/Decklist/View/' + decklistIds[name]));
            if (list) decks.push({ Player: name, Mainboard: list.Mainboard, Sideboard: list.Sideboard, AnchorUri: 'https://melee.gg/Decklist/View/' + decklistIds[name] });
          } catch (e) { /* lista non disponibile */ }
          done++;
          progress(tr('Decklists'), done, names.length);
        }
      };
      var workers = [];
      for (var w = 0; w < opts.concurrency; w++) workers.push(worker());
      await Promise.all(workers);
    }

    var compact = Core.compactFromCache({
      Tournament: { Name: info.title, Date: info.date, Uri: 'https://melee.gg/Tournament/View/' + id, Formats: mainFormat },
      Decks: decks, Standings: cacheStandings, Rounds: cacheRounds
    }, { source: 'melee.gg', sourceId: id, format: mainFormat });

    compact.players.forEach(function (p) { if (declared[p.n]) p.dn = declared[p.n]; });
    compact.rounds.forEach(function (r, i) {
      r.fmt = cacheRounds[i].Format;
      if (r.fmt && mainFormat && r.fmt !== mainFormat) r.ex = 1; // es. draft al Pro Tour
    });
    return compact;
  }

  return {
    parseTournamentId: parseTournamentId,
    parseTournamentPage: parseTournamentPage,
    parseDecklistPage: parseDecklistPage,
    importTournament: importTournament
  };
});
