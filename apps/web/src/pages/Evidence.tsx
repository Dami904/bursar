import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, ErrorLine, Loading, Status, TxLink } from "../components/ui.js";
import { MediaGallery } from "../components/Media.js";
import { api, type MediaItem, type PaymentState } from "../lib/api.js";
import { config } from "../lib/config.js";
import {
  blockedBecause,
  money,
  ruleLines,
  shortAddress,
  statusOf,
  time,
  toneText,
  verdictOf,
  type Tone,
} from "../lib/format.js";
import { verifyEntries, type AuditEntry } from "../lib/verify.js";

export interface Evidence {
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
    rail?: "VAULT" | "GATEWAY";
    vaultTx: string | null;
    paymentTx: string | null;
    gatewayTransferId?: string | null;
    /** What the seller answered, as text. */
    deliverable?: string | null;
    media?: MediaItem[];
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

export function EvidencePage({ demo = false }: { demo?: boolean }) {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["evidence", demo, id],
    queryFn: () => api<Evidence>(demo ? `/demo/decisions/${id}` : `/decisions/${id}`),
  });
  const [verified, setVerified] = useState<"idle" | "checking" | "ok" | "broken">("idle");

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorLine error={q.error} />;
  const e = q.data;
  const d = e.decision;
  const status = statusOf({ result: d.result, state: e.payment?.state ?? null });
  const verdict = verdictOf({ result: d.result, state: e.payment?.state ?? null });
  const passed = d.checks.filter((c) => c.passed).length;
  const failed = d.checks.find((c) => !c.passed);
  const sameTx = e.payment?.vaultTx !== null && e.payment?.vaultTx === e.payment?.paymentTx;

  async function verify() {
    setVerified("checking");
    const result = await verifyEntries(e.audit);
    setVerified(result.ok ? "ok" : "broken");
  }

  return (
    <main className="mx-auto max-w-xl lg:max-w-4xl">
      <Link to={demo ? "/demo" : `/app/jobs/${e.job.id}`} className="text-sm text-muted">
        ← {e.job.title}
      </Link>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-12">
        <div className="min-w-0">
          <h1 className="mt-4 text-xl font-medium">{verdict.headline}</h1>
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-3xl font-medium tracking-tight">{money(d.amount)}</p>
              <p className="break-words text-muted">
                to{" "}
                {d.kind === "INVOICE"
                  ? `${shortAddress(d.payee)} · invoice ${d.invoiceRef ?? ""}`
                  : d.payee}
              </p>
              <p className="mt-1 text-xs text-muted">
                {config.mainnet ? "Arc mainnet · real USDC" : "Arc testnet · test USDC"}
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
                failed
                  ? `Blocked: ${blockedBecause[failed.check] ?? failed.check}`
                  : "Rules checked"
              }
              meta={`${passed} of ${d.checks.length} passed`}
            >
              {d.result === "NEEDS_APPROVAL" && (
                <p className="text-sm text-muted">Above the approval threshold.</p>
              )}
              <details className="mt-1 text-sm" open={failed !== undefined}>
                <summary className="cursor-pointer text-xs text-muted">Each rule, in order</summary>
                <ul className="mt-2 space-y-1">
                  {d.checks.map((c) => {
                    const line = ruleLines[c.check] ?? { pass: c.check, fail: c.check };
                    return (
                      <li key={c.check} className="flex items-baseline gap-2">
                        {c.passed ? (
                          <Check size={13} className="translate-y-0.5 shrink-0 text-paid" />
                        ) : (
                          <X size={13} className="translate-y-0.5 shrink-0 text-blocked" />
                        )}
                        <span className={c.passed ? "text-muted" : "font-medium text-blocked"}>
                          {c.passed ? line.pass : line.fail}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {failed !== undefined && (
                  <p className="mt-2 text-xs text-muted">
                    The first rule that fails stops the request.
                  </p>
                )}
              </details>
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
            {e.payment?.rail === "GATEWAY" &&
              (e.payment.gatewayTransferId || e.payment.state === "SETTLED") && (
                <Step
                  tone="paid"
                  title="Paid through Circle Gateway"
                  meta={
                    e.payment.gatewayTransferId
                      ? `Transfer ${e.payment.gatewayTransferId} · settled on Arc in Circle's next batch`
                      : "Settled on Arc in Circle's next batch"
                  }
                />
              )}
            {e.payment?.paymentTx && !sameTx && (
              <Step tone="paid" title="Seller paid">
                <TxLink hash={e.payment.paymentTx} />
              </Step>
            )}
            {e.payment?.media && e.payment.media.length > 0 && (
              <Step tone="paid" title="Delivered">
                <MediaGallery items={e.payment.media} />
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

          {e.payment?.deliverable && (
            <details className="mt-8 border-t border-line pt-4 text-sm">
              <summary className="cursor-pointer text-muted">
                Technical details: the seller's answer
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-line bg-track p-3 text-xs">
                {prettyJson(e.payment.deliverable)}
              </pre>
            </details>
          )}

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
        </div>
        <aside className="hidden lg:mt-4 lg:block">
          <div className="sticky top-6 rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
              At a glance
            </p>
            <p className={`mt-2 text-lg font-medium ${toneText[verdict.tone]}`}>{status.word}</p>
            <dl className="mt-3 space-y-2.5">
              <Fact label="Job">
                <Link to={demo ? "/demo" : `/app/jobs/${e.job.id}`} className="underline">
                  {e.job.title}
                </Link>
              </Fact>
              <Fact label="Asked by">{e.agent.name}</Fact>
              <Fact label="When">{time(d.at)}</Fact>
              <Fact label="Network">{config.mainnet ? "Arc mainnet" : "Arc testnet"}</Fact>
              <Fact label="Rules">
                {passed} of {d.checks.length} passed
              </Fact>
              {e.payment && d.result !== "DENIED" && (
                <Fact label="Paid">
                  {e.payment.rail === "GATEWAY" ? "Circle Gateway" : "From the vault"}
                </Fact>
              )}
              {(e.payment?.paymentTx ?? e.payment?.vaultTx) && (
                <Fact label="Payment">
                  <TxLink hash={(e.payment?.paymentTx ?? e.payment?.vaultTx) as string} />
                </Fact>
              )}
              <Fact label="Sealed">
                {e.anchor ? (
                  <span className="flex flex-col items-end gap-1">
                    <span>On Arc, #{e.anchor.anchorSeq}</span>
                    {e.anchor.txHash && <TxLink hash={e.anchor.txHash} />}
                  </span>
                ) : e.audit.length > 0 ? (
                  "Waiting"
                ) : (
                  "-"
                )}
              </Fact>
            </dl>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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
