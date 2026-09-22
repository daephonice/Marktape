(function () {
  const REFRESH_MS = 45000;
  const STALE_SECONDS = 120;

  function fmtPremium(p) {
    if (p === null || p === undefined) return '—';
    const pct = p * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  function statusClass(p) {
    if (p === null || p === undefined) return 'status-flat';
    if (p > 0) return 'status-rich';
    if (p < 0) return 'status-cheap';
    return 'status-flat';
  }

  function money(v) {
    if (v === null || v === undefined) return '—';
    return '$' + Number(v).toFixed(2);
  }

  function moneyBig(v) {
    if (!v) return '—';
    return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function renderTimeAgo(iso) {
    const el = document.getElementById('last-refresh');
    if (!el || !iso) return;
    const dt = new Date(iso);
    const secs = Math.max(0, Math.round((Date.now() - dt.getTime()) / 1000));
    el.textContent = secs < 5 ? 'updated just now' : `updated ${secs}s ago`;
    el.classList.toggle('stale', secs > STALE_SECONDS);
  }

  function buildRow(t) {
    const a = document.createElement('a');
    a.className = 'mkt-row fade-refresh';
    a.href = `/t/${t.symbol}`;
    a.innerHTML = `
      ${t.image ? `<img class="mkt-logo" src="${t.image}" alt="" loading="lazy">` : '<span class="mkt-logo mkt-logo-empty"></span>'}
      <span class="mkt-name">
        <span class="mkt-ticker">${t.symbol}</span>
        <span class="mkt-fullname">${t.name || ''}</span>
      </span>
      <span class="mkt-premium ${statusClass(t.premium)}">${fmtPremium(t.premium)}</span>
      <span class="mkt-tape-price">${money(t.tokenPrice)}</span>
      <span class="mkt-mark-price">${money(t.markPrice)}</span>
      <span class="mkt-implied">${moneyBig(t.impliedValuation)}</span>
      <span class="mkt-mobile-line">${money(t.tokenPrice)} tape · ${money(t.markPrice)} mark</span>
    `;
    return a;
  }

  function updateStrip(tokens) {
    const priced = tokens.filter((t) => t.premium !== null && t.premium !== undefined);
    const cheapestEl = document.querySelector('#mkt-strip-cheapest .mkt-strip-value');
    const richestEl = document.querySelector('#mkt-strip-richest .mkt-strip-value');
    const countEl = document.querySelector('#mkt-strip-count .mkt-strip-label');
    if (countEl) countEl.textContent = `${tokens.length} Names`;
    if (!priced.length) return;
    const cheapest = priced.reduce((a, b) => (a.premium < b.premium ? a : b));
    const richest = priced.reduce((a, b) => (a.premium > b.premium ? a : b));
    if (cheapestEl && cheapest.premium < 0) {
      cheapestEl.innerHTML = `${cheapest.symbol} <span class="status-cheap">${fmtPremium(cheapest.premium)}</span>`;
    }
    if (richestEl && richest.premium > 0) {
      richestEl.innerHTML = `${richest.symbol} <span class="status-rich">${fmtPremium(richest.premium)}</span>`;
    }
  }

  async function refreshBoard() {
    try {
      const resp = await fetch('/api/board');
      if (!resp.ok) return;
      const snap = await resp.json();
      const body = document.getElementById('mkt-tape-body');
      if (body && snap.tokens) {
        body.innerHTML = '';
        snap.tokens.forEach((t) => body.appendChild(buildRow(t)));
        updateStrip(snap.tokens);
      }
      if (snap.fetchedAt) {
        document.getElementById('last-refresh').dataset.fetchedAt = snap.fetchedAt;
        renderTimeAgo(snap.fetchedAt);
      }
    } catch (err) {
      console.warn('board refresh failed', err);
    }
  }

  setInterval(() => {
    const el = document.getElementById('last-refresh');
    renderTimeAgo(el ? el.dataset.fetchedAt : null);
  }, 5000);

  setInterval(refreshBoard, REFRESH_MS);

  const initialEl = document.getElementById('last-refresh');
  if (initialEl && initialEl.dataset.fetchedAt) renderTimeAgo(initialEl.dataset.fetchedAt);
})();
