import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Card, ErrorLine, Loading } from "../components/ui.js";
import { api } from "../lib/api.js";
import { time } from "../lib/format.js";

interface AlertSettings {
  targets: { id: string; kind: "WEBHOOK" | "TELEGRAM"; url: string | null; chatLinked: boolean }[];
  recent: {
    id: string;
    title: string;
    body: string;
    at: string;
    status: "sent" | "failed" | "sending";
    error: string | null;
  }[];
  telegram: boolean;
}

const field =
  "min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-muted";

export function Settings() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["alerts"], queryFn: () => api<AlertSettings>("/alerts") });
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["alerts"] });

  const addHook = useMutation({
    mutationFn: () => api<{ secret: string }>("/alerts/webhooks", { body: { url: url.trim() } }),
    onSuccess: (r) => {
      setSecret(r.secret);
      setUrl("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/alerts/targets/${id}/remove`, { body: {} }),
    onSuccess: refresh,
  });
  const telegram = useMutation({
    mutationFn: () => api<{ url: string }>("/alerts/telegram", { body: {} }),
    onSuccess: (r) => window.open(r.url, "_blank", "noopener"),
  });
  const test = useMutation({
    mutationFn: () => api("/alerts/test", { body: {} }),
    onSuccess: refresh,
  });

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorLine error={q.error} />;
  const s = q.data;

  return (
    <main className="mx-auto max-w-lg">
      <h1 className="mb-1 text-xl font-medium">Alerts</h1>
      <p className="mb-6 text-sm text-muted">
        Payments that need you, stuck payments, budgets at 80%, frozen jobs and bursts of blocked
        requests.
      </p>

      <section className="space-y-2">
        {s.targets.length === 0 && (
          <p className="border-t border-line py-4 text-sm text-muted">
            Nowhere yet. Add {s.telegram ? "Telegram or " : ""}a webhook.
          </p>
        )}
        {s.targets.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-2 border-t border-line py-2.5 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate">{t.kind === "TELEGRAM" ? "Telegram" : t.url}</span>
              <span className="text-xs text-muted">
                {t.kind === "TELEGRAM" ? "Chat linked" : "Webhook · signed"}
              </span>
            </span>
            <button
              aria-label="Remove"
              className="rounded-full p-1.5 text-muted hover:bg-surface hover:text-ink"
              onClick={() => remove.mutate(t.id)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </section>

      {secret !== null && (
        <Card className="my-4">
          <p className="text-sm">Signing secret</p>
          <p className="mt-1 text-xs text-muted">
            Shown once. Your server checks the <code>x-bursar-signature</code> header with it.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-track px-2 py-1.5 font-mono text-xs">
              {secret}
            </code>
            <Button
              aria-label="Copy secret"
              onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        </Card>
      )}

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        {s.telegram && !s.targets.some((t) => t.kind === "TELEGRAM") && (
          <Button
            className="w-full"
            disabled={telegram.isPending}
            onClick={() => telegram.mutate()}
          >
            <Send size={14} /> Connect Telegram
          </Button>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() !== "") addHook.mutate();
          }}
        >
          <input
            className={field}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-server/bursar"
          />
          <Button disabled={addHook.isPending || url.trim() === ""}>Add webhook</Button>
        </form>
        <ErrorLine error={addHook.error ?? remove.error ?? telegram.error} />
        {s.targets.length > 0 && (
          <button className="text-xs text-muted underline" onClick={() => test.mutate()}>
            Send a test alert
          </button>
        )}
      </div>

      {s.recent.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-xs text-muted">Recent</h2>
          {s.recent.map((a) => (
            <div key={a.id} className="border-t border-line py-2.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate">{a.title}</span>
                <span
                  className={`text-xs ${a.status === "failed" ? "text-blocked" : a.status === "sent" ? "text-muted" : "text-needs"}`}
                >
                  {a.status === "sent" ? time(a.at) : a.status === "failed" ? "Failed" : "Sending"}
                </span>
              </div>
              {a.error && a.error !== "no alert targets" && (
                <p className="mt-1 text-xs text-muted">{a.error}</p>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
