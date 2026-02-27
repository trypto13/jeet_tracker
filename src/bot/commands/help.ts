import type { CommandContext, Context } from 'grammy';

export async function helpCommand(ctx: CommandContext<Context>): Promise<void> {
    await ctx.reply(
        '📖 *OPNet Wallet Tracker — Help*\n\n' +
            '*Wallet Tracking*\n' +
            '`/track <address> [label]` — Track any supported address\n' +
            '`/untrack <address>` — Remove a tracked wallet\n' +
            '`/wallets` — List all wallets you are tracking\n\n' +
            '*Balance*\n' +
            '`/balance <address>` — Show BTC, CSV1, OP\\-20 \\& OP\\-721 balances\n' +
            '`/portfolio` — Aggregate view of all your tracked wallets\n\n' +
            '*Token Monitoring \\(OP\\-20 \\& OP\\-721\\)*\n' +
            '`/tracktoken <address> [label]` — Subscribe to a token contract\n' +
            '`/untracktokens` — Manage tracked tokens\n' +
            '`/tokenalerts [label pricePct minBTC]` — View or set alert thresholds\n\n' +
            '*NativeSwap Analytics*\n' +
            '`/listings <address>` — Active liquidity providers for a token\n' +
            '`/reservations <address>` — Pending reservation state for a token\n\n' +
            '*Supported address types:*\n' +
            '• `bc1p` / `opt1p` / `bcrt1p` — Taproot \\(main \\+ CSV1 \\+ OP\\-20\\)\n' +
            '• `bc1q` / `opt1q` / `bcrt1q` — SegWit \\(main \\+ OP\\-20\\)\n' +
            '• `op1` / `opr1` — OPNet P2OP \\(OP\\-20 tokens only\\)\n\n' +
            '*Token monitoring notes:*\n' +
            '• Price alerts fire when price moves ≥ threshold% in a single poll\n' +
            '• Reservation alerts fire when a buyer reserves your listed liquidity\n' +
            '• /listings shows top liquidity providers \\(top holders by listing size\\)\n' +
            '• OP\\-721 collections: transfer notifications via wallet tracking\n\n' +
            '*Notes:*\n' +
            '• Notifications arrive within one poll cycle \\(\\~30s\\)',
        { parse_mode: 'MarkdownV2' },
    );
}
