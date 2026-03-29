<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Gutenberg dynamic block for the chat widget.
 */
final class Block
{
    public static function register(): void
    {
        add_action('init', [self::class, 'register_block']);
    }

    public static function register_block(): void
    {
        wp_register_script(
            'ai-ebot-block-editor',
            AI_EBOT_PLUGIN_URL . 'blocks/chat/editor.js',
            [
                'wp-blocks',
                'wp-element',
                'wp-block-editor',
                'wp-components',
                'wp-i18n',
            ],
            AI_EBOT_VERSION,
            true
        );

        register_block_type(
            'ai-ebot/chat',
            [
                'api_version' => 2,
                'title' => __('AI Ebot Chat', 'wp-ai-ebot'),
                'category' => 'widgets',
                'icon' => 'format-chat',
                'description' => __('WooCommerce-aware AI assistant with citations.', 'wp-ai-ebot'),
                'attributes' => [
                    'title' => [
                        'type' => 'string',
                        'default' => '',
                    ],
                ],
                'supports' => [
                    'html' => false,
                ],
                'render_callback' => [self::class, 'render'],
                'editor_script' => 'ai-ebot-block-editor',
            ]
        );
    }

    /**
     * @param array<string, mixed> $attributes
     */
    public static function render(array $attributes): string
    {
        $blockTitle = isset($attributes['title']) ? trim((string) $attributes['title']) : '';
        if ($blockTitle !== '') {
            return Shortcode::instance()->render_shortcode(['title' => $blockTitle]);
        }

        return Shortcode::instance()->render_shortcode([]);
    }
}
