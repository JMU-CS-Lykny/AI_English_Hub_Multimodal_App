package vn.englishhub.content.repo;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.content.domain.Lesson;

public interface LessonRepository extends JpaRepository<Lesson, UUID> {
    List<Lesson> findByClassroomIdOrderByCreatedAtDesc(UUID classroomId);
}
