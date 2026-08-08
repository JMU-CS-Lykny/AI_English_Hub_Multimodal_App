CREATE TABLE join_requests (
    id              UUID PRIMARY KEY,
    classroom_id    UUID         NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    student_id      UUID         NOT NULL,
    student_name    VARCHAR(255) NOT NULL DEFAULT '',
    student_email   VARCHAR(255) NOT NULL DEFAULT '',
    status          VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
    message         TEXT,
    reject_reason   TEXT,
    decided_by      UUID,
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_join_pending
    ON join_requests (classroom_id, student_id)
    WHERE status = 'PENDING';

CREATE INDEX idx_join_classroom_status ON join_requests(classroom_id, status);
CREATE INDEX idx_join_student ON join_requests(student_id);
