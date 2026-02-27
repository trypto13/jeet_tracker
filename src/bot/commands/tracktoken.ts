import type { CommandContext, Context } from 'grammy';
import { AddressVerificator } from '@btc-vision/transaction';
import { getContract, OP_20_ABI, OP_721_ABI, type IOP20Contract, type IOP721Contract } from 'opnet';
import { providerManager } from '../../provider/ProviderManager.js';
import { tokenRepo } from '../../db/TokenRepository.js';
import { bitcoinNetwork } from '../../config.js';

const MAX_TOKENS_PER_USER = 20;

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/** Try to identify and fetch basic info for a token contract. Returns null if not a valid token. */
async function detectToken(contractAddress: string): Promise<{
    tokenType: 'op20' | 'op721';
    name: string;
    symbol: string;
    decimals?: number;
    totalSupply?: bigint;
} | null> {
    const provider = providerManager.getProvider();
    const network = bitcoinNetwork;

    // Try OP-20 first
    try {
        const contract = getContract<IOP20Contract>(contractAddress, OP_20_ABI, provider, network);
        const [nameRes, symRes, decRes, supplyRes] = await Promise.all([
            contract.name(),
            contract.symbol(),
            contract.decimals(),
            contract.totalSupply(),
        ]);
        const name   = (nameRes.properties['name']         as string | undefined) ?? '';
        const symbol = (symRes.properties['symbol']        as string | undefined) ?? '';
        const decimals    = (decRes.properties['decimals']       as number | undefined);
        const totalSupply = (supplyRes.properties['totalSupply'] as bigint | undefined);
        if (symbol) return {
            tokenType: 'op20' as const,
            name,
            symbol,
            ...(decimals    !== undefined && { decimals }),
            ...(totalSupply !== undefined && { totalSupply }),
        };
    } catch { /* not OP-20 */ }

    // Try OP-721
    try {
        const contract = getContract<IOP721Contract>(contractAddress, OP_721_ABI, provider, network);
        const [nameRes, symRes] = await Promise.all([contract.name(), contract.symbol()]);
        const name   = (nameRes.properties['name']   as string | undefined) ?? '';
        const symbol = (symRes.properties['symbol']  as string | undefined) ?? '';
        if (symbol) return { tokenType: 'op721', name, symbol };
    } catch { /* not OP-721 */ }

    return null;
}

export async function trackTokenCommand(ctx: CommandContext<Context>): Promise<void> {
    const args = ctx.match.trim().split(/\s+/);
    const contractAddress = args[0] ?? '';
    const label = args.slice(1).join(' ') || undefined;

    if (!contractAddress) {
        await ctx.reply(
            'Usage: `/tracktoken <contractAddress> \\[label\\]`\n\nExample:\n`/tracktoken op1abc\\.\\.\\. MOTO`',
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
            `❌ Invalid contract address\\. Must be a P2OP address \\(op1… / opr1…\\) or 0x hex\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const thinking = await ctx.reply('⏳ _Detecting token…_', { parse_mode: 'MarkdownV2' });

    const info = await detectToken(contractAddress).catch(() => null);
    if (!info) {
        await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            `❌ Could not identify contract as OP\\-20 or OP\\-721\\. Check the address and try again\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const tokenLabel = label ?? info.symbol;
    const chatId = ctx.chat.id;

    const result = tokenRepo.addTokenSubscription(
        chatId,
        contractAddress,
        tokenLabel,
        info.tokenType,
        MAX_TOKENS_PER_USER,
    );

    if (result === 'duplicate') {
        await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            `ℹ️ Already tracking *${escapeMarkdown(tokenLabel)}*\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    if (result === 'limit_exceeded') {
        await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            `❌ You have reached the limit of ${MAX_TOKENS_PER_USER} tracked tokens\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const typeLabel = info.tokenType === 'op20' ? 'OP\\-20' : 'OP\\-721';
    const lines = [
        `✅ *Now tracking ${escapeMarkdown(tokenLabel)}*`,
        ``,
        `🪙 Type: ${typeLabel}`,
        `🏷 Symbol: \`${escapeMarkdown(info.symbol)}\``,
        `📍 \`${escapeMarkdown(contractAddress)}\``,
    ];
    if (info.decimals !== undefined) {
        lines.push(`🔢 Decimals: ${info.decimals.toString()}`);
    }
    if (info.tokenType === 'op20') {
        lines.push(
            ``,
            `_Default alerts: price ±5%, all reservations_`,
            `_Use /tokenalerts to customize thresholds_`,
        );
    }

    await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, lines.join('\n'), {
        parse_mode: 'MarkdownV2',
    });
}
