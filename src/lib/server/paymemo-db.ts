import type { PayMemoRecord } from "@/lib/paymemo-schema";
import type { StoredVaultRecord } from "@/lib/paymemo-vault";

type PayMemoDatabase = {
  vaultRecords: StoredVaultRecord[];
  extensionRecords: PayMemoRecord[];
  agentMemoryRecords: PayMemoRecord[];
  invoiceRecords: EncryptedDomainRecord[];
  batchPayoutRecords: EncryptedDomainRecord[];
  agentPaymentIntentRecords: EncryptedDomainRecord[];
  extensionPairings: ExtensionPairing[];
  watchedWallets: WatchedWallet[];
  updatedAt: string;
};

export type ExtensionPairing = {
  installToken: string;
  walletAddress: string;
  createdAt: string;
};

export type WatchedWallet = {
  ownerWallet: string;
  watchedAddress: string;
  label: string;
  enabled: boolean;
  lastScannedBlock: number;
  updatedAt: string;
};

type ExtensionPairingRow = {
  install_token: string;
  wallet_address: string;
  created_at: string;
};

const DEFAULT_DB: PayMemoDatabase = {
  vaultRecords: [],
  extensionRecords: [],
  agentMemoryRecords: [],
  invoiceRecords: [],
  batchPayoutRecords: [],
  agentPaymentIntentRecords: [],
  extensionPairings: [],
  watchedWallets: [],
  updatedAt: new Date(0).toISOString(),
};

let writeQueue = Promise.resolve();

type VaultRecordRow = {
  id: string;
  wallet_address: string;
  public_record: StoredVaultRecord["publicRecord"];
  encrypted_metadata: StoredVaultRecord["encryptedMetadata"];
  sync_status: StoredVaultRecord["syncStatus"];
  updated_at: string;
};

type JsonRecordRow = {
  id: string;
  record: PayMemoRecord;
  created_at?: string;
  updated_at?: string;
};

export type EncryptedDomainRecord = {
  id: string;
  walletAddress: string;
  type: "invoice" | "batch-payout" | "agent-payment-intent";
  publicData: Record<string, unknown>;
  encryptedMetadata: StoredVaultRecord["encryptedMetadata"];
  status: string;
  createdAt: string;
  updatedAt: string;
};

type DomainRecordRow = {
  id: string;
  wallet_address: string;
  type: EncryptedDomainRecord["type"];
  public_data: EncryptedDomainRecord["publicData"];
  encrypted_metadata: EncryptedDomainRecord["encryptedMetadata"];
  status: string;
  created_at: string;
  updated_at: string;
};

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function supabaseRequest<T>(
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase is not configured.");

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Supabase request failed (${response.status}): ${message}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function isSupabaseEnabled() {
  return Boolean(getSupabaseConfig());
}

function toStoredVaultRecord(row: VaultRecordRow): StoredVaultRecord {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    publicRecord: row.public_record,
    encryptedMetadata: row.encrypted_metadata,
    syncStatus: row.sync_status,
    updatedAt: row.updated_at,
  };
}

function toVaultRow(record: StoredVaultRecord): VaultRecordRow {
  return {
    id: record.id,
    wallet_address: record.walletAddress.toLowerCase(),
    public_record: record.publicRecord,
    encrypted_metadata: record.encryptedMetadata,
    sync_status: record.syncStatus,
    updated_at: record.updatedAt,
  };
}

function toDomainRecord(row: DomainRecordRow): EncryptedDomainRecord {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    type: row.type,
    publicData: row.public_data,
    encryptedMetadata: row.encrypted_metadata,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDomainRow(record: EncryptedDomainRecord): DomainRecordRow {
  return {
    id: record.id,
    wallet_address: record.walletAddress.toLowerCase(),
    type: record.type,
    public_data: record.publicData,
    encrypted_metadata: record.encryptedMetadata,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

async function getDbPath() {
  const path = await import("node:path");
  return path.join(process.cwd(), "database", "paymemo-dev-db.json");
}

async function ensureDbFile() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dbPath = await getDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(DEFAULT_DB, null, 2), "utf8");
  }

  return dbPath;
}

export async function readPayMemoDb(): Promise<PayMemoDatabase> {
  // On serverless platforms (Vercel) the filesystem is read-only outside
  // of /tmp, so when Supabase is configured we serve a fresh in-memory
  // default and let the real reads hit Supabase via the per-function helpers.
  if (isSupabaseEnabled()) {
    return { ...DEFAULT_DB, updatedAt: new Date().toISOString() };
  }
  const fs = await import("node:fs/promises");
  const dbPath = await ensureDbFile();
  const raw = await fs.readFile(dbPath, "utf8");

  try {
    return { ...DEFAULT_DB, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DB, updatedAt: new Date().toISOString() };
  }
}

export async function writePayMemoDb(
  updater: (db: PayMemoDatabase) => PayMemoDatabase | Promise<PayMemoDatabase>,
) {
  // When Supabase is the source of truth (production / Vercel) we never
  // touch the JSON file - it would throw EACCES on a read-only filesystem
  // and bubble up as a confusing "Unable to clear database" error. Each
  // mutation function already writes to Supabase before calling us; here
  // we just return a fresh in-memory snapshot so callers stay happy.
  if (isSupabaseEnabled()) {
    const current = await readPayMemoDb();
    const next = await updater(current);
    return { ...next, updatedAt: new Date().toISOString() };
  }

  const fs = await import("node:fs/promises");

  writeQueue = writeQueue.then(async () => {
    const dbPath = await ensureDbFile();
    const current = await readPayMemoDb();
    const next = await updater(current);
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    await fs.writeFile(dbPath, JSON.stringify(stamped, null, 2), "utf8");
    return undefined;
  });

  await writeQueue;
  return readPayMemoDb();
}

export async function upsertVaultRecord(record: StoredVaultRecord) {
  const walletKey = record.walletAddress.toLowerCase();
  const syncedRecord: StoredVaultRecord = {
    ...record,
    walletAddress: walletKey,
    syncStatus: "synced",
    updatedAt: new Date().toISOString(),
  };

  if (isSupabaseEnabled()) {
    const existingRows = await supabaseRequest<VaultRecordRow[]>(
      `vault_records?id=eq.${encodeURIComponent(syncedRecord.id)}&select=wallet_address&limit=1`,
    ).catch(() => [] as VaultRecordRow[]);
    if (existingRows[0] && existingRows[0].wallet_address.toLowerCase() !== walletKey) {
      throw new Error("Vault record id is owned by a different wallet.");
    }

    const rows = await supabaseRequest<VaultRecordRow[]>("vault_records?on_conflict=id", {
      method: "POST",
      body: JSON.stringify(toVaultRow(syncedRecord)),
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return toStoredVaultRecord(rows[0]);
  }

  const current = await readPayMemoDb();
  const conflicting = current.vaultRecords.find(
    (item) => item.id === syncedRecord.id && item.walletAddress.toLowerCase() !== walletKey,
  );
  if (conflicting) {
    throw new Error("Vault record id is owned by a different wallet.");
  }

  await writePayMemoDb((db) => ({
    ...db,
    vaultRecords: [
      syncedRecord,
      ...db.vaultRecords.filter(
        (item) => item.id !== syncedRecord.id || item.walletAddress.toLowerCase() !== walletKey,
      ),
    ].slice(0, 2000),
  }));

  return syncedRecord;
}

export async function listVaultRecords(walletAddress: string) {
  const walletKey = walletAddress.toLowerCase();

  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<VaultRecordRow[]>(
      `vault_records?wallet_address=eq.${encodeURIComponent(walletKey)}&select=*&order=updated_at.desc`,
    );
    return rows.map(toStoredVaultRecord);
  }

  const db = await readPayMemoDb();
  return db.vaultRecords.filter((record) => record.walletAddress.toLowerCase() === walletKey);
}

/**
 * Returns the set of tx hashes that are already memo'd in the vault for any
 * of the given owner wallets. The server-side Morph scanner uses this to
 * skip transactions the user has already explained via /app/send or via
 * the Review-confirm flow - they shouldn't bounce back into Needs Review.
 */
export async function listKnownVaultTxHashes(walletAddresses: string[]) {
  const wallets = walletAddresses.map((wallet) => wallet.toLowerCase());
  if (!wallets.length) return new Set<string>();

  const hashes = new Set<string>();

  if (isSupabaseEnabled()) {
    const filter = wallets.map((wallet) => `"${wallet}"`).join(",");
    const rows = await supabaseRequest<VaultRecordRow[]>(
      `vault_records?wallet_address=in.(${encodeURIComponent(filter)})&select=public_record`,
    ).catch(() => [] as VaultRecordRow[]);
    for (const row of rows) {
      const tx = (row.public_record as { txHash?: string } | null)?.txHash;
      if (tx) hashes.add(tx.toLowerCase());
    }
    return hashes;
  }

  const db = await readPayMemoDb();
  for (const record of db.vaultRecords) {
    if (!wallets.includes(record.walletAddress.toLowerCase())) continue;
    const tx = (record.publicRecord as { txHash?: string })?.txHash;
    if (tx) hashes.add(tx.toLowerCase());
  }
  return hashes;
}

export async function listKnownExtensionTxHashes() {
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<{ record: { txHash?: string } }[]>(
      `extension_records?select=record`,
    ).catch(() => [] as { record: { txHash?: string } }[]);
    const hashes = new Set<string>();
    for (const row of rows) {
      const tx = row.record?.txHash;
      if (tx) hashes.add(tx.toLowerCase());
    }
    return hashes;
  }
  const db = await readPayMemoDb();
  return new Set(
    db.extensionRecords.map((record) => String(record.txHash || "").toLowerCase()).filter(Boolean),
  );
}

export async function deleteVaultRecords(walletAddress: string) {
  const walletKey = walletAddress.toLowerCase();

  if (isSupabaseEnabled()) {
    await supabaseRequest<undefined>(
      `vault_records?wallet_address=eq.${encodeURIComponent(walletKey)}`,
      { method: "DELETE" },
    );
    return [];
  }

  const db = await writePayMemoDb((current) => ({
    ...current,
    vaultRecords: current.vaultRecords.filter(
      (record) => record.walletAddress.toLowerCase() !== walletKey,
    ),
  }));

  return db.vaultRecords.filter((record) => record.walletAddress.toLowerCase() === walletKey);
}

export async function deleteUserDatabase(walletAddress: string) {
  const walletKey = walletAddress.toLowerCase();
  const errors: string[] = [];

  if (isSupabaseEnabled()) {
    const safeDelete = async (path: string) => {
      try {
        await supabaseRequest<undefined>(path, { method: "DELETE" });
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await Promise.all([
      safeDelete(`vault_records?wallet_address=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`paymemo_domain_records?wallet_address=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`payment_intents?wallet_address=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`transactions?wallet_address=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`extension_records?record->>from=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`extension_records?record->>to=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`agent_memory_records?record->>from=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`agent_memory_records?record->>to=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`watched_wallets?owner_wallet=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`watched_wallets?watched_address=eq.${encodeURIComponent(walletKey)}`),
      safeDelete(`extension_pairings?wallet_address=eq.${encodeURIComponent(walletKey)}`),
    ]);

    // No JSON-file mirror on Vercel - Supabase is the only source of truth.
    return {
      deleted: errors.length === 0,
      storage: "supabase" as const,
      walletAddress: walletKey,
      partialErrors: errors,
    };
  }

  const db = await writePayMemoDb((current) => ({
    ...current,
    vaultRecords: current.vaultRecords.filter(
      (record) => record.walletAddress.toLowerCase() !== walletKey,
    ),
    extensionRecords: current.extensionRecords.filter(
      (record) =>
        String(record.from || "").toLowerCase() !== walletKey &&
        String(record.to || "").toLowerCase() !== walletKey,
    ),
    agentMemoryRecords: current.agentMemoryRecords.filter(
      (record) =>
        String(record.from || "").toLowerCase() !== walletKey &&
        String(record.to || "").toLowerCase() !== walletKey,
    ),
    invoiceRecords: current.invoiceRecords.filter(
      (record) => record.walletAddress.toLowerCase() !== walletKey,
    ),
    batchPayoutRecords: current.batchPayoutRecords.filter(
      (record) => record.walletAddress.toLowerCase() !== walletKey,
    ),
    agentPaymentIntentRecords: current.agentPaymentIntentRecords.filter(
      (record) => record.walletAddress.toLowerCase() !== walletKey,
    ),
  }));

  return {
    deleted: true,
    remaining: {
      vaultRecords: db.vaultRecords.filter(
        (record) => record.walletAddress.toLowerCase() === walletKey,
      ).length,
      domainRecords: [
        ...db.invoiceRecords,
        ...db.batchPayoutRecords,
        ...db.agentPaymentIntentRecords,
      ].filter((record) => record.walletAddress.toLowerCase() === walletKey).length,
      extensionRecords: db.extensionRecords.filter(
        (record) =>
          String(record.from || "").toLowerCase() === walletKey ||
          String(record.to || "").toLowerCase() === walletKey,
      ).length,
      agentMemoryRecords: db.agentMemoryRecords.filter(
        (record) =>
          String(record.from || "").toLowerCase() === walletKey ||
          String(record.to || "").toLowerCase() === walletKey,
      ).length,
    },
  };
}

function lowerWalletFields<T extends { from?: string; to?: string }>(record: T): T {
  const next = { ...record };
  if (typeof next.from === "string") next.from = next.from.toLowerCase();
  if (typeof next.to === "string") next.to = next.to.toLowerCase();
  return next;
}

export async function addExtensionRecord(record: PayMemoRecord) {
  const normalized = lowerWalletFields(record);
  const updatedAt = new Date().toISOString();
  if (isSupabaseEnabled()) {
    await supabaseRequest<JsonRecordRow[]>("extension_records?on_conflict=id", {
      method: "POST",
      body: JSON.stringify({ id: normalized.id, record: normalized, updated_at: updatedAt }),
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return normalized;
  }

  await writePayMemoDb((db) => ({
    ...db,
    extensionRecords: [
      normalized,
      ...db.extensionRecords.filter((item) => item.id !== normalized.id),
    ].slice(0, 250),
  }));
  return normalized;
}

export async function listExtensionRecords() {
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<JsonRecordRow[]>(
      "extension_records?select=*&order=updated_at.desc&limit=250",
    );
    return rows.map((row) => row.record);
  }

  const db = await readPayMemoDb();
  return db.extensionRecords;
}

export async function addAgentMemoryRecord(record: PayMemoRecord) {
  const normalized = lowerWalletFields(record);
  const updatedAt = new Date().toISOString();
  if (isSupabaseEnabled()) {
    await supabaseRequest<JsonRecordRow[]>("agent_memory_records?on_conflict=id", {
      method: "POST",
      body: JSON.stringify({ id: normalized.id, record: normalized, updated_at: updatedAt }),
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return normalized;
  }

  await writePayMemoDb((db) => ({
    ...db,
    agentMemoryRecords: [
      normalized,
      ...db.agentMemoryRecords.filter((item) => item.id !== normalized.id),
    ].slice(0, 250),
  }));
  return normalized;
}

export async function listAgentMemoryRecords(filters: {
  agentId?: string | null;
  taskId?: string | null;
}) {
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<JsonRecordRow[]>(
      "agent_memory_records?select=*&order=updated_at.desc&limit=250",
    );
    return rows
      .map((row) => row.record)
      .filter((record) => {
        if (filters.agentId && record.agentId !== filters.agentId) return false;
        if (filters.taskId && record.taskId !== filters.taskId) return false;
        return true;
      });
  }

  const db = await readPayMemoDb();
  return db.agentMemoryRecords.filter((record) => {
    if (filters.agentId && record.agentId !== filters.agentId) return false;
    if (filters.taskId && record.taskId !== filters.taskId) return false;
    return true;
  });
}

function getDomainCollectionName(type: EncryptedDomainRecord["type"]) {
  if (type === "invoice") return "invoiceRecords";
  if (type === "batch-payout") return "batchPayoutRecords";
  return "agentPaymentIntentRecords";
}

export async function upsertEncryptedDomainRecord(record: EncryptedDomainRecord) {
  const stamped: EncryptedDomainRecord = {
    ...record,
    walletAddress: record.walletAddress.toLowerCase(),
    updatedAt: new Date().toISOString(),
  };

  if (isSupabaseEnabled()) {
    const existingRows = await supabaseRequest<DomainRecordRow[]>(
      `paymemo_domain_records?id=eq.${encodeURIComponent(stamped.id)}&select=wallet_address,type&limit=1`,
    ).catch(() => [] as DomainRecordRow[]);
    if (
      existingRows[0] &&
      (existingRows[0].wallet_address.toLowerCase() !== stamped.walletAddress ||
        existingRows[0].type !== stamped.type)
    ) {
      throw new Error("Domain record id is owned by a different wallet or type.");
    }

    const rows = await supabaseRequest<DomainRecordRow[]>("paymemo_domain_records?on_conflict=id", {
      method: "POST",
      body: JSON.stringify(toDomainRow(stamped)),
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return toDomainRecord(rows[0]);
  }

  const current = await readPayMemoDb();
  const collection = getDomainCollectionName(stamped.type);
  const conflicting = current[collection].find(
    (item) => item.id === stamped.id && item.walletAddress.toLowerCase() !== stamped.walletAddress,
  );
  if (conflicting) {
    throw new Error("Domain record id is owned by a different wallet.");
  }
  await writePayMemoDb((db) => ({
    ...db,
    [collection]: [
      stamped,
      ...db[collection].filter(
        (item) => item.id !== stamped.id || item.walletAddress !== stamped.walletAddress,
      ),
    ].slice(0, 500),
  }));

  return stamped;
}

export async function listEncryptedDomainRecords(
  walletAddress: string,
  type: EncryptedDomainRecord["type"],
) {
  const walletKey = walletAddress.toLowerCase();

  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<DomainRecordRow[]>(
      `paymemo_domain_records?wallet_address=eq.${encodeURIComponent(walletKey)}&type=eq.${encodeURIComponent(type)}&select=*&order=updated_at.desc`,
    );
    return rows.map(toDomainRecord);
  }

  const collection = getDomainCollectionName(type);
  const db = await readPayMemoDb();
  return db[collection].filter((record) => record.walletAddress.toLowerCase() === walletKey);
}

export async function listAllEncryptedDomainRecords(walletAddress: string) {
  const walletKey = walletAddress.toLowerCase();

  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<DomainRecordRow[]>(
      `paymemo_domain_records?wallet_address=eq.${encodeURIComponent(walletKey)}&select=*&order=updated_at.desc`,
    );
    return rows.map(toDomainRecord);
  }

  const db = await readPayMemoDb();
  return [...db.invoiceRecords, ...db.batchPayoutRecords, ...db.agentPaymentIntentRecords].filter(
    (record) => record.walletAddress.toLowerCase() === walletKey,
  );
}

export async function getEncryptedDomainRecordById(
  id: string,
  type?: EncryptedDomainRecord["type"],
) {
  if (isSupabaseEnabled()) {
    const typeFilter = type ? `&type=eq.${encodeURIComponent(type)}` : "";
    const rows = await supabaseRequest<DomainRecordRow[]>(
      `paymemo_domain_records?id=eq.${encodeURIComponent(id)}${typeFilter}&select=*&limit=1`,
    );
    return rows[0] ? toDomainRecord(rows[0]) : null;
  }

  const db = await readPayMemoDb();
  const records = [...db.invoiceRecords, ...db.batchPayoutRecords, ...db.agentPaymentIntentRecords];
  return records.find((record) => record.id === id && (!type || record.type === type)) ?? null;
}

export async function patchEncryptedDomainRecordPublicData(
  id: string,
  type: EncryptedDomainRecord["type"],
  patch: { status?: string; publicData?: Record<string, unknown> },
) {
  const current = await getEncryptedDomainRecordById(id, type);
  if (!current) return null;

  const updated: EncryptedDomainRecord = {
    ...current,
    status: patch.status ?? current.status,
    publicData: {
      ...current.publicData,
      ...(patch.publicData ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };

  return upsertEncryptedDomainRecord(updated);
}

function toPairingRow(pairing: ExtensionPairing): ExtensionPairingRow {
  return {
    install_token: pairing.installToken,
    wallet_address: pairing.walletAddress.toLowerCase(),
    created_at: pairing.createdAt,
  };
}

function toPairing(row: ExtensionPairingRow): ExtensionPairing {
  return {
    installToken: row.install_token,
    walletAddress: row.wallet_address,
    createdAt: row.created_at,
  };
}

export async function pairExtensionInstall(installToken: string, walletAddress: string) {
  if (!installToken || installToken.length < 16) {
    throw new Error("Install token too short.");
  }
  const walletKey = walletAddress.toLowerCase();
  const pairing: ExtensionPairing = {
    installToken,
    walletAddress: walletKey,
    createdAt: new Date().toISOString(),
  };

  if (isSupabaseEnabled()) {
    await supabaseRequest<ExtensionPairingRow[]>(
      "extension_pairings?on_conflict=install_token,wallet_address",
      {
        method: "POST",
        body: JSON.stringify(toPairingRow(pairing)),
        prefer: "resolution=merge-duplicates,return=representation",
      },
    );
    return pairing;
  }

  await writePayMemoDb((db) => ({
    ...db,
    extensionPairings: [
      pairing,
      ...db.extensionPairings.filter(
        (item) =>
          item.installToken !== pairing.installToken ||
          item.walletAddress !== pairing.walletAddress,
      ),
    ].slice(0, 2000),
  }));

  return pairing;
}

export async function isExtensionWalletPaired(installToken: string, walletAddress: string) {
  if (!installToken || !walletAddress) return false;
  const walletKey = walletAddress.toLowerCase();

  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<ExtensionPairingRow[]>(
      `extension_pairings?install_token=eq.${encodeURIComponent(installToken)}&wallet_address=eq.${encodeURIComponent(walletKey)}&select=*&limit=1`,
    ).catch(() => [] as ExtensionPairingRow[]);
    return rows.length > 0;
  }

  const db = await readPayMemoDb();
  return db.extensionPairings.some(
    (pair) => pair.installToken === installToken && pair.walletAddress === walletKey,
  );
}

export async function listExtensionPairings(walletAddress: string) {
  const walletKey = walletAddress.toLowerCase();
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<ExtensionPairingRow[]>(
      `extension_pairings?wallet_address=eq.${encodeURIComponent(walletKey)}&select=*`,
    ).catch(() => [] as ExtensionPairingRow[]);
    return rows.map(toPairing);
  }
  const db = await readPayMemoDb();
  return db.extensionPairings.filter((pair) => pair.walletAddress === walletKey);
}

// ---------------------------------------------------------------------------
// Watched wallets - server-side chain-watch list. Owned by the user's connected
// wallet (owner_wallet); contains addresses the cron / on-load scan should sweep.
// ---------------------------------------------------------------------------

type WatchedWalletRow = {
  owner_wallet: string;
  watched_address: string;
  label: string | null;
  enabled: boolean;
  last_scanned_block: number | string;
  created_at: string;
  updated_at: string;
};

function toWatchedWallet(row: WatchedWalletRow): WatchedWallet {
  return {
    ownerWallet: row.owner_wallet,
    watchedAddress: row.watched_address,
    label: row.label ?? "",
    enabled: Boolean(row.enabled),
    lastScannedBlock: Number(row.last_scanned_block ?? 0),
    updatedAt: row.updated_at,
  };
}

export async function upsertWatchedWallet(input: {
  ownerWallet: string;
  watchedAddress: string;
  label?: string;
  enabled?: boolean;
}) {
  const ownerWallet = input.ownerWallet.toLowerCase();
  const watchedAddress = input.watchedAddress.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ownerWallet) || !/^0x[a-f0-9]{40}$/.test(watchedAddress)) {
    throw new Error("Invalid wallet address.");
  }

  const now = new Date().toISOString();
  const record: WatchedWallet = {
    ownerWallet,
    watchedAddress,
    label: (input.label ?? "").slice(0, 80),
    enabled: input.enabled ?? true,
    lastScannedBlock: 0,
    updatedAt: now,
  };

  if (isSupabaseEnabled()) {
    await supabaseRequest<WatchedWalletRow[]>(
      "watched_wallets?on_conflict=owner_wallet,watched_address",
      {
        method: "POST",
        body: JSON.stringify({
          owner_wallet: record.ownerWallet,
          watched_address: record.watchedAddress,
          label: record.label || null,
          enabled: record.enabled,
          updated_at: record.updatedAt,
        }),
        prefer: "resolution=merge-duplicates,return=representation",
      },
    );
    return record;
  }

  await writePayMemoDb((db) => {
    const next = (db.watchedWallets ?? []).filter(
      (item) => item.ownerWallet !== ownerWallet || item.watchedAddress !== watchedAddress,
    );
    return { ...db, watchedWallets: [record, ...next].slice(0, 5000) };
  });
  return record;
}

export async function listWatchedWalletsByOwner(ownerWallet: string) {
  const key = ownerWallet.toLowerCase();
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<WatchedWalletRow[]>(
      `watched_wallets?owner_wallet=eq.${encodeURIComponent(key)}&select=*&order=updated_at.desc`,
    ).catch(() => [] as WatchedWalletRow[]);
    return rows.map(toWatchedWallet);
  }
  const db = await readPayMemoDb();
  return (db.watchedWallets ?? []).filter((item) => item.ownerWallet === key);
}

export async function listEnabledWatchedWallets() {
  if (isSupabaseEnabled()) {
    const rows = await supabaseRequest<WatchedWalletRow[]>(
      `watched_wallets?enabled=eq.true&select=*&order=updated_at.desc&limit=5000`,
    ).catch(() => [] as WatchedWalletRow[]);
    return rows.map(toWatchedWallet);
  }
  const db = await readPayMemoDb();
  return (db.watchedWallets ?? []).filter((item) => item.enabled);
}

export async function deleteWatchedWallet(ownerWallet: string, watchedAddress: string) {
  const owner = ownerWallet.toLowerCase();
  const watched = watchedAddress.toLowerCase();
  if (isSupabaseEnabled()) {
    await supabaseRequest<unknown>(
      `watched_wallets?owner_wallet=eq.${encodeURIComponent(owner)}&watched_address=eq.${encodeURIComponent(watched)}`,
      { method: "DELETE" },
    );
    return { ok: true };
  }
  await writePayMemoDb((db) => ({
    ...db,
    watchedWallets: (db.watchedWallets ?? []).filter(
      (item) => item.ownerWallet !== owner || item.watchedAddress !== watched,
    ),
  }));
  return { ok: true };
}

export async function updateWatchedWalletScanProgress(
  watchedAddress: string,
  lastScannedBlock: number,
) {
  const watched = watchedAddress.toLowerCase();
  const updatedAt = new Date().toISOString();
  if (isSupabaseEnabled()) {
    await supabaseRequest<unknown>(
      `watched_wallets?watched_address=eq.${encodeURIComponent(watched)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          last_scanned_block: lastScannedBlock,
          updated_at: updatedAt,
        }),
        prefer: "return=minimal",
      },
    );
    return;
  }
  await writePayMemoDb((db) => ({
    ...db,
    watchedWallets: (db.watchedWallets ?? []).map((item) =>
      item.watchedAddress === watched ? { ...item, lastScannedBlock, updatedAt } : item,
    ),
  }));
}
