package vn.englishhub.classroom.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.classroom.domain.Classroom;
import vn.englishhub.classroom.domain.ClassroomMember;
import vn.englishhub.classroom.domain.JoinRequest;
import vn.englishhub.classroom.domain.JoinRequestStatus;
import vn.englishhub.classroom.repo.ClassroomMemberRepository;
import vn.englishhub.classroom.repo.ClassroomRepository;
import vn.englishhub.classroom.repo.JoinRequestRepository;

@Service
public class ClassroomService {

    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private final ClassroomRepository classrooms;
    private final ClassroomMemberRepository members;
    private final JoinRequestRepository joinRequests;
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper objectMapper;
    private final SecureRandom random = new SecureRandom();

    public ClassroomService(
            ClassroomRepository classrooms,
            ClassroomMemberRepository members,
            JoinRequestRepository joinRequests,
            KafkaTemplate<String, String> kafka,
            ObjectMapper objectMapper) {
        this.classrooms = classrooms;
        this.members = members;
        this.joinRequests = joinRequests;
        this.kafka = kafka;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Classroom create(UUID teacherId, String role, String name, String description) {
        requireRole(role, "TEACHER", "ADMIN");
        Classroom c = new Classroom();
        c.setId(UUID.randomUUID());
        c.setName(name.trim());
        c.setDescription(description);
        c.setTeacherId(teacherId);
        c.setInviteCode(generateInviteCode());
        classrooms.save(c);
        publish("classroom.events", "classroom.created", Map.of(
                "classroomId", c.getId().toString(),
                "teacherId", teacherId.toString(),
                "name", c.getName()));
        return c;
    }

    @Transactional(readOnly = true)
    public List<Classroom> listForUser(UUID userId, String role) {
        if ("TEACHER".equals(role) || "ADMIN".equals(role)) {
            return classrooms.findByTeacherId(userId);
        }
        return members.findByStudentId(userId).stream()
                .map(m -> classrooms.findById(m.getClassroomId()).orElse(null))
                .filter(c -> c != null)
                .toList();
    }

    /**
     * Hard-delete classroom. Members and join requests cascade via DB
     * {@code ON DELETE CASCADE}. Quizzes live in assessment-service (no cross-service FK);
     * callers should delete quizzes separately when cleaning up.
     */
    @Transactional
    public void delete(UUID teacherId, String role, UUID classroomId) {
        requireRole(role, "TEACHER", "ADMIN");
        Classroom classroom = get(classroomId);
        assertTeacherOwns(classroom, teacherId, role);
        classrooms.delete(classroom);
        publish("classroom.events", "classroom.deleted", Map.of(
                "classroomId", classroomId.toString(),
                "teacherId", classroom.getTeacherId().toString(),
                "name", classroom.getName()));
    }

    @Transactional
    public JoinRequest requestJoin(
            UUID studentId,
            String role,
            String inviteCode,
            String studentName,
            String studentEmail,
            String message) {
        requireRole(role, "STUDENT");
        Classroom classroom = classrooms.findByInviteCodeIgnoreCase(inviteCode.trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Invalid invite code"));

        if (members.existsByClassroomIdAndStudentId(classroom.getId(), studentId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Already enrolled");
        }

        return joinRequests
                .findByClassroomIdAndStudentIdAndStatus(classroom.getId(), studentId, JoinRequestStatus.PENDING)
                .orElseGet(() -> {
                    JoinRequest req = new JoinRequest();
                    req.setId(UUID.randomUUID());
                    req.setClassroomId(classroom.getId());
                    req.setStudentId(studentId);
                    req.setStudentName(studentName == null ? "" : studentName);
                    req.setStudentEmail(studentEmail == null ? "" : studentEmail);
                    req.setMessage(message);
                    req.setStatus(JoinRequestStatus.PENDING);
                    joinRequests.save(req);

                    Map<String, Object> payload = new HashMap<>();
                    payload.put("requestId", req.getId().toString());
                    payload.put("classroomId", classroom.getId().toString());
                    payload.put("classroomName", classroom.getName());
                    payload.put("teacherId", classroom.getTeacherId().toString());
                    payload.put("studentId", studentId.toString());
                    payload.put("studentName", req.getStudentName());
                    payload.put("studentEmail", req.getStudentEmail());
                    publish("classroom.events", "join_request.created", payload);
                    return req;
                });
    }

    @Transactional(readOnly = true)
    public List<JoinRequest> listPendingForClassroom(UUID teacherId, String role, UUID classroomId) {
        requireRole(role, "TEACHER", "ADMIN");
        Classroom classroom = get(classroomId);
        if (!classroom.getTeacherId().equals(teacherId) && !"ADMIN".equals(role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not your classroom");
        }
        return joinRequests.findByClassroomIdAndStatusOrderByCreatedAtDesc(
                classroomId, JoinRequestStatus.PENDING);
    }

    @Transactional(readOnly = true)
    public List<JoinRequest> listMyRequests(UUID studentId, String role) {
        requireRole(role, "STUDENT");
        return joinRequests.findByStudentIdOrderByCreatedAtDesc(studentId);
    }

    @Transactional
    public JoinRequest accept(UUID teacherId, String role, UUID requestId) {
        requireRole(role, "TEACHER", "ADMIN");
        JoinRequest req = getRequest(requestId);
        Classroom classroom = get(req.getClassroomId());
        assertTeacherOwns(classroom, teacherId, role);
        if (req.getStatus() == JoinRequestStatus.ACCEPTED) {
            return req; // idempotent — avoids UI 409 Conflict on double-click / stale notifs
        }
        if (req.getStatus() != JoinRequestStatus.PENDING) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Request is not pending");
        }

        req.setStatus(JoinRequestStatus.ACCEPTED);
        req.setDecidedBy(teacherId);
        req.setDecidedAt(Instant.now());
        req.setUpdatedAt(Instant.now());
        joinRequests.save(req);

        if (!members.existsByClassroomIdAndStudentId(req.getClassroomId(), req.getStudentId())) {
            ClassroomMember member = new ClassroomMember();
            member.setId(UUID.randomUUID());
            member.setClassroomId(req.getClassroomId());
            member.setStudentId(req.getStudentId());
            members.save(member);
        }

        Map<String, Object> accepted = basePayload(req, classroom);
        accepted.put("decidedBy", teacherId.toString());
        publish("classroom.events", "join_request.accepted", accepted);
        publish("classroom.events", "student.enrolled", Map.of(
                "classroomId", classroom.getId().toString(),
                "studentId", req.getStudentId().toString(),
                "requestId", req.getId().toString()));
        return req;
    }

    @Transactional
    public JoinRequest reject(UUID teacherId, String role, UUID requestId, String reason) {
        requireRole(role, "TEACHER", "ADMIN");
        JoinRequest req = getRequest(requestId);
        Classroom classroom = get(req.getClassroomId());
        assertTeacherOwns(classroom, teacherId, role);
        if (req.getStatus() == JoinRequestStatus.REJECTED) {
            return req; // idempotent
        }
        if (req.getStatus() != JoinRequestStatus.PENDING) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Request is not pending");
        }

        req.setStatus(JoinRequestStatus.REJECTED);
        req.setRejectReason(reason);
        req.setDecidedBy(teacherId);
        req.setDecidedAt(Instant.now());
        req.setUpdatedAt(Instant.now());
        joinRequests.save(req);

        Map<String, Object> rejected = basePayload(req, classroom);
        rejected.put("decidedBy", teacherId.toString());
        rejected.put("rejectReason", reason == null ? "" : reason);
        publish("classroom.events", "join_request.rejected", rejected);
        return req;
    }

    @Transactional(readOnly = true)
    public Classroom get(UUID id) {
        return classrooms.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Classroom not found"));
    }

    public record MemberView(
            UUID id,
            UUID classroomId,
            UUID studentId,
            String studentName,
            String studentEmail,
            Instant joinedAt) {}

    @Transactional(readOnly = true)
    public List<MemberView> listMembers(UUID teacherId, String role, UUID classroomId) {
        requireRole(role, "TEACHER", "ADMIN");
        Classroom classroom = get(classroomId);
        assertTeacherOwns(classroom, teacherId, role);

        Map<UUID, JoinRequest> acceptedByStudent = new HashMap<>();
        for (JoinRequest jr : joinRequests.findByClassroomIdAndStatusOrderByCreatedAtDesc(
                classroomId, JoinRequestStatus.ACCEPTED)) {
            acceptedByStudent.putIfAbsent(jr.getStudentId(), jr);
        }

        return members.findByClassroomId(classroomId).stream()
                .map(m -> {
                    JoinRequest jr = acceptedByStudent.get(m.getStudentId());
                    return new MemberView(
                            m.getId(),
                            m.getClassroomId(),
                            m.getStudentId(),
                            jr != null ? jr.getStudentName() : "",
                            jr != null ? jr.getStudentEmail() : "",
                            m.getJoinedAt());
                })
                .toList();
    }

    private JoinRequest getRequest(UUID id) {
        return joinRequests.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Join request not found"));
    }

    private void assertTeacherOwns(Classroom classroom, UUID teacherId, String role) {
        if (!classroom.getTeacherId().equals(teacherId) && !"ADMIN".equals(role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not your classroom");
        }
    }

    private Map<String, Object> basePayload(JoinRequest req, Classroom classroom) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("requestId", req.getId().toString());
        payload.put("classroomId", classroom.getId().toString());
        payload.put("classroomName", classroom.getName());
        payload.put("teacherId", classroom.getTeacherId().toString());
        payload.put("studentId", req.getStudentId().toString());
        payload.put("studentName", req.getStudentName());
        payload.put("studentEmail", req.getStudentEmail());
        return payload;
    }

    private String generateInviteCode() {
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    private void requireRole(String actual, String... allowed) {
        for (String a : allowed) {
            if (a.equals(actual)) {
                return;
            }
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Insufficient role");
    }

    private void publish(String topic, String type, Map<String, Object> payload) {
        try {
            String body = objectMapper.writeValueAsString(Map.of("type", type, "payload", payload));
            Object key = payload.getOrDefault("classroomId", payload.get("requestId"));
            kafka.send(topic, String.valueOf(key), body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
