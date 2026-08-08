#!/usr/bin/env python3
"""Classify an exact k8s-cluster namespace-manifest failure as inherited or new.

This harness never repairs or waives the production gate. It compares one exact
base/head pair, runs the repository-owned namespace tools in both trees, and
requires the pull request's new-debt ratchet to stay green.
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
from typing import Any

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


def run(
    command: list[str],
    *,
    cwd: Path,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def git(source: Path, *arguments: str) -> str:
    return run(["git", *arguments], cwd=source, capture=True).stdout.strip()


def run_json(command: list[str], *, cwd: Path) -> dict[str, Any]:
    completed = run(command, cwd=cwd, capture=True)
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"command did not emit JSON: {' '.join(command)}\n{completed.stdout}\n{completed.stderr}"
        ) from error
    if not isinstance(value, dict):
        raise RuntimeError(f"command emitted non-object JSON: {' '.join(command)}")
    return value


def sha256_json(value: dict[str, Any]) -> str:
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    return hashlib.sha256(encoded).hexdigest()


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
    contract = run_json(
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
    )
    inventory = run_json(
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
    )
    manifest = run_json(
        [
            "python3",
            "tools/namespace_manifest.py",
            "check",
            "--root",
            ".",
            "--format",
            "json",
        ],
        cwd=root,
    )
    return {
        "contract": contract,
        "contract_sha256": sha256_json(contract),
        "inventory": {
            "diagnostics": inventory.get("diagnostics"),
            "occurrence_count": len(inventory.get("occurrences", [])),
        },
        "inventory_sha256": sha256_json(inventory),
        "manifest": manifest,
        "manifest_report_sha256": sha256_json(manifest),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="_src/k8s-cluster")
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--evidence", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    evidence_path = Path(args.evidence).resolve()
    errors: list[str] = []

    checked_out_head = git(source, "rev-parse", "HEAD")
    if checked_out_head != args.head:
        errors.append(f"checked-out head mismatch: {checked_out_head}")

    for revision in (args.base, args.head):
        try:
            git(source, "cat-file", "-e", f"{revision}^{{commit}}")
        except subprocess.CalledProcessError:
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

    manifest_path = "catalog/namespaces/migration-manifest.json"
    base_manifest_blob = git(source, "rev-parse", f"{args.base}:{manifest_path}")
    head_manifest_blob = git(source, "rev-parse", f"{args.head}:{manifest_path}")

    if base.get("contract", {}).get("valid") is not True:
        errors.append("base namespace ownership contract is invalid")
    if head.get("contract", {}).get("valid") is not True:
        errors.append("head namespace ownership contract is invalid")
    if ratchet.get("valid") is not True:
        errors.append("new-debt ratchet is invalid")
    if ratchet.get("violations") not in ([], None):
        errors.append("new-debt ratchet found violations")
    if ratchet.get("diagnostics") not in ([], None):
        errors.append("new-debt ratchet emitted diagnostics")
    if base_manifest_blob != head_manifest_blob:
        errors.append("production PR changed the committed migration manifest")
    if base.get("manifest", {}).get("valid") is not False:
        errors.append("base manifest was not already stale; failure is not inherited")
    if head.get("manifest", {}).get("valid") is not False:
        errors.append("head manifest unexpectedly became valid")

    inherited_staleness = (
        base.get("manifest", {}).get("valid") is False
        and head.get("manifest", {}).get("valid") is False
        and base_manifest_blob == head_manifest_blob
        and ratchet.get("valid") is True
        and ratchet.get("violations") in ([], None)
        and ratchet.get("diagnostics") in ([], None)
    )

    evidence = {
        "schema_version": 1,
        "subject": {
            "repository": "ORESoftware/k8s-cluster",
            "base_sha": args.base,
            "head_sha": args.head,
            "checked_out_head_sha": checked_out_head,
            "changed_files": sorted(changed_files),
            "expected_changed_files": sorted(EXPECTED_CHANGED_FILES),
        },
        "manifest": {
            "path": manifest_path,
            "base_blob_sha": base_manifest_blob,
            "head_blob_sha": head_manifest_blob,
            "unchanged": base_manifest_blob == head_manifest_blob,
            "base_report": base["manifest"],
            "head_report": head["manifest"],
        },
        "inventory": {
            "base_occurrence_count": base["inventory"]["occurrence_count"],
            "head_occurrence_count": head["inventory"]["occurrence_count"],
            "delta": head["inventory"]["occurrence_count"]
            - base["inventory"]["occurrence_count"],
            "base_sha256": base["inventory_sha256"],
            "head_sha256": head["inventory_sha256"],
        },
        "contracts": {
            "base": base["contract"],
            "head": head["contract"],
            "ratchet": ratchet,
        },
        "classification": {
            "inherited_manifest_staleness": inherited_staleness,
            "production_gate_waived": False,
            "repair_included": False,
        },
        "errors": errors,
        "passed": not errors and inherited_staleness,
        "secrets_recorded": False,
    }

    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    evidence_path.chmod(0o600)

    print(
        json.dumps(
            {
                "passed": evidence["passed"],
                "inherited_manifest_staleness": inherited_staleness,
                "base_inventory": evidence["inventory"]["base_occurrence_count"],
                "head_inventory": evidence["inventory"]["head_occurrence_count"],
                "inventory_delta": evidence["inventory"]["delta"],
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
