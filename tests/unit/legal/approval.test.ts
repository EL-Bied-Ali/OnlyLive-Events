import { afterEach, describe, expect, it, vi } from "vitest";
import { legalDocumentsApproved } from "@/lib/legal/approval";

describe("legalDocumentsApproved", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is always approved outside production, regardless of the flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LEGAL_DOCUMENTS_APPROVED", "");
    expect(legalDocumentsApproved()).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    expect(legalDocumentsApproved()).toBe(true);
  });

  it("is blocked in production unless the flag is exactly \"true\"", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LEGAL_DOCUMENTS_APPROVED", "");
    expect(legalDocumentsApproved()).toBe(false);

    vi.stubEnv("LEGAL_DOCUMENTS_APPROVED", "TRUE");
    expect(legalDocumentsApproved()).toBe(false);

    vi.stubEnv("LEGAL_DOCUMENTS_APPROVED", "1");
    expect(legalDocumentsApproved()).toBe(false);
  });

  it("is approved in production only once the flag is explicitly set to \"true\"", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LEGAL_DOCUMENTS_APPROVED", "true");
    expect(legalDocumentsApproved()).toBe(true);
  });
});
