"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { apiFetch } from "@/lib/api";
import { setAuth } from "@/lib/auth";
import type { TokenResponse } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await apiFetch<TokenResponse>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setAuth(data.accessToken, data.user);
      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell page-shell--auth h-screen min-h-screen flex flex-col">
      <SiteHeader />
      <main className="page-main page-main--narrow flex-1 min-h-0 overflow-auto">
        <div className="card card--auth">
          <h1 className="card-title">Đăng nhập</h1>
          <p className="card-subtitle">
            Chào mừng trở lại AI English Hub
          </p>

          <div className="alert alert-info">
            <strong>Tài khoản demo:</strong>
            <br />
            teacher@englishhub.vn / Password123!
            <br />
            student@englishhub.vn / Password123!
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="ban@email.com"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password">
                Mật khẩu
              </label>
              <input
                id="password"
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? "Đang đăng nhập…" : "Đăng nhập"}
            </button>
          </form>

          <p className="form-footer">
            Chưa có tài khoản?{" "}
            <Link href="/register">Đăng ký</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
