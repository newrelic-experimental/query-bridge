# Splunk environment tokens (`$env:…$`) — design

**Date:** 2026-06-27
**Status:** Draft for review. (Brainstorming output — design forks flagged as Open Questions.)
**Scope:** `@newrelic/query-bridge` (translator) + importer variable wiring.
**Source:** `known-issues-laundry-list` row `splunk-env-tokens` (BUG, **High**). Repros 100%
synthetic. Verified `cceb76a`.

## Problem

Splunk's `$env:…$` namespace is **runtime context** — the current app, page, user, locale,
and user-profile fields the Splunk UI injects at render time — **not** a user-defined
dashboard variable. The translator treats it like an ordinary `$tok$` and emits a template
variable:

```
app="$env:app$" | stats count
→ FROM Log SELECT count(*) WHERE app = {{env:app}}
```

`{{env:app}}` does not work — and it fails **harder** than an ordinary undefined variable
(both verified live, staging acct 1, `run_nerdgraph_query`):
1. **The `:` breaks NRQL's `{{…}}` tokenizer.** `WHERE app = {{env:app}}` is a hard parse
   error (`unexpected '…{{env:'`), not a recoverable "undefined variable." (`_`/`.` are valid
   name chars — `{{env_app}}` reaches the later `Found undefined template variable(s)` stage —
   but `:` and `-` do not even tokenize.)
2. **Undefined even if it tokenized** — there is no fieldset/variable backing it.

In `eval`-expression position the problem is different: the eval ladder already rejects **any**
`$token$` (env or not) as `unsupported` (`eval x = $env:user$` → `unsupported: eval expression
not supported` — verified), so eval-position is already loud, not silent-wrong. The real bug is
therefore narrowly **WHERE/value position**.

NR has **no equivalent for Splunk runtime context** (there is no "current logged-in Splunk
user / current app / current page" concept in an NR dashboard widget). Note `$env:app$` is the
current **Splunk application context** — which UI app the dashboard lives in, e.g. `search` (doc:
"Current app context") — **not** an APM service name, so it cannot be massaged to `appName` /
`entity.name`: wrong concept, and the left-hand `app` is the user's own data field, not
necessarily APM `appName`. It is closer to an NR One nerdpack/app container, which is itself not
exposed as a widget token. So `$env:…$` can never become a faithful `{{…}}` variable — it must be
flagged `unsupported`, never emitted as a dead/parse-erroring variable.

**Not env-specific (cross-cutting finding — VERIFIED 2026-06-28).** The `:`/`-` tokenizer
rejection means ANY token name containing `:` or `-` becomes a NRDB parse error when emitted as
`{{name}}`. Confirmed end-to-end: `host="$my-var$"` → the translator emits
`WHERE host = {{my-var}}` (`bin/spl2nrql.js`), and `WHERE hostname = {{my-var}}` is a hard NRDB
parse error (`unexpected '…{{my-'`, acct 1) — the same class as `env:`. The translator's
token-name charset (`design-decisions.md` → Dashboard tokens: "allows `. : - _`") accepts these on
the SPL side, so any hyphenated dashboard variable parse-errors at NRDB. **This is a distinct bug
beyond `env:` — file it as its own laundry-list row** (the importer must sanitize `:`/`-` out of
emitted `{{…}}` names, or unsupport them). This spec fixes only the `env:` case.

## Corpus-observed set (8, per laundry list)

`$env:app$`, `$env:page$`, `$env:user$`, `$env:locale$`, `$env:user_timezone$`,
`$env:user_realname$`, `$env:user_email$`, `$env:is_cloud$`. (Documented Splunk core is
user/page/locale; the corpus shows the set is larger, so detect by the `env:` **namespace
prefix**, not an enumerated allowlist.)

## Goal

Never emit a `{{env:…}}` variable (it is a hard NRDB parse error). Detect the `env:` namespace
in WHERE/value position and flag it `unsupported`, distinct from an ordinary dashboard token.
(Eval-expression position is already `unsupported` — no change needed there.)

## Options (the design fork)

The hard part is that an `$env:…$` is usually a **filter that scopes results** (`app =
$env:app$` = "only the current app"). Two ways to handle a filter we can't reproduce:

**Option A — drop the comparison with a warning (salvage the panel, broadened results).**
`app="$env:app$"` → drop the `app=` predicate, warn that the current-app scoping is lost
(results now span all apps). Salvages the widget but **changes semantics** (broader data).
Acceptable for a dashboard the user will re-scope, dangerous if they don't notice.

**Option B — `unsupported` for the clause/panel (honest, loses the panel).** No faithful
translation exists, so emit a loud placeholder. Safe, but loses a panel that might be 90%
translatable apart from one env-scoped filter.

**Recommended: position-dependent.**
- **Filter/WHERE position:** Option B by default (the scoping is load-bearing; silently
  broadening is silent-wrong). Offer Option A only behind an explicit "drop env filters"
  flag.
- **`eval`/display/string position:** already `unsupported` — the eval ladder rejects any
  `$token$` in expression position (verified). No new handling needed; optionally improve the
  message to name the env token specifically.

Either way: **stop emitting `{{env:…}}` in WHERE/value position.**

## Resolved decisions

1. **Filter-position default → `unsupported` (lose the panel); drop-and-broaden only behind an
   opt-in flag.** Silently broadening data — dropping the `app=$env:app$` scope so results span all
   apps — yields plausible-but-wrong numbers, the worse failure. So the default is a loud
   placeholder. The **"drop env filters" flag** (a CLI/importer opt-in) is Option A for users who
   would rather get a broadened-but-rendering panel they will manually re-scope: its effect is to
   drop the env-scoped predicate and emit a warning, instead of unsupporting.
2. **No `$env:…$` member is faithfully mappable — confirmed via NR docs.** NR dashboards expose no
   widget-level current-user / runtime-context token; template variables filter on metadata and
   cannot carry the viewer's identity into a widget NRQL query (docs.newrelic.com →
   dashboard-template-variables). So `$env:user$` and the rest map to nothing → all `unsupported`.
   Revisit only if NR adds a widget runtime-context token.
3. **Disambiguation — confirmed: key on the `env:` prefix (colon required).** `$env:app$` (runtime
   context) is detected only by the literal `env:` prefix; a plain `$env$` user variable (no colon)
   is never reclassified and translates normally to `{{env}}` (`env` tokenizes fine — no `:`/`-`).

## Behavior (recommended)

- Detect a token whose name begins `env:` (colon required — not a plain `$env$` user variable).
- Filter/WHERE/value position → `unsupported` (`splunk_env_token` message naming the token),
  instead of emitting `{{env:…}}`. Optionally, an opt-in "drop env filters" mode drops the
  predicate + warning (Option A).
- eval-expression position → already `unsupported` (no change); optionally name the env token.
- Ordinary (non-`env:`) tokens are unchanged — scoped strictly to the `env:` namespace.

## Acceptance criteria (synthetic)

- `app="$env:app$" | stats count` → `unsupported` (`splunk_env_token('env:app')`), NOT
  `WHERE app = {{env:app}}`.
- `web_logs | eval label = "user: " . $env:user$` → `unsupported` (already today — any
  `$token$` in eval-expr position is rejected; confirm it stays loud, optionally env-named).
- `app="$env:app$" page="$env:page$"` (multiple) → one `unsupported` (or a warning per token
  under drop mode); no `{{env:…}}` anywhere.
- A normal token `app="$app$"` → unchanged (`app = {{app}}`).

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: WHERE-position `unsupported`, the
no-`{{env:…}}`-leak assertion, the `$env$`-vs-`$env:app$` disambiguation, and the normal-token
regression. Importer integration: an env-token panel becomes a placeholder, never a board with
a parse-erroring `{{env:…}}` variable; regen `GAP_INVENTORY.md`. Fuzz ×20.

## PR breakdown

1. **Detect the `env:` namespace + WHERE-position `unsupported`** (~120 lines, behavior) —
   add a `splunk_env_token` message; in the token/comparison handler, route any `env:`-prefixed
   token in filter position to `unsupported` instead of emitting `{{env:…}}`. Add the
   WHERE-position + normal-token-regression `cases`. This kills the dead-variable emission —
   the core bug. Dependency: none.
2. **(Optional) opt-in drop-filter mode + importer wiring** (~120 lines, behavior) — a flag to
   drop env-scoped predicates (Option A) instead of unsupporting; importer integration test +
   `GAP_INVENTORY.md` regen. Gate on Open Question 1. Dependency: PR 1. (No eval-position PR:
   eval-expr position is already `unsupported`.)
3. **(Optional) graduate** (~30 lines, docs) — promote cases, graduate the invariant, strike
   the laundry-list row. Dependency: PR 1 (+ PR 2 if built) + staging validation.
