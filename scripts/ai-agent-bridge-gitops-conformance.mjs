#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function gitBlobSha(text) {
  return crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function extractDocument(bundle, kind, name) {
  const documents = bundle.split(/^---\s*$/m).map((part) => part.trim()).filter(Boolean);
  const match = documents.find((document) => {
    const foundKind = document.match(/^kind:\s*(\S+)\s*$/m)?.[1];
    const metadata = document.match(/^metadata:\n((?:  .*\n?)*)/m)?.[1] ?? '';
    const foundName = metadata.match(/^  name:\s*(\S+)\s*$/m)?.[1];
    return foundKind === kind && foundName === name;
  });
  if (!match) throw new Error(`${kind}/${name} is missing from the Slack bundle`);
  return match;
}

function replicas(deployment) {
  const match = deployment.match(/^spec:\n(?:.*\n)*?  replicas:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : undefined;
}

function requireText(errors, text, needle, label) {
  if (!text.includes(needle)) errors.push(`${label}: missing ${needle}`);
}

function rejectText(errors, text, pattern, label) {
  if (pattern.test(text)) errors.push(`${label}: forbidden pattern ${pattern}`);
}

export function validateEvidenceContract(contract) {
  const errors = [];
  const { release } = contract;
  if (!SHA_RE.test(release.source_sha)) errors.push('release source SHA is invalid');
  if (!Number.isSafeInteger(release.workflow_run_id)) errors.push('release workflow run is invalid');
  if (release.workflow_run_attempt !== 1) errors.push('release workflow attempt must be 1');
  const targets = new Set();
  const refs = new Set();
  for (const artifact of release.artifacts) {
    const { payload } = artifact;
    if (!Number.isSafeInteger(artifact.artifact_id)) errors.push('artifact id is invalid');
    if (!DIGEST_RE.test(artifact.archive_digest)) errors.push(`${payload.target}: archive digest is invalid`);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (sha256(serialized) !== artifact.payload_sha256) {
      errors.push(`${payload.target}: retained payload checksum mismatch`);
    }
    if (payload.schema_version !== 2) errors.push(`${payload.target}: evidence schema must be 2`);
    if (payload.repository !== release.repository) errors.push(`${payload.target}: repository mismatch`);
    if (payload.source_sha !== release.source_sha) errors.push(`${payload.target}: source SHA mismatch`);
    if (payload.workflow_run_id !== release.workflow_run_id) errors.push(`${payload.target}: workflow run mismatch`);
    if (payload.workflow_run_attempt !== release.workflow_run_attempt) errors.push(`${payload.target}: workflow attempt mismatch`);
    if (!DIGEST_RE.test(payload.digest)) errors.push(`${payload.target}: image digest is invalid`);
    if (payload.image_ref !== `${payload.image}@${payload.digest}`) errors.push(`${payload.target}: image_ref mismatch`);
    if (payload.exact_digest_pulled !== true) errors.push(`${payload.target}: exact digest was not pulled`);
    if (payload.exact_runtime_contract_verified !== true) errors.push(`${payload.target}: runtime contract was not verified`);
    if (payload.exact_digest_vulnerability_scan !== 'passed') errors.push(`${payload.target}: vulnerability scan did not pass`);
    if (targets.has(payload.target)) errors.push(`${payload.target}: duplicate target`);
    if (refs.has(payload.image_ref)) errors.push(`${payload.target}: duplicate image reference`);
    targets.add(payload.target);
    refs.add(payload.image_ref);
  }
  for (const required of ['bridge', 'slack-command', 'runner']) {
    if (!targets.has(required)) errors.push(`missing ${required} artifact`);
  }
  return errors;
}

export function loadState(root, contract) {
  const files = {};
  for (const [key, descriptor] of Object.entries(contract.subject.files)) {
    const absolute = path.join(root, descriptor.path);
    files[key] = fs.readFileSync(absolute, 'utf8');
  }
  files.slack_deployment = extractDocument(files.slack_bundle, 'Deployment', 'dd-slack-command');
  files.slack_external_secret = extractDocument(files.slack_bundle, 'ExternalSecret', 'dd-slack-command-secrets');
  files.slack_network_policy = extractDocument(files.slack_bundle, 'NetworkPolicy', 'dd-slack-command');
  files.slack_ingress = extractDocument(files.slack_bundle, 'Ingress', 'dd-slack-command');
  return files;
}

export function validateState(state, contract) {
  const errors = [...validateEvidenceContract(contract)];
  const artifacts = Object.fromEntries(contract.release.artifacts.map((entry) => [entry.payload.target, entry.payload]));
  const deployments = [
    ['bridge', state.bridge_deployment, artifacts.bridge, contract.activation.bridge_replicas],
    ['slack-command', state.slack_deployment, artifacts['slack-command'], contract.activation.slack_command_replicas],
    ['runner', state.runner_deployment, artifacts.runner, contract.activation.runner_replicas],
  ];

  for (const [name, deployment, evidence, expectedReplicas] of deployments) {
    if (replicas(deployment) !== expectedReplicas) errors.push(`${name}: replicas must be ${expectedReplicas}`);
    if (count(deployment, `image: ${evidence.image_ref}`) !== 1) errors.push(`${name}: container image does not match retained evidence`);
    if (count(deployment, `dd.dev/image-reference: '${evidence.image_ref}'`) !== 2) errors.push(`${name}: image annotations do not match retained evidence`);
    if (count(deployment, `dd.dev/source-revision: '${contract.release.source_sha}'`) !== 2) errors.push(`${name}: source revision annotations are incoherent`);
    if (count(deployment, `dd.dev/release-workflow-run: '${contract.release.workflow_run_id}'`) !== 2) errors.push(`${name}: workflow run annotations are incoherent`);
    for (const required of [
      'automountServiceAccountToken: false',
      'enableServiceLinks: false',
      'allowPrivilegeEscalation: false',
      'readOnlyRootFilesystem: true',
      'runAsNonRoot: true',
      'type: RuntimeDefault',
      '- ALL',
    ]) requireText(errors, deployment, required, name);
    rejectText(errors, deployment, /\b(?:git clone|cargo build|cargo run|GH_PAT)\b|hostPath:|image:\s*[^\n]+:(?:latest|main)\b/, name);
  }

  requireText(errors, state.bridge_deployment, 'containerPort: 8142', 'bridge');
  requireText(errors, state.bridge_deployment, 'containerPort: 8143', 'bridge');
  requireText(errors, state.bridge_deployment, 'path: /readyz', 'bridge');
  requireText(errors, state.bridge_deployment, 'path: /healthz', 'bridge');
  requireText(errors, state.bridge_deployment, 'name: dd-ai-agent-bridge-secrets', 'bridge');
  requireText(errors, state.bridge_deployment, 'key: inbox_token', 'bridge');

  const expectedDryRun = contract.activation.slack_command_dry_run ? 'value: "true"' : 'value: "false"';
  requireText(errors, state.slack_deployment, '- name: SLACK_COMMAND_DRY_RUN', 'slack-command');
  requireText(errors, state.slack_deployment, expectedDryRun, 'slack-command');
  if (/SLACK_COMMAND_DRY_RUN[\s\S]{0,80}value:\s*"false"/.test(state.slack_deployment)) {
    errors.push('slack-command: dry-run activation gate is open');
  }
  for (const key of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_BRIDGE_BEARER', 'SLACK_COORDINATOR_BEARER']) {
    requireText(errors, state.slack_external_secret, `secretKey: ${key}`, 'slack ExternalSecret');
  }
  rejectText(errors, state.slack_external_secret, /\bvalue:\s*(?:xox|sk-)|stringData:/, 'slack ExternalSecret');

  const paths = [...state.slack_ingress.matchAll(/^\s*-\s+path:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(paths) !== JSON.stringify(contract.activation.exact_public_paths)) {
    errors.push(`slack ingress: exact path set mismatch (${paths.join(', ')})`);
  }
  if ((state.slack_ingress.match(/pathType: Exact/g) ?? []).length !== paths.length) {
    errors.push('slack ingress: every public path must use pathType Exact');
  }
  requireText(errors, state.slack_ingress, `host: ${contract.activation.public_host}`, 'slack ingress');

  requireText(errors, state.runner_deployment, 'dd.dev/activation-mode: held-zero', 'runner');
  requireText(errors, state.runner_deployment, 'name: dd-ai-agent-runner-secrets', 'runner');
  if (/name: dd-ai-agent-runner-secrets[\s\S]{0,80}optional:\s*true/.test(state.runner_deployment)) {
    errors.push('runner: provider secret must be required');
  }

  for (const [name, policy] of [
    ['bridge network policy', state.bridge_network_policy],
    ['runner network policy', state.runner_network_policy],
    ['slack network policy', state.slack_network_policy],
  ]) {
    requireText(errors, policy, 'policyTypes:', name);
    requireText(errors, policy, '- Ingress', name);
    requireText(errors, policy, '- Egress', name);
  }
  for (const cidr of ['10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']) {
    requireText(errors, state.runner_network_policy, `- ${cidr}`, 'runner network policy');
    requireText(errors, state.slack_network_policy, `- ${cidr}`, 'slack network policy');
  }
  requireText(errors, state.bridge_external_secret, 'kind: ExternalSecret', 'bridge ExternalSecret');
  requireText(errors, state.bridge_external_secret, 'secretKey: inbox_token', 'bridge ExternalSecret');
  rejectText(errors, state.bridge_external_secret, /stringData:|\binbox_token:\s*\S+/, 'bridge ExternalSecret');

  for (const [key, descriptor] of Object.entries(contract.subject.files)) {
    if (gitBlobSha(state[key]) !== descriptor.git_blob_sha) errors.push(`${key}: Git blob SHA mismatch`);
  }
  for (const resource of [
    'dd-ai-agent-bridge.externalsecret.yaml',
    'dd-ai-agent-bridge.deployment.yaml',
    'dd-ai-agent-bridge.networkpolicy.yaml',
    'dd-ai-agent-bridge.service.yaml',
    'dd-ai-agent-runner.deployment.yaml',
    'dd-ai-agent-runner.networkpolicy.yaml',
  ]) {
    if (count(state.kustomization, `- ${resource}`) !== 1) errors.push(`kustomization: ${resource} must be registered once`);
  }
  return errors;
}

export function buildSyntheticState(contract) {
  const evidence = Object.fromEntries(contract.release.artifacts.map((entry) => [entry.payload.target, entry.payload]));
  const common = (name, image, replicasValue, extra = '') => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  annotations:\n    dd.dev/source-revision: '${contract.release.source_sha}'\n    dd.dev/release-workflow-run: '${contract.release.workflow_run_id}'\n    dd.dev/image-reference: '${image}'\nspec:\n  replicas: ${replicasValue}\n  template:\n    metadata:\n      annotations:\n        dd.dev/source-revision: '${contract.release.source_sha}'\n        dd.dev/release-workflow-run: '${contract.release.workflow_run_id}'\n        dd.dev/image-reference: '${image}'\n    spec:\n      automountServiceAccountToken: false\n      enableServiceLinks: false\n      containers:\n        - name: runtime\n          image: ${image}\n          securityContext:\n            allowPrivilegeEscalation: false\n            readOnlyRootFilesystem: true\n            runAsNonRoot: true\n            capabilities:\n              drop:\n                - ALL\n            seccompProfile:\n              type: RuntimeDefault\n${extra}`;
  const bridge = common('dd-ai-agent-bridge', evidence.bridge.image_ref, 1, `          ports:\n            - containerPort: 8142\n            - containerPort: 8143\n          readinessProbe:\n            httpGet:\n              path: /readyz\n          livenessProbe:\n            httpGet:\n              path: /healthz\n          env:\n            - name: API_AUTH_BEARER\n              valueFrom:\n                secretKeyRef:\n                  name: dd-ai-agent-bridge-secrets\n                  key: inbox_token\n`);
  const slack = common('dd-slack-command', evidence['slack-command'].image_ref, 1, `          env:\n            - name: SLACK_COMMAND_DRY_RUN\n              value: "true"\n`);
  const runner = common('dd-ai-agent-runner', evidence.runner.image_ref, 0, `        dd.dev/activation-mode: held-zero\n          envFrom:\n            - secretRef:\n                name: dd-ai-agent-runner-secrets\n`);
  const slackExternalSecret = `apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nmetadata:\n  name: dd-slack-command-secrets\nspec:\n  data:\n${['SLACK_BOT_TOKEN','SLACK_SIGNING_SECRET','SLACK_BRIDGE_BEARER','SLACK_COORDINATOR_BEARER'].map((key) => `    - secretKey: ${key}\n      remoteRef:\n        key: test\n        property: ${key}`).join('\n')}\n`;
  const slackNetworkPolicy = `kind: NetworkPolicy\nspec:\n  policyTypes:\n    - Ingress\n    - Egress\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 0.0.0.0/0\n            except:\n${['10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16'].map((cidr) => `              - ${cidr}`).join('\n')}\n`;
  const ingress = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: dd-slack-command\nspec:\n  rules:\n    - host: ${contract.activation.public_host}\n      http:\n        paths:\n${contract.activation.exact_public_paths.map((p) => `          - path: ${p}\n            pathType: Exact`).join('\n')}\n`;
  const bundle = [
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: dd-ai-agent-bridge',
    slackExternalSecret,
    slack,
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: dd-slack-command',
    slackNetworkPolicy,
    'apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: dd-slack-command',
    ingress,
  ].join('\n---\n');
  const policy = `kind: NetworkPolicy\nspec:\n  policyTypes:\n    - Ingress\n    - Egress\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 0.0.0.0/0\n            except:\n${['10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16'].map((cidr) => `              - ${cidr}`).join('\n')}\n`;
  const state = {
    bridge_deployment: bridge,
    slack_bundle: bundle,
    runner_deployment: runner,
    bridge_external_secret: 'apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nspec:\n  data:\n    - secretKey: inbox_token\n      remoteRef:\n        key: test\n        property: inbox_token\n',
    bridge_network_policy: policy,
    runner_network_policy: policy,
    kustomization: ['dd-ai-agent-bridge.externalsecret.yaml','dd-ai-agent-bridge.deployment.yaml','dd-ai-agent-bridge.networkpolicy.yaml','dd-ai-agent-bridge.service.yaml','dd-ai-agent-runner.deployment.yaml','dd-ai-agent-runner.networkpolicy.yaml'].map((name) => `  - ${name}`).join('\n'),
    slack_deployment: slack,
    slack_external_secret: slackExternalSecret,
    slack_network_policy: slackNetworkPolicy,
    slack_ingress: ingress,
  };
  for (const [key, descriptor] of Object.entries(contract.subject.files)) descriptor.git_blob_sha = gitBlobSha(state[key]);
  return state;
}

function main() {
  const root = path.resolve(process.argv[2] ?? '_src/k8s-cluster');
  const contractPath = path.resolve(process.argv[3] ?? 'contracts/ai-agent-bridge-run-31264194679.json');
  const evidencePath = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const state = loadState(root, contract);
  const errors = validateState(state, contract);
  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    subject: contract.subject,
    release: {
      repository: contract.release.repository,
      source_sha: contract.release.source_sha,
      workflow_run_id: contract.release.workflow_run_id,
      workflow_run_attempt: contract.release.workflow_run_attempt,
      artifacts: contract.release.artifacts.map(({ artifact_id, artifact_name, archive_digest, payload_sha256, payload }) => ({ artifact_id, artifact_name, archive_digest, payload_sha256, target: payload.target, image_ref: payload.image_ref })),
    },
    activation: contract.activation,
    passed: errors.length === 0,
    errors,
    secrets_recorded: false,
  };
  if (evidencePath) {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ passed: result.passed, subject_revision: contract.subject.revision, errors }, null, 2));
  assert.deepEqual(errors, []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
