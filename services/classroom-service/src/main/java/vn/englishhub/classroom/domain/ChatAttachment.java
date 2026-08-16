package vn.englishhub.classroom.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "chat_attachments")
public class ChatAttachment {
    @Id
    private UUID id;

    @Column(name = "message_id", nullable = false)
    private UUID messageId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private AttachmentKind kind;

    @Column(name = "file_name", nullable = false, length = 512)
    private String fileName;

    @Column(name = "mime_type", nullable = false, length = 128)
    private String mimeType;

    @Column(name = "url_or_data", nullable = false, columnDefinition = "TEXT")
    private String urlOrData;

    @Column(name = "size_bytes")
    private Long sizeBytes;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getMessageId() {
        return messageId;
    }

    public void setMessageId(UUID messageId) {
        this.messageId = messageId;
    }

    public AttachmentKind getKind() {
        return kind;
    }

    public void setKind(AttachmentKind kind) {
        this.kind = kind;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getMimeType() {
        return mimeType;
    }

    public void setMimeType(String mimeType) {
        this.mimeType = mimeType;
    }

    public String getUrlOrData() {
        return urlOrData;
    }

    public void setUrlOrData(String urlOrData) {
        this.urlOrData = urlOrData;
    }

    public Long getSizeBytes() {
        return sizeBytes;
    }

    public void setSizeBytes(Long sizeBytes) {
        this.sizeBytes = sizeBytes;
    }
}
