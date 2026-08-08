"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, fileToAvatarDataUrl, updateProfile } from "@/lib/api";
import { clearAuth, setStoredUser } from "@/lib/auth";
import { CLASS_LEVEL_OPTIONS } from "@/lib/classroomMeta";
import type { Role, User } from "@/lib/types";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Quản trị viên",
  TEACHER: "Giáo viên",
  STUDENT: "Học sinh",
};

const GRADE_OPTIONS = [...CLASS_LEVEL_OPTIONS] as string[];

interface AccountPanelProps {
  user: User;
  onUserUpdated?: (user: User) => void;
}

export default function AccountPanel({ user, onUserUpdated }: AccountPanelProps) {
  const router = useRouter();
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email);
  const [grade, setGrade] = useState(user.grade || "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || "");
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setFullName(user.fullName);
    setEmail(user.email);
    setGrade(user.grade || "");
    setAvatarUrl(user.avatarUrl || "");
  }, [user]);

  async function handleAvatarChange(file: File | null) {
    if (!file) return;
    setError(null);
    setSuccess(null);
    setAvatarBusy(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setAvatarUrl(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được ảnh.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const updated = await updateProfile({
        fullName: fullName.trim(),
        email: email.trim(),
        grade: grade.trim() || null,
        avatarUrl: avatarUrl.trim() || null,
      });
      setStoredUser(updated);
      onUserUpdated?.(updated);
      setSuccess("Đã lưu thông tin tài khoản.");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Không lưu được.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleLogout() {
    clearAuth();
    router.push("/login");
  }

  return (
    <div className="home-account">
      <div className="home-panel-head">
        <h2>Tài khoản</h2>
        <p>Cập nhật họ tên, email, khối lớp và ảnh đại diện.</p>
      </div>

      <form className="home-account-form" onSubmit={handleSave}>
        <div className="home-account-avatar-row">
          <div className="home-account-avatar-preview" aria-hidden={!avatarUrl}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" />
            ) : (
              <span>{(fullName || "?").trim().charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="home-account-avatar-controls">
            <label className="form-label" htmlFor="account-avatar">
              Ảnh đại diện
            </label>
            <input
              id="account-avatar"
              type="file"
              accept="image/*"
              className="form-input"
              disabled={avatarBusy || saving}
              onChange={(e) => void handleAvatarChange(e.target.files?.[0] ?? null)}
            />
            <p className="home-account-hint">
              Ảnh sẽ được nén (~200KB) và lưu dưới dạng data URL.
            </p>
            {avatarUrl && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => setAvatarUrl("")}
              >
                Xóa ảnh
              </button>
            )}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="account-fullName">
            Họ và tên
          </label>
          <input
            id="account-fullName"
            className="form-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            maxLength={255}
            autoComplete="name"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="account-email">
            Email
          </label>
          <input
            id="account-email"
            type="email"
            className="form-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={255}
            autoComplete="email"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="account-grade">
            Khối lớp
          </label>
          <select
            id="account-grade"
            className="form-select"
            value={GRADE_OPTIONS.includes(grade) ? grade : grade ? "__other__" : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__other__") {
                setGrade(grade && !GRADE_OPTIONS.includes(grade) ? grade : "Khác");
              } else {
                setGrade(v);
              }
            }}
          >
            <option value="">— Chọn khối lớp —</option>
            {GRADE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
            {grade && !GRADE_OPTIONS.includes(grade) ? (
              <option value="__other__">{grade}</option>
            ) : null}
          </select>
          {(grade === "Khác" || (grade && !GRADE_OPTIONS.includes(grade))) && (
            <input
              className="form-input"
              style={{ marginTop: "0.5rem" }}
              placeholder="Nhập khối lớp (tùy chọn)"
              value={grade === "Khác" ? "" : grade}
              onChange={(e) => {
                const v = e.target.value.trim();
                setGrade(v || "Khác");
              }}
              maxLength={64}
            />
          )}
        </div>

        <div className="form-group">
          <span className="form-label">Vai trò</span>
          <p className="home-account-role">{ROLE_LABELS[user.role]}</p>
        </div>

        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-success">{success}</p>}

        <div className="home-account-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || avatarBusy || !fullName.trim() || !email.trim()}
          >
            {saving ? "Đang lưu…" : "Lưu thay đổi"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleLogout}>
            Đăng xuất
          </button>
        </div>
      </form>
    </div>
  );
}
