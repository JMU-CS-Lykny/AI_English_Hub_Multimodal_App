import { redirect } from "next/navigation";

/** Student classroom list lives on Home → Lớp học. Nested detail/quiz routes stay under this segment. */
export default function StudentClassroomsRedirectPage() {
  redirect("/home?tab=classrooms");
}
