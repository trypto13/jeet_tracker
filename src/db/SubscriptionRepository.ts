import { type Collection, type Db } from 'mongodb';

export interface AccessCodeDoc {
    code: string;
    walletAddress: string;
    txHash: string;
    paymentMethod: 'MOTO' | 'BTC';
    amount: string;
    used: boolean;
    redeemedBy?: number;
    createdAt: Date;
    codeExpiresAt: Date;
    subscriptionDays: number;
}

export interface PaidSubscriptionDoc {
    chatId: number;
    walletAddress: string;
    txHash: string;
    expiresAt: Date;
    createdAt: Date;
}

/**
 * Repository for paid subscription management and access code redemption.
 * Uses the same MongoDB connection as the main Database but manages its own collections.
 */
class SubscriptionRepository {
    private static instance: SubscriptionRepository | undefined;
    private accessCodesCol: Collection<AccessCodeDoc> | undefined;
    private paidSubsCol: Collection<PaidSubscriptionDoc> | undefined;

    private constructor() {}

    public static getInstance(): SubscriptionRepository {
        if (!SubscriptionRepository.instance) {
            SubscriptionRepository.instance = new SubscriptionRepository();
        }
        return SubscriptionRepository.instance;
    }

    public async init(db: Db): Promise<void> {
        this.accessCodesCol = db.collection<AccessCodeDoc>('access_codes');
        this.paidSubsCol = db.collection<PaidSubscriptionDoc>('subscriptions_paid');

        await Promise.all([
            this.accessCodesCol.createIndex({ code: 1 }, { unique: true }),
            this.accessCodesCol.createIndex({ txHash: 1 }, { unique: true }),
            this.paidSubsCol.createIndex({ chatId: 1 }, { unique: true }),
        ]);
    }

    /**
     * Attempt to redeem an access code for a Telegram chat.
     * Returns the subscription expiry date on success, or an error message.
     */
    public async redeemCode(
        code: string,
        chatId: number,
    ): Promise<{ success: true; expiresAt: Date; walletAddress: string } | { success: false; error: string }> {
        if (!this.accessCodesCol || !this.paidSubsCol) {
            return { success: false, error: 'Subscription system not initialized' };
        }

        const doc = await this.accessCodesCol.findOne({ code });

        if (!doc) {
            return { success: false, error: 'Invalid access code' };
        }

        if (doc.used) {
            return { success: false, error: 'This code has already been redeemed' };
        }

        if (new Date() > doc.codeExpiresAt) {
            return { success: false, error: 'This code has expired. Please purchase a new one.' };
        }

        // Mark code as used
        await this.accessCodesCol.updateOne(
            { code },
            { $set: { used: true, redeemedBy: chatId } },
        );

        // Create or extend subscription
        const now = new Date();
        const expiresAt = new Date(now.getTime() + doc.subscriptionDays * 24 * 60 * 60 * 1000);

        await this.paidSubsCol.updateOne(
            { chatId },
            {
                $set: {
                    chatId,
                    walletAddress: doc.walletAddress,
                    txHash: doc.txHash,
                    expiresAt,
                    createdAt: now,
                },
            },
            { upsert: true },
        );

        return { success: true, expiresAt, walletAddress: doc.walletAddress };
    }

    /**
     * Check if a chat has an active paid subscription.
     */
    public async hasActiveSubscription(chatId: number): Promise<boolean> {
        if (!this.paidSubsCol) return false;

        const doc = await this.paidSubsCol.findOne({ chatId });
        if (!doc) return false;

        return new Date() < doc.expiresAt;
    }

    /**
     * Get subscription details for a chat.
     */
    public async getSubscription(chatId: number): Promise<PaidSubscriptionDoc | null> {
        if (!this.paidSubsCol) return null;
        return this.paidSubsCol.findOne({ chatId });
    }
}

export const subscriptionRepo = SubscriptionRepository.getInstance();
