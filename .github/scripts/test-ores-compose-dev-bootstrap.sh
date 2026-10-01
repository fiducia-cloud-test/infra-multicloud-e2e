#!/usr/bin/env bash
set -euo pipefail

: "${BIN:?set BIN to the exact ores-compose candidate binary}"
: "${SOURCE_FIXTURE_SHA:?set SOURCE_FIXTURE_SHA to the pinned public fixture revision}"

WORK_ROOT="${WORK_ROOT:-$PWD/tmp/ores-compose-dev-bootstrap-canary}"
rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT"

init_fixture_repo() {
  local root="$1"
  mkdir -p "$root"
  git -C "$root" init -q
  git -C "$root" config user.name 'ores-compose test canary'
  git -C "$root" config user.email 'ores-compose-canary@invalid.example'
}

wait_for_pid_file() {
  local supervisor_pid="$1"
  local pid_file="$2"
  local log_file="$3"
  local attempts="${4:-100}"
  for _ in $(seq 1 "$attempts"); do
    if [[ -f "$pid_file" ]]; then
      return 0
    fi
    if ! kill -0 "$supervisor_pid" 2>/dev/null; then
      cat "$log_file" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  echo "timed out waiting for compose pid file: $pid_file" >&2
  cat "$log_file" >&2 || true
  return 1
}

echo '== CLI contract and config admission =='
"$BIN" --help > "$WORK_ROOT/help.txt"
for flag in \
  skip-install \
  skip-zed-pkg \
  skip-symlinks \
  skip-simlinks \
  skip-zed-build \
  skip-zed-hooks \
  skip-source-sync \
  skip-rpc-gen \
  ignore-rpc-gen-warning \
  shutdown-timeout-ms
do
  grep -F -- "--$flag" "$WORK_ROOT/help.txt" >/dev/null
done

INVALID_ROOT="$WORK_ROOT/invalid-infra"
init_fixture_repo "$INVALID_ROOT"
cat > "$INVALID_ROOT/.ores-compose.yaml" <<'YAML'
schema_version: ores.compose.v1
project: invalid-bootstrap
definitely_unknown_field: true
services: {}
YAML
mkdir -p "$WORK_ROOT/empty-home"
if HOME="$WORK_ROOT/empty-home" "$BIN" up "$INVALID_ROOT/.ores-compose.yaml" >"$WORK_ROOT/invalid.out" 2>&1; then
  echo 'invalid config unexpectedly started' >&2
  exit 1
fi
! grep -F 'installing the official zed-pkg CLI' "$WORK_ROOT/invalid.out"

echo '== infra-owned pinned source and graceful down =='
SOURCE_ROOT="$WORK_ROOT/fiducia-compose-infra"
init_fixture_repo "$SOURCE_ROOT"
cat > "$SOURCE_ROOT/.ores-compose.yaml" <<YAML
schema_version: ores.compose.v1
project: fiducia-compose-source-test
allow_lazy_start: false
source:
  repository: https://github.com/fiducia-cloud-test/infra-multicloud-e2e.git
  commit: $SOURCE_FIXTURE_SHA
  checkout_dir: tmp/dev/fiducia-cloud-monorepo
services:
  hold:
    runtime: host
    command: ["node", "-e", "setInterval(() => {}, 1000)"]
YAML
"$BIN" up --skip-zed-pkg --skip-rpc-gen "$SOURCE_ROOT/.ores-compose.yaml" >"$WORK_ROOT/source-up.log" 2>&1 &
UP_PID=$!
wait_for_pid_file "$UP_PID" "$SOURCE_ROOT/.ores/run/fiducia-compose-source-test.pid" "$WORK_ROOT/source-up.log"
test -d "$SOURCE_ROOT/tmp/dev/fiducia-cloud-monorepo/.git"
"$BIN" down --shutdown-timeout-ms 1500 "$SOURCE_ROOT/.ores-compose.yaml"
wait "$UP_PID"
test ! -e "$SOURCE_ROOT/.ores/run/fiducia-compose-source-test.pid"

echo '== default Zed install, symlink refresh, build, and hooks =='
ZED_ROOT="$WORK_ROOT/zed-bootstrap-infra"
ZED_HOME="$WORK_ROOT/zed-home"
init_fixture_repo "$ZED_ROOT"
mkdir -p "$ZED_HOME"
cat > "$ZED_ROOT/.zpkg.toml" <<'TOML'
[package]
org = "fiducia-cloud-test"
name = "ores-compose-zed-bootstrap-fixture"
version = "0.1.0"
description = "ores-compose Zed lifecycle test fixture"
language = "rust"

[package.repository]
vcs = "git"
url = "https://github.com/fiducia-cloud-test/infra-multicloud-e2e"

[dependencies]

[install]
dir = ".vendor/.zed"
TOML
cat > "$ZED_ROOT/.ores-compose.yaml" <<'YAML'
schema_version: ores.compose.v1
project: zed-bootstrap-test
allow_lazy_start: false
services:
  hold:
    runtime: host
    command: ["node", "-e", "setInterval(() => {}, 1000)"]
YAML
HOME="$ZED_HOME" "$BIN" up --skip-rpc-gen "$ZED_ROOT/.ores-compose.yaml" >"$WORK_ROOT/zed-up.log" 2>&1 &
UP_PID=$!
wait_for_pid_file "$UP_PID" "$ZED_ROOT/.ores/run/zed-bootstrap-test.pid" "$WORK_ROOT/zed-up.log" 200
grep -F '"event":"zed_stage"' "$WORK_ROOT/zed-up.log" >/dev/null
grep -F 'install dependencies' "$WORK_ROOT/zed-up.log" >/dev/null
grep -F 'refresh local dependency symlinks' "$WORK_ROOT/zed-up.log" >/dev/null
grep -F 'recompile dependency build hooks' "$WORK_ROOT/zed-up.log" >/dev/null
grep -F 'run pre/post-install hooks' "$WORK_ROOT/zed-up.log" >/dev/null
HOME="$ZED_HOME" "$BIN" down --shutdown-timeout-ms 1500 "$ZED_ROOT/.ores-compose.yaml"
wait "$UP_PID"

echo '== RPC temporary regeneration and drift controls =='
RPC_ROOT="$WORK_ROOT/rpc-bootstrap-infra"
TOOLBIN="$WORK_ROOT/fake-tools"
init_fixture_repo "$RPC_ROOT"
mkdir -p \
  "$RPC_ROOT/demo-web-server.rs/contracts" \
  "$RPC_ROOT/demo-lib-core/generated/rpc" \
  "$RPC_ROOT/demo-pub-lib-core/generated/rpc" \
  "$TOOLBIN"
cat > "$RPC_ROOT/demo-web-server.rs/.ores-stack.toml" <<'TOML'
version = 1
api_docs_route_map = "contracts/service.route-map.json"
TOML
printf '{"service":"demo","map":{}}\n' > "$RPC_ROOT/demo-web-server.rs/contracts/service.route-map.json"
cat > "$TOOLBIN/ores-stack" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = rpc
test "$2" = sync
shift 2
lib=''
pub=''
while (($#)); do
  case "$1" in
    --lib-core) lib="$2"; shift 2 ;;
    --pub-lib-core) pub="$2"; shift 2 ;;
    --web-repo|--route-map|--rust-dto-module) shift 2 ;;
    *) echo "unexpected ores-stack arg: $1" >&2; exit 2 ;;
  esac
done
test -n "$lib"
test -n "$pub"
mkdir -p "$lib/generated/rpc" "$pub/generated/rpc"
printf 'deterministic-internal-rpc\n' > "$lib/generated/rpc/client.txt"
printf 'deterministic-public-rpc\n' > "$pub/generated/rpc/client.txt"
SH
chmod +x "$TOOLBIN/ores-stack"
printf 'deterministic-internal-rpc\n' > "$RPC_ROOT/demo-lib-core/generated/rpc/client.txt"
printf 'deterministic-public-rpc\n' > "$RPC_ROOT/demo-pub-lib-core/generated/rpc/client.txt"
cat > "$RPC_ROOT/.ores-compose.yaml" <<'YAML'
schema_version: ores.compose.v1
project: rpc-bootstrap-test
allow_lazy_start: false
services:
  hold:
    runtime: host
    command: ["node", "-e", "setInterval(() => {}, 1000)"]
YAML

git -C "$RPC_ROOT" add .
git -C "$RPC_ROOT" commit -qm 'seed rpc fixture'

PATH="$TOOLBIN:$PATH" "$BIN" up --skip-zed-pkg "$RPC_ROOT/.ores-compose.yaml" >"$WORK_ROOT/rpc-clean.log" 2>&1 &
UP_PID=$!
wait_for_pid_file "$UP_PID" "$RPC_ROOT/.ores/run/rpc-bootstrap-test.pid" "$WORK_ROOT/rpc-clean.log"
PATH="$TOOLBIN:$PATH" "$BIN" down --shutdown-timeout-ms 1500 "$RPC_ROOT/.ores-compose.yaml"
wait "$UP_PID"

printf 'drift\n' >> "$RPC_ROOT/demo-lib-core/generated/rpc/client.txt"
if PATH="$TOOLBIN:$PATH" "$BIN" up --skip-zed-pkg "$RPC_ROOT/.ores-compose.yaml" >"$WORK_ROOT/rpc-drift.log" 2>&1; then
  echo 'RPC drift unexpectedly admitted' >&2
  exit 1
fi
grep -F 'generated RPC drift detected' "$WORK_ROOT/rpc-drift.log" >/dev/null
grep -F 'deterministic-internal-rpc' "$WORK_ROOT/rpc-drift.log" >/dev/null

PATH="$TOOLBIN:$PATH" "$BIN" up --skip-zed-pkg --ignore-rpc-gen-warning "$RPC_ROOT/.ores-compose.yaml" >"$WORK_ROOT/rpc-ignore.log" 2>&1 &
UP_PID=$!
wait_for_pid_file "$UP_PID" "$RPC_ROOT/.ores/run/rpc-bootstrap-test.pid" "$WORK_ROOT/rpc-ignore.log"
PATH="$TOOLBIN:$PATH" "$BIN" down --shutdown-timeout-ms 1500 "$RPC_ROOT/.ores-compose.yaml"
wait "$UP_PID"

PATH="$TOOLBIN:$PATH" "$BIN" up --skip-zed-pkg --skip-rpc-gen "$RPC_ROOT/.ores-compose.yaml" >"$WORK_ROOT/rpc-skip.log" 2>&1 &
UP_PID=$!
wait_for_pid_file "$UP_PID" "$RPC_ROOT/.ores/run/rpc-bootstrap-test.pid" "$WORK_ROOT/rpc-skip.log"
PATH="$TOOLBIN:$PATH" "$BIN" down --shutdown-timeout-ms 1500 "$RPC_ROOT/.ores-compose.yaml"
wait "$UP_PID"

echo 'ores-compose dev bootstrap canary passed'
