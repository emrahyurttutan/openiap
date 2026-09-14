import type { Id } from "@/convex";

export type CredentialPurpose =
  | "apple_p8_key"
  | "apple_p8_asc_api_key"
  | "android_service_account";

type SaveFileResult =
  | { success: true }
  | { success: false; code: string; message?: string };

// Mirrors the `saveFile` mutation args. Declared concretely rather than as a
// loose record so the mutation handle stays assignable under strict checks.
type SaveCredentialFileArgs = {
  organizationId: Id<"organizations">;
  projectId?: Id<"projects">;
  uploadReservationId: Id<"fileUploadReservations">;
  storageId: Id<"_storage">;
  fileName: string;
  fileType: string;
  fileSize: number;
  purpose: CredentialPurpose;
  description?: string;
  isInternal?: boolean;
};

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
 * Reserve a URL, POST the bytes, claim the blob with a file row. Shared by the
 * organization and project settings pages so both report failures alike.
 */
export async function uploadCredentialFile(options: {
  generateUploadUrl: (args: {
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
  }) => Promise<{
    uploadUrl: string;
    uploadReservationId: Id<"fileUploadReservations">;
  }>;
  saveFile: (args: SaveCredentialFileArgs) => Promise<SaveFileResult>;
  organizationId: Id<"organizations">;
  projectId?: Id<"projects">;
  file: File;
  purpose: CredentialPurpose;
  description: string;
  // Callers with their own failure copy pass a translator that throws.
  ensureSaved?: (result: SaveFileResult) => void;
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
  const { storageId } = (await response.json()) as {
    storageId: Id<"_storage">;
  };

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

  if (options.ensureSaved) {
    options.ensureSaved(saved);
    return;
  }

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
