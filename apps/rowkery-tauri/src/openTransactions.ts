import { openTransactions, type OpenTransaction } from "./api";
import { showToast } from "./notify";

/**
 * Re-pointing a window (another connection or database, Reconnect) or a new
 * safe mode starts its sessions afresh, which would roll back a transaction
 * open in one of its query tabs. Those are refused while one is, and a toast
 * names the tab.
 */

/** Each window's tab titles by tab id, as its workspace last showed them. */
const titles = new Map<string, Map<number, string>>();

/** A workspace's tabs, so a refusal can name the one in the way. */
export function noteTabTitles(windowId: string, tabs: { id: number; title: string }[]) {
  titles.set(windowId, new Map(tabs.map((t) => [t.id, t.title])));
}

export function forgetTabTitles(windowId: string) {
  titles.delete(windowId);
}

/** The toast for `held` (the tabs in the way), or null when nothing is. */
export function refusalToast(
  held: OpenTransaction[],
  title: (t: OpenTransaction) => string | undefined,
): { message: string; detail: string } | null {
  if (held.length === 0) return null;
  const name = title(held[0]);
  const named = name ? `“${name}”` : "a query tab";
  const more = held.length - 1;
  return {
    message: `A transaction is open in ${named}${more > 0 ? ` and ${more} more ${more === 1 ? "tab" : "tabs"}` : ""}`,
    detail: "COMMIT or ROLLBACK it first",
  };
}

/**
 * Whether a transaction open in one of `windowIds`' tabs is in the way of a
 * switch or a new safe mode; if so, a toast says which.
 * Core not answering lets the change go ahead, as it did before.
 */
export async function transactionInTheWay(windowIds: string[]): Promise<boolean> {
  const held = await openTransactions().catch(() => [] as OpenTransaction[]);
  const toast = refusalToast(
    held.filter((t) => windowIds.includes(t.window_id)),
    (t) => titles.get(t.window_id)?.get(t.tab_id),
  );
  if (toast) showToast(toast.message, toast.detail, "error");
  return !!toast;
}
