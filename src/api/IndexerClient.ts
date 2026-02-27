import { config } from '../config.js';

// ─── Response types ──────────────────────────────────────────────────────────

export interface TransferDoc {
    readonly txHash: string;
    readonly blockHeight: number;
    readonly contractAddress: string;
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly timestamp: number;
}

export interface ReservationDoc {
    readonly txHash: string;
    readonly blockHeight: number;
    readonly nativeSwapAddress: string;
    readonly depositAddress: string;
    readonly providerMldsa: string;
    readonly buyerAddress?: string;
    readonly satoshis: string;
    readonly tokenAmount: string;
    readonly status: 'pending' | 'fulfilled' | 'consumed';
    readonly timestamp: number;
}

export interface SwapDoc {
    readonly type: 'provider_consumed' | 'swap_executed';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly nativeSwapAddress: string;
    readonly address: string;
    readonly tokenAmount: string;
    readonly btcSpent?: string;
    readonly timestamp: number;
}

export interface PriceChangeDoc {
    readonly tokenContract: string;
    readonly oldPrice: string;
    readonly newPrice: string;
    readonly deltaPct: number;
    readonly direction: 'up' | 'down';
    readonly virtualBTCReserve: string;
    readonly virtualTokenReserve: string;
    readonly blockHeight: number;
    readonly timestamp: number;
}

export interface PoolEventDoc {
    readonly txHash: string;
    readonly blockHeight: number;
    readonly contractAddress: string;
    readonly action: 'added' | 'removed';
    readonly address: string;
    readonly tokenAmount: string;
    readonly tokenAmount2?: string;
    readonly btcAmount?: string;
    readonly timestamp: number;
}

export interface StakingEventDoc {
    readonly txHash: string;
    readonly blockHeight: number;
    readonly contractAddress: string;
    readonly action: 'staked' | 'unstaked' | 'claimed';
    readonly address: string;
    readonly amount: string;
    readonly timestamp: number;
}

export interface EventsResponse {
    readonly lastIndexedBlock: number;
    readonly since: number;
    readonly transfers: TransferDoc[];
    readonly reservations: ReservationDoc[];
    readonly swaps: SwapDoc[];
    readonly priceChanges: PriceChangeDoc[];
    readonly poolEvents?: PoolEventDoc[];
    readonly stakingEvents?: StakingEventDoc[];
}

export interface BalanceEntry {
    readonly contractAddress: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly balance: string;
}

export interface BalancesResponse {
    readonly address: string;
    readonly mldsaHash: string | null;
    readonly balances: BalanceEntry[];
}

export interface ProviderEntry {
    readonly providerId: string;
    readonly btcReceiver: string;
    readonly liquidity: string;
    readonly reserved: string;
    readonly isPriority: boolean;
}

export interface ListingsResponse {
    readonly tokenContract: string;
    readonly totalListings: number;
    readonly priorityCount: number;
    readonly standardCount: number;
    readonly priority: ProviderEntry[];
    readonly standard: ProviderEntry[];
}

export interface PriceDoc {
    readonly tokenContract: string;
    readonly price: string;
    readonly virtualBTCReserve: string;
    readonly virtualTokenReserve: string;
    readonly liquidity: string;
    readonly reservedLiquidity: string;
    readonly blockHeight: number;
    readonly timestamp: number;
}

export interface PricesResponse {
    readonly current: PriceDoc;
    readonly history: PriceChangeDoc[];
}

export interface ReservationsResponse {
    readonly reservations: ReservationDoc[];
}

export interface TransfersResponse {
    readonly address: string;
    readonly transfers: TransferDoc[];
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
    const url = `${config.indexerUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Indexer ${res.status} ${res.statusText}: GET ${path}`);
    }
    return res.json() as Promise<T>;
}

export async function fetchEvents(since: number, limit?: number): Promise<EventsResponse> {
    const params = new URLSearchParams({ since: String(since) });
    if (limit !== undefined) params.set('limit', String(limit));
    return get<EventsResponse>(`/events?${params.toString()}`);
}

export async function fetchBalances(address: string): Promise<BalancesResponse> {
    return get<BalancesResponse>(`/balances/${encodeURIComponent(address)}`);
}

export async function fetchListings(tokenContract: string): Promise<ListingsResponse> {
    return get<ListingsResponse>(`/listings/${encodeURIComponent(tokenContract)}`);
}

export async function fetchPrices(tokenContract: string): Promise<PricesResponse> {
    return get<PricesResponse>(`/prices/${encodeURIComponent(tokenContract)}`);
}

export async function fetchReservations(
    status?: 'pending' | 'fulfilled' | 'consumed',
    limit?: number,
): Promise<ReservationsResponse> {
    const params = new URLSearchParams();
    if (status !== undefined) params.set('status', status);
    if (limit !== undefined) params.set('limit', String(limit));
    const qs = params.toString();
    return get<ReservationsResponse>(`/reservations${qs ? `?${qs}` : ''}`);
}

export async function fetchTransfers(
    address: string,
    limit?: number,
    skip?: number,
): Promise<TransfersResponse> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (skip !== undefined) params.set('skip', String(skip));
    const qs = params.toString();
    return get<TransfersResponse>(`/transfers/${encodeURIComponent(address)}${qs ? `?${qs}` : ''}`);
}
