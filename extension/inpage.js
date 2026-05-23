(function () {
  const ignoredHosts = new Set(["127.0.0.1", "localhost"]);
  const ignoredPayMemo =
    ignoredHosts.has(window.location.hostname) && window.location.port === "5174";
  if (ignoredPayMemo || window.location.hostname.includes("paymemo")) return;

  const watchedMethods = new Set([
    "eth_sendTransaction",
    "wallet_sendTransaction",
    "wallet_sendCalls",
    "wallet_prepareCalls",
    "eth_signTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData",
    "eth_signTypedData_v1",
    "eth_signTypedData_v3",
    "eth_signTypedData_v4",
  ]);

  const knownProviderRoots = [
    ["window.ethereum", () => window.ethereum],
    ["window.ethereum.selectedProvider", () => window.ethereum?.selectedProvider],
    ["window.metamask", () => window.metamask],
    ["window.rabby", () => window.rabby],
    ["window.rabby.ethereum", () => window.rabby?.ethereum],
    ["window.bitkeep.ethereum", () => window.bitkeep?.ethereum],
    ["window.bitget.ethereum", () => window.bitget?.ethereum],
    ["window.okxwallet", () => window.okxwallet],
    ["window.okxwallet.ethereum", () => window.okxwallet?.ethereum],
    ["window.okexchain", () => window.okexchain],
    ["window.trustwallet", () => window.trustwallet],
    ["window.trustwallet.ethereum", () => window.trustwallet?.ethereum],
    ["window.trustWallet", () => window.trustWallet],
    ["window.trustWallet.ethereum", () => window.trustWallet?.ethereum],
    ["window.phantom.ethereum", () => window.phantom?.ethereum],
    ["window.coinbaseWalletExtension", () => window.coinbaseWalletExtension],
    ["window.coinbaseWalletExtension.ethereum", () => window.coinbaseWalletExtension?.ethereum],
    ["window.BinanceChain", () => window.BinanceChain],
    ["window.binancew3w.ethereum", () => window.binancew3w?.ethereum],
    ["window.braveEthereum", () => window.braveEthereum],
    ["window.frameEthereum", () => window.frameEthereum],
    ["window.tally", () => window.tally],
    ["window.tally.ethereum", () => window.tally?.ethereum],
    ["window.zerionWallet", () => window.zerionWallet],
    ["window.zerionWallet.ethereum", () => window.zerionWallet?.ethereum],
    ["window.rainbow", () => window.rainbow],
    ["window.rainbow.ethereum", () => window.rainbow?.ethereum],
    ["window.onekey.ethereum", () => window.onekey?.ethereum],
    ["window.$onekey.ethereum", () => window.$onekey?.ethereum],
    ["window.safepalProvider", () => window.safepalProvider],
    ["window.safepalWallet.ethereum", () => window.safepalWallet?.ethereum],
    ["window.tokenpocket.ethereum", () => window.tokenpocket?.ethereum],
    ["window.tokenPocket.ethereum", () => window.tokenPocket?.ethereum],
    ["window.imToken", () => window.imToken],
    ["window.imToken.ethereum", () => window.imToken?.ethereum],
    ["window.coin98.provider", () => window.coin98?.provider],
    ["window.coin98.ethereum", () => window.coin98?.ethereum],
    ["window.coreEth", () => window.coreEth],
    ["window.avalanche", () => window.avalanche],
    ["window.ethereumProvider", () => window.ethereumProvider],
  ];

  const wrappedProviders = new WeakSet();
  const providerLabels = new WeakMap();

  function waitForContext(id) {
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ skipped: true });
      }, 45000);

      function onMessage(event) {
        // Same-window messages only — content.js (which posts these) runs
        // in the same window context, so event.source === window AND
        // event.origin matches the page's own origin.
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== "PAYMEMO_CONTEXT_READY" || event.data?.id !== id) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(event.data);
      }

      window.addEventListener("message", onMessage);
    });
  }

  function isPlainRequest(args) {
    return Boolean(args && typeof args === "object" && typeof args.method === "string");
  }

  function getSendPayload(args) {
    const [first, second] = args;

    if (typeof first === "string") {
      return { method: first, params: Array.isArray(second) ? second : second ? [second] : [] };
    }

    if (Array.isArray(first)) {
      return first.find(isPlainRequest) || null;
    }

    if (isPlainRequest(first)) return first;

    return null;
  }

  function normalizePayload(args) {
    if (isPlainRequest(args)) return args;
    return getSendPayload(Array.from(args || []));
  }

  function shouldCapture(payload) {
    return Boolean(payload?.method && watchedMethods.has(payload.method));
  }

  function detectWalletFlags(provider, providerLabel) {
    const label = String(providerLabel || "").toLowerCase();
    return {
      isMetaMask: Boolean(provider?.isMetaMask) || label.includes("metamask"),
      isRabby: Boolean(provider?.isRabby) || label.includes("rabby"),
      isTrust: Boolean(provider?.isTrust || provider?.isTrustWallet) || label.includes("trust"),
      isBitget:
        Boolean(provider?.isBitKeep || provider?.isBitget || provider?.isBitKeepWallet) ||
        label.includes("bitkeep") ||
        label.includes("bitget"),
      isPhantom: Boolean(provider?.isPhantom) || label.includes("phantom"),
      isOkx: Boolean(provider?.isOkxWallet || provider?.isOKExWallet) || label.includes("okx"),
      isCoinbase: Boolean(provider?.isCoinbaseWallet) || label.includes("coinbase"),
      isBrave: Boolean(provider?.isBraveWallet) || label.includes("brave"),
    };
  }

  function clonePayload(payload, provider, providerLabel) {
    return {
      ...payload,
      providerLabel,
      walletFlags: detectWalletFlags(provider, providerLabel),
    };
  }

  async function captureContext(payload, provider, providerLabel) {
    const id = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.postMessage(
      {
        type: "PAYMEMO_REQUEST_CONTEXT",
        id,
        payload: clonePayload(payload, provider, providerLabel),
      },
      window.location.origin,
    );

    const context = await waitForContext(id);
    return { id, context };
  }

  function postResult(id, context, method, result) {
    window.postMessage(
      {
        type: "PAYMEMO_REQUEST_RESULT",
        id,
        recordId: context.recordId,
        method,
        result,
      },
      window.location.origin,
    );
  }

  function postError(id, context, method, error) {
    window.postMessage(
      {
        type: "PAYMEMO_REQUEST_ERROR",
        id,
        recordId: context.recordId,
        method,
        error: error?.message || "Wallet request rejected",
      },
      window.location.origin,
    );
  }

  function makeRequestWrapper(provider, originalRequest, providerLabel) {
    return async function payMemoRequest(args) {
      const payload = normalizePayload(args);
      if (!shouldCapture(payload)) {
        return originalRequest(args);
      }

      const { id, context } = await captureContext(payload, provider, providerLabel);

      try {
        const result = await originalRequest(args);
        postResult(id, context, payload.method, result);
        return result;
      } catch (error) {
        postError(id, context, payload.method, error);
        throw error;
      }
    };
  }

  function makeSendWrapper(provider, originalSend, providerLabel) {
    return function payMemoSend(...args) {
      const payload = getSendPayload(args);
      if (!shouldCapture(payload)) {
        return originalSend(...args);
      }

      const callbackIndex = args.findIndex((item) => typeof item === "function");
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] : null;
      const run = async () => {
        const { id, context } = await captureContext(payload, provider, providerLabel);

        if (originalCallback) {
          args[callbackIndex] = function payMemoSendCallback(error, result) {
            if (error) {
              postError(id, context, payload.method, error);
            } else {
              postResult(id, context, payload.method, result);
            }
            return originalCallback.apply(this, arguments);
          };
        }

        try {
          const result = await originalSend(...args);
          if (!originalCallback) postResult(id, context, payload.method, result);
          return result;
        } catch (error) {
          if (!originalCallback) postError(id, context, payload.method, error);
          throw error;
        }
      };

      if (originalCallback) {
        run().catch(() => {});
        return undefined;
      }

      return run();
    };
  }

  function makeSendAsyncWrapper(provider, originalSendAsync, providerLabel) {
    return function payMemoSendAsync(...args) {
      const payload = getSendPayload(args);
      if (!shouldCapture(payload)) {
        return originalSendAsync(...args);
      }

      const callbackIndex = args.findIndex((item) => typeof item === "function");
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] : null;

      captureContext(payload, provider, providerLabel)
        .then(({ id, context }) => {
          if (originalCallback) {
            args[callbackIndex] = function payMemoSendAsyncCallback(error, result) {
              if (error) {
                postError(id, context, payload.method, error);
              } else {
                postResult(id, context, payload.method, result);
              }
              return originalCallback.apply(this, arguments);
            };
          }

          const result = originalSendAsync(...args);
          if (!originalCallback && result && typeof result.then === "function") {
            result
              .then((value) => postResult(id, context, payload.method, value))
              .catch((error) => postError(id, context, payload.method, error));
          }
          return result;
        })
        .catch(() => {
          if (originalCallback) originalCallback(new Error("PayMemo context capture failed."));
        });

      return undefined;
    };
  }

  function replaceMethod(provider, methodName, wrappedMethod) {
    try {
      provider[methodName] = wrappedMethod;
      return true;
    } catch {
      try {
        Object.defineProperty(provider, methodName, {
          configurable: true,
          value: wrappedMethod,
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  function markWrapped(provider, providerLabel) {
    wrappedProviders.add(provider);
    providerLabels.set(provider, providerLabel);
    try {
      Object.defineProperty(provider, "__paymemoWrapped", {
        configurable: true,
        value: providerLabel || true,
      });
    } catch {
      try {
        provider.__paymemoWrapped = providerLabel || true;
      } catch {
        // Some wallet providers are sealed; the WeakSet still tracks them.
      }
    }
  }

  function wrapProvider(provider, providerLabel) {
    if (!provider || wrappedProviders.has(provider) || provider.__paymemoWrapped) return false;

    let wrappedAny = false;

    if (typeof provider.request === "function") {
      const originalRequest = provider.request.bind(provider);
      wrappedAny =
        replaceMethod(
          provider,
          "request",
          makeRequestWrapper(provider, originalRequest, providerLabel),
        ) || wrappedAny;
    }

    if (typeof provider.send === "function") {
      const originalSend = provider.send.bind(provider);
      wrappedAny =
        replaceMethod(provider, "send", makeSendWrapper(provider, originalSend, providerLabel)) ||
        wrappedAny;
    }

    if (typeof provider.sendAsync === "function") {
      const originalSendAsync = provider.sendAsync.bind(provider);
      wrappedAny =
        replaceMethod(
          provider,
          "sendAsync",
          makeSendAsyncWrapper(provider, originalSendAsync, providerLabel),
        ) || wrappedAny;
    }

    if (!wrappedAny) return false;

    markWrapped(provider, providerLabel);
    return true;
  }

  function addCandidate(candidates, seen, label, provider) {
    if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return;
    if (seen.has(provider)) return;
    seen.add(provider);
    candidates.push([label, provider]);
  }

  function addProviderFamily(candidates, seen, label, root) {
    addCandidate(candidates, seen, label, root);
    if (!root || (typeof root !== "object" && typeof root !== "function")) return;

    addCandidate(candidates, seen, `${label}.ethereum`, root.ethereum);
    addCandidate(candidates, seen, `${label}.provider`, root.provider);
    addCandidate(candidates, seen, `${label}.evm`, root.evm);
    addCandidate(candidates, seen, `${label}.selectedProvider`, root.selectedProvider);

    if (Array.isArray(root.providers)) {
      root.providers.forEach((provider, index) => {
        addCandidate(candidates, seen, `${label}.providers[${index}]`, provider);
      });
    }
  }

  function getProviderCandidates() {
    const candidates = [];
    const seen = new WeakSet();

    for (const [label, getter] of knownProviderRoots) {
      try {
        addProviderFamily(candidates, seen, label, getter());
      } catch {
        // Ignore wallet namespace getters that throw before their extension is ready.
      }
    }

    return candidates;
  }

  function scanAndWrap() {
    let wrappedAny = false;
    for (const [label, provider] of getProviderCandidates()) {
      wrappedAny = wrapProvider(provider, label) || wrappedAny;
    }
    return wrappedAny;
  }

  window.addEventListener("eip6963:announceProvider", (event) => {
    const provider = event.detail?.provider;
    const name = event.detail?.info?.name || event.detail?.info?.rdns || "eip6963";
    wrapProvider(provider, `eip6963:${name}`);
  });

  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    // Older pages can ignore EIP-6963 provider discovery.
  }

  scanAndWrap();

  let attempts = 0;
  const interval = window.setInterval(() => {
    attempts += 1;
    scanAndWrap();
    if (attempts >= 300) window.clearInterval(interval);
  }, 100);
})();
