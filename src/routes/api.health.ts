import { createFileRoute } from "@tanstack/react-router";

/**
 * Lightweight diagnostic endpoint. Useful when something looks off in
 * production to confirm:
 *   - the SSR function is running
 *   - Supabase env vars are set
 *   - PayMemo can actually round-trip a request to Supabase
 *   - Morph Hoodi RPC is reachable
 *
 * Read-only - does NOT touch user data. No auth (no PII surfaced).
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const startedAt = Date.now();

        const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "") || "";
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        const cronSecret = process.env.CRON_SECRET || "";
        const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

        let supabaseReachable = false;
        let supabaseLatencyMs: number | null = null;
        let supabaseError: string | null = null;

        if (supabaseConfigured) {
          const t0 = Date.now();
          try {
            const response = await fetch(`${supabaseUrl}/rest/v1/vault_records?select=id&limit=1`, {
              headers: {
                apikey: supabaseKey,
                authorization: `Bearer ${supabaseKey}`,
              },
            });
            supabaseLatencyMs = Date.now() - t0;
            if (response.ok) {
              supabaseReachable = true;
            } else {
              // Generic status only — never expose the response body which
              // can contain table names, JWT errors, or other internals.
              supabaseError = `HTTP ${response.status}`;
            }
          } catch {
            // Avoid leaking driver / DNS error messages to unauthenticated callers.
            supabaseError = "unreachable";
          }
        }

        let morphRpcReachable = false;
        let morphLatencyMs: number | null = null;
        let morphBlock: number | null = null;
        const t1 = Date.now();
        try {
          const response = await fetch("https://rpc-hoodi.morph.network", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_blockNumber",
            }),
          });
          morphLatencyMs = Date.now() - t1;
          if (response.ok) {
            const payload = (await response.json()) as { result?: string };
            morphBlock = payload.result ? Number(BigInt(payload.result)) : null;
            morphRpcReachable = true;
          }
        } catch {
          // ignore
        }

        return Response.json({
          ok: true,
          now: new Date().toISOString(),
          totalLatencyMs: Date.now() - startedAt,
          server: {
            runtime: "vercel-nodejs22",
          },
          database: {
            backend: supabaseConfigured ? "supabase" : "in-memory-only",
            configured: supabaseConfigured,
            reachable: supabaseReachable,
            latencyMs: supabaseLatencyMs,
            error: supabaseError,
          },
          chainWatch: {
            cronSecretConfigured: Boolean(cronSecret),
            morph: {
              rpc: "https://rpc-hoodi.morph.network",
              reachable: morphRpcReachable,
              latencyMs: morphLatencyMs,
              latestBlock: morphBlock,
            },
          },
        });
      },
    },
  },
});
