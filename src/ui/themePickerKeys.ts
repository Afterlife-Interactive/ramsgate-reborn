/**
 * Arrow-key movement in the first-run theme list, a grid filled row by row. Returns the new index, or null when
 * the key is not a movement key (so the caller leaves it alone). Moves stop at the edges instead of wrapping.
 */
export function nextThemeIndex(index: number, key: string, count: number, columns: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  let next: number;
  switch (key) {
    case "ArrowLeft":
      next = index - 1;
      break;
    case "ArrowRight":
      next = index + 1;
      break;
    case "ArrowUp":
      next = index - columns;
      break;
    case "ArrowDown":
      next = index + columns;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = last;
      break;
    default:
      return null;
  }
  if (next < 0 || next > last) return index;
  return next;
}
