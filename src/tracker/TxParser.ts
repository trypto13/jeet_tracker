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

export interface NftTransfer {
    readonly type: 'nft_transfer';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly direction: 'in' | 'out';
    readonly contractAddress: string;
    readonly amount: bigint;
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

/** Emitted when liquidity is added to any pool (NativeSwap or AMM). */
export interface LiquidityAdded {
    readonly type: 'liquidity_added';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;  // pool contract
    readonly tokenAmount: bigint;
    readonly tokenAmount2?: bigint;    // second token (AMM pools)
    readonly btcAmount?: bigint;       // sats (NativeSwap)
}

/** Emitted when liquidity is removed from any pool. */
export interface LiquidityRemoved {
    readonly type: 'liquidity_removed';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly tokenAmount: bigint;
    readonly tokenAmount2?: bigint;
    readonly btcAmount?: bigint;
}

/** Emitted when tokens are staked. */
export interface Staked {
    readonly type: 'staked';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly amount: bigint;
}

/** Emitted when tokens are unstaked. */
export interface Unstaked {
    readonly type: 'unstaked';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly amount: bigint;
}

/** Emitted when staking rewards are claimed. */
export interface RewardsClaimed {
    readonly type: 'rewards_claimed';
    readonly txHash: string;
    readonly blockHeight: number;
    readonly address: string;
    readonly contractAddress: string;
    readonly amount: bigint;
}

export type WalletEvent =
    | BtcReceived
    | BtcSent
    | TokenTransfer
    | NftTransfer
    | LiquidityReserved
    | ProviderConsumed
    | SwapExecuted
    | LiquidityAdded
    | LiquidityRemoved
    | Staked
    | Unstaked
    | RewardsClaimed;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function outputAddress(scriptPubKey: { addresses?: string[]; address?: string }): string | null {
    return scriptPubKey.address ?? scriptPubKey.addresses?.[0] ?? null;
}

function outputSats(value: bigint | number): bigint {
    return typeof value === 'bigint' ? value : BigInt(Math.round(Number(value) * 1e8));
}

// ─── BtcScanResult ───────────────────────────────────────────────────────────

export interface ReceivedUTXO {
    primaryAddress: string;
    txid: string;
    vout: number;
    value: bigint;
}

/** Inferred send: BTC leaving to non-tracked outputs in a tx where the tracked address received change. */
export interface InferredSend {
    txHash: string;
    blockHeight: number;
    address: string;          // canonical tracked address (the change receiver)
    totalSent: bigint;        // sum of non-tracked outputs
    counterparty?: string;    // first non-tracked output address
    recipientAmount?: bigint; // value of first non-tracked output
}

export interface BtcScanResult {
    events: WalletEvent[];
    /** UTXOs received this block — add these to the UTXO store. */
    receivedUTXOs: ReceivedUTXO[];
    /** "txid:vout" keys spent this block — remove these from the UTXO store. */
    spentUTXOKeys: string[];
    /** Potential btc_sent — only promote when corroborated by indexer events for same txHash. */
    inferredSends: InferredSend[];
}

// ─── BTC-only block scanner ──────────────────────────────────────────────────

/**
 * Scan a block for BTC send/receive events only (no contract event parsing).
 * Contract events (transfers, reservations, swaps) come from the indexer.
 */
export async function scanBlockForBTC(
    provider: JSONRpcProvider,
    blockHeight: number,
    trackedAddresses: ReadonlySet<string>,
    canonicalMap?: ReadonlyMap<string, string>,
    utxoMap?: ReadonlyMap<string, { primaryAddress: string; value: bigint }>,
): Promise<BtcScanResult> {
    const block = await provider.getBlock(blockHeight, true);
    if (!block) return { events: [], receivedUTXOs: [], spentUTXOKeys: [], inferredSends: [] };

    const txs = block.transactions ?? [];
    const events: WalletEvent[] = [];
    const receivedUTXOs: ReceivedUTXO[] = [];
    const spentUTXOKeys: string[] = [];
    const inferredSends: InferredSend[] = [];

    for (const tx of txs) {
        const txHash = tx.hash;

        // ── Pre-compute counterparties (no extra RPC — all from block data) ──
        type RawInput = {
            originalTransactionId?: string;
            outputTransactionIndex?: number | null;
        };
        const rawInputs = (tx as unknown as { inputs?: RawInput[] }).inputs ?? [];

        // ── BTC sent via UTXO map (works when linked addresses resolve) ─────
        if (utxoMap && utxoMap.size > 0) {
            for (const input of rawInputs) {
                if (!input.originalTransactionId || input.outputTransactionIndex == null) continue;
                const key = `${input.originalTransactionId}:${input.outputTransactionIndex}`;
                const utxo = utxoMap.get(key);
                if (!utxo) continue;
                spentUTXOKeys.push(key);

                // Find first non-tracked output as counterparty
                let counterparty: string | undefined;
                let recipientAmount: bigint | undefined;
                for (const out of tx.outputs) {
                    const a = outputAddress(out.scriptPubKey);
                    if (a && !trackedAddresses.has(a)) {
                        counterparty = a;
                        recipientAmount = outputSats(out.value);
                        break;
                    }
                }

                events.push({
                    type: 'btc_sent',
                    txHash,
                    blockHeight,
                    address: utxo.primaryAddress,
                    satoshis: utxo.value,
                    ...(counterparty     !== undefined && { counterparty }),
                    ...(recipientAmount  !== undefined && { recipientAmount }),
                });
            }
        }

        // ── BTC received ────────────────────────────────────────────────────
        let receivedAddr: string | undefined;
        for (const out of tx.outputs) {
            const addr = outputAddress(out.scriptPubKey);
            if (!addr || !trackedAddresses.has(addr)) continue;

            const canonicalAddr = canonicalMap?.get(addr) ?? addr;
            receivedAddr = canonicalAddr;
            const sats = outputSats(out.value);

            events.push({
                type: 'btc_received',
                txHash,
                blockHeight,
                address: canonicalAddr,
                satoshis: sats,
            });

            receivedUTXOs.push({ primaryAddress: canonicalAddr, txid: txHash, vout: out.index, value: sats });
        }

        // ── Inferred send (fallback when inputs have no address data) ───────
        // If the tracked address received BTC in this tx (likely change),
        // compute the total BTC going to non-tracked outputs.
        // BlockPoller promotes this to btc_sent only when the same txHash
        // has indexer events (token transfer, swap, reservation).
        if (receivedAddr) {
            let totalNonTracked = 0n;
            let firstCounterparty: string | undefined;
            let firstCounterpartyAmount: bigint | undefined;

            for (const out of tx.outputs) {
                const a = outputAddress(out.scriptPubKey);
                if (a && !trackedAddresses.has(a)) {
                    const v = outputSats(out.value);
                    totalNonTracked += v;
                    if (!firstCounterparty) {
                        firstCounterparty = a;
                        firstCounterpartyAmount = v;
                    }
                }
            }

            if (totalNonTracked > 0n) {
                inferredSends.push({
                    txHash,
                    blockHeight,
                    address: receivedAddr,
                    totalSent: totalNonTracked,
                    ...(firstCounterparty       !== undefined && { counterparty: firstCounterparty }),
                    ...(firstCounterpartyAmount !== undefined && { recipientAmount: firstCounterpartyAmount }),
                });
            }
        }
    }

    return { events, receivedUTXOs, spentUTXOKeys, inferredSends };
}
