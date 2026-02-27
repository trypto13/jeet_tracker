import { MongoClient, type Collection, type Db } from 'mongodb';

export interface LinkedAddresses {
    /** 64 hex chars, no 0x prefix — the wallet's OPNet MLDSA identity hash */
    readonly mldsaHash?: string;
    /** 64 hex chars — the wallet's tweaked taproot public key */
    readonly tweakedPubkey?: string;
    /** P2OP address — OPNet contract-style address derived from MLDSA key */
    readonly p2op?: string;
    /** P2TR address derived from MLDSA key (may equal the primary tracked address) */
    readonly p2tr?: string;
    /** P2WPKH address — only available when originalPublicKey is present */
    readonly p2wpkh?: string;
    /** P2PKH address — only available when originalPublicKey is present */
    readonly p2pkh?: string;
    /** CSV1 P2WSH timelock address — only available when originalPublicKey is present */
    readonly csv1?: string;
}

export interface StoredUTXO {
    readonly txid: string;
    readonly vout: number;
    /** bigint serialised as decimal string for JSON */
    readonly value: string;
}

export interface Subscription {
    readonly id: string;
    readonly chatId: number;
    readonly address: string;
    readonly label: string;
    readonly createdAt: string;
    linkedAddresses?: LinkedAddresses;
}

export interface TokenSubscription {
    readonly id: string;
    readonly chatId: number;
    /** P2OP or 0x-hex contract address */
    readonly contractAddress: string;
    readonly label: string;
    readonly tokenType: 'op20' | 'op721';
    /** Notify when price moves by this % or more (0 = off) */
    priceThresholdPct: number;
    /** Notify on reservations only when satoshis >= this value (0 = all) */
    minReservationSats: number;
}

interface Store {
    subscriptions: Subscription[];
    lastProcessedBlock: number | null;
    /** address → Set of OP-20 contract addresses seen in Transfer events */
    tokenContracts: Record<string, string[]>;
    /** address → Set of OP-721 NFT contract addresses seen in Transferred events */
    nftContracts: Record<string, string[]>;
    /** Addresses that have been fully scanned from block 1 */
    fullyScannedAddresses: string[];
    /** canonical primary address → UTXOs currently held at that wallet (all linked address types) */
    utxos: Record<string, StoredUTXO[]>;
    /** Telegram chat IDs that have authenticated with the bot password */
    authorizedChats: number[];
    /** Per-chat token (OP-20 / OP-721) monitoring subscriptions */
    tokenSubscriptions: TokenSubscription[];
}

const EMPTY_STORE: Store = {
    subscriptions: [],
    lastProcessedBlock: null,
    tokenContracts: {},
    nftContracts: {},
    fullyScannedAddresses: [],
    utxos: {},
    authorizedChats: [],
    tokenSubscriptions: [],
};

// --- MongoDB document shapes (only used internally) ---

interface SubscriptionDoc {
    id: string;
    chatId: number;
    address: string;
    label: string;
    createdAt: string;
    linkedAddresses?: LinkedAddresses;
}

interface TokenSubscriptionDoc {
    id: string;
    chatId: number;
    contractAddress: string;
    label: string;
    tokenType: 'op20' | 'op721';
    priceThresholdPct: number;
    minReservationSats: number;
}

interface AuthorizedChatDoc {
    chatId: number;
}

interface TokenContractDoc {
    walletAddress: string;
    contractAddress: string;
}

interface NftContractDoc {
    walletAddress: string;
    contractAddress: string;
}

interface UtxoDoc {
    primaryAddress: string;
    txid: string;
    vout: number;
    value: string;
}

interface StateDoc {
    key: string;
    value: unknown;
}

/**
 * MongoDB-backed store with in-memory cache for synchronous reads.
 * All mutations write-through to MongoDB; all reads come from memory.
 */
class Database {
    private static instance: Database | undefined;
    private data: Store = { ...EMPTY_STORE };
    private client: MongoClient | undefined;
    private db: Db | undefined;

    // Collections
    private subscriptionsCol!: Collection<SubscriptionDoc>;
    private tokenSubscriptionsCol!: Collection<TokenSubscriptionDoc>;
    private authorizedChatsCol!: Collection<AuthorizedChatDoc>;
    private tokenContractsCol!: Collection<TokenContractDoc>;
    private nftContractsCol!: Collection<NftContractDoc>;
    private utxosCol!: Collection<UtxoDoc>;
    private stateCol!: Collection<StateDoc>;

    private constructor() {}

    public static getInstance(): Database {
        if (!Database.instance) {
            Database.instance = new Database();
        }
        return Database.instance;
    }

    public async load(mongoUri: string): Promise<void> {
        this.client = new MongoClient(mongoUri);
        await this.client.connect();
        this.db = this.client.db();

        // Bind collections
        this.subscriptionsCol = this.db.collection<SubscriptionDoc>('subscriptions');
        this.tokenSubscriptionsCol = this.db.collection<TokenSubscriptionDoc>('token_subscriptions');
        this.authorizedChatsCol = this.db.collection<AuthorizedChatDoc>('authorized_chats');
        this.tokenContractsCol = this.db.collection<TokenContractDoc>('token_contracts');
        this.nftContractsCol = this.db.collection<NftContractDoc>('nft_contracts');
        this.utxosCol = this.db.collection<UtxoDoc>('utxos');
        this.stateCol = this.db.collection<StateDoc>('state');

        // Hydrate in-memory store from MongoDB
        const [subs, tokenSubs, authChats, tokenContracts, nftContracts, utxos, stateRows] =
            await Promise.all([
                this.subscriptionsCol.find().toArray(),
                this.tokenSubscriptionsCol.find().toArray(),
                this.authorizedChatsCol.find().toArray(),
                this.tokenContractsCol.find().toArray(),
                this.nftContractsCol.find().toArray(),
                this.utxosCol.find().toArray(),
                this.stateCol.find().toArray(),
            ]);

        // subscriptions
        this.data.subscriptions = subs.map((d) => {
            const base = {
                id: d.id,
                chatId: d.chatId,
                address: d.address,
                label: d.label,
                createdAt: d.createdAt,
            };
            return d.linkedAddresses
                ? { ...base, linkedAddresses: d.linkedAddresses }
                : base;
        });

        // token subscriptions
        this.data.tokenSubscriptions = tokenSubs.map((d) => ({
            id: d.id,
            chatId: d.chatId,
            contractAddress: d.contractAddress,
            label: d.label,
            tokenType: d.tokenType,
            priceThresholdPct: d.priceThresholdPct,
            minReservationSats: d.minReservationSats,
        }));

        // authorized chats
        this.data.authorizedChats = authChats.map((d) => d.chatId);

        // token contracts → Record<walletAddress, contractAddress[]>
        const tcMap: Record<string, string[]> = {};
        for (const d of tokenContracts) {
            const list = tcMap[d.walletAddress] ?? [];
            list.push(d.contractAddress);
            tcMap[d.walletAddress] = list;
        }
        this.data.tokenContracts = tcMap;

        // nft contracts → Record<walletAddress, contractAddress[]>
        const nftMap: Record<string, string[]> = {};
        for (const d of nftContracts) {
            const list = nftMap[d.walletAddress] ?? [];
            list.push(d.contractAddress);
            nftMap[d.walletAddress] = list;
        }
        this.data.nftContracts = nftMap;

        // utxos → Record<primaryAddress, StoredUTXO[]>
        const utxoMap: Record<string, StoredUTXO[]> = {};
        for (const d of utxos) {
            const list = utxoMap[d.primaryAddress] ?? [];
            list.push({ txid: d.txid, vout: d.vout, value: d.value });
            utxoMap[d.primaryAddress] = list;
        }
        this.data.utxos = utxoMap;

        // state keys
        for (const row of stateRows) {
            if (row.key === 'lastProcessedBlock') {
                this.data.lastProcessedBlock = row.value as number | null;
            } else if (row.key === 'fullyScannedAddresses') {
                this.data.fullyScannedAddresses = row.value as string[];
            }
        }

        console.log(
            `[DB] MongoDB connected — ${this.data.subscriptions.length} subscriptions, ` +
            `${this.data.authorizedChats.length} authorized chats`,
        );
    }

    public getStore(): Store {
        return this.data;
    }

    /**
     * Expose the underlying Db instance for other repositories
     * that need to manage their own collections (e.g. SubscriptionRepository).
     */
    public getDb(): Db {
        if (!this.db) throw new Error('Database not loaded');
        return this.db;
    }

    // ── Indexes ─────────────────────────────────────────────────────────────────

    public async ensureIndexes(): Promise<void> {
        await Promise.all([
            this.subscriptionsCol.createIndex({ id: 1 }, { unique: true }),
            this.subscriptionsCol.createIndex({ chatId: 1, address: 1 }, { unique: true }),
            this.tokenSubscriptionsCol.createIndex({ id: 1 }, { unique: true }),
            this.tokenSubscriptionsCol.createIndex(
                { chatId: 1, contractAddress: 1 },
                { unique: true },
            ),
            this.authorizedChatsCol.createIndex({ chatId: 1 }, { unique: true }),
            this.tokenContractsCol.createIndex(
                { walletAddress: 1, contractAddress: 1 },
                { unique: true },
            ),
            this.nftContractsCol.createIndex(
                { walletAddress: 1, contractAddress: 1 },
                { unique: true },
            ),
            this.utxosCol.createIndex({ txid: 1, vout: 1 }, { unique: true }),
            this.utxosCol.createIndex({ primaryAddress: 1 }),
            this.stateCol.createIndex({ key: 1 }, { unique: true }),
        ]);
        console.log('[DB] MongoDB indexes ensured');
    }

    // ── Write-through methods ───────────────────────────────────────────────────

    public async insertSubscription(sub: Subscription): Promise<void> {
        const doc: SubscriptionDoc = {
            id: sub.id,
            chatId: sub.chatId,
            address: sub.address,
            label: sub.label,
            createdAt: sub.createdAt,
        };
        if (sub.linkedAddresses) {
            doc.linkedAddresses = sub.linkedAddresses;
        }
        await this.subscriptionsCol.insertOne(doc);
    }

    public async deleteSubscription(chatId: number, address: string): Promise<void> {
        await this.subscriptionsCol.deleteOne({ chatId, address });
    }

    public async deleteSubscriptionsByChatId(chatId: number): Promise<void> {
        await this.subscriptionsCol.deleteMany({ chatId });
    }

    public async updateSubscriptionLinked(
        address: string,
        linked: LinkedAddresses,
    ): Promise<void> {
        await this.subscriptionsCol.updateMany(
            { address },
            { $set: { linkedAddresses: linked } },
        );
    }

    public async insertTokenSubscription(sub: TokenSubscription): Promise<void> {
        await this.tokenSubscriptionsCol.insertOne({
            id: sub.id,
            chatId: sub.chatId,
            contractAddress: sub.contractAddress,
            label: sub.label,
            tokenType: sub.tokenType,
            priceThresholdPct: sub.priceThresholdPct,
            minReservationSats: sub.minReservationSats,
        });
    }

    public async deleteTokenSubscription(chatId: number, contractAddress: string): Promise<void> {
        await this.tokenSubscriptionsCol.deleteOne({ chatId, contractAddress });
    }

    public async deleteTokenSubscriptionById(chatId: number, id: string): Promise<void> {
        await this.tokenSubscriptionsCol.deleteOne({ chatId, id });
    }

    public async updateTokenThresholds(
        chatId: number,
        contractAddress: string,
        priceThresholdPct: number,
        minReservationSats: number,
    ): Promise<void> {
        await this.tokenSubscriptionsCol.updateOne(
            { chatId, contractAddress },
            { $set: { priceThresholdPct, minReservationSats } },
        );
    }

    public async insertAuthorizedChat(chatId: number): Promise<void> {
        await this.authorizedChatsCol.insertOne({ chatId });
    }

    public async deleteAuthorizedChat(chatId: number): Promise<void> {
        await this.authorizedChatsCol.deleteOne({ chatId });
    }

    public async upsertTokenContract(
        walletAddress: string,
        contractAddress: string,
    ): Promise<void> {
        await this.tokenContractsCol.updateOne(
            { walletAddress, contractAddress },
            { $setOnInsert: { walletAddress, contractAddress } },
            { upsert: true },
        );
    }

    public async upsertNftContract(
        walletAddress: string,
        contractAddress: string,
    ): Promise<void> {
        await this.nftContractsCol.updateOne(
            { walletAddress, contractAddress },
            { $setOnInsert: { walletAddress, contractAddress } },
            { upsert: true },
        );
    }

    public async insertUTXO(
        primaryAddress: string,
        txid: string,
        vout: number,
        value: string,
    ): Promise<void> {
        await this.utxosCol.updateOne(
            { txid, vout },
            { $setOnInsert: { primaryAddress, txid, vout, value } },
            { upsert: true },
        );
    }

    public async deleteUTXO(txid: string, vout: number): Promise<void> {
        await this.utxosCol.deleteOne({ txid, vout });
    }

    public async setUTXOs(
        primaryAddress: string,
        utxos: ReadonlyArray<{ txid: string; vout: number; value: string }>,
    ): Promise<void> {
        await this.utxosCol.deleteMany({ primaryAddress });
        if (utxos.length > 0) {
            await this.utxosCol.insertMany(
                utxos.map((u) => ({
                    primaryAddress,
                    txid: u.txid,
                    vout: u.vout,
                    value: u.value,
                })),
            );
        }
    }

    public async setState(key: string, value: unknown): Promise<void> {
        await this.stateCol.updateOne(
            { key },
            { $set: { key, value } },
            { upsert: true },
        );
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    public async close(): Promise<void> {
        await this.client?.close();
        console.log('[DB] MongoDB connection closed');
    }
}

export const database = Database.getInstance();
