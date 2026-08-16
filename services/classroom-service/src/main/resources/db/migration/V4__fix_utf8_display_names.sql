-- Repair display names corrupted when X-User-Name carried raw UTF-8 through ISO-8859-1 headers
-- (Vietnamese diacritics replaced with '?'). Demo student id is fixed; pattern covers other cases.

UPDATE chat_messages
SET sender_name = 'Vũ Thị Nhật Linh'
WHERE sender_id = '33333333-3333-3333-3333-333333333333'
  AND (sender_name LIKE '%?%' OR sender_name IN ('Vu Thi Nhat Linh', 'Minh Student'));

UPDATE join_requests
SET student_name = 'Vũ Thị Nhật Linh'
WHERE student_id = '33333333-3333-3333-3333-333333333333'
  AND (student_name LIKE '%?%' OR student_name IN ('Vu Thi Nhat Linh', 'Minh Student'));
