/* Token page (/t/SYMBOL). Same data sources as the homepage:
 *   /api/prices           shared price cache (polled every second)
 *   /api/balances/{addr}  wallet holdings
 *   /api/chart/{symbol}   price history for the chart
 * Send opens send.js on this page; Buy / Sell open swap.js (frontend only for now).
 * With no holdings only the Buy button shows.
 */
(function () {
  'use strict';
  const page = document.getElementById('token-page');
  if (!page) return;

  const SYMBOL = page.dataset.symbol;
  const PRICE_MS = 1000;
  const BALANCE_MS = 6000;
  const CHART_MS = 30000;
  const UP = '#4ade80';
  const DOWN = '#fb7185';

  const $ = (id) => document.getElementById(id);
  const els = {
    price: $('tk-price'), chg: $('tk-chg'), chgAbs: $('tk-chg-abs'), chgPct: $('tk-chg-pct'),
    stats: $('tk-stats'), mc: $('tk-mc'), mark: $('tk-mark'), prem: $('tk-prem'),
    plot: $('tk-plot'), axis: $('tk-axis'), noHist: $('tk-nohist'), ranges: $('tk-ranges'),
    pos: $('tk-pos'), posVal: $('tk-pos-val'), posAmt: $('tk-pos-amt'), posDelta: $('tk-pos-delta'), posPct: $('tk-pos-pct'), posPnl: $('tk-pos-pnl'),
    bar: $('tk-bar'), send: $('tk-send'), sell: $('tk-sell'), buy: $('tk-buy'),
    back: $('tk-back'), share: $('tk-share'), mint: $('tk-mint'), mintText: $('tk-mint-text'),
    about: $('tk-about'), aboutText: $('tk-about-text'), more: $('tk-readmore'),
  };

  const state = {
    address: null,
    holdings: null, // { SYMBOL: amount } once loaded
    prices: {},
    assets: {},
    range: '1D',
    points: [],     // [[ms, price], ...] history for the selected range
  };

  // ---- Formatting ---------------------------------------------------------
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmtPrice = (v) => (v >= 1 ? usd.format(v) : '$' + v.toFixed(4));
  const fmtUsd = (v) => (v > 0 && v < 0.005 ? '<$0.01' : usd.format(v));

  function fmtCompact(v) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [div, suffix] of units) {
      if (v >= div) return '$' + (v / div).toFixed(2) + suffix;
    }
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  function fmtAmount(v) {
    const max = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
    return v.toLocaleString('en-US', { maximumFractionDigits: max });
  }

  function fmtDelta(v) {
    const abs = Math.abs(v);
    const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 5;
    return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' + abs.toFixed(digits);
  }

  function pct(p, digits) {
    if (p === null || p === undefined || !isFinite(p)) return null;
    const r = Number(p.toFixed(digits === undefined ? 1 : digits));
    return { text: (r > 0 ? '+' : '') + r.toString() + '%', cls: r > 0 ? 'pos' : r < 0 ? 'neg' : 'flat' };
  }

  function setTone(el, base, cls) {
    el.className = base + (cls ? ' ' + cls : '');
  }

  // ---- Render -------------------------------------------------------------
  function open24h(p) {
    return p.change24h === null || p.change24h === undefined ? p.price : p.price / (1 + p.change24h / 100);
  }

  function render() {
    const p = state.prices[SYMBOL];

    els.price.textContent = p ? fmtPrice(p.price) : '—';
    const info = p ? pct(p.change24h) : null;
    els.chg.hidden = !info;
    if (info) {
      els.chgAbs.textContent = fmtDelta(p.price - open24h(p));
      setTone(els.chg, 'tk-chg', info.cls);
      els.chgPct.textContent = info.text;
      setTone(els.chgPct, 'tk-pill', info.cls);
    }
    if (els.stats) {
      const show = !!p;
      els.stats.hidden = !show;
      if (show) {
        els.mc.textContent = p.mc ? fmtCompact(p.mc) : '—';
        els.mark.textContent = p.mark ? fmtPrice(p.mark) : '—';
        if (p.premium === null || p.premium === undefined || !isFinite(p.premium)) {
          els.prem.textContent = '—';
          els.prem.className = '';
        } else {
          const pctv = Number((p.premium * 100).toFixed(1));
          els.prem.textContent = (pctv > 0 ? '+' : '') + pctv + '%';
          els.prem.className = pctv > 0 ? 'pos' : pctv < 0 ? 'neg' : 'flat';
        }
      }
    }

    // Portfolio card + bottom bar
    const amount = state.address && state.holdings ? state.holdings[SYMBOL] || 0 : 0;
    const held = amount > 0 && !!p;
    els.pos.hidden = !held;
    els.send.hidden = els.sell.hidden = !held;
    els.bar.classList.toggle('only-buy', !held);
    if (held) {
      els.posVal.textContent = fmtUsd(amount * p.price);
      els.posAmt.textContent = `${fmtAmount(amount)} ${SYMBOL}`;
      const delta = amount * (p.price - open24h(p)); // 24h move of the position
      const pi = pct(p.change24h);
      els.posDelta.textContent = fmtDelta(delta);
      els.posPct.textContent = pi ? pi.text : '';
      setTone(els.posPnl, 'tk-pos-pnl', pi ? pi.cls : 'flat');
    }
    drawChart();
  }

  // ---- Chart --------------------------------------------------------------
  const NS = 'http://www.w3.org/2000/svg';
  const W = 360;
  const H = 230;
  const PAD_T = 16;
  const PAD_B = 16;

  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  }

  function drawChart() {
    const vals = state.points.map((pt) => pt[1]);
    const live = state.prices[SYMBOL];
    if (live && vals.length) vals.push(live.price);
    els.plot.textContent = '';
    els.noHist.hidden = vals.length >= 2;
    els.axis.hidden = vals.length < 2;
    if (vals.length < 2) return;

    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || Math.abs(max) * 0.001 || 1;
    const x = (i) => (i / (vals.length - 1)) * W;
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - min) / span);
    const color = vals[vals.length - 1] >= vals[0] ? UP : DOWN;

    [0, 0.5, 1].forEach((f) => {
      const gy = PAD_T + (H - PAD_T - PAD_B) * f;
      els.plot.appendChild(svgEl('line', { class: 'tk-grid', x1: 0, x2: W, y1: gy, y2: gy }));
    });

    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const defs = svgEl('defs', {});
    const grad = svgEl('linearGradient', { id: 'tk-grad', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.22 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.appendChild(grad);
    els.plot.appendChild(defs);
    els.plot.appendChild(svgEl('path', { d: `${line} L${W},${H} L0,${H} Z`, fill: 'url(#tk-grad)' }));
    els.plot.appendChild(svgEl('path', { d: line, class: 'tk-line', stroke: color }));

    const labels = els.axis.children;
    labels[0].textContent = fmtPrice(max);
    labels[1].textContent = fmtPrice((max + min) / 2);
    labels[2].textContent = fmtPrice(min);
  }

  let chartReq = 0;
  async function loadChart() {
    const req = ++chartReq;
    try {
      const data = await getJSON(`/api/chart/${encodeURIComponent(SYMBOL)}?range=${state.range}`);
      if (req !== chartReq) return;
      state.points = data.points || [];
    } catch (err) {
      if (req !== chartReq) return;
      // keep whatever we had for this range
    }
    drawChart();
  }

  els.ranges.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn || btn.dataset.range === state.range) return;
    state.range = btn.dataset.range;
    els.ranges.querySelectorAll('.tk-range').forEach((b) => b.classList.toggle('active', b === btn));
    state.points = [];
    drawChart();
    loadChart();
  });

  // ---- Data ---------------------------------------------------------------
  async function getJSON(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(url + ' ' + resp.status);
    return resp.json();
  }

  let pricesBusy = false;
  async function tickPrices() {
    if (document.hidden || pricesBusy) return;
    pricesBusy = true;
    try {
      const data = await getJSON('/api/prices');
      state.prices = data.prices || {};
      render();
    } catch (err) { /* keep last prices */ } finally {
      pricesBusy = false;
    }
  }

  let balancesFor = null;
  async function tickBalances() {
    const addr = state.address;
    if (!addr || document.hidden || balancesFor === addr) return;
    balancesFor = addr;
    try {
      const data = await getJSON('/api/balances/' + encodeURIComponent(addr));
      if (addr === state.address && data && data.holdings) {
        state.holdings = data.holdings;
        render();
      }
    } catch (err) { /* keep last holdings */ } finally {
      if (balancesFor === addr) balancesFor = null;
    }
  }

  async function loadAssets() {
    try {
      const data = await getJSON('/api/assets');
      state.assets = data.assets || {};
    } catch (err) {
      setTimeout(loadAssets, 3000);
    }
  }

  const getCtx = () => ({ address: state.address, holdings: state.holdings || {}, prices: state.prices, assets: state.assets });
  const refreshBalances = () => {
    tickBalances();
    setTimeout(tickBalances, 2500); // pick up the settled balance
  };

  // ---- Actions ------------------------------------------------------------
  function connect() {
    if (window.MarktapeWallet) window.MarktapeWallet.connectWithPicker();
  }

  els.send.addEventListener('click', () => {
    if (!state.address || !window.MarktapeSend) return;
    window.MarktapeSend.open({ symbol: SYMBOL, getCtx, onSent: refreshBalances });
  });

  function openSwap(side) {
    if (!state.address) { connect(); return; }
    if (window.MarktapeSwap) window.MarktapeSwap.open({ side, symbol: SYMBOL, getCtx, onDone: refreshBalances });
  }
  els.buy.addEventListener('click', () => openSwap('buy'));
  els.sell.addEventListener('click', () => openSwap('sell'));

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* fall back below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // Share = copy the Jupiter link; the icon turns into "Copied" for 2s.
  let shareTimer = null;
  els.share.addEventListener('click', async () => {
    if (els.share.classList.contains('done')) return;
    if (!(await copyText(els.share.dataset.link))) return;
    els.share.classList.add('done');
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => els.share.classList.remove('done'), 2000);
  });

  let mintTimer = null;
  const mintShort = els.mintText.textContent;
  els.mint.addEventListener('click', async () => {
    if (!(await copyText(els.mint.dataset.mint))) return;
    els.mintText.textContent = 'Copied';
    clearTimeout(mintTimer);
    mintTimer = setTimeout(() => { els.mintText.textContent = mintShort; }, 1200);
  });

  els.back.addEventListener('click', () => {
    let same = false;
    try { same = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (_) {}
    if (same && history.length > 1) history.back();
    else location.href = '/';
  });

  // ---- About: clamp + Read More -------------------------------------------
  function measureAbout() {
    if (els.about.classList.contains('expanded')) return;
    els.more.hidden = !(els.aboutText.scrollHeight > els.aboutText.clientHeight + 1);
  }
  els.more.addEventListener('click', () => {
    const open = els.about.classList.toggle('expanded');
    els.more.querySelector('span').textContent = open ? 'Read Less' : 'Read More';
  });
  window.addEventListener('resize', measureAbout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureAbout);

  // ---- Wallet -------------------------------------------------------------
  function setAddress(next) {
    if (next === state.address) return;
    state.address = next;
    state.holdings = null;
    render();
    tickBalances();
  }
  window.addEventListener('marktape:wallet', (e) => setAddress(e.detail.address));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tickPrices();
    tickBalances();
  });

  // ---- Boot ---------------------------------------------------------------
  state.address = window.MarktapeWallet ? window.MarktapeWallet.getAddress() : null;
  render();
  measureAbout();
  loadAssets();
  loadChart();
  tickPrices();
  tickBalances();
  setInterval(tickPrices, PRICE_MS);
  setInterval(tickBalances, BALANCE_MS);
  setInterval(loadChart, CHART_MS);
})();
