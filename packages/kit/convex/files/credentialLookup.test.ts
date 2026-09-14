import { describe, expect, it, vi } from "vitest";

import { getGooglePlayFileByProjectInternal as registeredGooglePlayLookup } from "./internal";
import { testableFunction } from "../test.setup";

const googlePlayLookup = testableFunction(registeredGooglePlayLookup);

type Row = Record<string, unknown> & { _id: string };

class IndexBuilder {
  predicates: Array<(row: Row) => boolean> = [];

  eq(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] === value);
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
}

function makeCtx(files: Row[]) {
  const tables: Record<string, Row[]> = {
    files,
    projects: [{ _id: "projects_a", organizationId: "organizations_a" }],
  };
  return {
    db: {
      get: vi.fn(
        async (id: string) =>
          Object.values(tables)
            .flat()
            .find((row) => row._id === id) ?? null,
      ),
      query: (table: string) => new TestQuery(tables[table] ?? []),
    },
  };
}

const ORG_FILE: Row = {
  _id: "files_org",
  organizationId: "organizations_a",
  purpose: "android_service_account",
};

const OWN_FILE: Row = {
  _id: "files_own",
  organizationId: "organizations_a",
  projectId: "projects_a",
  purpose: "android_service_account",
};

const OTHER_PROJECT_FILE: Row = {
  _id: "files_other",
  organizationId: "organizations_a",
  projectId: "projects_b",
  purpose: "android_service_account",
};

describe("google play service account lookup", () => {
  it("prefers the project's own service account", async () => {
    const ctx = makeCtx([ORG_FILE, OWN_FILE]);
    const file = await googlePlayLookup._handler(ctx, {
      projectId: "projects_a" as never,
    });
    expect(file?._id).toBe("files_own");
  });

  it("falls back to the organization service account", async () => {
    const ctx = makeCtx([ORG_FILE]);
    const file = await googlePlayLookup._handler(ctx, {
      projectId: "projects_a" as never,
    });
    expect(file?._id).toBe("files_org");
  });

  it("never returns another project's service account", async () => {
    const ctx = makeCtx([OTHER_PROJECT_FILE]);
    const file = await googlePlayLookup._handler(ctx, {
      projectId: "projects_a" as never,
    });
    expect(file).toBeNull();
  });

  it("ignores a service account from a different organization", async () => {
    const ctx = makeCtx([
      {
        _id: "files_other_org",
        organizationId: "organizations_b",
        purpose: "android_service_account",
      },
    ]);
    const file = await googlePlayLookup._handler(ctx, {
      projectId: "projects_a" as never,
    });
    expect(file).toBeNull();
  });
});
