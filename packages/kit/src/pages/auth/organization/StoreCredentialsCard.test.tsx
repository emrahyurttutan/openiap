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
  defaultIosAppStoreIssuerId: "11111111-1111-1111-1111-111111111111",
  defaultIosAppStoreKeyId: "ORGKEY1234",
  defaultIosAscKeyId: null,
};

function renderCard(canEdit = true) {
  return render(
    <StoreCredentialsCard
      organizationId={"organizations_a" as never}
      organization={ORGANIZATION}
      canEdit={canEdit}
    />,
  );
}

describe("StoreCredentialsCard", () => {
  beforeEach(() => {
    mocks.updateStoreDefaults.mockReset();
    mocks.updateStoreDefaults.mockResolvedValue(undefined);
    mocks.removeFile.mockReset();
    mocks.removeFile.mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.files = [];
  });

  afterEach(cleanup);

  it("prefills the stored defaults", () => {
    renderCard();
    expect(
      screen.getByLabelText<HTMLInputElement>("App Store Connect Issuer ID")
        .value,
    ).toBe("11111111-1111-1111-1111-111111111111");
    expect(
      screen.getByLabelText<HTMLInputElement>("In-App Purchase Key ID").value,
    ).toBe("ORGKEY1234");
    expect(
      screen.getByLabelText<HTMLInputElement>("App Store Connect Key ID").value,
    ).toBe("");
  });

  it("saves edited defaults and clears a blank one", async () => {
    renderCard();
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
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "App Store Connect Key ID must be 10 uppercase letters",
      );
    });
  });

  it("hides the editing controls without permission", () => {
    renderCard(false);
    expect(screen.queryByRole("button", { name: "Save defaults" })).toBeNull();
    expect(
      screen.queryByLabelText("Upload In-App Purchase key (.p8)"),
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
    renderCard();
    expect(screen.getByText("AuthKey_ABCDE12345.p8")).toBeTruthy();
  });

  it("ignores a project-owned file when listing organization defaults", () => {
    mocks.files = [
      {
        _id: "files_project",
        fileName: "ProjectKey.p8",
        purpose: "apple_p8_key",
        projectId: "projects_a",
      },
    ];
    renderCard();
    expect(screen.queryByText("ProjectKey.p8")).toBeNull();
  });

  it("resyncs when the stored defaults change under it", () => {
    const { rerender } = render(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={{ ...ORGANIZATION, defaultIosAppStoreKeyId: null }}
        canEdit
      />,
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("In-App Purchase Key ID").value,
    ).toBe("");

    rerender(
      <StoreCredentialsCard
        organizationId={"organizations_a" as never}
        organization={{
          ...ORGANIZATION,
          defaultIosAppStoreKeyId: "SAVED12345",
        }}
        canEdit
      />,
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("In-App Purchase Key ID").value,
    ).toBe("SAVED12345");
  });

  it("rejects an upload whose extension cannot match the slot", async () => {
    renderCard();
    const input = screen.getByLabelText("Upload In-App Purchase key (.p8)");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "service-account.json")] },
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Please upload a valid .p8 file",
      );
    });
    expect(mocks.generateUploadUrl).not.toHaveBeenCalled();
  });
});
