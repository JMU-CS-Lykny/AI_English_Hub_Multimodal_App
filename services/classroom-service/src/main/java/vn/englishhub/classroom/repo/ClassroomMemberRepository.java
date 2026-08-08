package vn.englishhub.classroom.repo;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import vn.englishhub.classroom.domain.ClassroomMember;

public interface ClassroomMemberRepository extends JpaRepository<ClassroomMember, UUID> {
    boolean existsByClassroomIdAndStudentId(UUID classroomId, UUID studentId);
    List<ClassroomMember> findByStudentId(UUID studentId);
    List<ClassroomMember> findByClassroomId(UUID classroomId);
    Optional<ClassroomMember> findByClassroomIdAndStudentId(UUID classroomId, UUID studentId);
}
