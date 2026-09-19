import { describe, expect, it } from "vitest";
import { hardenPostgresSslMode } from "@/lib/postgresConnection";

describe("hardenPostgresSslMode", () => {
  it.each(["prefer", "require", "verify-ca"])(
    "pins legacy pg sslmode=%s to verify-full",
    (mode) => {
      expect(
        hardenPostgresSslMode(
          `postgresql://user:secret@db.example.com/app?sslmode=${mode}&channel_binding=require`,
        ),
      ).toBe(
        "postgresql://user:secret@db.example.com/app?sslmode=verify-full&channel_binding=require",
      );
    },
  );

  it("leaves verify-full unchanged", () => {
    const url = "postgres://user:secret@db.example.com/app?sslmode=verify-full";
    expect(hardenPostgresSslMode(url)).toBe(url);
  });

  it("does not force SSL when sslmode is absent or disabled", () => {
    const absent = "postgresql://onlylive:onlylive@localhost:5432/onlylive_test";
    const disabled = `${absent}?sslmode=disable`;

    expect(hardenPostgresSslMode(absent)).toBe(absent);
    expect(hardenPostgresSslMode(disabled)).toBe(disabled);
  });

  it("preserves an explicit libpq-compatibility opt-in", () => {
    const url =
      "postgresql://user:secret@db.example.com/app?sslmode=require&uselibpqcompat=true";
    expect(hardenPostgresSslMode(url)).toBe(url);
  });

  it("preserves unrelated URLs", () => {
    const url = "https://example.com/?sslmode=require";
    expect(hardenPostgresSslMode(url)).toBe(url);
  });

  it("normalizes every legacy sslmode occurrence without rewriting other URL bytes", () => {
    const url =
      "postgresql://user:p%40ss@db.example.com/app?sslmode=require&x=a%2Bb&sslmode=VERIFY-CA";
    expect(hardenPostgresSslMode(url)).toBe(
      "postgresql://user:p%40ss@db.example.com/app?sslmode=verify-full&x=a%2Bb&sslmode=verify-full",
    );
  });
});
