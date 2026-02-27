import type { CommandContext, Context } from 'grammy';
import { walletRepo } from '../../db/WalletRepository.js';
import { config } from '../../config.js';


async function requireAdmin(ctx: CommandContext<Context>): Promise<boolean> {
    if (config.adminChatId === null || ctx.chat.id !== config.adminChatId) {
        await ctx.reply('❌ Admin only\\.', { parse_mode: 'MarkdownV2' });
        return false;
    }
    return true;
}

export async function usersCommand(ctx: CommandContext<Context>): Promise<void> {
    if (!await requireAdmin(ctx)) return;

    const authorized = walletRepo.listAuthorizedChats();

    if (authorized.length === 0) {
        await ctx.reply('_No authorized users\\._', { parse_mode: 'MarkdownV2' });
        return;
    }

    const lines = ['👥 *Authorized Users*', ''];
    for (const chatId of authorized) {
        const subs = await walletRepo.listSubscriptions(chatId);
        const adminFlag = chatId === config.adminChatId ? ' \\(admin\\)' : '';
        lines.push(`• \`${chatId}\`${adminFlag} — ${subs.length} wallet\\(s\\)`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
}

export async function revokeCommand(ctx: CommandContext<Context>): Promise<void> {
    if (!await requireAdmin(ctx)) return;

    const input = ctx.match.trim();
    const targetId = parseInt(input, 10);

    if (!input || isNaN(targetId)) {
        await ctx.reply('Usage: `/revoke <chatId>`', { parse_mode: 'MarkdownV2' });
        return;
    }

    if (targetId === config.adminChatId) {
        await ctx.reply('❌ Cannot revoke admin access\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    walletRepo.revokeChat(targetId);
    await ctx.reply(`✅ Revoked access for \`${targetId}\`\\.`, { parse_mode: 'MarkdownV2' });
}
