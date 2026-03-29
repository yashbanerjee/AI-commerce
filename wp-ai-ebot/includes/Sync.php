<?php

declare(strict_types=1);

namespace AI_Ebot;

use AI_Ebot\Admin\Settings;

/**
 * WooCommerce product sync and optional page sync hooks.
 */
final class Sync
{
    private static ?self $instance = null;

    /** @var array<int, true> Product IDs touched this request; flushed once on shutdown (one ingest per request). */
    private static array $pending_product_ids = [];

    private static bool $product_shutdown_registered = false;

    public static function instance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    public function init(): void
    {
        add_action('woocommerce_update_product', [$this, 'on_product_save'], 20, 1);
        add_action('woocommerce_before_delete_product', [$this, 'on_product_delete'], 10, 1);
        add_action('save_post_page', [$this, 'on_page_save'], 20, 3);
        add_action('admin_post_ai_ebot_reindex', [$this, 'handle_reindex']);
        add_action('wp_ajax_ai_ebot_reindex', [$this, 'ajax_reindex']);
    }

    /**
     * @param int|\WP_Post $product_id
     */
    public function on_product_save($product_id): void
    {
        if (! $this->should_sync()) {
            return;
        }
        $id = is_object($product_id) ? (int) $product_id->ID : (int) $product_id;
        if ($id <= 0) {
            return;
        }
        self::$pending_product_ids[$id] = true;
        $this->register_product_shutdown_flush();
    }

    private function register_product_shutdown_flush(): void
    {
        if (self::$product_shutdown_registered) {
            return;
        }
        self::$product_shutdown_registered = true;
        add_action('shutdown', [self::class, 'flush_pending_product_ingests'], 999);
    }

    /**
     * Sends a single batched ingest for all products updated during this request (reduces server ingest request count).
     */
    public static function flush_pending_product_ingests(): void
    {
        if (self::$pending_product_ids === []) {
            return;
        }
        $sync = self::instance();
        if (! $sync->should_sync()) {
            self::$pending_product_ids = [];

            return;
        }

        $ids = array_keys(self::$pending_product_ids);
        self::$pending_product_ids = [];

        $items = [];
        foreach ($ids as $pid) {
            $payload = $sync->build_product_payload((int) $pid);
            if ($payload !== null) {
                $items[] = $payload;
            }
        }
        if ($items === []) {
            return;
        }

        $client = new Server_Client();
        $batch_size = (int) apply_filters('ai_ebot_incremental_ingest_batch_size', 15);
        $batch_size = max(1, min(80, $batch_size));
        foreach (array_chunk($items, $batch_size) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'batched_product_count' => count($chunk),
            ]);
            if (! $result['ok']) {
                return;
            }
        }
    }

    public function on_product_delete(int $product_id): void
    {
        if (! $this->should_sync()) {
            return;
        }
        $external_id = 'product:' . $product_id;
        $client = new Server_Client();
        $result = $client->ingest([
            'items' => [],
            'delete_external_ids' => [$external_id],
        ]);
        Status::record_ingest_result($result['ok'], $result['body'], []);
    }

    /**
     * @param int $post_id
     * @param \WP_Post $post
     * @param bool $update
     */
    public function on_page_save(int $post_id, $post, bool $update): void
    {
        if (! $this->should_sync()) {
            return;
        }
        $allowed = Settings::get_sync_page_ids();
        if (! in_array((int) $post_id, $allowed, true)) {
            return;
        }
        if ($post->post_status !== 'publish') {
            return;
        }
        $payload = $this->build_page_payload($post_id);
        if ($payload === null) {
            return;
        }
        $client = new Server_Client();
        $result = $client->ingest([
            'items' => [$payload],
            'delete_external_ids' => [],
        ]);
        Status::record_ingest_result($result['ok'], $result['body'], []);
    }

    public function handle_reindex(): void
    {
        if (! current_user_can('manage_options')) {
            wp_die(esc_html__('Forbidden.', 'wp-ai-ebot'));
        }
        check_admin_referer('ai_ebot_reindex');

        $out = $this->run_full_reindex();
        if (! $out['ok']) {
            $msg = $out['reason'] === 'not_configured' ? 'not_configured' : 'reindex_failed';
            wp_safe_redirect(Settings::admin_tab_url('overview', ['ai_ebot_msg' => $msg]));
            exit;
        }

        wp_safe_redirect(Settings::admin_tab_url('overview', ['ai_ebot_msg' => 'reindexed']));
        exit;
    }

    /**
     * AJAX: reindex with JSON response (progress UI on Overview tab).
     */
    public function ajax_reindex(): void
    {
        if (! check_ajax_referer('ai_ebot_reindex', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- checked via check_ajax_referer above
        if (isset($_POST['reindex_progress']) && (string) wp_unslash($_POST['reindex_progress']) === '1') {
            $this->ajax_reindex_progress();

            return;
        }

        $out = $this->run_full_reindex();
        if (! $out['ok']) {
            $msg = $out['reason'] === 'not_configured'
                ? __('AI Ebot is not connected. Open Connection to register this site first.', 'wp-ai-ebot')
                : __('The AI service did not accept the reindex. Check the last sync error in Status.', 'wp-ai-ebot');
            wp_send_json_error(
                [
                    'code' => $out['reason'],
                    'message' => $msg,
                ],
                $out['reason'] === 'not_configured' ? 400 : 502
            );
        }

        wp_send_json_success(
            [
                'product_count' => $out['product_count'],
                'message' => __('Reindex complete.', 'wp-ai-ebot'),
                'index_status' => $this->reindex_ajax_index_status_payload(),
            ]
        );
    }

    /**
     * Stepped reindex for admin UI (live product counts). One batch per request.
     */
    private function ajax_reindex_progress(): void
    {
        // phpcs:disable WordPress.Security.NonceVerification.Missing
        $extras = isset($_POST['reindex_extras']) && (string) wp_unslash($_POST['reindex_extras']) === '1';
        // phpcs:enable WordPress.Security.NonceVerification.Missing

        if ($extras) {
            $out = $this->run_reindex_extras_and_finalize();
            if (! $out['ok']) {
                $msg = $out['reason'] === 'not_configured'
                    ? __('AI Ebot is not connected. Open Connection to register this site first.', 'wp-ai-ebot')
                    : __('The AI service did not accept the reindex. Check the last sync error in Status.', 'wp-ai-ebot');
                wp_send_json_error(
                    [
                        'code' => $out['reason'] ?? 'ingest_failed',
                        'message' => $msg,
                    ],
                    ($out['reason'] ?? '') === 'not_configured' ? 400 : 502
                );
            }

            wp_send_json_success(
                [
                    'reindex_progress' => true,
                    'done' => true,
                    'indexed_so_far' => $out['product_count'],
                    'total_products' => Status::published_product_count(),
                    'product_count' => $out['product_count'],
                    'message' => __('Reindex complete.', 'wp-ai-ebot'),
                    'index_status' => $this->reindex_ajax_index_status_payload(),
                ]
            );

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $offset = isset($_POST['product_offset']) ? max(0, (int) wp_unslash($_POST['product_offset'])) : 0;
        $out = $this->run_reindex_products_page($offset);
        if (! $out['ok']) {
            $msg = ($out['reason'] ?? '') === 'not_configured'
                ? __('AI Ebot is not connected. Open Connection to register this site first.', 'wp-ai-ebot')
                : __('The AI service did not accept the reindex. Check the last sync error in Status.', 'wp-ai-ebot');
            wp_send_json_error(
                [
                    'code' => $out['reason'] ?? 'ingest_failed',
                    'message' => $msg,
                    'indexed_so_far' => (int) ($out['indexed_so_far'] ?? 0),
                    'total_products' => (int) ($out['total_products'] ?? 0),
                ],
                ($out['reason'] ?? '') === 'not_configured' ? 400 : 502
            );
        }

        wp_send_json_success(
            [
                'reindex_progress' => true,
                'done' => false,
                'requires_extras' => ! empty($out['requires_extras']),
                'indexed_so_far' => (int) $out['indexed_so_far'],
                'total_products' => (int) $out['total_products'],
                'published_products' => (int) ($out['published_products'] ?? $out['total_products']),
                'index_cap_applied' => ! empty($out['index_cap_applied']),
            ]
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function reindex_ajax_index_status_payload(): array
    {
        $published = Status::published_product_count();
        $indexed = Status::indexed_product_count();
        $last_ingest_at = (int) get_option(Status::OPT_LAST_INGEST_AT, 0);
        $df = (string) get_option('date_format') . ' ' . (string) get_option('time_format');

        return [
            'indexed' => $indexed,
            'published' => $published,
            'has_full_reindex' => (int) get_option(Status::OPT_LAST_FULL_REINDEX_AT, 0) > 0,
            'full_reindex_human' => Status::last_full_reindex_human(),
            'last_ingest_ok' => (string) get_option(Status::OPT_LAST_INGEST_OK, '') === '1',
            'last_ingest_formatted' => $last_ingest_at > 0
                ? wp_date($df, $last_ingest_at)
                : '—',
        ];
    }

    /**
     * @return array{ok: bool, reason?: string, product_count: int}
     */
    public function run_full_reindex(): array
    {
        if (! $this->should_sync()) {
            return ['ok' => false, 'reason' => 'not_configured', 'product_count' => 0];
        }

        $items = [];
        $q = new \WP_Query([
            'post_type' => 'product',
            'post_status' => 'publish',
            'posts_per_page' => -1,
            'fields' => 'ids',
        ]);
        $product_count = 0;
        foreach ($q->posts as $pid) {
            $p = $this->build_product_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
                $product_count++;
            }
        }

        $scope = $this->reindex_product_scope_total();
        if ($scope['total'] < $product_count) {
            $items = array_slice($items, 0, $scope['total']);
            $product_count = $scope['total'];
        }

        $items = array_merge($items, $this->build_extras_items());

        $client = new Server_Client();

        /**
         * One giant ingest holds the HTTP connection until every chunk is embedded (no bytes sent until done).
         * WordPress then hits cURL error 28 (~120s default). Smaller batches return JSON within the timeout.
         *
         * @param int $size Items per request (products, pages, custom rows each count as one).
         */
        $batch_size = (int) apply_filters('ai_ebot_full_reindex_batch_size', 12);
        $batch_size = max(1, min(80, $batch_size));

        if ($items === []) {
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => [],
                'full_reindex' => true,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'full_reindex' => true,
                'product_count' => 0,
            ]);

            if (! $result['ok']) {
                return ['ok' => false, 'reason' => 'ingest_failed', 'product_count' => 0];
            }
        } else {
            $chunks = array_chunk($items, $batch_size);
            $is_first = true;
            $last_ingest_body = null;
            foreach ($chunks as $chunk) {
                $result = $client->ingest([
                    'items' => $chunk,
                    'delete_external_ids' => [],
                    'full_reindex' => $is_first,
                ]);
                $is_first = false;

                if (! $result['ok']) {
                    Status::record_ingest_result(false, $result['body'], []);

                    return ['ok' => false, 'reason' => 'ingest_failed', 'product_count' => $product_count];
                }

                $last_ingest_body = $result['body'];
                Status::record_ingest_result(true, $result['body'], []);
            }

            Status::record_ingest_result(
                true,
                is_array($last_ingest_body) ? $last_ingest_body : ['ok' => true],
                [
                    'full_reindex' => true,
                    'product_count' => $product_count,
                ]
            );
        }

        (new Server_Client())->heartbeat(Telemetry::site_metadata());

        return ['ok' => true, 'product_count' => $product_count];
    }

    /**
     * Synced pages, site blurb, and custom knowledge chunks (after all products).
     *
     * @return list<array<string, mixed>>
     */
    private function build_extras_items(): array
    {
        $items = [];
        $page_ids = Settings::get_sync_page_ids();
        foreach ($page_ids as $pid) {
            $p = $this->build_page_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        $site_payload = $this->build_site_payload();
        if ($site_payload !== null) {
            $items[] = $site_payload;
        }

        $custom = get_option('ai_ebot_custom_chunks', []);
        if (is_array($custom)) {
            foreach ($custom as $i => $chunk) {
                if (! is_array($chunk) || empty($chunk['body'])) {
                    continue;
                }
                $items[] = [
                    'external_id' => 'custom:' . $i,
                    'source_type' => 'custom',
                    'source_id' => (string) $i,
                    'url' => home_url('/'),
                    'title' => isset($chunk['title']) ? (string) $chunk['title'] : 'Custom',
                    'text' => $this->plain_text((string) $chunk['body']),
                    'metadata' => [],
                ];
            }
        }

        return $items;
    }

    /**
     * @return array{total: int, published: int, capped: bool}
     */
    private function reindex_product_scope_total(): array
    {
        $published = Status::published_product_count();
        $snap = Status::fetch_billing_snapshot();
        if (! is_array($snap) || ! isset($snap['max_indexed_products'])) {
            return ['total' => $published, 'published' => $published, 'capped' => false];
        }
        $cap = (int) $snap['max_indexed_products'];
        if ($cap <= 0) {
            return ['total' => $published, 'published' => $published, 'capped' => false];
        }
        $eff = min($published, $cap);

        return [
            'total' => $eff,
            'published' => $published,
            'capped' => $published > $cap,
        ];
    }

    /**
     * One progress step: ingest a window of published products (ordered by ID).
     *
     * @return array{
     *   ok: bool,
     *   reason?: string,
     *   indexed_so_far?: int,
     *   total_products?: int,
     *   published_products?: int,
     *   index_cap_applied?: bool,
     *   requires_extras?: bool,
     *   done?: bool
     * }
     */
    private function run_reindex_products_page(int $offset): array
    {
        if (! $this->should_sync()) {
            return ['ok' => false, 'reason' => 'not_configured', 'indexed_so_far' => 0, 'total_products' => 0];
        }

        $scope = $this->reindex_product_scope_total();
        $total = $scope['total'];
        $published_total = $scope['published'];
        $cap_applied = $scope['capped'];
        $progress_batch = (int) apply_filters('ai_ebot_reindex_progress_batch_size', 8);
        $progress_batch = max(1, min(40, $progress_batch));
        $api_chunk = (int) apply_filters('ai_ebot_full_reindex_batch_size', 12);
        $api_chunk = max(1, min(80, $api_chunk));
        $client = new Server_Client();

        if ($offset > 0 && $offset >= $total) {
            return [
                'ok' => true,
                'indexed_so_far' => $total,
                'total_products' => $total,
                'published_products' => $published_total,
                'index_cap_applied' => $cap_applied,
                'requires_extras' => true,
                'done' => false,
            ];
        }

        if ($offset === 0 && $total === 0) {
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => [],
                'full_reindex' => true,
            ]);
            if (! $result['ok']) {
                Status::record_ingest_result(false, $result['body'], []);

                return [
                    'ok' => false,
                    'reason' => 'ingest_failed',
                    'indexed_so_far' => 0,
                    'total_products' => 0,
                    'published_products' => $published_total,
                    'index_cap_applied' => $cap_applied,
                ];
            }
            Status::record_ingest_result(true, $result['body'], []);

            return [
                'ok' => true,
                'indexed_so_far' => 0,
                'total_products' => 0,
                'published_products' => $published_total,
                'index_cap_applied' => $cap_applied,
                'requires_extras' => true,
                'done' => false,
            ];
        }

        $q = new \WP_Query([
            'post_type' => 'product',
            'post_status' => 'publish',
            'posts_per_page' => $progress_batch,
            'offset' => $offset,
            'fields' => 'ids',
            'orderby' => 'ID',
            'order' => 'ASC',
            'no_found_rows' => true,
        ]);

        $ids = is_array($q->posts) ? array_map('intval', $q->posts) : [];
        $items = [];
        foreach ($ids as $pid) {
            $p = $this->build_product_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        $first_api = ($offset === 0);
        foreach (array_chunk($items, $api_chunk) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
                'full_reindex' => $first_api,
            ]);
            $first_api = false;
            if (! $result['ok']) {
                Status::record_ingest_result(false, $result['body'], []);

                return [
                    'ok' => false,
                    'reason' => 'ingest_failed',
                    'indexed_so_far' => $offset,
                    'total_products' => $total,
                    'published_products' => $published_total,
                    'index_cap_applied' => $cap_applied,
                ];
            }
            Status::record_ingest_result(true, $result['body'], []);
        }

        $next_offset = $offset + count($ids);
        $requires_extras = $next_offset >= $total;

        return [
            'ok' => true,
            'indexed_so_far' => min($next_offset, $total),
            'total_products' => $total,
            'published_products' => $published_total,
            'index_cap_applied' => $cap_applied,
            'requires_extras' => $requires_extras,
            'done' => false,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function step_reindex_products_page(int $offset): array
    {
        return $this->run_reindex_products_page($offset);
    }

    /**
     * @return array{ok: bool, reason?: string, product_count: int}
     */
    public function step_reindex_extras_and_finalize(): array
    {
        return $this->run_reindex_extras_and_finalize();
    }

    /**
     * @return array{ok: bool, reason?: string, product_count: int}
     */
    private function run_reindex_extras_and_finalize(): array
    {
        if (! $this->should_sync()) {
            return ['ok' => false, 'reason' => 'not_configured', 'product_count' => 0];
        }

        $items = $this->build_extras_items();
        $client = new Server_Client();
        $api_chunk = (int) apply_filters('ai_ebot_full_reindex_batch_size', 12);
        $api_chunk = max(1, min(80, $api_chunk));

        foreach (array_chunk($items, $api_chunk) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
                'full_reindex' => false,
            ]);
            if (! $result['ok']) {
                Status::record_ingest_result(false, $result['body'], []);

                return ['ok' => false, 'reason' => 'ingest_failed', 'product_count' => 0];
            }
            Status::record_ingest_result(true, $result['body'], []);
        }

        $product_count = Status::indexed_product_count();
        Status::record_ingest_result(true, ['ok' => true], [
            'full_reindex' => true,
            'product_count' => $product_count,
        ]);
        (new Server_Client())->heartbeat(Telemetry::site_metadata());

        return ['ok' => true, 'product_count' => $product_count];
    }

    private function should_sync(): bool
    {
        return class_exists('WooCommerce') && (new Server_Client())->is_configured();
    }

    public function can_sync(): bool
    {
        return $this->should_sync();
    }

    /**
     * @return array{total: int, published: int, capped: bool}
     */
    public function get_reindex_product_scope(): array
    {
        return $this->reindex_product_scope_total();
    }

    /**
     * Strip tags and decode HTML entities (WooCommerce price HTML uses &nbsp; and numeric currency symbols).
     */
    private function plain_text(string $html): string
    {
        $s = wp_strip_all_tags($html);

        return html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    /**
     * @return array<string, mixed>|null
     */
    private function build_product_payload(int $product_id): ?array
    {
        if (! function_exists('wc_get_product')) {
            return null;
        }
        $product = wc_get_product($product_id);
        if (! $product) {
            return null;
        }
        $parts = [
            html_entity_decode($product->get_name(), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            $product->get_sku() ? 'SKU: ' . $product->get_sku() : '',
            $this->plain_text($product->get_short_description() ?: ''),
            $this->plain_text($product->get_description() ?: ''),
        ];
        $terms = get_the_terms($product_id, 'product_cat');
        if (is_array($terms) && ! is_wp_error($terms)) {
            $parts[] = 'Categories: ' . implode(', ', wp_list_pluck($terms, 'name'));
        }
        $tags = get_the_terms($product_id, 'product_tag');
        if (is_array($tags) && ! is_wp_error($tags)) {
            $parts[] = 'Tags: ' . implode(', ', wp_list_pluck($tags, 'name'));
        }
        $parts[] = 'Price: ' . $this->plain_text($product->get_price_html());
        $parts[] = 'Stock: ' . ($product->is_in_stock() ? 'in stock' : 'out of stock');

        $attr_text = $this->product_attributes_text($product);
        if ($attr_text !== '') {
            $parts[] = $attr_text;
        }
        $var_text = $this->product_variations_text($product);
        if ($var_text !== '') {
            $parts[] = $var_text;
        }
        $dim_text = $this->product_dimensions_text($product);
        if ($dim_text !== '') {
            $parts[] = $dim_text;
        }

        $text = trim(implode("\n\n", array_filter($parts)));

        return [
            'external_id' => 'product:' . $product_id,
            'source_type' => 'product',
            'source_id' => (string) $product_id,
            'url' => get_permalink($product_id) ?: home_url('/'),
            'title' => $product->get_name(),
            'text' => $text,
            'metadata' => [
                'sku' => $product->get_sku(),
                'image' => wp_get_attachment_url($product->get_image_id()) ?: '',
            ],
        ];
    }

    private function product_attributes_text(\WC_Product $product): string
    {
        $attrs = $product->get_attributes();
        if ($attrs === []) {
            return '';
        }
        $lines = [];
        foreach ($attrs as $attr) {
            if (! $attr->get_visible()) {
                continue;
            }
            $name = wc_attribute_label($attr->get_name());
            if ($attr->is_taxonomy()) {
                $vals = wc_get_product_terms($product->get_id(), $attr->get_name(), ['fields' => 'names']);
                if (! is_array($vals) || $vals === []) {
                    continue;
                }
                $lines[] = $name . ': ' . implode(', ', $vals);
            } else {
                $opts = $attr->get_options();
                $lines[] = $name . ': ' . implode(', ', array_map('strval', (array) $opts));
            }
        }

        return $lines !== [] ? 'Attributes: ' . implode('; ', $lines) : '';
    }

    private function product_variations_text(\WC_Product $product): string
    {
        if (! $product->is_type('variable')) {
            return '';
        }
        $children = $product->get_children();
        if ($children === []) {
            return '';
        }
        $lines = [];
        foreach ($children as $vid) {
            $v = wc_get_product((int) $vid);
            if (! $v) {
                continue;
            }
            $var_desc = function_exists('wc_get_formatted_variation')
                ? wc_get_formatted_variation($v, true, true)
                : '';
            $price = $this->plain_text($v->get_price_html());
            $stock = $v->is_in_stock() ? 'in stock' : 'out of stock';
            $line = trim(html_entity_decode($v->get_name(), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            if ($var_desc !== '') {
                $line .= ' (' . $this->plain_text($var_desc) . ')';
            }
            $line .= ' — ' . $price . ' — ' . $stock;
            $lines[] = $line;
        }

        return $lines !== [] ? "Variations:\n" . implode("\n", $lines) : '';
    }

    private function product_dimensions_text(\WC_Product $product): string
    {
        $parts = [];
        if ($product->has_weight()) {
            $parts[] = 'Weight: ' . wc_format_weight($product->get_weight());
        }
        if ($product->has_dimensions()) {
            $parts[] = 'Dimensions: ' . wc_format_dimensions($product->get_dimensions(false));
        }

        return $parts !== [] ? implode(' · ', $parts) : '';
    }

    /**
     * @return array<string, mixed>|null
     */
    private function build_page_payload(int $page_id): ?array
    {
        $post = get_post($page_id);
        if (! $post || $post->post_type !== 'page') {
            return null;
        }
        $text = $this->plain_text($post->post_title . "\n\n" . apply_filters('the_content', $post->post_content));

        return [
            'external_id' => 'page:' . $page_id,
            'source_type' => 'page',
            'source_id' => (string) $page_id,
            'url' => get_permalink($page_id) ?: home_url('/'),
            'title' => html_entity_decode($post->post_title, ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            'text' => $text,
            'metadata' => [],
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function build_site_payload(): ?array
    {
        $title = get_bloginfo('name');
        $desc = get_bloginfo('description');
        $text = trim($this->plain_text($title . "\n\n" . $desc));
        if ($text === '') {
            return null;
        }

        return [
            'external_id' => 'site:info',
            'source_type' => 'page',
            'source_id' => '0',
            'url' => home_url('/'),
            'title' => html_entity_decode($title ?: 'Site', ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            'text' => $text,
            'metadata' => ['kind' => 'site'],
        ];
    }
}
