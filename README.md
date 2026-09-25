# Marktape

**Mark versus tape for PreStocks.**

PreStocks tokens trade 24/7 on Solana. Every name has two prices at once:

- **Tape** — what the token last traded at onchain
- **Mark** — the issuer’s official mark for the private company

Those two numbers diverge. A name can trade rich or cheap versus its own mark, and the gap is the whole market. Marktape is a wallet-shaped desk for that gap: the eight PreStocks names, a token page per name, an in-page Jupiter Ultra buy/sell of the real mint, a portfolio of what you already hold, Send, a paper Lend book, company news, and a Telegram watch bot.

Live demo: https://marktape-production.up.railway.app  
Telegram: https://t.me/Themarktapebot  
API health: `GET /api/health`  
Board: `GET /api/board`

## Bounty

Built for Solana Stocklana, PreStocks track.

Universe is **only** mints returned by `https://prestocks.com/api/prestocks`.  
No Tessera. No xStocks. No other pre-IPO issuer.

## How to test the site (in five minutes)

Use a **new empty Solana wallet**. Do not connect the wallet you actually fund.

Marktape never takes custody. Swaps and sends are signed in your wallet. A fresh wallet lets you click Connect, read balances (`$0.00` is correct), open Swap, open Send, open Lend, and leave with nothing at risk except a few cents of SOL if you choose to send a real transaction.

Suggested path:

1. Open the live URL. Home should show a Stocks strip of PreStocks names with live tape.
2. Open any name → token page. Confirm **Tape**, **Mark**, and **Prem** sit next to the big price.
3. Change the chart range (`1H` / `6H` / `1D` / `1W`).
4. Read **About**. Copy the mint. It must start with `Pre`.
5. Connect the empty wallet. Portfolio should stay at `$0.00`.
6. Open **Swap**. Pair is locked to USDC ↔ that PreStocks mint. Quote, then cancel.
7. Open **Send**. You can stop before signing.
8. Open **Lend**. This book is a paper market (see Lend below). Walk the flow, do not treat it as mainnet Kamino.
9. Message `@Themarktapebot` → `/board` then `/watch OPENAI`.

# Features

Listed from the feature the product cannot live without, to the feature that is extra.

---

## 1. Mark, tape, and premium

**What it is**  
The reason Marktape exists. For each PreStocks mint we show three numbers: onchain tape (`tokenPrice`), issuer mark (`markPrice`), and premium `tape / mark − 1`. Positive premium = the token is rich versus the mark. Negative = cheap.

**How it works on the site**  
`GET https://prestocks.com/api/prestocks` is the source of truth. We apply the Token-2022 `scaledUiAmount` multiplier so the tape is in the same units as the mark. The three numbers land on the token page as **Tape / Mark / Prem**, and they feed `/api/board`. Telegram cards print the same three lines.

**Problem without it**  
Jupiter, a wallet home screen, and a raw price chart all show one print. A judge (or a holder) cannot tell whether they are paying 30% above the official mark or buying a discount. That is the actual PreStocks question.

**What it solves**  
One glance: am I rich or cheap versus the issuer. No spreadsheet, no two tabs.

---

## 2. Stocks on the homepage

**What it is**  
The first screen is a wallet lobby. Under the balance sit the PreStocks names that matter — logo, ticker, live tape, 24h change.

**How it works on the site**  
Home pulls the shared price cache. Each row links to `/t/SYMBOL`. “View all” / Stocks is the full set, not a random meme list.

**Problem without it**  
A wallet home with `$0.00` and no names is a shell. A judge never reaches the gap.

**What it solves**  
Three seconds after load you are looking at SpaceX, Anduril, Anthropic, OpenAI — the PreStocks universe — and one tap opens the desk for that mint.

---

## 3. Token page

**What it is**  
`/t/OPENAI` (and every other symbol) is the full blotter for one name: identity, mint, tape + mark + premium, chart, about the company, portfolio slice if you hold it, and the door into Buy / Sell / Send.

**How it works on the site**  
Header: logo, ticker, truncated mint with one-tap copy (full address is the real PreStocks mint, prefix `Pre`). Price row: live tape, 24h, market cap, mark, premium. About is the official PreStocks description plus a link back to `prestocks.com`. Sticky **Buy** opens the in-page swap. Share copies a link.

**Problem without it**  
A table of eight rows cannot hold a mint, a disclaimer, a chart, and a trade. People bounce to Jupiter and lose the mark.

**What it solves**  
One scroll answers: what is this token, what does the issuer say it is worth, what is tape doing, do I already hold it, can I buy it without leaving.

---

## 4. Chart

**What it is**  
A line of tape across `1H`, `6H`, `1D`, `1W` on the token page.

**How it works on the site**  
`GET /api/chart/{symbol}?range=1D` returns `[[epoch_ms, price], ...]`. The page draws an SVG line. Empty history shows “No price history yet” — we do not invent candles.

**Problem without it**  
A single print of `$1,315` does not tell you if that is a spike or a grind. Premium without path is a screenshot.

**What it solves**  
Context for the gap. You see whether tape ran away from the mark in the last day or has been sitting there.

---

## 5. In-site Buy / Sell (Swap)

**What it is**  
Jupiter Ultra inside Marktape. You buy or sell the **exact PreStocks mint** against USDC. Marktape never holds the tokens.

**How it works on the site**  
Swap / the token-page **Buy** button. Pair is locked: USDC ↔ this mint. No SOL default, no random output mint. Connect wallet → enter size → we request a Jupiter Ultra order → you sign in the wallet → Solscan on fill. Same Jupiter key as the rest of the desk.

**Problem without it**  
Discovery without execution is a blog. Sending a judge to jup.ag loses the mark, the mint check, and the “this is PreStocks-only” guarantee.

**What it solves**  
See the gap, trade the mint, stay on the desk. Custody stays in the wallet you connected.

---

## 6. Portfolio

**What it is**  
After Connect, the home balance and the token-page position show **your** PreStocks (and accepted) holdings, priced on the same tape we use for the board.

**How it works on the site**  
`GET /api/balances/{address}` reads the wallet on Solana. Home shows total USD. Each token page shows units + USD of that mint. Empty wallet correctly reads `$0.00`.

**Problem without it**  
Tape and mark are abstract until they sit next to “you hold 0.4 OPENAI.” A judge cannot tell the app knows a real chain.

**What it solves**  
The desk becomes personal without becoming a custodian. Connect a fresh wallet to prove we only read.

---

## 7. Send

**What it is**  
Move a PreStocks token (or USDC/SOL) from the connected wallet to another address, in-app.

**How it works on the site**  
Home → **Send**. Pick asset, amount, destination. You sign. We do not hold a hot wallet and we do not rewrite the destination.

**Problem without it**  
A “wallet look” that cannot send is a screenshot. After a buy, the only way out would be a different app.

**What it solves**  
The loop closes on one origin: see → buy → hold → send. Useful when you want the token in a vault, a friend, or a cold address without opening Phantom’s send sheet.

---

## 8. News

**What it is**  
One fresh headline per PreStocks name on the home feed.

**How it works on the site**  
`GET /api/news`. Server refreshes about hourly. Each card is ticker + tape + source + age, and taps through to the token page.

**Problem without it**  
Pre-IPO names move on headlines (funding, lawsuits, product). A premium number with no “why” is a dead blotter.

**What it solves**  
The same eight names get a pulse. Not a generic crypto firehose — Anduril news sits on Anduril.

---

## 9. Telegram watch bot

**What it is**  
A second door onto the same board. No wallet. No signing.

**How it works**  
[@Themarktapebot](https://t.me/Themarktapebot)

| Command | What you get |
|---|---|
| `/start` or `/start OPENAI` | Pitch + site link, or that name’s card |
| `/board` | Every symbol with premium, tape, mark |
| `/t OPENAI` | Full card + site + Jupiter link |
| `/watch OPENAI` | Persist up to 5 names per chat |
| `/unwatch` / `/watches` | Manage the list |

The bot reads the same PreStocks cache as the website. It never asks for a key.

**Problem without it**  
The gap moves while you are in a group chat. Opening a browser for eight tickers is how people stop watching.

**What it solves**  
Share a card in Telegram. Watch a name. Click through to the token page when you actually want to trade.

---

## 10. Lend

**What it is**  
A **paper** isolated book: deposit a PreStocks name as collateral, borrow USDC or SOL up to a conservative LTV (45% USDC / 40% SOL), keep the upside. Liquidation threshold 55% / 50%.

**How it works on the site**  
Home → **Lend**. Oracle is the live PreStocks **tape** from the same cache as the board. Positions are stored in our Postgres. There is **no** Kamino or Jupiter Lend vault for these mints today — those venues list xStocks and majors, not PreStocks Token-2022. So this is a demo market with seeded book liquidity, not a mainnet money market. Do not deposit size you care about.

**Problem without it**  
The PreStocks brief explicitly asks for lending / collateral. Holders of OPENAI or SPACEX who do not want to sell have nowhere on mainnet to borrow stables against that mint.

**What it solves**  
It shows the shape: isolated market, live oracle, LTV, keep the name. It is the attach-point for a real curator book later. It is **not** a claim that Jupiter Lend already accepts `PreweJY…`.

---

# Trust

Marktape does not custody funds.  
Connect is Wallet Standard — any injected Solana wallet, not a three-logo list.  
Swaps go through Jupiter Ultra; you sign.  
Sends are your wallet’s transfer; you sign.  
Lend positions in this build are application-level paper.  
Balances are a read of chain.

For review, connect a **brand-new wallet**. If the demo needs a swap signature, fund that wallet with a little USDC and SOL — not your main seed.

# Stack

FastAPI + Jinja + vanilla JS + Aiogram + Postgres.  
One Railway service runs the site and the bot.  
GitHub → Railway is the deploy path.

# Disclaimer

PreStocks are economic exposure only. Not shares, not voting rights, not for US persons, not advice. Tokens can go to zero and can trade far from the mark. Marktape is not PreStocks, not Jupiter, and not a broker.
