# OPNet Wallet Tracker

A Telegram bot that tracks Bitcoin / OPNet wallet activity in real-time — the OPNet equivalent of [@EtherDROPS_bot](https://t.me/EtherDROPS_bot).

## Features

- **BTC Transfer Alerts** — Notified whenever a tracked wallet sends or receives BTC
- **OP-20 Token Transfer Alerts** — Catches `Transfer` events from any OP-20 contract
- **Balance Check** — Check any address's current confirmed BTC balance on demand
- **Multi-wallet** — Track up to 20 wallets per Telegram chat with optional labels
- **Persistent** — Subscriptions and block progress survive restarts (MongoDB)

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message & command overview |
| `/track <address> [label]` | Start tracking a wallet |
| `/untrack <address>` | Stop tracking a wallet |
| `/wallets` | List all tracked wallets |
| `/balance <address>` | Check BTC balance of any address |
| `/help` | Show help |

Supported address formats: `bc1q` (P2WPKH), `bc1p` (P2TR), `op1` (OPNet contracts)

## Setup

### 1. Prerequisites

- Node.js ≥ 22
- MongoDB (local or Atlas)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your values
```

```env
TELEGRAM_BOT_TOKEN=your_token_here
MONGO_URI=mongodb://localhost:27017/opnet-tracker
RPC_URL=https://api.opnet.org
NETWORK=mainnet
POLL_INTERVAL_MS=30000
MAX_WALLETS_PER_USER=20
```

### 4. Run

**Development (with hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Architecture

```
src/
├── index.ts                 Entry point — wires everything together
├── config.ts                Env var loading & validation
├── provider/
│   └── ProviderManager.ts   Singleton OPNet JSONRpcProvider
├── db/
│   ├── Database.ts          MongoDB connection singleton
│   └── WalletRepository.ts  Subscriptions + tracker state CRUD
├── tracker/
│   ├── BlockPoller.ts       Polls for new blocks every POLL_INTERVAL_MS
│   ├── TxParser.ts          Parses block txs for BTC + OP-20 events
│   └── Notifier.ts          Formats & sends Telegram notifications
└── bot/
    ├── Bot.ts               Grammy bot setup
    └── commands/            One file per bot command
```

**Stack:** Grammy · MongoDB · OPNet SDK (`opnet@rc`) · TypeScript (strict)

## How It Works

1. `BlockPoller` polls `provider.getBlockNumber()` every 30 s
2. For each new block, `TxParser` fetches the full block with transactions
3. BTC-level: checks all tx inputs/outputs against tracked addresses
4. OP-20 level: fetches transaction receipts and parses `Transfer` events
5. `Notifier` sends formatted Markdown messages to subscribed Telegram chats
