#!/usr/bin/env bash
set -euo pipefail
umask 077

CONTRACT_PATH="${1:-contracts/ai-agent-bridge-run-31264194679.json}"
EVIDENCE_PATH="${2:-${RUNNER_TEMP:-/tmp}/ai-agent-bridge-runtime-images.json}"
WORK_DIR="$(mktemp -d)"
RESULTS_PATH="${WORK_DIR}/results.jsonl"
trap 'rm -rf "${WORK_DIR}"' EXIT
: >"${RESULTS_PATH}"

command -v docker >/dev/null
command -v jq >/dev/null

SOURCE_SHA="$(jq -er '.release.source_sha | select(test("^[0-9a-f]{40}$"))' "${CONTRACT_PATH}")"
mapfile -t TARGETS < <(jq -er '.release.artifacts[] | [.payload.target, .payload.image_ref] | @tsv' "${CONTRACT_PATH}")
[[ "${#TARGETS[@]}" -eq 3 ]]

for row in "${TARGETS[@]}"; do
  IFS=$'\t' read -r target image_ref <<<"${row}"
  case "${target}" in
    bridge) expected_entrypoint='/usr/local/bin/fiducia-ai-agent-bridge' ;;
    slack-command) expected_entrypoint='/usr/local/bin/fiducia-slack-command' ;;
    runner) expected_entrypoint='/usr/local/bin/fiducia-ai-agent-runner' ;;
    *) echo "unexpected target: ${target}" >&2; exit 1 ;;
  esac

  [[ "${image_ref}" =~ @sha256:[0-9a-f]{64}$ ]]
  docker pull "${image_ref}"

  user="$(docker image inspect --format '{{.Config.User}}' "${image_ref}")"
  entrypoint="$(docker image inspect --format '{{index .Config.Entrypoint 0}}' "${image_ref}")"
  cmd="$(docker image inspect --format '{{join .Config.Cmd " "}}' "${image_ref}")"
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_ref}")"
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "${image_ref}")"

  [[ "${user}" == 'nonroot:nonroot' ]]
  [[ "${entrypoint}" == "${expected_entrypoint}" ]]
  [[ -z "${cmd}" ]]
  [[ "${revision}" == "${SOURCE_SHA}" ]]
  jq -e --arg image_ref "${image_ref}" 'index($image_ref) != null' <<<"${repo_digests}" >/dev/null

  jq -cn \
    --arg target "${target}" \
    --arg image_ref "${image_ref}" \
    --arg source_sha "${revision}" \
    --arg user "${user}" \
    --arg entrypoint "${entrypoint}" \
    --argjson repo_digests "${repo_digests}" \
    '{
      target: $target,
      image_ref: $image_ref,
      source_sha: $source_sha,
      user: $user,
      entrypoint: $entrypoint,
      cmd_empty: true,
      exact_repo_digest_present: ($repo_digests | index($image_ref) != null)
    }' >>"${RESULTS_PATH}"
done

mkdir -p "$(dirname "${EVIDENCE_PATH}")"
jq -s \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_sha "${SOURCE_SHA}" \
  '{
    schema_version: 1,
    generated_at: $generated_at,
    source_sha: $source_sha,
    images: .,
    exact_images_pulled: true,
    runtime_contracts_verified: true,
    secrets_recorded: false,
    passed: true
  }' "${RESULTS_PATH}" >"${EVIDENCE_PATH}"
chmod 600 "${EVIDENCE_PATH}"
jq -e '.passed == true and (.images | length) == 3 and all(.images[]; .exact_repo_digest_present and .cmd_empty)' "${EVIDENCE_PATH}" >/dev/null
jq '{passed, source_sha, image_count: (.images | length), targets: [.images[].target]}' "${EVIDENCE_PATH}"
