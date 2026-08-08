package vn.englishhub.identity.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.englishhub.identity.domain.RefreshToken;
import vn.englishhub.identity.domain.Role;
import vn.englishhub.identity.domain.UserAccount;
import vn.englishhub.identity.repo.RefreshTokenRepository;
import vn.englishhub.identity.repo.UserAccountRepository;
import vn.englishhub.identity.security.JwtService;
import vn.englishhub.identity.web.AuthDtos;

@Service
public class AuthService {

    private final UserAccountRepository users;
    private final RefreshTokenRepository refreshTokens;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final StringRedisTemplate redis;
    private final long accessTtlMinutes;
    private final long refreshTtlDays;

    public AuthService(
            UserAccountRepository users,
            RefreshTokenRepository refreshTokens,
            PasswordEncoder passwordEncoder,
            JwtService jwtService,
            StringRedisTemplate redis,
            @Value("${app.jwt.access-ttl-minutes}") long accessTtlMinutes,
            @Value("${app.jwt.refresh-ttl-days}") long refreshTtlDays) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.redis = redis;
        this.accessTtlMinutes = accessTtlMinutes;
        this.refreshTtlDays = refreshTtlDays;
    }

    @Transactional
    public AuthDtos.TokenResponse register(AuthDtos.RegisterRequest req) {
        if (users.existsByEmailIgnoreCase(req.email())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Email đã được đăng ký");
        }
        // Self-register always creates STUDENT. Teachers/ADMIN are seeded or admin-assigned.
        if (req.role() == Role.ADMIN || req.role() == Role.TEACHER) {
            throw new ResponseStatusException(
                    HttpStatus.FORBIDDEN,
                    "Không thể tự đăng ký với vai trò này. Liên hệ quản trị viên.");
        }

        String email = req.email().trim().toLowerCase();
        UserAccount user = new UserAccount();
        user.setId(UUID.randomUUID());
        user.setEmail(email);
        user.setPasswordHash(passwordEncoder.encode(req.password()));
        user.setFullName(resolveFullName(email, req.fullName()));
        user.setRole(Role.STUDENT);
        user.setLocale(req.locale() == null || req.locale().isBlank() ? "vi" : req.locale());
        users.save(user);
        return issueTokens(user);
    }

    /** Prefer provided fullName; else email local-part; else "Người dùng". */
    static String resolveFullName(String email, String fullName) {
        if (fullName != null && !fullName.isBlank()) {
            return fullName.trim();
        }
        if (email != null) {
            int at = email.indexOf('@');
            String local = (at > 0 ? email.substring(0, at) : email).trim();
            if (!local.isEmpty()) {
                return local;
            }
        }
        return "Người dùng";
    }

    @Transactional
    public AuthDtos.TokenResponse login(AuthDtos.LoginRequest req) {
        UserAccount user = users.findByEmailIgnoreCase(req.email().trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials"));
        if (!user.isActive() || !passwordEncoder.matches(req.password(), user.getPasswordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
        }
        return issueTokens(user);
    }

    @Transactional
    public AuthDtos.TokenResponse refresh(AuthDtos.RefreshRequest req) {
        String hash = sha256(req.refreshToken());
        RefreshToken stored = refreshTokens.findByTokenHashAndRevokedFalse(hash)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid refresh token"));
        if (stored.getExpiresAt().isBefore(Instant.now())) {
            stored.setRevoked(true);
            refreshTokens.save(stored);
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Refresh token expired");
        }
        stored.setRevoked(true);
        refreshTokens.save(stored);
        redis.delete("refresh:" + hash);

        UserAccount user = users.findById(stored.getUserId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not found"));
        return issueTokens(user);
    }

    @Transactional(readOnly = true)
    public AuthDtos.UserResponse me(UUID userId) {
        UserAccount user = users.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        return toUser(user);
    }

    @Transactional
    public AuthDtos.UserResponse updateProfile(UUID userId, AuthDtos.UpdateProfileRequest req) {
        UserAccount user = users.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

        String email = req.email().trim().toLowerCase();
        if (!email.equalsIgnoreCase(user.getEmail()) && users.existsByEmailIgnoreCase(email)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Email already registered");
        }

        String avatarUrl = normalizeAvatarUrl(req.avatarUrl());

        user.setFullName(req.fullName().trim());
        user.setEmail(email);
        user.setGrade(normalizeGrade(req.grade()));
        user.setAvatarUrl(avatarUrl);
        user.setUpdatedAt(Instant.now());
        users.save(user);
        return toUser(user);
    }

    /** ~200KB payload cap for data-URL avatars (demo). */
    private static final int MAX_AVATAR_CHARS = 280_000;

    private static String normalizeGrade(String grade) {
        if (grade == null) return null;
        String trimmed = grade.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String normalizeAvatarUrl(String avatarUrl) {
        if (avatarUrl == null) return null;
        String trimmed = avatarUrl.trim();
        if (trimmed.isEmpty()) return null;
        if (trimmed.length() > MAX_AVATAR_CHARS) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Avatar too large (max ~200KB)");
        }
        boolean ok = trimmed.startsWith("data:image/")
                || trimmed.startsWith("http://")
                || trimmed.startsWith("https://");
        if (!ok) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Avatar must be an image data URL or http(s) URL");
        }
        return trimmed;
    }

    private AuthDtos.TokenResponse issueTokens(UserAccount user) {
        String access = jwtService.createAccessToken(user);
        String refreshRaw = UUID.randomUUID() + "." + UUID.randomUUID();
        String hash = sha256(refreshRaw);

        RefreshToken rt = new RefreshToken();
        rt.setId(UUID.randomUUID());
        rt.setUserId(user.getId());
        rt.setTokenHash(hash);
        rt.setExpiresAt(Instant.now().plus(refreshTtlDays, ChronoUnit.DAYS));
        refreshTokens.save(rt);
        redis.opsForValue().set("refresh:" + hash, user.getId().toString());

        return new AuthDtos.TokenResponse(
                access,
                refreshRaw,
                "Bearer",
                accessTtlMinutes * 60,
                toUser(user));
    }

    public static AuthDtos.UserResponse toUser(UserAccount user) {
        return new AuthDtos.UserResponse(
                user.getId().toString(),
                user.getEmail(),
                user.getFullName(),
                user.getRole().name(),
                user.getLocale(),
                user.getGrade(),
                user.getAvatarUrl());
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashed);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
