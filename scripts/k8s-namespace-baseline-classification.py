#!/usr/bin/env python3
"""Generate and certify the deterministic namespace-manifest refresh for one PR.

This independent test-org harness reproduces the production namespace workflow
for one exact k8s-cluster base/head pair. It never writes to the production
repository. A passing run proves that the digest-only PR makes the committed
manifest stale, introduces no new namespace debt, and has one deterministic
replacement manifest that validates against the exact head inventory.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Iterable

EXPECTED_CHANGED_FILES = {
    ".github/workflows/ai-agent-runner-k8s-contract.yml",
    ".github/workflows/slack-command-gitops.yml",
    "remote/argocd/dd-next-runtime/dd-ai-agent-bridge.deployment.yaml",
    "remote/argocd/dd-next-runtime/dd-ai-agent-bridge.service.yaml",
    "remote/argocd/dd-next-runtime/dd-ai-agent-runner.deployment.yaml",
    "remote/tests/general/ai-agent-bridge-k8s-contract.test.mjs",
    "remote/tests/general/ai-agent-runner-k8s-contract.test.mjs",
    "remote/tests/general/slack-command-gitops.test.mjs",
}

MANIFEST_PATH = Path("catalog/namespaces/migration-manifest.json")
INVENTORY_PATH = Path("artifacts/namespace-inventory.json")
CONTRACT_REPORT_PATH = Path("artifacts/namespace-contract-report.json")
MANIFEST_REPORT_PATH = Path("artifacts/namespace-manifest-report.json")
REGISTRY_PATH = Path("catalog/namespaces/namespace-registry.yaml")
RULES_PATH = Path("catalog/namespaces/namespace-rules.yaml")


def run(
    command: list[str],
    *,
    cwd: Path,
    capture: bool = False,
    allowed_codes: Iterable[int] = (0,),
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
    )
    if completed.returncode not in set(allowed_codes):
        raise RuntimeError(
            f"command failed with {completed.returncode}: {' '.join(command)}\n"
            f"stdout:\n{completed.stdout or ''}\n"
            f"stderr:\n{completed.stderr or ''}"
        )
    return completed


def git(source: Path, *arguments: str) -> str:
    return run(["git", *arguments], cwd=source, capture=True).stdout.strip()


def parse_json(text: str, *, label: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} did not emit valid JSON: {text[:1000]}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} emitted a non-object JSON value")
    return value


def run_json(
    command: list[str],
    *,
    cwd: Path,
    allowed_codes: Iterable[int] = (0,),
) -> dict[str, Any]:
    completed = run(command, cwd=cwd, capture=True, allowed_codes=allowed_codes)
    return parse_json(completed.stdout, label=" ".join(command))


def run_json_redirect(
    command: list[str],
    *,
    cwd: Path,
    output: Path,
    allowed_codes: Iterable[int] = (0,),
) -> dict[str, Any]:
    """Reproduce shell `command > output` semantics used by production CI."""
    absolute = cwd / output
    absolute.parent.mkdir(parents=True, exist_ok=True)
    with absolute.open("w", encoding="utf-8") as handle:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            stdout=handle,
            stderr=subprocess.PIPE,
        )
    if completed.returncode not in set(allowed_codes):
        raise RuntimeError(
            f"command failed with {completed.returncode}: {' '.join(command)}\n"
            f"stderr:\n{completed.stderr or ''}"
        )
    return parse_json(absolute.read_text(encoding="utf-8"), label=" ".join(command))


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(value).encode())


def git_blob_sha(value: bytes) -> str:
    return hashlib.sha1(f"blob {len(value)}\0".encode() + value).hexdigest()


def manifest_command(action: str, manifest: Path) -> list[str]:
    return [
        "python3",
        "tools/namespace_manifest.py",
        action,
        "--root",
        ".",
        "--manifest",
        str(manifest),
        "--inventory",
        str(INVENTORY_PATH),
        "--registry",
        str(REGISTRY_PATH),
        "--rules",
        str(RULES_PATH),
        "--format",
        "json",
    ]


def evaluate_tree(root: Path) -> dict[str, Any]:
    run(
        [
            "python3",
            "-m",
            "py_compile",
            "tools/namespace_migration.py",
            "tools/test_namespace_migration.py",
            "tools/namespace_manifest.py",
            "tools/test_namespace_manifest.py",
        ],
        cwd=root,
    )
    run(["python3", "tools/test_namespace_migration.py"], cwd=root)
    run(["python3", "tools/test_namespace_manifest.py"], cwd=root)

    # Keep the same ordering and redirection semantics as the production job.
    contract = run_json_redirect(
        [
            "python3",
            "tools/namespace_migration.py",
            "check",
            "--root",
            ".",
            "--format",
            "json",
        ],
        cwd=root,
        output=CONTRACT_REPORT_PATH,
    )
    inventory = run_json_redirect(
        [
            "python3",
            "tools/namespace_migration.py",
            "inventory",
            "--root",
            ".",
            "--format",
            "json",
        ],
        cwd=root,
        output=INVENTORY_PATH,
    )
    manifest = run_json_redirect(
        manifest_command("check", MANIFEST_PATH),
        cwd=root,
        output=MANIFEST_REPORT_PATH,
        allowed_codes=(0, 2),
    )

    return {
        "contract": contract,
        "contract_sha256": sha256_json(contract),
        "inventory": inventory,
        "inventory_sha256": sha256_json(inventory),
        "inventory_occurrence_count": len(inventory.get("occurrences", [])),
        "manifest": manifest,
        "manifest_report_sha256": sha256_json(manifest),
    }


def render_candidate(root: Path, candidate_path: Path) -> dict[str, Any]:
    candidate_path.parent.mkdir(parents=True, exist_ok=True)
    command = manifest_command("render", MANIFEST_PATH)
    command.extend(["--output", str(candidate_path)])
    render_report = run_json(command, cwd=root)
    candidate_bytes = candidate_path.read_bytes()
    candidate = parse_json(candidate_bytes.decode(), label=str(candidate_path))
    candidate_check = run_json(
        manifest_command("check", candidate_path),
        cwd=root,
    )
    return {
        "render_report": render_report,
        "candidate": candidate,
        "candidate_check": candidate_check,
        "candidate_sha256": sha256_bytes(candidate_bytes),
        "candidate_git_blob_sha": git_blob_sha(candidate_bytes),
        "candidate_entry_count": len(candidate.get("entries", [])),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="_src/k8s-cluster")
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--candidate", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    evidence_path = Path(args.evidence).resolve()
    candidate_path = Path(args.candidate).resolve()
    errors: list[str] = []
    checked_out_head = ""
    changed_files: set[str] = set()
    base: dict[str, Any] = {}
    head: dict[str, Any] = {}
    ratchet: dict[str, Any] = {}
    generated: dict[str, Any] = {}
    base_manifest_blob = ""
    head_manifest_blob = ""
    exception: str | None = None

    try:
        checked_out_head = git(source, "rev-parse", "HEAD")
        if checked_out_head != args.head:
            errors.append(f"checked-out head mismatch: {checked_out_head}")

        for revision in (args.base, args.head):
            try:
                git(source, "cat-file", "-e", f"{revision}^{{commit}}")
            except RuntimeError:
                errors.append(f"missing exact commit object: {revision}")

        changed_files = {
            line
            for line in git(source, "diff", "--name-only", args.base, args.head).splitlines()
            if line
        }
        if changed_files != EXPECTED_CHANGED_FILES:
            errors.append(
                "changed file set mismatch: "
                + json.dumps(
                    {
                        "missing": sorted(EXPECTED_CHANGED_FILES - changed_files),
                        "unexpected": sorted(changed_files - EXPECTED_CHANGED_FILES),
                    },
                    sort_keys=True,
                )
            )

        with tempfile.TemporaryDirectory(prefix="k8s-namespace-base-") as temporary:
            base_root = Path(temporary) / "base"
            base_root.mkdir()
            archive = subprocess.run(
                ["git", "archive", "--format=tar", args.base],
                cwd=source,
                check=True,
                stdout=subprocess.PIPE,
            ).stdout
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
                bundle.extractall(base_root, filter="data")
            base = evaluate_tree(base_root)

        head = evaluate_tree(source)
        generated = render_candidate(source, candidate_path)

        ratchet = run_json(
            [
                "python3",
                "tools/namespace_migration.py",
                "ratchet",
                "--root",
                ".",
                "--base-ref",
                args.base,
                "--head-ref",
                args.head,
                "--format",
                "json",
            ],
            cwd=source,
        )

        manifest_path_text = MANIFEST_PATH.as_posix()
        base_manifest_blob = git(source, "rev-parse", f"{args.base}:{manifest_path_text}")
        head_manifest_blob = git(source, "rev-parse", f"{args.head}:{manifest_path_text}")

        if base.get("contract", {}).get("valid") is not True:
            errors.append("base namespace ownership contract is invalid")
        if head.get("contract", {}).get("valid") is not True:
            errors.append("head namespace ownership contract is invalid")
        if base.get("manifest", {}).get("valid") is not True:
            errors.append("exact base manifest is not valid under production semantics")
        if head.get("manifest", {}).get("valid") is not False:
            errors.append("exact head manifest is not stale; no refresh candidate is justified")
        if base_manifest_blob != head_manifest_blob:
            errors.append("production PR already changed the committed migration manifest")
        if ratchet.get("valid") is not True:
            errors.append("new-debt ratchet is invalid")
        if ratchet.get("violations") not in ([], None):
            errors.append("new-debt ratchet found violations")
        if ratchet.get("diagnostics") not in ([], None):
            errors.append("new-debt ratchet emitted diagnostics")
        if generated.get("candidate_check", {}).get("valid") is not True:
            errors.append("generated manifest does not validate against the exact head inventory")
        if generated.get("candidate_entry_count") != head.get("inventory_occurrence_count"):
            errors.append("generated manifest entry count does not match exact head inventory")

    except Exception as error:
        exception = f"{type(error).__name__}: {error}"
        errors.append(exception)

    refresh_required = (
        base.get("manifest", {}).get("valid") is True
        and head.get("manifest", {}).get("valid") is False
        and bool(base_manifest_blob)
        and base_manifest_blob == head_manifest_blob
        and ratchet.get("valid") is True
        and ratchet.get("violations") in ([], None)
        and ratchet.get("diagnostics") in ([], None)
        and generated.get("candidate_check", {}).get("valid") is True
        and generated.get("candidate_entry_count") == head.get("inventory_occurrence_count")
    )
    passed = not errors and refresh_required

    evidence = {
        "schema_version": 2,
        "subject": {
            "repository": "ORESoftware/k8s-cluster",
            "base_sha": args.base,
            "head_sha": args.head,
            "checked_out_head_sha": checked_out_head,
            "changed_files": sorted(changed_files),
            "expected_changed_files": sorted(EXPECTED_CHANGED_FILES),
        },
        "production_semantics": {
            "contract_report_path": CONTRACT_REPORT_PATH.as_posix(),
            "inventory_path": INVENTORY_PATH.as_posix(),
            "manifest_report_path": MANIFEST_REPORT_PATH.as_posix(),
            "shell_redirection_emulated": True,
        },
        "base": {
            "contract": base.get("contract"),
            "contract_sha256": base.get("contract_sha256"),
            "inventory_occurrence_count": base.get("inventory_occurrence_count"),
            "inventory_sha256": base.get("inventory_sha256"),
            "manifest": base.get("manifest"),
            "manifest_report_sha256": base.get("manifest_report_sha256"),
            "committed_manifest_blob_sha": base_manifest_blob,
        },
        "head": {
            "contract": head.get("contract"),
            "contract_sha256": head.get("contract_sha256"),
            "inventory_occurrence_count": head.get("inventory_occurrence_count"),
            "inventory_sha256": head.get("inventory_sha256"),
            "manifest": head.get("manifest"),
            "manifest_report_sha256": head.get("manifest_report_sha256"),
            "committed_manifest_blob_sha": head_manifest_blob,
        },
        "generated_manifest": {
            "path": str(candidate_path),
            "sha256": generated.get("candidate_sha256"),
            "git_blob_sha": generated.get("candidate_git_blob_sha"),
            "entry_count": generated.get("candidate_entry_count"),
            "render_report": generated.get("render_report"),
            "check_report": generated.get("candidate_check"),
        },
        "ratchet": ratchet,
        "classification": {
            "deterministic_manifest_refresh_required": refresh_required,
            "production_gate_waived": False,
            "production_repository_modified": False,
            "candidate_generated": candidate_path.exists(),
        },
        "exception": exception,
        "errors": errors,
        "passed": passed,
        "secrets_recorded": False,
    }

    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(canonical_json(evidence), encoding="utf-8")
    evidence_path.chmod(0o600)
    if candidate_path.exists():
        candidate_path.chmod(0o600)

    print(
        json.dumps(
            {
                "passed": passed,
                "refresh_required": refresh_required,
                "base_manifest_valid": base.get("manifest", {}).get("valid"),
                "head_manifest_valid": head.get("manifest", {}).get("valid"),
                "base_inventory": base.get("inventory_occurrence_count"),
                "head_inventory": head.get("inventory_occurrence_count"),
                "candidate_entries": generated.get("candidate_entry_count"),
                "candidate_sha256": generated.get("candidate_sha256"),
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
