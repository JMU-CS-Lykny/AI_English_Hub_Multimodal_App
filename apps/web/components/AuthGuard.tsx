"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) {
    return (
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <main className="page-main page-main--narrow flex-1 min-h-0 overflow-auto">
          <p style={{ textAlign: "center", color: "var(--text-muted)", padding: "4rem 0" }}>
            Đang tải…
          </p>
        </main>
      </div>
    );
  }

  return <>{children}</>;
}
