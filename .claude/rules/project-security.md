# Project Security Standards

## Overrides
These supplement the universal security standards (`.claude/rules/nr-ai-standards/security.md`):

- No new overrides — project follows the universal standards.

## Project Config

### NRQL Injection Prevention
All NRQL queries MUST use query builders — never string concatenation. User input flows into NRQL queries, making this a real injection risk. All escaping goes through `src/output/nrql/nrqlEncoding.js`:
- `escapeAttributeNameForNrql` — backtick escaping for attribute names
- `escapeStringLiteralForNrql` — single-quote escaping for string literals
- `escapeStringWildcardForNrql` — percent escaping for LIKE patterns
