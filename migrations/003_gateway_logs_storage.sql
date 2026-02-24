CREATE TABLE IF NOT EXISTS gateway_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    log_hash CHAR(64) NOT NULL UNIQUE,
    log_type VARCHAR(80) NOT NULL,
    pin VARCHAR(64) NULL,
    mobile_number VARCHAR(191) NULL,
    content_text TEXT NULL,
    request_id VARCHAR(120) NULL,
    device_id VARCHAR(191) NULL,
    environment_id CHAR(36) NULL,
    user_id CHAR(36) NULL,
    payload JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    saved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_gateway_logs_occurred_at (occurred_at),
    INDEX idx_gateway_logs_log_type (log_type),
    INDEX idx_gateway_logs_pin (pin),
    INDEX idx_gateway_logs_mobile_number (mobile_number),
    INDEX idx_gateway_logs_user_id (user_id),
    INDEX idx_gateway_logs_request_id (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO gateway_settings (setting_key, setting_value, updated_at)
VALUES ('log_retention_days', '2', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
    setting_value = VALUES(setting_value),
    updated_at = VALUES(updated_at);
