import { usdcAbi } from "@bursar/payments/chain";
import { useQuery } from "@tanstack/react-query";
import { Bell, LogOut, Moon, Sun } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";
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
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-5">
        {/* On a phone these three sit in the header's own rows: logo, then icons, then the tabs. */}
        <div className="contents sm:flex sm:items-center sm:gap-5">
          <NavLink
            to={owner ? "/app/jobs" : "/app/approvals"}
            className="order-1 flex items-center gap-2 font-medium sm:order-none"
          >
            <Logo /> Bursar
          </NavLink>
          <NetworkBadge />
          <nav className="order-4 flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:w-auto sm:overflow-visible">
            {owner && (
              <NavLink to="/app/jobs" className={navClass}>
                Jobs
              </NavLink>
            )}
            {owner && (
              <NavLink to="/app/activity" className={navClass}>
                Activity
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
        <div className="order-3 ml-auto flex items-center gap-2 text-sm text-muted sm:order-none sm:ml-0">
          {session && <WalletPill wallet={session.wallet} live={live} />}
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

/**
 * Which Arc network this console spends on, and a way to the other one. On mainnet it says so
 * loudly: the USDC is real. Mainnet and testnet are separate sites with separate sign-ins.
 */
function NetworkBadge() {
  return (
    <span className="order-2 flex items-center gap-2 sm:order-none">
      <NetworkLabel />
      {config.otherNetworkUrl !== undefined && (
        <a
          href={`${config.otherNetworkUrl}/app`}
          title={
            config.mainnet
              ? "Open the testnet console (test USDC)"
              : "Open the mainnet console (real USDC)"
          }
          className="hidden text-[11px] whitespace-nowrap text-muted underline-offset-2 hover:text-ink hover:underline sm:inline"
        >
          Switch to {config.mainnet ? "testnet" : "mainnet"}
        </a>
      )}
    </span>
  );
}

function NetworkLabel() {
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

/** Who's signed in, whether the live feed is up, and how much USDC that wallet holds here. */
function WalletPill({ wallet, live }: { wallet: string; live: boolean }) {
  const balance = useReadContract({
    abi: usdcAbi,
    address: config.usdc,
    functionName: "balanceOf",
    args: [wallet as `0x${string}`],
    chainId: config.chain.id,
    query: { refetchInterval: 30_000 },
  });
  const usdc =
    typeof balance.data === "bigint" ? Number(formatUnits(balance.data, 6)).toFixed(2) : null;
  return (
    <span
      className="hidden items-center gap-2 rounded-full border border-line px-3 py-1 sm:flex"
      title={`${wallet}${live ? " · live" : " · reconnecting"}`}
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-paid" : "bg-muted"}`} />
      <span className="font-mono text-xs">{shortAddress(wallet)}</span>
      {usdc !== null && (
        <span className="border-l border-line pl-2 font-mono text-xs tabular-nums text-ink">
          {usdc} <span className="text-muted">USDC</span>
        </span>
      )}
    </span>
  );
}
