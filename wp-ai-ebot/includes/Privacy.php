<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Privacy API: personal data export / erasure for locally stored chat, and suggested policy text.
 */
final class Privacy
{
    private const EXPORT_PAGE_SIZE = 20;

    private static bool $policy_suggested_registered = false;

    public static function init(): void
    {
        add_filter('wp_privacy_personal_data_exporters', [self::class, 'register_exporters']);
        add_filter('wp_privacy_personal_data_erasers', [self::class, 'register_erasers']);
        add_action('admin_init', [self::class, 'register_privacy_policy_content']);
    }

    /**
     * @param array<string, array{exporter_friendly_name: string, callback: callable}> $exporters
     * @return array<string, array{exporter_friendly_name: string, callback: callable}>
     */
    public static function register_exporters(array $exporters): array
    {
        $exporters['wp-ai-ebot-chat'] = [
            'exporter_friendly_name' => __('AI Ebot storefront chat', 'wp-ai-ebot'),
            'callback' => [self::class, 'export_chat_sessions'],
        ];

        return $exporters;
    }

    /**
     * @param array<string, array{eraser_friendly_name: string, callback: callable}> $erasers
     * @return array<string, array{eraser_friendly_name: string, callback: callable}>
     */
    public static function register_erasers(array $erasers): array
    {
        $erasers['wp-ai-ebot-chat'] = [
            'eraser_friendly_name' => __('AI Ebot storefront chat', 'wp-ai-ebot'),
            'callback' => [self::class, 'erase_chat_sessions'],
        ];

        return $erasers;
    }

    public static function register_privacy_policy_content(): void
    {
        if (self::$policy_suggested_registered || ! function_exists('wp_add_privacy_policy_content')) {
            return;
        }
        self::$policy_suggested_registered = true;

        $suggested = self::privacy_policy_suggested_text();
        wp_add_privacy_policy_content(
            'wp-ai-ebot',
            wp_kses_post($suggested)
        );
    }

    public static function privacy_policy_suggested_text(): string
    {
        $parts = [
            '<h2>' . esc_html__('AI Ebot for WooCommerce', 'wp-ai-ebot') . '</h2>',
            '<p>' . esc_html__(
                'This site may use the AI Ebot for WooCommerce plugin to offer a storefront chat. When visitors use the chat, messages are sent to a configured AI Ebot API service to generate replies, and recent conversation text may be stored in this WordPress database for session continuity.',
                'wp-ai-ebot'
            ) . '</p>',
            '<p>' . esc_html__(
                'Product and page content you choose to sync is sent to that service for indexing and retrieval. The plugin may also send non-secret site metadata (such as site title and software versions) to the service when administrators use the dashboard, as described in the plugin readme.',
                'wp-ai-ebot'
            ) . '</p>',
            '<p>' . esc_html__(
                'You should link to your AI Ebot operator’s privacy policy and terms of use here, and explain how visitors can exercise privacy rights regarding data held on the external service.',
                'wp-ai-ebot'
            ) . '</p>',
        ];

        return implode("\n", $parts);
    }

    /**
     * @return array{data: list<array<string, mixed>>, done: bool}
     */
    public static function export_chat_sessions(string $email_address, int $page = 1): array
    {
        $user = get_user_by('email', $email_address);
        if (! $user instanceof \WP_User) {
            return ['data' => [], 'done' => true];
        }

        global $wpdb;
        $table = Chat_Store::table_sessions();
        $per_page = self::EXPORT_PAGE_SIZE;
        $offset = max(0, ($page - 1) * $per_page);

        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $sessions = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT * FROM {$table} WHERE user_id = %d ORDER BY id ASC LIMIT %d OFFSET %d",
                (int) $user->ID,
                $per_page,
                $offset
            )
        );
        $total = (int) $wpdb->get_var(
            $wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE user_id = %d", (int) $user->ID)
        );
        // phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

        if (! is_array($sessions)) {
            $sessions = [];
        }

        $data = [];
        foreach ($sessions as $s) {
            $sid = (int) $s->id;
            $msgs = Chat_Store::get_messages($sid);
            $lines = [];
            foreach ($msgs as $m) {
                $lines[] = sprintf(
                    '%s (%s): %s',
                    (string) $m->role,
                    (string) $m->created_at,
                    wp_strip_all_tags((string) $m->content)
                );
            }
            $data[] = [
                'group_id' => 'ai_ebot_chat',
                'group_label' => __('AI Ebot chat', 'wp-ai-ebot'),
                'item_id' => 'ai-ebot-session-' . $sid,
                'data' => [
                    [
                        'name' => __('Public session ID', 'wp-ai-ebot'),
                        'value' => (string) $s->public_id,
                    ],
                    [
                        'name' => __('Session started', 'wp-ai-ebot'),
                        'value' => (string) $s->created_at,
                    ],
                    [
                        'name' => __('Session updated', 'wp-ai-ebot'),
                        'value' => (string) $s->updated_at,
                    ],
                    [
                        'name' => __('Messages', 'wp-ai-ebot'),
                        'value' => $lines !== [] ? implode("\n\n", $lines) : '—',
                    ],
                ],
            ];
        }

        $done = $offset + count($sessions) >= $total;

        return ['data' => $data, 'done' => $done];
    }

    /**
     * @return array{items_removed: bool, items_retained: bool, messages: string[], done: bool}
     */
    public static function erase_chat_sessions(string $email_address, int $page = 1): array
    {
        unset($page);
        $user = get_user_by('email', $email_address);
        if (! $user instanceof \WP_User) {
            return [
                'items_removed' => false,
                'items_retained' => false,
                'messages' => [],
                'done' => true,
            ];
        }

        $n = Chat_Store::erase_all_data_for_wp_user((int) $user->ID);
        $messages = [];
        if ($n > 0) {
            $messages[] = sprintf(
                /* translators: %d: number of chat sessions removed */
                _n(
                    'Removed %d AI Ebot chat session and its messages from this site.',
                    'Removed %d AI Ebot chat sessions and their messages from this site.',
                    $n,
                    'wp-ai-ebot'
                ),
                $n
            );
        } else {
            $messages[] = __('No AI Ebot chat sessions were found for this user on this site.', 'wp-ai-ebot');
        }

        return [
            'items_removed' => $n > 0,
            'items_retained' => false,
            'messages' => $messages,
            'done' => true,
        ];
    }
}
