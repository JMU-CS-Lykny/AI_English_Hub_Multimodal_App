package vn.englishhub.classroom.service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.classroom.domain.AttachmentKind;
import vn.englishhub.classroom.domain.ChatAttachment;
import vn.englishhub.classroom.domain.ChatMessage;
import vn.englishhub.classroom.domain.ChatReaction;
import vn.englishhub.classroom.domain.Classroom;
import vn.englishhub.classroom.realtime.ChatSseHub;
import vn.englishhub.classroom.repo.ChatAttachmentRepository;
import vn.englishhub.classroom.repo.ChatMessageRepository;
import vn.englishhub.classroom.repo.ChatReactionRepository;
import vn.englishhub.classroom.repo.ClassroomMemberRepository;
import vn.englishhub.classroom.repo.ClassroomRepository;

@Service
public class ChatService {

    private static final int DEFAULT_LIMIT = 40;
    private static final int MAX_LIMIT = 100;
    private static final int MAX_ATTACHMENTS = 4;
    /** ZWJ / skin-tone sequences can be longer than a single code point. */
    private static final int MAX_EMOJI_CHARS = 32;

    private static final Set<String> IMAGE_MIMES = Set.of(
            "image/jpeg", "image/png", "image/gif", "image/webp");
    private static final Set<String> VIDEO_MIMES = Set.of("video/mp4", "video/webm");
    private static final Set<String> FILE_MIMES = Set.of(
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/plain",
            "application/zip",
            "application/x-zip-compressed");

    /**
     * Max data-URL / base64 character length per kind.
     * ~5MB binary ≈ ~6.7M base64 chars (+ data-URL prefix); keep headroom under gateway 16MB JSON.
     */
    private static final int MAX_CHARS_IMAGE = 7_000_000;
    private static final int MAX_CHARS_VIDEO = 7_000_000;
    private static final int MAX_CHARS_FILE = 7_000_000;

    private final ClassroomRepository classrooms;
    private final ClassroomMemberRepository members;
    private final ChatMessageRepository messages;
    private final ChatAttachmentRepository attachments;
    private final ChatReactionRepository reactions;
    private final ChatSseHub sseHub;

    public ChatService(
            ClassroomRepository classrooms,
            ClassroomMemberRepository members,
            ChatMessageRepository messages,
            ChatAttachmentRepository attachments,
            ChatReactionRepository reactions,
            ChatSseHub sseHub) {
        this.classrooms = classrooms;
        this.members = members;
        this.messages = messages;
        this.attachments = attachments;
        this.reactions = reactions;
        this.sseHub = sseHub;
    }

    public record AttachmentInput(String kind, String fileName, String mimeType, String urlOrData) {}

    public record AttachmentView(
            String id, String kind, String fileName, String mimeType, String urlOrData, Long sizeBytes) {}

    public record ReactionChip(String emoji, long count, boolean reactedByMe) {}

    public record MessageView(
            String id,
            String classroomId,
            String senderId,
            String senderName,
            String senderRole,
            String text,
            boolean deleted,
            boolean pinned,
            String pinnedAt,
            String editedAt,
            String createdAt,
            List<AttachmentView> attachments,
            List<ReactionChip> reactions) {}

    /** Initial / poll feed: pinned strip + chronological page. */
    public record ChatFeedView(List<MessageView> pinned, List<MessageView> messages) {}

    @Transactional(readOnly = true)
    public ChatFeedView listMessages(
            UUID classroomId, UUID userId, String role, Instant before, Integer limit) {
        assertParticipant(classroomId, userId, role);
        int pageSize = clampLimit(limit);
        List<ChatMessage> page;
        if (before == null) {
            page = messages.findByClassroomIdOrderByCreatedAtDesc(classroomId, PageRequest.of(0, pageSize));
        } else {
            page = messages.findByClassroomIdAndCreatedAtBeforeOrderByCreatedAtDesc(
                    classroomId, before, PageRequest.of(0, pageSize));
        }
        // Chronological for UI (oldest → newest)
        List<ChatMessage> chronological = new ArrayList<>(page);
        chronological.sort(Comparator.comparing(ChatMessage::getCreatedAt));

        List<ChatMessage> pinnedRows =
                messages.findByClassroomIdAndPinnedAtIsNotNullAndDeletedAtIsNullOrderByPinnedAtDesc(
                        classroomId);
        return new ChatFeedView(toViews(pinnedRows, userId), toViews(chronological, userId));
    }

    @Transactional
    public MessageView sendMessage(
            UUID classroomId,
            UUID userId,
            String role,
            String senderName,
            String text,
            List<AttachmentInput> attachmentInputs) {
        assertParticipant(classroomId, userId, role);

        String body = text == null ? "" : text.trim();
        List<AttachmentInput> files =
                attachmentInputs == null ? List.of() : attachmentInputs.stream().filter(a -> a != null).toList();

        if (body.isEmpty() && files.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Message text or attachment required");
        }
        if (files.size() > MAX_ATTACHMENTS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Too many attachments");
        }

        ChatMessage msg = new ChatMessage();
        msg.setId(UUID.randomUUID());
        msg.setClassroomId(classroomId);
        msg.setSenderId(userId);
        msg.setSenderName(senderName == null || senderName.isBlank() ? "User" : senderName.trim());
        msg.setSenderRole(role);
        msg.setBody(body.isEmpty() ? null : body);
        msg.setCreatedAt(Instant.now());
        messages.save(msg);

        List<ChatAttachment> savedAttachments = new ArrayList<>();
        for (AttachmentInput input : files) {
            savedAttachments.add(saveAttachment(msg.getId(), input));
        }

        MessageView view = toView(msg, savedAttachments, List.of(), userId);
        sseHub.publish(classroomId, "message", view);
        return view;
    }

    @Transactional
    public MessageView editMessage(
            UUID classroomId, UUID userId, String role, UUID messageId, String text) {
        assertParticipant(classroomId, userId, role);
        ChatMessage msg = requireMessage(classroomId, messageId);
        if (msg.isDeleted()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Cannot edit deleted message");
        }
        if (!canEditMessage(msg, userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot edit this message");
        }

        String body = text == null ? "" : text.trim();
        if (body.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Message text required");
        }

        msg.setBody(body);
        msg.setEditedAt(Instant.now());
        messages.save(msg);

        List<ChatAttachment> atts = attachments.findByMessageId(msg.getId());
        MessageView view = toView(msg, atts, reactions.findByMessageId(msg.getId()), userId);
        sseHub.publish(classroomId, "message_edited", view);
        return view;
    }

    @Transactional
    public MessageView togglePin(UUID classroomId, UUID userId, String role, UUID messageId) {
        assertParticipant(classroomId, userId, role);
        ChatMessage msg = requireMessage(classroomId, messageId);
        return applyPinState(classroomId, userId, msg, !msg.isPinned());
    }

    @Transactional
    public MessageView unpinMessage(UUID classroomId, UUID userId, String role, UUID messageId) {
        assertParticipant(classroomId, userId, role);
        ChatMessage msg = requireMessage(classroomId, messageId);
        return applyPinState(classroomId, userId, msg, false);
    }

    private MessageView applyPinState(
            UUID classroomId, UUID userId, ChatMessage msg, boolean pinned) {
        if (msg.isDeleted()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Cannot pin deleted message");
        }
        if (pinned == msg.isPinned()) {
            List<ChatAttachment> atts = attachments.findByMessageId(msg.getId());
            return toView(msg, atts, reactions.findByMessageId(msg.getId()), userId);
        }
        msg.setPinnedAt(pinned ? Instant.now() : null);
        messages.save(msg);

        List<ChatAttachment> atts = attachments.findByMessageId(msg.getId());
        MessageView view = toView(msg, atts, reactions.findByMessageId(msg.getId()), userId);
        sseHub.publish(classroomId, "pin", view);
        return view;
    }

    @Transactional
    public MessageView deleteMessage(UUID classroomId, UUID userId, String role, UUID messageId) {
        assertParticipant(classroomId, userId, role);
        if (!canModerate(classroomId, userId, role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only teacher can delete messages");
        }

        ChatMessage msg = requireMessage(classroomId, messageId);
        if (msg.isDeleted()) {
            return toView(msg, List.of(), reactions.findByMessageId(msg.getId()), userId);
        }

        msg.setDeletedAt(Instant.now());
        msg.setBody(null);
        msg.setPinnedAt(null);
        messages.save(msg);
        // Drop attachment payloads so soft-deleted messages do not keep media forever
        List<ChatAttachment> existing = attachments.findByMessageId(msg.getId());
        if (!existing.isEmpty()) {
            attachments.deleteAll(existing);
        }

        MessageView view = toView(msg, List.of(), reactions.findByMessageId(msg.getId()), userId);
        sseHub.publish(classroomId, "message_deleted", Map.of(
                "id", msg.getId().toString(),
                "classroomId", classroomId.toString(),
                "deleted", true,
                "deletedAt", msg.getDeletedAt().toString()));
        return view;
    }

    @Transactional
    public MessageView toggleReaction(
            UUID classroomId, UUID userId, String role, UUID messageId, String emojiRaw) {
        assertParticipant(classroomId, userId, role);
        String emoji = emojiRaw == null ? "" : emojiRaw.trim();
        if (!isValidReactionEmoji(emoji)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported emoji");
        }

        ChatMessage msg = requireMessage(classroomId, messageId);
        if (msg.isDeleted()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Cannot react to deleted message");
        }

        var existing = reactions.findByMessageIdAndUserIdAndEmoji(messageId, userId, emoji);
        if (existing.isPresent()) {
            reactions.delete(existing.get());
        } else {
            ChatReaction reaction = new ChatReaction();
            reaction.setId(UUID.randomUUID());
            reaction.setMessageId(messageId);
            reaction.setUserId(userId);
            reaction.setEmoji(emoji);
            reaction.setCreatedAt(Instant.now());
            reactions.save(reaction);
        }

        List<ChatAttachment> atts = attachments.findByMessageId(messageId);
        MessageView view = toView(msg, atts, reactions.findByMessageId(messageId), userId);
        sseHub.publish(classroomId, "reaction", view);
        return view;
    }

    public void assertParticipant(UUID classroomId, UUID userId, String role) {
        Classroom classroom = getClassroom(classroomId);
        if ("ADMIN".equals(role)) {
            return;
        }
        if ("TEACHER".equals(role) && classroom.getTeacherId().equals(userId)) {
            return;
        }
        if ("STUDENT".equals(role) && members.existsByClassroomIdAndStudentId(classroomId, userId)) {
            return;
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not a classroom participant");
    }

    private boolean canModerate(UUID classroomId, UUID userId, String role) {
        if ("ADMIN".equals(role)) {
            return true;
        }
        if ("TEACHER".equals(role)) {
            return getClassroom(classroomId).getTeacherId().equals(userId);
        }
        return false;
    }

    /** Authors may edit their own messages only (all roles). */
    private boolean canEditMessage(ChatMessage msg, UUID userId) {
        return msg.getSenderId().equals(userId);
    }

    private ChatMessage requireMessage(UUID classroomId, UUID messageId) {
        ChatMessage msg = messages.findById(messageId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Message not found"));
        if (!msg.getClassroomId().equals(classroomId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Message not found");
        }
        return msg;
    }

    private Classroom getClassroom(UUID classroomId) {
        return classrooms.findById(classroomId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Classroom not found"));
    }

    private ChatAttachment saveAttachment(UUID messageId, AttachmentInput input) {
        AttachmentKind kind;
        try {
            kind = AttachmentKind.fromApi(input.kind());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid attachment kind");
        }
        String fileName = input.fileName() == null ? "" : input.fileName().trim();
        String mime = input.mimeType() == null ? "" : input.mimeType().trim().toLowerCase();
        String data = input.urlOrData() == null ? "" : input.urlOrData().trim();
        if (fileName.isEmpty() || fileName.length() > 512) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }
        if (data.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Attachment data required");
        }
        validateMimeAndSize(kind, mime, data);

        ChatAttachment att = new ChatAttachment();
        att.setId(UUID.randomUUID());
        att.setMessageId(messageId);
        att.setKind(kind);
        att.setFileName(fileName);
        att.setMimeType(mime);
        att.setUrlOrData(data);
        att.setSizeBytes((long) estimateDecodedBytes(data));
        return attachments.save(att);
    }

    private void validateMimeAndSize(AttachmentKind kind, String mime, String data) {
        Set<String> allowed = switch (kind) {
            case IMAGE -> IMAGE_MIMES;
            case VIDEO -> VIDEO_MIMES;
            case FILE -> FILE_MIMES;
        };
        if (!allowed.contains(mime)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "MIME type not allowed for " + kind);
        }
        int maxChars = switch (kind) {
            case IMAGE -> MAX_CHARS_IMAGE;
            case VIDEO -> MAX_CHARS_VIDEO;
            case FILE -> MAX_CHARS_FILE;
        };
        if (data.length() > maxChars) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Attachment too large for " + kind);
        }
    }

    private static int estimateDecodedBytes(String data) {
        int comma = data.indexOf(',');
        String payload = comma >= 0 ? data.substring(comma + 1) : data;
        // base64 ≈ 3/4 of char length
        return (int) (payload.length() * 0.75);
    }

    private int clampLimit(Integer limit) {
        if (limit == null || limit <= 0) {
            return DEFAULT_LIMIT;
        }
        return Math.min(limit, MAX_LIMIT);
    }

    private List<MessageView> toViews(List<ChatMessage> msgs, UUID viewerId) {
        if (msgs.isEmpty()) {
            return List.of();
        }
        List<UUID> ids = msgs.stream().map(ChatMessage::getId).toList();
        Map<UUID, List<ChatAttachment>> byMsg = new HashMap<>();
        for (ChatAttachment a : attachments.findByMessageIdIn(ids)) {
            byMsg.computeIfAbsent(a.getMessageId(), k -> new ArrayList<>()).add(a);
        }
        Map<UUID, List<ChatReaction>> reactionsByMsg = new HashMap<>();
        for (ChatReaction r : reactions.findByMessageIdIn(ids)) {
            reactionsByMsg.computeIfAbsent(r.getMessageId(), k -> new ArrayList<>()).add(r);
        }
        List<MessageView> out = new ArrayList<>(msgs.size());
        for (ChatMessage m : msgs) {
            List<ChatAttachment> atts = m.isDeleted() ? List.of() : byMsg.getOrDefault(m.getId(), List.of());
            out.add(toView(m, atts, reactionsByMsg.getOrDefault(m.getId(), List.of()), viewerId));
        }
        return out;
    }

    private MessageView toView(
            ChatMessage m, List<ChatAttachment> atts, List<ChatReaction> reactionRows, UUID viewerId) {
        List<AttachmentView> attachmentViews = atts.stream()
                .map(a -> new AttachmentView(
                        a.getId().toString(),
                        a.getKind().toApi(),
                        a.getFileName(),
                        a.getMimeType(),
                        a.getUrlOrData(),
                        a.getSizeBytes()))
                .toList();
        return new MessageView(
                m.getId().toString(),
                m.getClassroomId().toString(),
                m.getSenderId().toString(),
                m.getSenderName(),
                m.getSenderRole(),
                m.isDeleted() ? null : m.getBody(),
                m.isDeleted(),
                m.isPinned() && !m.isDeleted(),
                m.isPinned() && !m.isDeleted() && m.getPinnedAt() != null ? m.getPinnedAt().toString() : null,
                m.getEditedAt() == null ? null : m.getEditedAt().toString(),
                m.getCreatedAt() == null ? null : m.getCreatedAt().toString(),
                attachmentViews,
                aggregateReactions(reactionRows, viewerId));
    }

    private List<ReactionChip> aggregateReactions(List<ChatReaction> rows, UUID viewerId) {
        Map<String, Long> counts = new LinkedHashMap<>();
        Set<String> mine = new HashSet<>();
        for (ChatReaction r : rows) {
            counts.merge(r.getEmoji(), 1L, Long::sum);
            if (r.getUserId().equals(viewerId)) {
                mine.add(r.getEmoji());
            }
        }
        List<ReactionChip> chips = new ArrayList<>();
        for (Map.Entry<String, Long> e : counts.entrySet()) {
            chips.add(new ReactionChip(e.getKey(), e.getValue(), mine.contains(e.getKey())));
        }
        return chips;
    }

    /**
     * Accept common Unicode emoji (incl. ZWJ / variation selectors / skin tones).
     * Reject blank, oversized, or control-character payloads.
     */
    static boolean isValidReactionEmoji(String emoji) {
        if (emoji == null || emoji.isBlank() || emoji.length() > MAX_EMOJI_CHARS) {
            return false;
        }
        boolean hasEmoji = false;
        for (int i = 0; i < emoji.length(); ) {
            int cp = emoji.codePointAt(i);
            i += Character.charCount(cp);
            if (cp == '\n' || cp == '\r' || cp == '\t') {
                return false;
            }
            // ZWJ, variation selectors, skin-tone modifiers — allowed in sequences
            if (cp == 0x200D || cp == 0xFE0F || cp == 0xFE0E
                    || (cp >= 0x1F3FB && cp <= 0x1F3FF)) {
                continue;
            }
            if (Character.isEmoji(cp) || Character.isEmojiModifier(cp) || Character.isEmojiComponent(cp)) {
                hasEmoji = true;
                continue;
            }
            // Allow keycap base digits / # / * used in emoji keycaps
            if ((cp >= '0' && cp <= '9') || cp == '#' || cp == '*') {
                continue;
            }
            if (Character.isISOControl(cp)) {
                return false;
            }
            // Reject arbitrary text / letters masquerading as reactions
            if (Character.isLetterOrDigit(cp) || Character.isWhitespace(cp)) {
                return false;
            }
        }
        return hasEmoji;
    }
}
