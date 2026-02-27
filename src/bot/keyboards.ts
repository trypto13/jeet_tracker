import { InlineKeyboard, Keyboard } from 'grammy';
import type { Subscription } from '../db/WalletRepository.js';

/**
 * Persistent reply keyboard shown at the bottom of every chat.
 * Buttons send plain text which Bot.ts maps to command handlers.
 */
export const mainKeyboard = new Keyboard()
    .text('📋 My Wallets').text('💰 Check Balance')
    .row()
    .text('➕ Track Wallet').text('🪙 Track Token')
    .row()
    .text('📋 My Tokens').text('❓ Help')
    .resized()
    .persistent();

/**
 * Inline keyboard attached to each wallet entry in /wallets.
 * Callback data prefixes:
 *   bl_<id>  — check balance
 *   ut_<id>  — untrack wallet
 */
export function walletInlineKeyboard(sub: Subscription): InlineKeyboard {
    return new InlineKeyboard()
        .text('💰 Balance', `bl_${sub.id}`)
        .text('❌ Untrack', `ut_${sub.id}`);
}
