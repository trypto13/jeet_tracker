import type { CommandContext, Context } from 'grammy';
import { tokenRepo } from '../../db/TokenRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function tokenAlertsCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;
    const args = ctx.match.trim().split(/\s+/);

    // /tokenalerts — list current thresholds
    if (args.length < 1 || !args[0]) {
        const subs = tokenRepo.listTokenSubscriptions(chatId);
        if (subs.length === 0) {
            await ctx.reply(
                '_No tokens tracked\\. Use /tracktoken to add one\\._',
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }
        const lines = ['⚙️ *Token Alert Thresholds*', ''];
        for (const sub of subs) {
            const priceStr = sub.priceThresholdPct > 0 ? `±${sub.priceThresholdPct}%` : 'off';
            const resStr = sub.minReservationSats > 0
                ? `≥${(sub.minReservationSats / 1e8).toFixed(4)} BTC`
                : 'all';
            lines.push(`*${escapeMarkdown(sub.label)}*`);
            lines.push(`  Price alert: \`${escapeMarkdown(priceStr)}\``);
            lines.push(`  Min reservation: \`${escapeMarkdown(resStr)}\``);
            lines.push('');
        }
        lines.push('_Usage: /tokenalerts <label> <priceThresholdPct> <minReservationBTC>_');
        lines.push('_Example: /tokenalerts MOTO 3 0\\.001_');
        await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
        return;
    }

    // /tokenalerts <label> <priceThresholdPct> <minReservationBTC>
    if (args.length < 3) {
        await ctx.reply(
            'Usage: `/tokenalerts <label> <priceThresholdPct> <minReservationBTC>`\n\n' +
            'Examples:\n' +
            '`/tokenalerts MOTO 5 0` — alert on ±5% price, all reservations\n' +
            '`/tokenalerts MOTO 0 0.001` — price alerts off, reservations ≥ 0\\.001 BTC\n' +
            '`/tokenalerts MOTO 0 0` — disable all alerts',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const labelArg = args[0] ?? '';
    const pctArg   = args[1] ?? '';
    const btcArg   = args[2] ?? '';

    const priceThresholdPct = parseFloat(pctArg);
    const minReservationBTC = parseFloat(btcArg);

    if (isNaN(priceThresholdPct) || isNaN(minReservationBTC) || priceThresholdPct < 0 || minReservationBTC < 0) {
        await ctx.reply(
            '❌ Invalid numbers\\. Both values must be ≥ 0\\.',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    // Find subscription by label (case-insensitive)
    const subs = tokenRepo.listTokenSubscriptions(chatId);
    const sub = subs.find((s) => s.label.toLowerCase() === labelArg.toLowerCase())
        ?? subs.find((s) => s.contractAddress.toLowerCase() === labelArg.toLowerCase());

    if (!sub) {
        await ctx.reply(
            `❌ No tracked token found with label \`${escapeMarkdown(labelArg)}\`\\.\n_Use /untracktokens to see your tracked tokens\\._`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const minReservationSats = Math.round(minReservationBTC * 1e8);
    const updated = tokenRepo.updateThresholds(
        chatId,
        sub.contractAddress,
        Math.round(priceThresholdPct),
        minReservationSats,
    );

    if (!updated) {
        await ctx.reply('❌ Failed to update thresholds\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    const priceStr = priceThresholdPct > 0 ? `±${Math.round(priceThresholdPct).toString()}%` : 'off';
    const resStr   = minReservationSats > 0 ? `≥${minReservationBTC.toFixed(4)} BTC` : 'all';

    await ctx.reply(
        [
            `✅ *Updated — ${escapeMarkdown(sub.label)}*`,
            ``,
            `📈 Price alert: \`${escapeMarkdown(priceStr)}\``,
            `🔔 Min reservation: \`${escapeMarkdown(resStr)}\``,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' },
    );
}
