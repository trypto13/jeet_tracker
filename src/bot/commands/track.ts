import type { CommandContext, Context } from 'grammy';
import { AddressVerificator } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { walletRepo } from '../../db/WalletRepository.js';
import type { LinkedAddresses } from '../../db/WalletRepository.js';
import { providerManager } from '../../provider/ProviderManager.js';
import { config } from '../../config.js';
import { scanHistory } from '../../tracker/HistoricalScanner.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Validate a standard Bitcoin wallet address (bc1p, bc1q, bcrt1p, bcrt1q, legacy).
 * P2OP addresses (op1/opr1) are intentionally excluded.
 */
function isValidBitcoinAddress(address: string): boolean {
    const net = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;
    return AddressVerificator.detectAddressType(address, net) !== null;
}

function isP2OPAddress(address: string): boolean {
    const net = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;
    return AddressVerificator.isValidP2OPAddress(address, net);
}

/** Accept OPNet MLDSA hex addresses: 0x followed by exactly 64 hex characters. */
function isValidMldsaHex(address: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(address);
}

export async function trackCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;
    const args = ctx.match.trim().split(/\s+/);
    const address = args[0];

    if (!address) {
        await ctx.reply('Usage: `/track <address> [label]`', {
            parse_mode: 'MarkdownV2',
        });
        return;
    }

    if (isP2OPAddress(address)) {
        await ctx.reply(
            `❌ *P2OP addresses cannot be tracked\\.*\n\n` +
            `P2OP \\(\`op1\`/\`opr1\`\\) addresses are derived from your MLDSA key but cannot be used to match on\\-chain events\\.\n\n` +
            `Use your *Bitcoin address* \\(\`bcrt1p\` / \`bcrt1q\`\\) or your *MLDSA key* \\(\`0x…\`\\) instead\\.`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    if (!isValidBitcoinAddress(address) && !isValidMldsaHex(address)) {
        await ctx.reply(
            `❌ Invalid address: \`${escapeMarkdown(address)}\`\n\n` +
            `Supported formats:\n• Bitcoin: \`bc1p\`, \`bc1q\`, \`bcrt1p\`, \`bcrt1q\`\n• MLDSA key: \`0x…\` \\(64 hex chars\\)`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const label = args.slice(1).join(' ') || address;

    // ── Resolve MLDSA identity ─────────────────────────────────────────────────
    // Done synchronously so we can: (a) detect cross-format duplicates and
    // (b) store linked addresses immediately on a successful add.
    let linkedResult: LinkedAddresses | undefined;
    let mldsaHash: string | undefined;

    try {
        const provider = providerManager.getProvider();
        const owner = await provider.getPublicKeyInfo(address, false);
        if (owner) {
            const net = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;
            mldsaHash = Buffer.from(owner).toString('hex').toLowerCase();

            let p2tr: string | undefined;
            let p2wpkh: string | undefined;
            let p2pkh: string | undefined;
            let csv1: string | undefined;
            try { p2tr = owner.p2tr(net); } catch { /* requires originalPublicKey */ }
            try { p2wpkh = owner.p2wpkh(net); } catch { /* requires originalPublicKey */ }
            try { p2pkh = owner.p2pkh(net); } catch { /* requires originalPublicKey */ }
            try { csv1 = provider.getCSV1ForAddress(owner).address; } catch { /* requires originalPublicKey */ }

            linkedResult = {
                mldsaHash,
                ...(p2tr   !== undefined && { p2tr }),
                ...(p2wpkh !== undefined && { p2wpkh }),
                ...(p2pkh  !== undefined && { p2pkh }),
                ...(csv1   !== undefined && { csv1 }),
            };
        }
    } catch (err: unknown) {
        console.warn(
            '[Track] MLDSA resolution failed:',
            err instanceof Error ? err.message : String(err),
        );
    }

    // ── Cross-format duplicate detection ──────────────────────────────────────
    // Prevent the same wallet (same MLDSA identity) from being tracked twice
    // even when added with different address formats (e.g., bc1p then 0x…).
    if (mldsaHash) {
        const existing = walletRepo.findSubscriptionByMldsaHash(mldsaHash);
        if (existing && existing.address !== address) {
            await ctx.reply(
                `⚠️ Already tracking this wallet as \`${escapeMarkdown(existing.address)}\`\nLabel: *${escapeMarkdown(existing.label)}*`,
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }
    }

    const result = await walletRepo.addSubscription(
        chatId,
        address,
        label,
        config.maxWalletsPerUser,
    );

    switch (result) {
        case 'added':
            // Store linked addresses immediately — no need for a second RPC round-trip.
            if (linkedResult) walletRepo.updateLinkedAddresses(address, linkedResult);

            await ctx.reply(
                `✅ Now tracking:\n\`${escapeMarkdown(address)}\`\nLabel: *${escapeMarkdown(label)}*\n\n` +
                    `_Scanning recent blocks for token history\\.\\.\\._`,
                { parse_mode: 'MarkdownV2' },
            );
            // Fire-and-forget — runs in background, doesn't block the bot
            void scanHistory(address);
            break;

        case 'duplicate':
            await ctx.reply(
                `⚠️ Already tracking \`${escapeMarkdown(address)}\``,
                { parse_mode: 'MarkdownV2' },
            );
            break;

        case 'limit_exceeded':
            await ctx.reply(
                `❌ You've reached the limit of ${config.maxWalletsPerUser} tracked wallets\\.\n` +
                    `Use /untrack to remove one first\\.`,
                { parse_mode: 'MarkdownV2' },
            );
            break;
    }
}
