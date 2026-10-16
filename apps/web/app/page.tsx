import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Agents } from "@/components/sections/Agents";
import { Keys } from "@/components/sections/Keys";
import { Speed } from "@/components/sections/Speed";
import { Security } from "@/components/sections/Security";
import { Get } from "@/components/sections/Get";
import { Tools } from "@/components/sections/Tools";
import { Exploring } from "@/components/sections/Exploring";
import { Reveal } from "@/components/Reveal";

export default function Home() {
  return (
    <>
      <a className="skip btn white" href="#top">
        Skip to content
      </a>
      <Nav />
      <main id="top">
        <Hero />
        <Agents />
        <Security />
        <Keys />
        <Tools />
        <Speed />
        <Exploring />
        <Get />
      </main>
      <Reveal />
    </>
  );
}
