ALTER TABLE quizzes
    ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'DRAFT';

CREATE INDEX idx_quizzes_classroom_status ON quizzes(classroom_id, status);
