# Contributing

Contributions are always welcome. Before contributing please read the
[code of conduct](https://opensource.newrelic.com/code-of-conduct/) and [search the issue tracker](../../issues); your issue may have already been discussed or fixed in `master`. To contribute,
[fork](https://help.github.com/articles/fork-a-repo/) this repository, commit your changes, and [send a Pull Request](https://help.github.com/articles/using-pull-requests/).

Note that our [code of conduct](https://opensource.newrelic.com/code-of-conduct/) applies to all platforms and venues related to this project; please follow it in all your interactions with the project and its participants.

## Feature Requests

Feature requests should be submitted in the [Issue tracker](../../issues), with a description of the expected behavior & use case, where they’ll remain closed until sufficient interest, [e.g. :+1: reactions](https://help.github.com/articles/about-discussions-in-issues-and-pull-requests/), has been [shown by the community](../../issues?q=label%3A%22votes+needed%22+sort%3Areactions-%2B1-desc).
Before submitting an Issue, please search for similar ones in the
[closed issues](../../issues?q=is%3Aissue+is%3Aclosed+label%3Aenhancement).

## Pull Requests

1. Ensure any install or build dependencies are removed before the end of the layer when doing a build.
2. Increase the version numbers in any examples files and the README.md to the new version that this Pull Request would represent. The versioning scheme we use is [SemVer](http://semver.org/).
3. You may merge the Pull Request in once you have the sign-off of two other developers, or if you do not have permission to do that, you may request the second reviewer to merge it for you.

## Running checks locally

CI runs `npm ci`, `npm run lint`, `npm run types:check`, and `npm test`. All of those
run locally with Node 24.

A few checks depend on external binaries rather than npm packages:

- **gitleaks** (secret scanning). `npm run scan:secrets` scans the full history and
  `npm run scan:secrets:dir` the working tree. Install with `brew install gitleaks`.
  The script uses whichever `gitleaks` is on your `PATH`, while CI pins a version in
  `.github/workflows/secret-scan.yml`. If the two differ, a local pass does not
  guarantee CI agrees.
- **actionlint** (workflow syntax). `actionlint .github/workflows/*.yml`, installed
  with `brew install actionlint`. Worth running after editing any workflow: it catches
  invalid expressions and `if:` conditions that would otherwise surface only on a real
  run.
- **act** (running a workflow job locally, optional). For example:

  ```
  act push -W .github/workflows/ci.yml -j build \
    -P ubuntu-latest=catthehacker/ubuntu:act-latest
  ```

  It needs Docker. `act` reads only `DOCKER_HOST` and ignores Docker CLI contexts, so
  on Rancher Desktop, or any setup without `/var/run/docker.sock`, point it at the real
  socket first or it fails with "failed to connect to the docker API":

  ```
  export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
  ```

  `act` cannot reproduce everything. There is no GitHub cache service, so `cache` steps
  warn and miss, and there is no OIDC token endpoint, so `publish.yml`'s Trusted
  Publishing step cannot be exercised locally.

## Sensitive data

This project translates real customers' queries and dashboards, so take care not
to commit customer-identifying content. In code, tests, and docs, never name a
customer or paste real identifiers (company/brand names, host/index/cluster
names, customer-specific field names) — use generic placeholders instead (e.g.
"a customer", `userId`, `region_north`). Real corpus data lives only in a private
repository, never here. Maintainers who hold that private data also run a local
pre-commit scan (`scripts/scan-customer-names.sh`) that blocks accidental commits.

## Contributor License Agreement

Keep in mind that when you submit your Pull Request, you'll need to sign the CLA via the click-through using CLA-Assistant. If you'd like to execute our corporate CLA, or if you have any questions, please drop us an email at opensource@newrelic.com.

For more information about CLAs, please check out Alex Russell’s excellent post,
[“Why Do I Need to Sign This?”](https://infrequently.org/2008/06/why-do-i-need-to-sign-this/).

## Slack

We host a public Slack with a dedicated channel for contributors and maintainers of open source projects hosted by New Relic.  If you are contributing to this project, you're welcome to request access to the #oss-contributors channel in the newrelicusers.slack.com workspace.  To request access, see https://newrelicusers-signup.herokuapp.com/.
