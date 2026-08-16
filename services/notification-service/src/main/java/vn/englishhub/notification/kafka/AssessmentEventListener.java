package vn.englishhub.notification.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import vn.englishhub.notification.service.ExamReminderScheduler;
import vn.englishhub.notification.service.NotificationAppService;

@Component
public class AssessmentEventListener {

    private static final Logger log = LoggerFactory.getLogger(AssessmentEventListener.class);

    private final NotificationAppService notifications;
    private final ExamReminderScheduler reminderScheduler;
    private final ObjectMapper objectMapper;

    public AssessmentEventListener(
            NotificationAppService notifications,
            ExamReminderScheduler reminderScheduler,
            ObjectMapper objectMapper) {
        this.notifications = notifications;
        this.reminderScheduler = reminderScheduler;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(topics = "assessment.events", groupId = "notification-service")
    public void onMessage(String message) {
        try {
            JsonNode root = objectMapper.readTree(message);
            String type = root.path("type").asText();
            if ("quiz.exam.scheduled".equals(type)) {
                handleExamScheduled(root.path("payload"));
            } else {
                log.debug("Ignored assessment event type {}", type);
            }
        } catch (Exception ex) {
            log.error("Failed to process assessment event: {}", message, ex);
        }
    }

    private void handleExamScheduled(JsonNode p) {
        UUID quizId = UUID.fromString(p.path("quizId").asText());
        String title = text(p, "title", "Bài kiểm tra");
        String startsAtRaw = text(p, "startsAt", "");
        Instant startsAt = startsAtRaw.isBlank() ? null : Instant.parse(startsAtRaw);
        int reminderMinutes = p.path("reminderMinutesBefore").asInt(15);
        List<UUID> studentIds = readStudentIds(p.path("studentIds"));
        if (studentIds.isEmpty()) {
            log.warn("quiz.exam.scheduled for {} has no studentIds", quizId);
            return;
        }

        String when = startsAt == null ? "sắp tới" : startsAt.toString();
        String publishTitle = "Bài kiểm tra đã lên lịch / Exam scheduled";
        String publishBody = "Bài kiểm tra «" + title + "» lúc " + when + ".";
        Map<String, Object> payload = toMap(p);

        for (UUID studentId : studentIds) {
            notifications.create(
                    studentId,
                    "EXAM_REMINDER",
                    publishTitle,
                    publishBody,
                    payload,
                    "quiz",
                    quizId);
        }

        if (startsAt != null) {
            Instant remindAt = startsAt.minusSeconds(Math.max(0, reminderMinutes) * 60L);
            String remindTitle = "Sắp đến giờ kiểm tra / Exam starting soon";
            String remindBody = "Bài kiểm tra «" + title + "» bắt đầu lúc " + when
                    + " (còn khoảng " + reminderMinutes + " phút).";
            reminderScheduler.schedule(studentIds, quizId, remindAt, remindTitle, remindBody, payload);
        }
    }

    private List<UUID> readStudentIds(JsonNode node) {
        List<UUID> ids = new ArrayList<>();
        if (node == null || !node.isArray()) {
            return ids;
        }
        for (JsonNode n : node) {
            String s = n.asText(null);
            if (s != null && !s.isBlank()) {
                try {
                    ids.add(UUID.fromString(s));
                } catch (IllegalArgumentException ignored) {
                    // skip bad id
                }
            }
        }
        return ids;
    }

    private String text(JsonNode p, String field, String fallback) {
        String v = p.path(field).asText(null);
        return v == null || v.isBlank() ? fallback : v;
    }

    private Map<String, Object> toMap(JsonNode p) {
        Map<String, Object> map = new HashMap<>();
        p.fields().forEachRemaining(e -> {
            JsonNode v = e.getValue();
            if (v.isArray()) {
                List<String> list = new ArrayList<>();
                v.forEach(n -> list.add(n.asText()));
                map.put(e.getKey(), list);
            } else if (v.isNumber()) {
                map.put(e.getKey(), v.numberValue());
            } else {
                map.put(e.getKey(), v.asText());
            }
        });
        return map;
    }
}
