package vn.englishhub.assessment.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import vn.englishhub.assessment.domain.Quiz;
import vn.englishhub.assessment.domain.QuizAttempt;
import vn.englishhub.assessment.service.QuizService;

@RestController
@RequestMapping("/api/v1/assessments/quizzes")
@Tag(name = "Quizzes", description = "Author quizzes, import/export Excel, publish and grade attempts")
public class QuizController {
    private final QuizService quizService;

    public QuizController(QuizService quizService) {
        this.quizService = quizService;
    }

    public record CreateQuizRequest(
            @NotNull UUID classroomId,
            @NotBlank String title,
            @NotNull List<Map<String, Object>> questions) {}

    public record UpdateQuizRequest(String title, List<Map<String, Object>> questions) {}

    public record SubmitRequest(@NotNull List<String> answers) {}

    public record QuizResponse(
            String id, String classroomId, String title, String status, String questionsJson) {}

    public record AttemptResponse(
            String id, String quizId, String studentId, int score, int maxScore, String submittedAt) {}

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(
            summary = "Create draft quiz (TEACHER/ADMIN)",
            description = "Question: `{ id?, prompt, type: short|mcq, choices?, answer }`.")
    public QuizResponse create(@Valid @RequestBody CreateQuizRequest req, HttpServletRequest http) {
        Quiz q = quizService.create(
                userId(http), role(http), req.classroomId(), req.title(), req.questions());
        return toQuiz(q, role(http));
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update quiz title + questions (TEACHER owner)")
    public QuizResponse update(
            @PathVariable("id") UUID id,
            @RequestBody UpdateQuizRequest req,
            HttpServletRequest http) {
        Quiz q = quizService.update(userId(http), role(http), id, req.title(), req.questions());
        return toQuiz(q, role(http));
    }

    @PostMapping("/{id}/publish")
    @Operation(summary = "Publish quiz (TEACHER owner)")
    public QuizResponse publish(@PathVariable("id") UUID id, HttpServletRequest http) {
        return toQuiz(quizService.publish(userId(http), role(http), id), role(http));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(
            summary = "Delete quiz (TEACHER owner or ADMIN)",
            description = "Hard-delete. Attempts cascade via DB FK ON DELETE CASCADE.")
    public void delete(@PathVariable("id") UUID id, HttpServletRequest http) {
        quizService.delete(userId(http), role(http), id);
    }

    @PostMapping(value = "/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Import Excel (.xlsx) as draft quiz (TEACHER)")
    public QuizResponse importExcel(
            @RequestParam UUID classroomId,
            @RequestParam(required = false) String title,
            @RequestPart("file") MultipartFile file,
            HttpServletRequest http) {
        try {
            Quiz q = quizService.importExcel(
                    userId(http), role(http), classroomId, title, file.getInputStream());
            return toQuiz(q, role(http));
        } catch (java.io.IOException e) {
            throw new org.springframework.web.server.ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Failed to read upload");
        }
    }

    @GetMapping("/{id}/export")
    @Operation(summary = "Export quiz Q&A as Excel (.xlsx)")
    public ResponseEntity<byte[]> export(@PathVariable("id") UUID id, HttpServletRequest http) {
        byte[] bytes = quizService.exportExcel(userId(http), role(http), id);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"quiz-" + id + ".xlsx\"")
                .contentType(MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(bytes);
    }

    @GetMapping
    @Operation(summary = "List quizzes by classroom (students see PUBLISHED only)")
    public List<QuizResponse> list(@RequestParam UUID classroomId, HttpServletRequest http) {
        String role = role(http);
        return quizService.list(classroomId, role).stream().map(q -> toQuiz(q, role)).toList();
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get quiz (students get answers stripped)")
    public QuizResponse get(@PathVariable("id") UUID id, HttpServletRequest http) {
        String role = role(http);
        return toQuiz(quizService.getForViewer(id, role), role);
    }

    @GetMapping("/{id}/attempts")
    @Operation(summary = "List attempts/scores for a quiz (TEACHER)")
    public List<AttemptResponse> attempts(@PathVariable("id") UUID id, HttpServletRequest http) {
        return quizService.listAttempts(userId(http), role(http), id).stream()
                .map(this::toAttempt)
                .toList();
    }

    @PostMapping("/{id}/submit")
    @Operation(summary = "Submit quiz answers (STUDENT)")
    public AttemptResponse submit(
            @PathVariable("id") UUID id, @Valid @RequestBody SubmitRequest req, HttpServletRequest http) {
        QuizAttempt a = quizService.submit(userId(http), role(http), id, req.answers());
        return toAttempt(a);
    }

    private QuizResponse toQuiz(Quiz q, String role) {
        return new QuizResponse(
                q.getId().toString(),
                q.getClassroomId().toString(),
                q.getTitle(),
                q.getStatus() == null ? "DRAFT" : q.getStatus().name(),
                quizService.questionsJsonForViewer(q, role));
    }

    private AttemptResponse toAttempt(QuizAttempt a) {
        return new AttemptResponse(
                a.getId().toString(),
                a.getQuizId().toString(),
                a.getStudentId().toString(),
                a.getScore(),
                a.getMaxScore(),
                a.getSubmittedAt() == null ? null : a.getSubmittedAt().toString());
    }

    private UUID userId(HttpServletRequest http) {
        return (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID);
    }

    private String role(HttpServletRequest http) {
        return (String) http.getAttribute(UserContextInterceptor.ATTR_ROLE);
    }
}
