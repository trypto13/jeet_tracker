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

function shortAddr(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatTokenAmount(raw: bigint, decimals: number): string {
    if (decimals === 0) return raw.toLocaleString();
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

export async function listingsCommand(ctx: CommandContext<Context>): Promise<void> {
    const contractAddress = ctx.match.trim();

    if (!contractAddress) {
        await ctx.reply(
            'Usage: `/listings <contractAddress>`\n\nShows active NativeSwap liquidity providers for an OP\\-20 token\\.',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const net = bitcoinNetwork;
    const valid =
        AddressVerificator.isValidP2OPAddress(contractAddress, net) ||
        /^0x[0-9a-fA-F]{64}$/.test(contractAddress);

    if (!valid) {
        await ctx.reply(
            `❌ Invalid contract address\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const thinking = await ctx.reply('⏳ _Fetching listings…_', { parse_mode: 'MarkdownV2' });

    try {
        // Fetch token symbol + decimals via RPC (indexer doesn't return symbol in listings)
        const provider = providerManager.getProvider();
        const network = bitcoinNetwork;
        let symbol = contractAddress.slice(0, 8);
        let decimals = 8;
        try {
            const contract = getContract<IOP20Contract>(contractAddress, OP_20_ABI, provider, network);
            const [symRes, decRes] = await Promise.all([contract.symbol(), contract.decimals()]);
            symbol   = (symRes.properties['symbol']   as string | undefined) ?? symbol;
            decimals = (decRes.properties['decimals'] as number | undefined) ?? decimals;
        } catch { /* use defaults */ }

        const [pricesData, listingsData] = await Promise.all([
            fetchPrices(contractAddress).catch(() => null),
            fetchListings(contractAddress).catch(() => null),
        ]);

        if (!pricesData && !listingsData) {
            await ctx.api.editMessageText(
                ctx.chat.id,
                thinking.message_id,
                `❌ No NativeSwap pool found for this contract\\.`,
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }

        const virtualBTCReserve = pricesData ? BigInt(pricesData.current.virtualBTCReserve) : 0n;
        const virtualTokenReserve = pricesData ? BigInt(pricesData.current.virtualTokenReserve) : 0n;
        const priceSats = virtualTokenReserve > 0n
            ? (virtualBTCReserve * 10n ** 8n) / virtualTokenReserve
            : 0n;

        const totalListings = listingsData?.totalListings ?? 0;
        const priorityCount = listingsData?.priorityCount ?? 0;
        const standardCount = listingsData?.standardCount ?? 0;
        const allProviders = [
            ...(listingsData?.priority ?? []),
            ...(listingsData?.standard ?? []),
        ];

        const lines: string[] = [
            `📋 *Listings — ${escapeMarkdown(symbol)}*`,
            ``,
            `💰 Price: \`${escapeMarkdown(formatSats(priceSats))} / token\``,
            `🏊 Pool: \`${escapeMarkdown(formatSats(virtualBTCReserve))}\` virtual BTC`,
            `📊 Total Listings: \`${totalListings.toString()}\` \\(${priorityCount} priority \\+ ${standardCount} standard\\)`,
        ];

        if (allProviders.length === 0) {
            lines.push('', '_No active providers in queue_');
        } else {
            const priorityProviders = listingsData?.priority ?? [];
            const standardProviders = listingsData?.standard ?? [];

            if (priorityProviders.length > 0) {
                lines.push('', `⚡ *Priority Queue \\(${priorityProviders.length.toString()}\\):*`);
                for (const p of priorityProviders) {
                    const addr = shortAddr(p.btcReceiver);
                    const liq = formatTokenAmount(BigInt(p.liquidity), decimals);
                    const reserved = BigInt(p.reserved);
                    const res = reserved > 0n ? ` \\(${escapeMarkdown(formatTokenAmount(reserved, decimals))} reserved\\)` : '';
                    lines.push(`  • \`${escapeMarkdown(addr)}\` — ${escapeMarkdown(liq)} ${escapeMarkdown(symbol)}${res}`);
                }
            }
            if (standardProviders.length > 0) {
                lines.push('', `📋 *Standard Queue \\(${standardProviders.length.toString()}\\):*`);
                for (const p of standardProviders) {
                    const addr = shortAddr(p.btcReceiver);
                    const liq = formatTokenAmount(BigInt(p.liquidity), decimals);
                    const reserved = BigInt(p.reserved);
                    const res = reserved > 0n ? ` \\(${escapeMarkdown(formatTokenAmount(reserved, decimals))} reserved\\)` : '';
                    lines.push(`  • \`${escapeMarkdown(addr)}\` — ${escapeMarkdown(liq)} ${escapeMarkdown(symbol)}${res}`);
                }
            }
            if (totalListings > allProviders.length) {
                lines.push('', `_\\+${(totalListings - allProviders.length).toString()} more providers not shown_`);
            }
        }

        await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            `❌ Error fetching listings: ${escapeMarkdown(msg)}`,
            { parse_mode: 'MarkdownV2' },
        );
    }
}
