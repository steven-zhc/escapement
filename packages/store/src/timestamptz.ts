/**
 * Postgres `timestamptz` text → `Date`.
 *
 * The contract maps `at` to `pg/timestamptz-string@1`, so the driver hands back
 * whatever Postgres printed rather than a `Date`. What it prints is *not*
 * ISO 8601:
 *
 *     2026-08-31 18:02:10.201465+00
 *
 * — a space instead of `T`, and a two-digit offset where ISO wants `±HH:MM` or
 * `Z`. Measured against the live database on 2026-08-31.
 *
 * `new Date()` on that string happens to work in V8, which is the trap. It is a
 * non-standard extension, not something the spec promises, and the obvious
 * "fix" of swapping the space for a `T` makes it *worse* — `+00` is then in an
 * ISO-shaped string that is still invalid, and V8 stops guessing and returns
 * `Invalid Date`. Both of those were tried; the second is how this function
 * came to exist.
 *
 * So the offset is normalised explicitly and anything unrecognised throws. A
 * timestamp that cannot be parsed should be loud, not silently `Invalid Date`
 * propagating into a projection.
 */

/**
 * `YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM[:SS]]`
 *
 * Postgres prints the offset with as few components as it can: `+00` for UTC,
 * `+05:30` for India, and `±HH:MM:SS` only for local-mean-time offsets on dates
 * before standard time zones existed — which no row this store writes can have,
 * since `at` defaults to `now()`.
 */
const TIMESTAMPTZ =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

/**
 * A `Date` holds milliseconds; Postgres stores microseconds, so reading an event
 * back truncates `at` by up to 999µs. Acceptable because `at` is not the
 * ordering key — `seq` is. Do not start comparing `at` values for ordering.
 */
export function parseTimestamptz(text: string): Date {
  const m = TIMESTAMPTZ.exec(text);
  if (!m) {
    throw new Error(`not a Postgres timestamptz: ${JSON.stringify(text)}`);
  }
  const [, date, time, sign, hours, minutes] = m;

  // Seconds-of-offset (m[6]) are dropped: `Date` cannot represent them, and they
  // only appear on pre-1900 local-mean-time offsets. Worth knowing about rather
  // than worth handling.
  const iso = `${date}T${time}${sign}${hours}:${minutes ?? "00"}`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`unparseable timestamptz: ${JSON.stringify(text)}`);
  }
  return at;
}
