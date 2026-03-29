<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Site metadata sent on registration and periodic heartbeat (SaaS telemetry).
 */
final class Telemetry
{
    public static function init(): void
    {
        add_action('admin_init', [self::class, 'maybe_send_heartbeat'], 20);
    }

    /**
     * @return array<string, string>
     */
    public static function site_metadata(): array
    {
        global $wp_version;

        $out = [
            'site_name' => (string) get_bloginfo('name'),
            'plugin_version' => AI_EBOT_VERSION,
            'wp_version' => is_string($wp_version) ? $wp_version : '',
        ];
        if (class_exists('WooCommerce') && defined('WC_VERSION')) {
            $out['wc_version'] = (string) WC_VERSION;
        }

        return $out;
    }

    public static function maybe_send_heartbeat(): void
    {
        if (! is_admin() || ! current_user_can('manage_options')) {
            return;
        }

        $client = new Server_Client();
        if (! $client->is_configured()) {
            return;
        }

        if (get_transient('ai_ebot_heartbeat_sent')) {
            return;
        }

        $result = $client->heartbeat(self::site_metadata());
        if ($result['ok']) {
            set_transient('ai_ebot_heartbeat_sent', 1, DAY_IN_SECONDS);
        } elseif (defined('WP_DEBUG') && WP_DEBUG) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log('AI Ebot: heartbeat failed — HTTP ' . (string) $result['code']);
        }
    }
}
