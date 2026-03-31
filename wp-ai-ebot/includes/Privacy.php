<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Privacy API: suggested policy text. Chat content is stored on the configured AI Ebot service, not this database.
 */
final class Privacy
{
    private static bool $policy_suggested_registered = false;

    public static function init(): void
    {
        add_action('admin_init', [self::class, 'register_privacy_policy_content']);
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
                'This site may use the AI Ebot for WooCommerce plugin to offer a storefront chat. Messages are sent to your configured AI Ebot API service to generate replies, and conversation history for that chat is stored on that service (not in the WordPress database).',
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
}
