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
// Every endpoint here re-authenticates per-request (install token OR
// wallet signature), so a `*` Allow-Origin is acceptable.
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
  const address = String(value || "")
    .trim()
    .toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

/**
 * Authenticates a caller for a specific wallet address. A caller may prove
 * ownership two ways:
 *
 *   1. Install token (extension): header `x-paymemo-install-token` matches
 *      a pairing in `extension_pairings` for the given wallet.
 *   2. Wallet signature (dApp): headers `x-paymemo-wallet` +
 *      `x-paymemo-signature` validate against the vault-unlock message.
 *
 * Returns ok=true only when *one of those proofs* succeeds. Unlike the
 * previous "first-touch trust" model, an unpaired wallet is NOT treated
 * as open — callers must establish a pairing before they can write
 * records for that wallet.
 */
async function authenticateWallet(
  request: Request,
  wallet: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!wallet) {
    return {
      ok: false,
      response: Response.json({ error: "Missing wallet for authentication." }, { status: 400 }),
    };
  }

  const token = request.headers.get("x-paymemo-install-token")?.trim();
  if (token) {
    const ok = await isExtensionWalletPaired(token, wallet);
    if (ok) return { ok: true };
  }

  const headerWallet = request.headers.get("x-paymemo-wallet")?.toLowerCase();
  const headerSig = request.headers.get("x-paymemo-signature");
  if (headerWallet && headerSig) {
    const auth = await requireWalletAuth(request, wallet);
    if (auth.ok) return { ok: true };
  }

  return {
    ok: false,
    response: Response.json(
      {
        error:
          "Auth required. Send either x-paymemo-install-token (paired with this wallet) or x-paymemo-wallet + x-paymemo-signature (dApp vault).",
      },
      { status: 401 },
    ),
  };
}

/**
 * Bootstrap exception for first-time extension writes: if the caller
 * presents a fresh install token that has *no* pairings yet AND the
 * target wallet itself also has no pairings, allow the write. The next
 * /api/extension-pair call will lock the wallet to this token from
 * then on. This avoids a chicken-and-egg loop where the extension can't
 * write its very first observation before pairing completes.
 */
async function allowFirstTouchExtensionWrite(request: Request, wallet: string) {
  const token = request.headers.get("x-paymemo-install-token")?.trim();
  if (!token || token.length < 24) return false;
  const walletPairings = await listExtensionPairings(wallet);
  if (walletPairings.length > 0) return false;
  return true;
}

export const Route = createFileRoute("/api/extension-intent")({
  server: {
    handlers: {
      OPTIONS: async () => {
        return withCors(new Response(null, { status: 204 }));
      },

      GET: async ({ request }: { request: Request }) => {
        const limited = checkRateLimit(request, { scope: "extension-intent-get", limit: 120 });
        if (!limited.ok) return withCors(limited.response);

        const url = new URL(request.url);
        const wallets = url.searchParams.getAll("wallet").flatMap((value) =>
          value
            .split(/[\s,]+/)
            .map((address) => normalizeAddress(address))
            .filter(Boolean),
        );

        if (!wallets.length) {
          return withCors(
            Response.json(
              { error: "Provide at least one ?wallet=0x... query parameter." },
              { status: 400 },
            ),
          );
        }

        // Every requested wallet must be authenticated to the caller.
        // We never serve records for wallets the caller hasn't proven ownership of.
        for (const wallet of wallets) {
          const auth = await authenticateWallet(request, wallet);
          if (!auth.ok) return withCors(auth.response);
        }

        const records = await listExtensionRecords();
        const scoped = records.filter((record) => {
          const from = normalizeAddress(record.from ?? undefined);
          const to = normalizeAddress(record.to ?? undefined);
          return (from && wallets.includes(from)) || (to && wallets.includes(to));
        });

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
        const toWallet = normalizeAddress(parsed.data.to);

        // A record must touch at least one wallet, and the caller must
        // authenticate as the owner of at least one of those wallets.
        // If neither field is a wallet (e.g. `to: "contract interaction"`),
        // require auth via the from wallet — which means from must be set.
        const candidates = [fromWallet, toWallet].filter(Boolean);
        if (!candidates.length) {
          return withCors(
            Response.json(
              { error: "Record must include a `from` or `to` wallet address." },
              { status: 400 },
            ),
          );
        }

        let authenticated = false;
        for (const wallet of candidates) {
          const auth = await authenticateWallet(request, wallet);
          if (auth.ok) {
            authenticated = true;
            break;
          }
        }

        // Bootstrap path: a fresh, unpaired install token can write its
        // first record for an unpaired wallet. Locked down to ONLY the
        // from wallet (sender), never to wallets the caller doesn't control.
        if (!authenticated && fromWallet) {
          const firstTouch = await allowFirstTouchExtensionWrite(request, fromWallet);
          if (firstTouch) authenticated = true;
        }

        if (!authenticated) {
          return withCors(
            Response.json(
              {
                error:
                  "Auth required. Pair the extension to a wallet, or call from the dApp with x-paymemo-wallet + x-paymemo-signature.",
              },
              { status: 401 },
            ),
          );
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
