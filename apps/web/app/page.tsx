import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Ticker } from "@/components/Ticker";
import { AppShot } from "@/components/AppShot";
import { Agents } from "@/components/sections/Agents";
import { Security } from "@/components/sections/Security";
import { Keys } from "@/components/sections/Keys";
import { Footer } from "@/components/Footer";

/** The page (2026-10-16: agent first, then security, then ⌘K). */
export default function Home() {
  return (
    <>
      <a className="skip btn ink" href="#top">
        Skip to content
      </a>
      <Nav />
      <main className="sheet" id="top">
        <Hero />
        <Ticker />
        <AppShot />
        <Agents />
        <Security />
        <Keys />
        <Footer />
      </main>
    </>
  );
}
