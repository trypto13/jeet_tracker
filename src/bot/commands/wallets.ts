import type { CommandContext, Context } from 'grammy';
import { walletRepo } from '../../db/WalletRepository.js';
import { mainKeyboard, walletInlineKeyboard } from '../keyboards.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function walletsCommand(ctx: CommandContext<Context>): Promise<void> {
    const subs = await walletRepo.listSubscriptions(ctx.chat.id);

    if (subs.length === 0) {
        await ctx.reply(
            '📭 You have no tracked wallets\\.\n\nTap *➕ Track Wallet* or use `/track <address>`\\.',
            { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
        );
        return;
    }

    await ctx.reply(
        `👁 *Tracked Wallets \\(${subs.length}\\)*`,
        { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
    );

    // Send each wallet as a separate message with its own inline buttons
    for (const [i, s] of subs.entries()) {
        const num = escapeMarkdown(`${i + 1}.`);
        const label = escapeMarkdown(s.label);
        const addr = escapeMarkdown(s.address);
        const since = escapeMarkdown(s.createdAt.slice(0, 10));

        await ctx.reply(
            `${num} *${label}*\n\`${addr}\`\nAdded: ${since}`,
            {
                parse_mode: 'MarkdownV2',
                reply_markup: walletInlineKeyboard(s),
            },
        );
    }
}
