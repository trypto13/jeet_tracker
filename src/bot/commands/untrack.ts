import type { CommandContext, Context } from 'grammy';
import { walletRepo } from '../../db/WalletRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function untrackCommand(ctx: CommandContext<Context>): Promise<void> {
    const input = ctx.match.trim();
    const chatId = ctx.chat.id;

    if (!input) {
        await ctx.reply('Usage: `/untrack <address or label>`', { parse_mode: 'MarkdownV2' });
        return;
    }

    // Try exact address match first
    const removedByAddress = await walletRepo.removeSubscription(chatId, input);
    if (removedByAddress) {
        await ctx.reply(
            `✅ Stopped tracking \`${escapeMarkdown(input)}\``,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    // Try label match (case-insensitive)
    const subs = await walletRepo.listSubscriptions(chatId);
    const matches = subs.filter((s) => s.label.toLowerCase() === input.toLowerCase());

    if (matches.length === 0) {
        await ctx.reply(
            `⚠️ No tracked wallet found for \`${escapeMarkdown(input)}\``,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    if (matches.length > 1) {
        const list = matches
            .map((s) => `• \`${escapeMarkdown(s.address)}\` — ${escapeMarkdown(s.label)}`)
            .join('\n');
        await ctx.reply(
            `⚠️ Multiple wallets match label *${escapeMarkdown(input)}*\\. Use the address:\n\n${list}`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const sub = matches[0];
    if (!sub) return;
    await walletRepo.removeSubscription(chatId, sub.address);
    await ctx.reply(
        `✅ Stopped tracking *${escapeMarkdown(sub.label)}*\n\`${escapeMarkdown(sub.address)}\``,
        { parse_mode: 'MarkdownV2' },
    );
}
