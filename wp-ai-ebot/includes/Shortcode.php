<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Chat widget shortcode and asset enqueue.
 */
final class Shortcode
{
    private static ?self $instance = null;

    private bool $chat_assets_registered = false;

    public static function default_chat_header_title(): string
    {
        $saved = trim((string) get_option('ai_ebot_chat_title', ''));

        return $saved !== '' ? $saved : __('Store assistant', 'wp-ai-ebot');
    }

    public static function accent_hex(): string
    {
        $raw = get_option('ai_ebot_chat_accent', '#0b57d0');
        $c = is_string($raw) ? sanitize_hex_color($raw) : '';

        return $c !== '' ? $c : '#0b57d0';
    }

    /**
     * @return string "r, g, b" for use in rgba(var(--ai-ebot-accent-rgb), a)
     */
    public static function accent_rgb_csv(string $hex): string
    {
        $h = ltrim($hex, '#');
        if (strlen($h) === 3 && ctype_xdigit($h)) {
            $h = $h[0] . $h[0] . $h[1] . $h[1] . $h[2] . $h[2];
        }
        if (strlen($h) !== 6 || ! ctype_xdigit($h)) {
            return '11, 87, 208';
        }

        return ((int) hexdec(substr($h, 0, 2))) . ', ' . ((int) hexdec(substr($h, 2, 2))) . ', ' . ((int) hexdec(substr($h, 4, 2)));
    }

    public static function accent_hex_darkened(string $hex, float $factor = 0.72): string
    {
        $h = ltrim($hex, '#');
        if (strlen($h) === 3 && ctype_xdigit($h)) {
            $h = $h[0] . $h[0] . $h[1] . $h[1] . $h[2] . $h[2];
        }
        if (strlen($h) !== 6 || ! ctype_xdigit($h)) {
            return '#0842a0';
        }
        $r = (int) max(0, min(255, round(hexdec(substr($h, 0, 2)) * $factor)));
        $g = (int) max(0, min(255, round(hexdec(substr($h, 2, 2)) * $factor)));
        $b = (int) max(0, min(255, round(hexdec(substr($h, 4, 2)) * $factor)));

        return sprintf('#%02x%02x%02x', $r, $g, $b);
    }

    public static function chat_root_inline_style(): string
    {
        $accent = self::accent_hex();
        $rgb = self::accent_rgb_csv($accent);
        $dark = self::accent_hex_darkened($accent);

        return sprintf(
            '--ai-ebot-accent:%1$s;--ai-ebot-accent-rgb:%2$s;--ai-ebot-accent-dark:%3$s',
            $accent,
            $rgb,
            $dark
        );
    }

    /**
     * Fallback chips when the store has no product categories yet.
     *
     * @return list<string>
     */
    private static function default_starter_suggestions(): array
    {
        return [
            __('Shipping & delivery', 'wp-ai-ebot'),
            __('Returns & refunds', 'wp-ai-ebot'),
            __('Help me pick a product', 'wp-ai-ebot'),
        ];
    }

    /**
     * Starter suggestion chips: top product categories by catalog usage (non-empty), then defaults.
     *
     * @return list<string>
     */
    private static function starter_suggestions_for_chat(): array
    {
        if (! taxonomy_exists('product_cat')) {
            return apply_filters('ai_ebot_starter_suggestions', self::default_starter_suggestions());
        }

        $exclude = [];
        $default_cat = (int) get_option('default_product_cat', 0);
        if ($default_cat > 0) {
            $exclude[] = $default_cat;
        }

        $base = [
            'taxonomy' => 'product_cat',
            'hide_empty' => true,
            'number' => 24,
            'orderby' => 'count',
            'order' => 'DESC',
        ];
        if ($exclude !== []) {
            $base['exclude'] = $exclude;
        }

        // Prefer top-level departments (what the shop "offers"); fall back to any category with products.
        $terms = get_terms(array_merge($base, ['parent' => 0]));
        if (is_wp_error($terms) || ! is_array($terms) || $terms === []) {
            $terms = get_terms($base);
        }

        $out = [];
        if (! is_wp_error($terms) && is_array($terms)) {
            foreach ($terms as $term) {
                if (! $term instanceof \WP_Term) {
                    continue;
                }
                if ($term->slug === 'uncategorized') {
                    continue;
                }
                $name = trim(wp_strip_all_tags($term->name));
                if ($name === '') {
                    continue;
                }
                $out[] = $name;
                if (count($out) >= 6) {
                    break;
                }
            }
        }

        if ($out === []) {
            $out = self::default_starter_suggestions();
        }

        /** @var list<string> $filtered */
        $filtered = apply_filters('ai_ebot_starter_suggestions', $out);

        return is_array($filtered) ? $filtered : $out;
    }

    /**
     * Category chips for the first question in chat.
     * Prefer top-level departments; if the store has only one top-level category, fall back to all non-empty categories.
     *
     * @return list<string>
     */
    private static function category_chips_for_chat(): array
    {
        if (! taxonomy_exists('product_cat')) {
            return [];
        }

        $exclude = [];
        $default_cat = (int) get_option('default_product_cat', 0);
        if ($default_cat > 0) {
            $exclude[] = $default_cat;
        }

        $base = [
            'taxonomy' => 'product_cat',
            'hide_empty' => true,
            'orderby' => 'name',
            'order' => 'ASC',
            // Keep UI usable for stores with many departments.
            'number' => 48,
        ];
        if ($exclude !== []) {
            $base['exclude'] = $exclude;
        }

        $terms = get_terms(array_merge($base, ['parent' => 0]));
        if (! is_wp_error($terms) && is_array($terms) && count($terms) <= 1) {
            // Single “Shop” parent: show subcategories too.
            $terms = get_terms($base);
        }
        if (is_wp_error($terms) || ! is_array($terms) || $terms === []) {
            return [];
        }

        $out = [];
        foreach ($terms as $term) {
            if (! $term instanceof \WP_Term) {
                continue;
            }
            if ($term->slug === 'uncategorized') {
                continue;
            }
            $name = trim(wp_strip_all_tags($term->name));
            if ($name === '') {
                continue;
            }
            $out[] = $name;
        }

        return $out;
    }

    public static function instance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    public function init(): void
    {
        add_action('wp_enqueue_scripts', [$this, 'enqueue']);
        add_shortcode('ai_ebot_chat', [$this, 'render_shortcode']);
    }

    /**
     * Register chat CSS/JS and REST localization. Safe to call multiple times.
     * Must run before enqueue on render: {@see should_enqueue()} is often false when the block
     * lives in an FSE template, a widget, or a non-singular view — then the early return in
     * {@see enqueue()} would skip registration and the heading/markup would not match options.
     */
    private function ensure_chat_assets_registered(): void
    {
        if ($this->chat_assets_registered) {
            return;
        }
        $this->chat_assets_registered = true;

        wp_register_style(
            'ai-ebot-chat',
            AI_EBOT_PLUGIN_URL . 'public/css/chat.css',
            [],
            AI_EBOT_VERSION
        );

        wp_register_script(
            'ai-ebot-chat',
            AI_EBOT_PLUGIN_URL . 'public/js/chat.js',
            [],
            AI_EBOT_VERSION,
            true
        );

        wp_localize_script('ai-ebot-chat', 'aiEbotChat', [
            'restUrl' => esc_url_raw(rest_url('ai-ebot/v1/chat')),
            /** Fetched at runtime via bootstrap (correct per visitor; avoids stale nonce from page cache). */
            'bootstrapUrl' => esc_url_raw(rest_url('ai-ebot/v1/bootstrap')),
            /** Satisfies {@see rest_cookie_check_errors} on bootstrap GET when the page was rendered for this user. */
            'bootstrapProbeNonce' => wp_create_nonce('wp_rest'),
            'nonce' => '',
            'suggestionsLabel' => __('Suggested replies', 'wp-ai-ebot'),
            /** Label above the product card row in chat (same layout for every product). */
            'productCardsHeading' => __('Products', 'wp-ai-ebot'),
            'initPrompt' => __('What are you looking for?', 'wp-ai-ebot'),
            'categoryChips' => self::category_chips_for_chat(),
            'starterSuggestions' => self::starter_suggestions_for_chat(),
            'thinkingPhrases' => [
                __('Thinking…', 'wp-ai-ebot'),
                __('Browsing the catalog…', 'wp-ai-ebot'),
                __('Fetching details…', 'wp-ai-ebot'),
                __('Checking what we know…', 'wp-ai-ebot'),
                __('Putting it together…', 'wp-ai-ebot'),
            ],
        ]);
    }

    public function enqueue(): void
    {
        $this->ensure_chat_assets_registered();

        if (! $this->should_enqueue()) {
            return;
        }

        wp_enqueue_style('ai-ebot-chat');
        wp_enqueue_script('ai-ebot-chat');
    }

    /**
     * @param array<string, string>|string $atts
     */
    public function render_shortcode($atts = []): string
    {
        $atts = shortcode_atts(
            [
                'title' => self::default_chat_header_title(),
            ],
            is_array($atts) ? $atts : [],
            'ai_ebot_chat'
        );

        $header = trim((string) $atts['title']);
        if ($header === '') {
            $header = self::default_chat_header_title();
        }

        $this->ensure_chat_assets_registered();
        wp_enqueue_style('ai-ebot-chat');
        wp_enqueue_script('ai-ebot-chat');

        $title = '<span class="ai-ebot-chat__header-title">' . esc_html($header) . '</span>';

        return sprintf(
            '<div class="ai-ebot-chat" style="%1$s" data-ai-ebot-chat><div class="ai-ebot-chat__header">%2$s</div><div class="ai-ebot-chat__log" data-log></div><form class="ai-ebot-chat__form" data-form><input type="text" class="ai-ebot-chat__input" data-input placeholder="%3$s" autocomplete="off" /><button type="submit" class="ai-ebot-chat__send">%4$s</button></form></div>',
            esc_attr(self::chat_root_inline_style()),
            $title,
            esc_attr__('Ask about products…', 'wp-ai-ebot'),
            esc_html__('Send', 'wp-ai-ebot')
        );
    }

    private function should_enqueue(): bool
    {
        if (! is_singular()) {
            return false;
        }
        global $post;
        if (! $post instanceof \WP_Post) {
            return false;
        }

        $content = (string) $post->post_content;

        return has_shortcode($content, 'ai_ebot_chat')
            || (function_exists('has_block') && has_block('ai-ebot/chat', $post));
    }
}
