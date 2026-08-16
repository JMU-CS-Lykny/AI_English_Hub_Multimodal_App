package vn.englishhub.classroom.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import vn.englishhub.classroom.domain.Classroom;
import vn.englishhub.classroom.domain.JoinRequest;
import vn.englishhub.classroom.service.ClassroomService;

@RestController
@RequestMapping("/api/v1/classrooms")
@Tag(name = "Classrooms", description = "Classroom management and join approval")
public class ClassroomController {

    private final ClassroomService classroomService;

    public ClassroomController(ClassroomService classroomService) {
        this.classroomService = classroomService;
    }

    public record CreateRequest(@NotBlank String name, String description) {}

    public record JoinRequestBody(@NotBlank String inviteCode, String message) {}

    public record RejectBody(String reason) {}

    public record ClassroomResponse(
            String id, String name, String description, String teacherId, String inviteCode) {}

    public record JoinRequestResponse(
            String id,
            String classroomId,
            String studentId,
            String studentName,
            String studentEmail,
            String status,
            String message,
            String rejectReason,
            String createdAt) {}

    public record MemberResponse(
            String id,
            String classroomId,
            String studentId,
            String studentName,
            String studentEmail,
            String joinedAt) {}

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create classroom (TEACHER/ADMIN)")
    public ClassroomResponse create(@Valid @RequestBody CreateRequest req, HttpServletRequest http) {
        Classroom c = classroomService.create(userId(http), role(http), req.name(), req.description());
        return toResponse(c);
    }

    @GetMapping
    @Operation(summary = "List my classrooms")
    public List<ClassroomResponse> list(HttpServletRequest http) {
        return classroomService.listForUser(userId(http), role(http)).stream().map(this::toResponse).toList();
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get classroom by id")
    public ClassroomResponse get(@PathVariable("id") UUID id) {
        return toResponse(classroomService.get(id));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(
            summary = "Delete classroom (owning TEACHER or ADMIN)",
            description =
                    "Hard-delete. Members and join requests cascade via DB FK. "
                            + "Quizzes are not in this service — delete them via assessment API first.")
    public void delete(@PathVariable("id") UUID id, HttpServletRequest http) {
        classroomService.delete(userId(http), role(http), id);
    }

    @PostMapping("/join-requests")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Student requests to join with invite code (PENDING until teacher accepts)")
    public JoinRequestResponse requestJoin(@Valid @RequestBody JoinRequestBody req, HttpServletRequest http) {
        JoinRequest jr = classroomService.requestJoin(
                userId(http),
                role(http),
                req.inviteCode(),
                UserHeaderEncoding.decode(header(http, "X-User-Name")),
                header(http, "X-User-Email"),
                req.message());
        return toJoinResponse(jr);
    }

    @PostMapping("/join")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Alias of join-requests (no longer auto-enrolls)")
    public JoinRequestResponse joinAlias(@Valid @RequestBody JoinRequestBody req, HttpServletRequest http) {
        return requestJoin(req, http);
    }

    @GetMapping("/{id}/members")
    @Operation(summary = "List enrolled members (TEACHER)")
    public List<MemberResponse> listMembers(@PathVariable("id") UUID id, HttpServletRequest http) {
        return classroomService.listMembers(userId(http), role(http), id).stream()
                .map(m -> new MemberResponse(
                        m.id().toString(),
                        m.classroomId().toString(),
                        m.studentId().toString(),
                        m.studentName(),
                        m.studentEmail(),
                        m.joinedAt() == null ? null : m.joinedAt().toString()))
                .toList();
    }

    @GetMapping("/{id}/join-requests")
    @Operation(summary = "List PENDING join requests for a classroom (TEACHER)")
    public List<JoinRequestResponse> listPending(@PathVariable("id") UUID id, HttpServletRequest http) {
        return classroomService.listPendingForClassroom(userId(http), role(http), id).stream()
                .map(this::toJoinResponse)
                .toList();
    }

    @GetMapping("/join-requests/mine")
    @Operation(summary = "List my join requests (STUDENT)")
    public List<JoinRequestResponse> myRequests(HttpServletRequest http) {
        return classroomService.listMyRequests(userId(http), role(http)).stream()
                .map(this::toJoinResponse)
                .toList();
    }

    @PostMapping("/join-requests/{requestId}/accept")
    @Operation(summary = "Accept join request (TEACHER)")
    public JoinRequestResponse accept(@PathVariable("requestId") UUID requestId, HttpServletRequest http) {
        return toJoinResponse(classroomService.accept(userId(http), role(http), requestId));
    }

    @PostMapping("/join-requests/{requestId}/reject")
    @Operation(summary = "Reject join request (TEACHER)")
    public JoinRequestResponse reject(
            @PathVariable("requestId") UUID requestId,
            @RequestBody(required = false) RejectBody body,
            HttpServletRequest http) {
        String reason = body == null ? null : body.reason();
        return toJoinResponse(classroomService.reject(userId(http), role(http), requestId, reason));
    }

    private ClassroomResponse toResponse(Classroom c) {
        return new ClassroomResponse(
                c.getId().toString(),
                c.getName(),
                c.getDescription(),
                c.getTeacherId().toString(),
                c.getInviteCode());
    }

    private JoinRequestResponse toJoinResponse(JoinRequest jr) {
        return new JoinRequestResponse(
                jr.getId().toString(),
                jr.getClassroomId().toString(),
                jr.getStudentId().toString(),
                jr.getStudentName(),
                jr.getStudentEmail(),
                jr.getStatus().name(),
                jr.getMessage(),
                jr.getRejectReason(),
                jr.getCreatedAt() == null ? null : jr.getCreatedAt().toString());
    }

    private UUID userId(HttpServletRequest http) {
        return (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID);
    }

    private String role(HttpServletRequest http) {
        return (String) http.getAttribute(UserContextInterceptor.ATTR_ROLE);
    }

    private String header(HttpServletRequest http, String name) {
        String v = http.getHeader(name);
        return v == null ? "" : v;
    }
}
