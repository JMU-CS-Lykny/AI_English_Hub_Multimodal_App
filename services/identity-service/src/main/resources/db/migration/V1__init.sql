-- identity schema
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(255) NOT NULL,
    role            VARCHAR(32)  NOT NULL,
    locale          VARCHAR(16)  NOT NULL DEFAULT 'vi',
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY,
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(128) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ  NOT NULL,
    revoked         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Seed demo accounts (password for all: Password123!)
INSERT INTO users (id, email, password_hash, full_name, role, locale) VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin@englishhub.vn',
   '$2b$10$BMgDpgR7jKa1mvxRcsmfLuRd0a/V6B.x3nhIanNcRzn/jN4xhv7iS', 'System Admin', 'ADMIN', 'vi'),
  ('22222222-2222-2222-2222-222222222222', 'teacher@englishhub.vn',
   '$2b$10$BMgDpgR7jKa1mvxRcsmfLuRd0a/V6B.x3nhIanNcRzn/jN4xhv7iS', 'Vu Thi Bao Anh', 'TEACHER', 'vi'),
  ('33333333-3333-3333-3333-333333333333', 'student@englishhub.vn',
   '$2b$10$BMgDpgR7jKa1mvxRcsmfLuRd0a/V6B.x3nhIanNcRzn/jN4xhv7iS', 'Vu Thi Nhat Linh', 'STUDENT', 'vi');