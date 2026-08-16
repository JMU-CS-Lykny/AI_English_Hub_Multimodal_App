package vn.englishhub.classroom.web;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Decodes gateway {@code X-User-*} headers that carry UTF-8 via Base64URL.
 * Plain (legacy ASCII) values are returned unchanged for backward compatibility.
 */
public final class UserHeaderEncoding {

    public static final String PREFIX = "utf8b64:";

    private UserHeaderEncoding() {}

    public static String decode(String headerValue) {
        if (headerValue == null || headerValue.isBlank()) {
            return "";
        }
        String v = headerValue.trim();
        if (!v.startsWith(PREFIX)) {
            return v;
        }
        try {
            byte[] raw = Base64.getUrlDecoder().decode(v.substring(PREFIX.length()));
            return new String(raw, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            return v;
        }
    }
}
