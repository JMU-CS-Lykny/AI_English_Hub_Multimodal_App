package vn.englishhub.classroom.repo;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.JoinRequest;
import vn.englishhub.classroom.domain.JoinRequestStatus;

public interface JoinRequestRepository extends JpaRepository<JoinRequest, UUID> {
    Optional<JoinRequest> findByClassroomIdAndStudentIdAndStatus(
            UUID classroomId, UUID studentId, JoinRequestStatus status);

    List<JoinRequest> findByClassroomIdAndStatusOrderByCreatedAtDesc(
            UUID classroomId, JoinRequestStatus status);

    List<JoinRequest> findByStudentIdOrderByCreatedAtDesc(UUID studentId);

    List<JoinRequest> findByStudentIdAndStatusOrderByCreatedAtDesc(
            UUID studentId, JoinRequestStatus status);
}
