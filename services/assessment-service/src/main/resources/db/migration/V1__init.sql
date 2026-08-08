CREATE TABLE quizzes (
    id              UUID PRIMARY KEY,
    classroom_id    UUID         NOT NULL,
    title           VARCHAR(255) NOT NULL,
    questions_json  TEXT         NOT NULL,
    created_by      UUID         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE quiz_attempts (
    id              UUID PRIMARY KEY,
    quiz_id         UUID         NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    student_id      UUID         NOT NULL,
    answers_json    TEXT         NOT NULL,
    score           INTEGER      NOT NULL,
    max_score       INTEGER      NOT NULL,
    submitted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_quizzes_classroom ON quizzes(classroom_id);
CREATE INDEX idx_attempts_student ON quiz_attempts(student_id);
