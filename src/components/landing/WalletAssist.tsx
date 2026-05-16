import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { ArrowRight, Bot, Check, Lock, MousePointer2, ShieldCheck, Sparkles } from "lucide-react";
import metamaskLogo from "@/assets/metamask.png";

/**
 * Wallet-Assist intercept demo (Mode 02). Token-themed so it works in both modes.
 * A synthetic on-stage cursor moves between targets for every step so users can
 * follow exactly what's happening.
 */

const STEPS = [
  { id: 0, label: "Open dApp · pay invoice", duration: 3200 },
  { id: 1, label: "Wallet asks to sign", duration: 3600 },
  { id: 2, label: "PayMemo intercepts", duration: 5200 },
  { id: 3, label: "Tag the payment", duration: 4200 },
  { id: 4, label: "Signed & remembered", duration: 4400 },
] as const;

// Cursor positions per step, as % of the stage box.
// Each position is tuned to land on the actual interactive target shown in that step.
const CURSOR_POS: { x: string; y: string; label: string }[] = [
  // Step 0: hovering the "PAY WITH WALLET" button on invoice.studio
  { x: "50%", y: "70%", label: "pay" },
  // Step 1: hovering "CONFIRM" inside the MetaMask popup (top-right, 300px wide)
  { x: "82%", y: "33%", label: "confirm" },
  // Step 2: hovering the typewriter input inside PayMemo intercept modal
  { x: "50%", y: "58%", label: "type" },
  // Step 3: hovering the auto-tags row inside the intercept modal
  { x: "44%", y: "48%", label: "tag" },
  // Step 4: hovering the "SIGN & REMEMBER" / receipt confirmation
  { x: "50%", y: "52%", label: "submit" },
];

export function WalletAssist() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t = setTimeout(
      () => setStep((s) => (s + 1) % STEPS.length),
      STEPS[step].duration
    );
    return () => clearTimeout(t);
  }, [step]);

  return (
    <section
      id="wallet-assist"
      className="relative overflow-hidden bg-background text-foreground py-28 sm:py-36 px-6 border-y border-foreground/10"
    >
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(900px_500px_at_80%_20%,color-mix(in_oklab,var(--pink)_20%,transparent),transparent_60%)]" />
      <div aria-hidden className="absolute inset-0 grain opacity-[0.06] mix-blend-overlay" />

      <div className="relative mx-auto max-w-7xl grid lg:grid-cols-[0.9fr_1.1fr] gap-16 items-center">
        <div>
          <span className="font-body-alt text-[11px] uppercase tracking-[0.32em] text-[var(--pink)]">
            Mode 02 · Wallet-Assist
          </span>
          <h2 className="font-display mt-5 text-[10vw] sm:text-[5.5rem] leading-[0.88]">
            THE QUIET <br />
            <span className="font-serif-italic font-normal text-[var(--pink)]">intercept.</span>
          </h2>
          <p className="font-body-alt mt-7 max-w-[44ch] text-base text-foreground/65 leading-relaxed">
            Keep your wallet. Keep your dApps. PayMemo slides in for one second
            before you sign · just long enough to ask{" "}
            <em className="font-serif-italic text-foreground/85">what is this for</em>{" "}
            · then steps aside and lets the chain do its thing.
          </p>

          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-foreground/25 bg-foreground/5 px-3 py-1.5 text-[10px] font-display tracking-[0.28em] text-foreground/80">
            <Bot className="h-3.5 w-3.5" /> WORKS FOR AI AGENTS TOO
          </div>

          <ol className="mt-10 space-y-3">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={`flex items-center gap-4 font-body-alt text-sm transition-colors duration-500 ${
                  step === i ? "text-foreground" : "text-foreground/35"
                }`}
              >
                <span
                  className={`grid h-6 w-10 place-items-center rounded-sm font-display text-[11px] tracking-widest transition-colors duration-500 ${
                    step === i
                      ? "bg-foreground text-background"
                      : "bg-foreground/5 text-foreground/40"
                  }`}
                >
                  0{i + 1}
                </span>
                <span className="uppercase tracking-[0.2em]">{s.label}</span>
                {step === i && (
                  <motion.span
                    layoutId="step-bar"
                    className="ml-3 h-px flex-1 bg-gradient-to-r from-[var(--pink)] to-transparent"
                  />
                )}
              </li>
            ))}
          </ol>
        </div>

        <BrowserStage step={step} />
      </div>
    </section>
  );
}

function BrowserStage({ step }: { step: number }) {
  return (
    <div className="dark relative bg-transparent text-foreground">
      <div className="rounded-3xl border border-foreground/10 bg-card text-card-foreground shadow-card overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-foreground/10">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--pink)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--papaya)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-foreground/30" />
          <div className="ml-4 flex-1 rounded-md bg-foreground/5 px-3 py-1 text-[11px] font-mono text-foreground/50 truncate">
            invoice.studio · pay 2,400 USDC
          </div>
        </div>

        <div className="relative h-[540px] bg-background">
          <DappBackground active={step === 0} highlightPay={step === 0} />

          <AnimatePresence>
            {step === 1 && <MetaMaskPopup key="mm" />}
          </AnimatePresence>

          <AnimatePresence>
            {step === 2 && <PayMemoIntercept key="pm-ask" mode="ask" />}
            {step === 3 && <PayMemoIntercept key="pm-tag" mode="tag" />}
          </AnimatePresence>

          <AnimatePresence>{step === 4 && <Receipt key="rc" />}</AnimatePresence>

          {/* Visual cursor that moves per step */}
          <DemoCursor step={step} />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="absolute -top-5 -right-3 sm:right-6 inline-flex items-center gap-2 rounded-full bg-[var(--pink)] text-background px-4 py-1.5 text-[10px] font-display tracking-[0.25em]"
      >
        <Sparkles className="h-3 w-3" /> LIVE INTERCEPT
      </motion.div>
    </div>
  );
}

function DemoCursor({ step }: { step: number }) {
  const pos = CURSOR_POS[step] ?? CURSOR_POS[0];
  return (
    <motion.div
      aria-hidden
      initial={false}
      animate={{ left: pos.x, top: pos.y }}
      transition={{ type: "spring", stiffness: 110, damping: 20, mass: 0.7 }}
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
    >
      {/* soft glow */}
      <motion.div
        key={`glow-${step}`}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: [0.6, 1.4, 1], opacity: [0, 0.55, 0.35] }}
        transition={{ duration: 1.6, repeat: Infinity, repeatType: "reverse" }}
        className="absolute -inset-3 rounded-full bg-[var(--pink)] blur-xl"
      />
      <div className="relative flex items-center gap-2">
        <MousePointer2 className="h-5 w-5 text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)] fill-background" />
        <motion.span
          key={`lbl-${step}`}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          className="rounded-full bg-foreground text-background px-2 py-0.5 text-[10px] font-display tracking-[0.18em] uppercase"
        >
          {pos.label}
        </motion.span>
      </div>
    </motion.div>
  );
}

function DappBackground({ active, highlightPay }: { active: boolean; highlightPay: boolean }) {
  return (
    <motion.div
      animate={{
        opacity: active ? 1 : 0.4,
        filter: active ? "blur(0px)" : "blur(2px)",
      }}
      transition={{ duration: 0.7 }}
      className="absolute inset-0 p-8"
    >
      <div className="font-display text-[11px] tracking-[0.3em] text-foreground/45">
        INVOICE.STUDIO
      </div>
      <div className="mt-4 font-display text-4xl text-foreground">
        Pay <span className="font-serif-italic font-normal text-[var(--pink)]">Anya Petrova</span>
      </div>
      <div className="mt-2 font-mono text-sm text-foreground/55">
        0x9f2…c41 · June design retainer
      </div>

      <div className="mt-10 rounded-2xl border border-foreground/10 bg-foreground/[0.04] p-6">
        <div className="flex items-center justify-between">
          <span className="font-body-alt text-xs uppercase tracking-[0.25em] text-foreground/45">
            Amount
          </span>
          <span className="font-display text-3xl text-foreground">2,400.00 USDC</span>
        </div>
        <motion.div
          animate={
            highlightPay
              ? { boxShadow: ["0 0 0 0 color-mix(in oklab, var(--pink) 0%, transparent)", "0 0 0 8px color-mix(in oklab, var(--pink) 35%, transparent)", "0 0 0 0 color-mix(in oklab, var(--pink) 0%, transparent)"] }
              : { boxShadow: "0 0 0 0 transparent" }
          }
          transition={{ duration: 1.6, repeat: highlightPay ? Infinity : 0 }}
          className="relative mt-6 h-12 rounded-xl bg-[var(--pink)] grid place-items-center text-background font-display tracking-[0.2em] text-sm"
        >
          PAY WITH WALLET →
        </motion.div>
      </div>
    </motion.div>
  );
}

function MetaMaskPopup() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -24, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 180, damping: 22 }}
      className="absolute right-6 top-6 w-[300px] rounded-2xl bg-card border border-foreground/15 shadow-card overflow-hidden"
    >
      <motion.div
        animate={{ boxShadow: ["0 0 0 0 transparent", "0 0 0 6px color-mix(in oklab, var(--papaya) 35%, transparent)", "0 0 0 0 transparent"] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="absolute inset-0 rounded-2xl pointer-events-none"
      />
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-foreground/10">
        <img
          src={metamaskLogo}
          alt="MetaMask"
          width={20}
          height={20}
          loading="lazy"
          decoding="async"
          className="h-5 w-5 object-contain opacity-80"
        />
        <span className="font-display text-[11px] tracking-[0.25em] text-foreground/85">
          METAMASK
        </span>
        <span className="ml-auto font-mono text-[10px] text-foreground/40">eth_sendTx</span>
      </div>
      <div className="p-4">
        <div className="font-body-alt text-xs text-foreground/55">Confirm transaction</div>
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-2 font-display text-2xl text-foreground"
        >
          2,400 USDC
        </motion.div>
        <div className="mt-1 font-mono text-[10px] text-foreground/45 truncate">
          to 0x9f2a…c41 · gas ~$0.18
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="h-9 rounded-lg border border-foreground/20 text-[11px] font-display tracking-widest text-foreground/70">
            REJECT
          </button>
          <motion.button
            animate={{ scale: [1, 1.03, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, delay: 0.8 }}
            className="h-9 rounded-lg bg-[var(--papaya)] text-background text-[11px] font-display tracking-widest"
          >
            CONFIRM
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

function Typewriter({ text, speed = 55 }: { text: string; speed?: number }) {
  const [out, setOut] = useState("");
  useEffect(() => {
    setOut("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setOut(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return (
    <span>
      {out}
      <span className="ml-0.5 inline-block h-[1em] w-[2px] bg-foreground/70 align-middle animate-pulse" />
    </span>
  );
}

function PayMemoIntercept({ mode }: { mode: "ask" | "tag" }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="absolute inset-0 grid place-items-center bg-foreground/30 backdrop-blur-[3px] p-6"
    >
      <motion.div
        initial={{ scale: 0.9, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        transition={{ type: "spring", stiffness: 180, damping: 20 }}
        className="w-[380px] rounded-3xl bg-card text-card-foreground shadow-card overflow-hidden"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-foreground/10">
          <motion.span
            animate={{ scale: [1, 1.4, 1], opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 1.6, repeat: Infinity }}
            className="h-2 w-2 rounded-full bg-[var(--pink)]"
          />
          <span className="font-display text-[11px] tracking-[0.3em]">PAYMEMO · INTERCEPT</span>
          <Lock className="ml-auto h-3.5 w-3.5 text-foreground/40" />
        </div>

        {mode === "ask" ? (
          <div className="p-6">
            <div className="font-body-alt text-xs uppercase tracking-[0.25em] text-foreground/55">
              Before you sign
            </div>
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mt-3 font-display text-3xl leading-tight"
            >
              What is this <span className="font-serif-italic font-normal text-[var(--pink)]">payment</span> for
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              className="mt-5 min-h-[3rem] rounded-xl border border-foreground/15 bg-background px-4 py-3 font-mono text-sm text-foreground/85"
            >
              <Typewriter text="June design retainer · Anya P" speed={70} />
            </motion.div>
            <div className="mt-4 flex items-center gap-2 text-[11px] font-body-alt text-foreground/55">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--pink)]" />
              Stays private · only you can read it
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="font-body-alt text-xs uppercase tracking-[0.25em] text-foreground/55">
              Auto-tagged for accounting
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {["Payroll", "Contractor", "June", "USD-priced", "Agent-spend"].map((t, i) => (
                <motion.span
                  key={t}
                  initial={{ opacity: 0, y: 8, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: i * 0.18, type: "spring", stiffness: 260, damping: 20 }}
                  className="rounded-full bg-foreground text-background px-3 py-1 text-[11px] font-display tracking-[0.2em]"
                >
                  {t}
                </motion.span>
              ))}
            </div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
              className="mt-5 flex items-center gap-2 text-xs font-body-alt text-foreground/65"
            >
              <ShieldCheck className="h-4 w-4 text-[var(--pink)]" />
              Encrypted to your ledger only
            </motion.div>
            <motion.div
              animate={{ scale: [1, 1.02, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, delay: 1.2 }}
              className="mt-5 h-11 rounded-xl bg-foreground text-background grid place-items-center font-display tracking-[0.25em] text-[12px]"
            >
              SIGN &amp; REMEMBER →
            </motion.div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function Receipt() {
  const rows: [string, string][] = [
    ["Amount", "2,400.00 USDC"],
    ["To", "Anya Petrova"],
    ["Tag", "Payroll June"],
    ["Saved to", "Private ledger"],
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 180, damping: 22 }}
      className="absolute inset-0 grid place-items-center p-8"
    >
      <div className="w-full max-w-md rounded-3xl border border-[var(--pink)]/40 bg-card text-card-foreground p-7 shadow-card">
        <div className="flex items-center gap-3">
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 280, damping: 14, delay: 0.1 }}
            className="grid h-9 w-9 place-items-center rounded-full bg-[var(--pink)] text-background"
          >
            <Check className="h-5 w-5" strokeWidth={3} />
          </motion.span>
          <div>
            <div className="font-display text-[11px] tracking-[0.3em] text-[var(--pink)]">SIGNED</div>
            <div className="font-body-alt text-xs text-foreground/55">tx 0x4ad…9b1 · verified</div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 font-body-alt text-xs">
          {rows.map(([k, v], i) => (
            <motion.div
              key={k}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + i * 0.12 }}
              className="rounded-xl bg-background border border-foreground/10 p-3"
            >
              <div className="text-[10px] uppercase tracking-[0.25em] text-foreground/45">{k}</div>
              <div className="mt-1 text-foreground">{v}</div>
            </motion.div>
          ))}
        </div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="mt-5 flex items-center gap-2 text-[11px] font-display tracking-[0.25em] text-foreground/60"
        >
          <ArrowRight className="h-3.5 w-3.5" /> Ready for payroll invoices &amp; agent accounting
        </motion.div>
      </div>
    </motion.div>
  );
}
