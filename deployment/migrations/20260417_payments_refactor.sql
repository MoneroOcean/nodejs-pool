ALTER TABLE `balance`
  ADD COLUMN `pending_batch_id` bigint(20) unsigned DEFAULT NULL AFTER `amount`,
  ADD KEY `balance_pending_batch_id_index` (`pending_batch_id`);

CREATE TABLE `payment_batches` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `status` varchar(32) NOT NULL,
  `batch_type` varchar(32) NOT NULL,
  `total_gross` bigint(26) NOT NULL DEFAULT '0',
  `total_net` bigint(26) NOT NULL DEFAULT '0',
  `total_fee` bigint(26) NOT NULL DEFAULT '0',
  `destination_count` int(11) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `submit_started_at` timestamp NULL DEFAULT NULL,
  `submitted_at` timestamp NULL DEFAULT NULL,
  `finalized_at` timestamp NULL DEFAULT NULL,
  `released_at` timestamp NULL DEFAULT NULL,
  `last_reconciled_at` timestamp NULL DEFAULT NULL,
  `reconcile_attempts` int(11) NOT NULL DEFAULT '0',
  `reconcile_clean_passes` int(11) NOT NULL DEFAULT '0',
  `tx_hash` varchar(128) DEFAULT NULL,
  `tx_key` varchar(256) DEFAULT NULL,
  `transaction_id` int(11) DEFAULT NULL,
  `last_error_text` text,
  PRIMARY KEY (`id`),
  KEY `payment_batches_status_created_at_index` (`status`,`created_at`),
  KEY `payment_batches_transaction_id_index` (`transaction_id`),
  KEY `payment_batches_tx_hash_index` (`tx_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `payment_batch_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` bigint(20) unsigned NOT NULL,
  `balance_id` int(11) NOT NULL,
  `destination_order` int(11) NOT NULL,
  `pool_type` varchar(64) DEFAULT NULL,
  `payment_address` varchar(128) DEFAULT NULL,
  `gross_amount` bigint(26) NOT NULL DEFAULT '0',
  `net_amount` bigint(26) NOT NULL DEFAULT '0',
  `fee_amount` bigint(26) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `payment_batch_items_batch_destination_order_uindex` (`batch_id`,`destination_order`),
  UNIQUE KEY `payment_batch_items_batch_balance_id_uindex` (`batch_id`,`balance_id`),
  KEY `payment_batch_items_batch_id_index` (`batch_id`),
  KEY `payment_batch_items_balance_id_index` (`balance_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
