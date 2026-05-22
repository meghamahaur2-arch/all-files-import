const recordsRoot = document.querySelector("#records");
const enabledInput = document.querySelector("#enabled");
const enabledText = document.querySelector("#enabledText");
const appUrlInput = document.querySelector("#appUrl");
const rpcUrlInput = document.querySelector("#rpcUrl");
const chainWatchInput = document.querySelector("#chainWatchEnabled");
const chainWatchText = document.querySelector("#chainWatchText");
const watchedAddressesInput = document.querySelector("#watchedAddresses");
const autoOpenChainWatchPromptInput = document.querySelector("#autoOpenChainWatchPrompt");
const popupForPartnerWalletsInput = document.querySelector("#popupForPartnerWallets");
const scanStatus = document.querySelector("#scanStatus");
const totalEl = document.querySelector("#total");
const pendingEl = document.querySelector("#pending");
const confirmedEl = document.querySelector("#confirmed");
const lastBlockEl = document.querySelector("#lastBlock");
const lastScanEl = document.querySelector("#lastScan");

let currentSettings = {};
let currentRecords = [];
let currentWatchState = {};
let liveScanTimer = null;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
  });
}

function parseWatchedWalletLines(value) {
  const labels = {};
  const addresses = [];
  String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/0x[a-fA-F0-9]{40}/);
      if (!match) return;
      const address = match[0].toLowerCase();
      const label = line
        .replace(match[0], "")
        .replace(/[|,\---:]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!addresses.includes(address)) addresses.push(address);
      if (label) labels[address] = label;
    });
  return { addresses, labels };
}

function formatWatchedWallets(settings = {}) {
  const labels = settings.watchedWalletLabels || {};
  const addresses = Array.isArray(settings.watchedAddresses)
    ? settings.watchedAddresses
    : String(settings.watchedAddresses || "").split(/[\s,]+/);
  return addresses
    .map((address) => String(address || "").trim().toLowerCase())
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address))
    .map((address) => (labels[address] ? `${labels[address]} | ${address}` : address))
    .join("\n");
}

function statusText(status) {
  const map = {
    pending_signature: "waiting sign",
    pending_chain: "verifying",
    confirmed: "confirmed",
    failed: "failed",
    rejected: "rejected",
    signed: "signed",
    "needs-review": "needs review",
  };
  return map[status] || status || "intent";
}

function renderStats(records) {
  totalEl.textContent = String(records.length);
  pendingEl.textContent = String(
    records.filter((record) =>
      ["pending_signature", "pending_chain", "signed"].includes(record.status),
    ).length,
  );
  confirmedEl.textContent = String(
    records.filter((record) => record.status === "confirmed").length,
  );
}

function renderWatchHealth(watchState = {}) {
  currentWatchState = watchState;
  lastBlockEl.textContent = watchState.lastBlock ? String(watchState.lastBlock) : "-";
  lastScanEl.textContent = watchState.updatedAt
    ? new Date(watchState.updatedAt).toLocaleTimeString()
    : "Not yet";
}

function render(records) {
  currentRecords = records;
  renderStats(records);

  if (!records.length) {
    recordsRoot.innerHTML = `
      <div class="empty">
        No wallet-assisted records yet.<br>
        Start a transaction on a supported EVM dApp and PayMemo will ask what it is for.
      </div>
    `;
    return;
  }

  recordsRoot.innerHTML = records
    .map(
      (record) => `
        <article class="record">
          <div class="record-top">
            <div>
              <strong>${escapeHtml(record.category || "Uncategorized")} - ${escapeHtml(record.amount || "contract call")}</strong>
              <span>${escapeHtml(record.counterparty || record.to || "Unknown counterparty")}</span>
            </div>
            <span class="pill ${escapeHtml(record.status)}">${escapeHtml(statusText(record.status))}</span>
          </div>
          <p>${escapeHtml(record.note || "No private note captured.")}</p>
          <span>${escapeHtml(record.provider || "injected EVM provider")}</span>
          <span>${escapeHtml(record.txHash ? `${record.txHash.slice(0, 10)}...${record.txHash.slice(-8)}` : record.method || "wallet request")}</span>
          <div class="record-actions">
            <button class="secondary" data-memo="${escapeHtml(record.id)}">Memo</button>
            <button class="secondary" data-sync="${escapeHtml(record.id)}">${record.syncStatus === "synced" ? "Synced" : "Sync"}</button>
            <button class="secondary" data-copy="${escapeHtml(record.id)}">Copy JSON</button>
          </div>
        </article>
      `,
    )
    .join("");

  recordsRoot.querySelectorAll("[data-sync]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Syncing";
      const response = await sendMessage({ type: "PAYMEMO_SYNC_RECORD", id: button.dataset.sync, removeLocal: true });
      button.textContent = response.ok ? "Moved" : "Failed";
      await load({ live: true });
    });
  });

  recordsRoot.querySelectorAll("[data-memo]").forEach((button) => {
    button.addEventListener("click", async () => {
      await sendMessage({ type: "PAYMEMO_OPEN_CAPTURE", id: button.dataset.memo });
      window.close();
    });
  });

  recordsRoot.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const record = currentRecords.find((item) => item.id === button.dataset.copy);
      if (!record) return;
      await navigator.clipboard.writeText(JSON.stringify(record, null, 2));
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy JSON";
      }, 1200);
    });
  });
}

function applySettings(settings, options = {}) {
  currentSettings = settings;
  enabledInput.checked = Boolean(settings.enabled);
  enabledText.textContent = settings.enabled ? "Active" : "Paused";
  chainWatchInput.checked = Boolean(settings.chainWatchEnabled);
  chainWatchText.textContent = settings.chainWatchEnabled ? "Watching Morph" : "Paused";
  autoOpenChainWatchPromptInput.checked = settings.autoOpenChainWatchPrompt !== false;
  if (popupForPartnerWalletsInput) {
    popupForPartnerWalletsInput.checked = Boolean(settings.popupForPartnerWallets);
  }

  // Don't fight the user. We only overwrite TEXT inputs when:
  //   - this is an explicit reload (not a background poll), AND
  //   - the user isn't currently typing into one of them.
  // The live-scan interval passes { live: true } so the textarea never
  // gets wiped while the user is half-way through pasting a wallet.
  const live = Boolean(options.live);
  const focused = document.activeElement;
  const editingText =
    focused === watchedAddressesInput ||
    focused === appUrlInput ||
    focused === rpcUrlInput;

  if (!live && !editingText) {
    appUrlInput.value = settings.appUrl || "";
    rpcUrlInput.value = settings.rpcUrl || "";
    watchedAddressesInput.value = formatWatchedWallets(settings);
  }
  configureLivePopupScan();
}

async function load(options = {}) {
  const response = await sendMessage({ type: "PAYMEMO_GET_STATE" });
  applySettings(response.settings || {}, options);
  renderWatchHealth(response.watchState || {});
  render(response.records || []);
}

function configureLivePopupScan() {
  if (liveScanTimer) {
    clearInterval(liveScanTimer);
    liveScanTimer = null;
  }

  if (!currentSettings.chainWatchEnabled) return;

  // Slower interval (was 3.5s - too aggressive, made the popup feel like it
  // was refreshing constantly and clobbered the textarea while typing).
  // The Vercel cron + Railway worker do the real-time work; this is just
  // a "stats fresh" tick.
  liveScanTimer = setInterval(async () => {
    // Pause completely while the user is typing into any field. Resume on
    // the next tick once they tab/click away.
    const focused = document.activeElement;
    const editing =
      focused && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName);
    if (editing) return;

    const response = await sendMessage({ type: "PAYMEMO_SCAN_MORPH_NOW" });
    if (response.ok && response.result?.found) {
      scanStatus.textContent = `Detected ${response.result.found} new Morph tx${response.result.found === 1 ? "" : "s"}.`;
    }
    // Live mode = update stats + records list, but DON'T touch text inputs.
    await load({ live: true });
  }, 10000);
}

enabledInput.addEventListener("change", async () => {
  const settings = await sendMessage({
    type: "PAYMEMO_SAVE_SETTINGS",
    settings: { ...currentSettings, enabled: enabledInput.checked },
  });
  applySettings(settings.settings || {});
  scanStatus.textContent = chainWatchInput.checked
    ? "Morph watcher is on. New txs without a memo will land in Review."
    : "Morph watcher paused.";
});

chainWatchInput.addEventListener("change", async () => {
  const watched = parseWatchedWalletLines(watchedAddressesInput.value);
  const settings = await sendMessage({
    type: "PAYMEMO_SAVE_SETTINGS",
    settings: {
      ...currentSettings,
      chainWatchEnabled: chainWatchInput.checked,
      watchedAddresses: watched.addresses,
      watchedWalletLabels: watched.labels,
      autoOpenChainWatchPrompt: autoOpenChainWatchPromptInput.checked,
      popupForPartnerWallets: Boolean(popupForPartnerWalletsInput?.checked),
    },
  });
  applySettings(settings.settings || {});
});

document.querySelector("#saveSettings").addEventListener("click", async () => {
  const watched = parseWatchedWalletLines(watchedAddressesInput.value);
  const response = await sendMessage({
    type: "PAYMEMO_SAVE_SETTINGS",
    settings: {
      ...currentSettings,
      appUrl: appUrlInput.value.trim(),
      rpcUrl: rpcUrlInput.value.trim(),
      chainWatchEnabled: chainWatchInput.checked,
      watchedAddresses: watched.addresses,
      watchedWalletLabels: watched.labels,
      autoOpenChainWatchPrompt: autoOpenChainWatchPromptInput.checked,
      popupForPartnerWallets: Boolean(popupForPartnerWalletsInput?.checked),
    },
  });
  applySettings(response.settings || {});
  scanStatus.textContent = response.ok
    ? "Settings saved. Morph watcher uses these wallet names."
    : "Settings could not be saved.";
});

document.querySelector("#openApp").addEventListener("click", () => {
  const url = `${(currentSettings.appUrl || "https://paymemo.vercel.app").replace(/\/$/, "")}/app/assist`;
  chrome.tabs.create({ url });
});

document.querySelector("#openSettingsPage")?.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

document.querySelector("#openSidePanel").addEventListener("click", async () => {
  const response = await sendMessage({ type: "PAYMEMO_OPEN_SIDE_PANEL" });
  if (!response.ok)
    scanStatus.textContent = response.error || "Open side panel from Chrome toolbar.";
});

document.querySelector("#useLastWallet").addEventListener("click", async () => {
  const detected = currentRecords
    .map((record) => record.from)
    .find((address) => /^0x[a-fA-F0-9]{40}$/.test(String(address || "")));
  if (!detected) {
    scanStatus.textContent = "No detected wallet address yet. Start one dApp transaction or paste it once.";
    return;
  }
  const parsed = parseWatchedWalletLines(watchedAddressesInput.value);
  const detectedKey = detected.toLowerCase();
  const next = Array.from(new Set([detectedKey, ...parsed.addresses]));
  const labels = {
    ...parsed.labels,
    [detectedKey]: parsed.labels[detectedKey] || "Last detected wallet",
  };
  watchedAddressesInput.value = next
    .map((address) => (labels[address] ? `${labels[address]} | ${address}` : address))
    .join("\n");
  const response = await sendMessage({
    type: "PAYMEMO_SAVE_SETTINGS",
    settings: {
      ...currentSettings,
      watchedAddresses: next,
      watchedWalletLabels: labels,
      chainWatchEnabled: true,
      autoOpenChainWatchPrompt: autoOpenChainWatchPromptInput.checked,
      popupForPartnerWallets: Boolean(popupForPartnerWalletsInput?.checked),
    },
  });
  applySettings(response.settings || {});
  scanStatus.textContent = "Wallet saved locally. Morph chain watch is on.";
});

document.querySelector("#openReview").addEventListener("click", () => {
  const url = `${(currentSettings.appUrl || "https://paymemo.vercel.app").replace(/\/$/, "")}/app/review`;
  chrome.tabs.create({ url });
});

document.querySelector("#openReviewBottom")?.addEventListener("click", () => {
  const url = `${(currentSettings.appUrl || "https://paymemo.vercel.app").replace(/\/$/, "")}/app/review`;
  chrome.tabs.create({ url });
});

document.querySelector("#copyDemo").addEventListener("click", async () => {
  const steps = [
    "1. Add Morph Hoodi to Bitget Wallet.",
    "2. Paste your Morph wallet address into PayMemo extension.",
    "3. Enable Morph Chain Watch.",
    "4. Click Side panel and keep it open.",
    "5. Send a Morph Hoodi tx from Bitget Wallet.",
    "6. Add the private memo when PayMemo detects the tx.",
    "7. Click Save & sync, then show it in the dApp.",
  ].join("\n");
  await navigator.clipboard.writeText(steps);
  scanStatus.textContent = "Demo steps copied.";
});

document.querySelector("#scanMorphNow").addEventListener("click", async () => {
  scanStatus.textContent = "Scanning Morph Hoodi...";
  const response = await sendMessage({ type: "PAYMEMO_SCAN_MORPH_NOW" });
  if (!response.ok) {
    scanStatus.textContent = response.error || "Morph scan failed.";
    return;
  }

  const result = response.result || {};
  scanStatus.textContent = `Scanned Morph blocks ${result.fromBlock ?? "-"}-${result.latestBlock ?? "-"}; found ${result.found ?? 0}.`;
  await load();
});

document.querySelector("#syncAll").addEventListener("click", async () => {
  scanStatus.textContent = "Syncing records to PayMemo...";
  const response = await sendMessage({ type: "PAYMEMO_SYNC_ALL", removeLocal: true });
  scanStatus.textContent = response.ok
    ? `Synced and removed ${response.count ?? 0} local record${response.count === 1 ? "" : "s"}.`
    : response.error || "Sync failed.";
  await load();
});

document.querySelector("#clearSynced")?.addEventListener("click", async () => {
  const response = await sendMessage({ type: "PAYMEMO_CLEAR_SYNCED_RECORDS" });
  scanStatus.textContent = response.ok
    ? `Cleared ${response.count ?? 0} synced local record${response.count === 1 ? "" : "s"}.`
    : response.error || "Could not clear synced records.";
  await load();
});

document.querySelector("#clear").addEventListener("click", async () => {
  await sendMessage({ type: "PAYMEMO_CLEAR_RECORDS" });
  render([]);
});

void load();
