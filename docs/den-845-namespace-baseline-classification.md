# DEN-845 deterministic namespace manifest refresh

The `ORESoftware/k8s-cluster` namespace migration workflow is a production gate. This independent `fiducia-cloud-test` lane reproduces that workflow for the exact base and exact bridge-repair head, proves whether a refresh is required, and emits one validated replacement manifest.

## Exact comparison

- Base: `ORESoftware/k8s-cluster@18f1fa1dc8360c4817e1adbc1351b93f7d8604de`
- Head: `ORESoftware/k8s-cluster@664ea2fa106168e7e62ab70adb5719d54f59e9c4`
- Production PR: `ORESoftware/k8s-cluster#1210`

The first version of this lane treated the failure as possibly inherited. Its exact comparison disproved that interpretation: the base manifest is valid, the digest-only head changes namespace inventory identities, and the unchanged committed manifest becomes stale. The production PR therefore needs a deterministic manifest refresh rather than an exception.

## Production-equivalent evaluation

The harness deliberately matches the production workflow's ordering and shell-redirection behavior:

1. Run the repository-owned namespace classifier and manifest adversarial tests.
2. Write the ownership-contract report.
3. Create and populate `artifacts/namespace-inventory.json` through the same redirection semantics used in production.
4. Check the committed migration manifest against that exact inventory.
5. Run the exact base-to-head namespace debt ratchet.
6. Render a replacement manifest from the exact head inventory.
7. Check the replacement manifest against the same inventory.

It also verifies the production PR's exact eight-file scope and confirms that the committed manifest blob was not already edited.

## Passing result

A green result means all of the following are true:

- both namespace ownership contracts are valid;
- the exact base manifest is valid under production semantics;
- the exact head manifest is stale under those same semantics;
- the production PR leaves the committed manifest blob unchanged before repair;
- the base-to-head ratchet reports no new violations or diagnostics;
- the generated replacement validates against the exact head inventory;
- the replacement entry count equals the exact head inventory occurrence count;
- the production PR changed only the reviewed bridge, Slack-command, runner, focused workflow, and contract-test paths.

The uploaded evidence records deterministic report hashes, counts, diagnostics, the ratchet result, the generated manifest SHA-256 and Git blob identity, and the exact changed paths. The candidate manifest is uploaded separately so it can be applied verbatim in a focused production commit.

## Safety boundary

This test lane never writes to the production repository and never weakens or waives the production namespace gate. It performs no cluster, Cloudflare, R2, Slack, or model-provider operation and needs no secret credential. The replacement must still be committed to PR #1210 and pass the production namespace workflow on the resulting exact head.
