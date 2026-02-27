import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { walletRepo } from '../db/WalletRepository.js';
import { mainKeyboard } from './keyboards.js';
import { startCommand } from './commands/start.js';
import { helpCommand } from './commands/help.js';
import { trackCommand } from './commands/track.js';
import { untrackCommand } from './commands/untrack.js';
import { walletsCommand } from './commands/wallets.js';
import { balanceCommand, inlineBalanceHandler } from './commands/balance.js';
import { portfolioCommand } from './commands/portfolio.js';
import { usersCommand, revokeCommand } from './commands/admin.js';
import { trackTokenCommand } from './commands/tracktoken.js';
import { untracktokensCommand } from './commands/untracktokens.js';
import { listingsCommand } from './commands/listings.js';
import { reservationsCommand } from './commands/reservations.js';
import { tokenAlertsCommand } from './commands/tokenalerts.js';
import { redeemCommand } from './commands/redeem.js';
import { tokenRepo } from '../db/TokenRepository.js';
import { subscriptionRepo } from '../db/SubscriptionRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Build and configure the Grammy Telegram bot.
 */
export function createBot(): Bot {
    const bot = new Bot<Context>(config.telegramToken);

    // --- Rate limiting ---
    const rateLimitMap = new Map<string, number>();
    const RATE_LIMITS: Record<string, number> = { balance: 10_000, portfolio: 30_000, listings: 10_000, reservations: 10_000 };

    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id;
        const text = ctx.message?.text;
        if (!chatId || !text?.startsWith('/')) return next();

        const command = ((text.split(/\s+/)[0] ?? '').slice(1).split('@')[0] ?? '').toLowerCase();
        const limit = RATE_LIMITS[command];
        if (!limit) return next();

        const key = `${chatId}:${command}`;
        const last = rateLimitMap.get(key) ?? 0;
        const now = Date.now();
        if (now - last < limit) {
            const remaining = Math.ceil((limit - (now - last)) / 1000);
            await ctx.reply(
                `⏳ Please wait ${remaining}s before using /${escapeMarkdown(command)} again\\.`,
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }
        rateLimitMap.set(key, now);
        return next();
    });

    // --- Auth gate: /start and /redeem pass through for unauthenticated users ---
    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id ?? ctx.callbackQuery?.from.id;
        if (!chatId) return next();

        // Let /start and /redeem through for unauthenticated users
        const text = ctx.message?.text ?? '';
        if (text.startsWith('/start') || text.startsWith('/redeem')) return next();

        // Check authorization (password-based)
        if (!walletRepo.isAuthorized(chatId)) {
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery('Not authorized');
                return;
            }
            await ctx.reply(
                '🔒 *Not authorized\\.*\n\nVisit jeet\\-tracker\\.opnet\\.org to purchase access, then use `/redeem <code>` to activate\\.',
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }

        // Check paid subscription
        const hasSubscription = await subscriptionRepo.hasActiveSubscription(chatId);
        if (!hasSubscription) {
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery('Subscription expired');
                return;
            }
            await ctx.reply(
                '⏰ *Subscription expired\\.*\n\nVisit jeet\\-tracker\\.opnet\\.org to renew your access, then use `/redeem <code>` to reactivate\\.',
                { parse_mode: 'MarkdownV2' },
            );
            return;
        }

        return next();
    });

    // --- Slash commands ---
    bot.command('start', (ctx) => startCommand(ctx));
    bot.command('help', (ctx) => helpCommand(ctx));
    bot.command('track', (ctx) => trackCommand(ctx));
    bot.command('untrack', (ctx) => untrackCommand(ctx));
    bot.command('wallets', (ctx) => walletsCommand(ctx));
    bot.command('balance', (ctx) => balanceCommand(ctx));
    bot.command('portfolio', (ctx) => portfolioCommand(ctx));
    bot.command('users', (ctx) => usersCommand(ctx));
    bot.command('revoke', (ctx) => revokeCommand(ctx));
    bot.command('tracktoken', (ctx) => trackTokenCommand(ctx));
    bot.command('untracktokens', (ctx) => untracktokensCommand(ctx));
    bot.command('listings', (ctx) => listingsCommand(ctx));
    bot.command('reservations', (ctx) => reservationsCommand(ctx));
    bot.command('tokenalerts', (ctx) => tokenAlertsCommand(ctx));
    bot.command('redeem', (ctx) => redeemCommand(ctx));

    // --- Reply keyboard buttons ---
    bot.hears('📋 My Wallets', (ctx) => walletsCommand(ctx as never));
    bot.hears('❓ Help', (ctx) => helpCommand(ctx as never));
    bot.hears('➕ Track Wallet', async (ctx) => {
        await ctx.reply(
            'Send your wallet address to start tracking:\n`/track <address> [label]`\n\nExample:\n`/track bc1q\\.\\.\\. MyWallet`',
            { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
        );
    });
    bot.hears('💰 Check Balance', async (ctx) => {
        await ctx.reply(
            'Send an address to check its balance:\n`/balance <address>`',
            { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
        );
    });
    bot.hears('🪙 Track Token', async (ctx) => {
        await ctx.reply(
            'Send a token contract address to track:\n`/tracktoken <contractAddress> [label]`\n\nExample:\n`/tracktoken opt1sq\\.\\.\\. MOTO`',
            { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
        );
    });
    bot.hears('📋 My Tokens', (ctx) => untracktokensCommand(ctx as never));

    // --- Inline button: 💰 Balance (bl_<subId>) ---
    bot.callbackQuery(/^bl_/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = ctx.callbackQuery.data.slice(3);
        const sub = await walletRepo.getSubscriptionById(id);

        if (!sub) {
            await ctx.reply('⚠️ Wallet not found\\. It may have already been removed\\.', {
                parse_mode: 'MarkdownV2',
            });
            return;
        }

        const chatId = ctx.chat?.id ?? 0;

        await inlineBalanceHandler(
            sub.address,
            sub.label,
            () => ctx.reply('⏳ Fetching balances…'),
            (msgId, text) =>
                ctx.api.editMessageText(chatId, msgId, text, { parse_mode: 'MarkdownV2' }),
        );
    });

    // --- Inline button: ❌ Untrack (ut_<subId>) ---
    bot.callbackQuery(/^ut_/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = ctx.callbackQuery.data.slice(3);
        const sub = await walletRepo.getSubscriptionById(id);

        if (!sub) {
            await ctx.editMessageText('⚠️ Already removed\\.', { parse_mode: 'MarkdownV2' });
            return;
        }

        await walletRepo.removeSubscription(sub.chatId, sub.address);

        await ctx.editMessageText(
            `✅ Stopped tracking *${escapeMarkdown(sub.label)}*\n\`${escapeMarkdown(sub.address)}\``,
            { parse_mode: 'MarkdownV2' },
        );
    });

    // --- Inline button: ❌ Untrack token (ut_tok_<id>) ---
    bot.callbackQuery(/^ut_tok_/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = ctx.callbackQuery.data.slice(7);
        const sub = tokenRepo.getTokenSubscriptionById(id);

        if (!sub) {
            await ctx.editMessageText('⚠️ Already removed\\.', { parse_mode: 'MarkdownV2' });
            return;
        }

        const chatId = ctx.from.id;
        tokenRepo.removeTokenSubscriptionById(chatId, id);

        await ctx.editMessageText(
            `✅ Stopped tracking *${escapeMarkdown(sub.label)}*\n\`${escapeMarkdown(sub.contractAddress)}\``,
            { parse_mode: 'MarkdownV2' },
        );
    });

    // --- Unknown slash commands ---
    bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) {
            await ctx.reply(
                '❓ Unknown command\\. Use /help to see available commands\\.',
                { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
            );
        }
    });

    bot.catch((err) => {
        console.error('[Bot] Unhandled error:', err.message, err.ctx?.update);
    });

    return bot;
}
