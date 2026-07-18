import { expect, test, type Page } from "@playwright/test";
import { installAtlasApi, SANDBOX_ID } from "./atlas";

const previewRoute = `/sandboxes/${SANDBOX_ID}/preview?port=5173`;
const previewPrefix = `/s/${SANDBOX_ID}/shared/5173`;
const iframeTitle = `preview of ${SANDBOX_ID} port 5173`;
const previewCsp = "sandbox allow-scripts; default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; frame-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; form-action 'self'";

async function waitForPageAssets(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    Array.from(document.images).every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
}

async function openPreview(page: Page, body: string, status = 200) {
  await page.route(`**${previewPrefix}/**`, (route) => route.fulfill({ status, contentType: "text/html", body }));
  await installAtlasApi(page);
  await page.goto(`/atlas.html?route=${encodeURIComponent(previewRoute)}`);
  await waitForPageAssets(page);
  return page.frameLocator(`iframe[title="${iframeTitle}"]`);
}

for (const [width, height] of [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1440, 900],
] as const) {
  test(`P08 Preview opaque normal state at ${width}x${height} @visual`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const preview = await openPreview(page, "<main><h1>Preview ready</h1><p>Untrusted app output remains inside the opaque frame.</p></main>");
    await expect(preview.getByRole("heading", { name: "Preview ready" })).toBeVisible();
    await expect(page).toHaveScreenshot(`p08-preview-success-${width}x${height}.png`, { animations: "disabled" });
  });
}

test("P08 Preview exposes its opaque loading state @visual", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route(`**${previewPrefix}/**`, async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ contentType: "text/html", body: "<h1>Preview ready</h1>" });
  });
  await installAtlasApi(page);
  const navigation = page.goto(`/atlas.html?route=${encodeURIComponent(previewRoute)}`);
  await expect(page.getByRole("status")).toHaveText("Loading preview…");
  await waitForPageAssets(page);
  await expect(page).toHaveScreenshot("p08-preview-loading-1440x900.png", { animations: "disabled" });
  release?.();
  await navigation;
});

test("P08 Preview keeps proxy failures inside the opaque frame @visual", async ({ page }) => {
  const preview = await openPreview(page, "<main><h1>Preview unavailable</h1><p>The selected Preview route could not be reached.</p></main>", 502);
  await expect(preview.getByRole("heading", { name: "Preview unavailable" })).toBeVisible();
  await expect(page).toHaveScreenshot("p08-preview-error-1440x900.png", { animations: "disabled" });
});

test("P08 Preview keeps an opaque frame boundary while preserving selected capabilities @security", async ({ page }) => {
  let opaqueApiOrigin: string | undefined;
  let sameOriginWebSocketRouteHandled = false;
  const externalRequests: string[] = [];
  await page.routeWebSocket(`**${previewPrefix}/same-origin-ws`, () => {
    sameOriginWebSocketRouteHandled = true;
  });
  await page.route("https://preview-external.invalid/**", async (route) => {
    externalRequests.push(route.request().url());
    await route.fulfill({ status: 200, body: "unexpected external response" });
  });
  await page.route(`**${previewPrefix}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/same-origin-http")) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "same-origin response" });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": previewCsp },
      body: `<!doctype html><body>
        <output id=script>pending</output>
        <output id=parent>pending</output>
        <output id=popup>pending</output>
        <output id=top>pending</output>
        <output id=api>pending</output>
        <output id=relative-http>pending</output>
        <output id=relative-ws>pending</output>
        <output id=external-fetch>pending</output>
        <output id=external-image>pending</output>
        <output id=external-font>pending</output>
        <img src="https://preview-external.invalid/image.png"
          onload="document.querySelector('#external-image').textContent = 'loaded'"
          onerror="document.querySelector('#external-image').textContent = 'blocked'">
        <script>
          document.querySelector('#script').textContent = 'script ran';
          try { parent.document.body.dataset.previewEscaped = 'yes'; } catch { document.querySelector('#parent').textContent = 'blocked'; }
          document.querySelector('#popup').textContent = window.open('about:blank') === null ? 'blocked' : 'opened';
          try { top.location.href = '/api/rpc'; } catch { document.querySelector('#top').textContent = 'blocked'; }
          fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .then((response) => { document.querySelector('#api').textContent = response.status === 403 ? 'guarded' : 'unexpected'; })
            .catch(() => { document.querySelector('#api').textContent = 'blocked'; });
          fetch('./same-origin-http')
            .then((response) => response.text())
            .then((body) => { document.querySelector('#relative-http').textContent = body === 'same-origin response' ? 'allowed' : 'unexpected'; })
            .catch(() => { document.querySelector('#relative-http').textContent = 'blocked'; });
          const websocketUrl = new URL('./same-origin-ws', location.href);
          websocketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(websocketUrl);
          socket.addEventListener('open', () => {
            document.querySelector('#relative-ws').textContent = 'allowed';
            socket.close();
          });
          socket.addEventListener('error', () => { document.querySelector('#relative-ws').textContent = 'blocked'; });
          fetch('https://preview-external.invalid/fetch')
            .then(() => { document.querySelector('#external-fetch').textContent = 'loaded'; })
            .catch(() => { document.querySelector('#external-fetch').textContent = 'blocked'; });
          new FontFace('BlockedExternal', 'url(https://preview-external.invalid/font.woff2)')
            .load()
            .then(() => { document.querySelector('#external-font').textContent = 'loaded'; })
            .catch(() => { document.querySelector('#external-font').textContent = 'blocked'; });
        </script>
      </body>`,
    });
  });
  await installAtlasApi(page);
  await page.route("**/api/rpc", async (route) => {
    opaqueApiOrigin = route.request().headers().origin;
    await route.fulfill({ status: 403, body: "opaque origins cannot call console APIs" });
  });
  await page.goto(`/atlas.html?route=${encodeURIComponent(previewRoute)}`);

  const iframe = page.getByTitle(iframeTitle);
  const preview = page.frameLocator(`iframe[title="${iframeTitle}"]`);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("allow", "");
  await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(preview.locator("#script")).toHaveText("script ran");
  await expect(preview.locator("#parent")).toHaveText("blocked");
  await expect(preview.locator("#popup")).toHaveText("blocked");
  await expect(preview.locator("#top")).toHaveText("blocked");
  await expect(preview.locator("#api")).toHaveText("guarded");
  await expect(preview.locator("#relative-http")).toHaveText("allowed");
  await expect(preview.locator("#relative-ws")).toHaveText("allowed");
  await expect(preview.locator("#external-fetch")).toHaveText("blocked");
  await expect(preview.locator("#external-image")).toHaveText("blocked");
  await expect(preview.locator("#external-font")).toHaveText("blocked");
  expect(sameOriginWebSocketRouteHandled).toBe(true);
  expect(externalRequests).toEqual([]);
  expect(opaqueApiOrigin).toBe("null");
  await expect(page.locator("[data-atlas-location]")).toHaveText(previewRoute);
  expect(await iframe.evaluate((frame) => {
    try {
      void frame.contentWindow?.location.href;
      return false;
    } catch {
      return true;
    }
  })).toBe(true);

});
