import { createError, ErrorCode } from "../utils/errors";

// Apple issues one Issuer ID per team and 10-character Key IDs per key.
// Both the project-level inputs (projects/mutation.ts) and the
// organization-level defaults (organizations/mutation.ts) validate through
// this module so the two surfaces cannot drift apart.

export function normalizeAppStoreIssuerId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "App Store Connect Issuer ID cannot be empty.",
    );
  }

  const issuerPattern =
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  if (!issuerPattern.test(normalized)) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "App Store Connect Issuer ID must be a valid UUID (e.g. 12345678-ABCD-1234-ABCD-1234567890AB).",
    );
  }

  return normalized;
}

export function normalizeAppStoreKeyId(input: string): string {
  const normalized = input.trim().toUpperCase();
  if (!normalized) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "App Store Connect Key ID cannot be empty.",
    );
  }

  const keyPattern = /^[A-Z0-9]{10}$/;
  if (!keyPattern.test(normalized)) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "App Store Connect Key ID must be 10 uppercase letters or numbers (e.g. ABCDE12345).",
    );
  }

  return normalized;
}

// Organization defaults are clearable: `null` or a blank string removes the
// column. Anything else must still pass the strict format check above.
export function normalizeOptionalAppStoreIssuerId(
  input: string | null,
): string | null {
  if (input === null || input.trim() === "") return null;
  return normalizeAppStoreIssuerId(input);
}

export function normalizeOptionalAppStoreKeyId(
  input: string | null,
): string | null {
  if (input === null || input.trim() === "") return null;
  return normalizeAppStoreKeyId(input);
}
