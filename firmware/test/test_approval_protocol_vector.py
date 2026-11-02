#!/usr/bin/env python3
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "protocol" / "v1-vector.json"
HARNESS = ROOT / "firmware" / "test" / "approval_protocol_vector_test.cpp"
INCLUDE = ROOT / "firmware" / "include"

with FIXTURE.open(encoding="utf-8") as source:
    fixture = json.load(source)

inputs = fixture["inputs"]
arguments = [
    inputs["contract_id"],
    inputs["network_id"],
    str(inputs["payment_id"]),
    inputs["recipient_id"],
    inputs["amount_yocto"],
    str(inputs["nonce"]),
    inputs["expires_at_ns"],
]

with tempfile.TemporaryDirectory(prefix="tapproved-protocol-test-") as directory:
    executable = Path(directory) / "approval-protocol-vector-test"
    subprocess.run(
        ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
         f"-I{INCLUDE}", str(HARNESS), "-o", str(executable)],
        check=True,
        cwd=ROOT,
    )
    result = subprocess.run(
        [str(executable), *arguments],
        check=True,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    actual = result.stdout.strip()
    expected = fixture["message_hex"].lower()
    if actual != expected:
        raise SystemExit(
            "Firmware approval encoder mismatch against protocol/v1-vector.json\n"
            f"expected: {expected}\nactual:   {actual}"
        )

    invalid_cases = [
        [*arguments[:2], "042", *arguments[3:]],
        [*arguments[:4], "0", *arguments[5:]],
        [*arguments[:4], "340282366920938463463374607431768211456", *arguments[5:]],
    ]
    for invalid in invalid_cases:
        rejected = subprocess.run(
            [str(executable), *invalid],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        if rejected.returncode == 0:
            raise SystemExit(f"Firmware encoder accepted invalid protocol input: {invalid}")

print("Firmware approval encoder matches protocol/v1-vector.json")
