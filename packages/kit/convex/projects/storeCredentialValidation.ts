import { createError, ErrorCode } from "../utils/errors";

// Shared by the project inputs (projects/mutation.ts) and the organization
// defaults (organizations/mutation.ts) so the two cannot drift apart.

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

// Organization defaults are clearable: null or blank removes the column.
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
