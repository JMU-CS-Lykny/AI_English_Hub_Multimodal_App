export type Role = "ADMIN" | "TEACHER" | "STUDENT";

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  locale: string;
  grade?: string | null;
  avatarUrl?: string | null;
}

/** Public register body — role/fullName are assigned by the identity service. */
export interface RegisterRequest {
  email: string;
  password: string;
  locale?: string;
}

export interface UpdateProfileRequest {
  fullName: string;
  email: string;
  grade?: string | null;
  avatarUrl?: string | null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSeconds: number;
  user: User;
}

export interface Classroom {
  id: string;
  name: string;
  description: string;
  teacherId: string;
  inviteCode: string;
}

export interface Lesson {
  id: string;
  classroomId: string;
  title: string;
  body: string;
  cefrLevel: string;
  status: string;
}

export type QuizStatus = "DRAFT" | "PUBLISHED";
export type QuestionType = "short" | "mcq";

export interface QuizQuestion {
  id?: string;
  prompt: string;
  type: QuestionType;
  choices?: string[];
  answer?: string;
}

export interface Quiz {
  id: string;
  classroomId: string;
  title: string;
  status?: QuizStatus;
  questionsJson: string;
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  studentId: string;
  score: number;
  maxScore: number;
  submittedAt?: string;
}

export interface GenerateQuizResponse {
  title: string;
  questions: QuizQuestion[];
  source?: string;
}

export interface ClassroomMember {
  id: string;
  classroomId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  joinedAt?: string;
}

export interface TutorSource {
  lessonId?: string;
  title?: string;
  score?: number;
}

export type TutorMode = "english_learning" | "general";

export interface TutorResponse {
  reply?: string;
  message?: string;
  response?: string;
  grounded?: boolean;
  sources?: TutorSource[];
  mode?: TutorMode | string;
  transcript?: string | null;
}

/** Educational illustration from POST /api/v1/ai/tutor/image */
export interface TutorImageResponse {
  caption: string;
  provider: string;
  mimeType: string;
  imageSvg?: string | null;
  imageDataUrl: string;
  subject?: string | null;
  classroomName?: string | null;
  note?: string | null;
}

/** Short educational clip from POST /api/v1/ai/tutor/video */
export interface TutorVideoResponse {
  caption: string;
  provider: string;
  mimeType: string;
  videoSvg?: string | null;
  videoDataUrl: string;
  durationSec?: number | null;
  subject?: string | null;
  classroomName?: string | null;
  note?: string | null;
}

export interface TutorSttResponse {
  text: string;
  language?: string;
  provider?: string;
  note?: string | null;
}

export interface TutorVisionResponse {
  description: string;
  provider?: string;
  note?: string | null;
  classroomId?: string | null;
}

export interface JoinRequestItem {
  id: string;
  classroomId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  message?: string | null;
  rejectReason?: string | null;
  createdAt?: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  payloadJson?: string | null;
  refType?: string | null;
  refId?: string | null;
  read: boolean;
  createdAt: string;
}
