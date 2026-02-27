import type { CommandContext, Context } from 'grammy';
import { mainKeyboard } from '../keyboards.js';
import { walletRepo } from '../../db/WalletRepository.js';
import { subscriptionRepo } from '../../db/SubscriptionRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

const WELCOME =
    '👁 *OPNet Wallet Tracker*\n\n' +
    'Track Bitcoin \\& OPNet wallet activity in real\\-time\\.\n' +
    'Get notified of BTC transfers and OP\\-20 token events\\.\n\n' +
    '`/track <address> [label]` — Start tracking a wallet\n' +
    '`/untrack <address>` — Stop tracking\n' +
    '`/wallets` — List tracked wallets\n' +
    '`/balance <address>` — Check balance';

export async function startCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;

    // Check if user has an active subscription
    const hasSubscription = await subscriptionRepo.hasActiveSubscription(chatId);

    if (hasSubscription) {
        // Authorized + subscribed — show welcome + subscription info
        const sub = await subscriptionRepo.getSubscription(chatId);
        const expiryStr = sub
            ? sub.expiresAt.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
              })
            : 'Unknown';

        await ctx.reply(
            WELCOME + `\n\n📋 Subscription active until *${escapeMarkdown(expiryStr)}*`,
            { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
        );
        return;
    }

    // Check if user is authorized (legacy password auth) but no subscription
    if (walletRepo.isAuthorized(chatId)) {
        await ctx.reply(
            '👁 *OPNet Wallet Tracker*\n\n' +
            'Your subscription has expired or is not active\\.\n\n' +
            'Visit jeet\\-tracker\\.opnet\\.org to purchase access,\n' +
            'then use `/redeem <code>` to activate\\.',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    // Not authorized at all — show purchase instructions
    const code = ctx.match.trim();

    // If they provided an access code directly after /start, try to redeem it
    if (code && /^JT-[A-Z0-9]{12}$/i.test(code)) {
        const result = await subscriptionRepo.redeemCode(code.toUpperCase(), chatId);
        if (result.success) {
            walletRepo.authorizeChat(chatId);
            const expiryStr = result.expiresAt.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            await ctx.reply(
                '✅ *Subscription Activated\\!*\n\n' +
                WELCOME + `\n\n📋 Active until *${escapeMarkdown(expiryStr)}*`,
                { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
            );
            return;
        }
    }

    await ctx.reply(
        '👁 *Jeet Tracker*\n\n' +
        'OPNet wallet intelligence delivered via Telegram\\.\n\n' +
        '*Get started:*\n' +
        '1\\. Visit jeet\\-tracker\\.opnet\\.org\n' +
        '2\\. Pay $20/month with MOTO or BTC\n' +
        '3\\. Redeem your code: `/redeem <code>`',
        { parse_mode: 'MarkdownV2' },
    );
}
