/* Lend desk — mock isolated vaults for the 8 PreStocks names. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const pctFmt = (v) => (v * 100).toFixed(1) + '%';

  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v > 0 && v < 0.005) return '<$0.01';
    return usd.format(v);
  }
  function fmtAmt(v) {
    if (!(v > 0)) return '0';
    const max = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
    return v.toLocaleString('en-US', { maximumFractionDigits: max });
  }
  function fmtPx(v) {
    if (!(v > 0)) return '—';
    return v >= 1 ? usd.format(v) : '$' + v.toFixed(4);
  }
  function fmtApy(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v * 100).toFixed(2) + '%';
  }
  function sanitize(str) {
    str = String(str || '').replace(',', '.').replace(/[^\d.]/g, '');
    const i = str.indexOf('.');
    if (i !== -1) str = str.slice(0, i + 1) + str.slice(i + 1).replace(/\./g, '').slice(0, 8);
    if (str.startsWith('.')) str = '0' + str;
    return str.replace(/^0+(?=\d)/, '').slice(0, 16);
  }
  function num(el) {
    const n = parseFloat((el && el.value) || '');
    return isFinite(n) ? n : 0;
  }

  const root = $('lend-page');
  const state = {
    address: null,
    vaults: [],
    positions: [],
    holdings: {},
    prices: {},
    assets: {},
    debtFilter: 'ALL',
    tab: 'markets',
    symbol: (root && root.dataset.symbol) || '',
    debt: 'USDC',
    act: 'deposit',
    busy: false,
  };

  function toast(text) {
    if (window.MarktapeSend && window.MarktapeSend.toast) window.MarktapeSend.toast(text);
  }

  function logo(sym, size) {
    const meta = state.assets[sym] || {};
    const wrap = document.createElement('span');
    wrap.className = 'hm-logo-wrap';
    wrap.style.width = wrap.style.height = (size || 36) + 'px';
    if (meta.image) {
      const img = document.createElement('img');
      img.className = 'hm-logo';
      img.alt = '';
      img.src = meta.image;
      img.addEventListener('error', () => img.remove());
      wrap.appendChild(img);
    }
    return wrap;
  }

  function healthClass(h) {
    if (h === 'Risky') return 'risk';
    if (h === 'Very Risky') return 'bad';
    return 'ok';
  }

  async function jget(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('request failed');
    return r.json();
  }
  async function jpost(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      const d = data && data.detail;
      throw new Error(typeof d === 'string' ? d : (d && d.message) || 'Failed');
    }
    return data;
  }

  function vaultOf(sym, debt) {
    return state.vaults.find((v) => v.collateralSymbol === sym && v.debtSymbol === debt);
  }
  function posOf(sym, debt) {
    return state.positions.find((p) => p.collateralSymbol === sym && p.debtSymbol === debt && p.status !== 'closed');
  }

  function paintMarkets() {
    const list = $('lend-market-list');
    const empty = $('lend-market-empty');
    if (!list) return;
    const rows = state.vaults.filter((v) => state.debtFilter === 'ALL' || v.debtSymbol === state.debtFilter);
    list.textContent = '';
    if (!rows.length) {
      empty.hidden = false;
      empty.textContent = state.vaults.length ? 'No markets' : 'Loading…';
      return;
    }
    empty.hidden = true;
    rows.forEach((v) => {
      const a = document.createElement('a');
      a.className = 'lend-row';
      a.href = '/lend/' + v.collateralSymbol + '?debt=' + v.debtSymbol;
      a.appendChild(logo(v.collateralSymbol, 36));
      const mid = document.createElement('div');
      mid.className = 'lend-row-mid';
      mid.innerHTML = '<b>' + v.collateralSymbol + '</b><small>' + (v.name || '') + '</small>';
      a.appendChild(mid);
      const side = document.createElement('div');
      side.className = 'lend-row-side';
      side.innerHTML = '<b>' + pctFmt(v.ltv) + ' LTV</b><small>' + v.debtSymbol + ' · ' + fmtApy(v.borrowApy) + '</small>';
      a.appendChild(side);
      list.appendChild(a);
    });

    let tvl = 0, borrowed = 0, yours = 0;
    state.vaults.forEach((v) => {
      tvl += (v.totalSupplied || 0) * (v.collateralPrice || 0);
      borrowed += (v.totalBorrowed || 0) * (v.debtPrice || 0);
    });
    state.positions.forEach((p) => { yours += p.debtUsd || 0; });
    $('lend-tvl').textContent = fmtUsd(tvl);
    $('lend-borrowed').textContent = fmtUsd(borrowed);
    $('lend-your-debt').textContent = fmtUsd(yours);
  }

  function paintPortfolio() {
    const list = $('lend-pos-list');
    const empty = $('lend-pos-empty');
    const open = state.positions.filter((p) => p.status !== 'closed' && (p.colAmount > 0 || p.debtAmount > 0));
    list.textContent = '';
    empty.hidden = open.length > 0;
    if (!state.address) {
      empty.hidden = false;
      empty.querySelector('p').textContent = 'Connect wallet';
    } else if (!open.length) {
      empty.querySelector('p').textContent = 'No positions yet';
    }
    open.forEach((p) => {
      const a = document.createElement('a');
      a.className = 'lend-row';
      a.href = '/lend/' + p.collateralSymbol + '?debt=' + p.debtSymbol;
      a.appendChild(logo(p.collateralSymbol, 36));
      const mid = document.createElement('div');
      mid.className = 'lend-row-mid';
      mid.innerHTML = '<b>' + fmtAmt(p.colAmount) + ' ' + p.collateralSymbol + '</b><small>' + fmtAmt(p.debtAmount) + ' ' + p.debtSymbol + '</small>';
      a.appendChild(mid);
      const side = document.createElement('div');
      side.className = 'lend-row-side';
      const h = document.createElement('b');
      h.className = healthClass(p.health);
      h.textContent = p.health;
      side.appendChild(h);
      const sm = document.createElement('small');
      sm.textContent = pctFmt(p.ratio) + ' / ' + pctFmt(p.liquidationThreshold);
      side.appendChild(sm);
      a.appendChild(side);
      list.appendChild(a);
    });
  }

  function setTab(tab) {
    state.tab = tab;
    $('tab-markets').classList.toggle('on', tab === 'markets');
    $('tab-portfolio').classList.toggle('on', tab === 'portfolio');
    $('lend-filters').hidden = tab !== 'markets';
    $('lend-market-list').hidden = tab !== 'markets';
    $('lend-market-empty').hidden = tab !== 'markets' || !!state.vaults.length;
    $('lend-port').hidden = tab !== 'portfolio';
    if (tab === 'portfolio') paintPortfolio();
  }

  function available(sym) {
    return state.holdings[sym] || 0;
  }

  function paintVault() {
    const v = vaultOf(state.symbol, state.debt);
    const p = posOf(state.symbol, state.debt);
    if (!v) return;
    $('lend-title').textContent = state.symbol;
    $('vault-sym').textContent = state.symbol;
    $('vault-name').textContent = v.name || state.symbol;
    const logoWrap = $('vault-logo');
    logoWrap.textContent = '';
    logoWrap.appendChild(logo(state.symbol, 40));
    Array.from($('debt-toggle').querySelectorAll('.lend-chip')).forEach((b) => {
      b.classList.toggle('on', b.dataset.debt === state.debt);
    });
    $('tok-col').textContent = state.symbol;
    $('tok-debt').textContent = state.debt;

    const ratio = p ? p.ratio : 0;
    const lt = v.liquidationThreshold;
    const health = p ? p.health : 'Safe';
    $('pos-col').textContent = p ? fmtAmt(p.colAmount) + ' · ' + fmtUsd(p.colUsd) : '0';
    $('pos-debt').textContent = p ? fmtAmt(p.debtAmount) + ' · ' + fmtUsd(p.debtUsd) : '0';
    const hEl = $('pos-health');
    hEl.textContent = health;
    hEl.className = healthClass(health);
    const frac = lt > 0 ? Math.min(1, ratio / lt) : 0;
    $('pos-bar').style.width = (frac * 100).toFixed(1) + '%';
    $('pos-bar').className = healthClass(health);
    $('pos-ratio').textContent = pctFmt(ratio);
    $('pos-lt').textContent = 'Max LT ' + pctFmt(lt);
    $('pos-max').textContent = fmtUsd(p ? p.maxBorrowUsd : 0);
    $('pos-liq').textContent = p && p.liquidationPrice ? fmtPx(p.liquidationPrice) : '—';
    const tape = fmtPx(v.collateralPrice);
    const mark = v.mark ? fmtPx(v.mark) : '—';
    $('pos-tape').textContent = tape + ' / ' + mark;

    const act = state.act;
    const showCol = act === 'deposit' || act === 'withdraw' || act === 'both';
    const showDebt = act === 'borrow' || act === 'repay' || act === 'both';
    $('field-col').hidden = !showCol;
    $('field-debt').hidden = !showDebt;
    $('lab-col').textContent = act === 'withdraw' ? 'Withdraw' : 'Deposit';
    $('lab-debt').textContent = act === 'repay' ? 'Repay' : 'Borrow';
    $('act-liq').hidden = !(p && p.status === 'liquidatable');

    paintCta();
  }

  function signedDeltas() {
    const act = state.act;
    let col = 0, debt = 0;
    if (act === 'deposit') col = num($('amt-col'));
    else if (act === 'withdraw') col = -num($('amt-col'));
    else if (act === 'borrow') debt = num($('amt-debt'));
    else if (act === 'repay') debt = -num($('amt-debt'));
    else {
      col = num($('amt-col'));
      debt = num($('amt-debt'));
    }
    return { col, debt };
  }

  function paintCta() {
    const btn = $('act-cta');
    const { col, debt } = signedDeltas();
    if (!state.address) {
      btn.disabled = false;
      btn.textContent = 'Connect wallet';
      $('act-preview').textContent = 'Paper market. Connect to open a position.';
      return;
    }
    if (state.busy) {
      btn.disabled = true;
      btn.textContent = 'Working…';
      return;
    }
    if (col === 0 && debt === 0) {
      btn.disabled = true;
      btn.textContent = 'Enter an amount';
      $('act-preview').textContent = 'Demo book · wallet is not debited on-chain.';
      return;
    }
    btn.disabled = false;
    const v = vaultOf(state.symbol, state.debt);
    const labels = { deposit: 'Deposit ' + state.symbol, withdraw: 'Withdraw ' + state.symbol, borrow: 'Borrow ' + state.debt, repay: 'Repay ' + state.debt, both: 'Deposit & Borrow' };
    btn.textContent = labels[state.act] || 'Confirm';
    const p = posOf(state.symbol, state.debt);
    const colAmt = (p ? p.colAmount : 0) + col;
    const debtAmt = (p ? p.debtAmount : 0) + debt;
    const colUsd = colAmt * ((v && v.collateralPrice) || 0);
    const debtUsd = debtAmt * ((v && v.debtPrice) || 0);
    const ratio = colUsd > 0 ? debtUsd / colUsd : 0;
    $('act-preview').textContent = 'Health preview ' + pctFmt(ratio) + ' / LT ' + pctFmt(v ? v.liquidationThreshold : 0);
  }

  async function submit() {
    if (!state.address) {
      if (window.MarktapeWallet) window.MarktapeWallet.connectWithPicker();
      return;
    }
    const { col, debt } = signedDeltas();
    if (col === 0 && debt === 0) return;
    state.busy = true;
    paintCta();
    try {
      const res = await jpost('/api/lend/operate', {
        signer: state.address,
        collateralSymbol: state.symbol,
        debtSymbol: state.debt,
        colAmount: col,
        debtAmount: debt,
      });
      toast((res.receipt && res.receipt.label) || 'Demo tx');
      $('amt-col').value = '';
      $('amt-debt').value = '';
      await loadPositions();
      await loadHoldings();
      await loadVaults();
      paintVault();
    } catch (err) {
      $('act-preview').textContent = err.message || 'Failed';
    } finally {
      state.busy = false;
      paintCta();
    }
  }

  async function doLiq() {
    if (!state.address) return;
    try {
      await jpost('/api/lend/liquidate', {
        wallet: state.address,
        collateralSymbol: state.symbol,
        debtSymbol: state.debt,
      });
      toast('Liquidated (demo)');
      await loadPositions();
      await loadHoldings();
      paintVault();
    } catch (err) {
      $('act-preview').textContent = err.message || 'Failed';
    }
  }

  async function loadVaults() {
    const data = await jget('/api/lend/vaults');
    state.vaults = data.vaults || [];
  }
  async function loadPositions() {
    if (!state.address) { state.positions = []; return; }
    const data = await jget('/api/lend/positions?user=' + encodeURIComponent(state.address));
    state.positions = data.positions || [];
  }
  async function loadHoldings() {
    if (!state.address) { state.holdings = {}; return; }
    try {
      const data = await jget('/api/balances/' + encodeURIComponent(state.address));
      state.holdings = data.holdings || {};
    } catch (_) { state.holdings = {}; }
  }
  async function loadMeta() {
    try {
      const [p, a] = await Promise.all([jget('/api/prices'), jget('/api/assets')]);
      state.prices = (p && p.prices) || {};
      state.assets = (a && a.assets) || {};
    } catch (_) {}
  }

  function showVault(on) {
    $('lend-markets').hidden = on;
    $('lend-vault').hidden = !on;
    const back = $('lend-back');
    if (on) {
      back.href = '/lend';
      back.setAttribute('aria-label', 'Back');
      back.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19 5 12l7-7"/><path d="M19 12H5"/></svg>';
    }
  }

  function bind() {
    $('tab-markets').addEventListener('click', () => setTab('markets'));
    $('tab-portfolio').addEventListener('click', () => setTab('portfolio'));
    $('lend-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-debt]');
      if (!b) return;
      state.debtFilter = b.dataset.debt;
      Array.from($('lend-filters').children).forEach((c) => c.classList.toggle('on', c === b));
      paintMarkets();
    });
    $('debt-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('[data-debt]');
      if (!b) return;
      state.debt = b.dataset.debt;
      history.replaceState(null, '', '/lend/' + state.symbol + '?debt=' + state.debt);
      paintVault();
    });
    $('act-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      state.act = b.dataset.act;
      Array.from($('act-tabs').children).forEach((c) => c.classList.toggle('on', c === b));
      paintVault();
    });
    ['amt-col', 'amt-debt'].forEach((id) => {
      $(id).addEventListener('input', () => {
        $(id).value = sanitize($(id).value);
        paintCta();
      });
    });
    $('max-col').addEventListener('click', () => {
      if (state.act === 'withdraw') {
        const p = posOf(state.symbol, state.debt);
        $('amt-col').value = p ? String(p.colAmount) : '0';
      } else {
        const have = available(state.symbol);
        $('amt-col').value = have > 0 ? String(have) : '1';
      }
      paintCta();
    });
    $('max-debt').addEventListener('click', () => {
      const p = posOf(state.symbol, state.debt);
      const v = vaultOf(state.symbol, state.debt);
      if (state.act === 'repay') {
        $('amt-debt').value = p ? String(p.debtAmount) : '0';
      } else {
        const px = v && v.debtPrice;
        const maxUsd = p ? p.maxBorrowUsd : 0;
        $('amt-debt').value = px > 0 ? String(+(maxUsd / px).toPrecision(8)) : '0';
      }
      paintCta();
    });
    $('act-cta').addEventListener('click', submit);
    $('act-liq').addEventListener('click', doLiq);
  }

  async function boot() {
    bind();
    const q = new URLSearchParams(location.search);
    if (q.get('debt') === 'SOL' || q.get('debt') === 'USDC') state.debt = q.get('debt');
    showVault(!!state.symbol);
    await loadMeta();
    await loadVaults();
    paintMarkets();
    window.addEventListener('marktape:wallet', async (e) => {
      state.address = (e.detail && e.detail.address) || null;
      await loadHoldings();
      await loadPositions();
      paintMarkets();
      if (state.tab === 'portfolio') paintPortfolio();
      if (state.symbol) paintVault();
    });
    if (window.MarktapeWallet && window.MarktapeWallet.getAddress()) {
      state.address = window.MarktapeWallet.getAddress();
      await loadHoldings();
      await loadPositions();
      paintMarkets();
    }
    if (state.symbol) paintVault();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
