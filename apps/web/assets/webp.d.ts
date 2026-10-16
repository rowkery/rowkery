// What a `.webp` import is (the shape Next gives static image imports), so `tsc --noEmit`
// also passes on a fresh checkout, before a build has written next-env.d.ts.
declare module "*.webp" {
  const image: { src: string; width: number; height: number };
  export default image;
}
