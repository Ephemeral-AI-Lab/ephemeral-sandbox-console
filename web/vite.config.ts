import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const consoleServer = process.env.SANDBOX_CONSOLE_BIND ?? "127.0.0.1:7880";

function packageSharedAssetManifest(): Plugin {
  return {
    name: "package-shared-asset-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".vite/shared-assets-manifest.json",
        source: readFileSync(
          new URL("../shared/assets/manifest.json", import.meta.url),
          "utf8",
        ),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), packageSharedAssetManifest()],
  publicDir: fileURLToPath(new URL("../shared/public", import.meta.url)),
  build: {
    manifest: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://${consoleServer}`,
        changeOrigin: false,
      },
      "/s/": {
        target: `http://${consoleServer}`,
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
