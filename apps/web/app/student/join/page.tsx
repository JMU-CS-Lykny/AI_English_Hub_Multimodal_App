"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import SiteHeader from "@/components/SiteHeader";
import StudentMascotHost from "@/components/StudentMascotHost";
import { apiFetch } from "@/lib/api";
import type { JoinRequestItem } from "@/lib/types";

function JoinContent() {
  const router = useRouter();
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<JoinRequestItem | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setPending(null);
    setLoading(true);

    try {
      const data = await apiFetch<JoinRequestItem>("/api/v1/classrooms/join-requests", {
        method: "POST",
        body: JSON.stringify({ inviteCode: inviteCode.trim() }),
      });

      if (data.status === "ACCEPTED") {
        router.push(`/student/classrooms/${data.classroomId}`);
        return;
      }

      setPending(data);
      setInviteCode("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Không gửi được yêu cầu tham gia";
      if (msg.toLowerCase().includes("already enrolled")) {
        router.push("/home?tab=classrooms");
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-title-row">
        <div>
          <h1>Tham gia lớp</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Gửi yêu cầu bằng mã mời — giáo viên sẽ chấp nhận hoặc từ chối
          </p>
        </div>
        <Link href="/home?tab=classrooms" className="btn btn-ghost btn-sm">
          ← Lớp của tôi
        </Link>
      </div>

      <div className="card" style={{ marginTop: "1.5rem" }}>
        {error && <div className="alert alert-error">{error}</div>}
        {pending && (
          <div className="alert alert-info">
            <strong>Đang chờ duyệt</strong>
            <br />
            Yêu cầu `{pending.id.slice(0, 8)}…` đã gửi. Giáo viên sẽ nhận thông báo ngay.
            Bạn cũng sẽ được báo khi được chấp nhận hoặc từ chối (chuông Thông báo).
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="inviteCode">
              Mã mời
            </label>
            <input
              id="inviteCode"
              type="text"
              className="form-input"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              required
              placeholder="ABC12345"
              style={{ fontFamily: "monospace", letterSpacing: "0.1em" }}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? "Đang gửi…" : "Gửi yêu cầu"}
          </button>
        </form>
      </div>
    </>
  );
}

export default function JoinPage() {
  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main page-main--narrow flex-1 min-h-0 overflow-auto">
          <JoinContent />
        </main>
        <StudentMascotHost />
      </div>
    </AuthGuard>
  );
}
