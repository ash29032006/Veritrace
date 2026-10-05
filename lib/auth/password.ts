import bcrypt from "bcryptjs";

/* bcrypt with cost 10. Plain text never reaches the database. */

const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummy: Promise<string> | undefined;

/**
 * Compared against when the username does not exist, so a wrong username
 * takes as long as a wrong password and the response time leaks nothing.
 */
export function dummyHash(): Promise<string> {
  return (dummy ??= bcrypt.hash(bcrypt.genSaltSync(4), COST));
}
