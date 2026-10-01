import { useQuery } from "@tanstack/react-query";
import { Bell, LogOut, Moon, Sun } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { api, type PendingApproval } from "../lib/api.js";
import { config } from "../lib/config.js";
import { shortAddress } from "../lib/format.js";
import { useLiveUpdates } from "../lib/live.js";
import { useSession } from "../lib/session.js";
import { useTheme } from "../lib/theme.js";
import { Logo } from "./ui.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-3 py-1.5 text-sm ${isActive ? "bg-surface border border-line" : "text-muted hover:text-ink"}`;

export function Shell() {
  const { session, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const live = useLiveUpdates(session, () => void signOut());
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ pending: PendingApproval[] }>("/approvals"),
    enabled: session !== null,
  });
  const waiting = approvals.data?.pending.length ?? 0;
  const owner = session?.role === "OWNER";

  return (
    <div className="mx-auto min-h-dvh max-w-5xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-5">
        <div className="flex items-center gap-5">
          <NavLink
            to={owner ? "/app/jobs" : "/app/approvals"}
            className="flex items-center gap-2 font-medium"
          >
            <Logo /> Bursar
          </NavLink>
          <NetworkBadge />
          <nav className="flex items-center gap-1">
            {owner && (
              <NavLink to="/app/jobs" className={navClass}>
                Jobs
              </NavLink>
            )}
            <NavLink to="/app/approvals" className={navClass}>
              Approvals
              {waiting > 0 && (
                <span className="ml-1.5 rounded-full bg-needs px-1.5 text-[11px] font-medium text-on-accent">
                  {waiting}
                </span>
              )}
            </NavLink>
            {owner && (
              <NavLink to="/app/metrics" className={(s) => `${navClass(s)} hidden sm:inline`}>
                Metrics
              </NavLink>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <span
            className="hidden items-center gap-1.5 sm:flex"
            title={live ? "Live" : "Reconnecting"}
          >
            <span className={`size-1.5 rounded-full ${live ? "bg-paid" : "bg-muted"}`} />
            {session && shortAddress(session.wallet)}
          </span>
          {owner && (
            <NavLink
              to="/app/settings"
              className="rounded-full p-2 hover:bg-surface"
              aria-label="Alerts"
            >
              <Bell size={16} />
            </NavLink>
          )}
          <button
            onClick={toggle}
            className="rounded-full p-2 hover:bg-surface"
            aria-label="Switch theme"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => void signOut()}
            className="rounded-full p-2 hover:bg-surface"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

/** Which Arc network this console spends on. On mainnet it says so loudly: the USDC is real. */
function NetworkBadge() {
  return config.mainnet ? (
    <span
      title="Arc mainnet: payments move real USDC"
      className="rounded-full bg-needs px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-on-accent"
    >
      Mainnet
    </span>
  ) : (
    <span
      title="Arc testnet: test USDC with no value"
      className="hidden rounded-full border border-line px-2 py-0.5 text-[11px] whitespace-nowrap text-muted sm:inline"
    >
      Testnet
    </span>
  );
}
