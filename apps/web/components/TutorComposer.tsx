"use client";

import { FormEvent, useRef } from "react";

export interface TutorComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onCreateImage?: () => void;
  onCreateVideo?: () => void;
  onAttachImage: (file: File) => void;
  onPasteImage?: (file: File) => void;
  /** Toggle mic (click) or push-to-talk end */
  onMicToggle: () => void;
  /** Start push-to-talk (pointer down, held > ~220ms) */
  onMicHoldStart?: () => void;
  /** End push-to-talk */
  onMicHoldEnd?: () => void;
  attachedImageUrl?: string | null;
  onClearAttach?: () => void;
  listening?: boolean;
  interimTranscript?: string;
  loading?: boolean;
  disabled?: boolean;
  showImageButton?: boolean;
  showVideoButton?: boolean;
  placeholder?: string;
  className?: string;
}

export default function TutorComposer({
  input,
  onInputChange,
  onSubmit,
  onCreateImage,
  onCreateVideo,
  onAttachImage,
  onPasteImage,
  onMicToggle,
  onMicHoldStart,
  onMicHoldEnd,
  attachedImageUrl,
  onClearAttach,
  listening = false,
  interimTranscript = "",
  loading = false,
  disabled = false,
  showImageButton = true,
  showVideoButton = true,
  placeholder = "Nhập câu hỏi…",
  className = "",
}: TutorComposerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const ptrStartRef = useRef(0);
  const holdActiveRef = useRef(false);
  const inputText = (input ?? "").trim();
  const interimText = (interimTranscript ?? "").trim();

  return (
    <form className={`chat-input-row tutor-composer ${(className ?? "").trim()}`.trim()} onSubmit={onSubmit}>
      {(attachedImageUrl || interimTranscript || listening) && (
        <div className="tutor-composer-extras">
          {attachedImageUrl && (
            <div className="tutor-attach-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachedImageUrl} alt="Ảnh đính kèm" />
              {onClearAttach && (
                <button
                  type="button"
                  className="tutor-attach-clear"
                  onClick={onClearAttach}
                  aria-label="Xóa ảnh đính kèm"
                >
                  ×
                </button>
              )}
              <span>Ảnh đính kèm</span>
            </div>
          )}
          {(listening || interimTranscript) && (
            <div className={`tutor-listening-chip${listening ? " is-live" : ""}`}>
              {listening ? "Đang nghe…" : "Bản ghi"}
              {interimTranscript ? `: ${interimTranscript}` : ""}
            </div>
          )}
        </div>
      )}

      <div className="tutor-composer-toolbar">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onAttachImage(file);
          }}
        />
        <button
          type="button"
          className={`btn btn-ghost btn-sm tutor-tool-btn${listening ? " tutor-tool-btn--live" : ""}`}
          disabled={loading || disabled}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            ptrStartRef.current = Date.now();
            holdActiveRef.current = false;
            (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
            window.setTimeout(() => {
              if (ptrStartRef.current && Date.now() - ptrStartRef.current >= 220) {
                holdActiveRef.current = true;
                onMicHoldStart?.();
              }
            }, 220);
          }}
          onPointerUp={() => {
            const held = Date.now() - ptrStartRef.current;
            ptrStartRef.current = 0;
            if (holdActiveRef.current || held >= 220) {
              holdActiveRef.current = false;
              onMicHoldEnd?.();
              return;
            }
            onMicToggle();
          }}
          onPointerCancel={() => {
            ptrStartRef.current = 0;
            if (holdActiveRef.current) {
              holdActiveRef.current = false;
              onMicHoldEnd?.();
            }
          }}
          title="Bấm để bật/tắt mic · Giữ để nói"
          aria-label={listening ? "Dừng ghi âm" : "Bật mic"}
          aria-pressed={listening}
        >
          {listening ? "Dừng" : "Mic"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm tutor-tool-btn"
          disabled={loading || disabled}
          onClick={() => fileRef.current?.click()}
          title="Đính kèm ảnh (mô tả / học từ ảnh)"
          aria-label="Đính kèm ảnh"
        >
          Ảnh
        </button>
        <input
          type="text"
          className="form-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items || !onPasteImage) return;
            for (let i = 0; i < items.length; i += 1) {
              const item = items[i];
              if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                  e.preventDefault();
                  onPasteImage(file);
                  return;
                }
              }
            }
          }}
          placeholder={placeholder}
          disabled={loading || disabled}
        />
        {showImageButton && onCreateImage && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading || disabled || (!inputText && !listening)}
            onClick={() => onCreateImage()}
            title="Tạo minh họa học tập từ nội dung / giọng nói"
          >
            Tạo ảnh
          </button>
        )}
        {showVideoButton && onCreateVideo && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading || disabled || (!inputText && !listening)}
            onClick={() => onCreateVideo()}
            title="Tạo clip học tập ngắn (slide động) từ nội dung"
          >
            Tạo video
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            loading || disabled || (!inputText && !attachedImageUrl && !interimText)
          }
        >
          Gửi
        </button>
      </div>
    </form>
  );
}
