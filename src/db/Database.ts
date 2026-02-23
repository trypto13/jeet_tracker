import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LinkedAddresses {
    /** 64 hex chars, no 0x prefix — the wallet's OPNet MLDSA identity hash */
    readonly mldsaHash?: string;
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

interface Store {
    subscriptions: Subscription[];
    lastProcessedBlock: number | null;
    /** address → Set of OP-20 contract addresses seen in Transfer events */
    tokenContracts: Record<string, string[]>;
    /** Addresses that have been fully scanned from block 1 */
    fullyScannedAddresses: string[];
    /** canonical primary address → UTXOs currently held at that wallet (all linked address types) */
    utxos: Record<string, StoredUTXO[]>;
    /** Telegram chat IDs that have authenticated with the bot password */
    authorizedChats: number[];
}

const EMPTY_STORE: Store = {
    subscriptions: [],
    lastProcessedBlock: null,
    tokenContracts: {},
    fullyScannedAddresses: [],
    utxos: {},
    authorizedChats: [],
};

/**
 * Simple JSON file-based store. No external database required.
 */
class Database {
    private static instance: Database | undefined;
    private data: Store = { ...EMPTY_STORE };
    private filePath = './data/store.json';
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor() {}

    public static getInstance(): Database {
        if (!Database.instance) {
            Database.instance = new Database();
        }
        return Database.instance;
    }

    public async load(filePath = './data/store.json'): Promise<void> {
        this.filePath = filePath;
        await mkdir(dirname(filePath), { recursive: true });

        if (existsSync(filePath)) {
            const raw = await readFile(filePath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<Store>;
            this.data = {
                subscriptions: parsed.subscriptions ?? [],
                lastProcessedBlock: parsed.lastProcessedBlock ?? null,
                tokenContracts: parsed.tokenContracts ?? {},
                fullyScannedAddresses: parsed.fullyScannedAddresses ?? [],
                utxos: parsed.utxos ?? {},
                authorizedChats: parsed.authorizedChats ?? [],
            };
        } else {
            this.data = { ...EMPTY_STORE, tokenContracts: {} };
        }

        console.log('[DB] JSON store loaded from', filePath);
    }

    public getStore(): Store {
        return this.data;
    }

    public scheduleSave(): void {
        if (this.saveTimer !== undefined) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
        }, 200);
    }
}

export const database = Database.getInstance();
