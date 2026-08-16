package vn.englishhub.assessment.repo;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.assessment.domain.QuizAttempt;

public interface QuizAttemptRepository extends JpaRepository<QuizAttempt, UUID> {
    List<QuizAttempt> findByQuizIdOrderBySubmittedAtDesc(UUID quizId);

    boolean existsByQuizIdAndStudentId(UUID quizId, UUID studentId);
}
