"use client";

import { useEffect } from "react";

/**
 * AmbientBackdrop extracts the dominant colour from the current album art
 * and applies it as a subtle radial gradient overlay behind the page content.
 */
export function AmbientBackdrop() {
  useEffect(() => {
    const extract = () => {
      try {
        if (typeof document === "undefined") return;
        const img = document.querySelector<HTMLImageElement>("img.cover");
        if (!img || !img.complete || img.naturalWidth === 0) return;

        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.drawImage(img, 0, 0, 4, 4);
        const data = ctx.getImageData(0, 0, 4, 4).data;

        let r = 0, g = 0, b = 0;
        const pixels = 16;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        r = Math.round(r / pixels);
        g = Math.round(g / pixels);
        b = Math.round(b / pixels);

        document.body.style.setProperty("--ambient-color", `rgb(${r},${g},${b})`);
      } catch {
        // silently no-op
      }
    };

    // Run once after a short delay to let images load, then observe for changes
    const timer = setTimeout(extract, 500);

    // Watch for cover image changes
    const observer = new MutationObserver(() => extract());
    if (typeof document !== "undefined") {
      const target = document.querySelector(".cover-wrap") || document.body;
      observer.observe(target, { subtree: true, attributes: true, attributeFilter: ["src"] });
    }

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return <div className="ambient-backdrop" aria-hidden="true" />;
}
