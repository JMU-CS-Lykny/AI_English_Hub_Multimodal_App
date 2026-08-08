package vn.englishhub.content.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
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
    OpenAPI contentOpenApi(@Value("${app.openapi.server-url:http://localhost:8080}") String serverUrl) {
        final String scheme = "bearerAuth";
        return new OpenAPI()
                .info(new Info()
                        .title("AI English Hub — Content Service")
                        .description("Lessons CRUD and publish events for RAG indexing.")
                        .version("v1"))
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
