import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, ErrorLine, Loading, Status } from "../components/ui.js";
import { api, type PaymentState } from "../lib/api.js";
import { txUrl } from "../lib/config.js";
import {
  blockedBecause,
  money,
  shortAddress,
  shortHash,
  statusOf,
  time,
  type Tone,
} from "../lib/format.js";
import { verifyEntries, type AuditEntry } from "../lib/verify.js";

interface Evidence {
  job: { id: string; title: string };
  agent: { name: string };
  decision: {
    at: string;
    kind: "PURCHASE" | "INVOICE";
    payee: string;
    invoiceRef: string | null;
    amount: string;
    reasoning: string;
    result: "ALLOWED" | "NEEDS_APPROVAL" | "DENIED";
    reason: string | null;
    checks: { check: string; passed: boolean }[];
  };
  payment: {
    state: PaymentState;
    vaultTx: string | null;
    paymentTx: string | null;
    reason: string | null;
  } | null;
  approval: {
    verdict: string;
    approver: string | null;
    approverAddress: string | null;
    at: string;
  } | null;
  audit: (AuditEntry & { event: string })[];
  anchor: { anchorSeq: number; txHash: string | null; at: string } | null;
}

export function EvidencePage() {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["evidence", id],
    queryFn: () => api<Evidence>(`/decisions/${id}`),
  });
  const [verified, setVerified] = useState<"idle" | "checking" | "ok" | "broken">("idle");

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorLine error={q.error} />;
  const e = q.data;
  const d = e.decision;
  const status = statusOf({ result: d.result, state: e.payment?.state ?? null });
  const passed = d.checks.filter((c) => c.passed).length;
  const failed = d.checks.find((c) => !c.passed);
  const sameTx = e.payment?.vaultTx !== null && e.payment?.vaultTx === e.payment?.paymentTx;

  async function verify() {
    setVerified("checking");
    const result = await verifyEntries(e.audit);
    setVerified(result.ok ? "ok" : "broken");
  }

  return (
    <main className="mx-auto max-w-xl">
      <Link to={`/app/jobs/${e.job.id}`} className="text-sm text-muted">
        ← {e.job.title}
      </Link>
      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-3xl font-medium tracking-tight">{money(d.amount)}</p>
          <p className="text-muted">
            to{" "}
            {d.kind === "INVOICE"
              ? `${shortAddress(d.payee)} · invoice ${d.invoiceRef ?? ""}`
              : d.payee}
          </p>
        </div>
        <Status {...status} />
      </div>

      <ol className="mt-8 space-y-6 border-l border-line pl-5">
        <Step tone="muted" title="Asked" meta={`${e.agent.name} · ${time(d.at)}`}>
          <p className="font-voice italic">"{d.reasoning}"</p>
        </Step>
        <Step
          tone={failed ? "blocked" : d.result === "NEEDS_APPROVAL" ? "needs" : "paid"}
          title={
            failed ? `Blocked: ${blockedBecause[failed.check] ?? failed.check}` : "Rules checked"
          }
          meta={`${passed} of ${d.checks.length} passed`}
        >
          {d.result === "NEEDS_APPROVAL" && (
            <p className="text-sm text-muted">Above the approval threshold.</p>
          )}
        </Step>
        {e.approval && (
          <Step
            tone={e.approval.verdict === "APPROVED" ? "paid" : "muted"}
            title={
              e.approval.verdict === "APPROVED"
                ? "Approved"
                : e.approval.verdict === "EXPIRED"
                  ? "Approval expired"
                  : "Rejected"
            }
            meta={`${e.approval.approver ?? (e.approval.approverAddress ? shortAddress(e.approval.approverAddress) : "")} · ${time(e.approval.at)}`}
          />
        )}
        {e.payment?.vaultTx && (
          <Step tone="paid" title={sameTx ? "Paid from the vault" : "Released from the vault"}>
            <TxLink hash={e.payment.vaultTx} />
          </Step>
        )}
        {e.payment?.paymentTx && !sameTx && (
          <Step tone="paid" title="Seller paid">
            <TxLink hash={e.payment.paymentTx} />
          </Step>
        )}
        {e.payment?.reason && <Step tone="muted" title="Note" meta={e.payment.reason} />}
        {e.audit.length > 0 && (
          <Step
            tone={e.anchor ? "seal" : "muted"}
            title={
              e.anchor
                ? `Anchored on Arc · #${e.anchor.anchorSeq}`
                : "Logged, waiting for the next anchor"
            }
            meta={`Log entries ${e.audit[0]?.seq}–${e.audit.at(-1)?.seq}`}
          >
            {e.anchor?.txHash && <TxLink hash={e.anchor.txHash} />}
          </Step>
        )}
      </ol>

      {e.audit.length > 0 && (
        <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-4">
          <span className="text-sm text-muted">
            {verified === "ok" && (
              <span className="text-paid">Hashes match, checked in your browser</span>
            )}
            {verified === "broken" && <span className="text-blocked">Hashes don't match</span>}
          </span>
          <Button primary onClick={() => void verify()} disabled={verified === "checking"}>
            {verified === "checking" ? "Checking…" : "Verify"}
          </Button>
        </div>
      )}
    </main>
  );
}

function Step({
  tone,
  title,
  meta,
  children,
}: {
  tone: Tone | "seal";
  title: string;
  meta?: string;
  children?: React.ReactNode;
}) {
  const dot =
    tone === "seal"
      ? "bg-seal"
      : {
          paid: "bg-paid",
          held: "bg-held",
          needs: "bg-needs",
          stuck: "bg-stuck",
          blocked: "bg-blocked",
          muted: "bg-muted",
        }[tone];
  return (
    <li className="relative">
      <span className={`absolute -left-[25px] top-1.5 size-2.5 rounded-full ${dot}`} />
      <p className="text-sm font-medium">
        {title} {meta && <span className="font-normal text-muted">· {meta}</span>}
      </p>
      {children && <div className="mt-1">{children}</div>}
    </li>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-muted underline"
    >
      {shortHash(hash)} <ExternalLink size={11} />
    </a>
  );
}
