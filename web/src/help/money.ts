/** Dollar amounts shown in the help UI: always two decimals. */
export function formatUsd(n: number): string {
  return n.toFixed(2);
}
