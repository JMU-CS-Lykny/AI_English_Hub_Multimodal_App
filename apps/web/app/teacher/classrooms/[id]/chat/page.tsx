"use client";

import { useParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import ClassroomChat from "@/components/ClassroomChat";
import SiteHeader from "@/components/SiteHeader";

export default function TeacherClassroomChatPage() {
  const params = useParams();
  const classroomId = String(params.id || "");

  return (
    <AuthGuard>
      <div className="page-shell h-screen min-h-screen flex flex-col">
        <SiteHeader />
        <main className="page-main page-main--wide flex-1 min-h-0 overflow-auto">
          <ClassroomChat
            classroomId={classroomId}
            backHref={`/teacher/classrooms/${classroomId}/quizzes`}
            backLabel="← Bài kiểm tra"
          />
        </main>
      </div>
    </AuthGuard>
  );
}
