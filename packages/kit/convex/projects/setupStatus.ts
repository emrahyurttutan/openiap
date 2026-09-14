import { query } from "../_generated/server";
import { v } from "convex/values";

import {
  resolveProjectByApiKeyFromDb,
  resolveProjectByIdForCurrentUserFromDb,
} from "./helpers";
import {
  pickCredentialFile,
  resolveAppleCredentialIds,
} from "./storeCredentials";

// Public query — surfaces which platforms a project has configured so
// the dashboard, the SDK, and the MCP server can return a precise
// "X not configured" error instead of a silent empty response.
//
// Auth via apiKey (same model as the rest of the v1 surface). Returns
// `found: false` when the key is unknown so the dashboard can render
// "log in to a different project" without leaking which keys exist.

const platformShape = v.object({
  configured: v.boolean(),
  missing: v.array(v.string()),
});

export const getSetupStatus = query({
  args: {
    apiKey: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
  },
  returns: v.object({
    found: v.boolean(),
    projectId: v.union(v.id("projects"), v.null()),
    ios: platformShape,
    android: platformShape,
    horizon: platformShape,
    amazon: platformShape,
    appleP8Uploaded: v.boolean(),
    googleServiceAccountUploaded: v.boolean(),
    // Which credentials this project takes from its organization, so the
    // dashboard and MCP tools can say "inherited" instead of "configured here".
    usingOrganizationDefaults: v.object({
      iosAppStoreIssuerId: v.boolean(),
      iosAppStoreKeyId: v.boolean(),
      iosAscKeyId: v.boolean(),
      appleP8: v.boolean(),
      appleAscP8: v.boolean(),
      googleServiceAccount: v.boolean(),
    }),
  }),
  handler: async (ctx, args) => {
    const resolved = args.projectId
      ? await resolveProjectByIdForCurrentUserFromDb(ctx, args.projectId)
      : args.apiKey
        ? await resolveProjectByApiKeyFromDb(ctx, args.apiKey, "admin")
        : null;
    const project = resolved?.project ?? null;

    if (!project) {
      const empty = { configured: false, missing: ["project not found"] };
      return {
        found: false,
        projectId: null,
        ios: empty,
        android: empty,
        horizon: empty,
        amazon: empty,
        appleP8Uploaded: false,
        googleServiceAccountUploaded: false,
        usingOrganizationDefaults: {
          iosAppStoreIssuerId: false,
          iosAppStoreKeyId: false,
          iosAscKeyId: false,
          appleP8: false,
          appleAscP8: false,
          googleServiceAccount: false,
        },
      };
    }

    // A project with no credential file of its own inherits the org-level
    // one, so the lookup spans the org. One indexed read per purpose keeps
    // that bounded — a plain `by_organization` collect would also pull every
    // project's review screenshot into this hot, public query.
    const credentialFile = async (
      purpose:
        | "apple_p8_key"
        | "apple_p8_asc_api_key"
        | "android_service_account",
    ) =>
      pickCredentialFile(
        await ctx.db
          .query("files")
          .withIndex("by_org_and_purpose", (q) =>
            q
              .eq("organizationId", project.organizationId)
              .eq("purpose", purpose),
          )
          .collect(),
        project._id,
      );

    const appleP8File = await credentialFile("apple_p8_key");
    const appleAscFile = await credentialFile("apple_p8_asc_api_key");
    const googleServiceAccountFile = await credentialFile(
      "android_service_account",
    );

    const organization = await ctx.db.get(project.organizationId);
    const resolvedApple = resolveAppleCredentialIds(project, organization);

    const iosMissing: string[] = [];
    if (!project.iosBundleId) iosMissing.push("iosBundleId");
    if (!project.iosAppAppleId) iosMissing.push("iosAppAppleId");
    if (!resolvedApple.issuerId) iosMissing.push("iosAppStoreIssuerId");
    if (!resolvedApple.keyId) iosMissing.push("iosAppStoreKeyId");

    const androidMissing: string[] = [];
    if (!project.androidPackageName) androidMissing.push("androidPackageName");

    const horizonMissing: string[] = [];
    if (!project.horizonEnabled) horizonMissing.push("horizonEnabled");
    if (!project.horizonAppId) horizonMissing.push("horizonAppId");
    if (!project.horizonAppSecret) horizonMissing.push("horizonAppSecret");

    const amazonConfigured =
      (typeof project.amazonSharedSecret === "string" &&
        project.amazonSharedSecret.trim().length > 0) ||
      project.amazonSandboxEnabled === true;
    const amazonMissing: string[] = [];
    if (!amazonConfigured) {
      amazonMissing.push("amazonSharedSecret");
    }

    return {
      found: true,
      projectId: project._id,
      ios: {
        configured: iosMissing.length === 0,
        missing: iosMissing,
      },
      android: {
        configured: androidMissing.length === 0,
        missing: androidMissing,
      },
      horizon: {
        configured: horizonMissing.length === 0,
        missing: horizonMissing,
      },
      amazon: {
        configured: amazonConfigured,
        missing: amazonMissing,
      },
      // The webhook receivers also need the .p8 / service-account file, so
      // report whichever row this project actually resolves.
      appleP8Uploaded: !!appleP8File || !!appleAscFile,
      googleServiceAccountUploaded: !!googleServiceAccountFile,
      usingOrganizationDefaults: {
        iosAppStoreIssuerId: resolvedApple.sources.issuerId === "organization",
        iosAppStoreKeyId: resolvedApple.sources.keyId === "organization",
        iosAscKeyId: resolvedApple.sources.ascKeyId === "organization",
        appleP8: !!appleP8File && appleP8File.projectId === undefined,
        appleAscP8: !!appleAscFile && appleAscFile.projectId === undefined,
        googleServiceAccount:
          !!googleServiceAccountFile &&
          googleServiceAccountFile.projectId === undefined,
      },
    };
  },
});
