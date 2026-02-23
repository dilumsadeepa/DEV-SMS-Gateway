ALTER TABLE users
    ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user' AFTER email,
    ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER role,
    ADD COLUMN updated_at DATETIME(3) NULL AFTER created_at,
    ADD INDEX idx_users_role (role),
    ADD INDEX idx_users_is_active (is_active);

CREATE TABLE IF NOT EXISTS gateway_settings (
    setting_key VARCHAR(120) NOT NULL PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO gateway_settings (setting_key, setting_value, updated_at)
VALUES ('registration_enabled', '1', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
    setting_value = VALUES(setting_value),
    updated_at = VALUES(updated_at);

UPDATE users
SET role = 'super_admin',
    updated_at = UTC_TIMESTAMP(3)
WHERE id = (
    SELECT first_user.id
    FROM (
        SELECT id
        FROM users
        ORDER BY created_at ASC
        LIMIT 1
    ) AS first_user
)
AND NOT EXISTS (
    SELECT 1
    FROM (
        SELECT id
        FROM users
        WHERE role = 'super_admin'
        LIMIT 1
    ) AS existing_super_admin
);
