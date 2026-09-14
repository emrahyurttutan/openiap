import { describe, expect, it, vi } from "vitest";

// Apple names the signing key in the JWT's `kid`, so a resolved key id and the
// .p8 that signs for it must come from the same level. These lock the pinning
// that keeps an inherited id from being paired with a project-owned key.

const actionMocks = vi.hoisted(() => ({
  runQuery: vi.fn(),
  runAction: vi.fn(),
}));

import {
  getAppleAscApiKey as registeredAscKey,
  getAppleP8Key as registeredP8Key,
} from "./internal";
import { testableFunction } from "../test.setup";

const getAppleP8Key = testableFunction(registeredP8Key);
const getAppleAscApiKey = testableFunction(registeredAscKey);

type Row = Record<string, unknown> & { _id: string };

const ORG_ROW: Row = { _id: "files_org", purpose: "apple_p8_key" };
const OWN_ROW: Row = {
  _id: "files_own",
  projectId: "projects_a",
  purpose: "apple_p8_key",
};

function makeCtx(files: Row[]) {
  actionMocks.runQuery.mockReset();
  actionMocks.runAction.mockReset();
  actionMocks.runQuery.mockResolvedValue(files);
  actionMocks.runAction.mockImplementation(
    async (_ref: unknown, args: { fileId: string }) => ({
      content: `content-of-${args.fileId}`,
      metadata: undefined,
    }),
  );
  return { runQuery: actionMocks.runQuery, runAction: actionMocks.runAction };
}

describe("apple key file pinning", () => {
  it("takes the organization key when the id was inherited", async () => {
    const ctx = makeCtx([ORG_ROW, OWN_ROW]);
    const result = await getAppleP8Key._handler(ctx, {
      organizationId: "organizations_a" as never,
      projectId: "projects_a" as never,
      source: "organization" as const,
    });
    expect(result.fileId).toBe("files_org");
  });

  it("takes the project key when the id is the project's own", async () => {
    const ctx = makeCtx([ORG_ROW, OWN_ROW]);
    const result = await getAppleP8Key._handler(ctx, {
      organizationId: "organizations_a" as never,
      projectId: "projects_a" as never,
      source: "project" as const,
    });
    expect(result.fileId).toBe("files_own");
  });

  it("refuses to substitute the project key for an inherited id", async () => {
    const ctx = makeCtx([OWN_ROW]);
    await expect(
      getAppleP8Key._handler(ctx, {
        organizationId: "organizations_a" as never,
        projectId: "projects_a" as never,
        source: "organization" as const,
      }),
    ).rejects.toThrow();
  });

  it("refuses to substitute the organization key for a project id", async () => {
    const ctx = makeCtx([ORG_ROW]);
    await expect(
      getAppleP8Key._handler(ctx, {
        organizationId: "organizations_a" as never,
        projectId: "projects_a" as never,
        source: "project" as const,
      }),
    ).rejects.toThrow();
  });

  it("falls back project-then-organization when no level is pinned", async () => {
    const ctx = makeCtx([ORG_ROW, OWN_ROW]);
    const result = await getAppleP8Key._handler(ctx, {
      organizationId: "organizations_a" as never,
      projectId: "projects_a" as never,
    });
    expect(result.fileId).toBe("files_own");
  });

  it("pins the App Store Connect key to its own level too", async () => {
    const ascOrg: Row = { _id: "asc_org", purpose: "apple_p8_asc_api_key" };
    const ascOwn: Row = {
      _id: "asc_own",
      projectId: "projects_a",
      purpose: "apple_p8_asc_api_key",
    };
    const ctx = makeCtx([ascOrg, ascOwn]);
    const result = await getAppleAscApiKey._handler(ctx, {
      organizationId: "organizations_a" as never,
      projectId: "projects_a" as never,
      source: "organization" as const,
    });
    expect(result.fileId).toBe("asc_org");
  });
});
