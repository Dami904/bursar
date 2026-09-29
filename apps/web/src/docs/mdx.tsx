import { Info, Link2, TriangleAlert } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Link } from "react-router";
import { CodeBlock, ConnectTabs } from "../components/Connect.js";

/** A note or warning box. In the Markdown copies it becomes a blockquote. */
export function Callout({
  type = "note",
  children,
}: {
  type?: "note" | "warn";
  children: ReactNode;
}) {
  const warn = type === "warn";
  return (
    <div
      className={`my-6 flex gap-3 rounded-xl border px-4 py-3 text-[15px] ${
        warn ? "border-needs/40 bg-needs/5" : "border-line bg-surface"
      }`}
    >
      {warn ? (
        <TriangleAlert size={16} className="mt-1 shrink-0 text-needs" />
      ) : (
        <Info size={16} className="mt-1 shrink-0 text-muted" />
      )}
      <div className="min-w-0 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>p]:my-2">
        {children}
      </div>
    </div>
  );
}

function Heading({
  as: Tag,
  id,
  children,
  className,
}: {
  as: "h2" | "h3" | "h4";
  id?: string | undefined;
  children?: ReactNode;
  className: string;
}) {
  return (
    <Tag id={id} className={`group scroll-mt-28 ${className}`}>
      {children}
      {id && (
        <a
          href={`#${id}`}
          aria-label="Link to this section"
          className="ml-2 inline-block align-middle text-muted opacity-0 transition group-hover:opacity-100 focus:opacity-100"
        >
          <Link2 size={14} />
        </a>
      )}
    </Tag>
  );
}

function Anchor({ href = "", children, ...rest }: ComponentPropsWithoutRef<"a">) {
  if (href.startsWith("/") && !href.endsWith(".md") && !href.endsWith(".txt")) {
    return (
      <Link
        to={href}
        className="text-ink underline decoration-line underline-offset-4 hover:decoration-ink"
      >
        {children}
      </Link>
    );
  }
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="text-ink underline decoration-line underline-offset-4 hover:decoration-ink"
      {...rest}
    >
      {children}
    </a>
  );
}

function Pre({ children }: ComponentPropsWithoutRef<"pre">) {
  const code = children as ReactElement<{ className?: string; children?: ReactNode }>;
  const text = typeof code?.props?.children === "string" ? code.props.children : "";
  return (
    <div className="my-5">
      <CodeBlock code={text.replace(/\n$/, "")} />
    </div>
  );
}

/** How each Markdown element looks in the docs. */
export const mdxComponents = {
  h2: (p: ComponentPropsWithoutRef<"h2">) => (
    <Heading
      as="h2"
      id={p.id}
      className="mt-12 mb-4 border-t border-line pt-8 text-2xl font-medium tracking-tight"
    >
      {p.children}
    </Heading>
  ),
  h3: (p: ComponentPropsWithoutRef<"h3">) => (
    <Heading as="h3" id={p.id} className="mt-8 mb-3 text-lg font-medium">
      {p.children}
    </Heading>
  ),
  h4: (p: ComponentPropsWithoutRef<"h4">) => (
    <Heading as="h4" id={p.id} className="mt-6 mb-2 font-medium">
      {p.children}
    </Heading>
  ),
  p: (p: ComponentPropsWithoutRef<"p">) => <p className="my-4 leading-7 text-ink/85" {...p} />,
  a: Anchor,
  ul: (p: ComponentPropsWithoutRef<"ul">) => (
    <ul className="my-4 list-disc space-y-2 pl-6 leading-7 text-ink/85 marker:text-muted" {...p} />
  ),
  ol: (p: ComponentPropsWithoutRef<"ol">) => (
    <ol
      className="my-4 list-decimal space-y-2 pl-6 leading-7 text-ink/85 marker:text-muted"
      {...p}
    />
  ),
  li: (p: ComponentPropsWithoutRef<"li">) => <li className="pl-1 [&>p]:my-1" {...p} />,
  strong: (p: ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-medium text-ink" {...p} />
  ),
  hr: () => <hr className="my-10 border-line" />,
  blockquote: (p: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote className="my-6 border-l-2 border-seal pl-4 font-voice italic text-ink/80" {...p} />
  ),
  code: (p: ComponentPropsWithoutRef<"code">) => (
    <code className="rounded-md bg-track px-1.5 py-0.5 font-mono text-[0.85em]" {...p} />
  ),
  pre: Pre,
  table: (p: ComponentPropsWithoutRef<"table">) => (
    <div className="my-6 overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-left text-sm" {...p} />
    </div>
  ),
  th: (p: ComponentPropsWithoutRef<"th">) => (
    <th className="border-b border-line bg-surface px-4 py-2.5 font-medium" {...p} />
  ),
  td: (p: ComponentPropsWithoutRef<"td">) => (
    <td
      className="border-b border-line px-4 py-2.5 align-top text-ink/85 [tr:last-child_&]:border-0"
      {...p}
    />
  ),
  Callout,
  ConnectTabs,
};
