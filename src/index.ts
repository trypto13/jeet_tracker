import { database } from './db/Database.js';
import { walletRepo } from './db/WalletRepository.js';
import { createBot } from './bot/Bot.js';
import { Notifier } from './tracker/Notifier.js';
import { BlockPoller } from './tracker/BlockPoller.js';
import { scanHistory } from './tracker/HistoricalScanner.js';

async function main(): Promise<void> {
    console.log('[Main] Starting OPNet Wallet Tracker...');

    // Load JSON file store
    await database.load('./data/store.json');
    await walletRepo.ensureIndexes();

    // Build Telegram bot
    const bot = createBot();
    const notifier = new Notifier(bot);
    const poller = new BlockPoller(notifier);

    // Re-scan any tracked wallets that have no discovered token contracts yet.
    // This handles wallets added before the scanner was working correctly.
    const allAddresses = await walletRepo.getAllTrackedAddresses();
    for (const addr of allAddresses) {
        if (!walletRepo.isFullyScanned(addr)) {
            console.log(`[Main] Queuing full historical scan for: ${addr}`);
            void scanHistory(addr);
        }
    }

    // Graceful shutdown
    const shutdown = async (): Promise<void> => {
        console.log('\n[Main] Shutting down...');
        poller.stop();
        await bot.stop();
        void database; // file store needs no explicit close
        process.exit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    // Start block poller (async — don't await; runs in background)
    void poller.start();

    // Start Telegram bot (long-polling)
    console.log('[Main] Bot is running. Press Ctrl+C to stop.');
    await bot.start({
        onStart: (info) => {
            console.log(`[Main] Logged in as @${info.username}`);
        },
    });
}

main().catch((err: unknown) => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
});
