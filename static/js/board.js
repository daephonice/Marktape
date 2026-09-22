(function () {
  const REFRESH_MS = 45000;

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
  }

  function buildRow(t) {
    const tr = document.createElement('tr');
    tr.className = 'board-row fade-refresh';
    tr.onclick = () => { window.location.href = `/t/${t.symbol}`; };
    tr.innerHTML = `
      <td class="col-symbol">
        ${t.image ? `<img class="row-logo" src="${t.image}" alt="" loading="lazy">` : ''}
        <span class="row-symbol">${t.symbol}</span>
        <span class="row-name">${t.name || ''}</span>
      </td>
      <td class="col-premium ${statusClass(t.premium)}">${fmtPremium(t.premium)}</td>
      <td class="col-price mono">${money(t.tokenPrice)}</td>
      <td class="col-price mono">${money(t.markPrice)}</td>
      <td class="col-val mono">${moneyBig(t.impliedValuation)}</td>
      <td class="col-val mono">${moneyBig(t.markValuation)}</td>
      <td class="col-supply mono">${t.supply ? Number(t.supply).toLocaleString() : '—'}</td>
    `;
    return tr;
  }

  async function refreshBoard() {
    try {
      const resp = await fetch('/api/board');
      if (!resp.ok) return;
      const snap = await resp.json();
      const tbody = document.querySelector('#board-table tbody');
      if (tbody && snap.tokens) {
        tbody.innerHTML = '';
        snap.tokens.forEach((t) => tbody.appendChild(buildRow(t)));
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
