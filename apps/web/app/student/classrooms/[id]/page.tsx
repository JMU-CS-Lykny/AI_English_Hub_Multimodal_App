"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import SiteHeader from "@/components/SiteHeader";
import StudentMascotHost from "@/components/StudentMascotHost";
import { apiFetch } from "@/lib/api";
import type { Classroom, Lesson, Quiz } from "@/lib/types";

function statusLabel(status?: string | null): string {
  const s = String(status || "").toUpperCase();
  if (s === "DRAFT") return "Bản nháp";
  if (s === "PUBLISHED") return "Đã xuất bản";
  return status || "Đã xuất bản";
}

function ClassroomDetailContent() {
  const params = useParams();
  const classroomId = String(params.id || "");

  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
            {quizzes.map((quiz) => (
              <div key={quiz.id} className="classroom-item">
                <div>
                  <h4>{quiz.title}</h4>
                  <p>
                    {statusLabel(quiz.status)} · Có thể làm ngay
                  </p>
                </div>
                <Link
                  href={`/student/classrooms/${classroom.id}/quizzes/${quiz.id}`}
                  className="btn btn-primary btn-sm"
                >
                  Làm bài →
                </Link>
              </div>
            ))}
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
