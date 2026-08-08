"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import type { JoinRequestItem } from "@/lib/types";

export default function JoinPanel() {
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
    <div className="home-join">
      <div className="home-panel-head home-panel-head--row">
        <div>
          <h2>Tham gia lớp</h2>
          <p>Gửi yêu cầu bằng mã mời — giáo viên sẽ chấp nhận hoặc từ chối.</p>
        </div>
        <Link href="/student/join" className="btn btn-ghost btn-sm">
          Trang đầy đủ →
        </Link>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {pending && (
        <div className="alert alert-info">
          <strong>Đang chờ duyệt</strong>
          <br />
          Yêu cầu `{pending.id.slice(0, 8)}…` đã gửi. Bạn sẽ được báo qua chuông Thông báo.
        </div>
      )}

      <form onSubmit={handleSubmit} className="home-join-form">
        <div className="form-group">
          <label className="form-label" htmlFor="homeInviteCode">
            Mã mời
          </label>
          <input
            id="homeInviteCode"
            type="text"
            className="form-input"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            required
            placeholder="ABC12345"
            style={{ fontFamily: "monospace", letterSpacing: "0.1em" }}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "Đang gửi…" : "Gửi yêu cầu"}
        </button>
      </form>
    </div>
  );
}
