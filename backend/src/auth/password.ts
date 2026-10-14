import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt ships with Node, so there is no native module to compile on Windows or on a free host.
const N = 16384, R = 8, P = 1, KEYLEN = 32;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, len, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key))));

/** `scrypt$N$r$p$salt$hash`: the parameters travel with the hash so they can be raised later without breaking old logins. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !hash) return false; // also rejects the Phase 2 dev placeholder
  const params = [n, r, p].map(Number);
  if (params.some((x) => !Number.isInteger(x) || x < 1) || params[0] > 1 << 17) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), params[0], params[1], params[2], expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Spend the same time as a real check, so an unknown email cannot be told apart from a wrong password by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("not-a-real-password");
  await verifyPassword(password, await dummy);
}
