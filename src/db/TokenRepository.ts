import { database, type TokenSubscription } from './Database.js';

export type { TokenSubscription };

class TokenRepository {
    private static instance: TokenRepository | undefined;

    private constructor() {}

    public static getInstance(): TokenRepository {
        if (!TokenRepository.instance) {
            TokenRepository.instance = new TokenRepository();
        }
        return TokenRepository.instance;
    }

    public addTokenSubscription(
        chatId: number,
        contractAddress: string,
        label: string,
        tokenType: 'op20' | 'op721',
        maxPerUser: number,
    ): 'added' | 'duplicate' | 'limit_exceeded' {
        const store = database.getStore();
        const userSubs = store.tokenSubscriptions.filter((s) => s.chatId === chatId);

        if (userSubs.length >= maxPerUser) return 'limit_exceeded';
        if (userSubs.some((s) => s.contractAddress === contractAddress)) return 'duplicate';

        const sub: TokenSubscription = {
            id: crypto.randomUUID().slice(0, 8),
            chatId,
            contractAddress,
            label,
            tokenType,
            priceThresholdPct: 5,       // default: alert on ±5% price move
            minReservationSats: 0,       // default: alert on all reservations
        };

        store.tokenSubscriptions.push(sub);
        void database.insertTokenSubscription(sub);
        return 'added';
    }

    public removeTokenSubscription(chatId: number, contractAddress: string): boolean {
        const store = database.getStore();
        const before = store.tokenSubscriptions.length;
        store.tokenSubscriptions = store.tokenSubscriptions.filter(
            (s) => !(s.chatId === chatId && s.contractAddress === contractAddress),
        );
        const removed = store.tokenSubscriptions.length < before;
        if (removed) void database.deleteTokenSubscription(chatId, contractAddress);
        return removed;
    }

    public removeTokenSubscriptionById(chatId: number, id: string): boolean {
        const store = database.getStore();
        const before = store.tokenSubscriptions.length;
        store.tokenSubscriptions = store.tokenSubscriptions.filter(
            (s) => !(s.chatId === chatId && s.id === id),
        );
        const removed = store.tokenSubscriptions.length < before;
        if (removed) void database.deleteTokenSubscriptionById(chatId, id);
        return removed;
    }

    public listTokenSubscriptions(chatId: number): TokenSubscription[] {
        return database.getStore().tokenSubscriptions.filter((s) => s.chatId === chatId);
    }

    public getTokenSubscriptionById(id: string): TokenSubscription | null {
        return database.getStore().tokenSubscriptions.find((s) => s.id === id) ?? null;
    }

    /** All unique contract addresses tracked across all chats (for polling). */
    public getAllTrackedTokenContracts(): string[] {
        const seen = new Set<string>();
        for (const s of database.getStore().tokenSubscriptions) {
            seen.add(s.contractAddress);
        }
        return [...seen];
    }

    /** All unique OP-20 contract addresses (need NativeSwap polling). */
    public getAllOP20Contracts(): string[] {
        const seen = new Set<string>();
        for (const s of database.getStore().tokenSubscriptions) {
            if (s.tokenType === 'op20') seen.add(s.contractAddress);
        }
        return [...seen];
    }

    /** Chat subscriptions for a given contract address, with their thresholds. */
    public getSubscribersForToken(contractAddress: string): {
        chatId: number;
        label: string;
        priceThresholdPct: number;
        minReservationSats: number;
    }[] {
        return database
            .getStore()
            .tokenSubscriptions.filter((s) => s.contractAddress === contractAddress)
            .map((s) => ({
                chatId: s.chatId,
                label: s.label,
                priceThresholdPct: s.priceThresholdPct,
                minReservationSats: s.minReservationSats,
            }));
    }

    public updateThresholds(
        chatId: number,
        contractAddress: string,
        priceThresholdPct: number,
        minReservationSats: number,
    ): boolean {
        const store = database.getStore();
        const sub = store.tokenSubscriptions.find(
            (s) => s.chatId === chatId && s.contractAddress === contractAddress,
        );
        if (!sub) return false;
        sub.priceThresholdPct = priceThresholdPct;
        sub.minReservationSats = minReservationSats;
        void database.updateTokenThresholds(chatId, contractAddress, priceThresholdPct, minReservationSats);
        return true;
    }
}

export const tokenRepo = TokenRepository.getInstance();
