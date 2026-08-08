"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  imageDataUrl?: string;
  videoDataUrl?: string;
  videoMimeType?: string;
  transcript?: string;
}

const WELCOME =
  "Xin chào! Hãy chọn lớp học trước — gia sư chỉ hỗ trợ trong phạm vi môn và bài của lớp đó. Dùng **Mic** / **Ảnh** / **Tạo ảnh** / **Tạo video**, hoặc gõ «vẽ …» / «tạo video …».";

function pickDefaultClassroom(list: Classroom[], presetId: string): string {
  if (presetId && list.some((c) => c.id === presetId)) return presetId;
  if (list.length === 1) return list[0].id;
  const english = list.find((c) =>
    isEnglishSubject(getClassroomMeta(c.id, c.name, c.description).subject),
  );
  return english?.id || list[0]?.id || "";
}

export default function TutorInner() {
  const searchParams = useSearchParams();
  const presetClassroomId = searchParams.get("classroomId") || "";

  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: WELCOME },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [classroomId, setClassroomId] = useState(presetClassroomId);
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
    apiFetch<Classroom[]>("/api/v1/classrooms")
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setClassrooms(list);
        setClassroomId((cur) => pickDefaultClassroom(list, cur || presetClassroomId));
      })
      .catch(() => {});
  }, [presetClassroomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!classroomId) return;
    if (prevClassRef.current && prevClassRef.current !== classroomId) {
      const selected = classrooms.find((c) => c.id === classroomId);
      const meta = selected
        ? getClassroomMeta(selected.id, selected.name, selected.description)
        : null;
      setMessages([
        {
          role: "assistant",
          content: selected
            ? `Đã chuyển sang lớp **${selected.name}** (${subjectLabel(meta?.subject || "Other")}). Hỏi trong phạm vi môn này nhé.`
            : WELCOME,
        },
      ]);
      setError("");
      setAttachedImage(null);
    }
    prevClassRef.current = classroomId;
  }, [classroomId, classrooms]);

  useEffect(() => {
    return () => {
      speechAbortRef.current?.();
      mediaStopRef.current?.();
    };
  }, []);

  async function attachImageFile(file: File) {
    try {
      const dataUrl = await fileToTutorImageDataUrl(file);
      setAttachedImage(dataUrl);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được ảnh");
    }
  }

  async function startListening(opts?: { hold?: boolean; forImage?: boolean }) {
    if (listening || loading) return;
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
    await sendTutorMessage(transcript, { transcript });
  }

  async function runImageGeneration(
    text: string,
    opts?: { transcript?: string; skipUserBubble?: boolean },
  ) {
    if (!classroomId) {
      setError("Vui lòng chọn lớp học trước khi tạo ảnh.");
      return;
    }
    const selected = classrooms.find((c) => c.id === classroomId);
    const classMeta = selected
      ? getClassroomMeta(selected.id, selected.name, selected.description)
      : null;

    setInput("");
    setError("");
    if (!opts?.skipUserBubble) {
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          content: text,
          transcript: opts?.transcript,
        },
      ]);
    }
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
    opts?: { transcript?: string; skipUserBubble?: boolean },
  ) {
    if (!classroomId) {
      setError("Vui lòng chọn lớp học trước khi tạo video.");
      return;
    }
    const selected = classrooms.find((c) => c.id === classroomId);
    const classMeta = selected
      ? getClassroomMeta(selected.id, selected.name, selected.description)
      : null;

    setInput("");
    setError("");
    if (!opts?.skipUserBubble) {
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          content: text,
          transcript: opts?.transcript,
        },
      ]);
    }
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

  async function sendTutorMessage(
    text: string,
    opts?: { imageDataUrl?: string | null; transcript?: string },
  ) {
    if (!classroomId) {
      setError("Vui lòng chọn lớp học trước khi hỏi gia sư.");
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
        onMeta: ({ grounded, sources, mode, transcript }) => {
          const base = tutorMetaFromSources(grounded, sources, mode, selected?.name);
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
    if (!text && !attachedImage) return;

    if (!classroomId) {
      setError("Vui lòng chọn lớp học trước khi hỏi gia sư.");
      return;
    }

    if (attachedImage) {
      await sendTutorMessage(text, { imageDataUrl: attachedImage });
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

    await sendTutorMessage(text);
  }

  async function handleCreateImage() {
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
      setError("Vui lòng chọn lớp học trước khi tạo ảnh.");
      return;
    }
    await runImageGeneration(
      text.startsWith("tạo ảnh") || wantsTutorImage(text) ? text : `minh họa ${text}`,
    );
  }

  async function handleCreateVideo() {
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

  const selected = classrooms.find((c) => c.id === classroomId);
  const selectedMeta = selected
    ? getClassroomMeta(selected.id, selected.name, selected.description)
    : null;
  const canChat = Boolean(classroomId) && classrooms.length > 0;

  return (
    <div className="tutor-root">
      <div className="page-title-row">
        <div>
          <h1>AI Tutor</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Đa phương thức · gắn lớp · nhớ hội thoại trong phiên
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {classroomId && (
            <Link href={`/student/classrooms/${classroomId}`} className="btn btn-secondary btn-sm">
              Xem lớp
            </Link>
          )}
          <Link href="/home" className="btn btn-ghost btn-sm">
            ← Trang chủ
          </Link>
        </div>
      </div>

      {classrooms.length > 0 ? (
        <div className="form-group" style={{ marginTop: "1rem" }}>
          <label className="form-label" htmlFor="classroomSelect">
            Lớp học (bắt buộc)
          </label>
          <select
            id="classroomSelect"
            className="form-select"
            value={classroomId}
            onChange={(e) => setClassroomId(e.target.value)}
            required
          >
            <option value="" disabled>
              — Chọn lớp —
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
          {selected && selectedMeta && (
            <p style={{ marginTop: "0.5rem", color: "var(--text-muted)", fontSize: "0.9rem" }}>
              Đang học: <strong>{selected.name}</strong>
              {" · "}
              {subjectLabel(selectedMeta.subject)}
              {selectedMeta.knowledges && selectedMeta.knowledges.length > 0
                ? ` · ${selectedMeta.knowledges.join(", ")}`
                : ""}
            </p>
          )}
        </div>
      ) : (
        <div className="alert alert-info" style={{ marginTop: "1rem" }}>
          Bạn chưa tham gia lớp.{" "}
          <Link href="/student/join">Tham gia lớp</Link> để dùng gia sư AI theo môn học.
        </div>
      )}

      {error && (
        <div className="alert alert-error" style={{ marginTop: "0.75rem" }}>
          {error}
        </div>
      )}

      <div className="card chat-container" style={{ marginTop: "1rem" }}>
        <div className="chat-messages">
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
          input={input}
          onInputChange={setInput}
          onSubmit={(e) => void handleSend(e)}
          onCreateImage={() => void handleCreateImage()}
          onCreateVideo={() => void handleCreateVideo()}
          onAttachImage={(file) => void attachImageFile(file)}
          onPasteImage={(file) => void attachImageFile(file)}
          attachedImageUrl={attachedImage}
          onClearAttach={() => setAttachedImage(null)}
          listening={listening}
          interimTranscript={interimTranscript}
          loading={loading}
          disabled={!canChat}
          placeholder={
            canChat
              ? "Vd: Present simple · Mic · Tạo ảnh / video"
              : "Chọn lớp học để bắt đầu…"
          }
          onMicToggle={() => {
            if (listening) {
              void stopListeningAndSend();
            } else {
              void startListening({ hold: false });
            }
          }}
          onMicHoldStart={() => {
            if (!listening) void startListening({ hold: true });
          }}
          onMicHoldEnd={() => {
            if (listening && holdModeRef.current) {
              void stopListeningAndSend();
            }
          }}
        />
      </div>
    </div>
  );
}
