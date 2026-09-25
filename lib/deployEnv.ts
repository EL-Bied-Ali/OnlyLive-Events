type DeployEnv = Readonly<Record<string, string | undefined>>;

const EXAMPLE_RATE_LIMIT_SECRET = "replace-with-a-random-32-byte-base64-secret";

function trimmed(env: DeployEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function requireValue(errors: string[], env: DeployEnv, name: string): string {
  const value = trimmed(env, name);
  if (!value) errors.push(`${name} is required`);
  return value;
}

function requireStrongSecret(errors: string[], env: DeployEnv, name: string, minLength = 32): string {
  const value = requireValue(errors, env, name);
  if (value && value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

function requireHttpsOrigin(errors: string[], env: DeployEnv, name: string): string {
  const value = requireValue(errors, env, name);
  if (!value) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== "/"
    ) {
      errors.push(`${name} must be an HTTPS origin with no path, credentials, query, or fragment`);
    }
  } catch {
    errors.push(`${name} must be a valid absolute URL`);
  }
  return value;
}

/**
 * Build/runtime preflight for environment-scoped settings that can make a
 * Vercel deployment compile successfully but fail on the first real request.
 * Local development is intentionally unaffected.
 */
export function deploymentEnvErrors(env: DeployEnv = process.env): string[] {
  const vercelEnv = trimmed(env, "VERCEL_ENV");
  if (!vercelEnv) return [];

  const errors: string[] = [];
  requireValue(errors, env, "DATABASE_URL");
  requireHttpsOrigin(errors, env, "NEXTAUTH_URL");
  requireStrongSecret(errors, env, "NEXTAUTH_SECRET");
  requireStrongSecret(errors, env, "ADMIN_SESSION_SECRET");

  const rateLimitSecret = requireStrongSecret(errors, env, "RATE_LIMIT_KEY_SECRET");
  if (rateLimitSecret === EXAMPLE_RATE_LIMIT_SECRET) {
    errors.push("RATE_LIMIT_KEY_SECRET must not use the example value");
  }

  const internalSecret = trimmed(env, "INTERNAL_API_SECRET");
  const cronSecret = trimmed(env, "CRON_SECRET");
  if (!internalSecret && !cronSecret) {
    errors.push("INTERNAL_API_SECRET or CRON_SECRET is required for housekeeping endpoints");
  }

  const paymentProvider = requireValue(errors, env, "PAYMENT_PROVIDER");
  if (paymentProvider === "fake") {
    if (trimmed(env, "ALLOW_FAKE_PAYMENTS_IN_PRODUCTION") !== "true") {
      errors.push("PAYMENT_PROVIDER=fake requires ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true on Vercel previews");
    }
    requireStrongSecret(errors, env, "FAKE_PSP_WEBHOOK_SECRET", 16);
  } else if (paymentProvider === "charipay") {
    const providerEnv = requireValue(errors, env, "CHARIPAY_ENV");
    requireValue(errors, env, "CHARIPAY_API_KEY");
    requireValue(errors, env, "CHARIPAY_WEBHOOK_SECRET");
    requireHttpsOrigin(errors, env, "ONLYLIVE_PUBLIC_URL");
    if (vercelEnv === "production") {
      if (providerEnv !== "live") errors.push('Vercel Production requires CHARIPAY_ENV="live"');
      if (trimmed(env, "CHARIPAY_PROVIDER_VERIFIED") !== "true") {
        errors.push("Vercel Production ChariPay requires CHARIPAY_PROVIDER_VERIFIED=true");
      }
      if (cronSecret.length < 16) {
        errors.push("Vercel Production ChariPay requires CRON_SECRET with at least 16 characters");
      }
    } else if (providerEnv !== "sandbox") {
      errors.push('Vercel Preview ChariPay requires CHARIPAY_ENV="sandbox"');
    }
  } else if (paymentProvider) {
    errors.push(`Unsupported PAYMENT_PROVIDER: ${paymentProvider}`);
  }

  const emailProvider = trimmed(env, "EMAIL_PROVIDER") || "console";
  if (emailProvider === "console") {
    if (trimmed(env, "ALLOW_CONSOLE_EMAIL_IN_PRODUCTION") !== "true") {
      errors.push("EMAIL_PROVIDER=console requires ALLOW_CONSOLE_EMAIL_IN_PRODUCTION=true on Vercel previews");
    }
  } else if (emailProvider === "resend") {
    requireValue(errors, env, "RESEND_API_KEY");
    const from = requireValue(errors, env, "RESEND_FROM_EMAIL");
    if (from.toLowerCase().endsWith("@resend.dev")) {
      requireValue(errors, env, "RESEND_TEST_RECIPIENT");
    }
  } else {
    errors.push(`Unsupported EMAIL_PROVIDER: ${emailProvider}`);
  }

  return errors;
}

export function assertDeploymentEnv(env: DeployEnv = process.env): void {
  const errors = deploymentEnvErrors(env);
  if (errors.length > 0) {
    throw new Error(`Invalid Vercel deployment configuration:\n- ${errors.join("\n- ")}`);
  }
}
