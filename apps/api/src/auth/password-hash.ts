import * as argon2 from 'argon2';

/**
 * Password hashing parameters, in their own module so services that need to *set* a password
 * (reset, recovery code) do not have to import the whole AuthService and create a cycle.
 * OWASP 2024 minimum for argon2id: 19 MiB, t=2, p=1.
 */
export const PASSWORD_HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};
