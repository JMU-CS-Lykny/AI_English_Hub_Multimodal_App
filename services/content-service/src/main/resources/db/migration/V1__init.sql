CREATE TABLE lessons (
    id              UUID PRIMARY KEY,
    classroom_id    UUID         NOT NULL,
    title           VARCHAR(255) NOT NULL,
    body            TEXT         NOT NULL,
    cefr_level      VARCHAR(8)   NOT NULL DEFAULT 'A1',
    status          VARCHAR(32)  NOT NULL DEFAULT 'DRAFT',
    created_by      UUID         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ
);

CREATE INDEX idx_lessons_classroom ON lessons(classroom_id);
