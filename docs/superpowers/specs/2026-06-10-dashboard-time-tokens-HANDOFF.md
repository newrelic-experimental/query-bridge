# Dashboard Time Tokens — Spec B Handoff (NOT a finished spec)

**Status:** discovery notes for a future brainstorm → spec. This is a HANDOFF, not an approved design. It records what's already verified so spec B doesn't re-derive it, and lists the open questions a brainstorm pass must answer before writing a plan.

**Sibling:** spec A is `docs/superpowers/specs/2026-06-04-where-func-rhs-design.md` (where-clause function RHS, `_time`-only). Spec A deliberately scoped dashboard time tokens OUT (its deferred-gap #6). This is that carved-out work.

## The problem

Splunk dashboard time-range pickers produce tokens — `$tok.earliest$`, `$tok.latest$`, bare `$timespan$` / `$...span$` — used as time bounds:

```
index=web earliest=$time_token.earliest$ latest=$time_token.latest$ | stats count
... | timechart span=$timespan$ count
```

These currently translate WRONG (two distinct bugs, see below). The question spec B must settle: what is the correct behavior — loud `unsupported`, or some deferred-binding form?

## Verified findings (do not re-derive)

**SPL semantics (spl-expert, 2026-06-10):**
- A dashboard time token's value is **resolved only at dashboard-run-time**, after the user interacts with (or defaults) the picker. At static-translation time you have ONLY a placeholder.
- Its **format is unpredictable**: relative picker → relative string (`-24h@h`, with snap); absolute picker → **epoch seconds** (`1717977600`); presets → relative string; "all time" → empty/`0`/`now`. The SAME token can be a relative string OR an epoch number depending purely on picker mode.
- `.earliest`/`.latest` sub-tokens are specific to **time-range inputs** (a picker named `tok` auto-exposes `$tok.earliest$`/`$tok.latest$`). `$timespan$` is a SEPARATE input (text/dropdown) supplying the `span=` argument — a duration like `5m`/`1h`, NOT derived from the picker.
- **Subsearch scoping:** `earliest=`/`latest=` inside `[ search ... ]` apply ONLY to the subsearch; they do not propagate to the outer search. (https://docs.splunk.com/Documentation/SplunkCloud/latest/Search/Aboutsubsearches)

**NRQL constraints (executed via MCP against account 1, 2026-06-10):**
- `SINCE {{myStart}} UNTIL {{myEnd}}` → **FAILURE** `Error ... unexpected '{'`. NRQL has NO template-placeholder syntax in time clauses.
- `SINCE 1717200000000 UNTIL 1717221600000` (epoch MS) → **SUCCESS**.
- `SINCE '2026-06-01 00:00:00' UNTIL '2026-06-01 06:00:00'` (datetime string) → **SUCCESS**.
- `SINCE 7 days ago` → SUCCESS (relative). `SINCE now` → FAILURE (start must precede end).
- So SINCE/UNTIL require a CONCRETE literal: relative `N units ago`, epoch **milliseconds** (note: SPL absolute tokens are epoch **seconds** — unit mismatch), or a datetime string.

**Conclusion the findings point to:** a dashboard time token has no correct *static* NRQL translation — unknown value, unpredictable format, and NRQL won't accept a placeholder. The strong default is loud `unsupported`. Spec B must confirm or refute this against the open questions below.

## The two bugs to fix (located in code)

1. **`TemplateVariable` → SINCE/UNTIL** at `src/input/spl/splToIR.js:329-337`: `$tok.earliest$` sets `since = '{{tok.earliest}}'`, emitter passes `{{...}}` through (`irToNrql.js:150`), producing `SINCE {{tok.earliest}}` — which **does not compile** (verified). Emits broken NRQL.
2. **`earliest=$token$` via `TimeConstraint`** at `src/input/spl/splToIR.js:311-318` → `parseSplTime` (`splTime.js`): the token doesn't match `parseSplTime`'s regexes, returns `{nrql: null, warning: 'Unrecognized SPL time expression'}`, so `since`/`until` is **never set** → query silently uses NRQL's default window (`SINCE 1 hour ago`). **This is the true silent-wrong path** — a valid-looking query bound to the wrong time range. Worst failure class for the project.

## Scope (proposed — confirm in brainstorm)

- IN: dashboard time tokens (`$x.earliest$`, `$x.latest$`, `$...span$`) appearing in time contexts — `earliest=`/`latest=`, the `where _time` path from spec A, and `span=`. Fix both bug paths above. Must respect subsearch scoping (a token bound inside `[...]` binds only that subquery's `since`/`until`, never the outer).
- OUT: non-time template variables (`$x$` as a field value/filter) — those already pass through as `{{x}}` and that's a separate concern.
- DEPENDS ON spec A landing first (shares the `_time` SINCE/UNTIL path it would touch).

## Open questions for the brainstorm (spec B must answer before a plan)

1. **Is `unsupported` the end state, or does deferred binding exist?** Does the NR NRQL gateway (the thing that expands `$macro$` references — see `Macro` case at `splToIR.js:321`) resolve `{{...}}` BEFORE NRQL parsing? If macros are gateway-expanded, maybe time tokens could be too, via a different placeholder the gateway understands. If NOT, `unsupported` is the answer. **This is the load-bearing question** — verify how the gateway treats `$name` vs `{{name}}` before designing.
2. **Unit mismatch:** if any path ever DOES emit a concrete value, SPL absolute tokens are epoch **seconds**, NRQL wants epoch **milliseconds**. But since the value is run-time-only, this likely never arises statically — note and move on.
3. **`$timespan$` → `span=`:** does this map to NRQL `TIMESERIES <n> <unit>`? Different target than SINCE/UNTIL; may be its own sub-case or its own spec.
4. **Loud-unsupported vs warn:** spec A made `_time` snap → (currently) warn, deferred to unsupported. Keep B's token-in-time-context decision consistent with whatever A's snap policy converges to.

## Success metric

Corpus: the silent-wrong default-window queries (path 2 above) stop producing wrong output — they become loud (`unsupported`). Measure how many corpus queries carry `$...earliest$`/`$...latest$`/`$...span$` in a time context (the survey counted hundreds of token occurrences; narrow to time-context ones). `threw` stays 0; no clean query regresses to wrong-but-clean.
