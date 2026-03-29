<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Persists storefront chat sessions and messages in custom tables.
 */
final class Chat_Store
{
    public const DB_VERSION = '1';

    public static function table_sessions(): string
    {
        global $wpdb;

        return $wpdb->prefix . 'ai_ebot_chat_sessions';
    }

    public static function table_messages(): string
    {
        global $wpdb;

        return $wpdb->prefix . 'ai_ebot_chat_messages';
    }

    public static function activate(): void
    {
        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset_collate = $wpdb->get_charset_collate();
        $sessions = self::table_sessions();
        $messages = self::table_messages();

        $sql_sessions = "CREATE TABLE {$sessions} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            public_id char(36) NOT NULL,
            user_id bigint(20) unsigned NULL,
            ip_hash char(64) NULL,
            created_at datetime NOT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY public_id (public_id),
            KEY user_id (user_id),
            KEY updated_at (updated_at)
        ) {$charset_collate};";

        $sql_messages = "CREATE TABLE {$messages} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            session_id bigint(20) unsigned NOT NULL,
            role varchar(20) NOT NULL,
            content longtext NOT NULL,
            created_at datetime NOT NULL,
            PRIMARY KEY (id),
            KEY session_id (session_id)
        ) {$charset_collate};";

        dbDelta($sql_sessions);
        dbDelta($sql_messages);

        update_option('ai_ebot_db_version', self::DB_VERSION);
    }

    public static function maybe_install(): void
    {
        if (get_option('ai_ebot_db_version') === self::DB_VERSION) {
            return;
        }
        self::activate();
    }

    public static function is_valid_public_id(string $id): bool
    {
        return $id !== '' && (bool) preg_match('/^[a-f0-9-]{36}$/i', $id);
    }

    /**
     * @return object{id: int, public_id: string, user_id: int|null, ip_hash: string|null, created_at: string, updated_at: string}|null
     */
    public static function find_by_public_id(string $public_id)
    {
        global $wpdb;
        if (! self::is_valid_public_id($public_id)) {
            return null;
        }
        $table = self::table_sessions();
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name escaped
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$table} WHERE public_id = %s LIMIT 1", $public_id)
        );

        return $row ?: null;
    }

    /**
     * @return object{id: int, public_id: string, user_id: int|null, ip_hash: string|null, created_at: string, updated_at: string}|null
     */
    public static function find_by_id(int $id)
    {
        global $wpdb;
        $table = self::table_sessions();
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d LIMIT 1", $id));

        return $row ?: null;
    }

    /**
     * @return array{id: int, public_id: string}
     */
    public static function create_session(?int $user_id, ?string $ip_hash): array
    {
        global $wpdb;
        $now = current_time('mysql');
        $public_id = self::generate_public_id();
        $table = self::table_sessions();

        $data = [
            'public_id' => $public_id,
            'created_at' => $now,
            'updated_at' => $now,
        ];
        $format = ['%s', '%s', '%s'];
        if ($user_id !== null && $user_id > 0) {
            $data['user_id'] = $user_id;
            $format[] = '%d';
        }
        if ($ip_hash !== null && $ip_hash !== '') {
            $data['ip_hash'] = $ip_hash;
            $format[] = '%s';
        }

        $wpdb->insert($table, $data, $format);

        $id = (int) $wpdb->insert_id;

        return ['id' => $id, 'public_id' => $public_id];
    }

    public static function touch_session(int $session_id): void
    {
        global $wpdb;
        $wpdb->update(
            self::table_sessions(),
            ['updated_at' => current_time('mysql')],
            ['id' => $session_id],
            ['%s'],
            ['%d']
        );
    }

    public static function append_message(int $session_id, string $role, string $content): void
    {
        global $wpdb;
        $role = $role === 'assistant' ? 'assistant' : 'user';
        $wpdb->insert(
            self::table_messages(),
            [
                'session_id' => $session_id,
                'role' => $role,
                'content' => $content,
                'created_at' => current_time('mysql'),
            ],
            ['%d', '%s', '%s', '%s']
        );
        self::touch_session($session_id);
    }

    public static function count_sessions(): int
    {
        global $wpdb;
        $table = self::table_sessions();
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        return (int) $wpdb->get_var("SELECT COUNT(*) FROM {$table}");
    }

    /**
     * @return list<object>
     */
    public static function list_sessions(int $offset, int $limit): array
    {
        global $wpdb;
        $ts = self::table_sessions();
        $tm = self::table_messages();
        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table names from prefix
        $sql = "SELECT s.*, (SELECT COUNT(*) FROM `{$tm}` m WHERE m.session_id = s.id) AS message_count
                FROM `{$ts}` s
                ORDER BY s.updated_at DESC
                LIMIT %d OFFSET %d";
        $rows = $wpdb->get_results($wpdb->prepare($sql, $limit, $offset));
        // phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

        return is_array($rows) ? $rows : [];
    }

    /**
     * @param int|null $limit Max rows (1–500) for storefront history; null = no cap (admin / privacy export).
     *
     * @return list<object{id: int, session_id: int, role: string, content: string, created_at: string}>
     */
    public static function get_messages(int $session_id, ?int $limit = null): array
    {
        global $wpdb;
        $table = self::table_messages();
        if ($limit === null) {
            $rows = $wpdb->get_results(
                $wpdb->prepare(
                    "SELECT id, session_id, role, content, created_at FROM {$table} WHERE session_id = %d ORDER BY id ASC",
                    $session_id
                )
            );
        } else {
            $cap = max(1, min(500, $limit));
            $rows = $wpdb->get_results(
                $wpdb->prepare(
                    "SELECT id, session_id, role, content, created_at FROM {$table} WHERE session_id = %d ORDER BY id ASC LIMIT %d",
                    $session_id,
                    $cap
                )
            );
        }

        return is_array($rows) ? $rows : [];
    }

    /**
     * Delete all chat messages and sessions associated with a WordPress user (for privacy erasure).
     *
     * @return int Number of sessions removed
     */
    public static function erase_all_data_for_wp_user(int $user_id): int
    {
        if ($user_id <= 0) {
            return 0;
        }
        global $wpdb;
        $sessions = self::table_sessions();
        $messages = self::table_messages();
        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table names from prefix
        $ids = $wpdb->get_col($wpdb->prepare("SELECT id FROM {$sessions} WHERE user_id = %d", $user_id));
        // phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        if (! is_array($ids) || $ids === []) {
            return 0;
        }
        $ids = array_map('intval', $ids);
        $in = implode(',', $ids);
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $wpdb->query("DELETE FROM `{$messages}` WHERE session_id IN ({$in})");
        $wpdb->delete($sessions, ['user_id' => $user_id], ['%d']);

        return count($ids);
    }

    private static function generate_public_id(): string
    {
        if (function_exists('wp_generate_uuid4')) {
            return wp_generate_uuid4();
        }

        return sprintf(
            '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
            random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0x0fff) | 0x4000,
            random_int(0, 0x3fff) | 0x8000,
            random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0xffff)
        );
    }
}
