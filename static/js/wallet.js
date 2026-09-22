/* Wallet connect via Wallet Standard / window.solana. No adapter library,
 * no React. Phantom, Solflare, and Backpack all inject a compatible
 * window.solana (or window.backpack) provider that supports
 * connect() / signTransaction() / publicKey.
 */
(function () {
  function getProvider() {
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.backpack && window.backpack.isBackpack) return window.backpack;
    if (window.solana) return window.solana;
    return null;
  }

  async function connectWallet() {
    const provider = getProvider();
    if (!provider) {
      alert('No Solana wallet found. Install Phantom, Solflare, or Backpack.');
      return null;
    }
    try {
      const resp = await provider.connect();
      const pubkey = (resp && resp.publicKey ? resp.publicKey : provider.publicKey).toString();
      window.__marktapeWallet = { provider, pubkey };
      return pubkey;
    } catch (err) {
      console.error('wallet connect failed', err);
      return null;
    }
  }

  function base64ToBytes(base64Tx) {
    return Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function signTransactionBase64(base64Tx) {
    const state = window.__marktapeWallet;
    if (!state) throw new Error('Wallet not connected');
    const provider = state.provider;
    const raw = base64ToBytes(base64Tx);

    if (provider.signAndSendTransaction) {
      const result = await provider.signAndSendTransaction({ serialize: () => raw }, { encoding: 'base64', message: base64Tx });
      if (result && result.signature) return { signature: result.signature };
    }
    if (provider.signTransaction) {
      // Phantom/Solflare/Backpack accept a { serialize } shaped object OR
      // a raw VersionedTransaction; passing the base64-decoded bytes
      // wrapped so provider.signTransaction can re-serialize.
      const signed = await provider.signTransaction({
        serialize: () => raw,
        message: { serialize: () => raw },
      });
      const signedBytes = signed.serialize ? signed.serialize() : raw;
      return { signedTransactionBase64: bytesToBase64(signedBytes) };
    }
    throw new Error('Wallet does not support signing');
  }

  window.MarktapeWallet = { connectWallet, signTransactionBase64, getProvider };
})();
