import type { MDXContent } from "mdx/types";
import { ArrowLeft, ArrowRight, FileText, Menu, Pencil, Search, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentType,
} from "react";
import { Link, Navigate, NavLink, useLocation, useParams } from "react-router";
import { Footer } from "../pages/landing/Sections.js";
import { SiteHeader } from "../pages/landing/Landing.js";
import { mdxComponents } from "./mdx.js";
import { docPages, docSections, docsRepoPath, type DocPage } from "./nav.js";
import { SearchDialog, useSearchShortcut } from "./SearchDialog.js";

const modules = import.meta.glob<{ default: MDXContent }>("./content/*.mdx");

/** One lazily loaded component per page, made once so React keeps them between visits. */
const pages: Record<
  string,
  ComponentType<{ components: typeof mdxComponents }>
> = Object.fromEntries(
  docPages.flatMap((p) => {
    const load = modules[`./content/${p.slug}.mdx`];
    return load === undefined ? [] : [[p.slug, lazy(load)]];
  }),
);

interface TocItem {
  id: string;
  text: string;
  depth: number;
}

/** The docs: sidebar, the page, and "On this page". Every page lives at /docs/<slug>. */
export function Docs() {
  const { slug = "" } = useParams();
  const index = docPages.findIndex((p) => p.slug === slug);
  const page = docPages[index];
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const openSearch = useCallback(() => setSearching(true), []);
  useSearchShortcut(openSearch);

  useEffect(() => setMenu(false), [slug]);
  useEffect(() => {
    if (page) document.title = `${page.title} · Bursar docs`;
    return () => {
      document.title = "Bursar";
    };
  }, [page]);

  if (page === undefined) return <Navigate to="/docs/introduction" replace />;
  const section = docSections.find((s) => s.pages.includes(page));

  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <div className="sticky top-[65px] z-10 flex items-center gap-2 border-b border-line bg-bg/90 px-5 py-2 backdrop-blur-md lg:hidden">
        <button
          onClick={() => setMenu(true)}
          className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1.5 text-sm text-muted"
        >
          <Menu size={16} className="shrink-0" />
          <span className="truncate">
            {section?.title} <span className="text-line">/</span>{" "}
            <span className="text-ink">{page.title}</span>
          </span>
        </button>
        <button
          onClick={openSearch}
          className="ml-auto rounded-full p-2 text-muted"
          aria-label="Search the docs"
        >
          <Search size={16} />
        </button>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-12 px-5 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_12rem]">
        <aside className="sticky top-[65px] hidden h-[calc(100dvh-65px)] overflow-y-auto py-8 lg:block">
          <SearchButton onClick={openSearch} />
          <Sidebar current={page.slug} />
        </aside>

        <main className="min-w-0 pb-24 pt-8 lg:pt-12">
          <article className="mx-auto max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-seal">
              {section?.title}
            </p>
            <h1 className="mt-3 text-4xl font-medium tracking-[-0.03em]">{page.title}</h1>
            <p className="mt-3 text-lg text-muted">{page.description}</p>
            <PageBody key={page.slug} slug={page.slug} />
            <PageFooter page={page} prev={docPages[index - 1]} next={docPages[index + 1]} />
          </article>
        </main>

        <aside className="sticky top-[65px] hidden h-[calc(100dvh-65px)] overflow-y-auto py-12 xl:block">
          <OnThisPage slug={page.slug} />
        </aside>
      </div>

      {menu && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setMenu(false)}>
          <nav
            className="h-full w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-bg p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="font-medium">Docs</span>
              <button
                onClick={() => setMenu(false)}
                aria-label="Close menu"
                className="p-1 text-muted"
              >
                <X size={18} />
              </button>
            </div>
            <SearchButton
              onClick={() => {
                setMenu(false);
                openSearch();
              }}
            />
            <Sidebar current={page.slug} />
          </nav>
        </div>
      )}
      <SearchDialog open={searching} onClose={() => setSearching(false)} />
      <Footer />
    </div>
  );
}

function SearchButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-6 flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted hover:border-muted"
    >
      <Search size={14} /> Search
      <kbd className="ml-auto rounded-md border border-line px-1.5 text-[11px]">Ctrl K</kbd>
    </button>
  );
}

function Sidebar({ current }: { current: string }) {
  return (
    <nav aria-label="Docs" className="space-y-7 text-sm">
      {docSections.map((s) => (
        <div key={s.title}>
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.15em] text-muted">
            {s.title}
          </p>
          <ul className="space-y-0.5 border-l border-line">
            {s.pages.map((p) => (
              <li key={p.slug}>
                <NavLink
                  to={`/docs/${p.slug}`}
                  className={`-ml-px block border-l py-1.5 pl-3 ${
                    p.slug === current
                      ? "border-seal font-medium text-ink"
                      : "border-transparent text-muted hover:border-muted hover:text-ink"
                  }`}
                >
                  {p.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Renders the page, then scrolls to the linked section (or the top) once it's on screen. */
function PageBody({ slug }: { slug: string }) {
  const Page = pages[slug];
  if (Page === undefined) return null;
  return (
    <div className="docs-body mt-2">
      <Suspense fallback={<div className="mt-10 h-96 animate-pulse rounded-2xl bg-surface" />}>
        <Page components={mdxComponents} />
        <ScrollOnReady />
      </Suspense>
    </div>
  );
}

function ScrollOnReady() {
  const { hash } = useLocation();
  useLayoutEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
    window.dispatchEvent(new Event("docs:rendered"));
  }, [hash]);
  return null;
}

/** The page's headings, with the one you're reading highlighted. */
function OnThisPage({ slug }: { slug: string }) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    const collect = () => {
      const headings = [
        ...document.querySelectorAll<HTMLElement>(".docs-body h2[id], .docs-body h3[id]"),
      ];
      setItems(
        headings.map((h) => ({
          id: h.id,
          text: h.textContent ?? "",
          depth: h.tagName === "H3" ? 3 : 2,
        })),
      );
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.filter((e) => e.isIntersecting);
          if (visible[0]) setActive(visible[0].target.id);
        },
        { rootMargin: "-80px 0px -70% 0px" },
      );
      headings.forEach((h) => observer?.observe(h));
    };
    collect();
    window.addEventListener("docs:rendered", collect);
    return () => {
      window.removeEventListener("docs:rendered", collect);
      observer?.disconnect();
    };
  }, [slug]);

  if (items.length === 0) return null;
  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-muted">
        On this page
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className={item.depth === 3 ? "pl-3" : ""}>
            <a
              href={`#${item.id}`}
              className={`block leading-snug ${
                active === item.id ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PageFooter({
  page,
  prev,
  next,
}: {
  page: DocPage;
  prev?: DocPage | undefined;
  next?: DocPage | undefined;
}) {
  return (
    <footer className="mt-16 border-t border-line pt-6">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
        <a
          href={`https://github.com/Dami904/bursar/edit/main/${docsRepoPath}/${page.slug}.mdx`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-ink"
        >
          <Pencil size={13} /> Edit on GitHub
        </a>
        <a
          href={`/docs/${page.slug}.md`}
          className="inline-flex items-center gap-1.5 hover:text-ink"
        >
          <FileText size={13} /> This page as Markdown
        </a>
      </div>
      <div className="mt-8 grid grid-cols-2 gap-4">
        {prev ? (
          <Link
            to={`/docs/${prev.slug}`}
            className="rounded-xl border border-line p-4 hover:border-muted"
          >
            <span className="flex items-center gap-1 text-xs text-muted">
              <ArrowLeft size={12} /> Previous
            </span>
            <span className="mt-1 block font-medium">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            to={`/docs/${next.slug}`}
            className="rounded-xl border border-line p-4 text-right hover:border-muted"
          >
            <span className="flex items-center justify-end gap-1 text-xs text-muted">
              Next <ArrowRight size={12} />
            </span>
            <span className="mt-1 block font-medium">{next.title}</span>
          </Link>
        )}
      </div>
    </footer>
  );
}
