<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Builds a compact catalog outline for chat (categories, brands, product links) so the model can answer
 * "what do you have" without relying on vector retrieval alone.
 */
final class Catalog_Context
{
    private const TRANSIENT_KEY = 'ai_ebot_chat_catalog_ctx';

    public static function init(): void
    {
        add_action('save_post_product', [self::class, 'bust_cache'], 20);
        add_action('before_delete_post', [self::class, 'maybe_bust_on_delete'], 20);
        add_action('created_term', [self::class, 'maybe_bust_on_term_change'], 20, 3);
        add_action('edited_term', [self::class, 'maybe_bust_on_term_change'], 20, 3);
        add_action('delete_term', [self::class, 'maybe_bust_on_term_change'], 20, 3);
    }

    public static function bust_cache(): void
    {
        delete_transient(self::TRANSIENT_KEY);
    }

    public static function maybe_bust_on_delete(int $post_id): void
    {
        if (get_post_type($post_id) === 'product') {
            self::bust_cache();
        }
    }

    public static function maybe_bust_on_term_change(int $term_id, int $tt_id, string $taxonomy): void
    {
        if ($taxonomy === 'product_cat' || self::is_brand_taxonomy($taxonomy)) {
            self::bust_cache();
        }
    }

    private static function is_brand_taxonomy(string $taxonomy): bool
    {
        $brands = (array) apply_filters(
            'ai_ebot_catalog_brand_taxonomies',
            ['product_brand', 'pwb_brand', 'yith_product_brand', 'pa_brand', 'berocket_brand']
        );

        return in_array($taxonomy, $brands, true);
    }

    public static function build_for_chat(): string
    {
        if (! function_exists('WC')) {
            return '';
        }

        $ttl = (int) apply_filters('ai_ebot_catalog_context_cache_ttl', 180);
        $ttl = max(0, min(3600, $ttl));
        if ($ttl > 0) {
            $cached = get_transient(self::TRANSIENT_KEY);
            if (is_string($cached) && $cached !== '') {
                return $cached;
            }
        }

        $raw = self::build_uncached();
        if ($ttl > 0 && $raw !== '') {
            set_transient(self::TRANSIENT_KEY, $raw, $ttl);
        }

        return $raw;
    }

    private static function build_uncached(): string
    {
        $parts = [];

        $cats = get_terms([
            'taxonomy' => 'product_cat',
            'hide_empty' => true,
            'number' => 0,
        ]);
        if (! is_wp_error($cats) && is_array($cats) && $cats !== []) {
            $names = [];
            foreach ($cats as $t) {
                if ($t instanceof \WP_Term) {
                    $names[] = $t->name;
                }
            }
            natcasesort($names);
            $names = array_values($names);
            $parts[] = 'CATEGORIES (' . count($names) . '): ' . implode(', ', $names);
        } else {
            $parts[] = 'CATEGORIES: none';
        }

        $brand_names = self::collect_brand_names();
        if ($brand_names !== []) {
            natcasesort($brand_names);
            $brand_names = array_values(array_unique($brand_names));
            $parts[] = 'BRANDS (' . count($brand_names) . '): ' . implode(', ', $brand_names);
        } else {
            $parts[] = 'BRANDS: (none detected — store may use only categories or custom attributes)';
        }

        $limit = (int) apply_filters('ai_ebot_chat_catalog_product_limit', 4000);
        $limit = max(50, min(20000, $limit));

        $total_pub = 0;
        $count_obj = wp_count_posts('product');
        if ($count_obj && isset($count_obj->publish)) {
            $total_pub = (int) $count_obj->publish;
        }

        $types = (array) apply_filters(
            'ai_ebot_chat_catalog_product_types',
            ['simple', 'variable', 'grouped', 'external']
        );

        if (! function_exists('wc_get_products')) {
            return implode("\n\n", $parts);
        }

        $product_ids = wc_get_products([
            'status' => 'publish',
            'limit' => $limit,
            'orderby' => 'title',
            'order' => 'ASC',
            'return' => 'ids',
            'type' => $types,
        ]);

        $lines = [];
        if (is_array($product_ids)) {
            foreach ($product_ids as $pid) {
                $pid = (int) $pid;
                if ($pid <= 0) {
                    continue;
                }
                $title = get_the_title($pid);
                $url = get_permalink($pid);
                if (! is_string($title) || $title === '' || ! is_string($url) || $url === '') {
                    continue;
                }
                $lines[] = '- [' . self::escape_markdown_link_label($title) . '](' . $url . ')';
            }
        }

        $listed = count($lines);
        $parts[] = 'PRODUCTS (' . $listed . ' lines; WooCommerce reports ' . $total_pub . ' published products):';
        $parts[] = implode("\n", $lines);

        if ($total_pub > $listed) {
            $parts[] = '(Outline lists ' . $listed . ' of ' . $total_pub . ' published products due to a size cap; tell shoppers the shop has more and they can browse the catalog.)';
        }

        $blob = implode("\n\n", $parts);

        $max_bytes = (int) apply_filters('ai_ebot_chat_catalog_max_bytes', 240000);
        $max_bytes = max(50_000, min(1_500_000, $max_bytes));
        if (strlen($blob) > $max_bytes) {
            $blob = substr($blob, 0, $max_bytes);
            $blob .= "\n\n(Catalog outline truncated for size; invite shoppers to use the shop catalog or search.)";
        }

        return $blob;
    }

    private static function escape_markdown_link_label(string $title): string
    {
        return str_replace(['[', ']'], ['(', ')'], $title);
    }

    /**
     * @return list<string>
     */
    private static function collect_brand_names(): array
    {
        $taxes = (array) apply_filters(
            'ai_ebot_catalog_brand_taxonomies',
            ['product_brand', 'pwb_brand', 'yith_product_brand', 'pa_brand', 'berocket_brand']
        );
        $out = [];
        foreach ($taxes as $tax) {
            if (! is_string($tax) || ! taxonomy_exists($tax)) {
                continue;
            }
            $terms = get_terms([
                'taxonomy' => $tax,
                'hide_empty' => true,
                'number' => 0,
            ]);
            if (is_wp_error($terms) || ! is_array($terms) || $terms === []) {
                continue;
            }
            foreach ($terms as $t) {
                if ($t instanceof \WP_Term) {
                    $out[] = $t->name;
                }
            }
        }

        return $out;
    }
}
