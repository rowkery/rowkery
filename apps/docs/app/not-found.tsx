import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { alternates: { canonical: null } };

export default function NotFound() {
  return (
    <>
      <h1>This page isn't here</h1>
      <p className="lead">It may have moved. Search with ⌘K, or start from the introduction.</p>
      <p>
        <Link href="/">Go to the introduction</Link>
      </p>
    </>
  );
}
