/**
 * SPL time expression parsing.
 *
 * Converts SPL relative-time strings (e.g., '-24h', '@d', '-7d@d')
 * into NRQL SINCE/UNTIL equivalents.
 */

const UNIT_MAP = {
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  M: 'month',
  mon: 'month',
  y: 'year',
};

const SNAP_ONLY_MAP = {
  h: 'this hour',
  d: 'today',
  w: 'this week',
  mon: 'this month',
  q: 'this quarter',
  y: 'this year',
};

const TIME_REGEX = /^(-?)(\d+)(s|m|h|d|w|mon|y)(@[a-z]+)?$/i;
const SNAP_ONLY_REGEX = /^@([a-z]+)$/i;

/**
 * Parse an SPL relative-time string (e.g. `-24h`, `-7d@d`) into NRQL.
 *
 * @param {string} timeStr - The SPL time modifier.
 * @returns {{ nrql: string | null, warning: string | null }} The NRQL time
 *   expression (or null if unparseable) and an optional advisory warning.
 */
export function parseSplTime(timeStr) {
  if (!timeStr) return { nrql: null, warning: null };

  // Strip time alignment suffix (@h, @d, etc.) — NRQL doesn't support time snapping
  // Only strip when there's a relative time before the snap (e.g., -24h@h), not snap-only (@d)
  let strippedSnap = null;
  const alignMatch = timeStr.match(/^(.+?)(@[smhdw])$/i);
  if (alignMatch) {
    strippedSnap = alignMatch[2];
    timeStr = alignMatch[1];
  }

  if (timeStr.toLowerCase() === 'now') {
    return { nrql: null, warning: null };
  }

  const snapMatch = timeStr.match(SNAP_ONLY_REGEX);
  if (snapMatch) {
    const snapUnit = snapMatch[1].toLowerCase();
    const mapped = SNAP_ONLY_MAP[snapUnit];
    if (mapped) return { nrql: mapped, warning: null };
    return {
      nrql: 'today',
      warning: `SPL snap-to time '@${snapUnit}' approximated as 'today'`,
    };
  }

  const match = timeStr.match(TIME_REGEX);
  if (!match) {
    return {
      nrql: null,
      warning: `Unrecognized SPL time expression: ${timeStr}`,
    };
  }

  const [, sign, numStr, unit, snap] = match;
  const num = parseInt(numStr, 10);
  const nrqlUnit = UNIT_MAP[unit.toLowerCase()];

  if (!nrqlUnit) {
    return {
      nrql: null,
      warning: `Unrecognized SPL time unit: ${unit}`,
    };
  }

  const plural = num === 1 ? nrqlUnit : nrqlUnit + 's';
  const direction = sign === '-' ? 'ago' : 'from now';
  const nrql = `${num} ${plural} ${direction}`;

  const effectiveSnap = snap || strippedSnap;
  const warning = effectiveSnap
    ? `SPL snap-to time '${effectiveSnap}' ignored; NRQL SINCE/UNTIL does not support rounding to unit boundaries. Use 'today', 'this week', etc. for snap-only expressions.`
    : null;

  return { nrql, warning };
}
