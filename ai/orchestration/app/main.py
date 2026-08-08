from __future__ import annotations

import asyncio
import base64
import html
import json
import logging
import os
import random
import re
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any, TypedDict

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.openapi.utils import get_openapi
from fastapi.responses import StreamingResponse
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, ConfigDict, Field

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
# Smaller/faster model for optional quiz AI path.
OLLAMA_QUIZ_MODEL = os.getenv("OLLAMA_QUIZ_MODEL", "llama3.2:1b")
# Fast instruct model for tutor chat (prefer 1b already pulled with quiz).
OLLAMA_TUTOR_MODEL = os.getenv("OLLAMA_TUTOR_MODEL", OLLAMA_QUIZ_MODEL or "llama3.2:1b")
RAG_URL = os.getenv("RAG_URL", "http://localhost:8091")
MULTIMODAL_URL = os.getenv("MULTIMODAL_URL", "http://localhost:8092")
CONTENT_URL = os.getenv("CONTENT_URL", "http://localhost:8083")
CLASSROOM_URL = os.getenv("CLASSROOM_URL", "http://localhost:8082")
OPENAPI_SERVER_URL = os.getenv("OPENAPI_SERVER_URL", "http://localhost:8080")
TUTOR_CLASSROOM_TIMEOUT = float(os.getenv("TUTOR_CLASSROOM_TIMEOUT", "2.0"))
# Demo-reliable default: skip slow Ollama and serve enriched heuristic banks (<1s).
# Set QUIZ_PREFER_HEURISTIC=false to try OLLAMA_QUIZ_MODEL with a tight timeout first.
QUIZ_PREFER_HEURISTIC = os.getenv("QUIZ_PREFER_HEURISTIC", "true").lower() in (
    "1",
    "true",
    "yes",
    "on",
)
QUIZ_OLLAMA_TIMEOUT = float(os.getenv("QUIZ_OLLAMA_TIMEOUT", "0.8"))
# Tutor: short Ollama budget + quick RAG so first tokens feel ~1s when model is warm.
TUTOR_OLLAMA_TIMEOUT = float(os.getenv("TUTOR_OLLAMA_TIMEOUT", "8"))
TUTOR_RAG_TIMEOUT = float(os.getenv("TUTOR_RAG_TIMEOUT", "2.0"))
TUTOR_CONTENT_TIMEOUT = float(os.getenv("TUTOR_CONTENT_TIMEOUT", "2.0"))
TUTOR_NUM_PREDICT = int(os.getenv("TUTOR_NUM_PREDICT", "280"))
# Multimodal adapters: STT stub is instant; vision allows time for llava when pulled.
# When vision model is missing, multimodal returns a heuristic caption in well under 1s.
TUTOR_STT_TIMEOUT = float(os.getenv("TUTOR_STT_TIMEOUT", "8"))
TUTOR_VISION_TIMEOUT = float(os.getenv("TUTOR_VISION_TIMEOUT", "35"))

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("ai-orchestration")

app = FastAPI(
    title="AI English Hub — AI Orchestration",
    description="LangGraph multimodal tutor (text / voice / image) grounded via RAG.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)
# CORS is handled exclusively by the API gateway. Do not add CORSMiddleware here —
# duplicate Access-Control-Allow-Origin values (* + localhost) make browsers fail
# fetch() with "Failed to fetch" (seen on teacher Generate Quiz).


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema["servers"] = [{"url": OPENAPI_SERVER_URL, "description": "API Gateway"}]
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["bearerAuth"] = {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
    }
    schema["security"] = [{"bearerAuth": []}]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = custom_openapi  # type: ignore[method-assign]


class TutorChatMessage(BaseModel):
    role: str  # user | assistant
    content: str


class TutorRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Empty allowed when modality is voice/image with mediaBase64.
    message: str = ""
    classroom_id: str | None = Field(default=None, alias="classroomId")
    lesson_id: str | None = Field(default=None, alias="lessonId")
    modality: str = "text"  # text | voice | image
    media_base64: str | None = Field(default=None, alias="mediaBase64")
    locale: str = "vi"
    # Prior turns in this session (optional). Accepts `messages` or `history`.
    messages: list[TutorChatMessage] | None = None
    history: list[TutorChatMessage] | None = None
    # Optional classroom meta from client (classroomMeta / detect-subject).
    classroom_name: str | None = Field(default=None, alias="classroomName")
    classroom_description: str | None = Field(default=None, alias="classroomDescription")
    subject: str | None = None
    knowledges: list[str] | None = None
    cefr_level: str | None = Field(default=None, alias="cefrLevel")


class TutorSttRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    audio_base64: str = Field(min_length=1, alias="audioBase64")
    language: str = "vi"


class TutorVisionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    image_base64: str = Field(min_length=1, alias="imageBase64")
    prompt: str = ""
    locale: str = "vi"
    classroom_id: str | None = Field(default=None, alias="classroomId")


def _strip_media_b64(data: str | None) -> str:
    raw = (data or "").strip()
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1].strip()
    return raw


def _tutor_has_payload(body: TutorRequest) -> bool:
    msg = (body.message or "").strip()
    media = _strip_media_b64(body.media_base64)
    return bool(msg) or bool(media)


def _default_image_prompt(locale: str) -> str:
    if (locale or "vi").startswith("vi"):
        return (
            "Mô tả ảnh này cho người học tiếng Anh. Nếu có chữ hãy đọc (OCR), "
            "giải thích từ vựng/ngữ pháp liên quan trong phạm vi lớp."
        )
    return (
        "Describe this image for an English learner. OCR any text and explain "
        "related vocabulary/grammar within the class scope."
    )


class TutorResponse(BaseModel):
    reply: str
    grounded: bool
    sources: list[dict[str, Any]] = []
    transcript: str | None = None
    # english_learning | general — drives UI meta label
    mode: str = "english_learning"


class TutorImageRequest(BaseModel):
    """Text→image for the tutor chatbot (educational illustration)."""

    model_config = ConfigDict(populate_by_name=True)

    # Empty allowed for cartoon_cover (class name/description can fill the prompt).
    prompt: str = ""
    classroom_id: str | None = Field(default=None, alias="classroomId")
    locale: str = "vi"
    classroom_name: str | None = Field(default=None, alias="classroomName")
    classroom_description: str | None = Field(default=None, alias="classroomDescription")
    subject: str | None = None
    knowledges: list[str] | None = None
    cefr_level: str | None = Field(default=None, alias="cefrLevel")
    # cartoon_cover = create-classroom cover art (no classroomId required)
    style: str | None = None


class TutorImageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, ser_json_by_alias=True)

    caption: str
    provider: str
    mime_type: str = Field(alias="mimeType")
    image_svg: str | None = Field(default=None, alias="imageSvg")
    image_data_url: str = Field(alias="imageDataUrl")
    subject: str | None = None
    classroom_name: str | None = Field(default=None, alias="classroomName")
    note: str | None = None


class TutorVideoRequest(BaseModel):
    """Text→short educational video clip for the tutor / mascot."""

    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1)
    classroom_id: str | None = Field(default=None, alias="classroomId")
    locale: str = "vi"
    classroom_name: str | None = Field(default=None, alias="classroomName")
    classroom_description: str | None = Field(default=None, alias="classroomDescription")
    subject: str | None = None
    knowledges: list[str] | None = None
    cefr_level: str | None = Field(default=None, alias="cefrLevel")
    duration_sec: float | None = Field(default=5.0, alias="durationSec")


class TutorVideoResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, ser_json_by_alias=True)

    caption: str
    provider: str
    mime_type: str = Field(alias="mimeType")
    video_svg: str | None = Field(default=None, alias="videoSvg")
    video_data_url: str = Field(alias="videoDataUrl")
    duration_sec: float | None = Field(default=None, alias="durationSec")
    subject: str | None = None
    classroom_name: str | None = Field(default=None, alias="classroomName")
    note: str | None = None


class GraphState(TypedDict, total=False):
    message: str
    classroom_id: str | None
    locale: str
    modality: str
    media_base64: str | None
    transcript: str | None
    context_chunks: list[dict[str, Any]]
    user_id: str | None
    reply: str
    tutor_mode: str  # english_learning | general
    history: list[dict[str, str]]
    classroom_profile: dict[str, Any]


TUTOR_HISTORY_MAX_TURNS = int(os.getenv("TUTOR_HISTORY_MAX_TURNS", "16"))

NO_CLASSROOM_REPLY_VI = (
    "Vui lòng **chọn một lớp học** trước khi hỏi gia sư AI.\n\n"
    "Gia sư chỉ hỗ trợ trong phạm vi lớp đã chọn (môn học + bài giảng của lớp)."
)
NO_CLASSROOM_REPLY_EN = (
    "Please **select a classroom** before chatting with the AI tutor.\n\n"
    "The tutor only helps within the selected class subject and materials."
)

SYSTEM_PROMPT_ESL_VI = """Bạn là gia sư tiếng Anh chuyên nghiệp của AI English Hub cho học sinh Việt Nam.

Nhiệm vụ (chế độ học tiếng Anh — BẮT BUỘC gắn với lớp đã chọn):
1) CHỈ hỗ trợ trong phạm vi lớp: tên lớp, môn (English/IELTS), mô tả, knowledges, CEFR/level, và Lesson context.
2) Trả lời CHÍNH XÁC về ngữ pháp, từ vựng, phát âm, kỹ năng tiếng Anh phù hợp lớp.
3) Ưu tiên "Lesson context" nếu có — không bịa bài học không tồn tại.
4) Nếu học sinh hỏi lệch môn lớp: lịch sự từ chối và gợi ý quay lại chủ đề lớp.
5) Dùng hội thoại trước đó để hiểu đại từ / yêu cầu ngắn ("cho tôi 10 câu hỏi", "tiếp đi").
6) Cấu trúc ngắn gọn, dễ đọc (chat):
   - Đoạn ngắn; chèn dòng trống giữa các phần.
   - Tiêu đề vừa phải dạng **Đáp án:** / **Giải thích:** / **Ví dụ:** / **Luyện tập:**
   - Gạch đầu dòng (- ) cho ý chính hoặc ví dụ.
   - Với NGỮ PHÁP: giải thích ngắn → ví dụ tiếng Anh (1–3) → bài luyện (1 câu, hoặc N câu nếu được yêu cầu).
   - Với TỪ VỰNG / ĐỒNG NGHĨA / DỊCH (đồng nghĩa, dịch, nghĩa là, synonym, translate, "bằng tiếng Anh"):
     BẮT BUỘC trả lời TRƯỚC bằng từ tiếng Anh rõ ràng (và synonyms nếu hỏi đồng nghĩa),
     rồi giải thích ngắn, rồi 1–2 ví dụ song ngữ (EN + VI), rồi luyện tập ngắn tùy chọn.
     KHÔNG chỉ giải thích tiếng Việt; KHÔNG để **Luyện tập** hỏi lại đúng câu hỏi của học sinh.
7) Sửa lỗi nhẹ nhàng: nêu lỗi → câu đúng → giải thích vì sao.
8) GUARD BẮT BUỘC: "câu hỏi", "bài tập", "quiz", "luyện tập", "làm thử", "practice", "exercise"
   = yêu cầu bài luyện hợp lệ trong lớp. KHÔNG từ chối, KHÔNG nói bất hợp pháp/harmful.
   Khi xin N câu hỏi sau khi đang ôn grammar/skills: tạo đúng N câu luyện, đánh số 1..N, đúng chủ đề lớp/hội thoại.
9) Không bịa API/status/Ollama."""

SYSTEM_PROMPT_ESL_EN = """You are a professional English tutor for Vietnamese learners on AI English Hub.

Rules (English-learning mode — MUST stay bound to the selected classroom):
1) Only help within this class: name, subject (English/IELTS), description, knowledges, CEFR/level, and Lesson context.
2) Be accurate about grammar, vocabulary, pronunciation, and usage relevant to the class.
3) Prefer Lesson context; do not invent classroom materials.
4) If the student asks off-topic for this class, politely redirect back to the class subject.
5) Use prior conversation turns to resolve pronouns and short follow-ups
   like "give me 10 questions" / "cho tôi 10 câu hỏi".
6) Keep replies scannable: short paragraphs, blank lines, sparse **Headings:**
   (**Answer:** / **Explanation:** / **Examples:** / **Practice:**), and - bullets.
   For VOCAB / SYNONYM / TRANSLATION questions (synonym, translate, "nghĩa là", "đồng nghĩa",
   "bằng tiếng Anh"): lead with the English word(s) first, then a short explanation,
   then 1–2 bilingual examples, then optional short practice — never repeat the student's
   question as "Practice" without answering.
7) Correct gently: error → corrected sentence → why.
8) HARD GUARD: "câu hỏi", practice, quiz, exercise, "làm thử" mean legitimate class practice —
   NEVER refuse as illegal/harmful. If history shows grammar practice and the student asks for N
   questions, generate exactly N numbered practice items on that class topic.
9) Never mention infrastructure (Ollama, APIs, Docker)."""

SYSTEM_PROMPT_GENERAL_VI = """Bạn là trợ lý học tập của AI English Hub, gắn với một lớp học cụ thể (lịch sử, khoa học, văn học…).

QUY TẮC BẮT BUỘC:
1) CHỈ trả lời trong phạm vi môn/mô tả/knowledges của lớp đã chọn (+ Lesson context nếu có).
2) Nếu hỏi lệch môn lớp: lịch sự từ chối và mời hỏi lại đúng chủ đề lớp.
3) Toàn bộ câu trả lời bằng TIẾNG VIỆT (trừ khi lớp là tiếng Anh). Không bịa tài liệu lớp.
4) Định dạng dễ đọc: đoạn ngắn, dòng trống giữa phần, tiêu đề **Tóm tắt:** / **Ý chính:**,
   gạch đầu dòng (- ) hoặc danh sách số.
5) Dùng hội thoại trước để hiểu follow-up ngắn ("cho tôi 10 câu hỏi", "tiếp đi") — tạo bài luyện đúng môn lớp.
6) Nếu không chắc, nói rõ — không bịa. Không đề cập hạ tầng kỹ thuật."""

SYSTEM_PROMPT_GENERAL_EN = """You are a study assistant on AI English Hub, bound to one selected classroom.

Rules:
1) Only answer within that class subject, description, knowledges, and Lesson context when available.
2) If off-topic for the class, politely redirect to the class subject.
3) Be factually accurate. Prefer Lesson context; do not invent materials.
4) Format for chat: short paragraphs, blank lines, sparse **Headings:**, - bullet lists.
5) Use prior turns for short follow-ups (e.g. "give me 10 questions") and keep practice in-subject.
6) If unsure, say so. Never mention infrastructure."""

# Keep old names as aliases for any external references / mental model.
SYSTEM_PROMPT_VI = SYSTEM_PROMPT_ESL_VI
SYSTEM_PROMPT_EN = SYSTEM_PROMPT_ESL_EN

_VI_DIACRITICS = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
    r"ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]"
)

_ESL_HINT = re.compile(
    r"("
    r"\b(grammar|vocabulary|pronunciation|phrasal|idiom|tense|article|preposition|"
    r"present\s+simple|past\s+simple|present\s+continuous|present\s+perfect|"
    r"past\s+continuous|future\s+simple|modal\s+verb|irregular\s+verb|"
    r"synonym|synonyms|antonym|translate|translation|meaning)\b|"
    r"ngữ\s*pháp|từ\s*vựng|phát\s*âm|thì\s+hiện\s+tại|hiện\s+tại\s+đơn|"
    r"hiện\s+tại\s+tiếp\s+diễn|quá\s+khứ\s+đơn|mạo\s+từ|giới\s+từ|"
    r"đồng\s*nghĩa|trái\s*nghĩa|nghĩa\s*là|nghĩa\s*của|"
    r"sửa\s*câu|correct\s*:|fix\s*:|how\s+do\s+(?:you|i)\s+say|"
    r"dịch(?:\s+(?:sang|qua|ra|thành))?\s*tiếng\s*anh|bằng\s*tiếng\s*anh|"
    r"tiếng\s+anh|english\s+(grammar|vocab|word|sentence)|ielts|toeic"
    r")",
    re.I,
)

_VOCAB_INTENT = re.compile(
    r"("
    r"đồng\s*nghĩa|dong\s*nghia|synonym|synonyms|"
    r"trái\s*nghĩa|trai\s*nghia|antonym|antonyms|"
    r"dịch(?:\s+(?:sang|qua|ra|thành))?|"
    r"nghĩa\s*(?:là|của)|mean(?:s|ing)?\b|"
    r"translate|translation|"
    r"bằng\s*tiếng\s*anh|in\s+english|"
    r"how\s+do\s+(?:you|i)\s+say|what\s+is\s+.+\s+in\s+english|"
    r"tiếng\s*anh\s*là\s*gì"
    r")",
    re.I,
)

# Common VI → EN phrases (small-model fast path). Keys are lowercase Vietnamese lemmas.
_VI_EN_VOCAB: dict[str, dict[str, Any]] = {
    "đồng ý": {
        "primary": "agree",
        "synonyms": ["consent", "approve", "accept", "okay"],
        "pos": "verb",
        "gloss_vi": "đồng ý / tán thành / chấp nhận",
        "examples": [
            ("I agree with you.", "Tôi đồng ý với bạn."),
            ("They approved the plan.", "Họ phê duyệt kế hoạch."),
        ],
        "practice_vi": "Viết 1 câu tiếng Anh dùng `agree` về một quy định ở trường.",
        "practice_en": "Write 1 English sentence with `agree` about a school rule.",
    },
    "xin chào": {
        "primary": "hello",
        "synonyms": ["hi", "hey", "good morning"],
        "pos": "interjection",
        "gloss_vi": "lời chào",
        "examples": [
            ("Hello! How are you?", "Xin chào! Bạn khỏe không?"),
            ("Hi, nice to meet you.", "Chào bạn, rất vui được gặp bạn."),
        ],
        "practice_vi": "Viết 2 cách chào giáo viên bằng tiếng Anh.",
        "practice_en": "Write 2 English greetings for your teacher.",
    },
    "cảm ơn": {
        "primary": "thank you",
        "synonyms": ["thanks", "many thanks"],
        "pos": "phrase",
        "gloss_vi": "bày tỏ lòng biết ơn",
        "examples": [
            ("Thank you for your help.", "Cảm ơn bạn đã giúp đỡ."),
            ("Thanks a lot!", "Cảm ơn nhiều!"),
        ],
        "practice_vi": "Viết 1 câu cảm ơn bạn cùng lớp bằng tiếng Anh.",
        "practice_en": "Write 1 English sentence thanking a classmate.",
    },
    "xin lỗi": {
        "primary": "sorry",
        "synonyms": ["excuse me", "I apologize"],
        "pos": "phrase",
        "gloss_vi": "xin lỗi / bày tỏ sự ân hận",
        "examples": [
            ("I'm sorry I'm late.", "Xin lỗi vì tôi đến muộn."),
            ("Excuse me, can you help me?", "Xin lỗi, bạn giúp mình được không?"),
        ],
        "practice_vi": "Viết 1 câu xin lỗi vì quên bài tập (tiếng Anh).",
        "practice_en": "Write 1 English apology for forgetting homework.",
    },
}

_GENERAL_HINT = re.compile(
    r"("
    r"thế\s*chiến|chiến\s*tranh|lịch\s*sử|nguyên\s*nhân|phân\s*tích|"
    r"cách\s*mạng|đế\s*chế|địa\s*lý|khoa\s*học|sinh\s*học|hóa\s*học|"
    r"vật\s*lý|toán|văn\s*học|xã\s*hội|chính\s*trị|kinh\s*tế|"
    r"world\s*war|history|assassination|franz\s*ferdinand|"
    r"imperialism|nationalism|militarism|alliance"
    r")",
    re.I,
)


def _is_primarily_vietnamese(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if _VI_DIACRITICS.search(t):
        return True
    # Accent-stripped common Vietnamese tokens
    ascii_vi = re.compile(
        r"\b(cua|va|cho|voi|nhung|khong|duoc|trong|nguyen|nhan|"
        r"phan|tich|lich|su|chien|tranh|the|gioi|hoc|sinh|bai)\b",
        re.I,
    )
    # Prefer letter-count heuristic: many Vietnamese questions use Latin letters + VN words
    words = re.findall(r"[A-Za-zÀ-ỹĐđ]+", t)
    if not words:
        return False
    vi_markers = sum(1 for w in words if ascii_vi.fullmatch(w) or _VI_DIACRITICS.search(w))
    return vi_markers >= max(2, len(words) // 3)


_PRACTICE_FOLLOWUP = re.compile(
    r"("
    r"câu\s*hỏi|cau\s*hoi|bài\s*tập|bai\s*tap|làm\s*thử|lam\s*thu|"
    r"luyện\s*tập|luyen\s*tap|kiểm\s*tra|kiem\s*tra|"
    r"\b(practice|exercise|exercises|quiz|quizzes|questions?|drill|worksheet)\b|"
    r"cho\s*tôi\s*\d+|give\s+me\s+\d+|tạo\s*\d+|create\s+\d+"
    r")",
    re.I,
)


def _normalize_tutor_history(
    raw: list[TutorChatMessage] | list[dict[str, Any]] | None,
    *,
    current_message: str | None = None,
    max_turns: int = TUTOR_HISTORY_MAX_TURNS,
) -> list[dict[str, str]]:
    """Keep last N user/assistant turns; drop empty; avoid duplicating current user msg."""
    if not raw:
        return []
    out: list[dict[str, str]] = []
    cur = (current_message or "").strip()
    for item in raw:
        if isinstance(item, TutorChatMessage):
            role = (item.role or "").strip().lower()
            content = (item.content or "").strip()
        elif isinstance(item, dict):
            role = str(item.get("role") or "").strip().lower()
            content = str(item.get("content") or "").strip()
        else:
            continue
        if role not in ("user", "assistant") or not content:
            continue
        out.append({"role": role, "content": content})
    # Drop trailing duplicate of the current user message (clients may include it).
    if cur and out and out[-1]["role"] == "user" and out[-1]["content"] == cur:
        out = out[:-1]
    if max_turns > 0 and len(out) > max_turns:
        out = out[-max_turns:]
    return out


def _history_text(history: list[dict[str, str]] | None) -> str:
    if not history:
        return ""
    return "\n".join(f"{t['role']}: {t['content']}" for t in history)


def _history_has_esl(history: list[dict[str, str]] | None) -> bool:
    text = _history_text(history)
    return bool(text and _ESL_HINT.search(text))


def _is_practice_followup(message: str) -> bool:
    return bool(_PRACTICE_FOLLOWUP.search(message or ""))


def _is_vocab_intent(message: str) -> bool:
    return bool(_VOCAB_INTENT.search(message or ""))


def _strip_vi_punct(text: str) -> str:
    return re.sub(r"[^\w\sÀ-ỹĐđ]+", " ", text or "", flags=re.UNICODE).strip()


def _extract_vi_vocab_lemma(message: str) -> str | None:
    """Pull the Vietnamese target word/phrase from synonym/translate questions."""
    q = (message or "").strip()
    if not q:
        return None
    patterns = [
        r"đồng\s*nghĩa\s+với\s+(?:từ\s+)?[«\"'`]?(.+?)[»\"'`]?(?:\s+bằng|\s+trong|\s+sang|\?|$)",
        r"synonym(?:s)?\s+(?:of|for)\s+[«\"'`]?(.+?)[»\"'`]?(?:\s+in|\s+in\s+english|\?|$)",
        r"(?:từ\s+)?(.+?)\s+dịch\s+(?:sang|qua|ra|thành)",
        r"dịch\s+(?:từ\s+)?[«\"'`]?(.+?)[»\"'`]?\s+(?:sang|qua|ra|thành)",
        r"(?:từ\s+)?(.+?)\s+nghĩa\s+là",
        r"nghĩa\s+(?:của|là)\s+(?:từ\s+)?[«\"'`]?(.+?)[»\"'`!]?(?:\s+bằng|\s+trong|\?|$)",
        r"how\s+do\s+(?:you|i)\s+say\s+[«\"'`]?(.+?)[»\"'`]?(?:\s+in|\?|$)",
        r"what\s+is\s+[«\"'`]?(.+?)[»\"'`]?\s+in\s+english",
        r"(?:từ\s+)?(.+?)\s+bằng\s*tiếng\s*anh",
        r"(?:từ\s+)?(.+?)\s+tiếng\s*anh\s*là\s*gì",
    ]
    for pat in patterns:
        m = re.search(pat, q, re.I)
        if not m:
            continue
        lemma = _strip_vi_punct(m.group(1)).lower()
        lemma = re.sub(
            r"^(?:từ|the\s+word|word|cụm\s*từ)\s+",
            "",
            lemma,
            flags=re.I,
        ).strip()
        lemma = re.sub(r"\s+", " ", lemma)
        if lemma and len(lemma) <= 48:
            return lemma
    # Fallback: known lemmas mentioned anywhere in the question
    q_norm = _strip_vi_punct(q).lower()
    for lemma in sorted(_VI_EN_VOCAB.keys(), key=len, reverse=True):
        if lemma in q_norm:
            return lemma
    return None


def _lookup_vi_vocab(message: str) -> tuple[str, dict[str, Any]] | None:
    lemma = _extract_vi_vocab_lemma(message)
    if not lemma:
        return None
    if lemma in _VI_EN_VOCAB:
        return lemma, _VI_EN_VOCAB[lemma]
    # Soft match: lemma contained in a bank key or vice versa
    for key, entry in _VI_EN_VOCAB.items():
        if key in lemma or lemma in key:
            return key, entry
    return None


def _vocab_intent_kind(message: str) -> str:
    """Return synonym | translate | meaning for reply shaping."""
    q = message or ""
    if re.search(r"đồng\s*nghĩa|dong\s*nghia|synonym", q, re.I):
        return "synonym"
    if re.search(r"trái\s*nghĩa|trai\s*nghia|antonym", q, re.I):
        return "antonym"
    if re.search(
        r"dịch|translate|translation|bằng\s*tiếng\s*anh|in\s+english|"
        r"how\s+do\s+(?:you|i)\s+say|tiếng\s*anh\s*là\s*gì",
        q,
        re.I,
    ):
        return "translate"
    return "meaning"


def _history_already_covered_vocab(
    history: list[dict[str, str]] | None,
    lemma: str,
    primary: str,
) -> bool:
    text = _history_text(history).lower()
    if not text:
        return False
    return lemma.lower() in text or primary.lower() in text


def _vocab_synonym_fallback(
    message: str,
    *,
    vi: bool,
    history: list[dict[str, str]] | None = None,
) -> str | None:
    """Answer-first curated reply for VI→EN vocab / synonym / translation questions."""
    if not _is_vocab_intent(message):
        return None
    hit = _lookup_vi_vocab(message)
    if not hit:
        return None
    lemma, entry = hit
    primary = str(entry["primary"])
    synonyms = [str(s) for s in (entry.get("synonyms") or [])]
    examples = list(entry.get("examples") or [])
    kind = _vocab_intent_kind(message)
    followup = _history_already_covered_vocab(history, lemma, primary)

    syn_line = ", ".join(f"`{s}`" for s in synonyms[:4])
    if vi:
        if kind == "synonym":
            answer = (
                f"**Đáp án:** Từ đồng nghĩa tiếng Anh của **{lemma}** là "
                f"**`{primary}`**"
                + (f" (còn có: {syn_line})." if syn_line else ".")
            )
        elif kind == "translate":
            answer = (
                f"**Đáp án:** **{lemma}** → tiếng Anh: **`{primary}`**"
                + (f". Gần nghĩa: {syn_line}." if syn_line else ".")
            )
        else:
            answer = (
                f"**Đáp án:** **{lemma}** nghĩa tiếng Anh là **`{primary}`**"
                + (f" (synonyms: {syn_line})." if syn_line else ".")
            )
        explain = (
            f"**Giải thích:** `{primary}` là {entry.get('pos') or 'từ'} tiếng Anh — "
            f"{entry.get('gloss_vi') or lemma}."
        )
        if followup and kind == "translate":
            explain = (
                f"**Giải thích ngắn:** Đúng — **{lemma}** dịch là **`{primary}`**. "
                f"Các từ gần nghĩa: {syn_line or primary}."
            )
        ex_lines = []
        for en, vi_ex in examples[:2]:
            ex_lines.append(f"- `{en}` — {vi_ex}")
        practice = str(entry.get("practice_vi") or "").strip()
        parts = [answer, "", explain]
        if ex_lines:
            parts.extend(["", "**Ví dụ:**", *ex_lines])
        if practice and not followup:
            parts.extend(["", f"**Luyện tập:** {practice}"])
        elif practice and followup:
            parts.extend(
                [
                    "",
                    f"**Luyện tập:** Dùng `{primary}` hoặc một synonym "
                    f"({', '.join(synonyms[:2]) or primary}) trong 1 câu mới.",
                ]
            )
        return "\n".join(parts)

    # English reply locale
    if kind == "synonym":
        answer = (
            f"**Answer:** English synonyms of **{lemma}**: **`{primary}`**"
            + (f" (also: {syn_line})." if syn_line else ".")
        )
    elif kind == "translate":
        answer = (
            f"**Answer:** **{lemma}** in English is **`{primary}`**"
            + (f". Near-synonyms: {syn_line}." if syn_line else ".")
        )
    else:
        answer = (
            f"**Answer:** **{lemma}** means **`{primary}`**"
            + (f" (synonyms: {syn_line})." if syn_line else ".")
        )
    explain = (
        f"**Explanation:** `{primary}` is a {entry.get('pos') or 'word'} — "
        f"{entry.get('gloss_vi') or lemma}."
    )
    if followup and kind == "translate":
        explain = (
            f"**Explanation:** Direct translation: **{lemma}** → **`{primary}`**. "
            f"Near-synonyms: {syn_line or primary}."
        )
    ex_lines = [f"- `{en}` — {vi_ex}" for en, vi_ex in examples[:2]]
    practice = str(entry.get("practice_en") or "").strip()
    parts = [answer, "", explain]
    if ex_lines:
        parts.extend(["", "**Examples:**", *ex_lines])
    if practice:
        parts.extend(["", f"**Practice:** {practice}"])
    return "\n".join(parts)


def _request_history(body: TutorRequest) -> list[dict[str, str]]:
    raw = body.messages if body.messages is not None else body.history
    return _normalize_tutor_history(raw, current_message=body.message)


def _subject_is_english(subject: str | None) -> bool:
    return (subject or "").strip() in ("English", "IELTS", "TOEIC")


def detect_tutor_mode(
    message: str,
    locale: str = "vi",
    history: list[dict[str, str]] | None = None,
    classroom_subject: str | None = None,
) -> str:
    """Return 'english_learning' or 'general' from class subject + query (+ history)."""
    # Classroom subject is the primary mode signal when tutor is class-bound.
    if _subject_is_english(classroom_subject):
        return "english_learning"
    if classroom_subject and str(classroom_subject).strip() not in ("", "Other"):
        return "general"

    q = (message or "").strip()
    if not q:
        return "english_learning"
    esl = bool(_ESL_HINT.search(q))
    general = bool(_GENERAL_HINT.search(q))
    vi = _is_primarily_vietnamese(q) or (locale or "vi").startswith("vi")
    hist_esl = _history_has_esl(history)

    # Explicit ESL always wins (e.g. "giải thích present simple").
    if esl and not general:
        return "english_learning"
    if esl and general:
        # Mixed: prefer ESL only if clear English-learning cues dominate
        return "english_learning" if len(_ESL_HINT.findall(q)) >= len(_GENERAL_HINT.findall(q)) else "general"
    # Follow-ups like "cho tôi 10 câu hỏi" after an ESL turn → stay in ESL.
    if hist_esl and _is_practice_followup(q) and not general:
        return "english_learning"
    # Short follow-up after ESL chat (pronouns / "tiếp đi") without general-knowledge cues.
    if hist_esl and not general and len(q.split()) <= 24:
        return "english_learning"
    if general:
        return "general"
    # Vietnamese open questions without ESL keywords → general knowledge / study help
    if vi and not esl and not hist_esl:
        return "general"
    return "english_learning"


async def fetch_classroom_info(classroom_id: str, user_id: str | None) -> dict[str, Any] | None:
    headers = {
        "X-User-Id": user_id or "00000000-0000-0000-0000-000000000001",
        "X-User-Role": "STUDENT",
    }
    try:
        async with httpx.AsyncClient(timeout=TUTOR_CLASSROOM_TIMEOUT) as client:
            r = await client.get(
                f"{CLASSROOM_URL}/api/v1/classrooms/{classroom_id}",
                headers=headers,
            )
            if r.status_code == 200:
                data = r.json()
                return data if isinstance(data, dict) else None
    except httpx.HTTPError:
        return None
    return None


async def resolve_classroom_profile(
    body: TutorRequest,
    *,
    user_id: str | None,
    chunks: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Merge client meta + classroom-service + lesson CEFR into one profile."""
    cid = (body.classroom_id or "").strip()
    if not cid:
        return None

    name = (body.classroom_name or "").strip()
    description = (body.classroom_description or "").strip()
    subject = (body.subject or "").strip()
    knowledges = [k.strip() for k in (body.knowledges or []) if isinstance(k, str) and k.strip()]
    cefr = (body.cefr_level or "").strip() or None

    if not name or not description:
        info = await fetch_classroom_info(cid, user_id)
        if info:
            name = name or str(info.get("name") or "").strip()
            description = description or str(info.get("description") or "").strip()

    if not subject:
        subject, _ = _heuristic_subject(name, description)
    if not knowledges:
        knowledges = _heuristic_knowledges(name, description)

    if not cefr and chunks:
        for c in chunks:
            lvl = (c.get("cefr_level") or c.get("cefrLevel") or "").strip()
            if lvl:
                cefr = lvl
                break

    return {
        "id": cid,
        "name": name or "Classroom",
        "description": description[:500],
        "subject": subject or "Other",
        "knowledges": knowledges[:24],
        "cefr_level": cefr,
    }


def _classroom_binding_block(profile: dict[str, Any] | None, *, vi: bool) -> str:
    if not profile:
        return ""
    name = profile.get("name") or "Classroom"
    subject = profile.get("subject") or "Other"
    description = (profile.get("description") or "").strip() or "(none)"
    knowledges = profile.get("knowledges") or []
    cefr = profile.get("cefr_level") or ""
    kn = ", ".join(knowledges) if knowledges else "(none)"
    level_line = f"\n- Level / CEFR: {cefr}" if cefr else ""
    if vi:
        return (
            "\n\n=== LỚP ĐANG HỌC (BẮT BUỘC) ===\n"
            f"- Tên lớp: {name}\n"
            f"- Môn: {subject}\n"
            f"- Mô tả: {description}\n"
            f"- Knowledges: {kn}"
            f"{level_line}\n"
            "Chỉ hỗ trợ trong phạm vi lớp này. Hỏi lệch môn → lịch sự nhắc quay lại chủ đề lớp.\n"
        )
    return (
        "\n\n=== ACTIVE CLASSROOM (REQUIRED) ===\n"
        f"- Class name: {name}\n"
        f"- Subject: {subject}\n"
        f"- Description: {description}\n"
        f"- Knowledges: {kn}"
        f"{level_line}\n"
        "Only help within this classroom. If off-topic, politely redirect to the class subject.\n"
    )


def _missing_classroom_reply(locale: str) -> str:
    if (locale or "vi").startswith("vi"):
        return NO_CLASSROOM_REPLY_VI
    return NO_CLASSROOM_REPLY_EN


async def multimodal_node(state: GraphState) -> GraphState:
    modality = (state.get("modality") or "text").strip().lower()
    media = _strip_media_b64(state.get("media_base64"))
    locale = state.get("locale") or "vi"
    message = (state.get("message") or "").strip()

    if modality == "voice" and media:
        try:
            async with httpx.AsyncClient(timeout=TUTOR_STT_TIMEOUT) as client:
                r = await client.post(
                    f"{MULTIMODAL_URL}/v1/stt",
                    json={"audio_base64": media, "audioBase64": media, "language": locale},
                )
                if r.status_code == 200:
                    transcript = (r.json().get("text") or "").strip()
                    return {
                        **state,
                        "transcript": transcript,
                        "message": transcript
                        or message
                        or (
                            "Hãy giúp tôi luyện nói tiếng Anh."
                            if locale.startswith("vi")
                            else "Please help me practice speaking English."
                        ),
                    }
        except httpx.HTTPError:
            pass
        return state

    if modality == "image" and media:
        prompt = message or _default_image_prompt(locale)
        try:
            async with httpx.AsyncClient(timeout=TUTOR_VISION_TIMEOUT) as client:
                r = await client.post(
                    f"{MULTIMODAL_URL}/v1/vision",
                    json={
                        "image_base64": media,
                        "imageBase64": media,
                        "prompt": prompt,
                        "locale": locale,
                    },
                )
                if r.status_code == 200:
                    description = (r.json().get("description") or "").strip()
                    if description:
                        user_part = message or (
                            "Hãy giải thích ảnh và giúp tôi học từ nội dung."
                            if locale.startswith("vi")
                            else "Please explain the image and help me learn from it."
                        )
                        merged = f"{user_part}\n\n[Mô tả ảnh]: {description}".strip()
                        return {**state, "message": merged, "transcript": description}
        except httpx.HTTPError:
            pass
        # Soft fallback so tutor can still reply without vision model
        stub = (
            "Đã nhận ảnh. Hãy hỏi tôi về nội dung ảnh hoặc mô tả ngắn để mình hỗ trợ tiếng Anh."
            if locale.startswith("vi")
            else "Image received. Ask about it or describe it briefly so I can help with English."
        )
        return {**state, "message": (message + "\n\n" + stub).strip() if message else stub}
    return state


async def retrieve_node(state: GraphState) -> GraphState:
    chunks: list[dict[str, Any]] = []
    classroom_id = state.get("classroom_id")
    query = state["message"]

    # 1) Vector RAG (short timeout so tutor can start streaming quickly)
    try:
        async with httpx.AsyncClient(timeout=TUTOR_RAG_TIMEOUT) as client:
            r = await client.post(
                f"{RAG_URL}/v1/retrieve",
                json={"query": query, "classroom_id": classroom_id, "top_k": 5},
            )
            if r.status_code == 200:
                chunks = [c for c in r.json().get("chunks", []) if (c.get("text") or "").strip()]
    except httpx.HTTPError:
        chunks = []

    # 2) Fallback: published lessons from content-service (more reliable grounding)
    if not chunks and classroom_id:
        lesson_chunks = await fetch_classroom_lessons(
            classroom_id,
            user_id=state.get("user_id"),
        )
        chunks = lesson_chunks

    return {**state, "context_chunks": chunks}


async def fetch_classroom_lessons(classroom_id: str, user_id: str | None) -> list[dict[str, Any]]:
    headers = {
        "X-User-Id": user_id or "00000000-0000-0000-0000-000000000001",
        "X-User-Role": "STUDENT",
    }
    try:
        async with httpx.AsyncClient(timeout=TUTOR_CONTENT_TIMEOUT) as client:
            r = await client.get(
                f"{CONTENT_URL}/api/v1/content/lessons",
                params={"classroomId": classroom_id},
                headers=headers,
            )
            if r.status_code != 200:
                return []
            lessons = r.json()
    except httpx.HTTPError:
        return []

    out: list[dict[str, Any]] = []
    for lesson in lessons:
        if str(lesson.get("status", "")).upper() not in ("PUBLISHED", "DRAFT"):
            continue
        # Prefer published; still allow draft in early MVP if that is all teachers created
        body = (lesson.get("body") or "")[:1200]
        if not body.strip():
            continue
        out.append(
            {
                "lesson_id": lesson.get("id"),
                "classroom_id": classroom_id,
                "title": lesson.get("title"),
                "text": body,
                "cefr_level": lesson.get("cefrLevel") or lesson.get("cefr_level"),
                "score": 1.0 if str(lesson.get("status")).upper() == "PUBLISHED" else 0.5,
            }
        )
    # Prefer published first
    out.sort(key=lambda c: c.get("score", 0), reverse=True)
    return out[:5]


async def generate_node(state: GraphState) -> GraphState:
    locale = state.get("locale") or "vi"
    chunks = state.get("context_chunks") or []
    message = (state.get("message") or "").strip()
    history = state.get("history") or []
    profile = dict(state.get("classroom_profile") or {})
    if profile and not profile.get("cefr_level") and chunks:
        for c in chunks:
            lvl = (c.get("cefr_level") or c.get("cefrLevel") or "").strip()
            if lvl:
                profile["cefr_level"] = lvl
                break
    subject = profile.get("subject") if profile else None
    mode = detect_tutor_mode(message, locale, history, classroom_subject=subject)

    if not state.get("classroom_id"):
        return {
            **state,
            "reply": _missing_classroom_reply(locale),
            "tutor_mode": mode,
        }

    # Prefer curated accurate answers (ESL topics + key general-knowledge facts)
    curated = pedagogical_fallback(
        message,
        locale,
        chunks,
        allow_generic=False,
        mode=mode,
        history=history,
        classroom_profile=profile,
    )
    if curated:
        return {**state, "reply": curated, "tutor_mode": mode}

    system, user_prompt = _tutor_prompts(
        message, locale, chunks, mode=mode, history=history, classroom_profile=profile
    )
    num_predict = TUTOR_NUM_PREDICT if mode == "english_learning" else max(TUTOR_NUM_PREDICT, 360)
    if mode == "english_learning" and _is_practice_followup(message):
        num_predict = max(num_predict, 480)
    reply = await call_ollama_chat(
        system,
        user_prompt,
        model=OLLAMA_TUTOR_MODEL,
        num_predict=num_predict,
        temperature=0.2,
        timeout=TUTOR_OLLAMA_TIMEOUT,
        history=history,
    )
    if not reply or _looks_like_safety_refusal(reply):
        reply = pedagogical_fallback(
            message,
            locale,
            chunks,
            allow_generic=True,
            mode=mode,
            history=history,
            classroom_profile=profile,
        ) or (
            "Xin lỗi, mình chưa trả lời được lúc này. Hãy hỏi lại rõ hơn."
            if mode == "general"
            else "Xin lỗi, mình chưa trả lời được lúc này. Hãy hỏi lại về ngữ pháp hoặc gửi câu cần sửa."
        )
    # Guardrail: reject known-bad confusion patterns from weak models
    if _looks_inaccurate(reply, message):
        reply = pedagogical_fallback(
            message,
            locale,
            chunks,
            allow_generic=True,
            mode=mode,
            history=history,
            classroom_profile=profile,
        ) or reply
    return {**state, "reply": reply, "tutor_mode": mode}


def _looks_like_safety_refusal(reply: str) -> bool:
    """Small models sometimes refuse 'câu hỏi' / image captions as harmful content."""
    r = (reply or "").lower()
    return bool(
        re.search(
            r"("
            r"illegal|harmful|dangerous\s+activit|"
            r"không\s*thể\s*(hỗ\s*trợ|giúp|trả\s*lời).*?(bất\s*hợp\s*pháp|gây\s*hại|bạo\s*lực)|"
            r"hành\s*vi\s*sử\s*dụng\s*bạo\s*lực|"
            r"cannot\s+(help|assist|provide|answer).*?(illegal|harmful|violence)|"
            r"i\s+can'?t\s+(help|assist|answer).*?(illegal|harmful|violence)|"
            r"against\s+(my|the)\s+(guidelines|policies)|"
            r"as\s+an\s+ai.*?(cannot|can't|won't)"
            r")",
            r,
            re.I,
        )
    )


def _looks_inaccurate(reply: str, question: str) -> bool:
    r = reply.lower()
    q = question.lower()
    if "present simple" in q or "hiện tại đơn" in q or "hien tai don" in q:
        if "present continuous" in r and ("hình thức của" in r or "form of present continuous" in r):
            return True
    # WWI question must not blame WWII treaties / WWII events
    if re.search(r"thế\s*chiến\s*thứ\s*nhất|the\s*first\s*world\s*war|world\s*war\s*i\b|wwi\b", q, re.I):
        if re.search(
            r"thế\s*chiến\s*thứ\s*hai|world\s*war\s*ii|wwii|"
            r"hiệp\s*ước\s*versailles.*(gây|nguyên\s*nhân).*thế\s*chiến\s*thứ\s*nhất|"
            r"versailles.*(cause|caused).*world\s*war\s*i",
            r,
            re.I,
        ):
            return True
    # Vocab / synonym / translate → English must actually give English word(s).
    if _is_vocab_intent(question):
        hit = _lookup_vi_vocab(question)
        if hit:
            primary = str(hit[1]["primary"]).lower()
            if primary and primary not in r:
                return True
        en_words = re.findall(r"\b[a-z]{3,}\b", r)
        # Ignore common Vietnamese-loaned Latin headings tokens already lowercased
        useful = [
            w
            for w in en_words
            if w
            not in {
                "dap",
                "an",
                "giai",
                "thich",
                "vi",
                "du",
                "luyen",
                "tap",
                "the",
                "and",
                "for",
                "with",
            }
        ]
        if len(useful) < 1:
            return True
        # Practice that echoes the student question without answering
        q_core = re.sub(r"\s+", " ", q).strip(" ?!.")
        if q_core and len(q_core) >= 12 and q_core in r and "agree" not in r:
            if re.search(r"luyện\s*tập|practice", r, re.I):
                return True
    return False


def build_graph():
    graph = StateGraph(GraphState)
    graph.add_node("multimodal", multimodal_node)
    graph.add_node("retrieve", retrieve_node)
    graph.add_node("generate", generate_node)
    graph.set_entry_point("multimodal")
    graph.add_edge("multimodal", "retrieve")
    graph.add_edge("retrieve", "generate")
    graph.add_edge("generate", END)
    return graph.compile()


tutor_graph = build_graph()


def _ollama_messages(
    system: str,
    user_prompt: str,
    history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    msgs: list[dict[str, str]] = [{"role": "system", "content": system}]
    for turn in history or []:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user_prompt})
    return msgs


async def call_ollama_chat(
    system: str,
    user_prompt: str,
    *,
    model: str | None = None,
    num_predict: int = 450,
    temperature: float = 0.2,
    timeout: float = 120.0,
    allow_generate_fallback: bool = True,
    history: list[dict[str, str]] | None = None,
) -> str | None:
    """Prefer /api/chat with low temperature for more accurate tutoring."""
    use_model = (model or OLLAMA_MODEL).strip() or OLLAMA_MODEL
    chat_messages = _ollama_messages(system, user_prompt, history)
    payload = {
        "model": use_model,
        "messages": chat_messages,
        "stream": False,
        "options": {
            "temperature": temperature,
            "top_p": 0.8,
            "repeat_penalty": 1.15,
            "num_predict": num_predict,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            if r.status_code == 200:
                msg = (r.json().get("message") or {}).get("content", "").strip()
                if msg:
                    return msg

            if not allow_generate_fallback:
                return None

            # Fallback to /api/generate (flatten history into prompt)
            hist_block = ""
            if history:
                hist_block = "Conversation so far:\n" + _history_text(history) + "\n\n"
            r2 = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": use_model,
                    "prompt": f"{system}\n\n{hist_block}{user_prompt}",
                    "stream": False,
                    "options": payload["options"],
                },
            )
            if r2.status_code == 200:
                text = (r2.json().get("response") or "").strip()
                return text or None
    except (httpx.HTTPError, httpx.TimeoutException, ValueError, TypeError):
        return None
    return None


def _tutor_prompts(
    message: str,
    locale: str,
    chunks: list[dict[str, Any]],
    mode: str | None = None,
    history: list[dict[str, str]] | None = None,
    classroom_profile: dict[str, Any] | None = None,
) -> tuple[str, str]:
    subject = (classroom_profile or {}).get("subject") if classroom_profile else None
    mode = mode or detect_tutor_mode(message, locale, history, classroom_subject=subject)
    # Prefer Vietnamese reply language from current msg; fall back to history / locale.
    vi_reply = (
        _is_primarily_vietnamese(message)
        or _is_primarily_vietnamese(_history_text(history))
        or (locale or "vi").startswith("vi")
    )

    if chunks:
        context = "\n\n".join(
            f"[{i + 1}] {c.get('title', 'Lesson')}:\n{c.get('text', '')}" for i, c in enumerate(chunks)
        )
        grounded_note = (
            "Dùng ngữ cảnh bài học bên dưới khi phù hợp; không mâu thuẫn với bài / môn lớp."
            if vi_reply
            else "Use the lesson context below when relevant. Do not contradict class subject or lessons."
        )
    else:
        if mode == "general":
            context = (
                "(Không có bài giảng. Vẫn chỉ trả lời theo môn/mô tả/knowledges của lớp.)"
                if vi_reply
                else "(No lessons retrieved. Still constrain answers to class subject/description/knowledges.)"
            )
            grounded_note = (
                "Không có bài giảng — bám môn lớp và mô tả lớp; không lan sang chủ đề khác."
                if vi_reply
                else "No lesson materials — stay within class subject metadata only."
            )
        else:
            context = (
                "(Không có bài giảng. Vẫn dạy tiếng Anh theo môn/mô tả/knowledges của lớp.)"
                if vi_reply
                else "(No lessons retrieved. Teach English within this class subject/knowledges only.)"
            )
            grounded_note = (
                "Không có bài giảng — dạy tiếng Anh chính xác trong phạm vi lớp đã chọn."
                if vi_reply
                else "No lesson materials — teach accurately within the selected class scope."
            )

    if mode == "general":
        system = SYSTEM_PROMPT_GENERAL_VI if vi_reply else SYSTEM_PROMPT_GENERAL_EN
        answer_label = "Câu trả lời (toàn bộ bằng tiếng Việt):" if vi_reply else "Answer:"
    else:
        system = SYSTEM_PROMPT_ESL_VI if vi_reply else SYSTEM_PROMPT_ESL_EN
        answer_label = "Tutor answer:"

    system = system + _classroom_binding_block(classroom_profile, vi=vi_reply)

    followup_note = ""
    if mode == "english_learning" and _is_practice_followup(message) and not _is_vocab_intent(message):
        followup_note = (
            "\nIMPORTANT: This is a practice follow-up inside the selected English class. "
            "Prior turns / class knowledges define the topic. Generate the requested practice now. "
            "Do NOT refuse. 'câu hỏi' means practice questions, not harmful content.\n"
            if not vi_reply
            else "\nQUAN TRỌNG: Đây là yêu cầu bài luyện trong lớp tiếng Anh đã chọn. "
            "Hội thoại trước / knowledges lớp quyết định chủ đề. Tạo đúng số câu hỏi được yêu cầu. "
            "KHÔNG từ chối. 'câu hỏi' = câu luyện tập, không phải nội dung bất hợp pháp.\n"
        )
    elif mode == "english_learning" and _is_vocab_intent(message):
        followup_note = (
            "\nIMPORTANT: This is a vocabulary / synonym / translation question. "
            "Answer FIRST with the clear English word(s) (and synonyms if asked). "
            "Then a short explanation, then 1–2 bilingual examples. "
            "Optional short practice — do NOT repeat the student's question as practice.\n"
            if not vi_reply
            else "\nQUAN TRỌNG: Đây là câu hỏi từ vựng / đồng nghĩa / dịch. "
            "TRẢ LỜI TRƯỚC bằng từ tiếng Anh rõ ràng (và synonyms nếu hỏi đồng nghĩa). "
            "Sau đó giải thích ngắn, rồi 1–2 ví dụ song ngữ. "
            "Luyện tập ngắn tùy chọn — KHÔNG hỏi lại đúng câu hỏi của học sinh.\n"
        )

    user_prompt = (
        f"{grounded_note}\n"
        f"{followup_note}\n"
        f"Lesson context:\n{context}\n\n"
        f"Student question:\n{message}\n\n"
        f"{answer_label}"
    )
    return system, user_prompt


def _tutor_sources(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "lessonId": c.get("lesson_id"),
            "title": c.get("title"),
            "score": c.get("score"),
        }
        for c in chunks
    ]


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _stream_text_chunks(text: str, chunk_size: int = 16) -> AsyncIterator[str]:
    """Yield character chunks so heuristic replies still feel live in the UI."""
    if not text:
        return
    for i in range(0, len(text), chunk_size):
        yield text[i : i + chunk_size]
        await asyncio.sleep(0.012)


async def stream_ollama_chat(
    system: str,
    user_prompt: str,
    *,
    model: str | None = None,
    num_predict: int = 280,
    temperature: float = 0.2,
    timeout: float = 8.0,
    history: list[dict[str, str]] | None = None,
) -> AsyncIterator[str]:
    """Stream token deltas from Ollama /api/chat (NDJSON)."""
    use_model = (model or OLLAMA_TUTOR_MODEL).strip() or OLLAMA_TUTOR_MODEL
    payload = {
        "model": use_model,
        "messages": _ollama_messages(system, user_prompt, history),
        "stream": True,
        "options": {
            "temperature": temperature,
            "top_p": 0.8,
            "repeat_penalty": 1.15,
            "num_predict": num_predict,
        },
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", f"{OLLAMA_BASE_URL}/api/chat", json=payload) as r:
            if r.status_code != 200:
                logger.warning("Ollama tutor stream HTTP %s", r.status_code)
                return
            async for line in r.aiter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                delta = ((data.get("message") or {}).get("content") or "")
                if delta:
                    yield delta
                if data.get("done"):
                    break


def _extract_practice_count(message: str, default: int = 10) -> int:
    m = re.search(r"\b(\d{1,2})\b", message or "")
    if not m:
        return default
    n = int(m.group(1))
    return max(3, min(n, 15))


def _grammar_practice_fallback(
    message: str,
    history: list[dict[str, str]] | None,
    *,
    vi: bool,
    classroom_profile: dict[str, Any] | None = None,
) -> str | None:
    """Deterministic ESL practice set when follow-up asks for N questions after grammar talk."""
    if not _is_practice_followup(message):
        return None
    subject = (classroom_profile or {}).get("subject") if classroom_profile else None
    class_esl = _subject_is_english(subject)
    if not (
        class_esl
        or _history_has_esl(history)
        or _ESL_HINT.search(message or "")
    ):
        return None
    n = _extract_practice_count(message, 10)
    # Prefer user turns + class meta for topic (ignore assistant examples that mention tenses).
    user_hist = " ".join(
        t["content"] for t in (history or []) if t.get("role") == "user"
    ).lower()
    class_blob = " ".join(
        [
            str((classroom_profile or {}).get("name") or ""),
            str((classroom_profile or {}).get("description") or ""),
            " ".join((classroom_profile or {}).get("knowledges") or []),
        ]
    ).lower()
    blob = f"{user_hist} {message} {class_blob}"
    topic = "English grammar"
    class_name = ((classroom_profile or {}).get("name") or "").strip()
    if re.search(r"present\s*simple|hiện\s*tại\s*đơn|hien\s*tai\s*don", blob, re.I):
        topic = "Present Simple"
    elif re.search(r"present\s*continuous|hiện\s*tại\s*tiếp|hien\s*tai\s*tiep", blob, re.I):
        topic = "Present Continuous"
    elif re.search(r"past\s*simple|quá\s*khứ\s*đơn|qua\s*khu\s*don", blob, re.I):
        topic = "Past Simple"
    elif re.search(r"grammar|ngữ\s*pháp|ngu\s*phap|english\s*skills", blob, re.I):
        topic = "English grammar / skills"
    elif class_name:
        topic = f"{class_name} · English practice"

    # Mixed item bank — cycle to requested count.
    bank_en = [
        "Choose the correct form: She ___ to school every day. (go / goes / going)",
        "Correct the sentence: He don't like coffee.",
        "Fill in: They ___ (play) football on Sundays.",
        "Make a Present Simple question with: you / speak / English",
        "Choose: I ___ breakfast at 7 a.m. (have / has / having)",
        "Correct: She go to the market yesterday. (use a suitable tense)",
        "Fill in: My brother ___ (not / watch) TV in the morning.",
        "Rewrite in negative: They live in Da Nang.",
        "Choose: The sun ___ in the east. (rise / rises / rising)",
        "Make a Wh- question: she / live / where",
        "Fill in: We ___ (study) English every evening.",
        "Correct: Does he plays tennis?",
        "Choose: Cats ___ milk. (like / likes / liking)",
        "Fill in: ___ you ___ (want) some water?",
        "Write one sentence about your daily routine using Present Simple.",
    ]
    items = [bank_en[(i) % len(bank_en)] for i in range(n)]
    if vi:
        lines = [
            f"**Luyện tập ({n} câu) — {topic}**",
            "",
            "Dựa trên yêu cầu ôn luyện của bạn, đây là các câu hỏi thực hành:",
            "",
        ]
        lines.extend(f"{i + 1}. {q}" for i, q in enumerate(items))
        lines.extend(["", "Trả lời xong, gửi đáp án để mình chữa nhé."])
        return "\n".join(lines)
    lines = [
        f"**Practice ({n} questions) — {topic}**",
        "",
        "Based on your practice request, try these:",
        "",
    ]
    lines.extend(f"{i + 1}. {q}" for i, q in enumerate(items))
    lines.extend(["", "Send your answers when ready for feedback."])
    return "\n".join(lines)


def pedagogical_fallback(
    message: str,
    locale: str,
    chunks: list[dict[str, Any]],
    allow_generic: bool = True,
    mode: str | None = None,
    history: list[dict[str, str]] | None = None,
    classroom_profile: dict[str, Any] | None = None,
) -> str | None:
    """Accurate rule-based answers for common topics; optional generic coaching."""
    q = message.lower().strip()
    subject = (classroom_profile or {}).get("subject") if classroom_profile else None
    mode = mode or detect_tutor_mode(
        message, locale, history, classroom_subject=subject
    )
    vi = (
        _is_primarily_vietnamese(message)
        or _is_primarily_vietnamese(_history_text(history))
        or (locale or "vi").startswith("vi")
    )

    # ESL practice follow-up (e.g. "cho tôi 10 câu hỏi") after grammar intent in history.
    # Prefer this over tiny models that misread "câu hỏi" as harmful content.
    # Skip when the message is a vocab/synonym/translate ask (not a practice drill).
    if mode == "english_learning" and not _is_vocab_intent(message):
        practice = _grammar_practice_fallback(
            message, history, vi=vi, classroom_profile=classroom_profile
        )
        if practice:
            return practice

    # VI→EN vocab / synonym / translation — answer-first curated path (before lesson dump).
    if mode == "english_learning" or _is_vocab_intent(message) or _ESL_HINT.search(q):
        vocab_reply = _vocab_synonym_fallback(message, vi=vi, history=history)
        if vocab_reply:
            return vocab_reply

    # --- Curated general knowledge (only when class/mode is general, not English class) ---
    if mode != "general":
        pass  # skip WWI / general-knowledge banks for ESL classrooms
    elif re.search(r"thế\s*chiến\s*thứ\s*nhất|world\s*war\s*i\b|first\s*world\s*war|\bwwi\b", q, re.I):
        if vi:
            return (
                "**Nguyên nhân Chiến tranh thế giới thứ nhất (1914–1918)**\n\n"
                "Cuộc chiến bùng nổ không chỉ vì một sự kiện, mà do nhiều mâu thuẫn tích tụ lâu dài "
                "ở châu Âu cuối thế kỷ 19 – đầu thế kỷ 20.\n\n"
                "**1) Hệ thống liên minh đối đầu**\n"
                "- phe Liên minh Ba nước (Đức, Áo-Hung, Ý) và phe Hiệp ước Ba nước "
                "(Anh, Pháp, Nga) khiến xung đột cục bộ dễ lan thành chiến tranh toàn châu lục.\n\n"
                "**2) Chủ nghĩa đế quốc**\n"
                "- các cường quốc tranh giành thuộc địa, thị trường và ảnh hưởng (nhất là ở châu Phi, châu Á).\n\n"
                "**3) Chủ nghĩa dân tộc**\n"
                "- tinh thần dân tộc mạnh, đặc biệt ở vùng Balkan; các dân tộc thuộc Đế quốc Áo-Hung "
                "muốn độc lập.\n\n"
                "**4) Chủ nghĩa quân phiệt và chạy đua vũ trang**\n"
                "- các nước mở rộng quân đội, hải quân; kế hoạch chiến tranh sẵn sàng khiến ngoại giao "
                "dễ thất bại.\n\n"
                "**5) Ngòi nổ trực tiếp**\n"
                "- ngày 28/6/1914, Thái tử Áo-Hung Franz Ferdinand bị ám sát tại Sarajevo. "
                "Áo-Hung tuyên chiến với Serbia; hệ thống liên minh kéo các cường quốc vào cuộc chiến.\n\n"
                "**Lưu ý:** Hiệp ước Versailles (1919) là hệ quả sau Thế chiến I, "
                "không phải nguyên nhân gây ra Thế chiến I (và cũng không nên nhầm với Thế chiến II).\n\n"
                "**Kết luận ngắn:** nguyên nhân sâu xa là liên minh – đế quốc – dân tộc – quân phiệt; "
                "vụ ám sát Franz Ferdinand là yếu tố kích hoạt."
            )
        return (
            "**Causes of World War I (1914–1918)**\n\n"
            "Long-term tensions: opposing alliance systems, imperialism, nationalism, militarism/"
            "arms races. Trigger: assassination of Archduke Franz Ferdinand in Sarajevo (28 June 1914). "
            "The Treaty of Versailles (1919) was a consequence of WWI, not a cause of it."
        )

    # Sentence correction request → ESL
    correct_match = re.search(
        r"(?:correct|sửa(?:\s+câu)?|fix)\s*:?\s*(.+)$",
        message,
        re.I | re.S,
    )
    if correct_match:
        original = correct_match.group(1).strip().strip("\"'")
        fixed = _simple_correct(original)
        if vi:
            return (
                f"**Sửa câu**\n\n"
                f"- Câu gốc: `{original}`\n"
                f"- Câu gợi ý: `{fixed}`\n\n"
                f"**Luyện tập:** Viết lại câu đúng bằng cách của bạn."
            )
        return (
            f"**Correction**\n\n- Original: `{original}`\n- Suggested: `{fixed}`\n\n"
            f"**Practice:** Rewrite the corrected sentence in your own words."
        )

    # If we have lesson context and question is open, teach from it
    if chunks and allow_generic:
        top = chunks[0]
        title = top.get("title") or "bài học"
        excerpt = (top.get("text") or "")[:400]
        if mode == "general" and vi:
            return (
                f"**Dựa trên bài học «{title}»**\n\n"
                f"{excerpt}\n\n"
                f"**Gợi ý học:** Hãy tóm tắt lại 2–3 ý chính bằng tiếng Việt bằng lời của bạn."
            )
        if vi:
            return (
                f"**Dựa trên bài học «{title}»**\n\n"
                f"{excerpt}\n\n"
                f"**Ví dụ:** Write 1 English sentence about the idea above.\n\n"
                f"**Luyện tập:** Viết lại một câu then chốt của bài bằng tiếng Anh theo cách của bạn."
            )
        return (
            f"**From lesson «{title}»**\n\n{excerpt}\n\n"
            f"**Practice:** Rewrite one key sentence from the lesson in your own words."
        )

    patterns: list[tuple[re.Pattern[str], str, str]] = [
        (
            re.compile(r"\b(present simple|thì hiện tại đơn|hien tai don|hiện tại đơn)\b", re.I),
            (
                "**Thì hiện tại đơn (Present Simple)** dùng để nói thói quen, sự thật, lịch trình.\n\n"
                "- Công thức: `S + V(s/es)` (khẳng định), `S + do/does + not + V` (phủ định), "
                "`Do/Does + S + V?` (nghi vấn).\n"
                "- Ví dụ: `I study English every day.` / `She works in Hanoi.`\n"
                "- Với he/she/it thêm **-s/-es**: `watch → watches`.\n"
                "- Không nhầm với Present Continuous (`am/is/are + V-ing`) — continuous là việc đang xảy ra.\n\n"
                "**Luyện tập:** Viết 1 câu về thói quen buổi sáng của bạn bằng Present Simple."
            ),
            (
                "**Present Simple** is for habits, facts, and schedules.\n\n"
                "Form: `S + V(s/es)` / `do/does not + V` / `Do/Does + S + V?`\n"
                "Examples: `I study English every day.` `She works in Hanoi.`\n"
                "Do not confuse with Present Continuous (`am/is/are + V-ing`).\n\n"
                "**Practice:** Write one morning-habit sentence in Present Simple."
            ),
        ),
        (
            re.compile(r"\b(present continuous|hiện tại tiếp diễn|hien tai tiep dien|tiếp diễn)\b", re.I),
            (
                "**Thì hiện tại tiếp diễn (Present Continuous)** mô tả hành động đang diễn ra.\n\n"
                "- Công thức: `S + am/is/are + V-ing`\n"
                "- Ví dụ: `I am learning English now.` / `They are watching a video.`\n"
                "- Không dùng với stative verbs thường gặp: `know, like, want, believe`.\n\n"
                "**Luyện tập:** Nhìn quanh phòng và viết 1 câu Present Continuous."
            ),
            (
                "**Present Continuous** describes actions happening now: `S + am/is/are + V-ing`.\n"
                "Example: `I am learning English now.`\n\n"
                "**Practice:** Write one Present Continuous sentence about what you are doing."
            ),
        ),
        (
            re.compile(r"\b(past simple|quá khứ đơn|qua khu don|quá khứ)\b", re.I),
            (
                "**Thì quá khứ đơn (Past Simple)** nói việc đã xảy ra và kết thúc trong quá khứ.\n\n"
                "- Động từ có quy tắc: `V + ed` (`play → played`).\n"
                "- Bất quy tắc: `go → went`, `have → had`, `see → saw`.\n"
                "- Ví dụ: `I visited my grandparents yesterday.`\n\n"
                "**Luyện tập:** Viết 1 câu về việc bạn làm hôm qua."
            ),
            (
                "**Past Simple** is for finished past actions (`V-ed` or irregular forms).\n"
                "Example: `I visited my grandparents yesterday.`\n\n"
                "**Practice:** Write one sentence about yesterday."
            ),
        ),
        (
            re.compile(r"\b(a|an|the)\b.*\b(article|mạo từ|mao tu)\b|\b(mạo từ|articles?)\b", re.I),
            (
                "**Mạo từ (Articles)**\n\n"
                "- `a` trước phụ âm: `a book`, `a university` (âm /j/).\n"
                "- `an` trước nguyên âm: `an apple`, `an hour` (âm câm h).\n"
                "- `the` khi cả người nói và nghe đều biết đối tượng cụ thể: `the sun`, `the book on the table`.\n\n"
                "**Luyện tập:** Điền a/an/the: `I saw ___ elephant at ___ zoo.`"
            ),
            (
                "**Articles:** `a` before consonant sounds, `an` before vowel sounds, `the` for specific nouns.\n"
                "**Practice:** Fill in: `I saw ___ elephant at ___ zoo.`"
            ),
        ),
        (
            re.compile(r"\b(hello|xin chào|chao|how do i say hello)\b", re.I),
            (
                "**Chào hỏi tiếng Anh**\n\n"
                "- Thân mật: `Hi!` / `Hey!`\n"
                "- Lịch sự: `Hello!` / `Good morning.` / `Good afternoon.`\n"
                "- Ví dụ hội thoại: `Hi, how are you?` → `I'm good, thanks. And you?`\n\n"
                "**Luyện tập:** Viết 2 cách chào giáo viên của bạn."
            ),
            (
                "Common greetings: `Hi!`, `Hello!`, `Good morning.`\n"
                "Example: `Hi, how are you?` → `I'm good, thanks.`\n\n"
                "**Practice:** Write two greetings for your teacher."
            ),
        ),
    ]

    # ESL curated patterns only in english-learning mode (or when ESL keywords match)
    if mode == "english_learning" or _ESL_HINT.search(q):
        for pattern, ans_vi, ans_en in patterns:
            if pattern.search(q):
                return ans_vi if vi else ans_en

    if not allow_generic:
        return None

    if mode == "general":
        if vi:
            return (
                "Mình có thể giúp bạn phân tích kiến thức chung. Hãy nêu rõ chủ đề "
                "(ví dụ lịch sử, khoa học) và câu hỏi cụ thể hơn.\n\n"
                f"**Câu hỏi của bạn:** {message}"
            )
        return (
            "I can help with general study questions. Please specify the topic more clearly.\n\n"
            f"Your question: {message}"
        )

    if vi:
        return (
            "Mình có thể giúp bạn học tiếng Anh. Hãy hỏi cụ thể hơn, ví dụ:\n"
            "- `giải thích present simple`\n"
            "- `sửa câu: She go to school every day`\n\n"
            f"**Câu hỏi của bạn:** {message}"
        )
    return (
        "Ask a specific grammar/vocab question "
        "(e.g. 'explain present simple' or 'correct: She go to school').\n\n"
        f"Your question: {message}"
    )


def _simple_correct(sentence: str) -> str:
    s = " ".join(sentence.split())
    # Very small, high-precision fixes for common learner errors
    s = re.sub(r"\bShe go\b", "She goes", s, flags=re.I)
    s = re.sub(r"\bHe go\b", "He goes", s, flags=re.I)
    s = re.sub(r"\bIt go\b", "It goes", s, flags=re.I)
    s = re.sub(r"\bShe have\b", "She has", s, flags=re.I)
    s = re.sub(r"\bHe have\b", "He has", s, flags=re.I)
    s = re.sub(r"\bI is\b", "I am", s, flags=re.I)
    s = re.sub(r"\bHe are\b", "He is", s, flags=re.I)
    s = re.sub(r"\bShe are\b", "She is", s, flags=re.I)
    s = re.sub(r"\bThey is\b", "They are", s, flags=re.I)
    s = re.sub(r"\bdon't can\b", "can't", s, flags=re.I)
    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    if s and s[-1] not in ".!?":
        s += "."
    return s


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "service": "ai-orchestration"}


SUBJECT_LABELS = (
    "Literature",
    "Math",
    "English",
    "History",
    "PhysicalEducation",
    "NationalDefense",
    "ExperientialActivities",
    "LocalEducation",
    "Physics",
    "Chemistry",
    "Biology",
    "Geography",
    "CivicEducation",
    "Technology",
    "Informatics",
    "Music",
    "FineArts",
    "IELTS",
    "TOEIC",
    "Science",
    "Business",
    "Other",
)

# Vietnamese / short aliases → English storage keys for detect-subject.
SUBJECT_ALIASES = {
    "ngữ văn": "Literature",
    "văn học": "Literature",
    "toán": "Math",
    "toán học": "Math",
    "ngoại ngữ": "English",
    "ngoại ngữ 1": "English",
    "tiếng anh": "English",
    "lịch sử": "History",
    "giáo dục thể chất": "PhysicalEducation",
    "thể chất": "PhysicalEducation",
    "thể dục": "PhysicalEducation",
    "giáo dục quốc phòng và an ninh": "NationalDefense",
    "quốc phòng": "NationalDefense",
    "hoạt động trải nghiệm, hướng nghiệp": "ExperientialActivities",
    "trải nghiệm": "ExperientialActivities",
    "hướng nghiệp": "ExperientialActivities",
    "nội dung giáo dục của địa phương": "LocalEducation",
    "vật lí": "Physics",
    "vật lý": "Physics",
    "hóa học": "Chemistry",
    "hoá học": "Chemistry",
    "sinh học": "Biology",
    "địa lí": "Geography",
    "địa lý": "Geography",
    "giáo dục kinh tế và pháp luật": "CivicEducation",
    "công nghệ": "Technology",
    "tin học": "Informatics",
    "âm nhạc": "Music",
    "mĩ thuật": "FineArts",
    "mỹ thuật": "FineArts",
    "khoa học": "Science",
    "kinh doanh": "Business",
    "khác": "Other",
}


class DetectSubjectRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = ""
    description: str = ""


# Canonical Vietnamese labels for UI + storage (English aliases accepted on parse).
KNOWLEDGE_LABELS = (
    "Ngữ pháp",
    "Từ vựng",
    "Nói",
    "Nghe",
    "Viết",
    "Đọc",
    "Phát âm",
    "Luyện IELTS",
    "Luyện TOEIC",
    "Tiếng Anh thương mại",
    "Ngữ văn",
    "Lịch sử",
    "Khoa học",
    "Toán",
    "Kỹ năng thi",
    "Giao tiếp",
    # Geography topics
    "Bản đồ học",
    "Khí hậu",
    "Địa hình",
    "Tài nguyên thiên nhiên",
    "Dân số",
    "Đô thị hóa",
    "Di cư",
    "Toàn cầu hóa",
    "Môi trường",
    "Dân cư",
)

KNOWLEDGE_EN_TO_VI = {
    "Grammar": "Ngữ pháp",
    "Vocabulary": "Từ vựng",
    "Speaking": "Nói",
    "Listening": "Nghe",
    "Writing": "Viết",
    "Reading": "Đọc",
    "Pronunciation": "Phát âm",
    "IELTS Prep": "Luyện IELTS",
    "TOEIC Prep": "Luyện TOEIC",
    "Business English": "Tiếng Anh thương mại",
    "Literature": "Ngữ văn",
    "History": "Lịch sử",
    "Science": "Khoa học",
    "Math": "Toán",
    "Geography": "Địa lí",
    "Exam Skills": "Kỹ năng thi",
    "Communication": "Giao tiếp",
    "Cartography": "Bản đồ học",
    "Climate": "Khí hậu",
    "Terrain": "Địa hình",
    "Natural Resources": "Tài nguyên thiên nhiên",
    "Population": "Dân số",
    "Urbanization": "Đô thị hóa",
    "Migration": "Di cư",
    "Globalization": "Toàn cầu hóa",
    "Environment": "Môi trường",
}


class DetectSubjectResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    subject: str
    knowledges: list[str] = []
    confidence: float = 0.5
    source: str = "heuristic"


def _heuristic_subject(name: str, description: str) -> tuple[str, float]:
    text = f"{name} {description}".lower()
    # Prefer Geography early: title "Địa lý" + geo keywords. Do not map bare "văn hóa" → Literature.
    rules: list[tuple[str, float, re.Pattern[str]]] = [
        ("IELTS", 0.92, re.compile(r"\b(ielts|band\s?[56789])\b", re.I)),
        ("TOEIC", 0.92, re.compile(r"\btoeic\b", re.I)),
        ("IELTS", 0.86, re.compile(r"\b(toefl|luyện\s*thi\s*(?:anh|tiếng\s*anh))\b", re.I)),
        (
            "Geography",
            0.93,
            re.compile(
                r"(geography|địa\s*l[iíý]|địa\s*lý|trái\s*đất|bản\s*đồ|khí\s*hậu|địa\s*hình|"
                r"dân\s*cư|dân\s*số|đô\s*thị\s*hóa|di\s*cư|toàn\s*cầu\s*hóa|tài\s*nguyên|"
                r"không\s*gian|môi\s*trường)",
                re.I,
            ),
        ),
        (
            "Literature",
            0.88,
            re.compile(r"\b(literature|poetry|novel)\b|(ngữ\s*văn|văn\s*học|tiểu\s*thuyết|(?<!\w)thơ(?!\w))", re.I),
        ),
        (
            "History",
            0.88,
            re.compile(
                r"\b(history|historical|civilization|dynasty)\b|"
                r"(lịch\s*sử|lịch\s*chiến|chiến\s*tranh|chiến\s*dịch|"
                r"cách\s*mạng|triều\s*đại|thế\s*kỷ|kháng\s*chiến)",
                re.I,
            ),
        ),
        ("Physics", 0.9, re.compile(r"\b(physics)\b|(vật\s*l[iíý]|cơ\s*học|điện\s*học)", re.I)),
        ("Chemistry", 0.9, re.compile(r"\b(chemistry)\b|(hóa\s*học|hoá\s*học)", re.I)),
        ("Biology", 0.9, re.compile(r"\b(biology)\b|sinh\s*học", re.I)),
        (
            "CivicEducation",
            0.9,
            re.compile(r"(giáo\s*dục\s*kinh\s*tế|pháp\s*luật|gdkt&pl|kinh\s*tế\s*và\s*pháp\s*luật)", re.I),
        ),
        ("PhysicalEducation", 0.9, re.compile(r"\b(physical\s*education|\bpe\b)\b|(thể\s*chất|thể\s*dục|gdtc)", re.I)),
        ("NationalDefense", 0.9, re.compile(r"\b(national\s*defense)\b|(quốc\s*phòng|an\s*ninh|gdqp)", re.I)),
        (
            "ExperientialActivities",
            0.9,
            re.compile(r"\b(experiential)\b|(trải\s*nghiệm|hướng\s*nghiệp)", re.I),
        ),
        (
            "LocalEducation",
            0.9,
            re.compile(r"\b(local\s*education)\b|(giáo\s*dục\s*(?:của\s*)?địa\s*phương)", re.I),
        ),
        ("Technology", 0.88, re.compile(r"\b(technology)\b|(công\s*nghệ(?!\s*thông\s*tin))", re.I)),
        ("Informatics", 0.9, re.compile(r"\b(informatics|computer\s*science|programming)\b|(tin\s*học|lập\s*trình)", re.I)),
        ("Music", 0.9, re.compile(r"\b(music)\b|âm\s*nhạc", re.I)),
        ("FineArts", 0.9, re.compile(r"\b(fine\s*arts?)\b|(mĩ\s*thuật|mỹ\s*thuật|hội\s*họa)", re.I)),
        ("Science", 0.75, re.compile(r"\b(science)\b|(khoa\s*học(?:\s*tự\s*nhiên)?)", re.I)),
        ("Math", 0.88, re.compile(r"\b(math|algebra|geometry)\b|(toán(?:\s*học)?|đại\s*số|hình\s*học)", re.I)),
        ("Business", 0.85, re.compile(r"\b(business|marketing)\b|kinh\s*doanh", re.I)),
        (
            "English",
            0.82,
            re.compile(
                r"\b(english|foreign\s*language|grammar|vocabulary)\b|(ngoại\s*ngữ(?:\s*1)?|tiếng\s*anh|ngữ\s*pháp)",
                re.I,
            ),
        ),
    ]
    for label, conf, pattern in rules:
        if pattern.search(text):
            return label, conf
    return ("Other" if text.strip() else "English"), (0.35 if text.strip() else 0.2)


def _normalize_knowledge_label(raw: str) -> str | None:
    cleaned = (raw or "").strip(" .-•*\t\"'")
    if not cleaned:
        return None
    mapped = KNOWLEDGE_EN_TO_VI.get(cleaned) or KNOWLEDGE_EN_TO_VI.get(cleaned.title())
    if mapped:
        return mapped
    for label in KNOWLEDGE_LABELS:
        if cleaned.lower() == label.lower():
            return label
    # Allow short free-form topics from the model (Vietnamese/English).
    if 2 <= len(cleaned) <= 40 and not cleaned.lower().startswith("subject"):
        return cleaned
    return None


def _heuristic_knowledges(name: str, description: str, limit: int = 24) -> list[str]:
    text = f"{name} {description}"
    rules: list[tuple[str, int, re.Pattern[str]]] = [
        # Geography first (higher weight than generic reading/literature)
        ("Bản đồ học", 5, re.compile(r"bản\s*đồ(\s*học)?", re.I)),
        ("Khí hậu", 5, re.compile(r"khí\s*hậu|climate", re.I)),
        ("Địa hình", 5, re.compile(r"địa\s*hình|terrain|topograph", re.I)),
        ("Tài nguyên thiên nhiên", 5, re.compile(r"tài\s*nguyên(\s*thiên\s*nhiên)?|natural\s*resources?", re.I)),
        ("Dân số", 4, re.compile(r"dân\s*số|population", re.I)),
        ("Đô thị hóa", 5, re.compile(r"đô\s*thị\s*hóa|urbani[sz]ation", re.I)),
        ("Di cư", 4, re.compile(r"di\s*cư|migration", re.I)),
        ("Toàn cầu hóa", 5, re.compile(r"toàn\s*cầu\s*hóa|globali[sz]ation", re.I)),
        ("Môi trường", 4, re.compile(r"môi\s*trường|environment", re.I)),
        ("Dân cư", 4, re.compile(r"dân\s*cư", re.I)),
        ("Luyện IELTS", 5, re.compile(r"\b(ielts|band\s?[56789])\b", re.I)),
        ("Luyện TOEIC", 4, re.compile(r"\btoeic\b", re.I)),
        ("Ngữ pháp", 4, re.compile(r"\b(grammar|tense|conditionals?)\b|ngữ\s*pháp", re.I)),
        ("Từ vựng", 4, re.compile(r"\b(vocabulary|vocab)\b|từ\s*vựng", re.I)),
        ("Nói", 4, re.compile(r"\b(speaking|conversation)\b|(?<!\w)nói(?!\w)|hội\s*thoại|giao\s*tiếp", re.I)),
        ("Nghe", 4, re.compile(r"\b(listening)\b|(?<!\w)nghe(?!\w)", re.I)),
        ("Viết", 4, re.compile(r"\b(writing|essay)\b|(?<!\w)viết(?!\w)", re.I)),
        # Do not treat "đọc bản đồ" as English Reading
        ("Đọc", 4, re.compile(r"\b(reading|passage)\b|(đọc(?!\s*bản\s*đồ))", re.I)),
        ("Phát âm", 3, re.compile(r"\b(pronunciation)\b|phát\s*âm", re.I)),
        ("Tiếng Anh thương mại", 4, re.compile(r"\b(business|email|meeting|negotiation)\b|kinh\s*doanh", re.I)),
        # Explicit literature only — never bare "văn hóa"
        ("Ngữ văn", 3, re.compile(r"\b(literature|poetry|novel)\b|(ngữ\s*văn|văn\s*học|(?<!\w)thơ(?!\w))", re.I)),
        (
            "Lịch sử",
            3,
            re.compile(
                r"\b(history)\b|(lịch\s*sử|lịch\s*chiến|chiến\s*tranh|chiến\s*dịch|cách\s*mạng)",
                re.I,
            ),
        ),
        ("Khoa học", 3, re.compile(r"\b(science|physics|chemistry|biology)\b|(khoa\s*học|vật\s*lý|hóa\s*học|sinh\s*học)", re.I)),
        ("Toán", 3, re.compile(r"\b(math|algebra|geometry)\b|(toán|đại\s*số|hình\s*học)", re.I)),
        ("Kỹ năng thi", 3, re.compile(r"\b(exam|test\s*prep)\b|luyện\s*thi", re.I)),
        ("Giao tiếp", 2, re.compile(r"\b(communication|presentation)\b", re.I)),
    ]
    scored: list[tuple[str, int]] = []
    for label, weight, pattern in rules:
        if pattern.search(text):
            scored.append((label, weight))
    scored.sort(key=lambda x: x[1], reverse=True)
    out: list[str] = []
    for label, _ in scored:
        if label not in out:
            out.append(label)
        if len(out) >= limit:
            break
    if out:
        return out
    subject, _ = _heuristic_subject(name, description)
    defaults = {
        "IELTS": ["Luyện IELTS", "Viết", "Nói"],
        "TOEIC": ["Luyện TOEIC", "Nghe", "Đọc"],
        "English": ["Ngữ pháp", "Từ vựng", "Nói"],
        "Business": ["Tiếng Anh thương mại", "Giao tiếp"],
        "Literature": ["Ngữ văn", "Đọc"],
        "Geography": ["Bản đồ học", "Khí hậu", "Địa hình", "Tài nguyên thiên nhiên", "Đô thị hóa"],
    }
    return defaults.get(subject, [subject] if subject != "Other" else [])


def _parse_subject_label(raw: str) -> str | None:
    upper = (raw or "").strip()
    if not upper:
        return None
    lower = upper.lower()
    alias = SUBJECT_ALIASES.get(lower)
    if alias:
        return alias
    for label in SUBJECT_LABELS:
        if lower == label.lower():
            return label
    cleaned = re.sub(r"[^a-zA-Z]", " ", upper).strip()
    for token in cleaned.split():
        for label in SUBJECT_LABELS:
            if token.lower() == label.lower():
                return label
    for label in SUBJECT_LABELS:
        if re.search(rf"\b{re.escape(label)}\b", upper, re.I):
            return label
    # Longest Vietnamese alias match inside free text
    for alias, key in sorted(SUBJECT_ALIASES.items(), key=lambda x: len(x[0]), reverse=True):
        if alias in lower:
            return key
    return None


def _parse_knowledges(raw: str, limit: int = 24) -> list[str]:
    text = raw or ""
    found: list[str] = []

    # Prefer catalog matches (VI + EN aliases)
    for label in KNOWLEDGE_LABELS:
        if re.search(rf"\b{re.escape(label)}\b", text, re.I):
            if label not in found:
                found.append(label)
        if len(found) >= limit:
            return found
    for en, vi in KNOWLEDGE_EN_TO_VI.items():
        if re.search(rf"\b{re.escape(en)}\b", text, re.I):
            if vi not in found:
                found.append(vi)
        if len(found) >= limit:
            return found

    # Parse SUBJECT/KNOWLEDGES lines or comma lists; accept short free-form topics
    know_line = ""
    for line in text.splitlines():
        if re.match(r"^\s*KNOWLEDGES?\s*:", line, re.I):
            know_line = re.sub(r"^\s*KNOWLEDGES?\s*:\s*", "", line, flags=re.I)
            break
    source = know_line or text
    for part in re.split(r"[,;\n|/]+", source):
        label = _normalize_knowledge_label(part)
        if not label or label in found:
            continue
        # Skip subject line leftovers
        if label.lower().startswith("subject"):
            continue
        found.append(label)
        if len(found) >= limit:
            break
    return found


class GenerateQuizRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    classroom_id: str | None = Field(default=None, alias="classroomId")
    topic: str = ""
    cefr_level: str | None = Field(default=None, alias="cefrLevel")
    class_level: str | None = Field(default=None, alias="classLevel")
    count: int = Field(default=5, ge=1, le=20)
    style_prompt: str | None = Field(default=None, alias="stylePrompt")
    student_context: str | None = Field(default=None, alias="studentContext")


class QuizQuestionOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    type: str = "mcq"
    choices: list[str] | None = None
    answer: str


class GenerateQuizResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: str
    questions: list[QuizQuestionOut]
    source: str = "heuristic"


_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "with", "by",
    "from", "this", "that", "these", "those", "is", "are", "was", "were", "be", "been",
    "being", "as", "it", "its", "we", "you", "they", "their", "our", "my", "your",
    "will", "can", "should", "would", "could", "about", "into", "over", "under",
    "unit", "class", "classroom", "course", "lesson", "english", "quiz", "test",
    "covers", "cover", "practice", "practices", "students", "student", "learners",
    "learner", "emphasizes", "emphasise", "includes", "include", "themes", "theme",
    "handling", "dealing", "making", "asking", "ordering", "booking", "such",
    "real", "key", "main", "also", "using", "use", "used", "level", "intermediate",
    "beginner", "advanced", "practical", "situations", "situation", "information",
    "học", "lớp", "và", "của", "cho", "với", "các", "một", "này", "khi",
}


_CEFR_TITLE_RE = re.compile(r"\b(A1|A2|B1|B2|C1|C2)\b", re.I)
_CLASS_LEVEL_TITLE_RE = re.compile(
    r"\b(Lớp\s*(?:6|7|8|9|10|11|12)|Đại học|Khác)\b",
    re.I,
)


def _is_cefr_level(level: str) -> bool:
    return bool(re.fullmatch(r"A1|A2|B1|B2|C1|C2", (level or "").strip(), re.I))


def _resolve_quiz_level(body: GenerateQuizRequest) -> tuple[str, bool]:
    """Return (level_label, is_cefr). Prefer classLevel when CEFR omitted."""
    class_lvl = (body.class_level or "").strip()
    cefr = (body.cefr_level or "").strip()
    if class_lvl and not cefr:
        return class_lvl, False
    if cefr:
        return cefr, _is_cefr_level(cefr)
    if class_lvl:
        return class_lvl, False
    return "B1", True


def _with_level_title(title: str, level: str, *, is_cefr: bool = True) -> str:
    """Ensure quiz titles include the selected level (CEFR or Vietnamese class grade)."""
    lvl = (level or ("B1" if is_cefr else "Lớp 10")).strip() or ("B1" if is_cefr else "Lớp 10")
    t = (title or "").strip() or "AI Quiz"
    if re.search(rf"(?:·\s*)?{re.escape(lvl)}", t, re.I):
        return t
    if is_cefr and _CEFR_TITLE_RE.search(t):
        return _CEFR_TITLE_RE.sub(lvl, t, count=1)
    if not is_cefr and _CLASS_LEVEL_TITLE_RE.search(t):
        return _CLASS_LEVEL_TITLE_RE.sub(lvl, t, count=1)
    if is_cefr and re.search(r"\bQuiz\b", t, re.I):
        return re.sub(r"\bQuiz\b", f"{lvl} Quiz", t, count=1, flags=re.I)
    return f"{t} · {lvl}"


def _with_cefr_title(title: str, level: str) -> str:
    """Back-compat wrapper — CEFR titles keep the '· B1 Quiz' style when swapping Quiz."""
    lvl = (level or "B1").strip() or "B1"
    t = (title or "").strip() or "AI Quiz"
    if re.search(rf"(?:·\s*)?\b{re.escape(lvl)}\b", t, re.I):
        return t
    if _CEFR_TITLE_RE.search(t):
        return _CEFR_TITLE_RE.sub(lvl, t, count=1)
    if re.search(r"\bQuiz\b", t, re.I):
        return re.sub(r"\bQuiz\b", f"{lvl} Quiz", t, count=1, flags=re.I)
    return f"{t} · {lvl} Quiz"


def _split_topic_context(topic: str) -> tuple[str, str]:
    """Split classroom topic blob into short title + description (context only)."""
    lines = [ln.strip() for ln in (topic or "").splitlines() if ln.strip()]
    if not lines:
        return "English", ""
    title = lines[0][:100]
    desc = " ".join(lines[1:]).strip() if len(lines) > 1 else ""
    # If single long line, treat first clause as title and rest as description.
    if not desc and len(title) > 60:
        parts = re.split(r"[.:;\n]\s+", topic.strip(), maxsplit=1)
        if len(parts) == 2 and parts[1].strip():
            return parts[0].strip()[:100], parts[1].strip()
    return title, desc


def _topic_keywords(topic: str, limit: int = 8) -> list[str]:
    """Extract short topic keywords from title/description — never use full dump as a question."""
    title, desc = _split_topic_context(topic)
    # Prefer title tokens first (stronger topic signal), then description.
    ordered = re.findall(r"[A-Za-zÀ-ỹ]{3,}", title) + re.findall(r"[A-Za-zÀ-ỹ]{3,}", desc)
    seen: set[str] = set()
    out: list[str] = []
    for tok in ordered:
        key = tok.lower()
        if key in _STOPWORDS or key in seen or re.fullmatch(r"a[12]|b[12]|c[12]", key):
            continue
        seen.add(key)
        out.append(tok if tok[0].isupper() else tok.lower())
        if len(out) >= limit:
            break
    if not out:
        subj, _ = _heuristic_subject(title, desc)
        if subj == "History":
            out = ["lịch sử", "chiến tranh", "sự kiện"]
        elif subj == "Math":
            out = ["toán", "tính toán", "bài tập"]
        elif subj == "Science":
            out = ["khoa học", "thí nghiệm", "khái niệm"]
        elif subj == "Literature":
            out = ["văn học", "tác phẩm", "nhân vật"]
        elif subj in ("English", "IELTS", "TOEIC"):
            out = ["everyday English", "vocabulary", "grammar"]
        else:
            out = [subj.lower() if subj != "Other" else "chủ đề"]
    return out


def _prompt_leaks_context(prompt: str, topic: str) -> bool:
    """True if the question stem pasted classroom title/description instead of an exam item."""
    p = (prompt or "").strip().lower()
    if not p:
        return True
    title, desc = _split_topic_context(topic)
    title_l = title.lower().strip()
    desc_l = re.sub(r"\s+", " ", desc.lower()).strip()
    if title_l and len(title_l) >= 12 and title_l in p:
        return True
    if desc_l and len(desc_l) >= 40:
        # Long shared prefix / substring ⇒ model dumped description into the stem.
        chunk = desc_l[:80]
        if chunk in p:
            return True
        # High overlap of description words in a long prompt.
        desc_words = {w for w in re.findall(r"[a-zà-ỹ]{4,}", desc_l) if w not in _STOPWORDS}
        prompt_words = set(re.findall(r"[a-zà-ỹ]{4,}", p))
        if desc_words and len(desc_words & prompt_words) >= max(4, int(len(desc_words) * 0.45)):
            return True
    # Reject meta prompts that ask about the classroom itself.
    if re.search(r"\b(this classroom|class description|classroom title|mô tả lớp)\b", p):
        return True
    return False


def _normalize_mcq_choices(raw: list[str] | None, *, lang: str = "en") -> list[str] | None:
    if not raw:
        return None
    choices = [re.sub(r"^[A-Da-d][\)\.\:\-]\s*", "", str(x)).strip() for x in raw]
    choices = [c for c in choices if c]
    if len(choices) < 2:
        return None
    # Prefer exactly 4 options for exam MCQs; pad/truncate lightly when close.
    pad_prefix = "Phương án" if lang.startswith("vi") else "Option"
    while len(choices) < 4:
        choices.append(f"{pad_prefix} {chr(65 + len(choices))}")
    return choices[:4]


_VI_DIACRITIC_RE = re.compile(
    r"[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợ"
    r"ùúủũụưứừửữựỳýỷỹỵđ"
    r"ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢ"
    r"ÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]"
)
_VI_WORD_RE = re.compile(
    r"\b(và|của|các|một|những|trong|với|cho|là|học|lớp|bài|chương|"
    r"lịch|sử|chiến|toán|văn|khoa|thế|kỷ|cách|mạng|kháng|triều|"
    r"đại|sinh|hóa|vật|lý|hình|đại\s*số)\b",
    re.I,
)
_ESL_META_RE = re.compile(
    r"(learner mainly practice|using the language in real|"
    r"practice when studying|natural collocation|"
    r"memorizing random numbers|ignoring meaning and context|"
    r"writing only in another subject|get better|make progress with|"
    r"could you explain .+ again|"
    r"how long have you been learning|"
    r"polite request suitable|"
    r"luyện\s*tập\s*ngôn\s*ngữ|học\s*viên\s*chủ\s*yếu\s*luyện|"
    r"using the language|CEFR\b)",
    re.I,
)


def _is_english_learning_subject(subject: str) -> bool:
    return (subject or "").strip() in ("English", "IELTS", "TOEIC")


def _detect_quiz_subject(topic: str) -> str:
    title, desc = _split_topic_context(topic)
    subject, _ = _heuristic_subject(title, desc)
    return subject


def _detect_quiz_language(topic: str, *, subject: str, is_cefr: bool) -> str:
    """Vietnamese for primarily-Vietnamese non-English classrooms; English for ESL/IELTS."""
    if is_cefr or _is_english_learning_subject(subject):
        return "en"
    text = topic or ""
    vi_chars = len(_VI_DIACRITIC_RE.findall(text))
    vi_words = len(_VI_WORD_RE.findall(text))
    letters = re.findall(r"[A-Za-zÀ-ỹĐđ]", text)
    if vi_chars >= 2 or vi_words >= 2:
        return "vi"
    if not letters:
        return "vi"
    # Class-level (non-CEFR) Vietnamese curriculum default when mixed/ambiguous.
    if not is_cefr and vi_chars + vi_words >= 1:
        return "vi"
    if not is_cefr and subject not in ("English", "IELTS", "TOEIC", "Business"):
        # School subjects without clear English signal → Vietnamese stems.
        return "vi"
    return "en"


def _looks_like_esl_meta(prompt: str, choices: list[str] | None = None) -> bool:
    blob = (prompt or "") + " " + " ".join(choices or [])
    return bool(_ESL_META_RE.search(blob))


def _clean_focus_phrase(raw: str, fallback: str) -> str:
    """Keep topic fragments short and readable inside exam stems."""
    text = re.sub(r"\s+", " ", (raw or "").strip())
    text = re.sub(r"[^\w\sÀ-ỹ'/-]", "", text, flags=re.UNICODE).strip()
    if len(text) < 2 or text.lower() in _STOPWORDS:
        return fallback
    return text[:48]


def _english_esl_banks(level: str, focus: str, secondary: str) -> list[tuple[str, list[str], str]]:
    focus = _clean_focus_phrase(focus, "everyday English")
    secondary = _clean_focus_phrase(secondary, "communication")
    return [
        (
            f"Choose the best {level} word to complete: \"I need more _____ about {focus}.\"",
            ["information", "informations", "informate", "informing"],
            "A",
        ),
        (
            f"Which sentence is correct at {level} level?",
            [
                f"She has studied {focus} for two years.",
                f"She have studied {focus} for two years.",
                f"She studying {focus} for two years.",
                f"She studied {focus} since two years.",
            ],
            "A",
        ),
        (
            "Pick the most natural collocation:",
            [
                "make progress",
                "do progress",
                "build progress",
                "take progress",
            ],
            "A",
        ),
        (
            f"Which option best completes the dialogue?\nA: \"Could you explain {focus} again?\"\nB: \"_____.\"",
            [
                "Sure, let me give you an example.",
                "No, because English is finished.",
                "Please calculate the answer first.",
                "I only speak about mathematics.",
            ],
            "A",
        ),
        (
            f"Choose the correct question form ({level}):",
            [
                f"How long have you been learning about {focus}?",
                f"How long you have been learning about {focus}?",
                f"How long are you learn about {focus}?",
                f"How long did you been learning about {focus}?",
            ],
            "A",
        ),
        (
            'Which word is closest in meaning to "improve"?',
            ["get better", "get worse", "stay the same", "give up"],
            "A",
        ),
        (
            f"Select the polite request suitable for a {level} classroom:",
            [
                "Could you help me with this exercise, please?",
                "Give me the answer now!",
                "You must tell me everything immediately.",
                "I don't care about the lesson.",
            ],
            "A",
        ),
        (
            'Choose the correct article: "She is _____ honest student."',
            ["an", "a", "the", "— (no article)"],
            "A",
        ),
        (
            f"Choose the best synonym for \"essential\" in a lesson about {secondary}:",
            ["necessary", "optional", "rare", "silent"],
            "A",
        ),
        (
            "Which sentence uses the present perfect correctly?",
            [
                "I have already finished my homework.",
                "I have already finish my homework.",
                "I already finishing my homework.",
                "I am already finished my homework yesterday.",
            ],
            "A",
        ),
        (
            f"At {level}, which reply is the most natural?\nA: \"Thanks for your help.\"\nB: \"_____.\"",
            [
                "You're welcome.",
                "You are welcome very much yes.",
                "No problem forever always.",
                "I am thanking you back.",
            ],
            "A",
        ),
        (
            'Complete: "If it rains tomorrow, we _____ stay indoors."',
            ["will", "would", "are", "have"],
            "A",
        ),
    ]


def _history_quiz_banks(
    lang: str,
    level: str,
    topic: str = "",
) -> list[tuple[str, list[str], str]]:
    """Enriched History banks; prefer WWI / WWII / VN topical items when keywords match."""
    vi = lang.startswith("vi")
    blob = (topic or "").lower()
    ww1 = bool(
        re.search(
            r"thế\s*giới\s*thứ\s*nhất|world\s*war\s*i\b|wwi\b|1914|1918|"
            r"chiến\s*tranh\s*thế\s*giới\s*1",
            blob,
            re.I,
        )
    )
    ww2 = bool(
        re.search(
            r"thế\s*giới\s*thứ\s*hai|world\s*war\s*ii\b|wwii\b|1939|1945|"
            r"chiến\s*tranh\s*thế\s*giới\s*2",
            blob,
            re.I,
        )
    )

    if vi:
        core = [
            (
                "Chiến thắng Điện Biên Phủ (1954) diễn ra trong cuộc kháng chiến chống thực dân nào?",
                ["Thực dân Pháp", "Đế quốc Nhật", "Thực dân Tây Ban Nha", "Đế quốc Ottoman"],
                "A",
            ),
            (
                "Sự kiện nào gắn với ngày 2/9/1945 ở Việt Nam?",
                [
                    "Tuyên ngôn Độc lập tại Quảng trường Ba Đình",
                    "Ký Hiệp định Genève",
                    "Thành lập ASEAN",
                    "Mở cửa Đổi mới",
                ],
                "A",
            ),
            (
                "Nguyên nhân sâu xa nào thường dẫn đến xung đột vũ trang giữa các quốc gia?",
                [
                    "Mâu thuẫn lợi ích chính trị – kinh tế – lãnh thổ",
                    "Việc học ngoại ngữ kém",
                    "Thiếu bài tập ngữ pháp",
                    "Không có sách giáo khoa tiếng Anh",
                ],
                "A",
            ),
            (
                "Trong lịch sử chiến tranh, hậu phương có vai trò chủ yếu nào?",
                [
                    "Cung cấp nhân lực, lương thực và chỗ dựa tinh thần cho tiền tuyến",
                    "Chỉ tổ chức thi nói tiếng Anh",
                    "Thay thế hoàn toàn lực lượng chiến đấu",
                    "Loại bỏ mọi hoạt động sản xuất",
                ],
                "A",
            ),
            (
                "Hiệp định Genève (1954) liên quan trực tiếp đến vấn đề nào của Việt Nam?",
                [
                    "Chấm dứt chiến tranh ở Đông Dương và tạm thời chia cắt đất nước",
                    "Gia nhập Liên minh châu Âu",
                    "Áp dụng CEFR cho giáo dục",
                    "Thành lập Liên Hợp Quốc",
                ],
                "A",
            ),
            (
                f"Khi học lịch sử ở trình độ {level}, kỹ năng nào là quan trọng nhất?",
                [
                    "Phân tích nguyên nhân – diễn biến – kết quả của sự kiện",
                    "Luyện phát âm tiếng Anh",
                    "Viết email thương mại",
                    "Học thuộc bảng chữ cái Latin",
                ],
                "A",
            ),
            (
                "Yếu tố nào giúp đánh giá tính xác thực của một nguồn sử liệu?",
                [
                    "Nguồn gốc, thời điểm và mục đích ra đời của tài liệu",
                    "Độ dài của đoạn văn tiếng Anh",
                    "Số lượng tính từ trong câu",
                    "Việc có hay không có collocation",
                ],
                "A",
            ),
            (
                "Kháng chiến chống Mỹ cứu nước của nhân dân Việt Nam nhằm mục tiêu chính nào?",
                [
                    "Bảo vệ độc lập, thống nhất đất nước",
                    "Mở rộng thuộc địa hải ngoại",
                    "Thay thế chương trình IELTS",
                    "Bãi bỏ môn Toán ở phổ thông",
                ],
                "A",
            ),
            (
                "Cách mạng tháng Tám 1945 ở Việt Nam dẫn đến kết quả chủ yếu nào?",
                [
                    "Lật đổ chính quyền thuộc địa – phong kiến, giành chính quyền về tay nhân dân",
                    "Thành lập Liên minh châu Âu",
                    "Bắt đầu Đổi mới kinh tế 1986",
                    "Ký Hiệp định Paris 1973",
                ],
                "A",
            ),
            (
                "Đổi mới (1986) ở Việt Nam chủ yếu là sự chuyển đổi về lĩnh vực nào?",
                [
                    "Kinh tế – xã hội theo hướng mở cửa, hội nhập",
                    "Thay thế hoàn toàn chương trình lịch sử phổ thông",
                    "Gia nhập khối quân sự NATO",
                    "Bãi bỏ chữ Quốc ngữ",
                ],
                "A",
            ),
        ]
        ww1_bank = [
            (
                "Chiến tranh thế giới thứ nhất bùng nổ vào năm nào?",
                ["1914", "1939", "1945", "1858"],
                "A",
            ),
            (
                "Nguyên nhân trực tiếp thường được nêu khi nói về sự bùng nổ Chiến tranh thế giới thứ nhất là:",
                [
                    "Vụ ám sát Thái tử Áo-Hung Franz Ferdinand tại Sarajevo",
                    "Trận Trân Châu Cảng",
                    "Cách mạng tháng Mười Nga 1917 chưa xảy ra",
                    "Hiệp định Versailles đã được ký trước đó",
                ],
                "A",
            ),
            (
                "Phe Liên minh (Central Powers) trong Chiến tranh thế giới thứ nhất gồm chủ yếu:",
                [
                    "Đức, Áo-Hung (và đồng minh)",
                    "Anh, Pháp, Nga",
                    "Mỹ, Nhật, Trung Quốc",
                    "Chỉ có Ý và Bồ Đào Nha",
                ],
                "A",
            ),
            (
                "Chiến tranh thế giới thứ nhất kết thúc vào năm nào?",
                ["1918", "1914", "1939", "1941"],
                "A",
            ),
            (
                "Hiệp ước Versailles (1919) chủ yếu nhằm:",
                [
                    "Giải quyết hậu quả chiến tranh và áp đặt điều khoản với Đức",
                    "Thành lập ASEAN",
                    "Chia cắt Việt Nam tạm thời",
                    "Kết thúc Chiến tranh thế giới thứ hai",
                ],
                "A",
            ),
            (
                "Đặc điểm nổi bật của chiến tranh thế giới thứ nhất là:",
                [
                    "Chiến tranh tổng lực, quy mô toàn cầu, tổn thất nhân mạng rất lớn",
                    "Chỉ diễn ra trên lãnh thổ Việt Nam",
                    "Không sử dụng vũ khí hiện đại",
                    "Kết thúc trong chưa đầy một tháng",
                ],
                "A",
            ),
        ]
        ww2_bank = [
            (
                "Chiến tranh thế giới thứ hai bùng nổ vào năm nào?",
                ["1939", "1914", "1945", "1954"],
                "A",
            ),
            (
                "Sự kiện nào thường được xem là mốc kết thúc Chiến tranh thế giới thứ hai tại châu Âu?",
                [
                    "Đức phát xít đầu hàng (1945)",
                    "Ký Hiệp định Genève 1954",
                    "Cách mạng tháng Tám 1945 ở Việt Nam",
                    "Thành lập Liên Hợp Quốc ngay năm 1919",
                ],
                "A",
            ),
            (
                "Phe Đồng minh trong Chiến tranh thế giới thứ hai gồm chủ yếu:",
                [
                    "Liên Xô, Mỹ, Anh (và nhiều nước khác)",
                    "Chỉ có Đức và Ý",
                    "Chỉ có Nhật Bản",
                    "Áo-Hung và Ottoman",
                ],
                "A",
            ),
            (
                "Phát xít Nhật đầu hàng vào tháng 8/1945 tạo điều kiện thuận lợi cho sự kiện nào ở Việt Nam?",
                [
                    "Tổng khởi nghĩa giành chính quyền (Cách mạng tháng Tám)",
                    "Ký Hiệp định Paris về kết thúc chiến tranh Việt Nam",
                    "Mở cửa Đổi mới",
                    "Gia nhập WTO",
                ],
                "A",
            ),
        ]
    else:
        core = [
            (
                "The 1954 Dien Bien Phu victory was fought mainly against which colonial power?",
                ["France", "Spain", "Portugal", "Ottoman Empire"],
                "A",
            ),
            (
                "Which event is linked to 2 September 1945 in Vietnam?",
                [
                    "Declaration of Independence at Ba Dinh Square",
                    "Signing of the ASEAN charter",
                    "Opening of Doi Moi reforms",
                    "Founding of the United Nations",
                ],
                "A",
            ),
            (
                "A deep cause of armed conflict between states is usually:",
                [
                    "Political, economic, and territorial interest clashes",
                    "Poor English pronunciation",
                    "Missing grammar drills",
                    "Lack of IELTS practice tests",
                ],
                "A",
            ),
            (
                "In wartime history, the rear area (home front) mainly provides:",
                [
                    "Manpower, supplies, and moral support for the front",
                    "Only English speaking contests",
                    "A complete replacement for combat forces",
                    "An end to all production",
                ],
                "A",
            ),
            (
                "The 1954 Geneva Accords most directly concerned:",
                [
                    "Ending the Indochina war and temporarily dividing Vietnam",
                    "Joining the European Union",
                    "Adopting CEFR for schools",
                    "Creating the United Nations",
                ],
                "A",
            ),
            (
                f"At {level} history study, the most important skill is:",
                [
                    "Analyzing causes, developments, and results of events",
                    "Practicing English articles",
                    "Writing business emails",
                    "Memorizing Latin alphabet order",
                ],
                "A",
            ),
            (
                "To judge a historical source's reliability, check mainly:",
                [
                    "Origin, date, and purpose of the document",
                    "Length of English paragraphs",
                    "Number of adjectives",
                    "Presence of collocations",
                ],
                "A",
            ),
            (
                "Vietnam's resistance war against the US aimed primarily to:",
                [
                    "Defend independence and national reunification",
                    "Expand overseas colonies",
                    "Replace IELTS curricula",
                    "Abolish Mathematics in schools",
                ],
                "A",
            ),
            (
                "The August Revolution of 1945 in Vietnam mainly resulted in:",
                [
                    "Seizing power from colonial-feudal authorities",
                    "Joining the European Union",
                    "Starting Doi Moi in 1986",
                    "Signing the 1973 Paris Peace Accords",
                ],
                "A",
            ),
            (
                "Vietnam's Doi Moi (1986) was primarily a shift in:",
                [
                    "Economic and social policy toward openness and integration",
                    "Replacing the entire history curriculum",
                    "Joining NATO",
                    "Abolishing the Vietnamese alphabet",
                ],
                "A",
            ),
        ]
        ww1_bank = [
            (
                "In which year did World War I begin?",
                ["1914", "1939", "1945", "1858"],
                "A",
            ),
            (
                "The immediate spark often cited for World War I was:",
                [
                    "The assassination of Archduke Franz Ferdinand in Sarajevo",
                    "The attack on Pearl Harbor",
                    "The Russian October Revolution of 1917",
                    "The signing of the Treaty of Versailles beforehand",
                ],
                "A",
            ),
            (
                "The Central Powers in World War I mainly included:",
                [
                    "Germany and Austria-Hungary (and allies)",
                    "Britain, France, and Russia",
                    "The US, Japan, and China",
                    "Only Italy and Portugal",
                ],
                "A",
            ),
            (
                "World War I ended in which year?",
                ["1918", "1914", "1939", "1941"],
                "A",
            ),
            (
                "The Treaty of Versailles (1919) mainly aimed to:",
                [
                    "Settle the war's aftermath and impose terms on Germany",
                    "Found ASEAN",
                    "Temporarily divide Vietnam",
                    "End World War II",
                ],
                "A",
            ),
            (
                "A defining feature of World War I was:",
                [
                    "Total war on a global scale with massive casualties",
                    "Fighting only inside Vietnam",
                    "No modern weapons",
                    "Ending within one month",
                ],
                "A",
            ),
        ]
        ww2_bank = [
            (
                "In which year did World War II begin in Europe?",
                ["1939", "1914", "1945", "1954"],
                "A",
            ),
            (
                "Which event marks the end of World War II in Europe?",
                [
                    "Nazi Germany's surrender (1945)",
                    "The 1954 Geneva Accords",
                    "Vietnam's August Revolution",
                    "The founding of the UN in 1919",
                ],
                "A",
            ),
            (
                "The Allies in World War II mainly included:",
                [
                    "The Soviet Union, the United States, and Britain (among others)",
                    "Only Germany and Italy",
                    "Only Japan",
                    "Austria-Hungary and the Ottomans",
                ],
                "A",
            ),
            (
                "Japan's surrender in August 1945 created conditions for which event in Vietnam?",
                [
                    "The August Revolution and seizure of power",
                    "The Paris Peace Accords ending the Vietnam War",
                    "The start of Doi Moi",
                    "Joining the WTO",
                ],
                "A",
            ),
        ]

    if ww1:
        return ww1_bank + core
    if ww2:
        return ww2_bank + core
    # General history: mix in a few world-war items for variety.
    return core + ww1_bank[:2] + ww2_bank[:2]


def _subject_quiz_banks(
    subject: str,
    lang: str,
    level: str,
    focus: str,
    topic: str = "",
) -> list[tuple[str, list[str], str]]:
    """Subject-faithful MCQ banks. Never ESL meta for History/Math/etc."""
    vi = lang.startswith("vi")
    sub = (subject or "Other").strip() or "Other"

    if sub == "History":
        return _history_quiz_banks(lang, level, topic=topic)

    if sub == "Math":
        if vi:
            return [
                ("Kết quả của 15 × 4 là bao nhiêu?", ["60", "45", "19", "56"], "A"),
                ("Phân số nào bằng 1/2?", ["2/4", "1/3", "3/5", "2/5"], "A"),
                ("Nghiệm của phương trình x + 7 = 12 là:", ["5", "19", "-5", "7"], "A"),
                ("Diện tích hình chữ nhật dài 8, rộng 3 bằng:", ["24", "11", "5", "32"], "A"),
                ("Số nào là số nguyên tố?", ["7", "9", "15", "21"], "A"),
                (f"Ở mức {level}, bước đầu giải bài toán thường là:", ["Xác định giả thiết và yêu cầu", "Viết đoạn văn tiếng Anh", "Học thuộc bài thơ", "Vẽ bản đồ lịch sử"], "A"),
                ("Giá trị của 3² là:", ["9", "6", "8", "5"], "A"),
                ("Tỉ lệ 2:4 rút gọn thành:", ["1:2", "2:1", "4:2", "1:4"], "A"),
            ]
        return [
            ("What is 15 × 4?", ["60", "45", "19", "56"], "A"),
            ("Which fraction equals 1/2?", ["2/4", "1/3", "3/5", "2/5"], "A"),
            ("Solve: x + 7 = 12", ["5", "19", "-5", "7"], "A"),
            ("Area of a 8×3 rectangle is:", ["24", "11", "5", "32"], "A"),
            ("Which number is prime?", ["7", "9", "15", "21"], "A"),
            (f"At {level}, the first step in problem solving is usually:", ["Identify given data and the question", "Write an English paragraph", "Memorize a poem", "Draw a war map"], "A"),
            ("3² equals:", ["9", "6", "8", "5"], "A"),
            ("Simplify the ratio 2:4", ["1:2", "2:1", "4:2", "1:4"], "A"),
        ]

    if sub == "Science":
        if vi:
            return [
                ("Khí nào chiếm tỉ lệ lớn nhất trong không khí?", ["Nitơ", "Oxi", "Carbon dioxide", "Hydro"], "A"),
                ("Đơn vị đo lực trong hệ SI là:", ["Newton", "Joule", "Watt", "Pascal"], "A"),
                ("Quá trình quang hợp ở thực vật chủ yếu xảy ra ở:", ["Lá", "Rễ", "Hạt", "Hoa"], "A"),
                ("Nước có công thức hóa học:", ["H₂O", "CO₂", "O₂", "NaCl"], "A"),
                ("Trái Đất quay quanh:", ["Mặt Trời", "Mặt Trăng", "Sao Hỏa", "Sao Kim"], "A"),
                (f"Khi học Khoa học ở {level}, bước quan trọng là:", ["Quan sát – đặt giả thuyết – kiểm chứng", "Luyện collocation tiếng Anh", "Viết email xin việc", "Học thuộc năm kháng chiến"], "A"),
                ("Trạng thái nào của nước có hình dạng và thể tích xác định?", ["Rắn", "Lỏng", "Khí", "Plasma trong phòng thí nghiệm phổ thông"], "A"),
                ("Vitamin nào thường liên quan đến ánh sáng mặt trời?", ["Vitamin D", "Vitamin C", "Vitamin B12", "Vitamin K"], "A"),
            ]
        return [
            ("Which gas is most abundant in air?", ["Nitrogen", "Oxygen", "Carbon dioxide", "Hydrogen"], "A"),
            ("SI unit of force is:", ["Newton", "Joule", "Watt", "Pascal"], "A"),
            ("Photosynthesis in plants mainly occurs in the:", ["Leaves", "Roots", "Seeds", "Flowers"], "A"),
            ("Chemical formula of water is:", ["H₂O", "CO₂", "O₂", "NaCl"], "A"),
            ("Earth orbits the:", ["Sun", "Moon", "Mars", "Venus"], "A"),
            (f"In {level} science, a key method is:", ["Observe → hypothesize → test", "Drill English collocations", "Write a job email", "Memorize war years only"], "A"),
            ("Which state of water has fixed shape and volume?", ["Solid", "Liquid", "Gas", "Everyday classroom plasma"], "A"),
            ("Which vitamin is commonly linked to sunlight?", ["Vitamin D", "Vitamin C", "Vitamin B12", "Vitamin K"], "A"),
        ]

    if sub == "Literature":
        if vi:
            return [
                ("Thể loại nào thường dùng vần và nhịp?", ["Thơ", "Biên bản", "Bảng thống kê", "Hóa đơn"], "A"),
                ("Nhân vật trong tác phẩm văn học là:", ["Người hoặc hình tượng được xây dựng trong tác phẩm", "Một công thức toán", "Một đơn vị đo lực", "Một năm lịch sử"], "A"),
                ("Tìm hiểu hoàn cảnh sáng tác giúp gì?", ["Hiểu sâu hơn nội dung và tư tưởng tác phẩm", "Luyện phát âm IPA", "Tính diện tích hình học", "Đo pH dung dịch"], "A"),
                ("Hình ảnh so sánh trong văn học dùng để:", ["Làm nổi bật đặc điểm đối tượng", "Giải phương trình bậc nhất", "Ghi năm chiến dịch", "Đếm electron"], "A"),
                (f"Khi đọc hiểu văn bản ở {level}, cần chú ý:", ["Ý chính, chi tiết và biện pháp nghệ thuật", "Collocation tiếng Anh giao tiếp", "Bảng tuần hoàn", "Bản đồ chiến trường"], "A"),
                ("Kết cấu của một bài văn nghị luận thường có:", ["Mở bài – thân bài – kết bài", "Chỉ có phần đáp án A–D", "Chỉ bảng số liệu", "Chỉ danh sách động từ bất quy tắc"], "A"),
                ("Chủ đề của tác phẩm văn học là:", ["Vấn đề tư tưởng – nội dung then chốt được nêu lên", "Độ khó IELTS", "Công thức hóa học", "Tỉ số vàng"], "A"),
                ("Giọng điệu của người kể chuyện ảnh hưởng đến:", ["Cách người đọc cảm nhận tác phẩm", "Khối lượng riêng của kim loại", "Tọa độ điểm trên mặt phẳng", "Áp suất khí quyển"], "A"),
            ]
        return [
            ("Which genre typically uses rhyme and rhythm?", ["Poetry", "Minutes of a meeting", "Statistical tables", "Invoices"], "A"),
            ("A literary character is:", ["A person or figure constructed in the work", "A math formula", "A force unit", "A historical year"], "A"),
            ("Knowing the creation context helps readers:", ["Understand themes and ideas more deeply", "Practice IPA sounds", "Compute area", "Measure pH"], "A"),
            ("A simile or comparison image is used to:", ["Highlight traits of the subject", "Solve linear equations", "Date a military campaign", "Count electrons"], "A"),
            (f"When reading literature at {level}, focus on:", ["Main idea, details, and artistic devices", "Business English collocations", "The periodic table", "Battlefield maps only"], "A"),
            ("A typical argumentative essay structure is:", ["Introduction – body – conclusion", "Only A–D answer keys", "Only numeric tables", "Only irregular verb lists"], "A"),
            ("The theme of a literary work is:", ["Its central idea or issue", "An IELTS band target", "A chemical formula", "The golden ratio"], "A"),
            ("Narrative tone mainly affects:", ["How readers feel about the work", "Metal density", "Point coordinates", "Air pressure"], "A"),
        ]

    # Other / Business / unknown school topics — still subject-content, not ESL meta.
    if vi:
        return [
            (
                f"Khái niệm cốt lõi nào liên quan trực tiếp đến chủ đề «{focus}»?",
                [
                    f"Kiến thức nền tảng về {focus}",
                    "Cách chia động từ tiếng Anh",
                    "Bảng chữ cái IPA",
                    "Email xin việc bằng tiếng Anh",
                ],
                "A",
            ),
            (
                f"Khi ôn tập {focus} ở mức {level}, học sinh nên ưu tiên:",
                [
                    "Hiểu bản chất và áp dụng vào ví dụ cụ thể",
                    "Chỉ học thuộc collocation tiếng Anh",
                    "Bỏ qua lý thuyết, chỉ đoán đáp án ngẫu nhiên",
                    "Luyện phát âm Anh – Mỹ",
                ],
                "A",
            ),
            (
                f"Câu nào mô tả đúng cách tiếp cận môn học về {focus}?",
                [
                    "Phân tích khái niệm, ví dụ và mối liên hệ thực tiễn",
                    "Chỉ luyện hội thoại chào hỏi tiếng Anh",
                    "Chỉ học thuộc thì hiện tại đơn",
                    "Bỏ nội dung môn để học writing IELTS",
                ],
                "A",
            ),
            (
                f"Đâu là mục tiêu kiểm tra hợp lý với {focus}?",
                [
                    "Đánh giá hiểu biết và suy luận về nội dung môn học",
                    "Đánh giá khả năng đặt bài speaking Part 1",
                    "Đếm số lỗi mạo từ a/an/the",
                    "Chấm điểm phát âm /θ/",
                ],
                "A",
            ),
            (
                f"Nguồn học nào phù hợp nhất cho {focus}?",
                [
                    "Sách giáo khoa / tài liệu chuyên môn của môn",
                    "Danh sách động từ bất quy tắc",
                    "Bảng phiên âm IPA",
                    "Đề thi TOEIC listening",
                ],
                "A",
            ),
            (
                f"Khi làm bài trắc nghiệm về {focus}, bước hợp lý là:",
                [
                    "Đọc kỹ đề, loại đáp án sai, chọn phương án đúng nhất",
                    "Dịch toàn bộ sang tiếng Anh rồi trả lời",
                    "Chỉ nhìn độ dài của lựa chọn",
                    "Chọn đáp án có từ \"language\"",
                ],
                "A",
            ),
            (
                f"Yếu tố nào KHÔNG phải trọng tâm của môn liên quan {focus}?",
                [
                    "Luyện kỹ năng giao tiếp tiếng Anh hàng ngày",
                    "Nắm vững kiến thức chuyên môn của môn",
                    "Rèn tư duy phân tích theo chương trình",
                    "Áp dụng kiến thức vào tình huống liên quan",
                ],
                "A",
            ),
            (
                f"Phát biểu nào đúng về việc học {focus}?",
                [
                    "Cần kết hợp ghi nhớ kiến thức với phân tích ví dụ",
                    "Chỉ cần học thuộc mẫu câu \"How are you?\"",
                    "Chỉ cần biết cách dùng present perfect",
                    "Không cần hiểu khái niệm, chỉ cần dịch sang tiếng Anh",
                ],
                "A",
            ),
        ]
    return [
        (
            f"Which idea is most central to studying {focus}?",
            [
                f"Core concepts and facts about {focus}",
                "English verb conjugation drills",
                "IPA pronunciation charts",
                "Writing a cover letter in English",
            ],
            "A",
        ),
        (
            f"At {level}, the best way to revise {focus} is to:",
            [
                "Understand key ideas and apply them to examples",
                "Only memorize English collocations",
                "Guess randomly without reading stems",
                "Practice American English accents",
            ],
            "A",
        ),
        (
            f"A sound approach to {focus} is:",
            [
                "Analyze concepts, examples, and real links",
                "Only practice English greetings",
                "Only drill Present Simple",
                "Drop the subject to study IELTS writing",
            ],
            "A",
        ),
        (
            f"A fair test goal for {focus} is to assess:",
            [
                "Subject knowledge and reasoning",
                "IELTS Speaking Part 1 delivery",
                "Article (a/an/the) error counts",
                "Pronunciation of /θ/",
            ],
            "A",
        ),
        (
            f"The most suitable materials for {focus} are:",
            [
                "Subject textbooks and specialist notes",
                "Irregular verb lists",
                "IPA charts alone",
                "TOEIC listening sets",
            ],
            "A",
        ),
        (
            f"When answering MCQs about {focus}, you should:",
            [
                "Read carefully, eliminate wrong options, pick the best",
                "Translate everything into English first",
                "Choose by option length only",
                "Always pick the choice containing \"language\"",
            ],
            "A",
        ),
        (
            f"Which is NOT a focus of studying {focus}?",
            [
                "Daily English conversation fluency",
                "Mastering the subject's core knowledge",
                "Building analytical skills for the curriculum",
                "Applying ideas to relevant situations",
            ],
            "A",
        ),
        (
            f"Which statement about learning {focus} is correct?",
            [
                "Combine recalling facts with analyzing examples",
                "Only memorize \"How are you?\"",
                "Only learn Present Perfect forms",
                "Skip concepts and only translate to English",
            ],
            "A",
        ),
    ]


def _heuristic_quiz(body: GenerateQuizRequest) -> GenerateQuizResponse:
    topic = (body.topic or "English basics").strip()
    level, is_cefr = _resolve_quiz_level(body)
    count = max(1, min(int(body.count or 5), 20))
    title_hint, _desc = _split_topic_context(topic)
    keywords = _topic_keywords(topic)
    subject = _detect_quiz_subject(topic)
    lang = _detect_quiz_language(topic, subject=subject, is_cefr=is_cefr)
    use_esl = is_cefr or _is_english_learning_subject(subject)

    if use_esl:
        focus = " ".join(keywords[:2]) if keywords else "English"
        secondary = keywords[2] if len(keywords) > 2 else (keywords[1] if len(keywords) > 1 else "communication")
        banks = _english_esl_banks(level, focus, secondary)
        title = (
            _with_cefr_title(f"{title_hint[:60]} Quiz", level)
            if is_cefr
            else _with_level_title(f"{title_hint[:60]}", level, is_cefr=False)
        )
    else:
        focus = " ".join(keywords[:2]) if keywords else (subject if subject != "Other" else "chủ đề")
        banks = _subject_quiz_banks(subject, lang, level, focus, topic=topic)
        base_title = title_hint[:60] if title_hint else subject
        title = (
            _with_cefr_title(f"{base_title} Quiz", level)
            if is_cefr
            else _with_level_title(base_title, level, is_cefr=False)
        )

    rng = random.Random()
    order = list(range(len(banks)))
    rng.shuffle(order)
    questions: list[QuizQuestionOut] = []
    for i in range(count):
        prompt, choices, answer = banks[order[i % len(order)]]
        correct_idx = ord(answer.upper()[:1]) - 65 if answer[:1].upper() in "ABCD" else 0
        correct_idx = max(0, min(correct_idx, len(choices) - 1))
        correct_text = choices[correct_idx]
        shuffled = choices[:]
        rng.shuffle(shuffled)
        new_idx = shuffled.index(correct_text)
        letter = chr(65 + new_idx)
        questions.append(
            QuizQuestionOut(
                prompt=prompt,
                type="mcq",
                choices=shuffled,
                answer=letter,
            )
        )
    return GenerateQuizResponse(title=title, questions=questions, source="heuristic")


def _parse_quiz_json(
    raw: str,
    count: int,
    *,
    topic: str | None = None,
    reject_esl_meta: bool = False,
    lang: str = "en",
) -> GenerateQuizResponse | None:
    if not raw:
        return None
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        # Also accept a bare JSON array of questions
        a0, a1 = text.find("["), text.rfind("]")
        if a0 < 0 or a1 <= a0:
            return None
        try:
            arr = json.loads(text[a0 : a1 + 1])
        except json.JSONDecodeError:
            return None
        if not isinstance(arr, list):
            return None
        data = {"title": "AI Quiz", "questions": arr}
    else:
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict):
        return None
    title = str(data.get("title") or "").strip() or "AI Quiz"
    raw_qs = data.get("questions") or data.get("items") or data.get("quiz")
    if not isinstance(raw_qs, list) or not raw_qs:
        return None
    questions: list[QuizQuestionOut] = []
    skipped_esl = 0
    for item in raw_qs[: max(count * 3, count)]:
        if not isinstance(item, dict):
            continue
        prompt = str(
            item.get("prompt")
            or item.get("question")
            or item.get("text")
            or item.get("stem")
            or ""
        ).strip()
        answer = str(
            item.get("answer")
            or item.get("correct")
            or item.get("correctAnswer")
            or item.get("correct_answer")
            or ""
        ).strip()
        if not prompt or not answer:
            continue
        # MCQ-only: skip short-answer and any stem that pasted classroom context.
        if topic and _prompt_leaks_context(prompt, topic):
            continue
        c = item.get("choices") or item.get("options")
        choices = _normalize_mcq_choices(
            c if isinstance(c, list) else None,
            lang=lang,
        )
        if not choices:
            continue
        if reject_esl_meta and _looks_like_esl_meta(prompt, choices):
            skipped_esl += 1
            continue
        # Normalize answer to a letter when it matches a choice.
        ans = answer.strip()
        letter_m = re.match(r"^([A-Da-d])\b", ans)
        if letter_m:
            ans = letter_m.group(1).upper()
        else:
            for idx, ch in enumerate(choices):
                if ans.lower() == ch.lower():
                    ans = chr(65 + idx)
                    break
        questions.append(
            QuizQuestionOut(prompt=prompt, type="mcq", choices=choices, answer=ans)
        )
        if len(questions) >= count:
            break
    if skipped_esl:
        logger.info("generate-quiz: skipped %s ESL-meta AI items", skipped_esl)
    if not questions:
        return None
    return GenerateQuizResponse(title=title, questions=questions, source="ai")


def _ensure_response_level(
    resp: GenerateQuizResponse,
    level: str | None,
    *,
    is_cefr: bool = True,
) -> GenerateQuizResponse:
    lvl = level or ("B1" if is_cefr else "Lớp 10")
    title = (
        _with_cefr_title(resp.title, lvl)
        if is_cefr
        else _with_level_title(resp.title, lvl, is_cefr=False)
    )
    return GenerateQuizResponse(
        title=title,
        questions=resp.questions,
        source=resp.source,
    )


def _ensure_response_cefr(resp: GenerateQuizResponse, level: str | None) -> GenerateQuizResponse:
    return _ensure_response_level(resp, level, is_cefr=True)


def _pad_with_heuristic(
    parsed: GenerateQuizResponse,
    body: GenerateQuizRequest,
    level: str,
    *,
    is_cefr: bool = True,
) -> GenerateQuizResponse:
    """If AI returned fewer MCQs than requested, fill from varied heuristic bank."""
    need = max(1, min(int(body.count or 5), 20))
    if len(parsed.questions) >= need:
        return GenerateQuizResponse(
            title=parsed.title,
            questions=parsed.questions[:need],
            source=parsed.source,
        )
    filler = _heuristic_quiz(body).questions
    merged = list(parsed.questions)
    for q in filler:
        if len(merged) >= need:
            break
        merged.append(q)
    fallback_title = (
        _with_cefr_title("AI Quiz", level)
        if is_cefr
        else _with_level_title("AI Quiz", level, is_cefr=False)
    )
    return GenerateQuizResponse(
        title=parsed.title or fallback_title,
        questions=merged[:need],
        source=parsed.source if parsed.questions else "heuristic",
    )


async def _lesson_context_hint(classroom_id: str | None) -> str:
    if not classroom_id:
        return ""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"{CONTENT_URL}/api/v1/content/lessons",
                params={"classroomId": classroom_id},
            )
            if r.status_code != 200:
                return ""
            data = r.json()
            lessons = data if isinstance(data, list) else []
            titles = [
                str(x.get("title") or "").strip()
                for x in lessons[:8]
                if isinstance(x, dict) and str(x.get("title") or "").strip()
            ]
            if titles:
                return "Related lesson titles (context only): " + "; ".join(titles)
    except httpx.HTTPError:
        return ""
    return ""


@app.post("/api/v1/ai/generate-quiz", response_model=GenerateQuizResponse, tags=["Classroom"])
async def generate_quiz(body: GenerateQuizRequest):
    t0 = time.perf_counter()
    level, is_cefr = _resolve_quiz_level(body)
    topic = (body.topic or "").strip()
    subject = _detect_quiz_subject(topic) if topic else ("English" if is_cefr else "Other")
    lang = _detect_quiz_language(topic, subject=subject, is_cefr=is_cefr)
    reject_esl = not (is_cefr or _is_english_learning_subject(subject))
    fallback = _ensure_response_level(_heuristic_quiz(body), level, is_cefr=is_cefr)

    kw_list = _topic_keywords(topic) if topic else []
    logger.info(
        "generate-quiz: detect language=%s subject=%s level=%s is_cefr=%s count=%s "
        "reject_esl=%s prefer_heuristic=%s quiz_model=%s timeout=%.2f keywords=%s",
        lang,
        subject,
        level,
        is_cefr,
        body.count,
        reject_esl,
        QUIZ_PREFER_HEURISTIC,
        OLLAMA_QUIZ_MODEL,
        QUIZ_OLLAMA_TIMEOUT,
        kw_list[:6],
    )

    def _finish(resp: GenerateQuizResponse, *, path: str) -> GenerateQuizResponse:
        duration_ms = int((time.perf_counter() - t0) * 1000)
        sample = resp.questions[0].prompt if resp.questions else ""
        logger.info(
            "generate-quiz: done path=%s source=%s n=%s duration_ms=%s sample=%r",
            path,
            resp.source,
            len(resp.questions),
            duration_ms,
            sample[:180],
        )
        return resp

    # Fast path (default): enriched subject/language banks — primary UX under ~1s.
    if QUIZ_PREFER_HEURISTIC or not topic:
        return _finish(fallback, path="heuristic")

    try:
        lesson_hint = await _lesson_context_hint(body.classroom_id)
        class_title, class_desc = _split_topic_context(topic)
        keywords = ", ".join(kw_list)
        subject_vi = {
            "Literature": "Ngữ văn",
            "Math": "Toán học",
            "English": "Ngoại ngữ 1",
            "History": "Lịch sử",
            "PhysicalEducation": "Giáo dục thể chất",
            "NationalDefense": "Giáo dục quốc phòng và an ninh",
            "ExperientialActivities": "Hoạt động trải nghiệm, hướng nghiệp",
            "LocalEducation": "Nội dung giáo dục của địa phương",
            "Physics": "Vật lí",
            "Chemistry": "Hóa học",
            "Biology": "Sinh học",
            "Geography": "Địa lí",
            "CivicEducation": "Giáo dục kinh tế và pháp luật",
            "Technology": "Công nghệ",
            "Informatics": "Tin học",
            "Music": "Âm nhạc",
            "FineArts": "Mĩ thuật",
            "IELTS": "IELTS",
            "TOEIC": "TOEIC",
            "Science": "Khoa học",
            "Business": "Kinh doanh",
            "Other": "Môn học",
        }.get(subject, subject)

        if is_cefr or _is_english_learning_subject(subject):
            system = (
                "You generate English exam quizzes for language learners.\n"
                "Reply ONLY with valid JSON (no markdown) in this shape:\n"
                '{"title":"...","questions":[{"prompt":"...","type":"mcq","choices":["...","...","...","..."],"answer":"A"}]}\n'
                f"Create exactly {body.count} questions.\n"
                'EVERY question MUST be type "mcq" with exactly 4 choices (plain texts for A–D).\n'
                "answer must be the correct letter (A/B/C/D) or the exact choice text.\n"
                f'Include the CEFR level "{level}" in the title (e.g. "Travel English · {level} Quiz").\n'
                "CRITICAL RULES:\n"
                "- Classroom title and description are CONTEXT only (topic/scope/level).\n"
                "- Do NOT copy, quote, or paste the classroom title or description into any question prompt.\n"
                "- Do NOT ask meta questions about the classroom itself.\n"
                "- Write original, varied multiple-choice English exam items ABOUT the inferred topic.\n"
                f"- Difficulty and language must match CEFR {level}.\n"
                "- Vary grammar, vocabulary, and functional English; do not repeat the same stem.\n"
                "- Keep each prompt a short exam stem (1–3 sentences max)."
            )
            style_default = "Clear CEFR-aligned 4-option MCQs; practical English."
            level_line = f"CEFR level: {level}\n"
            lang_line = "OUTPUT LANGUAGE: English (all stems + choices).\n"
            subject_line = f"Subject focus: English language learning ({subject}).\n"
        else:
            lang_rule = (
                "OUTPUT LANGUAGE: Vietnamese ONLY — every question stem, every choice, and the title must be Vietnamese.\n"
                if lang == "vi"
                else "OUTPUT LANGUAGE: English for stems and choices.\n"
            )
            system = (
                "You generate school SUBJECT exam quizzes (NOT English-as-a-second-language).\n"
                "Reply ONLY with valid JSON (no markdown) in this shape:\n"
                '{"title":"...","questions":[{"prompt":"...","type":"mcq","choices":["...","...","...","..."],"answer":"A"}]}\n'
                f"Create exactly {body.count} questions.\n"
                'EVERY question MUST be type "mcq" with exactly 4 choices (plain texts for A–D).\n'
                "answer must be the correct letter (A/B/C/D) or the exact choice text.\n"
                f'Include the class grade "{level}" in the title (e.g. "{subject_vi} · {level}").\n'
                f"{lang_rule}"
                f"SUBJECT: {subject} ({subject_vi}). Questions must test REAL {subject} knowledge "
                f"(facts, concepts, causes/effects, problem-solving) for grade {level}.\n"
                "CRITICAL RULES:\n"
                "- Classroom title and description are CONTEXT only (topic/scope/level).\n"
                "- Do NOT copy, quote, or paste the classroom title or description into any question prompt.\n"
                "- Do NOT ask meta questions about the classroom itself.\n"
                "- FORBIDDEN: English-learning / ESL / IELTS pedagogy items "
                "(e.g. what learners practice, collocations, grammar tenses, 'using the language').\n"
                "- FORBIDDEN: Writing/Speaking/Listening skill questions unless subject is English/IELTS.\n"
                "- Write original, varied, plausible 4-choice MCQs about the subject content.\n"
                f"- Difficulty must match Vietnamese school grade / level: {level}.\n"
                "- Do not repeat the same stem.\n"
                "- Keep each prompt a short exam stem (1–3 sentences max)."
            )
            style_default = (
                "Trắc nghiệm 4 đáp án bằng tiếng Việt, đúng môn học (không phải luyện tiếng Anh)."
                if lang == "vi"
                else "4-option subject MCQs; not ESL pedagogy."
            )
            level_line = f"Class grade / level: {level}\n"
            lang_line = f"Detected output language: {lang}\n"
            subject_line = f"Detected subject: {subject} ({subject_vi})\n"

        user_prompt = (
            "Use the following as CONTEXT to infer subject and scope — "
            "do not paste them into question prompts.\n"
            f"Classroom title: {class_title}\n"
            f"Classroom description: {class_desc or '(none)'}\n"
            f"{subject_line}"
            f"{lang_line}"
            f"Inferred topic keywords: {keywords}\n"
            f"{level_line}"
            f"Style notes: {body.style_prompt or style_default}\n"
            f"Learner notes: {body.student_context or '(none)'}\n"
            f"{lesson_hint or ''}\n"
            "Generate original MCQ exam JSON now."
        )
        logger.info(
            "generate-quiz: prompt_summary system_chars=%s user_chars=%s title=%r subject=%s lang=%s",
            len(system),
            len(user_prompt),
            class_title[:80],
            subject,
            lang,
        )
        reply = await call_ollama_chat(
            system,
            user_prompt,
            model=OLLAMA_QUIZ_MODEL,
            num_predict=min(700, 180 + body.count * 90),
            temperature=0.65,
            timeout=QUIZ_OLLAMA_TIMEOUT,
            allow_generate_fallback=False,
        )
        ollama_ok = bool(reply and reply.strip())
        logger.info(
            "generate-quiz: ollama %s model=%s reply_chars=%s",
            "ok" if ollama_ok else "fail",
            OLLAMA_QUIZ_MODEL,
            len(reply or ""),
        )
        parsed = _parse_quiz_json(
            reply or "",
            body.count,
            topic=topic,
            reject_esl_meta=reject_esl,
            lang=lang,
        )
        if parsed:
            padded = _ensure_response_level(
                _pad_with_heuristic(parsed, body, level, is_cefr=is_cefr),
                level,
                is_cefr=is_cefr,
            )
            return _finish(padded, path="ollama")
        if reply:
            logger.info("generate-quiz: Ollama reply not parseable; fallback used=True")
        else:
            logger.info("generate-quiz: Ollama unavailable/timeout; fallback used=True")
    except Exception:
        logger.exception("generate-quiz: unexpected error; fallback used=True")

    return _finish(fallback, path="heuristic_fallback")


_LIT_KNOWLEDGE_RE = re.compile(
    r"^(ngữ\s*văn|văn\s*học|literature|đọc|viết|thơ)$",
    re.I,
)


def _has_literature_signal(name: str, description: str) -> bool:
    return bool(
        re.search(
            r"\b(literature|poetry|novel)\b|(ngữ\s*văn|văn\s*học|tiểu\s*thuyết|(?<!\w)thơ(?!\w))",
            f"{name} {description}",
            re.I,
        )
    )


def _knowledges_look_like_literature(knowledges: list[str]) -> bool:
    if not knowledges:
        return False
    hits = sum(1 for k in knowledges if _LIT_KNOWLEDGE_RE.match((k or "").strip()))
    return hits >= max(1, len(knowledges) // 2)


@app.post("/api/v1/ai/detect-subject", response_model=DetectSubjectResponse, tags=["Classroom"])
async def detect_subject(body: DetectSubjectRequest):
    name = (body.name or "").strip()
    description = (body.description or "").strip()
    fallback, conf = _heuristic_subject(name, description)
    fallback_knowledges = _heuristic_knowledges(name, description)

    if not (name or description):
        return DetectSubjectResponse(
            subject=fallback,
            knowledges=fallback_knowledges,
            confidence=conf,
            source="heuristic",
        )

    system = (
        "You classify a Vietnamese school classroom from its TITLE and DESCRIPTION.\n"
        f"1) SUBJECT must be EXACTLY one of: {', '.join(SUBJECT_LABELS)}\n"
        "   - Prefer the subject named or clearly implied by the TITLE "
        "(e.g. 'Địa lý 101' → Geography, 'Ngữ văn 10' → Literature).\n"
        "   - Do NOT map the word 'văn hóa' alone to Literature. "
        "In geography/social contexts it means culture / cultural geography, not Ngữ văn.\n"
        "2) KNOWLEDGES: 2-5 short topic labels EXTRACTED from the description that fit the SUBJECT.\n"
        "   - Do NOT default to English skills (Ngữ pháp, Từ vựng, Nói, Nghe, Viết, Đọc) "
        "or Literature (Ngữ văn) unless SUBJECT is English/IELTS/TOEIC/Literature.\n"
        "   - For Geography, prefer topics present in the text such as: "
        "Bản đồ học, Khí hậu, Địa hình, Tài nguyên thiên nhiên, Dân số, Đô thị hóa, "
        "Di cư, Toàn cầu hóa, Môi trường, Dân cư.\n"
        f"   - Catalog hints (use only when they fit): {', '.join(KNOWLEDGE_LABELS)}.\n"
        "Reply in this exact format only:\n"
        "SUBJECT: <one label>\n"
        "KNOWLEDGES: <label1>, <label2>, <label3>\n"
    )
    user_prompt = (
        f"Class name: {name or '(none)'}\n"
        f"Description: {description or '(none)'}\n"
        "Classify quickly:"
    )
    reply = await call_ollama_chat(system, user_prompt)
    parsed = _parse_subject_label(reply or "")
    knowledges = _parse_knowledges(reply or "")
    if not knowledges:
        knowledges = fallback_knowledges

    # Guard: strong heuristic beats AI Literature bias when title/description are clearly another subject
    # (common failure: Geography descriptions mentioning "văn hóa" → Literature / Ngữ văn).
    if (
        parsed == "Literature"
        and fallback not in ("Literature", "Other")
        and conf >= 0.85
        and not _has_literature_signal(name, description)
    ):
        if _knowledges_look_like_literature(knowledges) or not knowledges:
            knowledges = fallback_knowledges
        return DetectSubjectResponse(
            subject=fallback,
            knowledges=knowledges,
            confidence=conf,
            source="heuristic",
        )

    subject = parsed or fallback
    # Prefer geography knowledges from description when subject is Geography but AI returned lit skills
    if subject == "Geography" and _knowledges_look_like_literature(knowledges):
        knowledges = fallback_knowledges

    if parsed:
        return DetectSubjectResponse(
            subject=parsed,
            knowledges=knowledges,
            confidence=0.9,
            source="ai",
        )
    return DetectSubjectResponse(
        subject=fallback,
        knowledges=knowledges,
        confidence=conf,
        source="heuristic",
    )

def _image_prompt_bullets(prompt: str, knowledges: list[str] | None = None) -> list[str]:
    prompt = prompt or ""
    cleaned = re.sub(
        r"\b(vẽ|ve|tạo ảnh|tao anh|minh họa|minh hoa|illustrate|draw|generate image|"
        r"tạo hình|tao hinh|tạo minh họa|tao minh hoa|tạo video|tao video|làm video|"
        r"lam video|generate video|make video|animate)\b",
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
    # Enrich with classroom knowledge tags when prompt is short.
    if knowledges and len(bullets) < 3:
        for k in knowledges:
            k = (k or "").strip()
            if k and k not in bullets:
                bullets.append(k)
            if len(bullets) >= 4:
                break
    return bullets[:5]


def _build_tutor_educational_svg(
    prompt: str,
    *,
    subject: str | None = None,
    classroom_name: str | None = None,
    bullets: list[str] | None = None,
    locale: str = "vi",
) -> str:
    """Local SVG fallback when multimodal /v1/image is unavailable."""
    items = bullets or _image_prompt_bullets(prompt)
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


def _svg_data_url(svg: str) -> str:
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


@app.post(
    "/api/v1/ai/tutor/image",
    response_model=TutorImageResponse,
    tags=["Tutor"],
    summary="Text→image educational illustration for the AI tutor",
)
async def tutor_image(
    body: TutorImageRequest,
    x_user_id: Annotated[str | None, Header()] = None,
):
    """Generate an educational illustration from a text prompt.

    Demo path (always works offline): branded SVG study card via multimodal `/v1/image`
    or a local SVG fallback. Real Stable Diffusion / Flux can be plugged later by setting
    `OLLAMA_IMAGE_MODEL` on the multimodal service.
    """
    locale = body.locale or "vi"
    style = (body.style or "").strip().lower() or None
    is_cover = style in {"cartoon_cover", "cover", "classroom_cover"}
    raw_prompt = (body.prompt or "").strip()
    if not raw_prompt and not is_cover:
        raise HTTPException(
            status_code=400,
            detail="Vui lòng nhập nội dung để tạo ảnh",
        )
    if is_cover and not raw_prompt and not (body.classroom_name or "").strip() and not (
        body.classroom_description or ""
    ).strip():
        raise HTTPException(
            status_code=400,
            detail="Nhập tên hoặc mô tả trước khi tạo ảnh bìa AI",
        )

    if not (body.classroom_id or "").strip() and not is_cover:
        # Soft guidance — keep shape usable for UI.
        svg = _build_tutor_educational_svg(
            "Chọn lớp học trước",
            subject="English",
            bullets=[
                "Vui lòng chọn một lớp trước khi tạo ảnh",
                "Ảnh minh họa gắn với môn / bài của lớp",
            ],
            locale=locale,
        )
        return TutorImageResponse(
            caption=_missing_classroom_reply(locale),
            provider="svg-educational",
            mimeType="image/svg+xml",
            imageSvg=svg,
            imageDataUrl=_svg_data_url(svg),
            note="classroomId required",
        )

    subject = body.subject or "English"
    class_name = body.classroom_name
    knowledges = body.knowledges or []
    if not isinstance(knowledges, list):
        knowledges = []

    if (body.classroom_id or "").strip():
        # Reuse TutorRequest shape for classroom profile resolution.
        tutor_like = TutorRequest(
            message=raw_prompt or "classroom cover",
            classroomId=body.classroom_id,
            locale=locale,
            classroomName=body.classroom_name,
            classroomDescription=body.classroom_description,
            subject=body.subject,
            knowledges=body.knowledges,
            cefrLevel=body.cefr_level,
        )
        profile = await resolve_classroom_profile(tutor_like, user_id=x_user_id, chunks=None)
        subject = (profile or {}).get("subject") or body.subject or "English"
        class_name = (profile or {}).get("name") or body.classroom_name
        knowledges = (profile or {}).get("knowledges") or body.knowledges or []
        if not isinstance(knowledges, list):
            knowledges = []

    prompt = raw_prompt
    if is_cover:
        cover_bits = [
            "Cartoon classroom cover, friendly educational illustration,",
            "bright flat colors, simple shapes, no photorealism, no watermarks,",
            f"subject {subject}.",
        ]
        if class_name:
            cover_bits.append(f"Class theme: {class_name}.")
        if body.classroom_description:
            cover_bits.append(f"Description: {str(body.classroom_description)[:160]}.")
        if knowledges:
            cover_bits.append("Topics: " + ", ".join(str(k) for k in knowledges[:4]) + ".")
        if prompt and "cartoon" not in prompt.lower():
            cover_bits.append(prompt[:200])
        elif prompt:
            cover_bits.append(prompt[:220])
        prompt = " ".join(cover_bits)

    bullets = _image_prompt_bullets(prompt, knowledges if isinstance(knowledges, list) else None)
    enriched_prompt = prompt
    if subject:
        enriched_prompt = f"[{subject}] {prompt}"
    if class_name:
        enriched_prompt = f"{enriched_prompt} (class: {class_name})"

    provider = "svg-educational"
    mime_type = "image/svg+xml"
    image_svg: str | None = None
    image_b64: str | None = None
    note = (
        "Offline educational SVG card. Plug Stable Diffusion / Flux later via "
        "multimodal OLLAMA_IMAGE_MODEL."
    )

    try:
        # Fast path: multimodal SVG is near-instant; keep timeout tight so UI stays <1s.
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.post(
                f"{MULTIMODAL_URL}/v1/image",
                json={
                    "prompt": enriched_prompt,
                    "subject": subject,
                    "classroomName": class_name,
                    "locale": locale,
                    "bullets": bullets,
                    "style": style or ("cartoon_cover" if is_cover else None),
                },
            )
            if r.status_code == 200:
                data = r.json()
                provider = data.get("provider") or provider
                mime_type = data.get("mime_type") or mime_type
                image_svg = data.get("image_svg")
                image_b64 = data.get("image_base64")
                note = data.get("note") or note
    except httpx.HTTPError as exc:
        logger.warning("tutor image multimodal failed: %s", exc)

    if not image_b64 and not image_svg:
        image_svg = _build_tutor_educational_svg(
            prompt,
            subject=str(subject) if subject else None,
            classroom_name=str(class_name) if class_name else None,
            bullets=bullets,
            locale=locale,
        )
        image_b64 = base64.b64encode(image_svg.encode("utf-8")).decode("ascii")
        provider = "svg-educational"
        mime_type = "image/svg+xml"

    if image_svg and not image_b64:
        image_b64 = base64.b64encode(image_svg.encode("utf-8")).decode("ascii")

    if mime_type.startswith("image/svg") and image_b64:
        data_url = f"data:image/svg+xml;base64,{image_b64}"
    elif image_b64:
        data_url = f"data:{mime_type};base64,{image_b64}"
    else:
        # Should not happen — last-resort empty SVG
        image_svg = _build_tutor_educational_svg(prompt, subject=str(subject) if subject else None)
        data_url = _svg_data_url(image_svg)

    caption = (
        f"Ảnh bìa: {class_name or bullets[0]}"
        if is_cover and locale.lower().startswith("vi")
        else (
            f"Cover: {class_name or bullets[0]}"
            if is_cover
            else (
                f"Minh họa: {bullets[0]}"
                if locale.lower().startswith("vi")
                else f"Illustration: {bullets[0]}"
            )
        )
    )
    logger.info(
        "tutor image provider=%s class=%s subject=%s style=%s",
        provider,
        class_name,
        subject,
        style,
    )
    return TutorImageResponse(
        caption=caption,
        provider=provider,
        mimeType=mime_type,
        imageSvg=image_svg,
        imageDataUrl=data_url,
        subject=str(subject) if subject else None,
        classroomName=str(class_name) if class_name else None,
        note=note,
    )


def _build_tutor_video_svg(
    prompt: str,
    *,
    subject: str | None = None,
    classroom_name: str | None = None,
    bullets: list[str] | None = None,
    locale: str = "vi",
    duration_sec: float = 5.0,
) -> str:
    """Local animated-SVG fallback when multimodal /v1/video is unavailable."""
    items = bullets or _image_prompt_bullets(prompt)
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
    body = items[1:] if len(items) > 1 else [tip]
    slides = [title] + [html.escape(b[:88] + ("…" if len(b) > 88 else "")) for b in body[:4]]
    n = max(1, len(slides))
    dur = max(3.0, min(float(duration_sec or 5.0), 8.0))
    step = 1.0 / n
    groups: list[str] = []
    for i, text in enumerate(slides):
        t0 = i * step
        t1 = t0 + min(0.08, step * 0.25)
        t2 = (i + 1) * step - min(0.08, step * 0.25)
        t3 = (i + 1) * step
        if i == 0:
            values, key_times = "0;1;1;0;0", f"0;{t1:.3f};{t2:.3f};{t3:.3f};1"
        else:
            values, key_times = "0;0;1;1;0;0", f"0;{t0:.3f};{t1:.3f};{t2:.3f};{t3:.3f};1"
        label = ("Chủ đề" if vi else "Topic") if i == 0 else (f"Ý {i}" if vi else f"Point {i}")
        size = 36 if i == 0 else 26
        groups.append(
            f'''<g opacity="0">
  <animate attributeName="opacity" values="{values}" keyTimes="{key_times}"
           dur="{dur:.1f}s" repeatCount="indefinite" calcMode="linear"/>
  <text x="400" y="150" text-anchor="middle" fill="#99f6e4" font-size="14" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(label)}</text>
  <text x="400" y="220" text-anchor="middle" fill="#ffffff" font-size="{size}" font-weight="700"
        font-family="Georgia, 'Times New Roman', serif">{text}</text>
</g>'''
        )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="vbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b2e30"/>
      <stop offset="100%" stop-color="#0f766e"/>
    </linearGradient>
    <linearGradient id="vacc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2dd4bf"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="800" height="480" rx="28" fill="url(#vbg)"/>
  <rect x="36" y="28" width="200" height="32" rx="16" fill="url(#vacc)"/>
  <text x="136" y="49" text-anchor="middle" fill="#062825" font-size="13" font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(chip[:36])}</text>
  {"".join(groups)}
  <rect x="80" y="448" width="640" height="6" rx="3" fill="#0f3d3e"/>
  <rect x="80" y="448" width="640" height="6" rx="3" fill="url(#vacc)">
    <animate attributeName="width" values="0;640;0" keyTimes="0;0.92;1"
             dur="{dur:.1f}s" repeatCount="indefinite"/>
  </rect>
  <text x="48" y="470" fill="#b7e4dc" font-size="12"
        font-family="Segoe UI, system-ui, sans-serif">{html.escape(footer)}</text>
</svg>'''


@app.post(
    "/api/v1/ai/tutor/video",
    response_model=TutorVideoResponse,
    tags=["Tutor"],
    summary="Text→short educational video clip for the AI tutor / mascot",
)
async def tutor_video(
    body: TutorVideoRequest,
    x_user_id: Annotated[str | None, Header()] = None,
):
    """Generate a short educational clip from a text prompt.

    Demo path: animated SVG slideshow (title + key bullets) via multimodal `/v1/video`
    or a local SVG fallback — typically under ~1s, no paid APIs.
    """
    locale = body.locale or "vi"
    dur = body.duration_sec if body.duration_sec is not None else 5.0

    if not (body.classroom_id or "").strip():
        svg = _build_tutor_video_svg(
            "Chọn lớp học trước",
            subject="English",
            bullets=[
                "Vui lòng chọn một lớp trước khi tạo video",
                "Clip học tập gắn với môn / bài của lớp",
            ],
            locale=locale,
            duration_sec=dur,
        )
        b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
        return TutorVideoResponse(
            caption=_missing_classroom_reply(locale),
            provider="svg-animated-slides",
            mimeType="image/svg+xml",
            videoSvg=svg,
            videoDataUrl=f"data:image/svg+xml;base64,{b64}",
            durationSec=max(3.0, min(float(dur or 5.0), 8.0)),
            note="classroomId required",
        )

    subject = body.subject or "English"
    class_name = body.classroom_name
    knowledges = body.knowledges or []
    if not isinstance(knowledges, list):
        knowledges = []

    tutor_like = TutorRequest(
        message=body.prompt.strip(),
        classroomId=body.classroom_id,
        locale=locale,
        classroomName=body.classroom_name,
        classroomDescription=body.classroom_description,
        subject=body.subject,
        knowledges=body.knowledges,
        cefrLevel=body.cefr_level,
    )
    profile = await resolve_classroom_profile(tutor_like, user_id=x_user_id, chunks=None)
    subject = (profile or {}).get("subject") or body.subject or "English"
    class_name = (profile or {}).get("name") or body.classroom_name
    knowledges = (profile or {}).get("knowledges") or body.knowledges or []
    if not isinstance(knowledges, list):
        knowledges = []

    prompt = body.prompt.strip()
    bullets = _image_prompt_bullets(prompt, knowledges if isinstance(knowledges, list) else None)
    enriched_prompt = prompt
    if subject:
        enriched_prompt = f"[{subject}] {prompt}"
    if class_name:
        enriched_prompt = f"{enriched_prompt} (class: {class_name})"

    provider = "svg-animated-slides"
    mime_type = "image/svg+xml"
    video_svg: str | None = None
    video_b64: str | None = None
    duration_out = max(3.0, min(float(dur or 5.0), 8.0))
    note = "Offline animated SVG lesson clip."

    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.post(
                f"{MULTIMODAL_URL}/v1/video",
                json={
                    "prompt": enriched_prompt,
                    "subject": subject,
                    "classroomName": class_name,
                    "locale": locale,
                    "bullets": bullets,
                    "durationSec": duration_out,
                },
            )
            if r.status_code == 200:
                data = r.json()
                provider = data.get("provider") or provider
                mime_type = data.get("mime_type") or mime_type
                video_svg = data.get("video_svg")
                video_b64 = data.get("video_base64")
                if data.get("duration_sec") is not None:
                    try:
                        duration_out = float(data["duration_sec"])
                    except (TypeError, ValueError):
                        pass
                note = data.get("note") or note
    except httpx.HTTPError as exc:
        logger.warning("tutor video multimodal failed: %s", exc)

    if not video_b64 and not video_svg:
        video_svg = _build_tutor_video_svg(
            prompt,
            subject=str(subject) if subject else None,
            classroom_name=str(class_name) if class_name else None,
            bullets=bullets,
            locale=locale,
            duration_sec=duration_out,
        )
        video_b64 = base64.b64encode(video_svg.encode("utf-8")).decode("ascii")
        provider = "svg-animated-slides"
        mime_type = "image/svg+xml"

    if video_svg and not video_b64:
        video_b64 = base64.b64encode(video_svg.encode("utf-8")).decode("ascii")

    if mime_type.startswith("image/svg") and video_b64:
        data_url = f"data:image/svg+xml;base64,{video_b64}"
    elif video_b64:
        data_url = f"data:{mime_type};base64,{video_b64}"
    else:
        video_svg = _build_tutor_video_svg(prompt, subject=str(subject) if subject else None)
        data_url = _svg_data_url(video_svg)

    caption = (
        f"Video: {bullets[0]}"
        if locale.lower().startswith("vi")
        else f"Clip: {bullets[0]}"
    )
    logger.info(
        "tutor video provider=%s class=%s subject=%s",
        provider,
        class_name,
        subject,
    )
    return TutorVideoResponse(
        caption=caption,
        provider=provider,
        mimeType=mime_type,
        videoSvg=video_svg,
        videoDataUrl=data_url,
        durationSec=duration_out,
        subject=str(subject) if subject else None,
        classroomName=str(class_name) if class_name else None,
        note=note,
    )


@app.post("/api/v1/ai/tutor/stt", tags=["Tutor"])
async def tutor_stt(body: TutorSttRequest):
    """Speech→text via multimodal service (browser Web Speech is preferred for speed)."""
    audio = _strip_media_b64(body.audio_base64)
    try:
        async with httpx.AsyncClient(timeout=TUTOR_STT_TIMEOUT) as client:
            r = await client.post(
                f"{MULTIMODAL_URL}/v1/stt",
                json={
                    "audio_base64": audio,
                    "audioBase64": audio,
                    "language": body.language or "vi",
                },
            )
            if r.status_code == 200:
                data = r.json()
                return {
                    "text": data.get("text") or "",
                    "language": data.get("language") or body.language or "vi",
                    "provider": data.get("provider"),
                    "note": data.get("note"),
                }
    except httpx.HTTPError as exc:
        logger.warning("tutor stt failed: %s", exc)
    return {
        "text": "",
        "language": body.language or "vi",
        "provider": "error",
        "note": "STT service unavailable",
    }


@app.post("/api/v1/ai/tutor/vision", tags=["Tutor"])
async def tutor_vision(body: TutorVisionRequest):
    """Image→text (caption/OCR) via multimodal vision; does not require classroom."""
    image = _strip_media_b64(body.image_base64)
    locale = body.locale or "vi"
    prompt = (body.prompt or "").strip() or _default_image_prompt(locale)
    try:
        async with httpx.AsyncClient(timeout=TUTOR_VISION_TIMEOUT) as client:
            r = await client.post(
                f"{MULTIMODAL_URL}/v1/vision",
                json={
                    "image_base64": image,
                    "imageBase64": image,
                    "prompt": prompt,
                    "locale": locale,
                },
            )
            if r.status_code == 200:
                data = r.json()
                return {
                    "description": data.get("description") or "",
                    "provider": data.get("provider"),
                    "note": data.get("note"),
                    "classroomId": body.classroom_id,
                }
    except httpx.HTTPError as exc:
        logger.warning("tutor vision failed: %s", exc)
    return {
        "description": (
            "Đã nhận ảnh nhưng dịch vụ thị giác tạm lỗi. Hãy mô tả ngắn nội dung ảnh."
            if locale.startswith("vi")
            else "Image received but vision service failed. Please briefly describe it."
        ),
        "provider": "error",
        "note": "Vision unavailable",
        "classroomId": body.classroom_id,
    }


@app.post("/api/v1/ai/tutor", response_model=TutorResponse, tags=["Tutor"])
async def tutor(
    body: TutorRequest,
    x_user_id: Annotated[str | None, Header()] = None,
):
    if not _tutor_has_payload(body):
        return TutorResponse(
            reply=(
                "Hãy nhập câu hỏi, đính kèm ảnh, hoặc dùng mic để nói."
                if (body.locale or "vi").startswith("vi")
                else "Please type a question, attach an image, or use the mic."
            ),
            grounded=False,
            sources=[],
            mode="english_learning",
        )
    history = _request_history(body)
    if not (body.classroom_id or "").strip():
        return TutorResponse(
            reply=_missing_classroom_reply(body.locale),
            grounded=False,
            sources=[],
            mode="english_learning",
        )

    profile = await resolve_classroom_profile(body, user_id=x_user_id, chunks=None)
    result = await tutor_graph.ainvoke(
        {
            "message": (body.message or "").strip(),
            "classroom_id": body.classroom_id,
            "locale": body.locale,
            "modality": body.modality,
            "media_base64": _strip_media_b64(body.media_base64) or None,
            "user_id": x_user_id,
            "history": history,
            "classroom_profile": profile or {},
        }
    )
    chunks = result.get("context_chunks") or []
    # Enrich CEFR from lessons if missing on first resolve.
    if profile and not profile.get("cefr_level") and chunks:
        profile = await resolve_classroom_profile(body, user_id=x_user_id, chunks=chunks)
    subject = (profile or {}).get("subject")
    mode = result.get("tutor_mode") or detect_tutor_mode(
        body.message, body.locale, history, classroom_subject=subject
    )
    return TutorResponse(
        reply=result.get("reply") or "",
        grounded=bool(chunks),
        sources=_tutor_sources(chunks),
        transcript=result.get("transcript"),
        mode=mode,
    )


@app.post("/api/v1/ai/tutor/stream", tags=["Tutor"])
async def tutor_stream(
    body: TutorRequest,
    x_user_id: Annotated[str | None, Header()] = None,
):
    """SSE token stream: retrieve first, then delta events, then meta + done.

    Event payload (data: JSON):
      {"type":"delta","text":"..."}
      {"type":"meta","grounded":bool,"sources":[...],"mode":"general|english_learning","transcript":str|null}
      {"type":"done"}
      {"type":"error","message":"..."}
    """

    async def event_gen() -> AsyncIterator[str]:
        t0 = time.perf_counter()
        history = _request_history(body)
        locale = body.locale or "vi"

        if not _tutor_has_payload(body):
            empty = (
                "Hãy nhập câu hỏi, đính kèm ảnh, hoặc dùng mic để nói."
                if locale.startswith("vi")
                else "Please type a question, attach an image, or use the mic."
            )
            async for piece in _stream_text_chunks(empty):
                yield _sse({"type": "delta", "text": piece})
            yield _sse(
                {
                    "type": "meta",
                    "grounded": False,
                    "sources": [],
                    "mode": "english_learning",
                    "transcript": None,
                }
            )
            yield _sse({"type": "done"})
            return

        if not (body.classroom_id or "").strip():
            async for piece in _stream_text_chunks(_missing_classroom_reply(locale)):
                yield _sse({"type": "delta", "text": piece})
            yield _sse(
                {
                    "type": "meta",
                    "grounded": False,
                    "sources": [],
                    "mode": "english_learning",
                    "transcript": None,
                }
            )
            yield _sse({"type": "done"})
            return

        profile = await resolve_classroom_profile(body, user_id=x_user_id, chunks=None)
        state: GraphState = {
            "message": (body.message or "").strip(),
            "classroom_id": body.classroom_id,
            "locale": locale,
            "modality": body.modality,
            "media_base64": _strip_media_b64(body.media_base64) or None,
            "user_id": x_user_id,
            "history": history,
            "classroom_profile": profile or {},
        }
        try:
            state = await multimodal_node(state)
            state = await retrieve_node(state)
            chunks = state.get("context_chunks") or []
            if profile and not profile.get("cefr_level") and chunks:
                profile = await resolve_classroom_profile(body, user_id=x_user_id, chunks=chunks)
                state["classroom_profile"] = profile or {}
            message = (state.get("message") or "").strip()
            subject = (profile or {}).get("subject")
            mode = detect_tutor_mode(message, locale, history, classroom_subject=subject)
            sources = _tutor_sources(chunks)
            meta = {
                "type": "meta",
                "grounded": bool(chunks),
                "sources": sources,
                "mode": mode,
                "transcript": state.get("transcript"),
            }

            # Curated path: still stream character chunks for live UI feel.
            curated = pedagogical_fallback(
                message,
                locale,
                chunks,
                allow_generic=False,
                mode=mode,
                history=history,
                classroom_profile=profile,
            )
            if curated:
                async for piece in _stream_text_chunks(curated):
                    yield _sse({"type": "delta", "text": piece})
                yield _sse(meta)
                yield _sse({"type": "done"})
                logger.info(
                    "tutor stream curated mode=%s class=%s history_turns=%s total=%.0fms model=%s",
                    mode,
                    (profile or {}).get("name"),
                    len(history),
                    (time.perf_counter() - t0) * 1000,
                    OLLAMA_TUTOR_MODEL,
                )
                return

            system, user_prompt = _tutor_prompts(
                message,
                locale,
                chunks,
                mode=mode,
                history=history,
                classroom_profile=profile,
            )
            collected: list[str] = []
            first_token_ms: float | None = None
            num_predict = (
                TUTOR_NUM_PREDICT if mode == "english_learning" else max(TUTOR_NUM_PREDICT, 360)
            )
            if mode == "english_learning" and _is_practice_followup(message):
                num_predict = max(num_predict, 480)
            try:
                async for delta in stream_ollama_chat(
                    system,
                    user_prompt,
                    model=OLLAMA_TUTOR_MODEL,
                    num_predict=num_predict,
                    temperature=0.2,
                    timeout=TUTOR_OLLAMA_TIMEOUT,
                    history=history,
                ):
                    if first_token_ms is None:
                        first_token_ms = (time.perf_counter() - t0) * 1000
                    collected.append(delta)
                    yield _sse({"type": "delta", "text": delta})
            except (httpx.HTTPError, httpx.TimeoutException, ValueError, TypeError) as exc:
                logger.warning("tutor stream ollama failed: %s", exc)

            reply = "".join(collected).strip()
            if not reply or _looks_inaccurate(reply, message) or _looks_like_safety_refusal(reply):
                fallback = pedagogical_fallback(
                    message,
                    locale,
                    chunks,
                    allow_generic=True,
                    mode=mode,
                    history=history,
                    classroom_profile=profile,
                ) or (
                    "Xin lỗi, gia sư AI đang chậm. Hãy hỏi lại rõ hơn."
                    if mode == "general"
                    else "Xin lỗi, gia sư AI đang chậm. Hãy hỏi lại về ngữ pháp hoặc gửi câu cần sửa."
                )
                if not reply:
                    async for piece in _stream_text_chunks(fallback):
                        yield _sse({"type": "delta", "text": piece})
                elif _looks_inaccurate(reply, message) or _looks_like_safety_refusal(reply):
                    # Replace bad streamed content by appending a corrected note
                    correction = "\n\n---\n" + fallback
                    async for piece in _stream_text_chunks(correction):
                        yield _sse({"type": "delta", "text": piece})

            yield _sse(meta)
            yield _sse({"type": "done"})
            logger.info(
                "tutor stream model=%s mode=%s class=%s history_turns=%s first_token=%.0fms total=%.0fms grounded=%s",
                OLLAMA_TUTOR_MODEL,
                mode,
                (profile or {}).get("name"),
                len(history),
                first_token_ms if first_token_ms is not None else -1,
                (time.perf_counter() - t0) * 1000,
                bool(chunks),
            )
        except Exception as exc:  # noqa: BLE001 — surface soft error to client
            logger.exception("tutor stream failed")
            yield _sse({"type": "error", "message": str(exc) or "Tutor stream failed"})
            yield _sse({"type": "done"})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/v1/ai/sessions", response_model=TutorResponse, tags=["Tutor"])
async def sessions_alias(body: TutorRequest, x_user_id: Annotated[str | None, Header()] = None):
    return await tutor(body, x_user_id)
