package vn.englishhub.notification.repo;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import vn.englishhub.notification.domain.Notification;

public interface NotificationRepository extends JpaRepository<Notification, UUID> {
    List<Notification> findByUserIdOrderByCreatedAtDesc(UUID userId);

    @Query("select count(n) from Notification n where n.userId = ?1 and n.readAt is null")
    long countUnread(UUID userId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Notification n set n.readAt = ?2 where n.userId = ?1 and n.readAt is null")
    int markAllRead(UUID userId, Instant now);

    List<Notification> findByRefTypeAndRefIdAndType(String refType, UUID refId, String type);
}
