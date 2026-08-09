#!/usr/bin/env bash
set -euo pipefail

: "${FIDUCIA_AWS_CONTEXT:=laptop-aws-sim}"
: "${FIDUCIA_GCP_CONTEXT:=laptop-gcp-sim}"
: "${FIDUCIA_AZURE_CONTEXT:=laptop-azure-sim}"

for command in kubectl jq awk grep; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }
done

contexts=("$FIDUCIA_AWS_CONTEXT" "$FIDUCIA_GCP_CONTEXT" "$FIDUCIA_AZURE_CONTEXT")
providers=(aws gcp azure)
servers=()
kubeconfig_json="$(kubectl config view --raw -o json)"

for i in 0 1 2; do
  context="${contexts[$i]}"
  provider="${providers[$i]}"

  kubectl config get-contexts "$context" >/dev/null 2>&1 || {
    echo "missing required physical-lab kubecontext: $context" >&2
    exit 3
  }

  cluster_name="$(jq -er --arg context "$context" '.contexts[] | select(.name == $context) | .context.cluster' <<<"$kubeconfig_json")" || {
    echo "unable to resolve Kubernetes cluster name for context $context" >&2
    exit 4
  }
  server="$(jq -er --arg cluster "$cluster_name" '.clusters[] | select(.name == $cluster) | .cluster.server' <<<"$kubeconfig_json")" || {
    echo "unable to resolve API server for context $context / cluster $cluster_name" >&2
    exit 4
  }
  servers+=("$server")

  ready="$(kubectl --context "$context" get nodes --no-headers 2>/dev/null | awk '$2 ~ /^Ready/ {n++} END {print n+0}')"
  [[ "$ready" -ge 1 ]] || { echo "$context has no Ready Kubernetes node" >&2; exit 5; }

  labels="$(kubectl --context "$context" get nodes -o jsonpath='{range .items[*]}{.metadata.labels.fiducia\.cloud/synthetic-provider}{"\n"}{end}' 2>/dev/null || true)"
  if [[ -n "$labels" ]] && ! grep -qx "$provider" <<<"$labels"; then
    echo "$context does not expose expected synthetic-provider=$provider label" >&2
    exit 6
  fi

done

if [[ "${servers[0]}" == "${servers[1]}" || "${servers[0]}" == "${servers[2]}" || "${servers[1]}" == "${servers[2]}" ]]; then
  echo 'physical certification requires three distinct Kubernetes API servers; namespaces in one cluster do not qualify' >&2
  exit 7
fi

printf '{\n  "linearIssue": "DEN-3008",\n  "result": "PASS",\n  "contexts": [\n'
for i in 0 1 2; do
  comma=','; [[ "$i" == 2 ]] && comma=''
  printf '    {"provider":"%s","context":"%s","apiServer":"%s"}%s\n' "${providers[$i]}" "${contexts[$i]}" "${servers[$i]}" "$comma"
done
printf '  ]\n}\n'
