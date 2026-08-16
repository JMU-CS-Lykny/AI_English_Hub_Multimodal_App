package vn.englishhub.assessment.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "quizzes")
public class Quiz {
    @Id
    private UUID id;
    @Column(name = "classroom_id", nullable = false)
    private UUID classroomId;
    @Column(nullable = false)
    private String title;
    @Column(name = "questions_json", nullable = false, columnDefinition = "TEXT")
    private String questionsJson;
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private QuizStatus status = QuizStatus.DRAFT;
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private QuizKind kind = QuizKind.PRACTICE;
    @Column(name = "starts_at")
    private Instant startsAt;
    @Column(name = "ends_at")
    private Instant endsAt;
    @Column(name = "duration_minutes")
    private Integer durationMinutes;
    @Column(name = "reminder_minutes_before")
    private Integer reminderMinutesBefore;
    @Column(name = "source_label", length = 255)
    private String sourceLabel;
    @Column(name = "created_by", nullable = false)
    private UUID createdBy;
    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getClassroomId() { return classroomId; }
    public void setClassroomId(UUID classroomId) { this.classroomId = classroomId; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getQuestionsJson() { return questionsJson; }
    public void setQuestionsJson(String questionsJson) { this.questionsJson = questionsJson; }
    public QuizStatus getStatus() { return status; }
    public void setStatus(QuizStatus status) { this.status = status; }
    public QuizKind getKind() { return kind; }
    public void setKind(QuizKind kind) { this.kind = kind; }
    public Instant getStartsAt() { return startsAt; }
    public void setStartsAt(Instant startsAt) { this.startsAt = startsAt; }
    public Instant getEndsAt() { return endsAt; }
    public void setEndsAt(Instant endsAt) { this.endsAt = endsAt; }
    public Integer getDurationMinutes() { return durationMinutes; }
    public void setDurationMinutes(Integer durationMinutes) { this.durationMinutes = durationMinutes; }
    public Integer getReminderMinutesBefore() { return reminderMinutesBefore; }
    public void setReminderMinutesBefore(Integer reminderMinutesBefore) {
        this.reminderMinutesBefore = reminderMinutesBefore;
    }
    public String getSourceLabel() { return sourceLabel; }
    public void setSourceLabel(String sourceLabel) { this.sourceLabel = sourceLabel; }
    public UUID getCreatedBy() { return createdBy; }
    public void setCreatedBy(UUID createdBy) { this.createdBy = createdBy; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
