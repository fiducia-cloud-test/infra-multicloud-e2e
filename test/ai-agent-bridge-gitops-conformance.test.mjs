import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  buildSyntheticState,
  validateEvidenceContract,
  validateState,
} from '../scripts/ai-agent-bridge-gitops-conformance.mjs';

const original = JSON.parse(fs.readFileSync('contracts/ai-agent-bridge-run-31264194679.json', 'utf8'));

function fixture() {
  const contract = structuredClone(original);
  const state = buildSyntheticState(contract);
  return { contract, state };
}

function expectRejected(mutator, pattern) {
  const { contract, state } = fixture();
  mutator({ contract, state });
  assert.match(validateState(state, contract).join('\n'), pattern);
}

test('baseline exact-release tuple passes', () => {
  const { contract, state } = fixture();
  assert.deepEqual(validateState(state, contract), []);
});

test('retained evidence payload checksums are self-consistent', () => {
  assert.deepEqual(validateEvidenceContract(structuredClone(original)), []);
});

test('old bridge digest is rejected even when annotations are edited with it', () => {
  expectRejected(({ state }) => {
    state.bridge_deployment = state.bridge_deployment.replaceAll(
      'sha256:465803624fe98294620a644d6620ff8e179e7082a3142a4dd7bed68d1c9279d6',
      'sha256:bbf105c29cdbcec23d87ed0b21cfd548c43982cf6573aaf34a2fb1f4dc69a305',
    );
  }, /bridge: container image does not match retained evidence/);
});

test('source and workflow annotations cannot diverge', () => {
  expectRejected(({ state }) => {
    state.runner_deployment = state.runner_deployment.replaceAll(original.release.source_sha, '0'.repeat(40));
  }, /runner: source revision annotations are incoherent/);
  expectRejected(({ state }) => {
    state.slack_deployment = state.slack_deployment.replaceAll(String(original.release.workflow_run_id), '1');
  }, /slack-command: workflow run annotations are incoherent/);
});

test('activation boundaries fail closed', () => {
  expectRejected(({ state }) => {
    state.runner_deployment = state.runner_deployment.replace('replicas: 0', 'replicas: 1');
  }, /runner: replicas must be 0/);
  expectRejected(({ state }) => {
    state.slack_deployment = state.slack_deployment.replace('value: "true"', 'value: "false"');
  }, /dry-run activation gate is open/);
});

test('public route widening is rejected', () => {
  expectRejected(({ state }) => {
    state.slack_ingress = state.slack_ingress.replace('pathType: Exact', 'pathType: Prefix');
  }, /every public path must use pathType Exact/);
  expectRejected(({ state }) => {
    state.slack_ingress += '\n          - path: /\n            pathType: Prefix\n';
  }, /exact path set mismatch/);
});

test('literal secrets and optional provider credentials are rejected', () => {
  expectRejected(({ state }) => {
    state.slack_external_secret += '\nstringData:\n  SLACK_BOT_TOKEN: xoxb-not-real\n';
  }, /slack ExternalSecret: forbidden pattern/);
  expectRejected(({ state }) => {
    state.runner_deployment = state.runner_deployment.replace(
      'name: dd-ai-agent-runner-secrets',
      'name: dd-ai-agent-runner-secrets\n                optional: true',
    );
  }, /provider secret must be required/);
});

test('mutable images, runtime builds, PATs, and hostPath are rejected', () => {
  for (const injected of ['image: ghcr.io/oresoftware/fiducia-ai-agent-bridge:latest', 'cargo build', 'GH_PAT', 'hostPath:']) {
    expectRejected(({ state }) => {
      state.bridge_deployment += `\n${injected}\n`;
    }, /bridge: forbidden pattern/);
  }
});

test('private-network exclusions cannot be removed', () => {
  expectRejected(({ state }) => {
    state.runner_network_policy = state.runner_network_policy.replace('              - 169.254.0.0/16\n', '');
  }, /runner network policy: missing - 169\.254\.0\.0\/16/);
});

test('retained evidence tampering is rejected', () => {
  const contract = structuredClone(original);
  contract.release.artifacts[0].payload.digest = `sha256:${'f'.repeat(64)}`;
  assert.match(validateEvidenceContract(contract).join('\n'), /retained payload checksum mismatch/);
});
