# OPNet Development Bible — CLAUDE.md

> **This file is the single source of truth for all OPNet dApp development.**
> Every rule here is NON-NEGOTIABLE. Violating any rule produces broken, insecure, or undeployable code.

---

## TABLE OF CONTENTS

1. [What is OPNet](#1-what-is-opnet)
2. [Absolute Rules — Never Violate](#2-absolute-rules--never-violate)
3. [TypeScript Law](#3-typescript-law)
4. [Package Versions & Setup](#4-package-versions--setup)
5. [Smart Contract Development (AssemblyScript)](#5-smart-contract-development-assemblyscript)
6. [Frontend Development (React + Vite)](#6-frontend-development-react--vite)
7. [Backend Development (Node.js)](#7-backend-development-nodejs)
8. [Transaction Rules](#8-transaction-rules)
9. [Wallet Integration (OP_WALLET)](#9-wallet-integration-op_wallet)
10. [Address Systems & Public Keys](#10-address-systems--public-keys)
11. [Network Configuration](#11-network-configuration)
12. [Contract Addresses](#12-contract-addresses)
13. [Security Audit Checklist](#13-security-audit-checklist)
14. [Gas Optimization (Contracts)](#14-gas-optimization-contracts)
15. [Performance Rules (Frontend/Backend)](#15-performance-rules-frontendbackend)
16. [CSV Anti-Pinning (DEX/Swaps)](#16-csv-anti-pinning-dexswaps)
17. [NativeSwap DEX Patterns](#17-nativeswap-dex-patterns)
18. [Common Mistakes — Never Repeat](#18-common-mistakes--never-repeat)
19. [Code Verification Order](#19-code-verification-order)
20. [Client Libraries Reference](#20-client-libraries-reference)

---

## 1. What is OPNet

OPNet is a **Bitcoin L1 consensus layer** enabling smart contracts directly on Bitcoin.

- **NOT a metaprotocol** — it's a full consensus layer with cryptographic proofs
- **Fully trustless, permissionless, decentralized** — relies on Bitcoin PoW + OPNet epoch SHA1 mining
- **Contracts are WebAssembly** (AssemblyScript) — deterministic execution via `@btc-vision/assemblyscript`
- **NON-CUSTODIAL** — contracts NEVER hold BTC. Verify-don't-custody pattern.
- **No gas token** — uses Bitcoin directly
- **Partial reverts** — only consensus layer execution reverts; Bitcoin transfers are ALWAYS valid
- **Quantum resistance** — ML-DSA (FIPS 204) signature support via P2MR addresses (BIP-360)
- **Buffer is GONE** — the entire stack uses `Uint8Array`, not Node.js `Buffer`
- **ECDSA is DEPRECATED** — use ML-DSA (`Blockchain.verifySignature` with auto-detection)

### Why OPNet Requires Consensus (Not Just Indexing)

| Protocol | State Consistency | Can Different Nodes Disagree? |
|----------|-------------------|-------------------------------|
| Runes | Indexer-dependent | Yes |
| BRC-20 | Indexer-dependent | Yes |
| Alkanes | Indexer-dependent | Yes |
| **OPNet** | **Cryptographic consensus** | **No** |

After 20 blocks, an epoch is buried deep enough that changing it requires rewriting Bitcoin history at millions of dollars per hour.

---

## 2. Absolute Rules — Never Violate

### NO RAW JAVASCRIPT

**NEVER write raw JavaScript. ALWAYS use TypeScript.** No exceptions. Not even for "quick examples."

### NO RAW PSBT

**NEVER construct raw PSBTs.** No `new Psbt()`, no `Psbt.fromBase64()`, no manual PSBT construction. FORBIDDEN.

### CONTRACT CALLS USE `opnet` PACKAGE ONLY

- **For contract calls:** ALWAYS use `opnet` npm package → `getContract()` → simulate → `sendTransaction()`
- **NEVER use `@btc-vision/transaction` for contract calls** — it is ONLY for `TransactionFactory` (deployments, BTC transfers)

### ALWAYS SIMULATE BEFORE SENDING

Bitcoin transfers are **irreversible**. If the contract reverts, your BTC is gone. ALWAYS simulate first.

### SIGNER RULES (CONTEXT-DEPENDENT)

| Context | `signer` | `mldsaSigner` | Why |
|---------|----------|---------------|-----|
| **Frontend** | `null` | `null` | OP_WALLET handles ALL signing. NEVER put private keys in frontend code. |
| **Backend** | `wallet.keypair` | `wallet.mldsaKeypair` | Backend signs directly. Both REQUIRED. |

Mixing these up = critical security vulnerability (leaking keys) or broken transaction (missing signer).

### NO `any` TYPE — EVER

Use specific types, interfaces, or generics. `unknown` is only allowed at system boundaries (JSON parsing, external APIs).

### NO `bitcoinjs-lib`

Use `@btc-vision/bitcoin` — never `bitcoinjs-lib`. OPNet's fork has critical patches and 709x faster PSBT.

### NO `Buffer`

`Buffer` is completely removed from the OPNet stack. Use `Uint8Array` everywhere. For hex conversions:

```typescript
import { BufferHelper } from '@btc-vision/transaction';
const bytes: Uint8Array = BufferHelper.fromHex('deadbeef');
const hex: string = BufferHelper.toHex(bytes);
```

### NO Express / Fastify / Koa

Backend MUST use `@btc-vision/hyper-express` and `@btc-vision/uwebsocket.js`. Other frameworks are FORBIDDEN.

### ECDSA IS DEPRECATED

Use `Blockchain.verifySignature(address, signature, hash)` — it is consensus-aware and auto-selects the right algorithm. NEVER use `verifyECDSASignature` or `verifySchnorrSignature` directly.

### SHA256 NOT KECCAK256

OPNet uses **SHA256** for hashing and method selectors. This is Bitcoin, not Ethereum.

### NO `approve()` ON OP-20

OP-20 does NOT have `approve()`. Use `increaseAllowance(spender, amount)` and `decreaseAllowance(spender, amount)`.

---

## 3. TypeScript Law

### FORBIDDEN Constructs

| Construct | Why Forbidden | Use Instead |
|-----------|---------------|-------------|
| `any` | Runtime bug factory | Specific types, generics |
| `object` (lowercase) | Too broad | Specific interfaces or `Record<string, T>` |
| `Function` (uppercase) | Untyped | Specific signatures: `(param: Type) => ReturnType` |
| `{}` | Means "any non-nullish" | `Record<string, never>` |
| Non-null assertion `!` | Unsafe | Explicit null checks or optional chaining |
| Dead/duplicate code | Broken design | Delete it |
| ESLint bypasses | Never | Fix the code |
| Section separator comments | Noise | Use proper TSDoc |
| Inline CSS | Unmaintainable | CSS modules, styled-components, or external stylesheets |

### FORBIDDEN: Section Separator Comments

```typescript
// NEVER write these:
// ==================== PRIVATE METHODS ====================
// ---------------------- HELPERS ----------------------
// ************* CONSTANTS *************
```

Use proper TSDoc instead:

```typescript
/**
 * Transfers tokens from sender to recipient.
 * @param to - The recipient address
 * @param amount - The amount to transfer in base units
 * @returns True if transfer succeeded
 */
public async transfer(to: Address, amount: bigint): Promise<boolean> { ... }
```

### Numeric Types

| Type | Use For |
|------|---------|
| `number` | Array lengths, loop counters, small flags, ports, pixels |
| `bigint` | Satoshi amounts, block heights, timestamps, database IDs, file sizes |
| **Floats for financial values** | **FORBIDDEN** — use fixed-point `bigint` with explicit scale |

### Required tsconfig.json Settings

```json
{
    "compilerOptions": {
        "strict": true,
        "noImplicitAny": true,
        "strictNullChecks": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "exactOptionalPropertyTypes": true,
        "noImplicitReturns": true,
        "noFallthroughCasesInSwitch": true,
        "noUncheckedIndexedAccess": true,
        "noImplicitOverride": true,
        "moduleResolution": "bundler",
        "module": "ESNext",
        "target": "ESNext",
        "lib": ["ESNext"],
        "isolatedModules": true,
        "verbatimModuleSyntax": true
    }
}
```

### ESLint Key Rules (All Configs)

- `@typescript-eslint/no-explicit-any`: **error**
- `@typescript-eslint/explicit-function-return-type`: **error**
- `@typescript-eslint/no-unused-vars`: **error**

Use ESLint 10 flat config format (`eslint.config.js`):
- Contracts (AssemblyScript): `eslint-contract.js`
- Backend / Unit Tests / Plugins: `eslint-generic.js`
- Frontend (React): `eslint-react.js`

---

## 4. Package Versions & Setup

### Version Requirements

| Tool | Minimum Version |
|------|-----------------|
| Node.js | >= 24.0.0 |
| TypeScript | >= 5.9.3 |
| ESLint | ^10.0.0 |
| @eslint/js | ^10.0.1 |
| typescript-eslint | ^8.56.0 |
| AssemblyScript | `@btc-vision/assemblyscript@^0.29.2` (custom fork) |

### MANDATORY Install Commands

**ALWAYS clean install first. `rm -rf node_modules package-lock.json` is NON-NEGOTIABLE.**

#### Backend / Frontend / Plugins

```bash
rm -rf node_modules package-lock.json
npx npm-check-updates -u && npm i @btc-vision/bitcoin@rc @btc-vision/bip32@latest @btc-vision/ecpair@latest @btc-vision/transaction@rc opnet@rc --prefer-online
npm i -D eslint@^10.0.0 @eslint/js@^10.0.1 typescript-eslint@^8.56.0
```

#### Contract Projects (AssemblyScript)

```bash
rm -rf node_modules package-lock.json
npm uninstall assemblyscript 2>/dev/null
npx npm-check-updates -u && npm i @btc-vision/btc-runtime@rc @btc-vision/as-bignum@latest @btc-vision/assemblyscript @btc-vision/opnet-transform@latest @assemblyscript/loader@latest --prefer-online
npm i -D eslint@^10.0.0 @eslint/js@^10.0.1 typescript-eslint@^8.56.0
```

#### Unit Test Projects

```bash
rm -rf node_modules package-lock.json
npm uninstall assemblyscript 2>/dev/null
npx npm-check-updates -u && npm i @btc-vision/bitcoin@rc @btc-vision/bip32@latest @btc-vision/ecpair@latest @btc-vision/transaction@rc opnet@rc @btc-vision/op-vm@rc @btc-vision/unit-test-framework@beta --prefer-online
npm i -D eslint@^10.0.0 @eslint/js@^10.0.1 typescript-eslint@^8.56.0
```

### Package Reference

| Package | Version | Used In |
|---------|---------|---------|
| `@btc-vision/bitcoin` | `@rc` | Frontend, Backend, Plugins, Tests |
| `@btc-vision/transaction` | `@rc` | Frontend, Backend, Plugins, Tests |
| `opnet` | `@rc` | Frontend, Backend, Plugins, Tests |
| `@btc-vision/bip32` | latest | Frontend, Backend |
| `@btc-vision/ecpair` | latest | Frontend, Backend |
| `@btc-vision/btc-runtime` | `@rc` | Contracts |
| `@btc-vision/opnet-transform` | `1.1.0` | Contracts |
| `@btc-vision/assemblyscript` | `^0.29.2` | Contracts |
| `@btc-vision/as-bignum` | `0.1.2` | Contracts |
| `@btc-vision/hyper-express` | latest | Backend |
| `@btc-vision/uwebsocket.js` | latest | Backend |
| `@btc-vision/walletconnect` | latest | Frontend |
| `@btc-vision/opwallet` | latest | Frontend |

---

## 5. Smart Contract Development (AssemblyScript)

### Key Principles

1. **Custom AssemblyScript fork** — `@btc-vision/assemblyscript` adds closure support. ALWAYS `npm uninstall assemblyscript` first.
2. **Constructor runs on EVERY interaction** — use `onDeployment()` for initialization
3. **Contracts CANNOT hold BTC** — they are calculators, not custodians
4. **Verify-don't-custody pattern** — check `Blockchain.tx.outputs` against internal state
5. **Upgradeable contracts** — extend `Upgradeable` base class with `onUpdate()` lifecycle hook

### Contract Entry Point (index.ts)

Every contract needs THREE required elements:

```typescript
import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { MyContract } from './MyContract';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

// 1. Factory function — MUST return a NEW instance
Blockchain.contract = (): MyContract => {
    return new MyContract();
};

// 2. Runtime exports
export * from '@btc-vision/btc-runtime/runtime/exports';

// 3. Abort handler
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
```

### OP20 Token Pattern

```typescript
import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address, Blockchain, BytesWriter, Calldata, encodeSelector,
    OP20, OP20InitParameters, Revert, Selector, StoredU256,
    AddressMemoryMap, SafeMath
} from '@btc-vision/btc-runtime/runtime';

export class MyToken extends OP20 {
    public constructor() {
        const params: OP20InitParameters = {
            name: 'My Token',
            symbol: 'MTK',
            decimals: 18,
            maxSupply: u256.fromString('100000000000000000000000000'),
        };
        super(params);
    }
}
```

### Method Decorators

`@method`, `@returns`, `@emit`, `@final`, and `ABIDataTypes` are **compile-time globals** from `@btc-vision/opnet-transform`. Do NOT import them.

```typescript
@method({ name: 'to', type: ABIDataTypes.ADDRESS }, { name: 'amount', type: ABIDataTypes.UINT256 })
@returns({ name: 'result', type: ABIDataTypes.BOOL })
public transfer(calldata: Calldata): BytesWriter {
    // ...
}
```

### CRITICAL: @method() MUST Declare All Params

| Pattern | Result |
|---------|--------|
| `@method()` (no args) | Zero ABI inputs — **FORBIDDEN**. Breaks SDK integration. Requires redeployment to fix. |
| `@method({ name, type })` | Correct — ABI declared, SDK works |
| `@method(param1, param2, ...)` | Correct — all inputs declared |

### Selectors

```typescript
export class MyContract extends OP_NET {
    private readonly myMethodSelector: Selector = encodeSelector('myMethod(address,uint256)');

    public callMethod(calldata: Calldata): BytesWriter {
        const selector = calldata.readSelector();
        switch (selector) {
            case this.myMethodSelector:
                return this.myMethod(calldata);
            default:
                return super.callMethod(calldata);
        }
    }
}
```

### onDeployment vs Constructor

```typescript
export class MyContract extends OP_NET {
    public constructor() {
        super();
        // Runs EVERY time — set up selectors here
    }

    public override onDeployment(_calldata: Calldata): void {
        // Runs ONCE on deployment — initialize storage here
        this.deploymentBlock.set(Blockchain.block.number);
    }
}
```

### Storage and Pointers

Use `Blockchain.nextPointer` for automatic unique allocation:

```typescript
export class MyContract extends OP_NET {
    private readonly myValuePointer: u16 = Blockchain.nextPointer;
    private readonly myMapPointer: u16 = Blockchain.nextPointer;

    private readonly myValue: StoredU256 = new StoredU256(this.myValuePointer, u256.Zero);
    private readonly myMap: AddressMemoryMap<Address, StoredU256> = new AddressMemoryMap(
        this.myMapPointer, Address.dead()
    );
}
```

| Type | Use Case |
|------|----------|
| `StoredU256` | Single u256 value |
| `StoredBoolean` | Boolean flag |
| `StoredString` | String value |
| `StoredU64` | Single u64 value |
| `AddressMemoryMap` | Address → value mapping |
| `StoredMapU256` | u256 → u256 mapping |

**CRITICAL:** NEVER use bare `Map<Address, T>`. AssemblyScript's `Map` uses reference equality — two `Address` instances with identical bytes are different references. Use `AddressMemoryMap`, `StoredMapU256`, or key by `.toHexString()`.

### u256 and SafeMath

**SafeMath is MANDATORY for ALL u256 operations.**

```typescript
import { u256 } from '@btc-vision/as-bignum/assembly';
import { SafeMath } from '@btc-vision/btc-runtime/runtime';

// FORBIDDEN — raw operations
const result = a + b;  // Can overflow

// CORRECT — SafeMath
const result = SafeMath.add(a, b);   // Reverts on overflow
const result = SafeMath.sub(a, b);   // Reverts on underflow
const result = SafeMath.mul(a, b);   // Reverts on overflow
const result = SafeMath.div(a, b);   // Reverts on divide-by-zero
```

**Creating u256 values:**

```typescript
// Use fromString for large numbers (pow() doesn't exist on u256 in AS)
const TOKENS_PER_MINT: u256 = u256.fromString('1000000000000000000000');
const MAX_SUPPLY: u256 = u256.fromString('100000000000000000000000000');
const MAX_MINTS: u256 = u256.fromU32(5);
```

### Common Imports

```typescript
// From btc-runtime
import {
    Blockchain, OP_NET, OP20, OP721,
    Address, Calldata, BytesWriter, Selector,
    StoredU256, StoredBoolean, StoredString, StoredU64,
    AddressMemoryMap, StoredMapU256, EMPTY_POINTER,
    encodeSelector, SafeMath, Revert,
} from '@btc-vision/btc-runtime/runtime';

// From as-bignum
import { u256, u128 } from '@btc-vision/as-bignum/assembly';

// Abort handler
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';
```

### Time-Dependent Logic

**NEVER use `Blockchain.block.medianTimestamp`** — Bitcoin's Median Time Past can be manipulated by miners within ±2 hours. This is a CRITICAL SECURITY VULNERABILITY.

**ALWAYS use `Blockchain.block.number`** (block height) — strictly monotonic and tamper-proof.

| Need | Use |
|------|-----|
| 24h deadline | `Blockchain.block.number + 144` |
| Staleness check | Block count comparison |
| u256 block number | `Blockchain.block.numberU256` |

---

## 6. Frontend Development (React + Vite)

### Transaction Rules

- **NEVER use raw PSBT**
- **NEVER use `@btc-vision/transaction` for contract calls** — use `getContract()` from `opnet`
- **`signer: null` and `mldsaSigner: null` in `sendTransaction()` — ALWAYS** — the wallet handles signing
- **Always simulate before sending**

### ABI-Based Contract Interaction is MANDATORY

ALL frontends that interact with OPNet contracts MUST use the `opnet` npm package with ABI definitions:

```typescript
import { JSONRpcProvider, getContract } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { MyContractABI } from './abi/MyContractABI.js';

const provider = new JSONRpcProvider({ url: 'https://testnet.opnet.org', network: networks.opnetTestnet });
const contract = getContract(contractAddress, MyContractABI, provider, network, senderAddress);
const result = await contract.someMethod(param1, param2);
```

**`getContract` requires 5 parameters:** `(address, abi, provider, network, sender)`. Never skip any.

### Provider Singleton (Cache & Reuse)

```typescript
// WRONG — creating provider per component
const provider = new JSONRpcProvider({ url, network }); // in every render

// CORRECT — singleton
let cachedProvider: JSONRpcProvider | null = null;
export function getProvider(url: string, network: Network): JSONRpcProvider {
    if (!cachedProvider) {
        cachedProvider = new JSONRpcProvider({ url, network });
    }
    return cachedProvider;
}
```

### RPC Optimization: Use `.metadata()`

```typescript
// BAD — 4 RPC calls
const [name, symbol, decimals, totalSupply] = await Promise.all([
    contract.name(), contract.symbol(), contract.decimals(), contract.totalSupply()
]);

// GOOD — 1 RPC call
const { name, symbol, decimals, totalSupply } = (await contract.metadata()).decoded;
```

### Frontend sendTransaction Pattern

```typescript
// 1. Get contract instance (cached)
const contract = getContract(address, abi, provider, network, senderAddress);

// 2. Simulate
const sim = await contract.transfer(recipientAddress, amount);
if ('error' in sim) throw new Error(sim.error);

// 3. Send — signer=null on frontend
const receipt = await sim.sendTransaction({
    signer: null,
    mldsaSigner: null,
    refundTo: address,
    maximumAllowedSatToSpend: 10000n,
    network,
});
```

### Plain BTC Transfer (Frontend)

**Requires `@btc-vision/transaction@1.8.0-rc.10+`** — rc.10 added `IFundingTransactionParametersWithoutSigner` and `detectFundingOPWallet`.

```typescript
import { TransactionFactory } from '@btc-vision/transaction';
const factory = new TransactionFactory();
const result = await factory.createBTCTransfer({
    utxos, from: userAddress,
    to: 'bc1p...recipient', feeRate: 10,
    priorityFee: 0n, amount: 50000n,
});
await provider.sendRawTransaction(result.tx, false);
```

**Key rules:** Do NOT pass `signer`, `mldsaSigner`, `network`, or `gasSatFee` — omitted by `IFundingTransactionParametersWithoutSigner`. `priorityFee: 0n` IS required. rc.9 crashes with `null.publicKey`.

### Network-Switch Handling (No Page Refresh)

The website must handle network changes WITHOUT page refresh. When the wallet switches networks, clear all caches and re-fetch data.

---

## 7. Backend Development (Node.js)

### MANDATORY Frameworks

| Package | Purpose |
|---------|---------|
| `@btc-vision/hyper-express` | HTTP server |
| `@btc-vision/uwebsocket.js` | WebSocket server |

**Express, Fastify, Koa, Hapi are FORBIDDEN.**

### Server Setup

```typescript
import HyperExpress from '@btc-vision/hyper-express';

const app = new HyperExpress.Server({
    max_body_length: 1024 * 1024 * 8,
    fast_abort: true,
    max_body_buffer: 1024 * 32,
    idle_timeout: 60,
    response_timeout: 120,
});

// CRITICAL: Always set global error handler
app.set_error_handler((_request, response, _error) => {
    if (response.closed) return;
    response.atomic(() => {
        response.status(500);
        response.json({ error: 'Something went wrong.' });
    });
});
```

### Backend sendTransaction Pattern

```typescript
const receipt = await sim.sendTransaction({
    signer: wallet.keypair,            // MUST specify on backend
    mldsaSigner: wallet.mldsaKeypair,  // MUST specify on backend
    refundTo: address,
    maximumAllowedSatToSpend: 10000n,
    network,
});
```

### Threading is MANDATORY

- Use Worker threads for CPU-bound work
- Use async with proper concurrency for I/O
- Batch operations where possible
- Use connection pooling
- Sequential processing = unacceptable performance

---

## 8. Transaction Rules

### The Flow

| Step | Action |
|------|--------|
| 1 | Get contract instance via `getContract()` from `opnet` |
| 2 | (If payable) Call `setTransactionDetails()` BEFORE simulate |
| 3 | Simulate: `const sim = await contract.method(params)` |
| 4 | Check result: `if ('error' in sim) throw` |
| 5 | Send: `sim.sendTransaction({ signer, mldsaSigner, ... })` |
| 6 | (If payable) Include `extraOutputs`/`extraInputs` in sendTransaction |

### setTransactionDetails for Payable Functions

```typescript
import { getContract, TransactionOutputFlags } from 'opnet';

// 1. Set details BEFORE simulate
contract.setTransactionDetails({
    inputs: [],
    outputs: [{
        to: 'bc1p...recipient',
        value: 5000n,
        index: 1,  // index 0 is RESERVED
        flags: TransactionOutputFlags.hasTo,
    }],
});

// 2. Simulate
const sim = await contract.transfer(recipientAddress, 1000000n);

// 3. Send with matching extraOutputs
await sim.sendTransaction({
    signer: null, mldsaSigner: null,
    refundTo: address, network,
    maximumAllowedSatToSpend: 100000n,
    extraOutputs: [{ to: 'bc1p...recipient', value: 5000n }],
});
```

### Common Transaction Parameters

| User Request | Parameter |
|-------------|-----------|
| Set fee rate | `feeRate: number` (sat/vB) |
| Add priority fee | `priorityFee: bigint` |
| Add a note/memo | `note: string \| Uint8Array` |
| Use anchor outputs | `anchor: true` |
| Send to multiple addresses | `extraOutputs: PsbtOutputExtended[]` |
| Send max/entire balance | `autoAdjustAmount: true` |
| Pay fees from separate UTXOs | `feeUtxos: UTXO[]` |

### Offline Signing

```typescript
const buffer = await simulation.toOfflineBuffer(address, amount);
const reconstructed = CallResult.fromOfflineBuffer(buffer);
const signedTx = await reconstructed.signTransaction(params);
const receipt = await reconstructed.sendPresignedTransaction(signedTx);
```

---

## 9. Wallet Integration (OP_WALLET)

**OP_WALLET is the ONLY official wallet supporting full OPNet features.** ALL dApps MUST integrate it.

| Feature | OP_WALLET | Other Wallets |
|---------|-----------|---------------|
| ML-DSA Signatures | Yes | No |
| Quantum-Resistant Keys | Yes | No |
| Full OPNet Integration | Yes | Partial |

### Installation

```bash
npm i @btc-vision/opwallet @btc-vision/walletconnect
```

### Integration

```typescript
import { WalletConnectProvider, useWalletConnect, SupportedWallets } from '@btc-vision/walletconnect';

// Wrap your app
<WalletConnectProvider theme="dark">
    <App />
</WalletConnectProvider>

// In your component
const {
    connectToWallet, isConnected, address, network, disconnect,
    mldsaPublicKey, hashedMLDSAKey, publicKey, signMLDSAMessage
} = useWalletConnect();

// Connect to OP_WALLET
connectToWallet(SupportedWallets.OP_WALLET);
```

### CRITICAL: Signer is Always Null on Frontend

```typescript
// CORRECT — Frontend
const receipt = await sim.sendTransaction({
    signer: null,       // ALWAYS null
    mldsaSigner: null,  // ALWAYS null
    refundTo: address,
    maximumAllowedSatToSpend: 10000n,
    network,
});
```

Do NOT gate frontend actions on `signer` from walletconnect. Check `isConnected` and `address` instead.

---

## 10. Address Systems & Public Keys

### The Two Address Systems

| System | Format | Used For |
|--------|--------|----------|
| Bitcoin Address | Taproot P2TR (`bc1p...`) | External identity |
| OPNet Address | ML-DSA public key hash (32 bytes) | Contract balances, internal state |

**These are completely different cryptographic systems with no inherent link.**

### Address.fromString() — TWO Parameters Required

```typescript
// WRONG
const addr = Address.fromString(addressString);
const addr = Address.fromString('bc1q...');

// CORRECT — hashedMLDSAKey (32-byte hash) + tweakedPublicKey
const addr = Address.fromString(hashedMLDSAKey, publicKey);
```

- First param: `hashedMLDSAKey` from `useWalletConnect()` — NOT `mldsaPublicKey` (raw ~2500 bytes)
- Second param: `publicKey` (Bitcoin tweaked public key, 33 bytes compressed)
- Both must be 0x-prefixed hex strings

### Public Keys Must Be Hexadecimal

For transfers, you MUST use hex public keys (0x...), not Bitcoin addresses:

```typescript
// WRONG
const result = await contract.transfer('bc1q...recipient', amount);

// CORRECT — look up public key first
const pubKeyInfo = await provider.getPublicKeyInfo('bc1q...recipient');
const result = await contract.transfer(pubKeyInfo.publicKey, amount);
```

### Address Validation

```typescript
import { AddressVerificator } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

AddressVerificator.isValidP2TRAddress('bc1p...', networks.bitcoin);
AddressVerificator.isP2WPKHAddress('bc1q...', networks.bitcoin);
AddressVerificator.isValidP2OPAddress('op1...', networks.bitcoin);
AddressVerificator.detectAddressType('bc1q...', networks.bitcoin);
```

### Contract Addresses: Both Formats Valid

```typescript
const contract1 = getContract('op1qwerty...', abi, provider, network, sender);
const contract2 = getContract('0x1234abcd...', abi, provider, network, sender);
```

### Airdrops — Claim-Based Pattern Required

You CANNOT loop through Bitcoin addresses and call `transfer()`. OPNet airdrops require a **claim contract** where users prove ownership of both keys:

1. Deploy airdrop contract with allocations keyed by tweaked public key
2. Users call `claim()` with a signature proving they control that key
3. Contract verifies and mints/transfers tokens

---

## 11. Network Configuration

### ALWAYS Use `networks` Namespace

```typescript
import { networks, Network } from '@btc-vision/bitcoin';

const network: Network = networks.bitcoin;          // Mainnet
const network: Network = networks.opnetTestnet;     // OPNet Testnet (Signet fork)
const network: Network = networks.regtest;          // Regtest

// WRONG: networks.testnet is Testnet4, NOT supported by OPNet
```

### RPC URLs

| Network | URL |
|---------|-----|
| Mainnet | `https://mainnet.opnet.org` |
| Testnet | `https://testnet.opnet.org` |
| Regtest | `http://localhost:9001` |

### Provider Config

```typescript
import { JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';

const provider = new JSONRpcProvider({
    url: 'https://testnet.opnet.org',
    network: networks.opnetTestnet,  // Network object, NOT a string
});
```

---

## 12. Contract Addresses

### Mainnet

| Contract | Address |
|----------|---------|
| NativeSwap | `0x035884f9ac2b6ae75d7778553e7d447899e9a82e247d7ced48f22aa102681e70` |
| Staking | `0xaccca433aec3878ebc041cde2a1a2656f928cc404377ebd8339f0bf2cdd66cbe` |
| MOTO | `0x75bd98b086b71010448ec5722b6020ce1e0f2c09f5d680c84059db1295948cf8` |

**Mainnet RPC:** `https://mainnet.opnet.org`
**Fee Recipient:** `bc1pu3284e45n7apyddz49q4q8wf8s8pq4gmeanmu9wvsj7pejzm545qdny0ft`

---

## 13. Security Audit Checklist

### Cryptographic

- [ ] Key generation entropy
- [ ] Nonce reuse prevention
- [ ] Signature malleability protection
- [ ] Timing attack resistance
- [ ] Replay attack protection

### Smart Contract

- [ ] Reentrancy guards
- [ ] Integer overflow/underflow (SafeMath mandatory)
- [ ] Access control enforcement
- [ ] Authorization flaws
- [ ] State manipulation vectors
- [ ] Race conditions

### Bitcoin-Specific

- [ ] Transaction malleability
- [ ] UTXO selection vulnerabilities
- [ ] Fee sniping protection
- [ ] Dust attacks
- [ ] **Transaction pinning attacks** — MUST use CSV timelocks
- [ ] **Unconfirmed transaction chains** — verify CSV enforcement

### DEX/Swap-Specific

- [ ] Front-running / MEV attacks
- [ ] Price manipulation via queue flooding
- [ ] Reservation expiry edge cases
- [ ] Partial fill coordination
- [ ] Slashing mechanism bypass attempts

### Transaction Generation

- [ ] No raw PSBT construction
- [ ] Contract calls use `opnet` `getContract()` — NOT `@btc-vision/transaction`
- [ ] Frontend: `signer: null`, `mldsaSigner: null`
- [ ] Backend: both signers specified
- [ ] No private keys in frontend code
- [ ] `setTransactionDetails()` called BEFORE simulate for payable functions
- [ ] `setTransactionDetails()` output index starts at 1 (index 0 is RESERVED)
- [ ] Always simulate before sending

---

## 14. Gas Optimization (Contracts)

### FORBIDDEN Patterns

| Pattern | Why | Alternative |
|---------|-----|-------------|
| `while` loops | Unbounded gas | Bounded `for` loops |
| Infinite loops | Contract halts | Always have exit condition |
| Iterating all map keys | O(n) explosion | Indexed lookups, pagination |
| Iterating all array elements | O(n) cost | Store aggregates, pagination |
| Unbounded arrays | Grows forever | Cap size, use cleanup |

### Gas-Efficient Patterns

```typescript
// WRONG — iterating all holders O(n)
let total: u256 = u256.Zero;
for (let i = 0; i < holders.length; i++) {
    total = SafeMath.add(total, balances.get(holders[i]));
}

// CORRECT — store running total, read O(1)
const totalSupply: StoredU256 = new StoredU256(TOTAL_SUPPLY_POINTER);
```

---

## 15. Performance Rules (Frontend/Backend)

### Caching is MANDATORY

- **Reuse contract instances** — never create new instances for same contract
- **Reuse providers** — single provider instance per network
- **Cache locally** — browser localStorage/IndexedDB for user data
- **Cache on API** — server-side caching for blockchain state
- **Invalidate on block change** — clear stale data when new block confirmed

### RPC Call Optimization

**Use `.metadata()` instead of multiple calls** — returns name, symbol, decimals, totalSupply, owner in ONE call.

### Backend Threading

- Use Worker threads for CPU-bound work
- Use async with proper concurrency for I/O
- Batch operations where possible
- Use connection pooling

---

## 16. CSV Anti-Pinning (DEX/Swaps)

### What is Transaction Pinning?

An attacker creates massive chains of unconfirmed transactions to prevent your legitimate transaction from being mined. This destroys DEX swap guarantees.

### CSV (CheckSequenceVerify, BIP 112) Solution

```
Without CSV: Maximum unconfirmed chain = UNLIMITED (attackers pin forever)
With CSV:    Maximum unconfirmed chain = ZERO (must wait for confirmation)
```

**ALL addresses receiving BTC in OPNet swaps MUST use CSV timelocks.** This is enforced at the protocol level in NativeSwap. If you build anything coordinating BTC transfers with smart contract state, you MUST implement CSV.

---

## 17. NativeSwap DEX Patterns

### The Problem

Bitcoin cannot have a smart contract hold and programmatically transfer BTC. Traditional AMM approaches don't work.

### Virtual Reserves Solution

The AMM tracks economic effects via `bitcoinReserve` and `tokenReserve` numbers. Actual BTC goes directly to sellers, not to the contract. The constant product formula works identically with virtual reserves.

### Two-Phase Commit (Reservations)

| Phase | Action |
|-------|--------|
| **Phase 1: Reserve** | Prove you control BTC (UTXOs as inputs), pay small fee, price locked in consensus |
| **Phase 2: Execute** | Send exact BTC to providers (up to 200 addresses atomically), guaranteed execution at locked price |

**Benefits:** No slippage risk, no front-running, atomic partial fills across 200 addresses.

### Slashing Mechanism

- **Immediate cancellation:** 50% penalty
- **Extended squatting:** Escalates to 90%
- **Slashed tokens return to pool** — attacks improve liquidity

---

## 18. Common Mistakes — Never Repeat

| Mistake | Correct Approach |
|---------|-----------------|
| Using `Blockchain.block.medianTimestamp` for logic | Use `Blockchain.block.number` — miners can manipulate MTP ±2h |
| Using Keccak256 selectors | Use SHA256 — this is Bitcoin, not Ethereum |
| Calling `approve()` on OP-20 | Use `increaseAllowance()` / `decreaseAllowance()` |
| Passing `bc1p...` to `Address.fromString()` | Requires TWO hex pubkey params: `(hashedMLDSAKey, tweakedPubKey)` |
| Using `bitcoinjs-lib` | Use `@btc-vision/bitcoin` |
| Skipping simulation before `sendTransaction()` | ALWAYS simulate first — BTC transfers are irreversible |
| Using Express/Fastify | Use `@btc-vision/hyper-express` only |
| Not running `npm-check-updates` | Always clean install with `npx npm-check-updates -u` |
| Using `contract.execute()` with raw selector bytes | Define proper ABI, call methods by name |
| Creating multiple provider instances | Singleton per network |
| Calling `getContract` every render | Cache contract instances |
| Using walletconnect provider for read calls | Create separate `JSONRpcProvider` for reads |
| Bare `@method()` with no arguments | ALWAYS declare all params — empty = broken ABI |
| Using bare `Map<Address, T>` in contracts | Use `AddressMemoryMap` — JS Map uses reference equality |

---

## 19. Code Verification Order

**Before considering code complete, verify in this EXACT order:**

| Order | Check | Command |
|-------|-------|---------|
| 1 | ESLint | `npm run lint` |
| 2 | TypeScript | `npm run typecheck` or `tsc --noEmit` |
| 3 | Build | `npm run build` |
| 4 | Tests | `npm run test` |

**NEVER skip ESLint. NEVER ship code with lint errors.** ESLint catches `any` types, missing return types, and forbidden patterns that TypeScript alone misses.

---

## 20. Client Libraries Reference

| Package | Description |
|---------|-------------|
| `@btc-vision/bitcoin` | Bitcoin library (709x faster PSBT) — replaces `bitcoinjs-lib` |
| `@btc-vision/bip32` | HD derivation + quantum support |
| `@btc-vision/ecpair` | EC key pairs |
| `@btc-vision/transaction` | OPNet transactions — ONLY for TransactionFactory |
| `opnet` | Main client library — getContract, providers, ABI |
| `@btc-vision/walletconnect` | Wallet connection (OP_WALLET + others) |
| `@btc-vision/opwallet` | OP_WALLET integration |
| `@btc-vision/btc-runtime` | Smart contract runtime (AssemblyScript) |
| `@btc-vision/assemblyscript` | Custom AS fork with closure support |
| `@btc-vision/as-bignum` | u256/u128 for contracts |
| `@btc-vision/opnet-transform` | ABI transform for contract decorators |
| `@btc-vision/hyper-express` | HTTP server (backend) |
| `@btc-vision/uwebsocket.js` | WebSocket server (backend) |

---

## Quick Reference — How-To Guides

| Guide | Description |
|-------|-------------|
| Airdrops | Claim-based pattern (two-address system prevents loop-and-transfer) |
| Message Signing | ML-DSA, Schnorr, ECDSA with Auto methods |
| ETH Equivalents | Feature mapping table (Ethereum → OPNet) |
| Multisig | Multisig transaction workflow |
| Offline Signing | Air-gapped signing workflow |
| Contract Upgrades | Upgrade pattern with onUpdate lifecycle |
| DEX Building | NativeSwap pattern |
| Stablecoin | Stablecoin contract pattern |
| Oracle Integration | Oracle pattern |
