import type { JSONRpcProvider } from 'opnet';

// ─── Event interfaces ────────────────────────────────────────────────────────

export interface BtcReceived {
    readonly type: 'btc_received';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly satoshis: bigint;
    readonly counterparty?: string; // sender address if available from block data
}

export interface BtcSent {
    readonly type: 'btc_sent';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly satoshis: bigint;
    readonly counterparty?: string;    // recipient address from tx outputs
    readonly recipientAmount?: bigint; // value of the output going to counterparty
}

export interface TokenTransfer {
    readonly type: 'token';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly direction: 'in' | 'out';
    readonly contractAddress: string;
    readonly value: bigint;
    readonly counterparty: string; // 0x-prefixed MLDSA hash hex
}

/** Emitted when a NativeSwap liquidity provider's listing is reserved by a buyer. */
export interface LiquidityReserved {
    readonly type: 'liquidity_reserved';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;        // tracked wallet address
    readonly contractAddress: string; // NativeSwap P2OP address
    readonly satoshis: bigint;       // BTC the buyer will send
    readonly tokenAmount: bigint;    // tokens reserved for sale
    readonly role: 'buyer' | 'seller';
}

/** Emitted when a NativeSwap provider's liquidity is consumed (sale complete). */
export interface ProviderConsumed {
    readonly type: 'provider_consumed';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly tokenAmount: bigint;    // tokens sold
}

/** Emitted when a swap completes — buyer's perspective. */
export interface SwapExecuted {
    readonly type: 'swap_executed';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly btcSpent: bigint;       // sats
    readonly tokensReceived: bigint;
}

export type WalletEvent =
    | BtcReceived
    | BtcSent
    | TokenTransfer
    | LiquidityReserved
    | ProviderConsumed
    | SwapExecuted;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function outputAddress(scriptPubKey: { addresses?: string[]; address?: string }): string | null {
    return scriptPubKey.address ?? scriptPubKey.addresses?.[0] ?? null;
}

/**
 * Convert event data to a Buffer regardless of whether it arrived as
 * Uint8Array, a JSON-serialised byte object ({0:x,1:y,…}), or a hex string.
 */
function dataToBuffer(data: unknown): Buffer {
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (typeof data === 'string') {
        const hex = data.startsWith('0x') ? data.slice(2) : data;
        return Buffer.from(hex, 'hex');
    }
    if (data !== null && typeof data === 'object') {
        return Buffer.from(Object.values(data as Record<string, number>));
    }
    return Buffer.alloc(0);
}

/** Read a big-endian uint64 from a buffer at byteOffset. */
function readU64(buf: Buffer, offset: number): bigint {
    if (buf.length < offset + 8) return 0n;
    return buf.readBigUInt64BE(offset);
}

/** Read a big-endian uint128 (16 bytes) from a buffer at byteOffset. */
function readU128(buf: Buffer, offset: number): bigint {
    if (buf.length < offset + 16) return 0n;
    const hi = buf.readBigUInt64BE(offset);
    const lo = buf.readBigUInt64BE(offset + 8);
    return (hi << 64n) | lo;
}

/** Read a big-endian uint256 (32 bytes) from a buffer at byteOffset. */
function readU256(buf: Buffer, offset: number): bigint {
    if (buf.length < offset + 32) return 0n;
    return BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'));
}

/** Read a 32-byte address as lowercase hex (no 0x prefix). */
function readAddr(buf: Buffer, offset: number): string {
    if (buf.length < offset + 32) return '';
    return buf.subarray(offset, offset + 32).toString('hex');
}

/**
 * Read an OPNet-encoded STRING field.
 * Layout: [uint32 length][length bytes of UTF-8 content]
 * Returns the string value and the byte offset immediately after.
 */
function readString(buf: Buffer, offset: number): { value: string; end: number } {
    if (buf.length < offset + 4) return { value: '', end: offset };
    const len = buf.readUInt32BE(offset);
    const end = offset + 4 + len;
    if (buf.length < end) return { value: '', end };
    const value = buf.subarray(offset + 4, end).toString('utf8').replace(/\0/g, '');
    return { value, end };
}

// ─── ParseResult ─────────────────────────────────────────────────────────────

export interface ReceivedUTXO {
    primaryAddress: string;
    txid: string;
    vout: number;
    value: bigint;
}

export interface ParseResult {
    events: WalletEvent[];
    discoveredContracts: Map<string, Set<string>>;
    /** UTXOs received this block — add these to the UTXO store. */
    receivedUTXOs: ReceivedUTXO[];
    /** "txid:vout" keys spent this block — remove these from the UTXO store. */
    spentUTXOKeys: string[];
}

// ─── Main parser ─────────────────────────────────────────────────────────────

/**
 * Parse a block's transactions and return wallet events + newly discovered OP-20 contracts.
 *
 * OPNet encodes token transfers as "Transferred" events (128 bytes):
 *   [operator: 32][from: 32][to: 32][value: 32]
 * The contract address is the KEY of tx.events object (P2OP format).
 *
 * @param trackedAddresses - Bitcoin addresses to watch for BTC/token events.
 * @param mldsaMap         - Maps bitcoin_address → lowercase 64-char mldsa_hash_hex.
 */
export async function parseBlockForAddresses(
    provider: JSONRpcProvider,
    blockHeight: number,
    trackedAddresses: ReadonlySet<string>,
    mldsaMap: ReadonlyMap<string, string>,
    canonicalMap?: ReadonlyMap<string, string>,
    utxoMap?: ReadonlyMap<string, { primaryAddress: string; value: bigint }>,
): Promise<ParseResult> {
    const block = await provider.getBlock(blockHeight, true);
    if (!block) return { events: [], discoveredContracts: new Map(), receivedUTXOs: [], spentUTXOKeys: [] };

    const txs = block.transactions ?? [];
    const events: WalletEvent[] = [];
    const discoveredContracts = new Map<string, Set<string>>();
    const receivedUTXOs: ReceivedUTXO[] = [];
    const spentUTXOKeys: string[] = [];

    for (const tx of txs) {
        const txHash = tx.hash;

        // ── Pre-compute counterparties (no extra RPC — all from block data) ──
        // Sender (for "received from"): first input that exposes an address field.
        // Some OPNet API responses include address info on inputs; gracefully absent if not.
        type RawInput = {
            originalTransactionId?: string;
            outputTransactionIndex?: number | null;
            address?: string;
            scriptPubKey?: { address?: string; addresses?: string[] };
        };
        const rawInputs = (tx as unknown as { inputs?: RawInput[] }).inputs ?? [];
        let txSenderAddr: string | undefined;
        for (const inp of rawInputs) {
            const a = inp.address ?? inp.scriptPubKey?.address ?? inp.scriptPubKey?.addresses?.[0];
            if (a) { txSenderAddr = a; break; }
        }

        // Recipient (for "sent to"): first output NOT going to a tracked address.
        let txRecipientAddr: string | undefined;
        let txRecipientValue: bigint | undefined;
        for (const out of tx.outputs) {
            const a = outputAddress(out.scriptPubKey);
            if (a && !trackedAddresses.has(a)) {
                txRecipientAddr = a;
                txRecipientValue = typeof out.value === 'bigint'
                    ? out.value
                    : BigInt(Math.round(Number(out.value) * 1e8));
                break;
            }
        }

        // ── BTC sent (input scanning) ─────────────────────────────────────────
        // Check if any input spends a UTXO we're tracking.
        // No extra RPC calls needed — we match against the pre-built utxoMap.
        if (utxoMap && utxoMap.size > 0) {
            for (const input of rawInputs) {
                if (!input.originalTransactionId || input.outputTransactionIndex == null) continue;
                const key = `${input.originalTransactionId}:${input.outputTransactionIndex}`;
                const utxo = utxoMap.get(key);
                if (!utxo) continue;
                spentUTXOKeys.push(key);
                events.push({
                    type: 'btc_sent',
                    txHash,
                    blockHeight,
                    address: utxo.primaryAddress,
                    satoshis: utxo.value,
                    ...(txRecipientAddr   !== undefined && { counterparty:     txRecipientAddr   }),
                    ...(txRecipientValue  !== undefined && { recipientAmount:  txRecipientValue  }),
                });
            }
        }

        // ── BTC received ──────────────────────────────────────────────────────
        for (const out of tx.outputs) {
            const addr = outputAddress(out.scriptPubKey);
            if (!addr || !trackedAddresses.has(addr)) continue;

            // Normalise linked addresses (p2wpkh, p2pkh, etc.) back to their
            // primary subscription address so notifications go to the right sub.
            const canonicalAddr = canonicalMap?.get(addr) ?? addr;

            const sats =
                typeof out.value === 'bigint'
                    ? out.value
                    : BigInt(Math.round(Number(out.value) * 1e8));

            events.push({
                type: 'btc_received',
                txHash,
                blockHeight,
                address: canonicalAddr,
                satoshis: sats,
                ...(txSenderAddr !== undefined && { counterparty: txSenderAddr }),
            });

            // Record this UTXO so future input scans can detect when it's spent.
            receivedUTXOs.push({ primaryAddress: canonicalAddr, txid: txHash, vout: out.index as number, value: sats });
        }

        // ── Contract events ───────────────────────────────────────────────────
        const rawEvents = tx.events;
        if (!rawEvents) continue;

        // tx.events is { [contractP2opAddr]: RawEvent[] }
        const eventsObj = rawEvents as Record<string, Array<{ type: string; data: unknown }>>;
        if (Array.isArray(eventsObj)) continue;

        for (const [contractAddress, contractEvents] of Object.entries(eventsObj)) {
            for (const ev of contractEvents) {
                const buf = dataToBuffer(ev.data);

                // ── OP-20 Transferred ─────────────────────────────────────────
                if (ev.type === 'Transferred' && mldsaMap.size > 0) {
                    // Layout (128 bytes): [operator:32][from:32][to:32][value:32]
                    // Legacy (96 bytes):  [from:32][to:32][value:32]
                    const is128 = buf.length >= 128;
                    const is96  = buf.length >= 96;
                    if (!is96) continue;

                    const fromAddr = is128 ? readAddr(buf, 32)  : readAddr(buf, 0);
                    const toAddr   = is128 ? readAddr(buf, 64)  : readAddr(buf, 32);
                    const value    = is128 ? readU256(buf, 96)  : readU256(buf, 64);

                    for (const [btcAddr, mldsaHex] of mldsaMap) {
                        const isFrom = mldsaHex === fromAddr;
                        const isTo   = mldsaHex === toAddr;
                        if (!isFrom && !isTo) continue;

                        if (!discoveredContracts.has(btcAddr)) discoveredContracts.set(btcAddr, new Set());
                        discoveredContracts.get(btcAddr)!.add(contractAddress);

                        events.push({
                            type: 'token',
                            txHash,
                            blockHeight,
                            address: btcAddr,
                            direction: isFrom ? 'out' : 'in',
                            contractAddress,
                            value,
                            counterparty: '0x' + (isFrom ? toAddr : fromAddr),
                        });
                    }
                }

                // ── NativeSwap: LiquidityReserved ─────────────────────────────
                // Layout: [strLen:4][depositAddress:strLen][satoshis:8][providerId:32][tokenAmount:16]
                if (ev.type === 'LiquidityReserved' && buf.length >= 60) {
                    const { value: _depositAddress, end } = readString(buf, 0);
                    const satoshis    = readU64(buf, end);
                    const providerHex = readAddr(buf, end + 8);
                    const tokenAmount = readU128(buf, end + 40);

                    // SELLER: matched by MLDSA hash (the liquidity provider's identity)
                    for (const [btcAddr, mldsaHex] of mldsaMap) {
                        if (mldsaHex !== providerHex) continue;
                        events.push({
                            type: 'liquidity_reserved',
                            txHash,
                            blockHeight,
                            address: btcAddr,
                            contractAddress,
                            satoshis,
                            tokenAmount,
                            role: 'seller',
                        });
                    }

                    // BUYER: tx.from is the buyer's P2TR address (IInteractionTransaction.from).
                    // depositAddress is NativeSwap's internal vault — never a tracked address.
                    const txFrom = (tx as { from?: string | { toString(): string } }).from;
                    if (txFrom) {
                        const fromStr = typeof txFrom === 'string' ? txFrom : txFrom.toString();
                        if (trackedAddresses.has(fromStr)) {
                            const canonicalAddr = canonicalMap?.get(fromStr) ?? fromStr;
                            events.push({
                                type: 'liquidity_reserved',
                                txHash,
                                blockHeight,
                                address: canonicalAddr,
                                contractAddress,
                                satoshis,
                                tokenAmount,
                                role: 'buyer',
                            });
                        }
                    }
                }

                // ── NativeSwap: ProviderConsumed ──────────────────────────────
                // Layout: [providerId:32][amountUsed:16]
                if (ev.type === 'ProviderConsumed' && buf.length >= 48 && mldsaMap.size > 0) {
                    const providerHex = readAddr(buf, 0);
                    const tokenAmount = readU128(buf, 32);

                    for (const [btcAddr, mldsaHex] of mldsaMap) {
                        if (mldsaHex !== providerHex) continue;
                        events.push({
                            type: 'provider_consumed',
                            txHash,
                            blockHeight,
                            address: btcAddr,
                            contractAddress,
                            tokenAmount,
                        });
                    }
                }

                // ── NativeSwap: SwapExecuted ──────────────────────────────────
                // Layout: [buyer:32][amountIn:8][amountOut:32][totalFees:32]
                if (ev.type === 'SwapExecuted' && buf.length >= 72 && mldsaMap.size > 0) {
                    const buyerHex    = readAddr(buf, 0);
                    const btcSpent    = readU64(buf, 32);
                    const tokensReceived = readU256(buf, 40);

                    for (const [btcAddr, mldsaHex] of mldsaMap) {
                        if (mldsaHex !== buyerHex) continue;
                        events.push({
                            type: 'swap_executed',
                            txHash,
                            blockHeight,
                            address: btcAddr,
                            contractAddress,
                            btcSpent,
                            tokensReceived,
                        });
                    }
                }
            }
        }
    }

    return { events, discoveredContracts, receivedUTXOs, spentUTXOKeys };
}
