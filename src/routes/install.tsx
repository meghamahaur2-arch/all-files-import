import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Chrome,
  Download,
  FolderOpen,
  HelpCircle,
  ShieldCheck,
  ToggleRight,
  Wallet,
} from "lucide-react";
import { Nav } from "@/components/landing/Nav";
import { Footer } from "@/components/landing/Footer";
import { Logo } from "@/components/brand/Logo";

export const Route = createFileRoute("/install")({
  head: () => ({
    meta: [
      { title: "Install PayMemo - Wallet Assist browser extension" },
      {
        name: "description",
        content:
          "Install the PayMemo Wallet Assist browser extension manually. Side-load works on Chrome, Brave, Edge, Arc, Bitget Wallet browser and any Chromium-based browser.",
      },
    ],
  }),
  component: InstallPage,
});

const EXT_ZIP = "/paymemo-extension.zip";

function InstallPage() {
  return (
    <main className="relative min-h-screen overflow-x-clip bg-background text-foreground">
      <Nav />

      <section className="relative px-6 pt-36 pb-12 sm:pt-40">
        <div className="mx-auto max-w-5xl">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.18em] text-ink/75 hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to home
          </Link>

          <div className="mt-6 flex flex-wrap items-center gap-5">
            <Logo size={64} className="rounded-2xl" />
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-ink/75">
                PayMemo Wallet Assist · Chrome / Brave / Edge / Arc
              </p>
              <h1 className="mt-1 text-4xl sm:text-5xl font-semibold tracking-tight">
                Install the extension
              </h1>
            </div>
          </div>

          <p className="mt-6 max-w-3xl text-base sm:text-lg text-ink/82 leading-relaxed">
            The PayMemo browser extension watches your wallets on Morph and pops up a private memo
            prompt the moment a transaction is detected. The extension is not yet on the Chrome Web
            Store - for the demo you can side-load it in less than 30 seconds.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href={EXT_ZIP}
              download
              className="group inline-flex items-center gap-2 rounded-full bg-[var(--pink)] text-black px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] hover:opacity-90 transition-all shadow-glow-pink"
            >
              <Download className="h-4 w-4" /> Download paymemo-extension.zip
            </a>
            <a
              href="chrome://extensions"
              onClick={(event) => {
                // chrome://extensions cannot be opened from a normal link - guide the user instead.
                event.preventDefault();
                navigator.clipboard?.writeText("chrome://extensions").catch(() => undefined);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-ink/25 bg-white px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] text-ink hover:bg-ink/5 transition"
            >
              <Chrome className="h-4 w-4" /> Copy chrome://extensions
            </a>
            <Link
              to="/app"
              className="inline-flex items-center gap-2 rounded-full border border-ink/15 bg-cream/40 px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] text-ink/90 hover:bg-cream transition"
            >
              <Wallet className="h-4 w-4" /> Or use the dashboard instead
            </Link>
          </div>

          <p className="mt-3 text-xs text-ink/75 max-w-2xl">
            Don't want to install anything? The dashboard mirrors every extension feature - add a
            watched wallet, label partners, and review detected transactions in your browser without
            any sideload.
          </p>
        </div>
      </section>

      <section className="relative px-6 pb-20">
        <div className="mx-auto max-w-5xl grid md:grid-cols-2 gap-5">
          <Step
            n={1}
            icon={<Download className="h-5 w-5" />}
            title="Download the .zip"
            body={
              <>
                Click <strong>Download paymemo-extension.zip</strong> above. The archive is ~50 KB
                and contains the unpacked extension folder.
              </>
            }
          />
          <Step
            n={2}
            icon={<FolderOpen className="h-5 w-5" />}
            title="Unzip it somewhere"
            body={
              <>
                Right-click the file → <em>Extract All…</em> (Windows) or double-click (macOS). Keep
                the resulting{" "}
                <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[12px]">
                  paymemo-extension
                </code>{" "}
                folder - Chrome reads files directly from it.
              </>
            }
          />
          <Step
            n={3}
            icon={<Chrome className="h-5 w-5" />}
            title="Open chrome://extensions"
            body={
              <>
                Paste{" "}
                <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[12px]">
                  chrome://extensions
                </code>{" "}
                into your address bar (works in Chrome, Brave, Edge, Arc, Bitget Wallet browser, OKX
                Wallet browser, and most Chromium browsers).
              </>
            }
          />
          <Step
            n={4}
            icon={<ToggleRight className="h-5 w-5" />}
            title="Enable Developer mode"
            body={
              <>
                Toggle <strong>Developer mode</strong> in the top-right of the extensions page.
                Three buttons will appear: Load unpacked, Pack extension, Update.
              </>
            }
          />
          <Step
            n={5}
            icon={<FolderOpen className="h-5 w-5" />}
            title="Click 'Load unpacked'"
            body={
              <>
                Select the unzipped{" "}
                <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[12px]">
                  paymemo-extension
                </code>{" "}
                folder. PayMemo will appear in your extensions list with its icon - pin it to your
                toolbar so it's always one click away.
              </>
            }
          />
          <Step
            n={6}
            icon={<ShieldCheck className="h-5 w-5" />}
            title="You're done"
            body={
              <>
                Open the popup, add your wallet to <em>Morph Chain Watch</em>, and start a Morph
                Hoodi transaction. PayMemo will detect it and ask you to add a memo. Captures land
                in your dashboard's{" "}
                <Link to="/app/review" className="underline underline-offset-2 hover:text-ink">
                  Needs Review
                </Link>{" "}
                tab.
              </>
            }
          />
        </div>
      </section>

      <section className="relative px-6 pb-24">
        <div className="mx-auto max-w-5xl rounded-3xl border border-ink/15 bg-ink text-cream p-8 sm:p-10 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-xl">
              <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--pink)]">
                Why side-loading?
              </p>
              <h2 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight">
                Chrome Web Store listing is on the way.
              </h2>
              <p className="mt-3 text-cream/88 leading-relaxed">
                PayMemo is an open hackathon build. The Web Store $5 developer fee isn't a barrier -
                listing review and our v1 polish are. Until then, sideloading is the official
                install path, and the extension code is yours to inspect.
              </p>
            </div>
            <div className="grid gap-3">
              <a
                href={EXT_ZIP}
                download
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--pink)] text-black px-5 py-3 text-sm font-semibold uppercase tracking-[0.18em] hover:opacity-90 transition"
              >
                <Download className="h-4 w-4" /> Download .zip
              </a>
              <Link
                to="/app/docs"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-cream/30 px-5 py-3 text-sm font-semibold uppercase tracking-[0.18em] text-cream/92 hover:border-cream/70 transition"
              >
                <HelpCircle className="h-4 w-4" /> Troubleshooting
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <article className="relative rounded-2xl border border-ink/15 bg-white p-6 shadow-soft">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-ink text-cream">{icon}</div>
        <div className="text-[10px] uppercase tracking-[0.24em] text-ink/75">Step {n}</div>
      </div>
      <h3 className="mt-4 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm text-ink/82 leading-relaxed">{body}</p>
    </article>
  );
}
