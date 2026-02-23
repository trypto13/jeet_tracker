import type { CommandContext, Context } from 'grammy';
import { walletRepo } from '../../db/WalletRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function untrackCommand(ctx: CommandContext<Context>): Promise<void> {
    const address = ctx.match.trim();

    if (!address) {
        await ctx.reply('Usage: `/untrack <address>`', {
            parse_mode: 'MarkdownV2',
        });
        return;
    }

    const removed = await walletRepo.removeSubscription(ctx.chat.id, address);

    if (removed) {
        await ctx.reply(
            `✅ Stopped tracking \`${escapeMarkdown(address)}\``,
            { parse_mode: 'MarkdownV2' },
        );
    } else {
        await ctx.reply(
            `⚠️ You are not tracking \`${escapeMarkdown(address)}\``,
            { parse_mode: 'MarkdownV2' },
        );
    }
}
