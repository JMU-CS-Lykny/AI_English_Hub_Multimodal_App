CREATE TABLE classrooms (
    id              UUID PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    teacher_id      UUID         NOT NULL,
    invite_code     VARCHAR(16)  NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE classroom_members (
    id              UUID PRIMARY KEY,
    classroom_id    UUID         NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    student_id      UUID         NOT NULL,
    joined_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (classroom_id, student_id)
);

CREATE INDEX idx_classroom_teacher ON classrooms(teacher_id);
CREATE INDEX idx_members_student ON classroom_members(student_id);
