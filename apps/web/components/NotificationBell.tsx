"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import PaginationBar, { pageCount, slicePage } from "@/components/PaginationBar";
import { API_BASE, ApiError, apiFetch } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import type { NotificationItem } from "@/lib/types";

const NOTIF_PAGE_SIZE = 6;

function IconBell() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
      className={spinning ? "notif-spin" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function IconChecks() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 7l-8 8-3-3" />
      <path d="M21 10l-8 8-1.5-1.5" />
    </svg>
  );
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [acting, setActing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState("");
  const [page, setPage] = useState(1);
  const panelRef = useRef<HTMLDivElement>(null);

  const totalPages = pageCount(items.length, NOTIF_PAGE_SIZE);
  const pageItems = useMemo(() => slicePage(items, page, NOTIF_PAGE_SIZE), [items, page]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const load = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        apiFetch<NotificationItem[]>("/api/v1/notifications"),
        apiFetch<{ count: number }>("/api/v1/notifications/unread-count"),
      ]);
      setItems(Array.isArray(list) ? list.slice(0, 20) : []);
      setUnread(count.count);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function boot() {
      const ok = await load();
      if (cancelled || ok) return;
      attempt += 1;
      if (attempt > 8) return;
      timer = setTimeout(boot, Math.min(1000 * 2 ** (attempt - 1), 8000));
    }

    void boot();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    let closed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function connect() {
      if (closed) return;
      const url = `${API_BASE}/api/v1/notifications/stream?access_token=${encodeURIComponent(token!)}`;
      es = new EventSource(url);

      es.addEventListener("connected", () => {
        attempt = 0;
        void load();
      });

      es.addEventListener("notification", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            id: string;
            type: string;
            title: string;
            body: string;
            refId?: string;
            refType?: string;
            unreadCount?: number;
          };
          setItems((prev) =>
            [
              {
                id: data.id,
                type: data.type,
                title: data.title,
                body: data.body,
                payloadJson: null,
                refType: data.refType || null,
                refId: data.refId || null,
                read: false,
                createdAt: new Date().toISOString(),
              },
              ...prev.filter((n) => n.id !== data.id),
            ].slice(0, 20),
          );
          if (typeof data.unreadCount === "number") {
            setUnread(data.unreadCount);
          } else {
            setUnread((n) => n + 1);
          }
        } catch {
          /* ignore malformed */
        }
      });

      es.addEventListener("unread", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { unreadCount: number };
          setUnread(data.unreadCount);
        } catch {
          /* ignore */
        }
      });

      es.onerror = () => {
        // Avoid tight reconnect loops while the gateway/notification service is restarting
        const state = es?.readyState;
        es?.close();
        es = null;
        if (closed) return;
        attempt += 1;
        const delay = Math.min(2000 * 2 ** Math.min(attempt - 1, 4), 20000);
        // readyState 2 = CLOSED; still back off either way
        void state;
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [load]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function refresh(e?: ReactMouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function markRead(id: string) {
    const current = items.find((n) => n.id === id);
    if (current?.read) return;
    try {
      await apiFetch(`/api/v1/notifications/${id}/read`, { method: "POST" });
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      setUnread((n) => Math.max(0, n - 1));
    } catch {
      /* ignore */
    }
  }

  async function markAllRead(e?: ReactMouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    if (unread <= 0) return;
    setMarkingAll(true);
    try {
      await apiFetch("/api/v1/notifications/read-all", { method: "POST" });
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
    } catch {
      const unreadItems = items.filter((n) => !n.read);
      await Promise.allSettled(
        unreadItems.map((n) => apiFetch(`/api/v1/notifications/${n.id}/read`, { method: "POST" })),
      );
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
    } finally {
      setMarkingAll(false);
    }
  }

  function applyDecisionLocally(
    requestId: string,
    notificationId: string,
    decision: "ACCEPTED" | "REJECTED",
  ) {
    const type = decision === "ACCEPTED" ? "JOIN_ACCEPTED" : "JOIN_REJECTED";
    const title = decision === "ACCEPTED" ? "Đã chấp nhận" : "Đã từ chối";
    setItems((prev) =>
      prev.map((n) => {
        if (n.refId !== requestId && n.id !== notificationId) return n;
        const studentHint = n.body?.split(" muốn ")[0] || "Học sinh";
        const body =
          decision === "ACCEPTED"
            ? `Bạn đã chấp nhận ${studentHint} vào lớp.`
            : `Bạn đã từ chối ${studentHint} vào lớp.`;
        return { ...n, type, title, body, read: true };
      }),
    );
  }

  async function resolveTeacherNotif(requestId: string, decision: "ACCEPTED" | "REJECTED") {
    try {
      await apiFetch(`/api/v1/notifications/join-requests/${requestId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
    } catch {
      /* kafka listener may already have resolved */
    }
  }

  async function accept(requestId: string, notificationId: string, e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (acting) return;
    setActing(requestId);
    setActionError("");
    applyDecisionLocally(requestId, notificationId, "ACCEPTED");
    try {
      await apiFetch(`/api/v1/classrooms/join-requests/${requestId}/accept`, { method: "POST" });
      await resolveTeacherNotif(requestId, "ACCEPTED");
      await markRead(notificationId);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await resolveTeacherNotif(requestId, "ACCEPTED");
        await markRead(notificationId);
        await load();
      } else {
        await load();
        setActionError(err instanceof Error ? err.message : "Chấp nhận thất bại");
      }
    } finally {
      setActing(null);
    }
  }

  async function reject(requestId: string, notificationId: string, e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (acting) return;
    setActing(requestId);
    setActionError("");
    applyDecisionLocally(requestId, notificationId, "REJECTED");
    try {
      await apiFetch(`/api/v1/classrooms/join-requests/${requestId}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await resolveTeacherNotif(requestId, "REJECTED");
      await markRead(notificationId);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await resolveTeacherNotif(requestId, "REJECTED");
        await markRead(notificationId);
        await load();
      } else {
        await load();
        setActionError(err instanceof Error ? err.message : "Từ chối thất bại");
      }
    } finally {
      setActing(null);
    }
  }

  async function openItem(n: NotificationItem) {
    await markRead(n.id);
    // Teacher-resolved join items (updated in place) — stay on teacher side
    if (
      n.title?.startsWith("Đã chấp nhận") ||
      n.title?.startsWith("Đã từ chối") ||
      n.body?.startsWith("Bạn đã chấp nhận") ||
      n.body?.startsWith("Bạn đã từ chối")
    ) {
      try {
        const payload = n.payloadJson ? (JSON.parse(n.payloadJson) as { classroomId?: string }) : {};
        if (payload.classroomId) {
          router.push(`/teacher/classrooms/${payload.classroomId}/quizzes`);
          setOpen(false);
          return;
        }
      } catch {
        /* fall through */
      }
      router.push("/home?tab=classrooms");
      setOpen(false);
      return;
    }
    if (n.type === "JOIN_ACCEPTED") {
      try {
        const payload = n.payloadJson ? (JSON.parse(n.payloadJson) as { classroomId?: string }) : {};
        if (payload.classroomId) {
          router.push(`/student/classrooms/${payload.classroomId}`);
          setOpen(false);
          return;
        }
      } catch {
        /* fall through */
      }
      router.push("/home?tab=classrooms");
      setOpen(false);
      return;
    }
    if (n.type === "JOIN_REJECTED") {
      router.push("/student/join");
      setOpen(false);
    }
  }

  return (
    <div className="notif-bell" ref={panelRef}>
      <button
        type="button"
        className="notif-trigger"
        onClick={() => {
          setOpen((v) => {
            if (!v) setPage(1);
            return !v;
          });
        }}
        aria-label="Thông báo"
        title="Thông báo"
      >
        <IconBell />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-panel-head">
            <strong>Thông báo</strong>
            <div className="notif-panel-actions">
              <button
                type="button"
                className="notif-icon-btn"
                title="Đánh dấu đã đọc"
                aria-label="Đánh dấu tất cả đã đọc"
                disabled={markingAll || unread <= 0}
                onClick={(e) => void markAllRead(e)}
              >
                <IconChecks />
              </button>
              <button
                type="button"
                className="notif-icon-btn"
                title="Làm mới"
                aria-label="Làm mới thông báo"
                disabled={refreshing}
                onClick={(e) => void refresh(e)}
              >
                <IconRefresh spinning={refreshing} />
              </button>
            </div>
          </div>
          {actionError && (
            <div className="alert alert-error" style={{ margin: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
              {actionError}
            </div>
          )}
          {items.length === 0 ? (
            <p className="empty-state" style={{ padding: "1rem", margin: 0 }}>
              Chưa có thông báo
            </p>
          ) : (
            <>
              <ul className="notif-list">
                {pageItems.map((n) => (
                  <li key={n.id} className={n.read ? "notif-item" : "notif-item notif-item--unread"}>
                    <div className="notif-item-row">
                      <button type="button" className="notif-item-main" onClick={() => void openItem(n)}>
                        <strong>{n.title}</strong>
                        <span>{n.body}</span>
                      </button>
                      {!n.read && (
                        <button
                          type="button"
                          className="notif-icon-btn"
                          title="Đánh dấu đã xem"
                          aria-label="Đánh dấu đã đọc"
                          onClick={(e) => {
                            e.stopPropagation();
                            void markRead(n.id);
                          }}
                        >
                          <IconCheck />
                        </button>
                      )}
                    </div>
                    {n.type === "JOIN_REQUEST" && n.refId && (
                      <div className="notif-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={acting === n.refId}
                          onClick={(e) => void accept(n.refId!, n.id, e)}
                        >
                          Chấp nhận
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={acting === n.refId}
                          onClick={(e) => void reject(n.refId!, n.id, e)}
                        >
                          Từ chối
                        </button>
                      </div>
                    )}
                    {(n.type === "JOIN_ACCEPTED" || n.type === "JOIN_REJECTED" || n.type === "JOIN_HANDLED") && (
                      <div className="notif-status-row">
                        <span
                          className={`notif-status ${
                            n.type === "JOIN_REJECTED" ? "notif-status--rejected" : "notif-status--accepted"
                          }`}
                        >
                          {n.type === "JOIN_REJECTED" ? "Đã từ chối" : "Đã chấp nhận"}
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <PaginationBar
                className="pager--compact"
                page={page}
                totalPages={totalPages}
                totalItems={items.length}
                onChange={setPage}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
