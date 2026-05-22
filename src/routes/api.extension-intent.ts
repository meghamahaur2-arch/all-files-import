import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { normalizeRecord, payMemoRecordSchema } from "@/lib/paymemo-schema";
import {
  addExtensionRecord,
  isExtensionWalletPaired,
  listExtensionPairings,
  listExtensionRecords,
} from "@/lib/server/paymemo-db";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { requireWalletAuth } from "@/lib/server/wallet-auth";

// CORS - the PayMemo browser extension calls this endpoint from a
// `chrome-extension://<id>` origin, which triggers a preflight OPTIONS
// request whenever a custom header (`x-paymemo-install-token`) or
// non-simple content-type (`application/json`) is in play. Without
// explicit allow-* headers + an OPTIONS handler the preflight fails
// silently and the extension's fetch() throws "Failed to fetch".
//
// Endpoint already auth's itself via the install token OR wallet
// signature, so `*` for Allow-Origin is safe.
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-paymemo-install-token, x-paymemo-wallet, x-paymemo-signature",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

const extensionIntentSchema = payMemoRecordSchema.extend({
  method: z.string().optional(),
  origin: z.string().optional(),
});

function normalizeAddress(value: string | null | undefined) {
  const address = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

/**
 * Authenticates a write to `/api/extension-intent`. A wallet's extension
 * records can be created by either:
 *
 *   1. The PayMemo browser extension, which sends `x-paymemo-install-token`
 *      matching a row in `extension_pairings`. This is the original auth
 *      path - used by the popup, content-script overlay, and sidepanel.
 *
 *   2. The PayMemo dApp itself, which sends `x-paymemo-wallet` + the
 *      vault-unlock signature in `x-paymemo-signature`. The dApp uses
 *      this path when the user clicks "Record review" in /app/review,
 *      since the dApp has no install token of its own.
 *
 * Either is sufficient. We only require *some* form of proof that the
 * caller actually controls (or has been paired with) the from-wallet
 * once that wallet has any pairings on file. Wallets with no pairings
 * are still first-touch trusted so a brand-new extension install can
 * write its first record before the pairing is recorded.
 */
async function ensureCallerOwnsWallet(
  request: Request,
  wallet: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!wallet) return { ok: true };

  const pairings = await listExtensionPairings(wallet);
  if (!pairings.length) return { ok: true };

  // Path 1: extension install token
  const token = request.headers.get("x-paymemo-install-token")?.trim();
  if (token) {
    const ok = await isExtensionWalletPaired(token, wallet);
    if (ok) return { ok: true };
    return {
      ok: false,
      response: Response.json(
        { error: "Install token is not paired with this wallet." },
        { status: 403 },
      ),
    };
  }

  // Path 2: dApp wallet signature
  const headerWallet = request.headers.get("x-paymemo-wallet")?.toLowerCase();
  const headerSig = request.headers.get("x-paymemo-signature");
  if (headerWallet && headerSig) {
    const auth = await requireWalletAuth(request, wallet);
    if (auth.ok) return { ok: true };
    return { ok: false, response: auth.response };
  }

  return {
    ok: false,
    response: Response.json(
      {
        error:
          "Auth required for paired wallet. Send either x-paymemo-install-token (extension) or x-paymemo-wallet + x-paymemo-signature (dApp vault).",
      },
      { status: 401 },
    ),
  };
}

export const Route = createFileRoute("/api/extension-intent")({
  server: {
    handlers: {
      // CORS preflight. The extension (chrome-extension:// origin) sends
      // OPTIONS before the actual POST whenever a non-simple header like
      // `x-paymemo-install-token` is present. Without this the browser
      // blocks the POST and the fetch() throws "Failed to fetch".
      OPTIONS: async () => {
        return withCors(new Response(null, { status: 204 }));
      },

      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const wallets = url.searchParams.getAll("wallet").flatMap((value) =>
          value
            .split(/[\s,]+/)
            .map((address) => normalizeAddress(address))
            .filter(Boolean),
        );

        const records = await listExtensionRecords();
        const scoped = wallets.length
          ? records.filter((record) => {
              const from = normalizeAddress(record.from ?? undefined);
              const to = normalizeAddress(record.to ?? undefined);
              return wallets.includes(from) || wallets.includes(to);
            })
          : records;

        return withCors(
          Response.json({
            ok: true,
            records: scoped,
            storage: "database",
            wallets,
          }),
        );
      },

      POST: async ({ request }: { request: Request }) => {
        const limited = checkRateLimit(request, { scope: "extension-intent-post", limit: 60 });
        if (!limited.ok) return withCors(limited.response);

        const body = await request.json().catch(() => null);
        const parsed = extensionIntentSchema.safeParse(body);

        if (!parsed.success) {
          return withCors(
            Response.json(
              { error: "Invalid extension intent", issues: parsed.error.flatten() },
              { status: 400 },
            ),
          );
        }

        const fromWallet = normalizeAddress(parsed.data.from);
        if (fromWallet) {
          const check = await ensureCallerOwnsWallet(request, fromWallet);
          if (!check.ok) return withCors(check.response);
        }

        const record = normalizeRecord({
          ...parsed.data,
          from: parsed.data.from ? parsed.data.from.toLowerCase() : parsed.data.from,
          to: parsed.data.to ? parsed.data.to.toLowerCase() : parsed.data.to,
          mode: "wallet-assist",
          source: parsed.data.origin ?? parsed.data.source ?? "browser-extension",
        });

        await addExtensionRecord(record);

        return withCors(
          Response.json({
            ok: true,
            record,
            storage: "database",
          }),
        );
      },
    },
  },
});

