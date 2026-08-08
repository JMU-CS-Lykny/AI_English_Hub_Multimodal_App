"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { apiFetch } from "@/lib/api";
import { setAuth } from "@/lib/auth";
import type { RegisterRequest, TokenResponse } from "@/lib/types";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Mật khẩu phải có ít nhất 8 ký tự");
      return;
    }

    setLoading(true);

    try {
      const body: RegisterRequest = {
        email,
        password,
        locale: "vi",
      };
      const data = await apiFetch<TokenResponse>("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setAuth(data.accessToken, data.user);
      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng ký thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell page-shell--auth h-screen min-h-screen flex flex-col">
      <SiteHeader />
      <main className="page-main page-main--narrow flex-1 min-h-0 overflow-auto">
        <div className="card card--auth">
          <h1 className="card-title">Đăng ký</h1>
          <p className="card-subtitle">
            Tạo tài khoản mới trên AI English Hub
          </p>

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
                minLength={8}
                autoComplete="new-password"
                placeholder="Ít nhất 8 ký tự"
              />
            </div>

            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? "Đang tạo tài khoản…" : "Đăng ký"}
            </button>
          </form>

          <p className="form-footer">
            Đã có tài khoản?{" "}
            <Link href="/login">Đăng nhập</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
