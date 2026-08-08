-- Profile fields for account editing
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS grade VARCHAR(64),
    ADD COLUMN IF NOT EXISTS avatar_url TEXT;
