import { Dock, Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { AgentScene } from "@/components/story/AgentScene";
import { SecurityScene } from "@/components/story/SecurityScene";
import { KeysScene } from "@/components/story/KeysScene";
import { FreeScene } from "@/components/story/FreeScene";
import { Story } from "@/components/story/Story";
import { Close } from "@/components/Close";
import { More } from "@/components/sections/More";
import { Footer } from "@/components/Footer";

/**
 * The page (2026-10-21, the story mock): Meet Rowkery, then four chapters that play out as you
 * scroll (with your agent, security, on your own, for everyone), Get Rowkery over the colony,
 * connecting your agent with the common questions and the email signup, and the foot (the last
 * two fill the last screen, so nothing from the close rests half under the nav at the end). Every
 * word is in the markup; components/story/engine.ts only moves things.
 */
export default function Home() {
  return (
    <>
      <a className="skip btn ink" href="#top">
        Skip to content
      </a>
      <div className="bg-grid" aria-hidden="true">
        <i />
      </div>
      <Nav />
      <main id="top">
        <Hero />
        <AgentScene />
        <SecurityScene />
        <KeysScene />
        <FreeScene />
        <Close />
        <div className="tail">
          <More />
          <Footer />
        </div>
      </main>
      <Dock />
      <Story />
    </>
  );
}
