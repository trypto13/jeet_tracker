import type { CommandContext, Context } from 'grammy';
import { mainKeyboard } from '../keyboards.js';
import { walletRepo } from '../../db/WalletRepository.js';
import { config } from '../../config.js';

const WELCOME =
    '👁 *OPNet Wallet Tracker*\n\n' +
    'Track Bitcoin \\& OPNet wallet activity in real\\-time\\.\n' +
    'Get notified of BTC transfers and OP\\-20 token events\\.\n\n' +
    '`/track <address> [label]` — Start tracking a wallet\n' +
    '`/untrack <address>` — Stop tracking\n' +
    '`/wallets` — List tracked wallets\n' +
    '`/balance <address>` — Check balance';

export async function startCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;

    // Already authenticated — just show the welcome screen.
    if (walletRepo.isAuthorized(chatId)) {
        await ctx.reply(WELCOME, { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard });
        return;
    }

    const password = ctx.match.trim();

    if (!password) {
        await ctx.reply(
            '🔒 *This bot is private\\.* Send your password to continue:\n\n`/start <password>`',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    if (password !== config.botPassword) {
        await ctx.reply('❌ Incorrect password\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    walletRepo.authorizeChat(chatId);
    await ctx.reply(
        '✅ *Authenticated\\!*\n\n' + WELCOME,
        { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
    );
}
