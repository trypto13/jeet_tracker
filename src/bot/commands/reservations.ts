import type { CommandContext, Context } from 'grammy';
import { AddressVerificator } from '@btc-vision/transaction';
import { getContract, OP_20_ABI, type IOP20Contract } from 'opnet';
import { providerManager } from '../../provider/ProviderManager.js';
import { bitcoinNetwork } from '../../config.js';
import { fetchPrices, fetchListings } from '../../api/IndexerClient.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

function formatSats(sats: bigint): string {
    return `${(Number(sats) / 1e8).toFixed(8)} BTC`;
}

export async function reservationsCommand(ctx: CommandContext<Context>): Promise<void> {
    const contractAddress = ctx.match.trim();

    if (!contractAddress) {
        await ctx.reply(
            'Usage: `/reservations <contractAddress>`\n\nShows pending NativeSwap reservation state for an OP\\-20 token\\.',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const net = bitcoinNetwork;
    const valid =
        AddressVerificator.isValidP2OPAddress(contractAddress, net) ||
        /^0x[0-9a-fA-F]{64}$/.test(contractAddress);

    if (!valid) {
        await ctx.reply(`❌ Invalid contract address\\.`, { parse_mode: 'MarkdownV2' });
        return;
    }

    const thinking = await ctx.reply('⏳ _Fetching reservation data…_', { parse_mode: 'MarkdownV2' });

    try {
        // Fetch token symbol via RPC
        const provider = providerManager.getProvider();
        const network = bitcoinNetwork;
        let symbol = contractAddress.slice(0, 8);
        try {
            const contract = getContract<IOP20Contract>(contractAddress, OP_20_ABI, provider, network);
            const symRes = await contract.symbol();
            symbol = (symRes.properties['symbol'] as string | undefined) ?? symbol;
        } catch { /* use default */ }

        const [pricesData, listingsData] = await Promise.all([
            fetchPrices(contractAddress).catch(() => null),
            fetchListings(contractAddress).catch(() => null),
        ]);

        if (!pricesData) {
            await ctx.api.editMessageText(
                ctx.chat.id,
                thinking.message_id,
                `❌ No NativeSwap pool found for this contract\\.`,
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }

        const virtualBTCReserve = BigInt(pricesData.current.virtualBTCReserve);
        const virtualTokenReserve = BigInt(pricesData.current.virtualTokenReserve);
        const reservedLiquidity = BigInt(pricesData.current.reservedLiquidity);

        const priceSats = virtualTokenReserve > 0n
            ? (virtualBTCReserve * 10n ** 8n) / virtualTokenReserve
            : 0n;

        const totalListings = listingsData?.totalListings ?? 0;
        const priorityCount = listingsData?.priorityCount ?? 0;
        const standardCount = listingsData?.standardCount ?? 0;

        const lines = [
            `⏳ *Reservations — ${escapeMarkdown(symbol)}*`,
            ``,
            `💰 Price: \`${escapeMarkdown(formatSats(priceSats))} / token\``,
            `🏊 Pool BTC: \`${escapeMarkdown(formatSats(virtualBTCReserve))}\``,
            `🔒 Reserved Liquidity: \`${escapeMarkdown(formatSats(reservedLiquidity))}\``,
            ``,
            `📊 Active Listings: \`${totalListings.toString()}\``,
            `  ⚡ Priority: \`${priorityCount.toString()}\``,
            `  📋 Standard: \`${standardCount.toString()}\``,
            ``,
            `_Real\\-time reservation events are tracked for wallets you follow_`,
            `_Use /listings to see who is listed_`,
        ];

        await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            `❌ Error fetching reservation data: ${escapeMarkdown(msg)}`,
            { parse_mode: 'MarkdownV2' },
        );
    }
}
