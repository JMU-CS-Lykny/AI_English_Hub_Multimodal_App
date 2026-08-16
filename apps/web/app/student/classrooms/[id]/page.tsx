"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import SiteHeader from "@/components/SiteHeader";
import StudentMascotHost from "@/components/StudentMascotHost";
import { apiFetch } from "@/lib/api";
import type { Classroom, Lesson, Quiz, QuizKind } from "@/lib/types";

function normalizeKind(kind?: QuizKind | string | null): QuizKind {
  const k = String(kind || "PRACTICE").toUpperCase();
  if (k === "EXAM") return "EXAM";
  // Legacy GAME kind uses classic PRACTICE UX (soccer game removed).
  return "PRACTICE";
}

const KIND_LABEL: Record<QuizKind, string> = {
  EXAM: "Bài kiểm tra",
  PRACTICE: "Luyện tập",
  GAME: "Luyện tập",
};

type ExamGate = {
  state: "open" | "locked-soon" | "locked-ended" | "open-practice";
  label: string;
  canTake: boolean;
  countdown?: string;
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0 phút";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} ngày ${hours} giờ`;
  if (hours > 0) return `${hours} giờ ${mins} phút`;
  if (mins > 0) return `${mins} phút`;
  return `${totalSec} giây`;
}

function examGate(quiz: Quiz, now: number): ExamGate {
  const kind = normalizeKind(quiz.kind);
  if (kind !== "EXAM") {
    return {
      state: "open-practice",
      label: "Có thể làm ngay",
      canTake: true,
    };
  }

  const starts = quiz.startsAt ? new Date(quiz.startsAt).getTime() : NaN;
  const ends = quiz.endsAt
    ? new Date(quiz.endsAt).getTime()
    : quiz.startsAt && quiz.durationMinutes
      ? new Date(quiz.startsAt).getTime() + quiz.durationMinutes * 60_000
      : NaN;

  if (!Number.isNaN(starts) && now < starts) {
    return {
      state: "locked-soon",
      label: `Chưa mở · bắt đầu ${new Date(starts).toLocaleString("vi-VN")}`,
      canTake: false,
      countdown: formatCountdown(starts - now),
    };
  }
  if (!Number.isNaN(ends) && now > ends) {
    return {
      state: "locked-ended",
      label: "Đã hết giờ làm bài",
      canTake: false,
    };
  }
  const remaining =
    !Number.isNaN(ends) && ends > now ? formatCountdown(ends - now) : undefined;
  return {
    state: "open",
    label: remaining ? `Đang mở · còn ${remaining}` : "Đang mở",
    canTake: true,
    countdown: remaining,
  };
}

function ClassroomDetailContent() {
  const params = useParams();
  const classroomId = String(params.id || "");

  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!classroomId) return;
    setLoading(true);
    setError("");
    try {
      const [cls, lessonData, quizData] = await Promise.all([
        apiFetch<Classroom>(`/api/v1/classrooms/${classroomId}`),
        apiFetch<Lesson[]>(`/api/v1/content/lessons?classroomId=${classroomId}`).catch(() => []),
        apiFetch<Quiz[]>(`/api/v1/assessments/quizzes?classroomId=${classroomId}`).catch(() => []),
      ]);
      setClassroom(cls);
      setLessons(
        lessonData.filter((l) => String(l.status).toUpperCase() === "PUBLISHED"),
      );
      setQuizzes(quizData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được lớp học");
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (loading) {
    return <p className="empty-state">Đang tải lớp học…</p>;
  }

  if (error || !classroom) {
    return (
      <>
        <div className="alert alert-error">{error || "Không tìm thấy lớp học"}</div>
        <Link href="/home?tab=classrooms" className="btn btn-ghost btn-sm">
          ← Quay lại lớp của tôi
        </Link>
      </>
    );
  }

  return (
    <>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">Lớp học</p>
          <h1>{classroom.name}</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            {classroom.description || "Chưa có mô tả"}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Link
            href={`/student/classrooms/${classroom.id}/chat`}
            className="btn btn-secondary btn-sm"
          >
            Phòng chat
          </Link>
          <Link
            href={`/student/tutor?classroomId=${classroom.id}`}
            className="btn btn-primary btn-sm"
          >
            Học với AI Tutor
          </Link>
          <Link href="/home?tab=classrooms" className="btn btn-ghost btn-sm">
            ← Lớp của tôi
          </Link>
        </div>
      </div>

      <div className="info-strip" style={{ marginTop: "1.25rem" }}>
        <div>
          <span className="info-label">Mã lớp</span>
          <code>{classroom.id.slice(0, 8)}…</code>
        </div>
        <div>
          <span className="info-label">Bài học</span>
          <strong>{lessons.length}</strong>
        </div>
        <div>
          <span className="info-label">Bài kiểm tra</span>
          <strong>{quizzes.length}</strong>
        </div>
      </div>

      <section style={{ marginTop: "2rem" }}>
        <h2 className="section-heading">Bài học đã xuất bản</h2>
        {lessons.length === 0 ? (
          <p className="empty-state">
            Giáo viên chưa xuất bản bài học nào.
          </p>
        ) : (
          <div className="lesson-list">
            {lessons.map((lesson) => (
              <article key={lesson.id} className="lesson-card">
                <div className="lesson-card-head">
                  <h3>{lesson.title}</h3>
                  <span className="role-badge">{lesson.cefrLevel || "A1"}</span>
                </div>
                <p className="lesson-excerpt">
                  {lesson.body.length > 220 ? `${lesson.body.slice(0, 220)}…` : lesson.body}
                </p>
                <Link
                  href={`/student/tutor?classroomId=${classroom.id}`}
                  className="btn btn-secondary btn-sm"
                >
                  Hỏi AI về bài này →
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2 className="section-heading">Bài kiểm tra</h2>
        {quizzes.length === 0 ? (
          <p className="empty-state">Chưa có bài kiểm tra đã xuất bản.</p>
        ) : (
          <div className="classroom-list">
            {quizzes.map((quiz) => {
              const kind = normalizeKind(quiz.kind);
              const gate = examGate(quiz, now);
              const cta = gate.canTake ? "Làm bài →" : "Chưa mở";
              return (
                <div key={quiz.id} className="classroom-item">
                  <div>
                    <h4
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      {quiz.title}
                      <span
                        className={`quiz-kind-badge quiz-kind-badge--${kind.toLowerCase()}`}
                      >
                        {KIND_LABEL[kind]}
                      </span>
                    </h4>
                    <p>
                      {gate.label}
                      {gate.state === "locked-soon" && gate.countdown
                        ? ` · còn ${gate.countdown}`
                        : ""}
                    </p>
                  </div>
                  {gate.canTake ? (
                    <Link
                      href={`/student/classrooms/${classroom.id}/quizzes/${quiz.id}`}
                      className="btn btn-primary btn-sm"
                    >
                      {cta}
                    </Link>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" disabled>
                      {cta}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export default function StudentClassroomDetailPage() {
  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main flex-1 min-h-0 overflow-auto">
          <ClassroomDetailContent />
        </main>
        <StudentMascotHost />
      </div>
    </AuthGuard>
  );
}
