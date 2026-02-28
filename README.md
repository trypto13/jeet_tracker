# Jeet Track

Real-time OPNet wallet surveillance on Telegram. Built for OPNet on BTC L1.

**Bot:** [t.me/jeettracker](https://t.me/jeettracker)

Know the minute you're REKTing or getting REKT, when a whale moves, a jeet dumps, or your bag gets rugged.

**Subscription only.** Pay with BTC or MOTO to unlock full access.

## What It Does

Track any wallet on OPNet and get slow-fi Telegram alerts for:

- **BTC sends & receives** — see the sats flow in and out
- **OP-20 token transfers** — catch every token move before CT does
- **NativeSwap activity** — liquidity addition and removal, swaps executed
- **Token price alerts** — set thresholds on any token pair and get pinged when it hits
- **Portfolio view** — aggregate BTC + token + NFT balances across all your tracked wallets
- **Liquidity removal and addition** — Who's nice farmooooor?

## Commands

| Command | What It Does |
|---|---|
| `/track <address> [label]` | Watch a wallet |
| `/untrack <address>` | Stop watching |
| `/wallets` | List all tracked wallets |
| `/balance <address>` | BTC + token + NFT balances |
| `/portfolio` | Aggregate balances across all wallets |
| `/listings <contract>` | NativeSwap liquidity providers |
| `/reservations <contract>` | NativeSwap reservation state |
| `/tracktoken <contract> <threshold>` | Set a token price alert |
| `/untracktokens` | Clear token alerts |
| `/tokenalerts` | View active token alerts |
| `/redeem <code>` | Activate your subscription |
| `/help` | Show commands |

Supports `bc1q`, `bc1p`, `opt1p`, and `op1` addresses.

## Stack

- Grammy (Telegram long-polling)
- MongoDB
- OPNet SDK (`opnet@rc`)
- TypeScript strict mode
- Bitcoin L1 — no bridges, no sidechains, no L2

## Acknowledgments

Built with extensive guidance and tooling from **[OPNet-BOB](https://github.com/OPNet-BOB)** — OPNet's AI development assistant and MCP instructor. BOB's development guidelines, audit checklists, contract documentation, and SDK expertise were instrumental throughout this project.

## License

Copy pasta.
