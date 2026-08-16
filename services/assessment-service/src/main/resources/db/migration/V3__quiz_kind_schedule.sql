ALTER TABLE quizzes
    ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'PRACTICE',
    ADD COLUMN starts_at TIMESTAMPTZ NULL,
    ADD COLUMN ends_at TIMESTAMPTZ NULL,
    ADD COLUMN duration_minutes INTEGER NULL,
    ADD COLUMN reminder_minutes_before INTEGER NULL,
    ADD COLUMN source_label VARCHAR(255) NULL;

CREATE INDEX idx_quizzes_classroom_kind ON quizzes(classroom_id, kind);
