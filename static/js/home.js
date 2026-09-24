/* Homepage. Everything is driven by three server-side sources:
 *   /api/prices           shared price cache (server refreshes it every second)
 *   /api/balances/{addr}  wallet holdings across the 11 accepted assets
 *   /api/news             news feed
 * Values are computed here: balance = sum(amount * price) over ALL holdings;
 * Portfolio shows the top 3 by USD value. The Stocks card shows the 3 PreStocks
 * with the biggest 24h move (re-ranked every 30s); "View all" / the Stocks tab
 * open the full Stocks panel (/stocks in the URL so Back returns to it).
 * Every row links to its token page (/t/SYMBOL). Send opens the send flow
 * (send.js); Swap / Lend are inert for now.
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
    swapBtn: $('hm-swap-btn'),
    notice: $('hm-lock-notice'),
    stockRows: $('hm-stock-rows'),
    stockEmpty: $('hm-stock-empty'),
    stocksOpen: $('hm-stocks-open'),
    panel: $('stk-panel'),
    panelRows: $('stk-rows'),
    panelEmpty: $('stk-empty'),
    tabHome: document.querySelector('[data-tab="home"]'),
    tabStocks: document.querySelector('[data-tab="stocks"]'),
    tabSwap: document.querySelector('[data-tab="swap"]'),
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
    holdings: null, // { SYMBOL: amount } once loaded
    prices: {},     // { SYMBOL: { price, change24h, mc? } }
    assets: {},     // { SYMBOL: { name, image, kind } }
    loaded: false,  // first /api/prices response received
    top: [],        // the 3 stocks shown on the home card
    topAt: 0,       // when `top` was last ranked
    news: null,     // null = loading, [] = none
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

  // -1.2 -> { text: '-1.2%', cls: 'neg' }; up to `digits` decimals, trailing zeros trimmed
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

  // Keeps existing nodes (no image flicker / lost state) and only adds, removes, reorders.
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
    if (els.swapBtn) {
      els.swapBtn.classList.toggle('live', connected);
      if (connected) els.swapBtn.removeAttribute('aria-disabled');
      else els.swapBtn.setAttribute('aria-disabled', 'true');
    }

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

  // ---- Rows (stocks / portfolio) -------------------------------------------
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

  // Top 3 by absolute 24h move (market cap breaks ties / covers missing history).
  // Re-ranked at most every TOP_REFRESH_MS so the card doesn't jump every second.
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

  function buildStockRow(sym) {
    return rowShell(sym, { badge: true });
  }

  function updateStockRow(node, sym) {
    const p = state.prices[sym];
    const sub = node.querySelector('.hm-sub');
    sub.textContent = p && p.mc ? `${fmtCompact(p.mc)} MC` : '';
    node.querySelector('.hm-side-top').textContent = p ? fmtPrice(p.price) : '—';
    const bot = node.querySelector('.hm-side-bot');
    bot.className = 'hm-side-bot';
    setPct(bot, p ? p.change24h : null);
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
    const top = pickTop();
    syncList(els.stockRows, top, (s) => s, buildStockRow, updateStockRow);
    els.stockEmpty.hidden = top.length > 0;
    els.stockEmpty.textContent = state.loaded ? 'No stocks available' : 'Loading…';
    if (panelOpen) renderPanel();
  }

  // ---- Stocks panel (full list, sorted by market cap) -----------------------
  let panelOpen = false;
  let panelPushed = false;

  function buildPanelRow(sym) {
    const row = rowShell(sym, { badge: true, size: 40 });
    row.classList.add('stk-row');
    const side = row.querySelector('.hm-row-side');
    side.className = 'stk-price-col';
    side.replaceChildren(h('div', 'hm-side-top stk-price'), h('div', 'hm-side-bot stk-chg'));
    row.appendChild(h('div', 'hm-side-top stk-mc'));
    return row;
  }

  function updatePanelRow(node, sym) {
    const p = state.prices[sym];
    node.querySelector('.hm-sub').textContent = meta(sym).name || sym;
    node.querySelector('.stk-price').textContent = p ? fmtPrice(p.price) : '—';
    const chg = node.querySelector('.stk-chg');
    chg.className = 'hm-side-bot stk-chg';
    setPct(chg, p ? p.change24h : null);
    node.querySelector('.stk-mc').textContent = p && p.mc ? fmtCompact(p.mc) : '—';
  }

  function renderPanel() {
    const syms = stockSyms().sort((a, b) => mcOf(b) - mcOf(a) || a.localeCompare(b));
    syncList(els.panelRows, syms, (s) => s, buildPanelRow, updatePanelRow);
    els.panelEmpty.hidden = syms.length > 0;
    els.panelEmpty.textContent = state.loaded ? 'No stocks available' : 'Loading…';
  }

  function setPanel(open) {
    panelOpen = open;
    els.panel.classList.toggle('open', open);
    els.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.documentElement.classList.toggle('stk-lock', open);
    if (els.tabHome) els.tabHome.classList.toggle('active', !open);
    if (els.tabStocks) els.tabStocks.classList.toggle('active', open);
    if (open) {
      renderPanel();
      els.panel.scrollTop = 0;
    }
  }

  function openPanel() {
    if (panelOpen) return;
    if (location.pathname !== '/stocks') {
      history.pushState(null, '', '/stocks');
      panelPushed = true;
    }
    setPanel(true);
  }

  function closePanel() {
    if (!panelOpen) return;
    if (panelPushed) {
      panelPushed = false;
      history.back(); // popstate closes it
    } else {
      history.replaceState(null, '', '/');
      setPanel(false);
    }
  }

  els.stocksOpen.addEventListener('click', (e) => { e.preventDefault(); openPanel(); });
  if (els.tabStocks) {
    els.tabStocks.addEventListener('click', (e) => {
      e.preventDefault();
      panelOpen ? closePanel() : openPanel();
    });
  }
  if (els.tabHome) {
    els.tabHome.addEventListener('click', (e) => {
      e.preventDefault();
      if (panelOpen) closePanel();
      else if (window.MarktapeTrade && window.MarktapeTrade.isOpen()) history.back();
      else window.scrollTo({ top: 0, behavior: 'smooth' });
      if (location.pathname !== '/') history.replaceState(null, '', '/');
    });
  }
  window.addEventListener('popstate', () => {
    const open = location.pathname === '/stocks';
    if (!open) panelPushed = false;
    setPanel(open);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen && !document.documentElement.classList.contains('snd-lock') && !document.documentElement.classList.contains('trd-lock')) closePanel();
  });

  function renderHoldings() {
    const rows = state.address && state.holdings ? computePortfolio().rows.slice(0, LIST_MAX) : [];
    syncList(els.holdRows, rows, (r) => r.symbol, buildHoldRow, updateHoldRow);
    const loading = !!state.address && state.holdings === null;
    els.holdEmpty.hidden = rows.length > 0 || loading;
    els.holdEmpty.textContent = state.address ? 'No Holdings yet' : 'Connect wallet';
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
      // logos are baked into rows on creation — rebuild so late metadata shows up
      [els.stockRows, els.panelRows, els.holdRows, els.newsList].forEach((c) => { c.textContent = ''; });
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
        setTimeout(tickBalances, 2500); // pick up the settled balance
      },
    });
  });

  // ---- Trade (Swap) ---------------------------------------------------------
  function setSwapTabActive(open) {
    if (els.tabSwap) els.tabSwap.classList.toggle('active', open);
    if (open && els.tabHome) els.tabHome.classList.remove('active');
    else if (!panelOpen && els.tabHome) els.tabHome.classList.add('active');
  }

  function openTrade() {
    if (!state.address || !window.MarktapeTrade) return;
    if (location.pathname !== '/swap') history.pushState(null, '', '/swap');
    setSwapTabActive(true);
    window.MarktapeTrade.open({
      getCtx: () => ({ address: state.address, holdings: state.holdings || {}, prices: state.prices, assets: state.assets }),
      onDone: () => {
        tickBalances();
        setTimeout(tickBalances, 2500);
      },
    });
  }
  if (els.swapBtn) els.swapBtn.addEventListener('click', openTrade);
  if (els.tabSwap) {
    els.tabSwap.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.MarktapeTrade && window.MarktapeTrade.isOpen()) history.back();
      else openTrade();
    });
  }
  window.addEventListener('popstate', () => {
    if (location.pathname !== '/swap' && window.MarktapeTrade && window.MarktapeTrade.isOpen()) window.MarktapeTrade.close();
    if (location.pathname !== '/swap') setSwapTabActive(false);
  });
  // trade.js closes itself on a successful swap (not via history.back()) —
  // clean up the /swap URL + tab state so Back doesn't land on a re-opened panel.
  setInterval(() => {
    if (location.pathname === '/swap' && window.MarktapeTrade && !window.MarktapeTrade.isOpen()) {
      history.replaceState(null, '', '/');
      setSwapTabActive(false);
    }
  }, 400);

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

  window.addEventListener('resize', measureNews);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureNews);

  // ---- Boot ---------------------------------------------------------------
  state.address = window.MarktapeWallet ? window.MarktapeWallet.getAddress() : null;
  const bootPanel = window.__MKT_OPEN_PANEL__ || (location.pathname === '/stocks' ? 'stocks' : location.pathname === '/swap' ? 'swap' : '');
  if (bootPanel === 'stocks') setPanel(true);
  else if (bootPanel === 'swap' && state.address) openTrade();
  else if (bootPanel === 'swap') history.replaceState(null, '', '/');
  renderAll();
  setSwapTabActive(!!(window.MarktapeTrade && window.MarktapeTrade.isOpen()));
  tickPrices();
  tickBalances();
  loadNews();
  setInterval(tickPrices, PRICE_MS);
  setInterval(tickBalances, BALANCE_MS);
  setInterval(loadNews, NEWS_MS);
})();
