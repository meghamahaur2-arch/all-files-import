import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/app/Topbar";
import { WalletConnectModal } from "@/components/app/WalletConnectModal";
import {
  getErc20Balance,
  getMorphTokenContract,
  getNativeBalance,
  morphTokens,
  isAddress,
  morphHoodi,
  sendErc20Payment,
  sendNativePayment,
  shortAddress,
  waitForTransactionReceipt,
} from "@/lib/morph";
import {
  deriveVaultKey,
  encryptPrivateMetadata,
  getRememberedVaultKey,
  rememberVaultSession,
  readVaultSession,
  signVaultUnlock,
} from "@/lib/crypto-vault";
import {
  saveEncryptedVaultRecord,
  syncEncryptedVaultRecord,
  toPrivateMetadata,
  toPublicRecord,
} from "@/lib/paymemo-vault";
import { createRecordId, normalizeRecord } from "@/lib/paymemo-schema";
import {
  Lock,
  Wand2,
  Wallet,
  Plus,
  Trash2,
  Search,
  Shield,
  ChevronDown,
  ArrowDown,
  Network,
  Check,
  X,
  Info,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notify";

export const Route = createFileRoute("/app/send")({
  head: () => ({ meta: [{ title: "Send Payment · PayMemo" }] }),
  component: Send,
});

type Asset = {
  symbol: "ETH" | "USDC" | "WETH" | "BGB";
  name: string;
  type: "stable" | "native" | "token" | "nft";
  chain: string;
  decimals: number;
  contractAddress: string;
  envContractKey?: string;
  hoodiStatus: "native" | "official" | "env-required";
  note: string;
};

const ASSETS: Asset[] = morphTokens.map((token) => ({
  ...token,
  chain: "Morph Hoodi",
  contractAddress: getMorphTokenContract(token.symbol),
}));

const CATS = [
  "Payroll",
  "Vendor Payment",
  "Invoice",
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

type Recipient = { id: string; address: string; name: string; amount: string; note: string };

function newRecipient(): Recipient {
  return {
    id: Math.random().toString(36).slice(2, 9),
    address: "",
    name: "",
    amount: "",
    note: "",
  };
}

type FlowStep = "idle" | "intent" | "signature" | "chain" | "confirmed" | "failed";

function Send() {
  // Batch mode lives at /app/batch - this page is single-send only. We keep
  // the variable so the existing `mode === "batch"` branches stay tree-shake
  // friendly without TS narrowing them to dead-code comparisons.
  const mode = "single" as "single" | "batch";
  const [walletAddress, setWalletAddress] = useState("");
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [walletMessage, setWalletMessage] = useState(
    "Connect a wallet to prepare Morph Hoodi signing.",
  );
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [asset, setAsset] = useState<Asset>(
    ASSETS.find((item) => item.symbol === "ETH") ?? ASSETS[0],
  );
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [flowStep, setFlowStep] = useState<FlowStep>("idle");
  const [flowMessage, setFlowMessage] = useState(
    "Intent not saved yet. Please connect wallet before continuing.",
  );
  const [txHash, setTxHash] = useState("");
  const [sending, setSending] = useState(false);

  const [cat, setCat] = useState("Vendor Payment");
  const [tag, setTag] = useState("");

  const [single, setSingle] = useState<Recipient>({
    id: "s1",
    address: "",
    name: "",
    amount: "0.0001",
    note: "",
  });
  const [batch, setBatch] = useState<Recipient[]>([
    {
      id: "b1",
      address: "",
      name: "",
      amount: "0.0001",
      note: "",
    },
  ]);

  const filteredAssets = useMemo(
    () =>
      ASSETS.filter((a) => `${a.symbol} ${a.name}`.toLowerCase().includes(search.toLowerCase())),
    [search],
  );

  const totalAmount =
    mode === "single"
      ? Number(single.amount || 0)
      : batch.reduce((s, r) => s + Number(r.amount || 0), 0);
  const connected = Boolean(walletAddress);
  const assetBalance = balances[asset.symbol] ?? "";
  const canTransferAsset = asset.symbol === "ETH" || isAddress(asset.contractAddress);
  const lifecycleOn = {
    Intent: flowStep !== "idle",
    Sign: ["signature", "chain", "confirmed"].includes(flowStep),
    Verify: ["chain", "confirmed"].includes(flowStep),
    Vault: flowStep === "confirmed",
  };

  const prepareWallet = async () => {
    setWalletMessage("Please connect wallet before continuing.");
    setWalletPickerOpen(true);
  };

  // Hydrate from the global vault session (set by `/app` or any other connect
  // flow) so the user doesn't have to reconnect just to open /app/send.
  useEffect(() => {
    const session = readVaultSession();
    if (!session?.walletAddress) return;
    setWalletAddress(session.walletAddress);
    setWalletMessage(
      `Wallet connected from a prior step: ${session.walletAddress.slice(0, 6)}…${session.walletAddress.slice(-4)}.`,
    );
    void loadTokenBalances(session.walletAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onWalletConnected(account: string) {
    setWalletAddress(account);
    setWalletMessage("Wallet connected and switched to Morph Hoodi.");
    await loadTokenBalances(account);
  }

  const loadTokenBalances = async (account: string) => {
    const next: Record<string, string> = {};
    await Promise.all(
      ASSETS.map(async (item) => {
        try {
          if (item.symbol === "ETH") {
            next[item.symbol] = await getNativeBalance(account);
            return;
          }
          if (isAddress(item.contractAddress)) {
            next[item.symbol] = await getErc20Balance({
              owner: account,
              tokenContract: item.contractAddress,
              decimals: item.decimals,
            });
          }
        } catch {
          next[item.symbol] = "";
        }
      }),
    );
    setBalances(next);
  };

  const saveEncryptedRecord = async (
    id: string,
    status: "pending_signature" | "pending_chain" | "confirmed" | "failed",
    vaultKey: CryptoKey,
    account: string,
    hash = "",
  ) => {
    const recipient = mode === "single" ? single : batch[0];
    const normalized = normalizeRecord({
      id,
      mode: "direct",
      status,
      chainId: morphHoodi.chainId,
      chainName: morphHoodi.name,
      txHash: hash || undefined,
      from: account,
      to: recipient.address,
      amount: mode === "single" ? single.amount : String(totalAmount),
      token: asset.symbol,
      category: cat as Parameters<typeof normalizeRecord>[0]["category"],
      counterparty: recipient.name,
      note:
        mode === "single"
          ? single.note
          : `${batch.length} payout items. ${batch.map((item) => `${item.name}: ${item.amount}`).join("; ")}`,
      project: tag,
      source: "paymemo-dapp",
    });

    const encryptedMetadata = await encryptPrivateMetadata(
      toPrivateMetadata(normalized),
      vaultKey,
      account,
    );

    const stored = saveEncryptedVaultRecord({
      id: normalized.id ?? "",
      walletAddress: account,
      publicRecord: toPublicRecord(normalized),
      encryptedMetadata,
      syncStatus: "local",
      updatedAt: new Date().toISOString(),
    });

    try {
      const synced = await syncEncryptedVaultRecord(stored);
      saveEncryptedVaultRecord({ ...synced.record, syncStatus: "synced" });
    } catch {
      saveEncryptedVaultRecord({ ...stored, syncStatus: "sync-failed" });
    }

    return normalized;
  };

  const createIntentAndSend = async () => {
    if (sending) return;

    try {
      setSending(true);
      setTxHash("");
      setFlowStep("intent");

      if (!walletAddress) {
        setWalletMessage("Please connect wallet before continuing.");
        setFlowMessage("Please connect wallet before continuing.");
        setWalletPickerOpen(true);
        notify.walletRequired();
        return;
      }

      const account = walletAddress;
      setWalletAddress(account);
      setWalletMessage("Wallet connected. Unlock the PayMemo vault to encrypt this intent.");

      const recipient = mode === "single" ? single : batch[0];
      if (!recipient.address || !isAddress(recipient.address)) {
        throw new Error("Enter a full recipient address before signing.");
      }
      if (!recipient.amount || Number(recipient.amount) <= 0) {
        throw new Error("Enter a positive amount before signing.");
      }

      const intentId = createRecordId("intent");
      const session = readVaultSession();
      const vaultKey =
        session?.walletAddress.toLowerCase() === account.toLowerCase()
          ? await getRememberedVaultKey()
          : null;
      const key =
        vaultKey ??
        (await (async () => {
          const signature = await signVaultUnlock(account);
          rememberVaultSession(account, signature);
          return deriveVaultKey(signature, account);
        })());

      await saveEncryptedRecord(intentId, "pending_signature", key, account);
      setFlowStep("signature");
      setFlowMessage("Encrypted pending intent saved. Waiting for wallet signature.");

      let hash = "";
      if (!canTransferAsset) {
        throw new Error(
          `${asset.symbol} is visible for PayMemo records, but no Morph Hoodi contract is configured for live transfers.`,
        );
      }

      if (asset.symbol === "ETH") {
        hash = await sendNativePayment(account, recipient.address, recipient.amount);
      } else {
        const tokenContract = asset.contractAddress;
        if (!tokenContract) {
          throw new Error(
            `${asset.symbol} contract address is not configured. Use ETH for the live Morph Hoodi demo or set ${asset.envContractKey}.`,
          );
        }
        hash = await sendErc20Payment({
          from: account,
          tokenContract,
          to: recipient.address,
          amount: recipient.amount,
          decimals: asset.decimals ?? 6,
        });
      }

      setTxHash(hash);
      // Tell the PayMemo extension (if installed) that this tx is already
      // memo'd by the dApp itself, so its chain watcher doesn't pop up a
      // duplicate review prompt for the same hash.
      if (typeof window !== "undefined") {
        window.postMessage(
          {
            type: "PAYMEMO_DAPP_TX_HANDLED",
            txHash: hash,
            origin: "paymemo-dapp-send",
          },
          window.location.origin,
        );
      }
      await saveEncryptedRecord(intentId, "pending_chain", key, account, hash);
      setFlowStep("chain");
      setFlowMessage("Transaction submitted. Waiting for Morph Hoodi receipt confirmation.");

      const receipt = await waitForTransactionReceipt(hash);
      if (receipt.status !== "0x1") {
        await saveEncryptedRecord(intentId, "failed", key, account, hash);
        setFlowStep("failed");
        setFlowMessage("Morph returned a failed receipt. The record stays marked failed.");
        notify.error("Transaction failed onchain", "Morph returned a failed receipt.");
        return;
      }

      await saveEncryptedRecord(intentId, "confirmed", key, account, hash);
      setFlowStep("confirmed");
      setFlowMessage("Confirmed onchain and saved to your encrypted private ledger.");
      notify.success("Payment confirmed", "Saved to your encrypted ledger.");
    } catch (error) {
      setFlowStep("failed");
      const text = error instanceof Error ? error.message : "Unable to create PayMemo intent.";
      setFlowMessage(text);
      notify.error("Send failed", text);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Topbar title="Send Payment" subtitle="Create a test payment with private context." />

      <div className="p-6 lg:p-10 grid lg:grid-cols-[1fr_440px] gap-8">
        <div className="space-y-8">
          {/* Wallet / Network bar */}
          <div className="rounded-3xl border border-ink/25 bg-white p-4 shadow-float ring-1 ring-ink/10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={prepareWallet}
                className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold border transition-colors ${connected ? "bg-cream/70 border-ink/35 text-ink" : "bg-ink text-cream border-ink"}`}
              >
                <Wallet className="h-4 w-4" />
                {connected ? shortAddress(walletAddress) : "Connect Wallet"}
              </button>
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-mint/15 border border-mint/30 text-ink">
                <Network className="h-3 w-3" /> Morph Hoodi
              </span>
              <span className="hidden md:inline-flex items-center gap-1 text-xs text-ink/75">
                <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse-glow" /> Live Morph
                RPC
              </span>
            </div>
            <button
              type="button"
              onClick={prepareWallet}
              className="rounded-xl border border-ink/25 bg-cream/70 px-3 py-2 text-xs font-semibold text-ink/82 hover:text-ink"
            >
              Choose wallet
            </button>
            <div className="basis-full text-xs font-semibold text-red-900">{walletMessage}</div>
          </div>

          {/* Single-send only. For multi-recipient flows see /app/batch. */}

          {/* Form card */}
          <div className="rounded-3xl border border-ink/25 bg-ink/[0.025] shadow-float ring-1 ring-ink/10 overflow-hidden">
            {/* Asset picker bar */}
            <div className="px-7 pt-7 pb-2 flex items-center justify-between gap-4">
              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-ink/75">
                  Paying with
                </div>
                <button
                  onClick={() => setAssetPickerOpen(true)}
                  className="mt-2 inline-flex items-center gap-2 rounded-2xl bg-cream/70 px-4 py-2.5 text-sm hover:bg-cream transition-colors"
                >
                  <AssetIcon symbol={asset.symbol} />
                  <span className="font-semibold">{asset.symbol}</span>
                  <span className="text-ink/72">{asset.name}</span>
                  <ChevronDown className="h-4 w-4 text-ink/65" />
                </button>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-ink/75">
                  Available
                </div>
                <div className="mt-2 font-mono text-sm font-semibold">
                  {assetBalance
                    ? `${assetBalance} ${asset.symbol}`
                    : connected
                      ? "Not loaded"
                      : "Connect wallet"}
                </div>
                <div className="text-[11px] text-ink/72 font-mono">
                  {asset.hoodiStatus === "env-required"
                    ? `${asset.envContractKey} required`
                    : asset.hoodiStatus === "official"
                      ? "Official Hoodi token"
                      : "Native token"}
                </div>
              </div>
            </div>
            <div className="mx-7 h-px bg-ink/10" />

            {/* Single mode */}
            {mode === "single" && (
              <div className="px-7 pt-8 pb-4 space-y-7">
                <div className="grid sm:grid-cols-2 gap-6">
                  <Field label="Recipient address or ENS">
                    <input
                      value={single.address}
                      onChange={(e) => setSingle({ ...single, address: e.target.value })}
                      placeholder="0x... or vitalik.eth"
                      className="input"
                    />
                  </Field>
                  <Field label="Counterparty name (private)">
                    <input
                      value={single.name}
                      onChange={(e) => setSingle({ ...single, name: e.target.value })}
                      className="input"
                    />
                  </Field>
                </div>

                <Field label="Amount">
                  <div className="rounded-2xl border border-ink/25 bg-white p-5 shadow-soft transition-shadow focus-within:border-mint focus-within:shadow-glow-mint">
                    <div className="flex items-baseline justify-between gap-3">
                      <input
                        value={single.amount}
                        onChange={(e) =>
                          setSingle({ ...single, amount: e.target.value.replace(/[^0-9.]/g, "") })
                        }
                        placeholder="0.00"
                        inputMode="decimal"
                        className="w-full bg-transparent text-3xl font-semibold tracking-tight font-mono outline-none placeholder:text-ink/55"
                      />
                      <span className="text-sm font-semibold">{asset.symbol}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-ink/75">
                      <span className="font-mono">Morph Hoodi {asset.symbol} · editable</span>
                      <div className="flex items-center gap-1.5">
                        {[25, 50, 75, 100].map((p) => (
                          <button
                            key={p}
                            type="button"
                            disabled={!assetBalance}
                            onClick={() =>
                              setSingle({
                                ...single,
                                amount: String((Number(assetBalance || 0) * p) / 100),
                              })
                            }
                            className="rounded-md border border-ink/15 bg-white px-2 py-0.5 text-[10px] font-semibold text-ink/82 shadow-soft hover:border-ink/40 disabled:opacity-40"
                          >
                            {p === 100 ? "MAX" : `${p}%`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </Field>

                <Field label="Private note (encrypted)">
                  <textarea
                    value={single.note}
                    onChange={(e) => setSingle({ ...single, note: e.target.value })}
                    rows={2}
                    className="input resize-none"
                  />
                </Field>
              </div>
            )}

            {/* Batch mode */}
            {mode === "batch" && (
              <div className="px-7 pt-8 pb-4 space-y-3">
                <div className="text-xs text-ink/75 flex items-center justify-between">
                  <span>One signature, all transfers atomic.</span>
                  <button className="inline-flex items-center gap-1 text-ink hover:text-pink">
                    <Wand2 className="h-3 w-3" /> Import CSV
                  </button>
                </div>
                {batch.map((r, i) => (
                  <div
                    key={r.id}
                    className="grid grid-cols-[28px_1fr_1fr_140px_28px] gap-2 items-center bg-cream/50 rounded-2xl px-3 py-2.5"
                  >
                    <span className="text-[11px] font-mono text-ink/65 text-center">{i + 1}</span>
                    <input
                      value={r.address}
                      onChange={(e) =>
                        setBatch(
                          batch.map((b) => (b.id === r.id ? { ...b, address: e.target.value } : b)),
                        )
                      }
                      placeholder="0x..."
                      className="input bg-white text-sm"
                    />
                    <input
                      value={r.name}
                      onChange={(e) =>
                        setBatch(
                          batch.map((b) => (b.id === r.id ? { ...b, name: e.target.value } : b)),
                        )
                      }
                      placeholder="Name (private)"
                      className="input bg-white text-sm"
                    />
                    <div className="relative">
                      <input
                        value={r.amount}
                        onChange={(e) =>
                          setBatch(
                            batch.map((b) =>
                              b.id === r.id
                                ? { ...b, amount: e.target.value.replace(/[^0-9.]/g, "") }
                                : b,
                            ),
                          )
                        }
                        placeholder="0.00"
                        className="input bg-white text-sm pr-12 font-mono text-right"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-ink/75">
                        {asset.symbol}
                      </span>
                    </div>
                    <button
                      onClick={() => setBatch(batch.filter((b) => b.id !== r.id))}
                      className="grid place-items-center text-ink/65 hover:text-pink"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setBatch([...batch, newRecipient()])}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-dashed border-ink/30 py-3 text-sm font-semibold text-ink/78 hover:border-ink/50 hover:text-ink transition-colors"
                >
                  <Plus className="h-4 w-4" /> Add recipient
                </button>
              </div>
            )}

            {/* Category + Tag */}
            <div className="px-7 pt-10 pb-4 space-y-5">
              <div>
                <Label>What is this transaction for?</Label>
                <div className="mt-3 flex flex-wrap gap-2">
                  {CATS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCat(c)}
                      className={`text-sm px-3.5 py-1.5 rounded-full transition-all ${cat === c ? "bg-ink text-cream shadow-soft" : "bg-cream/60 text-ink/82 hover:bg-cream"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Invoice / project tag (private)">
                <input value={tag} onChange={(e) => setTag(e.target.value)} className="input" />
              </Field>
            </div>
          </div>
        </div>

        {/* Sidebar: Intent Preview / Tx summary */}
        <div className="space-y-5">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative overflow-hidden rounded-3xl bg-white p-7 shadow-float ring-1 ring-ink/10"
            style={{ border: "1px solid color-mix(in oklab, #0B0B0F 24%, transparent)" }}
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-aurora" />
            <div className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-pink">
              Transaction Preview
            </div>
            <div className="mt-1.5 text-lg font-semibold">{cat}</div>

            <div className="mt-5 rounded-2xl bg-cream/60 p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink/75">You send</span>
                <span className="text-xs text-ink/75">
                  {mode === "batch" ? `${batch.length} recipients` : "1 recipient"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight font-mono">
                  {totalAmount.toLocaleString(undefined, { maximumFractionDigits: 18 })}
                </span>
                <span className="text-sm font-semibold">{asset.symbol}</span>
              </div>
              <div className="text-xs text-ink/75 font-mono">
                Balance: {assetBalance || "connect wallet"}
              </div>
              <div className="mt-3 flex items-center justify-center">
                <ArrowDown className="h-4 w-4 text-ink/65" />
              </div>
              <div className="mt-1 text-xs text-ink/75">Recipient receives</div>
              <div className="font-mono text-sm font-semibold">
                {totalAmount.toLocaleString(undefined, { maximumFractionDigits: 18 })}{" "}
                {asset.symbol}
              </div>
            </div>

            <div className="mt-4 space-y-2.5 text-sm">
              <Row k="Network" v="Morph Hoodi" />
              <Row k="Wallet gas" v="Estimated by your wallet at signing" />
              <Row k="Tag" v={tag} />
              <Row
                k="Encryption"
                v={
                  <span className="inline-flex items-center gap-1 text-mint">
                    <Shield className="h-3 w-3" /> AES-256
                  </span>
                }
              />
            </div>

            <div className="mt-6 rounded-2xl bg-cream/70 p-4">
              <div className="text-[10px] uppercase tracking-widest text-ink/75">Lifecycle</div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-[10px] uppercase tracking-widest">
                {[
                  ["Intent", lifecycleOn.Intent],
                  ["Sign", lifecycleOn.Sign],
                  ["Verify", lifecycleOn.Verify],
                  ["Vault", lifecycleOn.Vault],
                ].map(([s, on]) => (
                  <div key={s as string} className="flex flex-col items-center gap-1">
                    <div className={`h-1.5 w-full rounded-full ${on ? "bg-pink" : "bg-ink/10"}`} />
                    <span className={on ? "text-ink" : "text-ink/65"}>{s as string}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-5 text-red-900">
                {flowMessage}
                {txHash && (
                  <div className="mt-1 font-mono text-[11px] text-ink">{shortAddress(txHash)}</div>
                )}
              </div>
            </div>

            <button
              onClick={connected ? createIntentAndSend : prepareWallet}
              disabled={sending}
              className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-ink text-cream py-4 text-sm font-semibold shadow-glow-mint hover:-translate-y-0.5 hover:shadow-glow-pink transition-all disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Lock className="h-4 w-4" />{" "}
              {sending
                ? "Working through intent lifecycle..."
                : connected
                  ? mode === "batch"
                    ? `Create Intent & Sign Batch (${batch.length})`
                    : "Create Intent & Sign"
                  : "Connect Wallet to Sign"}
            </button>
            <div className="mt-3 text-center text-[11px] text-ink/72 inline-flex items-center justify-center gap-1 w-full">
              <Info className="h-3 w-3" /> Your wallet will pop up to sign 1 transaction
            </div>
          </motion.div>

          <div className="rounded-3xl bg-white p-6 shadow-float ring-1 ring-ink/10 text-sm">
            <div className="font-semibold inline-flex items-center gap-1.5">
              <Shield className="h-4 w-4 text-mint" /> How encryption works
            </div>
            <p className="mt-1 text-ink/78">
              Your note, tag, and counterparty are encrypted with AES-256 on your device. Only your
              wallet can decrypt the vault.
            </p>
          </div>
        </div>
      </div>

      <WalletConnectModal
        open={walletPickerOpen}
        onClose={() => setWalletPickerOpen(false)}
        onConnected={(account) => void onWalletConnected(account)}
      />

      {/* Asset picker modal */}
      <AnimatePresence>
        {assetPickerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-ink/10 p-4"
            onClick={() => setAssetPickerOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.96, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 8 }}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="w-full max-w-md bg-white rounded-3xl shadow-float overflow-hidden"
            >
              <div className="px-6 pt-5 pb-3 flex items-center justify-between">
                <div className="text-sm font-semibold">Select asset</div>
                <button
                  onClick={() => setAssetPickerOpen(false)}
                  className="text-ink/65 hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-5 pb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/65" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name or symbol"
                    className="input pl-9"
                  />
                </div>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {filteredAssets.map((a) => (
                  <button
                    key={a.symbol}
                    onClick={() => {
                      setAsset(a);
                      setAssetPickerOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-5 py-3 hover:bg-cream/60 transition-colors text-left"
                  >
                    <AssetIcon symbol={a.symbol} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold flex items-center gap-2">
                        {a.symbol}
                        <span className="text-[10px] uppercase tracking-widest text-ink/65">
                          {a.symbol === "BGB" ? "BGB" : a.type}
                        </span>
                      </div>
                      <div className="text-xs text-ink/75 truncate">{a.name}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-mono">
                        {balances[a.symbol] ? balances[a.symbol] : connected ? "-" : "connect"}
                      </div>
                      <div className="text-[11px] text-ink/75 font-mono">
                        {a.hoodiStatus === "env-required" ? "set env for Hoodi" : "Morph Hoodi"}
                      </div>
                    </div>
                    {asset.symbol === a.symbol && <Check className="h-4 w-4 text-mint" />}
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .input { width: 100%; padding: 0.95rem 1.1rem; border-radius: 0.85rem; border: 1px solid color-mix(in oklab, #0B0B0F 22%, transparent); background: #FFFFFF; box-shadow: inset 0 0 0 1px color-mix(in oklab, #0B0B0F 6%, transparent); font-size: 0.9rem; outline: none; transition: box-shadow .15s, border-color .15s; }
        .input:focus { border-color: oklch(0.82 0.26 145); box-shadow: inset 0 0 0 1px oklch(0.82 0.26 145), 0 0 0 3px color-mix(in oklab, oklch(0.82 0.26 145) 22%, transparent); }
        .shadow-float { box-shadow: 0 1px 2px rgba(11,11,15,0.03), 0 30px 60px -28px rgba(11,11,15,0.10); }
      `}</style>
    </>
  );
}

function WalletPill({
  src,
  active,
  onClick,
}: {
  src: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hidden md:inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold ${active ? "bg-mint/20 text-ink" : "bg-cream/70 text-ink/75"}`}
    >
      {active && <span className="h-1 w-1 rounded-full bg-mint" />} {src}
    </button>
  );
}

function AssetIcon({ symbol }: { symbol: string }) {
  const token = morphTokens.find((item) => item.symbol === symbol);
  return (
    <span className="grid h-8 w-8 place-items-center overflow-hidden rounded-full border border-ink/15 bg-white text-[10px] font-bold tracking-tight text-ink">
      {token?.iconUrl ? (
        <img src={token.iconUrl} alt={`${symbol} logo`} className="h-full w-full object-cover" />
      ) : (
        symbol.slice(0, 4)
      )}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-ink/75">
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}
function Row({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-ink/75">{k}</span>
      <span className={`text-right ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}
