import { createFileRoute, Link } from "@tanstack/react-router";
import { Topbar } from "@/components/app/Topbar";
import { StatusBadge } from "@/components/app/StatusBadge";
import { WalletConnectModal } from "@/components/app/WalletConnectModal";
import {
  decryptPrivateMetadata,
  getRememberedVaultKey,
  readVaultSession,
  signWatchAuthorization,
} from "@/lib/crypto-vault";
import {
  fetchEncryptedVaultRecords,
  readEncryptedVaultRecords,
  type StoredVaultRecord,
} from "@/lib/paymemo-vault";
import { morphTokens } from "@/lib/morph";
import { parseAmountNumber } from "@/lib/amount-utils";
import {
  readPartnerWallets,
  registerWatchedWalletOnServer,
  removePartnerWallet,
  syncPartnerWalletsToExtension,
  triggerServerCatchUpScan,
  unregisterWatchedWalletOnServer,
  upsertPartnerWallet,
  type PartnerWallet,
} from "@/lib/watched-wallets";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Activity,
  Layers,
  AlertCircle,
  Plus,
  RadioTower,
  Trash2,
  Wallet,
} from "lucide-react";
import { motion } from "framer-motion";
import { PayMemoAreaChart } from "@/components/app/LazyCharts";
import { useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notify";

export const Route = createFileRoute("/app/")({
  head: () => ({ meta: [{ title: "Dashboard | PayMemo" }] }),
  component: Dashboard,
});

type DashboardRow = {
  id: string;
  date: string;
  month: string;
  type: "Sent" | "Received";
  amount: number;
  token: string;
  category: string;
  counterparty: string;
  note: string;
  status: string;
  txHash: string;
};

const stat = (l: string, v: string, sub: string, Icon: LucideIcon, ring: string) => ({
  l,
  v,
  sub,
  Icon,
  ring,
});

function Dashboard() {
  const [walletAddress, setWalletAddress] = useState("");
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [message, setMessage] = useState("Connect wallet before continuing.");
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [partnerWallets, setPartnerWallets] = useState<PartnerWallet[]>([]);
  const [partnerAddress, setPartnerAddress] = useState("");
  const [partnerLabel, setPartnerLabel] = useState("Partner wallet");

  async function loadDashboard() {
    try {
      const session = readVaultSession();
      const key = session ? await getRememberedVaultKey() : null;
      const wallet = session?.walletAddress ?? "";
      const records = wallet
        ? await fetchEncryptedVaultRecords(wallet).catch(() => readEncryptedVaultRecords())
        : [];

      if (!wallet || !key) {
        setWalletAddress(wallet);
        setRows(wallet ? records.map((record) => toLockedRow(record, wallet)) : []);
        setMessage(
          wallet
            ? "Private notes locked. Connect wallet again to unlock notes."
            : "Connect wallet before continuing.",
        );
        return;
      }

      const decrypted = await Promise.all(
        records.map((record) => toDashboardRow(record, key, wallet)),
      );
      setWalletAddress(wallet);
      setRows(decrypted);
      setMessage(`${decrypted.length} encrypted records loaded for ${short(wallet)}.`);

      // Server-side catch-up: scan Morph for anything that happened while
      // the user was offline, then refresh the records once.
      void triggerServerCatchUpScan(wallet).then((result) => {
        if (result && result.detections > 0) {
          notify.info(
            "Caught up on Morph activity",
            `${result.detections} new transaction${result.detections === 1 ? "" : "s"} added to Needs Review.`,
          );
        }
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load dashboard records.");
    }
  }

  useEffect(() => {
    void loadDashboard();
    void loadPrices()
      .then(setPrices)
      .catch(() => setPrices({}));
    const session = readVaultSession();
    setPartnerWallets(readPartnerWallets(session?.walletAddress));
  }, []);

  function connectDashboardWallet() {
    setMessage("Please connect wallet before continuing.");
    setWalletPickerOpen(true);
  }

  async function onWalletConnected(account: string) {
    setWalletAddress(account);
    setPartnerWallets(readPartnerWallets(account));
    setMessage(`Wallet connected and private notes unlocked: ${short(account)}.`);
    await loadDashboard();
    // Server-side: register this wallet so the cron sweeps it even while
    // the user's tab is closed, then kick off an immediate catch-up scan.
    void registerWatchedWalletOnServer({
      ownerWallet: account,
      watchedAddress: account,
      label: "My wallet",
    });
    readPartnerWallets(account).forEach((partner) => {
      void registerWatchedWalletOnServer({
        ownerWallet: account,
        watchedAddress: partner.address,
        label: partner.label,
      });
    });
    void triggerServerCatchUpScan(account);
  }

  async function addPartnerWallet() {
    if (!requireWallet()) return;
    const ownerWallet = (walletAddress || readVaultSession()?.walletAddress || "").toLowerCase();
    if (!ownerWallet) {
      setMessage("Please connect wallet before continuing.");
      return;
    }

    const normalized = partnerAddress.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      setMessage("Enter a valid 0x… EVM address before signing.");
      notify.error("Invalid address", "Wallet address must be 0x + 40 hex chars.");
      return;
    }

    // Friction-on-purpose: require the user to sign an explicit
    // "authorize watching" message with their own wallet before we add a
    // wallet to the watch list. Prevents accidental / unattended adds.
    setMessage("Open your wallet and sign the authorize-watch message…");
    let auth: Awaited<ReturnType<typeof signWatchAuthorization>> | null = null;
    try {
      auth = await signWatchAuthorization({
        ownerWallet,
        watchedAddress: normalized,
        label: partnerLabel,
        intent: normalized === ownerWallet ? "my-wallet" : "partner-wallet",
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "Signature was cancelled.";
      setMessage(`Add cancelled: ${text}`);
      notify.info("Add cancelled", "Signature was rejected - no wallet added.");
      return;
    }

    const next = upsertPartnerWallet(ownerWallet, {
      address: normalized,
      label: partnerLabel,
    });
    setPartnerWallets(next);
    syncPartnerWalletsToExtension(next);
    const just = next.find((wallet) => wallet.address === normalized);
    if (just) {
      void registerWatchedWalletOnServer({
        ownerWallet,
        watchedAddress: just.address,
        label: just.label,
        authSignature: auth.signature,
        authMessage: auth.message,
      });
      void triggerServerCatchUpScan(ownerWallet);
    }
    setPartnerAddress("");
    setPartnerLabel("Partner wallet");
    setMessage(
      "Partner wallet authorized and added. Server-side watcher is now scanning Morph for it.",
    );
    notify.success(
      "Partner wallet added",
      "Signed authorization saved. Server watcher will scan it even when this tab is closed.",
    );
  }

  function deletePartnerWallet(address: string) {
    if (!requireWallet()) return;
    const ownerWallet = walletAddress || readVaultSession()?.walletAddress;
    const next = removePartnerWallet(ownerWallet, address);
    setPartnerWallets(next);
    syncPartnerWalletsToExtension(next);
    if (ownerWallet) {
      void unregisterWatchedWalletOnServer({
        ownerWallet,
        watchedAddress: address,
      });
    }
    setMessage("Partner wallet removed locally and from the server watch list.");
    notify.info("Partner wallet removed", "Watcher list re-synced.");
  }

  function requireWallet() {
    if (walletAddress || readVaultSession()) return true;
    setMessage("Please connect wallet before continuing.");
    notify.walletRequired();
    setWalletPickerOpen(true);
    return false;
  }

  const totals = useMemo(() => {
    const confirmed = rows.filter((row) => row.status === "confirmed");
    return {
      sent: confirmed
        .filter((row) => row.type === "Sent")
        .reduce((sum, row) => sum + row.amount, 0),
      received: confirmed
        .filter((row) => row.type === "Received")
        .reduce((sum, row) => sum + row.amount, 0),
      confirmed: confirmed.length,
      pending: rows.filter((row) =>
        ["intent", "pending_signature", "pending_chain", "signed"].includes(row.status),
      ).length,
      needsReview: rows.filter((row) => row.status === "needs-review").length,
      sentUsd: confirmed
        .filter((row) => row.type === "Sent")
        .reduce((sum, row) => sum + row.amount * (prices[row.token] ?? 0), 0),
      receivedUsd: confirmed
        .filter((row) => row.type === "Received")
        .reduce((sum, row) => sum + row.amount * (prices[row.token] ?? 0), 0),
    };
  }, [prices, rows]);

  const cards = [
    stat(
      "Total Sent",
      formatUsd(totals.sentUsd),
      formatTokenTotal(totals.sent, rows),
      ArrowUpRight,
      "from-pink/20",
    ),
    stat(
      "Total Received",
      formatUsd(totals.receivedUsd),
      formatTokenTotal(totals.received, rows),
      ArrowDownLeft,
      "from-mint/20",
    ),
    stat("Confirmed Records", String(totals.confirmed), "from vault", Layers, "from-ink/15"),
    stat(
      "Pending Intents",
      String(totals.pending),
      "awaiting signature/chain",
      Activity,
      "from-papaya/30",
    ),
    stat("Needs Review", String(totals.needsReview), "unlabeled txs", AlertCircle, "from-pink/20"),
  ];

  const monthly = useMemo(() => {
    const grouped = new Map<string, { m: string; sent: number; received: number }>();
    rows.forEach((row) => {
      const current = grouped.get(row.month) ?? { m: row.month, sent: 0, received: 0 };
      if (row.type === "Sent") current.sent += row.amount;
      else current.received += row.amount;
      grouped.set(row.month, current);
    });
    return [...grouped.values()].sort((a, b) => a.m.localeCompare(b.m));
  }, [rows]);

  const recent = rows.slice(0, 8);

  return (
    <>
      <Topbar title="Dashboard" subtitle={message} />
      <div className="space-y-8 p-6 lg:p-10">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/35 bg-white p-4 shadow-soft">
          <div>
            <div className="text-sm font-semibold">Wallet data</div>
            <div className={`text-xs ${walletAddress ? "text-ink/75" : "text-red-900"}`}>
              {walletAddress ? `Signed vault: ${short(walletAddress)}` : "No wallet vault unlocked"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {walletAddress ? (
              <span className="inline-flex items-center gap-2 rounded-xl border border-mint/40 bg-mint/10 px-3 py-2 text-sm font-semibold text-ink">
                <span className="h-2 w-2 rounded-full bg-mint" />
                Connected · {short(walletAddress)}
              </span>
            ) : (
              <button
                onClick={connectDashboardWallet}
                className="inline-flex items-center gap-2 rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-cream"
              >
                <Wallet className="h-4 w-4" /> Connect wallet
              </button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-mint/30 bg-white p-4 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <RadioTower className="h-4 w-4 text-mint" /> Wallets to watch
              </div>
              <p className="mt-1 text-xs text-ink/75">
                Add the wallets PayMemo should listen to on Morph Hoodi -
                <strong> start with your own</strong>, then add teammate, vendor, or partner
                wallets. Detections appear in{" "}
                <Link to="/app/review" className="underline underline-offset-2 hover:text-ink">
                  Needs Review
                </Link>{" "}
                whether you use the extension or just this dashboard tab.
              </p>
            </div>
            <button
              onClick={() => {
                if (!requireWallet()) return;
                syncPartnerWalletsToExtension(partnerWallets);
                setMessage("Watched wallets pushed to the PayMemo extension (if installed).");
              }}
              className="rounded-xl border border-ink/30 px-3 py-2 text-xs font-semibold"
            >
              Sync to extension
            </button>
          </div>
          {!walletAddress && !readVaultSession() && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-900/25 bg-red-50 p-3 text-sm text-red-900">
              <span>Please connect wallet before continuing.</span>
              <button
                onClick={connectDashboardWallet}
                className="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-cream"
              >
                Connect wallet
              </button>
            </div>
          )}
          <div className="mt-4 grid gap-2 md:grid-cols-[1.2fr_.8fr_auto]">
            <input
              value={partnerAddress}
              onChange={(event) => setPartnerAddress(event.target.value)}
              placeholder="0x partner wallet"
              className="rounded-xl border border-ink/25 bg-cream/60 px-3 py-2 font-mono text-sm outline-none"
            />
            <input
              value={partnerLabel}
              onChange={(event) => setPartnerLabel(event.target.value)}
              placeholder="Partner name"
              className="rounded-xl border border-ink/25 bg-cream/60 px-3 py-2 text-sm outline-none"
            />
            <button
              onClick={addPartnerWallet}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-mint px-3 py-2 text-sm font-semibold text-ink"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {partnerWallets.map((wallet) => (
              <span
                key={wallet.address}
                className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-cream/70 py-1 pl-3 pr-1 text-xs"
              >
                <strong>{wallet.label}</strong>
                <span className="font-mono text-ink/75">{short(wallet.address)}</span>
                <button
                  onClick={() => deletePartnerWallet(wallet.address)}
                  className="grid h-6 w-6 place-items-center rounded-full hover:bg-destructive/10 hover:text-destructive"
                  title="Remove partner wallet"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            {partnerWallets.length === 0 && (
              <span className="text-xs text-ink/68">No partner wallets added yet.</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {cards.map((c, i) => (
            <motion.div
              key={c.l}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="relative overflow-hidden rounded-2xl border border-ink/35 bg-white p-5 shadow-soft"
            >
              <div
                className={`pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br ${c.ring} to-transparent`}
              />
              <div className="relative">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-ink/75">
                  {c.l}
                  <c.Icon className="h-4 w-4 text-ink/78" />
                </div>
                <div className="mt-3 text-3xl font-semibold tracking-tight">{c.v}</div>
                <div className="mt-1 text-xs text-ink/72">{c.sub}</div>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="rounded-3xl border border-ink/35 bg-white p-6 shadow-soft">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Wallet volume</div>
              <div className="text-xs text-ink/72">Computed from confirmed PayMemo records</div>
            </div>
            <div className="flex gap-3 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-pink" />
                Sent
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-mint" />
                Received
              </span>
            </div>
          </div>
          <div className="mt-4 h-64">
            <PayMemoAreaChart data={monthly} />
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl border border-ink/35 bg-white shadow-soft">
          <div className="flex items-center justify-between border-b border-ink/35 px-6 py-4">
            <div>
              <div className="text-sm font-semibold">Recent activity</div>
              <div className="text-xs text-ink/72">Latest entries from your encrypted ledger</div>
            </div>
            <Link
              to="/app/ledger"
              className="rounded-xl border border-ink/30 bg-cream/60 px-3 py-2 text-sm font-semibold"
            >
              Open ledger
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-ink/72">
                <th className="px-6 py-3 text-left font-medium">Date</th>
                <th className="px-6 py-3 text-left font-medium">Type</th>
                <th className="px-6 py-3 text-left font-medium">Counterparty / Note</th>
                <th className="px-6 py-3 text-left font-medium">Category</th>
                <th className="px-6 py-3 text-left font-medium">Amount</th>
                <th className="px-6 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className="border-t border-ink/30 hover:bg-cream/50">
                  <td className="px-6 py-3.5 text-ink/78">{t.date}</td>
                  <td className="px-6 py-3.5">
                    {t.type === "Sent" ? (
                      <span className="inline-flex items-center gap-1 text-pink">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        Sent
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-mint">
                        <ArrowDownLeft className="h-3.5 w-3.5" />
                        Received
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3.5">
                    <div className="font-medium">{t.counterparty}</div>
                    <div className="text-xs text-ink/72">{t.note}</div>
                  </td>
                  <td className="px-6 py-3.5">
                    <span className="rounded-full border border-ink/35 bg-cream px-2 py-0.5 text-[10px] font-medium">
                      {t.category}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 font-mono">
                    {t.amount.toLocaleString(undefined, { maximumFractionDigits: 18 })} {t.token}
                  </td>
                  <td className="px-6 py-3.5">
                    <StatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-sm text-ink/72">
                    No PayMemo records yet. Create a payment intent or tag a wallet-assisted
                    transaction.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <WalletConnectModal
          open={walletPickerOpen}
          onClose={() => setWalletPickerOpen(false)}
          onConnected={(account) => onWalletConnected(account)}
        />
      </div>
    </>
  );
}

async function toDashboardRow(record: StoredVaultRecord, key: CryptoKey, walletAddress: string) {
  const metadata = await decryptPrivateMetadata<Record<string, string>>(
    record.encryptedMetadata,
    key,
  );
  return toRow(record, walletAddress, {
    category: metadata.category || "Other",
    counterparty: metadata.counterparty || "Unknown",
    note: metadata.note || "",
  });
}

function toLockedRow(record: StoredVaultRecord, walletAddress: string): DashboardRow {
  return toRow(record, walletAddress, {
    category: "Encrypted",
    counterparty: "Unlock vault",
    note: "Private metadata is encrypted.",
  });
}

/**
 * Parse an amount string into a finite number, tolerating things like
 * `"0.000001 ETH"` (chain-watch records embed the token symbol), commas
 * (`"1,234.5"`), and stray whitespace. Returns 0 if nothing usable.
 *
 * Shared implementation lives in `src/lib/amount-utils.ts`.
 */

function toRow(
  record: StoredVaultRecord,
  walletAddress: string,
  privateFields: { category: string; counterparty: string; note: string },
): DashboardRow {
  const created = record.publicRecord.createdAt ?? record.updatedAt;
  const from = record.publicRecord.from?.toLowerCase() ?? "";
  const wallet = walletAddress.toLowerCase();
  return {
    id: record.id,
    date: new Date(created).toLocaleDateString(),
    month: created.slice(0, 7),
    type: wallet && from === wallet ? "Sent" : "Received",
    amount: parseAmountNumber(record.publicRecord.amount),
    token: record.publicRecord.token,
    category: privateFields.category,
    counterparty: privateFields.counterparty,
    note: privateFields.note,
    status: record.publicRecord.status,
    txHash: record.publicRecord.txHash ?? "",
  };
}

function formatTokenTotal(value: number, rows: DashboardRow[]) {
  const token = rows.find((row) => row.token)?.token ?? "tokens";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 18 })} ${token}`;
}

function formatUsd(value: number) {
  if (!value) return "$0.00";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

async function loadPrices() {
  const ids = Array.from(new Set(morphTokens.map((token) => token.coingeckoId))).join(",");
  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
  );
  if (!response.ok) return {};
  const payload = (await response.json()) as Record<string, { usd?: number }>;
  return Object.fromEntries(
    morphTokens.map((token) => [token.symbol, payload[token.coingeckoId]?.usd ?? 0]),
  );
}

function short(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
