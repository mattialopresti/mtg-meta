#!/usr/bin/env node
/*!
 * MTG Stats – headless importer
 * Does what the Import tab of the admin panel does, without a browser: lists the new events in the decklist
 * cache, classifies them with the plugin's own core.js and the site's house rules, and saves them through the
 * plugin's REST API. Meant for a scheduled job (see .github/workflows/sync.yml); Node 18 or later, no dependencies.
 *
 * Environment:
 *   MTGSTATS_URL           site address, e.g. https://example.com (required)
 *   MTGSTATS_USER          WordPress administrator user name (required)
 *   MTGSTATS_APP_PASSWORD  an Application Password of that user (required)
 *   MTGSTATS_REST          REST base, if not <site>/wp-json/mtgstats/v1 (e.g. <site>/?rest_route=/mtgstats/v1)
 *   MTGSTATS_FORMATS       formats to import, comma separated (default: Modern)
 *   MTGSTATS_SOURCES       cache sources, comma separated (default: melee.gg,mtgo.com)
 *   MTGSTATS_DAYS          how many days back to look for events (default: 30)
 *   MTGSTATS_MAX           maximum number of events per run (default: 40)
 *   MTGSTATS_LEAGUES       1 to also import MTGO Leagues (5-0 lists only; default: 0)
 *   MTGSTATS_DRY_RUN       1 to list what would be imported without saving anything
 *   GITHUB_TOKEN           optional; raises the GitHub API limit from 60 to 1,000+ requests per hour
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Core = require('../mtgstats/assets/core.js');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);

const SITE = String(env('MTGSTATS_URL', '')).replace(/\/+$/, '');
const USER = env('MTGSTATS_USER', '');
const PASS = env('MTGSTATS_APP_PASSWORD', '');
const REST = String(env('MTGSTATS_REST', `${SITE}/wp-json/mtgstats/v1`)).replace(/\/+$/, '');
const FORMATS = list(env('MTGSTATS_FORMATS', 'Modern'));
const SOURCES = list(env('MTGSTATS_SOURCES', 'melee.gg,mtgo.com'));
const DAYS = parseInt(env('MTGSTATS_DAYS', '30'), 10);
const MAX = parseInt(env('MTGSTATS_MAX', '40'), 10);
const LEAGUES = env('MTGSTATS_LEAGUES', '0') === '1';
const DRY = env('MTGSTATS_DRY_RUN', '0') === '1';
const GH_TOKEN = env('GITHUB_TOKEN', '');
const RULES_MAX_AGE = 7 * 86400000;
const UA = `MTGStats-sync/${Core.version} (+https://github.com/mattialopresti/mtg-meta)`;

const log = (msg) => console.log(msg);

// ---------------------------------------------------------------------------
// HTTP: the same { json, text, postJson } interface core.js expects in the browser
// ---------------------------------------------------------------------------

async function check(r, url) {
  if (r.ok) return r;
  let msg = `HTTP ${r.status} for ${url}`;
  try { const j = await r.clone().json(); if (j && j.message) msg += `: ${j.message}`; } catch (e) { /* not JSON */ }
  if ((r.status === 403 || r.status === 429) && /api\.github\.com/.test(url)) msg += ' (GitHub API limit: set GITHUB_TOKEN)';
  throw new Error(msg);
}

function headersFor(url, extra) {
  const h = Object.assign({ 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, extra || {});
  if (GH_TOKEN && /^https:\/\/api\.github\.com\//.test(url)) h.Authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

const http = {
  json: async (url) => (await check(await fetch(url, { headers: headersFor(url) }), url)).json(),
  text: async (url) => (await check(await fetch(url, { headers: headersFor(url) }), url)).text(),
  postJson: async (url, body) => (await check(await fetch(url, {
    method: 'POST', headers: headersFor(url, { 'Content-Type': 'application/json' }), body: JSON.stringify(body)
  }), url)).json()
};

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

async function wp(method, route, body) {
  const url = `${REST}${route}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error(`WordPress refused the credentials (HTTP ${r.status}). Check MTGSTATS_USER and MTGSTATS_APP_PASSWORD, and that the host passes the Authorization header to PHP.`);
  }
  return (await check(r, url)).json();
}

// ---------------------------------------------------------------------------
// Rules and classification (same steps as admin.js: house rules, community rules, supplementary rules)
// ---------------------------------------------------------------------------

const sameFormat = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const rulesKey = (format) => String(format).replace(/[^A-Za-z0-9_-]/g, '');
const EMPTY_BUNDLE = { lands: {}, nonLands: {}, archetypes: [], fallbacks: [] };

function byFormat(map, format) {
  const key = Object.keys(map || {}).find((k) => sameFormat(k, format));
  return key ? map[key] : [];
}

function makeParser(ctx, bundle, format) {
  const s = ctx.settings;
  return new Core.ArchetypeParser(bundle, {
    aliases: s.aliases || {},
    conflict: s.conflict || 'simpler',
    customRules: (s.customRules || []).filter((r) => r && !r.Disabled && (!r.Format || sameFormat(r.Format, format))),
    extraRules: byFormat((ctx.extras || {}).formats, format)
  });
}

async function getBundle(ctx, format, date) {
  const key = rulesKey(format);
  if (ctx.bundles[key]) return ctx.bundles[key];
  try {
    const saved = await http.json(`${ctx.dataUrl}/rules/${key}.json?t=${Date.now()}`);
    if (saved && saved.loadedAt && Date.now() - Date.parse(saved.loadedAt) < RULES_MAX_AGE) {
      ctx.bundles[key] = saved;
      return saved;
    }
  } catch (e) { /* no copy on the site yet */ }
  log(`  downloading the ${format} rules from MTGOFormatData…`);
  const b = await Core.loadFormatBundle(http, format, date);
  log(`  ${b.archetypes.length} archetypes, ${b.fallbacks.length} fallbacks (folder ${b.folder})`);
  ctx.bundles[key] = b;
  if (!DRY) await saveBundle(key, b);
  return b;
}

async function saveBundle(key, b) {
  const copy = Object.assign({}, b);
  delete copy._checked;
  try { await wp('POST', `/rules/${key}`, copy); } catch (e) { log(`  could not cache the rules on the site (${e.message})`); }
}

async function classify(ctx, tour) {
  let bundle;
  try { bundle = await getBundle(ctx, tour.format, tour.date); } catch (e) {
    log(`  no rules for ${tour.format} (${e.message}): house rules and declared deck names only`);
    const sum = Core.classifyTournament(tour, makeParser(ctx, EMPTY_BUNDLE, tour.format));
    tour.players.forEach((p) => { if (p.m === 'unknown' && p.dn) p.m = 'declared'; });
    return sum;
  }
  try {
    const enr = await Core.enrichColorsFromScryfall(http, bundle, tour.cards);
    if (enr.added) {
      log(`  colors of ${enr.added} new cards fetched from Scryfall`);
      if (!DRY) await saveBundle(rulesKey(tour.format), bundle);
    }
  } catch (e) { log(`  Scryfall unreachable, continuing (${e.message})`); }
  return Core.classifyTournament(tour, makeParser(ctx, bundle, tour.format));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function monthsBack(days) {
  const out = new Set();
  const now = Date.now();
  for (let d = 0; d <= days; d += 1) out.add(new Date(now - d * 86400000).toISOString().slice(0, 7));
  return [...out].sort();
}

async function loadExtras(assetsUrl) {
  try { return await http.json(`${assetsUrl}rules-extra.json?t=${Date.now()}`); } catch (e) {
    // Older plugin on the site, or assets not reachable: use the copy in this repository
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mtgstats', 'assets', 'rules-extra.json'), 'utf8'));
  }
}

async function main() {
  if (!SITE || !USER || !PASS) {
    console.error('Set MTGSTATS_URL, MTGSTATS_USER and MTGSTATS_APP_PASSWORD.');
    process.exit(2);
  }
  const status = await wp('GET', '/status');
  const ctx = {
    dataUrl: String(status.dataUrl).replace(/\/+$/, ''),
    settings: await wp('GET', '/settings'),
    extras: await loadExtras(status.assetsUrl),
    bundles: {}
  };
  log(`Site ${SITE}: MTG Stats ${status.version}; core ${Core.version}${DRY ? ' · dry run' : ''}`);
  if (status.version !== Core.version) log(`  note: the site runs ${status.version}, this script ${Core.version}`);

  let index = { tournaments: [] };
  try { index = await http.json(`${ctx.dataUrl}/index.json?t=${Date.now()}`); } catch (e) { /* empty site */ }
  const imported = new Set((index.tournaments || []).map((x) => x.id));
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

  // Same id as the admin panel, so events imported by hand are recognized
  const idFor = (it) => Core.slugify(`${it.source}-${it.sourceId}-${it.date}`);
  const todo = [];
  for (const source of SOURCES) {
    for (const ym of monthsBack(DAYS)) {
      const [y, m] = ym.split('-');
      let items;
      try { items = await Core.listCacheMonth(http, source, y, m); } catch (e) { log(`${source} ${ym}: ${e.message}`); continue; }
      for (const it of items) {
        it.fmt = Core.guessFormat(it.title);
        if (it.date < since || !FORMATS.some((f) => sameFormat(f, it.fmt))) continue;
        if (!LEAGUES && /\bleague\b/i.test(it.title)) continue;
        if (imported.has(idFor(it))) continue;
        todo.push(it);
      }
    }
  }
  todo.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  log(`${todo.length} new events since ${since} (${FORMATS.join(', ')}; ${SOURCES.join(', ')}${LEAGUES ? '; leagues included' : ''})`);
  const batch = todo.slice(0, MAX);
  if (todo.length > batch.length) log(`  importing the oldest ${batch.length}; the rest on the next run`);

  let ok = 0, failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const it = batch[i];
    log(`[${i + 1}/${batch.length}] ${it.date} ${it.title} (${it.source})`);
    try {
      const raw = Core.parseLenientJson(await http.text(it.url));
      const tour = Core.compactFromCache(raw, { source: it.source, sourceId: it.sourceId, file: it.file, title: it.title, date: it.date, id: idFor(it) });
      if (!tour.format) tour.format = it.fmt;
      const sum = await classify(ctx, tour);
      const summary = Object.keys(sum).filter((k) => sum[k]).map((k) => `${sum[k]} ${k}`).join(' · ');
      log(`  ${tour.players.length} players, ${tour.rounds.length} rounds · ${summary}`);
      if (!DRY) await wp('POST', '/tournaments', JSON.stringify(tour));
      ok++;
    } catch (e) {
      failed++;
      log(`  ERROR: ${e.message}`);
    }
  }
  log(`Done: ${ok} ${DRY ? 'ready (dry run, nothing written)' : 'saved'}, ${failed} failed, ${Math.max(0, todo.length - batch.length)} left for the next run.`);
  // A run where every import failed is worth a red mark in the scheduler
  if (batch.length && !ok) process.exit(1);
}

main().catch((e) => { console.error(`Sync failed: ${e.message}`); process.exit(1); });
