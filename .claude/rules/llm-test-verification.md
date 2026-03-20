# LLM Test Verification

How to build confidence that an LLM has produced good tests, and how to protect confirmed tests from being destroyed later.

## 1. Generating New Tests

When adding tests, start from full C2 code coverage and condense:

1. **Identify all public methods** in the module/class
2. **Add at least one test per public method** for the happy path
3. **Add one test for each side of each branch** (if/else, switch cases, early returns, error paths)
4. **Review for duplication** — some test cases will be redundant (e.g., two branches that exercise the same assertion). Remove the duplicates.
5. **Run coverage** to confirm you haven't missed anything obvious

The key is starting from the full coverage case and pruning down, not starting from zero and hoping you covered enough. LLMs tend to write 3 tests and call it done — push for completeness first, then simplify.

## 2. Expanded Red-Green-Refactor

LLMs will happily write a failing test, add code that renders the test pointless, then declare success. This expanded cycle catches that:

1. **Add test** — Write a failing test for the behavior you want
2. **Red** — Run the test, confirm it fails (proves the test is actually testing something)
3. **Add code** — Write the minimum code to make the test pass
4. **Green** — Run the test, confirm it passes
5. **Remove code** — Delete the code you just wrote
6. **Red** — Run the test, confirm it fails again (proves the test catches regressions). Try to make _exactly_ one test fail (this proves that you've really disabled the exact code and not something big and fundamental that makes _all_ tests fail)
7. **Re-add code** — Put the code back
8. **Green** — Run the test, confirm it passes again
9. **Refactor** — Clean up the code while keeping the test green

Steps 5-8 are the confirmation cycle. They prove the test is tightly coupled to the behavior, not accidentally passing.

## 3. Test Name Verification

LLMs love to write a test named `it('validates input correctly')` that doesn't actually test validation. The test name is a contract — if the name says it tests X, the assertions must verify X.

Check that:
- The test name describes the specific behavior being asserted
- The assertions actually verify what the name claims
- A reader who only sees the test name would correctly predict what the test does

## 4. AI-DEV Markers in Tests

Once a test has been confirmed through the red-green-refactor cycle, add an AI-DEV marker **inside each test** (not just at the file level):

```javascript
it('calculates total correctly', () => {
  // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
  expect(calculateTotal([1, 2, 3])).toBe(6);
});
```

The marker must be inside each individual test so that even LLMs with small context windows see it when working on a specific test.

## 5. Confirmed Tests Must Not Be Modified

LLMs **MUST NOT** modify tests that contain AI-DEV markers. If a confirmed test is failing, the LLM must fix the production code, not the test. The test is the source of truth.

Consider the git pre-commit-hook in the nr-ai-standards repo to help prevent this.

## 6. Post-Hoc Test Review

After the LLM has finished writing tests, review the entire test file with fresh eyes:

1. **Do the test names still match the assertions?** LLMs refactor tests and forget to update names.
2. **Are any tests trivially passing?** Look for tests that assert on mock return values, test that `true === true`, or verify setup rather than behavior.
3. **Are any tests duplicates in disguise?** Different names, same assertions, same code path exercised.
4. **Did coverage actually improve?** Run the coverage report before and after. If it didn't move, the tests aren't testing real code paths.
5. **Are the tests testing the code or the mocks?** A test that mocks everything and asserts the mock was called is testing your test setup, not your code.
