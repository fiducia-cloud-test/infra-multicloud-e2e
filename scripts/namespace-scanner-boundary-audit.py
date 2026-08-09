#!/usr/bin/env python3
"""Detect token-prefix truncation and template-boundary loss in DEN-2926."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence


def reference_dict(item: Any) -> dict[str, Any]:
    return {
        "system": item.system,
        "value": item.value,
        "column": item.column,
    }


def exact_check(
    checks: list[dict[str, Any]],
    *,
    name: str,
    line: str,
    actual: list[dict[str, Any]],
    expected: list[dict[str, Any]],
) -> None:
    checks.append(
        {
            "name": name,
            "line": line,
            "expected": expected,
            "actual": actual,
            "valid": actual == expected,
        }
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", default="subject")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    arguments = parser.parse_args(argv)

    subject = Path(arguments.subject).resolve()
    sys.path.insert(0, str(subject / "tools"))
    from namespace_migration import scan_line  # pylint: disable=import-error,import-outside-toplevel

    checks: list[dict[str, Any]] = []

    for line in (
        "WORKDIR /opt/dd-akka-ws-server",
        "cache=/var/lib/dd-cache",
        "checkout=/srv/dd-next",
        "checkout=/home/ec2-user/codes/dd-next-1",
        "module github.com/oresoftware/dd-next-1/remote/service",
        "package com.oresoftware.ddnext.service",
    ):
        references = scan_line(line)
        exact_check(
            checks,
            name="reject-prefix-truncation",
            line=line,
            expected=[],
            actual=[reference_dict(item) for item in references],
        )

    metadata_line = 'labels: {"dd/threadIdentifier": "abc"}'
    exact_check(
        checks,
        name="preserve-longer-legacy-token",
        line=metadata_line,
        actual=[reference_dict(item) for item in scan_line(metadata_line)],
        expected=[
            {
                "system": "slash-namespace",
                "value": "dd/threadIdentifier",
                "column": metadata_line.index("dd/threadIdentifier") + 1,
            }
        ],
    )

    package_line = "require github.com/oresoftware/dd/libs/telemetry-go v0.0.0"
    exact_check(
        checks,
        name="preserve-real-source-package",
        line=package_line,
        actual=[reference_dict(item) for item in scan_line(package_line)],
        expected=[
            {
                "system": "source-package",
                "value": "github.com/oresoftware/dd/libs/telemetry-go",
                "column": package_line.index("github.com") + 1,
            }
        ],
    )

    host_line = (
        "install=/opt/dd/bin/bootstrap-cluster.sh "
        "state=/var/lib/dd/nats "
        "repo=/home/ec2-user/codes/dd/dd-next-1"
    )
    host_actual = [reference_dict(item) for item in scan_line(host_line)]
    host_expected_values = [
        "/opt/dd/bin/bootstrap-cluster.sh",
        "/var/lib/dd/nats",
        "/home/ec2-user/codes/dd/dd-next-1",
    ]
    checks.append(
        {
            "name": "preserve-real-host-subpaths",
            "line": host_line,
            "expectedValues": host_expected_values,
            "actual": host_actual,
            "valid": [item["value"] for item in host_actual] == host_expected_values,
        }
    )

    templated_host = 'path = "/home/ec2-user/codes/dd/thread-workspaces/{name}"'
    exact_check(
        checks,
        name="preserve-templated-host-owner-prefix",
        line=templated_host,
        actual=[reference_dict(item) for item in scan_line(templated_host)],
        expected=[
            {
                "system": "host-path",
                "value": "/home/ec2-user/codes/dd/thread-workspaces",
                "column": templated_host.index("/home/") + 1,
            }
        ],
    )

    templated_package = 'module = "github.com/oresoftware/dd/libs/{generated}"'
    exact_check(
        checks,
        name="preserve-templated-package-owner-prefix",
        line=templated_package,
        actual=[reference_dict(item) for item in scan_line(templated_package)],
        expected=[
            {
                "system": "source-package",
                "value": "github.com/oresoftware/dd/libs",
                "column": templated_package.index("github.com") + 1,
            }
        ],
    )

    failures = [item for item in checks if not item["valid"]]
    report = {
        "valid": not failures,
        "subject": str(subject),
        "checks": checks,
        "failureCount": len(failures),
        "failureNames": [item["name"] for item in failures],
        "policy": (
            "Reject legacy prefixes inside longer sibling tokens, while preserving the "
            "full owner-bearing prefix before runtime template segments."
        ),
    }

    if arguments.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"valid: {str(report['valid']).lower()}")
        for item in checks:
            print(f"- {item['name']}: {str(item['valid']).lower()} :: {item['line']}")

    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
