package vn.englishhub.classroom.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import vn.englishhub.classroom.realtime.ChatSseHub;
import vn.englishhub.classroom.service.ChatService;
import vn.englishhub.classroom.service.ChatService.AttachmentInput;
import vn.englishhub.classroom.service.ChatService.ChatFeedView;
import vn.englishhub.classroom.service.ChatService.MessageView;

@RestController
@RequestMapping("/api/v1/classrooms/{classroomId}/chat")
@Tag(name = "Classroom chat", description = "Per-classroom chatroom for teacher + enrolled students")
public class ChatController {

    private final ChatService chatService;
    private final ChatSseHub sseHub;

    public ChatController(ChatService chatService, ChatSseHub sseHub) {
        this.chatService = chatService;
        this.sseHub = sseHub;
    }

    public record AttachmentRequest(String kind, String fileName, String mimeType, String urlOrData) {}

    public record SendMessageRequest(String text, List<AttachmentRequest> attachments) {}

    public record EditMessageRequest(@NotBlank String text) {}

    public record ReactionRequest(@NotBlank String emoji) {}

    @GetMapping("/messages")
    @Operation(summary = "List chat feed: pinned strip + chronological page (before = ISO instant cursor)")
    public ChatFeedView listMessages(
            @PathVariable("classroomId") UUID classroomId,
            @RequestParam(value = "before", required = false) String before,
            @RequestParam(value = "limit", required = false) Integer limit,
            HttpServletRequest http) {
        Instant beforeInstant = null;
        if (before != null && !before.isBlank()) {
            try {
                beforeInstant = Instant.parse(before.trim());
            } catch (Exception ex) {
                throw new org.springframework.web.server.ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "Invalid before cursor (use ISO-8601 instant)");
            }
        }
        return chatService.listMessages(classroomId, userId(http), role(http), beforeInstant, limit);
    }

    @PostMapping("/messages")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Send a text / attachment message")
    public MessageView sendMessage(
            @PathVariable("classroomId") UUID classroomId,
            @RequestBody SendMessageRequest body,
            HttpServletRequest http) {
        List<AttachmentInput> inputs = body == null || body.attachments() == null
                ? List.of()
                : body.attachments().stream()
                        .map(a -> new AttachmentInput(a.kind(), a.fileName(), a.mimeType(), a.urlOrData()))
                        .toList();
        String text = body == null ? null : body.text();
        return chatService.sendMessage(
                classroomId,
                userId(http),
                role(http),
                UserHeaderEncoding.decode(header(http, "X-User-Name")),
                text,
                inputs);
    }

    @PatchMapping("/messages/{messageId}")
    @Operation(summary = "Edit own message text (sender only; soft-sets edited_at)")
    public MessageView editMessage(
            @PathVariable("classroomId") UUID classroomId,
            @PathVariable("messageId") UUID messageId,
            @RequestBody EditMessageRequest body,
            HttpServletRequest http) {
        String text = body == null ? null : body.text();
        return chatService.editMessage(classroomId, userId(http), role(http), messageId, text);
    }

    @PostMapping("/messages/{messageId}/pin")
    @Operation(summary = "Toggle pin on a message (any classroom member)")
    public MessageView togglePin(
            @PathVariable("classroomId") UUID classroomId,
            @PathVariable("messageId") UUID messageId,
            HttpServletRequest http) {
        return chatService.togglePin(classroomId, userId(http), role(http), messageId);
    }

    @DeleteMapping("/messages/{messageId}/pin")
    @Operation(summary = "Unpin a message (any classroom member)")
    public MessageView unpinMessage(
            @PathVariable("classroomId") UUID classroomId,
            @PathVariable("messageId") UUID messageId,
            HttpServletRequest http) {
        return chatService.unpinMessage(classroomId, userId(http), role(http), messageId);
    }

    @DeleteMapping("/messages/{messageId}")
    @Operation(summary = "Soft-delete a message (TEACHER / ADMIN only)")
    public MessageView deleteMessage(
            @PathVariable("classroomId") UUID classroomId,
            @PathVariable("messageId") UUID messageId,
            HttpServletRequest http) {
        return chatService.deleteMessage(classroomId, userId(http), role(http), messageId);
    }

    @PostMapping("/messages/{messageId}/reactions")
    @Operation(summary = "Toggle an emoji reaction on a message")
    public MessageView toggleReaction(
            @PathVariable("classroomId") UUID classroomId,
            @PathVariable("messageId") UUID messageId,
            @RequestBody ReactionRequest body,
            HttpServletRequest http) {
        String emoji = body == null ? null : body.emoji();
        return chatService.toggleReaction(classroomId, userId(http), role(http), messageId, emoji);
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @Operation(summary = "SSE live updates (message / message_edited / pin / message_deleted / reaction)")
    public SseEmitter stream(@PathVariable("classroomId") UUID classroomId, HttpServletRequest http) {
        chatService.assertParticipant(classroomId, userId(http), role(http));
        return sseHub.subscribe(classroomId);
    }

    private UUID userId(HttpServletRequest http) {
        return (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID);
    }

    private String role(HttpServletRequest http) {
        return (String) http.getAttribute(UserContextInterceptor.ATTR_ROLE);
    }

    private String header(HttpServletRequest http, String name) {
        String v = http.getHeader(name);
        return v == null ? "" : v;
    }
}
