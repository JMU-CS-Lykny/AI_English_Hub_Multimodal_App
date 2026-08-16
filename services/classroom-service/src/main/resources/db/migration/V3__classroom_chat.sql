-- Classroom chatroom: one room per classroom (teacher + enrolled students).

CREATE TABLE chat_messages (
    id              UUID PRIMARY KEY,
    classroom_id    UUID         NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    sender_id       UUID         NOT NULL,
    sender_name     VARCHAR(255) NOT NULL DEFAULT '',
    sender_role     VARCHAR(32)  NOT NULL,
    body            TEXT,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_classroom_created
    ON chat_messages (classroom_id, created_at DESC);

CREATE TABLE chat_attachments (
    id              UUID PRIMARY KEY,
    message_id      UUID         NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    kind            VARCHAR(16)  NOT NULL,
    file_name       VARCHAR(512) NOT NULL,
    mime_type       VARCHAR(128) NOT NULL,
    url_or_data     TEXT         NOT NULL,
    size_bytes      BIGINT
);

CREATE INDEX idx_chat_attachments_message ON chat_attachments (message_id);

CREATE TABLE chat_reactions (
    id              UUID PRIMARY KEY,
    message_id      UUID         NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id         UUID         NOT NULL,
    emoji           VARCHAR(16)  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX idx_chat_reactions_message ON chat_reactions (message_id);
