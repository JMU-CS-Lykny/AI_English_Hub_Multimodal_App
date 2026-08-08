export type ClassroomSubject =
  | "Literature"
  | "Math"
  | "English"
  | "History"
  | "PhysicalEducation"
  | "NationalDefense"
  | "ExperientialActivities"
  | "LocalEducation"
  | "Physics"
  | "Chemistry"
  | "Biology"
  | "Geography"
  | "CivicEducation"
  | "Technology"
  | "Informatics"
  | "Music"
  | "FineArts"
  | "IELTS"
  | "TOEIC"
  | "Science"
  | "Business"
  | "Other";

export interface ClassroomMeta {
  subject: ClassroomSubject;
  coverImage: string;
  /** Main knowledge topics detected from the class description. */
  knowledges?: string[];
}

/** Dropdown groups for Môn chính (optgroup labels). */
export const CLASSROOM_SUBJECT_GROUPS: { label: string; subjects: ClassroomSubject[] }[] = [
  {
    label: "Môn bắt buộc / chung",
    subjects: [
      "Literature",
      "Math",
      "English",
      "History",
      "PhysicalEducation",
      "NationalDefense",
      "ExperientialActivities",
      "LocalEducation",
    ],
  },
  {
    label: "Khoa học tự nhiên",
    subjects: ["Physics", "Chemistry", "Biology"],
  },
  {
    label: "Khoa học xã hội",
    subjects: ["Geography", "CivicEducation"],
  },
  {
    label: "Công nghệ và nghệ thuật",
    subjects: ["Technology", "Informatics", "Music", "FineArts"],
  },
  {
    label: "Tiếng Anh / chứng chỉ",
    subjects: ["IELTS", "TOEIC"],
  },
  {
    label: "Khác",
    subjects: ["Business", "Science", "Other"],
  },
];

/** Flat list used in the Môn chính dropdown. */
export const CLASSROOM_SUBJECTS: ClassroomSubject[] = CLASSROOM_SUBJECT_GROUPS.flatMap(
  (g) => g.subjects,
);

/** All known subject keys (same as dropdown; kept for normalize/API). */
export const ALL_CLASSROOM_SUBJECTS: ClassroomSubject[] = [...CLASSROOM_SUBJECTS];

/** Vietnamese display labels for subject keys (keys stay English for storage/API). */
export const SUBJECT_LABELS: Record<ClassroomSubject, string> = {
  Literature: "Ngữ văn",
  Math: "Toán học",
  English: "Ngoại ngữ 1 (ví dụ: Tiếng Anh)",
  History: "Lịch sử",
  PhysicalEducation: "Giáo dục thể chất",
  NationalDefense: "Giáo dục quốc phòng và an ninh",
  ExperientialActivities: "Hoạt động trải nghiệm, hướng nghiệp",
  LocalEducation: "Nội dung giáo dục của địa phương",
  Physics: "Vật lí",
  Chemistry: "Hóa học",
  Biology: "Sinh học",
  Geography: "Địa lí",
  CivicEducation: "Giáo dục kinh tế và pháp luật",
  Technology: "Công nghệ",
  Informatics: "Tin học",
  Music: "Âm nhạc",
  FineArts: "Mĩ thuật",
  IELTS: "IELTS",
  TOEIC: "TOEIC",
  Science: "Khoa học",
  Business: "Kinh doanh",
  Other: "Khác",
};

export function subjectLabel(subject: ClassroomSubject | string | null | undefined): string {
  if (!subject) return SUBJECT_LABELS.Other;
  return SUBJECT_LABELS[subject as ClassroomSubject] || String(subject);
}

/** English-language subjects that use CEFR (not Vietnamese school grade). */
export function isEnglishSubject(subject: ClassroomSubject | string | null | undefined): boolean {
  return subject === "English" || subject === "IELTS" || subject === "TOEIC";
}

/** Vietnamese school / university grade options for non-English quiz level. */
export const CLASS_LEVEL_OPTIONS = [
  "Lớp 6",
  "Lớp 7",
  "Lớp 8",
  "Lớp 9",
  "Lớp 10",
  "Lớp 11",
  "Lớp 12",
  "Đại học",
  "Khác",
] as const;

export type ClassLevel = (typeof CLASS_LEVEL_OPTIONS)[number];

export const CEFR_LEVEL_OPTIONS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

/** Curated classroom cover images by subject (Unsplash). */
export const SUBJECT_COVERS: Record<ClassroomSubject, string[]> = {
  Literature: [
    "https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1481627834876-b7833e1d5e75?auto=format&fit=crop&w=900&q=80",
  ],
  Math: [
    "https://images.unsplash.com/photo-1635070041078-e363dbe005cb?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1509228468518-180dd4864904?auto=format&fit=crop&w=900&q=80",
  ],
  English: [
    "https://images.unsplash.com/photo-1456513080880-7d93ddd2b5e3?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=900&q=80",
  ],
  History: [
    "https://images.unsplash.com/photo-1461360223011-1e0b5e5a0f8b?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=900&q=80",
  ],
  PhysicalEducation: [
    "https://images.unsplash.com/photo-1517649763962-0c62306627c2?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?auto=format&fit=crop&w=900&q=80",
  ],
  NationalDefense: [
    "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=900&q=80",
  ],
  ExperientialActivities: [
    "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=900&q=80",
  ],
  LocalEducation: [
    "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=900&q=80",
  ],
  Physics: [
    "https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=900&q=80",
  ],
  Chemistry: [
    "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1603126857599-c1dd1e4e7e5e?auto=format&fit=crop&w=900&q=80",
  ],
  Biology: [
    "https://images.unsplash.com/photo-1530026405186-ed1f139313f8?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1507413245164-6160d8298b31?auto=format&fit=crop&w=900&q=80",
  ],
  Geography: [
    "https://images.unsplash.com/photo-1526778548025-fa2f459cd5c1?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1461360223011-1e0b5e5a0f8b?auto=format&fit=crop&w=900&q=80",
  ],
  CivicEducation: [
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=900&q=80",
  ],
  Technology: [
    "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80",
  ],
  Informatics: [
    "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80",
  ],
  Music: [
    "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=80",
  ],
  FineArts: [
    "https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=900&q=80",
  ],
  IELTS: [
    "https://images.unsplash.com/photo-1434030216411-0b793f4b4173?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=900&q=80",
  ],
  TOEIC: [
    "https://images.unsplash.com/photo-1434030216411-0b793f4b4173?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1456513080880-7d93ddd2b5e3?auto=format&fit=crop&w=900&q=80",
  ],
  Science: [
    "https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1507413245164-6160d8298b31?auto=format&fit=crop&w=900&q=80",
  ],
  Business: [
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=900&q=80",
  ],
  Other: [
    "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=900&q=80",
  ],
};

const STORAGE_KEY = "eh.classroomMeta.v1";

/**
 * ASCII `\b` does not treat Vietnamese letters as word chars, so patterns like
 * `\bđịa\s*lý\b` never match in JS. Match VI/EN keywords without relying on `\b`.
 */
const SUBJECT_RULES: { subject: ClassroomSubject; weight: number; pattern: RegExp }[] = [
  { subject: "IELTS", weight: 5, pattern: /\b(ielts|band\s?[56789]|academic\s+writing|speaking\s+test)\b/i },
  { subject: "TOEIC", weight: 5, pattern: /\b(toeic)\b/i },
  { subject: "IELTS", weight: 3, pattern: /\b(toefl|luyện\s*thi\s*(?:anh|tiếng\s*anh)|thi\s*chứng\s*chỉ)\b/i },
  {
    subject: "Geography",
    weight: 5,
    pattern:
      /(geography|địa\s*l[iíý]|địa\s*lý|trái\s*đất|bản\s*đồ|khí\s*hậu|địa\s*hình|dân\s*cư|dân\s*số|đô\s*thị\s*hóa|di\s*cư|toàn\s*cầu\s*hóa|tài\s*nguyên|không\s*gian|môi\s*trường)/i,
  },
  {
    subject: "Literature",
    weight: 4,
    // Do NOT treat bare "văn hóa" as literature (cultural geography).
    pattern: /\b(literature|literary|poetry|poem|novel|shakespeare)\b|(ngữ\s*văn|văn\s*học|tiểu\s*thuyết|(?<![a-zà-ỹ])thơ(?![a-zà-ỹ]))/i,
  },
  {
    subject: "History",
    weight: 4,
    pattern:
      /\b(history|historical|civilization|war|dynasty)\b|(lịch\s*sử|lịch\s*chiến|chiến\s*tranh|chiến\s*dịch|cách\s*mạng|triều\s*đại|kháng\s*chiến)/i,
  },
  { subject: "Math", weight: 4, pattern: /\b(math|mathematics|algebra|geometry|calculus|equation)\b|(toán(?:\s*học)?|đại\s*số|hình\s*học)/i },
  { subject: "Physics", weight: 4, pattern: /\b(physics)\b|(vật\s*l[iíý]|cơ\s*học|điện\s*học|quang\s*học)/i },
  { subject: "Chemistry", weight: 4, pattern: /\b(chemistry)\b|(hóa\s*học|hoá\s*học)/i },
  { subject: "Biology", weight: 4, pattern: /\b(biology)\b|(sinh\s*học|di\s*truyền|tế\s*bào)/i },
  {
    subject: "CivicEducation",
    weight: 4,
    pattern: /\b(civic)\b|(giáo\s*dục\s*kinh\s*tế|pháp\s*luật|gdkt&pl|kinh\s*tế\s*và\s*pháp\s*luật)/i,
  },
  { subject: "PhysicalEducation", weight: 4, pattern: /\b(physical\s*education|\bpe\b)\b|(thể\s*chất|thể\s*dục|gdtc)/i },
  {
    subject: "NationalDefense",
    weight: 4,
    pattern: /\b(national\s*defense)\b|(quốc\s*phòng|an\s*ninh|gdqp|gdqpan)/i,
  },
  {
    subject: "ExperientialActivities",
    weight: 4,
    pattern: /\b(experiential)\b|(trải\s*nghiệm|hướng\s*nghiệp|hoạt\s*động\s*trải\s*nghiệm)/i,
  },
  {
    subject: "LocalEducation",
    weight: 4,
    pattern: /\b(local\s*education)\b|(giáo\s*dục\s*(?:của\s*)?địa\s*phương|nội\s*dung\s*địa\s*phương)/i,
  },
  { subject: "Technology", weight: 4, pattern: /\b(technology)\b|(công\s*nghệ(?!\s*thông\s*tin)|kỹ\s*thuật)/i },
  { subject: "Informatics", weight: 4, pattern: /\b(informatics|computer\s*science|programming|coding)\b|(tin\s*học|lập\s*trình)/i },
  { subject: "Music", weight: 4, pattern: /\b(music)\b|(âm\s*nhạc)|(?<![a-zà-ỹ])nhạc(?![a-zà-ỹ])/i },
  { subject: "FineArts", weight: 4, pattern: /\b(fine\s*arts?|art)\b|(mĩ\s*thuật|mỹ\s*thuật|hội\s*họa)|(?<![a-zà-ỹ])vẽ(?![a-zà-ỹ])/i },
  { subject: "Science", weight: 2, pattern: /\b(science|lab|experiment)\b|(khoa\s*học(?:\s*tự\s*nhiên)?)/i },
  { subject: "Business", weight: 3, pattern: /\b(business|marketing|finance|startup|negotiation)\b|(kinh\s*doanh|thương\s*mại|đàm\s*phán)/i },
  {
    subject: "English",
    weight: 3,
    pattern:
      /\b(english|foreign\s*language|grammar|vocabulary|speaking|listening|writing|pronunciation)\b|(ngoại\s*ngữ(?:\s*1)?|tiếng\s*anh|ngữ\s*pháp|từ\s*vựng|phát\s*âm)/i,
  },
  { subject: "English", weight: 2, pattern: /\b(conversation|dialogue|communication)\b|(giao\s*tiếp|hội\s*thoại)/i },
];

/** Knowledge topics surfaced from a classroom description. */
export const KNOWLEDGE_CATALOG: { label: string; pattern: RegExp; weight: number }[] = [
  // Geography topics (high weight so they win over generic "Đọc"/"Ngữ văn")
  { label: "Bản đồ học", weight: 5, pattern: /bản\s*đồ(\s*học)?/i },
  { label: "Khí hậu", weight: 5, pattern: /khí\s*hậu|climate/i },
  { label: "Địa hình", weight: 5, pattern: /địa\s*hình|terrain|topograph/i },
  { label: "Tài nguyên thiên nhiên", weight: 5, pattern: /tài\s*nguyên(\s*thiên\s*nhiên)?|natural\s*resources?/i },
  { label: "Dân số", weight: 4, pattern: /dân\s*số|population/i },
  { label: "Đô thị hóa", weight: 5, pattern: /đô\s*thị\s*hóa|urbani[sz]ation/i },
  { label: "Di cư", weight: 4, pattern: /di\s*cư|migration/i },
  { label: "Toàn cầu hóa", weight: 5, pattern: /toàn\s*cầu\s*hóa|globali[sz]ation/i },
  { label: "Môi trường", weight: 4, pattern: /môi\s*trường|environment/i },
  { label: "Dân cư", weight: 4, pattern: /dân\s*cư/i },
  { label: "Ngữ pháp", weight: 4, pattern: /\b(grammar|tense|tenses|present\s*simple|past\s*simple|conditionals?)\b|ngữ\s*pháp/i },
  { label: "Từ vựng", weight: 4, pattern: /\b(vocabulary|vocab|word\s*list|collocations?)\b|từ\s*vựng/i },
  { label: "Nói", weight: 4, pattern: /\b(speaking|conversation|oral|fluency)\b|(?<![a-zà-ỹ])nói(?![a-zà-ỹ])|hội\s*thoại|giao\s*tiếp/i },
  { label: "Nghe", weight: 4, pattern: /\b(listening|comprehension|audio)\b|(?<![a-zà-ỹ])nghe(?![a-zà-ỹ])/i },
  { label: "Viết", weight: 4, pattern: /\b(writing|essay|paragraph|composition)\b|(?<![a-zà-ỹ])viết(?![a-zà-ỹ])/i },
  // Avoid matching "đọc bản đồ" in geography descriptions as English Reading skill
  { label: "Đọc", weight: 4, pattern: /\b(reading|passage|comprehension)\b|(đọc(?!\s*bản\s*đồ))/i },
  { label: "Phát âm", weight: 3, pattern: /\b(pronunciation|phonetics?|ipa|accent)\b|phát\s*âm/i },
  { label: "Luyện IELTS", weight: 5, pattern: /\b(ielts|band\s?[56789]|academic\s*writing|speaking\s*test)\b/i },
  { label: "Luyện TOEIC", weight: 4, pattern: /\b(toeic)\b/i },
  { label: "Tiếng Anh thương mại", weight: 4, pattern: /\b(business\s*english|email|meeting|negotiation)\b|đàm\s*phán|kinh\s*doanh/i },
  // Explicit literature only — never bare "văn hóa"
  { label: "Ngữ văn", weight: 3, pattern: /\b(literature|poetry|novel)\b|(ngữ\s*văn|văn\s*học|(?<![a-zà-ỹ])thơ(?![a-zà-ỹ]))/i },
  { label: "Lịch sử", weight: 3, pattern: /\b(history|civilization)\b|(lịch\s*sử|lịch\s*chiến|chiến\s*tranh|chiến\s*dịch|cách\s*mạng)/i },
  { label: "Vật lí", weight: 3, pattern: /\b(physics)\b|vật\s*l[iíý]/i },
  { label: "Hóa học", weight: 3, pattern: /\b(chemistry)\b|(hóa\s*học|hoá\s*học)/i },
  { label: "Sinh học", weight: 3, pattern: /\b(biology)\b|sinh\s*học/i },
  { label: "Địa lí", weight: 2, pattern: /\b(geography)\b|(địa\s*l[iíý]|địa\s*lý)/i },
  { label: "Tin học", weight: 3, pattern: /\b(informatics|programming|coding)\b|(tin\s*học|lập\s*trình)/i },
  { label: "Toán", weight: 3, pattern: /\b(math|algebra|geometry)\b|toán/i },
  { label: "Kỹ năng thi", weight: 3, pattern: /\b(exam|test\s*prep|strategy)\b|(luyện\s*thi|chiến\s*lược)/i },
  { label: "Giao tiếp", weight: 2, pattern: /\b(communication|soft\s*skills|presentation)\b/i },
];

function readStore(): Record<string, ClassroomMeta> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ClassroomMeta>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClassroomMeta>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function inferSubject(name: string, description?: string | null): ClassroomSubject {
  return detectSubjectFromText(`${name} ${description || ""}`).subject;
}

/** Score-based subject detection from class name/description (AI-assisted classifier). */
export function detectSubjectFromText(text: string): {
  subject: ClassroomSubject;
  confidence: number;
  matched: string[];
} {
  const input = (text ?? "").trim();
  if (!input) {
    return { subject: "English", confidence: 0, matched: [] };
  }

  const scores = new Map<ClassroomSubject, number>();
  const matched: string[] = [];

  for (const rule of SUBJECT_RULES) {
    const m = input.match(rule.pattern);
    if (m) {
      scores.set(rule.subject, (scores.get(rule.subject) || 0) + rule.weight);
      matched.push(m[0]);
    }
  }

  let best: ClassroomSubject = "Other";
  let bestScore = 0;
  for (const [subject, score] of scores) {
    if (score > bestScore) {
      best = subject;
      bestScore = score;
    }
  }

  if (bestScore === 0) {
    return { subject: "Other", confidence: 0.15, matched: [] };
  }

  const confidence = Math.min(0.98, 0.35 + bestScore * 0.12);
  return { subject: best, confidence, matched: matched.slice(0, 4) };
}

/** Max knowledges kept when normalizing / auto-detecting (display shows all of these). */
export const MAX_KNOWLEDGES = 24;

/** Extract ranked main knowledge topics from class description/name. */
export function detectKnowledgesFromText(text: string, limit = MAX_KNOWLEDGES): string[] {
  const input = (text ?? "").trim();
  if (!input) return [];

  const scored: { label: string; score: number }[] = [];
  for (const item of KNOWLEDGE_CATALOG) {
    if (item.pattern.test(input)) {
      scored.push({ label: item.label, score: item.weight });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const unique: string[] = [];
  for (const row of scored) {
    if (!unique.includes(row.label)) unique.push(row.label);
    if (unique.length >= limit) break;
  }

  if (unique.length > 0) return unique;

  const subject = detectSubjectFromText(input).subject;
  if (subject === "IELTS") return ["Luyện IELTS", "Viết", "Nói"];
  if (subject === "TOEIC") return ["Luyện TOEIC", "Nghe", "Đọc"];
  if (subject === "English") return ["Ngữ pháp", "Từ vựng", "Nói"];
  if (subject === "Business") return ["Tiếng Anh thương mại", "Giao tiếp"];
  if (subject === "Literature") return ["Ngữ văn", "Đọc"];
  if (subject === "Geography") {
    return ["Bản đồ học", "Khí hậu", "Địa hình", "Tài nguyên thiên nhiên", "Đô thị hóa"];
  }
  if (subject === "Other") return [];
  return [subjectLabel(subject)];
}

export function normalizeKnowledges(values: unknown, limit = MAX_KNOWLEDGES): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().replace(/\s+/g, " ");
    if (!label || out.some((x) => x.toLowerCase() === label.toLowerCase())) continue;
    out.push(label.slice(0, 40));
    if (out.length >= limit) break;
  }
  return out;
}

export function defaultCoverFor(subject: ClassroomSubject, seed = ""): string {
  const list = SUBJECT_COVERS[subject] ?? SUBJECT_COVERS.Other;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash + seed.charCodeAt(i) * (i + 1)) % 997;
  return list[hash % list.length];
}

export function getClassroomMeta(
  classroomId: string,
  name: string,
  description?: string | null,
): ClassroomMeta {
  const store = readStore();
  const saved = store[classroomId];
  const inferredKnowledges = detectKnowledgesFromText(`${name} ${description || ""}`);

  if (saved?.subject && saved?.coverImage) {
    const knowledges =
      normalizeKnowledges(saved.knowledges).length > 0
        ? normalizeKnowledges(saved.knowledges)
        : inferredKnowledges;
    return { ...saved, knowledges };
  }

  const subject = inferSubject(name, description);
  return {
    subject,
    coverImage: defaultCoverFor(subject, classroomId || name),
    knowledges: inferredKnowledges,
  };
}

export function saveClassroomMeta(classroomId: string, meta: ClassroomMeta) {
  const store = readStore();
  store[classroomId] = {
    ...meta,
    knowledges: normalizeKnowledges(meta.knowledges),
  };
  writeStore(store);
}

/** Compress an uploaded image file to a data URL suitable for localStorage covers. */
export async function fileToCoverDataUrl(file: File, maxEdge = 960, quality = 0.78): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Vui lòng chọn tệp ảnh");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Ảnh phải nhỏ hơn 8MB");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Không xử lý được ảnh");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không tải được ảnh"));
    img.src = src;
  });
}
