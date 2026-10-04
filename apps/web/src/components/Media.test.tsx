import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaGallery } from "./Media.js";

const item = (kind: "image" | "audio" | "video", url: string) => ({
  url,
  kind,
  contentType: `${kind}/x`,
  bytes: 1,
});

describe("delivered media", () => {
  it("shows a picture, a sound and a video as themselves", () => {
    const out = renderToStaticMarkup(
      <MediaGallery
        items={[
          item("image", "https://blob.test/a.png"),
          item("audio", "https://blob.test/b.mp3"),
          item("video", "https://blob.test/c.mp4"),
        ]}
      />,
    );
    expect(out).toContain("<img");
    expect(out).toContain("<audio");
    expect(out).toContain("<video");
  });

  it("never prints the file's address as text", () => {
    const out = renderToStaticMarkup(
      <MediaGallery items={[item("image", "https://blob.test/a.png")]} />,
    );
    const text = out.replace(/<[^>]*>/g, " ");
    expect(text).not.toContain("blob.test");
    expect(text).toContain("Download");
  });
});
