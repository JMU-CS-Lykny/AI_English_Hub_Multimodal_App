package vn.englishhub.classroom.repo;

import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.ChatAttachment;

public interface ChatAttachmentRepository extends JpaRepository<ChatAttachment, UUID> {
    List<ChatAttachment> findByMessageIdIn(Collection<UUID> messageIds);

    List<ChatAttachment> findByMessageId(UUID messageId);
}
