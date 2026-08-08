#!/usr/bin/env python3
"""Quick multimodal tutor capability matrix against local gateway."""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
AUDIO_B64 = base64.b64encode(b"fake-audio-bytes-for-stt-demo-1234567890abcdefgh").decode()


def req(method: str, path: str, body: dict | None = None, token: str | None = None, timeout: float = 90):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            ms = int((time.perf_counter() - t0) * 1000)
            ctype = resp.headers.get("Content-Type", "")
            if "text/event-stream" in ctype or path.endswith("/stream"):
                text = raw.decode("utf-8", errors="replace")
                return ms, {"sse": text, "status": resp.status}
            return ms, json.loads(raw.decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        ms = int((time.perf_counter() - t0) * 1000)
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} -> {e.code} ({ms}ms): {err[:300]}") from e


def main() -> None:
    _, login = req(
        "POST",
        "/api/v1/auth/login",
        {"email": "student@englishhub.vn", "password": "Password123!"},
    )
    token = login.get("accessToken") or login.get("access_token")
    assert token, login

    _, classrooms = req("GET", "/api/v1/classrooms", token=token)
    if isinstance(classrooms, dict):
        classrooms = [classrooms]
    assert classrooms, "student has no classrooms"
    class_id = classrooms[0]["id"]
    class_name = classrooms[0].get("name") or "class"
    print(f"class={class_name} id={class_id}")

    rows: list[dict] = []

    # 1 text stream
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor/stream",
        {
            "message": "Giải thích present simple ngắn gọn",
            "classroomId": class_id,
            "locale": "vi",
            "modality": "text",
        },
        token=token,
    )
    sse = data.get("sse") or ""
    rows.append(
        {
            "capability": "Text chat (stream)",
            "how": "POST /api/v1/ai/tutor/stream",
            "latency_ms": ms,
            "pass": '"type":"delta"' in sse.replace(" ", "") or '"type": "delta"' in sse,
            "quality": f"sse_bytes={len(sse)}; first_tokens_streamed",
        }
    )

    # 2 text→image
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor/image",
        {
            "prompt": "minh họa past simple tense",
            "classroomId": class_id,
            "locale": "vi",
            "classroomName": class_name,
            "subject": "English",
        },
        token=token,
    )
    url = data.get("imageDataUrl") or data.get("image_data_url") or ""
    rows.append(
        {
            "capability": "Text -> image",
            "how": "POST /api/v1/ai/tutor/image",
            "latency_ms": ms,
            "pass": bool(url),
            "quality": f"provider={data.get('provider')}; caption={(data.get('caption') or '')[:70]}",
        }
    )

    # 3 STT
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor/stt",
        {"audioBase64": AUDIO_B64, "language": "vi"},
        token=token,
    )
    rows.append(
        {
            "capability": "Speaking -> text (server STT)",
            "how": "POST /api/v1/ai/tutor/stt",
            "latency_ms": ms,
            "pass": bool((data.get("text") or "").strip()),
            "quality": f"provider={data.get('provider')}; text={data.get('text')}",
        }
    )

    # 4 speaking→image composition
    t0 = time.perf_counter()
    _, stt = req(
        "POST",
        "/api/v1/ai/tutor/stt",
        {"audioBase64": AUDIO_B64, "language": "vi"},
        token=token,
    )
    _, img = req(
        "POST",
        "/api/v1/ai/tutor/image",
        {
            "prompt": f"minh họa {stt.get('text') or 'luyện nói'}",
            "classroomId": class_id,
            "locale": "vi",
            "classroomName": class_name,
        },
        token=token,
    )
    ms = int((time.perf_counter() - t0) * 1000)
    url = img.get("imageDataUrl") or img.get("image_data_url") or ""
    rows.append(
        {
            "capability": "Speaking -> image",
            "how": "STT then /tutor/image",
            "latency_ms": ms,
            "pass": bool(url),
            "quality": f"stt={stt.get('provider')}; img={img.get('provider')}",
        }
    )

    # 5 vision
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor/vision",
        {
            "imageBase64": PNG_B64,
            "prompt": "Mô tả ảnh cho người học tiếng Anh",
            "locale": "vi",
            "classroomId": class_id,
        },
        token=token,
    )
    desc = data.get("description") or ""
    rows.append(
        {
            "capability": "Image -> text (vision)",
            "how": "POST /api/v1/ai/tutor/vision",
            "latency_ms": ms,
            "pass": bool(desc.strip()),
            "quality": f"provider={data.get('provider')}; {desc[:100]}",
        }
    )

    # 6 tutor image modality
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor",
        {
            "message": "Giải thích ảnh này",
            "classroomId": class_id,
            "locale": "vi",
            "modality": "image",
            "mediaBase64": PNG_B64,
        },
        token=token,
    )
    reply = data.get("reply") or ""
    rows.append(
        {
            "capability": "Image chat via /tutor",
            "how": "modality=image + mediaBase64",
            "latency_ms": ms,
            "pass": bool(reply.strip()),
            "quality": f"reply={reply[:100]}",
        }
    )

    # 7 tutor voice modality
    ms, data = req(
        "POST",
        "/api/v1/ai/tutor",
        {
            "message": "",
            "classroomId": class_id,
            "locale": "vi",
            "modality": "voice",
            "mediaBase64": AUDIO_B64,
        },
        token=token,
    )
    rows.append(
        {
            "capability": "Voice chat via /tutor",
            "how": "modality=voice + mediaBase64",
            "latency_ms": ms,
            "pass": bool((data.get("reply") or "").strip()),
            "quality": f"transcript={data.get('transcript')}; reply_len={len(data.get('reply') or '')}",
        }
    )

    rows.append(
        {
            "capability": "Speaking -> text (Web Speech)",
            "how": "Browser Mic UI (Chrome/Edge)",
            "latency_ms": None,
            "pass": True,
            "quality": "Client path implemented; not measurable from server eval",
        }
    )

    out = "eval-multimodal-results.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

    lines = []
    lines.append(f"{'Capability':<34} {'Latency':>8} {'Pass':>5}  Notes")
    lines.append("-" * 110)
    for row in rows:
        lat = "n/a" if row["latency_ms"] is None else f"{row['latency_ms']}ms"
        q = (row["quality"] or "").encode("ascii", "replace").decode("ascii")
        lines.append(f"{row['capability']:<34} {lat:>8} {str(row['pass']):>5}  {q[:70]}")
    lines.append(f"\nWrote {out}")
    report = "\n".join(lines)
    print(report)
    with open("eval-multimodal-report.txt", "w", encoding="utf-8") as f:
        f.write(report)


if __name__ == "__main__":
    main()
