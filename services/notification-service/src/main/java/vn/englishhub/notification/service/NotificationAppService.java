package vn.englishhub.notification.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.notification.domain.Notification;
import vn.englishhub.notification.realtime.SseHub;
import vn.englishhub.notification.repo.NotificationRepository;

@Service
public class NotificationAppService {

    private final NotificationRepository repo;
    private final SseHub sseHub;
    private final ObjectMapper objectMapper;

    public NotificationAppService(NotificationRepository repo, SseHub sseHub, ObjectMapper objectMapper) {
        this.repo = repo;
        this.sseHub = sseHub;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Notification create(
            UUID userId,
            String type,
            String title,
            String body,
            Map<String, Object> payload,
            String refType,
            UUID refId) {
        Notification n = new Notification();
        n.setId(UUID.randomUUID());
        n.setUserId(userId);
        n.setType(type);
        n.setTitle(title);
        n.setBody(body);
        n.setRefType(refType);
        n.setRefId(refId);
        try {
            n.setPayloadJson(payload == null ? null : objectMapper.writeValueAsString(payload));
        } catch (JsonProcessingException e) {
            n.setPayloadJson("{}");
        }
        repo.save(n);

        Map<String, Object> ssePayload = Map.of(
                "id", n.getId().toString(),
                "type", type,
                "title", title,
                "body", body,
                "refType", refType == null ? "" : refType,
                "refId", refId == null ? "" : refId.toString(),
                "createdAt", n.getCreatedAt().toString(),
                "unreadCount", repo.countUnread(userId));
        sseHub.publish(userId, "notification", ssePayload);
        return n;
    }

    @Transactional(readOnly = true)
    public List<Notification> list(UUID userId) {
        return repo.findByUserIdOrderByCreatedAtDesc(userId);
    }

    @Transactional(readOnly = true)
    public long unreadCount(UUID userId) {
        return repo.countUnread(userId);
    }

    @Transactional
    public Notification markRead(UUID userId, UUID notificationId) {
        Notification n = repo.findById(notificationId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Notification not found"));
        if (!n.getUserId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not your notification");
        }
        if (n.getReadAt() == null) {
            n.setReadAt(Instant.now());
            repo.save(n);
            sseHub.publish(userId, "unread", Map.of("unreadCount", repo.countUnread(userId)));
        }
        return n;
    }

    @Transactional
    public long markAllRead(UUID userId) {
        int updated = repo.markAllRead(userId, Instant.now());
        long remaining = repo.countUnread(userId);
        sseHub.publish(userId, "unread", Map.of("unreadCount", remaining));
        return updated;
    }

    /**
     * When a join request is decided, convert teacher JOIN_REQUEST inbox items into
     * JOIN_ACCEPTED / JOIN_REJECTED so Accept/Reject buttons do not reappear on reload.
     */
    @Transactional
    public int resolveJoinRequest(UUID requestId, String decision, String classroomName, String studentName) {
        boolean accepted = "ACCEPTED".equalsIgnoreCase(decision);
        String newType = accepted ? "JOIN_ACCEPTED" : "JOIN_REJECTED";
        String title = accepted
                ? "Đã chấp nhận / Accepted"
                : "Đã từ chối / Rejected";
        String who = studentName == null || studentName.isBlank() ? "Học sinh" : studentName;
        String room = classroomName == null || classroomName.isBlank() ? "lớp" : classroomName;
        String body = accepted
                ? "Bạn đã chấp nhận " + who + " vào lớp «" + room + "»."
                : "Bạn đã từ chối " + who + " vào lớp «" + room + "».";

        List<Notification> pending = repo.findByRefTypeAndRefIdAndType("join_request", requestId, "JOIN_REQUEST");
        int count = 0;
        for (Notification n : pending) {
            n.setType(newType);
            n.setTitle(title);
            n.setBody(body);
            n.setReadAt(Instant.now());
            repo.save(n);
            count++;
            sseHub.publish(
                    n.getUserId(),
                    "notification",
                    Map.of(
                            "id", n.getId().toString(),
                            "type", newType,
                            "title", title,
                            "body", body,
                            "refType", "join_request",
                            "refId", requestId.toString(),
                            "createdAt", n.getCreatedAt().toString(),
                            "unreadCount", repo.countUnread(n.getUserId())));
            sseHub.publish(n.getUserId(), "unread", Map.of("unreadCount", repo.countUnread(n.getUserId())));
        }
        return count;
    }
}
