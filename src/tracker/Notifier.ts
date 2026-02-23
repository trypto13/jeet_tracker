import type { Bot, Context } from 'grammy';
import { getContract, OP_20_ABI, type IOP20Contract } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { walletRepo } from '../db/WalletRepository.js';
import { providerManager } from '../provider/ProviderManager.js';
import { config } from '../config.js';
import type { WalletEvent, BtcReceived, BtcSent, TokenTransfer, SwapExecuted } from './TxParser.js';

const MEMPOOL_URL = 'https://mempool.opnet.org/tx/';

// ─── Known DEX contract addresses (MLDSA hash hex, no 0x) ────────────────────
// Used to detect listings and trades rather than plain sends.
const KNOWN_CONTRACTS: Record<'mainnet' | 'regtest', { nativeSwap: string; motoSwapRouter: string }> = {
    mainnet: {
        nativeSwap:      'b056ba05448cf4a5468b3e1190b0928443981a93c3aff568467f101e94302422',
        motoSwapRouter:  '80f8375d061d638a0b45a4eb4decbfd39e9abba913f464787194ce3c02d2ea5a',
    },
    regtest: {
        nativeSwap:      'b056ba05448cf4a5468b3e1190b0928443981a93c3aff568467f101e94302422',
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
        const network = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;
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

// ─── Formatters ───────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

function formatSats(sats: bigint): string {
    return `${(Number(sats) / 1e8).toFixed(8)} BTC`;
}

function formatToken(raw: bigint, decimals: number): string {
    if (decimals === 0) return raw.toLocaleString();
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

function shortAddr(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Notifier ─────────────────────────────────────────────────────────────────

export class Notifier {
    private readonly bot: Bot<Context>;

    public constructor(bot: Bot<Context>) {
        this.bot = bot;
    }

    /**
     * Group events by (address + txHash) so a single tx produces one message
     * showing both the BTC spent and the tokens received.
     */
    public async notify(events: WalletEvent[]): Promise<void> {
        // Group by address + txHash so related events in the same tx are batched
        const groups = new Map<string, WalletEvent[]>();
        for (const ev of events) {
            const key = `${ev.address}::${ev.txHash}`;
            const g = groups.get(key) ?? [];
            g.push(ev);
            groups.set(key, g);
        }

        for (const [, group] of groups) {
            const address = group[0]!.address;
            const subscribers = await walletRepo.getChatIdsForAddress(address);

            for (const { chatId, label } of subscribers) {
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
        // If all events in the group are the same type and it's just one, format individually.
        // Otherwise, check for the common swap pattern: btc_received + swap_executed or token in.
        const first = events[0]!;
        const walletDisplay = escapeMarkdown(
            label !== first.address
                ? `${label} \\(${shortAddr(first.address)}\\)`
                : shortAddr(first.address),
        );
        const txLink = `[${escapeMarkdown(shortAddr(first.txHash))}](${escapeMarkdown(MEMPOOL_URL + first.txHash)})`;
        const block = escapeMarkdown(String(first.blockHeight));

        // Detect purchase: btc_received + token transfer in the same tx
        const btcEv = events.find((e): e is BtcReceived => e.type === 'btc_received');
        const swapEv = events.find((e): e is SwapExecuted => e.type === 'swap_executed');
        const tokenInEv = events.find((e): e is TokenTransfer => e.type === 'token' && (e as TokenTransfer).direction === 'in');
        const tokenOutEv = events.find((e): e is TokenTransfer => e.type === 'token' && (e as TokenTransfer).direction === 'out');

        // ── OP20↔OP20 trade: token out + token in in the same tx, no BTC swap ──
        if (!swapEv && tokenInEv && tokenOutEv) {
            const [infoIn, infoOut] = await Promise.all([
                getContractInfo(tokenInEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 })),
                getContractInfo(tokenOutEv.contractAddress).catch(() => ({ symbol: '???', decimals: 8 })),
            ]);
            const lines = [
                `🔀 *Token Swap*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `📤 Sent: \`${escapeMarkdown(formatToken(tokenOutEv.value, infoOut.decimals))} ${escapeMarkdown(infoOut.symbol)}\``,
                `📥 Received: \`${escapeMarkdown(formatToken(tokenInEv.value, infoIn.decimals))} ${escapeMarkdown(infoIn.symbol)}\``,
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
            const lines = [
                `🔄 *Swap Executed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💸 BTC Spent: \`${escapeMarkdown(formatSats(swapEv.btcSpent))}\``,
                `🪙 Received: \`${escapeMarkdown(formatToken(swapEv.tokensReceived, info.decimals))} ${escapeMarkdown(info.symbol)}\``,
            ];
            if (btcEv && btcEv.type === 'btc_received') {
                lines.push(`🔁 Change: \`${escapeMarkdown(formatSats(btcEv.satoshis))}\``);
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
            const primary     = btcSentEvs[0]!;

            // Self-transfer: no output went to an external address
            if (!primary.counterparty) {
                const fee = totalInput > totalChange ? totalInput - totalChange : 0n;
                return [
                    `↔️ *Internal Transfer*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `💰 Received: \`${escapeMarkdown(formatSats(totalChange))}\``,
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
                `💸 Sent: \`${escapeMarkdown(formatSats(sentAmount))}\` to \`${escapeMarkdown(shortAddr(primary.counterparty))}\``,
                ...(totalChange > 0n ? [`🔁 Change: \`${escapeMarkdown(formatSats(totalChange))}\``] : []),
                ...(fee > 0n       ? [`⛽ Fee: \`${escapeMarkdown(formatSats(fee))}\``]           : []),
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ];
            return lines.join('\n');
        }

        // ── All other events: format individually in one grouped message ──────
        const parts: string[] = [];
        for (const ev of events) {
            parts.push(await this.formatSingle(ev, walletDisplay, txLink, block));
        }
        return parts.join('\n\n');
    }

    private async formatSingle(ev: WalletEvent, walletDisplay: string, txLink: string, block: string): Promise<string> {
        if (ev.type === 'btc_received') {
            const fromPart = ev.counterparty
                ? ` from \`${escapeMarkdown(shortAddr(ev.counterparty))}\``
                : '';
            return [
                `📥 ${walletDisplay} received \`${escapeMarkdown(formatSats(ev.satoshis))}\`${fromPart}`,
                `🔗 ${txLink} · Block \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'btc_sent') {
            const toPart = ev.counterparty
                ? ` to \`${escapeMarkdown(shortAddr(ev.counterparty))}\``
                : '';
            return [
                `📤 ${walletDisplay} sent \`${escapeMarkdown(formatSats(ev.satoshis))}\`${toPart}`,
                `🔗 ${txLink} · Block \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'token') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            const dex = KNOWN_CONTRACTS[config.network];
            const counterpartyHex = ev.counterparty.startsWith('0x') ? ev.counterparty.slice(2) : ev.counterparty;

            // Detect listing on NativeSwap
            if (ev.direction === 'out' && counterpartyHex === dex.nativeSwap) {
                return [
                    `🏷️ *Listed for Sale on NativeSwap*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `🪙 Token: \`${escapeMarkdown(formatToken(ev.value, info.decimals))} ${escapeMarkdown(info.symbol)}\``,
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
                `💰 Amount: \`${escapeMarkdown(formatToken(ev.value, info.decimals))} ${escapeMarkdown(info.symbol)}\``,
                `${counterLabel}: \`${escapeMarkdown(shortAddr(ev.counterparty))}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'liquidity_reserved') {
            if (ev.role === 'buyer') {
                return [
                    `🛒 *Reservation Made — Pending Purchase*`,
                    ``,
                    `📍 Wallet: ${walletDisplay}`,
                    `💸 BTC Committed: \`${escapeMarkdown(formatSats(ev.satoshis))}\``,
                    `🪙 Tokens to Receive: \`${escapeMarkdown(ev.tokenAmount.toLocaleString())}\``,
                    `_Purchase completes when your BTC confirms_`,
                    `🔗 Tx: ${txLink}`,
                    `📦 Block: \\#${block}`,
                ].join('\n');
            }
            return [
                `🔔 *Reservation — Buyer Incoming*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💰 BTC You'll Receive: \`${escapeMarkdown(formatSats(ev.satoshis))}\``,
                `🪙 Tokens Reserved: \`${escapeMarkdown(ev.tokenAmount.toLocaleString())}\``,
                `_Sale completes when buyer's BTC confirms_`,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'provider_consumed') {
            return [
                `✅ *Sale Completed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `🪙 Tokens Sold: \`${escapeMarkdown(ev.tokenAmount.toLocaleString())}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        if (ev.type === 'swap_executed') {
            const info = await getContractInfo(ev.contractAddress).catch(() => ({ symbol: '???', decimals: 8 }));
            return [
                `🔄 *Swap Executed*`,
                ``,
                `📍 Wallet: ${walletDisplay}`,
                `💸 BTC Spent: \`${escapeMarkdown(formatSats(ev.btcSpent))}\``,
                `🪙 Received: \`${escapeMarkdown(formatToken(ev.tokensReceived, info.decimals))} ${escapeMarkdown(info.symbol)}\``,
                `🔗 Tx: ${txLink}`,
                `📦 Block: \\#${block}`,
            ].join('\n');
        }

        return '';
    }
}
