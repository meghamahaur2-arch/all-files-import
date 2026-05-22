// PayMemo side panel - two distinct surfaces:
//
//   1. Default mode (Chrome side panel): WALLET MANAGER ONLY.
//      Paste a Morph address, label it, start watching. Nothing else.
//      No list of detected transactions, no review surface - all of that
//      lives at /app/review on the dApp.
//
//   2. popupMode=1 (windowed prompt opened by background.js when a tx is
//      detected on a watched wallet): a single capture form for THAT tx.
//      Fill category + note, save, the window closes. Done.

const categories = [
  "Vendor Payment",
  "Invoice Payment",
  "Business Expense",
  "Payroll",
  "Personal",
  "Transfer to Self",
  "Refund",
  "Subscription",
  "Agent Task Payment",
  "Other",
];

let records = [];
let settings = {};
let panelStatus = "Add the wallets PayMemo should watch on Morph Hoodi.";
const urlParams = new URLSearchParams(location.search);
const focusedRecordId = urlParams.get("record") || "";
const popupMode = urlParams.get("popup") === "1";

if (popupMode) {
  panelStatus = "Tag this transaction - saved memos go to your dashboard's Completed tab.";
}

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

function shorten(value) {
  if (!value) return "-";
  const text = String(value);
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

function normalizeAddress(value) {
  const address = String(value || "")
    .trim()
    .toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

function normalizeAddresses(addresses) {
  const values = Array.isArray(addresses) ? addresses : String(addresses || "").split(/[\s,]+/);
  return values.map(normalizeAddress).filter(Boolean);
}

function chainWatchRecords(all) {
  const chainRecords = all.filter((record) => record.provider === "Morph Chain Watch");
  if (!popupMode) return [];
  if (focusedRecordId) {
    const focused = chainRecords.find((record) => record.id === focusedRecordId);
    if (focused) return [focused];
  }
  // popupMode without a specific id → use the newest detected record.
  return chainRecords
    .filter((record) => record.status !== "confirmed")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 1);
}

// -------- popupMode: single capture form for one detected tx ---------------

function captureCard(record) {
  const category = record.category || "Other";
  return `
    <section class="tx-card" data-record="${escapeHtml(record.id)}">
      <div class="tx-top">
        <div>
          <span class="mini-label">Morph Hoodi chain watch</span>
          <div class="amount">${escapeHtml(record.amount || "contract call")}</div>
          <p class="hint">${escapeHtml(record.txHash ? `Tx ${shorten(record.txHash)}` : "Detected Morph transaction")}</p>
        </div>
        <span class="pill">${escapeHtml(record.status || "needs-review")}</span>
      </div>
      <div class="meta">
        <div><span class="mini-label">From</span><strong>${escapeHtml(shorten(record.from))}</strong></div>
        <div><span class="mini-label">To</span><strong>${escapeHtml(shorten(record.to))}</strong></div>
      </div>
      <input data-field="category" type="hidden" value="${escapeHtml(category)}" />
      <div class="chips">
        ${categories
          .map(
            (item) =>
              `<button type="button" class="${item === category ? "active" : ""}" data-category="${escapeHtml(item)}">${escapeHtml(item)}</button>`,
          )
          .join("")}
      </div>
      <div class="field-grid">
        <label>Counterparty<input data-field="counterparty" value="${escapeHtml(record.counterparty || record.to || "")}" /></label>
        <label>Private note<textarea data-field="note">${escapeHtml(record.note || "")}</textarea></label>
        <label>Invoice, project, or task<input data-field="project" value="${escapeHtml(record.project || "")}" /></label>
      </div>
      <div class="actions" style="padding: 10px 0 0; border-top: 0; background: transparent; grid-template-columns: 1fr;">
        <button class="primary" data-sync="${escapeHtml(record.id)}" type="button">Save memo</button>
      </div>
    </section>
  `;
}

function renderCapturePopup(root) {
  const latest = records[0];
  root.innerHTML = `
    <div class="shell">
      <header>
        <img class="logo" src="icons/icon-48.png" width="40" height="40" alt="PayMemo" />
        <div>
          <span class="eyebrow">PayMemo capture</span>
          <h1>Tag this transaction</h1>
          <p class="subtitle">Add the category and a private note. Saved memos go straight to your dashboard's Completed tab.</p>
        </div>
      </header>
      <div class="scroll">
        ${
          latest
            ? captureCard(latest)
            : `<div class="empty">Loading detected transaction…</div>`
        }
      </div>
      <div class="status-line">${escapeHtml(panelStatus)}</div>
    </div>
  `;

  root.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const cardRoot = button.closest("[data-record]");
      cardRoot.querySelector('[data-field="category"]').value = button.dataset.category;
      cardRoot
        .querySelectorAll("[data-category]")
        .forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });

  root.querySelectorAll("[data-sync]").forEach((button) => {
    button.addEventListener("click", async () => {
      const originalText = button.textContent;
      button.textContent = "Saving…";
      button.disabled = true;
      const cardRoot = button.closest("[data-record]");
      const id = cardRoot.dataset.record;
      const source = records.find((item) => item.id === id);
      const patch = {
        category: cardRoot.querySelector('[data-field="category"]').value.trim() || "Other",
        counterparty: cardRoot.querySelector('[data-field="counterparty"]').value.trim(),
        note: cardRoot.querySelector('[data-field="note"]').value.trim(),
        project: cardRoot.querySelector('[data-field="project"]').value.trim(),
        status: source?.status === "failed" ? "failed" : "confirmed",
        provider: "Morph Chain Watch",
        method: "morph-chain-watch",
        reviewedAt: new Date().toISOString(),
      };
      const update = await sendMessage({ type: "PAYMEMO_UPDATE_RECORD", id, patch });
      if (!update.ok) {
        panelStatus = update.error || "Could not save this memo locally.";
        button.textContent = originalText;
        button.disabled = false;
        renderCapturePopup(root);
        return;
      }
      const synced = await sendMessage({ type: "PAYMEMO_SYNC_RECORD", id, removeLocal: true });
      panelStatus = synced.ok
        ? "Saved. The memo is now in your dashboard's Completed tab."
        : synced.error || "Saved locally, but dashboard sync failed.";
      // Close the popup window once the user is done.
      if (synced.ok) {
        setTimeout(() => window.close(), 600);
      } else {
        button.textContent = originalText;
        button.disabled = false;
        renderCapturePopup(root);
      }
    });
  });
}

// -------- default mode: wallet manager only --------------------------------

function renderWalletManager(root) {
  // Snapshot any in-progress typing so the 10s heartbeat doesn't wipe it
  // when re-render runs.
  const preservedInputs = new Map();
  root.querySelectorAll("input").forEach((el) => {
    if (el.id) preservedInputs.set(el.id, el.value);
  });
  const previouslyFocusedId = document.activeElement?.id || "";

  const watchedAddresses = normalizeAddresses(settings.watchedAddresses);
  const watchedLabels = settings.watchedWalletLabels || {};
  const chainWatchOn = Boolean(settings.chainWatchEnabled);
  const partnerSet = new Set(normalizeAddresses(settings.partnerWalletAddresses));

  const rows = watchedAddresses
    .map((address) => {
      const label = watchedLabels[address] || "Watched wallet";
      const isPartner = partnerSet.has(address);
      return `
        <li class="watch-row" data-address="${escapeHtml(address)}">
          <div class="watch-row-main">
            <strong>${escapeHtml(label)}</strong>
            <code class="watch-row-addr">${escapeHtml(shorten(address))}</code>
            <span class="watch-tag ${isPartner ? "is-partner" : "is-mine"}">
              ${isPartner ? "Partner" : "Main"}
            </span>
          </div>
          <button class="secondary watch-row-remove" data-remove="${escapeHtml(address)}" type="button">Remove</button>
        </li>
      `;
    })
    .join("");

  root.innerHTML = `
    <div class="shell">
      <header>
        <img class="logo" src="icons/icon-48.png" width="40" height="40" alt="PayMemo" />
        <div>
          <span class="eyebrow">PayMemo Watcher</span>
          <h1>Watched wallets</h1>
          <p class="subtitle">Add the Morph wallets PayMemo should listen to. When a transaction lands, this extension pops up a memo prompt - saved memos go to your dashboard's Completed tab.</p>
        </div>
      </header>
      <div class="scroll">
        <section class="tx-card watcher-card">
          <div class="tx-top">
            <div>
              <span class="mini-label">Status</span>
              <div class="amount">${chainWatchOn ? "Live" : "Paused"}</div>
              <p class="hint">${watchedAddresses.length} address${watchedAddresses.length === 1 ? "" : "es"} on watch.</p>
            </div>
            <label class="toggle">
              <input id="chainWatchToggle" type="checkbox" ${chainWatchOn ? "checked" : ""} />
              <span>${chainWatchOn ? "On" : "Off"}</span>
            </label>
          </div>

          <ul class="watch-list">
            ${
              rows ||
              `<li class="watch-empty">No wallets yet. Add one below and PayMemo will start watching Morph Hoodi.</li>`
            }
          </ul>

          <div class="field-grid watch-form">
            <label>Wallet address<input id="watchAddress" placeholder="0x..." spellcheck="false" autocomplete="off" /></label>
            <label>Label<input id="watchLabel" placeholder="Main wallet, Partner Bob, …" autocomplete="off" /></label>
          </div>
          <div class="panel-actions">
            <button class="primary" id="addWatch" type="button">Add wallet to watch</button>
          </div>
        </section>

        <section class="tx-card walletmgr-help">
          <p class="hint">
            Reviewing past memos and editing notes happens on the dashboard
            <a href="#" id="openDashboardLink">PayMemo /app/review</a>.
            This panel is just the wallet-watch control surface.
          </p>
        </section>
      </div>
      <div class="status-line">${escapeHtml(panelStatus)}</div>
    </div>
  `;

  root.querySelector("#chainWatchToggle")?.addEventListener("change", async (event) => {
    const next = await sendMessage({
      type: "PAYMEMO_SAVE_SETTINGS",
      settings: { ...settings, chainWatchEnabled: event.target.checked },
    });
    settings = next.settings || settings;
    panelStatus = event.target.checked
      ? "Watching Morph Hoodi for activity on the wallets above."
      : "Watcher paused.";
    renderWalletManager(root);
  });

  root.querySelector("#addWatch")?.addEventListener("click", async () => {
    const address = normalizeAddress(root.querySelector("#watchAddress")?.value);
    const label = root.querySelector("#watchLabel")?.value.trim();
    if (!address) {
      panelStatus = "Paste a valid 0x address (40 hex chars) before adding.";
      renderWalletManager(root);
      return;
    }
    const existing = normalizeAddresses(settings.watchedAddresses);
    const watchedWalletLabels = { ...(settings.watchedWalletLabels || {}) };
    if (label) watchedWalletLabels[address] = label;
    else if (!watchedWalletLabels[address]) watchedWalletLabels[address] = "Watched wallet";

    const next = await sendMessage({
      type: "PAYMEMO_SAVE_SETTINGS",
      settings: {
        ...settings,
        chainWatchEnabled: true,
        autoOpenChainWatchPrompt: true,
        watchedAddresses: [address, ...existing.filter((item) => item !== address)],
        watchedWalletLabels,
      },
    });
    if (!next.ok) {
      panelStatus = next.error || "Could not save this watched wallet.";
      renderWalletManager(root);
      return;
    }
    settings = next.settings || settings;
    panelStatus = `Watching ${shorten(address)} for Morph Hoodi activity.`;
    renderWalletManager(root);
  });

  root.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.dataset.remove;
      const next = normalizeAddresses(settings.watchedAddresses).filter((item) => item !== target);
      const labels = { ...(settings.watchedWalletLabels || {}) };
      delete labels[target];
      const response = await sendMessage({
        type: "PAYMEMO_SAVE_SETTINGS",
        settings: {
          ...settings,
          watchedAddresses: next,
          watchedWalletLabels: labels,
        },
      });
      settings = response.settings || settings;
      panelStatus = `Removed ${shorten(target)} from the watch list.`;
      renderWalletManager(root);
    });
  });

  root.querySelector("#openDashboardLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    const url = `${(settings.appUrl || "https://paymemo.vercel.app").replace(/\/$/, "")}/app/review`;
    chrome.tabs.create({ url });
  });

  // Restore typing + focus that survived the rerender.
  preservedInputs.forEach((value, id) => {
    const el = root.querySelector(`#${id}`);
    if (el && el.value === "") el.value = value;
  });
  if (previouslyFocusedId) {
    const focusTarget = root.querySelector(`#${previouslyFocusedId}`);
    if (focusTarget && typeof focusTarget.focus === "function") {
      focusTarget.focus();
      try {
        focusTarget.setSelectionRange(focusTarget.value.length, focusTarget.value.length);
      } catch {
        // not all input types support selection
      }
    }
  }
}

function render() {
  const root = document.querySelector("#app");
  if (popupMode) renderCapturePopup(root);
  else renderWalletManager(root);
}

async function load() {
  const state = await sendMessage({ type: "PAYMEMO_GET_STATE" });
  settings = state.settings || {};
  records = chainWatchRecords(state.records || []);
  render();
}

function isUserEditing() {
  const focused = document.activeElement;
  if (!focused) return false;
  const tag = focused.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.type === "PAYMEMO_RECORDS_UPDATED" ||
    message?.type === "PAYMEMO_CHAIN_WATCH_FOUND"
  ) {
    // In popupMode the user is mid-memo - never refresh. In wallet manager
    // mode we only refresh when they aren't typing into the form.
    if (popupMode) return;
    if (isUserEditing()) return;
    void load();
  }
});

// Wallet manager has nothing time-sensitive to refresh. We only re-poll
// every 30 seconds so the watch-list reflects external changes (e.g. the
// dApp adding a partner via postMessage). Popup mode never polls.
setInterval(() => {
  if (popupMode) return;
  if (isUserEditing()) return;
  void load();
}, 30000);

void load();
