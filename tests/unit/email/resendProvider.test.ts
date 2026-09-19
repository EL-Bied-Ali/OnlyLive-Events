import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailProviderError } from "@/lib/email/provider";
import { ResendEmailProvider } from "@/lib/email/resendProvider";

function configure() {
  vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
  vi.stubEnv("RESEND_FROM_EMAIL", "tickets@onlylive.test");
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendEmailProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails fast when required configuration is missing or invalid", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    expect(() => new ResendEmailProvider()).toThrow(/RESEND_API_KEY/);

    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "not-an-email");
    expect(() => new ResendEmailProvider()).toThrow(/plain email address/);
  });

  it("sends plain-text email with the stable outbox id as Resend's idempotency key", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_123" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Confirmation",
      text: "Votre commande est confirmée.",
      idempotencyKey: "outbox-row-123",
    });

    expect(result).toEqual({ providerMessageId: "email_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer re_test_onlylive",
        "Content-Type": "application/json",
        "Idempotency-Key": "outbox-row-123",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "OnlyLive <tickets@onlylive.test>",
      to: ["buyer@example.com"],
      subject: "Confirmation",
      text: "Votre commande est confirmée.",
    });
  });

  it("treats throttling/server/network failures as retryable without exposing the raw provider body", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {
      name: "rate_limit_exceeded",
      message: "raw provider detail should never become our thrown message",
    })));

    await expect(new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "retryable-1",
    })).rejects.toMatchObject({
      name: "EmailProviderError",
      retryable: true,
      status: 429,
      providerCode: "rate_limit_exceeded",
      message: "resend_rate_limit_exceeded",
    });
  });

  it("keeps operator-fixable auth/domain failures retryable", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {
      name: "validation_error",
      message: "domain is not verified",
    })));

    await expect(new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "config-403",
    })).rejects.toMatchObject({
      name: "EmailProviderError",
      retryable: true,
      status: 403,
      providerCode: "validation_error",
    });
  });

  it("treats ordinary 4xx request/config errors as permanent", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(422, {
      name: "validation_error",
      message: "recipient rejected",
    })));

    await expect(new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "permanent-1",
    })).rejects.toMatchObject({
      name: "EmailProviderError",
      retryable: false,
      status: 422,
      providerCode: "validation_error",
      message: "resend_validation_error",
    });
  });

  it("distinguishes Resend's two idempotency-conflict outcomes", async () => {
    configure();
    const provider = new ResendEmailProvider();
    const send = () => provider.send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "same-key",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, {
      name: "concurrent_idempotent_requests",
    })));
    await expect(send()).rejects.toMatchObject({ retryable: true, providerCode: "concurrent_idempotent_requests" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, {
      name: "invalid_idempotent_request",
    })));
    await expect(send()).rejects.toMatchObject({ retryable: false, providerCode: "invalid_idempotent_request" });
  });

  it("treats a malformed successful response as ambiguous and retryable under the same key", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "ambiguous-success",
    })).rejects.toMatchObject({
      retryable: true,
      status: 200,
      providerCode: "missing_message_id",
    });
  });

  it("routes all preview email to the configured Resend test recipient", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_test_123" }));
    vi.stubGlobal("fetch", fetchMock);

    await new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Confirmation",
      text: "Votre commande est confirmée.",
      idempotencyKey: "outbox-row-123",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      headers: {
        "Idempotency-Key": "test-outbox-row-123",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "OnlyLive <onboarding@resend.dev>",
      to: ["owner@example.com"],
      subject: "Confirmation",
      text: "Votre commande est confirmée.",
    });
  });

  it("refuses the test-recipient override in Vercel Production", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "production");

    expect(() => new ResendEmailProvider()).toThrow(/forbidden in Vercel Production/);
  });

  it("requires an explicit test recipient when using Resend's shared test sender", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "");
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(() => new ResendEmailProvider()).toThrow(/requires RESEND_TEST_RECIPIENT/);
  });

  it("rejects an invalid local idempotency key before network I/O", async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ResendEmailProvider().send({
      to: "buyer@example.com",
      subject: "Hi",
      text: "Body",
      idempotencyKey: "",
    })).rejects.toEqual(expect.objectContaining<Partial<EmailProviderError>>({
      retryable: false,
      providerCode: "invalid_idempotency_key",
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
