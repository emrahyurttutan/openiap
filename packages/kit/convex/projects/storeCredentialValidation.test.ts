import { describe, expect, it } from "vitest";

import {
  normalizeAppStoreIssuerId,
  normalizeAppStoreKeyId,
  normalizeOptionalAppStoreIssuerId,
  normalizeOptionalAppStoreKeyId,
} from "./storeCredentialValidation";

describe("store credential validation", () => {
  it("trims a valid issuer id and preserves its case", () => {
    expect(
      normalizeAppStoreIssuerId("  12345678-abcd-1234-abcd-1234567890ab  "),
    ).toBe("12345678-abcd-1234-abcd-1234567890ab");
  });

  it("rejects an issuer id that is not a uuid", () => {
    expect(() => normalizeAppStoreIssuerId("not-a-uuid")).toThrow();
  });

  it("upper-cases a valid key id", () => {
    expect(normalizeAppStoreKeyId(" abcde12345 ")).toBe("ABCDE12345");
  });

  it("rejects a key id that is not ten alphanumerics", () => {
    expect(() => normalizeAppStoreKeyId("ABCDE1234")).toThrow();
    expect(() => normalizeAppStoreKeyId("ABCDE-12345")).toThrow();
  });

  it("clears an optional credential on null or blank input", () => {
    expect(normalizeOptionalAppStoreIssuerId(null)).toBeNull();
    expect(normalizeOptionalAppStoreIssuerId("   ")).toBeNull();
    expect(normalizeOptionalAppStoreKeyId(null)).toBeNull();
    expect(normalizeOptionalAppStoreKeyId("")).toBeNull();
  });

  it("validates a non-blank optional credential", () => {
    expect(normalizeOptionalAppStoreKeyId("abcde12345")).toBe("ABCDE12345");
    expect(() => normalizeOptionalAppStoreKeyId("nope")).toThrow();
  });
});
