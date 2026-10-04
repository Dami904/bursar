import { Download, X } from "lucide-react";
import { useState } from "react";
import type { MediaItem } from "../lib/api.js";

/**
 * What a seller delivered, shown as itself: pictures to look at (click to enlarge), players for
 * audio and video. The files are ours (kept when they were delivered), never the seller's address.
 */
export function MediaGallery({ items }: { items: MediaItem[] }) {
  const [enlarged, setEnlarged] = useState<MediaItem | null>(null);
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <figure key={item.url} className="overflow-hidden rounded-xl border border-line">
          {item.kind === "image" && (
            <button
              type="button"
              className="block w-full cursor-zoom-in bg-track"
              onClick={() => setEnlarged(item)}
              aria-label="Enlarge the image"
            >
              <img
                src={item.url}
                alt="Delivered by the seller"
                loading="lazy"
                className="mx-auto max-h-96 w-auto max-w-full"
              />
            </button>
          )}
          {item.kind === "audio" && (
            <audio controls preload="metadata" src={item.url} className="w-full" />
          )}
          {item.kind === "video" && (
            <video
              controls
              preload="metadata"
              src={item.url}
              className="max-h-96 w-full bg-black"
            />
          )}
          <figcaption className="flex justify-end border-t border-line px-3 py-1.5 text-xs text-muted">
            <a
              href={`${item.url}?download=1`}
              className="flex items-center gap-1 underline"
              rel="noopener noreferrer"
            >
              <Download size={12} /> Download
            </a>
          </figcaption>
        </figure>
      ))}
      {enlarged && (
        <div
          role="dialog"
          aria-label="Enlarged image"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={() => setEnlarged(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
          <img src={enlarged.url} alt="Delivered by the seller" className="max-h-full max-w-full" />
        </div>
      )}
    </div>
  );
}
