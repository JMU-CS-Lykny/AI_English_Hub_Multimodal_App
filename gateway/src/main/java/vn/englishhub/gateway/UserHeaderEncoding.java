package vn.englishhub.gateway;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * HTTP headers are historically ISO-8859-1. Putting raw UTF-8 (e.g. Vietnamese names)
 * into {@code X-User-Name} causes servlet containers to replace non-Latin-1 code points
 * with {@code ?}. Encode as ASCII-safe Base64URL with an explicit prefix.
 */
public final class UserHeaderEncoding {

    public static final String PREFIX = "utf8b64:";

    private UserHeaderEncoding() {}

    public static String encode(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        return PREFIX
                + Base64.getUrlEncoder()
                        .withoutPadding()
                        .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
