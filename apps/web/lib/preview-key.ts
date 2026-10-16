/**
 * ROWKERY_PREVIEW_KEY: with ROWKERY_COMING_SOON on, the real site is also built at
 * /<key>/ and `?key=<key>` on the coming-soon page goes there. Letters, digits, `-` and `_`
 * only, and nothing else about it is in the build: a wrong key lands on the 404, which is
 * the coming-soon page again. Unset, there is no way in.
 */
const raw = process.env.ROWKERY_PREVIEW_KEY ?? "";
if (raw && !/^[A-Za-z0-9_-]{16,}$/.test(raw)) throw new Error("ROWKERY_PREVIEW_KEY: use 16 or more letters, digits, - or _");
export const PREVIEW_KEY = raw;
