"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import NotificationBell from "@/components/NotificationBell";
import { AUTH_USER_CHANGED_EVENT, clearAuth, getUser } from "@/lib/auth";
import type { User } from "@/lib/types";

interface SiteHeaderProps {
  showNav?: boolean;
}

export default function SiteHeader({ showNav = true }: SiteHeaderProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const sync = () => setUser(getUser());
    sync();
    window.addEventListener(AUTH_USER_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTH_USER_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  function handleLogout() {
    clearAuth();
    router.push("/login");
  }

  const initial = (user?.fullName || "?").trim().charAt(0).toUpperCase();

  return (
    <header className="site-header">
      <Link href={user ? "/home" : "/"} className="brand">
        <img
          className="brand-mark"
          src="/icon.svg"
          alt=""
          width={28}
          height={28}
          aria-hidden
        />
        AI English Hub
      </Link>
      {showNav && (
        <nav className="nav-links">
          {user ? (
            <>
              <span className="site-header-user">
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="site-header-avatar"
                    src={user.avatarUrl}
                    alt=""
                    width={28}
                    height={28}
                  />
                ) : (
                  <span className="site-header-avatar site-header-avatar--fallback" aria-hidden>
                    {initial}
                  </span>
                )}
                <span className="site-header-name">{user.fullName}</span>
              </span>
              <NotificationBell />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleLogout}
              >
                Đăng xuất
              </button>
            </>
          ) : (
            <>
              <Link href="/login">Đăng nhập</Link>
              <Link href="/register" className="btn btn-primary btn-sm">
                Đăng ký
              </Link>
            </>
          )}
        </nav>
      )}
    </header>
  );
}
