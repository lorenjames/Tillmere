CREATE TABLE IF NOT EXISTS giftcard_books (
  id VARCHAR(64) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  prefix VARCHAR(32) DEFAULT '',
  start_num INT NOT NULL,
  end_num INT NOT NULL,
  pad INT NOT NULL,
  created_at DATETIME NOT NULL,
  count INT NOT NULL
);

CREATE TABLE IF NOT EXISTS giftcards (
  number VARCHAR(64) PRIMARY KEY,
  book_id VARCHAR(64),
  status VARCHAR(16) NOT NULL,
  balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  initial_value DECIMAL(10,2) NOT NULL DEFAULT 0,
  sold_at DATETIME NULL,
  sold_by VARCHAR(255) DEFAULT '',
  sold_receipt VARCHAR(255) DEFAULT '',
  note TEXT,
  KEY idx_giftcards_book (book_id)
);

CREATE TABLE IF NOT EXISTS giftcard_transactions (
  id VARCHAR(64) PRIMARY KEY,
  number VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  cashier VARCHAR(255) DEFAULT '',
  receipt_number VARCHAR(255) DEFAULT '',
  note TEXT,
  created_at DATETIME NOT NULL,
  KEY idx_giftcard_transactions_number (number)
);
