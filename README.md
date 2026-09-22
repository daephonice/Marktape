# Marktape

Mark vs tape for PreStocks.

PreStocks tokens trade 24/7 on Solana. Each name has an onchain token price
and an issuer mark price. Those two numbers diverge. Marktape is a desk for
that gap: a live board, a token page, an in-page Jupiter Ultra swap of the
PreStocks mint only, and optional Telegram alerts.

## Bounty

Built for Solana Stocklana, PreStocks track.
Universe is exclusively mints returned by https://prestocks.com/api/prestocks.
No Tessera, xStocks, Backpack, or other pre-IPO issuers.

## Stack

Next.js + Grammy + Postgres. Deployed on Railway from this repo.

## Disclaimer

PreStocks provide economic exposure only. Not shares. Not for US persons.
Not advice. Marktape does not custody funds.

## Repo layout

```
apps/web/      Next.js 15 Pages Router site + /api/*
apps/bot/      Grammy Telegram bot + 60s alert loop
packages/core/ shared types, PreStocks client, premium math, DB, multiplier
sql/           SQL migration script (backup reference — tables auto-create on boot)
```

## Setup

1. `npm install` at repo root (npm workspaces).
2. Copy `.env.example` to `.env` in `apps/web` and `apps/bot`, fill values (see below).
3. `npm run dev:web` and `npm run dev:bot`. Tables are created automatically on first DB call (`ensureSchema()` in `packages/core/migrate.ts`) — no manual SQL step needed. `sql/001_init.sql` is kept only as a manual-run reference/backup.

## Environment variables

| Var | Used by | Where to get it |
|---|---|---|
| `DATABASE_URL` | web, bot | Railway Postgres plugin → auto-injected, or copy from Variables tab |
| `PRESTOCKS_API_URL` | web | Public, default `https://prestocks.com/api/prestocks` |
| `SOLANA_RPC_URL` | web, bot | Helius / QuickNode / Ankr free-tier RPC URL (public mainnet-beta rate-limits) |
| `WEB_PUBLIC_URL` | bot | Your Railway web service's public domain (Settings → Networking → Generate Domain) |
| `JUPITER_API_KEY` | web | https://developers.jup.ag/portal — free signup |
| `CRON_SECRET` | web (optional) | Any random string you generate, only if wiring a cron hit to `/api/refresh` |
| `TELEGRAM_BOT_TOKEN` | bot | @BotFather on Telegram → `/newbot` |
| `TELEGRAM_BOT_USERNAME` | bot | The username you set with BotFather |
| `NEXT_PUBLIC_WEB_URL` | web | Same as `WEB_PUBLIC_URL`, exposed to browser |
| `NEXT_PUBLIC_TELEGRAM_URL` | web | `https://t.me/<your bot username>` |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | web | A **public-safe** RPC URL for the browser wallet adapter (do not reuse a keyed premium RPC URL client-side unless your provider allows public exposure) |

Seal `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `DATABASE_URL`, `JUPITER_API_KEY` in Railway (Variables → Seal).

## Railway deploy

1. New Railway project.
2. Attach a **Postgres** plugin — both services get `DATABASE_URL`.
3. Service `web`: Root Directory = repo root, Build `npm install && npm run build:web`, Start `npm run start -w @marktape/web`, generate a public domain.
4. Service `bot`: Root Directory = repo root, Build `npm install && npm run build:bot`, Start `npm run start -w @marktape/bot`, no public domain needed (long polling).
5. Tables auto-create on first boot. No manual SQL step.
6. Set env vars per table above on each service.

## Health check

`GET /api/health` → `{ ok: true, fetchedAt }`
