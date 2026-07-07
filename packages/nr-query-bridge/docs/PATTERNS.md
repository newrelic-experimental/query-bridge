# Textbook Patterns in this Codebase

This translator is a small compiler. It uses the same well-worn techniques a
"real" compiler (gcc, a SQL planner, Babel) uses — just at a scale you can read
in an afternoon. This doc names each classic pattern, points at where it lives,
and explains *why* it's there. Read it alongside `ARCHITECTURE.md` (which gives
the pipeline overview and a worked example).

If you know the CS term already, the "Where it lives" column is your map. If you
don't, each section explains the idea from scratch with a concrete example from
this repo.

---

## 1. Intermediate Representation (IR) — the "narrow waist"

**Where it lives:** `src/ir/nodes.js` (the node constructors), everything under
`src/ir/`.

**The idea.** You have *M* input languages (SPL, Lucene, PromQL, PPL) and *N*
output languages (NRQL, Trino). The naive design writes a direct translator for
every pair — that's *M × N* translators, and every new language multiplies the
work. Instead you define one **language-neutral middle form** (the IR) and write
*M* front-ends (input → IR) plus *N* back-ends (IR → output). Now it's *M + N*.

This is the "narrow waist" or "hourglass" architecture. The IR is the pinch
point everything funnels through. `nodes.js` says it outright:

```js
// Inspired by NRQL's TCompilerExpressionPlan ... but language-neutral —
// can emit to NRQL, Trino SQL, or other targets.
```

**What the IR looks like here.** Plain JS objects with a `type` discriminator —
`Identifier`, `Literal`, `BinOp`, `Func`, `SelectQuery`, `DualCheck`, etc. No
classes, no methods; the `type` string is the contract and functions switch on
it. A `SelectQuery` is the top-level "query plan": it has `select`, `where`,
`facet`, `bindings`, `orderBy`, `limit` — the neutral shape of *any* analytics
query, not tied to SPL's or NRQL's surface syntax.

**Why it matters when you edit.** Adding an SPL command means producing IR, not
NRQL strings. Adding NRQL syntax means consuming IR. The two sides never touch
each other. If you find yourself building NRQL text inside an SPL handler,
you've punched through the waist — stop.

---

## 2. Phased pipeline — separation of concerns

**Where it lives:** `src/translate.js` (orchestrates), stage table in
`ARCHITECTURE.md`.

```
SPL string → [parse] → AST → [translate] → IR → [optimize] → IR → [emit] → NRQL
```

Each arrow is a pure function; each box has exactly one job:

| Stage | Job | Doesn't know about |
|---|---|---|
| Parse | text → syntax tree | NRQL, semantics |
| Translate | AST → IR | text, NRQL syntax |
| Optimize | IR → simpler IR | text, either language's syntax |
| Emit | IR → NRQL text | SPL, how the IR was built |

**Why phases.** Each stage is testable in isolation and replaceable. You can
swap the Peggy parser without touching the emitter. You can add an optimization
pass without understanding SPL. Bugs localize: wrong NRQL text? Look at the
emitter. Wrong query plan? Look at translate/optimize. This is the single
biggest reason the codebase stays tractable.

---

## 3. AST vs IR — two different trees, on purpose

**Where it lives:** AST is produced by `splParser.js` (generated from
`spl.grammar`); IR by `splToIR.js` + the handler files.

Beginners conflate these. They're distinct:

- The **AST** (Abstract Syntax Tree) mirrors the *input grammar*. Its nodes are
  `StatsCommand`, `EvalCommand`, `Comparison`, `BooleanOp` — Splunk-shaped. It
  answers "what did the user type?"
- The **IR** mirrors the *query semantics*. Its nodes are `SelectQuery`,
  `Func('average', …)`, `DualCheck` — target-neutral. It answers "what does the
  query *mean*?"

`splToIR.js` is the bridge (a "front-end" / lowering from surface syntax to
semantics). See the worked example in `ARCHITECTURE.md`: the AST has a
`StatsCommand` with `functions` and `groupBy`; the IR has `select: [Func(...)]`
and `facet: [...]`. Same information, restructured toward the target.

---

## 4. Multi-pass optimizer — small composable passes ("nanopass")

**Where it lives:** `src/ir/optimize.js`.

**The idea.** Rather than one giant "make the IR better" function, you write
many tiny passes that each do *one* transformation, and compose them in
sequence. This is the nanopass philosophy (from compiler research): each pass is
trivial to understand, test, and reorder.

```js
const passes = [
  eliminateDoubleNot,      // Pass 1
  foldConstants,           // Pass 2
  eliminateTautologies,    // Pass 3
  expandDualChecks,        // Pass 4
  foldPostAggregationPass, // Pass 5
  applyFillnull,           // Pass 6
  applyFieldReplacements,  // Pass 7
];

export function optimize(ir) {
  return passes.reduce((node, pass) => pass(node), ir);
}
```

`reduce` is just "run each pass, feeding the output of one into the next." Order
matters (e.g. `expandDualChecks` must run before anything that inspects the
expanded `OR`), which is why the array is explicit and ordered.

Passes 1–3 are **classic peephole optimizations** every compiler textbook lists:

- **Double-NOT elimination** — `NOT NOT x` → `x`.
- **Constant folding** — evaluate arithmetic on literals at compile time:
  `1000 * 60` becomes the literal `60000`, so the query does no runtime math.
- **Tautology/contradiction elimination** — `x AND true` → `x`,
  `x OR false` → `x`. Algebraic simplification of boolean identities.

---

## 5. Bottom-up tree transformation (the visitor / catamorphism)

**Where it lives:** `src/ir/transform.js` — `transformTree(node, fn)`.

**The idea.** Almost every optimizer pass wants to "visit every node and maybe
rewrite it." Writing the recursion by hand in each pass is repetitive and
error-prone. So you write the traversal *once* as a generic walker, and each
pass supplies only the per-node rewrite function `fn`.

`transformTree` walks **bottom-up**: it transforms a node's children first, then
calls `fn` on the rebuilt node. Bottom-up matters — by the time your pass sees a
`BinOp`, its `left`/`right` have already been simplified, so a rule like "fold
`1 * 60`" sees folded operands.

```js
export function transformTree(node, fn) {
  if (!node || typeof node !== 'object') return node;
  const transformed = transformChildren(node, fn); // children first
  return fn(transformed);                           // then this node
}
```

A pass then reads like a single rule (from `eliminateDoubleNot`):

```js
transformTree(ir, (node) => {
  if (node.type === 'Not' && node.child?.type === 'Not') return node.child.child;
  return node; // unchanged
});
```

**Scope boundaries.** `transformChildren` deliberately does **not** recurse into
`SubqueryExpr` / `SubquerySource`. A subquery is an independent query scope — a
pass that wants to optimize inside it must recurse explicitly. This is the
tree-walking equivalent of respecting lexical scope; crossing it blindly would
apply outer-query assumptions to an inner query.

---

## 6. Lowering / desugaring — high-level node → primitive nodes

**Where it lives:** the `DualCheck` node (`nodes.js`) and its expansion pass
`expandDualChecks` in `optimize.js`.

**The idea.** "Desugaring" is representing a convenient high-level construct as a
compact node early, then expanding it into primitive nodes in one dedicated
place later. It keeps the messy expansion logic out of the many sites that
*produce* the construct.

Splunk's `status=500` is ambiguous: `status` might be stored as the string
`"500"` or the number `500`. Correct NRQL has to check both. Rather than emit
that two-armed `OR` at every comparison site, the translator emits one tidy
`DualCheck(field, op, value)` node, and a single pass lowers it:

```js
// status=500  →  status = '500' OR numeric(status) = 500
const strCompare = BinOp(op, field, Literal(String(value.value), 'string'));
const numCompare = BinOp(op, Func('numeric', [field]), value);
const joinOp = op === '=' ? 'OR' : 'AND'; // != must AND both arms
return BinOp(joinOp, strCompare, numCompare);
```

The `= → OR` / `!= → AND` flip is a real correctness subtlety (De Morgan): "not
equal" must fail on *both* representations. Concentrating it in one pass means
there's exactly one place to get it right. The IR you build stays small; the
expanded form only exists after optimization.

---

## 7. Row-wise (scalar) vs aggregate — the operation that names half the file

**Where it lives:** `src/ir/foldPostAggregation.js`; design rules in
`.claude/rules/design-decisions.md` under "IR & Optimization".

This is the row-wise-vs-aggregate distinction, and the subtlest pattern here.

**The distinction.** Operations come in two flavors:

- **Row-wise / scalar** (a.k.a. *per-event*, *projection*, *map*): computed
  independently for each input row. `duration / 1000`, `lower(name)`,
  `concat(a, b)`. One row in → one value out.
- **Aggregate** (a.k.a. *reduction*, *fold*, *group-by*): collapses *many* rows
  into one number per group. `count(*)`, `avg(x)`, `percentile(x, 95)`. Many
  rows in → one value out.

They don't compose freely. NRQL (like SQL) won't let you `SELECT` a bare
event-field next to an aggregate, and it rejects aggregates inside `WHERE`
(there's no `HAVING`). So when SPL chains a row-wise `eval` *after* an
aggregating `stats`, the translator must decide: can this fold into one flat
query, or does it need a subquery?

**The decision (in `foldPostAggregation.js`).** `eval` folds *into* the
aggregation as one flat query **only if** every function is "fold-safe"
(arithmetic + a whitelisted scalar set — `FOLD_SAFE_FUNCS`) **and** it
references no facet key. Otherwise the aggregation stays wrapped in a subquery
and the row-wise `eval` runs on the *outer* query over the already-computed
columns. Example:

- `stats avg(x) by host | eval y = avg_x * 2` → folds flat: `avg` result is a
  scalar within one level, `* 2` is fold-safe. One query.
- `... | eval label = lower(host)` → `lower` is not fold-safe; keep the
  subquery and run `lower` outside.

**Why not just always wrap in a subquery?** Correctness *and* cost — a flat
query is cheaper and clearer, so the translator prefers it when it's legal. This
is exactly what a SQL optimizer does when it decides between a scalar projection
and a nested aggregate.

---

## 8. Generate-naive-then-collapse (a two-phase optimization idiom)

**Where it lives:** `wrapAsSubquery` in `splExprUtils.js` (the naive step) +
`foldPostAggregationPass` in `foldPostAggregation.js` (the collapse step).

**The idea.** It's hard to decide "do I need a subquery here?" at the moment you
process a command — you don't yet know what comes after. A clean trick: have the
handler **always** wrap naively (produce possibly-over-nested IR), then run one
later pass that walks the over-nested chain and rewrites it into the *minimal*
legal form. The ugly intermediate IR is never emitted; only the collapsed
result reaches the printer.

This mirrors how optimizing compilers emit straightforward IR first and let a
later pass clean it up, rather than trying to be clever inline. It keeps each
`handleStats`/`handleEval`/`handleWhere` simple (no look-ahead), and
concentrates all the legality/folding judgment in one auditable pass. Per the
design rules: *"the handlers naive-wrap; this pass owns collapse + legality."*

---

## 9. Context-dependent name resolution (semantic analysis)

**Where it lives:** stats context → `mapFunction` in `splExprUtils.js`; eval
context → the `switch` in `walkEvalExpr` (`evalHandlers.js`).

**The idea.** The *same* surface token can mean different things depending on
where it appears — resolving it is the compiler's "semantic analysis" or "name
binding" step. Here, `sum(x)`:

- In **stats** context (`stats sum(x)`), it's an **aggregation** — reduce many
  rows to a total. Resolved via the `SPL_TO_NRQL_FUNCS` map in `mapFunction`.
- In **eval** context (`eval y = sum(a, b, c)`), it's a **multivalue** function
  — sum values within a *single* event. Resolved in the `walkEvalExpr` switch.

Two separate resolution tables, deliberately. If both contexts shared one table,
`sum` would have to mean one thing. The split is the mechanism that lets one
token be aggregation in one clause and row-wise in another. When you add a
function, ask *which context* first — that tells you which table to edit.

---

## 10. Precedence ladder / precedence climbing (in the grammar)

**Where it lives:** the `u_expr` → `u_add` → … typed ladder in `spl.grammar`;
notes in `design-decisions.md` under "WHERE Comparison RHS" and "Expression
Walking".

**The idea.** A grammar encodes operator precedence as a *ladder* of rules, one
tier per precedence level, each tier calling the next-tighter one. `a + b * c`
parses as `a + (b * c)` because the `*` tier sits below the `+` tier. This is
the standard way parsers get precedence right without ambiguity.

The load-bearing subtlety here: a WHERE comparison parses its right-hand side at
the `u_add` tier, **not** the top `u_expr` tier. Widening it would let
`where a > b AND c < d` greedily swallow the `AND` into the RHS of `>`. Choosing
*which rung* of the ladder a sub-expression starts on is how you control what it
can and can't absorb. The typed nodes it produces (`EvalArith`, `EvalNot`, …)
are then walked by `walkEvalExpr`.

---

## 11. Normalized / canonical forms — kill the null checks

**Where it lives:** `ir.where` as an `IRNode[]`; joined in the emitter.

**The idea.** Pick a single canonical representation so downstream code never
has to branch on shape. `ir.where` is **always a list of conditions**, never a
nullable condition tree. Handlers `push()` conditions onto it; the emitter joins
them with `AND`. An empty list emits no WHERE at all.

The payoff: no `if (ir.where == null)` guards scattered everywhere, no "is this a
single condition or a tree?" branching. Canonical forms trade a tiny bit of
generality for a lot of removed special-casing — the same reason SSA and
conjunctive normal form exist in real compilers.

---

## 12. Soundness over completeness — "unsupported over wrong"

**Where it lives:** everywhere; the `unsupported`/`warnings`/`errors` channels on
the IR; policy in `CLAUDE.md` ("Loud failure over silent wrong results").

**The idea.** A translator is **sound** if everything it emits is correct, and
**complete** if it handles every input. You usually can't have both. This
codebase always chooses soundness: if a construct can't be translated correctly,
it emits `unsupported` — it never emits plausible-but-wrong NRQL.

Concrete rule (from the WHERE-comparison design notes): a comparison whose RHS
uses a NRQL function that isn't yet valid in that position emits `unsupported`
rather than non-compiling NRQL. A user who gets "unsupported" writes the query
by hand; a user who gets silently-wrong data makes a bad decision and never
knows. This is the same principle behind a type checker rejecting a program it
can't prove safe rather than compiling it and hoping.

Note the three channels are distinct: **errors** and **unsupported** mean *no
NRQL is returned*; **warnings** mean *NRQL is returned but with a caveat*
(usually a precision loss). Don't route a "we produced wrong output" case
through `warnings`.

---

## 13. Code generation with boundary escaping (the back-end)

**Where it lives:** `src/output/nrql/irToNrql.js` (the emitter) +
`src/output/nrql/nrqlEncoding.js` (escaping).

**The idea.** The emitter is a **pretty-printer / unparser**: a recursive
`switch (node.type)` that turns each IR node into target text. It's the mirror
image of the parser.

```js
switch (node.type) {
  case 'Identifier': ...
  case 'Literal': ...
  case 'BinOp': ...
  case 'Function': ...
  // one arm per node type
}
```

Crucially, a code generator must **escape** values for the target syntax — the
same discipline as parameterized SQL or HTML-escaping. All escaping funnels
through `nrqlEncoding.js`:

- `escapeAttributeNameForNrql` — backtick-escape identifiers with dots/dashes/etc.
- `escapeStringLiteralForNrql` — single-quote-escape string literals.
- `escapeStringWildcardForNrql` — percent-escape `LIKE` patterns.

This isn't just cosmetics: user input flows into NRQL, so string concatenation
would be an **injection** vector. The project security rule is explicit — NRQL is
built through these encoders, never by hand-splicing strings.

---

## 14. Substitution hygiene — scope the rewrite, don't capture

**Where it lives:** `applyFieldReplacements` in `optimize.js`.

**The idea.** When you substitute names (like macro expansion), you must be
careful *where* you substitute, or you corrupt things that merely share a name.
`applyFieldReplacements` deliberately rewrites field names only in
`select`/`where`/`facet`/`orderBy` — the positions that refer to output columns
— and **not** in `bindings`/`dataSource`, because those define the source
expressions a replacement would corrupt.

This is the same concern as *hygienic macros*: a rename must not accidentally
capture or clobber an unrelated binding. Getting the scope of a substitution
right is a recurring source of subtle bugs; the pass encodes the safe scope
once.

---

## 15. The seam pattern, again, for dashboards (`DashboardModel`)

**Where it lives:** `packages/nr-dashboard-importer/` — `DashboardModel`; rules
in `design-decisions.md` under "Dashboard Importer".

The dashboard importer is a second hourglass (the IR pattern above), one level
up. Two parsers (Splunk Simple XML, Splunk Studio JSON) both produce a neutral
`DashboardModel`; the emitter consumes it. Today there's one emitter (Terraform),
but the model is deliberately emitter-agnostic — the design admits NerdGraph and
UI-paste back-ends without touching the parsers. No stage below the parsers
branches on the source format — the neutral `vizType` enum is the contract.
Adding a visualization type touches one map on each side, never the pipeline in
between. Same *M + N* win as the query IR, applied to whole dashboards, and it
reuses the query translator as a black box (the one-way dependency: importer →
translator, never the reverse).

---

## How these fit together (one sentence each)

1. **IR** — one neutral middle form so it's *M + N* translators, not *M × N*.
2. **Phases** — parse/translate/optimize/emit each do one job, testable alone.
3. **AST vs IR** — syntax tree vs meaning tree; `splToIR` bridges them.
4. **Nanopass optimizer** — many tiny ordered passes, composed with `reduce`.
5. **`transformTree`** — write the traversal once; passes supply one rule.
6. **DualCheck lowering** — one compact node, expanded in one place.
7. **Row-wise vs aggregate** — the fold-or-subquery decision.
8. **Naive-then-collapse** — handlers over-wrap; one pass minimizes.
9. **Context resolution** — `sum` is aggregation or multivalue by clause.
10. **Precedence ladder** — grammar tiers; pick the rung to control absorption.
11. **Canonical WHERE list** — no nullable-tree branching.
12. **Soundness** — `unsupported`, never wrong.
13. **Emitter + escaping** — recursive unparser; all escaping in one module.
14. **Substitution hygiene** — scope the rename to output positions only.
15. **DashboardModel seam** — the same hourglass for whole dashboards.
