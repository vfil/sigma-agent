CREATE TABLE `inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`text` text NOT NULL
);
