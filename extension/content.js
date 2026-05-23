const ignoredPayMemo =
  (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
  location.port === "5174";

if (!ignoredPayMemo && !location.hostname.includes("paymemo")) {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inpage.js");
  script.dataset.paymemo = "true";
  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

const categories = [
  "Payroll",
  "Vendor Payment",
  "Invoice Payment",
  "Bridge",
  "Swap",
  "Business Expense",
  "Refund",
  "Personal",
  "Transfer to Self",
  "Income",
  "Subscription",
  "API Payment",
  "Agent Task Payment",
  "Tool Usage",
  "Other",
];

const morphKnownTokens = {
  "0x1178341838b764dcffa5bceab1d41443fd71a227": { symbol: "USDC", decimals: 6 },
  "0x5300000000000000000000000000000000000011": { symbol: "WETH", decimals: 18 },
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shorten(value) {
  if (!value) return "unknown";
  const text = String(value);
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function hexWeiToEth(value) {
  if (!value || typeof value !== "string" || !value.startsWith("0x")) return "";
  try {
    const wei = BigInt(value);
    const whole = wei / 10n ** 18n;
    const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "");
  } catch {
    return "";
  }
}

function formatUnitsFromHex(hexValue, decimals) {
  if (!hexValue || typeof hexValue !== "string") return "";
  try {
    const units = BigInt(hexValue.startsWith("0x") ? hexValue : `0x${hexValue}`);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(decimals, "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return "";
  }
}

function decodeErc20Transfer(tx) {
  const data = String(tx.data || "");
  const token = morphKnownTokens[String(tx.to || "").toLowerCase()];
  if (!token || !data.startsWith("0xa9059cbb") || data.length < 138) return null;
  const recipientHex = data.slice(34, 74);
  const amountHex = data.slice(74, 138);
  const recipient = `0x${recipientHex.slice(-40)}`;
  const amount = formatUnitsFromHex(amountHex, token.decimals);
  return {
    to: recipient,
    amount: amount ? `${amount} ${token.symbol}` : "",
    token: token.symbol,
    tokenContract: tx.to,
  };
}

function parseTx(payload) {
  if (!payload) {
    return {
      provider: "unknown",
      to: "",
      from: "",
      amount: "",
      token: "ETH",
      method: "",
      rawValue: "",
      tokenContract: "",
      data: "",
    };
  }

  const tx = Array.isArray(payload.params) ? payload.params[0] || {} : {};
  const firstCall = Array.isArray(tx.calls) ? tx.calls[0] || {} : {};
  const to = tx.to || firstCall.to || "";
  const from = tx.from || payload.from || "";
  const rawValue = tx.value || firstCall.value || "";
  const ethAmount = hexWeiToEth(rawValue);
  const erc20 = decodeErc20Transfer({ ...tx, to, data: tx.data || firstCall.data || "" });

  return {
    provider: payload.providerLabel || "injected wallet",
    to: erc20?.to || to,
    from,
    amount: erc20?.amount || (ethAmount ? `${ethAmount} ETH` : ""),
    token: erc20?.token || "ETH",
    method: payload.method,
    rawValue,
    tokenContract: erc20?.tokenContract || "",
    data: tx.data || firstCall.data || "",
  };
}

function defaultCategory(payload, tx) {
  const method = payload?.method || "";
  if (method.includes("signTypedData")) return "Other";
  if (tx.data && tx.data !== "0x") return "Tool Usage";
  return "Vendor Payment";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        resolve({ ok: false, extensionUnavailable: true });
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, extensionUnavailable: true, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || {});
      });
    } catch (error) {
      resolve({
        ok: false,
        extensionUnavailable: true,
        error: error instanceof Error ? error.message : "Extension context unavailable",
      });
    }
  });
}

function renderOverlay(payload) {
  return new Promise((resolve) => {
    const existing = document.querySelector("#paymemo-capture-root");
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = "paymemo-capture-root";
    const shadow = root.attachShadow({ mode: "open" });
    const tx = parseTx(payload);
    const guessedCategory = defaultCategory(payload, tx);

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: block;
          pointer-events: none;
          background: rgba(7,8,11,.10);
          color: #f7f8f2;
          font-family: Geist, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          backdrop-filter: none;
        }
        .panel {
          position: fixed;
          top: 18px;
          right: 18px;
          width: min(430px, calc(100vw - 24px));
          max-height: calc(100vh - 36px);
          overflow: auto;
          pointer-events: auto;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 22px;
          background: rgba(12,14,19,.97);
          box-shadow: 0 24px 70px rgba(0,0,0,.42);
        }
        .top {
          position: relative;
          padding: 16px 17px 14px;
          background:
            linear-gradient(120deg, rgba(92,255,130,.26), rgba(11,11,15,.98)),
            #0b0b0f;
          color: white;
        }
        /* Red theme: a transaction was detected on a partner wallet, not
           the user's own. Make this very visually distinct so the user
           never mistakes a partner-tx prompt for one of their own. */
        .panel.partner .top {
          background:
            linear-gradient(120deg, rgba(255,82,82,.35), rgba(11,11,15,.98)),
            #1a0a0a;
        }
        .panel.partner .logo {
          box-shadow: 0 18px 40px rgba(255,82,82,.35);
        }
        .panel.partner .eyebrow { color: #ffb4b4; }
        .grain {
          position: absolute;
          inset: 0;
          opacity: .12;
          background-image: linear-gradient(90deg, rgba(255,255,255,.2) 1px, transparent 1px);
          background-size: 18px 18px;
        }
        .top-inner { position: relative; display: flex; gap: 12px; align-items: center; }
        .logo {
          display: block;
          width: 42px;
          height: 42px;
          border-radius: 12px;
          object-fit: contain;
          box-shadow: 0 18px 40px rgba(0,0,0,.25);
        }
        .eyebrow {
          font-size: 10px;
          font-weight: 900;
          letter-spacing: .18em;
          text-transform: uppercase;
          color: rgba(255,255,255,.72);
        }
        h1 { margin: 4px 0 0; font-size: 19px; line-height: 1.14; letter-spacing: -0.01em; }
        .body { padding: 16px; }
        .summary {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 14px;
        }
        .cell {
          min-width: 0;
          border: 1px solid rgba(255,255,255,.10);
          border-radius: 13px;
          background: rgba(255,255,255,.055);
          padding: 9px 10px;
        }
        .label {
          display: block;
          color: rgba(247,248,242,.52);
          font-size: 9px;
          font-weight: 900;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        .value {
          display: block;
          margin-top: 5px;
          overflow: hidden;
          color: #f7f8f2;
          font-size: 12px;
          font-weight: 750;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .chips { display: flex; flex-wrap: wrap; gap: 7px; margin: 8px 0 16px; }
        .chip {
          border: 1px solid rgba(255,255,255,.11);
          border-radius: 999px;
          background: rgba(255,255,255,.075);
          color: rgba(247,248,242,.78);
          padding: 7px 9px;
          font: 800 11px/1 inherit;
          cursor: pointer;
        }
        .chip.active { border-color: #5cff82; background: #5cff82; color: #071009; }
        label {
          display: block;
          margin-top: 12px;
          color: rgba(247,248,242,.55);
          font-size: 10px;
          font-weight: 900;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        input, textarea {
          width: 100%;
          margin-top: 7px;
          border: 1px solid rgba(255,255,255,.11);
          border-radius: 13px;
          background: rgba(0,0,0,.28);
          color: #f7f8f2;
          padding: 10px 11px;
          font: 13px/1.35 inherit;
          outline: none;
          box-shadow: inset 0 0 0 1px transparent;
        }
        input:focus, textarea:focus {
          border-color: #5cff82;
          box-shadow: 0 0 0 3px rgba(92,255,130,.18);
        }
        textarea { min-height: 62px; resize: vertical; }
        .toggle-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        .quick {
          border: 1px solid rgba(255,255,255,.11);
          border-radius: 14px;
          background: rgba(255,255,255,.075);
          color: #f7f8f2;
          padding: 10px;
          font: 850 12px/1 inherit;
          cursor: pointer;
        }
        .quick.active { background: rgba(92,255,130,.22); border-color: rgba(92,255,130,.45); }
        .lifecycle {
          margin-top: 13px;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          color: rgba(247,248,242,.48);
          font-size: 9px;
          font-weight: 900;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .life-dot { height: 4px; border-radius: 99px; background: rgba(255,255,255,.12); margin-bottom: 7px; }
        .life-dot.on { background: #5cff82; box-shadow: 0 0 18px rgba(92,255,130,.6); }
        .actions { display: grid; grid-template-columns: 1fr 1.4fr; gap: 9px; margin-top: 14px; }
        button {
          border: 0;
          border-radius: 13px;
          padding: 12px 12px;
          font: 900 13px/1 inherit;
          cursor: pointer;
        }
        .primary { background: #5cff82; color: #071009; box-shadow: 0 18px 45px rgba(92,255,130,.18); }
        .panel.partner .primary { background: #ff5c7a; color: #1a0a0a; box-shadow: 0 18px 45px rgba(255,92,122,.32); }
        .ghost { background: rgba(255,255,255,.08); color: rgba(247,248,242,.76); }
        .hint { margin: 11px 0 0; color: rgba(247,248,242,.52); font-size: 11px; line-height: 1.45; }
        @media (max-width: 520px) {
          .panel {
            top: 10px;
            right: 10px;
            width: calc(100vw - 20px);
          }
          .summary { grid-template-columns: 1fr; }
        }
      </style>
      <div class="wrap">
        <form class="panel ${payload.isPartnerWallet ? "partner" : ""}">
          <div class="top">
            <div class="grain"></div>
            <div class="top-inner">
              <img class="logo" src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="PayMemo" width="42" height="42" />
              <div>
                <div class="eyebrow">${payload.isPartnerWallet ? `Partner wallet · ${(payload.walletLabel || "Watched partner")}` : "PayMemo Wallet Assist"}</div>
                <h1>${payload.isPartnerWallet ? "Partner transaction detected" : "What is this transaction for?"}</h1>
              </div>
            </div>
          </div>
          <div class="body">
            <div class="summary">
              <div class="cell">
                <span class="label">Method</span>
                <span class="value">${escapeHtml(payload.method)}</span>
              </div>
              <div class="cell">
                <span class="label">Provider</span>
                <span class="value">${escapeHtml(shorten(tx.provider))}</span>
              </div>
              <div class="cell">
                <span class="label">Amount</span>
                <span class="value">${escapeHtml(tx.amount || "contract call")}</span>
              </div>
              <div class="cell">
                <span class="label">From</span>
                <span class="value">${escapeHtml(shorten(tx.from))}</span>
              </div>
              <div class="cell">
                <span class="label">To</span>
                <span class="value">${escapeHtml(shorten(tx.to))}</span>
              </div>
            </div>

            <span class="label">Category</span>
            <input type="hidden" name="category" value="${escapeHtml(guessedCategory)}" />
            <div class="chips">
              ${categories
                .slice(0, 10)
                .map(
                  (item) =>
                    `<button type="button" class="chip ${item === guessedCategory ? "active" : ""}" data-category="${escapeHtml(item)}">${escapeHtml(item)}</button>`,
                )
                .join("")}
            </div>

            <label>Counterparty</label>
            <input name="counterparty" placeholder="Vendor, wallet owner, protocol, API..." value="${escapeHtml(tx.to || "")}" />

            <div class="toggle-row">
              <button type="button" class="quick" data-kind="business">Mark as Business</button>
              <button type="button" class="quick" data-kind="personal">Mark as Personal</button>
            </div>

            <label>Private note</label>
            <textarea name="note" placeholder="Invoice, task, project, receipt, tax label..."></textarea>

            <label>Invoice, project, or task</label>
            <input name="project" placeholder="Project, task ID, client, workflow..." />

            <div class="lifecycle">
              <div><div class="life-dot on"></div>Intent</div>
              <div><div class="life-dot"></div>Sign</div>
              <div><div class="life-dot"></div>Verify</div>
              <div><div class="life-dot"></div>Ledger</div>
            </div>

            <div class="actions">
              <button class="ghost" type="button" data-skip>Skip</button>
              <button class="primary" type="submit">Save context and continue</button>
            </div>
            <p class="hint">PayMemo stores this context locally in the extension and tracks the tx hash if your wallet returns one.</p>
          </div>
        </form>
      </div>
    `;

    document.documentElement.appendChild(root);

    const categoryInput = shadow.querySelector('input[name="category"]');
    const chips = [...shadow.querySelectorAll(".chip")];
    const quicks = [...shadow.querySelectorAll(".quick")];

    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        chips.forEach((item) => item.classList.remove("active"));
        chip.classList.add("active");
        categoryInput.value = chip.dataset.category;
      });
    });

    quicks.forEach((button) => {
      button.addEventListener("click", () => {
        quicks.forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        if (button.dataset.kind === "personal") categoryInput.value = "Personal";
        if (button.dataset.kind === "business") categoryInput.value = "Business Expense";
        chips.forEach((item) => item.classList.remove("active"));
      });
    });

    const close = (record) => {
      root.remove();
      resolve(record);
    };

    shadow.querySelector("[data-skip]").addEventListener("click", () => close(null));
    shadow.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      close({
        source: window.location.origin,
        pageTitle: document.title,
        mode: "wallet-assist",
        status: "pending_signature",
        category: String(data.get("category")),
        counterparty: String(data.get("counterparty") || ""),
        note: String(data.get("note") || ""),
        project: String(data.get("project") || ""),
        to: tx.to || "unknown",
        from: tx.from || "",
        amount: tx.amount || "contract call",
        token: tx.token,
        method: tx.method,
        rawValue: tx.rawValue,
        callData: tx.data,
        tokenContract: tx.tokenContract,
        transactionType: tx.tokenContract ? "erc20" : tx.data && tx.data !== "0x" ? "contract-call" : "native",
        provider: tx.provider,
      });
    });
  });
}

function extractTxHash(result) {
  if (typeof result === "string" && /^0x[a-fA-F0-9]{64}$/.test(result)) return result;
  if (typeof result?.result === "string" && /^0x[a-fA-F0-9]{64}$/.test(result.result)) {
    return result.result;
  }
  if (
    typeof result?.transactionHash === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)
  ) {
    return result.transactionHash;
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const txHash = extractTxHash(item);
      if (txHash) return txHash;
    }
  }
  return "";
}

const PAYMEMO_ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "paymemo.app",
  "paymemo.vercel.app",
]);

function isAllowedPayMemoOrigin() {
  if (typeof window === "undefined" || !window.location) return false;
  if (window.top !== window.self) return false;
  if (location.protocol !== "https:" && location.protocol !== "http:") return false;
  if (location.protocol === "http:" && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    return false;
  }
  if (PAYMEMO_ALLOWED_HOSTS.has(location.hostname)) return true;
  if (location.hostname.endsWith(".paymemo.app")) return true;
  // Vercel preview deployments: `<project>-<hash>-<team>.vercel.app`.
  if (location.hostname.endsWith(".vercel.app") && location.hostname.includes("paymemo")) {
    return true;
  }
  return false;
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;

  if (event.data?.type === "PAYMEMO_REQUEST_INSTALL_TOKEN") {
    if (!isAllowedPayMemoOrigin()) return;
    const response = await sendRuntimeMessage({ type: "PAYMEMO_GET_INSTALL_TOKEN" });
    window.postMessage(
      {
        type: "PAYMEMO_INSTALL_TOKEN",
        requestId: event.data.requestId,
        token: response.token,
        ok: Boolean(response.ok),
      },
      window.location.origin,
    );
    return;
  }

  if (event.data?.type === "PAYMEMO_SYNC_WATCHED_WALLETS_FROM_APP") {
    if (!isAllowedPayMemoOrigin()) return;

    await sendRuntimeMessage({
      type: "PAYMEMO_MERGE_WATCHED_WALLETS",
      wallets: event.data.wallets || [],
    });
    return;
  }

  if (event.data?.type === "PAYMEMO_CLEAR_WALLET_DATA_FROM_APP") {
    if (!isAllowedPayMemoOrigin()) return;

    await sendRuntimeMessage({
      type: "PAYMEMO_CLEAR_WALLET_DATA",
      wallet: event.data.wallet,
    });
    return;
  }

  if (event.data?.type === "PAYMEMO_DAPP_TX_HANDLED") {
    if (!isAllowedPayMemoOrigin()) return;
    const txHash = String(event.data.txHash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) return;
    await sendRuntimeMessage({
      type: "PAYMEMO_REGISTER_HANDLED_TX",
      txHash,
      origin: event.data.origin || "paymemo-dapp",
    });
    return;
  }

  if (event.data?.type === "PAYMEMO_REQUEST_CONTEXT") {
    const record = await renderOverlay(event.data.payload);
    if (!record) {
      window.postMessage(
        { type: "PAYMEMO_CONTEXT_READY", id: event.data.id, skipped: true },
        window.location.origin,
      );
      return;
    }

    const response = await sendRuntimeMessage({ type: "PAYMEMO_SAVE_RECORD", record });
    window.postMessage(
      {
        type: "PAYMEMO_CONTEXT_READY",
        id: event.data.id,
        recordId: response.record?.id,
      },
      window.location.origin,
    );
  }

  if (event.data?.type === "PAYMEMO_REQUEST_RESULT") {
    const result = event.data.result;
    const txHash = extractTxHash(result);

    if (txHash) {
      await sendRuntimeMessage({
        type: "PAYMEMO_TX_SUBMITTED",
        recordId: event.data.recordId,
        txHash,
        method: event.data.method,
      });
      return;
    }

    await sendRuntimeMessage({
      type: "PAYMEMO_SIGNED",
      recordId: event.data.recordId,
      method: event.data.method,
    });
  }

  if (event.data?.type === "PAYMEMO_REQUEST_ERROR") {
    await sendRuntimeMessage({
      type: "PAYMEMO_REJECTED",
      recordId: event.data.recordId,
      method: event.data.method,
      error: event.data.error,
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PAYMEMO_SHOW_CAPTURE_FOR_RECORD" || !message.record) return false;

  // Never show the capture overlay on PayMemo's own domain - the dApp has its
  // own /app/review UI and renders its own memo prompts. The overlay is for
  // 3rd-party dApps only.
  if (isAllowedPayMemoOrigin()) {
    sendResponse({ ok: false, reason: "skipped-on-paymemo-origin" });
    return true;
  }

  const record = message.record;
  const payload = {
    method: "morph-chain-watch",
    providerLabel: "Morph Chain Watch",
    isPartnerWallet: Boolean(record.isPartnerWallet),
    walletLabel: record.walletLabel || record.project || "",
    params: [
      {
        from: record.from || "",
        to: record.to || "",
        value: record.rawValue || "0x0",
      },
    ],
  };

  renderOverlay(payload)
    .then((captured) => {
      if (!captured) {
        sendResponse({ ok: true, skipped: true });
        return null;
      }

      return sendRuntimeMessage({
        type: "PAYMEMO_UPDATE_RECORD",
        id: record.id,
        patch: {
          ...captured,
          status: record.status === "failed" ? "failed" : "confirmed",
          method: "morph-chain-watch",
          provider: "Morph Chain Watch",
          origin: record.origin || "Morph Hoodi chain watch",
          reviewedAt: new Date().toISOString(),
        },
      }).then(async (response) => {
        if (response.ok) {
          await sendRuntimeMessage({
            type: "PAYMEMO_SYNC_RECORD",
            id: record.id,
            removeLocal: true,
          });
        }
        sendResponse({ ok: Boolean(response.ok), record: response.record });
      });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});
