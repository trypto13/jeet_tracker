import { database, type Subscription, type LinkedAddresses, type StoredUTXO } from './Database.js';

export type { Subscription, LinkedAddresses, StoredUTXO };

/**
 * Repository for tracked wallet subscriptions and tracker state.
 * Backed by the in-memory JSON store — all operations are synchronous
 * under the hood; async signatures are kept for drop-in compatibility.
 */
class WalletRepository {
    private static instance: WalletRepository | undefined;

    private constructor() {}

    public static getInstance(): WalletRepository {
        if (!WalletRepository.instance) {
            WalletRepository.instance = new WalletRepository();
        }
        return WalletRepository.instance;
    }

    /** No-op — indexes not needed for file store. */
    public async ensureIndexes(): Promise<void> {
        return Promise.resolve();
    }

    // ── Authentication ──────────────────────────────────────────────────────────

    public isAuthorized(chatId: number): boolean {
        return database.getStore().authorizedChats.includes(chatId);
    }

    public authorizeChat(chatId: number): void {
        const store = database.getStore();
        if (store.authorizedChats.includes(chatId)) return;
        store.authorizedChats.push(chatId);
        database.scheduleSave();
    }

    public async addSubscription(
        chatId: number,
        address: string,
        label: string,
        maxPerUser: number,
    ): Promise<'added' | 'duplicate' | 'limit_exceeded'> {
        const store = database.getStore();
        const userSubs = store.subscriptions.filter((s) => s.chatId === chatId);

        if (userSubs.length >= maxPerUser) return 'limit_exceeded';
        if (userSubs.some((s) => s.address === address)) return 'duplicate';

        store.subscriptions.push({
            id: crypto.randomUUID().slice(0, 8),
            chatId,
            address,
            label,
            createdAt: new Date().toISOString(),
        });

        database.scheduleSave();
        return 'added';
    }

    public async removeSubscription(
        chatId: number,
        address: string,
    ): Promise<boolean> {
        const store = database.getStore();
        const before = store.subscriptions.length;
        store.subscriptions = store.subscriptions.filter(
            (s) => !(s.chatId === chatId && s.address === address),
        );
        const removed = store.subscriptions.length < before;
        if (removed) database.scheduleSave();
        return removed;
    }

    public async listSubscriptions(chatId: number): Promise<Subscription[]> {
        return database.getStore().subscriptions.filter((s) => s.chatId === chatId);
    }

    public async getAllTrackedAddresses(): Promise<string[]> {
        const seen = new Set<string>();
        for (const s of database.getStore().subscriptions) {
            seen.add(s.address);
        }
        return [...seen];
    }

    public async getChatIdsForAddress(
        address: string,
    ): Promise<{ chatId: number; label: string }[]> {
        return database
            .getStore()
            .subscriptions.filter((s) => s.address === address)
            .map((s) => ({ chatId: s.chatId, label: s.label }));
    }

    public async getSubscriptionById(id: string): Promise<Subscription | null> {
        return database.getStore().subscriptions.find((s) => s.id === id) ?? null;
    }

    /**
     * Register a token contract as having been seen for an address.
     * Returns true if it was newly added.
     */
    public addTokenContract(walletAddress: string, contractAddress: string): boolean {
        const store = database.getStore();
        const existing = store.tokenContracts[walletAddress] ?? [];
        if (existing.includes(contractAddress)) return false;
        store.tokenContracts[walletAddress] = [...existing, contractAddress];
        database.scheduleSave();
        return true;
    }

    /**
     * Get all known OP-20 token contracts for an address.
     */
    public getTokenContracts(walletAddress: string): string[] {
        return database.getStore().tokenContracts[walletAddress] ?? [];
    }

    public isFullyScanned(walletAddress: string): boolean {
        return database.getStore().fullyScannedAddresses.includes(walletAddress);
    }

    public markFullyScanned(walletAddress: string): void {
        const store = database.getStore();
        if (!store.fullyScannedAddresses.includes(walletAddress)) {
            store.fullyScannedAddresses.push(walletAddress);
            database.scheduleSave();
        }
    }

    public async getLastProcessedBlock(): Promise<number | null> {
        return database.getStore().lastProcessedBlock;
    }

    public async setLastProcessedBlock(height: number): Promise<void> {
        database.getStore().lastProcessedBlock = height;
        database.scheduleSave();
    }

    // ── UTXO tracking ──────────────────────────────────────────────────────────

    /**
     * Build a lookup map for input scanning: "txid:vout" → { primaryAddress, value }.
     * Used by TxParser to detect when a tracked UTXO is being spent.
     */
    public buildUTXOMap(): Map<string, { primaryAddress: string; value: bigint }> {
        const store = database.getStore();
        const map = new Map<string, { primaryAddress: string; value: bigint }>();
        for (const [addr, utxos] of Object.entries(store.utxos)) {
            for (const u of utxos) {
                map.set(`${u.txid}:${u.vout}`, { primaryAddress: addr, value: BigInt(u.value) });
            }
        }
        return map;
    }

    /** Record a newly received UTXO against a canonical primary address. */
    public addUTXO(primaryAddress: string, txid: string, vout: number, value: bigint): void {
        const store = database.getStore();
        const list = store.utxos[primaryAddress] ?? [];
        if (list.some((u) => u.txid === txid && u.vout === vout)) return;
        store.utxos[primaryAddress] = [...list, { txid, vout, value: value.toString() }];
        database.scheduleSave();
    }

    /** Remove a spent UTXO by its txid:vout key. */
    public removeUTXO(txid: string, vout: number): void {
        const store = database.getStore();
        for (const addr of Object.keys(store.utxos)) {
            const before = store.utxos[addr]!;
            const after = before.filter((u) => !(u.txid === txid && u.vout === vout));
            if (after.length !== before.length) {
                store.utxos[addr] = after;
                database.scheduleSave();
            }
        }
    }

    /**
     * Bulk-set the UTXO list for a primary address.
     * Used for initial population from provider.utxoManager.getUTXOs() on startup.
     */
    public setUTXOs(
        primaryAddress: string,
        utxos: ReadonlyArray<{ txid: string; vout: number; value: bigint }>,
    ): void {
        const store = database.getStore();
        store.utxos[primaryAddress] = utxos.map((u) => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value.toString(),
        }));
        database.scheduleSave();
    }

    /**
     * Store resolved linked addresses for a primary tracked address.
     * Persists to the subscription entry so future polls skip the RPC call.
     */
    public updateLinkedAddresses(primaryAddress: string, linked: LinkedAddresses): void {
        const store = database.getStore();
        const sub = store.subscriptions.find((s) => s.address === primaryAddress);
        if (!sub) return;
        sub.linkedAddresses = linked;
        database.scheduleSave();
    }

    /**
     * Get stored linked addresses for a primary tracked address.
     * Used by the balance command to resolve MLDSA identity when getPublicKeyInfo
     * returns null for the input address (no direct OPNet history).
     */
    public getLinkedAddressesFor(address: string): LinkedAddresses | undefined {
        return database.getStore().subscriptions.find((s) => s.address === address)?.linkedAddresses;
    }

    /**
     * Find any existing subscription sharing the given MLDSA hash (cross-format duplicate).
     * Also matches if a subscription's address field is literally '0x' + mldsaHash.
     */
    public findSubscriptionByMldsaHash(mldsaHash: string): Subscription | undefined {
        return database.getStore().subscriptions.find(
            (s) =>
                s.linkedAddresses?.mldsaHash === mldsaHash ||
                s.address === '0x' + mldsaHash,
        );
    }

    /**
     * Find a subscription that has a given BTC address as a linked alias (p2tr/p2wpkh/p2pkh).
     * Used by the balance command to resolve MLDSA when the input is a linked alias.
     */
    public findSubscriptionByLinkedAddress(address: string): Subscription | undefined {
        return database.getStore().subscriptions.find((s) => {
            const linked = s.linkedAddresses;
            if (!linked) return false;
            return linked.p2tr === address || linked.p2wpkh === address || linked.p2pkh === address;
        });
    }

    /**
     * Build expanded address data for the block poller in one call.
     *
     * Returns:
     *   - trackedSet  : primary addresses + all linked BTC addresses
     *   - mldsaMap    : primary_btc_address → mldsa_hash_hex (for OP-20 event matching)
     *   - canonicalMap: linked_btc_address  → primary_btc_address (for event normalisation)
     *
     * mldsaMap is keyed only by primary address so that OP-20 Transfer events always
     * produce notifications attributed to the subscription address, not a linked alias.
     */
    public getExpandedAddressData(): {
        trackedSet: Set<string>;
        mldsaMap: Map<string, string>;
        canonicalMap: Map<string, string>;
    } {
        const store = database.getStore();
        const trackedSet = new Set<string>();
        const mldsaMap = new Map<string, string>();
        const canonicalMap = new Map<string, string>();
        const seenPrimaries = new Set<string>();

        for (const sub of store.subscriptions) {
            const primary = sub.address;
            trackedSet.add(primary);

            // Process linked addresses once per unique primary
            if (seenPrimaries.has(primary)) continue;
            seenPrimaries.add(primary);

            const linked = sub.linkedAddresses;
            if (!linked) continue;

            if (linked.mldsaHash) {
                mldsaMap.set(primary, linked.mldsaHash);
            }

            // Add extra BTC addresses to trackedSet + canonicalMap (not to mldsaMap,
            // to avoid emitting duplicate events for the same MLDSA identity)
            for (const extra of [linked.p2tr, linked.p2wpkh, linked.p2pkh, linked.csv1]) {
                if (extra && extra !== primary) {
                    trackedSet.add(extra);
                    canonicalMap.set(extra, primary);
                }
            }
        }

        return { trackedSet, mldsaMap, canonicalMap };
    }
}

export const walletRepo = WalletRepository.getInstance();
