import type { CommandContext, Context } from 'grammy';
import { AddressVerificator } from '@btc-vision/transaction';
import { type Network } from '@btc-vision/bitcoin';
import { getContract, OP_721_ABI, type IOP721Contract } from 'opnet';
import { providerManager } from '../../provider/ProviderManager.js';
import { walletRepo } from '../../db/WalletRepository.js';
import { bitcoinNetwork } from '../../config.js';
import { fetchBalances } from '../../api/IndexerClient.js';

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
    return `${whole.toLocaleString()}.${frac.toString().padStart(decimals, '0').slice(0, 6)}`;
}

interface TokenBalance {
    symbol: string;
    amount: bigint;
    decimals: number;
    contractAddress: string;
}

export interface NftBalance {
    contractAddress: string;
    name: string;
    symbol: string;
    count: bigint;
}

export interface AddressBalance {
    /** Address type label, e.g. 'P2TR', 'P2WPKH', 'P2PKH', 'CSV1' */
    type: string;
    /** The full Bitcoin address */
    address: string;
    satoshis: bigint;
}

/**
 * Resolve the OPNet MLDSA owner for any address type.
 */
async function resolveOwner(address: string) {
    const provider = providerManager.getProvider();

    // Level 1: direct lookup
    try {
        const owner = await provider.getPublicKeyInfo(address, false);
        if (owner) return owner;
    } catch { /* no on-chain OPNet history for this address */ }

    // Level 2: stored MLDSA hash for tracked wallets
    const stored = walletRepo.getLinkedAddressesFor(address);
    if (stored?.mldsaHash) {
        try {
            const owner = await provider.getPublicKeyInfo('0x' + stored.mldsaHash, false);
            if (owner) return owner;
        } catch { /* */ }
    }

    // Level 3: address might be a linked alias (p2wpkh/p2pkh) of a tracked subscription
    const parentSub = walletRepo.findSubscriptionByLinkedAddress(address);
    if (parentSub?.linkedAddresses?.mldsaHash) {
        try {
            const owner = await provider.getPublicKeyInfo('0x' + parentSub.linkedAddresses.mldsaHash, false);
            if (owner) return owner;
        } catch { /* */ }
    }

    return null;
}

/**
 * Fetch BTC (per address type) + CSV1 + all discovered OP-20 token balances.
 */
export async function fetchAllBalances(address: string): Promise<{
    addressBalances: AddressBalance[];
    tokens: TokenBalance[];
    nfts: NftBalance[];
}> {
    const provider = providerManager.getProvider();
    const network: Network = bitcoinNetwork;

    const ownerAddress = await resolveOwner(address);

    const addressBalances: AddressBalance[] = [];

    if (ownerAddress) {
        const candidates: Array<{ type: string; addr: string }> = [];
        try { candidates.push({ type: 'P2TR',   addr: ownerAddress.p2tr(network) }); }   catch { /* */ }
        try { candidates.push({ type: 'P2WPKH', addr: ownerAddress.p2wpkh(network) }); } catch { /* */ }
        try { candidates.push({ type: 'P2PKH',  addr: ownerAddress.p2pkh(network) }); }  catch { /* */ }

        const seen = new Set<string>();
        const unique = candidates.filter(({ addr }) => {
            if (seen.has(addr)) return false;
            seen.add(addr);
            return true;
        });

        await Promise.all(unique.map(async ({ type, addr }) => {
            try {
                const sats = await provider.getBalance(addr, true);
                if (sats > 0n) addressBalances.push({ type, address: addr, satoshis: sats });
            } catch { /* */ }
        }));

        // CSV1
        try {
            const csvInfo = provider.getCSV1ForAddress(ownerAddress);
            const utxos = await provider.utxoManager.getUTXOs({
                address: csvInfo.address,
                isCSV: true,
                mergePendingUTXOs: true,
            });
            let csv1 = 0n;
            for (const u of utxos) csv1 += u.value;
            if (csv1 > 0n) addressBalances.push({ type: 'CSV1', address: csvInfo.address, satoshis: csv1 });
        } catch { /* originalPublicKey not available — CSV1 skipped */ }
    } else {
        try {
            const sats = await provider.getBalance(address, true);
            if (sats > 0n) {
                const type =
                    address.startsWith('bc1p') || address.startsWith('bcrt1p') ? 'P2TR' :
                    address.startsWith('bc1q') || address.startsWith('bcrt1q') ? 'P2WPKH' :
                    'P2PKH';
                addressBalances.push({ type, address, satoshis: sats });
            }
        } catch { /* */ }
    }

    // Sort: P2TR → P2WPKH → P2PKH → CSV1
    const typeOrder: Record<string, number> = { P2TR: 0, P2WPKH: 1, P2PKH: 2, CSV1: 3 };
    addressBalances.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

    // ── OP-20 token balances (from indexer) ──────────────────────────────────

    const tokens: TokenBalance[] = [];

    if (ownerAddress) {
        try {
            const indexerBalances = await fetchBalances(address);
            for (const b of indexerBalances.balances) {
                const bal = BigInt(b.balance);
                if (bal === 0n) continue;
                tokens.push({
                    contractAddress: b.contractAddress,
                    symbol: b.symbol || b.contractAddress.slice(0, 8),
                    amount: bal,
                    decimals: b.decimals,
                });
            }
        } catch (err: unknown) {
            console.warn('[Balance] Indexer balance fetch failed, falling back to empty:', err instanceof Error ? err.message : String(err));
        }
    }

    tokens.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // ── OP-721 NFT balances (still RPC-based — indexer doesn't track OP-721) ─

    const nfts: NftBalance[] = [];

    if (ownerAddress) {
        const discoveredNfts = walletRepo.getNftContracts(address);
        const nftContractSet = new Set(discoveredNfts);

        await Promise.all(
            [...nftContractSet].map(async (contractAddress) => {
                try {
                    const contract = getContract<IOP721Contract>(
                        contractAddress,
                        OP_721_ABI,
                        provider,
                        network,
                    );

                    const [balResult, nameResult, symResult] = await Promise.all([
                        contract.balanceOf(ownerAddress),
                        contract.name(),
                        contract.symbol(),
                    ]);

                    const count = balResult.properties['balance'] as bigint | undefined;
                    if (count === undefined || count === 0n) return;

                    nfts.push({
                        contractAddress,
                        name:   (nameResult.properties['name']   as string | undefined) ?? contractAddress.slice(0, 8),
                        symbol: (symResult.properties['symbol']  as string | undefined) ?? '???',
                        count,
                    });
                } catch { /* contract call failed */ }
            }),
        );
    }

    nfts.sort((a, b) => a.name.localeCompare(b.name));

    return { addressBalances, tokens, nfts };
}

function buildBalanceMessage(
    address: string,
    label: string | null,
    addressBalances: AddressBalance[],
    tokens: TokenBalance[],
    nfts: NftBalance[] = [],
): string {
    const displayName = label ?? address;

    const lines: string[] = [
        `💰 *Balance — ${escapeMarkdown(displayName)}*`,
        ``,
        `📍 \`${escapeMarkdown(address)}\``,
    ];

    if (addressBalances.length > 0) {
        lines.push('');

        for (const { type, address: addr, satoshis } of addressBalances) {
            lines.push(`*${escapeMarkdown(type)}:* \`${escapeMarkdown(formatSats(satoshis))}\``);
            lines.push(`  \`${escapeMarkdown(addr)}\``);
        }

        const total = addressBalances.reduce((sum, a) => sum + a.satoshis, 0n);
        if (addressBalances.length > 1) {
            lines.push('');
            lines.push(`*Grand Total:* \`${escapeMarkdown(formatSats(total))}\``);
        }
    } else {
        lines.push('', `_No BTC balance found_`);
    }

    if (tokens.length > 0) {
        lines.push('');
        for (const t of tokens) {
            lines.push(
                `*${escapeMarkdown(t.symbol)}:* \`${escapeMarkdown(formatTokenAmount(t.amount, t.decimals))}\``,
            );
        }
    } else {
        lines.push('', `_No OP\\-20 token balances found_`);
    }

    if (nfts.length > 0) {
        lines.push('', `🖼️ *NFTs*`);
        for (const n of nfts) {
            lines.push(
                `*${escapeMarkdown(n.name)}* \\(${escapeMarkdown(n.symbol)}\\): \`${n.count.toString()}\``,
            );
        }
    }

    return lines.join('\n');
}

async function runBalanceCheck(
    address: string,
    label: string | null,
    thinkingFn: () => Promise<{ message_id: number }>,
    editFn: (msgId: number, text: string) => Promise<unknown>,
): Promise<void> {
    const thinking = await thinkingFn();
    try {
        const { addressBalances, tokens, nfts } = await fetchAllBalances(address);
        await editFn(thinking.message_id, buildBalanceMessage(address, label, addressBalances, tokens, nfts));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Balance] Error:', msg);
        await editFn(
            thinking.message_id,
            `❌ Error fetching balance:\n${escapeMarkdown(msg)}`,
        );
    }
}

export async function balanceCommand(ctx: CommandContext<Context>): Promise<void> {
    const address = ctx.match.trim();

    if (!address) {
        await ctx.reply('Usage: `/balance <address>`', { parse_mode: 'MarkdownV2' });
        return;
    }

    const net = bitcoinNetwork;
    const valid =
        AddressVerificator.detectAddressType(address, net) !== null ||
        AddressVerificator.isValidP2OPAddress(address, net) ||
        /^0x[0-9a-fA-F]{64}$/.test(address); // MLDSA hex

    if (!valid) {
        await ctx.reply(
            `❌ Invalid address: \`${escapeMarkdown(address)}\``,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    await runBalanceCheck(
        address,
        null,
        () => ctx.reply('⏳ Fetching balances…'),
        (msgId, text) =>
            ctx.api.editMessageText(ctx.chat.id, msgId, text, { parse_mode: 'MarkdownV2' }),
    );
}

export async function inlineBalanceHandler(
    address: string,
    label: string,
    thinkingFn: () => Promise<{ message_id: number }>,
    editFn: (msgId: number, text: string) => Promise<unknown>,
): Promise<void> {
    await runBalanceCheck(address, label, thinkingFn, editFn);
}
