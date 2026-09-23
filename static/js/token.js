(function () {
  const page = document.getElementById('token-page');
  if (!page) return;

  const SYMBOL = page.dataset.symbol;
  const MINT = page.dataset.mint;
  const MARK_PRICE = parseFloat(page.dataset.markPrice) || null;
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const DEFAULT_BUY_USD = 100;
  const QUOTE_FRESH_MS = 15000;
  const QUOTE_REFRESH_MS = 10000;

  let side = 'buy'; // buy: USDC -> PreStock, sell: PreStock -> USDC
  let lastQuote = null;
  let quoteFetchedAt = 0;
  let quoteTimer = null;
  let wallet = null;
  let range = '1D';

  const amountInput = document.getElementById('swap-amount');
  const unitLabel = document.getElementById('swap-unit');
  const unitFieldLabel = document.getElementById('swap-unit-label');
  const quoteBox = document.getElementById('quote-box');
  const confirmBtn = document.getElementById('confirm-swap-btn');
  const noteEl = document.getElementById('swap-note');
  const resultEl = document.getElementById('swap-result');
  const noRouteEl = document.getElementById('mkt-tk-noroute');
  const jupFallback = document.getElementById('jup-fallback-link');
  const connectBtn = document.getElementById('connect-wallet-btn');
  const walletSection = document.getElementById('wallet-section');
  const walletAddrEl = document.getElementById('wallet-address');
  const headerConnectBtn = document.getElementById('mkt-connect-btn');

  // ---- Side toggle -------------------------------------------------------
  function setSide(newSide) {
    side = newSide;
    document.querySelectorAll('.mkt-tk-side-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.side === side);
    });
    unitLabel.textContent = side === 'buy' ? 'USDC' : SYMBOL;
    unitFieldLabel.textContent = side === 'buy' ? 'USDC' : SYMBOL;
    amountInput.value = side === 'buy' ? DEFAULT_BUY_USD : '';
    noRouteEl.hidden = true;
    fetchQuote();
  }

  document.querySelectorAll('.mkt-tk-side-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSide(btn.dataset.side));
  });

  amountInput.addEventListener('input', () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Get quote';
    scheduleQuote();
  });

  function scheduleQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 400);
  }

  // ---- Quote ---------------------------------------------------------
  async function fetchQuote() {
    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0) {
      quoteBox.hidden = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Get quote';
      return;
    }
    if (!wallet) return;
    noteEl.textContent = '';
    noRouteEl.hidden = true;

    const inputMint = side === 'buy' ? USDC_MINT : MINT;
    const outputMint = side === 'buy' ? MINT : USDC_MINT;

    try {
      const resp = await fetch('/api/swap/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputMint, outputMint, uiAmount: amount, taker: wallet }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.transaction) {
        const deepLink = (data.detail && data.detail.deepLink) || data.deepLink;
        if (deepLink) {
          jupFallback.href = deepLink;
          noRouteEl.hidden = false;
        } else {
          noteEl.textContent = (data.detail && data.detail.message) || 'No route found.';
        }
        quoteBox.hidden = true;
        confirmBtn.disabled = true;
        confirmBtn.hidden = true;
        return;
      }

      lastQuote = data;
      quoteFetchedAt = Date.now();

      const outAmount = data.outAmount || data.outputAmount;
      const outDecimals = data.outputDecimals || 6;
      const outUi = outAmount ? Number(outAmount) / Math.pow(10, outDecimals) : null;

      document.getElementById('quote-output').textContent =
        outUi !== null ? `${outUi.toFixed(4)} ${side === 'buy' ? SYMBOL : 'USDC'}` : '—';
      document.getElementById('quote-impact').textContent =
        data.priceImpactPct ? `${(Number(data.priceImpactPct) * 100).toFixed(2)}%` : '—';

      const usdVal = data.swapUsdValue ? Number(data.swapUsdValue) : null;
      document.getElementById('quote-premium-after').textContent =
        usdVal && MARK_PRICE ? vsMarkLabel(usdVal, outUi) : '—';

      quoteBox.hidden = false;
      confirmBtn.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${SYMBOL}`;
    } catch (err) {
      console.error('quote failed', err);
      noteEl.textContent = 'Could not fetch a quote.';
      confirmBtn.disabled = true;
    }
  }

  function vsMarkLabel(usdVal, outUi) {
    if (!outUi || !MARK_PRICE) return '—';
    const impliedPrice = side === 'buy' ? usdVal / outUi : usdVal / parseFloat(amountInput.value || '1');
    const diff = (impliedPrice / MARK_PRICE - 1) * 100;
    const sign = diff > 0 ? '+' : '';
    return `paying ${sign}${diff.toFixed(1)}% ${diff > 0 ? 'rich' : 'cheap'}`;
  }

  setInterval(() => {
    if (lastQuote && Date.now() - quoteFetchedAt > QUOTE_FRESH_MS) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Refreshing…';
    }
  }, 1000);

  setInterval(() => {
    if (document.visibilityState === 'visible' && wallet) fetchQuote();
  }, QUOTE_REFRESH_MS);

  // ---- Wallet ---------------------------------------------------------
  function onWalletConnected(pubkey) {
    wallet = pubkey;
    const short = `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
    walletAddrEl.textContent = short;
    walletAddrEl.hidden = false;
    connectBtn.hidden = true;
    if (headerConnectBtn) {
      headerConnectBtn.textContent = short;
      headerConnectBtn.classList.add('connected');
    }
    fetchQuote();
  }

  connectBtn.addEventListener('click', async () => {
    if (!window.MarktapeWallet) return;
    const pubkey = await window.MarktapeWallet.connectWithPicker();
    if (!pubkey) return;
    onWalletConnected(pubkey);
  });

  if (headerConnectBtn) {
    headerConnectBtn.addEventListener('click', async () => {
      if (!window.MarktapeWallet) return;
      const pubkey = await window.MarktapeWallet.connectWithPicker();
      if (!pubkey) return;
      onWalletConnected(pubkey);
    });
  }

  confirmBtn.addEventListener('click', async () => {
    if (!lastQuote || !lastQuote.transaction || !wallet) return;
    if (Date.now() - quoteFetchedAt > QUOTE_FRESH_MS) {
      await fetchQuote();
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm in wallet…';
    try {
      const signed = await window.MarktapeWallet.signTransactionBase64(lastQuote.transaction);
      let signature = signed.signature;
      if (!signature && signed.signedTransactionBase64) {
        const execResp = await fetch('/api/swap/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signedTransaction: signed.signedTransactionBase64,
            requestId: lastQuote.requestId,
          }),
        });
        const execData = await execResp.json();
        signature = execData.signature;
      }
      if (signature) {
        resultEl.hidden = false;
        resultEl.innerHTML = `Done — <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">View on Solscan ↗</a>`;
        fetchQuote();
      } else {
        noteEl.textContent = 'Transaction did not confirm.';
      }
    } catch (err) {
      console.error('swap failed', err);
      noteEl.textContent = 'Swap cancelled or failed.';
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${SYMBOL}`;
    }
  });

  // ---- Copy chips -------------------------------------------------------
  document.getElementById('mint-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(e.currentTarget.dataset.mint);
    const el = e.currentTarget;
    const prev = el.textContent;
    el.textContent = 'Copied';
    setTimeout(() => { el.textContent = prev; }, 1200);
  });

  const mintFull = document.getElementById('mkt-tk-mint-full');
  if (mintFull) {
    mintFull.addEventListener('click', () => {
      navigator.clipboard.writeText(mintFull.textContent);
      const prev = mintFull.textContent;
      mintFull.textContent = 'Copied';
      setTimeout(() => { mintFull.textContent = prev; }, 1200);
    });
  }

  // ---- Chart --------------------------------------------------------
  const plot = document.getElementById('mkt-tk-plot');
  const noHistoryEl = document.getElementById('mkt-tk-no-history');
  const RANGE_LIMIT = { '1H': 12, '6H': 36, '1D': 48, '1W': 48, '1M': 48 };

  function renderChart(points) {
    plot.innerHTML = '';
    if (!points || points.length < 2) {
      noHistoryEl.hidden = false;
      return;
    }
    noHistoryEl.hidden = true;
    const w = 600, h = 220, pad = 8;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const stepX = (w - pad * 2) / (points.length - 1);
    const coords = points.map((p, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad * 2) * (1 - (p - min) / range);
      return [x, y];
    });
    const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
    const up = points[points.length - 1] >= points[0];
    const stroke = '#C9B89A';
    const fillColor = up ? '#8FA08A' : '#C48B84';

    const fillD = `${lineD} L${coords[coords.length - 1][0].toFixed(1)},${h - pad} L${coords[0][0].toFixed(1)},${h - pad} Z`;

    const ns = 'http://www.w3.org/2000/svg';
    const fillPath = document.createElementNS(ns, 'path');
    fillPath.setAttribute('d', fillD);
    fillPath.setAttribute('fill', fillColor);
    fillPath.setAttribute('opacity', '0.08');
    plot.appendChild(fillPath);

    const linePath = document.createElementNS(ns, 'path');
    linePath.setAttribute('d', lineD);
    linePath.setAttribute('fill', 'none');
    linePath.setAttribute('stroke', stroke);
    linePath.setAttribute('stroke-width', '1.5');
    plot.appendChild(linePath);
  }

  async function loadChart() {
    try {
      const resp = await fetch(`/api/sparkline/${SYMBOL}?limit=${RANGE_LIMIT[range] || 48}`);
      const data = await resp.json();
      renderChart((data.points || []).filter((p) => p !== null && p !== undefined));
    } catch (err) {
      console.error('sparkline failed', err);
      renderChart([]);
    }
  }

  document.querySelectorAll('.mkt-tk-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mkt-tk-range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      range = btn.dataset.range;
      loadChart();
    });
  });

  loadChart();
  setSide('buy');
})();
