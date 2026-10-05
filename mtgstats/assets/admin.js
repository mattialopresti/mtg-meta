/*!
 * MTG Stats – WordPress admin panel
 * Imports run in the administrator's browser: download the tournament, detect archetypes and send
 * only the compact JSON to the server, which visitors then read as a static file. English and Italian.
 */
(function () {
  'use strict';
  var Core = window.MTGStatsCore, Melee = window.MTGStatsMelee, I18n = window.MTGStatsI18n, cfg = window.MTGStatsAdminConfig || {};
  var root = document.getElementById('mtgstats-admin');
  if (!root || !Core) return;
  I18n.setLang(cfg.lang || document.documentElement.lang);
  var t = I18n.t;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c !== null && c !== undefined) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  var dateFormat = new Intl.DateTimeFormat(I18n.locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  function fmtDate(iso) { return iso ? dateFormat.format(new Date(iso + 'T00:00:00Z')) : ''; }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

  async function check(r, url) {
    if (r.ok) return r;
    var msg = 'HTTP ' + r.status;
    try {
      var j = await r.clone().json();
      if (j && j.message) msg += ': ' + j.message;
    } catch (e) { /* not a JSON response */ }
    if (r.status === 403 && /github/.test(url)) msg = t('GitHub request limit reached (60 per hour per IP). Please try again later.');
    throw new Error(msg);
  }

  var http = {
    json: async function (url) { return (await check(await fetch(url), url)).json(); },
    text: async function (url) { return (await check(await fetch(url), url)).text(); },
    postJson: async function (url, body) {
      return (await check(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url)).json();
    },
    meleeGet: function (path) { return meleeProxy('GET', path); },
    meleePost: function (path, body) { return meleeProxy('POST', path, body); }
  };

  async function wp(method, route, body) {
    var url = cfg.restUrl + route;
    var r = await fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': cfg.nonce, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    return (await check(r, url)).json();
  }

  async function meleeProxy(method, path, body) {
    var res = await wp('POST', '/melee', { method: method, path: path, body: body || '' });
    if (res.status >= 400) throw new Error(t('melee.gg answered {status} for {path}', { status: res.status, path: path }));
    return res.body;
  }

  // ---------------------------------------------------------------------------
  // Rules and classification
  // ---------------------------------------------------------------------------

  var bundles = {};
  var forceRulesReload = false;
  var RULES_MAX_AGE = 7 * 86400000;

  function rulesKey(format) { return String(format).replace(/[^A-Za-z0-9_-]/g, ''); }

  async function getBundle(format, date, log) {
    var key = rulesKey(format);
    if (bundles[key] && !forceRulesReload) return bundles[key];
    if (!forceRulesReload) {
      try {
        var saved = await http.json(cfg.dataUrl + '/rules/' + key + '.json?t=' + Date.now());
        if (saved && saved.loadedAt && Date.now() - Date.parse(saved.loadedAt) < RULES_MAX_AGE) {
          bundles[key] = saved;
          return saved;
        }
      } catch (e) { /* no local copy */ }
    }
    log(t('Downloading the {format} rules from MTGOFormatData…', { format: format }));
    var b = await Core.loadFormatBundle(http, format, date, function (d, n) { if (d === n || d % 25 === 0) log('  ' + t('rules: {d}/{n}', { d: d, n: n }), true); });
    log('  ' + t('{a} archetypes and {f} fallbacks (folder {folder})', { a: b.archetypes.length, f: b.fallbacks.length, folder: b.folder }));
    if (b.errors.length) log('  ' + t('warning: {n} rule files could not be read', { n: b.errors.length }));
    bundles[key] = b;
    forceRulesReload = false;
    await saveBundle(key, b);
    return b;
  }

  async function saveBundle(key, b) {
    var copy = Object.assign({}, b);
    delete copy._checked;
    try { await wp('POST', '/rules/' + key, copy); } catch (e) { /* the local copy is only an optimization */ }
  }

  function makeParser(bundle, format) {
    var s = cfg.settings || {};
    return new Core.ArchetypeParser(bundle, {
      aliases: s.aliases || {},
      conflict: s.conflict || 'simpler',
      customRules: (s.customRules || []).filter(function (r) { return !r.Format || String(r.Format).toLowerCase() === String(format).toLowerCase(); })
    });
  }

  /** Classifies a compact tournament. Returns the count per detection method. */
  async function classify(tour, log, opts) {
    opts = opts || {};
    if (!tour.format) throw new Error(t('Format not detected: set it before importing.'));
    var bundle;
    try { bundle = await getBundle(tour.format, tour.date, log); } catch (e) {
      log('  ' + t('no rules for {format} ({error}): using the deck names declared by players, if any.', { format: tour.format, error: e.message }));
      tour.players.forEach(function (p) {
        if (opts.keepManual && p.m === 'manual') return;
        p.a = (cfg.settings.aliases || {})[p.dn] || p.dn || 'Unknown'; p.m = p.dn ? 'declared' : 'unknown';
      });
      return { declared: tour.players.filter(function (p) { return p.m === 'declared'; }).length };
    }
    try {
      var enr = await Core.enrichColorsFromScryfall(http, bundle, tour.cards);
      if (enr.added) { log('  ' + t('colors of {n} new cards fetched from Scryfall', { n: enr.added })); await saveBundle(rulesKey(tour.format), bundle); }
    } catch (e) { log('  ' + t('Scryfall unreachable, continuing ({error})', { error: e.message })); }
    return Core.classifyTournament(tour, makeParser(bundle, tour.format), { keepManual: opts.keepManual });
  }

  var METHOD_SUMMARY = { rule: 'by rule', variant: 'variant', fallback: 'by similarity', conflict: 'conflicts resolved', unknown: 'unrecognized', nolist: 'without list', manual: 'manual', declared: 'declared name' };
  var METHOD_BADGE = { rule: 'rule', variant: 'variant', fallback: 'similarity', conflict: 'conflict', unknown: 'unrecognized', nolist: 'no list', manual: 'manual', declared: 'declared' };

  function summaryText(sum) {
    return Object.keys(sum).filter(function (k) { return sum[k]; }).map(function (k) { return sum[k] + ' ' + t(METHOD_SUMMARY[k] || k); }).join(' · ');
  }

  async function saveTournament(tour) {
    return wp('POST', '/tournaments', JSON.stringify(tour));
  }

  async function loadIndex() {
    try { return await http.json(cfg.dataUrl + '/index.json?t=' + Date.now()); } catch (e) { return { tournaments: [] }; }
  }

  async function loadTournament(entry) {
    return http.json(cfg.dataUrl + '/' + (entry.file || ('t/' + entry.id + '.json')) + '?t=' + Date.now());
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  var TABS = [['import', 'Import'], ['list', 'Saved tournaments'], ['rules', 'Archetypes and rules'], ['preview', 'Shortcode and preview']];
  var nav = h('nav', { class: 'nav-tab-wrapper mtgsa-tabs' });
  var main = h('div', { class: 'mtgsa-main' });
  root.innerHTML = '';
  root.appendChild(nav);
  root.appendChild(main);

  function go(tab, arg) {
    nav.innerHTML = '';
    TABS.forEach(function (x) {
      nav.appendChild(h('a', { href: '#', class: 'nav-tab' + (x[0] === tab ? ' nav-tab-active' : ''), text: t(x[1]), onclick: function (e) { e.preventDefault(); go(x[0]); } }));
    });
    main.innerHTML = '';
    ({ import: renderImport, list: renderList, rules: renderRules, preview: renderPreview, review: renderReview })[tab](main, arg);
  }

  function panel(title, desc) {
    var body = h('div', { class: 'mtgsa-panel-body' });
    var el = h('div', { class: 'mtgsa-panel' }, [h('h2', { text: title }), desc ? h('p', { class: 'description', text: desc }) : null, body]);
    el.body = body;
    return el;
  }

  function makeLog() {
    var pre = h('pre', { class: 'mtgsa-log', 'aria-live': 'polite' });
    var lastTemp = false;
    pre.log = function (msg, temp) {
      if (lastTemp && pre.lastChild) pre.removeChild(pre.lastChild);
      pre.appendChild(document.createTextNode(msg + '\n'));
      lastTemp = !!temp;
      pre.scrollTop = pre.scrollHeight;
      pre.classList.add('is-on');
    };
    return pre;
  }

  // ---------------------------------------------------------------------------
  // Tab: Import
  // ---------------------------------------------------------------------------

  var cacheState = { source: 'melee.gg', month: new Date().toISOString().slice(0, 7), items: [], filter: '', format: '', hideImported: true, selected: new Set() };

  function renderImport(el) {
    var log = makeLog();

    // --- From the cache
    var p1 = panel(t('From MTGODecklistCache (recommended)'),
      t('Melee tournaments collected every day by the public Jiliac/MTGODecklistCache project: standings, round-by-round pairings and decklists. An event usually shows up the day after it ends.'));
    var sourceSel = h('select', {}, [['melee.gg', 'melee.gg'], ['CardsRealm', 'CardsRealm']].map(function (o) {
      return h('option', { value: o[0], selected: o[0] === cacheState.source, text: o[1] });
    }));
    var monthInp = h('input', { type: 'month', value: cacheState.month });
    var searchBtn = h('button', { type: 'button', class: 'button', text: t('Search tournaments') });
    var filterInp = h('input', { type: 'search', placeholder: t('Filter by name…'), value: cacheState.filter, class: 'regular-text' });
    var fmtSel = h('select', {}, [h('option', { value: '', text: t('All formats') })].concat(Core.KNOWN_FORMATS.map(function (f) {
      return h('option', { value: f, selected: f === cacheState.format, text: f });
    })));
    var hideChk = h('input', { type: 'checkbox', checked: cacheState.hideImported });
    var listBox = h('div', { class: 'mtgsa-list' });
    var importBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Import selected') });

    p1.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Source') + ' ', sourceSel]), h('label', {}, [t('Month') + ' ', monthInp]), searchBtn]));
    p1.body.appendChild(h('div', { class: 'mtgsa-row' }, [filterInp, fmtSel, h('label', {}, [hideChk, ' ' + t('Hide already imported')])]));
    p1.body.appendChild(listBox);
    p1.body.appendChild(h('div', { class: 'mtgsa-row' }, [importBtn]));

    var imported = new Set();
    loadIndex().then(function (idx) { (idx.tournaments || []).forEach(function (x) { imported.add(x.id); }); drawList(); });

    function idFor(it) { return Core.slugify(it.source + '-' + it.sourceId + '-' + it.date); }

    function updateImportButton() {
      importBtn.textContent = t('Import selected ({n})', { n: cacheState.selected.size });
      importBtn.disabled = cacheState.selected.size === 0;
    }

    function drawList() {
      listBox.innerHTML = '';
      var q = cacheState.filter.toLowerCase();
      var items = cacheState.items.filter(function (it) {
        it.fmt = it.fmt || Core.guessFormat(it.title);
        if (q && it.title.toLowerCase().indexOf(q) < 0) return false;
        if (cacheState.format && it.fmt !== cacheState.format) return false;
        if (cacheState.hideImported && imported.has(idFor(it))) return false;
        return true;
      });
      updateImportButton();
      if (!cacheState.items.length) { listBox.appendChild(h('p', { class: 'description', text: t('Choose a month and click “Search tournaments”.') })); return; }
      if (!items.length) { listBox.appendChild(h('p', { class: 'description', text: t('No tournament matches the filters.') })); return; }
      var table = h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [h('td', { class: 'check-column' }), h('th', { text: t('Date') }), h('th', { text: t('Tournament') }), h('th', { text: t('Format') }), h('th', { text: t('Size') }), h('th', { text: '' })])]),
        h('tbody', {}, items.map(function (it) {
          var cb = h('input', { type: 'checkbox', checked: cacheState.selected.has(it.path), onchange: function () {
            if (this.checked) cacheState.selected.add(it.path); else cacheState.selected.delete(it.path);
            updateImportButton();
          } });
          return h('tr', {}, [
            h('th', { class: 'check-column' }, [cb]),
            h('td', { text: fmtDate(it.date) }),
            h('td', { text: it.title }),
            h('td', { text: it.fmt || '?' }),
            h('td', { text: kb(it.size) }),
            h('td', { text: imported.has(idFor(it)) ? t('already imported') : '' })
          ]);
        }))
      ]);
      listBox.appendChild(table);
    }

    searchBtn.addEventListener('click', async function () {
      cacheState.source = sourceSel.value;
      cacheState.month = monthInp.value || cacheState.month;
      var ym = cacheState.month.split('-');
      searchBtn.disabled = true;
      listBox.innerHTML = '';
      listBox.appendChild(h('p', { text: t('Searching…') }));
      try {
        cacheState.items = await Core.listCacheMonth(http, cacheState.source, ym[0], ym[1]);
        cacheState.selected = new Set();
      } catch (e) {
        cacheState.items = [];
        log.log(t('Search failed: {error}', { error: e.message }));
      }
      searchBtn.disabled = false;
      drawList();
    });
    filterInp.addEventListener('input', function () { cacheState.filter = this.value; drawList(); });
    fmtSel.addEventListener('change', function () { cacheState.format = this.value; drawList(); });
    hideChk.addEventListener('change', function () { cacheState.hideImported = this.checked; drawList(); });

    importBtn.addEventListener('click', async function () {
      var todo = cacheState.items.filter(function (it) { return cacheState.selected.has(it.path); });
      importBtn.disabled = true; searchBtn.disabled = true;
      var results = [];
      for (var i = 0; i < todo.length; i++) {
        var it = todo[i];
        log.log('[' + (i + 1) + '/' + todo.length + '] ' + it.title);
        try {
          var raw = Core.parseLenientJson(await http.text(it.url));
          var tour = Core.compactFromCache(raw, { source: it.source, sourceId: it.sourceId, file: it.file, title: it.title, date: it.date, id: idFor(it) });
          if (!tour.format) tour.format = it.fmt;
          log.log('  ' + t('{p} players, {r} rounds, format {f}', { p: tour.players.length, r: tour.rounds.length, f: tour.format || '?' }));
          var sum = await classify(tour, log.log);
          log.log('  ' + t('archetypes: {summary}', { summary: summaryText(sum) }));
          await saveTournament(tour);
          imported.add(tour.id);
          cacheState.selected.delete(it.path);
          results.push(tour);
          log.log('  ' + t('saved ✓'));
        } catch (e) {
          log.log('  ' + t('ERROR: {error}', { error: e.message }));
        }
      }
      searchBtn.disabled = false;
      drawList();
      showResults(results);
    });

    // --- Directly from Melee
    var p2 = panel(t('Directly from Melee'),
      t('For events that are not in the cache yet. Reads pairings, Swiss standings and (optionally) every decklist through your site’s server. With decklists, a 1,000-player event takes a few minutes. Rounds in a different format from the main one (e.g. Pro Tour drafts) are excluded from the statistics.'));
    var urlInp = h('input', { type: 'text', class: 'regular-text', placeholder: 'https://melee.gg/Tournament/View/123456' });
    var listsChk = h('input', { type: 'checkbox', checked: true });
    var meleeBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Import from Melee') });
    p2.body.appendChild(h('div', { class: 'mtgsa-row' }, [urlInp, h('label', {}, [listsChk, ' ' + t('Also download decklists')]), meleeBtn]));
    meleeBtn.addEventListener('click', async function () {
      if (!Melee.parseTournamentId(urlInp.value)) { log.log(t('Enter a Melee tournament link or ID.')); return; }
      meleeBtn.disabled = true;
      try {
        log.log('Melee: ' + urlInp.value);
        var tour = await Melee.importTournament(http, urlInp.value, {
          decklists: listsChk.checked,
          concurrency: 4,
          onProgress: function (msg, d, n) { log.log('  ' + msg + (n > 1 ? ' ' + d + '/' + n : ''), true); }
        });
        log.log('  ' + t('{name} · {p} players · {r} rounds · {f}', { name: tour.name, p: tour.players.length, r: tour.rounds.length, f: tour.format || '?' }));
        var ex = tour.rounds.filter(function (r) { return r.ex; });
        if (ex.length) log.log('  ' + t('excluded rounds (different format): {list}', { list: ex.map(function (r) { return r.name + ' [' + r.fmt + ']'; }).join(', ') }));
        var sum = await classify(tour, log.log);
        log.log('  ' + t('archetypes: {summary}', { summary: summaryText(sum) }));
        await saveTournament(tour);
        log.log('  ' + t('saved ✓'));
        showResults([tour]);
      } catch (e) {
        log.log('  ' + t('ERROR: {error}', { error: e.message }));
      }
      meleeBtn.disabled = false;
    });

    var resultsBox = h('div');
    function showResults(list) {
      resultsBox.innerHTML = '';
      if (!list.length) return;
      var p3 = panel(t('Imported'), t('Check the unrecognized decks: you can fix them by hand or add a rule in the “Archetypes and rules” tab.'));
      p3.body.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [t('Tournament'), t('Players'), t('Unrecognized'), ''].map(function (x) { return h('th', { text: x }); }))]),
        h('tbody', {}, list.map(function (tour) {
          var unk = tour.players.filter(function (p) { return p.a === 'Unknown'; }).length;
          return h('tr', {}, [h('td', { text: tour.name }), h('td', { text: String(tour.players.length) }), h('td', { text: String(unk) }),
            h('td', {}, [h('button', { type: 'button', class: 'button', text: t('Review'), onclick: function () { go('review', tour); } })])]);
        }))
      ]));
      resultsBox.appendChild(p3);
    }

    el.appendChild(p1);
    el.appendChild(p2);
    el.appendChild(log);
    el.appendChild(resultsBox);
    drawList();
  }

  // ---------------------------------------------------------------------------
  // Tab: Saved tournaments
  // ---------------------------------------------------------------------------

  async function renderList(el) {
    var p = panel(t('Saved tournaments'), t('Files in wp-content/uploads/mtgstats/. “Reclassify” applies the current rules, aliases and custom rules again, keeping manual fixes.'));
    var log = makeLog();
    el.appendChild(p);
    el.appendChild(log);
    p.body.appendChild(h('p', { text: t('Loading…') }));
    var idx = await loadIndex();
    var list = (idx.tournaments || []).slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    p.body.innerHTML = '';
    if (!list.length) { p.body.appendChild(h('p', { text: t('No saved tournaments. Go to “Import”.') })); return; }

    var reclassAll = h('button', { type: 'button', class: 'button', text: t('Reclassify all') });
    p.body.appendChild(h('div', { class: 'mtgsa-row' }, [reclassAll]));

    async function reclassify(entry) {
      log.log(entry.name);
      var tour = await loadTournament(entry);
      var sum = await classify(tour, log.log, { keepManual: true });
      log.log('  ' + summaryText(sum));
      await saveTournament(tour);
    }

    var tbody = h('tbody', {}, list.map(function (e) {
      var tr = h('tr', {}, [
        h('td', { text: fmtDate(e.date) }),
        h('td', {}, [e.uri && /^https?:/.test(e.uri) ? h('a', { href: e.uri, target: '_blank', rel: 'noopener', text: e.name }) : e.name]),
        h('td', { text: e.format }),
        h('td', { text: String(e.players) }),
        h('td', { text: e.unknown === undefined ? '' : String(e.unknown) }),
        h('td', { class: 'mtgsa-actions' }, [
          h('button', { type: 'button', class: 'button button-small', text: t('Review'), onclick: async function () { go('review', await loadTournament(e)); } }),
          h('button', { type: 'button', class: 'button button-small', text: t('Reclassify'), onclick: async function () {
            this.disabled = true;
            try { await reclassify(e); log.log('  ' + t('done ✓')); } catch (err) { log.log('  ' + t('ERROR: {error}', { error: err.message })); }
            go('list');
          } }),
          h('button', { type: 'button', class: 'button button-small button-link-delete', text: t('Delete'), onclick: async function () {
            if (!window.confirm(t('Delete “{name}”? The file will be removed from the site.', { name: e.name }))) return;
            try { await wp('DELETE', '/tournaments/' + e.id); tr.remove(); } catch (err) { log.log(t('Error: {error}', { error: err.message })); }
          } })
        ])
      ]);
      return tr;
    }));
    p.body.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
      h('thead', {}, [h('tr', {}, [t('Date'), t('Tournament'), t('Format'), t('Players'), t('Unrecognized'), ''].map(function (x) { return h('th', { text: x }); }))]),
      tbody
    ]));
    reclassAll.addEventListener('click', async function () {
      reclassAll.disabled = true;
      for (var i = 0; i < list.length; i++) {
        try { await reclassify(list[i]); } catch (err) { log.log('  ' + t('ERROR: {error}', { error: err.message })); }
      }
      log.log(t('Done.'));
      go('list');
    });
  }

  // ---------------------------------------------------------------------------
  // Tournament review
  // ---------------------------------------------------------------------------

  function renderReview(el, tour) {
    var dirty = false;
    var saveBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Save changes'), disabled: true });
    var status = h('span', { class: 'mtgsa-status' });
    var markDirty = function () { dirty = true; saveBtn.disabled = false; status.textContent = t('Unsaved changes'); };

    el.appendChild(h('p', {}, [h('a', { href: '#', text: '← ' + t('Back to tournaments'), onclick: function (e) {
      e.preventDefault();
      if (!dirty || window.confirm(t('There are unsaved changes. Leave anyway?'))) go('list');
    } })]));

    // General data
    var p0 = panel(tour.name, null);
    var nameInp = h('input', { type: 'text', class: 'regular-text', value: tour.name, oninput: function () { tour.name = this.value; markDirty(); } });
    var dateInp = h('input', { type: 'date', value: tour.date, onchange: function () { tour.date = this.value; markDirty(); } });
    var fmtInp = h('input', { type: 'text', value: tour.format, list: 'mtgsa-formats', oninput: function () { tour.format = this.value; markDirty(); } });
    p0.body.appendChild(h('datalist', { id: 'mtgsa-formats' }, Core.KNOWN_FORMATS.map(function (f) { return h('option', { value: f }); })));
    p0.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Name') + ' ', nameInp]), h('label', {}, [t('Date') + ' ', dateInp]), h('label', {}, [t('Format') + ' ', fmtInp])]));
    if (tour.rounds.length) {
      p0.body.appendChild(h('p', { class: 'description', text: t('Rounds included in the statistics (untick draft or invalid rounds):') }));
      p0.body.appendChild(h('div', { class: 'mtgsa-rounds' }, tour.rounds.map(function (r) {
        return h('label', {}, [h('input', { type: 'checkbox', checked: !r.ex, onchange: function () { if (this.checked) delete r.ex; else r.ex = 1; markDirty(); } }), ' ' + r.name + (r.fmt ? ' (' + r.fmt + ')' : '')]);
      })));
    }
    el.appendChild(p0);

    // Archetype summary + rename
    var counts = {};
    var archNames = function () {
      counts = {};
      tour.players.forEach(function (p) { counts[p.a || 'Unknown'] = (counts[p.a || 'Unknown'] || 0) + 1; });
      return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    };
    var dl = h('datalist', { id: 'mtgsa-archs' });
    var refreshDatalist = function () {
      dl.innerHTML = '';
      archNames().forEach(function (a) { dl.appendChild(h('option', { value: a })); });
    };
    refreshDatalist();

    var p1 = panel(t('Archetypes'), t('Rename an archetype for every player in this tournament. To make it permanent across tournaments, use an alias in the “Archetypes and rules” tab.'));
    var fromSel = h('select');
    var toInp = h('input', { type: 'text', list: 'mtgsa-archs', placeholder: t('New name') });
    var renameBtn = h('button', { type: 'button', class: 'button', text: t('Rename') });
    var summaryBox = h('p', { class: 'mtgsa-chips' });
    var drawSummary = function () {
      var names = archNames();
      fromSel.innerHTML = '';
      names.forEach(function (a) { fromSel.appendChild(h('option', { value: a, text: a + ' (' + counts[a] + ')' })); });
      summaryBox.innerHTML = '';
      names.forEach(function (a) { summaryBox.appendChild(h('span', { class: 'mtgsa-chip' + (a === 'Unknown' ? ' is-warn' : ''), text: a + ' ' + counts[a] })); });
    };
    renameBtn.addEventListener('click', function () {
      var to = toInp.value.trim(), from = fromSel.value;
      if (!to || to === from) return;
      tour.players.forEach(function (p) { if ((p.a || 'Unknown') === from) { p.a = to; p.m = 'manual'; } });
      toInp.value = '';
      refreshDatalist(); drawSummary(); drawPlayers(); markDirty();
    });
    p1.body.appendChild(summaryBox);
    p1.body.appendChild(h('div', { class: 'mtgsa-row' }, [fromSel, '→', toInp, renameBtn]));
    p1.body.appendChild(dl);
    el.appendChild(p1);

    // Players
    var p2 = panel(t('Players'), null);
    var filterSel = h('select', {}, [['check', t('To check (unrecognized, conflicts, similarity)')], ['all', t('All')], ['manual', t('Fixed by hand')]].map(function (o) {
      return h('option', { value: o[0], text: o[1] });
    }));
    var searchInp = h('input', { type: 'search', placeholder: t('Search player or archetype…') });
    var playersBox = h('div', { class: 'mtgsa-players' });
    p2.body.appendChild(h('div', { class: 'mtgsa-row' }, [filterSel, searchInp]));
    p2.body.appendChild(playersBox);
    el.appendChild(p2);

    function deckText(p) {
      var line = function (e) { return e[1] + ' ' + tour.cards[e[0]]; };
      return (p.mb || []).map(line).join('\n') + ((p.sb || []).length ? '\n\nSideboard\n' + p.sb.map(line).join('\n') : '');
    }

    function drawPlayers() {
      playersBox.innerHTML = '';
      var q = searchInp.value.toLowerCase(), f = filterSel.value;
      var list = tour.players.filter(function (p) {
        if (f === 'check' && ['unknown', 'conflict', 'fallback'].indexOf(p.m) < 0 && p.a !== 'Unknown') return false;
        if (f === 'manual' && p.m !== 'manual') return false;
        if (q && (p.n + ' ' + p.a + ' ' + (p.dn || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      if (!list.length) { playersBox.appendChild(h('p', { class: 'description', text: t('No players to show.') })); return; }
      var shown = list.slice(0, 300);
      var tbody = h('tbody');
      shown.forEach(function (p) {
        var badge = h('span', { class: 'mtgsa-badge is-' + p.m, text: METHOD_BADGE[p.m] ? t(METHOD_BADGE[p.m]) : (p.m || '') });
        var inp = h('input', { type: 'text', list: 'mtgsa-archs', value: p.a || '', class: 'mtgsa-arch-input', onchange: function () {
          p.a = this.value.trim() || 'Unknown'; p.m = 'manual';
          badge.textContent = t(METHOD_BADGE.manual);
          refreshDatalist(); drawSummary(); markDirty();
        } });
        var deckRow = h('tr', { class: 'mtgsa-deckrow', hidden: true }, [h('td', { colspan: '6' }, [h('pre', { text: deckText(p) || t('List not available') })])]);
        var info = [];
        if (p.dn) info.push(t('declared: {v}', { v: p.dn }));
        if (p.cand) info.push(t('candidates: {v}', { v: p.cand.join(', ') }));
        if (p.col) info.push(t('colors: {v}', { v: p.col }));
        tbody.appendChild(h('tr', {}, [
          h('td', { text: p.n }),
          h('td', { text: p.w !== undefined ? p.w + '-' + p.l + (p.d ? '-' + p.d : '') : '' }),
          h('td', {}, [inp]),
          h('td', {}, [badge]),
          h('td', { class: 'mtgsa-info', text: info.join(' · ') }),
          h('td', {}, [p.mb ? h('button', { type: 'button', class: 'button button-small', text: t('List'), onclick: function () { deckRow.hidden = !deckRow.hidden; } }) : null])
        ]));
        tbody.appendChild(deckRow);
      });
      playersBox.appendChild(h('table', { class: 'widefat mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [t('Player'), t('Record'), t('Archetype'), t('Method'), t('Details'), ''].map(function (x) { return h('th', { text: x }); }))]),
        tbody
      ]));
      if (list.length > shown.length) playersBox.appendChild(h('p', { class: 'description', text: t('Showing 300 of {n}: use the search to narrow down.', { n: list.length }) }));
    }
    filterSel.addEventListener('change', drawPlayers);
    searchInp.addEventListener('input', drawPlayers);
    drawSummary();
    drawPlayers();

    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      status.textContent = t('Saving…');
      try {
        await saveTournament(tour);
        dirty = false;
        status.textContent = t('Saved ✓');
      } catch (e) {
        saveBtn.disabled = false;
        status.textContent = t('Error: {error}', { error: e.message });
      }
    });
    el.appendChild(h('div', { class: 'mtgsa-savebar' }, [saveBtn, status]));
  }

  // ---------------------------------------------------------------------------
  // Tab: Archetypes and rules
  // ---------------------------------------------------------------------------

  var RULE_EXAMPLE = [
    {
      Name: 'DevotedDruidCombo',
      Format: 'Modern',
      IncludeColorInName: false,
      Conditions: [
        { Type: 'InMainboard', Cards: ['Devoted Druid'] },
        { Type: 'OneOrMoreInMainboard', Cards: ['Vizier of Remedies', 'Luxior, Giada\'s Gift'] }
      ]
    }
  ];

  function renderRules(el) {
    var s = cfg.settings || {};
    var p1 = panel(t('Aliases'), t('One alias per line, as “Detected name => Displayed name”. Useful to standardize names (e.g. Simic Birthing Ritual => Simic Ritual). Applies to new imports and to “Reclassify”.'));
    var aliasTa = h('textarea', { rows: 8, class: 'large-text code', spellcheck: 'false' });
    aliasTa.value = Object.keys(s.aliases || {}).map(function (k) { return k + ' => ' + s.aliases[k]; }).join('\n');
    p1.body.appendChild(aliasTa);

    var p2 = panel(t('Custom rules'), t('Same JSON schema as the MTGOFormatData rules (conditions: InMainboard, InSideboard, InMainOrSideboard, OneOrMoreIn…, TwoOrMoreIn…, DoesNotContain…). The optional “Format” field limits a rule to one format. Custom rules take precedence over the community ones.'));
    var rulesTa = h('textarea', { rows: 14, class: 'large-text code', spellcheck: 'false', placeholder: JSON.stringify(RULE_EXAMPLE, null, 2) });
    rulesTa.value = (s.customRules || []).length ? JSON.stringify(s.customRules, null, 2) : '';
    p2.body.appendChild(rulesTa);
    p2.body.appendChild(h('p', {}, [h('button', { type: 'button', class: 'button', text: t('Insert example'), onclick: function () { if (!rulesTa.value.trim()) rulesTa.value = JSON.stringify(RULE_EXAMPLE, null, 2); } })]));

    var p3 = panel(t('Options'), null);
    var conflictSel = h('select', {}, [['simpler', t('When several rules match, pick the simplest')], ['none', t('When several rules match, mark “Conflict(…)”')]].map(function (o) {
      return h('option', { value: o[0], selected: (s.conflict || 'simpler') === o[0], text: o[1] });
    }));
    var priorInp = h('input', { type: 'number', min: '0', max: '100', value: String(s.prior === undefined ? 10 : s.prior), class: 'small-text' });
    p3.body.appendChild(h('div', { class: 'mtgsa-row' }, [conflictSel]));
    p3.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Bayesian win-rate prior: Beta('), priorInp, t(', same value)')])]));
    p3.body.appendChild(h('p', { class: 'description', text: t('10 = cautious estimate with few matches, 1 = almost no smoothing.') }));
    var accentOn = h('input', { type: 'checkbox', checked: !!s.accent });
    var accentInp = h('input', { type: 'color', value: s.accent || '#2a78d6' });
    p3.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [accentOn, ' ' + t('Custom accent color') + ' ', accentInp])]));
    p3.body.appendChild(h('p', { class: 'description', text: t('When off, the dashboard uses the WordPress theme’s primary color (if the theme declares one) or a neutral blue.') }));
    var reloadBtn = h('button', { type: 'button', class: 'button', text: t('Reload community rules on the next import') });
    reloadBtn.addEventListener('click', function () { forceRulesReload = true; bundles = {}; reloadBtn.textContent = t('OK: they will be downloaded again'); reloadBtn.disabled = true; });
    p3.body.appendChild(h('div', { class: 'mtgsa-row' }, [reloadBtn]));

    var status = h('span', { class: 'mtgsa-status' });
    var saveBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Save settings') });
    saveBtn.addEventListener('click', async function () {
      var aliases = {}, bad = [];
      aliasTa.value.split('\n').forEach(function (line, i) {
        if (!line.trim()) return;
        var m = line.split('=>');
        if (m.length !== 2 || !m[0].trim() || !m[1].trim()) bad.push(i + 1); else aliases[m[0].trim()] = m[1].trim();
      });
      if (bad.length) { status.textContent = t('Invalid aliases on lines {lines}', { lines: bad.join(', ') }); return; }
      var rules = [];
      if (rulesTa.value.trim()) {
        try { rules = JSON.parse(rulesTa.value); if (!Array.isArray(rules)) rules = [rules]; } catch (e) { status.textContent = t('Invalid rules JSON: {error}', { error: e.message }); return; }
        var invalid = rules.filter(function (r) { return !r || !r.Name || !Array.isArray(r.Conditions) || !r.Conditions.length; });
        if (invalid.length) { status.textContent = t('Every rule needs a Name and at least one condition.'); return; }
      }
      saveBtn.disabled = true;
      try {
        cfg.settings = await wp('POST', '/settings', { aliases: aliases, customRules: rules, conflict: conflictSel.value, prior: parseInt(priorInp.value, 10) || 0, accent: accentOn.checked ? accentInp.value : '' });
        status.textContent = t('Saved ✓ — use “Reclassify all” in “Saved tournaments” to apply them to existing tournaments.');
      } catch (e) { status.textContent = t('Error: {error}', { error: e.message }); }
      saveBtn.disabled = false;
    });

    el.appendChild(p1);
    el.appendChild(p2);
    el.appendChild(p3);
    el.appendChild(h('div', { class: 'mtgsa-savebar' }, [saveBtn, status]));
  }

  // ---------------------------------------------------------------------------
  // Tab: Shortcode and preview
  // ---------------------------------------------------------------------------

  function renderPreview(el) {
    var p = panel(t('Shortcode'), t('Add the shortcode to a page or post (“Shortcode” block in the editor).'));
    var examples = [
      ['[mtgstats]', t('Full dashboard; most common format, last 30 days.')],
      ['[mtgstats format="Pauper" days="60"]', t('Initial format and period.')],
      ['[mtgstats tournaments="ID1,ID2"]', t('Only some tournaments (IDs are in the saved tournaments list and in the file names).')],
      ['[mtgstats tabs="meta,mu"]', t('Only some tabs: meta, mu, pos, trend, conv, cards, players, data.')],
      ['[mtgstats theme="dark"]', t('Theme: auto (default, follows the page background), light, dark.')],
      ['[mtgstats accent="#c2412d"]', t('Accent color for this page (otherwise the one from the settings or the theme).')],
      ['[mtgstats lang="en"]', t('Language: en or it (default: the site language).')]
    ];
    p.body.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [h('tbody', {}, examples.map(function (e) {
      return h('tr', {}, [h('td', {}, [h('code', { text: e[0] })]), h('td', { text: e[1] })]);
    }))]));
    el.appendChild(p);
    var p2 = panel(t('Preview'), null);
    var app = h('div', { class: 'mtgstats-app', 'data-src': cfg.dataUrl, 'data-days': '30', 'data-url-state': 'off', 'data-theme': 'light', 'data-lang': I18n.lang, 'data-accent': (cfg.settings || {}).accent || '', 'data-prior': String((cfg.settings || {}).prior || 10) });
    p2.body.appendChild(app);
    el.appendChild(p2);
    if (window.MTGStatsViewer) window.MTGStatsViewer.boot();
  }

  go('import');
})();
