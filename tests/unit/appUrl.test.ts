import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteAppUrl, getAppBaseUrl } from "@/lib/appUrl";

describe("getAppBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when NEXTAUTH_URL is not set", () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    expect(() => getAppBaseUrl()).toThrow("NEXTAUTH_URL is not set");
  });

  it("throws when NEXTAUTH_URL is not a valid URL", () => {
    vi.stubEnv("NEXTAUTH_URL", "not-a-url");
    expect(() => getAppBaseUrl()).toThrow("must be a valid URL");
  });

  it("allows http on a local loopback host even in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3100");
    expect(getAppBaseUrl()).toBe("http://localhost:3100");
  });

  it("requires https in production for a non-local host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://tickets.onlylive.ma");
    expect(() => getAppBaseUrl()).toThrow("must use https in production");
  });

  it("allows https for a non-local host in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "https://tickets.onlylive.ma");
    expect(getAppBaseUrl()).toBe("https://tickets.onlylive.ma");
  });

  it("does not require https outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_URL", "http://tickets.onlylive.ma");
    expect(getAppBaseUrl()).toBe("http://tickets.onlylive.ma");
  });
});

describe("absoluteAppUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a relative path against the configured base URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(absoluteAppUrl("/orders/abc/tickets/def")).toBe("http://localhost:3000/orders/abc/tickets/def");
  });
});
