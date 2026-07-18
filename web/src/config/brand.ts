export const PRODUCT_NAME = "Ephemeral Sandbox";
export const PRODUCT_SHORT_NAME = "Sandbox";
export const CONSOLE_LABEL = "Console";

export const MASCOT_SOURCE_SHA256 =
  "b940877050866fb52b9e9e1142e7cffebfc5d5c77dfca26f0da5a82e00612bd3";
export const MASCOT_PNG_URL =
  "/brand/ephemeral-sandbox-mascot-b9408770.png";
export const MASCOT_WEBP_URL =
  "/brand/ephemeral-sandbox-mascot-b9408770.webp";
export const MASCOT_ACCESSIBLE_LABEL = `${PRODUCT_NAME} mascot`;
export const DECORATIVE_MASCOT_ALT = "";

export const BRAND = {
  name: PRODUCT_NAME,
  shortName: PRODUCT_SHORT_NAME,
  consoleLabel: CONSOLE_LABEL,
  mascot: {
    pngUrl: MASCOT_PNG_URL,
    webpUrl: MASCOT_WEBP_URL,
    accessibleLabel: MASCOT_ACCESSIBLE_LABEL,
    decorativeAlt: DECORATIVE_MASCOT_ALT,
  },
} as const;
