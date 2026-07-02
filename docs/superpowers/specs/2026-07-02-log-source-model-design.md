# Log source model — Splunk metadata fields → NR log data model

**Status:** design, awaiting review
**Date:** 2026-07-02

## Problem

SPL queries commonly filter on Splunk's three metadata fields — `index`, `sourcetype`,
and `source`. The translator currently treats them as ordinary NR log attributes:

```
index=web sourcetype=access status=500
  → FROM Log SELECT * WHERE index = 'web' AND sourcetype = 'access' AND status = '500' OR numeric(status) = 500
```

That is wrong as a silent default. In New Relic these fields have no guaranteed attribute
home — their representation is deployment-specific. In Splunk a stream's identity is the
`(index, sourcetype, source)` **combination** (many sources and sourcetypes fan into one
index), and a customer may have carved NR partitions by any of the three or a mix. So the
NR **partition** a query resolves to is a function of that combination, not of `index`
alone. Emitting `WHERE index = 'web'` silently produces a query that returns nothing on a
deployment where the stream was routed to a partition or the field was dropped at ingest.

The translator has no account or schema context, so it cannot know which representation a
given deployment chose. This is the same wall documented for native-JSON access in
`.claude/rules/design-decisions.md`: the deployment-specific truth must be supplied by the
caller.

## Background: the NR log data model (researched facts)

- **Partitions are query targets, not attribute filters, and they are disjoint.** A
  partition is an event type named `Log_<name>` (begins with `Log_`), queried as
  `FROM Log_<name> SELECT …`. A log routed to a partition lives **only** there — `FROM Log`
  returns the unpartitioned (default) logs, **not** a union across partitions. Partitions are
  created out-of-band by a NRQL `WHERE` rule that routes matching logs in — there is no
  automatic mapping from any Splunk field to a partition. The disjointness is why an
  under-specified query against a partitioned deployment cannot fall back to `FROM Log`: the
  data it wants is not there.
- **Partition counts are capped.** Public docs put the ceiling at **100 partitions per
  account**, so a one-partition-per-index rule does not scale to large index estates. The cap
  is an ingested/NRDB constraint; the federated path (Iceberg-backed tables) is not known to
  share it.
- **NRQL queries one partition, a comma-separated list, or the default — but not a wildcard
  or a negation.** `FROM Log_web` and `FROM Log_web, Log_api` (a union) both run (verified on
  staging); `FROM Log_*` is a syntax error. So an `OR`/`IN` over partition-routing *values* IS
  expressible as a comma-list `FROM`; a wildcard or negation over them is not. Partition names
  may contain underscores (live partitions like `Log_AIR_EU` query fine) — the public
  UI-creation rule is stricter than what NRDB will query.
- **Ingested and federated logs share one query surface, with two path caveats.**
  Federated-log partitions are also event types named `Log_<name>` (customer-defined names,
  optionally disambiguated by a setup-name prefix for cross-region), queried through NRQL
  identically to ingested logs. The primary difference is *which* partition names exist and
  how they are spelled — which the translator cannot know. Two secondary differences shape
  which *disposition* is likely correct per path:
    - **Ingested:** ingest-side processing (drop/parse rules) may strip or rename
      `index` / `sourcetype` / `source`, so a plain `WHERE index = …` more often matches
      nothing.
    - **Federated:** the customer controls the source→Iceberg transition, so these fields
      are more likely to survive as queryable attributes — so keeping them in the `WHERE`
      clause is genuinely more often correct there.
  Both point to the same conclusion: the right disposition is deployment- and path-specific,
  so it must come from the caller.
- **`message` is guaranteed present** on every NR log record, so bare-term →
  `message LIKE '%term%'` is safe and unaffected by this work.

## Goals

- Stop silently emitting `WHERE index = …` (etc.) as if these were known attributes.
- Give callers a single, explicit way to declare how `index` / `sourcetype` / `source` map
  into the NR data model, covering both ingested and federated deployments through one
  mechanism.
- Keep the zero-config path working: with no model supplied, produce a valid query and a
  loud warning rather than refusing or guessing structurally.
- Fail loudly (`unsupported`) for shapes that have no faithful NRQL translation.

## Non-goals

- **Generating** a mapping (inventorying a source system's indexes → emitting a model).
  That is a separate future tool; this spec only makes the translator *consume* a model.
- Auto-detecting a deployment's partitions (no schema context).
- Partition-**wildcard** and partition-**negation** support (`index=web*`, `index!=web`) — no
  NRQL equivalent. (Multi-partition `FROM` via `OR`/`IN` *is* in scope — see Guards.)
- Any change to bare-term / `message` handling.
- Ergonomic CLI shorthands (e.g. inline routing rules as flags); the model file expresses
  everything. Sugar can be added later if demand appears.

## Design

### The seam: a caller-supplied `logSourceModel`

`translate(spl, options)` gains an optional `logSourceModel` — an **ordered list of routing
rules** plus a default. Each rule matches on any subset of the `(index, sourcetype, source)`
triple and declares the resulting NR shape:

```js
logSourceModel: {
  routing: [
    { when: { index, sourcetype, source },  // any subset; values are literals or globs
      partition: 'Log_<name>',              // the FROM target
      keep: ['sourcetype', 'source'] },     // predicates emitted as WHERE attributes
    // …evaluated top-to-bottom, first match wins
  ],
  default: { partition: 'Log', keep: ['index', 'sourcetype', 'source'] }, // or the literal 'unsupported'
}
```

A rule matches on the triple (not `index` alone) precisely because the partition is a
function of the combination: a customer may have split one Splunk index's sourcetypes into
several NR partitions, or routed by `sourcetype` regardless of index.

### Resolving a query

The query's metadata predicates (`index=…`, `sourcetype=…`, `source=…`) are collected and
matched against `routing` in order; the first rule whose `when` is fully satisfied wins and
sets:

- **`partition`** → the `FROM Log_<name>` target.
- **`keep`** → which metadata predicates survive as `WHERE <field> = '<value>'`.
- Any field the rule matched on but did **not** `keep` is **consumed** by the routing —
  dropped silently, since it already helped select the partition and re-filtering it is
  redundant (and, on the ingested path where the attribute was stripped, actively wrong).
- A metadata predicate present in the query but neither consumed nor kept is **dropped with
  a warning** (`metadata_field_dropped`) — never silently retained as a filter whose NR fate
  is unknown.

No rule matches → `default` applies. `default` is either a rule (`{ partition, keep }`) or
the literal `'unsupported'`. Because partitions are disjoint from `FROM Log`, a deployment
whose data all lives in partitions must use `'unsupported'` — an under-specified query there
has no correct single `FROM`. A `FROM Log` default is honest only when unpartitioned data
actually lives there.

**Zero-config** (no `logSourceModel`) behaves as an implicit
`default: { partition: 'Log', keep: ['index', 'sourcetype', 'source'] }` **plus a loud
`metadata_field_attribute_default` warning** — today's output, made honest. Reversible, keeps
the CLI working, and guesses nothing structurally.

### The partition relocation

Applying a matched rule's `partition` is a structural relocation in the `splToIR` comparison
handler: the consumed predicates set `ir.dataSource` (`FROM Log_<name>`) instead of pushing
`WHERE` conditions. This mirrors the existing diversion of a `_time`-vs-relative-time
comparison to `ir.since` / `ir.until` rather than a `WHERE` `BinOp` (see
`.claude/rules/design-decisions.md` → "Relative time → SINCE/UNTIL").

Every `partition` name must begin with `Log_` and otherwise contain only characters NRDB
accepts in an event-type name (alphanumerics and underscores — verified against live
partitions such as `Log_AIR_EU`; the public UI-creation rule is stricter than query
acceptance, so we validate against the looser query rule). A violation is a loud error, not
silent-wrong output.

### Multi-value selection and guards

- **`OR` / `IN` over a partition-routing field → union `FROM`.** `index=web OR index=api`,
  where each value resolves through the rules to a partition, emits `FROM Log_web, Log_api`
  (an NRQL comma-list union), routing fields consumed. This is the faithful translation, so it
  is supported — not refused.
- **Mixed / incoherent multi-value → loud `unsupported`.** If the `OR`/`IN` values resolve to
  a mix that cannot form one query — some to a partition and some to the default `FROM Log`,
  or to rules with different `keep` sets — emit `partition_selection_mixed_unsupported`.
- **Wildcard over a partition-routing field → `unsupported`.** `index=web*` would need
  `FROM Log_*` (a syntax error) → `partition_selection_wildcard_unsupported`.
- **Negation over a partition-routing field → `unsupported`.** `index!=web` would need "all
  partitions except one", which the translator cannot enumerate →
  `partition_selection_negation_unsupported`.
- **Under-specified against a partitioned model.** No rule matches and `default` is
  `'unsupported'` → `partition_underspecified_unsupported`, rather than querying `FROM Log`,
  which does not contain the partitioned data. A query naming none of the triple resolves via
  `default` too — so on a fully-partitioned deployment even a bare free-text search is
  `unsupported`, because disjoint partitions cannot be searched without enumerating them.

An `OR` / `IN` / wildcard / negation on a `keep` (attribute) field is unaffected — it stays a
normal `WHERE` `IN` / `LIKE` / `!=`.

### Federated logs

No separate path. Federated partitions are the same `Log_<name>` event types, so a federated
deployment supplies rules whose `partition` values are its real (Iceberg) table names — the
optional cross-region setup-name prefix rides inside the name string. We do not invent NRQL
syntax for cross-region partition addressing, which is not finalized at the platform level.

### CLI surface

Both CLIs read a model file and thread it through unchanged:

```bash
# no model → default (attribute + loud warning)
node bin/spl2nrql.js 'index=web error'

# with a model
node bin/spl2nrql.js --log-source-model ./source-model.json 'index=web error'

# one model applied across every panel of a dashboard import
node bin/spl-dashboard.js --log-source-model ./source-model.json dashboard.xml
```

The file is the `logSourceModel` shape above. The dashboard importer passes it into every
panel's `translate()` call, preserving the one-way importer → translator dependency.

### Worked example

An **ingested** deployment that routes one index's audit sourcetype into a compliance
partition, routes the rest of that index by index, keeps `sourcetype` as a filter there, and
falls back to `FROM Log` for anything unmatched:

```json
{
  "routing": [
    { "when": { "index": "web", "sourcetype": "audit_*" }, "partition": "Log_compliance", "keep": [] },
    { "when": { "index": "web" }, "partition": "Log_web", "keep": ["sourcetype"] },
    { "when": { "index": "api" }, "partition": "Log_api", "keep": [] }
  ],
  "default": { "partition": "Log", "keep": ["index", "sourcetype"] }
}
```

Under that model:

| SPL | NRQL |
|---|---|
| `index=web sourcetype=audit_login error` | `FROM Log_compliance SELECT * WHERE message LIKE '%error%'` |
| `index=web sourcetype=access status=500` | `FROM Log_web SELECT * WHERE sourcetype = 'access' AND status = '500' OR numeric(status) = 500` |
| `index=web OR index=api error` | `FROM Log_web, Log_api SELECT * WHERE message LIKE '%error%'` |
| `index=payments error` | `FROM Log SELECT * WHERE index = 'payments' AND message LIKE '%error%'` |
| `index=web*` | *unsupported* — `partition_selection_wildcard_unsupported` |
| `index!=web` | *unsupported* — `partition_selection_negation_unsupported` |

- **Row 1:** first rule matches (`index=web` + `sourcetype` glob `audit_*`); `keep:[]`
  consumes both → clean `FROM Log_compliance`.
- **Row 2:** first rule fails (sourcetype not `audit_*`), second matches; `index` consumed
  into `Log_web`, `sourcetype` kept as a `WHERE` filter.
- **Row 3:** `OR` over two values that each resolve to a partition → comma-list union
  `FROM Log_web, Log_api`; `index` consumed on both sides. (If `api` had no rule and fell to
  the `FROM Log` default, the mix would be `partition_selection_mixed_unsupported`.)
- **Row 4:** no rule matches → `default`; `index` is emitted as an attribute (the customer
  chose this fallback, so no warning).

A **federated** deployment routes by `sourcetype` (the user's exact case — one index, many
sourcetypes), keeps `source`, and makes anything unmatched loud because all its data lives in
partitions:

```json
{
  "routing": [
    { "when": { "sourcetype": "access_*" }, "partition": "Log_prod_web_us", "keep": ["source"] }
  ],
  "default": "unsupported"
}
```

Here `sourcetype=access_combined source="/var/log/nginx"` → `FROM Log_prod_web_us WHERE
source = '/var/log/nginx'`; a query naming none of the triple → *unsupported*. The translator
neither knows nor cares that `Log_prod_web_us` is Iceberg-backed — only the name differs.

## Messages (new keys in `src/messages.js`)

- **`metadata_field_attribute_default(field)`** (warning) — zero-config only: fires when a
  metadata field is emitted as an attribute under the implicit default (no model). States
  that `index`/`sourcetype`/`source` are Splunk metadata whose NR representation is
  deployment-specific (often a partition, not an attribute), and that a `logSourceModel`
  should be supplied to confirm.
- **`metadata_field_dropped(field)`** (warning) — a metadata predicate present in the query
  was neither consumed by routing nor in the matched rule's `keep`, so it was dropped;
  results may be broader than the SPL. (Warn, not `unsupported`: the drop is visible and the
  query still runs — but it is never silent.)
- **`partition_selection_mixed_unsupported()`** (unsupported) — an `OR`/`IN` over a routing
  field whose values resolve to an incoherent mix (partition + default, or differing `keep`
  sets) that cannot form one query.
- **`partition_selection_wildcard_unsupported()`** (unsupported) — a routing field selected
  by wildcard; NRQL has no `FROM Log_*`.
- **`partition_selection_negation_unsupported()`** (unsupported) — a routing field negated
  (`index!=web`); "all partitions except one" cannot be enumerated.
- **`partition_underspecified_unsupported()`** (unsupported) — no rule matched and `default`
  is `'unsupported'`; the query (including a bare free-text search) cannot be answered from
  `FROM Log`.
- **`partition_name_invalid(name)`** (error) — a rule's `partition` name does not begin with
  `Log_` or contains characters NRDB rejects in an event-type name.

All follow the catalog conventions (keyed functions, JSDoc trigger example, leading
meaningful word). No inline template literals.

## Testing

Data-driven `cases` in `test/spl/spl.test.js`, one scenario per case, with exhaustive
`warningFunc` / `unsupportedFunc` arrays:

- zero-config (no model) → current NRQL + `metadata_field_attribute_default`
- single-field rule → `FROM Log_web …`, routing field consumed (not in `WHERE`)
- multi-field `when` (index + sourcetype glob) → the more specific partition, both consumed
- `keep` field survives as a `WHERE` attribute while the consumed field does not
- present-but-unmatched field → dropped + `metadata_field_dropped`
- no rule matches, `default` is a rule → default partition + kept attributes (no warning)
- no rule matches, `default` is `'unsupported'` → `partition_underspecified_unsupported`
- bare free-text query, `default` is `'unsupported'` → `partition_underspecified_unsupported`
- `OR`/`IN` over a routing field, all values → partitions → union `FROM Log_a, Log_b` (no msg)
- `OR`/`IN` over a routing field, mixed resolution → `partition_selection_mixed_unsupported`
- routing field via wildcard → `partition_selection_wildcard_unsupported`
- routing field negated → `partition_selection_negation_unsupported`
- wildcard/`OR`/negation on a `keep` field → normal `LIKE`/`IN`/`!=` (no unsupported)
- `partition` name with underscores (`Log_AIR_EU`) → valid; missing `Log_` prefix → `partition_name_invalid`

Unit tests for the source-model module (rule normalization, triple matching incl. globs,
partition/keep/consume resolution, name validation) in `test/` mirroring `src/`. Emitted
`FROM Log_<name>` shapes validated via the `validate-test-cases` skill before any `verified`
promotion.

## Out of scope / deferred

- The mapping **generator** (discovery → `model.json`) — separate future tool.
- Partition-**wildcard** and partition-**negation** support (`index=web*`, `index!=web`) — no
  NRQL equivalent. (Multi-partition `FROM` via `OR`/`IN` is in scope, PR 3.)
- CLI shorthand flags — file-only for now.
- Cross-region setup-name partition addressing beyond an opaque `prefix` — platform
  convention not finalized.

## PR breakdown

Ordered, smallest shippable slice first, scaffolding before the behavior that consumes it.
Each layer's new code carries its own tests (per the no-mergey / wire-last rules).

1. **Source-model module (pure, inert) + unit tests.** A new module that parses/normalizes a
   `logSourceModel`, matches a `(index, sourcetype, source)` triple against the ordered rules
   (literal + glob), resolves the winning `{ partition, keep, consumed }` (or `default` /
   `'unsupported'`), and validates each `partition` name against the NR rule (`Log_`-prefixed,
   underscores allowed). Nothing in the pipeline calls it yet. Fully unit-tested in isolation.
   (~200 lines)

2. **Wire single-partition resolution into `splToIR` + message catalog + `spl.test.js` cases.**
   The comparison handler collects the three metadata predicates, asks the module to resolve
   them, then sets `ir.dataSource` from `partition`, emits `keep` fields as `WHERE` attributes,
   drops consumed fields, warns on present-but-unmatched fields; the wildcard / negation /
   under-specified guards emit their `unsupported` messages; the zero-config path emits
   `metadata_field_attribute_default`; invalid names emit the error. Single literal value per
   routing field only (`OR`/`IN` deferred to PR 3). Adds those message keys + the matching
   cases. Depends on PR 1. (~300–400 lines)

3. **Multi-partition `FROM` for `OR`/`IN` over routing fields.** Resolve a multi-valued routing
   predicate to the set of partitions and emit a comma-list `FROM Log_a, Log_b` union; detect
   the incoherent mix and emit `partition_selection_mixed_unsupported`. Adds those two message
   keys/behaviors and the union + mixed `spl.test.js` cases. Isolated from PR 2 because it is
   the one structurally new emission shape. Depends on PR 2. (~150–250 lines)

4. **CLI + dashboard-importer wiring + integration tests.** Add `--log-source-model
   <file.json>` to `spl2nrql.js` and `spl-dashboard.js` (read + parse the file, pass into
   `translate()`); the importer threads one model through every panel. Integration tests
   for file read/parse and end-to-end translation with a model. Depends on PR 3. (~150 lines)

A later, separate spec covers the mapping **generator** — it produces the `model.json` this
work consumes.
