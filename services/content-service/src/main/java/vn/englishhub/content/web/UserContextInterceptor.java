package vn.englishhub.content.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;

public class UserContextInterceptor implements HandlerInterceptor {
    public static final String ATTR_USER_ID = "userId";
    public static final String ATTR_ROLE = "userRole";

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())
                || request.getRequestURI().startsWith("/actuator")
                || request.getRequestURI().startsWith("/v3/api-docs")
                || request.getRequestURI().startsWith("/swagger-ui")
                || request.getRequestURI().startsWith("/webjars")) {
            return true;
        }
        String userId = request.getHeader("X-User-Id");
        String role = request.getHeader("X-User-Role");
        if (userId == null || role == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Missing user context from gateway");
        }
        request.setAttribute(ATTR_USER_ID, UUID.fromString(userId));
        request.setAttribute(ATTR_ROLE, role);
        return true;
    }
}
