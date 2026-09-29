#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
required=(neon supabase cloudflare aws gcp tf)
for root in "${required[@]}"; do
  if [[ ! -d "$root" || -L "$root" ]]; then
    printf 'infra provider root must be a real directory: %s\n' "$root" >&2
    exit 2
  fi
  if [[ ! -f "$root/.ores-provider-root.json" || -L "$root/.ores-provider-root.json" ]]; then
    printf 'missing regular provider marker: %s/.ores-provider-root.json\n' "$root" >&2
    exit 2
  fi
done

command -v oresc >/dev/null 2>&1 || { echo 'oresc is required' >&2; exit 3; }
oresc --no-json audit repo --path . --profile baseline --required-paths 'neon,supabase,cloudflare,aws,gcp,tf'
