import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getAuthUserId: vi.fn() }));

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: authMocks.getAuthUserId,
}));

const storageMocks = vi.hoisted(() => ({
  deleteFileAndStorageIfUnreferenced: vi.fn(),
  deleteStorageIfUnreferenced: vi.fn(),
  isStorageReferenced: vi.fn(),
}));

vi.mock("./storage", () => storageMocks);

import {
  promoteFileToOrganizationDefault as registeredPromote,
  saveFile as registeredSaveFile,
} from "./mutation";
import { testableFunction } from "../test.setup";

const promoteFileToOrganizationDefault = testableFunction(registeredPromote);
const saveFile = testableFunction(registeredSaveFile);

type Row = Record<string, unknown> & { _id: string };

class IndexBuilder {
  predicates: Array<(row: Row) => boolean> = [];

  eq(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] === value);
    return this;
  }

  gt(field: string, value: number): this {
    this.predicates.push((row) => {
      const candidate = row[field];
      return typeof candidate === "number" && candidate > value;
    });
    return this;
  }
}

class FilterBuilder {
  field(name: string): { __field: string } {
    return { __field: name };
  }

  eq(left: { __field: string }, right: unknown): (row: Row) => boolean {
    return (row) => row[left.__field] === right;
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

  filter(build: (q: FilterBuilder) => (row: Row) => boolean): TestQuery {
    return new TestQuery(this.rows.filter(build(new FilterBuilder())));
  }

  async first(): Promise<Row | null> {
    return this.rows[0] ?? null;
  }

  async collect(): Promise<Row[]> {
    return [...this.rows];
  }

  async take(count: number): Promise<Row[]> {
    return this.rows.slice(0, count);
  }
}

const RESERVATION_ID = "fileUploadReservations_a";

function makeCtx(options: { role?: "owner" | "admin" | "member" } = {}) {
  const now = Date.now();
  const tables: Record<string, Row[]> = {
    organizations: [{ _id: "organizations_a" }],
    projects: [{ _id: "projects_a", organizationId: "organizations_a" }],
    organizationMembers: [
      {
        _id: "members_a",
        organizationId: "organizations_a",
        userId: "users_a",
        role: options.role ?? "admin",
      },
    ],
    files: [],
    fileUploadReservations: [
      {
        _id: RESERVATION_ID,
        organizationId: "organizations_a",
        projectId: undefined,
        createdBy: "users_a",
        expiresAt: now + 60_000,
        cleanupExpiresAt: now + 120_000,
        createdAt: now,
      },
    ],
  };
  let insertCount = 0;
  return {
    tables,
    ctx: {
      db: {
        system: { get: vi.fn(async (_t: string, id: string) => ({ _id: id })) },
        get: async (id: string) =>
          Object.values(tables)
            .flat()
            .find((row) => row._id === id) ?? null,
        query: (table: string) => new TestQuery(tables[table] ?? []),
        insert: async (table: string, value: Record<string, unknown>) => {
          insertCount += 1;
          const id = `${table}_new_${insertCount}`;
          (tables[table] ??= []).push({ _id: id, ...value });
          return id;
        },
        patch: async (id: string, value: Record<string, unknown>) => {
          const row = Object.values(tables)
            .flat()
            .find((candidate) => candidate._id === id);
          if (!row) throw new Error(`Unknown row: ${id}`);
          Object.assign(row, value);
        },
        delete: async (id: string) => {
          for (const rows of Object.values(tables)) {
            const index = rows.findIndex((row) => row._id === id);
            if (index >= 0) {
              rows.splice(index, 1);
              return;
            }
          }
        },
      },
    },
  };
}

function orgCredentialArgs() {
  return {
    organizationId: "organizations_a" as never,
    projectId: undefined,
    uploadReservationId: RESERVATION_ID as never,
    storageId: "storage_new" as never,
    fileName: "AuthKey.p8",
    fileType: "application/octet-stream",
    fileSize: 12,
    purpose: "apple_p8_key" as const,
  };
}

describe("organization-level credential files", () => {
  beforeEach(() => {
    authMocks.getAuthUserId.mockReset();
    authMocks.getAuthUserId.mockResolvedValue("users_a");
    storageMocks.isStorageReferenced.mockReset();
    storageMocks.isStorageReferenced.mockResolvedValue(false);
    storageMocks.deleteFileAndStorageIfUnreferenced.mockReset();
    storageMocks.deleteFileAndStorageIfUnreferenced.mockResolvedValue(
      undefined,
    );
    storageMocks.deleteStorageIfUnreferenced.mockReset();
    storageMocks.deleteStorageIfUnreferenced.mockResolvedValue(undefined);
  });

  it("saves a credential with no project as the organization default", async () => {
    const { ctx, tables } = makeCtx();
    const result = await saveFile._handler(ctx, orgCredentialArgs());
    expect(result.success).toBe(true);
    const saved = tables.files.at(-1);
    expect(saved?.projectId).toBeUndefined();
    expect(saved?.purpose).toBe("apple_p8_key");
  });

  it("replaces the previous organization default for that purpose", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push({
      _id: "files_old",
      organizationId: "organizations_a",
      purpose: "apple_p8_key",
      storageId: "storage_old",
    });
    await saveFile._handler(ctx, orgCredentialArgs());
    expect(
      storageMocks.deleteFileAndStorageIfUnreferenced,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ _id: "files_old" }),
    );
  });

  it("keeps a project-owned row when the organization default changes", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push({
      _id: "files_project_owned",
      organizationId: "organizations_a",
      projectId: "projects_a",
      purpose: "apple_p8_key",
    });
    await saveFile._handler(ctx, orgCredentialArgs());
    expect(
      storageMocks.deleteFileAndStorageIfUnreferenced,
    ).not.toHaveBeenCalled();
  });

  it("keeps a different purpose's organization default", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push({
      _id: "files_other_purpose",
      organizationId: "organizations_a",
      purpose: "android_service_account",
    });
    await saveFile._handler(ctx, orgCredentialArgs());
    expect(
      storageMocks.deleteFileAndStorageIfUnreferenced,
    ).not.toHaveBeenCalled();
  });

  it("refuses a credential upload from a member", async () => {
    const { ctx } = makeCtx({ role: "member" });
    const result = await saveFile._handler(ctx, orgCredentialArgs());
    expect(result.success).toBe(false);
    expect(result.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("promotes a project file to the organization default", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push({
      _id: "files_project",
      organizationId: "organizations_a",
      projectId: "projects_a",
      purpose: "apple_p8_key",
    });
    await promoteFileToOrganizationDefault._handler(ctx, {
      fileId: "files_project" as never,
    });
    const promoted = tables.files.find((row) => row._id === "files_project");
    expect(promoted?.projectId).toBeUndefined();
  });

  it("displaces the prior organization default when promoting", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push(
      {
        _id: "files_org_old",
        organizationId: "organizations_a",
        purpose: "apple_p8_key",
      },
      {
        _id: "files_project",
        organizationId: "organizations_a",
        projectId: "projects_a",
        purpose: "apple_p8_key",
      },
    );
    await promoteFileToOrganizationDefault._handler(ctx, {
      fileId: "files_project" as never,
    });
    expect(
      storageMocks.deleteFileAndStorageIfUnreferenced,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ _id: "files_org_old" }),
    );
  });

  it("refuses to promote from a member", async () => {
    const { ctx, tables } = makeCtx({ role: "member" });
    tables.files.push({
      _id: "files_project",
      organizationId: "organizations_a",
      projectId: "projects_a",
      purpose: "apple_p8_key",
    });
    await expect(
      promoteFileToOrganizationDefault._handler(ctx, {
        fileId: "files_project" as never,
      }),
    ).rejects.toThrow();
  });

  it("refuses to promote a non-credential file", async () => {
    const { ctx, tables } = makeCtx();
    tables.files.push({
      _id: "files_screenshot",
      organizationId: "organizations_a",
      projectId: "projects_a",
      purpose: "apple_iap_review_screenshot",
    });
    await expect(
      promoteFileToOrganizationDefault._handler(ctx, {
        fileId: "files_screenshot" as never,
      }),
    ).rejects.toThrow();
  });
});
