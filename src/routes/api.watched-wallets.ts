import { createFileRoute } from "@tanstack/react-router";
import { verifyMessage } from "viem";
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
   * Optional structured authorization message + signature. When supplied,
   * the server verifies that the message was signed by `ownerWallet` and
   * that the message references the same `watchedAddress`. This is in
   * addition to the standard wallet-auth headers; together they bind a
   * single, replay-resistant statement of consent to each add.
   */
  authSignature: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/u)
    .max(1024)
    .optional(),
  authMessage: z.string().max(2000).optional(),
});

const deleteSchema = z.object({
  ownerWallet: addressSchema,
  watchedAddress: addressSchema,
});

const MAX_WATCHED_WALLETS_PER_OWNER = 100;

async function verifyOptionalWatchAuth(input: z.infer<typeof upsertSchema>) {
  if (!input.authSignature || !input.authMessage) return { ok: true as const };

  // Defence-in-depth: confirm the user actually signed a message that
  // mentions the wallet they're trying to add. This prevents replay of
  // an old signature to add a different address.
  const watched = input.watchedAddress.toLowerCase();
  const messageLower = input.authMessage.toLowerCase();
  if (!messageLower.includes(watched)) {
    return { ok: false as const, reason: "authMessage does not reference watchedAddress" };
  }

  try {
    const valid = await verifyMessage({
      address: input.ownerWallet.toLowerCase() as `0x${string}`,
      message: input.authMessage,
      signature: input.authSignature as `0x${string}`,
    });
    if (!valid) return { ok: false as const, reason: "authSignature did not verify" };
  } catch {
    return { ok: false as const, reason: "authSignature could not be verified" };
  }
  return { ok: true as const };
}

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

        const watchAuth = await verifyOptionalWatchAuth(parsed.data);
        if (!watchAuth.ok) {
          return Response.json(
            { error: `Watch authorization invalid: ${watchAuth.reason}` },
            { status: 401 },
          );
        }

        // Cap the per-owner watch list so a compromised vault session
        // can't be used to amplify cron / RPC load by adding thousands
        // of wallets to scan.
        const existing = await listWatchedWalletsByOwner(parsed.data.ownerWallet);
        const alreadyExists = existing.some(
          (item) => item.watchedAddress.toLowerCase() === parsed.data.watchedAddress.toLowerCase(),
        );
        if (!alreadyExists && existing.length >= MAX_WATCHED_WALLETS_PER_OWNER) {
          return Response.json(
            {
              error: `Watch list is full. Maximum ${MAX_WATCHED_WALLETS_PER_OWNER} wallets per owner.`,
            },
            { status: 409 },
          );
        }

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
