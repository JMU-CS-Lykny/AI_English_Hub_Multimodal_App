package vn.englishhub.assessment.client;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class ClassroomClient {
    private static final Logger log = LoggerFactory.getLogger(ClassroomClient.class);

    private final RestClient restClient;

    public ClassroomClient(
            RestClient.Builder builder,
            @Value("${app.classroom-service-url:http://localhost:8082}") String baseUrl) {
        this.restClient = builder.baseUrl(baseUrl).build();
    }

    /**
     * Fetch enrolled student IDs for a classroom (teacher-authenticated).
     * Returns empty list on failure so publish still succeeds.
     */
    public List<UUID> listStudentIds(UUID classroomId, UUID teacherId, String role) {
        try {
            List<Map<String, Object>> members = restClient.get()
                    .uri("/api/v1/classrooms/{id}/members", classroomId)
                    .header("X-User-Id", teacherId.toString())
                    .header("X-User-Role", role == null ? "TEACHER" : role)
                    .accept(MediaType.APPLICATION_JSON)
                    .retrieve()
                    .body(new ParameterizedTypeReference<>() {});
            if (members == null || members.isEmpty()) {
                return List.of();
            }
            List<UUID> ids = new ArrayList<>();
            for (Map<String, Object> m : members) {
                Object sid = m.get("studentId");
                if (sid != null && !String.valueOf(sid).isBlank()) {
                    ids.add(UUID.fromString(String.valueOf(sid)));
                }
            }
            return ids;
        } catch (RestClientException | IllegalArgumentException ex) {
            log.warn("Failed to load classroom members for {}: {}", classroomId, ex.getMessage());
            return List.of();
        }
    }
}
