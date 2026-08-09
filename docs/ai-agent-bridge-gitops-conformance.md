# AI Agent Bridge artifact-backed GitOps conformance

This test-org lane independently certifies one exact AI Agent Bridge release tuple before the corresponding Kubernetes change is eligible for merge.

## Scope

The subject is `ORESoftware/k8s-cluster` pull request 1210 at commit `664ea2fa106168e7e62ab70adb5719d54f59e9c4`. The release source is `ORESoftware/ai-agent-bridge.rs@ec667946b1f8725b6baea8e67ae6a701d602dc04`, published by trusted workflow run `31264194679`, attempt 1.

The contract records the retained schema-v2 payloads and payload checksums for the bridge, signed Slack command ingress, and provider runner. It then checks the exact Git blob identities of the production manifests, source/run annotations, digest-only image references, replica gates, Slack dry-run mode, required External Secrets, exact public routes, and NetworkPolicy exclusions.

A separate runtime step anonymously pulls all three public `image@sha256:` references and verifies their non-root user, exact entrypoint, empty command, OCI source-revision label, and requested repository digest.

## Fail-closed boundaries

The lane fails when any of these conditions appears:

- a manifest digest differs from the retained artifact payload;
- source SHA or workflow-run annotations drift;
- the provider runner is raised above zero replicas;
- Slack dry-run is disabled;
- a public route is added or widened from `Exact`;
- a provider secret becomes optional or a credential literal appears;
- a mutable image tag, runtime compiler, Git checkout, PAT, or `hostPath` is introduced;
- private, loopback, or metadata CIDR exclusions are removed;
- a retained evidence payload or exact production Git blob changes.

The adversarial unit suite exercises these negative paths before the exact production head is evaluated.

## Evidence and limitations

The workflow uploads metadata-only JSON. It never records response bodies, credentials, provider prompts, or provider outputs. It uses only read-only public repository and GHCR access; no GitHub PAT, Linear token, Cloudflare token, R2 credential, Slack secret, or model-provider key is required.

A green result proves release-evidence and GitOps coherence for the exact pinned commits. It does **not** prove Argo CD reconciliation, live pod image IDs, ExternalSecret readiness, public-origin health, signed Slack delivery, ChatGPT execution, Claude execution, cancellation, rollback, or end-user usability. Those remain live-cluster acceptance work under DEN-845 and DEN-1041.

## Coordination

This lane complements rather than duplicates the focused `fiducia-cloud-test/control-plane-e2e` lifecycle/admission and registry-routing lanes. Any production-head change requires updating the exact subject revision and Git blob identities here and obtaining a fresh test-org result before merge.
