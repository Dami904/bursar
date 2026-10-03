import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Formatted text written by a model (an operator's answer). Model output read seller content, so:
 * no raw HTML (react-markdown never renders it), no images (media comes from stored files, not
 * from text), and links open in a new tab without telling the site where the click came from.
 */
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="underline decoration-line underline-offset-2 hover:decoration-ink"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mb-2 mt-5 text-base font-medium">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-5 text-base font-medium">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-4 font-medium">{children}</h4>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  strong: ({ children }) => <strong className="font-medium text-ink">{children}</strong>,
  code: ({ children }) => (
    <code className="rounded bg-track px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl border border-line bg-track p-3 text-xs">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-line pl-3 text-muted">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line px-2 py-1 align-top">{children}</td>,
};

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`text-sm leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        disallowedElements={["img"]}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
