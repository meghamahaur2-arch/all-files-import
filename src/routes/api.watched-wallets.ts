import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  deleteWatchedWallet,
  listWatchedWalletsByOwner,
  upsertWatchedWallet,
} from "@/lib/server/paymemo-db";
import { requireWalletAuth } from "@/lib/server/wallet-auth";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const upsertSchema = z.object({
  ownerWallet: addressSchema,
  watchedAddress: addressSchema,
  label: z.string().max(80).optional(),
  enabled: z.boolean().optional(),
  /**
   * Optional signed authorization. The client signs a structured message
   * with the owner's wallet before registering a wallet to watch. We store
   * just the signature + message text alongside the row - useful for later
   * audit and for proving consent. We don't currently re-verify the signature
   * server-side (would need viem's verifyMessage) - that's a future hardening.
   */
  authSignature: z.string().optional(),
  authMessage: z.string().optional(),
});

const deleteSchema = z.object({
  ownerWallet: addressSchema,
  watchedAddress: addressSchema,
});

/**
 * `/api/watched-wallets`
 *
 * The server-side mirror of the client's "wallets to watch" list. Lets the
 * Vercel cron and any on-page-load catch-up scan know which Morph addresses
 * to sweep - so transactions detected while the user is offline still land
 * in their Needs Review queue when they return.
 */
export const Route = createFileRoute("/api/watched-wallets")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const ownerWallet = url.searchParams.get("ownerWallet")?.toLowerCase();
        if (!ownerWallet) {
          return Response.json({ error: "Missing ownerWallet" }, { status: 400 });
        }
        const auth = await requireWalletAuth(request, ownerWallet);
        if (!auth.ok) return auth.response;

        const wallets = await listWatchedWalletsByOwner(ownerWallet);
        return Response.json({ ok: true, wallets });
      },

      POST: async ({ request }: { request: Request }) => {
        const body = await request.json().catch(() => null);
        const parsed = upsertSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid watched wallet", issues: parsed.error.flatten() },
            { status: 400 },
          );
        }
        const auth = await requireWalletAuth(request, parsed.data.ownerWallet);
        if (!auth.ok) return auth.response;

        const record = await upsertWatchedWallet(parsed.data);
        return Response.json({ ok: true, record });
      },

      DELETE: async ({ request }: { request: Request }) => {
        const body = await request.json().catch(() => null);
        const parsed = deleteSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid delete payload", issues: parsed.error.flatten() },
            { status: 400 },
          );
        }
        const auth = await requireWalletAuth(request, parsed.data.ownerWallet);
        if (!auth.ok) return auth.response;

        await deleteWatchedWallet(parsed.data.ownerWallet, parsed.data.watchedAddress);
        return Response.json({ ok: true });
      },
    },
  },
});
