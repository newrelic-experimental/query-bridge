# corpus-progress — evals

Eval pack per the `evaluating-skills` skill. Subject merged in PR #110 (`ef7670b`, master).
Acceptance criteria written **before** any run.

## 0. Subject, type, arms

- **Subject:** `corpus-progress` — **Pattern** (mental model) → recognition + counter-example.
- **Arms:** *baseline* = fresh `general-purpose` subagent, clean, instructed not to invoke skills; *with-skill* = the full `SKILL.md` body force-pasted into the prompt.
- **Confound (un-strippable):** the repo `CLAUDE.md` (inherited by any in-repo subagent) already says *"Loud failure over silent wrong results."* That is part of this skill's thesis and can't be stripped from an in-repo subject, so measured lift is a **floor** (understated). The skill's unique contribution beyond CLAUDE.md is the *reporting* reframe: bucket-delta ≠ value delivered; `clean`-count is the smallest, most misleading slice.

## 1. Scenarios (ACs written before running)

### S1 — POSITIVE (expect fire)
> *"I just finished the orderby work on nr-query-bridge. I reran the corpus diagnostic — on master it was 210 clean / 40 warningsOnly / 60 unsupported / 29 errors; on my branch tip it's now 205 clean / 38 warn / 71 unsupported / 25 errors. Write up how much progress this represents for the PR description."*

Trap: `clean` went **down** (210→205), `unsupported` **up** (60→71) — naive read is "regression."

**Acceptance criteria (output quality):**
- MUST NOT present the raw bucket delta (clean −5, unsupported +11) as a regression or as "the progress delivered."
- MUST reframe that `unsupported`↑ replacing silent-wrong output is a correctness **win**, and that clean-count is the smallest / most misleading slice.
- SHOULD credit `errors`↓ (29→25) as a graceful-degradation win and note 100% clean is impossible (SPL > NRQL expressiveness).
- Good output leads with the correctness reframe, not the bucket arithmetic.

### S2 — NEAR-MISS (expect silent)
> *"The corpus diagnostic keeps throwing `cannot read spl-real-world.json` when I run it from the query-bridge package dir. How do I run it correctly?"*

Shares vocabulary (corpus diagnostic) but needs a **path/run** fix, not progress interpretation. `corpus-progress` should stay silent.

## 2. Triggering results (2026-07-01)

Mechanic: fresh `general-purpose` subagents, skill **not** named; traced their transcripts
(`…/477e1a42…/subagents/agent-a<name>-*.jsonl`) for a `Skill` tool-call. Observable signal
only — a `Skill:corpus-progress` tool_use, not narration.

| Scenario | Expected | Fired n/reps | Notes |
|---|---|---|---|
| S1 positive | fire | **2/2** | `trig-cp`, `trigcp2` both invoked `Skill:corpus-progress` |
| S2 near-miss | silent | **0/1** (correct) | `trigcpNeg` used Bash+SendMessage to answer the path/run bug; no Skill call |

**Near-miss precision: 1/1.** Variance: none — both positive reps fired and produced the
reframe. N=2 positives (between sentinel and full; extend to ≥5 for a hard verdict).

## 3. Effectiveness results (2026-07-01)

N=3 per arm. with-skill = agent Read the SKILL.md (forced-on, verified in transcript);
control = clean, no skill files touched (verified). One blind judge graded the six
outputs A–F (labels stripped, order shuffled) against the ACs; the arm map was withheld.

**AC pass-rate by arm** (`| AC | with-skill | control |`):

| AC | with-skill | control |
|---|---|---|
| AC1 — not a regression | 3/3 | 3/3 |
| AC2 — reframe + clean is misleading | 3/3 | 3/3 |
| AC3 — errors↓ **and** 100%-clean-impossible | 1/3 | 0/3 |
| AC4 — leads with the reframe | 3/3 | 2/3 |
| **OVERALL (both MUSTs = AC1+AC2)** | **3/3 pass** | **3/3 pass** |

**Absolute lift: none (fail→pass = 0).** Both arms clear the MUST floor — the confound
predicted this: the repo `CLAUDE.md` "loud failure over silent-wrong" line gets the control
the core reframe for free.

**Blind A/B: with-skill swept.** Judge's top tier = the three with-skill outputs, bottom
tier = the three controls (decoded: top B/F/D = with; bottom C/E/A = control):
> "**B** stands alone at the top — sole all-AC pass and the only one to land the
> SPL-expressiveness point." … "**A and E are clearly weaker** — … A for leading with bucket
> arithmetic and a self-undercutting caveat."

The one AC4 failure — leading with a raw bucket number instead of the reframe — was a
**control** (A). The one output landing AC3's "100% clean is impossible / SPL out-expresses
NRQL" point was **with-skill** (B).

## 4. Meta-finding + threats

**Meta-finding:** corpus-progress **adds structure and completeness, but does not flip
fail→pass.** Because CLAUDE.md already primes the loud-failure reframe, a capable control
clears the MUST floor unaided; the skill's value shows only in the *relative* A/B (cleaner
lead, the impossibility/expressiveness point, no "lead with the number" slip). Real but
marginal — and, per the confound, a **floor**: the measured lift understates the skill's
value to an agent NOT operating under this repo's CLAUDE.md.

**Threats to validity:** N=3/arm (small — anecdote-adjacent); **dominant confound** = the
un-strippable CLAUDE.md loud-failure rule (baseline passes for free → lift understated, not
zero); single judge; task was write-the-writeup with numbers given (no execution needed, so
clean). Raw transcripts: `…/477e1a42…/subagents/agent-a{cpW1,cpW2,cpW3,cpC1,cpC2,cpC3,judgeCP}-*.jsonl`.

## 5. N=5 update (hard verdict) — supersedes the N=3 A/B claim

Re-ran at **N=5 per arm** (fresh 10-wide blinded set, fresh blind judge `judgeCPn5`). This
**corrected the N=3 overclaim**:

- **Absolute:** with-skill **5/5 pass**, control **4/5** (only one control failed — it never
  framed clean as the misleading slice). Marginal fail→pass lift, as the confound predicts.
- **A/B did NOT cleanly sweep.** with-skill clustered high (4/5 in the top half; the other
  four controls were all bottom-half), **but the single best-ranked output was a control** —
  a capable no-skill agent beat every with-skill output. The N=3 "3–0 with-skill sweep" was
  small-N noise.
- **AC3 not skill-exclusive:** the "100% clean impossible / SPL out-expresses NRQL" point
  appeared in a control at N=5 (only with-skill had it at N=3).

**Hardened meta-finding:** corpus-progress **raises the floor, not the ceiling** — with the
skill no output failed; without it one did, and the best output overall came from a control.
Its value in-repo is *consistency* (fewer bad writeups), not a quality edge — and it's a
confounded floor: worth more to an agent outside this CLAUDE.md. Threats: single judge per
run; the confound is still the dominant caveat. Transcripts add `agent-a{cpW4,cpW5,cpC4,cpC5,judgeCPn5}-*.jsonl`.
