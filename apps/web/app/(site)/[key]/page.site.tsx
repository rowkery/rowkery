import { PREVIEW_KEY } from "@/lib/preview-key";

/**
 * The real page at /<ROWKERY_PREVIEW_KEY>/ while ROWKERY_COMING_SOON is on, the one address
 * that shows it; the coming-soon page sends `?key=` there (components/ComingSoon.tsx). With
 * no key set, nothing is built here.
 */
export { default } from "@/app/page";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ key: PREVIEW_KEY }];
}
