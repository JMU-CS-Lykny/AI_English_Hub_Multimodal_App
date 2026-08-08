"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import type { Classroom, Role, User } from "@/lib/types";
import type { HomeTab } from "./HomeShell";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Quản trị viên",
  TEACHER: "Giáo viên",
  STUDENT: "Học sinh",
};

function asArray<T>(data: T | T[] | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

interface OverviewPanelProps {
  user: User;
  onNavigate: (tab: HomeTab) => void;
}

export default function OverviewPanel({ user, onNavigate }: OverviewPanelProps) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<Classroom[] | Classroom>("/api/v1/classrooms")
      .then((data) => setCount(asArray(data).length))
      .catch(() => setCount(0));
  }, []);

  const isStudent = user.role === "STUDENT";
  const isTeacherLike = user.role === "TEACHER" || user.role === "ADMIN";

  return (
    <div className="home-overview">
      <div className="home-hero">
        <span className="role-badge">{ROLE_LABELS[user.role]}</span>
        <h1>Xin chào, {user.fullName}</h1>
        <p>
          {isStudent
            ? "Vào lớp, tham gia bằng mã mời, hoặc hỏi AI Mascot khi cần."
            : "Quản lý lớp học và theo dõi nhanh từ trung tâm này."}
        </p>
        {count !== null && (
          <p className="home-hero-stat">
            {count} lớp học
          </p>
        )}
      </div>

      <div className="home-tiles">
        {isTeacherLike && (
          <>
            <button type="button" className="home-tile" onClick={() => onNavigate("classrooms")}>
              <span className="home-tile-kicker">Lớp học</span>
              <strong>Xem lớp của bạn</strong>
              <span>Danh sách lớp — tạo lớp, mã mời và quản lý từ đây.</span>
            </button>
            {user.role === "TEACHER" && (
              <Link href="/student/tutor" className="home-tile">
                <span className="home-tile-kicker">AI Tutor</span>
                <strong>Xem trước AI Tutor</strong>
                <span>Thử trải nghiệm học viên với gia sư AI.</span>
              </Link>
            )}
            {user.role === "ADMIN" && (
              <div className="home-tile home-tile--muted">
                <span className="home-tile-kicker">Hệ thống</span>
                <strong>Quản trị</strong>
                <span>Công cụ quản trị sẽ sớm có mặt.</span>
              </div>
            )}
          </>
        )}

        {isStudent && (
          <>
            <button type="button" className="home-tile" onClick={() => onNavigate("classrooms")}>
              <span className="home-tile-kicker">Lớp của tôi</span>
              <strong>Xem lớp đã tham gia</strong>
              <span>Bài học, bài kiểm tra và học với AI theo từng lớp.</span>
            </button>
            <button type="button" className="home-tile" onClick={() => onNavigate("join")}>
              <span className="home-tile-kicker">Tham gia</span>
              <strong>Nhập mã mời</strong>
              <span>Gửi yêu cầu — giáo viên chấp nhận hoặc từ chối.</span>
            </button>
            <button type="button" className="home-tile" onClick={() => onNavigate("mascot")}>
              <span className="home-tile-kicker">AI Mascot</span>
              <strong>Hỏi bạn đồng hành</strong>
              <span>Hỗ trợ app hoặc trò chuyện theo lớp đã tham gia.</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
