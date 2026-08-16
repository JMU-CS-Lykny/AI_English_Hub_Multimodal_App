package vn.englishhub.notification.service;

import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * MVP in-memory delayed executor for exam reminders.
 * Lost on process restart — acceptable for current scope.
 */
@Component
public class ExamReminderScheduler {

    private static final Logger log = LoggerFactory.getLogger(ExamReminderScheduler.class);

    private final NotificationAppService notifications;
    private final ScheduledExecutorService executor =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "exam-reminder");
                t.setDaemon(true);
                return t;
            });

    public ExamReminderScheduler(NotificationAppService notifications) {
        this.notifications = notifications;
    }

    public void schedule(
            List<UUID> studentIds,
            UUID quizId,
            Instant remindAt,
            String title,
            String body,
            Map<String, Object> payload) {
        if (studentIds == null || studentIds.isEmpty() || remindAt == null) {
            return;
        }
        long delayMs = Duration.between(Instant.now(), remindAt).toMillis();
        if (delayMs <= 0) {
            log.info("Exam reminder for quiz {} is due now (or past); sending immediately", quizId);
            deliver(studentIds, quizId, title, body, payload);
            return;
        }
        log.info("Scheduling exam reminder for quiz {} in {} ms (at {})", quizId, delayMs, remindAt);
        executor.schedule(
                () -> deliver(studentIds, quizId, title, body, payload),
                delayMs,
                TimeUnit.MILLISECONDS);
    }

    private void deliver(
            List<UUID> studentIds,
            UUID quizId,
            String title,
            String body,
            Map<String, Object> payload) {
        try {
            for (UUID studentId : studentIds) {
                notifications.create(
                        studentId,
                        "EXAM_REMINDER",
                        title,
                        body,
                        payload,
                        "quiz",
                        quizId);
            }
        } catch (Exception ex) {
            log.error("Failed to deliver delayed exam reminder for quiz {}", quizId, ex);
        }
    }

    @PreDestroy
    public void shutdown() {
        executor.shutdownNow();
    }
}
