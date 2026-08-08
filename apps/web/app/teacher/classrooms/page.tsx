import { redirect } from "next/navigation";

/** Teacher classroom list lives on Home → Lớp học. Nested quiz routes stay under this segment. */
export default function TeacherClassroomsRedirectPage() {
  redirect("/home?tab=classrooms");
}
