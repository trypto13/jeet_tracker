import type { Bot } from 'grammy';
import { providerManager } from '../provider/ProviderManager.js';
import { walletRepo } from '../db/WalletRepository.js';
import { tokenRepo } from '../db/TokenRepository.js';
import { scanBlockForBTC } from './TxParser.js';
import type { WalletEvent, InferredSend } from './TxParser.js';
import { config, bitcoinNetwork } from '../config.js';
import type { Notifier } from './Notifier.js';
import {
    fetchEvents,
    type TransferDoc,
    type ReservationDoc,
    type SwapDoc,
    type PriceChangeDoc,
    type PoolEventDoc,
    type StakingEventDoc,
} from '../api/IndexerClient.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

function formatSats(sats: bigint): string {
    return `${(Number(sats) / 1e8).toFixed(8)} BTC`;
}

/**
 * Polls the indexer for new events and the OPNet RPC for BTC send/receive.
 */
export class BlockPoller {
    private readonly notifier: Notifier;
    private readonly bot: Bot;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;

    /** Deduplicates notifications within a session. */
    private readonly notifiedTxHashes = new Set<string>();
    private static readonly MAX_NOTIFIED_TX_HASHES = 1000;

    /** Tracks which primary addresses have had their UTXOs initially populated. */
    private utxoPopulated = new Set<string>();

    public constructor(notifier: Notifier, bot: Bot) {
        this.notifier = notifier;
        this.bot = bot;
    }

    public async start(): Promise<void> {
        this.running = true;
        console.log('[BlockPoller] Starting...');
        await this.poll();
    }

    public stop(): void {
        this.running = false;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        console.log('[BlockPoller] Stopped.');
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        try {
            await this.processNewBlocks();
        } catch (err: unknown) {
            console.error('[BlockPoller] Error during poll:', err);
        }

        if (this.running) {
            this.timer = setTimeout(() => void this.poll(), config.pollIntervalMs);
        }
    }

    /**
     * For primary addresses not yet in mldsaMap (no stored linkedAddresses),
     * fetch from RPC, persist, and add to the in-progress maps for this poll.
     */
    private async resolveAndCacheLinked(
        primaryAddrs: string[],
        mldsaMap: Map<string, string>,
        trackedSet: Set<string>,
        canonicalMap: Map<string, string>,
    ): Promise<void> {
        const unresolved = primaryAddrs.filter((a) => !mldsaMap.has(a));
        if (unresolved.length === 0) return;

        const provider = providerManager.getProvider();
        const net = bitcoinNetwork;

        await Promise.all(
            unresolved.map(async (addr) => {
                try {
                    const owner = await provider.getPublicKeyInfo(addr, false);
                    if (!owner) return;

                    const mldsaHash = Buffer.from(owner).toString('hex').toLowerCase();
                    mldsaMap.set(addr, mldsaHash);

                    let tweakedPubkey: string | undefined;
                    let p2op: string | undefined;
                    let p2tr: string | undefined;
                    let p2wpkh: string | undefined;
                    let p2pkh: string | undefined;
                    let csv1: string | undefined;
                    try { tweakedPubkey = owner.tweakedToHex().toLowerCase(); } catch { /* not available */ }
                    try { p2op = owner.p2op(net); } catch { /* not available */ }
                    try { p2tr = owner.p2tr(net); } catch { /* not available */ }
                    try { p2wpkh = owner.p2wpkh(net); } catch { /* not available */ }
                    try { p2pkh = owner.p2pkh(net); } catch { /* not available */ }
                    try { csv1 = provider.getCSV1ForAddress(owner).address; } catch { /* not available */ }

                    // Track all address formats so event matching works regardless of format
                    for (const extra of [p2tr, p2wpkh, p2pkh, csv1, p2op]) {
                        if (extra && extra !== addr) {
                            trackedSet.add(extra);
                            canonicalMap.set(extra, addr);
                        }
                    }
                    // Also track hex identities (MLDSA hash, tweaked pubkey) with 0x prefix
                    // so events using hex format can be matched directly via trackedSet
                    for (const hex of [mldsaHash, tweakedPubkey]) {
                        if (!hex) continue;
                        trackedSet.add(hex);
                        trackedSet.add(`0x${hex}`);
                        canonicalMap.set(hex, addr);
                        canonicalMap.set(`0x${hex}`, addr);
                    }

                    walletRepo.updateLinkedAddresses(addr, {
                        mldsaHash,
                        ...(tweakedPubkey !== undefined && { tweakedPubkey }),
                        ...(p2op   !== undefined && { p2op }),
                        ...(p2tr   !== undefined && { p2tr }),
                        ...(p2wpkh !== undefined && { p2wpkh }),
                        ...(p2pkh  !== undefined && { p2pkh }),
                        ...(csv1   !== undefined && { csv1 }),
                    });
                } catch {
                    // No OPNet history yet — skip for now
                }
            }),
        );
    }

    /**
     * Pre-populate the UTXO store for addresses that haven't been populated yet.
     */
    private async populateUTXOs(primaryAddrs: string[]): Promise<void> {
        const provider = providerManager.getProvider();
        const unpopulated = primaryAddrs.filter((a) => !this.utxoPopulated.has(a));
        if (unpopulated.length === 0) return;

        await Promise.all(
            unpopulated.map(async (primaryAddr) => {
                this.utxoPopulated.add(primaryAddr);

                const linked = walletRepo.getLinkedAddressesFor(primaryAddr);
                const addresses: Array<{ addr: string; isCSV: boolean }> = [
                    { addr: primaryAddr, isCSV: false },
                ];
                if (linked?.p2tr && linked.p2tr !== primaryAddr) addresses.push({ addr: linked.p2tr, isCSV: false });
                if (linked?.p2wpkh) addresses.push({ addr: linked.p2wpkh, isCSV: false });
                if (linked?.p2pkh)  addresses.push({ addr: linked.p2pkh,  isCSV: false });
                if (linked?.csv1)   addresses.push({ addr: linked.csv1,   isCSV: true  });

                const allUTXOs: Array<{ txid: string; vout: number; value: bigint }> = [];

                await Promise.all(
                    addresses.map(async ({ addr, isCSV }) => {
                        try {
                            const utxos = await provider.utxoManager.getUTXOs({
                                address: addr,
                                isCSV,
                                mergePendingUTXOs: true,
                            });
                            for (const u of utxos) {
                                allUTXOs.push({ txid: u.transactionId, vout: u.outputIndex, value: u.value });
                            }
                        } catch {
                            // Address type not available on this network — skip
                        }
                    }),
                );

                walletRepo.setUTXOs(primaryAddr, allUTXOs);
                console.log(`[BlockPoller] UTXO store populated for ${primaryAddr}: ${allUTXOs.length} UTXO(s)`);
            }),
        );
    }

    // ─── Indexer event matching ──────────────────────────────────────────────

    /** Match indexer transfers against tracked MLDSA hashes → TokenTransfer/NftTransfer events. */
    private matchTransfers(
        transfers: TransferDoc[],
        mldsaMap: ReadonlyMap<string, string>,
        nftContractSet: ReadonlySet<string>,
    ): WalletEvent[] {
        const events: WalletEvent[] = [];

        for (const t of transfers) {
            const fromHex = t.from.startsWith('0x') ? t.from.slice(2).toLowerCase() : t.from.toLowerCase();
            const toHex = t.to.startsWith('0x') ? t.to.slice(2).toLowerCase() : t.to.toLowerCase();

            for (const [btcAddr, mldsaHex] of mldsaMap) {
                const isFrom = mldsaHex === fromHex;
                const isTo   = mldsaHex === toHex;
                if (!isFrom && !isTo) continue;

                const isNft = nftContractSet.has(t.contractAddress);

                if (isNft) {
                    events.push({
                        type: 'nft_transfer',
                        txHash: t.txHash,
                        blockHeight: t.blockHeight,
                        address: btcAddr,
                        direction: isFrom ? 'out' : 'in',
                        contractAddress: t.contractAddress,
                        amount: BigInt(t.value),
                        counterparty: '0x' + (isFrom ? toHex : fromHex),
                    });
                } else {
                    events.push({
                        type: 'token',
                        txHash: t.txHash,
                        blockHeight: t.blockHeight,
                        address: btcAddr,
                        direction: isFrom ? 'out' : 'in',
                        contractAddress: t.contractAddress,
                        value: BigInt(t.value),
                        counterparty: '0x' + (isFrom ? toHex : fromHex),
                    });
                }

                // Persist newly discovered contract
                walletRepo.addTokenContract(btcAddr, t.contractAddress);
            }
        }

        return events;
    }

    /** Match indexer reservations against tracked wallets (MLDSA hashes + BTC addresses). */
    private matchReservations(
        reservations: ReservationDoc[],
        mldsaMap: ReadonlyMap<string, string>,
        trackedSet: ReadonlySet<string>,
        canonicalMap: ReadonlyMap<string, string>,
    ): WalletEvent[] {
        const events: WalletEvent[] = [];

        for (const r of reservations) {
            const providerHex = r.providerMldsa.startsWith('0x')
                ? r.providerMldsa.slice(2).toLowerCase()
                : r.providerMldsa.toLowerCase();

            // SELLER: match by MLDSA hash first
            let sellerMatched = false;
            for (const [btcAddr, mldsaHex] of mldsaMap) {
                if (mldsaHex !== providerHex) continue;
                sellerMatched = true;
                events.push({
                    type: 'liquidity_reserved',
                    txHash: r.txHash,
                    blockHeight: r.blockHeight,
                    address: btcAddr,
                    contractAddress: r.nativeSwapAddress,
                    satoshis: BigInt(r.satoshis),
                    tokenAmount: BigInt(r.tokenAmount),
                    role: 'seller',
                });
            }

            // SELLER fallback: direct BTC address match (providerMldsa is now btcReceiver)
            if (!sellerMatched) {
                const canonical = canonicalMap.get(r.providerMldsa) ?? canonicalMap.get(providerHex);
                if (canonical && trackedSet.has(r.providerMldsa)) {
                    events.push({
                        type: 'liquidity_reserved',
                        txHash: r.txHash,
                        blockHeight: r.blockHeight,
                        address: canonical,
                        contractAddress: r.nativeSwapAddress,
                        satoshis: BigInt(r.satoshis),
                        tokenAmount: BigInt(r.tokenAmount),
                        role: 'seller',
                    });
                }
            }

            // BUYER: matched by buyerAddress (MLDSA hash hex, may have 0x prefix)
            if (r.buyerAddress) {
                const buyerHex = r.buyerAddress.startsWith('0x')
                    ? r.buyerAddress.slice(2).toLowerCase()
                    : r.buyerAddress.toLowerCase();

                for (const [btcAddr, mldsaHex] of mldsaMap) {
                    if (mldsaHex !== buyerHex) continue;
                    events.push({
                        type: 'liquidity_reserved',
                        txHash: r.txHash,
                        blockHeight: r.blockHeight,
                        address: btcAddr,
                        contractAddress: r.nativeSwapAddress,
                        satoshis: BigInt(r.satoshis),
                        tokenAmount: BigInt(r.tokenAmount),
                        role: 'buyer',
                    });
                }
            }
        }

        return events;
    }

    /** Match indexer swaps against tracked wallets (MLDSA hashes + BTC addresses). */
    private matchSwaps(
        swaps: SwapDoc[],
        mldsaMap: ReadonlyMap<string, string>,
        trackedSet: ReadonlySet<string>,
        canonicalMap: ReadonlyMap<string, string>,
    ): WalletEvent[] {
        const events: WalletEvent[] = [];

        for (const s of swaps) {
            const addrHex = s.address.startsWith('0x')
                ? s.address.slice(2).toLowerCase()
                : s.address.toLowerCase();

            let matched = false;

            // Check 1: MLDSA hash match (swap_executed buyer, legacy provider_consumed)
            for (const [btcAddr, mldsaHex] of mldsaMap) {
                if (mldsaHex !== addrHex) continue;
                matched = true;
                this.pushSwapEvent(events, s, btcAddr);
            }

            // Check 2: Direct BTC address match (provider_consumed btcReceiver)
            // The indexer now stores the provider's btcReceiver for provider_consumed events.
            if (!matched) {
                const canonical = canonicalMap.get(s.address) ?? canonicalMap.get(addrHex);
                if (canonical && trackedSet.has(s.address)) {
                    this.pushSwapEvent(events, s, canonical);
                }
            }
        }

        return events;
    }

    private pushSwapEvent(events: WalletEvent[], s: SwapDoc, btcAddr: string): void {
        if (s.type === 'swap_executed') {
            events.push({
                type: 'swap_executed',
                txHash: s.txHash,
                blockHeight: s.blockHeight,
                address: btcAddr,
                contractAddress: s.nativeSwapAddress,
                btcSpent: BigInt(s.btcSpent ?? '0'),
                tokensReceived: BigInt(s.tokenAmount),
            });
        } else {
            events.push({
                type: 'provider_consumed',
                txHash: s.txHash,
                blockHeight: s.blockHeight,
                address: btcAddr,
                contractAddress: s.nativeSwapAddress,
                tokenAmount: BigInt(s.tokenAmount),
            });
        }
    }

    /** Match indexer pool events against tracked MLDSA hashes. */
    private matchPoolEvents(
        poolEvents: PoolEventDoc[],
        mldsaMap: ReadonlyMap<string, string>,
    ): WalletEvent[] {
        const events: WalletEvent[] = [];

        for (const pe of poolEvents) {
            const addrHex = pe.address.startsWith('0x')
                ? pe.address.slice(2).toLowerCase()
                : pe.address.toLowerCase();

            for (const [btcAddr, mldsaHex] of mldsaMap) {
                if (mldsaHex !== addrHex) continue;

                if (pe.action === 'added') {
                    events.push({
                        type: 'liquidity_added',
                        txHash: pe.txHash,
                        blockHeight: pe.blockHeight,
                        address: btcAddr,
                        contractAddress: pe.contractAddress,
                        tokenAmount: BigInt(pe.tokenAmount),
                        ...(pe.tokenAmount2 !== undefined && { tokenAmount2: BigInt(pe.tokenAmount2) }),
                        ...(pe.btcAmount !== undefined && { btcAmount: BigInt(pe.btcAmount) }),
                    });
                } else {
                    events.push({
                        type: 'liquidity_removed',
                        txHash: pe.txHash,
                        blockHeight: pe.blockHeight,
                        address: btcAddr,
                        contractAddress: pe.contractAddress,
                        tokenAmount: BigInt(pe.tokenAmount),
                        ...(pe.tokenAmount2 !== undefined && { tokenAmount2: BigInt(pe.tokenAmount2) }),
                        ...(pe.btcAmount !== undefined && { btcAmount: BigInt(pe.btcAmount) }),
                    });
                }
            }
        }

        return events;
    }

    /** Match indexer staking events against tracked MLDSA hashes. */
    private matchStakingEvents(
        stakingEvents: StakingEventDoc[],
        mldsaMap: ReadonlyMap<string, string>,
    ): WalletEvent[] {
        const events: WalletEvent[] = [];

        const typeMap: Record<string, 'staked' | 'unstaked' | 'rewards_claimed'> = {
            staked: 'staked',
            unstaked: 'unstaked',
            claimed: 'rewards_claimed',
        };

        for (const se of stakingEvents) {
            const addrHex = se.address.startsWith('0x')
                ? se.address.slice(2).toLowerCase()
                : se.address.toLowerCase();

            for (const [btcAddr, mldsaHex] of mldsaMap) {
                if (mldsaHex !== addrHex) continue;

                const evType = typeMap[se.action];
                if (!evType) continue;

                events.push({
                    type: evType,
                    txHash: se.txHash,
                    blockHeight: se.blockHeight,
                    address: btcAddr,
                    contractAddress: se.contractAddress,
                    amount: BigInt(se.amount),
                });
            }
        }

        return events;
    }

    /** Process price changes from the indexer and send alerts to subscribers. */
    private async processPriceChanges(priceChanges: PriceChangeDoc[]): Promise<void> {
        for (const pc of priceChanges) {
            const subscribers = tokenRepo.getSubscribersForToken(pc.tokenContract);

            for (const sub of subscribers) {
                if (sub.priceThresholdPct <= 0 || pc.deltaPct < sub.priceThresholdPct) continue;

                const direction = pc.direction === 'up' ? '📈' : '📉';
                const oldBTC = BigInt(pc.oldPrice);
                const newBTC = BigInt(pc.newPrice);
                // Price display: approximate sats/token from virtual reserves
                const newVBTC = BigInt(pc.virtualBTCReserve);
                const newVToken = BigInt(pc.virtualTokenReserve);
                const newPriceSats = newVToken > 0n ? (newVBTC * 10n ** 8n) / newVToken : 0n;
                // For old price we just display delta info since old reserves aren't in the event
                const poolBtc = formatSats(newVBTC);

                const lines = [
                    `${direction} *Price Alert — ${escapeMarkdown(sub.label)}*`,
                    ``,
                    `📊 Moved: ${pc.direction === 'up' ? '\\+' : '\\-'}${escapeMarkdown(String(pc.deltaPct))}%`,
                    `💰 Old scaled: \`${escapeMarkdown(oldBTC.toString())}\``,
                    `💰 New scaled: \`${escapeMarkdown(newBTC.toString())}\``,
                    `💰 Price: \`${escapeMarkdown(formatSats(newPriceSats))} / token\``,
                    `🏊 Pool: \`${escapeMarkdown(poolBtc)}\` virtual BTC`,
                    `📍 \`${escapeMarkdown(pc.tokenContract.slice(0, 16))}…\``,
                ];

                try {
                    await this.bot.api.sendMessage(sub.chatId, lines.join('\n'), {
                        parse_mode: 'MarkdownV2',
                        link_preview_options: { is_disabled: true },
                    });
                } catch (err: unknown) {
                    console.warn(`[BlockPoller] Failed to send price alert to ${sub.chatId}:`, err);
                }
            }
        }
    }

    // ─── Main poll cycle ─────────────────────────────────────────────────────

    private async processNewBlocks(): Promise<void> {
        const savedLastBlock = await walletRepo.getLastProcessedBlock();

        // Fetch events from the indexer starting after our last processed block.
        const since = savedLastBlock !== null
            ? Math.max(1, savedLastBlock + 1)
            : 1;

        let indexerData;
        try {
            indexerData = await fetchEvents(since);
        } catch (err: unknown) {
            console.error('[BlockPoller] Indexer unreachable:', err instanceof Error ? err.message : String(err));
            return;
        }

        const lastIndexedBlock = indexerData.lastIndexedBlock;

        if (savedLastBlock !== null && lastIndexedBlock <= savedLastBlock) {
            return; // Nothing new
        }

        console.log(`[BlockPoller] Indexer: lastIndexedBlock=${lastIndexedBlock}, since=${since}, ` +
            `transfers=${indexerData.transfers.length}, reservations=${indexerData.reservations.length}, ` +
            `swaps=${indexerData.swaps.length}, pool=${(indexerData.poolEvents ?? []).length}, ` +
            `staking=${(indexerData.stakingEvents ?? []).length}, priceChanges=${indexerData.priceChanges.length}`);

        const trackedAddrs = await walletRepo.getAllTrackedAddresses();
        if (trackedAddrs.length === 0) {
            await walletRepo.setLastProcessedBlock(lastIndexedBlock);
            return;
        }

        // Build expanded address sets
        const { trackedSet, mldsaMap, canonicalMap } = walletRepo.getExpandedAddressData();
        await this.resolveAndCacheLinked(trackedAddrs, mldsaMap, trackedSet, canonicalMap);

        // Pre-populate UTXO store
        await this.populateUTXOs(trackedAddrs);

        // Build UTXO lookup map for BTC input scanning
        const utxoMap = walletRepo.buildUTXOMap();

        // ── Indexer events → WalletEvents ────────────────────────────────────
        const nftContractSet = walletRepo.getAllNftContractSet();

        const tokenEvents = this.matchTransfers(indexerData.transfers, mldsaMap, nftContractSet);
        const reservationEvents = this.matchReservations(indexerData.reservations, mldsaMap, trackedSet, canonicalMap);
        const swapEvents = this.matchSwaps(indexerData.swaps, mldsaMap, trackedSet, canonicalMap);
        const poolEvents = this.matchPoolEvents(indexerData.poolEvents ?? [], mldsaMap);
        const stakingEvents = this.matchStakingEvents(indexerData.stakingEvents ?? [], mldsaMap);

        // ── BTC scanning via RPC (indexer doesn't track raw BTC) ─────────────
        const btcEvents: WalletEvent[] = [];
        const allInferredSends: InferredSend[] = [];
        const lastProcessed = savedLastBlock ?? since - 1;
        const btcFrom = Math.max(1, lastProcessed + 1);
        const btcTo = lastIndexedBlock;

        // Process BTC blocks in batches of 10
        for (let start = btcFrom; start <= btcTo; start += 10) {
            const batchEnd = Math.min(btcTo, start + 9);
            const provider = providerManager.getProvider();

            for (let height = start; height <= batchEnd; height++) {
                try {
                    const { events, receivedUTXOs, spentUTXOKeys, inferredSends } =
                        await scanBlockForBTC(provider, height, trackedSet, canonicalMap, utxoMap);

                    // Update UTXO store
                    for (const key of spentUTXOKeys) {
                        const [txid, vout] = key.split(':');
                        if (txid && vout !== undefined) walletRepo.removeUTXO(txid, parseInt(vout, 10));
                        utxoMap.delete(key);
                    }
                    for (const u of receivedUTXOs) {
                        walletRepo.addUTXO(u.primaryAddress, u.txid, u.vout, u.value);
                        utxoMap.set(`${u.txid}:${u.vout}`, { primaryAddress: u.primaryAddress, value: u.value });
                    }

                    btcEvents.push(...events);
                    allInferredSends.push(...inferredSends);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[BlockPoller] BTC scan failed for block ${height}:`, msg);
                    for (const chatId of walletRepo.listAuthorizedChats()) {
                        try {
                            await this.bot.api.sendMessage(chatId,
                                `⚠️ *BTC scan skipped block ${height}*\n\`${msg.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}\``,
                                { parse_mode: 'MarkdownV2' });
                        } catch { /* best-effort */ }
                    }
                }
            }
        }

        // ── Promote inferred sends to btc_sent ─────────────────────────────────
        // OPNet testnet block inputs have no address data, so we infer btc_sent
        // from change outputs: if the tracked address received BTC in a tx that
        // also has non-tracked outputs, the user was likely the sender.
        // The smart BTC suppression below handles cases where btc_sent should
        // be hidden (swap_executed, OP20↔OP20, reservations).
        {
            const btcSentTxHashes = new Set<string>();
            for (const ev of btcEvents) {
                if (ev.type === 'btc_sent') btcSentTxHashes.add(ev.txHash);
            }

            for (const inf of allInferredSends) {
                // Skip if UTXO map already produced a btc_sent for this tx
                if (btcSentTxHashes.has(inf.txHash)) continue;
                btcEvents.push({
                    type: 'btc_sent',
                    txHash: inf.txHash,
                    blockHeight: inf.blockHeight,
                    address: inf.address,
                    satoshis: inf.totalSent,
                    ...(inf.counterparty    !== undefined && { counterparty:    inf.counterparty }),
                    ...(inf.recipientAmount !== undefined && { recipientAmount: inf.recipientAmount }),
                });
            }
        }

        // ── Merge & deduplicate ──────────────────────────────────────────────
        const allEvents = [...tokenEvents, ...reservationEvents, ...swapEvents, ...poolEvents, ...stakingEvents, ...btcEvents];

        // Deduplicate by txHash within this batch (indexer + BTC may overlap for same tx)
        const seenTxEvent = new Set<string>();
        let dedupedEvents: WalletEvent[] = [];
        for (const ev of allEvents) {
            const contract = 'contractAddress' in ev ? (ev as { contractAddress: string }).contractAddress : '';
            const direction = 'direction' in ev ? (ev as { direction: string }).direction : '';
            const key = `${ev.type}:${ev.txHash}:${ev.address}:${contract}:${direction}`;
            if (seenTxEvent.has(key)) continue;
            seenTxEvent.add(key);
            dedupedEvents.push(ev);
        }

        // Suppress BTC events (gas UTXO plumbing) only when we have enough
        // indexer context to know the BTC is redundant:
        //   1. swap_executed exists → it has btcSpent embedded, BTC events are noise
        //   2. Both token-in AND token-out → OP20↔OP20 trade, BTC is just gas
        //   3. Reservation events exist → BTC is just gas for the reservation tx
        // Do NOT suppress for one-sided token events (e.g. NativeSwap where
        // swap_executed might not be captured yet — BTC gives the only cost context).
        const suppressBtcAddrBlocks = new Set<string>();

        for (const ev of swapEvents) {
            if (ev.type === 'swap_executed') {
                suppressBtcAddrBlocks.add(`${ev.address}::${String(ev.blockHeight)}`);
            }
        }
        for (const ev of reservationEvents) {
            suppressBtcAddrBlocks.add(`${ev.address}::${String(ev.blockHeight)}`);
        }
        for (const ev of poolEvents) {
            suppressBtcAddrBlocks.add(`${ev.address}::${String(ev.blockHeight)}`);
        }
        for (const ev of stakingEvents) {
            suppressBtcAddrBlocks.add(`${ev.address}::${String(ev.blockHeight)}`);
        }

        const tokenInAddrBlocks = new Set<string>();
        const tokenOutAddrBlocks = new Set<string>();
        for (const ev of tokenEvents) {
            const dir = 'direction' in ev ? (ev as { direction: string }).direction : '';
            const key = `${ev.address}::${String(ev.blockHeight)}`;
            if (dir === 'in') tokenInAddrBlocks.add(key);
            if (dir === 'out') tokenOutAddrBlocks.add(key);
        }
        for (const key of tokenInAddrBlocks) {
            if (tokenOutAddrBlocks.has(key)) suppressBtcAddrBlocks.add(key);
        }

        if (suppressBtcAddrBlocks.size > 0) {
            dedupedEvents = dedupedEvents.filter((ev) => {
                if ((ev.type === 'btc_sent' || ev.type === 'btc_received') &&
                    suppressBtcAddrBlocks.has(`${ev.address}::${String(ev.blockHeight)}`)) {
                    return false;
                }
                return true;
            });
        }

        // Filter out already-notified
        const newEvents = dedupedEvents.filter((e) => !this.notifiedTxHashes.has(e.txHash));
        if (newEvents.length > 0) {
            console.log(`[BlockPoller] ${newEvents.length} event(s) to notify`);
            await this.notifier.notify(newEvents);
            for (const e of newEvents) this.notifiedTxHashes.add(e.txHash);

            // Prune oldest entries
            if (this.notifiedTxHashes.size > BlockPoller.MAX_NOTIFIED_TX_HASHES) {
                const oldest = [...this.notifiedTxHashes].slice(
                    0, this.notifiedTxHashes.size - BlockPoller.MAX_NOTIFIED_TX_HASHES,
                );
                for (const h of oldest) this.notifiedTxHashes.delete(h);
            }
        }

        // ── Price alerts ─────────────────────────────────────────────────────
        if (indexerData.priceChanges.length > 0) {
            await this.processPriceChanges(indexerData.priceChanges);
        }

        await walletRepo.setLastProcessedBlock(lastIndexedBlock);
    }
}
