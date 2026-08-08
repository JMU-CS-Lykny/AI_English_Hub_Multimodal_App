"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";

function DashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/home");
  }, [router]);

  return (
    <main className="page-main">
      <p className="empty-state">Đang chuyển tới trang chủ…</p>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <DashboardRedirect />
      </div>
    </AuthGuard>
  );
}
