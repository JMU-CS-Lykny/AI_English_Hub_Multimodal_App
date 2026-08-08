"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import FireworksOverlay from "@/components/FireworksOverlay";
import SiteHeader from "@/components/SiteHeader";
import StudentMascotHost from "@/components/StudentMascotHost";
import { apiFetch } from "@/lib/api";
import { getClassroomMeta } from "@/lib/classroomMeta";
import type { Classroom, Quiz, QuizAttempt, QuizQuestion } from "@/lib/types";

function parseQuestions(json: string | undefined): QuizQuestion[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as QuizQuestion[];
    if (!Array.isArray(raw)) return [];
    return raw.map((q, i) => ({
      id: q.id || `q-${i}`,
      prompt: q.prompt || "",
      type: q.type === "mcq" ? "mcq" : "short",
      choices: Array.isArray(q.choices) ? q.choices : [],
      // Never trust client-side answer for display; API strips for students
      answer: undefined,
    }));
  } catch {
    return [];
  }
}

function isAnswered(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function TakeExamContent({
  onCoverChange,
}: {
  onCoverChange?: (coverImage: string | null) => void;
}) {
  const params = useParams();
  const classroomId = String(params.id || "");
  const quizId = String(params.quizId || "");

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [navHint, setNavHint] = useState("");
  const [result, setResult] = useState<QuizAttempt | null>(null);
  const [showFireworks, setShowFireworks] = useState(false);

  const load = useCallback(async () => {
    if (!quizId) return;
    setLoading(true);
    setError("");
    try {
      const [data, classroom] = await Promise.all([
        apiFetch<Quiz>(`/api/v1/assessments/quizzes/${quizId}`),
        classroomId
          ? apiFetch<Classroom>(`/api/v1/classrooms/${classroomId}`).catch(() => null)
          : Promise.resolve(null),
      ]);
      const qs = parseQuestions(data.questionsJson);
      setQuiz(data);
      setQuestions(qs);
      setAnswers(qs.map(() => ""));
      setCurrentIndex(0);

      if (classroomId && classroom) {
        const meta = getClassroomMeta(classroomId, classroom.name, classroom.description);
        onCoverChange?.(meta.coverImage?.trim() || null);
      } else if (classroomId) {
        // Classroom fetch failed — still resolve from stored/inferred meta with empty name.
        const meta = getClassroomMeta(classroomId, "");
        onCoverChange?.(meta.coverImage?.trim() || null);
      } else {
        onCoverChange?.(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được đề thi");
      onCoverChange?.(null);
    } finally {
      setLoading(false);
    }
  }, [quizId, classroomId, onCoverChange]);

  useEffect(() => {
    void load();
  }, [load]);

  function setAnswerAt(index: number, value: string) {
    setNavHint("");
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function goNext() {
    if (!isAnswered(answers[currentIndex])) {
      setNavHint("Vui lòng chọn hoặc nhập đáp án trước khi tiếp tục.");
      return;
    }
    setNavHint("");
    setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
  }

  function goBack() {
    setNavHint("");
    setCurrentIndex((i) => Math.max(i - 1, 0));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (result) return;
    if (!isAnswered(answers[currentIndex])) {
      setNavHint("Vui lòng chọn hoặc nhập đáp án trước khi nộp bài.");
      return;
    }
    const unanswered = answers.findIndex((a) => !isAnswered(a));
    if (unanswered !== -1) {
      setCurrentIndex(unanswered);
      setNavHint(`Câu ${unanswered + 1} chưa có đáp án. Vui lòng trả lời trước khi nộp.`);
      return;
    }
    setSubmitting(true);
    setError("");
    setNavHint("");
    try {
      const attempt = await apiFetch<QuizAttempt>(
        `/api/v1/assessments/quizzes/${quizId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ answers }),
        },
      );
      setResult(attempt);
      if (attempt.maxScore > 0 && attempt.score === attempt.maxScore) {
        setShowFireworks(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nộp bài thất bại");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="empty-state">Đang tải đề…</p>;
  }

  if (error && !quiz) {
    return (
      <>
        <div className="alert alert-error">{error}</div>
        <Link href={`/student/classrooms/${classroomId}`} className="btn btn-ghost btn-sm">
          ← Quay lại lớp
        </Link>
      </>
    );
  }

  const total = questions.length;
  const q = questions[currentIndex];
  const isLast = currentIndex === total - 1;
  const progressPct = total > 0 ? ((currentIndex + 1) / total) * 100 : 0;

  return (
    <>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">Bài kiểm tra</p>
          <h1>{quiz?.title || "Bài kiểm tra"}</h1>
        </div>
        <Link href={`/student/classrooms/${classroomId}`} className="btn btn-ghost btn-sm">
          ← Lớp học
        </Link>
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: "1rem" }}>{error}</div>}

      {result ? (
        <div className="exam-score">
          <p className="eyebrow">Kết quả</p>
          <strong>
            {result.score} / {result.maxScore}
          </strong>
          {result.maxScore > 0 && result.score === result.maxScore ? (
            <p style={{ marginTop: "0.5rem" }}>
              Điểm tuyệt đối! Đã nộp bài thành công. Bạn có thể quay lại lớp học.
            </p>
          ) : (
            <p style={{ marginTop: "0.5rem" }}>
              Đã nộp bài thành công. Bạn có thể quay lại lớp học.
            </p>
          )}
          <Link
            href={`/student/classrooms/${classroomId}`}
            className="btn btn-primary btn-sm"
            style={{ marginTop: "0.85rem" }}
          >
            Về lớp học
          </Link>
        </div>
      ) : total === 0 ? (
        <p className="empty-state">Bài kiểm tra không có câu hỏi.</p>
      ) : (
        <form className="exam-take" onSubmit={(e) => void onSubmit(e)}>
          <div className="exam-progress" aria-live="polite">
            <div className="exam-progress-meta">
              <span className="exam-progress-label">
                Câu {currentIndex + 1} / {total}
              </span>
              <span className="exam-progress-hint">
                {q?.type === "mcq" ? "Trắc nghiệm" : "Tự luận ngắn"}
              </span>
            </div>
            <div className="exam-progress-track" aria-hidden="true">
              <div className="exam-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>

          <div className="exam-question exam-question--focus" key={q?.id || currentIndex}>
            <h3>{q?.prompt}</h3>
            {q?.type === "mcq" && (q.choices?.length || 0) > 0 ? (
              <div
                className="exam-choices"
                role="radiogroup"
                aria-label={`Câu hỏi ${currentIndex + 1}`}
              >
                {(q.choices || []).map((choice, ci) => {
                  const letter = String.fromCharCode(65 + ci);
                  return (
                    <label key={`${currentIndex}-${ci}`} className="exam-choice">
                      <input
                        type="radio"
                        name={`q-${currentIndex}`}
                        value={letter}
                        checked={
                          answers[currentIndex] === letter ||
                          answers[currentIndex] === choice
                        }
                        onChange={() => setAnswerAt(currentIndex, letter)}
                      />
                      <span>
                        <strong>{letter}.</strong> {choice}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                className="form-input"
                value={answers[currentIndex] || ""}
                onChange={(e) => setAnswerAt(currentIndex, e.target.value)}
                placeholder="Nhập đáp án của bạn"
                autoFocus
              />
            )}
          </div>

          {navHint && <p className="exam-nav-hint">{navHint}</p>}

          <div className="exam-nav">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={goBack}
              disabled={currentIndex === 0 || submitting}
            >
              ← Trước
            </button>
            {isLast ? (
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Đang nộp…" : "Nộp bài"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={goNext}
                disabled={submitting}
              >
                Tiếp →
              </button>
            )}
          </div>
        </form>
      )}

      {result && (
        <FireworksOverlay
          open={showFireworks}
          score={result.score}
          maxScore={result.maxScore}
          onDismiss={() => setShowFireworks(false)}
        />
      )}
    </>
  );
}

export default function StudentTakeExamPage() {
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const hasCover = Boolean(coverImage);

  return (
    <AuthGuard>
      <div
        className={`page-shell exam-page h-screen min-h-screen flex flex-col${
          hasCover ? " exam-page--with-cover" : ""
        }`}
      >
        {hasCover && coverImage ? (
          <div
            className="exam-page-cover"
            aria-hidden="true"
            style={{ backgroundImage: `url(${JSON.stringify(coverImage)})` }}
          />
        ) : null}
        <div className="exam-page-body flex-1 min-h-0 flex flex-col">
          <SiteHeader />
          <main className="page-main flex-1 min-h-0 overflow-auto">
            <TakeExamContent onCoverChange={setCoverImage} />
          </main>
          <StudentMascotHost />
        </div>
      </div>
    </AuthGuard>
  );
}
