import 'dotenv/config';

export interface Config {
    readonly telegramToken: string;
    readonly botPassword: string;
    readonly rpcUrl: string;
    readonly network: 'mainnet' | 'regtest';
    readonly pollIntervalMs: number;
    readonly maxWalletsPerUser: number;
}

const DEFAULT_RPC: Record<'mainnet' | 'regtest', string> = {
    mainnet: 'https://api.opnet.org',
    regtest: 'https://regtest.opnet.org',
};

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
}

function parseNetwork(val: string | undefined): 'mainnet' | 'regtest' {
    if (val === 'mainnet' || val === 'regtest') return val;
    return 'mainnet';
}

const network = parseNetwork(process.env['NETWORK']);

export const config: Config = {
    telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    botPassword:   requireEnv('BOT_PASSWORD'),
    network,
    // RPC_URL in .env overrides the default; otherwise pick based on NETWORK
    rpcUrl: process.env['RPC_URL'] ?? DEFAULT_RPC[network],
    pollIntervalMs: parseInt(process.env['POLL_INTERVAL_MS'] ?? '30000', 10),
    maxWalletsPerUser: parseInt(process.env['MAX_WALLETS_PER_USER'] ?? '20', 10),
};
