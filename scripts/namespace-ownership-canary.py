#!/usr/bin/env python3
"""Credential-free cross-organization canary for DEN-2786."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence


def git(root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", default="subject")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    arguments = parser.parse_args(argv)

    subject = Path(arguments.subject).resolve()
    tools = subject / "tools"
    if not tools.is_dir():
        raise SystemExit(f"missing subject tools directory: {tools}")
    sys.path.insert(0, str(tools))

    from namespace_migration import (  # pylint: disable=import-error,import-outside-toplevel
        Reference,
        classify_reference,
        load_contract,
        ratchet_report,
        scan_line,
    )
    from namespace_test_owner_contract import (  # pylint: disable=import-error,import-outside-toplevel
        build_report as build_test_owner_report,
    )

    failures: list[str] = []
    evidence: dict[str, Any] = {
        "subject": str(subject),
        "checks": {},
    }

    contract = load_contract(subject)
    errors = [item for item in contract.diagnostics if item.severity == "error"]
    if errors:
        failures.append(f"subject namespace contract has {len(errors)} error(s)")

    test_owner_report, test_owner_status = build_test_owner_report(subject)
    binding = next(
        (
            item
            for item in test_owner_report.get("bindings", [])
            if item.get("test_owner") == "fiducia-cloud-test"
        ),
        None,
    )
    expected_binding = {
        "test_owner": "fiducia-cloud-test",
        "canonical_owner": "fiducia-cloud",
        "github_owner": "fiducia-cloud-test",
    }
    if test_owner_status != 0 or binding != expected_binding:
        failures.append("fiducia-cloud-test canonical binding is missing or invalid")
    evidence["checks"]["testOwnerBinding"] = {
        "expected": expected_binding,
        "actual": binding,
        "valid": binding == expected_binding and test_owner_status == 0,
    }

    rule, target = classify_reference(
        Reference(
            "slash-namespace",
            "dd/remote-dev/fiducia-namespace-canary",
            1,
        ),
        contract.rules,
    )
    production_classification = {
        "rule": rule.rule_id if rule else None,
        "owner": rule.owner if rule else None,
        "status": rule.status if rule else None,
        "target": target,
    }
    expected_classification = {
        "rule": "remote-dev.fiducia",
        "owner": "fiducia-cloud",
        "status": "review-required",
        "target": "fiducia-cloud/dev/namespace-canary",
    }
    if production_classification != expected_classification:
        failures.append(
            "test execution identity changed the canonical owner of a Fiducia legacy reference"
        )
    evidence["checks"]["canonicalClassification"] = {
        "expected": expected_classification,
        "actual": production_classification,
        "valid": production_classification == expected_classification,
    }

    test_owned_path = "fiducia-cloud-test/dev/namespace-canary/runtime"
    test_path_references = scan_line(f"secret: {test_owned_path}")
    if test_path_references:
        failures.append("a registered test-owned target was misidentified as legacy debt")
    evidence["checks"]["testOwnedPath"] = {
        "path": test_owned_path,
        "legacyReferences": [
            {"system": item.system, "value": item.value, "column": item.column}
            for item in test_path_references
        ],
        "valid": not test_path_references,
    }

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        git(root, "init", "-q")
        git(root, "config", "user.email", "namespace-canary@example.invalid")
        git(root, "config", "user.name", "Namespace Canary")

        (root / "README.md").write_text("base\n", encoding="utf-8")
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", "base")
        base = git(root, "rev-parse", "HEAD")

        (root / "allowed.yaml").write_text(
            f"secret: {test_owned_path}\n",
            encoding="utf-8",
        )
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", "registered test path")
        allowed = git(root, "rev-parse", "HEAD")
        allowed_report, allowed_status = ratchet_report(root, base, allowed)
        if allowed_status != 0 or not allowed_report.get("valid"):
            failures.append("ratchet rejected a registered test-owned target")

        (root / "legacy.yaml").write_text(
            "secret: dd/remote-dev/fiducia-namespace-canary\n",
            encoding="utf-8",
        )
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", "legacy regression")
        legacy = git(root, "rev-parse", "HEAD")
        legacy_report, legacy_status = ratchet_report(root, allowed, legacy)
        violations = legacy_report.get("violations", [])
        if legacy_status == 0 or len(violations) != 1:
            failures.append("ratchet did not reject exactly one newly added legacy reference")

        evidence["checks"]["ratchet"] = {
            "registeredPath": {
                "valid": allowed_status == 0 and bool(allowed_report.get("valid")),
                "violations": allowed_report.get("violations", []),
            },
            "legacyRegression": {
                "valid": legacy_status != 0 and len(violations) == 1,
                "violations": violations,
            },
        }

    evidence["valid"] = not failures
    evidence["failures"] = failures

    if arguments.format == "json":
        print(json.dumps(evidence, indent=2, sort_keys=True))
    else:
        print(f"valid: {str(not failures).lower()}")
        for name, check in evidence["checks"].items():
            print(f"- {name}: {str(bool(check.get('valid', True))).lower()}")
        for failure in failures:
            print(f"error: {failure}")

    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
