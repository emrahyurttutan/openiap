# Organization-level store credential defaults — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator enter each Apple/Google store credential once per organization and have every project inherit it unless the project sets its own value.

**Architecture:** Four new optional columns on `organizations` hold the Apple ID defaults; a `files` row with no `projectId` is the organization default for its purpose. A pure resolver module applies one rule everywhere — project value first, organization default second, otherwise missing — and every existing read site calls it instead of reading project columns directly.

**Tech Stack:** Convex (queries/mutations/actions, `v` validators), TypeScript, React 19 + React Router, Vitest with hand-rolled fake `ctx` objects (this repo does **not** use `convexTest`), Testing Library for UI.

**Spec:** `docs/superpowers/specs/2026-09-14-org-store-credential-defaults-design.md`

## Global Constraints

- All work happens in `packages/kit`. Run commands from that directory.
- Test command: `bun run test` (Vitest). Single file: `bunx vitest run <path>`.
- Lint gate before any commit: `bun run lint` (runs `tsc --noEmit`, `convex typecheck`, ESLint).
- Convex tests use `testableFunction` from `convex/test.setup.ts` plus hand-rolled `TestDb`/`TestQuery` fakes. Copy that pattern; do not introduce `convex-test`.
- New organization columns are `v.optional(v.union(v.string(), v.null()))` so `ctx.db.patch` can clear them. Convex treats `undefined` in a patch as "leave unchanged".
- Apple Issuer ID format: UUID, case-insensitive, stored trimmed. Apple Key ID format: exactly 10 characters of `[A-Z0-9]`, stored upper-cased.
- A `files` row is organization-level when `projectId === undefined`. At most one such row per `purpose` per organization.
- Never let a project resolve a credential file owned by a *different* project.
- Git commits end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- The repo pre-commit hook runs a full SDK parity audit and takes ~60s. Expect it on every commit.

---

### Task 1: Shared credential validation + organization columns

Moves the Apple ID normalizers out of `projects/mutation.ts` into a shared module so the organization and project inputs cannot drift, and adds the four organization columns.

**Files:**
- Create: `packages/kit/convex/projects/storeCredentialValidation.ts`
- Create: `packages/kit/convex/projects/storeCredentialValidation.test.ts`
- Modify: `packages/kit/convex/schema.ts` (organizations table, after `pendingDeletion`)
- Modify: `packages/kit/convex/projects/mutation.ts:96-135` (delete the two local functions, import them instead)

**Interfaces:**
- Consumes: `createError`, `ErrorCode` from `convex/utils/errors`
- Produces:
  - `normalizeAppStoreIssuerId(input: string): string`
  - `normalizeAppStoreKeyId(input: string): string`
  - `normalizeOptionalAppStoreIssuerId(input: string | null): string | null`
  - `normalizeOptionalAppStoreKeyId(input: string | null): string | null`
  - Organization columns `defaultIosAppStoreIssuerId`, `defaultIosAppStoreKeyId`, `defaultIosAscIssuerId`, `defaultIosAscKeyId`

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/projects/storeCredentialValidation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/projects/storeCredentialValidation.test.ts`
Expected: FAIL — cannot resolve `./storeCredentialValidation`.

- [ ] **Step 3: Create the shared module**

Create `packages/kit/convex/projects/storeCredentialValidation.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run convex/projects/storeCredentialValidation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Point `projects/mutation.ts` at the shared module**

Delete the local `normalizeAppStoreIssuerId` and `normalizeAppStoreKeyId` function bodies (currently at `convex/projects/mutation.ts:96-135`) and add to the import block at the top of the file:

```ts
import {
  normalizeAppStoreIssuerId,
  normalizeAppStoreKeyId,
} from "./storeCredentialValidation";
```

Leave every call site (`convex/projects/mutation.ts:379-390`) unchanged.

- [ ] **Step 6: Add the organization columns**

In `packages/kit/convex/schema.ts`, inside `organizations: defineTable({ ... })`, immediately before `pendingDeletion: v.optional(v.boolean()),`:

```ts
    // Store API credentials issued per *developer account*, not per app:
    // Apple gives a team one Issuer ID and per-key 10-char Key IDs, and
    // Google gives one service account. A project inherits each of these
    // whenever its own column is blank, so an operator running several
    // apps under one account enters them once. Widened to accept `null`
    // so `ctx.db.patch({ ...: null })` can clear one — Convex treats
    // `undefined` in a patch as "leave unchanged".
    // The Google service account has no ID columns; it is a `files` row
    // with no `projectId` (see convex/projects/storeCredentials.ts).
    defaultIosAppStoreIssuerId: v.optional(v.union(v.string(), v.null())),
    defaultIosAppStoreKeyId: v.optional(v.union(v.string(), v.null())),
    defaultIosAscIssuerId: v.optional(v.union(v.string(), v.null())),
    defaultIosAscKeyId: v.optional(v.union(v.string(), v.null())),
```

- [ ] **Step 7: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS. The suite is large; allow several minutes.

- [ ] **Step 8: Commit**

```bash
git add convex/schema.ts convex/projects/storeCredentialValidation.ts \
  convex/projects/storeCredentialValidation.test.ts convex/projects/mutation.ts
git commit -m "$(cat <<'EOF'
feat(kit): add organization store credential columns

Apple issues one Issuer ID and key set per developer account, so the four
new organization columns hold defaults that projects will inherit. Moves
the Apple ID normalizers into a shared module so the organization and
project inputs validate identically.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure resolver module

The single place that decides "project value or organization default".

**Files:**
- Create: `packages/kit/convex/projects/storeCredentials.ts`
- Create: `packages/kit/convex/projects/storeCredentials.test.ts`

**Interfaces:**
- Consumes: `internalQuery` from `../_generated/server`, `v` from `convex/values`, Task 1's organization columns.
- Produces:
  - `type CredentialSource = "project" | "organization"`
  - `type ProjectAppleCredentialFields`
  - `type OrganizationStoreDefaults`
  - `type ResolvedAppleIds`
  - `resolveAppleCredentialIds(project, organization): ResolvedAppleIds`
  - `pickCredentialFile<T>(files: T[], projectId): T | undefined`
  - `getOrganizationStoreDefaults` internal query at `internal.projects.storeCredentials.getOrganizationStoreDefaults`

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/projects/storeCredentials.test.ts`:

```ts
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
      {},
      { ...ORG_DEFAULTS, defaultIosAscKeyId: null },
    );
    expect(resolved.ascKeyId).toBeUndefined();
  });
});

describe("pickCredentialFile", () => {
  const ownFile = { _id: "files_own", projectId: "projects_a" };
  const orgFile = { _id: "files_org", projectId: undefined };
  const otherFile = { _id: "files_other", projectId: "projects_b" };

  it("prefers the project's own file", () => {
    expect(
      pickCredentialFile([orgFile, otherFile, ownFile], "projects_a"),
    ).toBe(ownFile);
  });

  it("falls back to the organization file", () => {
    expect(pickCredentialFile([otherFile, orgFile], "projects_a")).toBe(
      orgFile,
    );
  });

  it("never returns another project's file", () => {
    expect(pickCredentialFile([otherFile], "projects_a")).toBeUndefined();
  });

  it("returns the organization file when no project is given", () => {
    expect(pickCredentialFile([otherFile, orgFile], undefined)).toBe(orgFile);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/projects/storeCredentials.test.ts`
Expected: FAIL — cannot resolve `./storeCredentials`.

- [ ] **Step 3: Write the module**

Create `packages/kit/convex/projects/storeCredentials.ts`:

```ts
import { v } from "convex/values";

import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// One rule, applied everywhere a store credential is read:
//   1. the project's own value, when set and non-blank
//   2. the organization default
//   3. not configured
//
// Apple and Google issue these per developer account, so the organization
// level is the natural home and a project column is an override for the
// uncommon case of a second account.

export type CredentialSource = "project" | "organization";

/** The Apple columns on `projects` this resolver reads. */
export type ProjectAppleCredentialFields = {
  iosAppStoreIssuerId?: string;
  iosAppStoreKeyId?: string;
  iosAscIssuerId?: string;
  iosAscKeyId?: string;
};

/** The Apple default columns on `organizations` this resolver reads. */
export type OrganizationStoreDefaults = {
  defaultIosAppStoreIssuerId?: string | null;
  defaultIosAppStoreKeyId?: string | null;
  defaultIosAscIssuerId?: string | null;
  defaultIosAscKeyId?: string | null;
};

export type ResolvedAppleIdField =
  | "issuerId"
  | "keyId"
  | "ascIssuerId"
  | "ascKeyId";

export type ResolvedAppleIds = {
  issuerId?: string;
  keyId?: string;
  ascIssuerId?: string;
  ascKeyId?: string;
  sources: Partial<Record<ResolvedAppleIdField, CredentialSource>>;
};

/**
 * Blank and whitespace-only values count as unset so a stray space typed
 * into a project field cannot shadow a valid organization default.
 */
function firstConfigured(
  projectValue: string | undefined,
  organizationValue: string | null | undefined,
): { value?: string; source?: CredentialSource } {
  const own = projectValue?.trim();
  if (own) return { value: own, source: "project" };
  const inherited = organizationValue?.trim();
  if (inherited) return { value: inherited, source: "organization" };
  return {};
}

export function resolveAppleCredentialIds(
  project: ProjectAppleCredentialFields,
  organization: OrganizationStoreDefaults | null | undefined,
): ResolvedAppleIds {
  const issuer = firstConfigured(
    project.iosAppStoreIssuerId,
    organization?.defaultIosAppStoreIssuerId,
  );
  const key = firstConfigured(
    project.iosAppStoreKeyId,
    organization?.defaultIosAppStoreKeyId,
  );
  const ascIssuer = firstConfigured(
    project.iosAscIssuerId,
    organization?.defaultIosAscIssuerId,
  );
  const ascKey = firstConfigured(
    project.iosAscKeyId,
    organization?.defaultIosAscKeyId,
  );

  const sources: Partial<Record<ResolvedAppleIdField, CredentialSource>> = {};
  if (issuer.source) sources.issuerId = issuer.source;
  if (key.source) sources.keyId = key.source;
  if (ascIssuer.source) sources.ascIssuerId = ascIssuer.source;
  if (ascKey.source) sources.ascKeyId = ascKey.source;

  return {
    issuerId: issuer.value,
    keyId: key.value,
    ascIssuerId: ascIssuer.value,
    ascKeyId: ascKey.value,
    sources,
  };
}

/**
 * Choose the credential file a project should use: its own row first, then
 * the organization-level row (`projectId === undefined`).
 *
 * A row owned by a *different* project is never returned. An earlier version
 * of `getAppleP8Key` fell back to `files[0]`, which silently signed one
 * project's receipts with another project's key.
 */
export function pickCredentialFile<
  T extends { projectId?: Id<"projects"> | undefined },
>(files: T[], projectId: Id<"projects"> | undefined): T | undefined {
  const own = projectId
    ? files.find((file) => file.projectId === projectId)
    : undefined;
  return own ?? files.find((file) => file.projectId === undefined);
}

/**
 * Action callers hold a project document but not its organization. This is
 * the one extra round trip they need to apply `resolveAppleCredentialIds`.
 */
export const getOrganizationStoreDefaults = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.object({
      defaultIosAppStoreIssuerId: v.optional(
        v.union(v.string(), v.null()),
      ),
      defaultIosAppStoreKeyId: v.optional(v.union(v.string(), v.null())),
      defaultIosAscIssuerId: v.optional(v.union(v.string(), v.null())),
      defaultIosAscKeyId: v.optional(v.union(v.string(), v.null())),
    }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<OrganizationStoreDefaults | null> => {
    const organization = await ctx.db.get(args.organizationId);
    if (!organization) return null;
    return {
      defaultIosAppStoreIssuerId: organization.defaultIosAppStoreIssuerId,
      defaultIosAppStoreKeyId: organization.defaultIosAppStoreKeyId,
      defaultIosAscIssuerId: organization.defaultIosAscIssuerId,
      defaultIosAscKeyId: organization.defaultIosAscKeyId,
    };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run convex/projects/storeCredentials.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the lint gate**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/projects/storeCredentials.ts convex/projects/storeCredentials.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): add store credential resolver

One rule for every read site: the project's own value, then the
organization default, then not configured. pickCredentialFile refuses to
return a file owned by a different project.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Credential file lookup falls back to the organization

Replaces the cross-project borrowing in the Apple loaders and gives Google the same organization fallback.

**Files:**
- Modify: `packages/kit/convex/files/internal.ts:317-428` (`getGooglePlayFileByProjectInternal`, `getAppleP8Key`, `getAppleAscApiKey`)
- Create: `packages/kit/convex/files/credentialLookup.test.ts`

**Interfaces:**
- Consumes: `pickCredentialFile` from `../projects/storeCredentials` (Task 2)
- Produces: no signature changes. `getGooglePlayFileByProjectInternal({ projectId })`, `getAppleP8Key({ organizationId, projectId? })` and `getAppleAscApiKey({ organizationId, projectId? })` keep their existing arguments so their five call sites stay untouched.

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/files/credentialLookup.test.ts`:

```ts
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

class TestQuery {
  constructor(private readonly rows: Row[]) {}

  withIndex(_name: string, build: (q: IndexBuilder) => IndexBuilder): TestQuery {
    const builder = build(new IndexBuilder());
    return new TestQuery(
      this.rows.filter((row) =>
        builder.predicates.every((predicate) => predicate(row)),
      ),
    );
  }

  filter(build: (q: FilterBuilder) => (row: Row) => boolean): TestQuery {
    const predicate = build(new FilterBuilder());
    return new TestQuery(this.rows.filter(predicate));
  }

  async first(): Promise<Row | null> {
    return this.rows[0] ?? null;
  }

  async collect(): Promise<Row[]> {
    return [...this.rows];
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/files/credentialLookup.test.ts`
Expected: FAIL — "falls back to the organization service account" returns `null` because the current implementation only reads the `by_project` index.

- [ ] **Step 3: Add the organization fallback to the Google lookup**

In `packages/kit/convex/files/internal.ts`, add to the import block at the top:

```ts
import { pickCredentialFile } from "../projects/storeCredentials";
```

Replace the whole `getGooglePlayFileByProjectInternal` definition (and the comment block above it) with:

```ts
// Internal query to get the Google Play service account file for a project.
//
// The project's own row wins and is read through the `by_project` index, so
// the common case stays a narrow indexed lookup. Only when the project has
// no row of its own do we scan the organization's rows for that purpose —
// bounded by the number of projects — to find the organization-level default
// (a row with no `projectId`). A row owned by a different project is never
// returned.
export const getGooglePlayFileByProjectInternal = internalQuery({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const projectFile = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .filter((q) => q.eq(q.field("purpose"), "android_service_account"))
      .first();
    if (projectFile) return projectFile;

    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const organizationFiles = await ctx.db
      .query("files")
      .withIndex("by_org_and_purpose", (q) =>
        q
          .eq("organizationId", project.organizationId)
          .eq("purpose", "android_service_account"),
      )
      .collect();

    return pickCredentialFile(organizationFiles, undefined) ?? null;
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run convex/files/credentialLookup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Remove cross-project borrowing from the Apple loaders**

In `getAppleP8Key`, replace the selection block:

```ts
    // Filter by project if specified
    let targetFile = files[0];
    if (args.projectId) {
      const projectFiles = files.filter(
        (f: any) => f.projectId === args.projectId,
      );
      targetFile = projectFiles[0] || files[0];
    }
```

with:

```ts
    // The project's own key first, then the organization default. Never
    // another project's key: the previous `files[0]` fallback silently
    // signed one project's requests with a different project's credential.
    const targetFile = pickCredentialFile(files, args.projectId);
```

In `getAppleAscApiKey`, replace:

```ts
    let targetFile = files[0];
    if (args.projectId) {
      const projectFiles = files.filter(
        (f: FilePublicProjection) => f.projectId === args.projectId,
      );
      targetFile = projectFiles[0] || files[0];
    }
```

with:

```ts
    const targetFile = pickCredentialFile(files, args.projectId);
```

Leave both `if (!targetFile) throw ...` blocks exactly as they are — the ASC one's message text is matched by a string comparison in `convex/products/asc.ts:262`, so it must not change.

- [ ] **Step 6: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/files/internal.ts convex/files/credentialLookup.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): resolve credential files from the organization

The Apple loaders fell back to files[0], an arbitrary other project's .p8,
while Google had no fallback at all. All three now read the project's own
row first and the organization-level row second, and none of them can
return a file owned by a different project.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `updateStoreDefaults` mutation

Lets an owner or admin write the four organization columns.

**Files:**
- Modify: `packages/kit/convex/organizations/mutation.ts` (append after `updateOrganization`)
- Create: `packages/kit/convex/organizations/storeDefaults.test.ts`

**Interfaces:**
- Consumes: Task 1's `normalizeOptionalAppStoreIssuerId`, `normalizeOptionalAppStoreKeyId`; `createError`, `ErrorCode`.
- Produces: `api.organizations.mutation.updateStoreDefaults({ organizationId, defaultIosAppStoreIssuerId?, defaultIosAppStoreKeyId?, defaultIosAscIssuerId?, defaultIosAscKeyId? })`, each optional field `v.union(v.string(), v.null())`.

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/organizations/storeDefaults.test.ts`:

```ts
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

  withIndex(_name: string, build: (q: IndexBuilder) => IndexBuilder): TestQuery {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/organizations/storeDefaults.test.ts`
Expected: FAIL — `updateStoreDefaults` is not exported from `./mutation`.

- [ ] **Step 3: Write the mutation**

In `packages/kit/convex/organizations/mutation.ts`, add to the import block:

```ts
import {
  normalizeOptionalAppStoreIssuerId,
  normalizeOptionalAppStoreKeyId,
} from "../projects/storeCredentialValidation";
```

Append immediately after the `updateOrganization` mutation:

```ts
// Apple issues one Issuer ID per team and one key set per developer
// account, so these live on the organization and every project inherits
// them unless it sets its own column. Passing `null` — or a blank string
// from a cleared input — removes the default.
export const updateStoreDefaults = mutation({
  args: {
    organizationId: v.id("organizations"),
    defaultIosAppStoreIssuerId: v.optional(v.union(v.string(), v.null())),
    defaultIosAppStoreKeyId: v.optional(v.union(v.string(), v.null())),
    defaultIosAscIssuerId: v.optional(v.union(v.string(), v.null())),
    defaultIosAscKeyId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw createError(ErrorCode.NOT_AUTHENTICATED);
    }

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId),
      )
      .first();

    if (
      !membership ||
      (membership.role !== "owner" && membership.role !== "admin")
    ) {
      throw createError(ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const organization = await ctx.db.get(args.organizationId);
    if (!organization || organization.pendingDeletion) {
      throw createError(ErrorCode.ORGANIZATION_NOT_FOUND);
    }

    const updates: Record<string, unknown> = { updatedAt: Date.now() };

    if (args.defaultIosAppStoreIssuerId !== undefined) {
      updates.defaultIosAppStoreIssuerId = normalizeOptionalAppStoreIssuerId(
        args.defaultIosAppStoreIssuerId,
      );
    }
    if (args.defaultIosAppStoreKeyId !== undefined) {
      updates.defaultIosAppStoreKeyId = normalizeOptionalAppStoreKeyId(
        args.defaultIosAppStoreKeyId,
      );
    }
    if (args.defaultIosAscIssuerId !== undefined) {
      updates.defaultIosAscIssuerId = normalizeOptionalAppStoreIssuerId(
        args.defaultIosAscIssuerId,
      );
    }
    if (args.defaultIosAscKeyId !== undefined) {
      updates.defaultIosAscKeyId = normalizeOptionalAppStoreKeyId(
        args.defaultIosAscKeyId,
      );
    }

    await ctx.db.patch(args.organizationId, updates);
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run convex/organizations/storeDefaults.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the lint gate**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/organizations/mutation.ts convex/organizations/storeDefaults.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): add updateStoreDefaults mutation

Owners and admins can set the organization's Apple Issuer ID and Key IDs
once. Null or a blank string clears a default; an omitted field is left
alone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Read sites use the resolver

Receipt verification, push-sync and the Apple webhook gate stop reading project columns directly.

**Files:**
- Modify: `packages/kit/convex/purchases/ios.ts:299-345` (`getAppStoreServerCredentials`)
- Modify: `packages/kit/convex/products/asc.ts:186-285` (`resolveAscCredentials`)
- Modify: `packages/kit/convex/webhooks/apple.ts:65-76` (the inlined `IOS_NOT_CONFIGURED` gate)

**Interfaces:**
- Consumes: `resolveAppleCredentialIds` and `internal.projects.storeCredentials.getOrganizationStoreDefaults` (Task 2).
- Produces: no new exports. Behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `packages/kit/convex/projects/storeCredentials.test.ts`:

```ts
describe("resolved ids drive the ASC pair rule", () => {
  // Mirrors the pair-resolution rule in convex/products/asc.ts: when an ASC
  // key id resolves, sign with the ASC pair and let its issuer fall back to
  // the shared App Store issuer. Locked here so inheritance cannot change it.
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
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `bunx vitest run convex/projects/storeCredentials.test.ts`
Expected: PASS. These lock the contract the three call sites must preserve; they exercise the Task 2 resolver, so they pass before the edits below and must still pass after.

- [ ] **Step 3: Update the receipt verifier**

In `packages/kit/convex/purchases/ios.ts`, add to the import block:

```ts
import { resolveAppleCredentialIds } from "../projects/storeCredentials";
```

Inside `getAppStoreServerCredentials`, replace the opening of the handler:

```ts
  const missingFields: AppStoreServerCredentialField[] = [];

  if (!project.iosAppStoreIssuerId) {
    missingFields.push("issuerId");
  }

  if (!project.iosAppStoreKeyId) {
    missingFields.push("keyId");
  }
```

with:

```ts
  const missingFields: AppStoreServerCredentialField[] = [];

  // Issuer and key ids may live on the organization: Apple issues them per
  // developer account, so a project that leaves them blank inherits them.
  const organizationDefaults = await ctx.runQuery(
    internal.projects.storeCredentials.getOrganizationStoreDefaults,
    { organizationId: project.organizationId },
  );
  const resolved = resolveAppleCredentialIds(project, organizationDefaults);

  if (!resolved.issuerId) {
    missingFields.push("issuerId");
  }

  if (!resolved.keyId) {
    missingFields.push("keyId");
  }
```

and replace the return statement's two non-null assertions:

```ts
  return {
    issuerId: project.iosAppStoreIssuerId!,
    keyId: project.iosAppStoreKeyId!,
    privateKey,
  };
```

with:

```ts
  return {
    issuerId: resolved.issuerId!,
    keyId: resolved.keyId!,
    privateKey,
  };
```

- [ ] **Step 4: Update push-sync**

In `packages/kit/convex/products/asc.ts`, add to the import block:

```ts
import { resolveAppleCredentialIds } from "../projects/storeCredentials";
```

Inside `resolveAscCredentials`, replace the three lines that read the project columns:

```ts
  const useAsc = !!project.iosAscKeyId;
  const issuerId = useAsc
    ? (project.iosAscIssuerId ?? project.iosAppStoreIssuerId)
    : project.iosAppStoreIssuerId;
  const keyId = useAsc ? project.iosAscKeyId : project.iosAppStoreKeyId;
```

with:

```ts
  // Each id resolves from the project when set and from the organization
  // default otherwise; the pair-resolution rule documented above is then
  // applied to the resolved values, unchanged.
  const organizationDefaults = await ctx.runQuery(
    internal.projects.storeCredentials.getOrganizationStoreDefaults,
    { organizationId: project.organizationId },
  );
  const resolved = resolveAppleCredentialIds(project, organizationDefaults);
  const useAsc = !!resolved.ascKeyId;
  const issuerId = useAsc
    ? (resolved.ascIssuerId ?? resolved.issuerId)
    : resolved.issuerId;
  const keyId = useAsc ? resolved.ascKeyId : resolved.keyId;
```

Leave the long explanatory comment above these lines and everything after them unchanged.

- [ ] **Step 5: Update the Apple webhook gate**

In `packages/kit/convex/webhooks/apple.ts`, add to the import block:

```ts
import { resolveAppleCredentialIds } from "../projects/storeCredentials";
```

Replace:

```ts
    const iosMissing: string[] = [];
    if (!project.iosBundleId) iosMissing.push("iosBundleId");
    if (!project.iosAppAppleId) iosMissing.push("iosAppAppleId");
    if (!project.iosAppStoreIssuerId) iosMissing.push("iosAppStoreIssuerId");
    if (!project.iosAppStoreKeyId) iosMissing.push("iosAppStoreKeyId");
```

with:

```ts
    const organizationDefaults = await ctx.runQuery(
      internal.projects.storeCredentials.getOrganizationStoreDefaults,
      { organizationId: project.organizationId },
    );
    const resolvedApple = resolveAppleCredentialIds(
      project,
      organizationDefaults,
    );
    const iosMissing: string[] = [];
    if (!project.iosBundleId) iosMissing.push("iosBundleId");
    if (!project.iosAppAppleId) iosMissing.push("iosAppAppleId");
    if (!resolvedApple.issuerId) iosMissing.push("iosAppStoreIssuerId");
    if (!resolvedApple.keyId) iosMissing.push("iosAppStoreKeyId");
```

The missing-field *names* stay as they are: they name the project field an operator would fill in, and the SDKs match on those strings.

- [ ] **Step 6: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS. If `internal` is not already imported in any of the three files, add `import { internal } from "../_generated/api";`.

- [ ] **Step 7: Commit**

```bash
git add convex/purchases/ios.ts convex/products/asc.ts convex/webhooks/apple.ts \
  convex/projects/storeCredentials.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): resolve apple ids through the organization at every read site

Receipt verification, push-sync and the Apple ASN gate now read resolved
ids instead of project columns, so a project with blank fields inherits
the organization default. The ASC pair-resolution rule is unchanged and
is locked by tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `getSetupStatus` reports inheritance

Without this a correctly configured project reports "missing" and the dashboard, SDK and MCP tools all mislead the operator.

**Files:**
- Modify: `packages/kit/convex/projects/setupStatus.ts` (whole handler)
- Create: `packages/kit/convex/projects/setupStatus.test.ts`

**Interfaces:**
- Consumes: `resolveAppleCredentialIds`, `pickCredentialFile` (Task 2).
- Produces: `getSetupStatus` response gains `usingOrganizationDefaults: { iosAppStoreIssuerId, iosAppStoreKeyId, iosAscKeyId, appleP8, appleAscP8, googleServiceAccount }`, all booleans.

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/projects/setupStatus.test.ts`:

```ts
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

  withIndex(_name: string, build: (q: IndexBuilder) => IndexBuilder): TestQuery {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/projects/setupStatus.test.ts`
Expected: FAIL — `usingOrganizationDefaults` is undefined and `ios.configured` is false.

- [ ] **Step 3: Rewrite the handler**

In `packages/kit/convex/projects/setupStatus.ts`, add to the imports:

```ts
import {
  pickCredentialFile,
  resolveAppleCredentialIds,
} from "./storeCredentials";
```

Add to the `returns` object, after `googleServiceAccountUploaded`:

```ts
    // Which credentials this project takes from its organization. The
    // dashboard setup card and the MCP `troubleshoot` tool use this to say
    // "inherited" instead of implying the project was configured directly.
    usingOrganizationDefaults: v.object({
      iosAppStoreIssuerId: v.boolean(),
      iosAppStoreKeyId: v.boolean(),
      iosAscKeyId: v.boolean(),
      appleP8: v.boolean(),
      appleAscP8: v.boolean(),
      googleServiceAccount: v.boolean(),
    }),
```

In the `if (!project)` early return, add:

```ts
        usingOrganizationDefaults: {
          iosAppStoreIssuerId: false,
          iosAppStoreKeyId: false,
          iosAscKeyId: false,
          appleP8: false,
          appleAscP8: false,
          googleServiceAccount: false,
        },
```

Replace the project-file read and the iOS missing block:

```ts
    const projectFiles = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();

    const iosMissing: string[] = [];
    if (!project.iosBundleId) iosMissing.push("iosBundleId");
    if (!project.iosAppAppleId) iosMissing.push("iosAppAppleId");
    if (!project.iosAppStoreIssuerId) iosMissing.push("iosAppStoreIssuerId");
    if (!project.iosAppStoreKeyId) iosMissing.push("iosAppStoreKeyId");
```

with:

```ts
    // Read every credential file in the organization, not just the
    // project's own rows: a project with no files of its own inherits the
    // organization-level ones, and reporting those as "missing" would send
    // a correctly configured operator hunting for a non-existent problem.
    const organizationFiles = await ctx.db
      .query("files")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", project.organizationId),
      )
      .collect();

    const filesForPurpose = (purpose: string) =>
      pickCredentialFile(
        organizationFiles.filter((file) => file.purpose === purpose),
        project._id,
      );

    const appleP8File = filesForPurpose("apple_p8_key");
    const appleAscFile = filesForPurpose("apple_p8_asc_api_key");
    const googleServiceAccountFile = filesForPurpose(
      "android_service_account",
    );

    const organization = await ctx.db.get(project.organizationId);
    const resolvedApple = resolveAppleCredentialIds(project, organization);

    const iosMissing: string[] = [];
    if (!project.iosBundleId) iosMissing.push("iosBundleId");
    if (!project.iosAppAppleId) iosMissing.push("iosAppAppleId");
    if (!resolvedApple.issuerId) iosMissing.push("iosAppStoreIssuerId");
    if (!resolvedApple.keyId) iosMissing.push("iosAppStoreKeyId");
```

Replace the two upload flags at the end of the return with:

```ts
      appleP8Uploaded: !!appleP8File || !!appleAscFile,
      googleServiceAccountUploaded: !!googleServiceAccountFile,
      usingOrganizationDefaults: {
        iosAppStoreIssuerId: resolvedApple.sources.issuerId === "organization",
        iosAppStoreKeyId: resolvedApple.sources.keyId === "organization",
        iosAscKeyId: resolvedApple.sources.ascKeyId === "organization",
        appleP8: appleP8File?.projectId === undefined && !!appleP8File,
        appleAscP8: appleAscFile?.projectId === undefined && !!appleAscFile,
        googleServiceAccount:
          googleServiceAccountFile?.projectId === undefined &&
          !!googleServiceAccountFile,
      },
```

Delete the now-unused `projectFiles` variable and the old comment block above the two flags.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run convex/projects/setupStatus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/projects/setupStatus.ts convex/projects/setupStatus.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): report inherited credentials in setup status

A project configured entirely from organization defaults now reports
configured, with usingOrganizationDefaults naming which credentials it
inherits. Without this the dashboard, SDK and MCP tools all report a
working project as missing its keys.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Organization-level credential uploads

Makes `saveFile` accept an organization-level credential, keep one row per purpose, require admin, and adds the promote action that migrates an existing project file.

**Files:**
- Modify: `packages/kit/convex/files/mutation.ts:153-178` (role guard), `:232-247` (single-slot replacement), append `promoteFileToOrganizationDefault`
- Create: `packages/kit/convex/files/organizationCredentials.test.ts`

**Interfaces:**
- Consumes: `deleteFileAndStorageIfUnreferenced` from `./storage`, `getOrganizationById`/`getProjectById` from `../projects/helpers` (both already imported).
- Produces: `api.files.mutation.promoteFileToOrganizationDefault({ fileId })` returning `{ success: true }`.

- [ ] **Step 1: Write the failing test**

Create `packages/kit/convex/files/organizationCredentials.test.ts`:

```ts
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
    this.predicates.push(
      (row) => typeof row[field] === "number" && (row[field] as number) > value,
    );
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

  withIndex(_name: string, build: (q: IndexBuilder) => IndexBuilder): TestQuery {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run convex/files/organizationCredentials.test.ts`
Expected: FAIL — `promoteFileToOrganizationDefault` is not exported; the member and replacement cases also fail.

- [ ] **Step 3: Add a shared purpose list and widen the role guard**

In `packages/kit/convex/files/mutation.ts`, add below `MAX_ACTIVE_FILE_UPLOAD_RESERVATIONS_PER_TARGET`:

```ts
// Store signing credentials. A member must not be able to replace one: at
// project level it would redirect receipt verification, and an
// organization-level row is inherited by every project that has no file of
// its own.
const CREDENTIAL_PURPOSES = [
  "apple_p8_key",
  "apple_p8_asc_api_key",
  "android_service_account",
] as const;

type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

function isCredentialPurpose(purpose: string): purpose is CredentialPurpose {
  return (CREDENTIAL_PURPOSES as readonly string[]).includes(purpose);
}
```

Replace the existing screenshot-only role guard:

```ts
    if (
      args.purpose === "apple_iap_review_screenshot" &&
      membership.role === "member"
    ) {
```

with:

```ts
    if (
      (args.purpose === "apple_iap_review_screenshot" ||
        isCredentialPurpose(args.purpose)) &&
      membership.role === "member"
    ) {
```

- [ ] **Step 4: Make the organization slot single-occupancy**

Replace the `screenshotsToReplace` block:

```ts
    const screenshotsToReplace =
      args.purpose === "apple_iap_review_screenshot" && args.projectId
        ? await ctx.db
            .query("files")
            .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
            .filter((q) =>
              q.eq(q.field("purpose"), "apple_iap_review_screenshot"),
            )
            .collect()
        : [];
```

with:

```ts
    const screenshotsToReplace =
      args.purpose === "apple_iap_review_screenshot" && args.projectId
        ? await ctx.db
            .query("files")
            .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
            .filter((q) =>
              q.eq(q.field("purpose"), "apple_iap_review_screenshot"),
            )
            .collect()
        : [];

    // An organization holds at most one credential row per purpose, the
    // same single-slot rule the screenshot uses. Reading the indexed range
    // before the insert makes concurrent uploads conflict under Convex OCC;
    // after the retry the later save replaces the earlier row and reclaims
    // its blob.
    const organizationDefaultsToReplace =
      !args.projectId && isCredentialPurpose(args.purpose)
        ? (
            await ctx.db
              .query("files")
              .withIndex("by_org_and_purpose", (q) =>
                q
                  .eq("organizationId", args.organizationId)
                  .eq("purpose", args.purpose),
              )
              .collect()
          ).filter((file) => file.projectId === undefined)
        : [];
```

and extend the replacement loop after the insert:

```ts
    for (const priorScreenshot of screenshotsToReplace) {
      await deleteFileAndStorageIfUnreferenced(ctx, priorScreenshot);
    }
```

to:

```ts
    for (const priorScreenshot of screenshotsToReplace) {
      await deleteFileAndStorageIfUnreferenced(ctx, priorScreenshot);
    }

    for (const priorDefault of organizationDefaultsToReplace) {
      await deleteFileAndStorageIfUnreferenced(ctx, priorDefault);
    }
```

- [ ] **Step 5: Add the promote mutation**

Append to `packages/kit/convex/files/mutation.ts`:

```ts
/**
 * Move a project's credential file up to the organization so every other
 * project inherits it. This is the one-click migration for operators who
 * relied on the removed "borrow another project's .p8" fallback.
 */
export const promoteFileToOrganizationDefault = mutation({
  args: {
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new ConvexError("Not authenticated");
    }

    const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new ConvexError("File not found");
    }

    if (!isCredentialPurpose(file.purpose)) {
      throw new ConvexError(
        "Only store credential files can become an organization default",
      );
    }

    const organization = await getOrganizationById(ctx, file.organizationId);
    if (!organization) {
      throw new ConvexError("File not found");
    }

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", file.organizationId).eq("userId", userId),
      )
      .first();

    if (!membership || membership.role === "member") {
      throw new ConvexError("Insufficient permissions");
    }

    if (file.projectId === undefined) {
      return { success: true as const };
    }

    // Read the indexed range before patching so a concurrent promote or
    // upload conflicts under Convex OCC instead of leaving two rows in the
    // organization's single slot for this purpose.
    const existingDefaults = (
      await ctx.db
        .query("files")
        .withIndex("by_org_and_purpose", (q) =>
          q
            .eq("organizationId", file.organizationId)
            .eq("purpose", file.purpose),
        )
        .collect()
    ).filter(
      (candidate) =>
        candidate.projectId === undefined && candidate._id !== file._id,
    );

    await ctx.db.patch(file._id, {
      projectId: undefined,
      updatedAt: Date.now(),
    });

    for (const priorDefault of existingDefaults) {
      await deleteFileAndStorageIfUnreferenced(ctx, priorDefault);
    }

    return { success: true as const };
  },
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bunx vitest run convex/files/organizationCredentials.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS. `convex/projects/project-child-pending-deletion.test.ts` uses an `admin` membership for its credential saves, so the widened role guard does not break it.

- [ ] **Step 8: Commit**

```bash
git add convex/files/mutation.ts convex/files/organizationCredentials.test.ts
git commit -m "$(cat <<'EOF'
feat(kit): store credential files at the organization level

saveFile now keeps one credential row per purpose per organization and
requires owner or admin for every credential purpose, not just review
screenshots. promoteFileToOrganizationDefault migrates a project's
existing file into that slot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Shared upload helper and the organization settings section

Where the operator actually enters the credentials once.

**Files:**
- Create: `packages/kit/src/pages/auth/organization/storeCredentialUpload.ts`
- Create: `packages/kit/src/pages/auth/organization/StoreCredentialsCard.tsx`
- Create: `packages/kit/src/pages/auth/organization/StoreCredentialsCard.test.tsx`
- Modify: `packages/kit/src/pages/auth/organization/settings.tsx` (render the card)

**Interfaces:**
- Consumes: `api.files.mutation.generateUploadUrl`, `api.files.mutation.saveFile`, `api.files.mutation.remove`, `api.files.query.list`, `api.organizations.mutation.updateStoreDefaults` (Task 4).
- Produces:
  - `uploadCredentialFile({ generateUploadUrl, saveFile, organizationId, projectId, file, purpose, description }): Promise<void>` — throws `Error` with a readable message on every failure code.
  - `<StoreCredentialsCard organizationId canEdit organization />`

- [ ] **Step 1: Write the failing test**

Create `packages/kit/src/pages/auth/organization/StoreCredentialsCard.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  updateStoreDefaults: vi.fn(),
  generateUploadUrl: vi.fn(),
  saveFile: vi.fn(),
  removeFile: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  files: [] as Array<Record<string, unknown>>,
}));

vi.mock("convex/react", () => ({
  useMutation: (reference: string) => {
    if (reference === "organizations.updateStoreDefaults") {
      return mocks.updateStoreDefaults;
    }
    if (reference === "files.generateUploadUrl") return mocks.generateUploadUrl;
    if (reference === "files.saveFile") return mocks.saveFile;
    return mocks.removeFile;
  },
  useQuery: () => mocks.files,
}));

vi.mock("@/convex", () => ({
  api: {
    files: {
      mutation: {
        generateUploadUrl: "files.generateUploadUrl",
        remove: "files.remove",
        saveFile: "files.saveFile",
      },
      query: { list: "files.list" },
    },
    organizations: {
      mutation: { updateStoreDefaults: "organizations.updateStoreDefaults" },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}));

import { StoreCredentialsCard } from "./StoreCredentialsCard";

const ORGANIZATION = {
  _id: "organizations_a",
  defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
  defaultIosAppStoreKeyId: "ORGKEY1234",
  defaultIosAscKeyId: null,
};

describe("StoreCredentialsCard", () => {
  beforeEach(() => {
    mocks.updateStoreDefaults.mockReset();
    mocks.updateStoreDefaults.mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.files = [];
  });

  afterEach(cleanup);

  it("prefills the stored defaults", () => {
    render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={ORGANIZATION as never}
        canEdit
      />,
    );
    expect(
      screen.getByLabelText("App Store Connect Issuer ID"),
    ).toHaveValue("11111111-1111-1111-1111-111111111111");
    expect(screen.getByLabelText("In-App Purchase Key ID")).toHaveValue(
      "ORGKEY1234",
    );
  });

  it("saves edited defaults", async () => {
    render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={ORGANIZATION as never}
        canEdit
      />,
    );
    fireEvent.change(screen.getByLabelText("In-App Purchase Key ID"), {
      target: { value: "NEWKEY1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => {
      expect(mocks.updateStoreDefaults).toHaveBeenCalledWith({
        organizationId: "organizations_a",
        defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
        defaultIosAppStoreKeyId: "NEWKEY1234",
        defaultIosAscKeyId: null,
      });
    });
  });

  it("surfaces a server validation error", async () => {
    mocks.updateStoreDefaults.mockRejectedValue(
      new Error("App Store Connect Key ID must be 10 uppercase letters"),
    );
    render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={ORGANIZATION as never}
        canEdit
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "App Store Connect Key ID must be 10 uppercase letters",
      );
    });
  });

  it("hides the editing controls without permission", () => {
    render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={ORGANIZATION as never}
        canEdit={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Save defaults" }),
    ).toBeNull();
  });

  it("lists an uploaded organization credential", () => {
    mocks.files = [
      {
        _id: "files_org",
        fileName: "AuthKey_ABCDE12345.p8",
        purpose: "apple_p8_key",
        projectId: undefined,
      },
    ];
    render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={ORGANIZATION as never}
        canEdit
      />,
    );
    expect(screen.getByText("AuthKey_ABCDE12345.p8")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pages/auth/organization/StoreCredentialsCard.test.tsx`
Expected: FAIL — cannot resolve `./StoreCredentialsCard`.

- [ ] **Step 3: Write the upload helper**

Create `packages/kit/src/pages/auth/organization/storeCredentialUpload.ts`:

```ts
import type { Id } from "@/convex";

export type CredentialPurpose =
  | "apple_p8_key"
  | "apple_p8_asc_api_key"
  | "android_service_account";

type SaveFileResult =
  | { success: true }
  | { success: false; code: string; message?: string };

const SAVE_FAILURE_MESSAGES: Record<string, string> = {
  UPLOAD_RESERVATION_EXPIRED:
    "The upload took too long and expired. Please try again.",
  TARGET_PENDING_DELETION:
    "The file was not saved because this organization is pending deletion.",
  AUTHORIZATION_LOST:
    "The file was not saved because your access changed during the upload. Please sign in and try again.",
  INSUFFICIENT_PERMISSIONS:
    "You need owner or admin access to change store credentials.",
  UPLOAD_ALREADY_REGISTERED:
    "That upload was already registered. Please try again.",
  UPLOAD_NOT_FOUND: "The uploaded file could not be found. Please try again.",
};

/**
 * The three-step Convex upload: reserve a URL, POST the bytes, then claim
 * the blob with a file row. Shared by the organization and project settings
 * pages so both surfaces report the same failure codes the same way.
 */
export async function uploadCredentialFile(options: {
  generateUploadUrl: (args: {
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
  }) => Promise<{ uploadUrl: string; uploadReservationId: string }>;
  saveFile: (args: Record<string, unknown>) => Promise<SaveFileResult>;
  organizationId: Id<"organizations">;
  projectId?: Id<"projects">;
  file: File;
  purpose: CredentialPurpose;
  description: string;
}): Promise<void> {
  const { uploadUrl, uploadReservationId } = await options.generateUploadUrl({
    organizationId: options.organizationId,
    projectId: options.projectId,
  });

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": options.file.type || "application/octet-stream",
    },
    body: options.file,
  });
  if (!response.ok) {
    throw new Error("Upload failed");
  }
  const { storageId } = (await response.json()) as { storageId: string };

  const saved = await options.saveFile({
    organizationId: options.organizationId,
    projectId: options.projectId,
    uploadReservationId,
    storageId,
    fileName: options.file.name,
    fileType: options.file.type || "application/octet-stream",
    fileSize: options.file.size,
    purpose: options.purpose,
    description: options.description,
    isInternal: true,
  });

  if (!saved.success) {
    throw new Error(
      saved.message ??
        SAVE_FAILURE_MESSAGES[saved.code] ??
        "The file could not be saved. Please try again.",
    );
  }
}

/** Reject an upload whose extension cannot match the credential kind. */
export function assertCredentialExtension(
  file: File,
  purpose: CredentialPurpose,
): void {
  const expected = purpose === "android_service_account" ? ".json" : ".p8";
  if (!file.name.toLowerCase().endsWith(expected)) {
    throw new Error(`Please upload a valid ${expected} file`);
  }
}
```

- [ ] **Step 4: Write the card**

Create `packages/kit/src/pages/auth/organization/StoreCredentialsCard.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";

import { api } from "@/convex";
import type { Id } from "@/convex";
import { ButtonPrimary } from "@/components/ButtonPrimary";
import {
  assertCredentialExtension,
  uploadCredentialFile,
  type CredentialPurpose,
} from "./storeCredentialUpload";

type OrganizationStoreDefaults = {
  defaultIosAppStoreIssuerId?: string | null;
  defaultIosAppStoreKeyId?: string | null;
  defaultIosAscKeyId?: string | null;
};

const CREDENTIAL_SLOTS: Array<{
  purpose: CredentialPurpose;
  label: string;
  hint: string;
  accept: string;
}> = [
  {
    purpose: "apple_p8_key",
    label: "In-App Purchase key (.p8)",
    hint: "App Store Connect → Users and Access → Integrations → In-App Purchase. Used to verify receipts.",
    accept: ".p8",
  },
  {
    purpose: "apple_p8_asc_api_key",
    label: "App Store Connect API key (.p8)",
    hint: "App Store Connect → Users and Access → Integrations → App Store Connect API. Used to push your catalog.",
    accept: ".p8",
  },
  {
    purpose: "android_service_account",
    label: "Google Play service account (.json)",
    hint: "Google Cloud service account with Play Developer API access. Grant it access to each app in Play Console.",
    accept: ".json",
  },
];

/**
 * Apple and Google issue store credentials per developer account, so they
 * belong to the organization. Every project inherits each value it leaves
 * blank; a project only fills these in when it ships under a second account.
 */
export function StoreCredentialsCard({
  organizationId,
  organization,
  canEdit,
}: {
  organizationId: Id<"organizations">;
  organization: OrganizationStoreDefaults;
  canEdit: boolean;
}) {
  const [issuerId, setIssuerId] = useState(
    organization.defaultIosAppStoreIssuerId ?? "",
  );
  const [keyId, setKeyId] = useState(
    organization.defaultIosAppStoreKeyId ?? "",
  );
  const [ascKeyId, setAscKeyId] = useState(
    organization.defaultIosAscKeyId ?? "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState<CredentialPurpose | null>(null);

  const updateStoreDefaults = useMutation(
    api.organizations.mutation.updateStoreDefaults,
  );
  const generateUploadUrl = useMutation(api.files.mutation.generateUploadUrl);
  const saveFile = useMutation(api.files.mutation.saveFile);
  const removeFile = useMutation(api.files.mutation.remove);

  const files = useQuery(api.files.query.list, { organizationId }) as
    | Array<{
        _id: Id<"files">;
        fileName: string;
        purpose: string;
        projectId?: Id<"projects">;
      }>
    | undefined;

  const organizationFile = (purpose: CredentialPurpose) =>
    files?.find(
      (file) => file.purpose === purpose && file.projectId === undefined,
    );

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateStoreDefaults({
        organizationId,
        defaultIosAppStoreIssuerId: issuerId.trim() || null,
        defaultIosAppStoreKeyId: keyId.trim() || null,
        defaultIosAscKeyId: ascKeyId.trim() || null,
      });
      toast.success("Store credential defaults saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save defaults",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
    purpose: CredentialPurpose,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(purpose);
    try {
      assertCredentialExtension(file, purpose);
      await uploadCredentialFile({
        generateUploadUrl,
        saveFile,
        organizationId,
        file,
        purpose,
        description: "Organization default store credential",
      });
      toast.success("Credential uploaded");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to upload credential",
      );
    } finally {
      setUploading(null);
    }
  };

  const handleDelete = async (fileId: Id<"files">) => {
    try {
      await removeFile({ fileId });
      toast.success("Credential removed");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove credential",
      );
    }
  };

  return (
    <div className="bg-card rounded border border-border p-6 mb-6">
      <h2 className="text-lg font-semibold mb-2">{"Store Credentials"}</h2>
      <p className="text-sm text-muted-foreground mb-6">
        {
          "Apple and Google issue these per developer account. Every project uses them unless it sets its own value."
        }
      </p>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="org-issuer-id"
            className="block text-sm font-medium mb-2"
          >
            {"App Store Connect Issuer ID"}
          </label>
          <input
            id="org-issuer-id"
            type="text"
            value={issuerId}
            disabled={!canEdit}
            onChange={(event) => setIssuerId(event.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder={"12345678-ABCD-1234-ABCD-1234567890AB"}
          />
        </div>
        <div>
          <label
            htmlFor="org-iap-key-id"
            className="block text-sm font-medium mb-2"
          >
            {"In-App Purchase Key ID"}
          </label>
          <input
            id="org-iap-key-id"
            type="text"
            value={keyId}
            disabled={!canEdit}
            onChange={(event) => setKeyId(event.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder={"ABCDE12345"}
          />
        </div>
        <div>
          <label
            htmlFor="org-asc-key-id"
            className="block text-sm font-medium mb-2"
          >
            {"App Store Connect Key ID"}
          </label>
          <input
            id="org-asc-key-id"
            type="text"
            value={ascKeyId}
            disabled={!canEdit}
            onChange={(event) => setAscKeyId(event.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder={"ABCDE12345"}
          />
        </div>

        {canEdit && (
          <ButtonPrimary
            type="button"
            onClick={() => {
              void handleSave();
            }}
            loading={isSaving}
            disabled={isSaving}
          >
            {"Save defaults"}
          </ButtonPrimary>
        )}
      </div>

      <div className="mt-8 space-y-6">
        {CREDENTIAL_SLOTS.map((slot) => {
          const existing = organizationFile(slot.purpose);
          return (
            <div key={slot.purpose}>
              <p className="text-sm font-medium">{slot.label}</p>
              <p className="text-xs text-muted-foreground mt-1">{slot.hint}</p>
              {existing ? (
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-sm">{existing.fileName}</span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleDelete(existing._id);
                      }}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      {"Remove"}
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mt-2">
                  {"No organization default uploaded."}
                </p>
              )}
              {canEdit && (
                <input
                  type="file"
                  accept={slot.accept}
                  aria-label={`Upload ${slot.label}`}
                  disabled={uploading === slot.purpose}
                  onChange={(event) => {
                    void handleUpload(event, slot.purpose);
                  }}
                  className="mt-2 block text-sm"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render the card on the settings page**

In `packages/kit/src/pages/auth/organization/settings.tsx`, add the import:

```ts
import { StoreCredentialsCard } from "./StoreCredentialsCard";
```

and render it directly after the closing `</div>` of the "Organization Details" block:

```tsx
      {currentOrg && (
        <StoreCredentialsCard
          organizationId={currentOrg._id}
          organization={currentOrg}
          canEdit={canEdit}
        />
      )}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bunx vitest run src/pages/auth/organization/StoreCredentialsCard.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/pages/auth/organization/storeCredentialUpload.ts \
  src/pages/auth/organization/StoreCredentialsCard.tsx \
  src/pages/auth/organization/StoreCredentialsCard.test.tsx \
  src/pages/auth/organization/settings.tsx
git commit -m "$(cat <<'EOF'
feat(kit): enter store credentials once per organization

Organization settings gains a Store Credentials card holding the Apple
Issuer ID, both Key IDs and the three credential files. The three-step
upload is extracted so the project page can share it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Project settings shows what it inherits

Closes the loop: the operator can see which values come from the organization and promote an existing project file.

**Files:**
- Modify: `packages/kit/src/pages/auth/organization/project/settings.tsx` (iOS and Android credential blocks)
- Modify: `packages/kit/src/pages/auth/organization/project/settings.test.tsx` (add cases)

**Interfaces:**
- Consumes: `api.files.mutation.promoteFileToOrganizationDefault` (Task 7), `api.projects.query.getSetupStatus`'s `usingOrganizationDefaults` (Task 6).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("ProjectSettings", ...)` block in `packages/kit/src/pages/auth/organization/project/settings.test.tsx`:

```tsx
  it("shows the inherited hint for a blank credential field", () => {
    mocks.project = {
      ...mocks.project,
      iosAppStoreKeyId: "",
      organizationDefaults: {
        defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
        defaultIosAppStoreKeyId: "ORGKEY1234",
      },
    } as never;
    render(<ProjectSettings />);
    expect(
      screen.getByText("Inherited from organization defaults: ORGKEY1234"),
    ).toBeTruthy();
  });

  it("offers to promote a project credential file to the organization", () => {
    mocks.files = [
      {
        _id: "files_own",
        fileName: "AuthKey_ABCDE12345.p8",
        purpose: "apple_p8_key",
        projectId: "projects_test",
      },
    ];
    render(<ProjectSettings />);
    expect(
      screen.getByRole("button", {
        name: "Make this the organization default",
      }),
    ).toBeTruthy();
  });
```

Extend the `convex/react` mock's `useMutation` so the new reference resolves:

```ts
    if (reference === "files.promoteFileToOrganizationDefault") {
      return mocks.promoteFile;
    }
```

adding `promoteFile: vi.fn()` to the `vi.hoisted` mocks object and
`promoteFileToOrganizationDefault: "files.promoteFileToOrganizationDefault"`
to the `@/convex` mock's `files.mutation` object.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pages/auth/organization/project/settings.test.tsx`
Expected: FAIL — neither the hint text nor the promote button exists.

- [ ] **Step 3: Read the organization defaults on the project page**

In `packages/kit/src/pages/auth/organization/project/settings.tsx`, alongside the existing `files` query, add:

```ts
  const organizationDefaults = useQuery(
    api.organizations.query.getStoreDefaults,
    project ? { organizationId: project.organizationId } : "skip",
  ) as
    | {
        defaultIosAppStoreIssuerId?: string | null;
        defaultIosAppStoreKeyId?: string | null;
        defaultIosAscKeyId?: string | null;
      }
    | undefined;

  // A blank input means "inherit", so show the operator what it will
  // inherit rather than leaving the field looking unconfigured.
  const inheritedHint = (
    current: string,
    inherited: string | null | undefined,
  ) =>
    !current.trim() && inherited
      ? `Inherited from organization defaults: ${inherited}`
      : null;
```

- [ ] **Step 4: Add the public organization defaults query**

Append to `packages/kit/convex/organizations/query.ts`:

```ts
// Read-only view of the organization's store credential defaults for the
// project settings page, which needs to show what a blank field inherits.
export const getStoreDefaults = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId),
      )
      .first();
    if (!membership) return null;

    const organization = await ctx.db.get(args.organizationId);
    if (!organization) return null;

    return {
      defaultIosAppStoreIssuerId: organization.defaultIosAppStoreIssuerId,
      defaultIosAppStoreKeyId: organization.defaultIosAppStoreKeyId,
      defaultIosAscIssuerId: organization.defaultIosAscIssuerId,
      defaultIosAscKeyId: organization.defaultIosAscKeyId,
    };
  },
});
```

If `query`, `v` or `getAuthUserId` are not yet imported in that file, add them to match `convex/organizations/mutation.ts`'s import style.

- [ ] **Step 5: Render the hints and the promote button**

Below the Issuer ID input (`settings.tsx:1274`), the In-App Purchase Key ID input (`:1311`) and the ASC Key ID input (`:1598`), add the matching hint. For the Issuer ID:

```tsx
                    {inheritedHint(
                      iosAppStoreIssuerId,
                      organizationDefaults?.defaultIosAppStoreIssuerId,
                    ) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {inheritedHint(
                          iosAppStoreIssuerId,
                          organizationDefaults?.defaultIosAppStoreIssuerId,
                        )}
                      </p>
                    )}
```

Repeat for `iosAppStoreKeyId` with `defaultIosAppStoreKeyId` and for
`iosAscKeyId` with `defaultIosAscKeyId`.

Next to each uploaded project-owned credential file row, add:

```tsx
                    {file.projectId && (
                      <button
                        type="button"
                        onClick={() => {
                          void handlePromoteFile(file._id);
                        }}
                        className="text-sm text-muted-foreground hover:text-foreground"
                      >
                        {"Make this the organization default"}
                      </button>
                    )}
```

with the handler defined alongside the other file handlers:

```ts
  const promoteFile = useMutation(
    api.files.mutation.promoteFileToOrganizationDefault,
  );

  const handlePromoteFile = async (fileId: Id<"files">) => {
    try {
      await promoteFile({ fileId });
      toast.success("Credential is now the organization default");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to promote the credential",
      );
    }
  };
```

- [ ] **Step 6: Reuse the shared upload helper**

Replace the bodies of `handleIosFileUpload`, `handleIosAscFileUpload` and the Android service-account upload handler with calls to `uploadCredentialFile` from Task 8, keeping each handler's existing `setUploading*` state and toast messages:

```ts
import {
  assertCredentialExtension,
  uploadCredentialFile,
} from "../storeCredentialUpload";
```

For example `handleIosFileUpload` becomes:

```ts
  const handleIosFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingIos(true);
    try {
      assertCredentialExtension(file, "apple_p8_key");
      await uploadCredentialFile({
        generateUploadUrl,
        saveFile,
        organizationId: project.organizationId,
        projectId: project._id,
        file,
        purpose: "apple_p8_key",
        description: `Apple .p8 key for ${project.name}`,
      });
      setIosFileUploaded(true);
      toast.success("iOS authentication file uploaded successfully");
    } catch (error: any) {
      console.error("iOS file upload error:", error);
      toast.error(error.message || "Failed to upload iOS authentication file");
    } finally {
      setUploadingIos(false);
    }
  };
```

Delete the now-unused local `ensureFileSaveSucceeded` helper only if no other handler still calls it.

- [ ] **Step 7: Run test to verify it passes**

Run: `bunx vitest run src/pages/auth/organization/project/settings.test.tsx`
Expected: PASS, including the two new cases and every pre-existing one.

- [ ] **Step 8: Run the lint gate and the full suite**

Run: `bun run lint && bun run test`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add src/pages/auth/organization/project/settings.tsx \
  src/pages/auth/organization/project/settings.test.tsx \
  convex/organizations/query.ts
git commit -m "$(cat <<'EOF'
feat(kit): show inherited credentials on the project settings page

A blank credential field now names the organization default it inherits,
and a project-owned credential file can be promoted to the organization
in one click — the migration path for the removed cross-project fallback.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Resolution rule | 2 |
| Organization ID columns | 1 |
| Organization files, single slot | 7 |
| Resolver module + internal query | 2 |
| Call sites: files/internal.ts | 3 |
| Call sites: ios.ts, asc.ts, webhooks/apple.ts | 5 |
| Call sites: setupStatus | 6 |
| `usingOrganizationDefaults` | 6 |
| `updateStoreDefaults` | 4 |
| Shared validation module | 1 |
| `saveFile` admin guard | 7 |
| `promoteFileToOrganizationDefault` | 7 |
| Organization dashboard section | 8 |
| Project dashboard inherited state | 9 |
| Shared upload helper | 8 (created), 9 (adopted) |

**Type consistency check** — `resolveAppleCredentialIds` returns `ResolvedAppleIds` with fields `issuerId`/`keyId`/`ascIssuerId`/`ascKeyId` and `sources`; Tasks 5 and 6 use exactly those names. `pickCredentialFile(files, projectId)` keeps its two-argument order in Tasks 3 and 6. `normalizeOptionalAppStoreIssuerId`/`normalizeOptionalAppStoreKeyId` defined in Task 1 are used only in Task 4. `uploadCredentialFile` and `assertCredentialExtension` defined in Task 8 are used in Tasks 8 and 9 with the same option names.

**Rollout after Task 9**

1. `cd packages/kit && npx convex deploy` — the new columns are optional, so no data migration runs.
2. Redeploy the `iap` application in Dokploy (project `biapp`) for the dashboard bundle.
3. Enter the defaults in organization settings, or promote the existing project files.
4. Announce the behavior change from the spec: Apple `.p8` lookup no longer borrows another project's file.
