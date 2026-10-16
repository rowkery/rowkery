import type { Metadata } from "next";
import { Penguin } from "@/components/Penguin";

export const metadata: Metadata = { title: "Nothing at this address · Rowkery" };

/** The 404 (static export: out/404.html): the penguin Tilted, and the way home. */
export default function NotFound() {
  return (
    <main className="lost wrap" data-not-found>
      <Penguin pose="tilted" size={120} />
      <h1 className="h2">Nothing at this address</h1>
      <a className="btn white big" href="/">
        Back to Rowkery
      </a>
    </main>
  );
}
