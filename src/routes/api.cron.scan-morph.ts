import { createFileRoute } from "@tanstack/react-router";
import { scanAllEnabled, scanForOwner } from "@/lib/server/morph-scanner";
import { requireWalletAuth } from "@/lib/server/wallet-auth";

/**
 * `/api/cron/scan-morph`
 *
 *   GET  → Vercel cron entry point. Sweeps every enabled watched wallet
 *          across all users. Auth: `Authorization: Bearer $CRON_SECRET`.
 *          On Vercel, cron requests carry that header automatically when
 *          `CRON_SECRET` is set in Project Settings.
 *
 *   POST → Per-user "catch-up" scan triggered when the dashboard mounts.
 *          Sweeps only the wallets owned by the calling user. Auth: the
 *          standard PayMemo wallet-signature header so other users can't
 *          force scans on a wallet they don't own.
 *
 * Both write detections into `extension_records`, which the existing
 * `useExtensionRecords` hook surfaces in /app/review and Wallet Assist.
 */
export const Route = createFileRoute("/api/cron/scan-morph")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const secret = process.env.CRON_SECRET;
        // Fail closed: never serve the global sweep unauthenticated.
        // If CRON_SECRET is not set, treat as misconfiguration.
        if (!secret) {
          return Response.json(
            { error: "CRON_SECRET is not configured on the server." },
            { status: 503 },
          );
        }
        const header = request.headers.get("authorization") ?? "";
        if (header !== `Bearer ${secret}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const result = await scanAllEnabled();
          return Response.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "scan failed";
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },

      POST: async ({ request }: { request: Request }) => {
        const body = await request.json().catch(() => null);
        const ownerWallet =
          typeof body?.ownerWallet === "string" ? body.ownerWallet.toLowerCase() : "";
        if (!/^0x[a-f0-9]{40}$/.test(ownerWallet)) {
          return Response.json({ error: "Invalid ownerWallet" }, { status: 400 });
        }
        const auth = await requireWalletAuth(request, ownerWallet);
        if (!auth.ok) return auth.response;
        try {
          const result = await scanForOwner(ownerWallet);
          return Response.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "scan failed";
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
