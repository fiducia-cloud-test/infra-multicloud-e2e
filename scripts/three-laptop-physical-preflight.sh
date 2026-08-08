#!/usr/bin/env bash
set -euo pipefail

: "${FIDUCIA_AWS_CONTEXT:=laptop-aws-sim}"
: "${FIDUCIA_GCP_CONTEXT:=laptop-gcp-sim}"
: "${FIDUCIA_AZURE_CONTEXT:=laptop-azure-sim}"

command -v kubectl >/dev/null || { echo 'kubectl is required' >&2; exit 2; }

contexts=("$FIDUCIA_AWS_CONTEXT" "$FIDUCIA_GCP_CONTEXT" "$FIDUCIA_AZURE_CONTEXT")
providers=(aws gcp azure)
servers=()

for i in 0 1 2; do
  context="${contexts[$i]}"
  provider="${providers[$i]}"

  kubectl config get-contexts "$context" >/dev/null 2>&1 || {
    echo "missing required physical-lab kubecontext: $context" >&2
    exit 3
  }

  server="$(kubectl config view --raw -o jsonpath="{.clusters[?(@.name=='$(kubectl config view -o jsonpath="{.contexts[?(@.name=='$context')].context.cluster}")')].cluster.server}")"
  [[ -n "$server" ]] || { echo "unable to resolve API server for $context" >&2; exit 4; }
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
