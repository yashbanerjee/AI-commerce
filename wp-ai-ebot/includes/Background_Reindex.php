<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Schedules reindex in small steps via WP-Cron (no long browser or PHP request).
 */
final class Background_Reindex
{
    public const OPTION = 'ai_ebot_bg_reindex';

    public const CRON_HOOK = 'ai_ebot_bg_reindex_tick';

    private const LOCK_TRANSIENT = 'ai_ebot_bg_reindex_lock';

    public static function init(): void
    {
        add_action(self::CRON_HOOK, [self::class, 'cron_tick']);
        add_action('wp_ajax_ai_ebot_bg_reindex_start', [self::class, 'ajax_start']);
        add_action('wp_ajax_ai_ebot_bg_reindex_status', [self::class, 'ajax_status']);
        add_action('wp_ajax_ai_ebot_bg_reindex_cancel', [self::class, 'ajax_cancel']);
    }

    public static function ajax_start(): void
    {
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }
        check_ajax_referer('ai_ebot_bg_reindex', 'nonce');

        $sync = Sync::instance();
        if (! $sync->can_sync()) {
            wp_send_json_error(
                ['message' => __('Connect this site under Connection before reindexing.', 'wp-ai-ebot')],
                400
            );
        }

        $existing = get_option(self::OPTION, null);
        if (is_array($existing) && ($existing['status'] ?? '') === 'running') {
            wp_send_json_error(
                ['message' => __('A background reindex is already running.', 'wp-ai-ebot')],
                409
            );
        }

        $scope = $sync->get_reindex_product_scope();
        update_option(
            self::OPTION,
            [
                'status' => 'running',
                'phase' => 'products',
                'offset' => 0,
                'total' => $scope['total'],
                'published' => $scope['published'],
                'cap_applied' => $scope['capped'],
                'message' => __('Starting…', 'wp-ai-ebot'),
                'updated_at' => time(),
            ],
            false
        );

        wp_clear_scheduled_hook(self::CRON_HOOK);
        wp_schedule_single_event(time() + 5, self::CRON_HOOK);
        self::spawn_wp_cron();

        wp_send_json_success(['ok' => true]);
    }

    public static function ajax_status(): void
    {
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }
        check_ajax_referer('ai_ebot_bg_reindex', 'nonce');

        $state = get_option(self::OPTION, null);
        if (! is_array($state)) {
            wp_send_json_success(['status' => 'idle']);
            return;
        }

        wp_send_json_success($state);
    }

    public static function ajax_cancel(): void
    {
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }
        check_ajax_referer('ai_ebot_bg_reindex', 'nonce');

        delete_option(self::OPTION);
        wp_clear_scheduled_hook(self::CRON_HOOK);
        delete_transient(self::LOCK_TRANSIENT);

        wp_send_json_success(['ok' => true]);
    }

    public static function cron_tick(): void
    {
        if (get_transient(self::LOCK_TRANSIENT)) {
            wp_schedule_single_event(time() + 120, self::CRON_HOOK);
            self::spawn_wp_cron();

            return;
        }
        set_transient(self::LOCK_TRANSIENT, '1', 5 * MINUTE_IN_SECONDS);

        try {
            $state = get_option(self::OPTION, null);
            if (! is_array($state) || ($state['status'] ?? '') !== 'running') {
                return;
            }

            $sync = Sync::instance();
            if (! $sync->can_sync()) {
                self::fail_state(__('Sync is not configured.', 'wp-ai-ebot'));

                return;
            }

            $phase = (string) ($state['phase'] ?? 'products');
            if ($phase === 'products') {
                $offset = (int) ($state['offset'] ?? 0);
                $out = $sync->step_reindex_products_page($offset);
                if (! $out['ok']) {
                    self::fail_state(
                        __('The AI service did not accept a reindex batch. Check Status for details.', 'wp-ai-ebot')
                    );

                    return;
                }

                $state['offset'] = (int) $out['indexed_so_far'];
                $state['total'] = (int) $out['total_products'];
                $state['published'] = (int) ($out['published_products'] ?? $out['total_products']);
                $state['cap_applied'] = ! empty($out['index_cap_applied']);
                $state['message'] = sprintf(
                    /* translators: 1: indexed count, 2: total in scope */
                    __('%1$d of %2$d products sent…', 'wp-ai-ebot'),
                    (int) $out['indexed_so_far'],
                    (int) $out['total_products']
                );
                $state['updated_at'] = time();

                if (! empty($out['requires_extras'])) {
                    $state['phase'] = 'extras';
                }

                update_option(self::OPTION, $state, false);

                if (($state['phase'] ?? '') === 'extras') {
                    wp_schedule_single_event(time() + 5, self::CRON_HOOK);
                } else {
                    wp_schedule_single_event(time() + 45, self::CRON_HOOK);
                }
                self::spawn_wp_cron();

                return;
            }

            // extras
            $out = $sync->step_reindex_extras_and_finalize();
            if (! $out['ok']) {
                self::fail_state(
                    __('Extras / finalize step failed. Check Status for the last sync error.', 'wp-ai-ebot')
                );

                return;
            }

            Status::invalidate_billing_cache((string) get_option('ai_ebot_tenant_id', ''));
            delete_option(self::OPTION);
            wp_clear_scheduled_hook(self::CRON_HOOK);
            set_transient(
                'ai_ebot_bg_reindex_last_ok',
                [
                    'finished_at' => time(),
                    'product_count' => (int) $out['product_count'],
                ],
                HOUR_IN_SECONDS
            );
        } finally {
            delete_transient(self::LOCK_TRANSIENT);
        }
    }

    private static function fail_state(string $message): void
    {
        $state = get_option(self::OPTION, []);
        if (! is_array($state)) {
            $state = [];
        }
        $state['status'] = 'error';
        $state['message'] = $message;
        $state['updated_at'] = time();
        update_option(self::OPTION, $state, false);
        wp_clear_scheduled_hook(self::CRON_HOOK);
    }

    private static function spawn_wp_cron(): void
    {
        if (function_exists('spawn_cron')) {
            spawn_cron();
            return;
        }
        wp_remote_get(
            site_url('wp-cron.php'),
            [
                'timeout' => 0.01,
                'blocking' => false,
                'sslverify' => apply_filters('https_local_ssl_verify', false),
            ]
        );
    }
}
