/**
 * One way to write a quantity, for a product whose whole output is quantities.
 *
 * Byte formatting was implemented three times — the retired run page's `bytesH`,
 * the retired import dialog's `bytesH` and `Composer.formatGiB` — and the two ladders
 * disagreed about their own top step (PiB vs TiB). Nobody would ever see the
 * difference in one screenshot, which is exactly why it drifts: a run detail and
 * an import dialog describing the same object could round it differently.
 *
 * Deliberately NOT collapsed into here:
 *
 * - `LiveTrace.fmtCallMs` suppresses anything under 100 ms because sub-100 ms is
 *   noise between steps and showing it implies a precision the number does not
 *   have once network jitter is in it. That is a different question from "how
 *   long did this turn take", and merging them would silently delete the reason.
 * - `Composer.formatGiB` always says GiB because its sentence compares the file
 *   against a 2 GiB limit; "1843.2 MiB is larger than the 2 GiB limit" is a worse
 *   sentence than the one it replaces.
 */

/** Binary divisors, binary labels — matching what the sidecar reports. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * A byte count as a person reads it.
 *
 * Whole bytes stay whole: "512 B", never "512.0 B". Everything above shows one
 * decimal, which is the precision that distinguishes two buckets without
 * implying the last digit is meaningful.
 */
export function fmtBytes(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${BYTE_UNITS[0]}` : `${v.toFixed(1)} ${BYTE_UNITS[i]}`;
}
