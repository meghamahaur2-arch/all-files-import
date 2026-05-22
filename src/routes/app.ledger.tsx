import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/app/Topbar";
import { StatusBadge } from "@/components/app/StatusBadge";
import { EditRecordModal, type EditableRecord } from "@/components/app/EditRecordModal";
import {
  decryptPrivateMetadata,
  encryptPrivateMetadata,
  getRememberedVaultKey,
  readVaultSession,
} from "@/lib/crypto-vault";
import {
  fetchEncryptedVaultRecords,
  readEncryptedVaultRecords,
  saveEncryptedVaultRecord,
  syncEncryptedVaultRecord,
  type StoredVaultRecord,
} from "@/lib/paymemo-vault";
import { Pencil, Search, Calendar, Filter, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/app/ledger")({
  head: () => ({ meta: [{ title: "Ledger | PayMemo" }] }),
  component: Ledger,
});

type LedgerRow = {
  id: string;
  date: string;
  /** Epoch milliseconds - drives the date-range filter. */
  dateMs: number;
  hash: string;
  amount: string;
  token: string;
  category: string;
  counterparty: string;
  note: string;
  project: string;
  status: string;
  source: "vault";
  raw?: StoredVaultRecord;
};

const cats = [
  "All",
  "Payroll",
  "Vendor Payment",
  "Invoice",
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
];
const statuses = [
  "All",
  "confirmed",
  "pending_signature",
  "pending_chain",
  "failed",
  "needs-review",
  "rejected",
];

// -- Date range presets ----------------------------------------------------
// Each preset is a function from `now` → `{ from, to }` epoch range. `null`
// means "no bound on that side". The financial-year presets use April→March
// (Indian / UK / SG / Japan FY) since that's the most common globally; if
// you want a different FY (Jul-Jun for AU/NZ, Oct-Sep for US federal) just
// add another entry below.

export type DateRangeKey =
  | "all"
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "6m"
  | "12m"
  | "this-month"
  | "last-month"
  | "this-quarter"
  | "ytd"
  | "last-year"
  | "fy"
  | "fy-prev"
  | "custom";

type Range = { from: number | null; to: number | null };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function startOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getTime();
}
function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

const FY_START_MONTH = 3; // 0-indexed: 3 = April. Change to 6=Jul, 9=Oct, etc.

function fyBoundsFor(date: Date): Range {
  const year = date.getMonth() >= FY_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
  return {
    from: startOfMonth(year, FY_START_MONTH),
    to: new Date(year + 1, FY_START_MONTH, 0, 23, 59, 59, 999).getTime(),
  };
}

function rangeForPreset(key: DateRangeKey, now = new Date()): Range {
  const today = startOfDay(now);
  switch (key) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: today, to: endOfDay(now) };
    case "7d":
      return { from: today - 6 * 86_400_000, to: endOfDay(now) };
    case "30d":
      return { from: today - 29 * 86_400_000, to: endOfDay(now) };
    case "90d":
      return { from: today - 89 * 86_400_000, to: endOfDay(now) };
    case "6m":
      return { from: startOfMonth(now.getFullYear(), now.getMonth() - 5), to: endOfDay(now) };
    case "12m":
      return { from: startOfMonth(now.getFullYear() - 1, now.getMonth() + 1), to: endOfDay(now) };
    case "this-month":
      return {
        from: startOfMonth(now.getFullYear(), now.getMonth()),
        to: endOfDay(now),
      };
    case "last-month":
      return {
        from: startOfMonth(now.getFullYear(), now.getMonth() - 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime(),
      };
    case "this-quarter": {
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      return { from: startOfMonth(now.getFullYear(), qStart), to: endOfDay(now) };
    }
    case "ytd":
      return { from: startOfMonth(now.getFullYear(), 0), to: endOfDay(now) };
    case "last-year":
      return {
        from: startOfMonth(now.getFullYear() - 1, 0),
        to: new Date(now.getFullYear(), 0, 0, 23, 59, 59, 999).getTime(),
      };
    case "fy":
      return fyBoundsFor(now);
    case "fy-prev": {
      const prev = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      return fyBoundsFor(prev);
    }
    case "custom":
      return { from: null, to: null }; // resolved from user input separately
  }
}

const DATE_RANGE_OPTIONS: { value: DateRangeKey; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "this-quarter", label: "This quarter" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "ytd", label: "Year to date" },
  { value: "last-year", label: "Last calendar year" },
  { value: "fy", label: "Financial year (Apr-Mar)" },
  { value: "fy-prev", label: "Previous FY (Apr-Mar)" },
  { value: "custom", label: "Custom range…" },
];

function formatRangeLabel(range: Range) {
  if (range.from === null && range.to === null) return "all time";
  const fmt = (ms: number | null) =>
    ms ? new Date(ms).toLocaleDateString() : "…";
  return `${fmt(range.from)} → ${fmt(range.to)}`;
}

function downloadCsv(rows: LedgerRow[]) {
  const csvRows = [
    [
      "date",
      "txHash",
      "amount",
      "token",
      "category",
      "counterparty",
      "privateNote",
      "status",
      "source",
    ],
    ...rows.map((row) => [
      row.date,
      row.hash,
      row.amount,
      row.token,
      row.category,
      row.counterparty,
      row.note,
      row.status,
      row.source,
    ]),
  ];
  const csv = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `paymemo-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Ledger() {
  const [cat, setCat] = useState("All");
  const [status, setStatus] = useState("All");
  const [q, setQ] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState(""); // yyyy-mm-dd
  const [customTo, setCustomTo] = useState("");
  const [vaultRows, setVaultRows] = useState<LedgerRow[]>([]);
  const [editing, setEditing] = useState<LedgerRow | null>(null);
  const [saveStatus, setSaveStatus] = useState("");

  async function loadVaultRows() {
    const key = await getRememberedVaultKey();
    const session = readVaultSession();
    const records = session
      ? await fetchEncryptedVaultRecords(session.walletAddress).catch(() =>
          readEncryptedVaultRecords(),
        )
      : readEncryptedVaultRecords();

    if (!key) {
      const lockedRows: LedgerRow[] = records.map((record) => ({
        id: record.id,
        date: new Date(record.publicRecord.createdAt ?? record.updatedAt).toLocaleDateString(),
        dateMs: new Date(record.publicRecord.createdAt ?? record.updatedAt).getTime(),
        hash: record.publicRecord.txHash ?? "pending",
        amount: record.publicRecord.amount,
        token: record.publicRecord.token,
        category: "Encrypted",
        counterparty: "Unlock vault",
        note: "Private metadata is encrypted on this device.",
        project: "",
        status: record.publicRecord.status,
        source: "vault",
        raw: record,
      }));
      setVaultRows(lockedRows);
      return;
    }

    const decryptedRows = await Promise.all(
      records.map(async (record) => {
        const metadata = await decryptPrivateMetadata<Record<string, string>>(
          record.encryptedMetadata,
          key,
        );
        return {
          id: record.id,
          date: new Date(record.publicRecord.createdAt ?? record.updatedAt).toLocaleDateString(),
        dateMs: new Date(record.publicRecord.createdAt ?? record.updatedAt).getTime(),
          hash: record.publicRecord.txHash ?? "pending",
          amount: record.publicRecord.amount,
          token: record.publicRecord.token,
          category: metadata.category || "Other",
          counterparty: metadata.counterparty || "Unknown",
          note: metadata.note || "",
          project: metadata.project || "",
          status: record.publicRecord.status,
          source: "vault" as const,
          raw: record,
        };
      }),
    );

    setVaultRows(decryptedRows);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      await loadVaultRows();
      if (!alive) return;
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function saveLedgerEdit(patch: EditableRecord) {
    const session = readVaultSession();
    const key = await getRememberedVaultKey();
    if (!session || !key) throw new Error("Please connect wallet before continuing.");

    const target = vaultRows.find((row) => row.id === patch.id);
    if (!target?.raw) throw new Error("Ledger record not found.");

    const existing = await decryptPrivateMetadata<Record<string, string>>(
      target.raw.encryptedMetadata,
      key,
    ).catch(() => ({}) as Record<string, string>);

    const nextMetadata = {
      ...existing,
      category: patch.category,
      counterparty: patch.counterparty,
      note: patch.note,
      project: patch.project,
    };

    const encryptedMetadata = await encryptPrivateMetadata(
      nextMetadata,
      key,
      session.walletAddress,
    );

    const updated: StoredVaultRecord = {
      ...target.raw,
      encryptedMetadata,
      syncStatus: "local",
      updatedAt: new Date().toISOString(),
    };

    saveEncryptedVaultRecord(updated);
    try {
      const synced = await syncEncryptedVaultRecord(updated);
      saveEncryptedVaultRecord({ ...synced.record, syncStatus: "synced" });
    } catch {
      saveEncryptedVaultRecord({ ...updated, syncStatus: "sync-failed" });
    }

    setSaveStatus("Saved. Encrypted update synced to the database.");
    await loadVaultRows();
  }

  const activeRange = useMemo<Range>(() => {
    if (dateRange === "custom") {
      return {
        from: customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : null,
        to: customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : null,
      };
    }
    return rangeForPreset(dateRange);
  }, [dateRange, customFrom, customTo]);

  const rows = useMemo(
    () =>
      vaultRows.filter((t) => {
        if (cat !== "All" && t.category !== cat) return false;
        if (status !== "All" && t.status !== status) return false;
        if (q) {
          const needle = q.toLowerCase();
          const matches =
            t.counterparty.toLowerCase().includes(needle) ||
            t.note.toLowerCase().includes(needle) ||
            t.hash.includes(q);
          if (!matches) return false;
        }
        if (activeRange.from !== null && t.dateMs < activeRange.from) return false;
        if (activeRange.to !== null && t.dateMs > activeRange.to) return false;
        return true;
      }),
    [vaultRows, cat, status, q, activeRange],
  );

  return (
    <>
      <Topbar title="Ledger" subtitle="Your private, encrypted record of every payment." />
      <div className="p-6 lg:p-10 space-y-5">
        <div className="rounded-2xl border border-ink/35 bg-white p-4 shadow-soft flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-ink/35 bg-cream/60 px-3 py-2 flex-1 min-w-[220px]">
            <Search className="h-4 w-4 text-ink/72" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search note, counterparty, hash"
              className="bg-transparent outline-none text-sm w-full"
            />
          </div>
          <Select
            label="Category"
            value={cat}
            onChange={setCat}
            options={cats}
            icon={<Filter className="h-3.5 w-3.5" />}
          />
          <Select
            label="Status"
            value={status}
            onChange={setStatus}
            options={statuses}
            icon={<Filter className="h-3.5 w-3.5" />}
          />
          <label className="inline-flex items-center gap-2 rounded-xl border border-ink/35 bg-cream/60 px-3 py-2 text-sm">
            <Calendar className="h-3.5 w-3.5 text-ink/72" />
            <span className="text-[10px] uppercase tracking-widest text-ink/72">
              Date range
            </span>
            <select
              value={dateRange}
              onChange={(event) => setDateRange(event.target.value as DateRangeKey)}
              className="bg-transparent text-sm font-semibold outline-none"
            >
              {DATE_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {dateRange === "custom" && (
            <div className="inline-flex items-center gap-2 rounded-xl border border-ink/35 bg-cream/60 px-3 py-2 text-sm">
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="bg-transparent text-sm outline-none"
                aria-label="From"
              />
              <span className="text-ink/72">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="bg-transparent text-sm outline-none"
                aria-label="To"
              />
            </div>
          )}

          <button
            onClick={() => downloadCsv(rows)}
            className="ml-auto inline-flex items-center gap-2 rounded-xl bg-ink text-cream px-3 py-2 text-sm font-semibold"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </div>

        {/* Range summary so the user can see what they're filtering by */}
        <div className="text-xs text-ink/72">
          Showing <strong className="text-ink">{rows.length}</strong> of{" "}
          <strong className="text-ink">{vaultRows.length}</strong> records{" "}
          {dateRange !== "all" && (
            <span>
              · range: <strong className="text-ink">{formatRangeLabel(activeRange)}</strong>
            </span>
          )}
        </div>

        <div className="rounded-3xl border border-ink/35 bg-white shadow-soft overflow-x-auto">
          {saveStatus && (
            <div className="border-b border-ink/15 bg-mint/10 px-5 py-2 text-xs font-semibold text-ink">
              {saveStatus}
            </div>
          )}
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-ink/72 bg-cream/60">
                {[
                  "Date",
                  "Tx hash",
                  "Amount",
                  "Category",
                  "Counterparty",
                  "Private note",
                  "Status",
                  "",
                ].map((h, index) => (
                  <th
                    key={`${h}-${index}`}
                    className="text-left font-medium px-5 py-3 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={`${t.source}-${t.id}`}
                  className="border-t border-ink/30 hover:bg-cream/40"
                >
                  <td className="px-5 py-3.5 text-ink/78 whitespace-nowrap">{t.date}</td>
                  <td className="px-5 py-3.5 font-mono text-xs">
                    <span title={t.hash} className="block max-w-[160px] truncate">
                      {t.hash}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 font-mono whitespace-nowrap">
                    {t.amount} <span className="text-ink/72">{t.token}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="inline-block whitespace-nowrap rounded-full border border-ink/35 bg-cream px-2.5 py-0.5 text-[10px] font-medium">
                      {t.category}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">{t.counterparty}</td>
                  <td className="px-5 py-3.5 text-ink/82 align-top">
                    <span className="block min-w-[200px] max-w-[340px] whitespace-normal break-words leading-snug">
                      {t.note}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(t)}
                      className="inline-flex items-center gap-1 rounded-lg border border-ink/25 px-2 py-1 text-xs font-semibold text-ink/82 hover:text-ink"
                      disabled={t.category === "Encrypted"}
                      title={t.category === "Encrypted" ? "Unlock vault to edit" : "Edit record"}
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-16 text-center text-ink/72">
                    No records match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <EditRecordModal
        open={Boolean(editing)}
        initial={
          editing
            ? {
                id: editing.id,
                category: editing.category,
                counterparty: editing.counterparty,
                note: editing.note,
                project: editing.project,
                status: editing.status,
              }
            : null
        }
        onClose={() => setEditing(null)}
        onSave={saveLedgerEdit}
      />
    </>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  icon,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  icon: React.ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2 rounded-xl border border-ink/35 bg-cream/60 px-3 py-2 text-sm">
      {icon}
      <span className="text-ink/75">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
