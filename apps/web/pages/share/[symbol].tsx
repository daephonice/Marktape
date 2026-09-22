import type { GetServerSideProps } from "next";
import Head from "next/head";
import type { TokenRow } from "@marktape/core";
import { getSnapshot } from "../../snapshot";
import PremiumPill from "../../PremiumPill";

type Props = { token: TokenRow | null; symbol: string };

export default function SharePage({ token, symbol }: Props) {
  if (!token) return <div className="px-4 py-16 text-center text-muted">Unknown symbol</div>;

  const ogUrl = `/api/og-image?symbol=${symbol}`;

  return (
    <>
      <Head>
        <meta property="og:image" content={ogUrl} />
        <meta name="twitter:card" content="summary_large_image" />
      </Head>
      <div className="flex flex-col items-center justify-center h-[70vh] gap-4">
        <div className="text-5xl font-mono font-bold">{token.symbol}</div>
        <PremiumPill premium={token.premium} size="lg" />
        <div className="font-mono text-muted">
          ${token.tokenPrice.toFixed(2)} tape · ${token.markPrice.toFixed(2)} mark
        </div>
        <div className="text-accent font-mono text-xs mt-8">MARKTAPE</div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const symbol = String(ctx.params?.symbol || "").toUpperCase();
  const { snapshot } = await getSnapshot();
  const token = snapshot.tokens.find((t) => t.symbol === symbol) || null;
  return { props: { token, symbol } };
};
