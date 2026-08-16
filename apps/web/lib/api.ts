import { getAccessToken } from "./auth";
import type {
  TutorImageResponse,
  TutorMode,
  TutorResponse,
  TutorSource,
  TutorSttResponse,
  TutorVideoResponse,
  TutorVisionResponse,
  UpdateProfileRequest,
  User,
} from "./types";
import { stripDataUrlBase64 } from "./tutorMedia";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(options.headers);

  if (
    !headers.has("Content-Type") &&
    options.body &&
    !(typeof FormData !== "undefined" && options.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let message = `Yêu cầu thất bại (${res.status})`;
    try {
      const err = (await res.json()) as {
        message?: string;
        error?: string;
        detail?: string;
        title?: string;
      };
      message =
        err.message || err.detail || err.error || err.title || message;
      if (
        res.status === 413 &&
        (message.includes("thất bại") || /payload too large/i.test(message))
      ) {
        message = "Tệp đính kèm quá lớn. Hãy chọn ảnh nhỏ hơn (~5MB).";
      }
    } catch {
      if (res.status === 413) {
        message = "Tệp đính kèm quá lớn. Hãy chọn ảnh nhỏ hơn (~5MB).";
      }
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export type TutorStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "meta";
      grounded?: boolean;
      sources?: TutorSource[];
      mode?: TutorMode | string;
      transcript?: string | null;
    }
  | { type: "done" }
  | { type: "error"; message: string };

export interface TutorHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export type TutorModality = "text" | "voice" | "image";

export interface TutorChatBody {
  message: string;
  /** Required for English tutor — binds answers to one classroom. */
  classroomId?: string;
  locale: string;
  /** text | voice | image — with mediaBase64 for voice/image. */
  modality?: TutorModality;
  /** Raw base64 or data-URL for voice audio / image. */
  mediaBase64?: string;
  /** Prior turns in this session (excluding the current `message`). */
  messages?: TutorHistoryMessage[];
  classroomName?: string;
  classroomDescription?: string;
  subject?: string;
  knowledges?: string[];
  cefrLevel?: string;
}

export interface TutorImageBody {
  prompt: string;
  classroomId?: string;
  locale?: string;
  classroomName?: string;
  classroomDescription?: string;
  subject?: string;
  knowledges?: string[];
  cefrLevel?: string;
  /** "cartoon_cover" for create-classroom cover art */
  style?: string;
}

export interface TutorVideoBody {
  prompt: string;
  classroomId?: string;
  locale?: string;
  classroomName?: string;
  classroomDescription?: string;
  subject?: string;
  knowledges?: string[];
  cefrLevel?: string;
  durationSec?: number;
}

/** Detect user intent to generate an illustration (vi/en). */
export function wantsTutorImage(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (wantsTutorVideo(t)) return false;
  return (
    /\b(vẽ|ve|minh\s*họa|minh\s*hoa|tạo\s*ảnh|tao\s*anh|tạo\s*hình|tao\s*hinh|illustrate|draw|generate\s*image|make\s*(an?\s*)?image)\b/i.test(
      t,
    ) || /^(tạo ảnh|tao anh|minh họa|minh hoa)\b/i.test(t)
  );
}

/** Detect user intent to generate a short lesson video (vi/en). */
export function wantsTutorVideo(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return (
    /\b(tạo\s*video|tao\s*video|làm\s*video|lam\s*video|generate\s*video|make\s*(a\s*)?video|animate|clip\s*học|video\s*học)\b/i.test(
      t,
    ) || /^(tạo video|tao video|làm video|lam video)\b/i.test(t)
  );
}

const TUTOR_HISTORY_MAX_TURNS = 16;

/** Build prior-turn payload for tutor APIs (last N user/assistant messages). */
export function buildTutorHistory(
  messages: Array<{ role: string; content: string }>,
  currentMessage?: string,
  maxTurns: number = TUTOR_HISTORY_MAX_TURNS,
): TutorHistoryMessage[] {
  const cur = (currentMessage || "").trim();
  const out: TutorHistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = (m.content || "").trim();
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  if (cur && out.length && out[out.length - 1].role === "user" && out[out.length - 1].content === cur) {
    out.pop();
  }
  if (maxTurns > 0 && out.length > maxTurns) {
    return out.slice(-maxTurns);
  }
  return out;
}

function parseSseChunk(chunk: string): TutorStreamEvent | null {
  const dataLine = chunk
    .split("\n")
    .map((l) => l.trimEnd())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  const raw = dataLine.replace(/^data:\s?/, "").trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    return JSON.parse(raw) as TutorStreamEvent;
  } catch {
    return null;
  }
}

/** Consume POST /api/v1/ai/tutor/stream (SSE). Calls onEvent for each event. */
export async function streamTutor(
  body: TutorChatBody,
  onEvent: (event: TutorStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/api/v1/ai/tutor/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(serializeTutorBody(body)),
    signal,
  });

  if (!res.ok) {
    let message = `Yêu cầu thất bại (${res.status})`;
    try {
      const err = (await res.json()) as { message?: string; error?: string };
      message = err.message || err.error || message;
    } catch {
      /* use default */
    }
    throw new ApiError(message, res.status);
  }

  if (!res.body) {
    throw new ApiError("Luồng phản hồi trống", res.status || 502);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseChunk(part);
      if (event) onEvent(event);
    }
  }

  if (buffer.trim()) {
    const event = parseSseChunk(buffer);
    if (event) onEvent(event);
  }
}

export function tutorMetaFromSources(
  grounded: boolean | undefined,
  sources: TutorSource[] | undefined,
  mode?: TutorMode | string,
  classroomName?: string,
): string {
  const sourceTitles = (sources || [])
    .map((s) => s.title)
    .filter(Boolean)
    .slice(0, 3);
  if (grounded) {
    return `Dựa trên bài học: ${sourceTitles.join(", ") || "tài liệu lớp"}`;
  }
  const classLabel = (classroomName || "").trim();
  if (classLabel) {
    return `Trong phạm vi lớp: ${classLabel}`;
  }
  if (mode === "general") {
    return "Kiến thức chung";
  }
  return "Kiến thức tiếng Anh chuẩn (chưa gắn bài lớp)";
}

/** POST /api/v1/ai/tutor/image — educational text→image (SVG card offline). */
export async function generateTutorImage(
  body: TutorImageBody,
  signal?: AbortSignal,
): Promise<TutorImageResponse> {
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) {
    throw new ApiError("Vui lòng nhập nội dung để tạo ảnh", 400);
  }
  const raw = await apiFetch<
    TutorImageResponse & {
      mime_type?: string;
      image_svg?: string | null;
      image_data_url?: string;
      classroom_name?: string | null;
    }
  >("/api/v1/ai/tutor/image", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      classroomId: body.classroomId,
      locale: body.locale || "vi",
      classroomName: body.classroomName,
      classroomDescription: body.classroomDescription,
      subject: body.subject,
      knowledges: body.knowledges,
      cefrLevel: body.cefrLevel,
      style: body.style,
    }),
    signal,
  });
  const imageDataUrl = raw.imageDataUrl || raw.image_data_url || "";
  if (!imageDataUrl) {
    throw new ApiError("Phản hồi ảnh trống", 502);
  }
  return {
    caption: raw.caption,
    provider: raw.provider,
    mimeType: raw.mimeType || raw.mime_type || "image/svg+xml",
    imageSvg: raw.imageSvg ?? raw.image_svg,
    imageDataUrl,
    subject: raw.subject,
    classroomName: raw.classroomName ?? raw.classroom_name,
    note: raw.note,
  };
}

/** POST /api/v1/ai/tutor/video — short educational clip (animated SVG offline). */
export async function generateTutorVideo(
  body: TutorVideoBody,
  signal?: AbortSignal,
): Promise<TutorVideoResponse> {
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) {
    throw new ApiError("Vui lòng nhập nội dung để tạo video", 400);
  }
  const raw = await apiFetch<
    TutorVideoResponse & {
      mime_type?: string;
      video_svg?: string | null;
      video_data_url?: string;
      duration_sec?: number | null;
      classroom_name?: string | null;
    }
  >("/api/v1/ai/tutor/video", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      classroomId: body.classroomId,
      locale: body.locale || "vi",
      classroomName: body.classroomName,
      classroomDescription: body.classroomDescription,
      subject: body.subject,
      knowledges: body.knowledges,
      cefrLevel: body.cefrLevel,
      durationSec: body.durationSec ?? 5,
    }),
    signal,
  });
  const videoDataUrl = raw.videoDataUrl || raw.video_data_url || "";
  if (!videoDataUrl) {
    throw new ApiError("Phản hồi video trống", 502);
  }
  return {
    caption: raw.caption,
    provider: raw.provider,
    mimeType: raw.mimeType || raw.mime_type || "image/svg+xml",
    videoSvg: raw.videoSvg ?? raw.video_svg,
    videoDataUrl,
    durationSec: raw.durationSec ?? raw.duration_sec,
    subject: raw.subject,
    classroomName: raw.classroomName ?? raw.classroom_name,
    note: raw.note,
  };
}

/**
 * Prefer SSE tutor stream; fall back to non-stream POST /api/v1/ai/tutor
 * if the stream fails before any delta arrives.
 */
function serializeTutorBody(body: TutorChatBody): Record<string, unknown> {
  const media = body.mediaBase64 ? stripDataUrlBase64(body.mediaBase64) : undefined;
  return {
    message: body.message || "",
    classroomId: body.classroomId,
    locale: body.locale || "vi",
    modality: body.modality || "text",
    mediaBase64: media,
    messages: body.messages,
    classroomName: body.classroomName,
    classroomDescription: body.classroomDescription,
    subject: body.subject,
    knowledges: body.knowledges,
    cefrLevel: body.cefrLevel,
  };
}

export async function tutorChatStreaming(
  body: TutorChatBody,
  handlers: {
    onDelta: (text: string) => void;
    onMeta?: (meta: {
      grounded?: boolean;
      sources?: TutorSource[];
      mode?: TutorMode | string;
      transcript?: string | null;
    }) => void;
    onError?: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<"stream" | "fallback"> {
  const payload = serializeTutorBody(body);
  let gotDelta = false;
  try {
    await streamTutor(
      body,
      (ev) => {
        if (ev.type === "delta" && ev.text) {
          gotDelta = true;
          handlers.onDelta(ev.text);
        } else if (ev.type === "meta") {
          handlers.onMeta?.({
            grounded: ev.grounded,
            sources: ev.sources,
            mode: ev.mode,
            transcript: ev.transcript,
          });
        } else if (ev.type === "error") {
          handlers.onError?.(ev.message || "Tutor stream error");
        }
      },
      signal,
    );
    if (!gotDelta) {
      throw new Error("empty stream");
    }
    return "stream";
  } catch (err) {
    if (gotDelta) {
      // Partial stream already shown — don't replace with a second full reply.
      throw err;
    }
    const data = await apiFetch<TutorResponse>("/api/v1/ai/tutor", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });
    const reply =
      data.reply || data.message || data.response || "Không nhận được phản hồi.";
    handlers.onDelta(reply);
    handlers.onMeta?.({
      grounded: data.grounded,
      sources: data.sources,
      mode: data.mode,
      transcript: data.transcript,
    });
    return "fallback";
  }
}

/** POST /api/v1/ai/tutor/stt — server STT fallback (prefer browser Web Speech). */
export async function tutorSpeechToText(
  audioBase64: string,
  language = "vi",
  signal?: AbortSignal,
): Promise<TutorSttResponse> {
  return apiFetch<TutorSttResponse>("/api/v1/ai/tutor/stt", {
    method: "POST",
    body: JSON.stringify({
      audioBase64: stripDataUrlBase64(audioBase64),
      language,
    }),
    signal,
  });
}

/** POST /api/v1/ai/tutor/vision — image caption / OCR assist. */
export async function tutorVisionDescribe(
  imageBase64: string,
  options?: { prompt?: string; locale?: string; classroomId?: string },
  signal?: AbortSignal,
): Promise<TutorVisionResponse> {
  return apiFetch<TutorVisionResponse>("/api/v1/ai/tutor/vision", {
    method: "POST",
    body: JSON.stringify({
      imageBase64: stripDataUrlBase64(imageBase64),
      prompt: options?.prompt || "",
      locale: options?.locale || "vi",
      classroomId: options?.classroomId,
    }),
    signal,
  });
}

export async function fetchCurrentUser(): Promise<User> {
  return apiFetch<User>("/api/v1/auth/me");
}

export async function updateProfile(body: UpdateProfileRequest): Promise<User> {
  return apiFetch<User>("/api/v1/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Resize image client-side and return a JPEG/PNG data URL under ~maxBytes. */
export async function fileToAvatarDataUrl(
  file: File,
  maxBytes = 200 * 1024,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Vui lòng chọn tệp ảnh.");
  }
  const bitmap = await createImageBitmap(file);
  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không thể xử lý ảnh.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > maxBytes * 1.37 && quality > 0.4) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > maxBytes * 1.37) {
    throw new Error("Ảnh quá lớn sau khi nén (giới hạn ~200KB).");
  }
  return dataUrl;
}
