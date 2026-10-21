"use client";

import { useEffect } from "react";
import { startStory } from "./engine";

/** Starts the story engine once the page is up, where the page asked for motion (app/layout.tsx). */
export function Story() {
  useEffect(() => (document.documentElement.hasAttribute("data-motion") ? startStory() : undefined), []);
  return null;
}
