import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import type { EmailProvider } from "@/lib/email/provider";

export function getEmailProvider(): EmailProvider {
  const provider = process.env.EMAIL_PROVIDER ?? "console";

  switch (provider) {
    case "console":
      return new ConsoleEmailProvider();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${provider}. Only "console" is implemented so far.`);
  }
}
