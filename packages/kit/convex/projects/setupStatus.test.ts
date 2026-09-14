import { beforeEach, describe, expect, it, vi } from "vitest";

const helperMocks = vi.hoisted(() => ({
  resolveProjectByIdForCurrentUserFromDb: vi.fn(),
  resolveProjectByApiKeyFromDb: vi.fn(),
}));

vi.mock("./helpers", () => ({
  resolveProjectByIdForCurrentUserFromDb:
    helperMocks.resolveProjectByIdForCurrentUserFromDb,
  resolveProjectByApiKeyFromDb: helperMocks.resolveProjectByApiKeyFromDb,
}));

import { getSetupStatus as registeredGetSetupStatus } from "./setupStatus";
import { testableFunction } from "../test.setup";

const getSetupStatus = testableFunction(registeredGetSetupStatus);

type Row = Record<string, unknown> & { _id: string };

class IndexBuilder {
  predicates: Array<(row: Row) => boolean> = [];

  eq(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] === value);
    return this;
  }
}

class TestQuery {
  constructor(private readonly rows: Row[]) {}

  withIndex(
    _name: string,
    build: (q: IndexBuilder) => IndexBuilder,
  ): TestQuery {
    const builder = build(new IndexBuilder());
    return new TestQuery(
      this.rows.filter((row) =>
        builder.predicates.every((predicate) => predicate(row)),
      ),
    );
  }

  async collect(): Promise<Row[]> {
    return [...this.rows];
  }
}

const ORGANIZATION: Row = {
  _id: "organizations_a",
  defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
  defaultIosAppStoreKeyId: "ORGKEY1234",
  defaultIosAscKeyId: "ORGASC1234",
};

const BARE_PROJECT: Row = {
  _id: "projects_a",
  organizationId: "organizations_a",
  iosBundleId: "com.example.app",
  iosAppAppleId: 123,
  androidPackageName: "com.example.app",
};

function makeCtx(files: Row[], organization: Row = ORGANIZATION) {
  const tables: Record<string, Row[]> = {
    files,
    organizations: [organization],
  };
  return {
    db: {
      get: async (id: string) =>
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null,
      query: (table: string) => new TestQuery(tables[table] ?? []),
    },
  };
}

describe("getSetupStatus inheritance", () => {
  beforeEach(() => {
    helperMocks.resolveProjectByIdForCurrentUserFromDb.mockReset();
    helperMocks.resolveProjectByIdForCurrentUserFromDb.mockResolvedValue({
      project: BARE_PROJECT,
    });
  });

  it("reports iOS configured from organization defaults alone", async () => {
    const ctx = makeCtx([
      {
        _id: "files_org_p8",
        organizationId: "organizations_a",
        purpose: "apple_p8_key",
      },
      {
        _id: "files_org_sa",
        organizationId: "organizations_a",
        purpose: "android_service_account",
      },
    ]);
    const status = await getSetupStatus._handler(ctx, {
      projectId: "projects_a" as never,
    });

    expect(status.ios.configured).toBe(true);
    expect(status.ios.missing).toEqual([]);
    expect(status.appleP8Uploaded).toBe(true);
    expect(status.googleServiceAccountUploaded).toBe(true);
    expect(status.usingOrganizationDefaults).toEqual({
      iosAppStoreIssuerId: true,
      iosAppStoreKeyId: true,
      iosAscKeyId: true,
      appleP8: true,
      appleAscP8: false,
      googleServiceAccount: true,
    });
  });

  it("marks a project-owned credential as not inherited", async () => {
    const ctx = makeCtx([
      {
        _id: "files_own_p8",
        organizationId: "organizations_a",
        projectId: "projects_a",
        purpose: "apple_p8_key",
      },
    ]);
    helperMocks.resolveProjectByIdForCurrentUserFromDb.mockResolvedValue({
      project: { ...BARE_PROJECT, iosAppStoreKeyId: "PRJKEY1234" },
    });
    const status = await getSetupStatus._handler(ctx, {
      projectId: "projects_a" as never,
    });

    expect(status.usingOrganizationDefaults.appleP8).toBe(false);
    expect(status.usingOrganizationDefaults.iosAppStoreKeyId).toBe(false);
    expect(status.usingOrganizationDefaults.iosAppStoreIssuerId).toBe(true);
  });

  it("still reports missing ids when neither level has them", async () => {
    const ctx = makeCtx([], { _id: "organizations_a" });
    const status = await getSetupStatus._handler(ctx, {
      projectId: "projects_a" as never,
    });

    expect(status.ios.configured).toBe(false);
    expect(status.ios.missing).toEqual([
      "iosAppStoreIssuerId",
      "iosAppStoreKeyId",
    ]);
    expect(status.appleP8Uploaded).toBe(false);
    expect(status.usingOrganizationDefaults.iosAppStoreKeyId).toBe(false);
  });

  it("does not inherit another project's credential file", async () => {
    const ctx = makeCtx([
      {
        _id: "files_other",
        organizationId: "organizations_a",
        projectId: "projects_b",
        purpose: "apple_p8_key",
      },
    ]);
    const status = await getSetupStatus._handler(ctx, {
      projectId: "projects_a" as never,
    });

    expect(status.appleP8Uploaded).toBe(false);
  });

  it("returns all-false inheritance flags when the project is unknown", async () => {
    helperMocks.resolveProjectByIdForCurrentUserFromDb.mockResolvedValue(null);
    const ctx = makeCtx([]);
    const status = await getSetupStatus._handler(ctx, {
      projectId: "projects_a" as never,
    });

    expect(status.found).toBe(false);
    expect(status.usingOrganizationDefaults).toEqual({
      iosAppStoreIssuerId: false,
      iosAppStoreKeyId: false,
      iosAscKeyId: false,
      appleP8: false,
      appleAscP8: false,
      googleServiceAccount: false,
    });
  });
});
