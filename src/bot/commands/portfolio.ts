import type { CommandContext, Context } from 'grammy';
import { walletRepo } from '../../db/WalletRepository.js';
import { fetchAllBalances } from './balance.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

function formatSats(sats: bigint): string {
    return `${(Number(sats) / 1e8).toFixed(8)} BTC`;
}

function formatTokenAmount(raw: bigint, decimals: number): string {
    if (decimals === 0) return raw.toLocaleString();
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    return `${whole.toLocaleString()}.${frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')}`;
}

export async function portfolioCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;
    const subs = await walletRepo.listSubscriptions(chatId);

    if (subs.length === 0) {
        await ctx.reply(
            '_No wallets being tracked\\. Use /track to add one\\._',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const thinking = await ctx.reply('⏳ _Loading portfolio\\.\\.\\._', { parse_mode: 'MarkdownV2' });

    try {
        const results = await Promise.allSettled(
            subs.map((sub) => fetchAllBalances(sub.address).then((b) => ({ sub, ...b }))),
        );

        const lines: string[] = ['📊 *Portfolio*', ''];
        let grandBtc = 0n;
        const tokenTotals = new Map<string, { symbol: string; amount: bigint; decimals: number }>();
        const nftTotals = new Map<string, { name: string; symbol: string; count: bigint }>();

        for (const result of results) {
            if (result.status === 'rejected') continue;
            const { sub, addressBalances, tokens, nfts } = result.value;
            const walletBtc = addressBalances.reduce((s, a) => s + a.satoshis, 0n);
            grandBtc += walletBtc;

            lines.push(`*${escapeMarkdown(sub.label)}*`);
            if (walletBtc > 0n) {
                lines.push(`  💰 \`${escapeMarkdown(formatSats(walletBtc))}\``);
            }
            for (const t of tokens) {
                lines.push(
                    `  🪙 ${escapeMarkdown(t.symbol)}: \`${escapeMarkdown(formatTokenAmount(t.amount, t.decimals))}\``,
                );
                const existing = tokenTotals.get(t.symbol);
                if (existing) {
                    existing.amount += t.amount;
                } else {
                    tokenTotals.set(t.symbol, { symbol: t.symbol, amount: t.amount, decimals: t.decimals });
                }
            }
            for (const n of nfts) {
                lines.push(`  🖼️ ${escapeMarkdown(n.name)}: \`${n.count.toString()}\``);
                const existing = nftTotals.get(n.symbol);
                if (existing) {
                    existing.count += n.count;
                } else {
                    nftTotals.set(n.symbol, { name: n.name, symbol: n.symbol, count: n.count });
                }
            }
            if (walletBtc === 0n && tokens.length === 0 && nfts.length === 0) {
                lines.push(`  _empty_`);
            }
            lines.push('');
        }

        lines.push(`*Total BTC:* \`${escapeMarkdown(formatSats(grandBtc))}\``);

        if (tokenTotals.size > 0) {
            lines.push('', '*Token Totals:*');
            for (const [, t] of tokenTotals) {
                lines.push(
                    `  🪙 ${escapeMarkdown(t.symbol)}: \`${escapeMarkdown(formatTokenAmount(t.amount, t.decimals))}\``,
                );
            }
        }

        if (nftTotals.size > 0) {
            lines.push('', '*NFT Totals:*');
            for (const [, n] of nftTotals) {
                lines.push(`  🖼️ ${escapeMarkdown(n.name)} \\(${escapeMarkdown(n.symbol)}\\): \`${n.count.toString()}\``);
            }
        }

        await ctx.api.editMessageText(chatId, thinking.message_id, lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.api.editMessageText(
            chatId, thinking.message_id,
            `❌ Error loading portfolio: ${escapeMarkdown(msg)}`,
            { parse_mode: 'MarkdownV2' },
        );
    }
}
