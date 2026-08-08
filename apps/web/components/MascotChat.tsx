"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  apiFetch,
  buildTutorHistory,
  generateTutorImage,
  generateTutorVideo,
  tutorChatStreaming,
  tutorMetaFromSources,
  tutorSpeechToText,
  wantsTutorImage,
  wantsTutorVideo,
} from "@/lib/api";
import type { Classroom } from "@/lib/types";
import FormattedChatContent from "@/components/FormattedChatContent";
import TutorComposer from "@/components/TutorComposer";
import {
  blobToBase64,
  browserSpeechSupported,
  fileToTutorImageDataUrl,
  recordMicAudio,
  startBrowserSpeech,
} from "@/lib/tutorMedia";
import {
  getClassroomMeta,
  isEnglishSubject,
  subjectLabel,
} from "@/lib/classroomMeta";

type MascotMode = "help" | "class";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  imageDataUrl?: string;
  videoDataUrl?: string;
  videoMimeType?: string;
  transcript?: string;
}

interface MascotChatProps {
  variant?: "floating" | "embedded";
  defaultOpen?: boolean;
}

function asArray<T>(data: T | T[] | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function MascotMark({ size = 28 }: { size?: number }) {
  return (
    <img
      src="/mascot.png"
      alt=""
      width={size}
      height={size}
      aria-hidden
      className="mascot-mark"
      draggable={false}
    />
  );
}

function answerAppHelp(question: string): string {
  const q = question.toLowerCase();

  if (/mời|invite|join|tham gia|mã/.test(q)) {
    return (
      "Để tham gia lớp: vào Trang chủ → tab Tham gia (hoặc /student/join), nhập mã mời từ giáo viên, rồi chờ chấp nhận."
    );
  }

  if (/lớp|classroom|classrooms|bài học|lesson|quiz|kiểm tra/.test(q)) {
    return (
      "Lớp của bạn nằm ở Trang chủ → Lớp học (/home?tab=classrooms). Mở từng lớp để xem bài học và bài kiểm tra đã xuất bản."
    );
  }

  if (/thông báo|notification|chuông|bell|duyệt|accept|reject|chấp nhận|từ chối/.test(q)) {
    return (
      "Chuông Thông báo trên thanh đầu trang báo khi yêu cầu tham gia được chấp nhận hoặc từ chối. Nhấn chuông để đọc."
    );
  }

  if (/tutor|ai|mascot|tiếng anh|english|ground|bám bài|ảnh|image|vẽ|minh họa|mic|giọng|video/.test(q)) {
    return (
      "Trên mascot (hoặc /student/tutor), chọn Theo lớp rồi chọn lớp — AI chỉ trả lời trong môn/bài lớp đó. Dùng Mic / Ảnh / Tạo ảnh / Tạo video, hoặc gõ «vẽ …» / «tạo video …»."
    );
  }

  if (/đăng xuất|logout|sign out|tài khoản|account|profile/.test(q)) {
    return (
      "Tài khoản: Trang chủ → tab Tài khoản (tên, email, vai trò, đăng xuất). Thanh đầu trang cũng có nút Đăng xuất."
    );
  }

  if (/home|dashboard|bảng|điều khiển|menu|tab|trang chủ/.test(q)) {
    return (
      "/home là trung tâm sau khi đăng nhập: tab trái đổi nội dung phải (Tổng quan, Lớp học, Tham gia, AI Mascot, Tài khoản)."
    );
  }

  return (
    "Tôi có thể giúp: tham gia lớp (mã mời), tìm lớp/bài học, thông báo, gia sư AI theo lớp (ảnh/mic), và tài khoản. Hỏi cụ thể hơn nhé!"
  );
}

const HELP_WELCOME: ChatMessage = {
  role: "assistant",
  content:
    "Xin chào! Tôi là mascot của AI English Hub. Hãy hỏi về cách dùng ứng dụng (tham gia lớp, thông báo, gia sư…).",
};

const CLASS_WELCOME_EMPTY: ChatMessage = {
  role: "assistant",
  content:
    "Chọn lớp ở phía trên để bắt đầu. Dùng **Mic** / **Ảnh** / **Tạo ảnh** / **Tạo video**, hoặc gõ «vẽ …» / «tạo video …».",
};

function classWelcome(classroomName: string, subject: string): ChatMessage {
  return {
    role: "assistant",
    content: `Đang trò chuyện về lớp **${classroomName}** (${subject}). Hỏi ngữ pháp, gửi ảnh, hoặc nói qua Mic. Minh họa: **Tạo ảnh**. Clip ngắn: **Tạo video**.`,
  };
}

function pickDefaultClassroom(list: Classroom[]): string {
  if (list.length === 1) return list[0].id;
  const english = list.find((c) =>
    isEnglishSubject(getClassroomMeta(c.id, c.name, c.description).subject),
  );
  return english?.id || list[0]?.id || "";
}

export default function MascotChat({
  variant = "floating",
  defaultOpen = false,
}: MascotChatProps) {
  const [open, setOpen] = useState(variant === "embedded" || defaultOpen);
  const [mode, setMode] = useState<MascotMode>("help");
  const [messages, setMessages] = useState<ChatMessage[]>([HELP_WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [classroomId, setClassroomId] = useState("");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevClassRef = useRef<string>("");
  const speechStopRef = useRef<(() => Promise<string>) | null>(null);
  const speechAbortRef = useRef<(() => void) | null>(null);
  const mediaStopRef = useRef<(() => void) | null>(null);
  const mediaDoneRef = useRef<Promise<Blob> | null>(null);
  const holdModeRef = useRef(false);
  const voiceImageIntentRef = useRef(false);

  useEffect(() => {
    if (mode !== "class") return;
    apiFetch<Classroom[] | Classroom>("/api/v1/classrooms")
      .then((data) => {
        const list = asArray(data);
        setClassrooms(list);
        setClassroomId((cur) => cur || pickDefaultClassroom(list));
      })
      .catch(() => setClassrooms([]));
  }, [mode]);

  useEffect(() => {
    if (mode !== "class") return;
    if (!classroomId) {
      if (prevClassRef.current) {
        setMessages([CLASS_WELCOME_EMPTY]);
        setError("");
        setInput("");
        setAttachedImage(null);
      }
      prevClassRef.current = "";
      return;
    }
    if (prevClassRef.current && prevClassRef.current !== classroomId) {
      const selected = classrooms.find((c) => c.id === classroomId);
      const meta = selected
        ? getClassroomMeta(selected.id, selected.name, selected.description)
        : null;
      setMessages([
        classWelcome(
          selected?.name || "lớp đã chọn",
          meta ? subjectLabel(meta.subject) : "môn học",
        ),
      ]);
      setError("");
      setInput("");
      setAttachedImage(null);
    } else if (!prevClassRef.current && classroomId) {
      const selected = classrooms.find((c) => c.id === classroomId);
      const meta = selected
        ? getClassroomMeta(selected.id, selected.name, selected.description)
        : null;
      if (selected) {
        setMessages([
          classWelcome(selected.name, meta ? subjectLabel(meta.subject) : "môn học"),
        ]);
      }
    }
    prevClassRef.current = classroomId;
  }, [classroomId, classrooms, mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    return () => {
      speechAbortRef.current?.();
      mediaStopRef.current?.();
    };
  }, []);

  function switchMode(next: MascotMode) {
    setMode(next);
    setError("");
    setInput("");
    setAttachedImage(null);
    speechAbortRef.current?.();
    mediaStopRef.current?.();
    setListening(false);
    setInterimTranscript("");
    if (next === "help") {
      setMessages([HELP_WELCOME]);
      prevClassRef.current = "";
    } else if (classroomId) {
      const selected = classrooms.find((c) => c.id === classroomId);
      const meta = selected
        ? getClassroomMeta(selected.id, selected.name, selected.description)
        : null;
      setMessages([
        selected
          ? classWelcome(selected.name, meta ? subjectLabel(meta.subject) : "môn học")
          : CLASS_WELCOME_EMPTY,
      ]);
      prevClassRef.current = classroomId;
    } else {
      setMessages([CLASS_WELCOME_EMPTY]);
      prevClassRef.current = "";
    }
  }

  async function attachImageFile(file: File) {
    try {
      const dataUrl = await fileToTutorImageDataUrl(file);
      setAttachedImage(dataUrl);
      setError("");
      if (mode !== "class") {
        setError("Chuyển sang chế độ Theo lớp để hỏi về ảnh.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được ảnh");
    }
  }

  async function startListening(opts?: { hold?: boolean; forImage?: boolean }) {
    if (listening || loading) return;
    if (mode !== "class") {
      setError("Chuyển sang Theo lớp để dùng mic với gia sư.");
      return;
    }
    holdModeRef.current = Boolean(opts?.hold);
    voiceImageIntentRef.current = Boolean(opts?.forImage);
    setError("");
    setInterimTranscript("");
    setListening(true);

    if (browserSpeechSupported()) {
      const session = startBrowserSpeech({
        lang: "vi-VN",
        onInterim: setInterimTranscript,
      });
      speechStopRef.current = session.stop;
      speechAbortRef.current = session.abort;
      return;
    }

    try {
      const rec = await recordMicAudio({ maxMs: 20000 });
      mediaStopRef.current = rec.stop;
      mediaDoneRef.current = rec.done;
    } catch {
      setListening(false);
      setError("Không truy cập được micro. Cho phép mic hoặc gõ câu hỏi.");
    }
  }

  async function stopListeningAndSend(opts?: { forImage?: boolean }) {
    if (!listening) return;
    setListening(false);
    const wantImage = Boolean(opts?.forImage || voiceImageIntentRef.current);
    voiceImageIntentRef.current = false;

    let transcript = "";
    if (speechStopRef.current) {
      transcript = ((await speechStopRef.current()) ?? "").trim();
      speechStopRef.current = null;
      speechAbortRef.current = null;
    } else if (mediaDoneRef.current) {
      mediaStopRef.current?.();
      try {
        const blob = await mediaDoneRef.current;
        const b64 = await blobToBase64(blob);
        const stt = await tutorSpeechToText(b64, "vi");
        transcript = (stt.text || "").trim();
      } catch {
        setError("Không chuyển được giọng nói thành chữ.");
      }
      mediaStopRef.current = null;
      mediaDoneRef.current = null;
    }

    setInterimTranscript("");
    if (!transcript) {
      setError(
        wantImage
          ? "Chưa nhận được lời nói. Thử lại hoặc gõ chủ đề ảnh."
          : "Chưa nhận được lời nói. Thử lại hoặc gõ câu hỏi.",
      );
      return;
    }

    if (wantImage || wantsTutorVideo(transcript) || wantsTutorImage(transcript)) {
      if (wantsTutorVideo(transcript) && !wantImage) {
        await runVideoGeneration(transcript, { transcript });
        return;
      }
      await runImageGeneration(transcript, { transcript });
      return;
    }
    setInput(transcript);
    await sendClassMessage(transcript, { transcript });
  }

  async function runImageGeneration(
    text: string,
    opts?: { transcript?: string },
  ) {
    if (!classroomId) {
      setError("Vui lòng chọn lớp trước khi tạo ảnh.");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Bạn cần chọn một lớp ở phía trên — ảnh minh họa gắn với môn của lớp đó.",
        },
      ]);
      return;
    }
    const selected = classrooms.find((c) => c.id === classroomId);
    const classMeta = selected
      ? getClassroomMeta(selected.id, selected.name, selected.description)
      : null;

    setInput("");
    setError("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, transcript: opts?.transcript },
    ]);
    setLoading(true);

    try {
      const data = await generateTutorImage({
        prompt: text,
        classroomId,
        locale: "vi",
        classroomName: selected?.name,
        classroomDescription: selected?.description || "",
        subject: classMeta?.subject,
        knowledges: classMeta?.knowledges,
      });
      const metaParts = [
        selected?.name ? `Lớp: ${selected.name}` : "",
        opts?.transcript ? "Từ giọng nói" : "",
        data.provider?.startsWith("svg") ? "Minh họa SVG (nhanh)" : `Nguồn: ${data.provider}`,
      ].filter(Boolean);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.caption || "Đây là minh họa học tập từ nội dung bạn nhập.",
          imageDataUrl: data.imageDataUrl,
          meta: metaParts.join(" · "),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tạo được ảnh lúc này");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Xin lỗi, tôi không thể tạo minh họa lúc này.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function runVideoGeneration(
    text: string,
    opts?: { transcript?: string },
  ) {
    if (!classroomId) {
      setError("Vui lòng chọn lớp trước khi tạo video.");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Bạn cần chọn một lớp ở phía trên — clip học tập gắn với môn của lớp đó.",
        },
      ]);
      return;
    }
    const selected = classrooms.find((c) => c.id === classroomId);
    const classMeta = selected
      ? getClassroomMeta(selected.id, selected.name, selected.description)
      : null;

    setInput("");
    setError("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, transcript: opts?.transcript },
    ]);
    setLoading(true);

    try {
      const data = await generateTutorVideo({
        prompt: text,
        classroomId,
        locale: "vi",
        classroomName: selected?.name,
        classroomDescription: selected?.description || "",
        subject: classMeta?.subject,
        knowledges: classMeta?.knowledges,
      });
      const metaParts = [
        selected?.name ? `Lớp: ${selected.name}` : "",
        opts?.transcript ? "Từ giọng nói" : "",
        data.provider?.startsWith("svg")
          ? "Clip SVG động (nhanh)"
          : `Nguồn: ${data.provider}`,
        data.durationSec ? `${Math.round(data.durationSec)}s` : "",
      ].filter(Boolean);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.caption || "Đây là clip học tập ngắn từ nội dung bạn nhập.",
          videoDataUrl: data.videoDataUrl,
          videoMimeType: data.mimeType,
          meta: metaParts.join(" · "),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tạo được video lúc này");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Xin lỗi, tôi không thể tạo video lúc này.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function sendClassMessage(
    text: string,
    opts?: { imageDataUrl?: string | null; transcript?: string },
  ) {
    if (!classroomId) {
      setInput("");
      setError("Vui lòng chọn lớp để trò chuyện.");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text || "(Ảnh)" },
        {
          role: "assistant",
          content: "Bạn cần chọn một lớp ở phía trên — gia sư chỉ hỗ trợ trong phạm vi lớp đó.",
        },
      ]);
      return;
    }

    const selected = classrooms.find((c) => c.id === classroomId);
    const classMeta = selected
      ? getClassroomMeta(selected.id, selected.name, selected.description)
      : null;

    const imageDataUrl = opts?.imageDataUrl ?? attachedImage;
    const modality = imageDataUrl ? "image" : opts?.transcript ? "voice" : "text";
    const messageText =
      (text ?? "").trim() ||
      (imageDataUrl
        ? "Mô tả ảnh này và giúp tôi học tiếng Anh từ nội dung."
        : "");

    if (!messageText && !imageDataUrl) return;

    setInput("");
    setAttachedImage(null);
    setError("");
    const prior = buildTutorHistory(messages, messageText);
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: messageText || "(Ảnh)",
        imageDataUrl: imageDataUrl || undefined,
        transcript: opts?.transcript,
        meta: opts?.transcript ? `Bản ghi: ${opts.transcript}` : undefined,
      },
    ]);

    setLoading(true);
    const body = {
      message: messageText,
      locale: "vi",
      classroomId,
      modality: modality as "text" | "voice" | "image",
      mediaBase64: imageDataUrl || undefined,
      messages: prior,
      classroomName: selected?.name,
      classroomDescription: selected?.description || "",
      subject: classMeta?.subject,
      knowledges: classMeta?.knowledges,
    };

    let startedAssistant = false;
    const appendDelta = (delta: string) => {
      if (!startedAssistant) {
        startedAssistant = true;
        setLoading(false);
        setMessages((prev) => [...prev, { role: "assistant", content: delta }]);
        return;
      }
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") {
          return [...next, { role: "assistant", content: delta }];
        }
        next[next.length - 1] = { ...last, content: last.content + delta };
        return next;
      });
    };

    try {
      await tutorChatStreaming(body, {
        onDelta: appendDelta,
        onMeta: ({ grounded, sources, mode: replyMode, transcript }) => {
          const base = tutorMetaFromSources(
            grounded,
            sources,
            replyMode,
            selected?.name,
          );
          const meta = transcript ? `${base} · Thị giác/STT` : base;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, meta };
            }
            return next;
          });
        },
        onError: (message) => setError(message),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gia sư AI tạm thời không khả dụng");
      if (!startedAssistant) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Xin lỗi, tôi không thể trả lời lúc này.",
          },
        ]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = (input ?? "").trim() || (interimTranscript ?? "").trim();
    if (loading) return;

    if (mode === "help") {
      if (!text) return;
      setInput("");
      setError("");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: answerAppHelp(text) },
      ]);
      return;
    }

    if (!text && !attachedImage) return;

    if (attachedImage) {
      await sendClassMessage(text, { imageDataUrl: attachedImage });
      return;
    }

    if (wantsTutorVideo(text)) {
      await runVideoGeneration(text);
      return;
    }

    if (wantsTutorImage(text)) {
      await runImageGeneration(text);
      return;
    }

    await sendClassMessage(text);
  }

  async function handleCreateImage() {
    if (mode !== "class") {
      setError("Chuyển sang chế độ Theo lớp và chọn lớp để tạo minh họa học tập.");
      return;
    }
    if (listening) {
      await stopListeningAndSend({ forImage: true });
      return;
    }
    const text = (input ?? "").trim() || (interimTranscript ?? "").trim();
    if (loading) return;
    if (!text) {
      setError("Vui lòng nhập nội dung (hoặc nói qua Mic) trước khi tạo ảnh.");
      return;
    }
    if (!classroomId) {
      setError("Vui lòng chọn lớp trước khi tạo ảnh.");
      return;
    }
    await runImageGeneration(
      text.startsWith("tạo ảnh") || wantsTutorImage(text) ? text : `minh họa ${text}`,
    );
  }

  async function handleCreateVideo() {
    if (mode !== "class") {
      setError("Chuyển sang chế độ Theo lớp và chọn lớp để tạo video học tập.");
      return;
    }
    if (listening) {
      setListening(false);
      let transcript = "";
      if (speechStopRef.current) {
        transcript = ((await speechStopRef.current()) ?? "").trim();
        speechStopRef.current = null;
        speechAbortRef.current = null;
      }
      setInterimTranscript("");
      if (!transcript) {
        setError("Chưa nhận được lời nói. Thử lại hoặc gõ chủ đề video.");
        return;
      }
      await runVideoGeneration(transcript, { transcript });
      return;
    }
    const text = (input ?? "").trim() || (interimTranscript ?? "").trim();
    if (loading) return;
    if (!text) {
      setError("Vui lòng nhập nội dung (hoặc nói qua Mic) trước khi tạo video.");
      return;
    }
    await runVideoGeneration(
      wantsTutorVideo(text) || text.toLowerCase().startsWith("tạo video")
        ? text
        : `tạo video ${text}`,
    );
  }

  const selectedClassroom = classrooms.find((c) => c.id === classroomId);
  const selectedMeta = selectedClassroom
    ? getClassroomMeta(
        selectedClassroom.id,
        selectedClassroom.name,
        selectedClassroom.description,
      )
    : null;
  const canClassChat = mode !== "class" || Boolean(classroomId);

  const panel = (
    <div className={`mascot-panel${variant === "embedded" ? " mascot-panel--embedded" : ""}`}>
      <div className="mascot-panel-head">
        <div className="mascot-panel-title">
          <MascotMark size={32} />
          <div>
            <strong>AI Mascot</strong>
            <span>Bạn đồng hành học tập</span>
          </div>
        </div>
        {variant === "floating" && (
          <button
            type="button"
            className="mascot-close"
            onClick={() => setOpen(false)}
            aria-label="Đóng mascot"
          >
            ×
          </button>
        )}
      </div>

      <div className="mascot-mode-toggle" role="tablist" aria-label="Chế độ mascot">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "help"}
          className={`mascot-mode-btn${mode === "help" ? " mascot-mode-btn--active" : ""}`}
          onClick={() => switchMode("help")}
        >
          Hỗ trợ app
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "class"}
          className={`mascot-mode-btn${mode === "class" ? " mascot-mode-btn--active" : ""}`}
          onClick={() => switchMode("class")}
        >
          Theo lớp
        </button>
      </div>

      {mode === "class" && (
        <div className="mascot-classroom">
          {classrooms.length > 0 ? (
            <>
              <label className="mascot-classroom-label" htmlFor="mascot-classroom-select">
                Chọn lớp để trò chuyện
              </label>
              <select
                id="mascot-classroom-select"
                className="form-select"
                value={classroomId}
                onChange={(e) => setClassroomId(e.target.value)}
                aria-label="Chọn lớp để trò chuyện"
                required
              >
                <option value="" disabled>
                  Chọn lớp
                </option>
                {classrooms.map((c) => {
                  const meta = getClassroomMeta(c.id, c.name, c.description);
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name} · {subjectLabel(meta.subject)}
                    </option>
                  );
                })}
              </select>
              {selectedClassroom && selectedMeta && (
                <p className="mascot-hint">
                  Đang học: <strong>{selectedClassroom.name}</strong>
                  {" · "}
                  {subjectLabel(selectedMeta.subject)}
                </p>
              )}
            </>
          ) : (
            <p className="mascot-hint">
              Chưa có lớp? <Link href="/home?tab=join">Tham gia lớp</Link> để trò chuyện với gia sư
              theo lớp.
            </p>
          )}
        </div>
      )}

      {error && <div className="alert alert-error mascot-error">{error}</div>}

      <div className="mascot-messages chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-bubble ${msg.role}`}>
            {msg.role === "assistant" ? (
              <FormattedChatContent content={msg.content} />
            ) : (
              <div className="chat-plain">{msg.content}</div>
            )}
            {msg.transcript && msg.role === "user" && (
              <div className="chat-meta">Bản ghi: {msg.transcript}</div>
            )}
            {msg.imageDataUrl && (
              <div className="chat-image-wrap">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={msg.imageDataUrl}
                  alt={msg.content || "Ảnh trong hội thoại"}
                  className="chat-generated-image"
                />
              </div>
            )}
            {msg.videoDataUrl && (
              <div className="chat-image-wrap chat-video-wrap">
                {msg.videoMimeType?.startsWith("video/") ? (
                  <video
                    src={msg.videoDataUrl}
                    className="chat-generated-video"
                    controls
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  <object
                    data={msg.videoDataUrl}
                    type={msg.videoMimeType || "image/svg+xml"}
                    className="chat-generated-video"
                    aria-label={msg.content || "Video học tập"}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={msg.videoDataUrl}
                      alt={msg.content || "Video học tập"}
                      className="chat-generated-video"
                    />
                  </object>
                )}
              </div>
            )}
            {msg.meta && <div className="chat-meta">{msg.meta}</div>}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble assistant" style={{ opacity: 0.6 }}>
            Đang suy nghĩ…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <TutorComposer
        className="mascot-input-row"
        input={input}
        onInputChange={setInput}
        onSubmit={(e) => void handleSend(e)}
        onCreateImage={mode === "class" ? () => void handleCreateImage() : undefined}
        onCreateVideo={mode === "class" ? () => void handleCreateVideo() : undefined}
        showImageButton={mode === "class"}
        showVideoButton={mode === "class"}
        onAttachImage={(file) => void attachImageFile(file)}
        onPasteImage={mode === "class" ? (file) => void attachImageFile(file) : undefined}
        attachedImageUrl={mode === "class" ? attachedImage : null}
        onClearAttach={() => setAttachedImage(null)}
        listening={listening}
        interimTranscript={interimTranscript}
        loading={loading}
        disabled={!canClassChat}
        placeholder={
          mode === "help"
            ? "Vd: Làm sao tham gia lớp?"
            : canClassChat
              ? "Vd: Ôn grammar · Mic · Tạo ảnh / video"
              : "Chọn lớp để bắt đầu…"
        }
        onMicToggle={() => {
          if (mode !== "class") {
            setError("Chuyển sang Theo lớp để dùng mic.");
            return;
          }
          if (listening) {
            void stopListeningAndSend();
          } else {
            void startListening({ hold: false });
          }
        }}
        onMicHoldStart={() => {
          if (mode === "class" && !listening) void startListening({ hold: true });
        }}
        onMicHoldEnd={() => {
          if (listening && holdModeRef.current) {
            void stopListeningAndSend();
          }
        }}
      />
    </div>
  );

  if (variant === "embedded") {
    return <div className="mascot-embed-root">{panel}</div>;
  }

  return (
    <div className="mascot-host">
      {open && panel}
      <button
        type="button"
        className={`mascot-fab${open ? " mascot-fab--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Đóng AI Mascot" : "Mở AI Mascot"}
      >
        <MascotMark size={36} />
      </button>
    </div>
  );
}
