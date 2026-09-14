import { describe, expect, it } from "vitest";

import {
  pickCredentialFile,
  resolveAppleCredentialIds,
} from "./storeCredentials";

const ORG_DEFAULTS = {
  defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
  defaultIosAppStoreKeyId: "ORGKEY1234",
  defaultIosAscIssuerId: null,
  defaultIosAscKeyId: "ORGASC1234",
};

describe("resolveAppleCredentialIds", () => {
  it("prefers the project value over the organization default", () => {
    const resolved = resolveAppleCredentialIds(
      { iosAppStoreKeyId: "PRJKEY1234" },
      ORG_DEFAULTS,
    );
    expect(resolved.keyId).toBe("PRJKEY1234");
    expect(resolved.sources.keyId).toBe("project");
  });

  it("falls back to the organization default when the project is unset", () => {
    const resolved = resolveAppleCredentialIds({}, ORG_DEFAULTS);
    expect(resolved.issuerId).toBe("11111111-1111-1111-1111-111111111111");
    expect(resolved.keyId).toBe("ORGKEY1234");
    expect(resolved.ascKeyId).toBe("ORGASC1234");
    expect(resolved.sources.issuerId).toBe("organization");
    expect(resolved.sources.keyId).toBe("organization");
    expect(resolved.sources.ascKeyId).toBe("organization");
  });

  it("treats a whitespace-only project value as unset", () => {
    const resolved = resolveAppleCredentialIds(
      { iosAppStoreKeyId: "   " },
      ORG_DEFAULTS,
    );
    expect(resolved.keyId).toBe("ORGKEY1234");
    expect(resolved.sources.keyId).toBe("organization");
  });

  it("reports a credential as unset when neither level has it", () => {
    const resolved = resolveAppleCredentialIds({}, null);
    expect(resolved.issuerId).toBeUndefined();
    expect(resolved.keyId).toBeUndefined();
    expect(resolved.ascKeyId).toBeUndefined();
    expect(resolved.sources.keyId).toBeUndefined();
  });

  it("ignores a null organization default", () => {
    const resolved = resolveAppleCredentialIds(
      { ...{} },
      { ...ORG_DEFAULTS, defaultIosAscKeyId: null },
    );
    expect(resolved.ascKeyId).toBeUndefined();
  });
});

describe("pickCredentialFile", () => {
  const ownFile = { _id: "files_own", projectId: "projects_a" as never };
  const orgFile = { _id: "files_org", projectId: undefined };
  const otherFile = { _id: "files_other", projectId: "projects_b" as never };

  it("prefers the project's own file", () => {
    expect(
      pickCredentialFile([orgFile, otherFile, ownFile], "projects_a" as never),
    ).toBe(ownFile);
  });

  it("falls back to the organization file", () => {
    expect(
      pickCredentialFile([otherFile, orgFile], "projects_a" as never),
    ).toBe(orgFile);
  });

  it("never returns another project's file", () => {
    expect(
      pickCredentialFile([otherFile], "projects_a" as never),
    ).toBeUndefined();
  });

  it("returns the organization file when no project is given", () => {
    expect(pickCredentialFile([otherFile, orgFile], undefined)).toBe(orgFile);
  });
});

describe("resolved ids drive the ASC pair rule", () => {
  // Mirrors the pair-resolution rule in convex/products/asc.ts, locked here
  // so inheritance cannot change which key signs an ASC request.
  function ascPair(resolved: ReturnType<typeof resolveAppleCredentialIds>) {
    const useAsc = !!resolved.ascKeyId;
    return {
      issuerId: useAsc
        ? (resolved.ascIssuerId ?? resolved.issuerId)
        : resolved.issuerId,
      keyId: useAsc ? resolved.ascKeyId : resolved.keyId,
    };
  }

  it("signs with the inherited ASC key and the inherited shared issuer", () => {
    const resolved = resolveAppleCredentialIds({}, ORG_DEFAULTS);
    expect(ascPair(resolved)).toEqual({
      issuerId: "11111111-1111-1111-1111-111111111111",
      keyId: "ORGASC1234",
    });
  });

  it("falls back to the server api pair when no ASC key resolves", () => {
    const resolved = resolveAppleCredentialIds(
      {},
      { ...ORG_DEFAULTS, defaultIosAscKeyId: null },
    );
    expect(ascPair(resolved)).toEqual({
      issuerId: "11111111-1111-1111-1111-111111111111",
      keyId: "ORGKEY1234",
    });
  });

  it("lets a project override only its own ASC key", () => {
    const resolved = resolveAppleCredentialIds(
      { iosAscKeyId: "PRJASC1234" },
      ORG_DEFAULTS,
    );
    expect(ascPair(resolved)).toEqual({
      issuerId: "11111111-1111-1111-1111-111111111111",
      keyId: "PRJASC1234",
    });
  });
});
