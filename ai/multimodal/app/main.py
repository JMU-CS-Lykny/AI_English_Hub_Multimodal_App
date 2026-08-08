from __future__ import annotations

import base64
import html
import os
import re
import struct
import time
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, ConfigDict, Field

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "llava")
# Optional local image-gen model name (e.g. flux / stable-diffusion). Not pulled by default.
OLLAMA_IMAGE_MODEL = os.getenv("OLLAMA_IMAGE_MODEL", "").strip()
# When vision model is missing, /v1/vision returns a heuristic in <<1s (tags check).
# When llava is pulled, allow enough time for a real caption.
VISION_TIMEOUT = float(os.getenv("VISION_TIMEOUT", "45"))
# Image diffusion only when model is present; keep probe+call short so SVG default stays <1s.
IMAGE_MODEL_TIMEOUT = float(os.getenv("IMAGE_MODEL_TIMEOUT", "2.5"))
STT_TIMEOUT = float(os.getenv("STT_TIMEOUT", "8"))
OPENAPI_SERVER_URL = os.getenv("OPENAPI_SERVER_URL", "http://localhost:8092")

app = FastAPI(
    title="AI English Hub — Multimodal Service",
    description=(
        "STT / TTS / vision / image / video adapters for the AI tutor pipeline. "
        "Prefer offline-capable demos: SVG image cards, animated SVG lesson clips, "
        "fast vision heuristics, and STT stubs (browser Web Speech preferred)."
    ),
    version="0.3.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema["servers"] = [{"url": OPENAPI_SERVER_URL, "description": "Multimodal service direct"}]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = custom_openapi  # type: ignore[method-assign]


def _strip_b64(data: str | None) -> str:
    raw = (data or "").strip()
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1].strip()
    return raw


_model_cache: dict[str, tuple[float, set[str]]] = {}


async def _ollama_has_model(wanted: str) -> bool:
    """Fast tags probe so missing vision models fall back in <<1s."""
    w = (wanted or "").strip()
    if not w:
        return False
    now = time.monotonic()
    cached = _model_cache.get("tags")
    names: set[str]
    if cached and now - cached[0] < 30:
        names = cached[1]
    else:
        names = set()
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
                if r.status_code == 200:
                    for m in r.json().get("models") or []:
                        name = str(m.get("name") or "").strip()
                        if name:
                            names.add(name)
                            names.add(name.split(":")[0])
        except httpx.HTTPError:
            names = set()
        _model_cache["tags"] = (now, names)
    if w in names:
        return True
    base = w.split(":")[0]
    return base in names or any(n.startswith(w) or n.startswith(base + ":") for n in names)


class SttRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    audio_base64: str = Field(min_length=1, alias="audioBase64")
    language: str = "en"


class VisionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    image_base64: str = Field(min_length=1, alias="imageBase64")
    prompt: str = "Describe this image for an English learner."
    locale: str = "vi"


class ImageGenRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1)
    subject: str | None = None
    classroom_name: str | None = Field(default=None, alias="classroomName")
    locale: str = "vi"
    bullets: list[str] | None = None
    # cartoon_cover = playful classroom banner style
    style: str | None = None


class VideoGenRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1)
    subject: str | None = None
    classroom_name: str | None = Field(default=None, alias="classroomName")
    locale: str = "vi"
    bullets: list[str] | None = None
    # Target loop length in seconds (demo clip; keep short for speed).
    duration_sec: float | None = Field(default=5.0, alias="durationSec")


def _split_image_bullets(prompt: str, max_items: int = 4) -> list[str]:
    prompt = prompt or ""
    cleaned = re.sub(
        r"\b(vẽ|ve|tạo ảnh|tao anh|minh họa|minh hoa|illustrate|draw|generate image|"
        r"tạo hình|tao hinh|tạo video|tao video|làm video|lam video|generate video|"
        r"make video|animate)\b",
        " ",
        prompt,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,:;-")
    if not cleaned:
        cleaned = prompt.strip()
    parts = re.split(r"[\n;•]+|(?:\s+[-–]\s+)|(?<=[.!?])\s+", cleaned)
    bullets = [p.strip(" .,:;-") for p in parts if len(p.strip(" .,:;-")) >= 3]
    if len(bullets) <= 1:
        chunks = re.split(r",|\band\b|\bvà\b", cleaned, flags=re.IGNORECASE)
        bullets = [c.strip(" .,:;-") for c in chunks if len(c.strip(" .,:;-")) >= 3]
    if not bullets:
        bullets = [cleaned[:80] or "English learning"]
    return bullets[:max_items]


def build_educational_svg(
    prompt: str,
    *,
    subject: str | None = None,
    classroom_name: str | None = None,
    bullets: list[str] | None = None,
    locale: str = "vi",
) -> str:
    """Branded SVG study card — works offline without diffusion models."""
    items = bullets or _split_image_bullets(prompt)
    title_raw = items[0] if items else prompt.strip()
    title = html.escape((title_raw[:72] + ("…" if len(title_raw) > 72 else "")))
    subject_label = html.escape((subject or "English").strip() or "English")
    class_label = html.escape((classroom_name or "").strip()[:48])
    footer = (
        "AI English Hub · minh họa học tập (SVG)"
        if (locale or "vi").lower().startswith("vi")
        else "AI English Hub · educational illustration (SVG)"
    )
    chip = subject_label if not class_label else f"{subject_label} · {class_label}"

    body_items = items[1:] if len(items) > 1 else items
    bullet_svg: list[str] = []
    y = 168
    for item in body_items[:5]:
        text = html.escape(item[:90] + ("…" if len(item) > 90 else ""))
        bullet_svg.append(
            f'<circle cx="56" cy="{y - 4}" r="5" fill="#2dd4bf"/>'
            f'<text x="74" y="{y}" fill="#e8f7f4" font-size="18" '
            f'font-family="Segoe UI, system-ui, sans-serif">{text}</text>'
        )
        y += 36
    if not bullet_svg:
        tip = (
            "Ôn nhanh ý chính trong lớp — hỏi gia sư để luyện thêm."
            if (locale or "vi").lower().startswith("vi")
            else "Review the key idea for your class — ask the tutor to practice more."
        )
        bullet_svg.append(
            f'<circle cx="56" cy="164" r="5" fill="#2dd4bf"/>'
            f'<text x="74" y="168" fill="#e8f7f4" font-size="18" '
            f'font-family="Segoe UI, system-ui, sans-serif">{html.escape(tip)}</text>'
        )

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f3d3e"/>
      <stop offset="55%" stop-color="#145a5c"/>
      <stop offset="100%" stop-color="#1b6b5a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2dd4bf"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="800" height="480" rx="28" fill="url(#bg)"/>
  <circle cx="720" cy="60" r="90" fill="#2dd4bf" opacity="0.12"/>
  <circle cx="40" cy="420" r="110" fill="#34d399" opacity="0.10"/>
  <rect x="36" y="36" width="180" height="34" rx="17" fill="url(#accent)"/>
  <text x="126" y="58" text-anchor="middle" fill="#062825" font-size="14" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(chip[:34])}</text>
  <text x="48" y="118" fill="#ffffff" font-size="34" font-weight="700"
        font-family="Georgia, 'Times New Roman', serif">{title}</text>
  <rect x="48" y="136" width="120" height="4" rx="2" fill="url(#accent)"/>
  {"".join(bullet_svg)}
  <text x="48" y="448" fill="#b7e4dc" font-size="14"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(footer)}</text>
</svg>'''


def build_cartoon_cover_svg(
    prompt: str,
    *,
    subject: str | None = None,
    classroom_name: str | None = None,
    bullets: list[str] | None = None,
    locale: str = "vi",
) -> str:
    """Playful flat cartoon classroom banner for create-classroom covers."""
    items = bullets or _split_image_bullets(prompt)
    title_raw = ((classroom_name or (items[0] if items else prompt)) or "").strip() or "Classroom"
    title = html.escape(title_raw[:42] + ("…" if len(title_raw) > 42 else ""))
    subject_label = html.escape((subject or "English").strip() or "English")
    topic = html.escape((items[1] if len(items) > 1 else items[0] if items else "Học vui").strip()[:36])
    footer = (
        "AI English Hub · ảnh bìa cartoon"
        if (locale or "vi").lower().startswith("vi")
        else "AI English Hub · cartoon classroom cover"
    )
    # Subject-tinted sky
    palette = {
        "IELTS": ("#7dd3fc", "#38bdf8", "#0ea5e9"),
        "Math": ("#c4b5fd", "#a78bfa", "#7c3aed"),
        "Science": ("#86efac", "#34d399", "#059669"),
        "History": ("#fcd34d", "#f59e0b", "#d97706"),
        "Literature": ("#fda4af", "#fb7185", "#e11d48"),
        "Business": ("#93c5fd", "#60a5fa", "#2563eb"),
    }
    sky_a, sky_b, accent = palette.get((subject or "English"), ("#99f6e4", "#5eead4", "#0f766e"))

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{sky_a}"/>
      <stop offset="70%" stop-color="{sky_b}"/>
      <stop offset="100%" stop-color="#ecfdf5"/>
    </linearGradient>
    <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fde68a"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#sky)"/>
  <circle cx="820" cy="90" r="58" fill="#fef08a" opacity="0.95"/>
  <circle cx="140" cy="70" r="28" fill="#fff" opacity="0.85"/>
  <circle cx="175" cy="70" r="36" fill="#fff" opacity="0.8"/>
  <circle cx="210" cy="78" r="24" fill="#fff" opacity="0.75"/>
  <!-- blackboard -->
  <rect x="90" y="110" width="420" height="230" rx="18" fill="#14532d"/>
  <rect x="108" y="128" width="384" height="194" rx="10" fill="#166534"/>
  <text x="300" y="200" text-anchor="middle" fill="#ecfdf5" font-size="34" font-weight="700"
        font-family="Georgia, 'Times New Roman', serif">{title}</text>
  <text x="300" y="250" text-anchor="middle" fill="#bbf7d0" font-size="18"
        font-family="Segoe UI, system-ui, sans-serif">{subject_label} · {topic}</text>
  <!-- books -->
  <rect x="560" y="250" width="54" height="150" rx="6" fill="#f97316" transform="rotate(-8 587 325)"/>
  <rect x="610" y="240" width="54" height="160" rx="6" fill="#3b82f6" transform="rotate(4 637 320)"/>
  <rect x="660" y="255" width="54" height="145" rx="6" fill="#ef4444" transform="rotate(-3 687 327)"/>
  <!-- cute student blobs -->
  <ellipse cx="220" cy="420" rx="48" ry="20" fill="#0f766e" opacity="0.18"/>
  <circle cx="220" cy="360" r="34" fill="#fde68a"/>
  <rect x="196" y="392" width="48" height="56" rx="16" fill="{accent}"/>
  <ellipse cx="420" cy="430" rx="48" ry="20" fill="#0f766e" opacity="0.18"/>
  <circle cx="420" cy="372" r="34" fill="#fed7aa"/>
  <rect x="396" y="404" width="48" height="56" rx="16" fill="#0ea5e9"/>
  <!-- desk -->
  <rect x="60" y="460" width="840" height="36" rx="10" fill="url(#desk)"/>
  <rect x="36" y="488" width="40" height="28" rx="4" fill="#b45309"/>
  <rect x="884" y="488" width="40" height="28" rx="4" fill="#b45309"/>
  <rect x="36" y="28" width="200" height="34" rx="17" fill="#fff" opacity="0.9"/>
  <text x="136" y="50" text-anchor="middle" fill="#115e59" font-size="14" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">Cartoon cover</text>
  <text x="48" y="525" fill="#115e59" font-size="13" opacity="0.8"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(footer)}</text>
</svg>'''


def build_educational_video_svg(
    prompt: str,
    *,
    subject: str | None = None,
    classroom_name: str | None = None,
    bullets: list[str] | None = None,
    locale: str = "vi",
    duration_sec: float = 5.0,
) -> str:
    """Animated SVG 'lesson clip' — title + key bullets as timed slides (offline, <1s)."""
    items = bullets or _split_image_bullets(prompt, max_items=5)
    title_raw = (items[0] if items else prompt.strip()) or "Lesson"
    title = html.escape(title_raw[:64] + ("…" if len(title_raw) > 64 else ""))
    subject_label = html.escape((subject or "English").strip() or "English")
    class_label = html.escape((classroom_name or "").strip()[:40])
    chip = subject_label if not class_label else f"{subject_label} · {class_label}"
    vi = (locale or "vi").lower().startswith("vi")
    footer = (
        "AI English Hub · video học tập (SVG động)"
        if vi
        else "AI English Hub · educational clip (animated SVG)"
    )
    tip = "Ôn nhanh — hỏi mascot để luyện thêm." if vi else "Quick review — ask the tutor to practice."

    body = items[1:] if len(items) > 1 else []
    if not body:
        body = [tip]
    slides_text = [title] + [b[:88] + ("…" if len(b) > 88 else "") for b in body[:4]]
    n = len(slides_text)
    dur = max(3.0, min(float(duration_sec or 5.0), 8.0))
    # Equal time per slide; SMIL keyTimes 0..1
    step = 1.0 / n
    # Each slide visible for ~step of the loop, with brief fade
    fade = min(0.08, step * 0.25)

    slide_groups: list[str] = []
    for i, text in enumerate(slides_text):
        t0 = i * step
        t1 = t0 + fade
        t2 = (i + 1) * step - fade
        t3 = (i + 1) * step
        # Opacity keyframes: hidden → show → show → hide (rest of cycle stays 0)
        values = "0;1;1;0;0"
        key_times = f"0;{t0:.3f};{t1:.3f};{t2:.3f};{t3:.3f}" if i == 0 else f"0;{t0:.3f};{t1:.3f};{t2:.3f};{t3:.3f}"
        # For i>0, start at 0 until t0
        if i > 0:
            values = "0;0;1;1;0;0"
            key_times = f"0;{t0:.3f};{t1:.3f};{t2:.3f};{t3:.3f};1"
        else:
            values = "0;1;1;0;0"
            key_times = f"0;{t1:.3f};{t2:.3f};{t3:.3f};1"

        safe = html.escape(text)
        is_title = i == 0
        label = ("Chủ đề" if vi else "Topic") if is_title else (f"Ý {i}" if vi else f"Point {i}")
        y_main = 210 if is_title else 230
        size = 36 if is_title else 26
        # Soft wrap: split long lines roughly in half for display
        if len(text) > 42 and not is_title:
            mid = text.rfind(" ", 0, 42)
            if mid < 12:
                mid = 42
            line1 = html.escape(text[:mid].strip())
            line2 = html.escape(text[mid:].strip()[:50])
            body_text = (
                f'<text x="400" y="{y_main}" text-anchor="middle" fill="#ffffff" font-size="{size}" '
                f'font-weight="700" font-family="Georgia, \'Times New Roman\', serif">{line1}</text>'
                f'<text x="400" y="{y_main + 36}" text-anchor="middle" fill="#e8f7f4" font-size="22" '
                f'font-family="Segoe UI, system-ui, sans-serif">{line2}</text>'
            )
        else:
            body_text = (
                f'<text x="400" y="{y_main}" text-anchor="middle" fill="#ffffff" font-size="{size}" '
                f'font-weight="700" font-family="Georgia, \'Times New Roman\', serif">{safe}</text>'
            )

        slide_groups.append(
            f'''<g opacity="0">
  <animate attributeName="opacity" values="{values}" keyTimes="{key_times}"
           dur="{dur:.1f}s" repeatCount="indefinite" calcMode="linear"/>
  <text x="400" y="150" text-anchor="middle" fill="#99f6e4" font-size="14" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(label)}</text>
  {body_text}
</g>'''
        )

    # Progress bar width animation across full loop
    dots = []
    for i in range(n):
        cx = 400 - (n - 1) * 14 + i * 28
        dots.append(f'<circle cx="{cx}" cy="420" r="5" fill="#2dd4bf" opacity="0.35"/>')

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480"
     role="img" aria-label="{title}">
  <defs>
    <linearGradient id="vbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b2e30"/>
      <stop offset="50%" stop-color="#145a5c"/>
      <stop offset="100%" stop-color="#0f766e"/>
    </linearGradient>
    <linearGradient id="vacc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2dd4bf"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="800" height="480" rx="28" fill="url(#vbg)"/>
  <circle cx="740" cy="70" r="100" fill="#2dd4bf" opacity="0.10"/>
  <circle cx="60" cy="400" r="120" fill="#34d399" opacity="0.08"/>
  <rect x="36" y="28" width="200" height="32" rx="16" fill="url(#vacc)"/>
  <text x="136" y="49" text-anchor="middle" fill="#062825" font-size="13" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(chip[:36])}</text>
  <text x="760" y="50" text-anchor="end" fill="#99f6e4" font-size="12"
        font-family="Segoe UI, system-ui, sans-serif">▶ clip · {dur:.0f}s</text>
  {"".join(slide_groups)}
  {"".join(dots)}
  <rect x="80" y="448" width="640" height="6" rx="3" fill="#0f3d3e"/>
  <rect x="80" y="448" width="640" height="6" rx="3" fill="url(#vacc)">
    <animate attributeName="width" values="0;640;0" keyTimes="0;0.92;1"
             dur="{dur:.1f}s" repeatCount="indefinite"/>
  </rect>
  <text x="48" y="470" fill="#b7e4dc" font-size="12"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(footer)}</text>
</svg>'''


def _decode_media(b64: str) -> bytes:
    raw = _strip_b64(b64)
    # Pad if needed
    pad = (-len(raw)) % 4
    if pad:
        raw += "=" * pad
    try:
        return base64.b64decode(raw, validate=False)
    except Exception:
        return b""


def _image_meta(data: bytes) -> dict[str, Any]:
    """Lightweight header parse — no Pillow required."""
    fmt = "unknown"
    width = height = 0
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        fmt = "png"
        width, height = struct.unpack(">II", data[16:24])
    elif data[:2] == b"\xff\xd8":
        fmt = "jpeg"
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xD9:
                break
            if marker in (0xC0, 0xC1, 0xC2) and i + 9 < len(data):
                height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                break
            if marker == 0x00 or marker == 0x01 or (0xD0 <= marker <= 0xD9):
                i += 2
                continue
            if i + 4 > len(data):
                break
            seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
            i += 2 + seg_len
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        fmt = "webp"
    elif data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        fmt = "gif"
        width, height = struct.unpack("<HH", data[6:10])
    elif b"<svg" in data[:200].lower():
        fmt = "svg"

    # Rough brightness from a sparse sample of payload bytes
    sample = data[64:64 + 1200] or data[:1200]
    avg = (sum(sample) / len(sample)) if sample else 128.0
    tone = "bright" if avg > 160 else ("dark" if avg < 80 else "balanced")
    return {
        "format": fmt,
        "width": int(width or 0),
        "height": int(height or 0),
        "bytes": len(data),
        "tone": tone,
    }


def _heuristic_vision_caption(data: bytes, prompt: str, locale: str) -> str:
    meta = _image_meta(data)
    vi = (locale or "vi").lower().startswith("vi")
    w, h = meta["width"], meta["height"]
    size_bit = f"{w}×{h}px" if w and h else ("vector/SVG" if meta["format"] == "svg" else "kích thước không rõ" if vi else "unknown size")
    tone_vi = {"bright": "sáng", "dark": "tối", "balanced": "cân bằng"}.get(meta["tone"], meta["tone"])
    tone_en = meta["tone"]
    fmt = meta["format"].upper()

    # Tiny OCR-ish hint: printable ASCII runs in the binary (works for some simple graphics)
    ascii_runs = re.findall(rb"[A-Za-z][A-Za-z0-9 .,'-]{3,40}", data[:8000])
    words: list[str] = []
    for run in ascii_runs[:6]:
        try:
            s = run.decode("ascii").strip()
        except Exception:
            continue
        if s.lower() in {"http", "https", "xmlns", "svg", "png", "jpeg", "exif"}:
            continue
        if s not in words:
            words.append(s)
    text_hint = ", ".join(words[:4])

    if vi:
        base = (
            f"Ảnh {fmt} ({size_bit}), tông màu {tone_vi}. "
            "Đây có thể là tư liệu học tiếng Anh — hãy hỏi từ vựng, ngữ pháp hoặc mô tả nội dung."
        )
        if text_hint:
            base += f" Gợi ý chữ/nhãn đọc được trong tệp: {text_hint}."
        if prompt and prompt.strip() and "mô tả" not in prompt.lower()[:20]:
            base += f" (Gợi ý của bạn: {prompt.strip()[:120]})"
        return base
    base = (
        f"{fmt} image ({size_bit}), {tone_en} tones. "
        "Likely English-learning material — ask about vocabulary, grammar, or describe the content."
    )
    if text_hint:
        base += f" Readable text hints: {text_hint}."
    if prompt and prompt.strip():
        base += f" (Your prompt: {prompt.strip()[:120]})"
    return base


def _stt_demo_transcript(language: str, audio_len: int) -> str:
    lang = (language or "en").lower()
    # Vary slightly by payload size so demos feel less static.
    variants_vi = [
        "Xin chào, hôm nay tôi muốn luyện nói tiếng Anh.",
        "Hãy giải thích thì hiện tại đơn giúp tôi.",
        "Tôi muốn ôn từ vựng theo bài học của lớp.",
    ]
    variants_en = [
        "Hello, I want to practice speaking English today.",
        "Please explain the present simple tense for me.",
        "I want to review vocabulary from my class lesson.",
    ]
    pool = variants_vi if lang.startswith("vi") else variants_en
    return pool[audio_len % len(pool)]


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok", "service": "ai-multimodal"}


@app.post("/v1/stt", tags=["Speech"])
async def speech_to_text(body: SttRequest):
    """Speech→text.

    Production: Whisper / cloud STT. Demo: instant offline stub so the tutor
    pipeline stays wired. Prefer browser Web Speech API on the client for <1s feel.
    """
    t0 = time.perf_counter()
    data = _decode_media(body.audio_base64)
    # Optional future: call a local Whisper endpoint if STT_URL is set.
    stt_url = os.getenv("STT_URL", "").strip()
    if stt_url and data:
        try:
            async with httpx.AsyncClient(timeout=STT_TIMEOUT) as client:
                r = await client.post(
                    stt_url,
                    json={"audio_base64": _strip_b64(body.audio_base64), "language": body.language},
                )
                if r.status_code == 200:
                    text = (r.json().get("text") or "").strip()
                    if text:
                        return {
                            "text": text,
                            "language": body.language,
                            "provider": "stt-url",
                            "note": f"External STT ({(time.perf_counter() - t0) * 1000:.0f}ms)",
                        }
        except httpx.HTTPError:
            pass

    text = _stt_demo_transcript(body.language, len(data) or len(body.audio_base64))
    return {
        "text": text,
        "language": body.language,
        "provider": "stub-whisper",
        "note": (
            "Offline STT stub for Docker demos. Use browser Web Speech for real "
            f"transcripts under ~1s. ({(time.perf_counter() - t0) * 1000:.0f}ms, {len(data)} bytes)"
        ),
    }


@app.post("/v1/tts", tags=["Speech"])
async def text_to_speech(payload: dict):
    text = payload.get("text", "")
    return {
        "audio_base64": "",
        "format": "mp3",
        "provider": "stub-tts",
        "chars": len(text),
        "note": "Wire Piper/Azure TTS for production audio output.",
    }


@app.post("/v1/vision", tags=["Vision"])
async def vision(body: VisionRequest):
    """Image→text (describe / light OCR). Tries Ollama vision briefly, else heuristic."""
    t0 = time.perf_counter()
    data = _decode_media(body.image_base64)
    b64 = _strip_b64(body.image_base64)
    locale = body.locale or "vi"
    prompt = body.prompt or "Describe this image for an English learner."

    # Probe tags first — missing llava → heuristic in well under 1s.
    if await _ollama_has_model(OLLAMA_VISION_MODEL):
        try:
            async with httpx.AsyncClient(timeout=VISION_TIMEOUT) as client:
                r = await client.post(
                    f"{OLLAMA_BASE_URL}/api/generate",
                    json={
                        "model": OLLAMA_VISION_MODEL,
                        "prompt": prompt,
                        "images": [b64],
                        "stream": False,
                        "options": {"num_predict": 220, "temperature": 0.2},
                    },
                )
                if r.status_code == 200:
                    desc = (r.json().get("response") or "").strip()
                    if desc:
                        return {
                            "description": desc,
                            "provider": f"ollama:{OLLAMA_VISION_MODEL}",
                            "note": f"Ollama vision {(time.perf_counter() - t0) * 1000:.0f}ms",
                        }
        except httpx.HTTPError:
            pass

    caption = _heuristic_vision_caption(data, prompt, locale)
    return {
        "description": caption,
        "provider": "heuristic",
        "note": (
            f"Vision heuristic fallback ({(time.perf_counter() - t0) * 1000:.0f}ms). "
            f"Pull `{OLLAMA_VISION_MODEL}` for real vision captions."
        ),
    }


@app.post("/v1/image", tags=["Image"])
async def generate_image(body: ImageGenRequest):
    """Text→image for the tutor.

    Default path: branded educational SVG in well under 1s (no Ollama wait).
    Optional: local diffusion only when `OLLAMA_IMAGE_MODEL` is set AND pulled.
    """
    t0 = time.perf_counter()
    prompt = (body.prompt or "").strip()
    if not prompt:
        prompt = "Educational classroom illustration"
    if OLLAMA_IMAGE_MODEL and await _ollama_has_model(OLLAMA_IMAGE_MODEL):
        try:
            async with httpx.AsyncClient(timeout=IMAGE_MODEL_TIMEOUT) as client:
                r = await client.post(
                    f"{OLLAMA_BASE_URL}/api/generate",
                    json={
                        "model": OLLAMA_IMAGE_MODEL,
                        "prompt": prompt,
                        "stream": False,
                    },
                )
                if r.status_code == 200:
                    data = r.json()
                    img_b64 = data.get("image") or (data.get("images") or [None])[0]
                    if img_b64:
                        return {
                            "provider": f"ollama:{OLLAMA_IMAGE_MODEL}",
                            "mime_type": "image/png",
                            "image_base64": img_b64,
                            "image_svg": None,
                            "caption": prompt[:160],
                            "note": (
                                f"Ollama image model {(time.perf_counter() - t0) * 1000:.0f}ms"
                            ),
                        }
        except httpx.HTTPError:
            pass

    style = (body.style or "").strip().lower()
    if style in {"cartoon_cover", "cover", "classroom_cover"}:
        svg = build_cartoon_cover_svg(
            prompt,
            subject=body.subject,
            classroom_name=body.classroom_name,
            bullets=body.bullets,
            locale=body.locale,
        )
        provider = "svg-cartoon-cover"
        note = (
            "Offline cartoon classroom cover SVG (fast default). "
            f"{(time.perf_counter() - t0) * 1000:.0f}ms"
        )
    else:
        svg = build_educational_svg(
            prompt,
            subject=body.subject,
            classroom_name=body.classroom_name,
            bullets=body.bullets,
            locale=body.locale,
        )
        provider = "svg-educational"
        note = (
            "Offline educational SVG card (fast default, no Ollama wait). "
            f"{(time.perf_counter() - t0) * 1000:.0f}ms"
        )
    svg_b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return {
        "provider": provider,
        "mime_type": "image/svg+xml",
        "image_base64": svg_b64,
        "image_svg": svg,
        "caption": prompt[:160],
        "note": note,
    }


@app.post("/v1/video", tags=["Video"])
async def generate_video(body: VideoGenRequest):
    """Text→short educational 'video' (animated SVG slideshow) under ~1s.

    No paid APIs. Returns an animated SVG data payload playable in chat via
    <object>/<img> (or client can wrap as a looping clip). WebM diffusion is
    intentionally not required for the demo path.
    """
    t0 = time.perf_counter()
    prompt = body.prompt.strip()
    dur = body.duration_sec if body.duration_sec is not None else 5.0
    svg = build_educational_video_svg(
        prompt,
        subject=body.subject,
        classroom_name=body.classroom_name,
        bullets=body.bullets,
        locale=body.locale or "vi",
        duration_sec=dur,
    )
    svg_b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    ms = (time.perf_counter() - t0) * 1000
    return {
        "provider": "svg-animated-slides",
        "mime_type": "image/svg+xml",
        "video_base64": svg_b64,
        "video_svg": svg,
        "caption": prompt[:160],
        "duration_sec": max(3.0, min(float(dur or 5.0), 8.0)),
        "note": f"Animated SVG lesson clip (offline demo) {ms:.0f}ms",
    }
