/**
 * pg 8.x currently treats sslmode=prefer|require|verify-ca as aliases for
 * verify-full, but pg 9 / pg-connection-string 3 will adopt libpq semantics
 * for those values. Preserve today's certificate + hostname verification
 * explicitly so a future dependency upgrade cannot silently weaken TLS.
 *
 * If an operator has explicitly opted into libpq compatibility with
 * uselibpqcompat=true, leave the URL untouched: that flag is an intentional
 * choice and should not be overridden invisibly here.
 */
export function hardenPostgresSslMode(connectionString: string): string {
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    return connectionString;
  }

  if (/[?&]uselibpqcompat=true(?=&|$)/i.test(connectionString)) {
    return connectionString;
  }

  return connectionString.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/gi,
    "$1verify-full",
  );
}
