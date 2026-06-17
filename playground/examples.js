// docs/playground/examples.js
// The 10 curated SPL→NRQL demo queries. Single source of truth for the
// playground examples rail AND test/playground/examples.test.js.
// Ordered: breadth → benefits → drawbacks → failures.

export const EXAMPLES = [
  {
    label: '1. Filter + aggregation',
    spl: 'index=web status=500 | stats count by host',
  },
  {
    label: '2. Time series',
    spl: 'sourcetype=access_* | timechart span=1h count by status',
  },
  {
    label: '3. Regex extraction',
    spl: '* | rex field=message "user=(?<username>\\w+) status=(?<code>\\d+)" | stats count by username, code',
  },
  {
    label: '4. Conditional counting',
    spl: '* | stats count(eval(status>=400)) as errors, count(eval(status<400)) as ok',
  },
  {
    label: '5. eventstats → JOIN',
    spl: '* | eventstats count by host | where count > 100',
  },
  {
    label: '6. append → filter()',
    spl: 'index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]',
  },
  {
    label: '7. Unsupported: transaction',
    spl: '* | transaction clientip maxspan=10m | stats avg(duration)',
  },
  {
    label: '8. Semantic-divergence warning',
    spl: '* | top 5 status by host',
  },
  {
    label: '9. Unsupported: mvexpand',
    spl: 'index=main | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms',
  },
  {
    label: '10. Unsupported: mvcombine',
    spl: '* | mvcombine delim="," values',
  },
];
