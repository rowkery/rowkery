import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Ticker } from "@/components/Ticker";
import { AppShot } from "@/components/AppShot";
import { Agents } from "@/components/sections/Agents";
import { Security } from "@/components/sections/Security";
import { Keys } from "@/components/sections/Keys";
import { Databases } from "@/components/sections/Databases";
import { Faq, Note } from "@/components/sections/Faq";
import { Get } from "@/components/sections/Get";
import { Follow } from "@/components/sections/Follow";
import { Rookery } from "@/components/sections/Rookery";
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
        <Databases />
        <Note />
        <Faq />
        <Get />
        <Follow />
        <Rookery />
        <Footer />
      </main>
    </>
  );
}
