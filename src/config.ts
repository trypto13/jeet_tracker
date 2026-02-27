import 'dotenv/config';
import { networks, type Network } from '@btc-vision/bitcoin';

export type OPNetNetwork = 'mainnet' | 'testnet';

export interface Config {
    readonly telegramToken: string;
    readonly botPassword: string;
    readonly rpcUrl: string;
    readonly network: OPNetNetwork;
    readonly pollIntervalMs: number;
    readonly maxWalletsPerUser: number;
    readonly mempoolUrl: string;
    readonly adminChatId: number | null;
    readonly mongoUri: string;
    readonly indexerUrl: string;
}

const DEFAULT_RPC: Record<OPNetNetwork, string> = {
    mainnet: 'https://mainnet.opnet.org',
    testnet: 'https://testnet.opnet.org',
};

const DEFAULT_MEMPOOL: Record<OPNetNetwork, string> = {
    mainnet: 'https://mempool.space/tx/',
    testnet: 'https://mempool.opnet.org/testnet4/tx/',
};

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
}

function parseNetwork(val: string | undefined): OPNetNetwork {
    if (val === 'mainnet' || val === 'testnet') return val;
    return 'mainnet';
}

const network = parseNetwork(process.env['NETWORK']);

export const config: Config = {
    telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    botPassword:   requireEnv('BOT_PASSWORD'),
    network,
    // RPC_URL in .env overrides the default; otherwise pick based on NETWORK
    rpcUrl: process.env['RPC_URL'] ?? DEFAULT_RPC[network],
    pollIntervalMs:    parseInt(process.env['POLL_INTERVAL_MS'] ?? '30000', 10),
    maxWalletsPerUser: parseInt(process.env['MAX_WALLETS_PER_USER'] ?? '20', 10),
    mempoolUrl: process.env['MEMPOOL_URL'] ?? DEFAULT_MEMPOOL[network],
    adminChatId: process.env['ADMIN_CHAT_ID'] ? parseInt(process.env['ADMIN_CHAT_ID'], 10) : null,
    mongoUri: process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017/jeet-tracker',
    indexerUrl: process.env['INDEXER_URL'] ?? 'http://localhost:3000',
};

/**
 * Resolved @btc-vision/bitcoin Network object for the configured network.
 * Use this everywhere instead of re-computing the ternary.
 * NOTE: OPNet testnet uses networks.opnetTestnet (Signet fork), NOT networks.testnet (BTC Testnet4).
 */
export const bitcoinNetwork: Network =
    network === 'mainnet' ? networks.bitcoin : networks.opnetTestnet;
