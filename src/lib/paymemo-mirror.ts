/**
 * Mirror extension_records into the encrypted vault (vault_records) so
 * /app/ledger sees EVERY transaction the user has touched - extension
 * popup memos, chain-watch detections, and (eventually) Record-review
 * confirmations.
 *
 * Why this exists:
 *
 *   The browser extension popup / sidepanel writes memos via
 *   `/api/extension-intent`, which lands in the `extension_records` table.
 *   The extension cannot write directly to `vault_records` because it has
 *   no access to the dApp's vault encryption key (the key is derived from
 *   a wallet-signature on the dApp side - see `crypto-vault.ts`).
 *
 *   Without this mirror, anything that lands in `extension_records` is
 *   invisible to /app/ledger, which reads only `vault_records`. That
 *   includes both:
 *     - Confirmed memos saved from the extension popup
 *     - `needs-review` rows the server-side Morph scanner or the
 *       extension's background chain-watch created for transactions you
 *       made while offline
 *
 *   We mirror all of those into the vault from any dApp page that has
 *   the vault unlocked. The next time the user opens /app/review or
 *   /app/ledger the rows are backfilled.
 *
 *   Idempotent: a row whose `txHash` already lives in `vault_records` is
 *   skipped, so re-running the mirror on every poll is safe.
 *
 * Mirrored statuses:
 *   - `confirmed`   - extension popup memos + offline payments the user
 *                     has already reviewed
 *   - `needs-review`- chain-watch detections still awaiting a memo (so
 *                     the user can see in /app/ledger that the
 *                     transaction happened even before they've reviewed
 *                     it)
 *   - `failed`      - chain-watch caught a tx with receipt.status=0x0
 *
 * Statuses deliberately skipped: `intent`, `pending_signature`,
 * `pending_chain`, `signed`, `rejected`. These are in-flight wallet-
 * assist states from a live extension popup capture session - either
 * the tx hasn't landed yet or the user dismissed it, and copying them
 * into the permanent ledger would be misleading.
 */

import { encryptPrivateMetadata } from "./crypto-vault";
import type { ExtensionRecord } from "./extension-records";
import { normalizeRecord, payMemoCategories, type PayMemoRecordInput } from "./paymemo-schema";
import {
  syncEncryptedVaultRecord,
  toPrivateMetadata,
  toPublicRecord,
  type StoredVaultRecord,
} from "./paymemo-vault";

type MirrorSession = { walletAddress: string };

// Statuses that should reach the Ledger. Everything else is mid-flight
// noise and would just confuse the ledger view.
const MIRRORABLE_STATUSES = new Set(["confirmed", "needs-review", "failed"]);

export function isMirrorableExtensionRecord(record: ExtensionRecord): boolean {
  return MIRRORABLE_STATUSES.has(record.status);
}

/**
 * Mirror a single extension_record into the encrypted vault.
 *
 * The mirror copies the row's existing status straight through - confirmed
 * stays confirmed, needs-review stays needs-review, failed stays failed.
 * No status promotion happens here. (The Record-review button in
 * `/app/review` does its own confirmed-status mirror via `confirmActive`,
 * which is what flips a needs-review row to confirmed.)
 *
 * Returns the stored vault record on success, or `null` if the mirror was
 * skipped (status not mirrorable, validation failed, encryption error, or
 * the server rejected the upsert). Errors are swallowed so a single bad
 * row never blocks the batch helper below.
 */
export async function mirrorExtensionRecordToVault(
  extensionRecord: ExtensionRecord,
  session: MirrorSession,
  key: CryptoKey,
): Promise<StoredVaultRecord | null> {
  if (!isMirrorableExtensionRecord(extensionRecord)) return null;

  // Coerce category back into the allowed enum - extension popup users can
  // type anything into the category field, and the dApp ledger filter uses
  // a fixed list, so an unknown category would just look ugly.
  const category = (payMemoCategories as readonly string[]).includes(extensionRecord.category)
    ? (extensionRecord.category as PayMemoRecordInput["category"])
    : ("Other" as PayMemoRecordInput["category"]);

  try {
    const normalized = normalizeRecord({
      ...extensionRecord,
      id: extensionRecord.id,
      // Preserve the source status. Mirroring a needs-review row creates a
      // needs-review vault row; the dedupe logic in /app/review depends on
      // this so we don't accidentally hide the row from the Pending tab.
      status: extensionRecord.status as PayMemoRecordInput["status"],
      chainId: 2910,
      chainName: "Morph Hoodi Testnet",
      mode: "wallet-assist",
      source: extensionRecord.source ?? "browser-extension",
      to: extensionRecord.to || session.walletAddress,
      amount: extensionRecord.amount || "0",
      token: extensionRecord.token || "ETH",
      category,
    });

    const encryptedMetadata = await encryptPrivateMetadata(
      toPrivateMetadata(normalized),
      key,
      session.walletAddress,
    );

    const stored: StoredVaultRecord = {
      id: normalized.id ?? extensionRecord.id ?? crypto.randomUUID(),
      walletAddress: session.walletAddress,
      publicRecord: toPublicRecord(normalized),
      encryptedMetadata,
      syncStatus: "synced",
      updatedAt:
        extensionRecord.reviewedAt ?? extensionRecord.updatedAt ?? new Date().toISOString(),
    };

    await syncEncryptedVaultRecord(stored);
    return stored;
  } catch (error) {
    console.warn(
      "[paymemo] mirrorExtensionRecordToVault failed",
      extensionRecord.id ?? extensionRecord.txHash,
      error,
    );
    return null;
  }
}

/**
 * Find every mirrorable extension_record whose `txHash` is NOT already in
 * the vault and mirror them in. Skips rows without a tx hash (we can't
 * dedupe them safely) and rows that are already in `existingVaultTxHashes`.
 *
 * Returns the freshly-mirrored records so callers can append them to
 * their in-memory list without waiting for a re-fetch round trip.
 */
export async function mirrorOrphanedExtensionRecords(params: {
  extensionRecords: ExtensionRecord[];
  existingVaultTxHashes: Set<string>;
  session: MirrorSession;
  key: CryptoKey;
}): Promise<StoredVaultRecord[]> {
  const { extensionRecords, existingVaultTxHashes, session, key } = params;

  const orphans = extensionRecords.filter((record) => {
    if (!isMirrorableExtensionRecord(record)) return false;
    const hash = (record.txHash || "").toLowerCase();
    if (!hash) return false;
    return !existingVaultTxHashes.has(hash);
  });

  if (orphans.length === 0) return [];

  const mirrored: StoredVaultRecord[] = [];
  for (const orphan of orphans) {
    const result = await mirrorExtensionRecordToVault(orphan, session, key);
    if (result) mirrored.push(result);
  }
  return mirrored;
}
