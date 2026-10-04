import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { txUrl } from "../lib/config.js";
import { TxLink } from "./ui.js";

describe("a transaction link", () => {
  it("shows the short hash, opens the explorer in a new tab, and can copy the whole hash", () => {
    const hash = "0x" + "ab".repeat(32);
    const html = renderToStaticMarkup(<TxLink hash={hash} />);
    expect(html).toContain(`href="${txUrl(hash)}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("0xabab…abab");
    // Only the short form is printed; the whole hash lives in the link and the copy button.
    const visible = html.replace(/<[^>]*>/g, " ");
    expect(visible).not.toContain(hash);
    expect(html).toContain("Copy the transaction hash");
  });
});
