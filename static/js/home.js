/* Homepage. Driven by:
 *   /api/prices           shared price cache (refreshes every second)
 *   /api/balances/{addr}  wallet holdings
 *   /api/news             news feed
 * Send is wallet-gated. Swap → /swap. Lend → /lend.
 */
(function () {
  const PRICE_MS = 1000;
  const BALANCE_MS = 6000;
  const NEWS_MS = 60000;
  const ASSETS_RETRY_MS = 3000;
  const LIST_MAX = 3;
  const TOP_REFRESH_MS = 30000;
  const NON_STOCKS = new Set(['SOL', 'USDT', 'USDC']);

  const $ = (id) => document.getElementById(id);
  const els = {
    total: $('hm-total'),
    change: $('hm-change'),
    changeText: $('hm-change-text'),
    actions: $('hm-actions'),
    sendBtn: $('hm-send-btn'),
    notice: $('hm-lock-notice'),
    stockRows: $('hm-stock-rows'),
    stockEmpty: $('hm-stock-empty'),
    stockToggle: $('hm-stock-toggle'),
    stocks: $('hm-stocks'),
    holdRows: $('hm-hold-rows'),
    holdEmpty: $('hm-hold-empty'),
    holdOpen: $('hm-hold-open'),
    newsList: $('hm-news-list'),
    newsEmpty: $('hm-news-empty'),
    hldRoot: $('hld-root'),
    hldBackdrop: $('hld-backdrop'),
    hldSheet: $('hld-sheet'),
    hldClose: $('hld-close'),
    hldRows: $('hld-rows'),
    hldEmpty: $('hld-empty'),
    hldDisc: $('hld-disc'),
  };

  const state = {
    address: null,
    holdings: null,
    prices: {},
    assets: {},
    loaded: false,
    top: [],
    topAt: 0,
    news: null,
    stocksOpen: false,
  };

  // ---- Formatting ---------------------------------------------------------
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  function fmtUsd(v) {
    if (v > 0 && v < 0.005) return '<$0.01';
    return usd.format(v);
  }

  function fmtPrice(v) {
    return v >= 1 ? usd.format(v) : '$' + v.toFixed(4);
  }

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

  function pct(p, digits) {
    if (p === null || p === undefined || !isFinite(p)) return null;
    const r = Number(p.toFixed(digits === undefined ? 2 : digits));
    return { text: (r > 0 ? '+' : '') + r.toString() + '%', cls: r > 0 ? 'pos' : r < 0 ? 'neg' : 'flat' };
  }

  function fmtDelta(v) {
    const abs = Math.abs(v);
    const digits = abs > 0 && abs < 1 ? 3 : 2;
    return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' + abs.toFixed(digits);
  }

  function fmtAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---- DOM helpers --------------------------------------------------------
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function icon(id, size, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    if (cls) svg.setAttribute('class', cls);
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function badgeEl() {
    const badge = h('span', 'hm-badge');
    badge.innerHTML = '<img src="/static/img/prestocks.png" alt="" width="18" height="18">';
    return badge;
  }

  function meta(sym) {
    return state.assets[sym] || { name: sym, image: null, kind: 'stock' };
  }

  function logo(sym, size) {
    const m = meta(sym);
    const wrap = h('span', 'hm-logo-wrap');
    wrap.style.width = wrap.style.height = size + 'px';
    const empty = () => h('span', 'hm-logo hm-logo-empty');
    if (m.image) {
      const img = h('img', 'hm-logo');
      img.alt = '';
      img.loading = 'lazy';
      img.src = m.image;
      img.addEventListener('error', () => img.replaceWith(empty()));
      wrap.appendChild(img);
    } else {
      wrap.appendChild(empty());
    }
    return wrap;
  }

  function setPct(el, p) {
    const info = pct(p);
    el.textContent = info ? info.text : '';
    el.className = el.className.replace(/\b(pos|neg|flat)\b/g, '').trim() + (info ? ' ' + info.cls : '');
    el.hidden = !info;
  }

  function syncList(container, items, keyOf, create, update) {
    const existing = new Map();
    Array.from(container.children).forEach((c) => existing.set(c.dataset.key, c));
    items.forEach((item, i) => {
      const key = keyOf(item);
      let node = existing.get(key);
      if (node) {
        existing.delete(key);
      } else {
        node = create(item);
        node.dataset.key = key;
      }
      update(node, item);
      if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null);
    });
    existing.forEach((n) => n.remove());
  }

  // ---- Portfolio maths ----------------------------------------------------
  function computePortfolio() {
    const rows = [];
    let total = 0;
    let prev = 0;
    Object.entries(state.holdings || {}).forEach(([sym, amount]) => {
      const p = state.prices[sym];
      if (!p || !(amount > 0)) return;
      const value = amount * p.price;
      const open = p.change24h === null || p.change24h === undefined ? p.price : p.price / (1 + p.change24h / 100);
      total += value;
      prev += amount * open;
      rows.push({ symbol: sym, amount, price: p.price, change: p.change24h, value });
    });
    rows.sort((a, b) => b.value - a.value);
    return { rows, total, delta: total - prev, deltaPct: prev > 0 ? (total / prev - 1) * 100 : 0 };
  }

  // ---- Balance ------------------------------------------------------------
  function renderBalance() {
    const connected = !!state.address;
    els.notice.hidden = connected;
    els.actions.classList.toggle('locked', !connected);
    els.sendBtn.classList.toggle('live', connected);
    if (connected) els.sendBtn.removeAttribute('aria-disabled');
    else els.sendBtn.setAttribute('aria-disabled', 'true');

    if (!connected) {
      els.total.textContent = '$0.00';
      els.changeText.textContent = '$0.00 (0%)';
      els.change.className = 'hm-change flat';
      els.change.style.visibility = 'visible';
      return;
    }
    if (state.holdings === null || !Object.keys(state.prices).length) {
      els.total.textContent = '—';
      els.change.style.visibility = 'hidden';
      return;
    }
    const pf = computePortfolio();
    els.total.textContent = usd.format(pf.total);
    const info = pct(pf.deltaPct, 1);
    els.changeText.textContent = `${fmtDelta(pf.delta)} (${info ? info.text : '0%'})`;
    els.change.className = 'hm-change ' + (info ? info.cls : 'flat');
    els.change.style.visibility = 'visible';
  }

  // ---- Rows ---------------------------------------------------------------
  function rowShell(sym, opts) {
    const row = h('a', 'hm-row');
    row.href = '/t/' + encodeURIComponent(sym);

    const lg = logo(sym, opts.size || 36);
    if (opts.badge) lg.appendChild(badgeEl());
    row.appendChild(lg);

    const main = h('div', 'hm-row-main');
    const name = h('div', 'hm-sym');
    name.appendChild(h('span', 'hm-sym-text', sym));
    name.appendChild(icon('i-verified', 15, 'hm-verified'));
    main.appendChild(name);
    main.appendChild(h('div', 'hm-sub'));
    row.appendChild(main);

    const side = h('div', 'hm-row-side');
    side.appendChild(h('div', 'hm-side-top'));
    side.appendChild(h('div', 'hm-side-bot'));
    row.appendChild(side);
    return row;
  }

  function stockSyms() {
    return Object.keys(state.prices).filter((sym) => !NON_STOCKS.has(sym));
  }

  const mcOf = (sym) => (state.prices[sym] && state.prices[sym].mc) || 0;

  function pickTop() {
    const fresh = Date.now() - state.topAt < TOP_REFRESH_MS;
    if (fresh && state.top.length && state.top.every((s) => state.prices[s])) return state.top;
    const syms = stockSyms();
    if (!syms.length) return [];
    const move = (s) => {
      const c = state.prices[s].change24h;
      return c === null || c === undefined ? -1 : Math.abs(c);
    };
    syms.sort((a, b) => move(b) - move(a) || mcOf(b) - mcOf(a) || a.localeCompare(b));
    state.top = syms.slice(0, LIST_MAX);
    state.topAt = Date.now();
    return state.top;
  }

  function fmtPrem(p) {
    if (p === null || p === undefined || !isFinite(p)) return '—';
    const pctv = p * 100;
    const r = Number(pctv.toFixed(1));
    return (r > 0 ? '+' : '') + r.toString() + '%';
  }

  function premCls(p) {
    if (!(p > 0) && !(p < 0)) return 'flat';
    return p > 0 ? 'pos' : 'neg';
  }

  function pickAll() {
    const syms = stockSyms();
    syms.sort((a, b) => mcOf(b) - mcOf(a) || a.localeCompare(b));
    return syms;
  }

  function metricLine(row, keys) {
    const line = h('div', 'hm-n-line');
    keys.forEach((k, i) => {
      if (i) line.appendChild(h('span', 'hm-dim hm-n-dot', ' • '));
      line.appendChild(h('span', 'hm-dim', k.label + ' '));
      line.appendChild(h('span', 'hm-stk-' + k.key));
    });
    row.appendChild(line);
    return line;
  }

  function buildStockRow(sym) {
    const row = h('a', 'hm-stk-row');
    row.href = '/t/' + encodeURIComponent(sym);

    const head = h('div', 'hm-n-head');
    const lg = logo(sym, 36);
    lg.appendChild(badgeEl());
    head.appendChild(lg);
    const name = h('div', 'hm-sym');
    name.appendChild(h('span', 'hm-sym-text', sym));
    name.appendChild(icon('i-verified', 16, 'hm-verified'));
    head.appendChild(name);
    head.appendChild(h('span', 'hm-stk-chg'));
    row.appendChild(head);

    metricLine(row, [
      { key: 'price', label: 'Price' },
      { key: 'mc', label: 'Mcap' },
      { key: 'mark', label: 'Mark' },
      { key: 'prem', label: 'Prem' },
    ]);
    return row;
  }

  function updateStockRow(node, sym) {
    const p = state.prices[sym] || {};
    const chg = node.querySelector('.hm-stk-chg');
    chg.className = 'hm-stk-chg';
    setPct(chg, p.change24h);
    node.querySelector('.hm-stk-price').textContent = p.price ? fmtPrice(p.price) : '—';
    node.querySelector('.hm-stk-mc').textContent = p.mc ? fmtCompact(p.mc) : '—';
    node.querySelector('.hm-stk-mark').textContent = p.mark ? fmtPrice(p.mark) : '—';
    const prem = node.querySelector('.hm-stk-prem');
    prem.textContent = fmtPrem(p.premium);
    prem.className = 'hm-stk-prem ' + premCls(p.premium);
  }

  function buildHoldRow(item) {
    const row = rowShell(item.symbol, {});
    const sub = row.querySelector('.hm-sub');
    sub.appendChild(h('span', 'hm-sub-price'));
    sub.appendChild(h('span', 'hm-pill'));
    return row;
  }

  function updateHoldRow(node, item) {
    node.querySelector('.hm-sub-price').textContent = fmtPrice(item.price);
    const pill = node.querySelector('.hm-pill');
    pill.className = 'hm-pill';
    setPct(pill, item.change);
    node.querySelector('.hm-side-top').textContent = fmtUsd(item.value);
    node.querySelector('.hm-side-bot').textContent = fmtAmount(item.amount);
  }

  function renderStocks() {
    const all = pickAll();
    const rows = state.stocksOpen ? all : pickTop();
    syncList(els.stockRows, rows, (s) => s, buildStockRow, updateStockRow);
    els.stockEmpty.hidden = rows.length > 0;
    els.stockEmpty.textContent = state.loaded ? 'No stocks available' : 'Loading…';
    if (els.stockToggle) {
      els.stockToggle.hidden = all.length <= LIST_MAX;
      const label = els.stockToggle.querySelector('.hm-n-toggle-text');
      if (label) label.textContent = state.stocksOpen ? 'View less' : 'View all';
      els.stockToggle.classList.toggle('open', state.stocksOpen);
      if (els.stocks) els.stocks.classList.toggle('open', state.stocksOpen);
    }
  }

  if (els.stockToggle) {
    els.stockToggle.addEventListener('click', () => {
      state.stocksOpen = !state.stocksOpen;
      renderStocks();
    });
  }

  function renderHoldings() {
    const rows = state.address && state.holdings ? computePortfolio().rows.slice(0, LIST_MAX) : [];
    syncList(els.holdRows, rows, (r) => r.symbol, buildHoldRow, updateHoldRow);
    const loading = !!state.address && state.holdings === null;
    els.holdEmpty.hidden = rows.length > 0 || loading;
    els.holdEmpty.textContent = 'No Holdings yet';
    if (hldOpen) renderHldModal();
  }

  // ---- Holdings modal (View All) -------------------------------------------
  let hldOpen = false;

  function renderHldModal() {
    const rows = state.address && state.holdings ? computePortfolio().rows : [];
    syncList(els.hldRows, rows, (r) => r.symbol, buildHoldRow, updateHoldRow);
    els.hldEmpty.hidden = rows.length > 0;
    els.hldRows.hidden = rows.length === 0;
    els.hldDisc.textContent = state.address ? 'Disconnect wallet' : 'Connect wallet';
    els.hldDisc.classList.toggle('connect', !state.address);
  }

  function openHldModal() {
    if (hldOpen) return;
    hldOpen = true;
    renderHldModal();
    els.hldRows.scrollTop = 0;
    els.hldRoot.hidden = false;
    document.documentElement.classList.add('hld-lock');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      els.hldBackdrop.classList.add('open');
      els.hldSheet.classList.add('open');
    }));
  }

  function closeHldModal() {
    if (!hldOpen) return;
    hldOpen = false;
    els.hldBackdrop.classList.remove('open');
    els.hldSheet.classList.remove('open');
    document.documentElement.classList.remove('hld-lock');
    setTimeout(() => { if (!hldOpen) els.hldRoot.hidden = true; }, 260);
  }

  if (els.holdOpen) els.holdOpen.addEventListener('click', openHldModal);
  els.hldBackdrop.addEventListener('click', closeHldModal);
  els.hldClose.addEventListener('click', closeHldModal);
  els.hldDisc.addEventListener('click', async () => {
    if (!window.MarktapeWallet) return;
    if (state.address) {
      closeHldModal();
      await window.MarktapeWallet.disconnect();
    } else {
      await window.MarktapeWallet.connectWithPicker();
    }
  });
  els.hldRows.addEventListener('click', (e) => {
    const row = e.target.closest('a.hm-row');
    if (!row) return;
    e.preventDefault();
    hldOpen = false;
    els.hldRoot.hidden = true;
    els.hldBackdrop.classList.remove('open');
    els.hldSheet.classList.remove('open');
    document.documentElement.classList.remove('hld-lock');
    location.href = row.href;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hldOpen) closeHldModal();
  });

  // ---- News ---------------------------------------------------------------
  function buildNews(item) {
    const art = h('article', 'hm-news-item');

    const head = h('div', 'hm-n-head');
    head.appendChild(logo(item.symbol, 36));
    const name = h('div', 'hm-sym');
    name.appendChild(h('span', 'hm-sym-text', item.symbol));
    name.appendChild(icon('i-verified', 16, 'hm-verified'));
    head.appendChild(name);
    head.appendChild(h('span', 'hm-n-time'));
    art.appendChild(head);

    const line = h('div', 'hm-n-line');
    line.appendChild(h('span', 'hm-dim', 'Price '));
    line.appendChild(h('span', 'hm-n-price'));
    line.appendChild(document.createTextNode(' '));
    line.appendChild(h('span', 'hm-n-chg'));
    line.appendChild(h('span', 'hm-dim hm-n-dot', ' • '));
    line.appendChild(h('span', 'hm-dim', 'MC '));
    line.appendChild(h('span', 'hm-n-mc'));
    line.appendChild(h('span', 'hm-dim hm-n-dot', ' • '));
    line.appendChild(h('span', 'hm-dim', 'Mark '));
    line.appendChild(h('span', 'hm-n-mark'));
    line.appendChild(h('span', 'hm-dim hm-n-dot', ' • '));
    line.appendChild(h('span', 'hm-dim', 'Prem '));
    line.appendChild(h('span', 'hm-n-prem'));
    art.appendChild(line);

    art.appendChild(h('p', 'hm-n-body'));

    const toggle = h('button', 'hm-n-toggle');
    toggle.type = 'button';
    toggle.hidden = true;
    toggle.appendChild(h('span', 'hm-n-toggle-text', 'Show More'));
    toggle.appendChild(icon('i-chevron-down', 14, 'hm-n-toggle-icon'));
    toggle.addEventListener('click', () => {
      const open = art.classList.toggle('expanded');
      toggle.querySelector('.hm-n-toggle-text').textContent = open ? 'Show Less' : 'Show More';
    });
    art.appendChild(toggle);
    return art;
  }

  function updateNews(node, item) {
    node.querySelector('.hm-n-time').textContent = fmtAgo(item.publishedAt);
    const p = state.prices[item.symbol];
    node.querySelector('.hm-n-price').textContent = p ? fmtPrice(p.price) : '—';
    const chg = node.querySelector('.hm-n-chg');
    chg.className = 'hm-n-chg';
    setPct(chg, p ? p.change24h : null);
    node.querySelector('.hm-n-mc').textContent = p && p.mc ? fmtCompact(p.mc) : '—';
    node.querySelector('.hm-n-mark').textContent = p && p.mark ? fmtPrice(p.mark) : '—';
    const prem = node.querySelector('.hm-n-prem');
    prem.textContent = fmtPrem(p ? p.premium : null);
    prem.className = 'hm-n-prem ' + premCls(p ? p.premium : null);
    const body = node.querySelector('.hm-n-body');
    if (body.textContent !== item.body) {
      body.textContent = item.body;
      node.dataset.measured = '';
    }
  }

  function measureNews() {
    els.newsList.querySelectorAll('.hm-news-item').forEach((node) => {
      if (node.classList.contains('expanded')) return;
      const body = node.querySelector('.hm-n-body');
      node.querySelector('.hm-n-toggle').hidden = !(body.scrollHeight > body.clientHeight + 1);
      node.dataset.measured = '1';
    });
  }

  function renderNews() {
    const items = state.news || [];
    syncList(els.newsList, items, (i) => i.symbol, buildNews, updateNews);
    els.newsEmpty.hidden = state.news === null || items.length > 0;
    if (Array.from(els.newsList.children).some((n) => !n.dataset.measured)) requestAnimationFrame(measureNews);
  }

  // ---- Render orchestration -----------------------------------------------
  function renderAll() {
    renderBalance();
    renderStocks();
    renderHoldings();
    renderNews();
  }

  // ---- Data ---------------------------------------------------------------
  async function getJSON(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(url + ' ' + resp.status);
    return resp.json();
  }

  let assetsAt = 0;
  async function ensureAssets() {
    const missing = Object.keys(state.prices).some((s) => !state.assets[s]);
    if (!missing || Date.now() - assetsAt < ASSETS_RETRY_MS) return;
    assetsAt = Date.now();
    try {
      const data = await getJSON('/api/assets');
      state.assets = data.assets || {};
      [els.stockRows, els.holdRows, els.newsList].forEach((c) => { c.textContent = ''; });
      renderAll();
    } catch (err) { /* retry on a later tick */ }
  }

  let pricesBusy = false;
  async function tickPrices() {
    if (document.hidden || pricesBusy) return;
    pricesBusy = true;
    try {
      const data = await getJSON('/api/prices');
      state.prices = data.prices || {};
      state.loaded = true;
      await ensureAssets();
      renderAll();
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
        renderAll();
      }
    } catch (err) { /* keep last holdings */ } finally {
      if (balancesFor === addr) balancesFor = null;
    }
  }

  async function loadNews() {
    try {
      const data = await getJSON('/api/news');
      state.news = data.items || [];
    } catch (err) {
      if (state.news === null) state.news = [];
    }
    renderNews();
  }

  // ---- Send ---------------------------------------------------------------
  els.sendBtn.addEventListener('click', () => {
    if (!state.address || !window.MarktapeSend) return;
    window.MarktapeSend.open({
      getCtx: () => ({ address: state.address, holdings: state.holdings || {}, prices: state.prices, assets: state.assets }),
      onSent: () => {
        tickBalances();
        setTimeout(tickBalances, 2500);
      },
    });
  });

  // ---- Wallet -------------------------------------------------------------
  function setAddress(next) {
    if (next === state.address) return;
    state.address = next;
    state.holdings = null;
    renderAll();
    tickBalances();
  }

  window.addEventListener('marktape:wallet', (e) => setAddress(e.detail.address));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tickPrices();
    tickBalances();
  });

  window.addEventListener('resize', () => { measureNews(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureNews);

  // ---- Boot ---------------------------------------------------------------
  state.address = window.MarktapeWallet ? window.MarktapeWallet.getAddress() : null;
  renderAll();
  tickPrices();
  tickBalances();
  loadNews();
  setInterval(tickPrices, PRICE_MS);
  setInterval(tickBalances, BALANCE_MS);
  setInterval(loadNews, NEWS_MS);
})();
