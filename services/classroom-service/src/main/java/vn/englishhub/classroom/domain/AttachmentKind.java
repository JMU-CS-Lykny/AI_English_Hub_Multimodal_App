package vn.englishhub.classroom.domain;

public enum AttachmentKind {
    IMAGE,
    VIDEO,
    FILE;

    public static AttachmentKind fromApi(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Attachment kind required");
        }
        return AttachmentKind.valueOf(value.trim().toUpperCase());
    }

    public String toApi() {
        return name().toLowerCase();
    }
}
