import type { GetServerSideProps } from "next";
import { Connection, PublicKey } from "@solana/web3.js";
import type { TokenRow } from "@marktape/core";
import { getSnapshot } from "../../snapshot";
import PremiumPill from "../../PremiumPill";
import SwapPanel from "../../SwapPanel";

type Props = { token: TokenRow | null; symbol: string; decimals: number };

export default function TokenPage({ token, symbol, decimals }: Props) {
  if (!token) {
    return <div className="px-4 py-16 text-center text-muted">Unknown symbol: {symbol}</div>;
  }

  const botUrl = `${process.env.NEXT_PUBLIC_TELEGRAM_URL || "https://t.me/MarktapeBot"}?start=${symbol}`;

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto grid md:grid-cols-3 gap-6">
      <div className="md:col-span-2 space-y-6">
        <div>
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {token.image && <img src={token.image} alt={token.symbol} className="w-8 h-8 rounded-full" />}
            <h1 className="text-2xl font-bold font-mono">{token.symbol}</h1>
            <span className="text-muted text-sm">{token.name}</span>
          </div>
          <div className="flex items-center gap-6 mt-4">
            <div>
              <div className="text-xs text-muted">TAPE</div>
              <div className="text-3xl font-mono font-bold">${token.tokenPrice.toFixed(2)}</div>
            </div>
            <PremiumPill premium={token.premium} size="lg" />
            <div>
              <div className="text-xs text-muted">MARK</div>
              <div className="text-3xl font-mono font-bold text-muted">
                ${token.markPrice.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="border border-line rounded p-3">
            <div className="text-muted text-xs">Implied Valuation</div>
            <div className="font-mono">${(token.impliedValuation / 1e6).toFixed(1)}M</div>
          </div>
          <div className="border border-line rounded p-3">
            <div className="text-muted text-xs">Mark Valuation</div>
            <div className="font-mono">${(token.markValuation / 1e6).toFixed(1)}M</div>
          </div>
        </div>

        <div className="text-sm space-y-1">
          <div className="text-muted text-xs">Mint</div>
          <div className="font-mono break-all">{token.mint}</div>
          <a
            className="text-accent underline text-sm"
            href={token.externalUrl}
            target="_blank"
            rel="noreferrer"
          >
            View on prestocks.com
          </a>
        </div>

        {token.description && <p className="text-sm text-muted">{token.description}</p>}

        <a href={botUrl} target="_blank" rel="noreferrer" className="text-sm text-accent underline block">
          Watch this in Telegram
        </a>
      </div>

      <div>
        <SwapPanel symbol={token.symbol} mint={token.mint} multiplier={token.multiplier} decimals={decimals} />
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const symbol = String(ctx.params?.symbol || "").toUpperCase();
  const { snapshot } = await getSnapshot();
  const token = snapshot.tokens.find((t) => t.symbol === symbol) || null;

  let decimals = 6;
  if (token) {
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl, "confirmed");
      const info = await connection.getParsedAccountInfo(new PublicKey(token.mint));
      const parsed = (info.value?.data as any)?.parsed;
      decimals = parsed?.info?.decimals ?? 6;
    } catch {
      decimals = 6;
    }
  }

  return { props: { token, symbol, decimals } };
};
