package vn.englishhub.classroom.realtime;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** Per-classroom SSE fan-out for chat message / edit / pin / delete / reaction events. */
@Component
public class ChatSseHub {

    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> emitters = new ConcurrentHashMap<>();

    public SseEmitter subscribe(UUID classroomId) {
        SseEmitter emitter = new SseEmitter(30 * 60 * 1000L);
        emitters.computeIfAbsent(classroomId, id -> new CopyOnWriteArrayList<>()).add(emitter);
        emitter.onCompletion(() -> remove(classroomId, emitter));
        emitter.onTimeout(() -> remove(classroomId, emitter));
        emitter.onError(ex -> remove(classroomId, emitter));
        try {
            emitter.send(SseEmitter.event().name("connected").data(Map.of("ok", true, "classroomId", classroomId.toString())));
        } catch (IOException e) {
            remove(classroomId, emitter);
        }
        return emitter;
    }

    public void publish(UUID classroomId, String eventName, Object data) {
        List<SseEmitter> list = emitters.get(classroomId);
        if (list == null || list.isEmpty()) {
            return;
        }
        for (SseEmitter emitter : list) {
            try {
                emitter.send(SseEmitter.event().name(eventName).data(data));
            } catch (Exception ex) {
                remove(classroomId, emitter);
            }
        }
    }

    private void remove(UUID classroomId, SseEmitter emitter) {
        List<SseEmitter> list = emitters.get(classroomId);
        if (list != null) {
            list.remove(emitter);
        }
    }
}
