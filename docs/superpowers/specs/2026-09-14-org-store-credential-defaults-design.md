# Organization-level store credential defaults

Date: 2026-09-14
Status: approved, ready for implementation
Scope: `packages/kit` (Convex backend + dashboard)

## Problem

Apple and Google issue store API credentials **per developer account**, not per
app. One App Store Connect Issuer ID, one In-App Purchase key, one App Store
Connect Team Key and one Google Play service account serve every app in the
account.

IAPKit stores them **per project**:

- `projects.iosAppStoreIssuerId`, `projects.iosAppStoreKeyId`,
  `projects.iosAscIssuerId`, `projects.iosAscKeyId` live on the project row.
- The `.p8` files and the service-account JSON live in `files` keyed by
  `projectId`.

An operator running several apps under one developer account therefore retypes
the same Issuer ID and Key IDs and re-uploads the same three files for every
new project. Rotating a key means editing every project by hand.

There is also an undocumented behavior that half-solves this and makes the
system harder to reason about: `files/internal.ts` `getAppleP8Key` and
`getAppleAscApiKey` fall back to `files[0]` — **an arbitrary other project's
`.p8`** — when the requested project has none. Google has no such fallback, so
Apple and Android behave differently for the same situation.

## Goal

Enter each store credential once per organization. Let a project override it
when it genuinely differs. Make the effective source visible.

## Non-goals

- Multiple named credential sets per organization. One default set is enough;
  a project that needs a second Apple account sets its own fields.
- Moving per-app values (`iosBundleId`, `iosAppAppleId`, `androidPackageName`,
  `horizonAppId`, `horizonAppSecret`, `amazonSharedSecret`) to the organization.
  These are genuinely per-app.
- Changing the public HTTP/v1 surface. No route reads these fields directly.

## Design

### Resolution rule

For every credential, in order:

1. The project's own value, when set and non-empty.
2. The organization default.
3. Not configured — report it as missing.

No opt-in toggle. A blank project field means "inherit"; filling it means
"override". This is the behavior an operator already expects from the empty
inputs in the current UI, so nothing that works today changes meaning.

The existing Apple pair-resolution rule inside `resolveAscCredentials` is
preserved exactly and applied **after** inheritance: if the resolved
`ascKeyId` is present, sign with the ASC pair (issuer falling back to the
resolved shared `iosAppStoreIssuerId`); otherwise fall back to the resolved
Server API pair.

### Storage

**Organization ID fields** — four new optional columns on `organizations`:

| Column | Mirrors |
|---|---|
| `defaultIosAppStoreIssuerId` | `projects.iosAppStoreIssuerId` |
| `defaultIosAppStoreKeyId` | `projects.iosAppStoreKeyId` |
| `defaultIosAscIssuerId` | `projects.iosAscIssuerId` |
| `defaultIosAscKeyId` | `projects.iosAscKeyId` |

All `v.optional(v.union(v.string(), v.null()))` so a patch can clear them —
Convex treats `undefined` in a patch as "leave unchanged".

Google needs no ID columns; its only credential is the service-account file.

**Organization files** — no schema change. A `files` row whose `projectId` is
`undefined` is the organization default for its `purpose`. The column is
already optional and `saveFile`, `generateUploadUrl`, `remove` and `list`
already accept and handle that shape. Only the UI never produced one.

At most one organization-level row per purpose: a new upload atomically
replaces the previous row and reclaims its blob, reusing the mechanism
`saveFile` already applies to `apple_iap_review_screenshot`.

### Resolver

New module `convex/projects/storeCredentials.ts`, all pure functions so both
query and action contexts can use them:

```ts
type CredentialSource = "project" | "organization";

type ResolvedAppleIds = {
  issuerId?: string;
  keyId?: string;
  ascIssuerId?: string;
  ascKeyId?: string;
  sources: Partial<Record<
    "issuerId" | "keyId" | "ascIssuerId" | "ascKeyId",
    CredentialSource
  >>;
};

resolveAppleCredentialIds(
  project: Doc<"projects">,
  organization: Doc<"organizations"> | null,
): ResolvedAppleIds;

pickCredentialFile<T extends { projectId?: Id<"projects"> }>(
  files: T[],
  projectId: Id<"projects"> | undefined,
): T | undefined;
```

`resolveAppleCredentialIds` treats whitespace-only strings as unset so a
stray space in a project field cannot shadow a valid organization default.

`pickCredentialFile` returns the project-owned row first, then the
organization-level row (`projectId === undefined`), and **never** a row owned
by a different project.

Plus one internal query for action callers that hold only a project:

```ts
getOrganizationStoreDefaults: internalQuery({ organizationId }) =>
  Pick<Doc<"organizations">,
    "defaultIosAppStoreIssuerId" | "defaultIosAppStoreKeyId"
    | "defaultIosAscIssuerId" | "defaultIosAscKeyId"> | null
```

### Call sites

| File | Change |
|---|---|
| `convex/files/internal.ts` | `getAppleP8Key`, `getAppleAscApiKey`, `getGooglePlayFileByProjectInternal` select via `pickCredentialFile`. Removes cross-project borrowing; adds organization fallback for all three. |
| `convex/purchases/ios.ts` | `getAppStoreServerCredentials` reads resolved issuer/key instead of raw project columns. |
| `convex/products/asc.ts` | `resolveAscCredentials` reads resolved ids; pair rule unchanged. |
| `convex/webhooks/apple.ts` | The inlined `IOS_NOT_CONFIGURED` gate checks resolved ids. |
| `convex/projects/setupStatus.ts` | Missing-field lists use resolved ids; file-presence flags consider organization rows; response gains `usingOrganizationDefaults`. |

`getGooglePlayFileByProjectInternal` keeps its name and `{ projectId }`
signature so its three callers (`purchases/android.ts`, `products/play.ts`,
`webhooks/google.ts`) are untouched. It now reads the project row to learn the
organization, then applies `pickCredentialFile`.

### setupStatus response

Adds one field:

```ts
usingOrganizationDefaults: v.object({
  iosAppStoreIssuerId: v.boolean(),
  iosAppStoreKeyId: v.boolean(),
  iosAscKeyId: v.boolean(),
  appleP8: v.boolean(),
  appleAscP8: v.boolean(),
  googleServiceAccount: v.boolean(),
})
```

Each flag is true when the project resolves that credential from the
organization. The MCP `troubleshoot` and `setup` tools and the dashboard setup
card read it without further work.

`appleP8Uploaded` and `googleServiceAccountUploaded` become true when an
organization-level file is inherited. Leaving them project-only would report
"missing" for a correctly configured project — a real bug introduced by this
feature if not handled.

### Mutations

`convex/organizations/mutation.ts` gains `updateStoreDefaults`:

- Args: `organizationId` plus the four optional `v.union(v.string(), v.null())`
  id fields.
- Requires `owner` or `admin`, matching `updateOrganization`.
- A non-empty string is normalized and validated; `null` or an empty/blank
  string clears the column.

Validation reuses the existing rules, moved from `convex/projects/mutation.ts`
into `convex/projects/storeCredentialValidation.ts` and imported by both so the
organization and project inputs cannot drift:

- Issuer ID: UUID shape, case-insensitive, stored trimmed.
- Key ID: exactly 10 characters of `[A-Z0-9]`, stored upper-cased.

`convex/files/mutation.ts`:

- `saveFile` requires `owner` or `admin` for the three credential purposes.
  Today only `apple_iap_review_screenshot` requires it, so a `member` can
  currently replace a project's signing key; an organization-wide key makes
  that worse. Tightening it is part of this change.
- `saveFile` replaces the previous organization-level row for the same purpose
  when `projectId` is absent, mirroring the screenshot single-slot path
  (indexed read before insert so Convex OCC serializes concurrent uploads).
- New `promoteFileToOrganizationDefault({ fileId })`: clears `projectId` on a
  credential file the caller can administer, replacing any existing
  organization row for that purpose. This is the migration path for operators
  who relied on the removed cross-project borrowing.

### Dashboard

`src/pages/auth/organization/settings.tsx` gains a **Store Credentials**
section below Organization Details, visible to owners and admins:

- Apple: shared Issuer ID, In-App Purchase Key ID, App Store Connect Key ID,
  and upload slots for the two `.p8` files.
- Google: upload slot for the service-account JSON.
- Copy states plainly that these apply to every project that leaves the field
  blank.

`src/pages/auth/organization/project/settings.tsx`:

- A blank field whose organization default exists renders an "Inherited from
  organization defaults" hint with the inherited value and a link to the
  organization settings page. Typing a value overrides it.
- File rows show the same inherited state, with the existing upload control
  relabeled "Upload a different file for this project".
- A project-owned credential file gains a "Make this the organization default"
  action calling `promoteFileToOrganizationDefault`.

The three-step upload flow (`generateUploadUrl` → `POST` → `saveFile`) is
extracted to `src/pages/auth/organization/storeCredentialUpload.ts` as plain
async functions and used by both pages. The project page's JSX is not
restructured; only the handlers change to call the shared function.

## Testing

Unit, on the pure resolver (`convex/projects/storeCredentials.test.ts`):

- Project value wins over the organization default.
- Blank or whitespace-only project value falls through to the organization.
- Neither set reports the credential missing.
- `pickCredentialFile` prefers the project row, falls back to the organization
  row, and returns nothing when only another project's row exists.

Convex integration (`convexTest`):

- `getAppleP8Key`, `getAppleAscApiKey` and `getGooglePlayFileByProjectInternal`
  each resolve the organization file and refuse another project's file.
- `getSetupStatus` reports `configured: true` and the matching
  `usingOrganizationDefaults` flags for a project carrying no credentials of
  its own, and keeps `appleP8Uploaded` true for an inherited file.
- `updateStoreDefaults` rejects a `member`, rejects a malformed Issuer ID and
  Key ID, and clears a column on `null`.
- `saveFile` rejects a credential upload from a `member` and replaces the
  previous organization-level row for the same purpose.
- `promoteFileToOrganizationDefault` clears `projectId` and displaces the prior
  organization row.

UI (`vitest` + Testing Library):

- The organization settings page saves defaults and surfaces a validation
  error.
- A project field with no value renders the inherited hint.

Full gate before merge: `bun run lint` and `bun run test` in `packages/kit`.

## Rollout

1. `npx convex deploy` — the four columns are optional, so the deploy is
   backwards compatible and needs no data migration.
2. Redeploy the `iap` application in Dokploy (project `biapp`) to ship the
   dashboard bundle.
3. Enter the defaults once in organization settings, or promote the existing
   `telefonuzmani` project files with the new action.

## Behavior change to announce

Apple `.p8` lookup no longer falls back to an arbitrary other project's file.
A project that was silently borrowing one starts reporting
`appleP8Uploaded: false` and fails receipt verification with the existing
"not configured" error. The remedy is one click: promote that file to the
organization default. This is called out here because it is the only way a
working deployment can regress.
