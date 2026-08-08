package vn.englishhub.classroom.repo;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.Classroom;

public interface ClassroomRepository extends JpaRepository<Classroom, UUID> {
    List<Classroom> findByTeacherId(UUID teacherId);
    Optional<Classroom> findByInviteCodeIgnoreCase(String inviteCode);
}
