"use client";

import { Suspense } from "react";
import AuthGuard from "@/components/AuthGuard";
import HomeShell from "@/components/home/HomeShell";

export default function HomePage() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <div className="page-shell h-screen min-h-screen flex flex-col">
            <main className="page-main flex-1 min-h-0 overflow-auto">
              <p className="empty-state">Đang tải…</p>
            </main>
          </div>
        }
      >
        <HomeShell />
      </Suspense>
    </AuthGuard>
  );
}
