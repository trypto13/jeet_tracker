import { providerManager } from '../provider/ProviderManager.js';
import { walletRepo } from '../db/WalletRepository.js';
import { parseBlockForAddresses } from './TxParser.js';

/** Blocks to process in one batch before yielding to the event loop. */
const BATCH_SIZE = 20;

/**
 * Resolve the MLDSA hash (hex, no 0x, lowercase) for a Bitcoin address.
 * Returns null if the address has no OPNet on-chain history.
 */
async function resolveMldsaHex(address: string): Promise<string | null> {
    try {
        const provider = providerManager.getProvider();
        const owner = await provider.getPublicKeyInfo(address, false);
        if (!owner) return null;
        return Buffer.from(owner).toString('hex').toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Scan historical blocks to discover OP-20 token contracts for a newly tracked address.
 * Runs entirely in the background — errors are logged, not thrown.
 */
export async function scanHistory(address: string): Promise<void> {
    console.log(`[HistoricalScanner] Starting scan for ${address}`);

    try {
        const provider = providerManager.getProvider();
        const latest = Number(await provider.getBlockNumber());
        const from = 1;
        const trackedSet = new Set([address]);

        // Resolve MLDSA hash once — Transfer events encode addresses as MLDSA hashes,
        // not as Bitcoin address strings.
        const mldsaHex = await resolveMldsaHex(address);
        const mldsaMap = new Map<string, string>();
        if (mldsaHex) {
            mldsaMap.set(address, mldsaHex);
            console.log(`[HistoricalScanner] MLDSA hash for ${address}: ${mldsaHex}`);
        } else {
            console.log(`[HistoricalScanner] No OPNet history for ${address} — BTC events only`);
        }

        let contractsFound = 0;
        const totalBlocks = latest - from + 1;

        for (let height = from; height <= latest; height += BATCH_SIZE) {
            if (height % 1000 === 1) {
                const pct = Math.round(((height - from) / totalBlocks) * 100);
                console.log(`[HistoricalScanner] ${address.slice(0, 12)}… ${pct}% (block ${height}/${latest})`);
            }
            const batchEnd = Math.min(latest, height + BATCH_SIZE - 1);
            const promises: Promise<void>[] = [];

            for (let h = height; h <= batchEnd; h++) {
                promises.push(
                    parseBlockForAddresses(provider, h, trackedSet, mldsaMap)
                        .then(({ discoveredContracts }) => {
                            for (const [addr, contracts] of discoveredContracts) {
                                for (const contract of contracts) {
                                    const added = walletRepo.addTokenContract(addr, contract);
                                    if (added) contractsFound++;
                                }
                            }
                        })
                        .catch(() => {
                            // Individual block failures are non-fatal
                        }),
                );
            }

            await Promise.all(promises);

            // Yield to the event loop between batches so bot stays responsive
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        walletRepo.markFullyScanned(address);
        console.log(
            `[HistoricalScanner] Done for ${address} — ${contractsFound} token contract(s) discovered across ${totalBlocks} blocks`,
        );
    } catch (err: unknown) {
        console.error(`[HistoricalScanner] Failed for ${address}:`, err);
    }
}
