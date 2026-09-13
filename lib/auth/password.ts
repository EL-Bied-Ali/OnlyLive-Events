import { hash, verify, type Options } from "@node-rs/argon2";

// Algorithm 2 = Argon2id (the package's `Algorithm` is a `const enum`,
// which can't be imported under Next.js's isolatedModules compilation).
const HASH_OPTIONS: Options = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export function verifyPassword(hashed: string, password: string): Promise<boolean> {
  return verify(hashed, password, HASH_OPTIONS);
}
