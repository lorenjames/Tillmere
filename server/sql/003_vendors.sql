CREATE TABLE IF NOT EXISTS vendors (
  pk BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(128),
  phone VARCHAR(64),
  email VARCHAR(128),
  active TINYINT(1) DEFAULT 1,
  importKey VARCHAR(64),
  data JSON NOT NULL,
  UNIQUE KEY idx_vendors_code (code),
  KEY idx_vendors_name (name)
);
