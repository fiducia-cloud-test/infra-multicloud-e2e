# DEN-845 namespace baseline classification

The `ORESoftware/k8s-cluster` namespace migration workflow is a production gate. This independent `fiducia-cloud-test` lane determines whether the failure seen on bridge repair PR #1210 is inherited from its exact `dev` base or introduced by the repair.

## Exact comparison

- Base: `ORESoftware/k8s-cluster@18f1fa1dc8360c4817e1adbc1351b93f7d8604de`
- Head: `ORESoftware/k8s-cluster@664ea2fa106168e7e62ab70adb5719d54f59e9c4`
- Production PR: `ORESoftware/k8s-cluster#1210`

The harness runs the repository-owned classifier and manifest adversarial tests in both trees, regenerates each read-only inventory, evaluates each committed manifest, verifies the production PR's exact eight-file change set, compares the committed manifest blob, and runs the repository-owned base-to-head new-debt ratchet.

## Passing classification

A green result means all of the following are true:

- both namespace ownership contracts are valid;
- the committed migration manifest was already stale at the exact base;
- the same committed manifest blob remains unchanged at the exact head;
- the head remains stale for the inherited reason;
- the base-to-head namespace ratchet is valid and reports no new violations or diagnostics;
- the production PR changed only its reviewed bridge/Slack/runner manifest, workflow, and test paths.

The generated JSON records base/head inventory counts, deterministic report hashes, manifest diagnostics, the ratchet result, and exact changed paths. It contains no credentials or secret values.

## Non-goals

This classification does not repair, suppress, weaken, or waive the production namespace gate. The canonical manifest still needs a separately reviewed regeneration or debt-reconciliation change. This lane only prevents the unrelated bridge digest repair from being misclassified as the source of inherited namespace drift.
