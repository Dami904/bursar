import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { connectHint, connectSnippet, connectTargets, type ConnectTarget } from "../lib/mcp.js";

export function CodeBlock({
  code,
  label = "Copy",
  wrap = false,
}: {
  code: string;
  label?: string;
  /** Prose (a prompt) wraps; commands keep their lines and scroll. */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className={`${wrap ? "whitespace-pre-wrap" : "overflow-x-auto"} rounded-xl border border-line bg-track p-4 pr-12 font-mono text-xs leading-relaxed`}
      >
        {code}
      </pre>
      <button
        aria-label={label}
        className="absolute right-2 top-2 rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"
        onClick={() =>
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** Tabs for connecting an agent: Claude Code, a JSON MCP config, or the plain HTTP API. */
export function ConnectTabs({ agentKey }: { agentKey: string }) {
  const [target, setTarget] = useState<ConnectTarget>("claude-code");
  return (
    <div>
      <div role="tablist" className="mb-3 flex flex-wrap gap-1">
        {connectTargets.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={target === t.id}
            onClick={() => setTarget(t.id)}
            className={`rounded-full px-3 py-1 text-xs ${
              target === t.id ? "bg-ink text-bg" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock code={connectSnippet(target, agentKey)} />
      <p className="mt-2 text-xs text-muted">{connectHint[target]}</p>
    </div>
  );
}
