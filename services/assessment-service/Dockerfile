# syntax=docker/dockerfile:1
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
COPY gateway/pom.xml gateway/pom.xml
COPY services/identity-service/pom.xml services/identity-service/pom.xml
COPY services/classroom-service/pom.xml services/classroom-service/pom.xml
COPY services/content-service/pom.xml services/content-service/pom.xml
COPY services/assessment-service/pom.xml services/assessment-service/pom.xml
COPY services/notification-service/pom.xml services/notification-service/pom.xml
COPY services/assessment-service services/assessment-service
RUN mvn -q -pl services/assessment-service -am -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/services/assessment-service/target/assessment-service-*.jar app.jar
EXPOSE 8084
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
