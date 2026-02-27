import type { CommandContext, Context } from 'grammy';
import { mainKeyboard } from '../keyboards.js';
import { subscriptionRepo } from '../../db/SubscriptionRepository.js';
import { walletRepo } from '../../db/WalletRepository.js';

function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function redeemCommand(ctx: CommandContext<Context>): Promise<void> {
    const chatId = ctx.chat.id;
    const code = ctx.match.trim();

    if (!code) {
        await ctx.reply(
            '🔑 *Redeem Access Code*\n\n' +
            'Paste your access code to activate your subscription:\n\n' +
            '`/redeem JT\\-XXXXXXXXXXXX`',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    // Validate code format
    if (!/^JT-[A-Z0-9]{12}$/i.test(code)) {
        await ctx.reply(
            '❌ Invalid code format\\. Expected: `JT\\-XXXXXXXXXXXX`',
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    const result = await subscriptionRepo.redeemCode(code.toUpperCase(), chatId);

    if (!result.success) {
        await ctx.reply(
            `❌ ${escapeMarkdown(result.error)}`,
            { parse_mode: 'MarkdownV2' },
        );
        return;
    }

    // Authorize the chat so commands work
    walletRepo.authorizeChat(chatId);

    const expiryStr = result.expiresAt.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    await ctx.reply(
        '✅ *Subscription Activated\\!*\n\n' +
        `Your access is valid until *${escapeMarkdown(expiryStr)}*\\.\n\n` +
        'Get started:\n' +
        '`/track <address> [label]` — Start tracking a wallet\n' +
        '`/wallets` — List tracked wallets\n' +
        '`/help` — See all commands',
        { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard },
    );
}
