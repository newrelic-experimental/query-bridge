<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# LLM Test Verification

How to build confidence that an LLM has produced good tests, and how to protect confirmed tests from being destroyed later.

## 1. Generating New Tests (For New or Existing Code)

When adding tests, start from full branch coverage (every side of every if/else and switch) and condense from there:

1. **Identify all public methods** in the module/class
2. **Add at least one test per public method** for the happy path
3. **Add one test for each side of each branch** (if/else, switch cases, early returns, error paths)
4. **Review for duplication** — some of those test cases will be redundant (e.g., two branches that exercise the same assertion). Remove the duplicates.
5. **Run coverage** to confirm you haven't missed anything obvious

The key is starting from the full coverage case and pruning down, not starting from zero and hoping you covered enough. LLMs tend to write 3 tests and call it done — push for completeness first, then simplify.

## 2. (Expanded) Red-Green-Refactor

LLMs will happily write a failing test, add code that renders the test pointless, then declare success. This is unacceptable; we need a verification cycle.

When writing tests, follow this expanded red-green-refactor cycle to confirm both the test and the code:

1. **Add test** — Write a failing test for the behavior you want
2. **Red** — Run the test, confirm it fails (this proves the test is actually testing something)
3. **Add code** — Write the minimum code to make the test pass
4. **Green** — Run the test, confirm it passes
5. **Remove code** — Delete the code you just wrote
6. **Red** — Run the test, confirm it fails again (this proves the test catches regressions). Try to make _exactly_ one test fail (this proves that you've really disabled the exact code and not something big and fundamental that makes _all_ tests fail)
7. **Re-add code** — Put the code back
8. **Green** — Run the test, confirm it passes again
9. **Refactor** — Clean up the code while keeping the test green

Steps 5-8 are the confirmation cycle. They prove the test is tightly coupled to the behavior, not accidentally passing.

### Mutation testing as a faster alternative to steps 5-8

Steps 5-8 are the right thing to do but they're slow. Mutation testing tools automate exactly that cycle — they introduce small faults (mutants) into your production code and check whether your tests catch them. A surviving mutant means a test isn't actually verifying what it claims to.

If the project's build config includes a mutation testing tool (check for stryker.conf.js, pom.xml pitest plugin, mutmut in pyproject.toml, etc.), **replace steps 5-8** with a targeted mutation run against the production code you just wrote (not the test file). This gives you the same confidence (does the test actually catch regressions?) without the manual delete-and-restore cycle.

This is not a new step — it's a faster way to do a step you're already doing.

**Tools by language:**

| Language | Tool | Notes |
|----------|------|-------|
| Java/JVM | [PIT](https://pitest.org/) | Gold standard. Maven/Gradle integration. |
| JS/TS | [Stryker](https://stryker-mutator.io/) | Supports Jest, Mocha, Vitest, etc. |
| Ruby | [mutant](https://github.com/mbj/mutant) | Works with RSpec and Minitest. |
| Python | [mutmut](https://github.com/boxed/mutmut) | Simpler alternative: [Cosmic Ray](https://cosmic-ray.readthedocs.io/). |
| Go | [gremlins](https://github.com/go-gremlins/gremlins) | Younger ecosystem — evaluate before adopting. |
| Elixir | [mutation](https://github.com/JordiPolo/mutation) | Lightly maintained — evaluate before adopting. |

## 3. Check That the Test Names Match Test Contents

LLMs love to write a test named `it('validates input correctly')` that doesn't actually test validation. The test name is a contract — if the name says it tests X, the assertions must verify X.

When reviewing or writing tests, check that:
- The test name describes the specific behavior being asserted
- The assertions actually verify what the name claims
- A reader who only sees the test name would correctly predict what the test does

## 4. AI-DEV Markers in Tests

Once a test has passed the full red-green-refactor cycle (steps 1-9 above, or a mutation testing run that killed all mutants), add an AI-DEV marker **inside each test** (not just at the file level):

```javascript
it('calculates total correctly', () => {
  // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
  expect(calculateTotal([1, 2, 3])).toBe(6);
});
```

The marker must be inside each individual test so that even LLMs with small context windows see it when working on a specific test.

## 5. Confirmed Tests Must Not Be Modified

LLMs **MUST NOT** modify tests that contain AI-DEV markers. If a confirmed test is failing, the LLM must fix the production code, not the test. The test is the source of truth.

Install the pre-commit hook from the nr-ai-standards repo (.githooks/pre-commit) to block modifications to tests that contain AI-DEV markers.

## 6. Post-Hoc Test Review

After generating tests, re-read the entire test file and check each test against the following criteria (do not skip tests you just wrote):

1. **Do the test names still match the assertions?** LLMs refactor tests and forget to update names.
2. **Are any tests trivially passing?** Look for tests that assert on mock return values, test that `true === true`, or only verify that setup ran (e.g., asserting a mock was called without checking the result of the call). (Mutation testing tools catch this automatically — if you have one set up, run it instead of eyeballing.)
3. **Are any tests duplicates in disguise?** Different names, same assertions, same code path exercised.
4. **Did coverage actually improve?** Run the coverage report before and after. If it didn't move, the tests aren't testing real code paths.
5. **Are the tests testing the code or the mocks?** A test that mocks everything and asserts the mock was called is testing your test setup, not your code.
