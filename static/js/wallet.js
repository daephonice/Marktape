/* Wallet connect via the Wallet Standard — the real cross-wallet protocol
 * that Phantom, Solflare, Backpack, Jupiter, Trust Wallet, OKX, Coin98,
 * Glow, and every other modern Solana wallet register through. No adapter
 * library, no bundler: this is ~2 DOM events per the spec at
 * https://github.com/wallet-standard/wallet-standard.
 *
 * Discovery: wallets announce themselves by dispatching
 * "wallet-standard:register-wallet" (if they loaded before us) and by
 * listening for "wallet-standard:app-ready" (if they load after us). We do
 * both, so wallets are found regardless of load order.
 *
 * Fallback: any wallet that has NOT adopted the standard yet but still
 * injects a bare `window.solana`-shaped object is picked up as a last
 * resort so nothing regresses.
 */
(function () {
  const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  const discovered = new Map(); // wallet name -> standard Wallet object
  const STORAGE_KEY = 'mkt_wallet'; // remembered wallet so a page reload re-connects silently

  function emit(address) {
    window.dispatchEvent(new CustomEvent('marktape:wallet', { detail: { address } }));
  }

  function remember(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: state.kind, name: state.wallet ? state.wallet.name : null }));
    } catch (_) {}
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function getAddress() {
    const s = window.__marktapeWallet;
    if (!s) return null;
    return s.kind === 'standard' ? s.account.address : s.pubkey;
  }

  function setConnected(state) {
    window.__marktapeWallet = state;
    remember(state);
    const address = getAddress();
    emit(address);
    return address;
  }

  function isSolanaWallet(wallet) {
    return Array.isArray(wallet.chains) && wallet.chains.some((c) => c.startsWith('solana:'));
  }

  function registerIfSolana(wallet) {
    if (!wallet || !wallet.name || discovered.has(wallet.name)) return;
    if (!isSolanaWallet(wallet)) return;
    discovered.set(wallet.name, wallet);
  }

  function startDiscovery() {
    try {
      window.addEventListener('wallet-standard:register-wallet', (event) => {
        event.detail({ register: (...wallets) => wallets.forEach(registerIfSolana) });
      });
    } catch (err) {
      console.warn('wallet-standard register listener failed', err);
    }
    try {
      window.dispatchEvent(
        new CustomEvent('wallet-standard:app-ready', {
          detail: Object.freeze({ register: (...wallets) => wallets.forEach(registerIfSolana) }),
        })
      );
    } catch (err) {
      console.warn('wallet-standard app-ready dispatch failed', err);
    }
  }

  startDiscovery();

  function getStandardWallets() {
    return Array.from(discovered.values());
  }

  // Legacy fallback for the rare wallet that hasn't adopted the standard.
  function getLegacyProvider() {
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.backpack && window.backpack.isBackpack) return window.backpack;
    if (window.solana) return window.solana;
    return null;
  }

  function base64ToBytes(base64Tx) {
    return Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /* Returns a list the caller can present as a picker: [{name, icon, kind}].
   * kind 'standard' | 'legacy'. Call this right before showing a chooser so
   * late-registering wallets (loaded after page paint) are included. */
  function listAvailableWallets() {
    const list = getStandardWallets().map((w) => ({ name: w.name, icon: w.icon, kind: 'standard' }));
    if (!list.length && getLegacyProvider()) {
      list.push({ name: 'Solana Wallet', icon: null, kind: 'legacy' });
    }
    return list;
  }

  async function connectByName(name) {
    if (name) {
      const wallet = discovered.get(name);
      if (wallet) return connectStandardWallet(wallet);
    }
    return connectAny();
  }

  async function connectStandardWallet(wallet, silent) {
    const connectFeature = wallet.features && wallet.features['standard:connect'];
    if (!connectFeature) throw new Error(`${wallet.name} does not support standard:connect`);
    const { accounts } = await connectFeature.connect(silent ? { silent: true } : undefined);
    const account = (accounts || [])[0];
    if (!account) throw new Error(`${wallet.name} returned no account`);
    return setConnected({ kind: 'standard', wallet, account });
  }

  async function connectLegacy(silent) {
    const provider = getLegacyProvider();
    if (!provider) return null;
    const resp = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pubkey = (resp && resp.publicKey ? resp.publicKey : provider.publicKey).toString();
    return setConnected({ kind: 'legacy', provider, pubkey });
  }

  /* Silent re-connect on page load using the wallet remembered from the last
   * successful connect. Never opens a popup; if the wallet no longer trusts
   * this site the memory is dropped. Wallets can register a beat after page
   * load, so retry briefly before giving up. */
  async function autoConnect() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
    if (!saved) return null;
    for (let i = 0; i < 8; i++) {
      try {
        if (saved.kind === 'standard') {
          const wallet = discovered.get(saved.name);
          if (wallet) return await connectStandardWallet(wallet, true);
        } else if (getLegacyProvider()) {
          return await connectLegacy(true);
        }
      } catch (err) {
        forget();
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return null;
  }

  async function disconnect() {
    const state = window.__marktapeWallet;
    try {
      if (state && state.kind === 'standard') {
        const feature = state.wallet.features['standard:disconnect'];
        if (feature) await feature.disconnect();
      } else if (state && state.provider && state.provider.disconnect) {
        await state.provider.disconnect();
      }
    } catch (_) {}
    window.__marktapeWallet = null;
    forget();
    emit(null);
  }

  /* Connects to the single available wallet directly; if more than one is
   * installed, throws MultipleWalletsError so the caller can show a picker
   * (see listAvailableWallets) and retry with connectByName. */
  async function connectAny() {
    const wallets = getStandardWallets();
    if (wallets.length === 1) return connectStandardWallet(wallets[0]);
    if (wallets.length > 1) {
      const err = new Error('Multiple wallets available');
      err.code = 'MULTIPLE_WALLETS';
      err.wallets = wallets.map((w) => w.name);
      throw err;
    }
    const legacyPubkey = await connectLegacy();
    if (legacyPubkey) return legacyPubkey;
    throw new Error('No Solana wallet found');
  }

  async function connectWallet() {
    try {
      return await connectAny();
    } catch (err) {
      if (err && err.code === 'MULTIPLE_WALLETS') throw err; // let caller show a picker
      console.error('wallet connect failed', err);
      if (!getStandardWallets().length && !getLegacyProvider()) {
        alert('No Solana wallet found. Install a wallet such as Phantom, Solflare, Backpack, or Jupiter Mobile.');
      }
      return null;
    }
  }

  // ---- Built-in picker modal, used when more than one wallet is found ----
  function buildPickerModal(wallets) {
    const overlay = document.createElement('div');
    overlay.className = 'mkt-wallet-picker-overlay';
    const box = document.createElement('div');
    box.className = 'mkt-wallet-picker';
    box.innerHTML = `<div class="mkt-wallet-picker-title">Choose a wallet</div>`;
    wallets.forEach((w) => {
      const btn = document.createElement('button');
      btn.className = 'mkt-wallet-picker-item';
      btn.type = 'button';
      btn.innerHTML = `${w.icon ? `<img src="${w.icon}" alt="" class="mkt-wallet-picker-icon">` : '<span class="mkt-wallet-picker-icon mkt-wallet-picker-icon-empty"></span>'}<span>${w.name}</span>`;
      btn.addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('pick', { detail: w.name })));
      box.appendChild(btn);
    });
    const cancel = document.createElement('button');
    cancel.className = 'mkt-wallet-picker-cancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('pick', { detail: null })));
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.dispatchEvent(new CustomEvent('pick', { detail: null }));
    });
    return overlay;
  }

  function ensurePickerStyles() {
    if (document.getElementById('mkt-wallet-picker-styles')) return;
    const style = document.createElement('style');
    style.id = 'mkt-wallet-picker-styles';
    style.textContent = `
      .mkt-wallet-picker-overlay { position: fixed; inset: 0; background: rgba(11,17,24,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; }
      .mkt-wallet-picker { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; width: min(320px, 88vw); display: flex; flex-direction: column; gap: 8px; }
      .mkt-wallet-picker-title { font-family: 'Geist', sans-serif; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
      .mkt-wallet-picker-item { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-family: 'Geist', sans-serif; font-size: 13px; cursor: pointer; text-align: left; }
      .mkt-wallet-picker-item:hover { border-color: var(--accent); }
      .mkt-wallet-picker-icon { width: 22px; height: 22px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
      .mkt-wallet-picker-icon-empty { background: var(--surface-2); display: inline-block; }
      .mkt-wallet-picker-cancel { margin-top: 4px; background: transparent; border: none; color: var(--dim); font-family: 'Geist', sans-serif; font-size: 12px; cursor: pointer; padding: 6px; }
      .mkt-wallet-picker-cancel:hover { color: var(--text); }
    `;
    document.head.appendChild(style);
  }

  /* Preferred entry point for UI code: handles the single-wallet case
   * directly and shows a picker automatically when more than one wallet
   * is available. Returns the connected pubkey, or null if cancelled /
   * unavailable. */
  async function connectWithPicker() {
    try {
      return await connectAny();
    } catch (err) {
      if (!err || err.code !== 'MULTIPLE_WALLETS') {
        console.error('wallet connect failed', err);
        if (!getStandardWallets().length && !getLegacyProvider()) {
          alert('No Solana wallet found. Install a wallet such as Phantom, Solflare, Backpack, or Jupiter Mobile.');
        }
        return null;
      }
    }

    ensurePickerStyles();
    const wallets = listAvailableWallets();
    const overlay = buildPickerModal(wallets);
    document.body.appendChild(overlay);

    const chosenName = await new Promise((resolve) => {
      overlay.addEventListener('pick', (e) => resolve(e.detail), { once: true });
    });
    overlay.remove();
    if (!chosenName) return null;

    try {
      return await connectByName(chosenName);
    } catch (err) {
      console.error('wallet connect failed', err);
      return null;
    }
  }

  async function signTransactionBase64(base64Tx) {
    const state = window.__marktapeWallet;
    if (!state) throw new Error('Wallet not connected');
    const raw = base64ToBytes(base64Tx);

    if (state.kind === 'standard') {
      const { wallet, account } = state;
      const chain = (wallet.chains || []).find((c) => SOLANA_CHAINS.includes(c)) || 'solana:mainnet';

      const sendFeature = wallet.features['solana:signAndSendTransaction'];
      if (sendFeature) {
        const results = await sendFeature.signAndSendTransaction({ account, transaction: raw, chain });
        const first = (results || [])[0];
        if (first && first.signature) {
          const sig = typeof first.signature === 'string' ? first.signature : bytesToBase64(first.signature);
          return { signature: sig };
        }
      }

      const signFeature = wallet.features['solana:signTransaction'];
      if (signFeature) {
        const results = await signFeature.signTransaction({ account, transaction: raw, chain });
        const first = (results || [])[0];
        if (first && first.signedTransaction) {
          return { signedTransactionBase64: bytesToBase64(first.signedTransaction) };
        }
      }
      throw new Error(`${wallet.name} does not support signing`);
    }

    // Legacy path (pre-standard provider).
    const provider = state.provider;
    if (provider.signAndSendTransaction) {
      const result = await provider.signAndSendTransaction({ serialize: () => raw }, { encoding: 'base64', message: base64Tx });
      if (result && result.signature) return { signature: result.signature };
    }
    if (provider.signTransaction) {
      const signed = await provider.signTransaction({ serialize: () => raw, message: { serialize: () => raw } });
      const signedBytes = signed.serialize ? signed.serialize() : raw;
      return { signedTransactionBase64: bytesToBase64(signedBytes) };
    }
    throw new Error('Wallet does not support signing');
  }

  function bytesToBase58(bytes) {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let out = '';
    while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
    return out;
  }

  /* Sign only, never broadcast: the server relays through its own RPC.
   * Resolves { signedTransactionBase64 }, or { signature } (base58) for a
   * wallet that can only sign-and-send itself. */
  async function signTransactionForSend(base64Tx) {
    const state = window.__marktapeWallet;
    if (!state) throw new Error('Wallet not connected');
    if (state.kind !== 'standard') throw new Error('This wallet is not supported for sending');
    const { wallet, account } = state;
    const raw = base64ToBytes(base64Tx);
    const chain = SOLANA_CHAINS.find((c) => (wallet.chains || []).includes(c)) || 'solana:mainnet';

    const signFeature = wallet.features['solana:signTransaction'];
    if (signFeature) {
      const results = await signFeature.signTransaction({ account, transaction: raw, chain });
      const first = (results || [])[0];
      if (first && first.signedTransaction) return { signedTransactionBase64: bytesToBase64(first.signedTransaction) };
    }
    const sendFeature = wallet.features['solana:signAndSendTransaction'];
    if (sendFeature) {
      const results = await sendFeature.signAndSendTransaction({ account, transaction: raw, chain });
      const first = (results || [])[0];
      if (first && first.signature) return { signature: bytesToBase58(first.signature) };
    }
    throw new Error(`${wallet.name} does not support signing`);
  }

  window.MarktapeWallet = {
    connectWallet,
    connectWithPicker,
    connectByName,
    listAvailableWallets,
    signTransactionBase64,
    signTransactionForSend,
    getAddress,
    disconnect,
    getProvider: getLegacyProvider, // kept for back-compat with older callers
  };

  // ---- Header connect button: one place, every page --------------------
  (function initHeaderButton() {
    const btn = document.getElementById('mkt-connect-btn');
    if (!btn) return;
    const idleLabel = btn.textContent;
    function paint(address) {
      if (address) {
        btn.textContent = `${address.slice(0, 4)}…${address.slice(-4)}`;
        btn.classList.add('connected');
      } else {
        btn.textContent = idleLabel;
        btn.classList.remove('connected');
      }
    }
    window.addEventListener('marktape:wallet', (e) => paint(e.detail.address));
    btn.addEventListener('click', async () => {
      if (getAddress()) {
        if (window.confirm('Disconnect wallet?')) await disconnect();
        return;
      }
      await connectWithPicker();
    });
    paint(getAddress());
  })();

  autoConnect();
})();
