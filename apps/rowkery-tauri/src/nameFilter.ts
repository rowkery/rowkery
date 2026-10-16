/**
 * A picker's filter on names: the names containing `query` (any case), the
 * exact name first, then names starting with it, then the rest, each in list
 * order. The cursor goes on the first, so ↵ takes what was typed.
 */
export function filterByName<T>(list: readonly T[], query: string, name: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const rank = (n: string) => (n === q ? 0 : n.startsWith(q) ? 1 : 2);
  return list
    .map((item, i) => ({ item, i, n: name(item).toLowerCase() }))
    .filter((x) => x.n.includes(q))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map((x) => x.item);
}
