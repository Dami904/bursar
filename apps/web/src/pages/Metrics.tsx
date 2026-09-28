import { formatUsdc } from "@bursar/money";
import { useQuery } from "@tanstack/react-query";
import { Card, ErrorLine, Loading } from "../components/ui.js";
import { api } from "../lib/api.js";
import { blockedBecause, money } from "../lib/format.js";

interface Metrics {
  jobs: { total: number; live: number };
  usdc: { revenueReceived: string; paidOut: string; refunded: string };
  decisions: {
    total: number;
    allowed: number;
    needsApproval: number;
    denied: number;
    deniedByReason: Record<string, number>;
  };
  approvals: { approved: number; rejected: number; expired: number };
  payments: { settled: number; refunded: number; unresolvedNow: number };
  ai: { runs: number; costMicros: string };
}

/** Amounts arrive in micro-USDC. */
const usdc = (micros: string) => money(formatUsdc(BigInt(micros)));

export function MetricsPage() {
  const q = useQuery({ queryKey: ["metrics"], queryFn: () => api<Metrics>("/metrics") });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorLine error={q.error} />;
  const m = q.data;
  const tiles = [
    { label: "Paid out", value: usdc(m.usdc.paidOut), unit: "USDC" },
    { label: "Revenue in", value: usdc(m.usdc.revenueReceived), unit: "USDC" },
    { label: "Blocked", value: String(m.decisions.denied), unit: "requests" },
    { label: "Approved by you", value: String(m.approvals.approved), unit: "payments" },
    { label: "Live jobs", value: String(m.jobs.live), unit: `of ${m.jobs.total}` },
    {
      label: "AI cost",
      value: `$${(Number(m.ai.costMicros) / 1e6).toFixed(4)}`,
      unit: `${m.ai.runs} runs`,
    },
  ];
  const reasons = Object.entries(m.decisions.deniedByReason).sort((a, b) => b[1] - a[1]);
  return (
    <main>
      <h1 className="mb-6 text-xl font-medium">Metrics</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label}>
            <p className="text-xs text-muted">{t.label}</p>
            <p className="mt-1 text-2xl font-medium tracking-tight">{t.value}</p>
            <p className="text-xs text-muted">{t.unit}</p>
          </Card>
        ))}
      </div>
      {reasons.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs text-muted">Why requests were blocked</h2>
          {reasons.map(([reason, count]) => (
            <div key={reason} className="flex justify-between border-t border-line py-2.5 text-sm">
              <span>{blockedBecause[reason] ?? reason}</span>
              <span className="text-muted tabular-nums">{count}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
