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

FastAPI + Jinja + vanilla JS + Aiogram + Postgres. Deployed on Railway from
this repo.

## Disclaimer

PreStocks provide economic exposure only. Not shares. Not for US persons.
Not advice. Marktape does not custody funds.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in values, see below
uvicorn main:app --reload
```

## Environment variables

| Var | Required | Where to get it |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres plugin → auto-injects when you add the plugin and reference it on the web service |
| `PRESTOCKS_API_URL` | no (has default) | `https://prestocks.com/api/prestocks` |
| `SOLANA_RPC_URL` | yes | Helius / Triton / QuickNode / Ankr — public RPC will rate-limit. Free tier at helius.dev works. |
| `WEB_PUBLIC_URL` | yes | Railway → your web service → Settings → Generate Domain, then paste it here |
| `JUPITER_API_KEY` | yes (for swap) | https://developers.jup.ag/portal |
| `CRON_SECRET` | no | Any random string you choose, only needed if you wire an external cron to hit a refresh endpoint |
| `TELEGRAM_BOT_TOKEN` | yes (for bot) | Message @BotFather on Telegram → `/newbot` |
| `TELEGRAM_BOT_USERNAME` | yes (for bot) | The username you gave BotFather, e.g. `MarktapeBot` |
| `TELEGRAM_PUBLIC_URL` | no (has default) | `https://t.me/<your bot username>` |

Seal `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `DATABASE_URL`, `JUPITER_API_KEY`
in Railway (Variables → Seal).

## Deploy on Railway

1. Push this repo to a new **public** GitHub repo, branch `main`.
2. Railway → New Project → Deploy from GitHub repo.
3. Add a **Postgres** plugin to the project, then on the web service:
   Variables → New Variable → Reference → pick the Postgres service's
   `DATABASE_URL`.
4. Set the other env vars above on the web service.
5. Generate a domain on the web service → that's `WEB_PUBLIC_URL` and your
   live demo URL. Add it back into the env vars and redeploy.
6. Healthcheck: `GET /api/health` → `{ "ok": true, "fetchedAt": ... }`.

One service (`web`) runs both the FastAPI app and the Telegram bot (aiogram
long polling as a background asyncio task started on FastAPI startup).
