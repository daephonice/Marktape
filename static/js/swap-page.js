/* /swap host. Mounts MarktapeTrade into #trd-slot with the same
 * getCtx / onDone shape home.js used when the swap panel lived on home.
 */
(function () {
  const slot = document.getElementById('trd-slot');
  if (!slot || !window.MarktapeTrade) return;

  const PRICE_MS = 1000;
  const BALANCE_MS = 6000;
  const ASSETS_RETRY_MS = 3000;

  const state = {
    address: window.MarktapeWallet ? window.MarktapeWallet.getAddress() : null,
    holdings: null,
    prices: {},
    assets: {},
  };

  const getCtx = () => ({
    address: state.address,
    holdings: state.holdings || {},
    prices: state.prices,
    assets: state.assets,
  });

  function onDone() {
    tickBalances();
    setTimeout(tickBalances, 2500);
  }

  async function getJSON(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(url + ' ' + resp.status);
    return resp.json();
  }

  let opened = false;
  function maybeOpen() {
    if (opened || !Object.keys(state.prices).length) return;
    opened = true;
    window.MarktapeTrade.mount(slot);
    window.MarktapeTrade.open({ getCtx, onDone });
  }

  function refreshTrade() {
    if (window.MarktapeTrade.refresh) window.MarktapeTrade.refresh();
  }

  let assetsAt = 0;
  async function ensureAssets() {
    const missing = Object.keys(state.prices).some((s) => !state.assets[s]);
    if (!missing || Date.now() - assetsAt < ASSETS_RETRY_MS) return;
    assetsAt = Date.now();
    try {
      const data = await getJSON('/api/assets');
      state.assets = data.assets || {};
      refreshTrade();
    } catch (_) { /* retry on a later tick */ }
  }

  let pricesBusy = false;
  async function tickPrices() {
    if (document.hidden || pricesBusy) return;
    pricesBusy = true;
    try {
      const data = await getJSON('/api/prices');
      state.prices = data.prices || {};
      await ensureAssets();
      maybeOpen();
      refreshTrade();
    } catch (_) { /* keep last prices */ } finally {
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
        refreshTrade();
      }
    } catch (_) { /* keep last holdings */ } finally {
      if (balancesFor === addr) balancesFor = null;
    }
  }

  window.addEventListener('marktape:wallet', (e) => {
    const next = e.detail.address || null;
    if (next === state.address) return;
    state.address = next;
    state.holdings = null;
    tickBalances();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tickPrices();
    tickBalances();
  });

  document.documentElement.classList.add('trd-lock');
  document.addEventListener('touchmove', (e) => {
    if (e.target.closest('.trd-tok-list, .trd-tok-sheet, .trd-info-sheet')) return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  tickPrices();
  tickBalances();
  setInterval(tickPrices, PRICE_MS);
  setInterval(tickBalances, BALANCE_MS);
})();
