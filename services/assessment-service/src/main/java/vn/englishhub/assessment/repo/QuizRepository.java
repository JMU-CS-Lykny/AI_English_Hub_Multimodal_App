package vn.englishhub.assessment.repo;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.assessment.domain.Quiz;
import vn.englishhub.assessment.domain.QuizStatus;

public interface QuizRepository extends JpaRepository<Quiz, UUID> {
    List<Quiz> findByClassroomIdOrderByCreatedAtDesc(UUID classroomId);

    List<Quiz> findByClassroomIdAndStatusOrderByCreatedAtDesc(UUID classroomId, QuizStatus status);
}
