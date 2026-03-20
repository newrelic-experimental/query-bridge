# Security Standards

## General Security Practices

- Never expose or log secrets, API keys, or sensitive data
- Never commit credentials, tokens, or secrets to version control — use approved secret storage
- Validate all inputs at system boundaries
- Follow the principle of least privilege
- Encrypt data in flight and at rest
- Every code change must be reviewed by another contributor before deploying to production

## When to Engage Security

File an SLCREV ticket (Slack: #ask-security-legal-compliance) if any of these apply:
- New product, app, or service
- Major change to an existing product
- Integration with a third-party service
- Changes to authentication or authorization
- Collection/processing of new data types (especially personal data)
- ML or automated data processing on customer data
- Anything impacting regulated customers (FedRAMP, HIPAA)

Reference: https://newrelic.atlassian.net/wiki/spaces/STAN/pages/2628059217

## Open Source Components

Open source components must use an approved license and have zero known critical vulnerabilities. Keep them less than two years old and less than two major versions behind latest. This applies to LLM-suggested libraries too — verify before adding.

**Approved licenses** means permissive licenses (MIT, BSD, Apache 2.0, LGPL). Network reciprocal licenses (AGPL, EUPL, SSPL, CPAL, OSL) are always prohibited. Strong reciprocal licenses (GPL) are prohibited for distributed software. When in doubt, check the [Open Source Usage Policy](https://newrelic.atlassian.net/wiki/spaces/OSPO/pages/3497361556) or ask in #ask-security-legal-compliance.

**License scanning tools:**
- **Distributed software** (agents, integrations, anything shipped to customers): FOSSA is required for legal review. See the [Code Scanning standard](https://newrelic.atlassian.net/wiki/spaces/STAN/pages/2653716669).
- **All projects**: Dependabot / Snyk for vulnerability scanning.

## Library Verification (LLM-Specific)

LLMs hallucinate library names. Malicious actors register packages with commonly hallucinated names. Before using any library suggested by an LLM:

1. **Verify the package exists** on the official registry (npm, PyPI, etc.)
2. **Verify the publisher** — maintained by a known, trusted entity
3. **Check download counts** — legitimate popular libraries have significant downloads
4. **Check the repository** — source repo should exist, be active, match the package description

Example: The `claude` npm package is **not** maintained by Anthropic.

## UTF-8 Invisible Character Scanning

Skills, rules, commands, or any configuration imported from the web must be scanned for invisible UTF-8 characters. These can hide prompt injection attacks.

1. Check for non-printable characters: `cat -v <file>` or `xxd <file>`
2. Look for zero-width spaces (U+200B), zero-width joiners (U+200D), and other invisible Unicode
3. If found, reject the file and inspect the source

## Project-Specific: NRQL Injection

All NRQL queries MUST use query builders — never string concatenation. This is a real security risk since user input flows into NRQL queries. All escaping goes through `nrqlEncoding.js`.
