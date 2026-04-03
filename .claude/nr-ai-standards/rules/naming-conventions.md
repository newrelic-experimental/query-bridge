<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# Naming Conventions

## Structure: A/HC/LC

Every function name follows: `prefix? + action (A) + high context (HC) + low context? (LC)`

| Name | Action | High Context | Low Context |
|---|---|---|---|
| `getUser` | `get` | `User` | |
| `getUserMessages` | `get` | `User` | `Messages` |
| `handleClick` | `handle` | `Click` | |
| `shouldRetryRequest` | (prefix) | `Retry` | `Request` |

High context = the primary thing. Low context = qualifier. Order matters: `shouldUpdateComponent` (you update it) vs `shouldComponentUpdate` (it updates itself).

## S-I-D: Every Name Must Be

- **Short** — quick to type and remember
- **Intuitive** — reads naturally, close to common speech
- **Descriptive** — reflects what it does/possesses

No contractions (`onItmClk` → `onItemClick`).
No context duplication (`MenuItem.handleMenuItemClick` → `MenuItem.handleClick`).

## Boolean Prefixes (closed set)

| Prefix | Meaning | Example |
|---|---|---|
| `is` | Characteristic or current state | `isEnabled`, `isNumeric` |
| `has` | Possesses a value or capability | `hasProducts`, `hasPermission` |
| `should` | Positive conditional tied to action | `shouldRetry`, `shouldWrap` |
| `did` | Past-tense completion state | `didChange`, `didLoad` |
| `can` | Ability or permission | `canEdit`, `canRetry` |

No other boolean prefixes. Never use negative names (`notReady`, `noHeaders`) — invert the logic instead.

## Variable Prefixes (closed set)

| Prefix | Meaning |
|---|---|
| `min` / `max` | Boundaries or limits |
| `prev` / `next` | State transitions |
| `raw` / `parsed` | Before/after processing |
| `total` / `count` | Aggregates |

## Common Opposites (always use as pairs)

`add/remove` · `create/delete` · `open/close` · `start/stop` · `begin/end` · `first/last` · `get/set` · `show/hide` · `enable/disable` · `old/new` · `prev/next` · `source/target` · `min/max` · `push/pop` · `read/write` · `encode/decode` · `enqueue/dequeue` · `publish/subscribe` · `serialize/deserialize` · `marshal/unmarshal`

Key distinction: **add/remove** need a destination (add *to* a list). **create/delete** don't (create a post, delete a post). Don't mix pairs.

## Singular/Plural

Singular for one value, plural for collections. Never pluralize lazily — `blog.js` and `blogs.js` are impossible to grep.

## Core Verb Vocabulary

Pick one verb per concept. The rest are banned synonyms.

| Concept | Use | Do NOT use |
|---|---|---|
| Read/access data | `get` | `fetch`, `retrieve`, `obtain`, `acquire`, `load`, `find` |
| Assign/mutate | `set` | `assign`, `update`, `put`, `write`, `store` |
| Make new thing | `create` | `make`, `generate`, `produce`, `construct`, `init` |
| Erase permanently | `delete` | `destroy`, `kill`, `nuke`, `purge`, `wipe` |
| Take from collection | `remove` | `drop`, `discard`, `detach`, `unset` |
| Return to default | `reset` | `clear`, `restore`, `revert`, `reinitialize` |
| Build from parts | `compose` | `assemble`, `combine`, `merge`, `construct` |
| React to event | `handle` | `on` (as prefix), `process`, `respond`, `react` |
| Check a condition | `is`/`has`/`should` | `check`, `test`, `verify`, `validate`, `assert` |
| Transform shape | `transform` | `convert`, `morph`, `reshape` |
| Make string/output | `format` | `render`, `stringify`, `print`, `display` |
| Parse string/input | `parse` | `deserialize`, `extract`, `read` |

Projects may extend this table with domain-specific verbs (see below). Document overrides in the project's `.claude/rules/naming-conventions.md`.

---

## Domain-Specific Verb Extensions

When a project falls into one of these domains, add the relevant verbs to the core vocabulary. These don't replace the core verbs — they cover concepts the core table doesn't address.

### HTTP / Web Services

| Verb | Meaning | Example |
|---|---|---|
| `fetch` | Make an external HTTP request (async, may fail) | `fetchAccountDetails()` |
| `submit` | Send user-initiated data to a server | `submitForm()`, `submitOrder()` |
| `redirect` | Send client to a different URL | `redirectToLogin()` |
| `render` | Produce HTML/DOM output from data | `renderDashboard()` |
| `route` | Dispatch a request to a handler | `routeRequest()` |
| `validate` | Check user input at the system boundary | `validatePayload()` |
| `authorize` | Check if a principal has permission | `authorizeRequest()` |
| `authenticate` | Verify identity | `authenticateUser()` |

Note: `fetch` is allowed here as distinct from `get`. `get` returns data you already have access to (in-memory, local DB). `fetch` crosses a network boundary. If your service only does one or the other, just use `get`.

### Message Queues / Kafka / Event Streaming

| Verb | Meaning | Example |
|---|---|---|
| `publish` | Send a message to a topic/exchange | `publishEvent()`, `publishMetric()` |
| `consume` | Receive and process messages from a topic | `consumeEvents()` |
| `enqueue` | Add to an ordered queue | `enqueueJob()` |
| `dequeue` | Take from an ordered queue | `dequeueJob()` |
| `ack` | Acknowledge successful processing | `ackMessage()` |
| `nack` | Reject / negative-acknowledge | `nackMessage()` |
| `emit` | Fire an event for listeners (in-process) | `emitMetric()`, `emitEvent()` |
| `dispatch` | Route a message/event to a specific handler | `dispatchCommand()` |
| `replay` | Re-process historical messages | `replayFromOffset()` |

Note: `emit` vs `publish` — `emit` is in-process (EventEmitter pattern), `publish` crosses a process boundary (Kafka, AMQP, SNS). Don't swap them.

### Background Jobs / Workers / Pipelines

| Verb | Meaning | Example |
|---|---|---|
| `schedule` | Register work to run at a future time | `scheduleRetry()`, `scheduleExport()` |
| `execute` | Run a unit of work synchronously | `executeStep()`, `executeQuery()` |
| `spawn` | Start an async/parallel unit of work | `spawnWorker()` |
| `retry` | Re-attempt a failed operation | `retryWithBackoff()` |
| `poll` | Repeatedly check for new work/state | `pollForResults()` |
| `drain` | Process remaining items then stop | `drainQueue()` |
| `cancel` | Abort scheduled/in-progress work | `cancelJob()` |
| `resume` | Continue paused/interrupted work | `resumeFromCheckpoint()` |

### Data Pipelines / Compilers / Translators

| Verb | Meaning | Example |
|---|---|---|
| `translate` | Convert one representation to another (AST→IR, SPL→NRQL) | `translateExpr()` |
| `emit` | Produce output-format strings from internal representation | `emitQuery()` |
| `resolve` | Look up a name/symbol in a mapping or registry | `resolveFunction()` |
| `build` | Construct a node/structure from primitive parts | `buildComparison()` |
| `optimize` | Transform a structure to improve it (IR→IR) | `optimizeQuery()` |
| `normalize` | Canonicalize input before processing | `normalizeWhitespace()` |
| `walk` | Traverse a tree structure (visiting, not converting) | `walkDependencies()` |
| `rewrite` | Replace patterns in a tree (tree→tree of same type) | `rewriteSubqueries()` |

Note: `translate` converts between types (AST→IR). `rewrite` transforms within the same type (IR→IR). `walk` visits without producing a new structure. If your "walk" produces a different type, call it `translate`.

### Database / Persistence

| Verb | Meaning | Example |
|---|---|---|
| `query` | Read from a data store with criteria | `queryByStatus()` |
| `insert` | Add a new record | `insertAccount()` |
| `update` | Modify an existing record | `updateBalance()` |
| `upsert` | Insert or update depending on existence | `upsertConfig()` |
| `migrate` | Transform schema or data between versions | `migrateToV3()` |
| `seed` | Populate initial/test data | `seedTestAccounts()` |
| `flush` | Write buffered data to storage | `flushBatch()` |
