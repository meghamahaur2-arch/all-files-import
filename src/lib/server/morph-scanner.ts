/**
 * Server-side Morph Hoodi scanner. Writes detected transactions directly
 * to `extension_records` (the same table the dApp's review queue reads)
 * via `paymemo-db`.
 *
 * Used by:
 *   - `GET /api/cron/scan-morph` (Vercel cron, periodic background sweep)
 *   - `POST /api/cron/scan-morph` with `?ownerWallet=` (per-user catch-up
 *     scan triggered when the dashboard mounts after the user comes back online)
 *   - The Railway worker (`worker/index.js`), which calls the GET endpoint
 *     on every new Morph block for ~2-second push detection
 *
 * The dApp no longer runs an in-tab poller - all scanning is server-side.
 */

import {
  listEnabledWatchedWallets,
  listWatchedWalletsByOwner,
  updateWatchedWalletScanProgress,
  addExtensionRecord,
  listKnownVaultTxHashes,
  listKnownExtensionTxHashes,
  type WatchedWallet,
} from "./paymemo-db";
import { morphHoodi, morphTokens, formatUnits } from "@/lib/morph";
import { normalizeRecord } from "@/lib/paymemo-schema";
import type { PayMemoRecordInput } from "@/lib/paymemo-schema";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MAX_BLOCK_WINDOW = 250;
const INITIAL_LOOKBACK = 200;

type Hex = string;

type RawBlockTx = {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: Hex;
  input?: Hex;
  blockNumber?: Hex;
};

type RawBlock = {
  number: Hex;
  timestamp: Hex;
  transactions: RawBlockTx[];
};

type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
};

function hexToBigInt(value: string | null | undefined) {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function hexToNumber(value: string | null | undefined) {
  return Number(hexToBigInt(value));
}

function pad32(address: string) {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

async function morphRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(morphHoodi.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Morph RPC ${method} ${response.status}`);
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message || `Morph RPC ${method} error.`);
  return payload.result as T;
}

function findKnownToken(contract: string) {
  const normalized = contract.toLowerCase();
  return morphTokens.find(
    (token) => token.contractAddress && token.contractAddress.toLowerCase() === normalized,
  );
}

function describeNativeAmount(rawValue: string) {
  const value = hexToBigInt(rawValue);
  if (value === 0n) return "0 ETH";
  return `${formatUnits(value, 18, 6)} ETH`;
}

function describeErc20Amount(value: bigint, decimals: number, symbol: string) {
  return `${formatUnits(value, decimals, 6)} ${symbol}`;
}

function buildNativeRecord(
  tx: RawBlockTx,
  watchedAddress: string,
  ownerLabel: string,
): PayMemoRecordInput | null {
  const from = (tx.from || "").toLowerCase();
  const to = (tx.to || "").toLowerCase();
  const valueRaw = tx.value ?? "0x0";
  const value = hexToBigInt(valueRaw);
  if (!to || value === 0n) return null;
  const isOutgoing = from === watchedAddress;
  const isIncoming = to === watchedAddress;
  if (!isOutgoing && !isIncoming) return null;

  return {
    id: `mcw-srv-${tx.hash}`,
    mode: "wallet-assist",
    status: "needs-review",
    chainId: morphHoodi.chainId,
    chainName: morphHoodi.name,
    txHash: tx.hash,
    from,
    to,
    amount: describeNativeAmount(valueRaw),
    token: "ETH",
    direction: isOutgoing ? "outgoing" : "incoming",
    transactionType: "native",
    rawValue: valueRaw,
    blockNumber: tx.blockNumber,
    source: "server-chain-watch",
    provider: "Morph Chain Watch",
    method: "morph-chain-watch",
    category: "Other",
    counterparty: ownerLabel
      ? `${ownerLabel} ↔ ${(isOutgoing ? to : from).slice(0, 10)}…`
      : undefined,
    createdAt: new Date().toISOString(),
  };
}

function buildErc20Record(
  log: RawLog,
  watchedAddress: string,
  ownerLabel: string,
): PayMemoRecordInput | null {
  const fromHex = `0x${log.topics[1]?.slice(-40) ?? ""}`.toLowerCase();
  const toHex = `0x${log.topics[2]?.slice(-40) ?? ""}`.toLowerCase();
  const value = hexToBigInt(log.data);
  const isOutgoing = fromHex === watchedAddress;
  const isIncoming = toHex === watchedAddress;
  if (!isOutgoing && !isIncoming) return null;

  const token = findKnownToken(log.address);
  const symbol = token?.symbol ?? "TOKEN";
  const decimals = token?.decimals ?? 18;

  return {
    id: `mcw-srv-${log.transactionHash}-${log.address.toLowerCase()}`,
    mode: "wallet-assist",
    status: "needs-review",
    chainId: morphHoodi.chainId,
    chainName: morphHoodi.name,
    txHash: log.transactionHash,
    from: fromHex,
    to: toHex,
    amount: describeErc20Amount(value, decimals, symbol),
    token: symbol,
    direction: isOutgoing ? "outgoing" : "incoming",
    transactionType: "erc20",
    tokenContract: log.address.toLowerCase(),
    blockNumber: log.blockNumber,
    source: "server-chain-watch",
    provider: "Morph Chain Watch",
    method: "morph-chain-watch",
    category: "Other",
    counterparty: ownerLabel
      ? `${ownerLabel} ↔ ${(isOutgoing ? toHex : fromHex).slice(0, 10)}…`
      : undefined,
    createdAt: new Date().toISOString(),
  };
}

async function fetchBlocks(fromBlock: number, toBlock: number) {
  const blocks: RawBlock[] = [];
  for (let i = fromBlock; i <= toBlock; i++) {
    const hex = `0x${i.toString(16)}`;
    try {
      const block = await morphRpc<RawBlock | null>("eth_getBlockByNumber", [hex, true]);
      if (block) blocks.push(block);
    } catch {
      // Tolerate flaky RPC; the next run picks it up.
    }
  }
  return blocks;
}

async function fetchErc20Transfers(fromBlock: number, toBlock: number, watched: string) {
  const knownContracts = morphTokens
    .map((token) => token.contractAddress)
    .filter((value): value is string => Boolean(value));
  if (!knownContracts.length) return [] as RawLog[];

  const paddedAddress = pad32(watched);
  const base = {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    address: knownContracts,
  };

  const fromCall = morphRpc<RawLog[]>("eth_getLogs", [
    { ...base, topics: [ERC20_TRANSFER_TOPIC, paddedAddress] },
  ]).catch(() => [] as RawLog[]);
  const toCall = morphRpc<RawLog[]>("eth_getLogs", [
    { ...base, topics: [ERC20_TRANSFER_TOPIC, null, paddedAddress] },
  ]).catch(() => [] as RawLog[]);
  const [a, b] = await Promise.all([fromCall, toCall]);
  return [...(a ?? []), ...(b ?? [])];
}

type ScanResult = {
  watched: string;
  startBlock: number;
  endBlock: number;
  detections: number;
};

async function scanOne(
  watched: WatchedWallet,
  latestBlock: number,
  knownTxHashes: Set<string>,
): Promise<ScanResult> {
  const previous = watched.lastScannedBlock || Math.max(0, latestBlock - INITIAL_LOOKBACK);
  const fromBlock = Math.max(0, Math.min(previous + 1, latestBlock));
  const toBlock = latestBlock;
  if (fromBlock > toBlock) {
    return {
      watched: watched.watchedAddress,
      startBlock: previous,
      endBlock: latestBlock,
      detections: 0,
    };
  }
  const span = toBlock - fromBlock + 1;
  const startBlock = span > MAX_BLOCK_WINDOW ? toBlock - MAX_BLOCK_WINDOW + 1 : fromBlock;

  const [blocks, logs] = await Promise.all([
    fetchBlocks(startBlock, toBlock),
    fetchErc20Transfers(startBlock, toBlock, watched.watchedAddress),
  ]);

  const ownerLabel = watched.label || "";
  let detections = 0;
  const seenKeys = new Set<string>();

  for (const block of blocks) {
    for (const tx of block.transactions ?? []) {
      if (!tx.hash) continue;
      const hashLower = tx.hash.toLowerCase();
      // Skip transactions the user has already memo'd via /app/send or via
      // the Review-confirm flow - they live in vault_records or are already
      // recorded in extension_records, so re-inserting would create
      // duplicates and bounce them back into Needs Review.
      if (knownTxHashes.has(hashLower)) continue;
      const key = `native:${hashLower}`;
      if (seenKeys.has(key)) continue;
      const draft = buildNativeRecord(tx, watched.watchedAddress, ownerLabel);
      if (!draft) continue;
      seenKeys.add(key);
      try {
        const normalized = normalizeRecord(draft);
        await addExtensionRecord(normalized);
        knownTxHashes.add(hashLower);
        detections += 1;
      } catch {
        // Skip a single bad record; keep scanning.
      }
    }
  }

  for (const log of logs) {
    if (!log.transactionHash) continue;
    const hashLower = log.transactionHash.toLowerCase();
    if (knownTxHashes.has(hashLower)) continue;
    const key = `erc20:${hashLower}:${log.address.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    const draft = buildErc20Record(log, watched.watchedAddress, ownerLabel);
    if (!draft) continue;
    seenKeys.add(key);
    try {
      const normalized = normalizeRecord(draft);
      await addExtensionRecord(normalized);
      knownTxHashes.add(hashLower);
      detections += 1;
    } catch {
      // skip
    }
  }

  await updateWatchedWalletScanProgress(watched.watchedAddress, toBlock);
  return { watched: watched.watchedAddress, startBlock, endBlock: toBlock, detections };
}

export async function scanAllEnabled() {
  const wallets = await listEnabledWatchedWallets();
  if (!wallets.length)
    return { ok: true, walletsScanned: 0, detections: 0, results: [] as ScanResult[] };
  const latestBlock = hexToNumber(await morphRpc<Hex>("eth_blockNumber"));
  // Pre-fetch every tx hash already memo'd or recorded so the scan dedupes
  // them in a single in-memory Set instead of querying per-wallet.
  const owners = Array.from(new Set(wallets.map((wallet) => wallet.ownerWallet)));
  const [vaultHashes, extensionHashes] = await Promise.all([
    listKnownVaultTxHashes(owners),
    listKnownExtensionTxHashes(),
  ]);
  const knownTxHashes = new Set<string>([...vaultHashes, ...extensionHashes]);

  const results: ScanResult[] = [];
  for (const wallet of wallets) {
    const result = await scanOne(wallet, latestBlock, knownTxHashes).catch((error) => {
      console.warn("[paymemo] server scan failed for", wallet.watchedAddress, error);
      return {
        watched: wallet.watchedAddress,
        startBlock: 0,
        endBlock: latestBlock,
        detections: 0,
      };
    });
    results.push(result);
  }
  const detections = results.reduce((sum, item) => sum + item.detections, 0);
  return { ok: true, walletsScanned: wallets.length, detections, results, latestBlock };
}

export async function scanForOwner(ownerWallet: string) {
  const wallets = (await listWatchedWalletsByOwner(ownerWallet)).filter((item) => item.enabled);
  if (!wallets.length)
    return { ok: true, walletsScanned: 0, detections: 0, results: [] as ScanResult[] };
  const latestBlock = hexToNumber(await morphRpc<Hex>("eth_blockNumber"));
  const [vaultHashes, extensionHashes] = await Promise.all([
    listKnownVaultTxHashes([ownerWallet]),
    listKnownExtensionTxHashes(),
  ]);
  const knownTxHashes = new Set<string>([...vaultHashes, ...extensionHashes]);

  const results: ScanResult[] = [];
  for (const wallet of wallets) {
    const result = await scanOne(wallet, latestBlock, knownTxHashes).catch((error) => {
      console.warn("[paymemo] owner scan failed for", wallet.watchedAddress, error);
      return {
        watched: wallet.watchedAddress,
        startBlock: 0,
        endBlock: latestBlock,
        detections: 0,
      };
    });
    results.push(result);
  }
  const detections = results.reduce((sum, item) => sum + item.detections, 0);
  return { ok: true, walletsScanned: wallets.length, detections, results, latestBlock };
}
