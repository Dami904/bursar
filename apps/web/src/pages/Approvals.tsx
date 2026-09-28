import { useQuery } from "@tanstack/react-query";
import { Button, Card, ErrorLine, Loading } from "../components/ui.js";
import { api, type PendingApproval } from "../lib/api.js";
import { useApprove, useReject } from "../lib/approve.js";
import { money, shortPayee, time } from "../lib/format.js";

/** Phone-first: everything needed to decide is on one card, and approving is one tap. */
export function Approvals() {
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ pending: PendingApproval[] }>("/approvals"),
  });
  return (
    <main className="mx-auto max-w-md">
      <h1 className="mb-6 text-xl font-medium">Approvals</h1>
      {approvals.isPending && <Loading />}
      <ErrorLine error={approvals.error} />
      {approvals.data?.pending.length === 0 && (
        <Card className="py-12 text-center">
          <p className="font-medium">You're all caught up</p>
          <p className="mt-1 text-sm text-muted">
            Payments above a job's threshold wait here for you.
          </p>
        </Card>
      )}
      <div className="space-y-3">
        {approvals.data?.pending.map((p) => (
          <ApprovalItem key={p.authorizationId} pending={p} />
        ))}
      </div>
    </main>
  );
}

function ApprovalItem({ pending }: { pending: PendingApproval }) {
  const approve = useApprove();
  const reject = useReject();
  const busy = approve.isPending || reject.isPending;
  return (
    <Card className="border-needs">
      <div className="flex items-baseline justify-between">
        <span className="text-3xl font-medium tracking-tight">{money(pending.amount)}</span>
        <span className="text-xs text-muted">{time(pending.requestedAt)}</span>
      </div>
      <p className="mt-1">to {shortPayee(pending.payee)}</p>
      <p className="text-sm text-muted">{pending.jobTitle}</p>
      <p className="mt-3 font-voice italic">"{pending.reasoning}"</p>
      <div className="mt-4 flex flex-col gap-2">
        <Button primary className="py-3" disabled={busy} onClick={() => approve.mutate(pending)}>
          {approve.isPending ? "Sign in your wallet…" : "Approve"}
        </Button>
        <Button disabled={busy} onClick={() => reject.mutate(pending)}>
          Reject
        </Button>
      </div>
      <div className="mt-2">
        <ErrorLine error={approve.error ?? reject.error} />
      </div>
    </Card>
  );
}
