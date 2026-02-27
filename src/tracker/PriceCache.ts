const PRICE_TTL_MS = 60_000;
let cachedPrice: number | null = null;
let cacheTime = 0;

/**
 * Fetch BTC/USD price from CoinGecko with a 60-second in-memory cache.
 * Returns null if the price cannot be fetched.
 */
export async function getBtcPriceUsd(): Promise<number | null> {
    if (cachedPrice !== null && Date.now() - cacheTime < PRICE_TTL_MS) return cachedPrice;
    try {
        const resp = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        );
        const data = await resp.json() as { bitcoin?: { usd?: number } };
        const price = data.bitcoin?.usd;
        if (typeof price === 'number') {
            cachedPrice = price;
            cacheTime = Date.now();
        }
    } catch {
        // Keep old cached value or null — fail silently
    }
    return cachedPrice;
}
