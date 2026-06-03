<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# Engineering Standards

## Where Standards Live

New Relic engineering standards are in the STAN Confluence space. They cover quality, security, engineering practices, and domain-specific guidance. The full index is at:

https://newrelic.atlassian.net/wiki/spaces/STAN/pages/2628059170

You can search them directly via the Atlassian MCP server if it's configured:
```
mcp__atlassian-mcp__confluence_search with spaces_filter: "STAN"
```

## How to Access Standards Skills

Standards skills come from the NR Claude plugin marketplace. If `/nr:check-engineering-standards-skill` isn't available, the plugin isn't installed.

### Install the plugin marketplace (one-time)

In Claude Code:
```
/plugin marketplace add git@<GHE_HOST>:commune/claude-plugin-marketplace.git
/plugin install nr@claude-plugin-marketplace
```

### Authenticate Atlassian MCP (one-time)

The engineering standards skill needs Confluence access:
1. Run `/mcp` in Claude Code
2. Select `atlassian-confluence` → Authenticate
3. Select **Confluence** as the product
4. Enter `newrelic.atlassian.net` as the workspace (no hyphen)

For Jira access (used by other skills):
1. Select `atlassian-jira` → Authenticate
2. Select **Jira** as the product
3. Enter `new-relic.atlassian.net` as the workspace (with hyphen)

### Available skills

Once installed, these skills are available:

- **`nr:check-engineering-standards-skill`** — Search STAN space for engineering standards. Use for code reviews, architecture decisions, build/deploy guidance.
- **`nr:suggest-nr-ui-plugin`** — Detects frontend work and suggests the `nr-ui` plugin for design system guidance.
- **`nr-java:java-coding-standards-skill`** — Java-specific standards (requires `nr-java` plugin).

Other domain plugins: `nr-ui` (frontend/design system), `nr-go` (Go), `nr-ruby` (Ruby).

## When to Check Standards

- Architecture decisions
- Code reviews
- Choosing libraries or frameworks
- Build/deploy pipeline changes
- Anything where you're not sure if NR has an opinion — they probably do

---

## Standards Export (from STAN Confluence space, 2026-03-13)

This section contains the actual standards content so LLMs can make correct decisions without needing live Confluence access. Standards use RFC 2119 language: MUST, SHOULD, MAY, MUST NOT, SHOULD NOT.

### Quality Standards

The Quality Standards are the top-level requirements every team must follow. They are organized into sections:

#### Meta Rules
- **M-1**: Teams MUST NOT silently bypass any quality standards.
- **M-2**: Standards MUST be re-evaluated every quarter.

#### Architecture
- **A-1**: Initiative Design Docs MUST be used for all Initiatives. Change Design Docs MUST be used for substantial architectural changes. DACIs MUST be written for major decisions. Team architecture diagrams MUST be updated at least once a year.
- **A-2**: Every team MUST review their risk matrix each quarter and have plans to mitigate high risks.
- **A-3**: Every team MUST follow engineering standards or get an exception from their architect.
- **A-4**: All customer-facing functionality MUST have a publicly exposed API in NerdGraph. Exception: telemetry ingest APIs MUST use Vortex (New Relic's ingest pipeline), not NerdGraph.
- **A-5**: Services MUST tolerate dependency failures (degrade gracefully with defaults or caches).
- **A-6**: Services MUST use auto scaling. Services that cannot auto scale (e.g., stateful services with fixed instance counts) MUST maintain at least 30% unused CPU and memory capacity on each instance.
- **A-7**: All production systems MUST run software less than two years old and less than two major versions behind the latest supported version. This includes NR agents and 3rd party libraries.

#### Security & Compliance
- **S-1**: Security is not optional. Teams MUST secure services and customer data per Security Standards.
- **S-2**: Open source components MUST use an approved license and have zero known critical vulnerabilities.
- **S-3**: Secrets, including API keys, MUST be stored in approved secret storage options and MUST NEVER be stored in source code or written to logs.
- **S-4**: Everything MUST be encrypted in flight and at rest unless it has an approved exception.
- **S-5**: Every code change MUST be reviewed by another contributor (sidekick review) before being deployed to production. Branch protection MUST be enabled.
- **S-6**: Teams MUST use the SLC Review process prior to updating or launching any new product features, internal services, or systems.
- **S-7**: Teams MUST own the lifecycle of code and infrastructure vulnerabilities and remediate within SLA.

#### FinOps
- **F-1**: Teams MUST factor costs into all decisions and maintain documented architectural cost flows.
- **F-2**: Teams MUST follow tagging standards and maintain 100% service tag coverage.

#### Testing
- **T-1**: Unit test coverage for production code SHOULD be at least 70%. Teams below 70% SHOULD increase coverage by at least 5 percentage points per quarter. Integration/e2e tests SHOULD cover key workflows. Tier 1 services (customer-facing, revenue-impacting) and Tier 2 services (internal but business-critical) SHOULD run Gamedays at least every six months.
- **T-2**: Test plans MUST be documented and verified in Staging, then verified in US and EU production.

#### Deployments
- **D-1**: Deploy changes as small and as frequently as possible. Minimize time between development and deployment.
- **D-2**: Changes MUST be deployed iteratively in staging before production and in one region at a time using canaries, feature flags, and appropriate bake times.
- **D-3**: Every service MUST have a dashboard or UI with telemetry in New Relic reviewable during deployments.
- **D-4**: Teams MUST review production readiness checklists prior to significant releases.
- **D-5**: Infrastructure MUST be configured in code in Github (infrastructure as testable idempotent code).

#### Service Levels
- **L-1**: Every key user experience MUST have mature, maintained SLIs and SLOs tied to the customer experience, viewable in New Relic, with a defined owner team.
- **L-2**: Meeting the SLA takes priority over all other work. Remediation from Service Levels takes precedence over feature work.

#### Operations & Incident Response
- **O-1**: Every service MUST have monitoring and actionable alerts in New Relic for production and staging.
- **O-2**: Incident responders MUST have completed incident response training and follow the incident commander runbook.
- **O-3**: Communicate emergencies and high risk changes through appropriate slack channels. Share theories and charts openly during incidents (unless undisclosed security vulnerability).
- **O-4**: All manual production changes MUST be made through an Urgent Care ticket (New Relic's emergency change process) and MUST be approved by another engineer before execution.
- **O-5**: Blameless culture — focus on learning and prevention, not blame.
- **O-6**: During active incidents, the on-call engineer SHOULD rotate in a fresh responder at least every 2 hours to prevent fatigue and bring new perspective.
- **O-7**: Each team MUST write and maintain emergency runbooks linked in alert conditions.
- **O-8**: All incidents MUST be reported in Upboard (New Relic's incident tracking system) within the reporting SLA defined for the incident's severity level. RCAs MUST be completed within 5 business days.
- **O-9**: Owning team's manager MUST hold blameless retros within 3 business days. File remediation as JIRA bug tickets.
- **O-10**: Teams MUST use New Relic for their observability needs.

#### Collaboration
- **C-1**: Diversity is a competitive strength. Collaborate across teams and hierarchy.
(Standards C-2, C-4, C-5 were retired.)
- **C-3**: Everyone has the right to contribute to any code. Teams MUST specify external contribution guidelines.
- **C-6**: All engineering teams MUST track work in JIRA and work in sprints.

#### Open Source
- **OSS-1**: Teams MUST engage with external contributors within three business days.
- **OSS-2**: New projects MUST follow the Open Source Release checklist. Archived projects MUST follow the OSPO archival checklist.

### Secrets & Credentials

These are the standards most relevant to LLM-assisted development. An LLM suggesting "just put the API key here" violates multiple MUST-level standards.

#### Source Code Must Not Contain Secrets
All code that New Relic uses or depends on **MUST NOT** contain hardcoded secrets within source code. Secrets **MUST** be stored in an approved secret storage system. This includes API keys, tokens, passwords, connection strings, and any authentication credential.

**Why this matters for LLMs**: When generating code examples, config files, CI/CD pipelines, or scripts, NEVER include real secrets. Use environment variables, secret references, or placeholder values like `${VAULT_SECRET}` or `$NEW_RELIC_API_KEY`. Even in "temporary" or "test" code, secrets in source are a standards violation.

#### Approved Secret Storage Options
Employees **MUST NOT** place secret values into files, Slack, web apps, wikis, Jira tickets, or Google Docs. Approved options:

| Tool | Usage |
|------|-------|
| **Hashicorp Vault** | Primary option for most product teams. MUST be used in Cell and Chicago/Softlayer deployments. |
| **AWS Secrets Manager** | If building natively in AWS without Vault access, you MUST use AWS Secrets Manager. |
| **NR Secrets Store** | For customer secrets including NR read/write API keys, tokens, and customer-specific secrets like Synthetics secure credentials. MUST NOT be used for internal use cases (use Vault instead). All secrets/stores to be migrated by March 31, 2027 (end of FY27). |
| **1Password** | For human-to-human secret sharing only. Never paste passwords into Slack/email/wikis. |

#### API Keys Standard
- API Keys are **Secrets** and MUST be treated accordingly.
- API keys MUST have permissions assigned through RBAC.
- API keys MUST be revocable within 12 hours (half the 24-hour credentials-leak remediation SLA).
- New Relic-generated keys MUST have a signature prefix/postfix for secrets scanning (like `NRAK-`).
- API keys MUST be rotated at least once per 365-day period.
- API keys SHOULD be tied to individual users or service accounts, not "general account keys".
- API keys SHOULD be scoped to the principle of least privilege.

#### Redaction of Secrets in Logs
New Relic **MUST** redact customer secrets/API keys when captured in logs. Partial unredaction rules based on key length (when calculating key length for redaction rules, do not count known prefixes — e.g., subtract the 5 characters of 'NRAK-' before measuring):
- < 15 chars: no values may be shown
- 15-40 chars: up to 15% may be shown
- \> 40 chars: up to 20% may be shown

Production logging of partial secrets SHOULD be enabled only for active debugging sessions and MUST be disabled within 24 hours or when the debugging session ends, whichever comes first.

### Encryption

#### Encryption at Rest
- All non-public data MUST be encrypted at rest using a FIPS 140-2 validated encryption algorithm.
- Customer passwords MUST only be stored by the Login Service using the scrypt key derivation function.
- Customer credentials (including API keys) for third-party services MUST be encrypted using AES-256-GCM and MUST use Vault or Amazon KMS for key management.
- Base64, XOR, ROT13, and hashing are NOT encryption.

#### Encryption in Transit
- All non-public data MUST be encrypted when transiting any network.
- All existing service endpoints MUST use TLS 1.2 with at least an A grade from SSL Labs.
- All new service endpoints (created after April 1, 2024) MUST support TLS 1.3.

### Code Review & Sidekick Process

All changes to code that New Relic uses or depends on **MUST** be made using pull requests, and these PRs **MUST** pass review by another engineer (sidekick review) prior to merge.

Key rules:
- The sidekicker MUST be a background-checked person who was not involved in writing the code.
- The sidekicker MUST use GitHub review approval or add the `sidekick:approved` label.
- Branch protection MUST be enabled on default branches.
- Revert commits, Gemfile changes, config changes, and typo fixes all require sidekick review.
- Only exception: changes to markdown-only files (.md) do not require sidekick approval.
- PRs created by security-approved automated tools (e.g., Dependabot, Renovate) do not require sidekick review. Any new automated tool that creates PRs MUST be approved by the security team before its PRs can skip sidekick review. LLM-generated PRs still require sidekick review.

### Code Scanning & Vulnerability Management

All code in use or depended on by New Relic **MUST** go through security scanning. Results SHOULD be analyzed before code runs in production.

Required scans:
- **Dependabot**: Software Composition Analysis (dependency vulnerabilities)
- **CodeQL**: Static Code Analysis (replacing Sonarqube)
- **Trivy**: Container and container image scanning. Teams MUST fix issues within SLA when Jira tickets are issued.
- **FOSSA**: Legal license scanning for all software distributed to customers.

All security findings **MUST** be resolved within the Vulnerability Tracking & Resolution Standard SLA. Critical/High findings SHOULD be remediated before production release.

### API Standards

#### General API Standard
Teams **MUST** get APIs reviewed by the #api-review-board prior to shipping. An API is any interface a client interacts with — HTTP APIs (REST, GraphQL), Ingest APIs, Internal APIs, NRQL language.

#### NerdGraph
Teams **MUST** stitch into NerdGraph for all Public APIs. NerdGraph is the public API gateway using GraphQL. Exceptions: ingest APIs, large datasets (use Blob APIs), non-JSON datasets, and integrations where NR doesn't control the payload (e.g., webhooks).

### Observability Standards

#### Observability as Code
Teams **MUST** automate their New Relic Alerting configuration. Teams SHOULD automate as much observability configuration as reasonable. Teams SHOULD use the official New Relic Terraform Provider. Teams **MUST NOT** use the internal Alerts DSL (no longer supported).

#### Monitoring (Four Golden Signals)
Teams **MUST** use some form of monitoring. Most teams SHOULD use the Four Golden Signals:
- **Latency**: How long requests take. For Kafka consumers, consumer lag is key.
- **Traffic**: System load (requests/sec, concurrent sessions, etc.).
- **Errors**: Rate of failed requests (implicit or explicit).
- **Saturation**: Most constrained resource (memory, CPU, network I/O).

Synthetics Monitors SHOULD be used for monitoring HTTP endpoints.

### Build & Deploy

#### Developer Platform
Teams **MUST** build and deploy all resources using Developer Platform (which uses Grand Central). Exceptions may be granted for stateful services in consultation with architects, but builds MUST still use Developer Platform for vulnerability scanning.

#### Test Plans
Systems **MUST** have a Test Plan documented. It must be discoverable (part of source README or linked from it). Feature Test Plans are required for new features. System-level test plans should aggregate feature test plans.

### AI Standards

#### AI Use Cases
Generative AI use cases in the SaaS product **MUST** be expressly approved by Security, Legal, and Compliance (SLC) through the SLC Review process. Teams **MUST** initiate SLC Review during initial ideation/design — Teams MUST NOT begin development until SLC clearance is granted. Teams **MUST NOT** create, use, or redistribute AI tools for prohibited purposes.

#### LLM Gateway
Teams SHOULD use LLM models only through the internal LLM gateway (nerd-completion). It provides governance, retries, load balancing, rate limiting, automatic fallbacks, and secure virtual LLM keys. Exception: engineering/IT tools with their own LLM models (GitHub Copilot, Gemini, etc.).

### Other Engineering Standards

#### Cloud Security
All resources in cloud providers **MUST** meet CIS Benchmark Level 1 at minimum configuration.

#### Impersonation
Impersonation MUST only be used for troubleshooting and MUST have customer consent. All impersonation actions must be customer-auditable. Employees MUST only have access necessary to perform their jobs. Customer-impacting access MUST be reviewed quarterly.

#### Semantic Versioning
Teams SHOULD follow semver `#.#.#` (with optional `-label` pre-release) for released artifacts. Especially important for client libraries.

#### US English
Property names and values MUST use US English (e.g., "standardization" not "standardisation").

#### Synthetics
New Relic employees MUST NOT create synthetic checks against domains not owned by New Relic. Customer domains require explicit documented permission.

#### FIPS / FedRAMP
Teams MUST enable FIPS in FedRAMP environments using ACCP provided by Gradle Plugins.
