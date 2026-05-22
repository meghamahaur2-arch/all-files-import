/**
 * PayMemo Morph Hoodi real-time block trigger.
 *
 * Watches Morph for new blocks and, on every new block, fires the PayMemo
 * `/api/cron/scan-morph` endpoint so the scan runs immediately instead of
 * waiting for the Vercel cron (which is daily-ish on Hobby).
 *
 * Modes:
 *   1. WebSocket (`MORPH_WS_URL`) - subscribes to `newHeads`. Fastest, but
 *      depends on Morph exposing a WS endpoint. Auto-falls-back to HTTP
 *      polling if the socket can't connect / drops.
 *   2. HTTP polling (`MORPH_RPC_URL`) - calls `eth_blockNumber` every
 *      `POLL_INTERVAL_MS` (default 2s). Catches every block since Morph
 *      Hoodi block time is ~2s.
 *
 * The worker itself does NOT call Morph's heavier scan RPCs - it just
 * triggers Vercel, which holds all the real logic. Splitting the work this
 * way keeps the worker stateless, easy to redeploy, and immune to schema
 * drift in PayMemo.
 *
 * Required env:
 *   PAYMEMO_API_URL    e.g. https://paymemo.vercel.app
 *   CRON_SECRET        same value as set in Vercel project env
 *
 * Optional env:
 *   MORPH_WS_URL       e.g. wss://rpc-hoodi.morph.network
 *                      (falls back to HTTP polling if missing or broken)
 *   MORPH_RPC_URL      default: https://rpc-hoodi.morph.network
 *   POLL_INTERVAL_MS   default: 2000
 *   SCAN_DEBOUNCE_MS   default: 1500 - minimum gap between scan triggers
 *   SCAN_BURST_LIMIT   default: 8 - max consecutive scans per minute
 */

import { WebSocket } from "ws";

const PAYMEMO_API_URL = (process.env.PAYMEMO_API_URL || "https://paymemo.vercel.app").replace(/\/$/, "");
const CRON_SECRET = process.env.CRON_SECRET || "";
const MORPH_RPC_URL = process.env.MORPH_RPC_URL || "https://rpc-hoodi.morph.network";
const MORPH_WS_URL = process.env.MORPH_WS_URL || "";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);
const SCAN_DEBOUNCE_MS = parseInt(process.env.SCAN_DEBOUNCE_MS || "1500", 10);
const SCAN_BURST_LIMIT = parseInt(process.env.SCAN_BURST_LIMIT || "8", 10);

if (!CRON_SECRET) {
  console.warn("[paymemo-worker] CRON_SECRET is empty - scan calls will be unauthenticated and Vercel will likely reject them.");
}

let lastSeenBlock = 0;
let lastScanAt = 0;
let scansInLastMinute = 0;
let burstWindowStart = Date.now();

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[paymemo-worker ${ts()}]`, ...args);
}

async function rpc(method, params = []) {
  const response = await fetch(MORPH_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Morph RPC ${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Morph RPC ${method}: ${payload.error.message ?? "error"}`);
  return payload.result;
}

async function triggerScan(blockNumber) {
  const now = Date.now();
  if (now - lastScanAt < SCAN_DEBOUNCE_MS) return;

  // Sliding burst limiter: reset window once per minute.
  if (now - burstWindowStart > 60_000) {
    burstWindowStart = now;
    scansInLastMinute = 0;
  }
  if (scansInLastMinute >= SCAN_BURST_LIMIT) {
    log(`burst limit hit (${SCAN_BURST_LIMIT}/min) - skipping scan trigger`);
    return;
  }

  lastScanAt = now;
  scansInLastMinute += 1;

  try {
    const t0 = Date.now();
    const response = await fetch(`${PAYMEMO_API_URL}/api/cron/scan-morph`, {
      method: "GET",
      headers: CRON_SECRET ? { authorization: `Bearer ${CRON_SECRET}` } : {},
    });
    const body = await response.json().catch(() => ({}));
    const dt = Date.now() - t0;
    if (!response.ok) {
      log(`scan trigger failed (block ${blockNumber}) - HTTP ${response.status} in ${dt}ms - ${JSON.stringify(body).slice(0, 200)}`);
      return;
    }
    log(
      `block ${blockNumber} → scan ok in ${dt}ms ·`,
      `wallets=${body.walletsScanned ?? "?"} detections=${body.detections ?? 0}`,
    );
  } catch (error) {
    log(`scan trigger error (block ${blockNumber}):`, error?.message ?? error);
  }
}

async function onNewBlock(blockNumber) {
  if (!Number.isFinite(blockNumber)) return;
  if (blockNumber <= lastSeenBlock) return;
  lastSeenBlock = blockNumber;
  await triggerScan(blockNumber);
}

// --- HTTP polling loop -------------------------------------------------------

let httpPollHandle = null;
function startHttpPolling() {
  if (httpPollHandle) return;
  log(`HTTP polling at ${POLL_INTERVAL_MS}ms against ${MORPH_RPC_URL}`);
  httpPollHandle = setInterval(async () => {
    try {
      const hex = await rpc("eth_blockNumber");
      const block = Number(BigInt(hex));
      await onNewBlock(block);
    } catch (error) {
      log("poll error:", error?.message ?? error);
    }
  }, POLL_INTERVAL_MS);
}
function stopHttpPolling() {
  if (!httpPollHandle) return;
  clearInterval(httpPollHandle);
  httpPollHandle = null;
}

// --- WebSocket subscription --------------------------------------------------

let wsClient = null;
let wsBackoffMs = 1000;
const WS_BACKOFF_MAX = 60_000;

function startWebSocket() {
  if (!MORPH_WS_URL) {
    log("no MORPH_WS_URL set - using HTTP polling only");
    startHttpPolling();
    return;
  }

  log(`connecting to ${MORPH_WS_URL}`);
  let opened = false;
  const socket = new WebSocket(MORPH_WS_URL);
  wsClient = socket;

  socket.on("open", () => {
    opened = true;
    wsBackoffMs = 1000;
    log("WebSocket connected - subscribing to newHeads");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["newHeads"],
      }),
    );
    // While the WS is healthy we don't need the HTTP poller, but we keep a
    // slower safety poll running in case the WS silently misses a block.
    stopHttpPolling();
    setTimeout(() => {
      if (wsClient === socket) startHttpPolling();
    }, 30_000);
  });

  socket.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      const head = payload?.params?.result;
      if (head?.number) {
        const block = Number(BigInt(head.number));
        await onNewBlock(block);
      }
    } catch (error) {
      log("ws message parse error:", error?.message ?? error);
    }
  });

  socket.on("error", (error) => {
    log("WebSocket error:", error?.message ?? error);
  });

  socket.on("close", () => {
    if (wsClient === socket) wsClient = null;
    log(`WebSocket closed - reconnecting in ${wsBackoffMs}ms (also resuming HTTP polling)`);
    startHttpPolling();
    if (!opened) {
      // Initial connect failed - disable WS for this run and rely on HTTP.
      log("WebSocket never opened; staying on HTTP polling only");
      return;
    }
    const wait = wsBackoffMs;
    wsBackoffMs = Math.min(WS_BACKOFF_MAX, wsBackoffMs * 2);
    setTimeout(() => startWebSocket(), wait);
  });
}

// --- Startup banner + shutdown -----------------------------------------------

log("PayMemo Morph worker starting");
log(`PAYMEMO_API_URL = ${PAYMEMO_API_URL}`);
log(`CRON_SECRET configured = ${Boolean(CRON_SECRET)}`);
log(`mode = ${MORPH_WS_URL ? "websocket (+ http safety poll)" : "http polling"}`);

startWebSocket();

// Healthcheck - write the latest seen block to a file so Railway / Fly
// health endpoints can read it if you wire one up.
setInterval(() => {
  log(`heartbeat · lastSeenBlock=${lastSeenBlock} · scansInLastMinute=${scansInLastMinute}`);
}, 60_000);

process.on("SIGTERM", () => {
  log("SIGTERM received - shutting down");
  stopHttpPolling();
  if (wsClient) wsClient.close();
  process.exit(0);
});
