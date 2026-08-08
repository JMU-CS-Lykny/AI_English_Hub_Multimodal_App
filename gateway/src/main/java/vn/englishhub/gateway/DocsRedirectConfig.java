package vn.englishhub.gateway;

import java.net.URI;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

@Configuration
public class DocsRedirectConfig {

    @Bean
    RouterFunction<ServerResponse> docsRedirect() {
        return RouterFunctions.route()
                .GET("/", req -> ServerResponse.temporaryRedirect(URI.create("/swagger-ui.html")).build())
                .GET("/docs", req -> ServerResponse.temporaryRedirect(URI.create("/swagger-ui.html")).build())
                .GET("/swagger", req -> ServerResponse.status(HttpStatus.FOUND)
                        .location(URI.create("/swagger-ui.html"))
                        .build())
                .build();
    }
}
