package vn.englishhub.notification.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import vn.englishhub.notification.service.NotificationAppService;

@Component
public class ClassroomEventListener {

    private static final Logger log = LoggerFactory.getLogger(ClassroomEventListener.class);

    private final NotificationAppService notifications;
    private final ObjectMapper objectMapper;

    public ClassroomEventListener(NotificationAppService notifications, ObjectMapper objectMapper) {
        this.notifications = notifications;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(topics = "classroom.events", groupId = "notification-service")
    public void onMessage(String message) {
        try {
            JsonNode root = objectMapper.readTree(message);
            String type = root.path("type").asText();
            JsonNode p = root.path("payload");
            switch (type) {
                case "join_request.created" -> handleCreated(p);
                case "join_request.accepted" -> handleAccepted(p);
                case "join_request.rejected" -> handleRejected(p);
                default -> log.debug("Ignored event type {}", type);
            }
        } catch (Exception ex) {
            log.error("Failed to process classroom event: {}", message, ex);
        }
    }

    private void handleCreated(JsonNode p) {
        UUID teacherId = UUID.fromString(p.path("teacherId").asText());
        UUID requestId = UUID.fromString(p.path("requestId").asText());
        String studentName = text(p, "studentName", "A student");
        String classroomName = text(p, "classroomName", "your class");
        Map<String, Object> payload = toMap(p);
        notifications.create(
                teacherId,
                "JOIN_REQUEST",
                "Yêu cầu tham gia lớp / Join request",
                studentName + " muốn tham gia lớp «" + classroomName + "».",
                payload,
                "join_request",
                requestId);
    }

    private void handleAccepted(JsonNode p) {
        UUID studentId = UUID.fromString(p.path("studentId").asText());
        UUID requestId = UUID.fromString(p.path("requestId").asText());
        String classroomName = text(p, "classroomName", "the class");
        String studentName = text(p, "studentName", "A student");
        notifications.resolveJoinRequest(requestId, "ACCEPTED", classroomName, studentName);
        notifications.create(
                studentId,
                "JOIN_ACCEPTED",
                "Đã được chấp nhận / Accepted",
                "Giáo viên đã chấp nhận bạn vào lớp «" + classroomName + "».",
                toMap(p),
                "join_request",
                requestId);
    }

    private void handleRejected(JsonNode p) {
        UUID studentId = UUID.fromString(p.path("studentId").asText());
        UUID requestId = UUID.fromString(p.path("requestId").asText());
        String classroomName = text(p, "classroomName", "the class");
        String studentName = text(p, "studentName", "A student");
        String reason = text(p, "rejectReason", "");
        notifications.resolveJoinRequest(requestId, "REJECTED", classroomName, studentName);
        String body = "Yêu cầu vào lớp «" + classroomName + "» bị từ chối.";
        if (!reason.isBlank()) {
            body += " Lý do: " + reason;
        }
        notifications.create(
                studentId,
                "JOIN_REJECTED",
                "Bị từ chối / Rejected",
                body,
                toMap(p),
                "join_request",
                requestId);
    }

    private String text(JsonNode p, String field, String fallback) {
        String v = p.path(field).asText(null);
        return v == null || v.isBlank() ? fallback : v;
    }

    private Map<String, Object> toMap(JsonNode p) {
        Map<String, Object> map = new HashMap<>();
        p.fields().forEachRemaining(e -> map.put(e.getKey(), e.getValue().asText()));
        return map;
    }
}
