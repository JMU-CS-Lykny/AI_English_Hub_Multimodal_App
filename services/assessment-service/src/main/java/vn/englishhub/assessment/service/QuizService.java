package vn.englishhub.assessment.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.assessment.client.ClassroomClient;
import vn.englishhub.assessment.domain.Quiz;
import vn.englishhub.assessment.domain.QuizAttempt;
import vn.englishhub.assessment.domain.QuizKind;
import vn.englishhub.assessment.domain.QuizStatus;
import vn.englishhub.assessment.repo.QuizAttemptRepository;
import vn.englishhub.assessment.repo.QuizRepository;

@Service
public class QuizService {
    private final QuizRepository quizzes;
    private final QuizAttemptRepository attempts;
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper objectMapper;
    private final QuizExcelService excelService;
    private final ClassroomClient classroomClient;

    public QuizService(
            QuizRepository quizzes,
            QuizAttemptRepository attempts,
            KafkaTemplate<String, String> kafka,
            ObjectMapper objectMapper,
            QuizExcelService excelService,
            ClassroomClient classroomClient) {
        this.quizzes = quizzes;
        this.attempts = attempts;
        this.kafka = kafka;
        this.objectMapper = objectMapper;
        this.excelService = excelService;
        this.classroomClient = classroomClient;
    }

    public record QuizSchedule(
            QuizKind kind,
            Instant startsAt,
            Instant endsAt,
            Integer durationMinutes,
            Integer reminderMinutesBefore,
            String sourceLabel) {}

    @Transactional
    public Quiz create(
            UUID userId,
            String role,
            UUID classroomId,
            String title,
            List<Map<String, Object>> questions,
            QuizSchedule schedule) {
        requireTeacher(role);
        Quiz quiz = saveNew(userId, classroomId, title, normalizeQuestions(questions), QuizStatus.DRAFT);
        applySchedule(quiz, schedule, false);
        return quizzes.save(quiz);
    }

    @Transactional
    public Quiz update(
            UUID userId,
            String role,
            UUID quizId,
            String title,
            List<Map<String, Object>> questions,
            QuizSchedule schedule) {
        requireTeacher(role);
        Quiz quiz = get(quizId);
        assertOwner(quiz, userId, role);
        try {
            if (title != null && !title.isBlank()) {
                quiz.setTitle(title.trim());
            }
            if (questions != null) {
                quiz.setQuestionsJson(objectMapper.writeValueAsString(normalizeQuestions(questions)));
            }
            applySchedule(quiz, schedule, false);
            return quizzes.save(quiz);
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid questions payload");
        }
    }

    @Transactional
    public Quiz publish(UUID userId, String role, UUID quizId, QuizSchedule schedule) {
        requireTeacher(role);
        Quiz quiz = get(quizId);
        assertOwner(quiz, userId, role);
        List<Map<String, Object>> questions = readQuestions(quiz);
        if (questions.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Quiz has no questions");
        }
        applySchedule(quiz, schedule, true);

        QuizKind kind = quiz.getKind() == null ? QuizKind.PRACTICE : quiz.getKind();
        if (kind == QuizKind.EXAM) {
            if (quiz.getStartsAt() == null || quiz.getDurationMinutes() == null || quiz.getDurationMinutes() <= 0) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "EXAM publish requires startsAt and durationMinutes");
            }
            quiz.setEndsAt(quiz.getStartsAt().plus(quiz.getDurationMinutes(), ChronoUnit.MINUTES));
            if (quiz.getReminderMinutesBefore() == null) {
                quiz.setReminderMinutesBefore(15);
            }
        }

        quiz.setStatus(QuizStatus.PUBLISHED);
        Quiz saved = quizzes.save(quiz);

        if (kind == QuizKind.EXAM) {
            emitExamScheduled(saved, userId, role);
        }
        return saved;
    }

    /**
     * Hard-delete quiz. Related attempts are removed via DB {@code ON DELETE CASCADE}.
     */
    @Transactional
    public void delete(UUID userId, String role, UUID quizId) {
        requireTeacher(role);
        Quiz quiz = get(quizId);
        assertOwner(quiz, userId, role);
        quizzes.delete(quiz);
    }

    @Transactional
    public Quiz importExcel(
            UUID userId, String role, UUID classroomId, String title, InputStream in) {
        requireTeacher(role);
        List<Map<String, Object>> questions = excelService.parseQuestions(in);
        String quizTitle = (title == null || title.isBlank()) ? "Imported quiz" : title.trim();
        return saveNew(userId, classroomId, quizTitle, questions, QuizStatus.DRAFT);
    }

    @Transactional(readOnly = true)
    public byte[] exportExcel(UUID userId, String role, UUID quizId) {
        requireTeacher(role);
        Quiz quiz = get(quizId);
        assertOwner(quiz, userId, role);
        return excelService.exportQuestions(quiz.getTitle(), readQuestions(quiz));
    }

    @Transactional(readOnly = true)
    public List<Quiz> list(UUID classroomId, String role) {
        if ("STUDENT".equals(role)) {
            return quizzes.findByClassroomIdAndStatusOrderByCreatedAtDesc(classroomId, QuizStatus.PUBLISHED);
        }
        return quizzes.findByClassroomIdOrderByCreatedAtDesc(classroomId);
    }

    @Transactional(readOnly = true)
    public Quiz get(UUID id) {
        return quizzes.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Quiz not found"));
    }

    @Transactional(readOnly = true)
    public Quiz getForViewer(UUID id, String role) {
        Quiz quiz = get(id);
        if ("STUDENT".equals(role) && quiz.getStatus() != QuizStatus.PUBLISHED) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Quiz not found");
        }
        if ("STUDENT".equals(role)) {
            assertExamWindowOpen(quiz);
        }
        return quiz;
    }

    @Transactional(readOnly = true)
    public List<QuizAttempt> listAttempts(UUID userId, String role, UUID quizId) {
        requireTeacher(role);
        Quiz quiz = get(quizId);
        assertOwner(quiz, userId, role);
        return attempts.findByQuizIdOrderBySubmittedAtDesc(quizId);
    }

    @Transactional
    public QuizAttempt submit(UUID studentId, String role, UUID quizId, List<String> answers) {
        if (!"STUDENT".equals(role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Students only");
        }
        Quiz quiz = get(quizId);
        if (quiz.getStatus() != QuizStatus.PUBLISHED) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Quiz is not published");
        }
        assertExamWindowOpen(quiz);
        QuizKind kind = quiz.getKind() == null ? QuizKind.PRACTICE : quiz.getKind();
        if (kind == QuizKind.EXAM && attempts.existsByQuizIdAndStudentId(quizId, studentId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "EXAM allows only one attempt");
        }
        try {
            List<Map<String, Object>> questions = readQuestions(quiz);
            int score = 0;
            for (int i = 0; i < questions.size(); i++) {
                String given = i < answers.size() && answers.get(i) != null ? answers.get(i) : "";
                if (isCorrect(questions.get(i), given)) {
                    score++;
                }
            }
            QuizAttempt attempt = new QuizAttempt();
            attempt.setId(UUID.randomUUID());
            attempt.setQuizId(quizId);
            attempt.setStudentId(studentId);
            attempt.setAnswersJson(objectMapper.writeValueAsString(answers));
            attempt.setScore(score);
            attempt.setMaxScore(questions.size());
            attempts.save(attempt);

            kafka.send("assessment.events", quizId.toString(), objectMapper.writeValueAsString(Map.of(
                    "type", "quiz.submitted",
                    "payload", Map.of(
                            "quizId", quizId.toString(),
                            "studentId", studentId.toString(),
                            "score", score,
                            "maxScore", questions.size()))));
            return attempt;
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Student list/detail: strip answers for all kinds. For EXAM outside window, hide
     * question stems on list responses (GET by id is blocked separately).
     */
    public String questionsJsonForViewer(Quiz quiz, String role, boolean enforceExamGate) {
        if (!"STUDENT".equals(role)) {
            return quiz.getQuestionsJson();
        }
        if (enforceExamGate && isExamOutsideWindow(quiz)) {
            return "[]";
        }
        try {
            List<Map<String, Object>> questions = readQuestions(quiz);
            List<Map<String, Object>> stripped = new ArrayList<>();
            for (Map<String, Object> q : questions) {
                Map<String, Object> copy = new LinkedHashMap<>();
                if (q.get("id") != null) {
                    copy.put("id", q.get("id"));
                }
                copy.put("prompt", q.get("prompt"));
                String type = str(q.get("type"));
                copy.put("type", "mcq".equalsIgnoreCase(type) ? "mcq" : "short");
                if ("mcq".equals(copy.get("type")) && q.get("choices") != null) {
                    copy.put("choices", q.get("choices"));
                }
                stripped.add(copy);
            }
            return objectMapper.writeValueAsString(stripped);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    public String questionsJsonForViewer(Quiz quiz, String role) {
        return questionsJsonForViewer(quiz, role, false);
    }

    private void emitExamScheduled(Quiz quiz, UUID teacherId, String role) {
        List<UUID> studentIds = classroomClient.listStudentIds(quiz.getClassroomId(), teacherId, role);
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("quizId", quiz.getId().toString());
            payload.put("classroomId", quiz.getClassroomId().toString());
            payload.put("title", quiz.getTitle());
            payload.put("startsAt", quiz.getStartsAt().toString());
            payload.put("endsAt", quiz.getEndsAt() == null ? "" : quiz.getEndsAt().toString());
            payload.put(
                    "reminderMinutesBefore",
                    quiz.getReminderMinutesBefore() == null ? 15 : quiz.getReminderMinutesBefore());
            payload.put("studentIds", studentIds.stream().map(UUID::toString).toList());
            kafka.send(
                    "assessment.events",
                    quiz.getId().toString(),
                    objectMapper.writeValueAsString(Map.of(
                            "type", "quiz.exam.scheduled",
                            "payload", payload)));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private void applySchedule(Quiz quiz, QuizSchedule schedule, boolean publishing) {
        if (schedule == null) {
            return;
        }
        if (schedule.kind() != null) {
            quiz.setKind(schedule.kind());
        }
        if (schedule.startsAt() != null || publishing) {
            if (schedule.startsAt() != null) {
                quiz.setStartsAt(schedule.startsAt());
            }
        }
        if (schedule.endsAt() != null) {
            quiz.setEndsAt(schedule.endsAt());
        }
        if (schedule.durationMinutes() != null) {
            quiz.setDurationMinutes(schedule.durationMinutes());
        }
        if (schedule.reminderMinutesBefore() != null) {
            quiz.setReminderMinutesBefore(schedule.reminderMinutesBefore());
        }
        if (schedule.sourceLabel() != null) {
            String label = schedule.sourceLabel().trim();
            quiz.setSourceLabel(label.isEmpty() ? null : label);
        }
    }

    private void assertExamWindowOpen(Quiz quiz) {
        if (!isExamOutsideWindow(quiz)) {
            return;
        }
        Instant now = Instant.now();
        Instant starts = quiz.getStartsAt();
        Instant ends = quiz.getEndsAt();
        if (starts != null && now.isBefore(starts)) {
            throw new ResponseStatusException(
                    HttpStatus.FORBIDDEN,
                    "Exam has not started yet. Opens at " + starts);
        }
        throw new ResponseStatusException(
                HttpStatus.FORBIDDEN,
                "Exam window has closed" + (ends == null ? "" : " at " + ends));
    }

    private boolean isExamOutsideWindow(Quiz quiz) {
        QuizKind kind = quiz.getKind() == null ? QuizKind.PRACTICE : quiz.getKind();
        if (kind != QuizKind.EXAM) {
            return false;
        }
        Instant now = Instant.now();
        Instant starts = quiz.getStartsAt();
        Instant ends = quiz.getEndsAt();
        if (starts != null && now.isBefore(starts)) {
            return true;
        }
        if (ends != null && now.isAfter(ends)) {
            return true;
        }
        return false;
    }

    private Quiz saveNew(
            UUID userId, UUID classroomId, String title, List<Map<String, Object>> questions, QuizStatus status) {
        try {
            Quiz quiz = new Quiz();
            quiz.setId(UUID.randomUUID());
            quiz.setClassroomId(classroomId);
            quiz.setTitle(title.trim());
            quiz.setQuestionsJson(objectMapper.writeValueAsString(questions));
            quiz.setStatus(status);
            quiz.setKind(QuizKind.PRACTICE);
            quiz.setCreatedBy(userId);
            return quizzes.save(quiz);
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid questions payload");
        }
    }

    private List<Map<String, Object>> normalizeQuestions(List<Map<String, Object>> questions) {
        if (questions == null || questions.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Questions required");
        }
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (Map<String, Object> raw : questions) {
            if (raw == null) {
                continue;
            }
            String prompt = str(raw.get("prompt"));
            String answer = str(raw.get("answer"));
            if (prompt.isBlank() || answer.isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Each question needs prompt and answer");
            }
            String type = str(raw.get("type")).toLowerCase(Locale.ROOT);
            if (!"mcq".equals(type)) {
                type = "short";
            }
            Map<String, Object> q = new LinkedHashMap<>();
            Object id = raw.get("id");
            q.put("id", id == null || str(id).isBlank() ? UUID.randomUUID().toString() : str(id));
            q.put("prompt", prompt);
            q.put("type", type);
            q.put("answer", answer);
            if ("mcq".equals(type)) {
                Object choicesObj = raw.get("choices");
                List<String> choices = new ArrayList<>();
                if (choicesObj instanceof List<?> list) {
                    for (Object c : list) {
                        String s = str(c);
                        if (!s.isBlank()) {
                            choices.add(s);
                        }
                    }
                } else if (choicesObj != null) {
                    for (String part : str(choicesObj).split("[|;]")) {
                        String s = part.trim();
                        if (!s.isEmpty()) {
                            choices.add(s);
                        }
                    }
                }
                if (choices.size() < 2) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "MCQ needs at least 2 choices");
                }
                q.put("choices", choices);
            }
            normalized.add(q);
        }
        if (normalized.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Questions required");
        }
        return normalized;
    }

    private boolean isCorrect(Map<String, Object> question, String givenRaw) {
        String given = givenRaw == null ? "" : givenRaw.trim();
        if (given.isEmpty()) {
            return false;
        }
        String correct = str(question.get("answer"));
        if (correct.equalsIgnoreCase(given)) {
            return true;
        }
        String type = str(question.get("type")).toLowerCase(Locale.ROOT);
        if (!"mcq".equals(type)) {
            return false;
        }
        Object choicesObj = question.get("choices");
        if (!(choicesObj instanceof List<?> choices) || choices.isEmpty()) {
            return false;
        }
        // Letter match: A/B/C/D or 1-based index
        if (given.length() == 1) {
            char ch = Character.toUpperCase(given.charAt(0));
            if (ch >= 'A' && ch <= 'Z') {
                int idx = ch - 'A';
                if (idx >= 0 && idx < choices.size() && correctEqualsChoice(correct, choices, idx)) {
                    return true;
                }
                // correct itself may be a letter
                if (correct.length() == 1 && Character.toUpperCase(correct.charAt(0)) == ch) {
                    return true;
                }
            }
        }
        // Choice text match against correct letter → choice text
        int correctIdx = letterIndex(correct);
        if (correctIdx >= 0 && correctIdx < choices.size()) {
            if (str(choices.get(correctIdx)).equalsIgnoreCase(given)) {
                return true;
            }
        }
        // given is choice text; correct is that text or its letter
        for (int i = 0; i < choices.size(); i++) {
            if (str(choices.get(i)).equalsIgnoreCase(given)) {
                if (correct.equalsIgnoreCase(given) || letterIndex(correct) == i) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean correctEqualsChoice(String correct, List<?> choices, int idx) {
        if (correct.equalsIgnoreCase(str(choices.get(idx)))) {
            return true;
        }
        return letterIndex(correct) == idx;
    }

    private static int letterIndex(String value) {
        String v = str(value);
        if (v.length() == 1) {
            char ch = Character.toUpperCase(v.charAt(0));
            if (ch >= 'A' && ch <= 'Z') {
                return ch - 'A';
            }
        }
        return -1;
    }

    private List<Map<String, Object>> readQuestions(Quiz quiz) {
        try {
            return objectMapper.readValue(quiz.getQuestionsJson(), new TypeReference<>() {});
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private void requireTeacher(String role) {
        if (!"TEACHER".equals(role) && !"ADMIN".equals(role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Teachers only");
        }
    }

    private void assertOwner(Quiz quiz, UUID userId, String role) {
        if ("ADMIN".equals(role)) {
            return;
        }
        if (!quiz.getCreatedBy().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not your quiz");
        }
    }

    private static String str(Object v) {
        return v == null ? "" : String.valueOf(v).trim();
    }
}
