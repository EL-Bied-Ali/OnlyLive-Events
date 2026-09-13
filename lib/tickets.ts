import crypto from "node:crypto";
import QRCode from "qrcode";

/**
 * The QR encodes only this opaque, cryptographically random token — never a
 * sequential database id and never any personal data. 24 random bytes
 * (192 bits) makes it computationally infeasible to guess or enumerate.
 */
export function generateValidationToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function ticketQrPayload(validationToken: string): string {
  return validationToken;
}

export async function renderTicketQrDataUrl(validationToken: string): Promise<string> {
  return QRCode.toDataURL(ticketQrPayload(validationToken), { margin: 1, width: 320 });
}
