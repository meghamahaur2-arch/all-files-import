import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/app/Topbar";
import { Check, ChevronDown, FileSearch, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useExtensionRecords } from "@/lib/extension-records";
import { notify } from "@/lib/notify";
import {
  decryptPrivateMetadata,
  encryptPrivateMetadata,
  getRememberedVaultKey,
  getVaultAuthHeaders,
  readVaultSession,
} from "@/lib/crypto-vault";
import {
  fetchEncryptedVaultRecords,
  readEncryptedVaultRecords,
  saveEncryptedVaultRecord,
  syncEncryptedVaultRecord,
  toPrivateMetadata,
  toPublicRecord,
  type StoredVaultRecord,
} from "@/lib/paymemo-vault";
import { normalizeRecord, payMemoCategories, type PayMemoRecordInput } from "@/lib/paymemo-schema";
import { morphHoodi } from "@/lib/morph";
import { readPartnerWallets, type PartnerWallet } from "@/lib/watched-wallets";

export const Route = createFileRoute("/app/review")({
  head: () => ({ meta: [{ title: "Review Queue | PayMemo" }] }),
  component: ReviewQueue,
});

function ReviewQueue() {
  const extensionQuery = useExtensionRecords();
  const extensionRecords = useMemo<ReviewItem[]>(
    () =>
      (extensionQuery.data ?? [])
        .filter((record) => record.status !== "confirmed")
        .map((record, index) => toReviewItem(record, index)),
    [extensionQuery.data],
  );

  const [activeTab, setActiveTab] = useState<"pending" | "completed">("pending");
  const [ownerWallet, setOwnerWallet] = useState<string>("");
  const [partnerWallets, setPartnerWallets] = useState<PartnerWallet[]>([]);
  const [completedRecords, setCompletedRecords] = useState<ReviewItem[]>([]);
  const [completedStatus, setCompletedStatus] = useState<
    "idle" | "loading" | "loaded" | "locked" | "error"
  >("idle");

  useEffect(() => {
    const session = readVaultSession();
    const owner = (session?.walletAddress ?? "").toLowerCase();
    setOwnerWallet(owner);
    setPartnerWallets(readPartnerWallets(owner || undefined));
  }, []);

  async function loadCompletedRecords() {
    const session = readVaultSession();
    if (!session?.walletAddress) {
      setCompletedRecords([]);
      setCompletedStatus("locked");
      return;
    }
    setCompletedStatus("loading");
    try {
      const key = await getRememberedVaultKey();
      const records = await fetchEncryptedVaultRecords(session.walletAddress).catch(() =>
        readEncryptedVaultRecords(),
      );
      const onlyConfirmed = records.filter((record) => record.publicRecord.status === "confirmed");

      if (!key) {
        const lockedItems = onlyConfirmed.map((record, index) =>
          vaultRecordToReviewItem(record, {}, index),
        );
        setCompletedRecords(lockedItems);
        setCompletedStatus("locked");
        return;
      }

      const decrypted = await Promise.all(
        onlyConfirmed.map(async (record, index) => {
          const metadata = await decryptPrivateMetadata<Record<string, string>>(
            record.encryptedMetadata,
            key,
          ).catch(() => ({}) as Record<string, string>);
          return vaultRecordToReviewItem(record, metadata, index);
        }),
      );
      setCompletedRecords(decrypted);
      setCompletedStatus("loaded");
    } catch (error) {
      console.warn("[paymemo] completed load failed", error);
      setCompletedRecords([]);
      setCompletedStatus("error");
    }
  }

  useEffect(() => {
    if (activeTab === "completed") void loadCompletedRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const visibleRecords = activeTab === "pending" ? extensionRecords : completedRecords;

  const walletBuckets = useMemo(() => {
    const main = ownerWallet ? ownerWallet.toLowerCase() : "";
    const labels = new Map<string, string>();
    if (main) labels.set(main, "My wallet");
    partnerWallets.forEach((wallet) => labels.set(wallet.address.toLowerCase(), wallet.label));

    type Bucket = {
      key: string;
      label: string;
      address: string;
      records: ReviewItem[];
      tone: "main" | "partner" | "unattributed";
    };
    const buckets = new Map<string, Bucket>();

    function addToBucket(
      key: string,
      label: string,
      address: string,
      tone: Bucket["tone"],
      record: ReviewItem,
    ) {
      const current = buckets.get(key);
      if (current) {
        current.records.push(record);
        return;
      }
      buckets.set(key, { key, label, address, tone, records: [record] });
    }

    for (const record of visibleRecords) {
      const from = (record.raw.from ?? "").toLowerCase();
      const to = (record.raw.to ?? "").toLowerCase();
      const matchesMain = main && (from === main || to === main);
      const partnerMatch = (() => {
        const partner = partnerWallets.find((wallet) => {
          const watched = wallet.address.toLowerCase();
          return from === watched || to === watched;
        });
        return partner ? partner.address.toLowerCase() : "";
      })();

      if (matchesMain) {
        addToBucket(main, labels.get(main) ?? "My wallet", main, "main", record);
      } else if (partnerMatch) {
        addToBucket(
          partnerMatch,
          labels.get(partnerMatch) ?? "Partner wallet",
          partnerMatch,
          "partner",
          record,
        );
      } else {
        addToBucket("__unattributed", "Unattributed", "", "unattributed", record);
      }
    }

    const ordered = Array.from(buckets.values()).sort((a, b) => {
      const order = { main: 0, partner: 1, unattributed: 2 };
      return order[a.tone] - order[b.tone];
    });
    return ordered;
  }, [visibleRecords, ownerWallet, partnerWallets]);

  // Collapse state per wallet bucket. Default: main + partners expanded,
  // unattributed collapsed.
  const [collapsedKeys, setCollapsedKeys] = useState<Record<string, boolean>>({});
  const isCollapsed = (key: string) =>
    collapsedKeys[key] ??
    walletBuckets.find((bucket) => bucket.key === key)?.tone === "unattributed";
  const toggleCollapse = (key: string) =>
    setCollapsedKeys((current) => ({
      ...current,
      [key]: !(
        current[key] ?? walletBuckets.find((bucket) => bucket.key === key)?.tone === "unattributed"
      ),
    }));
  const [draft, setDraft] = useState({
    category: "Other",
    counterparty: "",
    note: "",
    project: "",
  });
  const [actionMessage, setActionMessage] = useState("");
  const [activeId, setActiveId] = useState<string>("");
  const active = visibleRecords.find((item) => item.id === activeId) ?? visibleRecords[0];

  useEffect(() => {
    setActiveId((current) =>
      current && visibleRecords.some((record) => record.id === current)
        ? current
        : (visibleRecords[0]?.id ?? ""),
    );
  }, [visibleRecords]);

  async function loadExtensionRecords() {
    await extensionQuery.refetch();
  }

  useEffect(() => {
    if (!active) return;
    setDraft({
      category: active.category,
      counterparty: active.counterparty,
      note: active.note,
      project: active.project,
    });
    setActionMessage("");
  }, [active?.id]);

  async function updateCompletedActive() {
    if (!active || !active.vault) {
      setActionMessage("This record is not editable.");
      return;
    }
    setActionMessage("Re-encrypting and saving…");

    const session = readVaultSession();
    const key = session ? await getRememberedVaultKey() : null;
    if (!session?.walletAddress || !key) {
      setActionMessage("Unlock your vault on the dashboard first.");
      notify.error("Vault locked", "Connect your wallet to edit memos.");
      return;
    }

    try {
      const category = (payMemoCategories as readonly string[]).includes(draft.category)
        ? (draft.category as PayMemoRecordInput["category"])
        : ("Other" as PayMemoRecordInput["category"]);
      const existingMetadata = await decryptPrivateMetadata<Record<string, string>>(
        active.vault.encryptedMetadata,
        key,
      ).catch(() => ({}) as Record<string, string>);

      const merged = {
        ...existingMetadata,
        category,
        counterparty: draft.counterparty,
        note: draft.note,
        project: draft.project,
      };
      const newEncrypted = await encryptPrivateMetadata(merged, key, session.walletAddress);
      const updated: StoredVaultRecord = {
        ...active.vault,
        encryptedMetadata: newEncrypted,
        syncStatus: "local",
        updatedAt: new Date().toISOString(),
      };
      saveEncryptedVaultRecord(updated);
      try {
        await syncEncryptedVaultRecord({ ...updated, syncStatus: "synced" });
        saveEncryptedVaultRecord({ ...updated, syncStatus: "synced" });
      } catch {
        saveEncryptedVaultRecord({ ...updated, syncStatus: "sync-failed" });
      }
      await loadCompletedRecords();
      setActionMessage("Memo updated in your encrypted Ledger.");
      notify.success("Memo updated", "Your Ledger entry was re-encrypted and saved.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Update failed.";
      setActionMessage(text);
      notify.error("Update failed", text);
    }
  }

  async function confirmActive() {
    if (!active) return;
    setActionMessage("Saving review...");

    // Build the canonical confirmed record once, used for both the
    // extension-intent store (review queue source) and the encrypted vault
    // (ledger source).
    const reviewedAt = new Date().toISOString();
    const confirmedPayload = {
      ...active.raw,
      id: active.id,
      ...draft,
      status: "confirmed" as const,
      reviewedAt,
    };

    const response = await fetch("/api/extension-intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Vault auth so the server accepts the write even when the user's
        // wallet has been paired with the browser extension. Without this
        // the endpoint returns 401 "Missing extension install token for
        // paired wallet" because the dApp has no install token of its own.
        ...getVaultAuthHeaders(),
      },
      body: JSON.stringify(confirmedPayload),
    }).catch((networkError) => {
      console.warn("[paymemo] /api/extension-intent fetch failed", networkError);
      return null;
    });

    if (!response?.ok) {
      let detail = "";
      try {
        const text = await response?.text();
        if (text) {
          try {
            const json = JSON.parse(text);
            detail =
              json?.error ||
              (json?.issues
                ? `Validation: ${JSON.stringify(json.issues)}`
                : "") ||
              text.slice(0, 200);
          } catch {
            detail = text.slice(0, 200);
          }
        }
      } catch {
        // ignore
      }
      const status = response ? `HTTP ${response.status}` : "no response (network/CORS)";
      const reason = `${status}${detail ? ` — ${detail}` : ""}`;
      console.error("[paymemo] save review failed:", reason, "payload was:", confirmedPayload);
      setActionMessage(`Could not save this review. ${reason}`);
      notify.error("Could not save review", reason);
      return;
    }

    // Mirror to the encrypted vault so it shows up in /app/ledger as a
    // confirmed entry. Without this, the row only ever lives in
    // `extension_records` and never reaches the ledger view.
    const session = readVaultSession();
    let ledgerSynced: "synced" | "local-only" | "skipped" = "skipped";
    if (session?.walletAddress) {
      try {
        const key = await getRememberedVaultKey();
        if (key) {
          const category = (payMemoCategories as readonly string[]).includes(draft.category)
            ? (draft.category as PayMemoRecordInput["category"])
            : ("Other" as PayMemoRecordInput["category"]);
          const normalized = normalizeRecord({
            ...confirmedPayload,
            chainId: active.raw.chainId ?? morphHoodi.chainId,
            chainName: active.raw.chainName ?? morphHoodi.name,
            mode: "wallet-assist",
            source: active.raw.source ?? "needs-review",
            to: active.raw.to || session.walletAddress,
            amount: active.raw.amount || "0",
            token: active.raw.token || "ETH",
            category,
          });
          const encryptedMetadata = await encryptPrivateMetadata(
            toPrivateMetadata(normalized),
            key,
            session.walletAddress,
          );
          const stored: StoredVaultRecord = {
            id: normalized.id ?? active.id,
            walletAddress: session.walletAddress,
            publicRecord: toPublicRecord(normalized),
            encryptedMetadata,
            syncStatus: "local",
            updatedAt: reviewedAt,
          };
          saveEncryptedVaultRecord(stored);
          ledgerSynced = "local-only";
          try {
            await syncEncryptedVaultRecord({ ...stored, syncStatus: "synced" });
            saveEncryptedVaultRecord({ ...stored, syncStatus: "synced" });
            ledgerSynced = "synced";
          } catch {
            saveEncryptedVaultRecord({ ...stored, syncStatus: "sync-failed" });
          }
        }
      } catch (error) {
        console.warn("[paymemo] vault mirror failed", error);
      }
    }

    await extensionQuery.refetch();
    setActionMessage(
      ledgerSynced === "synced"
        ? "Recorded. Saved to your encrypted Ledger as confirmed."
        : ledgerSynced === "local-only"
          ? "Recorded locally. Sync to your Ledger failed — try again from /app/ledger."
          : "Recorded. Unlock your vault on the dashboard to also save this to the Ledger.",
    );
    notify.success(
      "Review recorded",
      ledgerSynced === "synced"
        ? "Confirmed — view it in your Ledger."
        : "Confirmed in the review queue.",
    );
  }

  return (
    <>
      <Topbar
        title="Review Queue"
        subtitle="Confirm unclear transaction meaning before it enters the vault."
      />
      <div className="grid gap-6 overflow-x-hidden p-6 pb-28 lg:grid-cols-[minmax(0,1fr)_440px] lg:p-10">
        <section className="overflow-hidden rounded-3xl border border-ink/35 bg-white shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/25 px-5 py-4">
            <div>
              <div className="text-sm font-semibold">
                {activeTab === "pending" ? "Payments to review" : "Completed transactions"}
              </div>
              <div className="text-xs text-ink/72">
                {activeTab === "pending"
                  ? "Click a transaction, add context, then record it."
                  : "Edit the memo on any past transaction — they're already in your encrypted Ledger."}
              </div>
            </div>
            <button
              onClick={() =>
                activeTab === "pending" ? void loadExtensionRecords() : void loadCompletedRecords()
              }
              className="inline-flex items-center gap-2 rounded-xl border border-ink/25 px-3 py-2 text-xs font-semibold"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>

          {/* Pending / Completed tab pills */}
          <div className="flex items-center gap-2 border-b border-ink/15 px-5 py-3">
            {(["pending", "completed"] as const).map((tab) => {
              const isActive = activeTab === tab;
              const count = tab === "pending" ? extensionRecords.length : completedRecords.length;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab);
                    setActiveId("");
                  }}
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    isActive
                      ? tab === "pending"
                        ? "bg-papaya/30 text-ink"
                        : "bg-mint/25 text-ink"
                      : "border border-ink/15 bg-white text-ink/72 hover:bg-cream/60"
                  }`}
                >
                  <span className="capitalize">{tab}</span>
                  <span
                    className={`rounded-full px-1.5 text-[10px] ${
                      isActive ? "bg-ink/15 text-ink" : "bg-ink/8 text-ink/68"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="divide-y divide-ink/15">
            {walletBuckets.map((bucket) => {
              const collapsed = isCollapsed(bucket.key);
              const toneStyles =
                bucket.tone === "main"
                  ? "border-mint/40 bg-mint/10 text-ink"
                  : bucket.tone === "partner"
                    ? "border-pink/40 bg-pink/10 text-ink"
                    : "border-ink/15 bg-cream/50 text-ink/78";
              return (
                <div key={bucket.key}>
                  <button
                    type="button"
                    onClick={() => toggleCollapse(bucket.key)}
                    className={`flex w-full items-center justify-between gap-3 border-b border-ink/15 px-5 py-3 text-left transition-colors hover:bg-cream/40 ${toneStyles}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                          bucket.tone === "main"
                            ? "border-mint/60 bg-mint/20 text-ink"
                            : bucket.tone === "partner"
                              ? "border-pink/60 bg-pink/20 text-ink"
                              : "border-ink/30 bg-cream/70 text-ink/80"
                        }`}
                      >
                        {bucket.tone === "main"
                          ? "My wallet"
                          : bucket.tone === "partner"
                            ? "Partner"
                            : "Unattributed"}
                      </span>
                      <span className="truncate font-semibold text-sm">{bucket.label}</span>
                      {bucket.address && (
                        <span className="truncate font-mono text-[11px] text-ink/72">
                          {bucket.address.slice(0, 6)}…{bucket.address.slice(-4)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-papaya/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ink">
                        {bucket.records.length} pending
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
                      />
                    </div>
                  </button>
                  {!collapsed &&
                    bucket.records.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setActiveId(item.id)}
                        className={`block w-full p-5 text-left transition-colors ${
                          active?.id === item.id ? "bg-mint/10" : "bg-white hover:bg-cream/60"
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-ink/68">
                              <FileSearch className="h-3.5 w-3.5" /> {item.source}
                            </div>
                            <div className="mt-2 text-lg font-semibold">{item.publicFact}</div>
                            <div className="mt-1 text-xs text-ink/75">{item.localDateTime}</div>
                            <div className="mt-1 truncate font-mono text-xs text-ink/68">
                              {item.hash}
                            </div>
                          </div>
                          <span className="rounded-full border border-papaya/40 bg-papaya/15 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-ink">
                            Needs review
                          </span>
                        </div>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
          {visibleRecords.length === 0 && activeTab === "pending" && (
            <div className="rounded-3xl border border-ink/35 bg-white p-8 text-center text-sm text-ink/75 shadow-soft">
              No review items yet. Two ways to get one:{" "}
              <a href="/install" className="font-semibold text-ink underline underline-offset-2">
                install the extension
              </a>{" "}
              and capture a wallet tx, or open the{" "}
              <a href="/app" className="font-semibold text-ink underline underline-offset-2">
                dashboard
              </a>{" "}
              and enable <em>Browser chain watch</em> to scan Morph Hoodi from this tab.
            </div>
          )}
          {visibleRecords.length === 0 && activeTab === "completed" && (
            <div className="rounded-3xl border border-ink/35 bg-white p-8 text-center text-sm text-ink/75 shadow-soft">
              {completedStatus === "loading"
                ? "Loading completed transactions…"
                : completedStatus === "locked"
                  ? "Unlock your vault on the dashboard to view completed transactions."
                  : "No completed transactions yet. Pay from /app/send or confirm a pending review to populate this tab."}
            </div>
          )}
        </section>

        <aside className="min-w-0 overflow-hidden rounded-3xl border border-ink/35 bg-white p-6 shadow-card">
          {active ? (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-mint">
                Review selected payment
              </div>
              <h2 className="mt-2 break-all text-xl font-semibold leading-snug">
                {active.publicFact}
              </h2>
              <div className="mt-4 space-y-3 text-sm">
                <ReviewRow label="Detected" value={active.localDateTime} />
                <ReviewRow label="From" value={active.raw.from ?? "unknown"} mono />
                <ReviewRow label="To" value={active.raw.to} mono />
                <ReviewRow label="Tx hash" value={active.hash} mono />
                <ReviewRow label="Status" value={active.status} />
              </div>

              <label className="mt-5 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/72">
                  Category
                </span>
                <select
                  value={draft.category}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, category: event.target.value }))
                  }
                  className="mt-2 w-full rounded-2xl border border-ink/25 bg-cream/60 p-3 text-sm outline-none focus:border-mint"
                >
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </label>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/72">
                  Counterparty
                </span>
                <input
                  value={draft.counterparty}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, counterparty: event.target.value }))
                  }
                  className="mt-2 w-full rounded-2xl border border-ink/25 bg-cream/60 p-3 text-sm outline-none focus:border-mint"
                />
              </label>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/72">
                  Private note
                </span>
                <textarea
                  value={draft.note}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, note: event.target.value }))
                  }
                  className="mt-2 min-h-28 w-full rounded-2xl border border-ink/25 bg-cream/60 p-3 text-sm outline-none focus:border-mint"
                />
              </label>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/72">
                  Invoice, project, or task
                </span>
                <input
                  value={draft.project}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, project: event.target.value }))
                  }
                  className="mt-2 w-full rounded-2xl border border-ink/25 bg-cream/60 p-3 text-sm outline-none focus:border-mint"
                />
              </label>

              <button
                onClick={activeTab === "completed" ? updateCompletedActive : confirmActive}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-ink py-3 text-sm font-semibold text-cream"
              >
                <Check className="h-4 w-4" />
                {activeTab === "completed" ? "Update memo" : "Record review"}
              </button>
              {actionMessage && (
                <p className="mt-3 text-xs leading-5 text-ink/75">{actionMessage}</p>
              )}
            </>
          ) : (
            <div className="text-sm text-ink/75">No transaction selected.</div>
          )}
        </aside>
      </div>
    </>
  );
}

const categories = [
  "Payroll",
  "Vendor Payment",
  "Invoice Payment",
  "Bridge",
  "Swap",
  "Business Expense",
  "Refund",
  "Personal",
  "Transfer to Self",
  "Income",
  "Subscription",
  "API Payment",
  "Agent Task Payment",
  "Other",
];

function toReviewItem(record: SyncedRecord, index: number): ReviewItem {
  const id = record.id ?? `extension-${index}`;
  return {
    id,
    source: record.provider ?? record.source ?? "Wallet Assist",
    publicFact: formatPublicFact(record),
    hash: record.txHash ?? "pending",
    category: record.category ?? "Other",
    counterparty:
      record.counterparty ?? (record.direction === "incoming" ? (record.from ?? "") : record.to),
    note: record.note ?? "",
    project: record.project ?? "",
    status: record.status,
    localDateTime: formatLocalDateTime(record.confirmedAt ?? record.updatedAt ?? record.createdAt),
    raw: record,
    vault: undefined,
  };
}

/**
 * Adapt a (possibly decrypted) `StoredVaultRecord` into the same
 * `ReviewItem` shape the list expects. When `metadata` is empty the
 * record stays "locked" — fields render as encrypted but the row still
 * shows in the Completed tab so the user knows it exists.
 */
function vaultRecordToReviewItem(
  record: StoredVaultRecord,
  metadata: Record<string, string>,
  index: number,
): ReviewItem {
  const fakeSynced: SyncedRecord = {
    id: record.id,
    chainId: record.publicRecord.chainId,
    chainName: record.publicRecord.chainName,
    source: record.publicRecord.source ?? "vault",
    provider: record.publicRecord.source ?? "PayMemo Vault",
    txHash: record.publicRecord.txHash,
    from: record.publicRecord.from,
    to: record.publicRecord.to,
    amount: record.publicRecord.amount,
    token: record.publicRecord.token,
    category: metadata.category ?? "Other",
    counterparty: metadata.counterparty ?? "",
    note: metadata.note ?? "",
    project: metadata.project ?? "",
    method: "vault",
    status: record.publicRecord.status,
    createdAt: record.publicRecord.createdAt,
    updatedAt: record.updatedAt,
    confirmedAt: record.publicRecord.confirmedAt,
  };
  const item = toReviewItem(fakeSynced, index);
  item.vault = record;
  return item;
}

type ReviewItem = {
  id: string;
  source: string;
  publicFact: string;
  hash: string;
  category: string;
  counterparty: string;
  note: string;
  project: string;
  status: string;
  localDateTime: string;
  raw: SyncedRecord;
  /** If this item came from the Completed tab, the underlying vault row
   *  so we can re-encrypt + PATCH on save. */
  vault?: StoredVaultRecord;
};

type SyncedRecord = {
  id?: string;
  mode?: string;
  chainId?: number;
  chainName?: string;
  source?: string;
  provider?: string;
  txHash?: string;
  from?: string;
  to: string;
  amount: string;
  token: string;
  category?: string;
  counterparty?: string;
  note?: string;
  project?: string;
  direction?: "incoming" | "outgoing";
  method?: string;
  rawValue?: string;
  callData?: string;
  tokenContract?: string;
  transactionType?: "native" | "erc20" | "contract-call";
  blockNumber?: string;
  confirmedAt?: string;
  detectionTiming?: string;
  reviewedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  status: string;
};

function formatLocalDateTime(value?: string) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPublicFact(record: SyncedRecord) {
  const amount = formatAmount(record.amount, record.token);
  if (record.direction === "incoming") return `${amount} from ${record.from ?? "unknown sender"}`;
  return `${amount} to ${record.to}`;
}

function formatAmount(amount: string, token: string) {
  const value = String(amount || "contract call");
  if (!token || value.toLowerCase().includes(token.toLowerCase())) return value;
  return `${value} ${token}`;
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b border-ink/20 pb-2">
      <div className="text-[10px] uppercase tracking-widest text-ink/68">{label}</div>
      <div className={`mt-1 min-w-0 break-all leading-6 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </div>
    </div>
  );
}
