#!/usr/bin/env python3
"""Smoke: join request → teacher accept → student enrolled."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"


def post(path: str, payload: dict, token: str | None = None) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def get(path: str, token: str) -> object:
    req = urllib.request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    print(f"Smoke against {BASE}")
    teacher = post("/api/v1/auth/login", {"email": "teacher@englishhub.vn", "password": "Password123!"})
    student = post("/api/v1/auth/login", {"email": "student@englishhub.vn", "password": "Password123!"})
    classroom = post(
        "/api/v1/classrooms",
        {"name": "Smoke Approval Class", "description": "join approval"},
        token=teacher["accessToken"],
    )
    print("classroom:", classroom["inviteCode"])
    req = post(
        "/api/v1/classrooms/join-requests",
        {"inviteCode": classroom["inviteCode"]},
        token=student["accessToken"],
    )
    print("join request:", req["status"], req["id"])
    assert req["status"] == "PENDING"

    # Wait briefly for Kafka → notification
    time.sleep(2)
    notifs = get("/api/v1/notifications", teacher["accessToken"])
    print("teacher notifications:", len(notifs) if isinstance(notifs, list) else notifs)

    accepted = post(
        f"/api/v1/classrooms/join-requests/{req['id']}/accept",
        {},
        token=teacher["accessToken"],
    )
    print("accepted:", accepted["status"])
    assert accepted["status"] == "ACCEPTED"

    classes = get("/api/v1/classrooms", student["accessToken"])
    ids = [c["id"] for c in classes] if isinstance(classes, list) else []
    assert classroom["id"] in ids
    print("SMOKE_OK")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as exc:
        print("SMOKE_SKIP: gateway not reachable —", exc)
        sys.exit(0)
    except Exception as exc:
        print("SMOKE_FAIL:", exc)
        sys.exit(1)
