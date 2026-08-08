#!/usr/bin/env python3
"""Detect token-prefix truncation in the DEN-2786 namespace scanner."""
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
    ):
        references = scan_line(line)
        checks.append(
            {
                "name": "reject-prefix-truncation",
                "line": line,
                "expected": [],
                "actual": [reference_dict(item) for item in references],
                "valid": not references,
            }
        )

    metadata_line = 'labels: {"dd/threadIdentifier": "abc"}'
    metadata_actual = [reference_dict(item) for item in scan_line(metadata_line)]
    metadata_expected = [
        {
            "system": "slash-namespace",
            "value": "dd/threadIdentifier",
            "column": metadata_line.index("dd/threadIdentifier") + 1,
        }
    ]
    checks.append(
        {
            "name": "preserve-longer-legacy-token",
            "line": metadata_line,
            "expected": metadata_expected,
            "actual": metadata_actual,
            "valid": metadata_actual == metadata_expected,
        }
    )

    package_line = "require github.com/oresoftware/dd/libs/telemetry-go v0.0.0"
    package_actual = [reference_dict(item) for item in scan_line(package_line)]
    package_expected = [
        {
            "system": "source-package",
            "value": "github.com/oresoftware/dd/libs/telemetry-go",
            "column": package_line.index("github.com") + 1,
        }
    ]
    checks.append(
        {
            "name": "preserve-real-source-package",
            "line": package_line,
            "expected": package_expected,
            "actual": package_actual,
            "valid": package_actual == package_expected,
        }
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

    failures = [item for item in checks if not item["valid"]]
    report = {
        "valid": not failures,
        "subject": str(subject),
        "checks": checks,
        "failureCount": len(failures),
        "failureNames": [item["name"] for item in failures],
        "policy": (
            "A scanner may match a real legacy token or the full longer legacy token, "
            "but it may not truncate a hyphenated sibling, repository name, or metadata name."
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
