package vn.englishhub.classroom.repo;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.ChatReaction;

public interface ChatReactionRepository extends JpaRepository<ChatReaction, UUID> {
    List<ChatReaction> findByMessageIdIn(Collection<UUID> messageIds);

    List<ChatReaction> findByMessageId(UUID messageId);

    Optional<ChatReaction> findByMessageIdAndUserIdAndEmoji(UUID messageId, UUID userId, String emoji);
}
