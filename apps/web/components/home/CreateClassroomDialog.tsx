"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import CoverCropDialog from "@/components/home/CoverCropDialog";
import { apiFetch, generateTutorImage } from "@/lib/api";
import {
  CLASSROOM_SUBJECT_GROUPS,
  ClassroomSubject,
  fileToCoverDataUrl,
  normalizeKnowledges,
  saveClassroomMeta,
  SUBJECT_COVERS,
  subjectLabel,
} from "@/lib/classroomMeta";
import { ensureRasterDataUrl } from "@/lib/cropImage";
import {
  detectClassroomSubject,
  detectClassroomSubjectLocal,
} from "@/lib/detectSubject";
import type { Classroom } from "@/lib/types";

export type CreateClassroomDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (classroom: Classroom) => void;
};

function buildCoverPrompt(
  name: string,
  description: string,
  subject: ClassroomSubject,
  knowledges: string[],
): string {
  const topics = (knowledges ?? []).slice(0, 4).join(", ");
  const desc = (description ?? "").trim().slice(0, 180);
  const className = (name ?? "").trim();
  return [
    "Cartoon classroom cover illustration, friendly educational style,",
    "bright colors, clean vector look, no photorealism, no text overlays,",
    `subject ${subjectLabel(subject)}.`,
    className ? `Class: ${className}.` : "",
    desc ? `Theme: ${desc}.` : "",
    topics ? `Topics: ${topics}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export default function CreateClassroomDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateClassroomDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [subject, setSubject] = useState<ClassroomSubject>("English");
  const [knowledges, setKnowledges] = useState<string[]>([]);
  const [suggestedKnowledges, setSuggestedKnowledges] = useState<string[]>([]);
  const [customKnowledge, setCustomKnowledge] = useState("");
  const [coverImage, setCoverImage] = useState(SUBJECT_COVERS.English[0]);
  const [customCover, setCustomCover] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [detectSource, setDetectSource] = useState<"ai" | "heuristic" | null>(null);
  const [detectConfidence, setDetectConfidence] = useState(0);
  const [subjectLocked, setSubjectLocked] = useState(false);
  const [knowledgesLocked, setKnowledgesLocked] = useState(false);
  const [error, setError] = useState("");
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detectSeq = useRef(0);

  const activeCover = customCover || coverImage;

  function resetForm() {
    setName("");
    setDescription("");
    setSubject("English");
    setKnowledges([]);
    setSuggestedKnowledges([]);
    setCustomKnowledge("");
    setCoverImage(SUBJECT_COVERS.English[0]);
    setCustomCover(null);
    setDetectSource(null);
    setDetectConfidence(0);
    setSubjectLocked(false);
    setKnowledgesLocked(false);
    setError("");
    setDetecting(false);
    setGeneratingCover(false);
    setCreating(false);
    setUploadBusy(false);
    setCropOpen(false);
    setCropSrc(null);
  }

  useEffect(() => {
    if (open) resetForm();
  }, [open]);

  useEffect(() => {
    if (customCover) return;
    setCoverImage((SUBJECT_COVERS[subject] ?? SUBJECT_COVERS.Other)[0]);
  }, [subject, customCover]);

  async function runAnalyze(opts?: { force?: boolean }) {
    const text = `${name} ${description}`.trim();
    if (!text) {
      setDetectSource(null);
      setDetectConfidence(0);
      if (!knowledgesLocked) {
        setKnowledges([]);
        setSuggestedKnowledges([]);
      }
      return;
    }

    const seq = ++detectSeq.current;
    const local = detectClassroomSubjectLocal(name, description);
    if (!subjectLocked) setSubject(local.subject);
    if (!knowledgesLocked || opts?.force) {
      setKnowledges(local.knowledges);
      setSuggestedKnowledges(local.knowledges);
      if (opts?.force) setKnowledgesLocked(false);
    }
    setDetectSource("heuristic");
    setDetectConfidence(local.confidence);
    setDetecting(true);

    try {
      const result = await detectClassroomSubject(name, description);
      if (seq !== detectSeq.current) return;
      if (!subjectLocked) setSubject(result.subject);
      if (!knowledgesLocked || opts?.force) {
        setKnowledges(result.knowledges);
        setSuggestedKnowledges(result.knowledges);
      } else {
        setSuggestedKnowledges(result.knowledges);
      }
      setDetectSource(result.source);
      setDetectConfidence(result.confidence);
    } finally {
      if (seq === detectSeq.current) setDetecting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const text = `${name} ${description}`.trim();
    if (!text) {
      setDetectSource(null);
      setDetectConfidence(0);
      if (!knowledgesLocked) {
        setKnowledges([]);
        setSuggestedKnowledges([]);
      }
      return;
    }

    const timer = window.setTimeout(() => {
      void runAnalyze();
    }, 700);

    return () => window.clearTimeout(timer);
    // intentionally re-run on name/description; locks read latest via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, open]);

  function toggleKnowledge(label: string) {
    setKnowledgesLocked(true);
    setKnowledges((prev) => {
      if (prev.some((k) => k.toLowerCase() === label.toLowerCase())) {
        return prev.filter((k) => k.toLowerCase() !== label.toLowerCase());
      }
      return normalizeKnowledges([...prev, label]);
    });
  }

  function addCustomKnowledge() {
    const label = customKnowledge.trim();
    if (!label) return;
    setKnowledgesLocked(true);
    setKnowledges((prev) => normalizeKnowledges([...prev, label]));
    setSuggestedKnowledges((prev) => normalizeKnowledges([...prev, label]));
    setCustomKnowledge("");
  }

  async function openCropFor(src: string) {
    setError("");
    setUploadBusy(true);
    try {
      const raster = await ensureRasterDataUrl(src);
      setCropSrc(raster);
      setCropOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không mở được trình cắt ảnh");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadBusy(true);
    setError("");
    try {
      const dataUrl = await fileToCoverDataUrl(file);
      setCustomCover(dataUrl);
      setCoverImage(dataUrl);
      const raster = await ensureRasterDataUrl(dataUrl);
      setCropSrc(raster);
      setCropOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tải ảnh thất bại");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleGenerateCover() {
    const text = `${name ?? ""} ${description ?? ""}`.trim();
    if (!text) {
      setError("Nhập tên hoặc mô tả trước khi tạo ảnh bìa AI");
      return;
    }
    const prompt = buildCoverPrompt(name, description, subject, knowledges);
    if (!(prompt ?? "").trim()) {
      setError("Nhập tên hoặc mô tả trước khi tạo ảnh bìa AI");
      return;
    }
    setGeneratingCover(true);
    setError("");
    try {
      const data = await generateTutorImage({
        prompt,
        locale: "vi",
        classroomName: (name ?? "").trim() || undefined,
        classroomDescription: (description ?? "").trim() || undefined,
        subject,
        knowledges,
        style: "cartoon_cover",
      });
      const raster = await ensureRasterDataUrl(data.imageDataUrl);
      setCustomCover(raster);
      setCoverImage(raster);
      setCropSrc(raster);
      setCropOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tạo ảnh bìa thất bại");
    } finally {
      setGeneratingCover(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");

    try {
      const created = await apiFetch<Classroom>("/api/v1/classrooms", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      saveClassroomMeta(created.id, {
        subject,
        coverImage: activeCover,
        knowledges,
      });
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tạo lớp thất bại");
    } finally {
      setCreating(false);
    }
  }

  const chipPool = normalizeKnowledges([...suggestedKnowledges, ...knowledges]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Tạo lớp học</DialogTitle>
            <DialogDescription>
              Nhập tên và mô tả — AI gợi ý môn, kiến thức và ảnh bìa cartoon; bạn có thể cắt ảnh trước khi lưu.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => void handleCreate(e)} className="grid gap-4">
            {error && <div className="alert alert-error">{error}</div>}

            <div className="form-group">
              <label className="form-label" htmlFor="homeClassName">
                Tên lớp
              </label>
              <input
                id="homeClassName"
                className="form-input"
                value={name}
                onChange={(e) => {
                  setSubjectLocked(false);
                  setName(e.target.value);
                }}
                required
                placeholder="Tiếng Anh 101"
                autoFocus
              />
            </div>

            <div className="form-group">
              <div className="tc-field-head">
                <label className="form-label" htmlFor="homeClassDesc">
                  Mô tả
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={detecting || !`${name} ${description}`.trim()}
                  onClick={() => void runAnalyze({ force: true })}
                >
                  {detecting ? "Đang phân tích…" : "Phân tích AI"}
                </button>
              </div>
              <textarea
                id="homeClassDesc"
                className="form-textarea"
                value={description}
                onChange={(e) => {
                  setSubjectLocked(false);
                  setDescription(e.target.value);
                }}
                onBlur={() => {
                  if (`${name} ${description}`.trim()) void runAnalyze();
                }}
                placeholder="Ví dụ: Luyện IELTS speaking & writing, ngữ pháp và từ vựng…"
                rows={4}
              />
            </div>

            <section className="tc-ai-subject" aria-live="polite">
              <div className="tc-ai-subject-head">
                <h3>Môn chính</h3>
                <span className={`tc-ai-pill ${detecting ? "is-busy" : ""}`}>
                  {detecting
                    ? "AI đang phân tích…"
                    : detectSource === "ai"
                      ? "AI phát hiện"
                      : "Gợi ý nhanh"}
                </span>
              </div>
              <div className="tc-ai-subject-body">
                <strong className="tc-ai-subject-value">{subjectLabel(subject)}</strong>
                <p>
                  {detecting
                    ? "Đã điền tạm bằng gợi ý nhanh — đang tinh chỉnh bằng AI…"
                    : detectConfidence > 0
                      ? `Độ tin cậy ~${Math.round(detectConfidence * 100)}% — chỉnh lại nếu cần.`
                      : "Nhập mô tả hoặc bấm Phân tích AI."}
                </p>
                <label className="form-label" htmlFor="homeClassSubjectOverride">
                  Chỉnh môn (tùy chọn)
                </label>
                <select
                  id="homeClassSubjectOverride"
                  className="form-select"
                  value={subject}
                  onChange={(e) => {
                    setSubjectLocked(true);
                    setSubject(e.target.value as ClassroomSubject);
                  }}
                >
                  {CLASSROOM_SUBJECT_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.subjects.map((s) => (
                        <option key={s} value={s}>
                          {subjectLabel(s)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </section>

            <section className="tc-ai-subject tc-ai-knowledges" aria-live="polite">
              <div className="tc-ai-subject-head">
                <h3>Kiến thức chính</h3>
                <span className={`tc-ai-pill ${detecting ? "is-busy" : ""}`}>
                  {detecting ? "Đang phát hiện…" : "Bấm chip để chọn/bỏ"}
                </span>
              </div>
              {chipPool.length === 0 ? (
                <p className="tc-ai-subject-body" style={{ margin: 0 }}>
                  {detecting
                    ? "AI đang trích xuất kiến thức chính…"
                    : "Nhập mô tả hoặc bấm Phân tích AI để gợi ý kiến thức."}
                </p>
              ) : (
                <div className="tc-knowledge-chips tc-knowledge-chips--lg tc-knowledge-chips--editable">
                  {chipPool.map((k) => {
                    const selected = knowledges.some(
                      (x) => x.toLowerCase() === k.toLowerCase(),
                    );
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`tc-knowledge-chip tc-knowledge-chip--btn ${selected ? "is-selected" : ""}`}
                        onClick={() => toggleKnowledge(k)}
                        aria-pressed={selected}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="tc-knowledge-add">
                <input
                  className="form-input"
                  value={customKnowledge}
                  onChange={(e) => setCustomKnowledge(e.target.value)}
                  placeholder="Thêm kiến thức…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomKnowledge();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!customKnowledge.trim()}
                  onClick={addCustomKnowledge}
                >
                  Thêm
                </button>
              </div>
            </section>

            <div className="form-group">
              <div className="tc-field-head">
                <span className="form-label">Ảnh bìa</span>
                <span className={`tc-ai-pill ${generatingCover ? "is-busy" : ""}`}>
                  {generatingCover ? "Đang vẽ cartoon…" : "Cartoon / tải lên"}
                </span>
              </div>
              <div
                className="tc-cover-preview"
                style={{ backgroundImage: `url(${activeCover})` }}
                aria-hidden
              />
              <div className="tc-upload-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="tc-file-input"
                  onChange={(e) => void handleUpload(e)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={generatingCover || !`${name} ${description}`.trim()}
                  onClick={() => void handleGenerateCover()}
                >
                  {generatingCover ? "Đang tạo…" : "Tạo ảnh cartoon"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={uploadBusy || generatingCover}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadBusy ? "Đang tải…" : "Tải ảnh lên"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!activeCover || uploadBusy || generatingCover}
                  onClick={() => void openCropFor(activeCover)}
                >
                  Cắt ảnh
                </button>
                {customCover && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setCustomCover(null);
                      setCoverImage((SUBJECT_COVERS[subject] ?? SUBJECT_COVERS.Other)[0]);
                    }}
                  >
                    Dùng ảnh mẫu
                  </button>
                )}
              </div>
              {!customCover && (
                <div className="tc-cover-picker">
                  {(SUBJECT_COVERS[subject] ?? SUBJECT_COVERS.Other).map((url) => (
                    <button
                      key={url}
                      type="button"
                      className={`tc-cover-option ${coverImage === url ? "is-selected" : ""}`}
                      style={{ backgroundImage: `url(${url})` }}
                      onClick={() => setCoverImage(url)}
                      aria-label="Chọn ảnh bìa"
                    />
                  ))}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={creating || generatingCover}
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={creating || generatingCover || !name.trim()}
              >
                {creating ? "Đang tạo…" : "Tạo lớp"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CoverCropDialog
        open={cropOpen}
        imageSrc={cropSrc}
        onOpenChange={setCropOpen}
        onCropped={(dataUrl) => {
          setCustomCover(dataUrl);
          setCoverImage(dataUrl);
        }}
      />
    </>
  );
}
