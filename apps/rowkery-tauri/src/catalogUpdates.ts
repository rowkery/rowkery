import type { SchemaCatalog } from "./types";

/**
 * What core says about a window answered from the catalog cache, once its
 * session opened (bridge `CatalogUpdate`, the `catalog-update` event).
 */
export type CatalogUpdate =
  | { kind: "confirmed"; window_id: string; open_seq: number }
  | {
      kind: "replaced";
      window_id: string;
      open_seq: number;
      catalog: SchemaCatalog;
      server_version: string | null;
    }
  | { kind: "failed"; window_id: string; open_seq: number; error: string };

/**
 * Matches updates to the open they belong to. An update can arrive before
 * the `open_window` reply it follows (events and replies travel separately),
 * so it waits; an update for an older open of the window is dropped.
 */
export class CatalogUpdates {
  private expected = new Map<string, number>();
  private early = new Map<string, CatalogUpdate>();

  /** A reply from the cache landed: returns an update that was already waiting for it. */
  expect(windowId: string, openSeq: number): CatalogUpdate | null {
    this.expected.set(windowId, openSeq);
    const waiting = this.early.get(windowId);
    this.early.delete(windowId);
    return waiting && waiting.open_seq === openSeq ? waiting : null;
  }

  /** The window was re-pointed or closed: nothing pending for it applies. */
  forget(windowId: string) {
    this.expected.delete(windowId);
    this.early.delete(windowId);
  }

  /** An update arrived: returns it when it is for the window's current open. */
  receive(update: CatalogUpdate): CatalogUpdate | null {
    const want = this.expected.get(update.window_id);
    if (want === update.open_seq) {
      this.expected.delete(update.window_id);
      return update;
    }
    // Ahead of its reply: keep it (the newest) until `expect`.
    if (want === undefined || update.open_seq > want) this.early.set(update.window_id, update);
    return null;
  }
}
