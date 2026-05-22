import { createFileRoute, Link } from "@tanstack/react-router";
import { Topbar } from "@/components/app/Topbar";
import { StatusBadge } from "@/components/app/StatusBadge";
import { Chrome, Download, FileSearch, PanelRightOpen, RadioTower, RefreshCw } from "lucide-react";
import { useExtensionRecords, type ExtensionRecord } from "@/lib/extension-records";

export const Route = createFileRoute("/app/assist")({
  head: () => ({ meta: [{ title: "Wallet Assist | PayMemo" }] }),
  component: WalletAssist,
});

type SyncedExtensionRecord = ExtensionRecord;

function WalletAssist() {
  const extensionQuery = useExtensionRecords();
  const syncedRecords = (extensionQuery.data ?? []) as SyncedExtensionRecord[];
  const pendingRecords = syncedRecords.filter((record) => record.status !== "confirmed");

  async function loadSyncedRecords() {
    await extensionQuery.refetch();
  }

  return (
    <>
      <Topbar
        title="Wallet Assist"
        subtitle="Extension captures and watched-wallet transactions."
      />
      <div className="space-y-5 p-6 pb-28 lg:p-10 lg:pb-10">
        <section className="grid gap-4 lg:grid-cols-3">
          <Link
            to="/install"
            className="group rounded-3xl border border-mint/40 bg-mint/10 p-5 shadow-soft transition hover:border-mint/70 hover:bg-mint/15"
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Download className="h-4 w-4 text-mint" /> Install extension
            </div>
            <p className="mt-2 text-sm leading-6 text-ink/82">
              Get the PayMemo browser extension for the full experience - popup memo prompts, side
              panel review, and pre-signature capture on any dApp.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-ink group-hover:underline">
              Open install guide <Chrome className="h-3.5 w-3.5" />
            </span>
          </Link>
          <div className="rounded-3xl border border-ink/35 bg-white p-5 shadow-soft">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <RadioTower className="h-4 w-4 text-mint" /> Or skip the extension entirely
            </div>
            <p className="mt-2 text-sm leading-6 text-ink/78">
              PayMemo's server scanner sweeps Morph for your watched wallets every
              few seconds via a background worker. Offline-detected transactions
              wait for you in{" "}
              <Link to="/app/review" className="underline underline-offset-2 hover:text-ink">
                Needs Review
              </Link>{" "}
              with no tab needed.
            </p>
          </div>
          <div className="rounded-3xl border border-ink/35 bg-white p-5 shadow-soft">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <PanelRightOpen className="h-4 w-4" /> Add the memo
            </div>
            <p className="mt-2 text-sm leading-6 text-ink/78">
              When a tx is detected, the extension popup or the dashboard{" "}
              <Link to="/app/review" className="underline underline-offset-2 hover:text-ink">
                Review tab
              </Link>{" "}
              asks <em>what was this for</em>. Save it and the record is yours, encrypted.
            </p>
          </div>
        </section>

        <section className="rounded-3xl border border-ink/35 bg-white shadow-soft overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/35 px-6 py-4">
            <div>
              <div className="text-sm font-semibold">Needs info</div>
              <div className="text-xs text-ink/72">
                Detected transactions waiting for user context
              </div>
            </div>
            <button
              onClick={() => void loadSyncedRecords()}
              className="inline-flex items-center gap-2 rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-cream"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="bg-cream/60 text-[10px] uppercase tracking-widest text-ink/72">
                  {[
                    "Source",
                    "Action",
                    "Chain",
                    "Amount",
                    "Category",
                    "Review source",
                    "Status",
                  ].map((h) => (
                    <th key={h} className="px-5 py-3 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingRecords.map((intent) => (
                  <tr key={intent.id} className="border-t border-ink/30 hover:bg-cream/40">
                    <td className="px-5 py-3.5 font-medium">
                      {intent.provider ?? intent.source ?? "Wallet Assist"}
                    </td>
                    <td className="px-5 py-3.5">
                      <div>{formatAction(intent)}</div>
                      <div className="text-xs text-ink/72">{formatCounterparty(intent)}</div>
                    </td>
                    <td className="px-5 py-3.5 text-ink/78">Morph Hoodi</td>
                    <td className="px-5 py-3.5 font-mono">
                      {intent.amount} {intent.token}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded-full border border-ink/35 bg-cream px-2 py-0.5 text-[10px] font-medium">
                        {intent.category}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-ink/78">
                      {intent.provider === "Morph Chain Watch"
                        ? "Needs user memo"
                        : "Extension capture"}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={intent.status} />
                    </td>
                  </tr>
                ))}
                {pendingRecords.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-sm text-ink/72">
                      No pending assisted intents. Capture a wallet transaction with the extension.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-3xl border border-mint/30 bg-white shadow-soft overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/35 px-6 py-4">
            <div>
              <div className="text-sm font-semibold">Synced extension captures</div>
              <div className="text-xs text-ink/72">
                Records pushed from the browser extension into this dApp session
              </div>
            </div>
            <span className="rounded-full border border-mint/30 bg-mint/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-ink">
              {syncedRecords.length} synced
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="bg-cream/60 text-[10px] uppercase tracking-widest text-ink/72">
                  {[
                    "Origin",
                    "Wallet",
                    "Amount",
                    "Category",
                    "Counterparty",
                    "Private note",
                    "Tx hash",
                    "Status",
                  ].map((h) => (
                    <th key={h} className="px-5 py-3 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {syncedRecords.map((record) => (
                  <tr key={record.id} className="border-t border-ink/30 hover:bg-cream/40">
                    <td className="max-w-[180px] truncate px-5 py-3.5 text-ink/78">
                      {record.source ?? "browser-extension"}
                    </td>
                    <td className="max-w-[180px] truncate px-5 py-3.5 text-ink/78">
                      {record.provider ?? "injected EVM"}
                    </td>
                    <td className="px-5 py-3.5 font-mono">
                      {record.amount} <span className="text-ink/72">{record.token}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded-full border border-ink/35 bg-cream px-2 py-0.5 text-[10px] font-medium">
                        {record.category}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      {record.counterparty ?? formatCounterparty(record)}
                    </td>
                    <td className="max-w-[260px] truncate px-5 py-3.5 text-ink/82">
                      {record.note ?? "No private note synced."}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs">{record.txHash ?? "pending"}</td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={record.status} />
                    </td>
                  </tr>
                ))}
                {syncedRecords.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-12 text-center text-sm text-ink/72">
                      Use the extension popup's Sync button after capturing a transaction.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <a
          href="/app/review"
          className="inline-flex items-center gap-2 rounded-2xl border border-ink/30 bg-white px-4 py-3 text-sm font-semibold shadow-soft"
        >
          <FileSearch className="h-4 w-4" /> Open review queue
        </a>
      </div>
    </>
  );
}

function formatAction(record: SyncedExtensionRecord) {
  if (!record.txHash) return "Captured wallet request";
  if (record.direction === "incoming") return "Received transaction";
  if (record.direction === "outgoing") return "Sent transaction";
  return "Broadcast transaction";
}

function formatCounterparty(record: SyncedExtensionRecord) {
  if (record.direction === "incoming") return record.from ?? "unknown sender";
  return record.to;
}
