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

type OrganizationFile = {
  _id: Id<"files">;
  fileName: string;
  purpose: string;
  projectId?: Id<"projects">;
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
    hint: "App Store Connect → Users and Access → Integrations → In-App Purchase. Verifies receipts.",
    accept: ".p8",
  },
  {
    purpose: "apple_p8_asc_api_key",
    label: "App Store Connect API key (.p8)",
    hint: "App Store Connect → Users and Access → Integrations → App Store Connect API. Pushes your catalog.",
    accept: ".p8",
  },
  {
    purpose: "android_service_account",
    label: "Google Play service account (.json)",
    hint: "A Google Cloud service account with Play Developer API access. Grant it access to each app in Play Console.",
    accept: ".json",
  },
];

const TEXT_FIELDS: Array<{
  id: string;
  label: string;
  placeholder: string;
  key: "issuerId" | "keyId" | "ascKeyId";
}> = [
  {
    id: "org-issuer-id",
    label: "App Store Connect Issuer ID",
    placeholder: "12345678-ABCD-1234-ABCD-1234567890AB",
    key: "issuerId",
  },
  {
    id: "org-iap-key-id",
    label: "In-App Purchase Key ID",
    placeholder: "ABCDE12345",
    key: "keyId",
  },
  {
    id: "org-asc-key-id",
    label: "App Store Connect Key ID",
    placeholder: "ABCDE12345",
    key: "ascKeyId",
  },
];

/**
 * Apple and Google issue store credentials per developer account, so they
 * belong to the organization. A project only fills these in when it ships
 * under a second account.
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
  const [values, setValues] = useState({
    issuerId: organization.defaultIosAppStoreIssuerId ?? "",
    keyId: organization.defaultIosAppStoreKeyId ?? "",
    ascKeyId: organization.defaultIosAscKeyId ?? "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState<CredentialPurpose | null>(null);

  const updateStoreDefaults = useMutation(
    api.organizations.mutation.updateStoreDefaults,
  );
  const generateUploadUrl = useMutation(api.files.mutation.generateUploadUrl);
  const saveFile = useMutation(api.files.mutation.saveFile);
  const removeFile = useMutation(api.files.mutation.remove);

  const files = useQuery(api.files.query.list, { organizationId }) as
    | OrganizationFile[]
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
        defaultIosAppStoreIssuerId: values.issuerId.trim() || null,
        defaultIosAppStoreKeyId: values.keyId.trim() || null,
        defaultIosAscKeyId: values.ascKeyId.trim() || null,
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
        {TEXT_FIELDS.map((field) => (
          <div key={field.id}>
            <label
              htmlFor={field.id}
              className="block text-sm font-medium mb-2"
            >
              {field.label}
            </label>
            <input
              id={field.id}
              type="text"
              value={values[field.key]}
              disabled={!canEdit}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/20"
              placeholder={field.placeholder}
            />
          </div>
        ))}

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
