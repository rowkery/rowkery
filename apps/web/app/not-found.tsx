import type { Metadata } from "next";
import { Pg } from "@/components/Pg";

export const metadata: Metadata = {
  title: "Nothing at this address · Rowkery",
  alternates: { canonical: null },
};

/** The 404 (static export: out/404.html): the penguin Tilted, and the way home. */
export default function NotFound() {
  return (
    <main className="lost wrap" data-not-found>
      <Pg tilted />
      <h1>Nothing at this address</h1>
      <a className="btn ink lg" href="/">
        Back to Rowkery
      </a>
    </main>
  );
}
