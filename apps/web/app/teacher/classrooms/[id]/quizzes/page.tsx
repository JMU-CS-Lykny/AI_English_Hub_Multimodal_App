"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import PaginationBar, { pageCount, slicePage } from "@/components/PaginationBar";
import SiteHeader from "@/components/SiteHeader";
import { API_BASE, apiFetch } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import {
  CEFR_LEVEL_OPTIONS,
  CLASS_LEVEL_OPTIONS,
  getClassroomMeta,
  isEnglishSubject,
} from "@/lib/classroomMeta";
import type {
  Classroom,
  GenerateQuizResponse,
  QuestionType,
  Quiz,
  QuizAttempt,
  QuizQuestion,
  QuizStatus,
} from "@/lib/types";

const DEFAULT_STYLE_ENGLISH =
  "Trắc nghiệm 4 đáp án, bám CEFR. Câu hỏi tiếng Anh thực tế theo chủ đề — không chép tên/mô tả lớp vào đề.";

const DEFAULT_STYLE_CLASS =
  "Trắc nghiệm 4 đáp án bằng tiếng Việt (nếu lớp/mô tả tiếng Việt), đúng môn học (Lịch sử/Toán/…). Không hỏi meta luyện tiếng Anh/ESL. Không chép tên/mô tả lớp vào đề.";

const PLACEHOLDERS = {
  topic:
    "VD: Tên lớp + mô tả lớp (dùng làm ngữ cảnh chủ đề, không phải nội dung câu hỏi)",
  styleEnglish:
    "VD: Trắc nghiệm 4 đáp án, bám CEFR, tiếng Anh thực tế trong lớp",
  styleClass:
    "VD: Trắc nghiệm 4 đáp án theo chương trình phổ thông, phù hợp khối lớp",
  count: "VD: 5",
  studentContextEnglish:
    "VD: Học sinh lớp 10, cần luyện thêm thì hiện tại hoàn thành",
  studentContextClass:
    "VD: Học sinh yếu phần lý thuyết chương 2, cần câu hỏi vừa sức",
  quizTitleEnglish: "VD: Tiếng Anh lớp 10 · B1",
  quizTitleClass: "VD: Toán 10 · Lớp 10",
  prompt: "VD: Chọn dạng đúng: She ___ in Hanoi since 2020.",
  choices: "VD: has lived | lived | is living | lives",
  answerMcq: "VD: A hoặc has lived",
} as const;

function normalizeQuizStatus(status?: QuizStatus | string | null): QuizStatus {
  return String(status || "DRAFT").toUpperCase() === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
}

function QuizStatusBadge({ status }: { status?: QuizStatus | string | null }) {
  const normalized = normalizeQuizStatus(status);
  const isPublished = normalized === "PUBLISHED";
  return (
    <span
      className={`quiz-status-badge ${
        isPublished ? "quiz-status-badge--published" : "quiz-status-badge--draft"
      }`}
    >
      {isPublished ? "Đã xuất bản" : "Bản nháp"}
    </span>
  );
}

function asArray<T>(data: T | T[] | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/** Full classroom context for AI topic (title + complete description). */
function topicFromClassroom(cls: Classroom | null | undefined): string {
  if (!cls) return "";
  const name = (cls.name || "").trim();
  const desc = (cls.description || "").trim();
  if (name && desc) return `${name}\n\n${desc}`;
  return name || desc;
}

function styleFromClassroom(english: boolean): string {
  return english ? DEFAULT_STYLE_ENGLISH : DEFAULT_STYLE_CLASS;
}

function titleFromClassroom(cls: Classroom | null | undefined, level: string): string {
  const name = (cls?.name || "").trim() || "Bài kiểm tra";
  const lvl = (level || "").trim() || "B1";
  return `${name} · ${lvl}`;
}

const CEFR_IN_TITLE = /\b(A1|A2|B1|B2|C1|C2)\b/i;
const CLASS_LEVEL_IN_TITLE =
  /\b(Lớp\s*(?:6|7|8|9|10|11|12)|Đại học|Khác)\b/i;

function ensureLevelInTitle(raw: string, level: string, english: boolean): string {
  const lvl = (level || "").trim() || (english ? "B1" : "Lớp 10");
  const t = (raw || "").trim();
  if (!t) return `Bài kiểm tra · ${lvl}`;
  if (t.toLowerCase().includes(lvl.toLowerCase())) return t;
  if (english && CEFR_IN_TITLE.test(t)) {
    return t.replace(CEFR_IN_TITLE, lvl);
  }
  if (!english && CLASS_LEVEL_IN_TITLE.test(t)) {
    return t.replace(CLASS_LEVEL_IN_TITLE, lvl);
  }
  if (english && /\bQuiz\b/i.test(t)) {
    return t.replace(/\bQuiz\b/i, `${lvl} Quiz`);
  }
  return `${t} · ${lvl}`;
}

function parseQuestions(json: string | undefined): QuizQuestion[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as QuizQuestion[];
    if (!Array.isArray(raw)) return [];
    return raw.map((q, i) => ({
      id: q.id || `q-${i}`,
      prompt: q.prompt || "",
      type: "mcq" as QuestionType,
      choices:
        Array.isArray(q.choices) && q.choices.length >= 2
          ? [...q.choices, "", "", "", ""].slice(0, 4)
          : ["", "", "", ""],
      answer: q.answer || "",
    }));
  } catch {
    return [];
  }
}

function emptyRow(): QuizQuestion {
  return {
    id: crypto.randomUUID(),
    prompt: "",
    type: "mcq",
    choices: ["", "", "", ""],
    answer: "",
  };
}

function QuizzesContent() {
  const params = useParams();
  const router = useRouter();
  const classroomId = String(params.id || "");

  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingQuizzes, setDeletingQuizzes] = useState(false);
  const [deletingClassroom, setDeletingClassroom] = useState(false);
  const [confirmDeleteQuizzesOpen, setConfirmDeleteQuizzesOpen] = useState(false);
  const [confirmDeleteClassroomOpen, setConfirmDeleteClassroomOpen] = useState(false);
  const [quizPage, setQuizPage] = useState(1);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [rows, setRows] = useState<QuizQuestion[]>([emptyRow()]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);

  const [aiTopic, setAiTopic] = useState("");
  const [aiStyle, setAiStyle] = useState(DEFAULT_STYLE_ENGLISH);
  const [aiCount, setAiCount] = useState(5);
  const [aiCefr, setAiCefr] = useState("B1");
  const [aiClassLevel, setAiClassLevel] = useState<string>("Lớp 10");
  const [aiStudentContext, setAiStudentContext] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrefillDone, setAiPrefillDone] = useState(false);

  const classroomSubject = useMemo(() => {
    if (!classroom) return "English" as const;
    return getClassroomMeta(classroom.id, classroom.name, classroom.description).subject;
  }, [classroom]);
  const isEnglishClass = isEnglishSubject(classroomSubject);
  const selectedLevel = isEnglishClass ? aiCefr : aiClassLevel;

  const [attemptsQuizId, setAttemptsQuizId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);

  const editingQuiz = useMemo(
    () => quizzes.find((q) => q.id === editingId) || null,
    [quizzes, editingId],
  );

  const editorStatus: QuizStatus =
    editingId === "new" || !editingQuiz
      ? "DRAFT"
      : normalizeQuizStatus(editingQuiz.status);
  const canPublish =
    !!editingId &&
    editingId !== "new" &&
    editorStatus === "DRAFT" &&
    !saving &&
    !publishing;

  const allSelected = quizzes.length > 0 && selectedIds.size === quizzes.length;
  const QUIZ_PAGE_SIZE = 8;
  const quizTotalPages = pageCount(quizzes.length, QUIZ_PAGE_SIZE);
  const quizPageItems = useMemo(
    () => slicePage(quizzes, quizPage, QUIZ_PAGE_SIZE),
    [quizzes, quizPage],
  );

  useEffect(() => {
    if (quizPage > quizTotalPages) setQuizPage(quizTotalPages);
  }, [quizPage, quizTotalPages]);

  const load = useCallback(async () => {
    if (!classroomId) return;
    setLoading(true);
    setError("");
    try {
      const [cls, quizData] = await Promise.all([
        apiFetch<Classroom>(`/api/v1/classrooms/${classroomId}`),
        apiFetch<Quiz[] | Quiz>(`/api/v1/assessments/quizzes?classroomId=${classroomId}`),
      ]);
      setClassroom(cls);
      const list = asArray(quizData);
      setQuizzes(list);
      setSelectedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          if (list.some((q) => q.id === id)) next.add(id);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được bài kiểm tra");
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(quizzes.map((q) => q.id)));
  }

  async function deleteSelectedQuizzes() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setDeletingQuizzes(true);
    setError("");
    setSuccess("");
    try {
      const ids = [...selectedIds];
      for (const id of ids) {
        await apiFetch(`/api/v1/assessments/quizzes/${id}`, { method: "DELETE" });
      }
      if (editingId && selectedIds.has(editingId)) setEditingId(null);
      setSelectedIds(new Set());
      setConfirmDeleteQuizzesOpen(false);
      setSuccess(`Đã xóa ${count} bài kiểm tra`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xóa bài kiểm tra thất bại");
      await load();
    } finally {
      setDeletingQuizzes(false);
    }
  }

  async function deleteClassroom() {
    if (!classroom) return;
    setDeletingClassroom(true);
    setError("");
    try {
      // Quizzes are in assessment-service (no cross-service FK) — clean them first.
      const quizList = asArray(
        await apiFetch<Quiz[] | Quiz>(`/api/v1/assessments/quizzes?classroomId=${classroomId}`),
      );
      for (const quiz of quizList) {
        await apiFetch(`/api/v1/assessments/quizzes/${quiz.id}`, { method: "DELETE" }).catch(
          () => undefined,
        );
      }
      await apiFetch(`/api/v1/classrooms/${classroomId}`, { method: "DELETE" });
      setConfirmDeleteClassroomOpen(false);
      router.replace("/home?tab=classrooms");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xóa lớp thất bại");
      setDeletingClassroom(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setAiPrefillDone(false);
  }, [classroomId]);

  useEffect(() => {
    if (!classroom || aiPrefillDone) return;
    const derivedTopic = topicFromClassroom(classroom);
    if (derivedTopic) setAiTopic(derivedTopic);
    setAiStyle(styleFromClassroom(isEnglishSubject(
      getClassroomMeta(classroom.id, classroom.name, classroom.description).subject,
    )));
    setAiPrefillDone(true);
  }, [classroom, aiPrefillDone]);

  // Keep auto title in sync with selected level while creating a new quiz.
  useEffect(() => {
    if (titleTouched || editingId !== "new") return;
    setTitle(titleFromClassroom(classroom, selectedLevel));
  }, [selectedLevel, classroom, editingId, titleTouched]);

  // When subject flips English ↔ other, refresh default style if still the stock prompt.
  useEffect(() => {
    if (!classroom || !aiPrefillDone) return;
    setAiStyle((prev) => {
      const stockEn = DEFAULT_STYLE_ENGLISH;
      const stockClass = DEFAULT_STYLE_CLASS;
      if (prev === stockEn || prev === stockClass || !prev.trim()) {
        return styleFromClassroom(isEnglishClass);
      }
      return prev;
    });
  }, [isEnglishClass, classroom, aiPrefillDone]);

  function startCreate() {
    setEditingId("new");
    setTitleTouched(false);
    const derivedTopic = topicFromClassroom(classroom);
    setTitle(titleFromClassroom(classroom, selectedLevel));
    setRows([emptyRow()]);
    if (derivedTopic) setAiTopic(derivedTopic);
    setAiStyle(styleFromClassroom(isEnglishClass));
    setSuccess("");
    setError("");
  }

  function startEdit(quiz: Quiz) {
    setEditingId(quiz.id);
    setTitleTouched(true);
    setTitle(quiz.title);
    const parsed = parseQuestions(quiz.questionsJson);
    setRows(parsed.length ? parsed : [emptyRow()]);
    setSuccess("");
    setError("");
  }

  function updateRow(index: number, patch: Partial<QuizQuestion>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function saveDraft(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const questions = rows.map((r) => {
        const choices = (r.choices || []).map((c) => c.trim()).filter(Boolean);
        return {
          id: r.id,
          prompt: r.prompt.trim(),
          type: "mcq" as const,
          answer: (r.answer || "").trim(),
          choices,
        };
      });
      if (!title.trim()) throw new Error("Vui lòng nhập tiêu đề");
      if (questions.some((q) => !q.prompt || !q.answer)) {
        throw new Error("Mỗi câu cần đề bài và đáp án");
      }
      if (questions.some((q) => q.choices.length < 2)) {
        throw new Error("Mỗi câu trắc nghiệm cần ít nhất 2 lựa chọn (nên 4: A–D)");
      }

      let saved: Quiz;
      if (editingId && editingId !== "new") {
        saved = await apiFetch<Quiz>(`/api/v1/assessments/quizzes/${editingId}`, {
          method: "PUT",
          body: JSON.stringify({ title: title.trim(), questions }),
        });
      } else {
        saved = await apiFetch<Quiz>("/api/v1/assessments/quizzes", {
          method: "POST",
          body: JSON.stringify({
            classroomId,
            title: title.trim(),
            questions,
          }),
        });
      }
      setSuccess(
        normalizeQuizStatus(saved.status) === "PUBLISHED"
          ? "Đã lưu thay đổi (vẫn đang xuất bản)"
          : "Đã lưu bản nháp — bấm Xuất bản khi sẵn sàng cho học sinh",
      );
      setEditingId(saved.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  async function publishQuiz() {
    if (!editingId || editingId === "new") {
      setError("Hãy lưu bản nháp trước khi xuất bản");
      setConfirmPublishOpen(false);
      return;
    }
    if (editorStatus !== "DRAFT") {
      setError("Bài kiểm tra đã được xuất bản");
      setConfirmPublishOpen(false);
      return;
    }
    setPublishing(true);
    setError("");
    setSuccess("");
    try {
      await apiFetch(`/api/v1/assessments/quizzes/${editingId}/publish`, { method: "POST" });
      setConfirmPublishOpen(false);
      setSuccess("Đã xuất bản bài kiểm tra cho học sinh");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xuất bản thất bại");
    } finally {
      setPublishing(false);
    }
  }

  async function generateAi(e: FormEvent) {
    e.preventDefault();
    setAiBusy(true);
    setError("");
    try {
      const topic =
        aiTopic.trim() ||
        topicFromClassroom(classroom) ||
        classroom?.name?.trim() ||
        (isEnglishClass ? "Bài kiểm tra tiếng Anh" : "Bài kiểm tra");
      if (!aiTopic.trim() && topic) setAiTopic(topic);
      const baseStyle = aiStyle.trim() || styleFromClassroom(isEnglishClass);
      const stylePrompt = isEnglishClass
        ? baseStyle
        : `${baseStyle}\nKhối lớp / trình độ: ${aiClassLevel}.`;
      if (!aiStyle.trim()) setAiStyle(baseStyle);
      const studentContext = aiStudentContext.trim();

      const requestPayload = {
        classroomId,
        topic,
        ...(isEnglishClass
          ? { cefrLevel: aiCefr }
          : { classLevel: aiClassLevel }),
        count: aiCount,
        stylePrompt,
        studentContext: studentContext || undefined,
      };
      console.log("[generate-quiz] stage=request", requestPayload);

      const data = await apiFetch<GenerateQuizResponse>("/api/v1/ai/generate-quiz", {
        method: "POST",
        body: JSON.stringify(requestPayload),
      });
      const source = data.source === "ai" ? "ai" : "heuristic";
      console.log("[generate-quiz] stage=response", {
        source,
        title: data.title,
        questionCount: Array.isArray(data.questions) ? data.questions.length : 0,
        samplePrompt: data.questions?.[0]?.prompt,
        data,
      });
      console.log("[generate-quiz] stage=source", source);

      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (!questions.length) {
        throw new Error("AI không trả về câu hỏi — thử lại hoặc điền bảng thủ công");
      }
      if (!editingId) setEditingId("new");
      const generatedTitle = ensureLevelInTitle(
        data.title || titleFromClassroom(classroom, selectedLevel),
        selectedLevel,
        isEnglishClass,
      );
      if (!titleTouched || !title.trim()) {
        setTitle(generatedTitle);
      } else {
        setTitle((prev) => ensureLevelInTitle(prev, selectedLevel, isEnglishClass));
      }
      setRows(
        questions.map((q) => {
          const choices =
            Array.isArray(q.choices) && q.choices.length >= 2
              ? [...q.choices, "", "", "", ""].slice(0, 4)
              : ["", "", "", ""];
          return {
            id: crypto.randomUUID(),
            prompt: q.prompt || "",
            type: "mcq" as QuestionType,
            choices,
            answer: q.answer || "",
          };
        }),
      );
      setSuccess(
        source === "ai"
          ? "AI đã tạo câu hỏi (vẫn là nháp) — chỉnh rồi bấm Lưu bản nháp; Xuất bản là bước riêng"
          : "Đã dùng mẫu heuristic (vẫn là nháp) — chỉnh rồi Lưu bản nháp; Xuất bản là bước riêng",
      );
    } catch (err) {
      console.log("[generate-quiz] stage=error", err);
      const msg = err instanceof Error ? err.message : "Tạo bằng AI thất bại";
      setError(
        /failed to fetch|networkerror|load failed/i.test(msg)
          ? "Không kết nối được AI — kiểm tra gateway/dịch vụ AI rồi thử lại"
          : msg,
      );
    } finally {
      setAiBusy(false);
    }
  }

  async function importExcel(file: File | null) {
    if (!file) return;
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.append("file", file);
      const qs = new URLSearchParams({
        classroomId,
        title: file.name.replace(/\.xlsx$/i, "") || "Bài kiểm tra nhập từ Excel",
      });
      const imported = await apiFetch<Quiz>(
        `/api/v1/assessments/quizzes/import?${qs.toString()}`,
        { method: "POST", body: form },
      );
      setSuccess("Đã nhập Excel thành bản nháp — bấm Xuất bản khi sẵn sàng");
      startEdit(imported);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nhập Excel thất bại");
    }
  }

  async function exportExcel(quizId: string) {
    setError("");
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_BASE}/api/v1/assessments/quizzes/${quizId}/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Xuất Excel thất bại (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quiz-${quizId.slice(0, 8)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xuất Excel thất bại");
    }
  }

  async function loadAttempts(quizId: string) {
    setAttemptsQuizId(quizId);
    setAttemptsLoading(true);
    setError("");
    try {
      const data = await apiFetch<QuizAttempt[] | QuizAttempt>(
        `/api/v1/assessments/quizzes/${quizId}/attempts`,
      );
      setAttempts(asArray(data));
    } catch (err) {
      setAttempts([]);
      setError(err instanceof Error ? err.message : "Không tải được kết quả");
    } finally {
      setAttemptsLoading(false);
    }
  }

  if (loading) {
    return <p className="empty-state">Đang tải…</p>;
  }

  if (!classroom) {
    return (
      <>
        <div className="alert alert-error">{error || "Không tìm thấy lớp học"}</div>
        <Link href="/home?tab=classrooms" className="btn btn-ghost btn-sm">
          ← Quay lại
        </Link>
      </>
    );
  }

  return (
    <>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">Soạn bài kiểm tra</p>
          <h1>{classroom.name}</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Tạo / chỉnh câu hỏi → Lưu bản nháp → Xuất bản (hai bước riêng). Hỗ trợ AI và Excel.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={startCreate}>
            + Tạo bài kiểm tra
          </button>
          <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
            Nhập Excel
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(e) => void importExcel(e.target.files?.[0] || null)}
            />
          </label>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={deletingClassroom}
            onClick={() => setConfirmDeleteClassroomOpen(true)}
          >
            {deletingClassroom ? "Đang xóa…" : "Xóa lớp"}
          </button>
          <Link href="/home?tab=classrooms" className="btn btn-ghost btn-sm">
            ← Lớp học
          </Link>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: "1rem" }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginTop: "1rem" }}>{success}</div>}

      <section style={{ marginTop: "1.15rem" }}>
        <div className="page-title-row" style={{ marginBottom: "0.55rem", alignItems: "center" }}>
          <h2 className="section-heading" style={{ margin: 0 }}>
            Danh sách bài kiểm tra
          </h2>
          {quizzes.length > 0 && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  fontSize: "0.85rem",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Chọn tất cả bài kiểm tra"
                />
                Chọn tất cả
              </label>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={selectedIds.size === 0 || deletingQuizzes}
                onClick={() => setConfirmDeleteQuizzesOpen(true)}
              >
                {deletingQuizzes
                  ? "Đang xóa…"
                  : `Xóa đã chọn (${selectedIds.size})`}
              </button>
            </div>
          )}
        </div>
        {quizzes.length === 0 ? (
          <p className="empty-state">Chưa có bài kiểm tra. Tạo mới hoặc nhập Excel.</p>
        ) : (
          <>
          <div className="classroom-list">
            {quizPageItems.map((quiz) => (
              <div key={quiz.id} className="classroom-item">
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(quiz.id)}
                    onChange={() => toggleSelect(quiz.id)}
                    aria-label={`Chọn ${quiz.title}`}
                    style={{ marginTop: "0.35rem" }}
                  />
                  <div>
                    <h4 style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                      {quiz.title}
                      <QuizStatusBadge status={quiz.status} />
                    </h4>
                    <p>{parseQuestions(quiz.questionsJson).length} câu</p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(quiz)}>
                    Sửa
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void exportExcel(quiz.id)}
                  >
                    Xuất Excel
                  </button>
                  {String(quiz.status).toUpperCase() === "PUBLISHED" && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void loadAttempts(quiz.id)}
                    >
                      Kết quả
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <PaginationBar
            page={quizPage}
            totalPages={quizTotalPages}
            totalItems={quizzes.length}
            onChange={setQuizPage}
          />
          </>
        )}
      </section>

      {editingId && (
        <section className="quiz-editor" style={{ marginTop: "2rem" }}>
          <div className="page-title-row" style={{ marginBottom: "1rem" }}>
            <h2
              className="section-heading"
              style={{ margin: 0, display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}
            >
              {editingId === "new" ? "Bài kiểm tra mới" : "Chỉnh bài kiểm tra"}
              <QuizStatusBadge status={editorStatus} />
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
              Đóng
            </button>
          </div>

          <form className="quiz-ai-form" onSubmit={(e) => void generateAi(e)}>
            <h3 className="section-heading">Tạo bằng AI</h3>
            <p className="page-subtitle" style={{ marginTop: 0 }}>
              {isEnglishClass
                ? "Tạo trắc nghiệm 4 đáp án theo chủ đề lớp + CEFR. Tên/mô tả lớp chỉ là ngữ cảnh — không được đưa vào nội dung câu hỏi."
                : "Tạo trắc nghiệm 4 đáp án theo chủ đề lớp + khối lớp. Tên/mô tả lớp chỉ là ngữ cảnh — không được đưa vào nội dung câu hỏi."}
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="aiTopic">Chủ đề</label>
              <textarea
                id="aiTopic"
                className="form-textarea quiz-ai-topic"
                rows={8}
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                placeholder={PLACEHOLDERS.topic}
                required
              />
            </div>
            <div className="quiz-ai-grid">
              {isEnglishClass ? (
                <div className="form-group">
                  <label className="form-label" htmlFor="aiCefr">CEFR</label>
                  <select
                    id="aiCefr"
                    className="form-select"
                    value={aiCefr}
                    onChange={(e) => setAiCefr(e.target.value)}
                    title="VD: B1 — trung cấp"
                  >
                    {CEFR_LEVEL_OPTIONS.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="form-group">
                  <label className="form-label" htmlFor="aiClassLevel">Khối lớp</label>
                  <select
                    id="aiClassLevel"
                    className="form-select"
                    value={aiClassLevel}
                    onChange={(e) => setAiClassLevel(e.target.value)}
                    title="Chọn khối lớp / trình độ"
                  >
                    {CLASS_LEVEL_OPTIONS.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label" htmlFor="aiCount">Số câu</label>
                <input
                  id="aiCount"
                  className="form-input"
                  type="number"
                  min={1}
                  max={20}
                  value={aiCount}
                  onChange={(e) => setAiCount(Number(e.target.value) || 5)}
                  placeholder={PLACEHOLDERS.count}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="aiStyle">Phong cách</label>
              <textarea
                id="aiStyle"
                className="form-textarea"
                rows={3}
                value={aiStyle}
                onChange={(e) => setAiStyle(e.target.value)}
                placeholder={
                  isEnglishClass ? PLACEHOLDERS.styleEnglish : PLACEHOLDERS.styleClass
                }
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="aiStudentContext">
                Ngữ cảnh học sinh
              </label>
              <textarea
                id="aiStudentContext"
                className="form-textarea"
                rows={2}
                value={aiStudentContext}
                onChange={(e) => setAiStudentContext(e.target.value)}
                placeholder={
                  isEnglishClass
                    ? PLACEHOLDERS.studentContextEnglish
                    : PLACEHOLDERS.studentContextClass
                }
              />
            </div>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={aiBusy}>
              {aiBusy ? "Đang tạo…" : "Tạo bằng AI → điền bảng"}
            </button>
          </form>

          <form onSubmit={(e) => void saveDraft(e)} style={{ marginTop: "1.5rem" }}>
            <div className="form-group">
              <label className="form-label" htmlFor="quizTitle">Tiêu đề</label>
              <input
                id="quizTitle"
                className="form-input"
                value={title}
                onChange={(e) => {
                  setTitleTouched(true);
                  setTitle(e.target.value);
                }}
                required
                placeholder={
                  isEnglishClass
                    ? PLACEHOLDERS.quizTitleEnglish
                    : PLACEHOLDERS.quizTitleClass
                }
              />
            </div>

            <div className="quiz-table-wrap">
              <table className="quiz-table">
                <thead>
                  <tr>
                    <th style={{ width: "36%" }}>Đề bài</th>
                    <th style={{ width: "10%" }}>Loại</th>
                    <th style={{ width: "30%" }}>Lựa chọn (A–D)</th>
                    <th style={{ width: "16%" }}>Đáp án</th>
                    <th style={{ width: "8%" }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id || index}>
                      <td>
                        <textarea
                          className="form-textarea quiz-cell"
                          rows={2}
                          value={row.prompt}
                          onChange={(e) => updateRow(index, { prompt: e.target.value })}
                          required
                          placeholder={PLACEHOLDERS.prompt}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input quiz-cell"
                          value="mcq"
                          readOnly
                          title="Chỉ trắc nghiệm 4 đáp án"
                          aria-label="Loại câu hỏi"
                        />
                      </td>
                      <td>
                        <input
                          className="form-input quiz-cell"
                          value={(row.choices || []).join(" | ")}
                          onChange={(e) =>
                            updateRow(index, {
                              type: "mcq",
                              choices: e.target.value.split("|").map((s) => s.trim()),
                            })
                          }
                          placeholder={PLACEHOLDERS.choices}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input quiz-cell"
                          value={row.answer || ""}
                          onChange={(e) => updateRow(index, { answer: e.target.value })}
                          required
                          placeholder={PLACEHOLDERS.answerMcq}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeRow(index)}
                          aria-label="Xóa dòng"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="quiz-editor-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setRows((prev) => [...prev, emptyRow()])}
              >
                + Thêm câu
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving || publishing}>
                {saving
                  ? "Đang lưu…"
                  : editorStatus === "PUBLISHED"
                    ? "Lưu thay đổi"
                    : "Lưu bản nháp"}
              </button>
              {editorStatus === "PUBLISHED" ? (
                <span className="quiz-muted" style={{ fontSize: "0.85rem" }}>
                  Đã xuất bản — học sinh có thể làm bài
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!canPublish}
                  title={
                    editingId === "new"
                      ? "Lưu bản nháp trước khi xuất bản"
                      : "Xuất bản bài kiểm tra cho học sinh"
                  }
                  onClick={() => setConfirmPublishOpen(true)}
                >
                  {publishing ? "Đang xuất bản…" : "Xuất bản"}
                </button>
              )}
            </div>
            {editorStatus === "DRAFT" && editingId === "new" && (
              <p className="quiz-muted" style={{ marginTop: "0.65rem", fontSize: "0.85rem" }}>
                Lưu bản nháp trước, rồi mới Xuất bản (hai bước riêng).
              </p>
            )}
          </form>
        </section>
      )}

      {attemptsQuizId && (
        <section style={{ marginTop: "2rem" }}>
          <div className="page-title-row">
            <h2 className="section-heading" style={{ margin: 0 }}>
              Kết quả làm bài
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttemptsQuizId(null)}>
              Đóng
            </button>
          </div>
          {attemptsLoading ? (
            <p className="empty-state">Đang tải kết quả…</p>
          ) : attempts.length === 0 ? (
            <p className="empty-state">Chưa có bài nộp.</p>
          ) : (
            <div className="classroom-list" style={{ marginTop: "0.75rem" }}>
              {attempts.map((a) => (
                <div key={a.id} className="classroom-item">
                  <div>
                    <h4>
                      {a.score}/{a.maxScore}
                    </h4>
                    <p>
                      Học sinh {a.studentId.slice(0, 8)}… · {a.submittedAt || ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ConfirmDeleteDialog
        open={confirmDeleteQuizzesOpen}
        onOpenChange={(open) => {
          if (!deletingQuizzes) setConfirmDeleteQuizzesOpen(open);
        }}
        title={`Xóa ${selectedIds.size} bài kiểm tra đã chọn?`}
        description={
          <p>
            Xóa {selectedIds.size} bài kiểm tra đã chọn? Hành động này không hoàn tác.
          </p>
        }
        confirmLabel={`Xóa ${selectedIds.size} bài`}
        confirming={deletingQuizzes}
        onConfirm={() => void deleteSelectedQuizzes()}
      />

      <ConfirmDeleteDialog
        open={confirmDeleteClassroomOpen}
        onOpenChange={(open) => {
          if (!deletingClassroom) setConfirmDeleteClassroomOpen(open);
        }}
        title={`Xóa lớp “${classroom.name}”?`}
        description={
          <p>
            Thành viên, yêu cầu tham gia và bài kiểm tra của lớp “{classroom.name}” sẽ bị xóa.
            Hành động này không hoàn tác.
          </p>
        }
        confirmLabel="Xóa lớp"
        confirming={deletingClassroom}
        onConfirm={() => void deleteClassroom()}
      />

      <ConfirmDeleteDialog
        open={confirmPublishOpen}
        onOpenChange={(open) => {
          if (!publishing) setConfirmPublishOpen(open);
        }}
        title="Xuất bản bài kiểm tra này cho học sinh?"
        description={
          <p>
            Học sinh trong lớp sẽ thấy và làm được bài này. Bạn vẫn có thể chỉnh nội dung sau khi
            xuất bản.
          </p>
        }
        confirmLabel="Xuất bản"
        cancelLabel="Hủy"
        confirming={publishing}
        confirmingLabel="Đang xuất bản…"
        variant="default"
        onConfirm={() => void publishQuiz()}
      />
    </>
  );
}

export default function TeacherQuizzesPage() {
  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main page-main--wide flex-1 min-h-0 overflow-auto">
          <QuizzesContent />
        </main>
      </div>
    </AuthGuard>
  );
}
