import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("an answer written in Markdown", () => {
  it("shows formatting instead of asterisks and dashes", () => {
    const out = html("**Core functionality:**\n\n- Swap tokens\n- Check balances");
    expect(out).toContain("<strong");
    expect(out).toContain("Core functionality:");
    expect(out).toContain("<li>Swap tokens</li>");
    expect(out).not.toContain("**");
  });

  it("never renders raw HTML or images from the text", () => {
    const out = html(
      '<script>alert(1)</script><img src="https://evil.example/x.png">\n\n![x](https://evil.example/y.png)',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
  });

  it("opens links in a new tab without telling the site where the click came from", () => {
    const out = html("[Arc mainnet launch](https://www.circle.com/pressroom/arc)");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain(">Arc mainnet launch</a>");
  });

  it("drops a link that isn't http(s)", () => {
    expect(html("[click](javascript:alert(1))")).not.toContain("javascript:");
  });
});
