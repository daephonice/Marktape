(function () {
  const page = document.getElementById('token-page');
  if (!page) return;

  const SYMBOL = page.dataset.symbol;
  const MINT = page.dataset.mint;
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const DEFAULT_BUY_USD = 100;
  const QUOTE_FRESH_MS = 15000;
  const QUOTE_REFRESH_MS = 10000;

  let side = 'buy'; // buy: USDC -> PreStock, sell: PreStock -> USDC
  let lastQuote = null;
  let quoteFetchedAt = 0;
  let quoteTimer = null;
  let wallet = null;

  const amountInput = document.getElementById('swap-amount');
  const unitLabel = document.getElementById('swap-unit');
  const quoteBox = document.getElementById('quote-box');
  const confirmBtn = document.getElementById('confirm-swap-btn');
  const noteEl = document.getElementById('swap-note');
  const resultEl = document.getElementById('swap-result');
  const jupFallback = document.getElementById('jup-fallback-link');
  const connectBtn = document.getElementById('connect-wallet-btn');
  const walletAddrEl = document.getElementById('wallet-address');

  function setSide(newSide) {
    side = newSide;
    document.querySelectorAll('.swap-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.side === side);
    });
    unitLabel.textContent = side === 'buy' ? 'USD' : SYMBOL;
    amountInput.value = side === 'buy' ? DEFAULT_BUY_USD : '';
    fetchQuote();
  }

  document.querySelectorAll('.swap-tab').forEach((btn) => {
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

  async function fetchQuote() {
    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0) {
      quoteBox.hidden = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Get quote';
      return;
    }
    if (!wallet) {
      noteEl.textContent = 'Connect a wallet to get a quote.';
      return;
    }
    noteEl.textContent = '';

    const inputMint = side === 'buy' ? USDC_MINT : MINT;
    const outputMint = side === 'buy' ? MINT : USDC_MINT;
    let uiAmount = amount;

    try {
      const resp = await fetch('/api/swap/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputMint, outputMint, uiAmount, taker: wallet }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.transaction) {
        noteEl.textContent = data.detail && data.detail.message ? data.detail.message : 'No route found.';
        const deepLink = (data.detail && data.detail.deepLink) || data.deepLink;
        if (deepLink) {
          jupFallback.href = deepLink;
          jupFallback.hidden = false;
        }
        quoteBox.hidden = true;
        confirmBtn.disabled = true;
        return;
      }

      lastQuote = data;
      quoteFetchedAt = Date.now();
      jupFallback.hidden = true;

      const outAmount = data.outAmount || data.outputAmount;
      const outDecimals = data.outputDecimals || (side === 'buy' ? 6 : 6);
      const outUi = outAmount ? Number(outAmount) / Math.pow(10, outDecimals) : null;

      document.getElementById('quote-output').textContent =
        outUi !== null ? `${outUi.toFixed(4)} ${side === 'buy' ? SYMBOL : 'USDC'}` : '—';
      document.getElementById('quote-price').textContent =
        data.swapUsdValue ? `$${Number(data.swapUsdValue).toFixed(2)}` : '—';
      document.getElementById('quote-impact').textContent =
        data.priceImpactPct ? `${(Number(data.priceImpactPct) * 100).toFixed(2)}%` : '—';
      document.getElementById('quote-route').textContent =
        (data.routePlan && data.routePlan[0] && data.routePlan[0].swapInfo && data.routePlan[0].swapInfo.label) || 'Jupiter';
      document.getElementById('quote-slippage').textContent =
        data.slippageBps ? `${(data.slippageBps / 100).toFixed(2)}%` : '—';
      document.getElementById('quote-premium-after').textContent = '—';

      quoteBox.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Confirm ${side === 'buy' ? 'Buy' : 'Sell'}`;
    } catch (err) {
      console.error('quote failed', err);
      noteEl.textContent = 'Could not fetch a quote.';
      confirmBtn.disabled = true;
    }
  }

  setInterval(() => {
    if (lastQuote && Date.now() - quoteFetchedAt > QUOTE_FRESH_MS) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Refreshing quote…';
    }
  }, 1000);

  setInterval(() => {
    if (document.visibilityState === 'visible' && wallet) fetchQuote();
  }, QUOTE_REFRESH_MS);

  connectBtn.addEventListener('click', async () => {
    const pubkey = await window.MarktapeWallet.connectWithPicker();
    if (!pubkey) return;
    wallet = pubkey;
    walletAddrEl.textContent = `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
    walletAddrEl.hidden = false;
    connectBtn.hidden = true;
    fetchQuote();
  });

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
        resultEl.innerHTML = `Done. <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">View on Solscan ↗</a>`;
        fetchQuote();
      } else {
        noteEl.textContent = 'Transaction did not confirm.';
      }
    } catch (err) {
      console.error('swap failed', err);
      noteEl.textContent = 'Swap cancelled or failed.';
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Confirm ${side === 'buy' ? 'Buy' : 'Sell'}`;
    }
  });

  document.getElementById('mint-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(e.target.dataset.mint);
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = e.target.dataset.mint; }, 1200);
  });

  document.getElementById('share-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    const btn = document.getElementById('share-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Share'; }, 1200);
  });

  setSide('buy');
})();
