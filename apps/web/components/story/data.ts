/**
 * What the scenes show, shared by the markup (the finished state, which shows without scripts
 * and under Reduce Motion) and the engine (which plays it out as you scroll).
 */

/** The agent's query; a keyword is a one-item array. */
export const AGENT_SQL: (string | [string])[] = [["SELECT"], " email, card_number, total\n", ["FROM"], " orders\n", ["WHERE"], " created_at > now() - interval '7 days';"];

/** card_number in the agent's rows: the real value, then the stand-in the agent gets. */
export const CARDS: [real: string, masked: string][] = [
  ["4242 4242 4242 1881", "masked:7f3a9e01b2"],
  ["5555 4444 3333 1067", "masked:1b06d2c4e8"],
  ["4000 0566 5566 5556", "masked:e94c1150a3"],
];

/** The security card's values that turn into what an agent sees. */
export const SEC = {
  card: ["4242 4242 4242 1881", "masked:7f3a9e01b2"],
  phone: ["+44 7700 900123", "masked:c41d0e77a9"],
  host: ["prd.shop.internal", "prd***.shop.internal"],
  user: ["app_owner", "not shared"],
  password: ["••••••••••••", "not shared"],
} as const satisfies Record<string, readonly [string, string]>;
export type SecKey = keyof typeof SEC;

/** The keyboard scene's chords (the app's own, apps/rowkery-tauri/src/commands.ts): Search, Run statement, Review SQL. */
export const CHORDS: [shift: string, mod: string, key: string][] = [
  ["", "⌘", "K"],
  ["", "⌘", "↵"],
  ["⇧", "⌘", "P"],
];
