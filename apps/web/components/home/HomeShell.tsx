"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import MascotChat from "@/components/MascotChat";
import StudentMascotHost from "@/components/StudentMascotHost";
import { getUser } from "@/lib/auth";
import type { Role, User } from "@/lib/types";
import OverviewPanel from "./OverviewPanel";
import ClassroomsPanel from "./ClassroomsPanel";
import AccountPanel from "./AccountPanel";
import JoinPanel from "./JoinPanel";

export type HomeTab =
  | "overview"
  | "classrooms"
  | "join"
  | "mascot"
  | "account";

interface TabDef {
  id: HomeTab;
  label: string;
  hint: string;
}

const TEACHER_TABS: TabDef[] = [
  { id: "overview", label: "Tổng quan", hint: "Trang chính" },
  { id: "classrooms", label: "Lớp học", hint: "Quản lý lớp" },
  { id: "account", label: "Tài khoản", hint: "Hồ sơ" },
];

const STUDENT_TABS: TabDef[] = [
  { id: "overview", label: "Tổng quan", hint: "Trang chính" },
  { id: "classrooms", label: "Lớp học", hint: "Lớp của tôi" },
  { id: "join", label: "Tham gia", hint: "Mã mời" },
  { id: "mascot", label: "AI Mascot", hint: "Bạn đồng hành" },
  { id: "account", label: "Tài khoản", hint: "Hồ sơ" },
];

function tabsForRole(role: Role): TabDef[] {
  return role === "STUDENT" ? STUDENT_TABS : TEACHER_TABS;
}

function isHomeTab(value: string | null, role: Role): value is HomeTab {
  if (!value) return false;
  return tabsForRole(role).some((t) => t.id === value);
}

export default function HomeShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, []);

  const tabs = useMemo(
    () => (user ? tabsForRole(user.role) : TEACHER_TABS),
    [user],
  );

  const activeTab: HomeTab = useMemo(() => {
    if (!user) return "overview";
    const raw = searchParams.get("tab");
    return isHomeTab(raw, user.role) ? raw : "overview";
  }, [searchParams, user]);

  function setTab(tab: HomeTab) {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    router.replace(qs ? `/home?${qs}` : "/home", { scroll: false });
  }

  if (!user) {
    return (
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main flex-1 min-h-0 overflow-auto">
          <p className="empty-state">Đang tải…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell home-page h-screen min-h-screen flex flex-col">
      <SiteHeader />
      <div className="home-shell flex-1 min-h-0">
        <aside className="home-rail" aria-label="Điều hướng trang chủ">
          <p className="home-rail-label">Menu</p>
          <nav className="home-rail-nav">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`home-tab${activeTab === tab.id ? " home-tab--active" : ""}`}
                onClick={() => setTab(tab.id)}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                <span className="home-tab-label">{tab.label}</span>
                <span className="home-tab-hint">{tab.hint}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="home-panel" aria-live="polite">
          {activeTab === "overview" && <OverviewPanel user={user} onNavigate={setTab} />}
          {activeTab === "classrooms" && <ClassroomsPanel user={user} />}
          {activeTab === "join" && user.role === "STUDENT" && <JoinPanel />}
          {activeTab === "mascot" && user.role === "STUDENT" && (
            <div className="home-mascot-embed">
              <div className="home-panel-head">
                <h2>AI Mascot</h2>
                <p>Hỗ trợ app hoặc trò chuyện theo lớp đã tham gia</p>
              </div>
              <MascotChat variant="embedded" />
            </div>
          )}
          {activeTab === "account" && (
            <AccountPanel user={user} onUserUpdated={setUser} />
          )}
        </section>
      </div>

      {user.role === "STUDENT" && activeTab !== "mascot" && <StudentMascotHost />}
    </div>
  );
}
