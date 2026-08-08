package vn.englishhub.notification.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import vn.englishhub.notification.domain.Notification;
import vn.englishhub.notification.realtime.SseHub;
import vn.englishhub.notification.service.NotificationAppService;

@RestController
@RequestMapping("/api/v1/notifications")
@Tag(name = "Notifications", description = "Inbox and realtime SSE stream")
public class NotificationController {

    private final NotificationAppService notifications;
    private final SseHub sseHub;

    public NotificationController(NotificationAppService notifications, SseHub sseHub) {
        this.notifications = notifications;
        this.sseHub = sseHub;
    }

    public record NotificationResponse(
            String id,
            String type,
            String title,
            String body,
            String payloadJson,
            String refType,
            String refId,
            boolean read,
            String createdAt) {}

    @GetMapping
    @Operation(summary = "List my notifications")
    public List<NotificationResponse> list(HttpServletRequest http) {
        return notifications.list(userId(http)).stream().map(this::toResponse).toList();
    }

    @GetMapping("/unread-count")
    @Operation(summary = "Unread badge count")
    public Map<String, Long> unreadCount(HttpServletRequest http) {
        return Map.of("count", notifications.unreadCount(userId(http)));
    }

    @PostMapping("/{id}/read")
    @Operation(summary = "Mark notification as read")
    public NotificationResponse markRead(@PathVariable("id") UUID id, HttpServletRequest http) {
        return toResponse(notifications.markRead(userId(http), id));
    }

    @PostMapping("/read-all")
    @Operation(summary = "Mark all notifications as read")
    public Map<String, Long> markAllRead(HttpServletRequest http) {
        long updated = notifications.markAllRead(userId(http));
        return Map.of("updated", updated, "count", 0L);
    }

    public record ResolveJoinBody(String decision, String classroomName, String studentName) {}

    @PostMapping("/join-requests/{requestId}/resolve")
    @Operation(summary = "Mark teacher join-request notification as accepted/rejected")
    public Map<String, Integer> resolveJoin(
            @PathVariable("requestId") UUID requestId,
            @org.springframework.web.bind.annotation.RequestBody(required = false) ResolveJoinBody body,
            HttpServletRequest http) {
        // Auth still required via interceptor; teacher/admin resolve their inbox item
        userId(http);
        String decision = body == null || body.decision() == null ? "ACCEPTED" : body.decision();
        String classroomName = body == null ? null : body.classroomName();
        String studentName = body == null ? null : body.studentName();
        int updated = notifications.resolveJoinRequest(requestId, decision, classroomName, studentName);
        return Map.of("updated", updated);
    }

    @GetMapping(path = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @Operation(summary = "SSE realtime notification stream")
    public SseEmitter stream(HttpServletRequest http) {
        return sseHub.subscribe(userId(http));
    }

    private NotificationResponse toResponse(Notification n) {
        return new NotificationResponse(
                n.getId().toString(),
                n.getType(),
                n.getTitle(),
                n.getBody(),
                n.getPayloadJson(),
                n.getRefType(),
                n.getRefId() == null ? null : n.getRefId().toString(),
                n.getReadAt() != null,
                n.getCreatedAt().toString());
    }

    private UUID userId(HttpServletRequest http) {
        return (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID);
    }
}
