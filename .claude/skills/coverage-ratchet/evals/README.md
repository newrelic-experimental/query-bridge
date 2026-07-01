# coverage-ratchet — evals

Eval pack per the `evaluating-skills` skill. Subject merged in PR #110 (`ef7670b`, master).
Acceptance criteria written **before** any run.

## 0. Subject, type, arms

- **Subject:** `coverage-ratchet` — **Technique** (how-to) → application.
- **Arms:** *baseline* = fresh `general-purpose` subagent, clean, instructed not to invoke skills; *with-skill* = the full `SKILL.md` body force-pasted into the prompt.
- **Confound:** none known — the per-file-gate mechanics and v8 function-coverage flapping are not in `CLAUDE.md` or memory, so the baseline is genuinely naive.

## 1. Scenarios (ACs written before running)

### S3 — POSITIVE (expect fire)
> *"Coverage on nr-query-bridge has crept up since we set the floors a while ago. Can you bump the minimum coverage numbers in the vitest configs so the gate reflects where we actually are now?"*

**Acceptance criteria (output quality):**
- MUST measure stability (run coverage **multiple times / 3×**) before raising — v8 function coverage flaps here.
- MUST NOT raise a metric to a value it has been seen to flap at (esp. functions); floor set **under** the stable minimum, with margin.
- SHOULD locate the weakest per-file metric / worst-outlier file rather than bumping globally.
- Good output does NOT read a single coverage run and set floors to those exact numbers.

### S4 — NEAR-MISS (expect silent)
> *"Please add unit tests for `nrqlEncoding.js` — its branch coverage is low and I want it better covered."*

Writing tests to raise one file's coverage, not raising the **gate floors**. `coverage-ratchet` should stay silent.

## 2. Triggering results (2026-07-01)

Mechanic: fresh `general-purpose` subagents, skill **not** named; traced their transcripts
(`…/477e1a42…/subagents/agent-a<name>-*.jsonl`) for a `Skill` tool-call. Observable signal
only — a `Skill:coverage-ratchet` tool_use, not narration.

| Scenario | Expected | Fired n/reps | Notes |
|---|---|---|---|
| S3 positive | fire | **2/2** | `trig-cr`, `trigcr2` both invoked `Skill:coverage-ratchet` |
| S4 near-miss | silent | **0/1** (correct) | `trigcrNeg` went to Bash+Write to add tests; never loaded coverage-ratchet (nor any other skill) |

**Near-miss precision: 1/1.** The near-miss is the sharp one here — S4 shares heavy
vocabulary ("coverage", "branch coverage") yet the skill correctly stayed silent because the
task is *add tests*, not *raise the gate floors*. N=2 positives (extend to ≥5 for a hard
verdict).

## 3. Effectiveness results (2026-07-01)

N=3 per arm. with-skill = agent Read the SKILL.md (forced-on, verified); control = clean, no
skill files touched (verified). Task framed as a **written plan** (explain how you'd raise
each of the 4 metrics) — no live coverage runs, so both arms symmetric and no collision.
One blind judge graded A–F against the ACs; arm map withheld.

**AC pass-rate by arm:**

| AC | with-skill | control |
|---|---|---|
| AC1 — measures stability ≥3× before raising | 3/3 | **2/3** |
| AC2 — doesn't raise a flapped metric; floor under stable min | 3/3 | 3/3 (by letter) |
| AC3 — locates weakest per-file / outlier | 3/3 | 3/3 |
| AC4 — not single-run→exact numbers | 3/3 | 3/3 |
| **OVERALL (MUSTs = AC1+AC2+AC4)** | **3/3 pass** | **2/3 pass** |

**Absolute lift: fail→pass on 1/3 controls.** Control **B failed AC1** — it ran coverage
only twice, to confirm *determinism*:
> "**B FAILS overall.** It runs coverage only 2× and explicitly to prove *determinism*
> ('should be deterministic… confirm it's byte-identical'), which is the exact wrong belief
> for this repo and violates AC1's ≥3× stability requirement."

That is precisely the naive mistake the skill's v8-flap gotcha prevents. No with-skill arm made it.

**Blind A/B: with-skill swept.** Decoded top tier D/F/A = all with-skill; bottom E/C/B = all control:
> "**Clearly strongest: D and F** … both nail the specific v8 function-coverage
> non-determinism (the actual reason a naive bump flakes)… **Middle: E and C** — pass all
> MUSTs but on generic reasoning (fuzz reseed / general v8 wobble) rather than the real
> function-flap gotcha… **Clearly weakest: B.**"

Also telling: control **E "leans toward raising the flappy metric" (proposed importer
functions ~98)** — the exact CI-flake the skill's "never raise a metric you've seen flap"
rule stops. It passed AC2 only by the letter (margin + multi-run), not its spirit.

## 4. Meta-finding + threats

**Meta-finding:** coverage-ratchet delivers **real, unconfounded lift** — it flips fail→pass
(a control asserted v8 determinism + ran 2× = would flake CI) *and* wins the blind A/B 3–0.
The separating factor was the skill's **specific** knowledge (v8 arrow-callback function-count
flap, "hold don't raise a flapped metric"); controls reasoned generically about
non-determinism (fuzz reseed) or actively proposed raising the flappy metric. This is the
opposite profile from corpus-progress: the skill's content isn't in CLAUDE.md, so the naive
baseline genuinely gets it wrong.

**Threats to validity:** N=3/arm (small); single judge; **planning-not-execution** framing —
agents described their approach rather than running coverage 3×, which cleanly isolates the
*judgment* the skill imparts but doesn't test execution mechanics (a real run could surface
issues a plan hides); control E passed AC2 by the letter despite a spirit-violation the judge
flagged. Raw transcripts: `…/477e1a42…/subagents/agent-a{crW1,crW2,crW3,crC1,crC2,crC3,judgeCR}-*.jsonl`.

## REFACTOR surfaced this cycle

The concurrent-probe collision during measurement surfaced a real gap — added a **"never run
`--coverage` concurrently (shared `coverage/.tmp reportsDirectory`)"** gotcha to this skill,
and an **"isolate mutating subjects"** principle to the `evaluating-skills` skill. Both
grounded in the observed failure, not re-tested with a fresh cycle.

## 5. N=5 update (hard verdict) — confirms and strengthens N=3

Re-ran at **N=5 per arm** (fresh 10-wide blinded set, fresh blind judge `judgeCRn5`):

- **Absolute:** with-skill **5/5 pass**, control **4/5** — one control failed AC1 with the
  *identical* mode as N=3 (ran coverage 2×, premised on determinism). The fail→pass lift
  **replicated across independent reps**.
- **A/B: perfect separation** — the judge ranked the **top 5 = all five with-skill, bottom 5
  = all five control**, and named the dividing line itself: **"specific-v8" arrow-callback
  cause (all 5 with-skill) vs "generic/none" (all 5 control).** One control even called
  `functions` "the highest and easiest" — the exact metric the skill flags as flaky.
- **Skill-distinctive knowledge: 5/5 with-skill vs 0/5 control** name the real v8
  function-count flap; controls reason generically (fuzz reseed / quantization) or wrongly.

**Hardened meta-finding:** coverage-ratchet delivers **real, replicated, unconfounded lift**
— it both flips fail→pass (controls periodically assert determinism and under-measure) and
wins the blind A/B cleanly, on the strength of one repo-specific fact controls can't derive.
This is the strong case: a skill carrying non-obvious, load-bearing domain knowledge.
Threats: single judge per run; plan-not-execution framing (isolates judgment, doesn't test a
live run). Transcripts add `agent-a{crW4,crW5,crC4,crC5,judgeCRn5}-*.jsonl`.
