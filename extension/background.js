const STORAGE_KEY = "paymemo.records";
const SETTINGS_KEY = "paymemo.settings";
const WATCH_STATE_KEY = "paymemo.morphWatchState";
const INSTALL_TOKEN_KEY = "paymemo.installToken";
const HANDLED_TX_HASHES_KEY = "paymemo.handledTxHashes";
const HANDLED_TX_LIMIT = 500;
const MORPH_WATCH_ALARM = "paymemo-morph-watch";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MORPH_KNOWN_TOKENS = {
  "0x1178341838b764dcffa5bceab1d41443fd71a227": { symbol: "USDC", decimals: 6 },
  "0x5300000000000000000000000000000000000011": { symbol: "WETH", decimals: 18 },
};

let memoPopupWindowId = null;

const DEFAULT_SETTINGS = {
  appUrl: "https://paymemo.vercel.app",
  rpcUrl: "https://rpc-hoodi.morph.network",
  chainId: 2910,
  enabled: true,
  chainWatchEnabled: false,
  watchedAddresses: [],
  watchedWalletLabels: {},
  partnerWalletAddresses: [],
  autoOpenChainWatchPrompt: true,
  // If false (default), the chain-watch popup only fires for transactions
  // involving the user's own wallet - not for partner wallets. Partner-wallet
  // detections are still recorded silently for review.
  popupForPartnerWallets: false,
  morphWatchIntervalMs: 2500,
};

function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getOrCreateInstallToken() {
  const stored = await chrome.storage.local.get(INSTALL_TOKEN_KEY);
  if (typeof stored[INSTALL_TOKEN_KEY] === "string" && stored[INSTALL_TOKEN_KEY].length >= 24) {
    return stored[INSTALL_TOKEN_KEY];
  }
  const token = randomToken();
  await chrome.storage.local.set({ [INSTALL_TOKEN_KEY]: token });
  return token;
}

async function readSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await configureMorphWatch(next);
  return next;
}

async function mergeWatchedWallets(wallets = []) {
  const settings = await readSettings();
  const watched = normalizeAddresses(settings.watchedAddresses);
  const labels = { ...(settings.watchedWalletLabels || {}) };
  let added = 0;

  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    const address = normalizeAddresses([wallet?.address || wallet])[0];
    if (!address) continue;
    if (!watched.includes(address)) {
      watched.push(address);
      added += 1;
    }
    const label = String(wallet?.label || "").trim();
    if (label) labels[address] = label;
  }

  return saveSettings({
    ...settings,
    watchedAddresses: watched,
    watchedWalletLabels: labels,
    // Do not silently change chainWatchEnabled/autoOpenChainWatchPrompt. The user
    // toggles those from the extension popup/settings. We only persist the new
    // address book here.
    addedCount: added,
  });
}

function watchStateKey(walletAddress) {
  const key = String(walletAddress || "").toLowerCase();
  if (!key || !/^0x[a-f0-9]{40}$/.test(key)) return WATCH_STATE_KEY;
  return `${WATCH_STATE_KEY}:${key}`;
}

async function readWatchState(walletAddress) {
  const key = watchStateKey(walletAddress);
  const result = await chrome.storage.local.get(key);
  const fallback = walletAddress ? await chrome.storage.local.get(WATCH_STATE_KEY) : {};
  const merged =
    result[key] ||
    (walletAddress ? fallback[WATCH_STATE_KEY] : null) ||
    {};
  return {
    lastBlock: 0,
    seenTxHashes: [],
    ...merged,
  };
}

async function writeWatchState(state, walletAddress) {
  const key = watchStateKey(walletAddress);
  await chrome.storage.local.set({ [key]: state });
  return state;
}

// Tx hashes the dApp itself has fully handled (e.g. the user just used the
// /app/send flow which already memos and stores everything). The chain watch
// skips these so the dApp doesn't get a duplicate popup for its own tx.
async function readHandledTxHashes() {
  const result = await chrome.storage.local.get(HANDLED_TX_HASHES_KEY);
  const list = Array.isArray(result[HANDLED_TX_HASHES_KEY])
    ? result[HANDLED_TX_HASHES_KEY]
    : [];
  return new Set(list.map((value) => String(value).toLowerCase()));
}

async function registerHandledTxHash(txHash, origin) {
  const hash = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Invalid tx hash for register-handled.");
  }
  const set = await readHandledTxHashes();
  set.add(hash);
  const trimmed = Array.from(set).slice(-HANDLED_TX_LIMIT);
  await chrome.storage.local.set({ [HANDLED_TX_HASHES_KEY]: trimmed });
  // Also drop any extension record that was already created for this tx -
  // the dApp owns it now, so it shouldn't sit in the review queue.
  const records = await readRecords();
  const filtered = records.filter(
    (record) => String(record.txHash || "").toLowerCase() !== hash,
  );
  if (filtered.length !== records.length) await writeRecords(filtered);
  return { handled: hash, origin: origin || "paymemo-dapp" };
}

async function readRecords() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function writeRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records });
  await chrome.action.setBadgeBackgroundColor({ color: "#5cff82" });
  await chrome.runtime
    .sendMessage({ type: "PAYMEMO_RECORDS_UPDATED", count: records.length })
    .catch(() => null);
  return records;
}

async function upsertRecord(record) {
  const records = await readRecords();
  const id =
    record.id || `ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nextRecord = {
    ...record,
    id,
    updatedAt: new Date().toISOString(),
    createdAt: record.createdAt || new Date().toISOString(),
  };
  const next = [nextRecord, ...records.filter((item) => item.id !== id)];
  await writeRecords(next);
  if (nextRecord.provider !== "Morph Chain Watch") await rememberWatchedAddress(nextRecord.from);
  return nextRecord;
}

async function rememberWatchedAddress(address) {
  const normalized = normalizeAddresses([address])[0];
  if (!normalized) return;
  const settings = await readSettings();
  const watched = normalizeAddresses(settings.watchedAddresses);
  if (watched.includes(normalized)) return;
  await saveSettings({ ...settings, watchedAddresses: [...watched, normalized] });
}

async function patchRecord(id, patch) {
  const records = await readRecords();
  const current = records.find((item) => item.id === id);
  if (!current) return null;
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeRecords([updated, ...records.filter((item) => item.id !== id)]);
  return updated;
}

async function deleteRecord(id) {
  const records = await readRecords();
  const next = records.filter((item) => item.id !== id);
  await writeRecords(next);
  return next;
}

async function clearSyncedRecords() {
  const records = await readRecords();
  const next = records.filter((record) => record.syncStatus !== "synced");
  await writeRecords(next);
  return records.length - next.length;
}

function normalizeAddresses(addresses) {
  const values = Array.isArray(addresses) ? addresses : String(addresses || "").split(/[\s,]+/);
  return values
    .map((address) =>
      String(address || "")
        .trim()
        .toLowerCase(),
    )
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address));
}

function hexToNumber(value) {
  if (!value) return 0;
  return Number.parseInt(value, 16);
}

function numberToHex(value) {
  return `0x${Math.max(0, value).toString(16)}`;
}

function formatEther(hexValue) {
  if (!hexValue || hexValue === "0x") return "0";
  try {
    const wei = BigInt(hexValue);
    const whole = wei / 10n ** 18n;
    const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return "0";
  }
}

function formatUnits(hexValue, decimals) {
  if (!hexValue || hexValue === "0x") return "0";
  try {
    const units = BigInt(hexValue);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(decimals, "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return "0";
  }
}

function padAddressTopic(address) {
  const normalized = normalizeAddresses([address])[0];
  if (!normalized) return "";
  return `0x${normalized.slice(2).padStart(64, "0")}`;
}

function topicToAddress(topic) {
  const value = String(topic || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(value)) return "";
  return `0x${value.slice(-40)}`;
}

function decodeKnownErc20Transfer(tx) {
  const token = MORPH_KNOWN_TOKENS[String(tx?.to || "").toLowerCase()];
  const data = String(tx?.input || tx?.data || "").toLowerCase();
  if (!token || !data.startsWith("0xa9059cbb") || data.length < 138) return null;

  const recipient = `0x${data.slice(34, 74).slice(-40)}`;
  const rawAmount = `0x${data.slice(74, 138)}`;
  const amount = formatUnits(rawAmount, token.decimals);
  return {
    to: recipient,
    counterparty: recipient,
    amount: amount ? `${amount} ${token.symbol}` : `${token.symbol} transfer`,
    token: token.symbol,
    tokenContract: tx.to,
    rawValue: rawAmount,
    transactionType: "erc20",
  };
}

function decodeTransferLog(log, direction) {
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC || topics.length < 3) return null;

  const token = MORPH_KNOWN_TOKENS[String(log.address || "").toLowerCase()];
  const from = topicToAddress(topics[1]);
  const to = topicToAddress(topics[2]);
  const rawAmount = String(log.data || "0x0");
  const amount = token ? `${formatUnits(rawAmount, token.decimals)} ${token.symbol}` : "ERC-20 transfer";
  return {
    from,
    to,
    amount,
    token: token?.symbol || "ERC-20",
    tokenContract: log.address,
    rawValue: rawAmount,
    transactionType: "erc20",
    direction,
    counterparty: direction === "outgoing" ? to : from,
  };
}

async function morphRpc(method, params = []) {
  const settings = await readSettings();
  const response = await fetch(settings.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) throw new Error(`Morph RPC failed: ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Morph RPC error");
  return payload.result;
}

async function getReceipt(txHash) {
  return morphRpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
}

async function pollReceipt(recordId, txHash, attempt = 0) {
  if (!recordId || !txHash || attempt > 30) return;

  const receipt = await getReceipt(txHash).catch(() => null);
  if (receipt) {
    await patchRecord(recordId, {
      status: receipt.status === "0x1" ? "confirmed" : "failed",
      txHash,
      blockNumber: receipt.blockNumber,
      confirmedAt: new Date().toISOString(),
    });
    return;
  }

  setTimeout(() => {
    void pollReceipt(recordId, txHash, attempt + 1);
  }, 3000);
}

async function syncRecord(record) {
  const settings = await readSettings();
  const endpoint = `${settings.appUrl.replace(/\/$/, "")}/api/extension-intent`;
  const payload = {
    id: record.id,
    mode: "wallet-assist",
    status: normalizeRecordStatus(record.status),
    chainId: record.chainId || settings.chainId,
    chainName: record.chainName || "Morph Hoodi Testnet",
    txHash: record.txHash,
    from: record.from,
    to: record.to || "unknown",
    amount: record.amount || "contract call",
    token: record.token || "ETH",
    category: record.category || "Other",
    counterparty: record.counterparty,
    note: record.note,
    project: record.project,
    source: record.source || record.origin || "browser-extension",
    origin: record.origin,
    pageTitle: record.pageTitle,
    method: record.method,
    provider: record.provider,
    rawValue: record.rawValue,
    callData: record.callData || record.data,
    tokenContract: record.tokenContract,
    transactionType: record.transactionType,
    direction: record.direction,
    blockNumber: record.blockNumber,
    confirmedAt: record.confirmedAt,
    detectionTiming: record.detectionTiming,
    reviewedAt: record.reviewedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  const installToken = await getOrCreateInstallToken();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paymemo-install-token": installToken,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Network-level failure: CORS preflight rejected, DNS failure, offline,
    // Vercel not reachable, etc. Surface the actual cause so the popup can
    // show "Failed to fetch: TypeError: ..." instead of a generic message.
    throw new Error(
      `Network error talking to ${endpoint}: ${error?.message ?? String(error)}`,
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const text = await response.text();
      if (text) {
        try {
          const json = JSON.parse(text);
          detail = json?.error || text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200);
        }
      }
    } catch {
      // ignore
    }
    throw new Error(
      `PayMemo sync failed: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`,
    );
  }
  const result = await response.json();
  await patchRecord(record.id, { syncStatus: "synced", syncedAt: new Date().toISOString() });
  return result;
}

function normalizeRecordStatus(status) {
  const allowed = new Set([
    "intent",
    "pending_signature",
    "pending_chain",
    "signed",
    "confirmed",
    "failed",
    "rejected",
    "needs-review",
  ]);
  return allowed.has(status) ? status : "needs-review";
}

async function openSidePanel() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (activeTab?.id && chrome.sidePanel?.setOptions) {
    await chrome.sidePanel
      .setOptions({ tabId: activeTab.id, path: "sidepanel.html", enabled: true })
      .catch(() => null);
  }
  if (activeTab?.id && chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: activeTab.id }).catch(async () => {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      if (focused?.id) await chrome.sidePanel.open({ windowId: focused.id });
    });
    return true;
  }
  return false;
}

async function openMemoPopup(record) {
  if (!record?.id || !chrome.windows?.create) return false;

  const url = chrome.runtime.getURL(`sidepanel.html?record=${encodeURIComponent(record.id)}&popup=1`);
  if (memoPopupWindowId && chrome.windows?.update) {
    const focused = await chrome.windows
      .update(memoPopupWindowId, { focused: true, width: 430, height: 720 })
      .catch(() => null);
    if (focused?.id) return true;
  }

  const created = await chrome.windows
    .create({ url, type: "popup", width: 430, height: 720, focused: true })
    .catch(() => null);
  memoPopupWindowId = created?.id || null;
  return Boolean(created?.id);
}

async function showRecordInActiveTab(record) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) return false;
  const response = await chrome.tabs
    .sendMessage(tab.id, { type: "PAYMEMO_SHOW_CAPTURE_FOR_RECORD", record })
    .catch(() => null);
  return Boolean(response?.ok);
}

async function showChainWatchPrompt(records) {
  const settings = await readSettings();
  if (!settings.autoOpenChainWatchPrompt) return;
  const allItems = Array.isArray(records) ? records : [records];
  if (!allItems.length) return;

  // Partner-wallet popups are opt-in. We still record the detection silently
  // (it'll appear in the dApp's Needs Review queue), we just don't interrupt
  // the user unless they've turned the toggle on.
  const items = settings.popupForPartnerWallets
    ? allItems
    : allItems.filter((record) => !record.isPartnerWallet);

  if (!items.length) {
    // Still update the badge so the user sees something landed in review.
    await chrome.action
      .setBadgeText({
        text: allItems.length > 1 ? String(allItems.length) : "!",
      })
      .catch(() => null);
    await chrome.action
      .setTitle({
        title: `${allItems.length} partner-wallet Morph tx detected (popup muted)`,
      })
      .catch(() => null);
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const tab = tabs?.[0];
  const canMessageTab = Boolean(tab?.id && /^https?:\/\//.test(tab.url || ""));

  if (canMessageTab) {
    const response = await chrome.tabs
      .sendMessage(tab.id, { type: "PAYMEMO_SHOW_CAPTURE_FOR_RECORD", record: items[0] })
      .catch(() => null);
    if (response?.ok) {
      await chrome.action.setBadgeText({ text: items.length > 1 ? String(items.length) : "!" });
      await chrome.action.setTitle({ title: `${items.length} Morph transaction${items.length === 1 ? "" : "s"} need PayMemo context` });
      return;
    }
  }

  await chrome.runtime
    .sendMessage({ type: "PAYMEMO_CHAIN_WATCH_FOUND", count: items.length })
    .catch(() => null);
  const openedPopup = await openMemoPopup(items[0]).catch(() => false);
  if (!openedPopup) await openSidePanel().catch(() => null);
  await chrome.action.setBadgeText({ text: items.length > 1 ? String(items.length) : "!" });
  await chrome.action.setTitle({ title: `${items.length} Morph transaction${items.length === 1 ? "" : "s"} need PayMemo context` });
}

async function createChainWatchRecord(tx, receipt, direction, settings = {}, details = {}) {
  const failed = receipt?.status === "0x0";
  const amount = details.amount || `${formatEther(tx.value)} ETH`;
  const labels = settings.watchedWalletLabels || {};
  const partners = normalizeAddresses(settings.partnerWalletAddresses);
  const watchedWallet =
    details.watchedWallet ||
    (direction === "outgoing"
      ? String(tx.from || "").toLowerCase()
      : String(tx.to || "").toLowerCase());
  const walletLabel = labels[watchedWallet] || "Watched Morph wallet";
  const isPartnerWallet = partners.includes(watchedWallet);
  const counterparty =
    details.counterparty ||
    (direction === "outgoing" ? tx.to || "contract interaction" : tx.from || "unknown sender");

  return upsertRecord({
    mode: "wallet-assist",
    status: failed ? "failed" : "needs-review",
    chainId: 2910,
    chainName: "Morph Hoodi Testnet",
    txHash: tx.hash,
    from: details.from || tx.from || "",
    to: details.to || tx.to || "contract interaction",
    amount,
    token: details.token || "ETH",
    category: "Other",
    counterparty,
    note: `Detected ${direction} transaction for ${walletLabel}. Add what this Morph testnet payment was for.`,
    project: walletLabel,
    origin: "Morph Hoodi chain watch",
    source: "Morph Hoodi chain watch",
    provider: "Morph Chain Watch",
    method: "morph-chain-watch",
    rawValue: details.rawValue || tx.value || "0x0",
    tokenContract: details.tokenContract,
    transactionType: details.transactionType || "native",
    blockNumber: receipt?.blockNumber,
    confirmedAt: receipt ? new Date().toISOString() : undefined,
    syncStatus: "local",
    detectionTiming: "post-broadcast",
    direction,
    isPartnerWallet,
    watchedWallet,
    walletLabel,
  });
}

async function findTransferLogRecords({ startBlock, latestBlock, watchedAddresses, seen, existingTxHashes, settings }) {
  const found = [];
  const directions = [
    { direction: "outgoing", topicIndex: 1 },
    { direction: "incoming", topicIndex: 2 },
  ];

  for (const watchedAddress of watchedAddresses) {
    const watchedTopic = padAddressTopic(watchedAddress);
    if (!watchedTopic) continue;

    for (const config of directions) {
      const topics = [ERC20_TRANSFER_TOPIC, null, null];
      topics[config.topicIndex] = watchedTopic;
      const logs = await morphRpc("eth_getLogs", [
        {
          fromBlock: numberToHex(startBlock),
          toBlock: numberToHex(latestBlock),
          topics,
        },
      ]).catch(() => []);

      for (const log of Array.isArray(logs) ? logs : []) {
        const hash = String(log.transactionHash || "").toLowerCase();
        if (!hash || seen.has(hash) || existingTxHashes.has(hash)) continue;

        const transfer = decodeTransferLog(log, config.direction);
        if (!transfer) continue;

        const tx =
          (await morphRpc("eth_getTransactionByHash", [log.transactionHash]).catch(() => null)) ||
          {
            hash: log.transactionHash,
            from: transfer.from,
            to: transfer.to,
            value: "0x0",
          };
        const receipt = await getReceipt(log.transactionHash);
        const record = await createChainWatchRecord(tx, receipt, config.direction, settings, {
          ...transfer,
          watchedWallet: watchedAddress,
          to: transfer.to,
        });
        found.push(record);
        await syncRecord(record).catch(() => null);
        seen.add(hash);
        existingTxHashes.add(hash);
      }
    }
  }

  return found;
}

async function scanMorphChainWatch({ forceRecent = false } = {}) {
  const settings = await readSettings();
  const watchedAddresses = normalizeAddresses(settings.watchedAddresses);

  if (!settings.chainWatchEnabled || !watchedAddresses.length) {
    return {
      ok: true,
      enabled: settings.chainWatchEnabled,
      watched: watchedAddresses.length,
      found: 0,
    };
  }

  const latestHex = await morphRpc("eth_blockNumber");
  const latestBlock = hexToNumber(latestHex);

  // Per-wallet state: each watched address has its own lastBlock and seenTxHashes.
  const states = await Promise.all(
    watchedAddresses.map((wallet) => readWatchState(wallet)),
  );
  const stateMap = new Map(watchedAddresses.map((wallet, index) => [wallet, states[index]]));

  // Combine seen hashes across all states so any prior detection skips.
  const seen = new Set();
  for (const state of states) {
    (state.seenTxHashes || []).forEach((hash) => seen.add(String(hash).toLowerCase()));
  }
  // Also union in the dApp-owned hashes so /app/send transactions never
  // trigger a duplicate popup or duplicate review record.
  const handled = await readHandledTxHashes();
  handled.forEach((hash) => seen.add(hash));

  const existingRecords = await readRecords();
  const existingTxHashes = new Set(
    existingRecords.map((record) => record.txHash?.toLowerCase()).filter(Boolean),
  );

  // The scan start block is the oldest lastBlock across watched wallets.
  const minLastBlock = states.reduce((min, state) => {
    if (!state.lastBlock) return min;
    if (min === 0) return state.lastBlock;
    return Math.min(min, state.lastBlock);
  }, 0);

  const startBlock = forceRecent
    ? Math.max(0, latestBlock - 8)
    : minLastBlock
      ? Math.max(minLastBlock + 1, latestBlock - 8)
      : Math.max(0, latestBlock - 2);

  const found = [];

  for (let blockNumber = startBlock; blockNumber <= latestBlock; blockNumber += 1) {
    const block = await morphRpc("eth_getBlockByNumber", [numberToHex(blockNumber), true]).catch(
      () => null,
    );
    const transactions = Array.isArray(block?.transactions) ? block.transactions : [];

    for (const tx of transactions) {
      const hash = String(tx.hash || "").toLowerCase();
      if (!hash || seen.has(hash) || existingTxHashes.has(hash)) continue;

      const from = String(tx.from || "").toLowerCase();
      const to = String(tx.to || "").toLowerCase();
      const isOutgoing = watchedAddresses.includes(from);
      const isIncoming = watchedAddresses.includes(to);
      if (!isOutgoing && !isIncoming) continue;

      const receipt = await getReceipt(tx.hash);
      const knownTokenTransfer = isOutgoing ? decodeKnownErc20Transfer(tx) : null;
      const record = await createChainWatchRecord(
        tx,
        receipt,
        isOutgoing ? "outgoing" : "incoming",
        settings,
        knownTokenTransfer || {},
      );
      found.push(record);
      await syncRecord(record).catch(() => null);
      seen.add(hash);
      existingTxHashes.add(hash);

      // Mark this hash seen on the relevant wallet's state too.
      const ownerWallet = isOutgoing ? from : to;
      const ownerState = stateMap.get(ownerWallet);
      if (ownerState) {
        const ownerSeen = new Set((ownerState.seenTxHashes || []).map((value) => String(value).toLowerCase()));
        ownerSeen.add(hash);
        ownerState.seenTxHashes = Array.from(ownerSeen).slice(-300);
      }
    }
  }

  const transferRecords = await findTransferLogRecords({
    startBlock,
    latestBlock,
    watchedAddresses,
    seen,
    existingTxHashes,
    settings,
  });
  found.push(...transferRecords);

  const updatedAt = new Date().toISOString();
  await Promise.all(
    watchedAddresses.map((wallet) => {
      const state = stateMap.get(wallet) || { lastBlock: 0, seenTxHashes: [] };
      return writeWatchState(
        {
          lastBlock: latestBlock,
          seenTxHashes: state.seenTxHashes || [],
          updatedAt,
        },
        wallet,
      );
    }),
  );

  if (found.length) await showChainWatchPrompt(found);
  if (found.length) {
    await chrome.runtime
      .sendMessage({ type: "PAYMEMO_CHAIN_WATCH_FOUND", count: found.length })
      .catch(() => null);
  }

  return {
    ok: true,
    enabled: true,
    fromBlock: startBlock,
    latestBlock,
    watched: watchedAddresses.length,
    found: found.length,
    batch: found.length > 1,
  };
}

let liveWatchTimer = null;

function startLiveMorphWatch() {
  if (liveWatchTimer) clearTimeout(liveWatchTimer);

  const tick = async () => {
    const settings = await readSettings();
    if (!settings.chainWatchEnabled) {
      liveWatchTimer = null;
      return;
    }

    await scanMorphChainWatch().catch(() => null);
    liveWatchTimer = setTimeout(tick, Math.max(1500, settings.morphWatchIntervalMs || 2500));
  };

  liveWatchTimer = setTimeout(tick, 750);
}

async function configureMorphWatch(settings) {
  if (settings.chainWatchEnabled) {
    await chrome.alarms.create(MORPH_WATCH_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5,
    });
    startLiveMorphWatch();
    return;
  }

  if (liveWatchTimer) clearTimeout(liveWatchTimer);
  liveWatchTimer = null;
  await chrome.alarms.clear(MORPH_WATCH_ALARM);
}

chrome.runtime.onInstalled.addListener(async () => {
  const records = await readRecords();
  const settings = await saveSettings(await readSettings());
  await configureMorphWatch(settings);
  await writeRecords(records);
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => null);
});

chrome.runtime.onStartup?.addListener(async () => {
  await configureMorphWatch(await readSettings());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MORPH_WATCH_ALARM) {
    void scanMorphChainWatch().catch(() => null);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PAYMEMO_GET_STATE") {
    (async () => {
      const [records, settings] = await Promise.all([readRecords(), readSettings()]);
      const watched = normalizeAddresses(settings.watchedAddresses);
      const states = await Promise.all(watched.map((wallet) => readWatchState(wallet)));
      const watchState = states.reduce(
        (acc, state) => ({
          lastBlock: Math.max(acc.lastBlock || 0, state.lastBlock || 0),
          seenTxHashes: [...new Set([...(acc.seenTxHashes || []), ...(state.seenTxHashes || [])])].slice(-300),
          updatedAt:
            !acc.updatedAt || (state.updatedAt && state.updatedAt > acc.updatedAt)
              ? state.updatedAt
              : acc.updatedAt,
        }),
        { lastBlock: 0, seenTxHashes: [], updatedAt: "" },
      );
      void chrome.action.setBadgeText({ text: "" }).catch(() => null);
      sendResponse({ ok: true, records, settings, watchState });
    })();
    return true;
  }

  if (message?.type === "PAYMEMO_GET_INSTALL_TOKEN") {
    getOrCreateInstallToken()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_SAVE_SETTINGS") {
    saveSettings(message.settings || {}).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message?.type === "PAYMEMO_MERGE_WATCHED_WALLETS") {
    mergeWatchedWallets(message.wallets || [])
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_REGISTER_HANDLED_TX") {
    registerHandledTxHash(message.txHash, message.origin)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_SCAN_MORPH_NOW") {
    scanMorphChainWatch({ forceRecent: true })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_OPEN_SIDE_PANEL") {
    openSidePanel()
      .then((opened) => sendResponse({ ok: opened }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_SAVE_RECORD") {
    readSettings().then(async (settings) => {
      if (!settings.enabled) {
        sendResponse({ ok: false, skipped: true });
        return;
      }

      const saved = await upsertRecord({
        mode: "wallet-assist",
        status: "pending_signature",
        origin: sender.tab?.url || message.origin || "unknown",
        syncStatus: "local",
        ...message.record,
      });
      sendResponse({ ok: true, record: saved });
    });
    return true;
  }

  if (message?.type === "PAYMEMO_TX_SUBMITTED") {
    patchRecord(message.recordId, {
      status: "pending_chain",
      txHash: message.txHash,
      method: message.method,
    }).then((record) => {
      if (record?.txHash) void pollReceipt(record.id, record.txHash);
      sendResponse({ ok: true, record });
    });
    return true;
  }

  if (message?.type === "PAYMEMO_UPDATE_RECORD") {
    patchRecord(message.id, message.patch || {}).then((record) =>
      sendResponse({ ok: Boolean(record), record }),
    );
    return true;
  }

  if (message?.type === "PAYMEMO_OPEN_CAPTURE") {
    readRecords()
      .then((records) => records.find((item) => item.id === message.id))
      .then(async (record) => {
        if (!record) return false;
        const shown = await showRecordInActiveTab(record);
        if (!shown) await openSidePanel().catch(() => null);
        return shown;
      })
      .then((shown) => sendResponse({ ok: true, shownInline: Boolean(shown) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_SIGNED") {
    patchRecord(message.recordId, {
      status: "signed",
      method: message.method,
    }).then((record) => sendResponse({ ok: true, record }));
    return true;
  }

  if (message?.type === "PAYMEMO_REJECTED") {
    patchRecord(message.recordId, {
      status: "rejected",
      error: message.error || "Wallet request rejected",
    }).then((record) => sendResponse({ ok: true, record }));
    return true;
  }

  if (message?.type === "PAYMEMO_SYNC_RECORD") {
    readRecords()
      .then((records) => records.find((item) => item.id === message.id))
      .then(async (record) => {
        if (!record) return null;
        const result = await syncRecord(record);
        if (message.removeLocal) await deleteRecord(record.id);
        return result;
      })
      .then((result) => sendResponse({ ok: true, result, removedLocal: Boolean(message.removeLocal) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_SYNC_ALL") {
    readRecords()
      .then(async (records) => {
        const results = [];
        for (const record of records) {
          try {
            results.push(await syncRecord(record));
            if (message.removeLocal) await deleteRecord(record.id);
          } catch (error) {
            await patchRecord(record.id, { syncStatus: "sync-failed", syncError: error.message });
          }
        }
        return results;
      })
      .then((results) => sendResponse({ ok: true, count: results.length }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_CLEAR_SYNCED_RECORDS") {
    clearSyncedRecords()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAYMEMO_CLEAR_RECORDS") {
    chrome.storage.local.set({ [STORAGE_KEY]: [] }).then(async () => {
      await chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "PAYMEMO_CLEAR_WALLET_DATA") {
    const wallet = normalizeAddresses([message.wallet])[0];
    if (!wallet) {
      sendResponse({ ok: false, error: "Missing wallet address" });
      return true;
    }

    Promise.all([readRecords(), readSettings()])
      .then(async ([records, settings]) => {
        const nextRecords = records.filter(
          (record) =>
            String(record.from || "").toLowerCase() !== wallet &&
            String(record.to || "").toLowerCase() !== wallet,
        );
        const watchedAddresses = normalizeAddresses(settings.watchedAddresses).filter(
          (address) => address !== wallet,
        );
        const watchedWalletLabels = { ...(settings.watchedWalletLabels || {}) };
        delete watchedWalletLabels[wallet];
        await writeRecords(nextRecords);
        await saveSettings({ ...settings, watchedAddresses, watchedWalletLabels });
        await chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true, count: nextRecords.length });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

void readSettings()
  .then(configureMorphWatch)
  .catch(() => null);
