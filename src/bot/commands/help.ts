import type { CommandContext, Context } from 'grammy';

export async function helpCommand(ctx: CommandContext<Context>): Promise<void> {
    await ctx.reply(
        '📖 *OPNet Wallet Tracker — Help*\n\n' +
            '*Tracking*\n' +
            '`/track <address> [label]` — Track any supported address\n' +
            '`/untrack <address>` — Remove a tracked wallet\n' +
            '`/wallets` — List all wallets you are tracking\n\n' +
            '*Balance*\n' +
            '`/balance <address>` — Show BTC, CSV1, and OP\\-20 balances\n\n' +
            '*Supported address types:*\n' +
            '• `bc1p` / `bcrt1p` — Taproot \\(main \\+ CSV1 \\+ OP\\-20\\)\n' +
            '• `bc1q` / `bcrt1q` — SegWit \\(main \\+ OP\\-20\\)\n' +
            '• `op1` / `opr1` — OPNet P2OP \\(OP\\-20 tokens only\\)\n\n' +
            '*Supported events:*\n' +
            '• BTC sends \\& receives\n' +
            '• OP\\-20 token Transfer events \\(any contract\\)\n\n' +
            '*Notes:*\n' +
            '• Track your Bitcoin address AND your P2OP address to see all balances\n' +
            '• Labels are optional but recommended for clarity\n' +
            '• Notifications arrive within one poll cycle \\(\\~30s\\)',
        { parse_mode: 'MarkdownV2' },
    );
}
