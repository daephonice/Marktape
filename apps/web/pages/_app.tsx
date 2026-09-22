import type { AppProps } from "next/app";
import "../styles.css";
import WalletContextProvider from "../WalletContextProvider";

export default function App({ Component, pageProps }: AppProps) {
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_URL || "https://t.me/MarktapeBot";

  return (
    <WalletContextProvider>
      <div className="min-h-screen flex flex-col font-sans">
        <header className="sticky top-0 z-10 bg-bg/90 backdrop-blur border-b border-line px-4 py-3 flex items-center justify-between">
          <a href="/" className="font-mono text-accent font-bold tracking-tight">
            MARKTAPE
          </a>
          <a
            href={botUsername}
            target="_blank"
            rel="noreferrer"
            className="text-sm border border-line rounded px-3 py-1.5 hover:border-accent transition-colors"
          >
            Alerts on Telegram
          </a>
        </header>
        <main className="flex-1">
          <Component {...pageProps} />
        </main>
        <footer className="border-t border-line px-4 py-6 text-xs text-muted space-y-1">
          <p>
            PreStocks provide economic exposure via an SPV only. Not shares. Not for US persons.
            Not investment advice. Marktape does not custody funds.
          </p>
          <p>
            Data: PreStocks API. Execution: Jupiter Ultra, signed in your wallet. Prices can be
            stale.
          </p>
          <p className="space-x-3">
            <a
              className="hover:text-accent"
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <a className="hover:text-accent" href={botUsername} target="_blank" rel="noreferrer">
              Telegram
            </a>
          </p>
        </footer>
      </div>
    </WalletContextProvider>
  );
}
