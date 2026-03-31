<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Builds a compact store outline for chat: categories, brands, tags, and promotion signals only.
 * Individual products are not listed here — the bot must recommend products from the AI index (retrieval), not from a full published-product list.
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
        if ($taxonomy === 'product_cat' || $taxonomy === 'product_tag' || self::is_brand_taxonomy($taxonomy)) {
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

    /**
     * Site identity so the model can describe overall positioning (not only products).
     *
     * @return string Non-empty prefix with trailing newlines, or "".
     */
    private static function store_identity_prefix(): string
    {
        $lines = [];
        $name = trim(wp_strip_all_tags((string) get_bloginfo('name')));
        if ($name !== '') {
            $lines[] = 'STORE NAME: ' . $name;
        }
        $desc = trim(wp_strip_all_tags((string) get_bloginfo('description')));
        if ($desc !== '') {
            $lines[] = 'SITE TAGLINE / SHORT DESCRIPTION (WordPress): ' . $desc;
        }

        if ($lines === []) {
            return '';
        }

        return implode("\n", $lines) . "\n\n";
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

        $tag_names = self::collect_product_tag_names();
        if ($tag_names !== []) {
            natcasesort($tag_names);
            $tag_names = array_values(array_unique($tag_names));
            $parts[] = 'PRODUCT TAGS (' . count($tag_names) . '): ' . implode(', ', $tag_names);
        } else {
            $parts[] = 'PRODUCT TAGS: (none or unused)';
        }

        $sale_note = self::on_sale_summary_line();
        if ($sale_note !== '') {
            $parts[] = $sale_note;
        }

        $parts[] = 'INDIVIDUAL PRODUCTS: Not listed in this outline. Name, describe, or recommend only products that appear in RETRIEVAL CONTEXT (AI-indexed products). Do not invent a full product list from category/tag names alone.';

        $blob = self::store_identity_prefix() . implode("\n\n", $parts);

        $max_bytes = (int) apply_filters('ai_ebot_chat_catalog_max_bytes', 240000);
        $max_bytes = max(50_000, min(1_500_000, $max_bytes));
        if (strlen($blob) > $max_bytes) {
            $blob = substr($blob, 0, $max_bytes);
            $blob .= "\n\n(Catalog outline truncated for size; invite shoppers to use the shop catalog or search.)";
        }

        /**
         * @param string $blob Full catalog outline including store identity.
         */
        return (string) apply_filters('ai_ebot_chat_catalog_context', $blob);
    }

    /**
     * WooCommerce on-sale count only — no product titles (those come from retrieval).
     */
    private static function on_sale_summary_line(): string
    {
        if (! function_exists('wc_get_product_ids_on_sale')) {
            return '';
        }
        $ids = wc_get_product_ids_on_sale();
        $n = is_array($ids) ? count($ids) : 0;
        if ($n <= 0) {
            return 'PROMOTIONS / ON SALE: (no products flagged on sale in WooCommerce, or not applicable.)';
        }

        return 'PROMOTIONS / ON SALE: About ' . $n . ' product(s) are currently marked on sale. Exact titles, prices, and links must come from RETRIEVAL CONTEXT, not guessed.';
    }

    /**
     * @return list<string>
     */
    private static function collect_product_tag_names(): array
    {
        if (! taxonomy_exists('product_tag')) {
            return [];
        }
        $terms = get_terms([
            'taxonomy' => 'product_tag',
            'hide_empty' => true,
            'number' => 0,
        ]);
        if (is_wp_error($terms) || ! is_array($terms) || $terms === []) {
            return [];
        }
        $out = [];
        foreach ($terms as $t) {
            if ($t instanceof \WP_Term) {
                $out[] = $t->name;
            }
        }

        return $out;
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
