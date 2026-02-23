CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(191) NOT NULL UNIQUE,
    password_salt VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX idx_sessions_user_id (user_id),
    INDEX idx_sessions_expires_at (expires_at),
    CONSTRAINT fk_sessions_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environments (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL,
    pin VARCHAR(64) NOT NULL UNIQUE,
    description TEXT NULL,
    metadata JSON NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_environments_user_id (user_id),
    CONSTRAINT fk_environments_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
    id CHAR(36) NOT NULL PRIMARY KEY,
    environment_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL,
    key_hash CHAR(64) NOT NULL UNIQUE,
    key_preview VARCHAR(64) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    last_used_at DATETIME(3) NULL,
    revoked_at DATETIME(3) NULL,
    INDEX idx_api_keys_environment_id (environment_id),
    INDEX idx_api_keys_user_id (user_id),
    INDEX idx_api_keys_active (is_active),
    CONSTRAINT fk_api_keys_environment_id
        FOREIGN KEY (environment_id) REFERENCES environments(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_api_keys_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
