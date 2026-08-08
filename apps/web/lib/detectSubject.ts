import { apiFetch } from "./api";
import {
  ALL_CLASSROOM_SUBJECTS,
  ClassroomSubject,
  detectKnowledgesFromText,
  detectSubjectFromText,
  normalizeKnowledges,
  SUBJECT_LABELS,
} from "./classroomMeta";

export interface DetectSubjectResult {
  subject: ClassroomSubject;
  knowledges: string[];
  confidence: number;
  source: "ai" | "heuristic";
}

/** Map English API knowledge labels → Vietnamese UI labels. */
const KNOWLEDGE_EN_TO_VI: Record<string, string> = {
  Grammar: "Ngữ pháp",
  Vocabulary: "Từ vựng",
  Speaking: "Nói",
  Listening: "Nghe",
  Writing: "Viết",
  Reading: "Đọc",
  Pronunciation: "Phát âm",
  "IELTS Prep": "Luyện IELTS",
  "TOEIC Prep": "Luyện TOEIC",
  "Business English": "Tiếng Anh thương mại",
  Literature: "Ngữ văn",
  History: "Lịch sử",
  Science: "Khoa học",
  Math: "Toán",
  Physics: "Vật lí",
  Chemistry: "Hóa học",
  Biology: "Sinh học",
  Geography: "Địa lí",
  "Exam Skills": "Kỹ năng thi",
  Communication: "Giao tiếp",
};

/** Extra aliases (Vietnamese / short names) → stable English keys. */
const SUBJECT_ALIASES: Record<string, ClassroomSubject> = {
  "ngữ văn": "Literature",
  "văn học": "Literature",
  "toán": "Math",
  "toán học": "Math",
  "ngoại ngữ": "English",
  "ngoại ngữ 1": "English",
  "ngoại ngữ 1 (ví dụ: tiếng anh)": "English",
  "tiếng anh": "English",
  "foreign language": "English",
  "lịch sử": "History",
  "giáo dục thể chất": "PhysicalEducation",
  "thể chất": "PhysicalEducation",
  "thể dục": "PhysicalEducation",
  "giáo dục quốc phòng và an ninh": "NationalDefense",
  "quốc phòng": "NationalDefense",
  "hoạt động trải nghiệm, hướng nghiệp": "ExperientialActivities",
  "trải nghiệm": "ExperientialActivities",
  "hướng nghiệp": "ExperientialActivities",
  "nội dung giáo dục của địa phương": "LocalEducation",
  "địa phương": "LocalEducation",
  "vật lí": "Physics",
  "vật lý": "Physics",
  "hóa học": "Chemistry",
  "hoá học": "Chemistry",
  "sinh học": "Biology",
  "địa lí": "Geography",
  "địa lý": "Geography",
  "giáo dục kinh tế và pháp luật": "CivicEducation",
  "gdkt&pl": "CivicEducation",
  "công nghệ": "Technology",
  "tin học": "Informatics",
  "âm nhạc": "Music",
  "mĩ thuật": "FineArts",
  "mỹ thuật": "FineArts",
  "khoa học": "Science",
  "kinh doanh": "Business",
  khác: "Other",
};

function normalizeSubject(value: string | undefined | null): ClassroomSubject {
  const trimmed = (value || "").trim();
  if (!trimmed) return "Other";

  const byKey = ALL_CLASSROOM_SUBJECTS.find((s) => s.toLowerCase() === trimmed.toLowerCase());
  if (byKey) return byKey;

  const lower = trimmed.toLowerCase();
  if (SUBJECT_ALIASES[lower]) return SUBJECT_ALIASES[lower];

  const byLabel = (Object.entries(SUBJECT_LABELS) as [ClassroomSubject, string][]).find(
    ([, label]) => label.toLowerCase() === lower,
  );
  if (byLabel) return byLabel[0];

  return "Other";
}

function localizeKnowledges(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const mapped = values.map((raw) => {
    if (typeof raw !== "string") return "";
    const trimmed = raw.trim();
    return KNOWLEDGE_EN_TO_VI[trimmed] || trimmed;
  });
  return normalizeKnowledges(mapped);
}

/** Instant local subject + knowledge detection (no network). */
export function detectClassroomSubjectLocal(
  name: string,
  description: string,
): DetectSubjectResult {
  const text = `${name} ${description}`;
  const local = detectSubjectFromText(text);
  return {
    subject: local.subject,
    knowledges: detectKnowledgesFromText(text),
    confidence: local.confidence,
    source: "heuristic",
  };
}

/** Detect main subject + knowledge topics from description via AI API, with local fallback. */
export async function detectClassroomSubject(
  name: string,
  description: string,
): Promise<DetectSubjectResult> {
  const local = detectClassroomSubjectLocal(name, description);

  if (!((name ?? "").trim() || (description ?? "").trim())) {
    return local;
  }

  try {
    const data = await apiFetch<{
      subject: string;
      knowledges?: string[];
      confidence?: number;
      source?: string;
    }>("/api/v1/ai/detect-subject", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });

    const knowledges = localizeKnowledges(data.knowledges);
    let subject = normalizeSubject(data.subject);

    // Guard AI Literature bias when local heuristics clearly match another subject
    // (e.g. Geography title + "văn hóa" in description → Ngữ văn).
    const litSignal = /\b(literature|poetry|novel)\b|(ngữ\s*văn|văn\s*học|tiểu\s*thuyết)/i.test(
      `${name} ${description}`,
    );
    if (
      subject === "Literature" &&
      local.subject !== "Literature" &&
      local.subject !== "Other" &&
      local.confidence >= 0.7 &&
      !litSignal
    ) {
      return {
        subject: local.subject,
        knowledges: local.knowledges.length > 0 ? local.knowledges : knowledges,
        confidence: local.confidence,
        source: "heuristic",
      };
    }

    const litKnowledges = knowledges.filter((k) =>
      /^(ngữ\s*văn|văn\s*học|literature|đọc|viết|thơ)$/i.test(k.trim()),
    );
    if (
      subject === "Geography" &&
      litKnowledges.length >= Math.max(1, Math.floor(knowledges.length / 2)) &&
      local.knowledges.length > 0
    ) {
      return {
        subject,
        knowledges: local.knowledges,
        confidence: typeof data.confidence === "number" ? data.confidence : 0.85,
        source: data.source === "ai" ? "ai" : "heuristic",
      };
    }

    return {
      subject,
      knowledges: knowledges.length > 0 ? knowledges : local.knowledges,
      confidence: typeof data.confidence === "number" ? data.confidence : 0.85,
      source: data.source === "ai" ? "ai" : "heuristic",
    };
  } catch {
    return local;
  }
}
