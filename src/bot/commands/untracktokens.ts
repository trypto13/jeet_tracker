import type { CommandContext, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { tokenRepo } from '../../db/TokenRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function untracktokensCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;
    const subs = tokenRepo.listTokenSubscriptions(chatId);

    if (subs.length === 0) {
        await ctx.reply(
            '_No tokens being tracked\\. Use /tracktoken to add one\\._',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const keyboard = new InlineKeyboard();
    const lines = ['📋 *Tracked Tokens*', ''];

    for (const sub of subs) {
        const typeLabel = sub.tokenType === 'op20' ? 'OP-20' : 'OP-721';
        const priceStr = sub.priceThresholdPct > 0 ? `±${sub.priceThresholdPct}%` : 'off';
        const resStr = sub.minReservationSats > 0
            ? `≥${(sub.minReservationSats / 1e8).toFixed(4)} BTC`
            : 'all';

        lines.push(
            `*${escapeMarkdown(sub.label)}* \\[${escapeMarkdown(typeLabel)}\\]`,
            `  \`${escapeMarkdown(sub.contractAddress.slice(0, 20))}…\``,
            `  Price alert: ${escapeMarkdown(priceStr)} · Reservation: ${escapeMarkdown(resStr)}`,
            '',
        );
        keyboard.text(`❌ ${sub.label}`, `ut_tok_${sub.id}`).row();
    }

    await ctx.reply(lines.join('\n'), {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
    });
}
