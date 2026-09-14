import { v } from "convex/values";

import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// One rule everywhere a store credential is read: the project's own value
// when non-blank, then the organization default, then not configured.

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

/** Blank counts as unset so a stray space cannot shadow the default. */
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
 * The project's own row first, then the organization row (no `projectId`).
 * Never another project's row: the previous `files[0]` fallback signed one
 * project's requests with a different project's credential.
 */
export function pickCredentialFile<
  T extends { projectId?: Id<"projects"> | undefined },
>(files: T[], projectId: Id<"projects"> | undefined): T | undefined {
  const own = projectId
    ? files.find((file) => file.projectId === projectId)
    : undefined;
  return own ?? files.find((file) => file.projectId === undefined);
}

/** Actions hold a project but not its organization; this fetches the rest. */
export const getOrganizationStoreDefaults = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.object({
      defaultIosAppStoreIssuerId: v.optional(v.union(v.string(), v.null())),
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
