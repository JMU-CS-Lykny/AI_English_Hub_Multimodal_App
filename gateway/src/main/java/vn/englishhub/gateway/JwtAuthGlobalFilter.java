package vn.englishhub.gateway;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.crypto.SecretKey;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class JwtAuthGlobalFilter implements GlobalFilter, Ordered {

    private final SecretKey key;
    private final String issuer;
    private final List<String> publicExactPaths = List.of(
            "/api/v1/auth/login",
            "/api/v1/auth/register",
            "/api/v1/auth/refresh");

    private final List<String> publicPrefixes = List.of(
            "/actuator/",
            "/swagger-ui",
            "/v3/api-docs",
            "/webjars/",
            "/docs-json/",
            "/swagger/",
            "/favicon.ico");

    public JwtAuthGlobalFilter(
            @Value("${app.jwt.secret}") String secret,
            @Value("${app.jwt.issuer}") String issuer) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.issuer = issuer;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        String path = request.getURI().getPath();

        if (request.getMethod() == HttpMethod.OPTIONS || isPublic(path)) {
            return chain.filter(exchange);
        }

        String token = extractToken(request);
        if (token == null) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }

        try {
            Claims claims = Jwts.parser()
                    .verifyWith(key)
                    .requireIssuer(issuer)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();

            // X-User-Name must be ASCII-safe: raw UTF-8 Vietnamese becomes "?" in servlet headers.
            ServerHttpRequest mutated = request.mutate()
                    .header("X-User-Id", claims.getSubject())
                    .header("X-User-Email", String.valueOf(claims.get("email")))
                    .header("X-User-Role", String.valueOf(claims.get("role")))
                    .header("X-User-Name", UserHeaderEncoding.encode(String.valueOf(claims.get("name"))))
                    .build();
            return chain.filter(exchange.mutate().request(mutated).build());
        } catch (Exception ex) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }
    }

    private String extractToken(ServerHttpRequest request) {
        String auth = request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (auth != null && auth.startsWith("Bearer ")) {
            return auth.substring(7);
        }
        // EventSource cannot set Authorization header — allow query token for SSE
        String path = request.getURI().getPath();
        if (path.startsWith("/api/v1/notifications/stream") || isClassroomChatStream(path)) {
            String q = request.getQueryParams().getFirst("access_token");
            if (q != null && !q.isBlank()) {
                return q;
            }
        }
        return null;
    }

    /** Matches /api/v1/classrooms/{id}/chat/stream */
    private boolean isClassroomChatStream(String path) {
        return path != null && path.matches("^/api/v1/classrooms/[^/]+/chat/stream$");
    }

    private boolean isPublic(String path) {
        return publicExactPaths.contains(path)
                || publicPrefixes.stream().anyMatch(path::startsWith)
                || path.equals("/swagger-ui.html")
                || path.equals("/");
    }

    @Override
    public int getOrder() {
        return -100;
    }
}
