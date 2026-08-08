"use client";

import { Suspense } from "react";
import AuthGuard from "@/components/AuthGuard";
import SiteHeader from "@/components/SiteHeader";
import StudentMascotHost from "@/components/StudentMascotHost";
import TutorInner from "./TutorInner";

export default function TutorPage() {
  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main page-main--wide page-main--tutor flex-1 min-h-0 overflow-auto">
          <Suspense fallback={<p className="empty-state">Đang tải AI Tutor…</p>}>
            <TutorInner />
          </Suspense>
        </main>
        <StudentMascotHost />
      </div>
    </AuthGuard>
  );
}
