/* Buy / Sell sheets for the token page (frontend only).
 *
 *   Buy  : pay in SOL or USDC, type an amount (device keyboard), quick amounts.
 *   Sell : receive SOL or USDC, pick a % of the holding (slider / - +).
 *
 * A token can't be paid / received in itself, so on the SOL page only USDC is
 * offered and on the USDC page only SOL.
 *
 * Host (token.js) calls MarktapeSwap.open({ side, symbol, getCtx, onDone }) where
 * getCtx() -> { address, holdings, prices, assets } (live state).
 * On success the sheet closes and the shared blue toast (send.js) shows
 * "Swap successful".
 *
 * TODO(swap-backend): executeSwap() is a stub that only simulates the wait.
 * Replace it with the Jupiter Ultra flow (/api/swap/order -> wallet sign ->
 * /api/swap/execute) once the site's Swap feature is integrated.
 */
(function () {
  'use strict';

  const ANIM_MS = 260;
  const SIM_MS = 1600;            // simulated swap time (stub)
  const PAY = ['SOL', 'USDC'];
  const LOGO = { SOL: '/static/img/sol.svg', USDC: '/static/img/usdc.svg' };
  const DEC = { SOL: 9, USDC: 6 };
  const QUICK = { SOL: [0.1, 0.5, 1], USDC: [10, 50, 100] };
  const SOL_RESERVE = 0.003;      // kept back for network fees / new token account
  const STEP = 5;                 // - / + step for the sell percentage
  const TOKEN_DEC = 9;

  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  // Truncates (never rounds up) to `dec` decimals, trailing zeros trimmed.
  function trunc(v, dec) {
    if (!(v > 0)) return '0';
    const [i, f = ''] = v.toFixed(Math.min(dec + 3, 20)).split('.');
    const frac = f.slice(0, dec).replace(/0+$/, '');
    return frac ? i + '.' + frac : i;
  }

  function fmtTok(v) {
    if (!(v > 0)) return '0';
    return trunc(v, v >= 1000 ? 2 : v >= 1 ? 4 : 8);
  }

  function sanitize(str, maxDec) {
    str = str.replace(',', '.').replace(/[^\d.]/g, '');
    const i = str.indexOf('.');
    if (i !== -1) str = str.slice(0, i + 1) + str.slice(i + 1).replace(/\./g, '').slice(0, maxDec);
    if (str.startsWith('.')) str = '0' + str;
    return str.replace(/^0+(?=\d)/, '').slice(0, 14);
  }

  // ---- DOM ------------------------------------------------------------------
  let root = null;
  const R = {};
  let S = null; // open session, null when closed

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'swp-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="swp-backdrop"></div>
      <div class="swp-sheet" role="dialog" aria-modal="true">
        <div class="snd-handle"></div>
        <h3 class="swp-title"></h3>
        <div class="swp-cur"></div>
        <p class="swp-bal"></p>
        <div class="swp-buy">
          <input class="swp-input" type="text" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="0" aria-label="Amount">
          <div class="swp-quick"></div>
        </div>
        <div class="swp-sell">
          <div class="swp-stepper">
            <button type="button" class="swp-step swp-minus" aria-label="Decrease">&minus;</button>
            <div class="swp-pct"></div>
            <button type="button" class="swp-step swp-plus" aria-label="Increase">+</button>
          </div>
          <input class="swp-range" type="range" min="0" max="100" step="1" aria-label="Amount to sell">
          <div class="swp-ticks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
        </div>
        <button type="button" class="snd-cta swp-cta"></button>
        <p class="swp-est"></p>
        <p class="swp-note" role="alert"></p>
      </div>`;
    document.body.appendChild(root);

    const q = (s) => root.querySelector(s);
    Object.assign(R, {
      backdrop: q('.swp-backdrop'), sheet: q('.swp-sheet'), title: q('.swp-title'), cur: q('.swp-cur'),
      bal: q('.swp-bal'), buy: q('.swp-buy'), input: q('.swp-input'), quick: q('.swp-quick'),
      sell: q('.swp-sell'), minus: q('.swp-minus'), plus: q('.swp-plus'), pct: q('.swp-pct'), range: q('.swp-range'),
      cta: q('.swp-cta'), est: q('.swp-est'), note: q('.swp-note'),
    });

    R.backdrop.addEventListener('click', () => { if (S && !S.busy) close(); });
    R.cur.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cur]');
      if (b && S && !S.busy) setCur(b.dataset.cur);
    });
    R.quick.addEventListener('click', (e) => {
      const b = e.target.closest('[data-amt]');
      if (!b || !S || S.busy) return;
      S.raw = b.dataset.amt;
      setNote('');
      render();
    });
    R.input.addEventListener('input', () => {
      S.raw = sanitize(R.input.value, DEC[S.cur]);
      R.input.value = S.raw;
      setNote('');
      render();
    });
    R.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !R.cta.disabled) R.cta.click(); });
    R.range.addEventListener('input', () => setPct(Number(R.range.value)));
    R.minus.addEventListener('click', () => setPct(S.pct - STEP));
    R.plus.addEventListener('click', () => setPct(S.pct + STEP));
    R.cta.addEventListener('click', doSwap);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S && !S.busy) close();
    });
    window.addEventListener('marktape:wallet', (e) => {
      if (S && e.detail.address !== S.address) close();
    });
    if (window.visualViewport) {
      const sync = () => {
        const vv = window.visualViewport;
        const kb = Math.round(window.innerHeight - vv.height - vv.offsetTop);
        root.style.setProperty('--swp-kb', (kb > 80 ? kb : 0) + 'px');
      };
      window.visualViewport.addEventListener('resize', sync);
      window.visualViewport.addEventListener('scroll', sync);
    }
  }

  // ---- State helpers ----------------------------------------------------------
  const payOptions = () => PAY.filter((s) => s !== S.symbol);
  const price = (c, sym) => (c.prices[sym] ? c.prices[sym].price : 0);

  function setNote(msg) { R.note.textContent = msg || ''; }

  function setCur(cur) {
    if (cur === S.cur) return;
    S.cur = cur;
    S.raw = '';
    setNote('');
    renderCur();
    renderQuick();
    render();
  }

  function setPct(v) {
    if (S.busy) return;
    S.pct = Math.max(0, Math.min(100, Math.round(v)));
    setNote('');
    render();
  }

  // ---- Render -------------------------------------------------------------------
  function renderCur() {
    const opts = payOptions();
    R.cur.classList.toggle('single', opts.length === 1);
    R.cur.textContent = '';
    opts.forEach((sym) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cur = sym;
      b.className = 'swp-cur-opt' + (sym === S.cur ? ' active' : '');
      const img = new Image();
      img.alt = '';
      img.src = LOGO[sym];
      b.appendChild(img);
      b.appendChild(document.createTextNode(sym));
      R.cur.appendChild(b);
    });
  }

  function renderQuick() {
    R.quick.textContent = '';
    QUICK[S.cur].forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swp-chip';
      b.dataset.amt = String(v);
      b.textContent = `${v} ${S.cur}`;
      R.quick.appendChild(b);
    });
  }

  function setCta(text, disabled, busy) {
    const b = R.cta;
    b.disabled = disabled;
    b.classList.toggle('busy', !!busy);
    if (busy) {
      if (b.dataset.busy !== '1') {
        b.dataset.busy = '1';
        b.innerHTML = `<span class="snd-dots"><i></i><i></i><i></i><i></i></span>${text}`;
      }
    } else {
      b.dataset.busy = '';
      if (b.textContent !== text) b.textContent = text;
    }
  }

  function buyCalc(c) {
    const bal = c.holdings[S.cur] || 0;
    const spendable = S.cur === 'SOL' ? Math.max(0, bal - SOL_RESERVE) : bal;
    const v = parseFloat(S.raw) || 0;
    const usdIn = v * price(c, S.cur);
    const tokPrice = price(c, S.symbol);
    return { bal, v, usdIn, out: tokPrice > 0 ? usdIn / tokPrice : 0, over: v > spendable + 1e-12 };
  }

  function sellCalc(c) {
    const bal = c.holdings[S.symbol] || 0;
    const amt = S.pct >= 100 ? bal : Math.floor(((bal * S.pct) / 100) * 10 ** TOKEN_DEC) / 10 ** TOKEN_DEC;
    const usdOut = amt * price(c, S.symbol);
    const curPrice = price(c, S.cur);
    return { bal, amt, usdOut, out: curPrice > 0 ? usdOut / curPrice : 0 };
  }

  function render() {
    if (!S) return;
    const c = S.host.getCtx();
    const buying = S.side === 'buy';
    R.buy.hidden = !buying;
    R.sell.hidden = buying;

    if (buying) {
      const d = buyCalc(c);
      R.bal.textContent = `Balance: ${trunc(d.bal, DEC[S.cur])} ${S.cur}`;
      if (R.input.value !== S.raw) R.input.value = S.raw;
      const len = S.raw.length;
      R.input.style.fontSize = len > 14 ? '32px' : len > 10 ? '42px' : '';
      R.quick.querySelectorAll('.swp-chip').forEach((b) => {
        b.classList.toggle('active', S.raw !== '' && parseFloat(S.raw) === parseFloat(b.dataset.amt));
      });
      if (S.busy) setCta('Buying', true, true);
      else if (!(d.v > 0)) setCta('Enter an amount', true);
      else if (d.over) setCta(`Insufficient ${S.cur} balance`, true);
      else setCta(`Buy with ${S.raw.replace(/\.$/, '')} ${S.cur}`, false);
      R.est.textContent = d.v > 0 && d.out > 0
        ? `You will receive ~${fmtTok(d.out)} ${S.symbol} ≈ ${usdFmt.format(d.usdIn)}`
        : `You will receive in ${S.symbol}`;
    } else {
      const d = sellCalc(c);
      R.bal.textContent = `Balance: ${trunc(d.bal, TOKEN_DEC)} ${S.symbol}`;
      R.pct.textContent = S.pct + '%';
      R.range.value = S.pct;
      R.range.style.setProperty('--pct', S.pct + '%');
      R.minus.disabled = S.busy || S.pct <= 0;
      R.plus.disabled = S.busy || S.pct >= 100;
      R.range.disabled = S.busy;
      if (S.busy) setCta('Selling', true, true);
      else if (!(d.amt > 0)) setCta('Select an amount', true);
      else setCta(`Sell ${trunc(d.amt, TOKEN_DEC)} ${S.symbol}`, false);
      R.est.textContent = d.amt > 0 && d.out > 0
        ? `You will receive ~${fmtTok(d.out)} ${S.cur} ≈ ${usdFmt.format(d.usdOut)}`
        : `You will receive in ${S.cur}`;
    }
  }

  // ---- Swap (stub) ----------------------------------------------------------------
  // TODO(swap-backend): replace with Jupiter Ultra order -> wallet sign -> execute.
  function executeSwap(/* order */) {
    return new Promise((resolve) => setTimeout(resolve, SIM_MS));
  }

  async function doSwap() {
    if (!S || S.busy || R.cta.disabled) return;
    const sess = S;
    sess.busy = true;
    setNote('');
    render();
    try {
      await executeSwap({ side: sess.side, symbol: sess.symbol, cur: sess.cur, amount: sess.side === 'buy' ? sess.raw : sess.pct });
      if (S !== sess) return;
      const host = sess.host;
      close();
      if (window.MarktapeSend && window.MarktapeSend.toast) window.MarktapeSend.toast('Swap successful');
      if (host.onDone) host.onDone();
    } catch (err) {
      if (S !== sess) return;
      sess.busy = false;
      setNote((err && err.message) || 'Swap failed, try again');
      render();
    }
  }

  // ---- Public ---------------------------------------------------------------------
  function close() {
    if (!S) return;
    S = null;
    R.input.blur();
    R.backdrop.classList.remove('open');
    R.sheet.classList.remove('open');
    document.documentElement.classList.remove('snd-lock');
    setTimeout(() => { if (!S) root.hidden = true; }, ANIM_MS + 40);
  }

  function open(host) {
    const c = host.getCtx();
    if (S || !c.address || !c.prices[host.symbol]) return;
    const cur = PAY.find((s) => s !== host.symbol);
    if (!c.prices[cur]) return;
    build();
    S = {
      host, address: c.address, side: host.side === 'sell' ? 'sell' : 'buy', symbol: host.symbol,
      cur, raw: '', pct: 25, busy: false,
    };
    R.title.textContent = `${S.side === 'buy' ? 'Buy' : 'Sell'} ${S.symbol}`;
    R.input.value = '';
    setNote('');
    renderCur();
    renderQuick();
    render();
    root.hidden = false;
    document.documentElement.classList.add('snd-lock');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!S) return;
      R.backdrop.classList.add('open');
      R.sheet.classList.add('open');
    }));
    if (S.side === 'buy') {
      setTimeout(() => { if (S && S.side === 'buy') R.input.focus({ preventScroll: true }); }, ANIM_MS + 40);
    }
  }

  window.MarktapeSwap = { open };
})();
