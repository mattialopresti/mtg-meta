/*!
 * MTG Stats – dashboard
 * Reads index.json and the compact tournaments, computes the statistics in the browser and draws them as SVG.
 * Adapts to the host theme: inherited font and text color, light/dark detected from the page background,
 * accent color from the WordPress theme or the shortcode's accent attribute. English and Italian.
 */
(() => {
  'use strict';

  const Core = window.MTGStatsCore;
  const Adv = window.MTGStatsAdvanced;
  const I18n = window.MTGStatsI18n;
  const t = (text, vars) => I18n.t(text, vars);

  // ---------------------------------------------------------------------------
  // Formatting (locale follows the dashboard language)
  // ---------------------------------------------------------------------------

  const formats = new Map();
  const cached = (key, make) => { if (!formats.has(key)) formats.set(key, make()); return formats.get(key); };
  const nf = (digits, style = 'decimal') => cached(`${I18n.locale()}|${style}|${digits}`,
    () => new Intl.NumberFormat(I18n.locale(), { style, minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const df = () => cached(`${I18n.locale()}|date`, () => new Intl.DateTimeFormat(I18n.locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }));
  const toDate = (iso) => new Date(`${iso}T00:00:00Z`);

  const fmt = {
    int: (n) => nf(0).format(n),
    num: (n, d = 1) => nf(d).format(n),
    pct: (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : nf(d, 'percent').format(x)),
    pp: (x, d = 1) => {
      if (x === null || x === undefined || !Number.isFinite(x)) return '–';
      const sign = x > 0.00049 ? '+' : x < -0.00049 ? '−' : '±';
      return `${sign}${nf(d).format(Math.abs(x * 100))} pp`;
    },
    record: (o) => `${o.w}-${o.l}${o.d ? `-${o.d}` : ''}`,
    date: (iso) => (iso ? df().format(toDate(iso)) : ''),
    range: (a, b) => {
      if (!a) return '';
      if (!b || a === b) return fmt.date(a);
      return df().formatRange ? df().formatRange(toDate(a), toDate(b)) : `${fmt.date(a)} – ${fmt.date(b)}`;
    },
    ordinal: (n) => (n === null || n === undefined ? '–' : I18n.ordinal(n))
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  const PROPS = new Set(['value', 'checked', 'selected', 'hidden', 'disabled', 'tabIndex']);

  function append(node, kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) append(node, kid);
      else node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROPS.has(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    return append(node, kids);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value !== null && value !== undefined) node.setAttribute(key, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const ICON_PATHS = {
    info: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Zm0-11v6m0-9.5v.01',
    close: 'M6 6l12 12M18 6 6 18',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
    chevron: 'm6 9 6 6 6-6',
    search: 'm20 20-4.5-4.5M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    external: 'M14 5h5v5m0-5-8 8M18 14v5H5V6h5',
    empty: 'M4 19V5m0 14h16M8 15l3-4 3 2 4-6'
  };
  function icon(name, size = 16) {
    const svg = s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'mtgs-icon' });
    svg.append(s('path', { d: ICON_PATHS[name] }));
    return svg;
  }

  const MANA = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
  function pips(colors) {
    const list = String(colors || '').split('').filter((c) => MANA[c]);
    if (!list.length) return null;
    return h('span', { class: 'mtgs-pips', title: list.map((c) => t(MANA[c])).join(', '), 'aria-hidden': 'true' },
      list.map((c) => h('span', { class: `mtgs-pip mtgs-pip-${c}` })));
  }

  function download(name, text) {
    const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return undefined;
  }

  const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  // ---------------------------------------------------------------------------
  // Colors: page background, theme, accent
  // ---------------------------------------------------------------------------

  function parseRgb(str) {
    const m = String(str).match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/);
    if (!m) return null;
    let alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (String(m[4]).endsWith('%')) alpha /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
  }
  function parseHex(str) {
    const m = String(str).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  function luminance({ r, g, b }) {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const toCss = ({ r, g, b }) => `rgb(${r} ${g} ${b})`;

  function pageBackground(node) {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    // No opaque background anywhere: the browser paints the page white, unless the page opts into a dark color scheme
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    const dark = /dark/.test(scheme) && !/light/.test(scheme) && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? { r: 18, g: 18, b: 20, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  function themeAccent() {
    const css = getComputedStyle(document.body);
    for (const name of ['--wp--preset--color--primary', '--wp--preset--color--accent', '--wp--preset--color--secondary']) {
      const value = css.getPropertyValue(name).trim();
      if (!value) continue;
      const probe = h('span', { style: { color: value, display: 'none' } });
      document.body.append(probe);
      const rgb = parseRgb(getComputedStyle(probe).color);
      probe.remove();
      if (rgb) return rgb;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Tooltip and popover
  // ---------------------------------------------------------------------------

  function tipContent(c) {
    return [
      c.title ? h('div', { class: 'mtgs-tip-title' }, c.title) : null,
      c.rows && c.rows.length ? h('dl', { class: 'mtgs-tip-rows' }, c.rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])) : null,
      c.note ? h('p', { class: 'mtgs-tip-note', text: c.note }) : null,
      c.hint ? h('p', { class: 'mtgs-tip-hint', text: c.hint }) : null
    ];
  }

  class Tooltip {
    constructor(host) {
      this.host = host;
      this.el = h('div', { class: 'mtgs-tip', role: 'tooltip', hidden: true });
      host.append(this.el);
      this.owner = null;
      this.lastPointer = 'mouse';
      document.addEventListener('pointerdown', (e) => {
        this.lastPointer = e.pointerType || 'mouse';
        if (this.owner && !this.owner.contains(e.target)) this.hide();
      }, true);
      window.addEventListener('scroll', () => this.hide(), { passive: true });
    }

    showAt(content, x, y, owner) {
      this.el.replaceChildren(...tipContent(content).filter(Boolean));
      this.el.hidden = false;
      this.owner = owner;
      const host = this.host.getBoundingClientRect();
      const w = this.el.offsetWidth, ht = this.el.offsetHeight;
      let left = x - host.left + 14, top = y - host.top + 14;
      if (left + w > host.width - 8) left = x - host.left - w - 14;
      if (left < 4) left = 4;
      if (y + ht + 24 > window.innerHeight) top = y - host.top - ht - 14;
      this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }

    hide() {
      this.el.hidden = true;
      this.owner = null;
    }

    /** Mouse hover, keyboard focus, first tap on touch; Enter/click run onActivate */
    bind(node, content, onActivate) {
      node.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') this.showAt(content(), e.clientX, e.clientY, node); });
      node.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.hide(); });
      node.addEventListener('focus', () => {
        const r = node.getBoundingClientRect();
        this.showAt(content(), r.left + Math.min(r.width, 240) / 2, r.bottom - 6, node);
      });
      node.addEventListener('blur', () => this.hide());
      node.addEventListener('click', (e) => {
        if (this.lastPointer !== 'mouse' && this.owner !== node) {
          this.showAt(content(), e.clientX, e.clientY, node);
          return;
        }
        if (onActivate) { this.hide(); onActivate(); }
      });
      node.addEventListener('keydown', (e) => {
        if (onActivate && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.hide(); onActivate(); }
      });
      if (onActivate) node.classList.add('is-actionable');
    }
  }

  class Popover {
    constructor(host) {
      this.host = host;
      this.current = null;
      document.addEventListener('pointerdown', (e) => {
        if (this.current && !this.current.panel.contains(e.target) && !this.current.trigger.contains(e.target)) this.close();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.current) { const trig = this.current.trigger; this.close(); trig.focus(); }
      });
    }

    toggle(trigger, build, className = '') {
      if (this.current && this.current.trigger === trigger) { this.close(); return; }
      this.close();
      const panel = h('div', { class: `mtgs-pop ${className}`, role: 'dialog' }, build(() => this.close()));
      this.host.append(panel);
      const host = this.host.getBoundingClientRect(), r = trigger.getBoundingClientRect();
      let left = r.left - host.left;
      if (left + panel.offsetWidth > host.width) left = Math.max(0, host.width - panel.offsetWidth);
      panel.style.left = `${left}px`;
      panel.style.top = `${r.bottom - host.top + 6}px`;
      trigger.setAttribute('aria-expanded', 'true');
      this.current = { trigger, panel };
      const focusable = panel.querySelector('input, button');
      if (focusable) focusable.focus({ preventScroll: true });
    }

    close() {
      if (!this.current) return;
      this.current.trigger.setAttribute('aria-expanded', 'false');
      this.current.panel.remove();
      this.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // SVG charts
  // ---------------------------------------------------------------------------

  const labelWidth = (labels, width) => {
    const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
    return Math.min(Math.max(longest * 6.6 + 14, 80), Math.max(110, width * 0.36));
  };

  function svgRoot(width, height, label) {
    return s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'mtgs-svg', role: 'img', 'aria-label': label || '' });
  }

  /** Interactive row shared by the row-based charts */
  function chartRow(svg, tip, { y, rowH, width, item, onSelect }) {
    const g = s('g', { class: 'mtgs-row', tabindex: 0, role: onSelect ? 'button' : null, 'aria-label': item.aria || item.label });
    g.append(s('rect', { x: 0, y, width, height: rowH, class: 'mtgs-hit', rx: 6 }));
    svg.append(g);
    if (item.tip) tip.bind(g, () => item.tip, onSelect && item.key !== null ? () => onSelect(item.key || item.label) : null);
    return g;
  }

  /** Horizontal bars. items: [{label, value, text, tip, muted, lo, hi, mark, key}] */
  function barChart(box, tip, items, opts = {}) {
    const width = Math.max(box.clientWidth, 280);
    const rowH = 28, top = opts.refLabel ? 22 : 4, bottom = opts.axis ? 26 : 4;
    const labW = labelWidth(items.map((i) => i.label), width);
    const valW = opts.valueWidth || 96, plotW = width - labW - valW - 8;
    const height = top + bottom + items.length * rowH;
    const max = opts.max || Math.max(...items.map((i) => Math.max(i.value, i.mark || 0)), 1e-9);
    const X = (v) => labW + plotW * v / max;
    const svg = svgRoot(width, height, opts.aria);
    const maxChars = Math.floor((labW - 10) / 6.4);

    if (opts.axis) {
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        svg.append(s('line', { x1: X(max * f), x2: X(max * f), y1: top, y2: height - bottom, class: 'mtgs-grid' }));
        svg.append(s('text', { x: X(max * f), y: height - 8, 'text-anchor': 'middle', class: 'mtgs-axis' }, opts.axisFmt(max * f)));
      }
    }
    items.forEach((it, i) => {
      const y = top + i * rowH;
      const g = chartRow(svg, tip, { y, rowH, width, item: it, onSelect: opts.onSelect });
      g.append(s('text', { x: labW - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'mtgs-label' }, truncate(it.label, maxChars)));
      g.append(s('rect', { x: labW, y: y + 7, width: Math.max(plotW * it.value / max, it.value > 0 ? 2 : 0), height: rowH - 14, rx: 3, class: `mtgs-bar${it.muted ? ' is-muted' : ''}`, style: `--i:${i}` }));
      if (it.lo !== undefined) g.append(s('line', { x1: X(it.lo), x2: X(it.hi), y1: y + rowH / 2, y2: y + rowH / 2, class: 'mtgs-whisker' }));
      if (it.mark !== undefined) g.append(s('line', { x1: X(it.mark), x2: X(it.mark), y1: y + 4, y2: y + rowH - 4, class: 'mtgs-mark' }));
      g.append(s('text', { x: labW + plotW + 10, y: y + rowH / 2 + 4, class: 'mtgs-value' }, it.text));
    });
    if (opts.ref !== undefined && opts.ref !== null) {
      svg.append(s('line', { x1: X(opts.ref), x2: X(opts.ref), y1: top - 4, y2: height - bottom, class: 'mtgs-ref' }));
      if (opts.refLabel) svg.append(s('text', { x: X(opts.ref), y: top - 8, 'text-anchor': 'middle', class: 'mtgs-ref-label' }, opts.refLabel));
    }
    box.replaceChildren(svg);
  }

  /** Dot + interval around a reference. items: [{label, value, lo, hi, text, tip, muted, mark, key}] */
  function intervalChart(box, tip, items, opts = {}) {
    const center = opts.center ?? 0.5, step = opts.step || 0.1;
    const tickFmt = opts.fmt || ((v) => `${Math.round(v * 100)}%`);
    const width = Math.max(box.clientWidth, 280);
    const rowH = 28, top = 6, bottom = 28;
    const labW = labelWidth(items.map((i) => i.label), width);
    const valW = opts.valueWidth || 70, plotW = width - labW - valW - 10;
    const height = top + bottom + items.length * rowH;
    let lo = opts.min ?? center - 2 * step, hi = opts.max ?? center + 2 * step;
    const snap = step / 2;
    for (const i of items) {
      lo = Math.min(lo, Math.floor(Math.min(i.lo, i.mark ?? i.lo) / snap) * snap);
      hi = Math.max(hi, Math.ceil(Math.max(i.hi, i.mark ?? i.hi) / snap) * snap);
    }
    const X = (v) => labW + plotW * (v - lo) / (hi - lo);
    const svg = svgRoot(width, height, opts.aria);
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) {
      const tick = k * step;
      svg.append(s('line', { x1: X(tick), x2: X(tick), y1: top, y2: height - bottom, class: Math.abs(tick - center) < 1e-9 ? 'mtgs-ref' : 'mtgs-grid' }));
      svg.append(s('text', { x: X(tick), y: height - 9, 'text-anchor': 'middle', class: 'mtgs-axis' }, tickFmt(tick)));
    }
    const maxChars = Math.floor((labW - 10) / 6.4);
    items.forEach((it, i) => {
      const y = top + i * rowH, cy = y + rowH / 2;
      const g = chartRow(svg, tip, { y, rowH, width, item: it, onSelect: opts.onSelect });
      g.append(s('text', { x: labW - 10, y: cy + 4, 'text-anchor': 'end', class: 'mtgs-label' }, truncate(it.label, maxChars)));
      g.append(s('line', { x1: X(it.lo), x2: X(it.hi), y1: cy, y2: cy, class: `mtgs-interval${it.muted ? ' is-muted' : ''}` }));
      if (it.mark !== undefined) g.append(s('line', { x1: X(it.mark), x2: X(it.mark), y1: cy - 7, y2: cy + 7, class: 'mtgs-mark' }));
      g.append(s('circle', { cx: X(it.value), cy, r: 5, class: `mtgs-dot${it.muted ? ' is-muted' : ''}` }));
      g.append(s('text', { x: labW + plotW + 10, y: cy + 4, class: 'mtgs-value' }, it.text));
    });
    box.replaceChildren(svg);
  }

  /** Share vs win rate scatter. items: [{label, x, y, tip, labelled}] */
  function scatterChart(box, tip, items, opts = {}) {
    const width = Math.max(box.clientWidth, 280);
    const height = Math.min(Math.max(width * 0.62, 300), 440);
    const m = { l: 44, r: 14, t: 12, b: 40 };
    const pw = width - m.l - m.r, ph = height - m.t - m.b;
    const xMax = Math.max(...items.map((i) => i.x), 0.01) * 1.1;
    const yMin = Math.floor(Math.min(...items.map((i) => i.y), 0.45) * 20) / 20;
    const yMax = Math.ceil(Math.max(...items.map((i) => i.y), 0.55) * 20) / 20;
    const X = (v) => m.l + pw * v / xMax, Y = (v) => m.t + ph * (1 - (v - yMin) / (yMax - yMin));
    const svg = svgRoot(width, height, opts.aria);
    for (let k = Math.round(yMin * 20); k <= Math.round(yMax * 20); k++) {
      const yt = k / 20;
      svg.append(s('line', { x1: m.l, x2: width - m.r, y1: Y(yt), y2: Y(yt), class: 'mtgs-grid' }));
      svg.append(s('text', { x: m.l - 8, y: Y(yt) + 4, 'text-anchor': 'end', class: 'mtgs-axis' }, `${Math.round(yt * 100)}%`));
    }
    const xStep = xMax > 0.2 ? 0.05 : xMax > 0.08 ? 0.02 : 0.01;
    for (let k = 0; k * xStep <= xMax + 1e-9; k++) {
      svg.append(s('text', { x: X(k * xStep), y: height - m.b + 18, 'text-anchor': 'middle', class: 'mtgs-axis' }, `${Math.round(k * xStep * 100)}%`));
    }
    svg.append(s('text', { x: m.l + pw / 2, y: height - 4, 'text-anchor': 'middle', class: 'mtgs-axis-title' }, t('Share')));
    svg.append(s('text', { x: 12, y: m.t + ph / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${m.t + ph / 2})`, class: 'mtgs-axis-title' }, t('Win rate')));
    if (opts.medianX !== undefined) svg.append(s('line', { x1: X(opts.medianX), x2: X(opts.medianX), y1: m.t, y2: m.t + ph, class: 'mtgs-ref' }));
    svg.append(s('line', { x1: m.l, x2: width - m.r, y1: Y(0.5), y2: Y(0.5), class: 'mtgs-ref' }));

    const placed = [];
    for (const it of [...items].sort((a, b) => b.x - a.x)) {
      const g = s('g', { class: 'mtgs-pt', tabindex: 0, role: opts.onSelect ? 'button' : null, 'aria-label': it.label });
      g.append(s('circle', { cx: X(it.x), cy: Y(it.y), r: 13, class: 'mtgs-hit' }));
      g.append(s('circle', { cx: X(it.x), cy: Y(it.y), r: 5, class: 'mtgs-dot' }));
      tip.bind(g, () => it.tip, opts.onSelect ? () => opts.onSelect(it.label) : null);
      svg.append(g);
      if (!it.labelled) continue;
      const tw = it.label.length * 6.2;
      let tx = X(it.x) + 9, ty = Y(it.y) + 4;
      if (tx + tw > width - m.r) tx = X(it.x) - 9 - tw;
      const collides = (yy) => placed.some((p) => Math.abs(p.y - yy) < 12 && tx < p.x + p.w && tx + tw > p.x);
      const shift = [0, -12, 12, -24, 24].find((d) => !collides(ty + d));
      if (shift === undefined) continue;
      ty += shift;
      placed.push({ x: tx, y: ty, w: tw });
      svg.append(s('text', { x: tx, y: ty, class: 'mtgs-pt-label' }, it.label));
    }
    box.replaceChildren(svg);
  }

  /** Small multiples: one mini line chart per panel, shared vertical scale. */
  function smallMultiples(box, tip, panels, labels, opts = {}) {
    const width = Math.max(box.clientWidth, 260);
    const cols = opts.cols || (width >= 900 ? 4 : width >= 600 ? 3 : 2);
    const gap = 12, pw = Math.floor((width - gap * (cols - 1)) / cols) - 2, ph = opts.height || 78;
    const all = panels.flatMap((p) => p.values.filter((v) => v !== null));
    const yMin = opts.yMin ?? Math.min(...all);
    let yMax = opts.yMax ?? Math.max(...all);
    if (!(yMax - yMin > 1e-9)) yMax = yMin + 0.01;
    const n = labels.length, padX = 6, padY = 8;
    const X = (i) => (n === 1 ? pw / 2 : padX + (pw - 2 * padX) * i / (n - 1));
    const Y = (v) => padY + (ph - 2 * padY) * (1 - (v - yMin) / (yMax - yMin));
    const grid = h('div', { class: 'mtgs-sm-grid', style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } });
    for (const p of panels) {
      const svg = svgRoot(pw, ph, p.title);
      svg.append(s('line', { x1: 0, x2: pw, y1: Y(yMin), y2: Y(yMin), class: 'mtgs-grid' }));
      if (opts.ref !== undefined) svg.append(s('line', { x1: 0, x2: pw, y1: Y(opts.ref), y2: Y(opts.ref), class: 'mtgs-ref' }));
      let d = '', pen = false;
      p.values.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
        pen = true;
      });
      if (opts.area && n > 1 && p.values.every((v) => v !== null)) {
        svg.append(s('path', { d: `${d}L${X(n - 1).toFixed(1)} ${Y(yMin).toFixed(1)}L${X(0).toFixed(1)} ${Y(yMin).toFixed(1)}Z`, class: 'mtgs-area' }));
      }
      svg.append(s('path', { d, class: 'mtgs-line' }));
      p.values.forEach((v, i) => { if (v !== null) svg.append(s('circle', { cx: X(i), cy: Y(v), r: i === n - 1 ? 3.5 : 2, class: 'mtgs-line-dot' })); });
      const half = n === 1 ? pw / 2 : (pw - 2 * padX) / (n - 1) / 2;
      p.values.forEach((v, i) => {
        const band = s('rect', { x: Math.max(0, X(i) - half), y: 0, width: Math.min(pw, half * 2), height: ph, class: 'mtgs-hit' });
        if (p.tips && p.tips[i]) tip.bind(band, () => p.tips[i]);
        svg.append(band);
      });
      const title = opts.onSelect
        ? h('button', { type: 'button', class: 'mtgs-sm-title is-link', title: p.title, onClick: () => opts.onSelect(p.title) }, p.title)
        : h('span', { class: 'mtgs-sm-title', title: p.title }, p.title);
      grid.append(h('div', { class: 'mtgs-sm' },
        h('div', { class: 'mtgs-sm-head' }, title, h('span', { class: 'mtgs-sm-value' }, p.valueText || '')),
        p.sub ? h('div', { class: `mtgs-sm-sub ${p.trend || ''}` }, p.sub) : null,
        svg));
    }
    const children = [grid];
    if (n > 1) children.push(h('p', { class: 'mtgs-footnote' }, `${labels[0]} → ${labels[n - 1]}${opts.scaleText ? ` · ${opts.scaleText}` : ''}`));
    box.replaceChildren(...children);
  }

  /** Connected dots per row (all → Day 2 → Top 8) */
  function dotPlot(box, tip, rows, series, opts = {}) {
    const width = Math.max(box.clientWidth, 280);
    const rowH = 28, top = 4, bottom = 26;
    const labW = labelWidth(rows.map((r) => r.label), width);
    const valW = opts.valueWidth || 150, plotW = width - labW - valW - 10;
    const height = top + bottom + rows.length * rowH;
    const max = Math.max(...rows.flatMap((r) => r.values), 1e-9) * 1.08;
    const X = (v) => labW + plotW * v / max;
    const svg = svgRoot(width, height, opts.aria);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { x1: X(max * f), x2: X(max * f), y1: top, y2: height - bottom, class: 'mtgs-grid' }));
      svg.append(s('text', { x: X(max * f), y: height - 8, 'text-anchor': 'middle', class: 'mtgs-axis' }, fmt.pct(max * f, 0)));
    }
    const maxChars = Math.floor((labW - 10) / 6.4);
    rows.forEach((r, i) => {
      const y = top + i * rowH, cy = y + rowH / 2;
      const g = chartRow(svg, tip, { y, rowH, width, item: r, onSelect: opts.onSelect });
      g.append(s('text', { x: labW - 10, y: cy + 4, 'text-anchor': 'end', class: 'mtgs-label' }, truncate(r.label, maxChars)));
      g.append(s('line', { x1: X(Math.min(...r.values)), x2: X(Math.max(...r.values)), y1: cy, y2: cy, class: 'mtgs-dumbbell' }));
      r.values.forEach((v, k) => g.append(s('circle', { cx: X(v), cy, r: 5, class: `mtgs-s${k + 1}` })));
      g.append(s('text', { x: labW + plotW + 10, y: cy + 4, class: 'mtgs-value' }, r.text));
    });
    box.replaceChildren(
      h('div', { class: 'mtgs-legend' }, series.map((name, k) => h('span', { class: 'mtgs-legend-item' }, h('span', { class: `mtgs-swatch mtgs-bg-s${k + 1}` }), name))),
      svg
    );
  }

  function sparkline(values, { width = 220, height = 44 } = {}) {
    const vals = values.filter((v) => v !== null);
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'mtgs-spark', 'aria-hidden': 'true' });
    if (vals.length < 2) return svg;
    const min = Math.min(...vals, 0), max = Math.max(...vals) || 1;
    const X = (i) => 4 + (width - 8) * i / (values.length - 1), Y = (v) => height - 4 - (height - 8) * (v - min) / (max - min || 1);
    let d = '', pen = false;
    values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; });
    svg.append(s('path', { d, class: 'mtgs-line' }));
    const last = values.length - 1;
    if (values[last] !== null) svg.append(s('circle', { cx: X(last), cy: Y(values[last]), r: 3.5, class: 'mtgs-line-dot' }));
    return svg;
  }

  // Fixed diverging scale (blue = favorable, red = unfavorable), the same with any site color
  const DIVERGING = {
    light: { neg: [227, 73, 72], mid: [240, 239, 236], pos: [42, 120, 214] },
    dark: { neg: [230, 103, 103], mid: [56, 56, 53], pos: [57, 135, 229] }
  };
  function divergingColor(v, dark) {
    const p = dark ? DIVERGING.dark : DIVERGING.light;
    const k0 = Math.max(-1, Math.min(1, (v - 0.5) / 0.3));
    const pole = k0 < 0 ? p.neg : p.pos, k = Math.abs(k0);
    return { bg: `rgb(${p.mid.map((c, i) => Math.round(c + (pole[i] - c) * k)).join(' ')})`, strong: k > 0.55 };
  }

  // ---------------------------------------------------------------------------
  // URL state
  // ---------------------------------------------------------------------------

  const URL_KEYS = ['tab', 'format', 'days', 'ev', 'top', 'arch', 'card'];
  const readHash = () => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const out = {};
    for (const key of URL_KEYS) if (params.has(key)) out[key] = params.get(key);
    return out;
  };

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  const TABS = [
    { id: 'meta', label: 'Metagame' },
    { id: 'mu', label: 'Matchups' },
    { id: 'pos', label: 'Positioning' },
    { id: 'trend', label: 'Trends' },
    { id: 'conv', label: 'Conversion' },
    { id: 'cards', label: 'Cards' },
    { id: 'players', label: 'Players' },
    { id: 'data', label: 'Data' }
  ];
  const PERIODS = ['7', '30', '90', 'all'];
  const PREF_KEYS = ['muN', 'muMode', 'convMode', 'posN', 'posField', 'trendBucket', 'trendMetric', 'playerMin'];
  let instances = 0;

  class Dashboard {
    constructor(root) {
      this.root = root;
      this.index = instances++;
      // One language per page: the first dashboard decides it
      if (this.index === 0) I18n.setLang(root.dataset.lang || document.documentElement.lang);
      this.src = (root.dataset.src || '').replace(/\/$/, '');
      const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      this.cfg = {
        format: root.dataset.format || '',
        days: root.dataset.days || '30',
        fixedIds: list(root.dataset.tournaments),
        tabs: list(root.dataset.tabs),
        alpha: parseFloat(root.dataset.prior || '10') || 10,
        theme: root.dataset.theme || 'auto',
        accent: root.dataset.accent || '',
        urlState: root.dataset.urlState !== 'off' && this.index === 0
      };
      this.cache = new Map();
      this.state = {
        tab: 'meta', format: '', days: this.cfg.days, ev: null, excludePlayoffs: false, arch: '', cardArch: '',
        muN: 10, muMode: 'obs', convMode: 'auto', posN: 12, posField: 'all', trendBucket: 'auto', trendMetric: 'share', playerMin: 10
      };
      try { Object.assign(this.state, JSON.parse(localStorage.getItem('mtgs-prefs') || '{}')); } catch (e) { /* storage unavailable */ }
      this.selectArchetype = (name) => this.openArchetype(name);
      this.applyTheme();
      this.init();
    }

    // --- theme -----------------------------------------------------------------

    applyTheme() {
      const root = this.root;
      const bg = pageBackground(root);
      this.dark = this.cfg.theme === 'dark' || (this.cfg.theme === 'auto' && luminance(bg) < 0.25);
      root.classList.add('mtgs');
      root.classList.toggle('mtgs-dark', this.dark);
      root.setAttribute('lang', I18n.lang);
      const page = this.cfg.theme === 'auto' ? bg : (this.dark ? { r: 22, g: 23, b: 26 } : { r: 255, g: 255, b: 255 });
      root.style.setProperty('--mtgs-page', toCss(page));
      const fallback = this.dark ? { r: 57, g: 135, b: 229 } : { r: 42, g: 120, b: 214 };
      let accent = parseHex(this.cfg.accent) || themeAccent();
      if (!accent || contrast(accent, page) < 2.2) accent = fallback;
      root.style.setProperty('--mtgs-accent', toCss(accent));
      root.style.setProperty('--mtgs-on-accent', luminance(accent) > 0.45 ? '#111' : '#fff');
      const bar = document.getElementById('wpadminbar');
      const offset = bar && getComputedStyle(bar).position === 'fixed' ? bar.offsetHeight : 0;
      root.style.setProperty('--mtgs-sticky-top', `${offset}px`);
    }

    // --- data ------------------------------------------------------------------

    async fetchJson(path) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await fetch(`${this.src}/${path}${sep}v=${encodeURIComponent(this.stamp || Date.now())}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    async init() {
      this.root.replaceChildren(this.skeleton());
      try {
        const index = await this.fetchJson('index.json');
        this.stamp = index.updated || '';
        this.all = (index.tournaments || []).slice().sort((a, b) => b.date.localeCompare(a.date));
      } catch (e) {
        this.root.replaceChildren(this.emptyState(t('Data unavailable'), t('The statistics could not be loaded ({error}). Please try again in a few minutes.', { error: e.message })));
        return;
      }
      if (!this.all.length) {
        this.root.replaceChildren(this.emptyState(t('No tournaments yet'), t('Statistics will appear here as soon as the first tournaments are imported.')));
        return;
      }
      const counts = {};
      for (const ev of this.all) counts[ev.format] = (counts[ev.format] || 0) + 1;
      this.formats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

      const fromUrl = this.cfg.urlState ? readHash() : {};
      const st = this.state;
      st.format = [fromUrl.format, this.cfg.format].find((f) => f && counts[f]) || this.formats[0];
      if (fromUrl.days && (fromUrl.days === 'all' || /^\d+$/.test(fromUrl.days))) st.days = fromUrl.days;
      if (fromUrl.ev) st.ev = new Set(fromUrl.ev.split(','));
      if (fromUrl.top === '1') st.excludePlayoffs = true;
      if (fromUrl.card) st.cardArch = fromUrl.card;
      const tabs = this.visibleTabs();
      st.tab = [fromUrl.tab, st.tab].find((x) => tabs.some((tab) => tab.id === x)) || tabs[0].id;
      this.pendingArch = fromUrl.arch || '';

      this.buildShell();
      this.applyPeriod({ keepSelection: true });
      if (this.cfg.urlState) window.addEventListener('hashchange', () => this.onHashChange());
    }

    visibleTabs() {
      return TABS.filter((tab) => !this.cfg.tabs.length || this.cfg.tabs.includes(tab.id));
    }

    savePrefs() {
      const prefs = {};
      for (const k of PREF_KEYS) prefs[k] = this.state[k];
      try { localStorage.setItem('mtgs-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    }

    syncUrl() {
      if (!this.cfg.urlState) return;
      const st = this.state, p = new URLSearchParams();
      p.set('tab', st.tab);
      if (!this.cfg.fixedIds.length) {
        p.set('format', st.format);
        p.set('days', st.days);
        if (st.ev && this.pool && st.ev.size !== this.pool.length) p.set('ev', [...st.ev].join(','));
      }
      if (st.excludePlayoffs) p.set('top', '1');
      if (st.tab === 'cards' && st.cardArch) p.set('card', st.cardArch);
      if (st.arch) p.set('arch', st.arch);
      const hash = `#${p.toString()}`;
      if (hash !== location.hash) {
        this.writingHash = hash;
        history.replaceState(null, '', hash);
      }
    }

    onHashChange() {
      if (location.hash === this.writingHash) return;
      const u = readHash();
      if (u.arch && u.arch !== this.state.arch) this.openArchetype(u.arch);
      else if (!u.arch && this.state.arch) this.closeDrawer();
      if (u.tab && u.tab !== this.state.tab && this.visibleTabs().some((tab) => tab.id === u.tab)) this.setTab(u.tab);
    }

    // --- layout ----------------------------------------------------------------

    buildShell() {
      const st = this.state;
      const fixed = this.cfg.fixedIds.length > 0;

      this.formatSelect = h('select', { class: 'mtgs-select', 'aria-label': t('Format'), onChange: (e) => { st.format = e.target.value; st.ev = null; this.applyPeriod(); } },
        this.formats.map((f) => h('option', { value: f, selected: f === st.format, text: f })));

      const values = PERIODS.includes(String(st.days)) ? PERIODS : [...PERIODS.slice(0, -1), String(st.days), 'all'];
      this.periodGroup = h('div', { class: 'mtgs-segmented', role: 'radiogroup', 'aria-label': t('Period') },
        values.map((v) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(String(st.days) === v), class: 'mtgs-seg', dataset: { value: v },
          onClick: () => { st.days = v; st.ev = null; this.applyPeriod(); }
        }, v === 'all' ? t('All') : t('{n} d', { n: v }))));

      this.eventsButton = h('button', { type: 'button', class: 'mtgs-select mtgs-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: (e) => this.openEventPicker(e.currentTarget) });

      this.playoffInput = h('input', { type: 'checkbox', role: 'switch', checked: st.excludePlayoffs, onChange: (e) => { st.excludePlayoffs = e.target.checked; this.compute(); } });
      const playoffSwitch = h('label', { class: 'mtgs-switch' }, this.playoffInput, h('span', { class: 'mtgs-switch-track', 'aria-hidden': 'true' }), t('Exclude top cut'));

      const share = this.cfg.urlState ? h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-ghost', onClick: () => this.shareLink() }, icon('link'), h('span', { class: 'mtgs-hide-sm' }, t('Copy link'))) : null;

      this.summary = h('p', { class: 'mtgs-summary', 'aria-live': 'polite' });
      this.chips = h('div', { class: 'mtgs-chips' });

      const tabs = this.visibleTabs();
      this.tabButtons = new Map();
      this.tablist = h('div', { class: 'mtgs-tabs', role: 'tablist', 'aria-label': t('Sections'), onKeydown: (e) => this.onTabKey(e) },
        tabs.map((tab) => {
          const b = h('button', { type: 'button', role: 'tab', id: `mtgs-${this.index}-tab-${tab.id}`, 'aria-controls': `mtgs-${this.index}-panel`, class: 'mtgs-tab', onClick: () => this.setTab(tab.id) }, t(tab.label));
          this.tabButtons.set(tab.id, b);
          return b;
        }));

      this.body = h('div', { class: 'mtgs-body', id: `mtgs-${this.index}-panel`, role: 'tabpanel', tabindex: '-1' });
      this.toast = h('div', { class: 'mtgs-toast', role: 'status', 'aria-live': 'polite' });

      const bar = h('div', { class: 'mtgs-bar' },
        h('div', { class: 'mtgs-filters' },
          fixed ? null : this.formatSelect,
          fixed ? null : this.periodGroup,
          fixed ? null : this.eventsButton,
          playoffSwitch,
          h('span', { class: 'mtgs-spacer' }),
          share),
        tabs.length > 1 ? h('div', { class: 'mtgs-tabs-wrap' }, this.tablist) : null);

      this.root.replaceChildren(bar, h('div', { class: 'mtgs-context' }, this.summary, this.chips), this.body, this.toast);
      this.tip = new Tooltip(this.root);
      this.pop = new Popover(this.root);
      this.updateTabs();

      let lastWidth = this.root.clientWidth, timer;
      new ResizeObserver(() => {
        if (Math.abs(this.root.clientWidth - lastWidth) < 8) return;
        lastWidth = this.root.clientWidth;
        clearTimeout(timer);
        timer = setTimeout(() => { if (this.result) this.renderTab(); }, 150);
      }).observe(this.root);
    }

    onTabKey(e) {
      const ids = this.visibleTabs().map((tab) => tab.id);
      let i = ids.indexOf(this.state.tab);
      if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
      else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      else return;
      e.preventDefault();
      this.setTab(ids[i]);
      this.tabButtons.get(ids[i]).focus();
    }

    setTab(id) {
      this.state.tab = id;
      this.updateTabs();
      this.renderTab();
    }

    updateTabs() {
      for (const [id, b] of this.tabButtons) {
        const active = id === this.state.tab;
        b.setAttribute('aria-selected', String(active));
        b.tabIndex = active ? 0 : -1;
        b.classList.toggle('is-active', active);
        if (active) {
          this.body.setAttribute('aria-labelledby', b.id);
          const wrap = this.tablist;
          if (b.offsetLeft < wrap.scrollLeft || b.offsetLeft + b.offsetWidth > wrap.scrollLeft + wrap.clientWidth) {
            wrap.scrollTo({ left: b.offsetLeft - 24, behavior: 'smooth' });
          }
        }
      }
    }

    showToast(text) {
      this.toast.textContent = text;
      this.toast.classList.add('is-on');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toast.classList.remove('is-on'), 2200);
    }

    async shareLink() {
      this.syncUrl();
      try { await copyText(location.href); this.showToast(t('Link copied to the clipboard')); } catch (e) { this.showToast(t('Copy failed')); }
    }

    // --- selection ---------------------------------------------------------------

    applyPeriod({ keepSelection = false } = {}) {
      const st = this.state;
      let pool;
      if (this.cfg.fixedIds.length) {
        pool = this.all.filter((ev) => this.cfg.fixedIds.includes(ev.id));
      } else {
        pool = this.all.filter((ev) => ev.format === st.format);
        if (st.days !== 'all' && pool.length) {
          // The period counts back from the latest event, so the page never empties out between imports
          const from = new Date(toDate(pool[0].date).getTime() - (parseInt(st.days, 10) - 1) * 86400000).toISOString().slice(0, 10);
          pool = pool.filter((ev) => ev.date >= from);
        }
      }
      this.pool = pool;
      if (!keepSelection || !st.ev) st.ev = new Set(pool.map((ev) => ev.id));
      else st.ev = new Set(pool.map((ev) => ev.id).filter((id) => st.ev.has(id)));
      if (!st.ev.size) st.ev = new Set(pool.map((ev) => ev.id));
      this.formatSelect.value = st.format;
      for (const b of this.periodGroup.querySelectorAll('.mtgs-seg')) b.setAttribute('aria-checked', String(b.dataset.value === String(st.days)));
      this.updateEventsButton();
      this.load();
    }

    updateEventsButton() {
      const n = this.state.ev.size, total = this.pool.length;
      this.eventsButton.replaceChildren(h('span', {}, n === total ? t('All events · {n}', { n: total }) : t('{n} of {total} events', { n, total })), icon('chevron', 14));
    }

    openEventPicker(trigger) {
      this.pop.toggle(trigger, () => {
        const st = this.state;
        const search = h('input', { type: 'search', class: 'mtgs-input', placeholder: t('Search events…'), 'aria-label': t('Search events…') });
        const list = h('div', { class: 'mtgs-checklist' });
        const draw = () => {
          const q = search.value.trim().toLowerCase();
          list.replaceChildren(...this.pool.filter((ev) => !q || ev.name.toLowerCase().includes(q)).map((ev) =>
            h('label', { class: 'mtgs-check-item' },
              h('input', { type: 'checkbox', checked: st.ev.has(ev.id), onChange: (e) => { if (e.target.checked) st.ev.add(ev.id); else st.ev.delete(ev.id); this.onSelectionChange(); } }),
              h('span', { class: 'mtgs-check-name' }, ev.name),
              h('span', { class: 'mtgs-check-meta' }, `${fmt.date(ev.date)} · ${t('{n} players', { n: fmt.int(ev.players) })}`))));
        };
        search.addEventListener('input', draw);
        draw();
        const setAll = (on) => { st.ev = new Set(on ? this.pool.map((ev) => ev.id) : []); draw(); this.onSelectionChange(); };
        return [
          search,
          h('div', { class: 'mtgs-pop-actions' },
            h('button', { type: 'button', class: 'mtgs-link', onClick: () => setAll(true) }, t('Select all')),
            h('button', { type: 'button', class: 'mtgs-link', onClick: () => setAll(false) }, t('None'))),
          list
        ];
      }, 'mtgs-pop-events');
    }

    onSelectionChange() {
      this.updateEventsButton();
      clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => this.load(), 250);
    }

    renderChips() {
      const st = this.state, chips = [];
      if (this.pool && st.ev.size !== this.pool.length) {
        chips.push([t('{n} of {total} events', { n: st.ev.size, total: this.pool.length }), () => { st.ev = new Set(this.pool.map((ev) => ev.id)); this.updateEventsButton(); this.load(); }]);
      }
      if (st.excludePlayoffs) {
        chips.push([t('Top cut excluded'), () => { st.excludePlayoffs = false; this.playoffInput.checked = false; this.compute(); }]);
      }
      this.chips.replaceChildren(...chips.map(([label, remove]) => h('button', { type: 'button', class: 'mtgs-chip', 'aria-label': t('Remove filter: {label}', { label }), onClick: remove }, label, icon('close', 12))));
    }

    async load() {
      const ids = this.pool.filter((ev) => this.state.ev.has(ev.id));
      const token = (this.loadToken = (this.loadToken || 0) + 1);
      if (!ids.length) {
        this.tournaments = [];
        this.compute();
        return;
      }
      if (ids.some((ev) => !this.cache.has(ev.id))) this.body.replaceChildren(this.skeleton(true));
      try {
        const data = await Promise.all(ids.map((ev) => {
          if (!this.cache.has(ev.id)) this.cache.set(ev.id, this.fetchJson(ev.file || `t/${ev.id}.json`));
          return this.cache.get(ev.id);
        }));
        if (token !== this.loadToken) return;
        this.tournaments = data;
        this.compute();
      } catch (e) {
        ids.forEach((ev) => this.cache.delete(ev.id));
        this.body.replaceChildren(this.emptyState(t('Loading failed'), t('Some events could not be loaded ({error}).', { error: e.message }), [t('Try again'), () => this.load()]));
      }
    }

    compute() {
      const ts = this.tournaments || [];
      const rows = Core.playerRows(ts, { excludePlayoffs: this.state.excludePlayoffs });
      const meta = Core.metaStats(rows, { alpha: this.cfg.alpha, beta: this.cfg.alpha });
      let matches = 0;
      for (const ev of ts) for (const r of ev.rounds) if (!r.ex) for (const m of r.m) if (m[1] >= 0) matches++;
      this.result = { rows, meta, matches, memo: new Map(), byName: new Map(meta.map((m) => [m.archetype, m])) };
      const dates = ts.map((ev) => ev.date).sort();
      this.summary.textContent = ts.length
        ? [t(ts.length === 1 ? '{n} event' : '{n} events', { n: fmt.int(ts.length) }), t('{n} players', { n: fmt.int(rows.length) }),
          t('{n} matches', { n: fmt.int(matches) }), fmt.range(dates[0], dates[dates.length - 1])].join(' · ')
        : '';
      this.renderChips();
      this.renderTab();
      if (this.drawer && !this.drawer.hidden && this.state.arch) {
        if (this.result.byName.has(this.state.arch)) { this.drawerName = ''; this.openArchetype(this.state.arch); } else this.closeDrawer();
      }
      if (this.pendingArch) { const a = this.pendingArch; this.pendingArch = ''; if (this.result.byName.has(a)) this.openArchetype(a); }
    }

    memo(key, fn) {
      const m = this.result.memo;
      if (!m.has(key)) m.set(key, fn());
      return m.get(key);
    }

    renderTab() {
      this.tip.hide();
      this.pop.close();
      this.syncUrl();
      if (!this.result || !this.result.rows.length) {
        const noneSelected = this.state.ev && this.state.ev.size === 0;
        this.body.replaceChildren(this.emptyState(t('Nothing to show'),
          noneSelected ? t('No event is selected.') : t('No events in the selected period.'),
          noneSelected || this.state.days === 'all'
            ? [t('Select all events'), () => { this.state.ev = new Set(this.pool.map((ev) => ev.id)); this.updateEventsButton(); this.load(); }]
            : [t('Show the whole period'), () => { this.state.days = 'all'; this.applyPeriod(); }]));
        return;
      }
      const renderers = {
        meta: this.renderMeta, mu: this.renderMatchups, pos: this.renderPositioning, trend: this.renderTrend,
        conv: this.renderConversion, cards: this.renderCards, players: this.renderPlayers, data: this.renderData
      };
      const frag = document.createDocumentFragment();
      const after = [];
      (renderers[this.state.tab] || this.renderMeta).call(this, frag, (fn) => after.push(fn));
      this.body.replaceChildren(frag);
      after.forEach((fn) => fn());
      this.savePrefs();
    }

    // --- interface building blocks ---------------------------------------------

    section({ title, lead, info, actions, wide }) {
      const id = `mtgs-${this.index}-s${(this.sectionCounter = (this.sectionCounter || 0) + 1)}`;
      const infoBtn = info ? h('button', {
        type: 'button', class: 'mtgs-info', 'aria-label': t('How to read: {title}', { title }), 'aria-expanded': 'false',
        onClick: (e) => this.pop.toggle(e.currentTarget, () => [h('p', { class: 'mtgs-pop-text' }, info)], 'mtgs-pop-info')
      }, icon('info')) : null;
      const body = h('div', { class: 'mtgs-section-body' });
      const node = h('section', { class: `mtgs-section${wide ? ' is-wide' : ''}`, 'aria-labelledby': id },
        h('div', { class: 'mtgs-section-head' },
          h('div', { class: 'mtgs-section-titles' },
            h('h3', { class: 'mtgs-section-title', id }, title, infoBtn),
            lead ? h('p', { class: 'mtgs-section-lead' }, lead) : null),
          actions && actions.length ? h('div', { class: 'mtgs-section-actions' }, actions) : null),
        body);
      return { node, body };
    }

    segmented(label, options, value, onChange) {
      return h('div', { class: 'mtgs-segmented', role: 'radiogroup', 'aria-label': label },
        options.map(([v, text]) => h('button', { type: 'button', role: 'radio', class: 'mtgs-seg', 'aria-checked': String(v === value), onClick: () => onChange(v) }, text)));
    }

    select(label, options, value, onChange) {
      return h('select', { class: 'mtgs-select', 'aria-label': label, onChange: (e) => onChange(e.target.value) },
        options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value), text })));
    }

    emptyState(title, text, action) {
      return h('div', { class: 'mtgs-empty' },
        h('div', { class: 'mtgs-empty-icon' }, icon('empty', 28)),
        h('p', { class: 'mtgs-empty-title' }, title),
        text ? h('p', { class: 'mtgs-empty-text' }, text) : null,
        action ? h('button', { type: 'button', class: 'mtgs-btn', onClick: action[1] }, action[0]) : null);
    }

    skeleton(bodyOnly = false) {
      const block = (cls) => h('div', { class: `mtgs-skel ${cls}` });
      const content = h('div', { class: 'mtgs-skeleton', 'aria-busy': 'true', 'aria-label': t('Loading') },
        h('div', { class: 'mtgs-kpis' }, block('is-kpi'), block('is-kpi'), block('is-kpi'), block('is-kpi')),
        h('div', { class: 'mtgs-grid2' }, block('is-chart'), block('is-chart')));
      if (bodyOnly) return content;
      return h('div', {}, h('div', { class: 'mtgs-bar' }, h('div', { class: 'mtgs-filters' }, block('is-control'), block('is-control is-wide'), block('is-control'))), content);
    }

    kpis(items) {
      return h('div', { class: 'mtgs-kpis' }, items.filter(Boolean).map((k) => h('div', { class: 'mtgs-kpi' },
        h('div', { class: 'mtgs-kpi-label' }, k.label),
        h('div', { class: `mtgs-kpi-value${k.small ? ' is-small' : ''}` }, k.value),
        k.sub ? h('div', { class: 'mtgs-kpi-sub' }, k.sub) : null)));
    }

    archetypeLink(name, colors) {
      if (!name || name === 'Unknown') return h('span', { class: 'mtgs-muted' }, name === 'Unknown' ? t('Unrecognized') : '–');
      return h('button', { type: 'button', class: 'mtgs-arch', onClick: () => this.openArchetype(name) }, pips(colors), h('span', {}, name));
    }

    dominantColor(name) {
      const m = this.result.byName.get(name);
      if (!m || !m.colors) return '';
      return Object.keys(m.colors).sort((a, b) => m.colors[b] - m.colors[a])[0] || '';
    }

    /** Sortable table. cols: [{key, label, num, fmt(v, row), bar, arch, cls}] */
    table(cols, data, { sortKey, limit = 25, search } = {}) {
      const state = { key: sortKey, dir: -1, query: '', showAll: false };
      const maxBar = {};
      for (const c of cols) if (c.bar) maxBar[c.key] = Math.max(...data.map((r) => r[c.key] || 0), 1e-9);
      const searchInput = search ? h('label', { class: 'mtgs-search' }, icon('search', 14),
        h('input', { type: 'search', class: 'mtgs-input', placeholder: search, 'aria-label': search, onInput: (e) => { state.query = e.target.value.trim().toLowerCase(); render(); } })) : null;
      const tableHost = h('div', { class: 'mtgs-table-scroll' });
      const more = h('div', { class: 'mtgs-table-foot' });
      const render = () => {
        let rows = data;
        if (state.query) rows = rows.filter((r) => cols.some((c) => !c.num && String(r[c.key] ?? '').toLowerCase().includes(state.query)));
        rows = [...rows].sort((a, b) => {
          const x = a[state.key], y = b[state.key];
          if (typeof x === 'string' || typeof y === 'string') return -state.dir * String(x ?? '').localeCompare(String(y ?? ''), I18n.locale());
          return state.dir * ((x ?? -Infinity) - (y ?? -Infinity));
        });
        const total = rows.length;
        const clipped = !state.showAll && !state.query && total > limit + 5;
        if (clipped) rows = rows.slice(0, limit);
        const thead = h('thead', {}, h('tr', {}, cols.map((c) => {
          const active = state.key === c.key;
          return h('th', { class: c.num ? 'is-num' : '', 'aria-sort': active ? (state.dir < 0 ? 'descending' : 'ascending') : 'none', scope: 'col' },
            h('button', { type: 'button', class: 'mtgs-th', onClick: () => { state.dir = state.key === c.key ? -state.dir : (c.num ? -1 : 1); state.key = c.key; render(); } },
              c.label, h('span', { class: 'mtgs-sort', 'aria-hidden': 'true' }, active ? (state.dir < 0 ? '↓' : '↑') : '')));
        })));
        const tbody = h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => {
          const v = r[c.key];
          if (c.arch) return h('td', { class: 'is-name' }, this.archetypeLink(v, r.color || this.dominantColor(v)));
          const text = c.fmt ? c.fmt(v, r) : (v === null || v === undefined ? '–' : String(v));
          if (c.bar) {
            return h('td', { class: 'is-num' }, h('div', { class: 'mtgs-cellbar' },
              h('span', { class: 'mtgs-cellbar-fill', style: { width: `${Math.round(100 * (v || 0) / maxBar[c.key])}%` } }),
              h('span', { class: 'mtgs-cellbar-text' }, text)));
          }
          return h('td', { class: [c.num ? 'is-num' : '', c.cls || ''].join(' ').trim() || null }, text);
        }))));
        tableHost.replaceChildren(rows.length ? h('table', { class: 'mtgs-table' }, thead, tbody) : h('p', { class: 'mtgs-muted mtgs-pad' }, t('No results.')));
        more.replaceChildren(clipped ? h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-ghost', onClick: () => { state.showAll = true; render(); } }, t('Show all {n} rows', { n: fmt.int(total) })) : '');
      };
      render();
      return h('div', { class: 'mtgs-table-block' }, searchInput, tableHost, more);
    }

    metaTip(m) {
      return {
        title: m.archetype,
        rows: [
          [t('Share'), `${fmt.pct(m.share)} · ${t('{n} players', { n: fmt.int(m.players) })}`],
          [t('Matches'), fmt.record(m)],
          [t('Win rate'), t('{wr} (estimated {est})', { wr: fmt.pct(m.wrObs), est: fmt.pct(m.wr) })],
          [t('95% interval'), `${fmt.pct(m.lo, 0)} – ${fmt.pct(m.hi, 0)}`]
        ],
        hint: t('Click for the archetype profile')
      };
    }

    // --- Metagame -------------------------------------------------------------

    renderMeta(body, after) {
      const { meta, rows, matches } = this.result;
      const known = meta.filter((m) => m.archetype !== 'Unknown');
      const unknown = meta.find((m) => m.archetype === 'Unknown');
      const top = known[0];
      body.append(this.kpis([
        { label: t('Players'), value: fmt.int(rows.length) },
        { label: t('Matches'), value: fmt.int(matches) },
        { label: t('Archetypes'), value: fmt.int(known.length), sub: unknown ? t('{pct} unrecognized', { pct: fmt.pct(unknown.share, 0) }) : null },
        top ? { label: t('Most played'), value: top.archetype, small: true, sub: t('{pct} of the metagame', { pct: fmt.pct(top.share) }) } : null
      ]));

      const share = this.section({
        title: t('Share'),
        lead: t('Share of players per archetype.'),
        info: t('Percentage of players in the selection who brought each archetype. The 15 most played are shown; the rest are in the table below. Hover a bar for details, click it to open the profile.')
      });
      const minN = Math.max(3, Math.round(rows.length * 0.01));
      const sc = known.filter((m) => m.players >= minN);
      const shares = sc.map((m) => m.share).sort((a, b) => a - b);
      const scatter = this.section({
        title: t('Share and win rate'),
        lead: t('Archetypes with at least {n} players.', { n: fmt.int(minN) }),
        info: t('Each dot is an archetype: further right means more played, higher means more wins. Win rates are estimated with Bayesian smoothing, so archetypes with few matches do not end up at the extremes. Dashed lines: 50% win rate and median share.')
      });
      body.append(h('div', { class: 'mtgs-grid2' }, share.node, scatter.node));

      const ci = known.slice(0, 12).sort((a, b) => b.wr - a.wr);
      const interval = this.section({
        title: t('Win rate with uncertainty'),
        lead: t('The 12 most played archetypes, with 95% intervals.'),
        info: t('The dot is the estimated win rate, the line the 95% credible interval: with few matches the line is long and the estimate stays close to 50%. Bayesian smoothing with a Beta({a}, {a}) prior, adjustable in the plugin settings.', { a: this.cfg.alpha })
      });
      body.append(interval.node);

      const csv = () => download('metagame.csv', ['Archetype,Players,Share,W,L,D,WR,WR_estimated,CI_low,CI_high']
        .concat(meta.map((m) => [`"${m.archetype.replace(/"/g, '""')}"`, m.players, m.share.toFixed(4), m.w, m.l, m.d, m.wrObs === null ? '' : m.wrObs.toFixed(4), m.wr.toFixed(4), m.lo.toFixed(4), m.hi.toFixed(4)].join(','))).join('\n'));
      const tableSec = this.section({ title: t('All archetypes'), actions: [h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-ghost', onClick: csv }, icon('download'), 'CSV')] });
      tableSec.body.append(this.table([
        { key: 'archetype', label: t('Archetype'), arch: true },
        { key: 'players', label: t('Players'), num: true, fmt: fmt.int },
        { key: 'share', label: t('Share'), num: true, fmt: (v) => fmt.pct(v), bar: true },
        { key: 'matches', label: t('W-L-D'), num: true, fmt: (v, r) => fmt.record(r) },
        { key: 'wrObs', label: t('Win rate'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'wr', label: t('Estimated'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'lo', label: t('95% interval'), num: true, fmt: (v, r) => `${fmt.pct(r.lo, 0)} – ${fmt.pct(r.hi, 0)}` }
      ], meta.map((m) => ({ ...m, color: this.dominantColor(m.archetype) })), { sortKey: 'players', search: t('Search archetypes…') }));
      body.append(tableSec.node);

      after(() => {
        const items = meta.slice(0, 15).map((m) => ({ label: m.archetype === 'Unknown' ? t('Unrecognized') : m.archetype, value: m.share, text: `${fmt.pct(m.share)} · ${fmt.int(m.players)}`, tip: this.metaTip(m), muted: m.archetype === 'Unknown', key: m.archetype === 'Unknown' ? null : m.archetype }));
        barChart(share.body, this.tip, items, { aria: t('Share by archetype'), valueWidth: 104, onSelect: this.selectArchetype });
        const rest = meta.slice(15);
        if (rest.length) {
          const n = rest.reduce((a, m) => a + m.players, 0);
          share.body.append(h('p', { class: 'mtgs-footnote' }, t('{n} other archetypes: {pct} of players.', { n: fmt.int(rest.length), pct: fmt.pct(n / rows.length) })));
        }
        scatterChart(scatter.body, this.tip, sc.map((m, i) => ({ label: m.archetype, x: m.share, y: m.wr, tip: this.metaTip(m), labelled: i < 12 || m.share >= 0.03 })),
          { medianX: shares.length ? shares[Math.floor(shares.length / 2)] : undefined, aria: t('Share and win rate'), onSelect: this.selectArchetype });
        intervalChart(interval.body, this.tip, ci.map((m) => ({ label: m.archetype, value: m.wr, lo: m.lo, hi: m.hi, text: fmt.pct(m.wr), tip: this.metaTip(m) })), { aria: t('Win rate with uncertainty'), onSelect: this.selectArchetype });
      });
    }

    // --- Matchups -------------------------------------------------------------

    matchupData(archs) {
      return this.memo(`mu|${archs.join('|')}`, () => {
        const mu = Core.matchupStats(this.tournaments, archs, { excludePlayoffs: this.state.excludePlayoffs });
        const post = Adv.matchupPosterior(mu, archs.map((a) => (this.result.byName.get(a) || { wrMean: 0.5 }).wrMean));
        return { mu, post };
      });
    }

    renderMatchups(body, after) {
      const st = this.state;
      const known = this.result.meta.filter((m) => m.archetype !== 'Unknown');
      if (known.length < 2) { body.append(this.emptyState(t('At least two archetypes are needed'), t('Widen the selection to see matchups.'))); return; }
      const archs = known.slice(0, Math.min(st.muN, known.length)).map((m) => m.archetype);
      const { mu, post } = this.matchupData(archs);
      const est = st.muMode === 'est';
      const refresh = (patch) => { Object.assign(st, patch); this.renderTab(); };

      const sec = this.section({
        title: t('Matchup matrix'),
        lead: est ? t('Bayesian estimate, row against column.') : t('Win rate of the row against the column; below, the matches played.'),
        info: t('Each cell is the win rate of the row archetype against the column archetype (draws excluded). In “Estimated” mode, cells with few matches start from what the overall strength of the two decks suggests and move with the results: the most reliable reading for decisions. The dot marks clear-cut matchups, where the favorite is favored with at least 95% probability. Cells with fewer than 5 matches are faded.'),
        actions: [
          this.segmented(t('Values'), [['obs', t('Observed')], ['est', t('Estimated')]], st.muMode, (v) => refresh({ muMode: v })),
          this.select(t('Archetypes'), [6, 8, 10, 12, 15, 20].map((k) => [k, t('Top {n}', { n: k })]), st.muN, (v) => refresh({ muN: parseInt(v, 10) }))
        ],
        wide: true
      });
      const headBtn = (a) => h('button', { type: 'button', class: 'mtgs-matrix-head', title: a, onClick: () => this.openArchetype(a) }, h('span', {}, a));
      const table = h('table', { class: 'mtgs-matrix' },
        h('thead', {}, h('tr', {}, h('th', { class: 'mtgs-matrix-corner', scope: 'col' }, h('span', { class: 'mtgs-sr' }, t('Archetype'))),
          archs.map((a) => h('th', { scope: 'col', class: 'mtgs-matrix-col' }, headBtn(a))))),
        h('tbody', {}, archs.map((a, i) => h('tr', {}, h('th', { scope: 'row', class: 'mtgs-matrix-row' }, headBtn(a)),
          archs.map((b, j) => {
            const cell = mu.matrix[i][j];
            if (i === j) return h('td', { class: 'mtgs-cell is-diag', 'aria-label': t('Mirror') });
            if (!est && cell.w + cell.l + cell.d === 0) return h('td', { class: 'mtgs-cell is-empty', 'aria-label': t('No matches') });
            const pc = post[i][j], dec = cell.w + cell.l;
            const wr = est ? pc.mean : (dec ? cell.w / dec : 0.5);
            const col = divergingColor(wr, this.dark);
            const sig = pc.pFav >= 0.95 || pc.pFav <= 0.05;
            const td = h('td', {
              class: `mtgs-cell${col.strong ? ' is-strong' : ''}${dec < 5 ? ' is-low' : ''}${sig ? ' is-sig' : ''}`, style: { background: col.bg }, tabindex: 0,
              'aria-label': t('{a} vs {b}: {wr}, {n} matches', { a, b, wr: est || dec ? fmt.pct(wr, 0) : t('no data'), n: cell.w + cell.l + cell.d })
            }, h('span', { class: 'mtgs-cell-wr' }, est || dec ? fmt.pct(wr, 0) : '–'), h('span', { class: 'mtgs-cell-n' }, fmt.int(cell.w + cell.l + cell.d)));
            this.tip.bind(td, () => ({
              title: t('{a} vs {b}', { a, b }),
              rows: [
                [t('Matches'), `${fmt.record(cell)}${dec ? ` (${fmt.pct(cell.w / dec)})` : ''}`],
                [t('Games'), `${cell.gw}-${cell.gl}`],
                [t('Estimate'), t('{v} (90%: {lo} – {hi})', { v: fmt.pct(pc.mean), lo: fmt.pct(pc.lo, 0), hi: fmt.pct(pc.hi, 0) })],
                [t('Chance of being favored'), fmt.pct(pc.pFav, 0)]
              ]
            }));
            return td;
          })))));
      sec.body.append(
        h('div', { class: 'mtgs-matrix-scroll' }, table),
        h('div', { class: 'mtgs-legend is-center' },
          h('span', { class: 'mtgs-legend-item' }, h('span', { class: 'mtgs-scale' }), t('unfavorable · 50% · favorable')),
          h('span', { class: 'mtgs-legend-item' }, h('span', { class: 'mtgs-sig-key' }), t('clear-cut matchup'))));
      body.append(sec.node);

      const minMatches = Math.max(10, Math.round(this.result.matches * 0.01));
      const draws = mu.draws.filter((d) => d.matches >= minMatches && d.archetype !== 'Unknown' && d.draws > 0).sort((a, b) => b.rate - a.rate).slice(0, 15);
      const dsec = this.section({
        title: t('Draws'),
        lead: t('Share of matches that ended in a draw.'),
        info: t('Percentage of matches ending in a draw, for archetypes with at least {n} matches: useful to spot slow decks that often go to time.', { n: fmt.int(minMatches) })
      });
      body.append(dsec.node);
      after(() => {
        if (!draws.length) { dsec.body.append(h('p', { class: 'mtgs-muted' }, t('No draws in the selection.'))); return; }
        barChart(dsec.body, this.tip, draws.map((d) => ({ label: d.archetype, value: d.rate, text: `${fmt.pct(d.rate)} · ${d.draws}/${d.matches}`, tip: { title: d.archetype, rows: [[t('Draws'), t('{d} of {n} matches', { d: d.draws, n: d.matches })]] } })), { aria: t('Draws'), onSelect: this.selectArchetype });
      });
    }

    // --- Positioning ----------------------------------------------------------

    renderPositioning(body, after) {
      const st = this.state, rows = this.result.rows, alpha = this.cfg.alpha;
      const known = this.result.meta.filter((m) => m.archetype !== 'Unknown');
      if (known.length < 3 || this.result.matches < 50) {
        body.append(this.emptyState(t('More data needed'), t('Positioning needs at least 50 matches and 3 archetypes.'), st.days !== 'all' ? [t('Show the whole period'), () => { st.days = 'all'; this.applyPeriod(); }] : null));
        return;
      }
      const n = Math.min(st.posN, known.length);
      const top = known.slice(0, n), archs = top.map((m) => m.archetype);
      const { post } = this.matchupData(archs);

      const fields = [{ id: 'all', label: t('Whole selection'), rows }];
      const d2 = rows.filter((r) => r.day2 === true);
      if (d2.length >= 20) fields.push({ id: 'day2', label: 'Day 2', rows: d2 });
      const t8 = rows.filter((r) => r.rank !== null && r.rank <= 8);
      if (t8.length >= 8) fields.push({ id: 'top8', label: 'Top 8', rows: t8 });
      if (this.tournaments.length > 1) {
        let last = 0;
        this.tournaments.forEach((ev, i) => { if (ev.date > this.tournaments[last].date) last = i; });
        fields.push({ id: 'last', label: t('Latest event'), rows: rows.filter((r) => r.t === last) });
      }
      const field = fields.find((f) => f.id === st.posField) || fields[0];
      const refresh = (patch) => { Object.assign(st, patch); this.renderTab(); };

      const exp = this.memo(`exp|${n}|${field.id}`, () => Adv.expectedVsField(archs, post, top.map((m) => ({ p: m.wrMean, a: alpha + m.w, b: alpha + m.l })), Adv.shares(field.rows)));
      const eq = this.memo(`eq|${n}`, () => Adv.metaEquilibrium(post));
      const covered = exp.length ? exp[0].covered : 0;

      const s1 = this.section({
        title: t('Expected win rate'),
        lead: t('What to expect when bringing each deck against the chosen field.'),
        info: t('Combines the estimated matchups with the make-up of the reference field. Dot = estimate, line = 90% interval (1,000 simulations), tick = win rate observed so far. The top {n} archetypes cover {pct} of the field; against the rest, the deck’s overall win rate is used.', { n, pct: fmt.pct(covered, 0) }),
        actions: [
          this.select(t('Reference field'), fields.map((f) => [f.id, f.label]), field.id, (v) => refresh({ posField: v })),
          this.select(t('Archetypes'), [8, 10, 12, 15, 20].map((k) => [k, t('Top {n}', { n: k })]), st.posN, (v) => refresh({ posN: parseInt(v, 10) }))
        ]
      });
      const s2 = this.section({
        title: t('Equilibrium metagame'),
        lead: t('The deck mix the matchup matrix rewards.'),
        info: t('The Nash equilibrium of the “game” defined by the matrix: against this mix no archetype considered goes above 50%. Bar = share in the mix, tick = current share, stability = in how many simulations the deck stays in the mix. Read it as a hint of which decks the matrix favors, not as a forecast.')
      });
      const strong = [];
      archs.forEach((a, i) => archs.forEach((b, j) => {
        const c = post[i][j];
        if (c && c.mean > 0.5 && c.pFav >= 0.9) strong.push({ fav: a, dog: b, mean: c.mean, lo: c.lo, hi: c.hi, n: c.n, rec: `${c.w}-${c.l}`, pFav: c.pFav });
      }));
      const s3 = this.section({ title: t('Clearest matchups'), lead: t('Favorite with at least 90% probability.'), info: t('Pairs where the Bayesian estimate makes the favorite favored with at least 90% probability. 90% interval.') });
      s3.body.append(strong.length ? this.table([
        { key: 'fav', label: t('Favorite'), arch: true },
        { key: 'dog', label: t('Against'), arch: true },
        { key: 'mean', label: t('Estimate'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'lo', label: t('90% interval'), num: true, fmt: (v, r) => `${fmt.pct(r.lo, 0)} – ${fmt.pct(r.hi, 0)}` },
        { key: 'n', label: t('W-L'), num: true, fmt: (v, r) => r.rec },
        { key: 'pFav', label: t('Probability'), num: true, fmt: (v) => fmt.pct(v, 0) }
      ], strong, { sortKey: 'pFav', limit: 12 }) : h('p', { class: 'mtgs-muted' }, t('No matchup is clear-cut enough with the current data.')));
      body.append(s1.node, s2.node, s3.node);

      after(() => {
        const list = exp.map((e, i) => ({ ...e, m: top[i] })).sort((a, b) => b.expected - a.expected);
        intervalChart(s1.body, this.tip, list.map((e) => ({
          label: e.archetype, value: e.expected, lo: e.lo, hi: e.hi, mark: e.m.wrMean, text: fmt.pct(e.expected),
          tip: { title: e.archetype, rows: [[t('Expected'), fmt.pct(e.expected)], [t('90% interval'), `${fmt.pct(e.lo)} – ${fmt.pct(e.hi)}`], [t('Observed'), `${fmt.pct(e.m.wrObs)} (${fmt.record(e.m)})`], [t('Share of the field'), fmt.pct(e.share)]], hint: t('Click for the profile') }
        })), { aria: t('Expected win rate'), step: 0.05, min: 0.4, max: 0.6, onSelect: this.selectArchetype });
        const eqList = archs.map((a, i) => ({ archetype: a, current: this.result.byName.get(a).share, ...eq[i] })).sort((a, b) => b.share - a.share || b.current - a.current);
        barChart(s2.body, this.tip, eqList.map((e) => ({
          label: e.archetype, value: e.share, mark: e.current, muted: e.share === 0, text: t('{eq} · now {now}', { eq: fmt.pct(e.share, 0), now: fmt.pct(e.current, 0) }),
          tip: { title: e.archetype, rows: [[t('In the mix'), fmt.pct(e.share)], [t('Current share'), fmt.pct(e.current)], [t('Win rate against the mix'), fmt.pct(e.wrVsEq)], [t('Stability'), fmt.pct(e.stability, 0)]] }
        })), { aria: t('Equilibrium metagame'), valueWidth: 116, onSelect: this.selectArchetype });
      });
    }

    // --- Trends ---------------------------------------------------------------

    renderTrend(body, after) {
      const st = this.state, rows = this.result.rows, ts = this.tournaments;
      const dates = ts.map((ev) => ev.date).sort();
      const span = (toDate(dates[dates.length - 1]) - toDate(dates[0])) / 86400000;
      const bucket = st.trendBucket === 'auto' ? (ts.length <= 8 ? 'tournament' : span > 75 ? 'month' : 'week') : st.trendBucket;
      const metric = st.trendMetric;
      const refresh = (patch) => { Object.assign(st, patch); this.renderTab(); };
      const tr = this.memo(`trend|${bucket}`, () => Adv.trendStats(ts, rows, { bucket, alpha: this.cfg.alpha }));
      const B = tr.buckets;

      const controls = [
        this.segmented(t('Metric'), [['share', t('Share')], ['wr', t('Win rate')]], metric, (v) => refresh({ trendMetric: v })),
        this.select(t('Group by'), [['auto', t('Automatic')], ['tournament', t('By event')], ['week', t('By week')], ['month', t('By month')]], st.trendBucket, (v) => refresh({ trendBucket: v }))
      ];
      if (B.length < 2) {
        const sec = this.section({ title: t('Over time'), actions: controls });
        sec.body.append(this.emptyState(t('More than one period is needed'), t('Select more events or a longer period, or group by event.'),
          st.days !== 'all' ? [t('Show the whole period'), () => { st.days = 'all'; this.applyPeriod(); }] : null));
        body.append(sec.node);
        return;
      }
      const labels = B.map((b) => (bucket === 'tournament' ? fmt.date(b.start) : bucket === 'week' ? t('week of {date}', { date: fmt.date(b.start) }) : b.label));
      const first = B[0], last = B[B.length - 1];
      const dEff = last.effective - first.effective;
      body.append(this.kpis([
        { label: t('Effective archetypes'), value: fmt.num(last.effective), sub: t('{delta} since the start', { delta: `${dEff >= 0 ? '+' : '−'}${fmt.num(Math.abs(dEff))}` }) },
        { label: t('Top-3 share'), value: fmt.pct(last.top3, 0), sub: t('at the start: {v}', { v: fmt.pct(first.top3, 0) }) },
        { label: t('Periods'), value: fmt.int(B.length), sub: fmt.range(B[0].start, dates[dates.length - 1]) }
      ]));

      const top = this.result.meta.filter((m) => m.archetype !== 'Unknown').slice(0, 12);
      const s1 = this.section({
        title: metric === 'share' ? t('Share over time') : t('Win rate over time'),
        lead: t('Same scale for every panel.'),
        info: metric === 'share'
          ? t('Share of players of each archetype per period. The change compares the last period with the first. Hover a chart for the values, click a name for the profile.')
          : t('Estimated win rate per period (blank with fewer than 5 players). Dashed line: 50%.'),
        actions: controls,
        wide: true
      });
      const s2 = this.section({
        title: t('Metagame diversity'),
        lead: t('“Effective” number of archetypes per period.'),
        info: t('The exponential of the Shannon entropy of the shares: how many equally popular archetypes would give the same variety. Higher means a more varied metagame.')
      });
      const minPlayers = Math.max(5, Math.round(rows.length * 0.01));
      const s3 = this.section({
        title: t('Risers and fallers'),
        lead: t('First half of the periods against the second half.'),
        info: t('Compares the first {a} periods with the last {b}, for archetypes with at least {n} players. Changes in percentage points.', { a: tr.halves[0], b: tr.halves[1], n: fmt.int(minPlayers) })
      });
      s3.body.append(this.table([
        { key: 'archetype', label: t('Archetype'), arch: true },
        { key: 'b', label: t('Before'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'a', label: t('After'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'dShare', label: t('Δ share'), num: true, fmt: (v) => fmt.pp(v) },
        { key: 'dWr', label: t('Δ win rate'), num: true, fmt: (v) => fmt.pp(v) }
      ], tr.movers.filter((m) => m.players >= minPlayers).map((m) => ({ archetype: m.archetype, b: m.before.share, a: m.after.share, dShare: m.dShare, dWr: m.dWr })), { sortKey: 'dShare', limit: 15 }));
      body.append(s1.node, h('div', { class: 'mtgs-grid2' }, s2.node, s3.node));

      after(() => {
        const panels = top.map((m) => {
          const ser = tr.series(m.archetype);
          const vals = ser.map((x) => (metric === 'share' ? x.share : (x.n >= 5 ? x.wr : null)));
          const nn = vals.filter((v) => v !== null);
          const delta = nn.length > 1 ? nn[nn.length - 1] - nn[0] : null;
          return {
            title: m.archetype, values: vals, valueText: nn.length ? fmt.pct(nn[nn.length - 1]) : '–',
            sub: delta === null ? '' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : '='} ${fmt.pp(delta)}`,
            trend: delta > 0.002 ? 'is-up' : delta < -0.002 ? 'is-down' : '',
            tips: ser.map((x, i) => ({ title: `${m.archetype} · ${labels[i]}`, rows: [[t('Share'), `${fmt.pct(x.share)} (${x.n}/${x.total})`], [t('Win rate'), x.w + x.l ? `${fmt.pct(x.w / (x.w + x.l))} (${x.w}-${x.l})` : '–']] }))
          };
        });
        const all = panels.flatMap((p) => p.values.filter((v) => v !== null));
        smallMultiples(s1.body, this.tip, panels, labels, metric === 'share'
          ? { yMin: 0, area: true, scaleText: t('scale 0–{max}', { max: fmt.pct(Math.max(...all), 0) }), onSelect: this.selectArchetype }
          : { ref: 0.5, yMin: Math.min(0.4, ...all), yMax: Math.max(0.6, ...all), scaleText: t('shared scale'), onSelect: this.selectArchetype });
        smallMultiples(s2.body, this.tip, [{
          title: t('Effective archetypes'), values: B.map((b) => b.effective), valueText: fmt.num(last.effective),
          tips: B.map((b, i) => ({ title: labels[i], rows: [[t('Players'), fmt.int(b.players)], [t('Events'), fmt.int(b.events)], [t('Effective archetypes'), fmt.num(b.effective)], [t('Top-3 share'), fmt.pct(b.top3, 0)]] }))
        }], labels, { cols: 1, height: 120, yMin: 0 });
      });
    }

    // --- Conversion -----------------------------------------------------------

    renderConversion(body, after) {
      const st = this.state, rows = this.result.rows;
      const hasDay2 = rows.some((r) => r.day2 !== null), hasRank = rows.some((r) => r.rank !== null);
      const options = [];
      if (hasDay2) options.push(['day2', 'Day 2']);
      if (hasRank) options.push(['top8', 'Top 8'], ['top16', 'Top 16'], ['top32', 'Top 32']);
      options.push(['positive', t('Winning record')]);
      let mode = st.convMode === 'auto' ? options[0][0] : st.convMode;
      if (!options.some((o) => o[0] === mode)) mode = options[0][0];
      const label = options.find((o) => o[0] === mode)[1];
      const conv = Core.conversionStats(rows, mode);
      const minStart = Math.max(3, Math.round(conv.eligible * 0.01));
      const data = conv.rows.filter((r) => r.start >= minStart && r.archetype !== 'Unknown').sort((a, b) => b.rate - a.rate).slice(0, 20);

      const s1 = this.section({
        title: t('Conversion: {target}', { target: label }),
        lead: t('Overall average {avg} · archetypes with at least {n} players.', { avg: fmt.pct(conv.overall), n: fmt.int(minStart) }),
        info: mode === 'day2'
          ? t('Share of each archetype’s players who reached Day 2. The Day 2 cut is detected automatically from the drop in players between rounds. The vertical line is the overall average.')
          : mode === 'positive' ? t('Share of players who finished with more wins than losses.') : t('Share of players who reached the {target} of the Swiss standings. The vertical line is the overall average.', { target: label }),
        actions: [this.select(t('Target'), options, mode, (v) => { st.convMode = v; this.renderTab(); })]
      });
      body.append(s1.node);

      const shift = Adv.metaShift(rows);
      const stageLabel = (x) => (x.id === 'all' ? t('All') : x.label);
      let s2 = null;
      if (shift.stages.length > 1) {
        s2 = this.section({
          title: t('The metagame through the event'),
          lead: shift.stages.map((x) => `${stageLabel(x)} ${fmt.int(x.total)}`).join(' · '),
          info: t('Share of each archetype among all players, among those who reached Day 2 and in the Top 8. A deck that “rises” converts better than average. With few events the Top 8 holds few players: treat it as a hint.')
        });
        body.append(s2.node);
      }
      const s3 = this.section({ title: t('Details') });
      s3.body.append(this.table([
        { key: 'archetype', label: t('Archetype'), arch: true },
        { key: 'start', label: t('Players'), num: true, fmt: fmt.int },
        { key: 'conv', label, num: true, fmt: fmt.int },
        { key: 'rate', label: t('Conversion'), num: true, fmt: (v) => fmt.pct(v), bar: true },
        { key: 'delta', label: t('Vs. expected'), num: true, fmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt.num(Math.abs(v))}` }
      ], conv.rows.filter((r) => r.archetype !== 'Unknown'), { sortKey: 'start', search: t('Search archetypes…') }));
      body.append(s3.node);

      after(() => {
        if (!data.length) s1.body.append(h('p', { class: 'mtgs-muted' }, t('Not enough data.')));
        else {
          barChart(s1.body, this.tip, data.map((r) => ({
            label: r.archetype, value: r.rate, lo: r.lo, hi: r.hi, text: `${fmt.pct(r.rate, 0)} · ${r.conv}/${r.start}`,
            tip: { title: r.archetype, rows: [[t('Converted'), t('{c} of {n} ({pct})', { c: r.conv, n: r.start, pct: fmt.pct(r.rate) })], [t('Expected at the average'), fmt.num(conv.overall * r.start)], [t('95% interval'), `${fmt.pct(r.lo, 0)} – ${fmt.pct(r.hi, 0)}`]] }
          })), {
            max: Math.min(1, Math.ceil(Math.max(...data.map((r) => r.hi), conv.overall) * 10 + 1e-4) / 10),
            ref: conv.overall, refLabel: t('average {v}', { v: fmt.pct(conv.overall, 0) }), axis: true, axisFmt: (v) => fmt.pct(v, 0),
            aria: t('Conversion by archetype'), valueWidth: 104, onSelect: this.selectArchetype
          });
        }
        if (s2) {
          dotPlot(s2.body, this.tip, shift.rows.slice(0, 12).map((r) => ({
            label: r.archetype, values: r.values, text: r.values.map((v) => fmt.pct(v, 0)).join(' → '),
            tip: { title: r.archetype, rows: shift.stages.map((x, k) => [stageLabel(x), `${fmt.pct(r.values[k])} (${r.counts[k]})`]) }
          })), shift.stages.map(stageLabel), { aria: t('The metagame through the event'), onSelect: this.selectArchetype });
        }
      });
    }

    // --- Cards ----------------------------------------------------------------

    renderCards(body, after) {
      const st = this.state;
      const withLists = this.result.meta.filter((m) => m.archetype !== 'Unknown')
        .map((m) => ({ a: m.archetype, n: this.result.rows.filter((r) => r.archetype === m.archetype && r.hasList).length }))
        .filter((x) => x.n > 0);
      if (!withLists.length) { body.append(this.emptyState(t('No decklists'), t('The selected events have no published decklists.'))); return; }
      if (!withLists.some((x) => x.a === st.cardArch)) st.cardArch = withLists[0].a;
      const arch = st.cardArch;
      const ts = this.tournaments, rows = this.result.rows, alpha = this.cfg.alpha;
      const cs = this.memo(`cards|${arch}`, () => Core.cardStats(ts, rows, arch, { alpha, beta: alpha }));

      body.append(h('div', { class: 'mtgs-toolbar' },
        this.select(t('Archetype'), withLists.map((x) => [x.a, t('{a} · {n} lists', { a: x.a, n: x.n })]), arch, (v) => { st.cardArch = v; this.renderTab(); }),
        h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-ghost', onClick: () => this.openArchetype(arch) }, t('Archetype profile'), icon('arrow', 14))));

      const cons = Adv.consensusDeck(ts, rows, arch);
      if (cons) body.append(this.consensusSection(cons));

      const variants = this.memo(`var|${arch}`, () => Adv.variantClusters(ts, rows, arch, { alpha }));
      const vs = this.section({
        title: t('Variants'),
        lead: !variants ? t('At least 12 lists are needed.') : variants.k > 1 ? t('{n} groups of similar lists.', { n: variants.k }) : t('No clear variants: the lists are alike.'),
        info: t('Lists are grouped by similarity (weighted Jaccard distance on card counts, sideboard at half weight, k-medoids). For each variant: the cards whose average count differs most from the other lists, and the estimated win rate with a 90% interval.')
      });
      if (variants && variants.k > 1) vs.body.append(this.variantCards(variants));
      body.append(vs.node);

      const cols = [
        { key: 'card', label: t('Card'), cls: 'is-name' },
        { key: 'inclusion', label: t('In decks'), num: true, fmt: (v) => fmt.pct(v, 0), bar: true },
        { key: 'avgWhenPlayed', label: t('Copies when played'), num: true, fmt: (v) => fmt.num(v, 2) },
        { key: 'avgOverall', label: t('Average copies'), num: true, fmt: (v) => fmt.num(v, 2) },
        { key: 'dist', label: t('Distribution'), cls: 'is-dist' }
      ];
      const withDist = (list) => list.map((c) => ({ ...c, dist: Object.keys(c.byQty).sort((a, b) => b - a).map((q) => `${q}× ${c.byQty[q].decks}`).join(' · ') }));
      const main = this.section({ title: t('Main deck'), lead: t('{n} lists.', { n: fmt.int(cs.decks) }), info: t('Average copies over every list of the archetype; “Copies when played” only counts the lists that include the card. Distribution: number of lists per number of copies.') });
      main.body.append(this.table(cols, withDist(cs.main), { sortKey: 'avgOverall', search: t('Search cards…') }));
      const side = this.section({ title: t('Sideboard') });
      side.body.append(this.table(cols, withDist(cs.side), { sortKey: 'avgOverall', search: t('Search cards…') }));
      body.append(main.node, side.node);

      const imp = this.memo(`imp|${arch}`, () => Adv.cardImpact(ts, rows, arch, { alpha }));
      const is = this.section({
        title: t('Card impact'),
        lead: t('Win rate with the card minus win rate without it.'),
        info: t('Difference in win rate between the lists that play the card and those that do not, in percentage points, with a 95% interval. Solid dot = credible difference. This is a correlation, not a causal effect: a card often just marks a variant, and with many cards some differences look credible by chance.')
      });
      body.append(is.node);

      const flex = [...cs.main.map((c) => ({ ...c, sec: 'Main' })), ...cs.side.map((c) => ({ ...c, sec: 'Side' }))]
        .filter((c) => c.variable && c.decks >= 3)
        .sort((a, b) => Math.min(b.decks, cs.decks - b.decks + 1) - Math.min(a.decks, cs.decks - a.decks + 1)).slice(0, 20);
      const fs = this.section({ title: t('Win rate by number of copies'), lead: t('Cards played in different quantities.'), info: t('Estimated win rate of the lists by number of copies played (0 = lists without the card). Only combinations with at least 3 lists; next to the value, the number of lists.') });
      if (!flex.length || cs.decks < 6) fs.body.append(h('p', { class: 'mtgs-muted' }, t('More lists are needed for this analysis.')));
      else fs.body.append(this.copiesTable(flex, arch));
      body.append(fs.node);

      after(() => {
        if (!imp.length) { is.body.append(h('p', { class: 'mtgs-muted' }, t('At least 5 lists with and 5 without the card are needed.'))); return; }
        intervalChart(is.body, this.tip, imp.slice(0, 20).sort((a, b) => b.diff - a.diff).map((x) => ({
          label: x.card + (x.section === 'Side' ? ' (SB)' : ''), value: x.diff, lo: x.lo, hi: x.hi, muted: !x.credible, text: fmt.pp(x.diff),
          tip: { title: `${x.card} (${x.section})`, rows: [[t('With the card'), t('{wr} · {n} lists', { wr: fmt.pct(x.wrWith), n: x.decks })], [t('Without'), t('{wr} · {n} lists', { wr: fmt.pct(x.wrWithout), n: x.without })], [t('Difference'), `${fmt.pp(x.diff)} (95%: ${fmt.pp(x.lo)} / ${fmt.pp(x.hi)})`], [t('Chance it helps'), fmt.pct(x.pBetter, 0)]] }
        })), { center: 0, step: 0.05, fmt: (v) => fmt.pp(v, 0), aria: t('Card impact'), valueWidth: 78 });
      });
    }

    consensusSection(cons, compact = false) {
      const sum = (list) => list.reduce((a, c) => a + c.qty, 0);
      const text = cons.main.map((c) => `${c.qty} ${c.card}`).join('\n') + (cons.side.length ? `\n\nSideboard\n${cons.side.map((c) => `${c.qty} ${c.card}`).join('\n')}` : '');
      const copy = h('button', {
        type: 'button', class: 'mtgs-btn mtgs-btn-ghost',
        onClick: async () => { try { await copyText(text); this.showToast(t('List copied: paste it into MTGO or Arena')); } catch (e) { this.showToast(t('Copy failed')); } }
      }, icon('copy'), t('Copy list'));
      const column = (title, list) => h('div', { class: 'mtgs-decklist' },
        h('h4', { class: 'mtgs-decklist-title' }, `${title} · ${sum(list)}`),
        list.map((c) => h('div', { class: 'mtgs-deckline' },
          h('span', { class: 'mtgs-deckqty' }, c.qty), h('span', { class: 'mtgs-deckname' }, c.card), h('span', { class: 'mtgs-decksupport', title: t('Lists with at least this many copies') }, fmt.pct(c.support, 0)))));
      const cols = h('div', { class: 'mtgs-deckcols' }, column(t('Main deck'), cons.main), column(t('Sideboard'), cons.side));
      if (compact) return h('div', {}, cols, h('div', { class: 'mtgs-row-actions' }, copy));
      const sec = this.section({
        title: t('Average list'),
        lead: t('The most common choices across {n} lists.', { n: fmt.int(cons.decks) }),
        info: t('Built by taking, copy by copy, the most common choices up to the typical main deck and sideboard size. The percentage is the share of lists playing at least that many copies.'),
        actions: [copy]
      });
      sec.body.append(cols);
      return sec.node;
    }

    variantCards(variants) {
      return h('div', { class: 'mtgs-variants' }, variants.clusters.map((c, i) => h('article', { class: 'mtgs-variant' },
        h('div', { class: 'mtgs-variant-head' }, h('strong', {}, t('Variant {x}', { x: 'ABCD'.charAt(i) })), h('span', { class: 'mtgs-muted' }, `${t('{n} lists', { n: fmt.int(c.size) })} · ${fmt.pct(c.share, 0)}`)),
        h('div', { class: 'mtgs-variant-wr' }, fmt.pct(c.wr), h('span', { class: 'mtgs-muted' }, ` ${fmt.pct(c.lo, 0)} – ${fmt.pct(c.hi, 0)}`)),
        h('ul', { class: 'mtgs-variant-cards' }, c.signature.slice(0, 6).map((sg) => h('li', {},
          h('span', { class: `mtgs-delta ${sg.diff > 0 ? 'is-up' : 'is-down'}` }, `${sg.diff > 0 ? '+' : '−'}${fmt.num(Math.abs(sg.diff))}`),
          sg.card + (sg.section === 'side' ? ' (SB)' : '')))))));
    }

    copiesTable(flex, arch) {
      const rowsFor = this.result.rows.filter((r) => r.hasList && r.archetype === arch);
      let zw = 0, zl = 0;
      for (const r of rowsFor) { zw += r.w; zl += r.l; }
      const qcols = ['0', '1', '2', '3', '4'];
      return h('div', { class: 'mtgs-table-scroll' }, h('table', { class: 'mtgs-table mtgs-copies' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('Card')), h('th', { scope: 'col' }, ''), qcols.map((q) => h('th', { class: 'is-num', scope: 'col' }, `${q}×`)))),
        h('tbody', {}, flex.map((c) => {
          let w = 0, l = 0, n = 0;
          for (const q of Object.keys(c.byQty)) { w += c.byQty[q].w; l += c.byQty[q].l; n += c.byQty[q].decks; }
          const zero = { decks: rowsFor.length - n, w: zw - w, l: zl - l };
          return h('tr', {}, h('td', { class: 'is-name' }, c.card), h('td', { class: 'mtgs-muted' }, c.sec), qcols.map((q) => {
            const b = q === '0' ? zero : c.byQty[q];
            if (!b || b.decks < 3) return h('td', { class: 'is-num mtgs-muted' }, '·');
            const wr = Core.qbeta(0.5, this.cfg.alpha + b.w, this.cfg.alpha + b.l);
            const col = divergingColor(wr, this.dark);
            return h('td', { class: `is-num mtgs-copy-cell${col.strong ? ' is-strong' : ''}`, style: { background: col.bg }, title: t('{w}-{l} in {n} lists', { w: b.w, l: b.l, n: b.decks }) }, fmt.pct(wr, 0), h('small', {}, ` ${b.decks}`));
          }));
        }))));
    }

    // --- Players --------------------------------------------------------------

    renderPlayers(body, after) {
      const st = this.state, rows = this.result.rows, ts = this.tournaments;
      const ps = this.memo('players', () => Adv.playerStats(ts, rows, { alpha: this.cfg.alpha }));
      const rm = this.memo(`rating|${st.excludePlayoffs}`, () => Adv.ratingModel(ts, { excludePlayoffs: st.excludePlayoffs }));
      body.append(this.kpis([
        { label: t('Unique players'), value: fmt.int(ps.unique) },
        { label: t('In more than one event'), value: fmt.int(ps.repeat), sub: ps.unique ? t('{pct} of all players', { pct: fmt.pct(ps.repeat / ps.unique, 0) }) : null },
        { label: t('Switched decks'), value: fmt.int(ps.switched), sub: ps.repeat ? t('{pct} of returning players', { pct: fmt.pct(ps.switched / ps.repeat, 0) }) : null },
        { label: t('Matches in the model'), value: fmt.int(rm.matches), sub: t('draws excluded') }
      ]));

      const lead = this.section({
        title: t('Player leaderboard'),
        lead: t('Across every event in the selection.'),
        info: t('“Estimated strength” is the probability of beating an average player with the same deck, from a model that separates pilot skill from deck strength and accounts for the opponents faced. Players are matched by name: namesakes, or names spelled differently, can get mixed up.'),
        actions: [this.select(t('Minimum matches'), [3, 5, 10, 15, 20, 30].map((k) => [k, t('At least {n} matches', { n: k })]), st.playerMin, (v) => { st.playerMin = parseInt(v, 10); this.renderTab(); })]
      });
      const data = ps.players.filter((p) => p.matches >= st.playerMin).map((p) => {
        const r = rm.byPlayer.get(p.key);
        return { ...p, skill: r ? r.skill : null, archetype: p.mainArchetype };
      });
      lead.body.append(data.length ? this.table([
        { key: 'name', label: t('Player'), cls: 'is-name' },
        { key: 'events', label: t('Events'), num: true },
        { key: 'matches', label: t('W-L-D'), num: true, fmt: (v, r) => fmt.record(r) },
        { key: 'wrObs', label: t('Win rate'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'skill', label: t('Estimated strength'), num: true, fmt: (v) => fmt.pct(v), bar: true },
        { key: 'bestRank', label: t('Best finish'), num: true, fmt: fmt.ordinal },
        { key: 'archetype', label: t('Main archetype'), arch: true }
      ], data, { sortKey: 'skill', search: t('Search players…') }) : this.emptyState(t('No players'), t('Lower the minimum number of matches.')));
      body.append(lead.node);

      const top = new Set(this.result.meta.filter((m) => m.archetype !== 'Unknown').slice(0, 15).map((m) => m.archetype));
      const decks = rm.decks.filter((d) => top.has(d.archetype) && d.games >= 10);
      const pilot = this.section({
        title: t('Deck or pilot?'),
        lead: t('Win rate adjusted for pilot skill.'),
        info: t('Each archetype’s win rate with the effect of its pilots and of the opponents they faced removed (Bradley-Terry player + deck model). Dot = adjusted win rate with a 95% interval, tick = raw win rate. When the raw rate sits right of the adjusted one, the deck was played by stronger-than-average pilots.')
      });
      const detail = this.section({ title: t('Details by archetype') });
      detail.body.append(this.table([
        { key: 'archetype', label: t('Archetype'), arch: true },
        { key: 'games', label: t('Matches'), num: true, fmt: fmt.int },
        { key: 'rawWr', label: t('Raw'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'adjWr', label: t('Adjusted'), num: true, fmt: (v) => fmt.pct(v) },
        { key: 'diff', label: t('Pilot effect'), num: true, fmt: (v) => fmt.pp(v) },
        { key: 'pilotWr', label: t('Average pilot skill'), num: true, fmt: (v) => fmt.pct(v) }
      ], decks.map((d) => ({ ...d, diff: d.rawWr - d.adjWr })), { sortKey: 'games' }));
      body.append(h('div', { class: 'mtgs-grid2' }, pilot.node, detail.node));
      after(() => {
        if (!decks.length) { pilot.body.append(h('p', { class: 'mtgs-muted' }, t('Not enough data.'))); return; }
        intervalChart(pilot.body, this.tip, [...decks].sort((a, b) => b.adjWr - a.adjWr).map((d) => ({
          label: d.archetype, value: d.adjWr, lo: d.lo, hi: d.hi, mark: d.rawWr, text: fmt.pct(d.adjWr),
          tip: { title: d.archetype, rows: [[t('Adjusted'), `${fmt.pct(d.adjWr)} (${fmt.pct(d.lo, 0)} – ${fmt.pct(d.hi, 0)})`], [t('Raw'), t('{wr} over {n} matches', { wr: fmt.pct(d.rawWr), n: fmt.int(d.games) })], [t('Pilot skill'), fmt.pct(d.pilotWr)]] }
        })), { aria: t('Win rate adjusted for pilot skill.'), step: 0.05, min: 0.4, max: 0.6, onSelect: this.selectArchetype });
      });
    }

    // --- Data -----------------------------------------------------------------

    renderData(body) {
      const sec = this.section({ title: t('Export'), lead: t('CSV files with standings, round-by-round matches and decklists.') });
      const events = [...this.tournaments].sort((a, b) => b.date.localeCompare(a.date));
      sec.body.append(h('div', { class: 'mtgs-table-scroll' }, h('table', { class: 'mtgs-table' },
        h('thead', {}, h('tr', {}, [t('Date'), t('Event'), t('Players'), t('Rounds'), ''].map((x, i) => h('th', { class: i === 2 || i === 3 ? 'is-num' : '', scope: 'col' }, x)))),
        h('tbody', {}, events.map((ev) => {
          const slug = Core.slugify(ev.name).slice(0, 50) || ev.id;
          const btn = (label, name, make) => h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-ghost mtgs-btn-sm', onClick: () => download(`${slug}-${name}.csv`, make(ev)) }, icon('download', 14), label);
          return h('tr', {},
            h('td', { class: 'mtgs-nowrap' }, fmt.date(ev.date)),
            h('td', { class: 'is-name' }, /^https?:\/\//.test(ev.uri || '') ? h('a', { href: ev.uri, target: '_blank', rel: 'noopener' }, ev.name, ' ', icon('external', 12)) : ev.name),
            h('td', { class: 'is-num' }, fmt.int(ev.players.length)),
            h('td', { class: 'is-num' }, fmt.int(ev.rounds.length)),
            h('td', { class: 'mtgs-row-actions' }, btn(t('Standings'), 'standings', Core.standingsCsv), btn(t('Matches'), 'matches', Core.matchesCsv), btn(t('Decklists'), 'decklists', Core.decklistsCsv)));
        })))));
      body.append(sec.node);

      const players = this.section({ title: t('Player results') });
      players.body.append(this.table([
        { key: 'player', label: t('Player'), cls: 'is-name' },
        { key: 'archetype', label: t('Archetype'), arch: true },
        { key: 'rank', label: t('Rank'), num: true, fmt: fmt.ordinal },
        { key: 'w', label: t('W-L-D'), num: true, fmt: (v, r) => fmt.record(r) },
        { key: 'wr', label: t('Win rate'), num: true, fmt: (v) => fmt.pct(v, 0) },
        { key: 'tname', label: t('Event') }
      ], this.result.rows.map((r) => ({ ...r, tname: this.tournaments[r.t].name, wr: r.w + r.l ? r.w / (r.w + r.l) : null })), { sortKey: 'w', search: t('Search players or archetypes…') }));
      body.append(players.node);
    }

    // --- Archetype profile (side panel) ---------------------------------------

    openArchetype(name) {
      const m = this.result && this.result.byName.get(name);
      if (!m || name === 'Unknown') return;
      this.tip.hide();
      this.pop.close();
      if (!this.drawer) this.buildDrawer();
      this.state.arch = name;
      this.syncUrl();
      if (!this.drawer.hidden && this.drawerName === name) return;
      this.drawerName = name;
      if (this.drawer.hidden) this.returnFocus = document.activeElement;
      this.drawerContent.replaceChildren(...this.archetypeProfile(m));
      this.drawerContent.scrollTop = 0;
      this.drawer.hidden = false;
      document.documentElement.classList.add('mtgs-lock');
      requestAnimationFrame(() => this.drawer.classList.add('is-open'));
      this.drawerPanel.focus({ preventScroll: true });
    }

    closeDrawer() {
      if (!this.drawer || this.drawer.hidden) return;
      this.state.arch = '';
      this.drawerName = '';
      this.syncUrl();
      this.drawer.classList.remove('is-open');
      document.documentElement.classList.remove('mtgs-lock');
      setTimeout(() => { if (!this.drawer.classList.contains('is-open')) this.drawer.hidden = true; }, 200);
      if (this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true });
    }

    buildDrawer() {
      this.drawerClose = h('button', { type: 'button', class: 'mtgs-icon-btn', 'aria-label': t('Close'), onClick: () => this.closeDrawer() }, icon('close', 18));
      this.drawerTitle = h('h3', { class: 'mtgs-drawer-title', id: `mtgs-${this.index}-drawer-title` });
      this.drawerContent = h('div', { class: 'mtgs-drawer-body' });
      const panel = h('aside', { class: 'mtgs-drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': this.drawerTitle.id, tabindex: '-1' }, this.drawerContent);
      this.drawerPanel = panel;
      this.drawer = h('div', { class: 'mtgs-drawer', hidden: true }, h('div', { class: 'mtgs-drawer-backdrop', onClick: () => this.closeDrawer() }), panel);
      this.drawer.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); this.closeDrawer(); }
        if (e.key !== 'Tab') return;
        const focusable = [...panel.querySelectorAll('button, a[href], input, select, summary, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      this.root.append(this.drawer);
    }

    archetypeProfile(m) {
      const name = m.archetype, rows = this.result.rows, ts = this.tournaments;
      const mine = rows.filter((r) => r.archetype === name);
      this.drawerTitle.textContent = name;

      const header = h('div', { class: 'mtgs-drawer-head' },
        h('div', {}, h('div', { class: 'mtgs-drawer-kicker' }, pips(this.dominantColor(name)), this.state.format || ''), this.drawerTitle),
        this.drawerClose);

      const hasDay2 = rows.some((r) => r.day2 !== null), hasRank = rows.some((r) => r.rank !== null);
      const convMode = hasDay2 ? 'day2' : hasRank ? 'top8' : null;
      const conv = convMode ? Core.conversionStats(rows, convMode) : null;
      const convRow = conv && conv.rows.find((r) => r.archetype === name);
      const blocks = [header, this.kpis([
        { label: t('Share'), value: fmt.pct(m.share), sub: t('{n} players', { n: fmt.int(m.players) }) },
        { label: t('Win rate'), value: fmt.pct(m.wr), sub: `${fmt.pct(m.lo, 0)} – ${fmt.pct(m.hi, 0)}` },
        convRow ? { label: convMode === 'day2' ? t('Reached Day 2') : t('Made Top 8'), value: fmt.pct(convRow.rate, 0), sub: t('average {v}', { v: fmt.pct(conv.overall, 0) }) } : null
      ]), h('p', { class: 'mtgs-footnote mtgs-drawer-record' }, t('Matches: {rec} (wins-losses-draws)', { rec: fmt.record(m) }))];

      if (ts.length > 1) {
        const tr = this.memo('trend|tournament', () => Adv.trendStats(ts, rows, { bucket: 'tournament', alpha: this.cfg.alpha }));
        if (tr.buckets.length > 1) {
          blocks.push(h('section', { class: 'mtgs-drawer-section' }, h('h4', {}, t('Share event by event')),
            sparkline(tr.series(name).map((x) => x.share), { width: 360, height: 56 }),
            h('p', { class: 'mtgs-footnote' }, `${fmt.date(tr.buckets[0].start)} → ${fmt.date(tr.buckets[tr.buckets.length - 1].start)}`)));
        }
      }

      const opponents = this.result.meta.filter((x) => x.archetype !== 'Unknown' && x.archetype !== name).slice(0, 12).map((x) => x.archetype);
      if (opponents.length) {
        const { mu, post } = this.matchupData([name, ...opponents]);
        const list = opponents.map((o, j) => ({ o, c: mu.matrix[0][j + 1], p: post[0][j + 1] })).filter((x) => x.c.w + x.c.l > 0).sort((a, b) => b.p.mean - a.p.mean);
        if (list.length) {
          blocks.push(h('section', { class: 'mtgs-drawer-section' },
            h('h4', {}, `${t('Matchups')} `, h('span', { class: 'mtgs-muted' }, `· ${t('Bayesian estimate')}`)),
            h('ul', { class: 'mtgs-mu-list' }, list.map(({ o, c, p }) => h('li', {},
              h('button', { type: 'button', class: 'mtgs-arch', onClick: () => this.openArchetype(o) }, pips(this.dominantColor(o)), h('span', {}, o)),
              h('span', { class: 'mtgs-mu-bar', 'aria-hidden': 'true' }, h('span', { class: `mtgs-mu-fill ${p.mean >= 0.5 ? 'is-pos' : 'is-neg'}`, style: { width: `${Math.min(50, Math.abs(p.mean - 0.5) * 100 / 0.3 * 0.5)}%` } })),
              h('span', { class: 'mtgs-mu-val' }, fmt.pct(p.mean, 0)),
              h('span', { class: 'mtgs-mu-n' }, fmt.record(c)))))));
        }
      }

      const variants = this.memo(`var|${name}`, () => Adv.variantClusters(ts, rows, name, { alpha: this.cfg.alpha }));
      if (variants && variants.k > 1) blocks.push(h('section', { class: 'mtgs-drawer-section' }, h('h4', {}, t('Variants')), this.variantCards(variants)));

      const cons = Adv.consensusDeck(ts, rows, name);
      if (cons) {
        blocks.push(h('section', { class: 'mtgs-drawer-section' }, h('details', { class: 'mtgs-details' },
          h('summary', {}, t('Average list · {n} lists', { n: fmt.int(cons.decks) })), this.consensusSection(cons, true))));
      }

      const best = [...mine].sort((a, b) => (b.w - b.l) - (a.w - a.l) || (a.rank ?? 1e9) - (b.rank ?? 1e9)).slice(0, 5);
      if (best.length) {
        blocks.push(h('section', { class: 'mtgs-drawer-section' }, h('h4', {}, t('Best results')),
          h('ul', { class: 'mtgs-results' }, best.map((r) => h('li', {},
            h('span', { class: 'mtgs-results-name' }, r.player),
            h('span', { class: 'mtgs-muted' }, `${fmt.record(r)}${r.rank ? ` · ${fmt.ordinal(r.rank)}` : ''}`),
            h('span', { class: 'mtgs-results-event' }, ts[r.t].name))))));
      }

      blocks.push(h('div', { class: 'mtgs-drawer-foot' },
        h('button', { type: 'button', class: 'mtgs-btn mtgs-btn-primary', onClick: () => { this.state.cardArch = name; this.closeDrawer(); this.setTab('cards'); } }, t('Card analysis'), icon('arrow', 14))));
      return blocks;
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    for (const node of document.querySelectorAll('.mtgstats-app:not([data-ready])')) {
      node.dataset.ready = '1';
      new Dashboard(node);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.MTGStatsViewer = { boot };
})();
