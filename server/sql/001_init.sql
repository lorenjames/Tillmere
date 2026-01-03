CREATE TABLE IF NOT EXISTS receipts (
  id VARCHAR(64) PRIMARY KEY,
  number VARCHAR(64),
  datetime DATETIME,
  cashier VARCHAR(128),
  payment VARCHAR(64),
  subtotal DECIMAL(10,2),
  tax DECIMAL(10,2),
  total DECIMAL(10,2),
  voided TINYINT(1) DEFAULT 0,
  returned TINYINT(1) DEFAULT 0,
  createdAt DATETIME,
  updatedAt DATETIME,
  data JSON NOT NULL,
  KEY idx_receipts_datetime (datetime),
  KEY idx_receipts_cashier (cashier),
  KEY idx_receipts_payment (payment),
  KEY idx_receipts_number (number)
);
