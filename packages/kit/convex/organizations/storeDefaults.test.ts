import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getAuthUserId: vi.fn() }));

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: authMocks.getAuthUserId,
}));

import { updateStoreDefaults as registeredUpdateStoreDefaults } from "./mutation";
import { testableFunction } from "../test.setup";

const updateStoreDefaults = testableFunction(registeredUpdateStoreDefaults);

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

  async first(): Promise<Row | null> {
    return this.rows[0] ?? null;
  }
}

function makeCtx(role: "owner" | "admin" | "member") {
  const organization: Row = { _id: "organizations_a" };
  const tables: Record<string, Row[]> = {
    organizations: [organization],
    organizationMembers: [
      {
        _id: "members_a",
        organizationId: "organizations_a",
        userId: "users_a",
        role,
      },
    ],
  };
  return {
    organization,
    ctx: {
      db: {
        get: async (id: string) =>
          Object.values(tables)
            .flat()
            .find((row) => row._id === id) ?? null,
        query: (table: string) => new TestQuery(tables[table] ?? []),
        patch: async (id: string, value: Record<string, unknown>) => {
          const row = Object.values(tables)
            .flat()
            .find((candidate) => candidate._id === id);
          if (!row) throw new Error(`Unknown row: ${id}`);
          Object.assign(row, value);
        },
      },
    },
  };
}

describe("updateStoreDefaults", () => {
  beforeEach(() => {
    authMocks.getAuthUserId.mockReset();
    authMocks.getAuthUserId.mockResolvedValue("users_a");
  });

  it("stores normalized apple defaults for an admin", async () => {
    const { ctx, organization } = makeCtx("admin");
    await updateStoreDefaults._handler(ctx, {
      organizationId: "organizations_a" as never,
      defaultIosAppStoreIssuerId: " 11111111-1111-1111-1111-111111111111 ",
      defaultIosAppStoreKeyId: "abcde12345",
    });
    expect(organization.defaultIosAppStoreIssuerId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(organization.defaultIosAppStoreKeyId).toBe("ABCDE12345");
  });

  it("clears a default on null and on a blank string", async () => {
    const { ctx, organization } = makeCtx("owner");
    organization.defaultIosAscKeyId = "ORGASC1234";
    organization.defaultIosAppStoreKeyId = "ORGKEY1234";
    await updateStoreDefaults._handler(ctx, {
      organizationId: "organizations_a" as never,
      defaultIosAscKeyId: null,
      defaultIosAppStoreKeyId: "   ",
    });
    expect(organization.defaultIosAscKeyId).toBeNull();
    expect(organization.defaultIosAppStoreKeyId).toBeNull();
  });

  it("rejects a malformed issuer id", async () => {
    const { ctx } = makeCtx("admin");
    await expect(
      updateStoreDefaults._handler(ctx, {
        organizationId: "organizations_a" as never,
        defaultIosAppStoreIssuerId: "not-a-uuid",
      }),
    ).rejects.toThrow();
  });

  it("rejects a member", async () => {
    const { ctx } = makeCtx("member");
    await expect(
      updateStoreDefaults._handler(ctx, {
        organizationId: "organizations_a" as never,
        defaultIosAppStoreKeyId: "ABCDE12345",
      }),
    ).rejects.toThrow();
  });

  it("leaves an omitted field untouched", async () => {
    const { ctx, organization } = makeCtx("owner");
    organization.defaultIosAppStoreKeyId = "ORGKEY1234";
    await updateStoreDefaults._handler(ctx, {
      organizationId: "organizations_a" as never,
      defaultIosAscKeyId: "ORGASC1234",
    });
    expect(organization.defaultIosAppStoreKeyId).toBe("ORGKEY1234");
    expect(organization.defaultIosAscKeyId).toBe("ORGASC1234");
  });

  it("rejects an unauthenticated caller", async () => {
    authMocks.getAuthUserId.mockResolvedValue(null);
    const { ctx } = makeCtx("owner");
    await expect(
      updateStoreDefaults._handler(ctx, {
        organizationId: "organizations_a" as never,
        defaultIosAppStoreKeyId: "ABCDE12345",
      }),
    ).rejects.toThrow();
  });
});
