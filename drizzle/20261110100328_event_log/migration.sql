CREATE TABLE `event` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `event_pk` PRIMARY KEY(`session_id`, `seq`)
);
