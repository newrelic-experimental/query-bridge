/**
 * Splunk strftime/strptime `%`-format → Java DateTimeFormatter pattern.
 *
 * NRQL's toDatetime()/toTimestamp() take Java DateTimeFormatter patterns, not C
 * strftime %-codes, so we map the codes. The mapping table below is verified on
 * NR staging acct 1 (2026-06-27/28). The sub-second %N-family and %% are handled
 * in code, not in the table.
 */

// Splunk %-code → Java pattern letters (sub-second %N-family + %% handled below).
const SPL_TO_JAVA = {
  Y: 'yyyy',
  y: 'yy',
  m: 'MM',
  d: 'dd',
  j: 'DDD',
  b: 'MMM',
  h: 'MMM',
  B: 'MMMM',
  Z: 'zzz',
  H: 'HH',
  I: 'hh',
  M: 'mm',
  S: 'ss',
  p: 'a',
  a: 'EEE',
  A: 'EEEE',
  z: 'Z',
};

/**
 * Convert a Splunk strftime `%`-format string to a Java DateTimeFormatter pattern.
 *
 * @param {string} fmt - the Splunk format (e.g. `"%Y-%m-%d %H:%M:%S"`)
 * @returns {{ pattern: string, unmappable: string[] }} `pattern` is the Java
 *   DateTimeFormatter string (literal letters quoted); `unmappable` lists every
 *   `%`-code with no Java equivalent (e.g. `['%s','%c']`), empty when all map.
 */
export function splFormatToJava(fmt) {
  const parts = []; // { token } for pattern letters | { literal } for raw text
  const unmappable = [];
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '%') {
      // Sub-second: %3N / %6N / %9N, and bare %N (Splunk default = nanoseconds).
      const sub = fmt.slice(i).match(/^%([369]?)N/);
      if (sub) {
        const w = sub[1];
        parts.push({
          token: w === '3' ? 'SSS' : w === '6' ? 'SSSSSS' : 'SSSSSSSSS',
        });
        i += sub[0].length;
        continue;
      }
      const code = fmt[i + 1];
      if (code === '%') {
        parts.push({ literal: '%' });
        i += 2;
        continue;
      }
      if (code === undefined) {
        parts.push({ literal: '%' });
        i += 1;
        continue;
      }
      const java = SPL_TO_JAVA[code];
      if (java) {
        parts.push({ token: java });
        i += 2;
        continue;
      }
      unmappable.push('%' + code); // omit from the pattern; the caller rejects
      i += 2;
      continue;
    }
    parts.push({ literal: fmt[i] });
    i += 1;
  }

  // Assemble. Tokens emit raw. In literal text, quote each maximal run of
  // pattern-significant chars — letters (DateTimeFormatter reserves a-zA-Z) and
  // '%' (so no bare % survives; a stray % is the silent-garbage signature, e.g.
  // '%Y' renders "%2026") — doubling any embedded ' (Java's literal-quote escape,
  // so o'clock -> 'o''clock'). Whitespace/punctuation pass through bare. (A lone '
  // wedged between two codes is out of scope — no corpus demand.)
  let pattern = '';
  let lit = '';
  const flushLit = () => {
    if (!lit) return;
    pattern += lit.replace(
      /[A-Za-z%']+/g,
      (run) => "'" + run.replace(/'/g, "''") + "'",
    );
    lit = '';
  };
  for (const p of parts) {
    if (p.literal !== undefined) lit += p.literal;
    else {
      flushLit();
      pattern += p.token;
    }
  }
  flushLit();
  return { pattern, unmappable };
}
