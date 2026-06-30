# Template-Var Hoist (rescue a facet-key `{{var}}` from a subquery) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a dashboard `{{var}}` predicate the post-aggregation fold pushed into a `SubquerySource` filters on an **exposed facet key**, hoist it to the outer `WHERE` (where NR's interpolator substitutes it) instead of failing loud — upgrading those `template_var_in_subquery` cases from `unsupported` to a faithful widget-renderable query.

**Architecture:** PR #97 (`feat/render-fails-template-var`) added `detectTemplateVarInSubquery` (last optimizer pass) that marks **every** `{{var}}`-in-a-subquery as `unsupported`. This adds the deferred hoist its own comment names: filtering by a grouping key commutes with aggregation, so a `<facetKey> = {{var}}` predicate can move from the inner `WHERE` to the outer `WHERE` and stay faithful. A `{{var}}` on a non-facet field (or anywhere else in the inner) still can't move → stays `unsupported`.

**Source spec:** `docs/superpowers/specs/2026-06-27-render-fails-design.md` (Sub-problem 2 / Open Q2 — the hoist deferred from PR 2). This is the fold-coupled follow-up, now unblocked (`foldPostAggregationPass` is on master).

**Branch strategy (git-town):** `feat/render-fails-var-hoist`, **parent `feat/render-fails-template-var`** (#97) — it modifies #97's `detectTemplateVarInSubquery`. `git config git-town-branch.feat/render-fails-var-hoist.parent feat/render-fails-template-var` (+ `.branchtype feature`); headless PR via `gh pr create --base feat/render-fails-template-var`. One commit → one PR.

## Global Constraints

- **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (tests AND commit).
- Conventional commits, lowercase subject ≤72 chars, body ≤100. `git push origin HEAD`.
- **Loud failure over silent-wrong:** a `{{var}}` that can't hoist stays `unsupported` (never emit a query with a `{{var}}` still inside a `FROM (…)`).
- Messages in `src/messages.js`; `warningFunc`/`unsupportedFunc` arrays exhaustive. New key → `test/messages.test.js` reference.
- New/changed cases: `verified: false`.
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`.
- No `build:parsers`. Fuzz ×20. `git add docs/SPL_TO_NRQL.md` after green.

## Engine-Grounded Facts (verified on `feat/render-fails-template-var`, 2026-06-30)

- `detectTemplateVarInSubquery(ir)` is the **last** pass in `optimize.js`; today: `if (hasTemplateVarInSubquery(ir)) ir.unsupported.push(messages.template_var_in_subquery())`.
- `hasTemplateVar(node)` (exists) — true if any `Identifier` with `name` starting `{{` or any `Like` with `pattern` starting `{{` sits under `node`. `hasTemplateVarInSubquery(ir)` (exists) — true if a `{{var}}` sits inside any `SubquerySource.query`.
- Fold shape for `host="$host$" | stats count by host | where count > 5`: `ir.dataSource` is a `SubquerySource` whose `.query` has `where: [host = {{host}}]`, `facet: [Identifier('host')]`, `select: [count(*)]`; the top-level `ir.where` holds the post-agg `[numeric(count) > 5]`. The `{{var}}` predicate is `BinOp('=', Identifier('host'), Identifier('{{host}}'))` (the flat case emits `WHERE host = {{host}}`). **Confirm the exact node shape via a quick inspection in Step 1** before finalizing `fieldNameOf`.
- A facet-key filter commutes with aggregation: counting all hosts then keeping `host = {{host}}` ≡ pre-filtering to that host — faithful **except past the 5000-group subquery cap** (above that the filtered group may be dropped) → warn.
- Verified current behavior (both `unsupported` today): `host="$host$" | stats count by host | where count > 5` (hoistable — host is the facet key); `region="$region$" | stats count by host | where count > 5` (not hoistable — region isn't faceted).

## File Structure

- **Modify:** `src/ir/optimize.js` — `detectTemplateVarInSubquery` attempts the hoist before the `unsupported`; add `hoistFacetKeyTemplateVars` + a `fieldNameOf` helper.
- **Modify:** `src/messages.js` — add `template_var_hoisted`.
- **Tests:** `test/spl/spl.test.js` (hoist case + non-hoistable regression + a no-subquery regression), `test/messages.test.js`, `docs/SPL_TO_NRQL.md` (regen).

---

### Task 1: Hoist a facet-key `{{var}}` predicate out of the subquery

**Commit:** `feat: hoist a facet-key template-var filter out of a subquery`

**Files:** `packages/nr-query-bridge/src/ir/optimize.js`, `src/messages.js`, `test/spl/spl.test.js`, `test/messages.test.js`, `docs/SPL_TO_NRQL.md`.

- [ ] **Step 1: Confirm the `{{var}}` predicate node shape.** `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'host="$host$" | stats count by host'` → `WHERE host = {{host}}` (flat). Briefly confirm in `src/output/nrql/irToNrql.js` / a console.log spike that the condition is `BinOp('=', Identifier('host'), Identifier('{{host}}'))` so `fieldNameOf` reads `cond.left.name`. (Remove any spike before committing.)

- [ ] **Step 2: Write the failing cases** in `test/spl/spl.test.js` (exact `nrql`/keys confirmed against the runner in Step 6):
```js
// {{var}} on a facet key, stranded in a subquery → hoist to the outer WHERE (faithful).
{ spl: 'host="$host$" | stats count by host | where count > 5',
  nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 5 AND host = {{host}}',
  warningFunc: ['template_var_hoisted'], verified: false, doc: 'render-fails-template-var' },
// {{var}} on a NON-facet field → cannot hoist → stays unsupported (#97 behavior).
{ spl: 'region="$region$" | stats count by host | where count > 5',
  unsupportedFunc: ['template_var_in_subquery'], verified: false, doc: 'render-fails-template-var' },
// Regression: no subquery (flat) → {{var}} already in the only WHERE, untouched.
{ spl: 'host="$host$" | stats count by host',
  nrql: 'FROM Log SELECT count(*) WHERE host = {{host}} FACET host',
  warningFunc: ['facet_default_limit'], verified: false, doc: 'render-fails-template-var' },
```
(Use whatever `doc:` tag the existing template-var cases use — grep `template_var_in_subquery` in `spl.test.js`; match it so the `SPL_TO_NRQL.md` sentinel resolves.)

- [ ] **Step 3: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl` — the hoist case fails (still `unsupported`).

- [ ] **Step 4: Add the message** to `src/messages.js`:
```js
template_var_hoisted: (field) =>
  `hoisted the '${field}' = {{var}} filter out of the subquery to the outer query so the dashboard variable resolves; '${field}' is a grouping key so the filter is faithful, but the inner aggregation is bounded by the 5000-group subquery cap — above that, the filtered group may be dropped`,
```

- [ ] **Step 5: Implement the hoist** in `src/ir/optimize.js`. Replace `detectTemplateVarInSubquery` and add the helpers:
```js
// Field a simple predicate filters on (the side that is NOT the {{var}}): a BinOp's
// left Identifier, or a Like's field. null when the shape isn't a simple field filter.
function fieldNameOf(cond) {
  if (cond?.type === 'BinOp' && cond.left?.type === 'Identifier') return cond.left.name;
  if (cond?.type === 'Like') {
    return cond.field?.type === 'Identifier' ? cond.field.name : cond.field ?? null;
  }
  return null;
}

// Rescue hoistable {{var}} predicates from the TOP-LEVEL subquery: a {{var}} filter
// whose field is an exposed inner facet key commutes with the aggregation, so it can
// move to the outer ir.where (where NR substitutes {{var}}). Deeper-nested subqueries
// and non-facet fields are left in place (→ still unsupported below).
function hoistFacetKeyTemplateVars(ir) {
  const ds = ir.dataSource;
  if (ds?.type !== 'SubquerySource' || !ds.query) return;
  const inner = ds.query;
  const facetNames = new Set(
    inner.facet.filter((f) => f.type === 'Identifier').map((f) => f.name),
  );
  const kept = [];
  for (const cond of inner.where) {
    const field = fieldNameOf(cond);
    if (hasTemplateVar(cond) && field && facetNames.has(field)) {
      ir.where.push(cond); // hoist to the outer WHERE — interpolator substitutes here
      ir.warnings.push(messages.template_var_hoisted(field));
    } else {
      kept.push(cond);
    }
  }
  inner.where = kept;
}

function detectTemplateVarInSubquery(ir) {
  if (!hasTemplateVarInSubquery(ir)) return ir;
  hoistFacetKeyTemplateVars(ir); // rescue what we can…
  if (hasTemplateVarInSubquery(ir)) {
    // …anything still stranded (non-facet field, deeper subquery, {{var}} outside a
    // simple WHERE predicate) has no faithful form → loud.
    ir.unsupported.push(messages.template_var_in_subquery());
  }
  return ir;
}
```

- [ ] **Step 6: Run, confirm green.** `… -- spl`, then the whole package. Adjust the case arrays to exactly what fires (the hoist case should carry only `template_var_hoisted`; confirm `facet_default_limit` does NOT co-fire — the inner has `LIMIT MAX` and the outer isn't faceted).

- [ ] **Step 7: messages.test reference** for `template_var_hoisted`.

- [ ] **Step 8: Fuzz ×20** — `cd packages/nr-query-bridge && for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npx vitest run spl-fuzz || break; done`.

- [ ] **Step 9: `git add docs/SPL_TO_NRQL.md`** (regenerated by Step 6).

- [ ] **Step 10: Commit** (`ASDF_NODEJS_VERSION=24.14.0 git commit -F <msgfile>`), `git push origin HEAD`. Do NOT merge.

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace green (translator + new cases; importer unaffected — a hoisted query is now a real widget instead of a placeholder, an upgrade).
- [ ] `npm run lint && npm run types:check` — clean.
- [ ] Fuzz ×20 green.
- [ ] CLI spot-checks: hoist case → `FROM (…) SELECT * WHERE … AND host = {{host}}` (no `{{var}}` inside `FROM (…)`); non-facet case → `unsupported`; flat case → unchanged.
- [ ] **Widget-layer validation (per `project_nr_widget_engine_stricter`):** these are render-fail fixes, so confirm the hoisted query renders via a `dashboardCreate` + open-the-widget check on staging — `{{host}}` in the outer WHERE substitutes and the widget renders (the whole point). NRDB/NerdGraph accept both forms, so an `execute_nrql_query` run does NOT validate the fix.
- [ ] PR body via `write-gooder`; 100–200 words; note it's the deferred hoist from the render-fails spec, child of #97.

## Self-Review (run before requesting review)

1. **Spec coverage:** the facet-key hoist (Open Q2) is implemented; non-facet `{{var}}` stays `unsupported`; flat `{{var}}` untouched.
2. **Loud-failure:** any `{{var}}` still inside a subquery after the hoist attempt → `unsupported`; never emit a stranded `{{var}}`.
3. **Blast-radius:** the hoist only touches the top-level `SubquerySource`'s `{{var}}` facet-key predicates; deeper subqueries, non-facet fields, and non-`{{var}}` conditions are untouched (verified against the non-hoistable + flat regressions).
4. **Faithfulness caveat:** the 5000-group cap edge is surfaced via `template_var_hoisted` (per your sign-off), not silent.
5. **Message consistency:** `template_var_hoisted` referenced in `test/messages.test.js`; the hoist case's `warningFunc` lists exactly it.
6. **Verified levels:** new/changed cases `verified: false`.

## Graduation note (separate, later)

The render-fails spec's PR 5 (graduate) covers all of order-by / select-star / template-var (+ this hoist) together; it lands once the render-fails set is on master, graduating the combined render-fail invariants into `.claude/rules/design-decisions.md`. The widget-renderability lint (spec PR 4) is a separate unbuilt piece, not part of #94.
