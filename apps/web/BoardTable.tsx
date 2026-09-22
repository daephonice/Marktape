import { useEffect, useState } from "react";
import Link from "next/link";
import type { Snapshot } from "@marktape/core";
import PremiumPill from "./PremiumPill";

export default function BoardTable({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [error, setError] = useState(false);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/board");
        if (!res.ok) throw new Error();
        const data = await res.json();
        setSnapshot(data);
        setError(false);
      } catch {
        setError(true);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <div className="px-4 py-2 text-xs text-muted flex justify-between">
        <span>Last refresh: {new Date(snapshot.fetchedAt).toLocaleTimeString()}</span>
        {error && <span className="text-rich">Live refresh failing — showing last snapshot</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="px-4 py-2 font-normal"></th>
              <th className="px-4 py-2 font-normal">Symbol</th>
              <th className="px-4 py-2 font-normal">Premium</th>
              <th className="px-4 py-2 font-normal">Token</th>
              <th className="px-4 py-2 font-normal">Mark</th>
              <th className="px-4 py-2 font-normal hidden md:table-cell">Implied Val</th>
              <th className="px-4 py-2 font-normal hidden md:table-cell">Mark Val</th>
              <th className="px-4 py-2 font-normal hidden md:table-cell">Supply</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.tokens.map((t) => (
              <tr key={t.symbol} className="border-b border-line hover:bg-surface">
                <td className="px-4 py-3">
                  <Link href={`/t/${t.symbol}`}>
                    {t.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.image} alt={t.symbol} className="w-5 h-5 rounded-full" />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-line" />
                    )}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/t/${t.symbol}`} className="hover:text-accent">
                    <div className="font-mono font-semibold">{t.symbol}</div>
                    <div className="text-muted text-xs">{t.name}</div>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <PremiumPill premium={t.premium} />
                </td>
                <td className="px-4 py-3 font-mono">${t.tokenPrice.toFixed(2)}</td>
                <td className="px-4 py-3 font-mono text-muted">${t.markPrice.toFixed(2)}</td>
                <td className="px-4 py-3 font-mono text-muted hidden md:table-cell">
                  ${(t.impliedValuation / 1e6).toFixed(0)}M
                </td>
                <td className="px-4 py-3 font-mono text-muted hidden md:table-cell">
                  ${(t.markValuation / 1e6).toFixed(0)}M
                </td>
                <td className="px-4 py-3 font-mono text-muted hidden md:table-cell">
                  {t.supply.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
