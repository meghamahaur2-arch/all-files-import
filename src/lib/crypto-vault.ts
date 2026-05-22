import { getSelectedEthereumProvider } from "./morph";
import { connectWallet } from "./morph";

export const PAYMEMO_UNLOCK_MESSAGE =
  "Unlock PayMemo Vault\n\nThis signature derives your local encryption key. It does not send a transaction or grant spending permission.";

export type EncryptedMetadata = {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "SHA-256(wallet-signature)";
  walletAddress: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
};

type VaultSession = {
  walletAddress: string;
  signature: string;
  createdAt: string;
};

const SESSION_KEY = "paymemo:vault:session:v1";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requireBrowserCrypto() {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    throw new Error("PayMemo vault encryption requires browser Web Crypto support.");
  }
  return window.crypto;
}

export async function signVaultUnlock(walletAddress: string) {
  const ethereum = await getSelectedEthereumProvider();
  if (!ethereum) throw new Error("No browser wallet found.");

  return (await ethereum.request({
    method: "personal_sign",
    params: [PAYMEMO_UNLOCK_MESSAGE, walletAddress],
  })) as string;
}

/**
 * Ask the user to sign an explicit "authorize watching" message before we
 * register a wallet in their PayMemo watch list. This is a friction-on-purpose
 * step - it makes accidental adds impossible (the user has to see a wallet
 * popup and confirm) and lets us record a verifiable consent for the
 * partner wallet address.
 */
export async function signWatchAuthorization(input: {
  ownerWallet: string;
  watchedAddress: string;
  label: string;
  intent?: "my-wallet" | "partner-wallet";
}) {
  const ethereum = await getSelectedEthereumProvider();
  if (!ethereum) throw new Error("No browser wallet found.");

  const intent = input.intent ?? "partner-wallet";
  const now = new Date().toISOString();
  const message = [
    "PayMemo · Authorize wallet watch",
    "",
    `Intent: ${intent}`,
    `Watcher: ${input.ownerWallet}`,
    `Watched: ${input.watchedAddress}`,
    `Label: ${input.label || "(unlabeled)"}`,
    `Issued: ${now}`,
    "",
    "Signing this message authorizes PayMemo to add the wallet above to your encrypted watch list. No funds move. No transactions are signed.",
  ].join("\n");

  const signature = (await ethereum.request({
    method: "personal_sign",
    params: [message, input.ownerWallet],
  })) as string;

  return { message, signature, signedAt: now };
}

export async function deriveVaultKey(signature: string, walletAddress: string) {
  const crypto = requireBrowserCrypto();
  const encoder = new TextEncoder();
  const seed = encoder.encode(`${walletAddress.toLowerCase()}:${signature}:paymemo:vault:v1`);
  const digest = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptPrivateMetadata(
  metadata: Record<string, unknown>,
  key: CryptoKey,
  walletAddress: string,
): Promise<EncryptedMetadata> {
  const crypto = requireBrowserCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "SHA-256(wallet-signature)",
    walletAddress,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptPrivateMetadata<T = Record<string, unknown>>(
  encrypted: EncryptedMetadata,
  key: CryptoKey,
): Promise<T> {
  const iv = base64ToBytes(encrypted.iv);
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  const plaintext = await requireBrowserCrypto().subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  const decoded = new TextDecoder().decode(plaintext);
  return JSON.parse(decoded) as T;
}

export function rememberVaultSession(walletAddress: string, signature: string) {
  if (typeof window === "undefined") return;
  const session: VaultSession = {
    walletAddress,
    signature,
    createdAt: new Date().toISOString(),
  };
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readVaultSession() {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as VaultSession;
  } catch {
    return null;
  }
}

export function getVaultAuthHeaders(): Record<string, string> {
  const session = readVaultSession();
  if (!session) return {};

  return {
    "x-paymemo-wallet": session.walletAddress,
    "x-paymemo-signature": session.signature,
  };
}

export function clearVaultSession() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_KEY);
}

export async function getRememberedVaultKey() {
  const session = readVaultSession();
  if (!session) return null;
  return deriveVaultKey(session.signature, session.walletAddress);
}

export async function getRememberedVaultKeyFor(walletAddress: string) {
  const session = readVaultSession();
  if (!session) return null;
  if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
  return deriveVaultKey(session.signature, session.walletAddress);
}

export async function unlockVaultWithWallet() {
  const existing = readVaultSession();
  if (existing) {
    return {
      walletAddress: existing.walletAddress,
      key: await deriveVaultKey(existing.signature, existing.walletAddress),
    };
  }

  const walletAddress = await connectWallet();
  const signature = await signVaultUnlock(walletAddress);
  rememberVaultSession(walletAddress, signature);

  return {
    walletAddress,
    key: await deriveVaultKey(signature, walletAddress),
  };
}
