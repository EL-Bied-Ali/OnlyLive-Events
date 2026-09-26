import crypto from "node:crypto";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@/lib/email/provider";

/**
 * Sandbox implementation: never sends anything over the network, just
 * logs the message and returns a fake message id. This exercises the
 * idempotency and trigger-wiring logic end-to-end today (mirrors
 * lib/payments/fakeProvider.ts's role for payments) and swaps cleanly for
 * a real provider (Resend/Postmark/SES/...) later.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (input.sensitive) {
      console.log("[email:console] sensitive email dispatched (recipient/subject/body omitted)");
    } else {
      console.log(`[email:console] to=${input.to} subject="${input.subject}"\n${input.text}\n`);
    }
    return { providerMessageId: `console_${crypto.randomUUID()}` };
  }
}
