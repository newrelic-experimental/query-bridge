/**
 * Assembles a full NRQL query string from translateSplToNrql() result fragments.
 *
 * Assembly order:
 *   FROM {from|Log} [JOIN ...] [WITH {with}] SELECT {select|*}
 *   [WHERE {where}] [FACET {facet}] [ORDER BY {orderBy}]
 *   [LIMIT {limit}] [SINCE {since}] [UNTIL {until}] [TIMESERIES {timeseries}]
 */
function assembleNrql(r) {
  const parts = [];

  // __none__ means no meaningful output (unsupported command with no translatable content)
  if (r.from === '__none__') return '';
  const from = r.from || 'Log';
  parts.push(`FROM ${from}`);

  // JOIN (appended after FROM)
  if (r.join && r.join.length > 0) {
    for (const j of r.join) {
      // j already has the join type prefix like "INNER (...) ON ..."
      parts.push(`JOIN ${j}`);
    }
  }

  // WITH
  if (r.with && r.with.length > 0) {
    parts.push(`WITH ${r.with.join(', ')}`);
  }

  // SELECT
  const select = r.select && r.select.length > 0 ? r.select.join(', ') : '*';
  parts.push(`SELECT ${select}`);

  // WHERE
  if (r.where) {
    parts.push(`WHERE ${r.where}`);
  }

  // FACET
  if (r.facet && r.facet.length > 0) {
    parts.push(`FACET ${r.facet.join(', ')}`);
  }

  // ORDER BY
  if (r.orderBy && r.orderBy.length > 0) {
    parts.push(`ORDER BY ${r.orderBy.join(', ')}`);
  }

  // LIMIT
  if (r.limit != null) {
    parts.push(`LIMIT ${r.limit}`);
  }

  // SINCE
  if (r.since) {
    parts.push(`SINCE ${r.since}`);
  }

  // UNTIL
  if (r.until) {
    parts.push(`UNTIL ${r.until}`);
  }

  // TIMESERIES
  if (r.timeseries) {
    parts.push(`TIMESERIES ${r.timeseries}`);
  }

  return parts.join(' ');
}

export { assembleNrql };
