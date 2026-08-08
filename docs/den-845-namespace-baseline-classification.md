# DEN-845 deterministic namespace manifest refresh

The `ORESoftware/k8s-cluster` namespace migration workflow is a production gate. This independent `fiducia-cloud-test` lane reproduces that workflow for one exact base and one exact bridge-repair head, classifies any baseline drift, and emits a validated replacement manifest when the head requires one.

## Exact comparison

- Base: `ORESoftware/k8s-cluster@18f1fa1dc8360c4817e1adbc1351b93f7d8604de`
- Head: `ORESoftware/k8s-cluster@664ea2fa106168e7e62ab70adb5719d54f59e9c4`
- Production PR: `ORESoftware/k8s-cluster#1210`

The lane does not assume whether the base manifest is valid or stale. It evaluates base and head with the repository-owned tools and records the result. This distinction matters because a broad baseline refresh must not be disguised as a bridge-only bookkeeping change.

## Production-equivalent evaluation

The harness matches the production workflow's ordering and shell-redirection behavior:

1. Run the repository-owned namespace classifier and manifest adversarial tests.
2. Write the ownership-contract report.
3. Create and populate `artifacts/namespace-inventory.json` through the same redirection semantics used in production.
4. Check the committed migration manifest against that exact inventory.
5. Compare base and head occurrence identities using `(path, line, column, system, current)`.
6. Run the exact base-to-head namespace debt ratchet.
7. Generate the replacement manifest twice from the exact head inventory and require byte-for-byte equality.
8. Check the generated replacement against the same inventory.

The harness uses the repository's canonical inputs:

- `catalog/namespaces/owners.json`
- `catalog/namespaces/migration-rules.json`
- `catalog/namespaces/migration-manifest.json`

It also verifies the production PR's exact eight-file scope and confirms that the committed manifest blob was not already edited.

## Passing result

A green result means all of the following are true:

- both namespace ownership contracts are valid;
- the exact head manifest is stale and therefore needs a refresh;
- the production PR leaves the committed manifest blob unchanged before repair;
- the base-to-head ratchet reports no new violations or diagnostics;
- two exact-head generations produce identical bytes;
- the generated replacement validates against the exact head inventory;
- its entry count equals the exact head inventory occurrence count;
- `executionAuthorized` remains false;
- destructive cleanup remains disabled for every entry;
- the production PR changed only the reviewed bridge, Slack-command, runner, focused workflow, and contract-test paths.

Base validity, base/head inventory counts, identity additions/removals, affected paths, report hashes, and manifest diagnostics are recorded rather than inferred.

## Evidence

The uploaded evidence records deterministic report hashes, exact occurrence-identity deltas, ratchet output, generated-manifest SHA-256 and Git blob identity, and the exact changed paths. The candidate manifest is uploaded separately so it can be applied verbatim in a focused production commit or a separate baseline-repair PR, depending on the classification.

## Safety boundary

This test lane never writes to the production repository and never weakens or waives the production namespace gate. It performs no cluster, Cloudflare, R2, Slack, or model-provider operation and needs no secret credential. A candidate must still be reviewed, committed to the appropriate production PR, and pass the production namespace workflow on the resulting exact head.
