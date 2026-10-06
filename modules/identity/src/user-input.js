// What a new account must look like. Both identity services (in-memory and PostgreSQL) use this, so they accept and refuse the same input.
export const MINIMUM_PASSWORD_LENGTH = 12;
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,128}$/;       // checked after trimming and lower-casing; the sign-up form uses the same rule
export const DISPLAY_NAME_MAX_LENGTH = 200;

// Returns the cleaned identity, or throws USER_INVALID. Anything that is not a string (a missing or null field, a number, an object) is invalid.
export function cleanUserIdentity({ username, displayName }) {
  if (typeof username !== 'string' || typeof displayName !== 'string') throw new Error('USER_INVALID');
  const trimmedName = username.trim(), normalized = trimmedName.toLowerCase(), shownAs = displayName.trim();
  if (!USERNAME_PATTERN.test(normalized) || !shownAs || shownAs.length > DISPLAY_NAME_MAX_LENGTH) throw new Error('USER_INVALID');
  return { username: trimmedName, normalized, displayName: shownAs };
}
export const passwordAcceptable = password => typeof password === 'string' && password.length >= MINIMUM_PASSWORD_LENGTH;
