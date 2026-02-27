import { providerManager } from '../provider/ProviderManager.js';
import { walletRepo } from '../db/WalletRepository.js';
import { fetchTransfers } from '../api/IndexerClient.js';

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
 * Scan historical transfers for a newly tracked address using the indexer.
 * Replaces the old block-by-block RPC scan with a single indexer HTTP call.
 * Runs entirely in the background — errors are logged, not thrown.
 */
export async function scanHistory(address: string): Promise<void> {
    console.log(`[HistoricalScanner] Starting scan for ${address}`);

    try {
        // Resolve MLDSA hash — the indexer stores transfers by MLDSA hash
        const mldsaHex = await resolveMldsaHex(address);
        if (!mldsaHex) {
            console.log(`[HistoricalScanner] No OPNet history for ${address} — skipping`);
            walletRepo.markFullyScanned(address);
            return;
        }

        console.log(`[HistoricalScanner] MLDSA hash for ${address}: ${mldsaHex}`);

        // Fetch all transfers for this MLDSA hash from the indexer
        const result = await fetchTransfers(mldsaHex, 200);
        const transfers = result.transfers;

        // Extract unique contract addresses and persist them
        let contractsFound = 0;
        const seen = new Set<string>();
        for (const t of transfers) {
            if (seen.has(t.contractAddress)) continue;
            seen.add(t.contractAddress);
            if (walletRepo.addTokenContract(address, t.contractAddress)) {
                contractsFound++;
            }
        }

        walletRepo.markFullyScanned(address);
        console.log(
            `[HistoricalScanner] Done for ${address} — ${contractsFound} token contract(s) discovered from ${transfers.length} transfer(s)`,
        );
    } catch (err: unknown) {
        console.error(`[HistoricalScanner] Failed for ${address}:`, err);
    }
}
