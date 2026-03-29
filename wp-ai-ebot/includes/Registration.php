<?php

declare(strict_types=1);

namespace AI_Ebot;

use AI_Ebot\Admin\Settings;

/**
 * Links the WordPress site to the AI Ebot API on activation when credentials are not stored yet.
 *
 * The server treats POST /v1/register as upsert: same site URL + matching site secret → existing tenant
 * (credentials refreshed); unknown URL → new tenant. There is no separate unauthenticated "lookup".
 */
final class Registration
{
    public const TRANSIENT_STATUS = 'ai_ebot_activation_register_status';

    public static function on_activation(): void
    {
        if (! Config::has_server_endpoint()) {
            set_transient(self::TRANSIENT_STATUS, 'no_endpoint', 300);

            return;
        }

        if (Status::has_registered_credentials()) {
            return;
        }

        if ((string) get_option('ai_ebot_site_secret', '') === '') {
            return;
        }

        try {
            Settings::run_server_registration();
            set_transient(self::TRANSIENT_STATUS, 'success', 300);
        } catch (\Throwable $e) {
            if (defined('WP_DEBUG') && WP_DEBUG) {
                // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                error_log('AI Ebot: activation registration failed — ' . $e->getMessage());
            }
            set_transient(self::TRANSIENT_STATUS, 'failed', 600);
            set_transient(
                'ai_ebot_connect_err',
                wp_strip_all_tags($e->getMessage()),
                600
            );
        }
    }
}
