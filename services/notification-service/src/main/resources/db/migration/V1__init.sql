CREATE TABLE notifications (
    id              UUID PRIMARY KEY,
    user_id         UUID         NOT NULL,
    type            VARCHAR(64)  NOT NULL,
    title           VARCHAR(255) NOT NULL,
    body            TEXT         NOT NULL,
    payload_json    TEXT,
    ref_type        VARCHAR(64),
    ref_id          UUID,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
