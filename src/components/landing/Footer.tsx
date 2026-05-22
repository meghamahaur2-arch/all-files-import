import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/brand/Logo";

export function Footer() {
  return (
    <footer className="px-6 py-10 border-t border-ink/35">
      <div className="mx-auto max-w-7xl flex flex-wrap items-center justify-between gap-6 text-sm text-ink/78">
        <div className="flex items-center gap-2">
          <Logo size={24} className="rounded-[8px]" />
          <span className="font-semibold text-ink">PayMemo</span>
          <span className="ml-3">© 2026 - Encrypted memory for the onchain economy.</span>
        </div>
        <div className="flex gap-5">
          <Link to="/install" className="hover:text-ink">
            Extension
          </Link>
          <Link to="/app/docs" className="hover:text-ink">
            Docs
          </Link>
          <a href="https://twitter.com" target="_blank" rel="noreferrer" className="hover:text-ink">
            Twitter
          </a>
          <Link to="/app/settings" className="hover:text-ink">
            Security
          </Link>
        </div>
      </div>
    </footer>
  );
}
