# PayMemo Morph worker

Tiny Node process that watches Morph Hoodi for new blocks and pokes
`POST /api/cron/scan-morph` on the deployed PayMemo Vercel instance so
chain-watch detection runs in real time (~2 sec) instead of waiting for
Vercel's daily cron.

```
  Morph Hoodi  ──new block──▶  worker (Railway/Fly/etc.)  ──HTTP──▶  PayMemo Vercel /api/cron/scan-morph
                                                                          │
                                                                          ▼
                                                                Supabase: extension_records
                                                                          │
                                                                          ▼
                                                                /app/review (Needs Review)
```

The worker holds **no scan logic** - all scanning happens inside
PayMemo's Vercel function. The worker is just a wake-up trigger. That
means you can redeploy it freely and never worry about the worker and
the dApp drifting apart.

## Modes

- **WebSocket** (`MORPH_WS_URL` set): subscribes to `newHeads`. Fastest.
  Auto-falls-back to HTTP polling if the socket can't connect or drops.
- **HTTP polling** (default): calls `eth_blockNumber` every 2 seconds.
  Morph Hoodi block time is ~2s, so every block is still caught.

## Deploy to Railway (recommended - free hobby plan covers this)

1. **Create a new Railway project**: <https://railway.app/new>
2. **Connect this repo** and pick the `worker` directory as the service root.
   Railway will detect `package.json` and use the `node index.js` start
   command from `railway.json`.
3. **Set environment variables** (Variables tab):
   - `PAYMEMO_API_URL` = `https://paymemo.vercel.app` (your live PayMemo URL)
   - `CRON_SECRET` = **same value** you set in Vercel's project settings.
     Without this the worker will be rejected by Vercel.
   - `MORPH_WS_URL` = leave empty unless Morph publishes a `wss://` endpoint.
     (HTTP polling is fine - it triggers within ~2s anyway.)
4. **Deploy**. The first log line should read
   `[paymemo-worker] PayMemo Morph worker starting`. After that you'll see
   one line per block:
   `[paymemo-worker] block 1234567 → scan ok in 320ms · wallets=4 detections=0`

## Deploy to Fly.io (alternative)

```bash
fly launch --no-deploy --copy-config
# edit fly.toml: set internal_port = 3000 (we don't listen, doesn't matter)
fly secrets set PAYMEMO_API_URL=https://paymemo.vercel.app CRON_SECRET=...
fly deploy
```

## Run locally

```bash
cp .env.example .env
# fill in PAYMEMO_API_URL + CRON_SECRET
npm install
npm run dev
```

## Costs

- Railway free tier: 500 execution hours/month free. This worker uses
  one always-on container = ~720h/month, so you'll hit the cap after
  ~20 days. Either upgrade to Railway Pro ($5/mo) or use Fly.io's free
  tier (3 small VMs free indefinitely).
- The worker itself does almost nothing - it's <50 MB RAM, no disk, no
  CPU. Any free-tier hobby host will run it forever.

## Tuning

- `POLL_INTERVAL_MS` (default 2000) - Morph block time. Lowering it
  doesn't help; raising it costs you detection latency.
- `SCAN_DEBOUNCE_MS` (default 1500) - minimum gap between successive
  scan POSTs. Prevents a flurry of triggers if Morph spits out two
  blocks fast.
- `SCAN_BURST_LIMIT` (default 8/min) - hard cap so a runaway loop can't
  blow up your Vercel function quota.

## Failure modes (and what happens)

| Failure | What still works |
|---|---|
| Worker dies / restarts | Vercel daily cron still scans; user catches up on next page load. |
| Vercel rejects scan POST (bad CRON_SECRET) | Worker logs HTTP 401 every 2s; no records written. Fix the secret in Railway env. |
| Morph RPC down | Worker logs poll errors, retries on the next tick. No data lost - Morph state is the source of truth. |
| Worker can't reach `paymemo.vercel.app` | Same as above - retries every 2s. |
| Vercel function cold start | Adds ~1s to the first trigger after idle. Subsequent triggers within ~5min are warm. |

## What this gives you vs. the existing Vercel cron

| | Vercel cron only | Vercel cron + this worker |
|---|---|---|
| Latency floor | 6 hours (Hobby) / 1 min (Pro) | ~2 seconds |
| Cost | Free | Free (Railway hobby) or $5/mo (Pro) |
| Always-on | Yes | Yes (with auto-restart) |
| Code change to roll back | Just delete the worker | Just delete the worker |

If demo day is over and you want to shut it down, `Service → Settings →
Remove Service` on Railway. The Vercel cron keeps PayMemo functional -
you just lose the sub-minute latency.
