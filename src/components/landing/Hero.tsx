import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Download, Play } from "lucide-react";
import heroBg from "@/assets/hero-bg.png";

/**
 * Editorial hero - themed via design tokens so light + dark both look intentional.
 */
export function Hero() {
  return (
    <section className="relative min-h-[100vh] overflow-hidden text-white">
      <HeroBackdrop />

      {/* Top eyebrow */}
      <div className="relative z-10 flex items-center justify-between px-6 sm:px-10 pt-28 text-[10px] uppercase tracking-[0.3em] text-white/75 font-body-alt">
        <span>PayMemo · vol.01</span>
        <span className="hidden sm:inline">Memory layer / wallets &amp; agents</span>
        <span>{new Date().getFullYear()}</span>
      </div>

      {/* Center stage */}
      <div className="relative z-10 mx-auto max-w-6xl px-6 pt-14 pb-32 sm:pt-20 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="font-display leading-[0.86] tracking-[0.005em]"
        >
          <div className="bulb-flicker text-[11vw] sm:text-[9vw] lg:text-[7.5rem]">REMEMBER</div>
          <div className="bulb-flicker text-[11vw] sm:text-[9vw] lg:text-[7.5rem]">EVERY</div>
          <div className="text-[11vw] sm:text-[9vw] lg:text-[7.5rem]">
            <span className="font-serif-italic font-normal text-[var(--pink)] [letter-spacing:-0.02em]">
              transaction
            </span>
          </div>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.45 }}
          className="font-body-alt mx-auto mt-10 max-w-[60ch] text-base sm:text-lg text-white/85 leading-relaxed"
        >
          PayMemo is the private memory layer for every wallet · human or AI agent. It listens for
          supported Morph transactions, pops up after a payment is detected, asks{" "}
          <em className="font-serif-italic text-white/95">what was this for</em>, and turns raw
          on-chain activity into payroll, invoices, agent spend, and tax-ready records.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.55 }}
          className="mt-6 flex flex-wrap items-center justify-center gap-2 font-body-alt text-[10px] uppercase tracking-[0.28em] text-white/75"
        >
          <span className="rounded-full border border-white/25 px-3 py-1 text-white/90">
            For AI agents
          </span>
          <span className="text-white/60">·</span>
          <span>Track agent spend</span>
          <span className="text-white/60">·</span>
          <span>Auto-accounting</span>
          <span className="text-white/60">·</span>
          <span>Audit trail</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.65 }}
          className="mt-10 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            to="/app"
            data-cursor="cta"
            data-cursor-label="launch"
            className="group inline-flex items-center gap-2 rounded-full bg-white text-black px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] hover:opacity-90 transition-all"
          >
            Launch App{" "}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            to="/install"
            data-cursor="cta"
            data-cursor-label="install"
            className="group inline-flex items-center gap-2 rounded-full bg-[var(--pink)] text-black px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] hover:opacity-90 transition-all"
          >
            <Download className="h-4 w-4" /> Get Extension
          </Link>
          <a
            href="#wallet-assist"
            data-cursor="cta"
            data-cursor-label="watch"
            className="inline-flex items-center gap-2 rounded-full border border-white/30 px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] text-white/92 hover:border-white/70 transition-colors"
          >
            <Play className="h-4 w-4" /> Watch detection
          </a>
        </motion.div>

        {/* Bottom marquee of categories */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.9 }}
          className="mt-16 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[11px] uppercase tracking-[0.3em] text-white/70 font-body-alt"
        >
          {["Payroll", "Invoices", "Swaps", "Bridges", "Accounting", "Tax"].map((t) => (
            <span key={t} className="inline-flex items-center gap-3">
              <span className="h-px w-6 bg-white/20" />
              {t}
            </span>
          ))}
        </motion.div>
      </div>

      {/* Bottom corner ticker */}
      <div className="absolute bottom-6 left-0 right-0 z-10 flex items-center justify-between px-6 sm:px-10 text-[10px] uppercase tracking-[0.3em] text-white/68 font-body-alt">
        <span>Scroll &darr;</span>
        <span className="hidden sm:inline">Editorial · chapter 01</span>
        <span>N&deg; 001</span>
      </div>
    </section>
  );
}

function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url(${heroBg})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      />
      {/* dark overlay for legibility */}
      <div className="absolute inset-0 bg-black/70" />
    </div>
  );
}
