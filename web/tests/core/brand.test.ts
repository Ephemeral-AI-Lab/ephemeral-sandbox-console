import { describe, expect, it } from "vitest";
import {
  BRAND,
  DECORATIVE_MASCOT_ALT,
  MASCOT_PNG_URL,
  MASCOT_SOURCE_SHA256,
  MASCOT_WEBP_URL,
  PRODUCT_NAME,
} from "@/config/brand";

describe("Ephemeral Sandbox brand config", () => {
  it("centralizes the active UI name and local content-addressed assets", () => {
    expect(PRODUCT_NAME).toBe("Ephemeral Sandbox");
    expect(BRAND.name).toBe(PRODUCT_NAME);
    expect(MASCOT_SOURCE_SHA256).toBe(
      "b940877050866fb52b9e9e1142e7cffebfc5d5c77dfca26f0da5a82e00612bd3",
    );
    expect(MASCOT_PNG_URL).toBe("/brand/ephemeral-sandbox-mascot-b9408770.png");
    expect(MASCOT_WEBP_URL).toBe("/brand/ephemeral-sandbox-mascot-b9408770.webp");
    expect(MASCOT_PNG_URL).not.toMatch(/^https?:/);
    expect(MASCOT_WEBP_URL).not.toMatch(/^https?:/);
    expect(DECORATIVE_MASCOT_ALT).toBe("");
  });
});
