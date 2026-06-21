-- Self-hosted in-app update metadata (used by GET /api/v2/app-version)
CREATE TABLE IF NOT EXISTS `app_updates` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `version_name` varchar(32) NOT NULL,
  `build_number` int(11) NOT NULL,
  `apk_url` varchar(512) NOT NULL,
  `is_mandatory` tinyint(1) NOT NULL DEFAULT 0,
  `release_notes` text DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_build_active` (`build_number`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Example: publish version 1.0.1 (build 2) — APK hosted on main website
-- INSERT INTO app_updates (version_name, build_number, apk_url, is_mandatory, release_notes, is_active)
-- VALUES ('1.0.1', 2, 'https://smmtor.com/downloads/smmtor-latest.apk', 0, 'Bug fixes', 1);
