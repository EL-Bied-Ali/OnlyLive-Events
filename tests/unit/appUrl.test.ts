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

  it("rejects http loopback in production without the explicit E2E opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3100");
    vi.stubEnv("ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION", "");
    expect(() => getAppBaseUrl()).toThrow("must use https in production");
  });

  it("allows http loopback in production only with the explicit E2E opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3100");
    vi.stubEnv("ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION", "true");
    expect(getAppBaseUrl()).toBe("http://127.0.0.1:3100");
  });

  it("recognizes the URL-normalized IPv6 loopback form with the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://[::1]:3100");
    vi.stubEnv("ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION", "true");
    expect(getAppBaseUrl()).toBe("http://[::1]:3100");
  });

  it("the E2E opt-in never exempts a non-loopback http URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "http://tickets.onlylive.ma");
    vi.stubEnv("ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION", "true");
    expect(() => getAppBaseUrl()).toThrow("must use https in production");
  });

  it("the E2E opt-in never exempts a non-http loopback URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "ftp://localhost:3100");
    vi.stubEnv("ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION", "true");
    expect(() => getAppBaseUrl()).toThrow("must use https in production");
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
