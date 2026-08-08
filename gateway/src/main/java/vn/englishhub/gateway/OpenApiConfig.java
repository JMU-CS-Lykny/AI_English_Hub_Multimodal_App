package vn.englishhub.gateway;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.servers.Server;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI gatewayOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("AI English Hub — API Gateway")
                        .description("""
                                Unified Swagger hub for all microservices.

                                Use the **Select a definition** dropdown (top-right) to switch between:
                                Identity, Classroom, Content, Assessment, AI Orchestration, AI RAG, AI Multimodal.

                                1. Open **identity** → `POST /api/v1/auth/login`
                                2. Copy `accessToken`
                                3. Click **Authorize** → paste token (Bearer)
                                4. Call protected APIs from any definition
                                """)
                        .version("v1"))
                .servers(List.of(new Server().url("http://localhost:8080").description("API Gateway")));
    }
}
