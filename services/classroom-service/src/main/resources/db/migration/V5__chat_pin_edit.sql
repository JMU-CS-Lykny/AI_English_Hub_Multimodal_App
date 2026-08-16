-- Pin + edit metadata for classroom chat messages.

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_messages_classroom_pinned
    ON chat_messages (classroom_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;
