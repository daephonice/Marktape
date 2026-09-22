import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT, USDC_DECIMALS, toRawAmount, toUiAmount } from "@marktape/core";

type Props = {
  symbol: string;
  mint: string;
  multiplier: number;
  decimals: number;
};

type Quote = {
  transaction?: string;
  requestId?: string;
  outAmount?: string;
  inAmount?: string;
  priceImpactPct?: string;
  error?: string;
};

export default function SwapPanel({ symbol, mint, multiplier, decimals }: Props) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteAt, setQuoteAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const inputMint = side === "buy" ? USDC_MINT : mint;
  const outputMint = side === "buy" ? mint : USDC_MINT;
  const inputDecimals = side === "buy" ? USDC_DECIMALS : decimals;
  const inputMultiplier = side === "buy" ? 1 : multiplier;

  const fetchQuote = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const raw = toRawAmount(Number(amount), inputDecimals, inputMultiplier);
      const res = await fetch(
        `/api/swap-order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&taker=${publicKey.toBase58()}`
      );
      const data = await res.json();
      if (data.error) {
        setErrorMsg(data.error === "no_route" ? "No route found for this size." : data.error);
        setQuote(null);
      } else {
        setQuote(data);
        setQuoteAt(Date.now());
      }
    } catch {
      setErrorMsg("Could not fetch quote.");
    } finally {
      setLoading(false);
    }
  }, [publicKey, amount, inputMint, outputMint, inputDecimals, inputMultiplier]);

  useEffect(() => {
    fetchQuote();
    const id = setInterval(fetchQuote, 10_000);
    return () => clearInterval(id);
  }, [fetchQuote]);

  const quoteFresh = Date.now() - quoteAt < 15_000;

  async function handleConfirm() {
    if (!publicKey || !signTransaction || !quote?.transaction || !quote.requestId) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const txBuf = Buffer.from(quote.transaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      const signed = await signTransaction(tx);
      const serialized = Buffer.from(signed.serialize()).toString("base64");

      const res = await fetch("/api/swap-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTransaction: serialized, requestId: quote.requestId }),
      });
      const data = await res.json();
      if (data.signature) {
        setTxResult(data.signature);
      } else {
        setErrorMsg(data.error || "Execution failed.");
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
      fetchQuote();
    }
  }

  const outUi =
    quote?.outAmount != null
      ? toUiAmount(quote.outAmount, side === "buy" ? decimals : USDC_DECIMALS, side === "buy" ? multiplier : 1)
      : null;

  return (
    <div className="border border-line rounded-lg p-4 bg-surface space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setSide("buy")}
          className={`flex-1 py-2 rounded font-semibold text-sm ${side === "buy" ? "bg-accent text-bg" : "border border-line text-muted"}`}
        >
          Buy
        </button>
        <button
          onClick={() => setSide("sell")}
          className={`flex-1 py-2 rounded font-semibold text-sm ${side === "sell" ? "bg-accent text-bg" : "border border-line text-muted"}`}
        >
          Sell
        </button>
      </div>

      <div>
        <label className="text-xs text-muted">
          {side === "buy" ? "USDC amount" : `${symbol} amount`}
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full bg-bg border border-line rounded px-3 py-2 font-mono mt-1"
        />
      </div>

      {!publicKey ? (
        <WalletMultiButton style={{ width: "100%", justifyContent: "center" }} />
      ) : (
        <>
          {quote?.transaction ? (
            <div className="text-sm space-y-1 font-mono text-muted">
              <div>
                Out: {outUi?.toFixed(4)} {side === "buy" ? symbol : "USDC"}
              </div>
              {quote.priceImpactPct && <div>Impact: {quote.priceImpactPct}%</div>}
            </div>
          ) : errorMsg ? (
            <div className="text-sm text-rich space-y-1">
              <p>{errorMsg}</p>
              <a
                className="underline text-accent"
                href={`https://jup.ag/swap/${side === "buy" ? `USDC-${mint}` : `${mint}-USDC`}`}
                target="_blank"
                rel="noreferrer"
              >
                Try on jup.ag instead
              </a>
            </div>
          ) : (
            <div className="text-sm text-muted">Fetching quote…</div>
          )}

          <p className="text-xs text-muted">
            Not for US persons. Not investment advice. Economic exposure only.
          </p>

          <button
            disabled={!quote?.transaction || !quoteFresh || loading}
            onClick={handleConfirm}
            className="w-full py-2 rounded font-semibold bg-accent text-bg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Working…" : "Confirm"}
          </button>

          {txResult && (
            <div className="text-sm text-cheap">
              Done.{" "}
              <a
                className="underline"
                href={`https://solscan.io/tx/${txResult}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Solscan
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
