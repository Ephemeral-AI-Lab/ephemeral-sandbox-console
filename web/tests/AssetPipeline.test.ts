import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("shared asset pipeline", () => {
  it("pins the approved source and exact public URLs", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(process.cwd(), "../shared/assets/manifest.json"), "utf8"),
    );

    expect(manifest).toMatchObject({
      product: "Ephemeral Sandbox",
      source: {
        path: "shared/assets/source/ephemeral-sandbox-mascot.png",
        sha256: "b940877050866fb52b9e9e1142e7cffebfc5d5c77dfca26f0da5a82e00612bd3",
        width: 1024,
        height: 1024,
        colorMode: "RGBA",
        colorSpace: "sRGB",
      },
      derivatives: {
        web: {
          png: {
            path: "shared/public/brand/ephemeral-sandbox-mascot-b9408770.png",
            mimeType: "image/png",
          },
          webp: {
            path: "shared/public/brand/ephemeral-sandbox-mascot-b9408770.webp",
            mimeType: "image/webp",
          },
        },
      },
    });
  });

  it(
    "verifies hashes, formats, dimensions, fonts, licenses, and Tauri icons",
    async () => {
      const result = await execFileAsync(process.execPath, ["scripts/assets.mjs", "verify"], {
        cwd: process.cwd(),
      });
      expect(result.stdout).toContain(
        "verified 56 derivatives from b940877050866fb52b9e9e1142e7cffebfc5d5c77dfca26f0da5a82e00612bd3",
      );
    },
    20_000,
  );
});
