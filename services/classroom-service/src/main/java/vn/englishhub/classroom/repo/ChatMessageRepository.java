package vn.englishhub.classroom.repo;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.ChatMessage;

public interface ChatMessageRepository extends JpaRepository<ChatMessage, UUID> {
    List<ChatMessage> findByClassroomIdOrderByCreatedAtDesc(UUID classroomId, Pageable pageable);

    List<ChatMessage> findByClassroomIdAndCreatedAtBeforeOrderByCreatedAtDesc(
            UUID classroomId, Instant before, Pageable pageable);

    List<ChatMessage> findByClassroomIdAndPinnedAtIsNotNullAndDeletedAtIsNullOrderByPinnedAtDesc(
            UUID classroomId);
}
