import type { Bot } from 'grammy';
import { getContract, OP_20_ABI, OP_721_ABI, type IOP20Contract, type IOP721Contract } from 'opnet';
import { walletRepo } from '../db/WalletRepository.js';
import { subscriptionRepo } from '../db/SubscriptionRepository.js';
import { providerManager } from '../provider/ProviderManager.js';
import { config, bitcoinNetwork } from '../config.js';
import type { OPNetNetwork } from '../config.js';
import { getBtcPriceUsd } from './PriceCache.js';
import { fetchPrices } from '../api/IndexerClient.js';
import type { WalletEvent, BtcReceived, BtcSent, TokenTransfer, SwapExecuted } from './TxParser.js';

// ─── Known DEX contract addresses (MLDSA hash hex, no 0x) ────────────────────
// Used to detect listings and trades rather than plain sends.
const KNOWN_CONTRACTS: Record<OPNetNetwork, { nativeSwap: string; motoSwapRouter: string }> = {
    mainnet: {
        nativeSwap:      '035884f9ac2b6ae75d7778553e7d447899e9a82e247d7ced48f22aa102681e70',
        motoSwapRouter:  '80f8375d061d638a0b45a4eb4decbfd39e9abba913f464787194ce3c02d2ea5a',
    },
    testnet: {
        nativeSwap:      '4397befe4e067390596b3c296e77fe86589487bf3bf3f0a9a93ce794e2d78fb5',
        motoSwapRouter:  '80f8375d061d638a0b45a4eb4decbfd39e9abba913f464787194ce3c02d2ea5a',
    },
};

// ─── Contract info cache ──────────────────────────────────────────────────────

interface ContractInfo { symbol: string; decimals: number }
const contractInfoCache = new Map<string, ContractInfo>();

async function getContractInfo(contractAddress: string): Promise<ContractInfo> {
    const cached = contractInfoCache.get(contractAddress);
    if (cached) return cached;

    try {
        const provider = providerManager.getProvider();
        const network = bitcoinNetwork;
        const contract = getContract<IOP20Contract>(contractAddress, OP_20_ABI, provider, network);
        const [symResult, decResult] = await Promise.all([contract.symbol(), contract.decimals()]);
        const info: ContractInfo = {
            symbol: (symResult.properties['symbol'] as string | undefined) ?? '???',
            decimals: (decResult.properties['decimals'] as number | undefined) ?? 8,
        };
        contractInfoCache.set(contractAddress, info);
        return info;
    } catch {
        const info: ContractInfo = { symbol: contractAddress.slice(0, 8), decimals: 8 };
        contractInfoCache.set(contractAddress, info);
        return info;
    }
}

// ─── NFT collection info cache ────────────────────────────────────────────────

interface NftCollectionInfo { name: string; symbol: string }
const nftInfoCache = new Map<string, NftCollectionInfo>();

async function getNftCollectionInfo(contractAddress: string): Promise<NftCollectionInfo> {
    const cached = nftInfoCache.get(contractAddress);
    if (cached) return cached;

    try {
        const provider = providerManager.getProvider();
        const contract = getContract<IOP721Contract>(contractAddress, OP_721_ABI, provider, bitcoinNetwork);
        const [nameResult, symResult] = await Promise.all([contract.name(), contract.symbol()]);
        const info: NftCollectionInfo = {
            name:   (nameResult.properties['name']     as string | undefined) ?? contractAddress.slice(0, 8),
            symbol: (symResult.properties['symbol']    as string | undefined) ?? '???',
        };
        nftInfoCache.set(contractAddress, info);
        return info;
    } catch {
        const info: NftCollectionInfo = { name: contractAddress.slice(0, 8), symbol: '???' };
        nftInfoCache.set(contractAddress, info);
        return info;
    }
}

// ─── Token price cache (TTL: 60s) ────────────────────────────────────────────

interface CachedPrice { satPerToken: number; fetchedAt: number }
const tokenPriceCache = new Map<string, CachedPrice>();
const PRICE_TTL_MS = 60_000;

/**
 * Get the current sat-per-token price from the indexer.
 * Returns null if the price can't be fetched.
 * Price from indexer is: virtualBTCReserve * 1e18 / virtualTokenReserve (scaled bigint).
 * We convert back: price / 1e18 = sats per 1 raw token unit.
 */
async function getTokenSatPrice(contractAddress: string): Promise<number | null> {
    const cached = tokenPriceCache.get(contractAddress);
    if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.satPerToken;

    try {
        const priceData = await fetchPrices(contractAddress);
        const priceRaw = BigInt(priceData.current.price);
        // price is virtualBTCReserve * 1e18 / virtualTokenReserve
        // So sat value of N raw tokens = N * price / 1e18
        const satPerToken = Number(priceRaw) / 1e18;
        tokenPriceCache.set(contractAddress, { satPerToken, fetchedAt: Date.now() });
        return satPerToken;
    } catch {
        return null;
    }
}

/**
 * Estimate the BTC (sats) value of a raw token amount using the indexer price.
 */
async function estimateTokenSats(
    rawAmount: bigint,
    contractAddress: string,
): Promise<bigint | null> {
    const satPerToken = await getTokenSatPrice(contractAddress);
    if (satPerToken === null) return null;
    // rawAmount is in the token's smallest unit (includes decimals)
    const sats = Number(rawAmount) * satPerToken;
    if (!Number.isFinite(sats) || sats <= 0) return null;
    return BigInt(Math.round(sats));
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

function formatSats(sats: bigint): string {
    return `${(Number(sats) / 1e8).toFixed(8)} BTC`;
}

function formatSatsWithUsd(sats: bigint, price: number | null): string {
    const btc = formatSats(sats);
    if (!price) return btc;
    const usd = (Number(sats) / 1e8) * price;
    return `${btc} (~$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}

function formatToken(raw: bigint, decimals: number): string {
    if (decimals === 0) return raw.toLocaleString();
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

/**
 * Format a token amount with its symbol, plus an estimated BTC/USD value if available.
 * Example: "400 MOTO (~0.00050000 BTC / ~$33.75)"
 */
async function formatTokenFull(
    raw: bigint,
    contractAddress: string,
    info: ContractInfo,
    btcPrice: number | null,
): Promise<string> {
    const base = `${formatToken(raw, info.decimals)} ${info.symbol}`;
    const estSats = await estimateTokenSats(raw, contractAddress);
    if (estSats === null) return base;
    const btcStr = `${(Number(estSats) / 1e8).toFixed(8)} BTC`;
    if (btcPrice) {
        const usd = (Number(estSats) / 1e8) * btcPrice;
        const usdStr = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return `${base}\n   (~${btcStr} / ~${usdStr})`;
    }
    return `${base} (~${btcStr})`;
}

function shortAddr(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Notifier ─────────────────────────────────────────────────────────────────

export class Notifier {
    private readonly bot: Bot;

    /** Chats that have already been sent one expiry reminder this session. */
    private readonly expiredNotified = new Set<number>();

    public constructor(bot: Bot) {
        this.bot = bot;
    }

    /**
     * Group events by (address + txHash) so a single tx produces one message
     * showing both the BTC spent and the tokens received.
     */
    public async notify(events: WalletEvent[]): Promise<void> {
        const groups = new Map<string, WalletEvent[]>();
        for (const ev of events) {
            const key = `${ev.address}::${ev.txHash}`;
            const g = groups.get(key) ?? [];
            g.push(ev);
            groups.set(key, g);
        }

        for (const [, group] of groups) {
            const firstEv = group[0];
            if (!firstEv) continue;
            const address = firstEv.address;
            const subscribers = await walletRepo.getChatIdsForAddress(address);

            for (const { chatId, label } of subscribers) {
                // Gate notifications behind active subscription
                const active = await subscriptionRepo.hasActiveSubscription(chatId);
                if (!active) {
                    if (!this.expiredNotified.has(chatId)) {
                        this.expiredNotified.add(chatId);
                        try {
                            await this.bot.api.sendMessage(
                                chatId,
                                '⏰ *Your subscription has expired\\.*\n\n' +
                                'Notifications are paused until you renew\\.\n' +
                                'Visit jeet\\-tracker\\.opnet\\.org to purchase access, ' +
                                'then use `/redeem <code>` to reactivate\\.',
                                { parse_mode: 'MarkdownV2' },
                            );
                        } catch (err: unknown) {
                            console.warn(`[Notifier] Failed to send expiry notice to ${chatId}:`, err);
                        }
                    }
                    continue;
                }

                // User is active — clear expiry flag if they renewed
                this.expiredNotified.delete(chatId);

                const message = await this.formatGroup(group, label);
                try {
                    await this.bot.api.sendMessage(chatId, message, {
                        parse_mode: 'MarkdownV2',
                        link_preview_options: { is_disabled: true },
                    });
                } catch (err: unknown) {
                    console.warn(`[Notifier] Failed to send to ${chatId}:`, err);
                }
            }
        }
    }

    private async formatGroup(events: WalletEvent[], label: string): Promise<string> {
        const first = events[0];
        if (!first) return '';
        const walletDisplay = escapeMarkdown(
            label !== first.address
                ? `${label} \\(${shortAddr(first.address)}\\)`
                : shortAddr(first.address),
        );
        const txLink = `[${escapeMarkdown(shortAddr(first.txHash))}](${escapeMarkdown(config.mempoolUrl + first.txHash)})`;
        const block = escapeMarkdown(String(first.blockHeight));
        const btcPrice = await getBtcPriceUsd().catch(() => null);

        // Detect purchase: btc_received + token transfer in the same tx
        const btcEv = events.find((e): e is BtcReceived => e.type === 'btc_received');
        const swapEv = events.find((e): e is SwapExecuted => e.type === 'swap_executed');
        const tokenInEv = events.find((e): e is TokenTransfer => e.type === 'token' && (e).direction === 'in');
        const tokenOutEv = events.find((e): e is TokenTransfer => e.type === 'token' && (e).direction === 'out');

        // ── OP20↔OP20 trade: token out + token in in the same tx, no BTC swap ──
        if (!swapEv && tokenInEv && tokenOutEv) {
            const [infoIn, infoOut] = await Promise.all([
                getContractInfo(tokenInEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 })),
                getContractInfo(tokenOutEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 })),
            ]);
            const sentStr = await formatTokenFull(tokenOutEv.value, tokenOutEv.contractAddress, infoOut, btcPrice);
            const recvStr = await formatTokenFull(tokenInEv.value, tokenInEv.contractAddress, infoIn, btcPrice);
            const lines = [
                `🔀 *Token Swap*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `📤 Sent: \`${escapeMarkdown(sentStr)}\``,
                `📥 Received: \`${escapeMarkdown(recvStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ];
            return lines.join('\n');
        }

        // ── Swap: use SwapExecuted which has the accurate net BTC spent ─────────
        // btc_received in the same tx is change returned, NOT cost.
        // SwapExecuted.btcSpent = UTXO committed − change returned (computed by contract).
        if (swapEv && swapEv.type === 'swap_executed') {
            const tokenEv = tokenInEv ?? tokenOutEv;
            const info = tokenEv
                ? await getContractInfo(tokenEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }))
                : await getContractInfo(swapEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(swapEv.tokensReceived, swapEv.contractAddress, info, btcPrice);
            const lines = [
                `🔄 *Swap Executed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💸 BTC Spent: \`${escapeMarkdown(formatSatsWithUsd(swapEv.btcSpent, btcPrice))}\``,
                `🪙 Received: \`${escapeMarkdown(tokenStr)}\``,
            ];
            if (btcEv && btcEv.type === 'btc_received') {
                lines.push(`🔁 Change: \`${escapeMarkdown(formatSatsWithUsd(btcEv.satoshis, btcPrice))}\``);
            }
            lines.push(`🔗 Tx: ${txLink}`, `📦 Block: \\#${block}`);
            return lines.join('\n');
        }

        // ── Pure BTC transaction: consolidate send + change into one message ──
        // Handles self-transfers (CSV1 → main, consolidation) and external sends.
        const btcSentEvs  = events.filter((e): e is BtcSent     => e.type === 'btc_sent');
        const btcRecvEvs  = events.filter((e): e is BtcReceived  => e.type === 'btc_received');
        const isPureBtc   = btcSentEvs.length > 0 && !swapEv && !tokenInEv && !tokenOutEv
            && !events.some((e) => e.type === 'liquidity_reserved' || e.type === 'provider_consumed');

        if (isPureBtc) {
            const totalInput  = btcSentEvs.reduce((s, e) => s + e.satoshis, 0n);
            const totalChange = btcRecvEvs.reduce((s, e) => s + e.satoshis, 0n);
            const primary     = btcSentEvs[0];
            if (!primary) return '';

            // Self-transfer: no output went to an external address
            if (!primary.counterparty) {
                const fee = totalInput > totalChange ? totalInput - totalChange : 0n;
                return [
                    `↔️ *Internal Transfer*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `💰 Received: \`${escapeMarkdown(formatSatsWithUsd(totalChange, btcPrice))}\``,
                    ...(fee > 0n ? [`⛽ Fee: \`${escapeMarkdown(formatSats(fee))}\``] : []),
                    `🔗 Tx: ${txLink}`,
                    `📦 Block: \\#${block}`,
                ].join('\n');
            }

            // External send ± change
            const sentAmount = primary.recipientAmount ?? (totalInput - totalChange);
            const fee        = primary.recipientAmount !== undefined
                ? totalInput - primary.recipientAmount - totalChange
                : 0n;
            const lines = [
                `📤 *BTC Sent*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💸 Sent: \`${escapeMarkdown(formatSatsWithUsd(sentAmount, btcPrice))}\` to \`${escapeMarkdown(shortAddr(primary.counterparty))}\``,
                ...(totalChange > 0n ? [`🔁 Change: \`${escapeMarkdown(formatSatsWithUsd(totalChange, btcPrice))}\``] : []),
                ...(fee > 0n       ? [`⛽ Fee: \`${escapeMarkdown(formatSats(fee))}\``]           : []),
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ];
            return lines.join('\n');
        }

        // ── All other events: format individually in one grouped message ──────
        const parts: string[] = [];
        for (const ev of events) {
            parts.push(await this.formatSingle(ev, walletDisplay, txLink, block, btcPrice));
        }
        return parts.join('\n\n');
    }

    private async formatSingle(
        ev: WalletEvent,
        walletDisplay: string,
        txLink: string,
        block: string,
        btcPrice: number | null = null,
    ): Promise<string> {
        if (ev.type === 'btc_received') {
            const fromPart = ev.counterparty
                ? ` from \`${escapeMarkdown(shortAddr(ev.counterparty))}\``
                : '';
            return [
                `📥 ${walletDisplay} received \`${escapeMarkdown(formatSatsWithUsd(ev.satoshis, btcPrice))}\`${fromPart}`,
                `🔗 ${txLink} · Block \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'btc_sent') {
            const toPart = ev.counterparty
                ? ` to \`${escapeMarkdown(shortAddr(ev.counterparty))}\``
                : '';
            return [
                `📤 ${walletDisplay} sent \`${escapeMarkdown(formatSatsWithUsd(ev.satoshis, btcPrice))}\`${toPart}`,
                `🔗 ${txLink} · Block \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'token') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const dex = KNOWN_CONTRACTS[config.network];
            const counterpartyHex = ev.counterparty.startsWith('0x') ? ev.counterparty.slice(2) : ev.counterparty;
            const tokenStr = await formatTokenFull(ev.value, ev.contractAddress, info, btcPrice);

            // Detect listing on NativeSwap
            if (ev.direction === 'out' && counterpartyHex === dex.nativeSwap) {
                return [
                    `🏷️ *Listed for Sale on NativeSwap*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `🪙 Token: \`${escapeMarkdown(tokenStr)}\``,
                    `🔗 Tx: ${txLink}`,
                    `📦 Block: \\#${block}`,
                ].join('\n');
            }

            // Detect NativeSwap purchase (token received FROM NativeSwap contract)
            if (ev.direction === 'in' && counterpartyHex === dex.nativeSwap) {
                return [
                    `🛒 *NativeSwap Purchase*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `🪙 Received: \`${escapeMarkdown(tokenStr)}\``,
                    `🔗 Tx: ${txLink}`,
                    `📦 Block: \\#${block}`,
                ].join('\n');
            }

            const arrow = ev.direction === 'in' ? '📥' : '📤';
            const action = ev.direction === 'in' ? 'Received' : 'Sent';
            const counterLabel = ev.direction === 'in' ? 'From' : 'To';
            return [
                `${arrow} *OP\\-20 ${escapeMarkdown(action)} ${escapeMarkdown(info.symbol)}*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💰 Amount: \`${escapeMarkdown(tokenStr)}\``,
                `${counterLabel}: \`${escapeMarkdown(shortAddr(ev.counterparty))}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'nft_transfer') {
            const info = await getNftCollectionInfo(ev.contractAddress).catch(() => ({ name: '???', symbol: '???' }));
            const arrow = ev.direction === 'in' ? '🖼️' : '📤';
            const action = ev.direction === 'in' ? 'NFT Received' : 'NFT Sent';
            const counterLabel = ev.direction === 'in' ? 'From' : 'To';
            const amountStr = ev.amount > 1n ? `${ev.amount.toString()}× ` : '';
            return [
                `${arrow} *${escapeMarkdown(action)}*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🗂 Collection: *${escapeMarkdown(info.name)}* \\(${escapeMarkdown(info.symbol)}\\)`,
                `🔢 Amount: \`${escapeMarkdown(amountStr + info.symbol)}\``,
                `${counterLabel}: \`${escapeMarkdown(shortAddr(ev.counterparty))}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'liquidity_reserved') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.tokenAmount, ev.contractAddress, info, btcPrice);
            if (ev.role === 'buyer') {
                return [
                    `🛒 *Reservation Made — Pending Purchase*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `💸 BTC Committed: \`${escapeMarkdown(formatSatsWithUsd(ev.satoshis, btcPrice))}\``,
                    `🪙 Tokens to Receive: \`${escapeMarkdown(tokenStr)}\``,
                    `_Purchase completes when your BTC confirms_`,
                    `🔗 Tx: ${txLink}`,
                    `📦 Block: \\#${block}`,
                ].join('\n');
            }
            return [
                `🔔 *Reservation — Buyer Incoming*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💰 BTC You'll Receive: \`${escapeMarkdown(formatSatsWithUsd(ev.satoshis, btcPrice))}\``,
                `🪙 Tokens Reserved: \`${escapeMarkdown(tokenStr)}\``,
                `_Sale completes when buyer's BTC confirms_`,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'provider_consumed') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.tokenAmount, ev.contractAddress, info, btcPrice);
            return [
                `✅ *Sale Completed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Tokens Sold: \`${escapeMarkdown(tokenStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'swap_executed') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.tokensReceived, ev.contractAddress, info, btcPrice);
            return [
                `🔄 *Swap Executed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💸 BTC Spent: \`${escapeMarkdown(formatSatsWithUsd(ev.btcSpent, btcPrice))}\``,
                `🪙 Received: \`${escapeMarkdown(tokenStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'liquidity_added') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.tokenAmount, ev.contractAddress, info, btcPrice);
            const lines = [
                `💧 *Liquidity Added*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Amount: \`${escapeMarkdown(tokenStr)}\``,
            ];
            if (ev.tokenAmount2 !== undefined && ev.tokenAmount2 > 0n) {
                lines.push(`🪙 Amount 2: \`${escapeMarkdown(formatToken(ev.tokenAmount2, info.decimals))}\``);
            }
            if (ev.btcAmount !== undefined && ev.btcAmount > 0n) {
                lines.push(`💰 BTC: \`${escapeMarkdown(formatSatsWithUsd(ev.btcAmount, btcPrice))}\``);
            }
            lines.push(`🔗 Tx: ${txLink}`, `📦 Block: \\#${block}`);
            return lines.join('\n');
        }

        if (ev.type === 'liquidity_removed') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.tokenAmount, ev.contractAddress, info, btcPrice);
            const lines = [
                `🔥 *Liquidity Removed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Amount: \`${escapeMarkdown(tokenStr)}\``,
            ];
            if (ev.tokenAmount2 !== undefined && ev.tokenAmount2 > 0n) {
                lines.push(`🪙 Amount 2: \`${escapeMarkdown(formatToken(ev.tokenAmount2, info.decimals))}\``);
            }
            if (ev.btcAmount !== undefined && ev.btcAmount > 0n) {
                lines.push(`💰 BTC: \`${escapeMarkdown(formatSatsWithUsd(ev.btcAmount, btcPrice))}\``);
            }
            lines.push(`🔗 Tx: ${txLink}`, `📦 Block: \\#${block}`);
            return lines.join('\n');
        }

        if (ev.type === 'staked') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.amount, ev.contractAddress, info, btcPrice);
            return [
                `🔒 *Staked*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Amount: \`${escapeMarkdown(tokenStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'unstaked') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.amount, ev.contractAddress, info, btcPrice);
            return [
                `🔓 *Unstaked*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Amount: \`${escapeMarkdown(tokenStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'rewards_claimed') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const tokenStr = await formatTokenFull(ev.amount, ev.contractAddress, info, btcPrice);
            return [
                `🎁 *Rewards Claimed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Amount: \`${escapeMarkdown(tokenStr)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        return '';
    }
}
