import type { CommandContext, Context } from 'grammy';
import { AddressVerificator } from '@btc-vision/transaction';
import { networks, type Network } from '@btc-vision/bitcoin';
import { getContract, OP_20_ABI, type IOP20Contract } from 'opnet';
import { providerManager } from '../../provider/ProviderManager.js';
import { walletRepo } from '../../db/WalletRepository.js';
import { config } from '../../config.js';

// Known OP-20 contracts to always check per network.
const ALWAYS_CHECK: Record<'mainnet' | 'regtest', string[]> = {
    mainnet: [
        '0x75bd98b086b71010448ec5722b6020ce1e0f2c09f5d680c84059db1295948cf8', // MOTO
    ],
    regtest: [
        '0x0a6732489a31e6de07917a28ff7df311fc5f98f6e1664943ac1c3fe7893bdab5', // MOTO
        '0xfb7df2f08d8042d4df0506c0d4cee3cfa5f2d7b02ef01ec76dd699551393a438', // PILL
        '0xc573930e4c67f47246589ce6fa2dbd1b91b58c8fdd7ace336ce79e65120f79eb', // ODYS
    ],
};

// OP20_DEPLOYER factory — enumerates ALL tokens deployed via the factory.
const OP20_DEPLOYER_ADDRESS: Record<'mainnet' | 'regtest', string | null> = {
    mainnet: null,
    regtest: '0x1d2d60f610018e30c043f5a2af2ce57931759358f83ed144cb32717a9ad22345',
};

// Minimal inline ABI for the two factory read methods we need.
const FACTORY_ABI = [
    {
        name: 'getDeploymentsCount',
        type: 'function' as const,
        constant: true,
        inputs: [],
        outputs: [{ name: 'count', type: 'UINT32' as const }],
    },
    {
        name: 'getDeploymentByIndex',
        type: 'function' as const,
        constant: true,
        inputs: [{ name: 'index', type: 'UINT32' as const }],
        outputs: [
            { name: 'deployer', type: 'ADDRESS' as const },
            { name: 'token', type: 'ADDRESS' as const },
            { name: 'block', type: 'UINT64' as const },
        ],
    },
];

// Cache factory token addresses for 5 minutes.
const FACTORY_CACHE_TTL_MS = 5 * 60 * 1000;
let factoryCacheTs = 0;
let factoryCacheList: string[] = [];

async function fetchFactoryTokenAddresses(): Promise<string[]> {
    const factoryAddr = OP20_DEPLOYER_ADDRESS[config.network];
    if (!factoryAddr) return [];

    const now = Date.now();
    if (now - factoryCacheTs < FACTORY_CACHE_TTL_MS) return factoryCacheList;

    try {
        const provider = providerManager.getProvider();
        const network = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const factory = getContract<any>(factoryAddr, FACTORY_ABI as any, provider, network);

        const countResult = (await factory.getDeploymentsCount()) as { properties: Record<string, unknown> };
        const count = (countResult.properties['count'] as number | undefined) ?? 0;
        if (count === 0) {
            factoryCacheList = [];
            factoryCacheTs = Date.now();
            return factoryCacheList;
        }

        const results = await Promise.all(
            Array.from({ length: count }, (_, i) =>
                (factory.getDeploymentByIndex(i) as Promise<{ properties: Record<string, unknown> }>)
                    .then((r) => {
                        const token = r.properties['token'] as { toString(): string } | undefined;
                        return token ? token.toString().toLowerCase() : null;
                    })
                    .catch(() => null),
            ),
        );

        factoryCacheList = results.filter((t): t is string => t !== null);
        factoryCacheTs = Date.now();
        console.log(`[Balance] Factory: ${count} deployment(s), ${factoryCacheList.length} token address(es)`);
    } catch (err) {
        console.error('[Balance] Factory enumeration failed:', err instanceof Error ? err.message : String(err));
    }

    return factoryCacheList;
}

/**
 * Normalize any contract address to P2OP format so Set deduplication works
 * regardless of whether the address arrived as 0x hex or opr1/op1 bech32m.
 */
import { EcKeyPair } from '@btc-vision/transaction';

function toP2OP(address: string, network: Network): string {
    if (!address.startsWith('0x')) return address;
    try {
        const bytes = Buffer.from(address.slice(2), 'hex');
        return EcKeyPair.p2op(bytes, network);
    } catch {
        return address;
    }
}

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

export interface AddressBalance {
    /** Address type label, e.g. 'P2TR', 'P2WPKH', 'P2PKH', 'CSV1' */
    type: string;
    /** The full Bitcoin address */
    address: string;
    satoshis: bigint;
}

/**
 * Resolve the OPNet MLDSA owner for any address type.
 *
 * Falls back through three levels:
 *   1. getPublicKeyInfo(address) directly
 *   2. Stored MLDSA hash for tracked addresses → getPublicKeyInfo('0x' + hash)
 *   3. This address is a linked alias of another subscription → same fallback
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
 *
 * Accepts Bitcoin addresses (bc1p, bc1q, bcrt1p, bcrt1q), MLDSA hex (0x…),
 * and P2OP (op1/opr1). Only address types with a balance > 0 are included
 * in addressBalances.
 */
export async function fetchAllBalances(address: string): Promise<{
    addressBalances: AddressBalance[];
    tokens: TokenBalance[];
}> {
    const provider = providerManager.getProvider();
    const network: Network = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;

    const ownerAddress = await resolveOwner(address);

    const addressBalances: AddressBalance[] = [];

    if (ownerAddress) {
        // Collect all linked BTC address types from the resolved identity.
        // Each type uses try/catch because p2wpkh/p2pkh require originalPublicKey.
        const candidates: Array<{ type: string; addr: string }> = [];
        try { candidates.push({ type: 'P2TR',   addr: ownerAddress.p2tr(network) }); }   catch { /* */ }
        try { candidates.push({ type: 'P2WPKH', addr: ownerAddress.p2wpkh(network) }); } catch { /* */ }
        try { candidates.push({ type: 'P2PKH',  addr: ownerAddress.p2pkh(network) }); }  catch { /* */ }

        // Deduplicate by address string (p2tr and input address can be equal)
        const seen = new Set<string>();
        const unique = candidates.filter(({ addr }) => {
            if (seen.has(addr)) return false;
            seen.add(addr);
            return true;
        });

        // Fetch BTC at each address type in parallel
        await Promise.all(unique.map(async ({ type, addr }) => {
            try {
                const sats = await provider.getBalance(addr, true);
                if (sats > 0n) addressBalances.push({ type, address: addr, satoshis: sats });
            } catch { /* */ }
        }));

        // CSV1: requires originalPublicKey stored in the Address object
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
        // No OPNet identity found — show BTC at input address only
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

    // ── OP-20 token balances ──────────────────────────────────────────────────

    if (!ownerAddress) return { addressBalances, tokens: [] };

    const [factoryTokens, discovered] = await Promise.all([
        fetchFactoryTokenAddresses(),
        Promise.resolve(walletRepo.getTokenContracts(address)),
    ]);
    const contractSet = new Set(
        [...ALWAYS_CHECK[config.network], ...factoryTokens, ...discovered]
            .map(addr => toP2OP(addr, network)),
    );
    console.log(`[Balance] Checking ${contractSet.size} contract(s) for ${address}`);

    const tokens: TokenBalance[] = [];

    await Promise.all(
        [...contractSet].map(async (contractAddress) => {
            try {
                const contract = getContract<IOP20Contract>(
                    contractAddress,
                    OP_20_ABI,
                    provider,
                    network,
                );

                const [balResult, symResult, decResult] = await Promise.all([
                    contract.balanceOf(ownerAddress),
                    contract.symbol(),
                    contract.decimals(),
                ]);

                const balance = balResult.properties['balance'] as bigint | undefined;
                if (balance === undefined || balance === 0n) return;

                tokens.push({
                    contractAddress,
                    symbol: (symResult.properties['symbol'] as string | undefined) ?? contractAddress.slice(0, 8),
                    amount: balance,
                    decimals: (decResult.properties['decimals'] as number | undefined) ?? 8,
                });
            } catch { /* contract may not be OP-20 or call failed */ }
        }),
    );

    tokens.sort((a, b) => a.symbol.localeCompare(b.symbol));

    return { addressBalances, tokens };
}

function buildBalanceMessage(
    address: string,
    label: string | null,
    addressBalances: AddressBalance[],
    tokens: TokenBalance[],
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
        const { addressBalances, tokens } = await fetchAllBalances(address);
        await editFn(thinking.message_id, buildBalanceMessage(address, label, addressBalances, tokens));
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

    const net = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;
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
