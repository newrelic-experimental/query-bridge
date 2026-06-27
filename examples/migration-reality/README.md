# Migration Reality

Two **synthetic** Splunk dashboards — one Simple XML, one Dashboard Studio — modeled on
the *shape* of real customer dashboards, run through the SPL→NRQL importer to show what
a customer actually gets when they migrate. Not a success demo: a little works, much
breaks, and the breakage is the point.

All field/index/token names are invented (`web_logs`, `k8s_logs`, `checkout`, `level`,
`status`, `clientip`, `pod`). **No customer content** appears here — only structures
reproduced from the donated corpora. The catalogued problems live in
[`docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`](../../docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md).

## What each board shows

Both mix a few clean translations (so you see the happy path render) with the dominant
real failure classes:

- **Clean:** `timechart`→`TIMESERIES`, `stats count by`→`FACET` (these target this demo
  account's log fields so they render live).
- **Render-fails** (`top`/`sort` → `ORDER BY` on an aggregation): the importer emits
  NRQL that passes the query console but the live widget **red-banners**.
- **No NRQL equivalent** → loud placeholder panels preserving the original SPL:
  `transaction`, `mvexpand`, `iplocation`, `strftime`, affixed tokens, wildcard rename.
- **Lossy:** dashboard time-picker tokens (`$tr.earliest$`) are silently dropped — the
  panel loses its intended time window.

The Studio board adds Studio-specific reality: a `ds.chain` whose base transforms then
post-processes with `eval` → guard placeholder; `ds.savedSearch` → placeholder; an
unrecognized `splunk.*` viz (sankey) → placeholder; `splunk.image` → clean markdown;
`splunk.rectangle` → dropped. Simple XML adds: `<html>` panels → placeholders.

## Run / deploy

The real customer path — Splunk source → importer → Terraform → `terraform apply`:

```bash
# import each source to Terraform
node packages/nr-dashboard-importer/bin/spl-dashboard.js \
  examples/migration-reality/sources/reality-studio.xml \
  --account 10671289 --region Staging --out examples/migration-reality/out/studio

# deploy (staging key from env; see the nr:nr-env skill)
export TF_VAR_account_id=10671289 TF_VAR_newrelic_api_key=NRAK-...
cd examples/migration-reality/out/studio && terraform init && terraform apply
```

(Repeat with `reality-simplexml.xml` → `out/simplexml`.) `out/` is generated and
git-ignored — never commit terraform state or the provider binary.

## Note on the demo account

The boards target staging account `10671289` (its `Log` data backs the clean panels).
The placeholder/render-fail panels demonstrate regardless of data. Re-point with a
different `--account` and the breakage classes still hold; the clean panels will be
empty until they target fields that exist in your account.
