package vn.englishhub.content.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.content.domain.Lesson;
import vn.englishhub.content.repo.LessonRepository;

@Service
public class LessonService {
    private final LessonRepository lessons;
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper objectMapper;

    public LessonService(LessonRepository lessons, KafkaTemplate<String, String> kafka, ObjectMapper objectMapper) {
        this.lessons = lessons;
        this.kafka = kafka;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Lesson create(UUID userId, String role, UUID classroomId, String title, String body, String cefrLevel) {
        requireTeacher(role);
        Lesson lesson = new Lesson();
        lesson.setId(UUID.randomUUID());
        lesson.setClassroomId(classroomId);
        lesson.setTitle(title.trim());
        lesson.setBody(body);
        lesson.setCefrLevel(cefrLevel == null || cefrLevel.isBlank() ? "A1" : cefrLevel);
        lesson.setCreatedBy(userId);
        return lessons.save(lesson);
    }

    @Transactional(readOnly = true)
    public List<Lesson> listByClassroom(UUID classroomId) {
        return lessons.findByClassroomIdOrderByCreatedAtDesc(classroomId);
    }

    @Transactional(readOnly = true)
    public Lesson get(UUID id) {
        return lessons.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Lesson not found"));
    }

    @Transactional
    public Lesson publish(UUID userId, String role, UUID lessonId) {
        requireTeacher(role);
        Lesson lesson = get(lessonId);
        lesson.setStatus(Lesson.Status.PUBLISHED);
        lesson.setPublishedAt(Instant.now());
        lessons.save(lesson);
        try {
            String body = objectMapper.writeValueAsString(Map.of(
                    "type", "lesson.published",
                    "payload", Map.of(
                            "lessonId", lesson.getId().toString(),
                            "classroomId", lesson.getClassroomId().toString(),
                            "title", lesson.getTitle(),
                            "body", lesson.getBody(),
                            "cefrLevel", lesson.getCefrLevel())));
            kafka.send("content.events", lesson.getId().toString(), body);
            kafka.send("rag.events", lesson.getId().toString(), objectMapper.writeValueAsString(Map.of(
                    "type", "rag.index.requested",
                    "payload", Map.of(
                            "lessonId", lesson.getId().toString(),
                            "classroomId", lesson.getClassroomId().toString(),
                            "title", lesson.getTitle(),
                            "body", lesson.getBody()))));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        return lesson;
    }

    private void requireTeacher(String role) {
        if (!"TEACHER".equals(role) && !"ADMIN".equals(role)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Teachers only");
        }
    }
}
