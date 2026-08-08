package vn.englishhub.content.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import vn.englishhub.content.domain.Lesson;
import vn.englishhub.content.service.LessonService;

@RestController
@RequestMapping("/api/v1/content/lessons")
@Tag(name = "Lessons", description = "Create, list, and publish classroom lessons")
public class LessonController {
    private final LessonService lessonService;

    public LessonController(LessonService lessonService) {
        this.lessonService = lessonService;
    }

    public record CreateLessonRequest(
            @NotNull UUID classroomId,
            @NotBlank String title,
            @NotBlank String body,
            String cefrLevel) {}

    public record LessonResponse(
            String id, String classroomId, String title, String body, String cefrLevel, String status) {}

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create draft lesson (TEACHER/ADMIN)")
    public LessonResponse create(@Valid @RequestBody CreateLessonRequest req, HttpServletRequest http) {
        return toResponse(lessonService.create(
                (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID),
                (String) http.getAttribute(UserContextInterceptor.ATTR_ROLE),
                req.classroomId(), req.title(), req.body(), req.cefrLevel()));
    }

    @GetMapping
    @Operation(summary = "List lessons by classroom")
    public List<LessonResponse> list(@RequestParam UUID classroomId) {
        return lessonService.listByClassroom(classroomId).stream().map(this::toResponse).toList();
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get lesson")
    public LessonResponse get(@PathVariable("id") UUID id) {
        return toResponse(lessonService.get(id));
    }

    @PostMapping("/{id}/publish")
    @Operation(summary = "Publish lesson and emit RAG index event")
    public LessonResponse publish(@PathVariable("id") UUID id, HttpServletRequest http) {
        return toResponse(lessonService.publish(
                (UUID) http.getAttribute(UserContextInterceptor.ATTR_USER_ID),
                (String) http.getAttribute(UserContextInterceptor.ATTR_ROLE),
                id));
    }

    private LessonResponse toResponse(Lesson l) {
        return new LessonResponse(
                l.getId().toString(),
                l.getClassroomId().toString(),
                l.getTitle(),
                l.getBody(),
                l.getCefrLevel(),
                l.getStatus().name());
    }
}
