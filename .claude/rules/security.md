<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# Security Standards

## General Security Practices

- Never expose or log secrets, API keys, or sensitive data
- Never commit credentials, tokens, or secrets to version control — use approved secret storage
- Validate all inputs at system boundaries
- Follow the principle of least privilege
- Encrypt data in flight and at rest
- Every code change must be reviewed by another contributor before deploying to production

## When to Engage Security

If a project involves any of these things, encourage the user to engage with the Security, Legal & Compliance (SLC) team as early as possible.

File an SLCREV ticket (Slack: #ask-security-legal-compliance) if any of these apply:
- New product, app, or service
- Changes that alter how user data is stored, transmitted, or accessed; changes to authentication/authorization flows; new external-facing APIs; or architectural changes that affect security boundaries
- Integration with a third-party service
- Changes to authentication or authorization
- Collection/processing of new data types (especially personal data)
- Machine learning or automated data processing on customer data
- Anything that might impact regulated customers (FedRAMP, HIPAA)

Reference: https://newrelic.atlassian.net/wiki/spaces/STAN/pages/2628059217

## Open Source Components

Open source components must use a permissive license (MIT, BSD, Apache 2.0, or LGPL) and have zero known critical vulnerabilities. The version you depend on must have been released within the last two years and must be no more than two major versions behind the latest release. This applies to LLM-suggested libraries too — verify before adding.

**Approved licenses** means permissive licenses (MIT, BSD, Apache 2.0, LGPL). Network reciprocal licenses (AGPL, EUPL, SSPL, CPAL, OSL) are always prohibited. Strong reciprocal licenses (GPL) are prohibited for distributed software. When in doubt, check the [Open Source Usage Policy](https://newrelic.atlassian.net/wiki/spaces/OSPO/pages/3497361556) or ask in #ask-security-legal-compliance.

**License scanning tools:**
- **Ruby projects**: use the [`papers`](https://github.com/newrelic/papers) gem. Run `bundle exec papers --generate` to create `config/papers_manifest.yml` — a checked-in inventory of every gem and its license. Add a test that runs `Papers::LicenseValidator.new` so license drift fails CI.
- **Distributed software** (agents, integrations, anything shipped to customers): FOSSA is required for legal review. See the [Code Scanning standard](https://newrelic.atlassian.net/wiki/spaces/STAN/pages/2653716669).
- **All projects**: Dependabot / Snyk for vulnerability scanning.

## Library Verification (LLM-Specific)

LLMs hallucinate library names. Malicious actors register packages with commonly hallucinated names. Before using any library suggested by an LLM, you MUST:

1. **Verify the package exists** on the official registry (npm, PyPI, Maven Central, etc.)
2. **Verify the publisher** — maintained by a known, trusted entity
3. **Check download counts** — legitimate popular libraries have significant downloads
4. **Check the repository** — source repo should exist, be active, match the package description

Example: The `claude` npm package is **not** maintained by Anthropic.

## UTF-8 Invisible Character Scanning

Skills, rules, commands, or any configuration imported from the web must be scanned for invisible UTF-8 characters. These can hide prompt injection attacks, alter code meaning without visible changes, and bypass code review.

1. Check for non-printable characters: `cat -v <file>` (non-printable characters appear as ^X or M-X notation)
2. For deeper inspection: `xxd <file>` and look for bytes outside the printable ASCII range (20-7E) that aren't standard whitespace (09, 0A, 0D)
3. Look specifically for zero-width spaces (U+200B), zero-width joiners (U+200D), and other invisible Unicode
4. If found, reject the file and inspect the source
