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

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Build and configure the Grammy Telegram bot.
 */
export function createBot(): Bot<Context> {
    const bot = new Bot<Context>(config.telegramToken);

    // --- Auth gate: only /start passes through for unauthenticated users ---
    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id ?? ctx.callbackQuery?.from.id;
        if (!chatId) return next();

        if (walletRepo.isAuthorized(chatId)) return next();

        // Let /start through so unauthenticated users can submit the password.
        if (ctx.message?.text?.startsWith('/start')) return next();

        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery('Not authorized');
            return;
        }

        await ctx.reply(
            '🔒 *Not authorized\\.* Use `/start <password>` to authenticate\\.',
            { parse_mode: 'MarkdownV2' },
        );
    });

    // --- Slash commands ---
    bot.command('start', (ctx) => startCommand(ctx));
    bot.command('help', (ctx) => helpCommand(ctx));
    bot.command('track', (ctx) => trackCommand(ctx));
    bot.command('untrack', (ctx) => untrackCommand(ctx));
    bot.command('wallets', (ctx) => walletsCommand(ctx));
    bot.command('balance', (ctx) => balanceCommand(ctx));

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
