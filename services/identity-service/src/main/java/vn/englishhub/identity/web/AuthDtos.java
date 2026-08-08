package vn.englishhub.identity.web;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import vn.englishhub.identity.domain.Role;

public final class AuthDtos {
    private AuthDtos() {}

    /**
     * Public self-registration. Only email + password are required.
     * {@code fullName} / {@code role} are optional for backward compatibility;
     * the service defaults fullName from the email local-part (or "Người dùng")
     * and always assigns {@code STUDENT}. Teachers are seeded or admin-assigned.
     */
    public record RegisterRequest(
            @Email(message = "Email không hợp lệ")
            @NotBlank(message = "Email không được để trống")
            String email,
            @NotBlank(message = "Mật khẩu không được để trống")
            @Size(min = 8, max = 72, message = "Mật khẩu phải từ 8 đến 72 ký tự")
            String password,
            @Size(max = 255, message = "Họ tên tối đa 255 ký tự")
            String fullName,
            Role role,
            String locale) {}

    public record LoginRequest(
            @Email @NotBlank String email,
            @NotBlank String password) {}

    public record RefreshRequest(@NotBlank String refreshToken) {}

    public record UpdateProfileRequest(
            @NotBlank @Size(max = 255) String fullName,
            @Email @NotBlank @Size(max = 255) String email,
            @Size(max = 64) String grade,
            /** Data URL or http(s) URL; null/blank clears avatar. Max ~200KB for data URLs. */
            String avatarUrl) {}

    public record TokenResponse(
            String accessToken,
            String refreshToken,
            String tokenType,
            long expiresInSeconds,
            UserResponse user) {}

    public record UserResponse(
            String id,
            String email,
            String fullName,
            String role,
            String locale,
            String grade,
            String avatarUrl) {}
}
