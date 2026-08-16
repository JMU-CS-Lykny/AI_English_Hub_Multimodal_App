"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import CreateClassroomDialog from "@/components/home/CreateClassroomDialog";
import PaginationBar, { pageCount, slicePage } from "@/components/PaginationBar";
import { apiFetch } from "@/lib/api";
import { getClassroomMeta, subjectLabel } from "@/lib/classroomMeta";
import type { Classroom, ClassroomMember, Quiz, User } from "@/lib/types";

const PAGE_SIZE = 6;

function asArray<T>(data: T | T[] | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/** CEFR / band from name+description when not stored on the classroom. */
function inferLevel(name: string, description?: string | null): string | null {
  const text = `${name} ${description || ""}`;
  const cefr = text.match(/\b(A1|A2|B1|B2|C1|C2)\b/i);
  if (cefr) return cefr[1].toUpperCase();
  if (/\b(band\s*[56789](?:\.\d)?)\b/i.test(text)) {
    const band = text.match(/\bband\s*([56789](?:\.\d)?)\b/i);
    return band ? `Band ${band[1]}` : null;
  }
  if (/\b(beginner|sơ\s*cấp|cơ\s*bản)\b/i.test(text)) return "A1–A2";
  if (/\b(intermediate|trung\s*cấp)\b/i.test(text)) return "B1–B2";
  if (/\b(advanced|cao\s*cấp)\b/i.test(text)) return "C1";
  return null;
}

function truncate(text: string, max = 110): string {
  const t = text.trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

interface CardStats {
  studentCount: number | null;
  examCount: number;
  loading: boolean;
}

interface ClassroomsPanelProps {
  user: User;
}

export default function ClassroomsPanel({ user }: ClassroomsPanelProps) {
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [stats, setStats] = useState<Record<string, CardStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Classroom | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const isStudent = user.role === "STUDENT";
  const canManage = user.role === "TEACHER" || user.role === "ADMIN";
  const canListMembers = canManage;
  const totalPages = pageCount(classrooms.length, PAGE_SIZE);
  const pageItems = useMemo(
    () => slicePage(classrooms, page, PAGE_SIZE),
    [classrooms, page],
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function copyInviteCode(classroomId: string, code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(classroomId);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === classroomId ? null : prev));
      }, 2000);
    } catch {
      setError("Không sao chép được mã mời");
    }
  }

  const loadCardStats = useCallback(
    async (list: Classroom[]) => {
      const initial: Record<string, CardStats> = {};
      for (const c of list) {
        initial[c.id] = { studentCount: null, examCount: 0, loading: true };
      }
      setStats(initial);

      await Promise.all(
        list.map(async (c) => {
          const [membersResult, quizzesResult] = await Promise.all([
            canListMembers
              ? apiFetch<ClassroomMember[] | ClassroomMember>(
                  `/api/v1/classrooms/${c.id}/members`,
                )
                  .then((m) => asArray(m).length)
                  .catch(() => null)
              : Promise.resolve(null),
            apiFetch<Quiz[] | Quiz>(`/api/v1/assessments/quizzes?classroomId=${c.id}`)
              .then((q) => asArray(q).length)
              .catch(() => 0),
          ]);

          setStats((prev) => ({
            ...prev,
            [c.id]: {
              studentCount: membersResult,
              examCount: quizzesResult,
              loading: false,
            },
          }));
        }),
      );
    },
    [canListMembers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = asArray(await apiFetch<Classroom[] | Classroom>("/api/v1/classrooms"));
      setClassrooms(data);
      await loadCardStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được lớp học");
    } finally {
      setLoading(false);
    }
  }, [loadCardStats]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteClassroom(c: Classroom) {
    setDeletingId(c.id);
    setError("");
    try {
      const quizList = asArray(
        await apiFetch<Quiz[] | Quiz>(`/api/v1/assessments/quizzes?classroomId=${c.id}`),
      );
      for (const quiz of quizList) {
        await apiFetch(`/api/v1/assessments/quizzes/${quiz.id}`, { method: "DELETE" }).catch(
          () => undefined,
        );
      }
      await apiFetch(`/api/v1/classrooms/${c.id}`, { method: "DELETE" });
      setPendingDelete(null);
      setClassrooms((prev) => prev.filter((x) => x.id !== c.id));
      setStats((prev) => {
        const next = { ...prev };
        delete next[c.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xóa lớp thất bại");
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  function handleCreated(created: Classroom) {
    setSuccess(`Đã tạo lớp “${created.name}” — mã mời ${created.inviteCode}`);
    setClassrooms((prev) => [created, ...prev]);
    setStats((prev) => ({
      ...prev,
      [created.id]: { studentCount: 0, examCount: 0, loading: false },
    }));
    void load();
  }

  return (
    <div className="home-classrooms">
      <div className="home-panel-head home-panel-head--row">
        <div>
          <h2>{isStudent ? "Lớp của tôi" : "Lớp học"}</h2>
          <p>
            {isStudent
              ? "Thẻ lớp ngang — mở chi tiết để học."
              : "Thẻ lớp ngang — tạo lớp mới hoặc mở bài kiểm tra."}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            className="tc-icon-btn tc-icon-btn--primary"
            title="Thêm lớp"
            aria-label="Thêm lớp"
            onClick={() => setCreateOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        ) : (
          <Link href="/home?tab=join" className="btn btn-primary btn-sm">
            Tham gia lớp
          </Link>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {loading ? (
        <p className="empty-state">Đang tải…</p>
      ) : classrooms.length === 0 ? (
        <div className="home-empty">
          <h3>{isStudent ? "Chưa tham gia lớp nào" : "Chưa có lớp học"}</h3>
          <p>
            {isStudent
              ? "Dùng tab Tham gia hoặc trang tham gia để nhập mã mời."
              : "Tạo lớp đầu tiên bằng nút + Thêm lớp."}
          </p>
          {canManage ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreateOpen(true)}>
              + Thêm lớp
            </button>
          ) : (
            <Link href="/home?tab=join" className="btn btn-secondary btn-sm">
              Tham gia lớp
            </Link>
          )}
        </div>
      ) : (
        <>
          <ul className="home-class-list">
            {pageItems.map((c, index) => {
              const meta = getClassroomMeta(c.id, c.name, c.description);
              const level = inferLevel(c.name, c.description);
              const knowledges = meta.knowledges ?? [];
              const subjectText = subjectLabel(meta.subject);
              const isOtherTopic = (label: string) => {
                const t = label.trim().toLowerCase();
                return !t || t === "khác" || t === "other";
              };
              const showSubjectChip =
                meta.subject !== "Other" && !isOtherTopic(subjectText ?? "");
              const topicChips = [
                ...(showSubjectChip ? [subjectText] : []),
                ...knowledges.filter((k) => {
                  const label = (k ?? "").trim();
                  if (isOtherTopic(label)) return false;
                  if (!showSubjectChip) return true;
                  return label.toLowerCase() !== (subjectText ?? "").trim().toLowerCase();
                }),
              ];
              const card = stats[c.id];
              const studentLabel =
                card?.loading && canListMembers
                  ? "…"
                  : card?.studentCount != null
                    ? String(card.studentCount)
                    : "—";
              const examLabel = card?.loading ? "…" : String(card?.examCount ?? 0);
              const desc = truncate(c.description?.trim() || "");
              const href = isStudent
                ? `/student/classrooms/${c.id}`
                : `/teacher/classrooms/${c.id}/quizzes`;
              const busy = deletingId === c.id;
              const copied = copiedId === c.id;

              return (
                <li
                  key={c.id}
                  className="home-class-card-wrap"
                  style={{ animationDelay: `${Math.min(index, 5) * 0.05}s` }}
                >
                  <div className="home-class-card">
                    <Link href={href} className="home-class-card-link">
                      <span
                        className="home-class-card-cover"
                        style={{ backgroundImage: `url(${meta.coverImage})` }}
                        aria-hidden
                      />
                      <span className="home-class-card-body">
                        <span className="home-class-card-heading-row">
                          <strong className="home-class-card-title">{c.name}</strong>
                          <span className="home-class-card-level" title="Trình độ CEFR">
                            {level || "—"}
                          </span>
                        </span>
                        {topicChips.length > 0 && (
                          <span className="home-class-card-topics" aria-label="Chủ đề">
                            {topicChips.map((topic, i) => (
                              <span
                                key={`${topic}-${i}`}
                                className={`home-class-topic-chip${
                                  showSubjectChip && i === 0
                                    ? " home-class-topic-chip--subject"
                                    : ""
                                }`}
                              >
                                {topic}
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="home-class-card-desc">
                          {desc || "Chưa có mô tả cho lớp học này."}
                        </span>
                        <span className="home-class-card-stats" aria-label="Thống kê lớp học">
                          {canListMembers && (
                            <span>
                              <em>Học sinh</em>
                              <b>{studentLabel}</b>
                            </span>
                          )}
                          <span>
                            <em>Chủ đề</em>
                            <b>{topicChips.length}</b>
                          </span>
                          <span>
                            <em>Bài kiểm tra</em>
                            <b>{examLabel}</b>
                          </span>
                        </span>
                      </span>
                      <span className="home-class-card-chevron" aria-hidden>
                        →
                      </span>
                    </Link>
                    {canManage && c.inviteCode && (
                      <div className="home-class-card-invite">
                        <span className="home-class-card-invite-meta">
                          <em>Mã mời</em>
                          <b className="home-class-card-invite-code">{c.inviteCode}</b>
                        </span>
                        <button
                          type="button"
                          className={`home-class-invite-copy${copied ? " is-copied" : ""}`}
                          title={copied ? "Đã sao chép" : "Sao chép mã mời"}
                          aria-label={
                            copied
                              ? `Đã sao chép mã mời ${c.inviteCode}`
                              : `Sao chép mã mời ${c.inviteCode}`
                          }
                          onClick={() => void copyInviteCode(c.id, c.inviteCode)}
                        >
                          {copied ? (
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                              <rect x="9" y="9" width="11" height="11" rx="2" />
                              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                            </svg>
                          )}
                        </button>
                      </div>
                    )}
                    <Link
                      href={
                        isStudent
                          ? `/student/classrooms/${c.id}/chat`
                          : `/teacher/classrooms/${c.id}/chat`
                      }
                      className="home-class-card-chat"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Phòng chat
                    </Link>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className="home-class-card-delete"
                      disabled={busy}
                      title="Xóa lớp"
                      aria-label={`Xóa lớp ${c.name}`}
                      onClick={() => setPendingDelete(c)}
                    >
                      {busy ? "…" : "×"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <PaginationBar
            page={page}
            totalPages={totalPages}
            totalItems={classrooms.length}
            onChange={setPage}
          />
        </>
      )}

      {canManage && (
        <CreateClassroomDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(created) => {
            setPage(1);
            handleCreated(created);
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open && !deletingId) setPendingDelete(null);
        }}
        title={pendingDelete ? `Xóa lớp “${pendingDelete.name}”?` : "Xóa lớp?"}
        description={
          pendingDelete ? (
            <p>
              Thành viên, yêu cầu tham gia và bài kiểm tra của lớp “{pendingDelete.name}” sẽ bị
              xóa. Hành động này không hoàn tác.
            </p>
          ) : null
        }
        confirmLabel="Xóa lớp"
        confirming={deletingId != null && pendingDelete?.id === deletingId}
        onConfirm={() => {
          if (pendingDelete) void deleteClassroom(pendingDelete);
        }}
      />
    </div>
  );
}
