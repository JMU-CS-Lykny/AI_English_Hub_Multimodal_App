package vn.englishhub.identity.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.servers.Server;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI identityOpenApi(@Value("${app.openapi.server-url:http://localhost:8080}") String serverUrl) {
        final String scheme = "bearerAuth";
        return new OpenAPI()
                .info(new Info()
                        .title("AI English Hub — Identity Service")
                        .description(
                                "Authentication, registration, JWT issue/refresh. "
                                        + "Self-register (email+password) always creates STUDENT; "
                                        + "fullName defaults from email local-part. "
                                        + "TEACHER/ADMIN are seeded or admin-assigned.")
                        .version("v1")
                        .contact(new Contact().name("AI English Hub").email("admin@englishhub.vn")))
                .servers(List.of(new Server().url(serverUrl).description("API Gateway")))
                .components(new Components().addSecuritySchemes(scheme,
                        new SecurityScheme()
                                .name(scheme)
                                .type(SecurityScheme.Type.HTTP)
                                .scheme("bearer")
                                .bearerFormat("JWT")))
                .addSecurityItem(new SecurityRequirement().addList(scheme));
    }
}
