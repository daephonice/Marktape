/* Total balance (homepage). BNB + USDT + USDC held by the connected wallet,
 * valued in USD. Prices poll every 2s, holdings every 6s, so the total moves
 * with the market like a wallet app. Nothing polls until a wallet is connected. */
(function () {
  const PRICE_MS = 2000;
  const BALANCE_MS = 6000;
  const ASSETS = ['BNB', 'USDT', 'USDC'];

  const valueEl = document.getElementById('mkt-balance-value');
  const connectEl = document.getElementById('mkt-balance-connect');
  if (!valueEl || !connectEl) return;

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  let address = null;
  let prices = null;   // { BNB, USDT, USDC } in USD
  let holdings = null; // { BNB, USDT, USDC } in UI units
  let priceTimer = null;
  let balanceTimer = null;
  let gen = 0; // bumps on every wallet change so stale poll chains die

  function render() {
    if (!address) {
      valueEl.hidden = true;
      connectEl.hidden = false;
      return;
    }
    connectEl.hidden = true;
    valueEl.hidden = false;
    if (!prices || !holdings) {
      valueEl.textContent = '—';
      return;
    }
    const total = ASSETS.reduce((sum, a) => sum + (holdings[a] || 0) * (prices[a] || 0), 0);
    valueEl.textContent = usd.format(total);
  }

  async function getJSON(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    return resp.json();
  }

  async function pollPrices() {
    const g = gen;
    if (!address) return;
    if (!document.hidden) {
      try {
        const data = await getJSON('/api/prices');
        if (g === gen && ASSETS.every((a) => typeof data[a] === 'number')) {
          prices = data;
          render();
        }
      } catch (err) { /* keep last prices */ }
    }
    if (g === gen) priceTimer = setTimeout(pollPrices, PRICE_MS);
  }

  async function pollBalances() {
    const g = gen;
    const addr = address;
    if (!addr) return;
    if (!document.hidden) {
      try {
        const data = await getJSON(`/api/balances/${encodeURIComponent(addr)}`);
        if (g === gen && ASSETS.every((a) => typeof data[a] === 'number')) {
          holdings = data;
          render();
        }
      } catch (err) { /* keep last holdings */ }
    }
    if (g === gen) balanceTimer = setTimeout(pollBalances, BALANCE_MS);
  }

  function stop() {
    gen += 1;
    clearTimeout(priceTimer);
    clearTimeout(balanceTimer);
  }

  function setAddress(next) {
    if (next === address) return;
    stop();
    address = next;
    holdings = null;
    render();
    if (address) {
      pollPrices();
      pollBalances();
    }
  }

  window.addEventListener('marktape:wallet', (e) => setAddress(e.detail.address));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !address) return;
    stop();
    pollPrices();
    pollBalances();
  });

  connectEl.addEventListener('click', () => {
    if (window.MarktapeWallet) window.MarktapeWallet.connectWithPicker();
  });

  setAddress(window.MarktapeWallet ? window.MarktapeWallet.getAddress() : null);
})();
