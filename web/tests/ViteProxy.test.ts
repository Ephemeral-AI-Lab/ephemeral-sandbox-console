import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vite preview proxy", () => {
  it("proxies only preview routes and never source modules", async () => {
    const source = await readFile(join(resolve(process.cwd()), "vite.config.ts"), "utf8");

    expect(source).toContain('"/s/": {');
    expect(source).not.toContain('"/s": {');
  });

  it("serves the repository-owned shared public tree", async () => {
    const source = await readFile(join(resolve(process.cwd()), "vite.config.ts"), "utf8");

    expect(source).toContain(
      'publicDir: fileURLToPath(new URL("../shared/public", import.meta.url))',
    );
    expect(source).not.toContain('new URL("./public"');
  });

  it("emits authoritative Vite and shared-asset manifests for the BFF cache policy", async () => {
    const source = await readFile(join(resolve(process.cwd()), "vite.config.ts"), "utf8");

    expect(source).toContain("manifest: true");
    expect(source).toContain('fileName: ".vite/shared-assets-manifest.json"');
  });
});
