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

  // Supplementary rules shipped with the plugin (assets/rules-extra.json): archetypes the community rules do not cover yet
  var extrasPromise = null;
  function getExtras() {
    if (!extrasPromise) {
      extrasPromise = cfg.assetsUrl
        ? http.json(cfg.assetsUrl + 'rules-extra.json?v=' + encodeURIComponent(cfg.version || '')).catch(function () { return { formats: {} }; })
        : Promise.resolve({ formats: {} });
    }
    return extrasPromise;
  }

  function sameFormat(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

  function byFormat(map, format) {
    var key = Object.keys(map || {}).filter(function (k) { return sameFormat(k, format); })[0];
    return key ? map[key] : [];
  }

  /** House rules that apply to a format: those without a format and those of that format, unless switched off */
  function houseRulesFor(format) {
    return ((cfg.settings || {}).customRules || []).filter(function (r) { return r && !r.Disabled && (!r.Format || sameFormat(r.Format, format)); });
  }

  var EMPTY_BUNDLE = { lands: {}, nonLands: {}, archetypes: [], fallbacks: [] };

  function makeParser(bundle, format, extras) {
    var s = cfg.settings || {};
    return new Core.ArchetypeParser(bundle, {
      aliases: s.aliases || {},
      conflict: s.conflict || 'simpler',
      customRules: houseRulesFor(format),
      extraRules: byFormat((extras || {}).formats, format)
    });
  }

  /** Classifies a compact tournament. Returns the count per detection method. */
  async function classify(tour, log, opts) {
    opts = opts || {};
    if (!tour.format) throw new Error(t('Format not detected: set it before importing.'));
    var extras = await getExtras();
    var bundle;
    try { bundle = await getBundle(tour.format, tour.date, log); } catch (e) {
      // No community rules for this format: house and supplementary rules still apply, then the declared deck names
      log('  ' + t('no rules for {format} ({error}): using your house rules and the deck names declared by players, if any.', { format: tour.format, error: e.message }));
      var sum = Core.classifyTournament(tour, makeParser(EMPTY_BUNDLE, tour.format, extras), { keepManual: opts.keepManual });
      tour.players.forEach(function (p) {
        if (p.m === 'unknown' && p.dn) { p.m = 'declared'; sum.unknown--; sum.declared = (sum.declared || 0) + 1; }
      });
      return sum;
    }
    try {
      var enr = await Core.enrichColorsFromScryfall(http, bundle, tour.cards);
      if (enr.added) { log('  ' + t('colors of {n} new cards fetched from Scryfall', { n: enr.added })); await saveBundle(rulesKey(tour.format), bundle); }
    } catch (e) { log('  ' + t('Scryfall unreachable, continuing ({error})', { error: e.message })); }
    return Core.classifyTournament(tour, makeParser(bundle, tour.format, extras), { keepManual: opts.keepManual });
  }

  var METHOD_SUMMARY = { rule: 'by rule', custom: 'by house rule', variant: 'variant', extra: 'by supplementary rule', fallback: 'by similarity', conflict: 'conflicts resolved', unknown: 'unrecognized', nolist: 'without list', manual: 'manual', declared: 'declared name' };
  var METHOD_BADGE = { rule: 'rule', custom: 'house rule', variant: 'variant', extra: 'supplementary', fallback: 'similarity', conflict: 'conflict', unknown: 'unrecognized', nolist: 'no list', manual: 'manual', declared: 'declared' };

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

  /** Applies the current rules again to saved tournaments, keeping manual fixes */
  async function reclassifyEntries(entries, log) {
    var ok = 0;
    for (var i = 0; i < entries.length; i++) {
      log('[' + (i + 1) + '/' + entries.length + '] ' + entries[i].name);
      try {
        var tour = await loadTournament(entries[i]);
        var sum = await classify(tour, log, { keepManual: true });
        log('  ' + summaryText(sum));
        await saveTournament(tour);
        ok++;
      } catch (err) { log('  ' + t('ERROR: {error}', { error: err.message })); }
    }
    log(t('Done: {n} of {total} tournaments reclassified.', { n: ok, total: entries.length }));
    return ok;
  }

  /** Saves the settings, keeping the values that are not passed */
  async function saveSettings(patch) {
    var s = cfg.settings || {};
    var body = Object.assign({ aliases: s.aliases || {}, customRules: s.customRules || [], focus: s.focus || [], conflict: s.conflict || 'simpler', prior: s.prior === undefined ? 10 : s.prior, accent: s.accent || '' }, patch);
    cfg.settings = await wp('POST', '/settings', body);
    return cfg.settings;
  }

  /** A checkbox in a table header that selects every visible row */
  function selectAllBox(rows, selected, keyOf, onChange) {
    var box = h('input', { type: 'checkbox', 'aria-label': t('Select all') });
    var sync = function () {
      var n = rows.filter(function (r) { return selected.has(keyOf(r)); }).length;
      box.checked = rows.length > 0 && n === rows.length;
      box.indeterminate = n > 0 && n < rows.length;
    };
    box.addEventListener('change', function () {
      var on = box.checked;
      rows.forEach(function (r) { if (on) selected.add(keyOf(r)); else selected.delete(keyOf(r)); });
      onChange();
    });
    sync();
    box.sync = sync;
    return box;
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  var TABS = [['import', 'Import'], ['list', 'Saved tournaments'], ['rules', 'Archetypes and rules'], ['focus', 'Deck focus'], ['preview', 'Shortcode and preview']];
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
    ({ import: renderImport, list: renderList, rules: renderRules, focus: renderFocusAdmin, preview: renderPreview, review: renderReview })[tab](main, arg);
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
      t('Tournaments collected every day by public community projects (Jiliac/MTGODecklistCache, and fbettega/MTG_decklistcache for MTGO): standings, pairings and decklists. An event usually shows up the day after it ends. MTGO Challenges only include the top 8 pairings, and MTGO Leagues only publish 5-0 decklists, which inflates their win rates.'));
    var sourceSel = h('select', {}, Core.CACHE_SOURCES.map(function (s) {
      var label = s.until ? t('{source} (archive, until {month})', { source: s.key, month: s.until.split('-').reverse().join('/') }) : s.key;
      return h('option', { value: s.key, selected: s.key === cacheState.source, text: label });
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
      var all = selectAllBox(items, cacheState.selected, function (it) { return it.path; }, drawList);
      var table = h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [h('td', { class: 'check-column' }, [all]), h('th', { text: t('Date') }), h('th', { text: t('Tournament') }), h('th', { text: t('Format') }), h('th', { text: t('Size') }), h('th', { text: '' })])]),
        h('tbody', {}, items.map(function (it) {
          var cb = h('input', { type: 'checkbox', checked: cacheState.selected.has(it.path), onchange: function () {
            if (this.checked) cacheState.selected.add(it.path); else cacheState.selected.delete(it.path);
            updateImportButton();
            all.sync();
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

    var selected = new Set();
    var formats = list.map(function (e) { return e.format; }).filter(function (f, i, a) { return f && a.indexOf(f) === i; }).sort();
    var fmtSel = h('select', {}, [h('option', { value: '', text: t('All formats') })].concat(formats.map(function (f) { return h('option', { value: f, text: f }); })));
    var searchInp = h('input', { type: 'search', placeholder: t('Filter by name…'), class: 'regular-text' });
    var reclassBtn = h('button', { type: 'button', class: 'button' });
    var deleteBtn = h('button', { type: 'button', class: 'button button-link-delete' });
    var tableBox = h('div');
    p.body.appendChild(h('div', { class: 'mtgsa-row' }, [searchInp, fmtSel]));
    p.body.appendChild(tableBox);
    p.body.appendChild(h('div', { class: 'mtgsa-row' }, [reclassBtn, deleteBtn]));

    function updateBulk() {
      reclassBtn.textContent = t('Reclassify selected ({n})', { n: selected.size });
      deleteBtn.textContent = t('Delete selected ({n})', { n: selected.size });
      reclassBtn.disabled = deleteBtn.disabled = selected.size === 0;
    }

    function draw() {
      var q = searchInp.value.toLowerCase(), f = fmtSel.value;
      var rows = list.filter(function (e) { return (!f || e.format === f) && (!q || String(e.name).toLowerCase().indexOf(q) >= 0); });
      // The selection only keeps visible tournaments, so bulk actions never touch rows hidden by the filters
      Array.from(selected).forEach(function (id) { if (!rows.some(function (e) { return e.id === id; })) selected.delete(id); });
      var all = selectAllBox(rows, selected, function (e) { return e.id; }, draw);
      tableBox.innerHTML = '';
      updateBulk();
      if (!rows.length) { tableBox.appendChild(h('p', { class: 'description', text: t('No tournament matches the filters.') })); return; }
      tableBox.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [h('td', { class: 'check-column' }, [all])].concat([t('Date'), t('Tournament'), t('Format'), t('Players'), t('Unrecognized'), ''].map(function (x) { return h('th', { text: x }); })))]),
        h('tbody', {}, rows.map(function (e) {
          return h('tr', {}, [
            h('th', { class: 'check-column' }, [h('input', { type: 'checkbox', checked: selected.has(e.id), onchange: function () {
              if (this.checked) selected.add(e.id); else selected.delete(e.id);
              all.sync(); updateBulk();
            } })]),
            h('td', { text: fmtDate(e.date) }),
            h('td', {}, [e.uri && /^https?:/.test(e.uri) ? h('a', { href: e.uri, target: '_blank', rel: 'noopener', text: e.name }) : e.name]),
            h('td', { text: e.format }),
            h('td', { text: String(e.players) }),
            h('td', { text: e.unknown === undefined ? '' : String(e.unknown) }),
            h('td', { class: 'mtgsa-actions' }, [
              h('button', { type: 'button', class: 'button button-small', text: t('Review'), onclick: async function () { go('review', await loadTournament(e)); } })
            ])
          ]);
        }))
      ]));
    }

    function chosen() { return list.filter(function (e) { return selected.has(e.id); }); }

    reclassBtn.addEventListener('click', async function () {
      reclassBtn.disabled = deleteBtn.disabled = true;
      await reclassifyEntries(chosen(), log.log);
      go('list');
    });
    deleteBtn.addEventListener('click', async function () {
      var todo = chosen();
      var msg = todo.length === 1 ? t('Delete “{name}”? The file will be removed from the site.', { name: todo[0].name }) : t('Delete {n} tournaments? The files will be removed from the site.', { n: todo.length });
      if (!window.confirm(msg)) return;
      reclassBtn.disabled = deleteBtn.disabled = true;
      for (var i = 0; i < todo.length; i++) {
        try {
          await wp('DELETE', '/tournaments/' + todo[i].id);
          list.splice(list.indexOf(todo[i]), 1);
          selected.delete(todo[i].id);
        } catch (err) { log.log(t('Error: {error}', { error: err.message })); }
      }
      draw();
    });
    searchInp.addEventListener('input', draw);
    fmtSel.addEventListener('change', draw);
    draw();
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

  // How each condition type reads in the editor and in the catalog
  var CONDITION_LABELS = {
    InMainboard: 'Main deck: all of',
    InSideboard: 'Sideboard: all of',
    InMainOrSideboard: 'Main deck or sideboard: all of',
    OneOrMoreInMainboard: 'Main deck: at least one of',
    OneOrMoreInSideboard: 'Sideboard: at least one of',
    OneOrMoreInMainOrSideboard: 'Main deck or sideboard: at least one of',
    TwoOrMoreInMainboard: 'Main deck: at least two of',
    TwoOrMoreInSideboard: 'Sideboard: at least two of',
    TwoOrMoreInMainOrSideboard: 'Main deck or sideboard: at least two of',
    DoesNotContain: 'Main deck and sideboard: none of',
    DoesNotContainMainboard: 'Main deck: none of',
    DoesNotContainSideboard: 'Sideboard: none of'
  };

  var RULE_EXAMPLE = [
    {
      Name: 'Devoted Combo',
      Format: 'Modern',
      IncludeColorInName: false,
      Conditions: [
        { Type: 'InMainboard', Cards: ['Devoted Druid'] },
        { Type: 'OneOrMoreInMainboard', Cards: ['Vizier of Remedies', 'Luxior, Giada\'s Gift'] }
      ]
    }
  ];

  var TEST_MAX_TOURNAMENTS = 25;

  function cardList(cards) {
    if (typeof cards === 'string') cards = cards.split(/\r?\n/);
    return (Array.isArray(cards) ? cards : []).map(Core.normCardName).filter(Boolean);
  }

  /**
   * Groups the conditions for display and editing: single-card conditions of the same type become one line
   * ("Main deck: all of A, B"). Like the community parser, they only look at their first card.
   */
  function conditionGroups(conditions) {
    var out = [];
    (Array.isArray(conditions) ? conditions : []).forEach(function (c) {
      c = c || {};
      var type = Core.CONDITION_TYPES.filter(function (x) { return x.toLowerCase() === String(c.Type || '').replace(/\s+/g, '').toLowerCase(); })[0] || String(c.Type || '');
      var cards = cardList(c.Cards !== undefined ? c.Cards : c.Card);
      var single = !/OrMore/.test(type);
      var prev = single && out.filter(function (g) { return g.Type === type; })[0];
      if (single) cards = cards.slice(0, 1);
      if (prev) prev.Cards = prev.Cards.concat(cards); else out.push({ Type: type, Cards: cards });
    });
    return out;
  }

  function conditionText(c) {
    return (CONDITION_LABELS[c.Type] ? t(CONDITION_LABELS[c.Type]) : c.Type) + ' ' + c.Cards.join(', ');
  }

  function ruleSummary(rule) {
    var text = conditionGroups(rule.Conditions).map(conditionText).join(' · ');
    var variants = (rule.Variants || []).map(function (v) { return v && v.Name; }).filter(Boolean);
    if (variants.length) text += ' · ' + t('variants: {list}', { list: variants.join(', ') });
    return text;
  }

  /** Normalized copy of a rule when it is valid, the rule as it is otherwise (it stays visible with its errors) */
  function cleanRule(raw) {
    var res = Core.normalizeRule(raw);
    if (res.errors.length) return raw;
    if (raw.Disabled) res.rule.Disabled = true;
    return res.rule;
  }

  function ruleName(rule, custom) {
    var name = Core.archetypeDisplayName({ Name: rule.Name, IncludeColorInName: false, _custom: custom }, '');
    return rule.IncludeColorInName ? t('[colors]') + ' ' + name : name;
  }

  // --- Card names: Scryfall suggestions and spelling check

  var suggestCache = {}, checkCache = {};

  function suggestCards(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return Promise.resolve([]);
    if (!suggestCache[q]) {
      suggestCache[q] = http.json('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(q))
        .then(function (r) { return r.data || []; }, function () { return []; });
    }
    return suggestCache[q];
  }

  /** { ok: true, name } when Scryfall knows the card, { ok: false } when it does not, { ok: null } when it cannot be reached */
  function checkCard(name) {
    var key = Core.cardKey(name);
    if (!checkCache[key]) {
      checkCache[key] = http.json('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name))
        .then(function (c) { return { ok: true, name: Core.normCardName(c.name) }; },
          function (e) { return { ok: /^HTTP 404/.test(e.message) ? false : null }; });
    }
    return checkCache[key];
  }

  var pickerSeq = 0;

  /** Card list editor: one chip per card, suggestions while typing, several cards at once by pasting one per line */
  function cardPicker(cards, onChange) {
    var id = 'mtgsa-cards-' + (++pickerSeq);
    var options = h('datalist', { id: id });
    var chips = h('span', { class: 'mtgsa-cardchips' });
    var input = h('input', { type: 'text', list: id, class: 'mtgsa-cardinput', placeholder: t('Add a card…'), autocomplete: 'off', 'aria-label': t('Add a card…') });
    var timer = null;

    function changed() { draw(); onChange(); }

    function draw() {
      chips.innerHTML = '';
      cards.forEach(function (name, i) {
        var chip = h('span', { class: 'mtgsa-cardchip' }, [h('span', { text: name }), h('button', {
          type: 'button', class: 'mtgsa-chip-x', text: '×', 'aria-label': t('Remove {name}', { name: name }),
          onclick: function (e) { e.stopPropagation(); cards.splice(i, 1); changed(); }
        })]);
        chips.appendChild(chip);
        checkCard(name).then(function (res) {
          if (cards[i] !== name) return;
          if (res.ok === false) {
            chip.classList.add('is-bad');
            chip.title = t('Card not found on Scryfall: check the spelling.');
          } else if (res.ok && res.name !== name) {
            if (Core.cardKey(res.name) === Core.cardKey(name)) { cards[i] = res.name; changed(); return; }
            chip.classList.add('is-warn');
            chip.title = t('Did you mean “{name}”? Click to fix.', { name: res.name });
            chip.addEventListener('click', function () { cards[i] = res.name; changed(); });
          }
        });
      });
    }

    function add(text) {
      text.split(/\r?\n|;/).map(function (line) { return Core.normCardName(line.replace(/^\s*\d+x?\s+/i, '')); }).filter(Boolean).forEach(function (n) {
        if (!cards.some(function (c) { return Core.cardKey(c) === Core.cardKey(n); })) cards.push(n);
      });
      input.value = '';
      options.innerHTML = '';
      changed();
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) add(input.value); }
      else if (e.key === 'Backspace' && !input.value && cards.length) { cards.pop(); changed(); }
    });
    input.addEventListener('input', function (e) {
      var v = input.value;
      // Picking a suggestion fires an input event that is not typing
      if (!e.inputType || e.inputType === 'insertReplacementText') {
        if (Array.prototype.some.call(options.options, function (o) { return o.value === v; })) { add(v); return; }
      }
      clearTimeout(timer);
      timer = setTimeout(function () {
        suggestCards(v).then(function (names) {
          if (input.value !== v) return;
          options.innerHTML = '';
          names.forEach(function (n) { options.appendChild(h('option', { value: n })); });
        });
      }, 200);
    });
    input.addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text');
      if (/\n/.test(text)) { e.preventDefault(); add(text); }
    });
    input.addEventListener('blur', function () { if (input.value.trim().length >= 3) add(input.value); });
    draw();
    return h('div', { class: 'mtgsa-cardpicker', onclick: function (e) { if (e.target === this || e.target === chips) input.focus(); } }, [chips, input, options]);
  }

  // --- Rule editor

  /**
   * opts: { formats, title, onSave(rule) → error message or '', onCancel(), onTest(rule) }
   * With opts.compact (versions of a deck focus) there is no format, no color prefix and no test button.
   */
  function ruleEditor(initial, opts) {
    var compact = !!opts.compact;
    var draft = {
      Name: String(initial.Name || ''),
      Format: String(initial.Format || ''),
      IncludeColorInName: !!initial.IncludeColorInName,
      Conditions: conditionGroups(initial.Conditions),
      Variants: initial.Variants
    };
    if (!draft.Conditions.length) draft.Conditions.push({ Type: 'InMainboard', Cards: [] });

    var errorsBox = h('div', { class: 'mtgsa-errors', role: 'alert' });
    var condBox = h('div', { class: 'mtgsa-conds' });
    var tried = false;

    function build() {
      var raw = { Name: draft.Name, Format: draft.Format, IncludeColorInName: draft.IncludeColorInName, Conditions: draft.Conditions };
      if (draft.Variants) raw.Variants = draft.Variants;
      var res = Core.normalizeRule(raw);
      if (res.rule && initial.Disabled) res.rule.Disabled = true;
      return res;
    }

    function showErrors(list) {
      errorsBox.innerHTML = '';
      list.forEach(function (msg) { errorsBox.appendChild(h('p', { text: msg })); });
    }

    function refresh() { if (tried) showErrors(build().errors); }

    function drawConditions() {
      condBox.innerHTML = '';
      draft.Conditions.forEach(function (c, i) {
        var typeSel = h('select', { 'aria-label': t('Condition type') }, Core.CONDITION_TYPES.map(function (type) {
          return h('option', { value: type, selected: type === c.Type, text: t(CONDITION_LABELS[type]) });
        }));
        typeSel.addEventListener('change', function () { c.Type = typeSel.value; refresh(); });
        condBox.appendChild(h('div', { class: 'mtgsa-cond' }, [
          typeSel,
          cardPicker(c.Cards, refresh),
          h('button', { type: 'button', class: 'button-link mtgsa-cond-x', text: t('Remove'), disabled: draft.Conditions.length < 2, onclick: function () {
            draft.Conditions.splice(i, 1); drawConditions(); refresh();
          } })
        ]));
      });
    }

    var nameInp = h('input', { type: 'text', class: 'regular-text', value: draft.Name, placeholder: compact ? t('e.g. Ritual') : t('e.g. Boros Dwarves'), oninput: function () { draft.Name = this.value; refresh(); } });
    var fmtSel = h('select', { onchange: function () { draft.Format = this.value; } }, [h('option', { value: '', text: t('All formats') })].concat(opts.formats.map(function (f) {
      return h('option', { value: f, selected: sameFormat(f, draft.Format), text: f });
    })));
    var colorChk = h('input', { type: 'checkbox', checked: draft.IncludeColorInName, onchange: function () { draft.IncludeColorInName = this.checked; } });
    var saveBtn = h('button', { type: 'button', class: 'button button-primary', text: opts.saveLabel || t('Save rule') });
    var testBtn = h('button', { type: 'button', class: 'button', text: t('Test on saved tournaments') });
    var cancelBtn = h('button', { type: 'button', class: 'button-link', text: t('Cancel'), onclick: function () { opts.onCancel(); } });

    saveBtn.addEventListener('click', async function () {
      tried = true;
      var res = build();
      showErrors(res.errors);
      if (res.errors.length) return;
      saveBtn.disabled = true;
      var err = await opts.onSave(res.rule);
      saveBtn.disabled = false;
      if (err) showErrors([err]);
    });
    testBtn.addEventListener('click', function () {
      tried = true;
      var res = build();
      showErrors(res.errors);
      if (!res.errors.length) opts.onTest(res.rule);
    });

    drawConditions();
    return h('div', { class: 'mtgsa-editor' }, [
      h('h3', { text: opts.title }),
      h('div', { class: 'mtgsa-row' }, [h('label', {}, [(compact ? t('Version name') : t('Archetype name')) + ' ', nameInp]), compact ? null : h('label', {}, [t('Format') + ' ', fmtSel])]),
      compact ? null : h('div', { class: 'mtgsa-row' }, [h('label', {}, [colorChk, ' ' + t('Put the deck colors before the name (e.g. “Izzet” + name)')])]),
      h('p', { class: 'description', text: compact
        ? t('A list gets this version when it meets every condition; versions are tried in order and the first match wins. Type a card name and pick it from the suggestions, or paste a list with one card per line.')
        : t('A deck gets this archetype when it meets every condition. Type a card name and pick it from the suggestions, or paste a list with one card per line.') }),
      condBox,
      h('p', {}, [h('button', { type: 'button', class: 'button', text: '+ ' + t('Add condition'), onclick: function () {
        draft.Conditions.push({ Type: 'OneOrMoreInMainboard', Cards: [] }); drawConditions();
      } })]),
      draft.Variants && draft.Variants.length ? h('p', { class: 'description', text: t('This rule also has {n} variants: they are kept, and you can change them in the JSON editor.', { n: draft.Variants.length }) }) : null,
      errorsBox,
      h('div', { class: 'mtgsa-row' }, [saveBtn, opts.onTest ? testBtn : null, cancelBtn])
    ]);
  }

  /** Runs a rule alone on the most recent saved tournaments and shows which decks it would take */
  async function testRule(rule, box) {
    box.innerHTML = '';
    box.appendChild(h('p', { class: 'description', text: t('Testing on saved tournaments…') }));
    var idx = await loadIndex();
    var entries = (idx.tournaments || []).filter(function (e) { return !rule.Format || sameFormat(e.format, rule.Format); })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, TEST_MAX_TOURNAMENTS);
    box.innerHTML = '';
    if (!entries.length) { box.appendChild(h('p', { class: 'description', text: t('No saved tournaments to test on.') })); return; }
    var parsers = {}, hits = [], decks = 0;
    for (var i = 0; i < entries.length; i++) {
      var tour;
      try { tour = await loadTournament(entries[i]); } catch (e) { continue; }
      var key = rulesKey(tour.format);
      var b = bundles[key] || EMPTY_BUNDLE;
      parsers[key] = parsers[key] || new Core.ArchetypeParser({ lands: b.lands || {}, nonLands: b.nonLands || {}, archetypes: [], fallbacks: [] }, { customRules: [rule] });
      tour.players.forEach(function (p) {
        if (!p.mb || !p.mb.length) return;
        decks++;
        var deck = Core.deckOf(tour, p);
        var r = parsers[key].detect(deck.main, deck.side);
        if (r.method !== 'unknown' && r.method !== 'fallback') hits.push({ tour: tour, p: p, name: r.archetype });
      });
    }
    box.appendChild(h('p', {}, [h('strong', { text: t('The rule takes {n} of {total} decks in the last {k} saved tournaments.', { n: hits.length, total: decks, k: entries.length }) })]));
    if (!hits.length) {
      box.appendChild(h('p', { class: 'description', text: t('No deck matches: check the card names and the conditions.') }));
      return;
    }
    var now = {};
    hits.forEach(function (x) {
      var k = (x.p.a || 'Unknown') + '\u0000' + (x.p.m || '');
      now[k] = (now[k] || 0) + 1;
    });
    box.appendChild(h('table', { class: 'widefat striped mtgsa-table mtgsa-narrow' }, [
      h('thead', {}, [h('tr', {}, [t('Currently classified as'), t('Method'), t('Decks')].map(function (x) { return h('th', { text: x }); }))]),
      h('tbody', {}, Object.keys(now).sort(function (a, b) { return now[b] - now[a]; }).map(function (k) {
        var parts = k.split('\u0000');
        return h('tr', {}, [h('td', { text: parts[0] }), h('td', {}, [h('span', { class: 'mtgsa-badge is-' + parts[1], text: METHOD_BADGE[parts[1]] ? t(METHOD_BADGE[parts[1]]) : parts[1] })]), h('td', { text: String(now[k]) })]);
      }))
    ]));
    var sample = h('details', {}, [h('summary', { text: t('Show the decks ({n})', { n: hits.length }) })]);
    var tbody = h('tbody');
    hits.slice(0, 200).forEach(function (x) {
      var p = x.p;
      tbody.appendChild(h('tr', {}, [
        h('td', { text: p.n }),
        h('td', { text: p.w !== undefined ? p.w + '-' + p.l + (p.d ? '-' + p.d : '') : '' }),
        h('td', { text: x.name }),
        h('td', { text: p.a || 'Unknown' }),
        h('td', { class: 'mtgsa-info', text: x.tour.name + ' · ' + fmtDate(x.tour.date) })
      ]));
    });
    sample.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
      h('thead', {}, [h('tr', {}, [t('Player'), t('Record'), t('With this rule'), t('Now'), t('Tournament')].map(function (x) { return h('th', { text: x }); }))]),
      tbody
    ]));
    box.appendChild(sample);
  }

  function downloadJson(name, data) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var rulesTab = { format: '', houseFormat: '' };

  async function renderRules(el) {
    var s = cfg.settings || {};
    var house = (s.customRules || []).slice();
    var idx = await loadIndex();
    var saved = idx.tournaments || [];
    var extras = await getExtras();

    // Formats in the menus: the known ones plus those of the saved tournaments and of the rules
    var formats = Core.KNOWN_FORMATS.slice();
    saved.map(function (e) { return e.format; }).concat(house.map(function (r) { return r && r.Format; }), Object.keys(extras.formats || {})).forEach(function (f) {
      if (f && !formats.some(function (x) { return sameFormat(x, f); })) formats.push(String(f));
    });
    if (!rulesTab.format) {
      var count = {};
      saved.forEach(function (e) { count[e.format] = (count[e.format] || 0) + 1; });
      rulesTab.format = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0] || 'Standard';
    }

    var notice = h('div');
    el.appendChild(notice);

    /** After a change to rules or aliases: offer to apply it to the saved tournaments */
    function offerReclassify() {
      notice.innerHTML = '';
      if (!saved.length) return;
      var log = makeLog();
      var btn = h('button', { type: 'button', class: 'button button-primary', text: t('Reclassify the saved tournaments ({n})', { n: saved.length }) });
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        await reclassifyEntries(saved, log.log);
        btn.textContent = t('Done ✓');
      });
      notice.appendChild(h('div', { class: 'notice notice-info mtgsa-notice' }, [
        h('p', { text: t('Saved. The tournaments already imported keep their archetypes until you reclassify them (manual fixes are kept).') }),
        h('p', {}, [btn]),
        log
      ]));
    }

    // --- House rules
    var p1 = panel(t('House rules'), t('Your own archetype definitions, saved in the WordPress database. They take precedence over every other rule; a house rule with the same name as a community archetype replaces it. Rules with errors stay saved but are ignored until you fix them.'));
    var editorBox = h('div');
    var testBox = h('div', { class: 'mtgsa-test' });
    var houseBox = h('div');
    var houseStatus = h('span', { class: 'mtgsa-status' });
    var houseFmt = h('select', {}, [h('option', { value: '', text: t('All formats') })].concat(formats.map(function (f) {
      return h('option', { value: f, selected: f === rulesTab.houseFormat, text: f });
    })));
    houseFmt.addEventListener('change', function () { rulesTab.houseFormat = this.value; drawHouse(); });
    var fileInp = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true });

    async function storeRules(rules) {
      houseStatus.textContent = t('Saving…');
      try {
        await saveSettings({ customRules: rules });
        var kept = (cfg.settings.customRules || []).length;
        house = (cfg.settings.customRules || []).slice();
        houseStatus.textContent = kept < rules.length ? t('Saved, but the server discarded {n} rules without a name.', { n: rules.length - kept }) : t('Saved ✓');
        drawHouse();
        drawCatalog();
        offerReclassify();
        return '';
      } catch (e) {
        houseStatus.textContent = t('Error: {error}', { error: e.message });
        return t('Error: {error}', { error: e.message });
      }
    }

    function openEditor(rule, index, title) {
      testBox.innerHTML = '';
      editorBox.innerHTML = '';
      editorBox.appendChild(ruleEditor(rule, {
        formats: formats,
        title: title,
        onCancel: function () { editorBox.innerHTML = ''; testBox.innerHTML = ''; },
        onTest: function (r) { testRule(r, testBox); },
        onSave: async function (r) {
          var clash = house.some(function (x, i) { return i !== index && x && String(x.Name).trim().toLowerCase() === r.Name.toLowerCase() && sameFormat(x.Format, r.Format); });
          if (clash) return t('There is already a house rule with this name for this format.');
          var next = house.slice();
          if (index >= 0) next[index] = r; else next.push(r);
          var err = await storeRules(next);
          if (!err) { editorBox.innerHTML = ''; testBox.innerHTML = ''; }
          return err;
        }
      }));
      editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var first = editorBox.querySelector('input');
      if (first) first.focus({ preventScroll: true });
    }

    function drawHouse() {
      houseBox.innerHTML = '';
      var f = houseFmt.value;
      var rows = house.map(function (r, i) { return { r: r || {}, i: i }; }).filter(function (x) { return !f || !x.r.Format || sameFormat(x.r.Format, f); });
      if (!house.length) { houseBox.appendChild(h('p', { class: 'description', text: t('No house rules yet. Create one, or start from an archetype of the catalog below with “Customize”.') })); return; }
      if (!rows.length) { houseBox.appendChild(h('p', { class: 'description', text: t('No house rules for this format.') })); return; }
      var valid = 0;
      var tbody = h('tbody', {}, rows.map(function (x) {
        var r = x.r, res = Core.normalizeRule(r);
        var bad = res.errors.length > 0;
        if (!bad && !r.Disabled) valid++;
        var status = bad ? h('span', { class: 'mtgsa-badge is-unknown', text: t('ignored: errors') })
          : r.Disabled ? h('span', { class: 'mtgsa-badge', text: t('off') }) : h('span', { class: 'mtgsa-badge is-manual', text: t('active') });
        var onChk = h('input', { type: 'checkbox', checked: !r.Disabled, disabled: bad, 'aria-label': t('Use this rule'), onchange: function () {
          var next = house.slice();
          next[x.i] = Object.assign({}, r);
          if (this.checked) delete next[x.i].Disabled; else next[x.i].Disabled = true;
          storeRules(next);
        } });
        return h('tr', { class: bad ? 'mtgsa-row-bad' : r.Disabled ? 'mtgsa-row-off' : '' }, [
          h('th', { class: 'check-column' }, [onChk]),
          h('td', {}, [h('strong', { text: r.Name ? ruleName(r, true) : t('Rule without a name') })].concat(bad ? [h('div', { class: 'mtgsa-errors' }, res.errors.map(function (m) { return h('p', { text: m }); }))] : [])),
          h('td', { text: r.Format || t('All formats') }),
          h('td', { class: 'mtgsa-info', text: ruleSummary(res.rule || r) }),
          h('td', {}, [status]),
          h('td', { class: 'mtgsa-actions' }, [
            h('button', { type: 'button', class: 'button button-small', text: t('Edit'), onclick: function () { openEditor(r, x.i, t('Edit house rule')); } }),
            h('button', { type: 'button', class: 'button button-small', text: t('Test'), disabled: bad, onclick: function () { editorBox.innerHTML = ''; testRule(res.rule, testBox); testBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }),
            h('button', { type: 'button', class: 'button button-small button-link-delete', text: t('Delete'), onclick: function () {
              if (!window.confirm(t('Delete the house rule “{name}”?', { name: r.Name || '?' }))) return;
              var next = house.slice();
              next.splice(x.i, 1);
              storeRules(next);
            } })
          ])
        ]);
      }));
      houseBox.appendChild(h('p', { class: 'description', text: t('{n} rules, {v} in use.', { n: rows.length, v: valid }) }));
      houseBox.appendChild(h('table', { class: 'widefat mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [h('td', { class: 'check-column' }), h('th', { text: t('Archetype') }), h('th', { text: t('Format') }), h('th', { text: t('Definition') }), h('th', { text: t('Status') }), h('th', { text: '' })])]),
        tbody
      ]));
    }

    fileInp.addEventListener('change', async function () {
      var added = [], bad = [];
      for (var i = 0; i < fileInp.files.length; i++) {
        var file = fileInp.files[i];
        try {
          var data = Core.parseLenientJson(await file.text());
          (Array.isArray(data) ? data : [data]).forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            if (!r.Format && houseFmt.value) r.Format = houseFmt.value;
            added.push(cleanRule(r));
          });
        } catch (e) { bad.push(file.name); }
      }
      fileInp.value = '';
      if (bad.length) houseStatus.textContent = t('Not valid JSON: {files}', { files: bad.join(', ') });
      if (!added.length) return;
      var next = house.slice(), replaced = 0;
      added.forEach(function (r) {
        var at = next.findIndex(function (x) { return x && r.Name && String(x.Name).trim().toLowerCase() === String(r.Name).trim().toLowerCase() && sameFormat(x.Format, r.Format); });
        if (at >= 0) { next[at] = r; replaced++; } else next.push(r);
      });
      if (replaced && !window.confirm(t('{n} imported rules have the same name and format as existing house rules and will replace them. Continue?', { n: replaced }))) return;
      await storeRules(next);
    });

    // Every house rule as JSON, for bulk changes and for variants
    var jsonTa = h('textarea', { rows: 14, class: 'large-text code', spellcheck: 'false', placeholder: JSON.stringify(RULE_EXAMPLE, null, 2) });
    var jsonStatus = h('span', { class: 'mtgsa-status' });
    var jsonBox = h('details', { class: 'mtgsa-json' }, [
      h('summary', { text: t('Edit all house rules as JSON') }),
      h('p', { class: 'description', text: t('Same schema as the MTGOFormatData rules (Name, IncludeColorInName, Conditions, Variants), plus the optional “Format” and “Disabled” fields. Condition types: {types}.', { types: Core.CONDITION_TYPES.join(', ') }) }),
      jsonTa,
      h('div', { class: 'mtgsa-row' }, [
        h('button', { type: 'button', class: 'button', text: t('Save JSON'), onclick: async function () {
          var list = [];
          if (jsonTa.value.trim()) {
            try { list = Core.parseLenientJson(jsonTa.value); } catch (e) { jsonStatus.textContent = t('Invalid rules JSON: {error}', { error: e.message }); return; }
            if (!Array.isArray(list)) list = [list];
          }
          jsonStatus.textContent = '';
          await storeRules(list.filter(function (r) { return r && typeof r === 'object'; }).map(cleanRule));
          jsonTa.value = JSON.stringify(house, null, 2);
        } }),
        h('button', { type: 'button', class: 'button-link', text: t('Insert example'), onclick: function () { if (!jsonTa.value.trim()) jsonTa.value = JSON.stringify(RULE_EXAMPLE, null, 2); } }),
        jsonStatus
      ])
    ]);
    jsonBox.addEventListener('toggle', function () { if (jsonBox.open) jsonTa.value = house.length ? JSON.stringify(house, null, 2) : ''; });

    p1.body.appendChild(h('div', { class: 'mtgsa-row' }, [
      h('button', { type: 'button', class: 'button button-primary', text: '+ ' + t('New rule'), onclick: function () { openEditor({ Format: houseFmt.value || rulesTab.format }, -1, t('New house rule')); } }),
      h('button', { type: 'button', class: 'button', text: t('Import JSON files…'), onclick: function () { fileInp.click(); } }),
      h('button', { type: 'button', class: 'button', text: t('Download JSON'), onclick: function () { downloadJson('mtgstats-house-rules.json', house); } }),
      h('label', {}, [t('Show') + ' ', houseFmt]),
      houseStatus,
      fileInp
    ]));
    p1.body.appendChild(editorBox);
    p1.body.appendChild(testBox);
    p1.body.appendChild(houseBox);
    p1.body.appendChild(jsonBox);
    el.appendChild(p1);

    // --- Catalog: every archetype a format knows, by source
    var p2 = panel(t('Archetype catalog'), t('What the plugin recognizes in a format, in order of priority: your house rules, the community rules (MTGOFormatData), the supplementary rules shipped with the plugin for archetypes the community has not added yet, and finally the similarity groups. “Customize” copies an archetype into your house rules.'));
    var catFmt = h('select', {}, formats.map(function (f) { return h('option', { value: f, selected: sameFormat(f, rulesTab.format), text: f }); }));
    var catSearch = h('input', { type: 'search', placeholder: t('Search archetype or card…'), class: 'regular-text' });
    var updateBtn = h('button', { type: 'button', class: 'button', text: t('Update community rules now') });
    var catInfo = h('div', { class: 'mtgsa-catinfo' });
    var catBox = h('div', { class: 'mtgsa-list mtgsa-catalog' });
    var catLog = makeLog();
    var catRows = [];
    p2.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Format') + ' ', catFmt]), catSearch, updateBtn]));
    p2.body.appendChild(catInfo);
    p2.body.appendChild(catLog);
    p2.body.appendChild(catBox);
    el.appendChild(p2);

    var SOURCE_BADGE = { house: ['house rule', 'is-manual'], community: ['community', ''], extra: ['supplementary', 'is-extra'], fallback: ['similarity', 'is-fallback'] };

    async function drawCatalog() {
      var format = catFmt.value;
      rulesTab.format = format;
      catInfo.innerHTML = '';
      catBox.innerHTML = '';
      catBox.appendChild(h('p', { class: 'description', text: t('Loading…') }));
      var bundle = null, error = '';
      try { bundle = await getBundle(format, new Date().toISOString().slice(0, 10), catLog.log); } catch (e) { error = e.message; }
      if (catFmt.value !== format) return;
      var extraList = byFormat(extras.formats, format);
      catRows = [];
      house.forEach(function (r, i) {
        if (r && (!r.Format || sameFormat(r.Format, format))) catRows.push({ source: 'house', rule: r, index: i, off: r.Disabled || Core.normalizeRule(r).errors.length > 0 });
      });
      ((bundle && bundle.archetypes) || []).forEach(function (r) { catRows.push({ source: 'community', rule: r }); });
      extraList.forEach(function (r) { catRows.push({ source: 'extra', rule: r }); });
      ((bundle && bundle.fallbacks) || []).forEach(function (r) { catRows.push({ source: 'fallback', rule: r }); });

      catInfo.appendChild(h('p', { text: bundle
        ? t('Community rules: folder {folder}, downloaded on {date}: {a} archetypes and {f} similarity groups.', { folder: bundle.folder, date: fmtDate(String(bundle.loadedAt || '').slice(0, 10)), a: bundle.archetypes.length, f: bundle.fallbacks.length })
        : t('No community rules for {format}: {error}', { format: format, error: error }) }));
      catInfo.appendChild(h('p', { text: t('Supplementary rules: {n} for {format} (updated on {date}).', { n: extraList.length, format: format, date: fmtDate(extras.updated) }) }));
      drawCatalogRows();
    }

    function drawCatalogRows() {
      catBox.innerHTML = '';
      var q = Core.cardKey(catSearch.value || '');
      var rows = catRows.filter(function (x) {
        if (!q) return true;
        var r = x.rule;
        var hay = [r.Name].concat((r.Conditions || []).reduce(function (acc, c) { return acc.concat(cardList(c && c.Cards)); }, []), r.CommonCards || []);
        return hay.some(function (v) { return Core.cardKey(v || '').indexOf(q) >= 0; });
      });
      if (!rows.length) { catBox.appendChild(h('p', { class: 'description', text: t('No archetype matches the search.') })); return; }
      catBox.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [t('Archetype'), t('Source'), t('Definition'), ''].map(function (x) { return h('th', { text: x }); }))]),
        h('tbody', {}, rows.map(function (x) {
          var r = x.rule, b = SOURCE_BADGE[x.source];
          var def = x.source === 'fallback'
            ? h('td', { class: 'mtgsa-info', title: (r.CommonCards || []).join(', '), text: t('Similar to {n} typical cards: {list}…', { n: (r.CommonCards || []).length, list: (r.CommonCards || []).slice(0, 6).join(', ') }) })
            : h('td', { class: 'mtgsa-info', text: ruleSummary(x.source === 'house' ? (Core.normalizeRule(r).rule || r) : r) });
          var action = null;
          if (x.source === 'house') action = h('button', { type: 'button', class: 'button button-small', text: t('Edit'), onclick: function () { openEditor(r, x.index, t('Edit house rule')); } });
          else if (x.source !== 'fallback') action = h('button', { type: 'button', class: 'button button-small', text: t('Customize'), onclick: function () {
            openEditor({ Name: ruleName({ Name: r.Name }, x.source === 'extra'), Format: catFmt.value, IncludeColorInName: r.IncludeColorInName, Conditions: r.Conditions, Variants: r.Variants }, -1, t('New house rule'));
          } });
          return h('tr', { class: x.off ? 'mtgsa-row-off' : '' }, [
            h('td', {}, [h('strong', { text: ruleName(r, x.source !== 'community' && x.source !== 'fallback') })]),
            h('td', {}, [h('span', { class: 'mtgsa-badge ' + b[1], text: t(b[0]) })]),
            def,
            h('td', { class: 'mtgsa-actions' }, [action])
          ]);
        }))
      ]));
      if (rows.length < catRows.length || q) catBox.appendChild(h('p', { class: 'description', text: t('{n} of {total} archetypes.', { n: rows.length, total: catRows.length }) }));
    }

    catFmt.addEventListener('change', drawCatalog);
    catSearch.addEventListener('input', drawCatalogRows);
    updateBtn.addEventListener('click', async function () {
      updateBtn.disabled = true;
      forceRulesReload = true;
      delete bundles[rulesKey(catFmt.value)];
      await drawCatalog();
      forceRulesReload = false;
      updateBtn.disabled = false;
    });

    // --- Aliases and options
    var p3 = panel(t('Aliases'), t('One alias per line, as “Detected name => Displayed name”. Useful to standardize names (e.g. Simic Birthing Ritual => Simic Ritual). Applies to new imports and to “Reclassify”.'));
    var aliasTa = h('textarea', { rows: 6, class: 'large-text code', spellcheck: 'false' });
    aliasTa.value = Object.keys(s.aliases || {}).map(function (k) { return k + ' => ' + s.aliases[k]; }).join('\n');
    p3.body.appendChild(aliasTa);

    var p4 = panel(t('Options'), null);
    var conflictSel = h('select', {}, [['simpler', t('When several rules match, pick the simplest')], ['none', t('When several rules match, mark “Conflict(…)”')]].map(function (o) {
      return h('option', { value: o[0], selected: (s.conflict || 'simpler') === o[0], text: o[1] });
    }));
    var priorInp = h('input', { type: 'number', min: '0', max: '100', value: String(s.prior === undefined ? 10 : s.prior), class: 'small-text' });
    p4.body.appendChild(h('div', { class: 'mtgsa-row' }, [conflictSel]));
    p4.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Bayesian win-rate prior: Beta('), priorInp, t(', same value)')])]));
    p4.body.appendChild(h('p', { class: 'description', text: t('10 = cautious estimate with few matches, 1 = almost no smoothing.') }));
    var accentOn = h('input', { type: 'checkbox', checked: !!s.accent });
    var accentInp = h('input', { type: 'color', value: s.accent || '#2a78d6' });
    p4.body.appendChild(h('div', { class: 'mtgsa-row' }, [h('label', {}, [accentOn, ' ' + t('Custom accent color') + ' ', accentInp])]));
    p4.body.appendChild(h('p', { class: 'description', text: t('When off, the dashboard uses the WordPress theme’s primary color (if the theme declares one) or a neutral blue.') }));

    var status = h('span', { class: 'mtgsa-status' });
    var saveBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Save aliases and options') });
    saveBtn.addEventListener('click', async function () {
      var aliases = {}, bad = [];
      aliasTa.value.split('\n').forEach(function (line, i) {
        if (!line.trim()) return;
        var m = line.split('=>');
        if (m.length !== 2 || !m[0].trim() || !m[1].trim()) bad.push(i + 1); else aliases[m[0].trim()] = m[1].trim();
      });
      if (bad.length) { status.textContent = t('Invalid aliases on lines {lines}', { lines: bad.join(', ') }); return; }
      var aliasesChanged = JSON.stringify(aliases) !== JSON.stringify(cfg.settings.aliases || {});
      saveBtn.disabled = true;
      try {
        await saveSettings({ aliases: aliases, conflict: conflictSel.value, prior: parseInt(priorInp.value, 10) || 0, accent: accentOn.checked ? accentInp.value : '' });
        status.textContent = t('Saved ✓');
        if (aliasesChanged) offerReclassify();
      } catch (e) { status.textContent = t('Error: {error}', { error: e.message }); }
      saveBtn.disabled = false;
    });

    // Not a sticky bar here: house rules save on their own, and a bar would cover the editors above
    p4.body.appendChild(h('div', { class: 'mtgsa-row' }, [saveBtn, status]));
    el.appendChild(p3);
    el.appendChild(p4);

    drawHouse();
    drawCatalog();
  }

  // ---------------------------------------------------------------------------
  // Tab: Deck focus
  // ---------------------------------------------------------------------------

  // Ready-made focus definitions. Versions are tried in order: a list that plays both Birthing Ritual and
  // Wrenn and Six is a Ritual list.
  var FOCUS_PRESETS = [{
    id: 'omnath', name: 'Omnath', format: 'Modern', cards: ['Omnath, Locus of Creation'],
    versions: [
      { Name: 'Ritual', Conditions: [{ Type: 'InMainboard', Cards: ['Birthing Ritual'] }] },
      { Name: 'Paradox / W6', Conditions: [{ Type: 'OneOrMoreInMainboard', Cards: ['Way of the Paradox', 'Wrenn and Six'] }] },
      { Name: 'Elementals', Conditions: [{ Type: 'InMainboard', Cards: ['Risen Reef'] }] }
    ]
  }];

  function focusShortcode(f) { return '[mtgstats focus="' + f.id + '"]'; }

  /** Errors of a focus definition; versions are checked with the same rules as house rules */
  function focusErrors(f, others) {
    var errors = [];
    if (!String(f.name || '').trim()) errors.push(t('The focus has no name.'));
    if (!f.cards.length) errors.push(t('Add at least one key card.'));
    if (others.some(function (o) { return o.id === f.id; })) errors.push(t('There is already a focus with this name.'));
    var names = {};
    f.versions.forEach(function (v) {
      Core.normalizeRule(v).errors.forEach(function (e) { errors.push(e); });
      var k = String(v.Name || '').trim().toLowerCase();
      if (k && names[k]) errors.push(t('Two versions are called “{name}”.', { name: v.Name }));
      names[k] = true;
    });
    return errors;
  }

  /** opts: { formats, others, title, onSave(focus) → error message or '', onCancel(), onTest(focus) } */
  function focusEditor(initial, opts) {
    var draft = {
      name: String(initial.name || ''),
      format: String(initial.format || ''),
      cards: (initial.cards || []).slice(),
      versions: (initial.versions || []).map(function (v) { return JSON.parse(JSON.stringify(v)); })
    };
    var errorsBox = h('div', { class: 'mtgsa-errors', role: 'alert' });
    var versionsBox = h('div');
    var versionEditor = h('div');

    function build() {
      // The id stays the same when the deck is renamed, so the shortcodes already on pages keep working
      var f = { id: initial.id || Core.slugify(draft.name), name: draft.name.replace(/\s+/g, ' ').trim(), format: draft.format, cards: draft.cards.slice(), versions: draft.versions.slice() };
      return { focus: f, errors: focusErrors(f, opts.others) };
    }
    function showErrors(list) {
      errorsBox.innerHTML = '';
      list.forEach(function (msg) { errorsBox.appendChild(h('p', { text: msg })); });
    }

    function editVersion(index) {
      versionEditor.innerHTML = '';
      versionEditor.appendChild(ruleEditor(index >= 0 ? draft.versions[index] : {}, {
        compact: true,
        formats: [],
        title: index >= 0 ? t('Edit version') : t('New version'),
        saveLabel: t('Apply'),
        onCancel: function () { versionEditor.innerHTML = ''; },
        onSave: function (rule) {
          var v = { Name: rule.Name, Conditions: rule.Conditions };
          if (index >= 0) draft.versions[index] = v; else draft.versions.push(v);
          versionEditor.innerHTML = '';
          drawVersions();
          return Promise.resolve('');
        }
      }));
      var first = versionEditor.querySelector('input');
      if (first) first.focus();
    }

    function drawVersions() {
      versionsBox.innerHTML = '';
      if (!draft.versions.length) {
        versionsBox.appendChild(h('p', { class: 'description', text: t('No versions yet: every list with the key cards will be counted as one deck.') }));
        return;
      }
      var move = function (i, d) {
        var j = i + d;
        if (j < 0 || j >= draft.versions.length) return;
        var x = draft.versions[i]; draft.versions[i] = draft.versions[j]; draft.versions[j] = x;
        drawVersions();
      };
      versionsBox.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: '#' }), h('th', { text: t('Version') }), h('th', { text: t('Definition') }), h('th', { text: '' })])]),
        h('tbody', {}, draft.versions.map(function (v, i) {
          return h('tr', {}, [
            h('td', { text: String(i + 1) }),
            h('td', {}, [h('strong', { text: v.Name || '?' })]),
            h('td', { class: 'mtgsa-info', text: ruleSummary(v) }),
            h('td', { class: 'mtgsa-actions' }, [
              h('button', { type: 'button', class: 'button button-small', text: '↑', 'aria-label': t('Move up'), disabled: i === 0, onclick: function () { move(i, -1); } }),
              h('button', { type: 'button', class: 'button button-small', text: '↓', 'aria-label': t('Move down'), disabled: i === draft.versions.length - 1, onclick: function () { move(i, 1); } }),
              h('button', { type: 'button', class: 'button button-small', text: t('Edit'), onclick: function () { editVersion(i); } }),
              h('button', { type: 'button', class: 'button button-small button-link-delete', text: t('Remove'), onclick: function () { draft.versions.splice(i, 1); drawVersions(); } })
            ])
          ]);
        }))
      ]));
    }

    var nameInp = h('input', { type: 'text', class: 'regular-text', value: draft.name, placeholder: t('e.g. Omnath'), oninput: function () { draft.name = this.value; } });
    var fmtSel = h('select', { onchange: function () { draft.format = this.value; } }, [h('option', { value: '', text: t('All formats') })].concat(opts.formats.map(function (f) {
      return h('option', { value: f, selected: sameFormat(f, draft.format), text: f });
    })));
    var saveBtn = h('button', { type: 'button', class: 'button button-primary', text: t('Save focus') });
    saveBtn.addEventListener('click', async function () {
      var res = build();
      showErrors(res.errors);
      if (res.errors.length) return;
      saveBtn.disabled = true;
      var err = await opts.onSave(res.focus);
      saveBtn.disabled = false;
      if (err) showErrors([err]);
    });
    var testBtn = h('button', { type: 'button', class: 'button', text: t('Test on saved tournaments'), onclick: function () {
      var res = build();
      showErrors(res.errors);
      if (!res.errors.length) opts.onTest(res.focus);
    } });

    drawVersions();
    return h('div', { class: 'mtgsa-editor' }, [
      h('h3', { text: opts.title }),
      h('div', { class: 'mtgsa-row' }, [h('label', {}, [t('Deck name') + ' ', nameInp]), h('label', {}, [t('Format') + ' ', fmtSel])]),
      h('p', { class: 'description', text: t('Key cards: a list belongs to the deck when its main deck plays at least one of them.') }),
      cardPicker(draft.cards, function () {}),
      h('h4', { text: t('Versions') }),
      h('p', { class: 'description', text: t('Tried in order: a list gets the first version whose conditions it meets. Lists that meet none are shown as “other lists”, and the dashboard looks for groups among them.') }),
      versionsBox,
      h('p', {}, [h('button', { type: 'button', class: 'button', text: '+ ' + t('Add version'), onclick: function () { editVersion(-1); } })]),
      versionEditor,
      errorsBox,
      h('div', { class: 'mtgsa-row' }, [saveBtn, testBtn, h('button', { type: 'button', class: 'button-link', text: t('Cancel'), onclick: function () { opts.onCancel(); } })])
    ]);
  }

  /** Splits the decks of the most recent saved tournaments into the focus versions */
  async function testFocus(focus, box) {
    box.innerHTML = '';
    box.appendChild(h('p', { class: 'description', text: t('Testing on saved tournaments…') }));
    var idx = await loadIndex();
    var entries = (idx.tournaments || []).filter(function (e) { return !focus.format || sameFormat(e.format, focus.format); })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, TEST_MAX_TOURNAMENTS);
    var tours = [];
    for (var i = 0; i < entries.length; i++) {
      try { tours.push(await loadTournament(entries[i])); } catch (e) { /* skip unreadable files */ }
    }
    box.innerHTML = '';
    if (!tours.length) { box.appendChild(h('p', { class: 'description', text: t('No saved tournaments to test on.') })); return; }
    var F = window.MTGStatsAdvanced.focusTournaments(tours, focus, { otherName: t('other lists') });
    var total = Object.keys(F.decks).reduce(function (a, k) { return a + F.decks[k]; }, 0);
    box.appendChild(h('p', {}, [h('strong', { text: t('{n} {name} lists in the last {k} saved tournaments.', { n: total, name: focus.name, k: tours.length }) })]));
    if (!total) { box.appendChild(h('p', { class: 'description', text: t('No list plays the key cards: check their spelling.') })); return; }
    var now = {};
    F.tournaments.forEach(function (tour) {
      tour.players.forEach(function (p) {
        if (p.orig === undefined) return;
        now[p.a] = now[p.a] || {};
        now[p.a][p.orig || 'Unknown'] = (now[p.a][p.orig || 'Unknown'] || 0) + 1;
      });
    });
    box.appendChild(h('table', { class: 'widefat striped mtgsa-table mtgsa-narrow' }, [
      h('thead', {}, [h('tr', {}, [t('Version'), t('Lists'), t('Currently classified as')].map(function (x) { return h('th', { text: x }); }))]),
      h('tbody', {}, F.labels.map(function (label) {
        var orig = now[label] || {};
        return h('tr', {}, [
          h('td', { text: label }),
          h('td', { text: String(F.decks[label]) }),
          h('td', { class: 'mtgsa-info', text: Object.keys(orig).sort(function (a, b) { return orig[b] - orig[a]; }).map(function (a) { return a + ' (' + orig[a] + ')'; }).join(', ') })
        ]);
      }))
    ]));
    var leagues = F.listOnly.filter(Boolean).length;
    if (leagues) box.appendChild(h('p', { class: 'description', text: t('{n} of these events only publish 5-0 lists (MTGO Leagues): the dashboard uses them for the lists, not for win rates.', { n: leagues }) }));
  }

  async function renderFocusAdmin(el) {
    var list = ((cfg.settings || {}).focus || []).slice();
    var idx = await loadIndex();
    var formats = Core.KNOWN_FORMATS.slice();
    (idx.tournaments || []).forEach(function (e) { if (e.format && !formats.some(function (x) { return sameFormat(x, e.format); })) formats.push(String(e.format)); });

    var p1 = panel(t('Deck focus'), t('Follow one deck closely: the lists with its key cards are split into versions, and the dashboard shows which version to play against the current field, how each version does against the most played decks, its average list and the cards that are coming in. Add the focus to a page with its shortcode.'));
    var status = h('span', { class: 'mtgsa-status' });
    var editorBox = h('div');
    var testBox = h('div', { class: 'mtgsa-test' });
    var listBox = h('div');
    var actions = h('div', { class: 'mtgsa-row' });

    async function store(next) {
      status.textContent = t('Saving…');
      try {
        await saveSettings({ focus: next });
        list = (cfg.settings.focus || []).slice();
        status.textContent = t('Saved ✓');
        draw();
        return '';
      } catch (e) {
        status.textContent = t('Error: {error}', { error: e.message });
        return t('Error: {error}', { error: e.message });
      }
    }

    function openEditor(focus, index, title) {
      testBox.innerHTML = '';
      editorBox.innerHTML = '';
      editorBox.appendChild(focusEditor(focus, {
        formats: formats,
        others: list.filter(function (_, i) { return i !== index; }),
        title: title,
        onCancel: function () { editorBox.innerHTML = ''; testBox.innerHTML = ''; },
        onTest: function (f) { testFocus(f, testBox); },
        onSave: async function (f) {
          var next = list.slice();
          if (index >= 0) next[index] = f; else next.push(f);
          var err = await store(next);
          if (!err) { editorBox.innerHTML = ''; testBox.innerHTML = ''; }
          return err;
        }
      }));
      editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function draw() {
      actions.innerHTML = '';
      actions.appendChild(h('button', { type: 'button', class: 'button button-primary', text: '+ ' + t('New focus'), onclick: function () { openEditor({}, -1, t('New focus')); } }));
      FOCUS_PRESETS.forEach(function (p) {
        if (list.some(function (f) { return f.id === p.id; })) return;
        actions.appendChild(h('button', { type: 'button', class: 'button', text: t('Add preset: {name} ({format})', { name: p.name, format: p.format }), onclick: function () { openEditor(p, -1, t('New focus')); } }));
      });
      actions.appendChild(status);

      listBox.innerHTML = '';
      if (!list.length) { listBox.appendChild(h('p', { class: 'description', text: t('No deck focus yet. Create one, or start from a preset.') })); return; }
      listBox.appendChild(h('table', { class: 'widefat striped mtgsa-table' }, [
        h('thead', {}, [h('tr', {}, [t('Deck'), t('Format'), t('Key cards'), t('Versions'), t('Shortcode'), ''].map(function (x) { return h('th', { text: x }); }))]),
        h('tbody', {}, list.map(function (f, i) {
          return h('tr', {}, [
            h('td', {}, [h('strong', { text: f.name })]),
            h('td', { text: f.format || t('All formats') }),
            h('td', { class: 'mtgsa-info', text: (f.cards || []).join(', ') }),
            h('td', { class: 'mtgsa-info', text: (f.versions || []).map(function (v) { return v.Name; }).join(' → ') || '–' }),
            h('td', {}, [h('code', { text: focusShortcode(f) })]),
            h('td', { class: 'mtgsa-actions' }, [
              h('button', { type: 'button', class: 'button button-small', text: t('Edit'), onclick: function () { openEditor(f, i, t('Edit focus')); } }),
              h('button', { type: 'button', class: 'button button-small', text: t('Test'), onclick: function () { editorBox.innerHTML = ''; testFocus(f, testBox); } }),
              h('button', { type: 'button', class: 'button button-small button-link-delete', text: t('Delete'), onclick: function () {
                if (!window.confirm(t('Delete the focus “{name}”? Pages using its shortcode will show the dashboard without it.', { name: f.name }))) return;
                var next = list.slice();
                next.splice(i, 1);
                store(next);
              } })
            ])
          ]);
        }))
      ]));
    }

    p1.body.appendChild(actions);
    p1.body.appendChild(editorBox);
    p1.body.appendChild(testBox);
    p1.body.appendChild(listBox);
    el.appendChild(p1);
    draw();
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
      ['[mtgstats focus="omnath"]', t('Adds the tab of a deck focus (see “Deck focus”), first in line; with tabs="focus" it is the only one.')],
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
