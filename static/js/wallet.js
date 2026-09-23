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

  async function connectStandardWallet(wallet) {
    const connectFeature = wallet.features && wallet.features['standard:connect'];
    if (!connectFeature) throw new Error(`${wallet.name} does not support standard:connect`);
    const { accounts } = await connectFeature.connect();
    const account = (accounts || [])[0];
    if (!account) throw new Error(`${wallet.name} returned no account`);
    window.__marktapeWallet = { kind: 'standard', wallet, account };
    return account.address;
  }

  async function connectLegacy() {
    const provider = getLegacyProvider();
    if (!provider) return null;
    const resp = await provider.connect();
    const pubkey = (resp && resp.publicKey ? resp.publicKey : provider.publicKey).toString();
    window.__marktapeWallet = { kind: 'legacy', provider, pubkey };
    return pubkey;
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
      .mkt-wallet-picker-overlay { position: fixed; inset: 0; background: rgba(14,15,12,0.7); display: flex; align-items: center; justify-content: center; z-index: 1000; }
      .mkt-wallet-picker { background: #161714; border: 1px solid #2A2B27; border-radius: 12px; padding: 16px; width: min(320px, 88vw); display: flex; flex-direction: column; gap: 8px; }
      .mkt-wallet-picker-title { font-family: 'Geist', sans-serif; font-size: 13px; color: #9A9588; margin-bottom: 4px; }
      .mkt-wallet-picker-item { display: flex; align-items: center; gap: 10px; background: #0E0F0C; border: 1px solid #2A2B27; border-radius: 8px; padding: 10px 12px; color: #E8E4D9; font-family: 'Geist', sans-serif; font-size: 13px; cursor: pointer; text-align: left; }
      .mkt-wallet-picker-item:hover { border-color: #C4B49A; }
      .mkt-wallet-picker-icon { width: 22px; height: 22px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
      .mkt-wallet-picker-icon-empty { background: #1C1D1A; display: inline-block; }
      .mkt-wallet-picker-cancel { margin-top: 4px; background: transparent; border: none; color: #6F6B61; font-family: 'Geist', sans-serif; font-size: 12px; cursor: pointer; padding: 6px; }
      .mkt-wallet-picker-cancel:hover { color: #E8E4D9; }
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

  window.MarktapeWallet = {
    connectWallet,
    connectWithPicker,
    connectByName,
    listAvailableWallets,
    signTransactionBase64,
    getProvider: getLegacyProvider, // kept for back-compat with older callers
  };
})();
