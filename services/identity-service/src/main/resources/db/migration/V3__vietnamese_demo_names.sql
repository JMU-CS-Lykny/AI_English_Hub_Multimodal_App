-- Ensure demo accounts use proper UTF-8 Vietnamese names (source of truth for JWT /me).
-- Applied after V1 ASCII seeds; also repairs any '?' corruption from header encoding bugs.

UPDATE users
SET full_name = 'Vũ Thị Nhật Linh',
    updated_at = NOW()
WHERE id = '33333333-3333-3333-3333-333333333333'
  AND email = 'student@englishhub.vn'
  AND (
      full_name IS DISTINCT FROM 'Vũ Thị Nhật Linh'
  );

UPDATE users
SET full_name = 'Vũ Thị Bảo Anh',
    updated_at = NOW()
WHERE id = '22222222-2222-2222-2222-222222222222'
  AND email = 'teacher@englishhub.vn'
  AND (
      full_name IN ('Vu Thi Bao Anh', 'V? Th? B?o Anh')
      OR full_name LIKE 'V? Th? B%o Anh'
  );
