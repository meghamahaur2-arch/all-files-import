import { isAddress } from "./morph";
import { getVaultAuthHeaders } from "./crypto-vault";

const LEGACY_PARTNER_KEY = "paymemo:partner-wallets:v1";
const PARTNER_WALLETS_PREFIX = "paymemo:partner-wallets:owner:";

export type PartnerWallet = {
  address: string;
  label: string;
};

function ownerKey(walletAddress: string | null | undefined) {
  const normalized = String(walletAddress || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  return `${PARTNER_WALLETS_PREFIX}${normalized}`;
}

export function normalizePartnerWallet(address: string, label = "Partner wallet") {
  const normalized = address.trim().toLowerCase();
  if (!isAddress(normalized)) return null;
  return {
    address: normalized,
    label: label.trim() || "Partner wallet",
  } satisfies PartnerWallet;
}

export function readPartnerWallets(walletAddress?: string | null) {
  if (typeof window === "undefined") return [];

  const key = walletAddress ? ownerKey(walletAddress) : "";
  const storageKey = key || LEGACY_PARTNER_KEY;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    if (key) {
      // One-shot migration: if scoped key empty but legacy exists, copy then drop legacy.
      const legacy = window.localStorage.getItem(LEGACY_PARTNER_KEY);
      if (legacy) {
        window.localStorage.setItem(key, legacy);
        window.localStorage.removeItem(LEGACY_PARTNER_KEY);
        return readPartnerWallets(walletAddress);
      }
    }
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as PartnerWallet[];
    return Array.isArray(parsed)
      ? parsed.flatMap((wallet) => {
          const next = normalizePartnerWallet(wallet.address, wallet.label);
          return next ? [next] : [];
        })
      : [];
  } catch {
    return [];
  }
}

export function writePartnerWallets(
  walletAddress: string | null | undefined,
  wallets: PartnerWallet[],
) {
  if (typeof window === "undefined") return;
  const key = walletAddress ? ownerKey(walletAddress) : LEGACY_PARTNER_KEY;
  if (!key) return;
  const seen = new Set<string>();
  const normalized = wallets.flatMap((wallet) => {
    const next = normalizePartnerWallet(wallet.address, wallet.label);
    if (!next || seen.has(next.address)) return [];
    seen.add(next.address);
    return [next];
  });
  window.localStorage.setItem(key, JSON.stringify(normalized));
}

export function upsertPartnerWallet(
  walletAddress: string | null | undefined,
  wallet: PartnerWallet,
) {
  const normalized = normalizePartnerWallet(wallet.address, wallet.label);
  if (!normalized) return readPartnerWallets(walletAddress ?? undefined);
  const current = readPartnerWallets(walletAddress ?? undefined);
  const next = [normalized, ...current.filter((item) => item.address !== normalized.address)];
  writePartnerWallets(walletAddress ?? undefined, next);
  return next;
}

export function removePartnerWallet(walletAddress: string | null | undefined, address: string) {
  const normalized = normalizePartnerWallet(address)?.address;
  if (!normalized) return readPartnerWallets(walletAddress ?? undefined);
  const next = readPartnerWallets(walletAddress ?? undefined).filter(
    (wallet) => wallet.address !== normalized,
  );
  writePartnerWallets(walletAddress ?? undefined, next);
  return next;
}

export function syncPartnerWalletsToExtension(wallets: PartnerWallet[]) {
  if (typeof window === "undefined") return;
  window.postMessage(
    {
      type: "PAYMEMO_SYNC_WATCHED_WALLETS_FROM_APP",
      wallets,
    },
    window.location.origin,
  );
}

export function clearWalletDataFromExtension(walletAddress: string) {
  if (typeof window === "undefined") return;
  window.postMessage(
    {
      type: "PAYMEMO_CLEAR_WALLET_DATA_FROM_APP",
      wallet: walletAddress,
    },
    window.location.origin,
  );
}

/**
 * Server-side mirror - registers a watched wallet so the Vercel cron and
 * the on-load catch-up scan know to sweep it even while the user's tab
 * is closed. Failure is non-fatal (client-side watch still works).
 */
export async function registerWatchedWalletOnServer(input: {
  ownerWallet: string;
  watchedAddress: string;
  label?: string;
  enabled?: boolean;
  /** Optional: signed authorization message proving user intent. */
  authSignature?: string;
  authMessage?: string;
}) {
  try {
    const response = await fetch("/api/watched-wallets", {
      method: "POST",
      headers: { "content-type": "application/json", ...getVaultAuthHeaders() },
      body: JSON.stringify({
        ownerWallet: input.ownerWallet.toLowerCase(),
        watchedAddress: input.watchedAddress.toLowerCase(),
        label: input.label ?? "",
        enabled: input.enabled ?? true,
        authSignature: input.authSignature,
        authMessage: input.authMessage,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function unregisterWatchedWalletOnServer(input: {
  ownerWallet: string;
  watchedAddress: string;
}) {
  try {
    const response = await fetch("/api/watched-wallets", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...getVaultAuthHeaders() },
      body: JSON.stringify({
        ownerWallet: input.ownerWallet.toLowerCase(),
        watchedAddress: input.watchedAddress.toLowerCase(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ask the server to sweep this user's watched wallets right now. Run on
 * dashboard mount so users see anything that happened while they were
 * offline. Returns the scan summary or null on failure.
 */
export async function triggerServerCatchUpScan(ownerWallet: string) {
  try {
    const response = await fetch("/api/cron/scan-morph", {
      method: "POST",
      headers: { "content-type": "application/json", ...getVaultAuthHeaders() },
      body: JSON.stringify({ ownerWallet: ownerWallet.toLowerCase() }),
    });
    if (!response.ok) return null;
    return (await response.json()) as {
      ok: true;
      walletsScanned: number;
      detections: number;
      latestBlock?: number;
    };
  } catch {
    return null;
  }
}
