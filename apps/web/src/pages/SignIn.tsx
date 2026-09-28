import { useState } from "react";
import { Navigate } from "react-router";
import { useConnectors } from "wagmi";
import { Button, ErrorLine, Logo } from "../components/ui.js";
import { useSession } from "../lib/session.js";

export function SignIn() {
  const { session, signIn } = useSession();
  const connectors = useConnectors();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (session !== null)
    return <Navigate to={session.role === "OWNER" ? "/app/jobs" : "/app/approvals"} replace />;

  const browser = connectors.find((c) => c.type === "injected");
  const phone = connectors.find((c) => c.type === "walletConnect");

  async function go(id: string) {
    setBusy(id);
    setError(null);
    try {
      await signIn(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
      <Logo size={48} />
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Bursar</h1>
        <p className="mt-1 text-muted">Budgets your AI agents can't overspend.</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {browser && (
          <Button primary disabled={busy !== null} onClick={() => void go(browser.id)}>
            {busy === browser.id ? "Check your wallet…" : "Connect wallet"}
          </Button>
        )}
        {phone && (
          <Button disabled={busy !== null} onClick={() => void go(phone.id)}>
            {busy === phone.id ? "Check your phone…" : "Use a phone wallet"}
          </Button>
        )}
        <ErrorLine error={error} />
      </div>
      <p className="max-w-xs text-xs text-muted">
        You'll sign a message to prove it's your wallet. It's free and sends nothing.
      </p>
    </main>
  );
}
