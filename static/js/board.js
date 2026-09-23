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

  function renderTimeAgo(iso) {
    const el = document.getElementById('last-refresh');
    if (!el || !iso) return;
    const dt = new Date(iso);
    const secs = Math.max(0, Math.round((Date.now() - dt.getTime()) / 1000));
    el.textContent = secs < 5 ? 'updated just now' : `updated ${secs}s ago`;
    el.classList.toggle('stale', secs > STALE_SECONDS);
  }

  // ---- Sparklines --------------------------------------------------------
  function buildPolyline(points, rich) {
    if (!points || points.length < 2) return '';
    const w = 300, h = 72, pad = 6;
    const min = Math.min(...points), max = Math.max(...points);
    const range = max - min || 1;
    const step = (w - pad * 2) / (points.length - 1);
    const coords = points.map((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return coords.join(' ');
  }

  async function loadSparkline(svg) {
    const symbol = svg.dataset.symbol;
    try {
      const resp = await fetch(`/api/sparkline/${symbol}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const pts = data.points || [];
      if (pts.length < 2) return;
      const rich = pts[pts.length - 1] >= pts[0];
      const poly = buildPolyline(pts, rich);
      if (!poly) return;
      const existing = svg.querySelector('.mkt-sparkline-line');
      if (existing) existing.remove();
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      el.setAttribute('points', poly);
      el.setAttribute('class', `mkt-sparkline-line ${rich ? 'status-rich-stroke' : 'status-cheap-stroke'}`);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-width', '1.6');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(el);
    } catch (err) {
      console.warn('sparkline failed for', symbol, err);
    }
  }

  function loadAllSparklines() {
    document.querySelectorAll('.mkt-sparkline').forEach(loadSparkline);
  }

  // ---- Cards --------------------------------------------------------------
  function buildCard(t) {
    const div = document.createElement('div');
    div.className = 'mkt-card fade-refresh';
    div.dataset.symbol = t.symbol;
    div.dataset.name = (t.name || '').toLowerCase();
    div.innerHTML = `
      <div class="mkt-card-top">
        ${t.image ? `<img class="mkt-card-logo" src="${t.image}" alt="" loading="lazy">` : '<span class="mkt-card-logo mkt-logo-empty"></span>'}
        <div class="mkt-card-heading">
          <span class="mkt-card-ticker">${t.symbol}</span>
          <span class="mkt-card-name">${t.name || ''}</span>
        </div>
        <span class="mkt-card-premium ${statusClass(t.premium)}">${fmtPremium(t.premium)}</span>
      </div>
      <div class="mkt-card-prices">
        <div class="mkt-card-price-cell">
          <span class="mkt-card-price-label">Tape</span>
          <span class="mkt-card-price-value">${money(t.tokenPrice)}</span>
        </div>
        <div class="mkt-card-price-cell mkt-card-price-cell-mark">
          <span class="mkt-card-price-label">Mark</span>
          <span class="mkt-card-price-value mkt-card-price-muted">${money(t.markPrice)}</span>
        </div>
      </div>
      <div class="mkt-card-chart">
        <svg class="mkt-sparkline" data-symbol="${t.symbol}" viewBox="0 0 300 72" preserveAspectRatio="none">
          <line x1="0" y1="36" x2="300" y2="36" class="mkt-sparkline-mid"></line>
        </svg>
      </div>
      <a href="/t/${t.symbol}" class="mkt-trade-btn">Trade ${t.symbol}</a>
    `;
    return div;
  }

  async function refreshBoard() {
    try {
      const resp = await fetch('/api/board');
      if (!resp.ok) return;
      const snap = await resp.json();
      const grid = document.getElementById('mkt-cards');
      if (grid && snap.tokens) {
        const query = (document.getElementById('mkt-search') || {}).value || '';
        grid.innerHTML = '';
        snap.tokens.forEach((t) => grid.appendChild(buildCard(t)));
        applySearch(query);
        loadAllSparklines();
      }
      if (snap.fetchedAt) {
        document.getElementById('last-refresh').dataset.fetchedAt = snap.fetchedAt;
        renderTimeAgo(snap.fetchedAt);
      }
    } catch (err) {
      console.warn('board refresh failed', err);
    }
  }

  // ---- Search ---------------------------------------------------------
  function applySearch(rawQuery) {
    const query = (rawQuery || '').trim().toLowerCase();
    const cards = document.querySelectorAll('.mkt-card');
    let visible = 0;
    cards.forEach((card) => {
      const match = !query || card.dataset.symbol.toLowerCase().includes(query) || card.dataset.name.includes(query);
      card.hidden = !match;
      if (match) visible += 1;
    });
    const noResults = document.getElementById('mkt-no-results');
    if (noResults) noResults.hidden = visible !== 0 || cards.length === 0;
  }

  const searchInput = document.getElementById('mkt-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => applySearch(e.target.value));
  }

  // ---- Wallet connect button in header ---------------------------------
  const connectBtn = document.getElementById('mkt-connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      if (!window.MarktapeWallet) return;
      const pubkey = await window.MarktapeWallet.connectWithPicker();
      if (!pubkey) return;
      connectBtn.textContent = `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
      connectBtn.classList.add('connected');
    });
  }

  setInterval(() => {
    const el = document.getElementById('last-refresh');
    renderTimeAgo(el ? el.dataset.fetchedAt : null);
  }, 5000);

  setInterval(refreshBoard, REFRESH_MS);

  const initialEl = document.getElementById('last-refresh');
  if (initialEl && initialEl.dataset.fetchedAt) renderTimeAgo(initialEl.dataset.fetchedAt);

  loadAllSparklines();
})();
