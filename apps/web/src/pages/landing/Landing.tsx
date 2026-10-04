import { Moon, Sun } from "lucide-react";
import { Link } from "react-router";
import { useSession } from "../../lib/session.js";
import { useTheme } from "../../lib/theme.js";
import { Controls, Faq, OneRule, PaymentLife, WhereItBreaks } from "./Explain.js";
import { Hero } from "./Hero.js";
import {
  CtaBand,
  Footer,
  HowItWorks,
  InjectionDemo,
  OverspendDemo,
  Stats,
  Ticker,
} from "./Sections.js";

/** The public front door: shows what Bursar does in seconds, then sends people to the demo. */
export function Landing() {
  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <main>
        <Hero />
        <Ticker />
        <OverspendDemo />
        <OneRule />
        <WhereItBreaks />
        <Controls />
        <HowItWorks />
        <PaymentLife />
        <InjectionDemo />
        <Stats />
        <Faq />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}

/** The public site's header: landing, demo, and the demo's evidence pages. */
export function SiteHeader() {
  const { session } = useSession();
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link to="/" className="flex items-center gap-2 font-medium">
          <svg viewBox="0 0 64 64" className="size-5" aria-hidden="true">
            <rect x="14" y="8" width="8" height="48" rx="4" className="fill-ink" />
            <circle cx="36" cy="40" r="14" className="fill-seal" />
          </svg>
          Bursar
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/demo"
            className="hidden rounded-full px-3 py-1.5 text-muted hover:text-ink sm:inline"
          >
            Demo
          </Link>
          <Link
            to="/docs/introduction"
            className="hidden rounded-full px-3 py-1.5 text-muted hover:text-ink sm:inline"
          >
            Docs
          </Link>
          <a
            href="https://github.com/Dami904/bursar"
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full px-3 py-1.5 text-muted hover:text-ink sm:inline"
          >
            GitHub
          </a>
          <button
            onClick={toggle}
            className="rounded-full p-2 text-muted hover:text-ink"
            aria-label="Switch theme"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <Link
            to={session ? "/app/jobs" : "/login"}
            className="ml-1 rounded-full bg-accent px-4 py-2 font-medium text-on-accent"
          >
            {session ? "Your jobs" : "Open console"}
          </Link>
        </nav>
      </div>
    </header>
  );
}
