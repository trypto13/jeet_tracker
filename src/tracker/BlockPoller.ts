import { networks } from '@btc-vision/bitcoin';
import { providerManager } from '../provider/ProviderManager.js';
import { walletRepo } from '../db/WalletRepository.js';
import { parseBlockForAddresses } from './TxParser.js';
import { config } from '../config.js';
import type { Notifier } from './Notifier.js';

/**
 * Polls OPNet for new blocks and dispatches wallet-activity notifications.
 */
export class BlockPoller {
    private readonly notifier: Notifier;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;

    /** Tracks which primary addresses have had their UTXOs initially populated. */
    private utxoPopulated = new Set<string>();

    public constructor(notifier: Notifier) {
        this.notifier = notifier;
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
     * Also resolves and stores the CSV1 address.
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
        const net = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;

        await Promise.all(
            unresolved.map(async (addr) => {
                try {
                    const owner = await provider.getPublicKeyInfo(addr, false);
                    if (!owner) return;

                    const mldsaHash = Buffer.from(owner).toString('hex').toLowerCase();
                    mldsaMap.set(addr, mldsaHash);

                    let p2tr: string | undefined;
                    let p2wpkh: string | undefined;
                    let p2pkh: string | undefined;
                    let csv1: string | undefined;
                    try { p2tr = owner.p2tr(net); } catch { /* not available */ }
                    try { p2wpkh = owner.p2wpkh(net); } catch { /* not available */ }
                    try { p2pkh = owner.p2pkh(net); } catch { /* not available */ }
                    try { csv1 = provider.getCSV1ForAddress(owner).address; } catch { /* not available */ }

                    for (const extra of [p2tr, p2wpkh, p2pkh, csv1]) {
                        if (extra && extra !== addr) {
                            trackedSet.add(extra);
                            canonicalMap.set(extra, addr);
                        }
                    }

                    walletRepo.updateLinkedAddresses(addr, {
                        mldsaHash,
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
     * Fetches current UTXOs from the provider so sends of pre-existing UTXOs
     * (e.g. CSV1 UTXOs that existed before the bot started) are detected.
     */
    private async populateUTXOs(primaryAddrs: string[]): Promise<void> {
        const provider = providerManager.getProvider();
        const unpopulated = primaryAddrs.filter((a) => !this.utxoPopulated.has(a));
        if (unpopulated.length === 0) return;

        await Promise.all(
            unpopulated.map(async (primaryAddr) => {
                this.utxoPopulated.add(primaryAddr);

                // Collect all addresses that belong to this primary (including CSV1)
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
                        } catch { /* address has no UTXOs or not supported */ }
                    }),
                );

                walletRepo.setUTXOs(primaryAddr, allUTXOs);
                console.log(`[BlockPoller] UTXO store populated for ${primaryAddr}: ${allUTXOs.length} UTXO(s)`);
            }),
        );
    }

    private async processNewBlocks(): Promise<void> {
        const provider = providerManager.getProvider();

        const [latestHeight, savedLastBlock] = await Promise.all([
            provider.getBlockNumber(),
            walletRepo.getLastProcessedBlock(),
        ]);

        const latest = Number(latestHeight);
        const lastProcessed = savedLastBlock ?? latest - 1;

        if (lastProcessed >= latest) return;

        const trackedAddrs = await walletRepo.getAllTrackedAddresses();
        if (trackedAddrs.length === 0) {
            await walletRepo.setLastProcessedBlock(latest);
            return;
        }

        // Build expanded address sets from stored linkedAddresses (instant, no RPC).
        // For primaries not yet resolved, fall back to RPC and persist for future polls.
        const { trackedSet, mldsaMap, canonicalMap } = walletRepo.getExpandedAddressData();
        await this.resolveAndCacheLinked(trackedAddrs, mldsaMap, trackedSet, canonicalMap);

        // Pre-populate UTXO store on first poll for each tracked wallet.
        await this.populateUTXOs(trackedAddrs);

        // Build the UTXO lookup map for input scanning this poll cycle.
        const utxoMap = walletRepo.buildUTXOMap();

        const from = lastProcessed + 1;
        const to = Math.min(latest, from + 9);

        console.log(`[BlockPoller] Processing blocks ${from}–${to} (${trackedAddrs.length} tracked, ${trackedSet.size} addresses, ${utxoMap.size} UTXOs)`);

        for (let height = from; height <= to; height++) {
            const { events, discoveredContracts, receivedUTXOs, spentUTXOKeys } =
                await parseBlockForAddresses(
                    provider,
                    height,
                    trackedSet,
                    mldsaMap,
                    canonicalMap,
                    utxoMap,
                );

            // Update UTXO store: remove spent, add received
            for (const key of spentUTXOKeys) {
                const [txid, vout] = key.split(':');
                if (txid && vout !== undefined) walletRepo.removeUTXO(txid, parseInt(vout, 10));
                // Also remove from the in-memory map so same-block double-spends aren't re-detected
                utxoMap.delete(key);
            }
            for (const u of receivedUTXOs) {
                walletRepo.addUTXO(u.primaryAddress, u.txid, u.vout, u.value);
                // Add to in-memory map so same-block spends of fresh UTXOs are detected
                utxoMap.set(`${u.txid}:${u.vout}`, { primaryAddress: u.primaryAddress, value: u.value });
            }

            // Persist newly discovered token contracts
            for (const [addr, contracts] of discoveredContracts) {
                for (const contract of contracts) {
                    walletRepo.addTokenContract(addr, contract);
                }
            }

            if (events.length > 0) {
                console.log(`[BlockPoller] Block ${height}: ${events.length} event(s) found`);
                await this.notifier.notify(events);
            }

            await walletRepo.setLastProcessedBlock(height);
        }
    }
}
