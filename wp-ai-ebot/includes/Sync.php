<?php

declare(strict_types=1);

namespace AI_Ebot;

use AI_Ebot\Admin\Catalog_Index_Tab;
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
        add_action('wp_ajax_ai_ebot_curated_reindex', [$this, 'ajax_curated_reindex']);
        add_action('wp_ajax_ai_ebot_store_structure_sync', [$this, 'ajax_store_structure_sync']);
        add_action('wp_ajax_ai_ebot_knowledge_pages_index', [$this, 'ajax_knowledge_pages_index']);
        add_action('wp_ajax_ai_ebot_assistant_save_index', [$this, 'ajax_assistant_save_index']);
        add_action('wp_ajax_ai_ebot_catalog_index', [$this, 'ajax_catalog_index']);
        add_action('wp_ajax_ai_ebot_clear_vector_index', [$this, 'ajax_clear_vector_index']);
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

    /**
     * Product Index tab only: reindex **curated list** products—never the whole catalog. Removes stray product chunks
     * for published WooCommerce products not in the list, then re-ingests listed products only (no pages/assistant batch).
     */
    public function ajax_curated_reindex(): void
    {
        if (! check_ajax_referer('ai_ebot_curated_reindex', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }
        if (! class_exists('WooCommerce')) {
            wp_send_json_error(['message' => __('WooCommerce is required.', 'wp-ai-ebot')], 400);
        }
        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        if (isset($_POST['reindex_progress']) && (string) wp_unslash($_POST['reindex_progress']) === '1') {
            $this->ajax_curated_reindex_progress();

            return;
        }

        wp_send_json_error(['message' => __('Invalid request.', 'wp-ai-ebot')], 400);
    }

    /**
     * Product Index tab: sync store structure (categories + brands) to the AI index as durable chunks.
     * This helps the assistant list categories/brands and guide shoppers without reindexing products.
     */
    public function ajax_store_structure_sync(): void
    {
        if (! check_ajax_referer('ai_ebot_store_structure_sync', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected. Complete setup on Overview.', 'wp-ai-ebot'),
                ],
                400
            );
            return;
        }
        if (! Status::is_woocommerce_active()) {
            wp_send_json_error(['message' => __('WooCommerce is required.', 'wp-ai-ebot')], 400);
        }

        $items = $this->build_store_structure_items();
        if ($items === []) {
            wp_send_json_success(['message' => __('No store structure data found to sync.', 'wp-ai-ebot')]);
            return;
        }

        $client = new Server_Client();
        $api_chunk = (int) apply_filters('ai_ebot_store_structure_sync_batch_size', 10);
        $api_chunk = max(1, min(60, $api_chunk));
        foreach (array_chunk($items, $api_chunk) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'store_structure_sync' => count($chunk),
            ]);
            if (! $result['ok']) {
                wp_send_json_error(
                    ['message' => __('The AI service did not accept store structure sync. Check Overview → Status.', 'wp-ai-ebot')],
                    502
                );
                return;
            }
        }

        wp_send_json_success(['message' => __('Store structure synced (categories/brands).', 'wp-ai-ebot')]);
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function build_store_structure_items(): array
    {
        $items = [];
        $url = home_url('/');

        // Categories (hierarchical).
        if (taxonomy_exists('product_cat')) {
            $cats = get_terms([
                'taxonomy' => 'product_cat',
                'hide_empty' => true,
                'orderby' => 'name',
                'order' => 'ASC',
                'number' => 200,
            ]);
            if (! is_wp_error($cats) && is_array($cats) && $cats !== []) {
                $byParent = [];
                foreach ($cats as $t) {
                    if (! $t instanceof \WP_Term) {
                        continue;
                    }
                    if ($t->slug === 'uncategorized') {
                        continue;
                    }
                    $p = (int) $t->parent;
                    if (! isset($byParent[$p])) {
                        $byParent[$p] = [];
                    }
                    $byParent[$p][] = $t;
                }
                foreach ($byParent as $p => $list) {
                    usort($list, static fn (\WP_Term $a, \WP_Term $b): int => strcasecmp((string) $a->name, (string) $b->name));
                    $byParent[$p] = $list;
                }

                $lines = [];
                $lines[] = 'Product categories (from WooCommerce):';
                $lines[] = '';

                $walk = function (int $parent, int $depth) use (&$walk, &$byParent, &$lines): void {
                    if (! isset($byParent[$parent])) {
                        return;
                    }
                    foreach ($byParent[$parent] as $term) {
                        $name = trim(wp_strip_all_tags((string) $term->name));
                        if ($name === '') {
                            continue;
                        }
                        $indent = str_repeat('  ', max(0, $depth));
                        $count = (int) $term->count;
                        $slug = (string) $term->slug;
                        $lines[] = sprintf('%s- %s (slug: %s, products: %d)', $indent, $name, $slug, $count);
                        $walk((int) $term->term_id, $depth + 1);
                    }
                };
                $walk(0, 0);

                $text = trim(implode("\n", $lines));
                if ($text !== '') {
                    $items[] = [
                        'external_id' => 'store:structure:product_categories',
                        'source_type' => 'custom',
                        'source_id' => 'store_structure',
                        'url' => $url,
                        'title' => 'Store product categories',
                        'text' => $text,
                        'metadata' => ['kind' => 'store_structure', 'taxonomy' => 'product_cat'],
                    ];
                }
            }
        }

        // Brands: support common taxonomies (product_brand) and common attribute taxonomy (pa_brand).
        $brandTax = '';
        if (taxonomy_exists('product_brand')) {
            $brandTax = 'product_brand';
        } elseif (taxonomy_exists('pa_brand')) {
            $brandTax = 'pa_brand';
        }
        if ($brandTax !== '') {
            $brands = get_terms([
                'taxonomy' => $brandTax,
                'hide_empty' => true,
                'orderby' => 'name',
                'order' => 'ASC',
                'number' => 400,
            ]);
            if (! is_wp_error($brands) && is_array($brands) && $brands !== []) {
                $names = [];
                foreach ($brands as $t) {
                    if (! $t instanceof \WP_Term) {
                        continue;
                    }
                    $name = trim(wp_strip_all_tags((string) $t->name));
                    if ($name === '') {
                        continue;
                    }
                    $names[] = $name;
                }
                $names = array_values(array_unique($names));
                sort($names, SORT_NATURAL | SORT_FLAG_CASE);
                if ($names !== []) {
                    $text = "Brands (from WooCommerce):\n\n" . implode("\n", array_map(static fn (string $n): string => '- ' . $n, $names));
                    $items[] = [
                        'external_id' => 'store:structure:brands',
                        'source_type' => 'custom',
                        'source_id' => 'store_structure',
                        'url' => $url,
                        'title' => 'Store brands',
                        'text' => $text,
                        'metadata' => ['kind' => 'store_structure', 'taxonomy' => $brandTax],
                    ];
                }
            }
        }

        return $items;
    }

    private function ajax_curated_reindex_progress(): void
    {
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected. Complete setup on Overview.', 'wp-ai-ebot'),
                ],
                400
            );

            return;
        }

        $curated = Catalog_Index_Tab::get_curated_product_ids();
        sort($curated);
        if ($curated === []) {
            wp_send_json_error(
                ['message' => __('Add products to the AI index list before reindexing.', 'wp-ai-ebot')],
                400
            );

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $orphan_batch = isset($_POST['orphan_batch']) ? (int) wp_unslash($_POST['orphan_batch']) : 0;
        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $product_offset = isset($_POST['product_offset']) ? max(0, (int) wp_unslash($_POST['product_offset'])) : 0;

        $del_batch = (int) apply_filters('ai_ebot_curated_reindex_orphan_delete_batch', 50);
        $del_batch = max(1, min(120, $del_batch));
        $progress_batch = (int) apply_filters('ai_ebot_reindex_progress_batch_size', 8);
        $progress_batch = max(1, min(40, $progress_batch));
        $api_chunk = (int) apply_filters('ai_ebot_full_reindex_batch_size', 12);
        $api_chunk = max(1, min(80, $api_chunk));

        $orphan_ids = $this->orphan_product_external_ids($curated);
        $num_ob = (int) ceil(count($orphan_ids) / $del_batch);

        $client = new Server_Client();

        if ($orphan_batch < $num_ob) {
            $slice = array_slice($orphan_ids, $orphan_batch * $del_batch, $del_batch);
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => $slice,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], ['curated_reindex_orphans' => count($slice)]);
            if (! $result['ok']) {
                wp_send_json_error(
                    ['message' => __('The AI service did not accept a delete batch. Check Overview → Status.', 'wp-ai-ebot')],
                    502
                );

                return;
            }

            $next_ob = $orphan_batch + 1;
            wp_send_json_success(
                [
                    'reindex_progress' => true,
                    'done' => false,
                    'phase' => 'orphans',
                    'orphan_batch' => $next_ob,
                    'product_offset' => 0,
                    'orphan_done' => $next_ob,
                    'orphan_total' => $num_ob,
                    'indexed_so_far' => 0,
                    'total_products' => count($curated),
                ]
            );

            return;
        }

        if ($product_offset >= count($curated)) {
            $this->finalize_curated_product_reindex(count($curated));
            wp_send_json_success(
                [
                    'reindex_progress' => true,
                    'done' => true,
                    'phase' => 'done',
                    'orphan_batch' => $num_ob,
                    'product_offset' => count($curated),
                    'indexed_so_far' => count($curated),
                    'total_products' => count($curated),
                    'message' => __('Reindex of listed products complete.', 'wp-ai-ebot'),
                    'index_status' => $this->reindex_ajax_index_status_payload(),
                ]
            );

            return;
        }

        $ids = array_slice($curated, $product_offset, $progress_batch);
        $items = [];
        foreach ($ids as $pid) {
            $p = $this->build_product_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        foreach (array_chunk($items, $api_chunk) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
            ]);
            if (! $result['ok']) {
                Status::record_ingest_result(false, $result['body'], []);

                wp_send_json_error(
                    ['message' => __('The AI service did not accept a product batch. Check Overview → Status.', 'wp-ai-ebot')],
                    502
                );

                return;
            }
            Status::record_ingest_result($result['ok'], $result['body'], []);
        }

        $next_po = $product_offset + count($ids);
        wp_send_json_success(
            [
                'reindex_progress' => true,
                'done' => false,
                'phase' => 'products',
                'orphan_batch' => $num_ob,
                'product_offset' => $next_po,
                'orphan_done' => $num_ob,
                'orphan_total' => $num_ob,
                'indexed_so_far' => min($next_po, count($curated)),
                'total_products' => count($curated),
            ]
        );
    }

    /**
     * @param array<string, mixed> $state Background job row from {@see Background_Reindex::OPTION}.
     *
     * @return array{ok: bool, finished?: bool, state?: array<string, mixed>, fail_message?: string}
     */
    public function background_curated_tick(array $state): array
    {
        if (! $this->should_sync()) {
            return ['ok' => false, 'fail_message' => __('Sync is not configured.', 'wp-ai-ebot')];
        }

        $csv = (string) ($state['curated_csv'] ?? '');
        $curated = array_values(array_unique(array_filter(array_map('absint', explode(',', $csv)), static fn (int $id): bool => $id > 0)));
        sort($curated);
        if ($curated === []) {
            return ['ok' => false, 'fail_message' => __('Curated list was empty.', 'wp-ai-ebot')];
        }

        $del_batch = (int) apply_filters('ai_ebot_curated_reindex_orphan_delete_batch', 50);
        $del_batch = max(1, min(120, $del_batch));
        $progress_batch = (int) apply_filters('ai_ebot_reindex_progress_batch_size', 8);
        $progress_batch = max(1, min(40, $progress_batch));
        $api_chunk = (int) apply_filters('ai_ebot_full_reindex_batch_size', 12);
        $api_chunk = max(1, min(80, $api_chunk));

        $orphan_ids = $this->orphan_product_external_ids($curated);
        $num_ob = (int) ceil(count($orphan_ids) / $del_batch);
        $orphan_batch = (int) ($state['orphan_batch'] ?? 0);
        $product_offset = (int) ($state['product_offset'] ?? 0);
        $client = new Server_Client();

        if ($orphan_batch < $num_ob) {
            $slice = array_slice($orphan_ids, $orphan_batch * $del_batch, $del_batch);
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => $slice,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], ['curated_reindex_orphans' => count($slice)]);
            if (! $result['ok']) {
                return ['ok' => false, 'fail_message' => __('The AI service did not accept a delete batch.', 'wp-ai-ebot')];
            }
            $state['orphan_batch'] = $orphan_batch + 1;
            $state['message'] = sprintf(
                /* translators: 1: orphan delete pass, 2: total passes */
                __('Cleaning old catalog products from AI index (%1$d of %2$d)…', 'wp-ai-ebot'),
                (int) $state['orphan_batch'],
                $num_ob
            );
            $state['updated_at'] = time();

            return ['ok' => true, 'finished' => false, 'state' => $state];
        }

        if ($product_offset >= count($curated)) {
            $this->finalize_curated_product_reindex(count($curated));

            return ['ok' => true, 'finished' => true, 'state' => $state];
        }

        $ids = array_slice($curated, $product_offset, $progress_batch);
        $items = [];
        foreach ($ids as $pid) {
            $p = $this->build_product_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        foreach (array_chunk($items, $api_chunk) as $chunk) {
            $result = $client->ingest([
                'items' => $chunk,
                'delete_external_ids' => [],
            ]);
            if (! $result['ok']) {
                Status::record_ingest_result(false, $result['body'], []);

                return ['ok' => false, 'fail_message' => __('The AI service did not accept a product batch.', 'wp-ai-ebot')];
            }
            Status::record_ingest_result($result['ok'], $result['body'], []);
        }

        $state['product_offset'] = $product_offset + count($ids);
        $state['message'] = sprintf(
            /* translators: 1: products processed, 2: total in list */
            __('%1$d of %2$d listed products sent…', 'wp-ai-ebot'),
            min((int) $state['product_offset'], count($curated)),
            count($curated)
        );
        $state['updated_at'] = time();

        return ['ok' => true, 'finished' => false, 'state' => $state];
    }

    private function finalize_curated_product_reindex(int $listed_count): void
    {
        (new Server_Client())->heartbeat(Telemetry::site_metadata());
        Status::record_ingest_result(
            true,
            ['indexed_product_count' => $listed_count],
            [
                'full_reindex' => true,
                'product_count' => $listed_count,
            ]
        );
    }

    /**
     * @return list<int>
     */
    private function all_published_product_ids(): array
    {
        $q = new \WP_Query([
            'post_type' => 'product',
            'post_status' => 'publish',
            'posts_per_page' => -1,
            'fields' => 'ids',
            'orderby' => 'ID',
            'order' => 'ASC',
        ]);

        return array_values(array_map('intval', is_array($q->posts) ? $q->posts : []));
    }

    /**
     * Published products not in the curated AI list (candidates to remove from vector index).
     *
     * @param list<int> $curated_int
     *
     * @return list<string>
     */
    private function orphan_product_external_ids(array $curated_int): array
    {
        $pub = $this->all_published_product_ids();
        $diff = array_values(array_diff($pub, $curated_int));

        return array_map(static fn (int $id): string => 'product:' . $id, $diff);
    }

    private function ajax_catalog_remove_all(): void
    {
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected.', 'wp-ai-ebot'),
                ],
                400
            );

            return;
        }

        $curated_int = array_values(array_map('intval', Catalog_Index_Tab::get_curated_product_ids()));
        if ($curated_int === []) {
            wp_send_json_success([
                'message' => __('The AI index list is already empty.', 'wp-ai-ebot'),
                'curated_count' => 0,
            ]);

            return;
        }

        $delete_external_ids = array_map(static fn (int $pid): string => 'product:' . $pid, $curated_int);
        $chunk = (int) apply_filters('ai_ebot_curated_bulk_delete_batch', 80);
        $chunk = max(1, min(150, $chunk));
        $client = new Server_Client();

        foreach (array_chunk($delete_external_ids, $chunk) as $batch) {
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => $batch,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'curated_remove_all' => count($batch),
            ]);
            if (! $result['ok']) {
                wp_send_json_error(
                    ['message' => __('Could not remove all products from the AI index. Nothing was changed.', 'wp-ai-ebot')],
                    502
                );

                return;
            }
        }

        Catalog_Index_Tab::save_curated_csv([]);

        wp_send_json_success(
            [
                'message' => __(
                    'All listed products were removed from the AI product index and the list was cleared.',
                    'wp-ai-ebot'
                ),
                'curated_count' => 0,
            ]
        );
    }

    /**
     * Remove every chunk for this tenant on the AI service (same as ingest full_reindex flag + empty items).
     * Clears the Product index curated list locally and cancels background reindex.
     */
    public function ajax_clear_vector_index(): void
    {
        check_ajax_referer('ai_ebot_clear_vector_index', 'nonce');
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('Connect AI Ebot on Overview before clearing the index.', 'wp-ai-ebot'),
                ],
                400
            );

            return;
        }

        $result = (new Server_Client())->ingest([
            'full_reindex' => true,
            'items' => [],
        ]);
        Status::record_ingest_result($result['ok'], $result['body'], ['clear_vector_index' => true]);
        if (! $result['ok']) {
            $msg = __('The AI service could not clear the index. Check Overview → Status.', 'wp-ai-ebot');
            if (is_array($result['body']) && isset($result['body']['error'])) {
                $msg .= ' ' . (string) $result['body']['error'];
            }
            wp_send_json_error(['message' => $msg], 502);

            return;
        }

        Catalog_Index_Tab::save_curated_csv([]);
        delete_option(Status::OPT_LAST_FULL_REINDEX_AT);
        delete_option(Background_Reindex::OPTION);
        delete_transient('ai_ebot_bg_reindex_lock');
        wp_clear_scheduled_hook(Background_Reindex::CRON_HOOK);

        wp_send_json_success(
            [
                'message' => __(
                    'All indexed chunks for this site were removed on the AI service. The Product index list and background reindex job were cleared. Use the Product index tab when you want to send products again.',
                    'wp-ai-ebot'
                ),
                'index_status' => $this->reindex_ajax_index_status_payload(),
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
     * Synced pages, site blurb, and custom knowledge chunks (after all products).
     *
     * @return list<array<string, mixed>>
     */
    private function build_extras_items(): array
    {
        $items = [];
        $items[] = $this->build_assistant_behavior_item();

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
     * Single ingest item: assistant tone/instructions for RAG (external_id assistant:behavior).
     *
     * @return array<string, mixed>
     */
    private function build_assistant_behavior_item(): array
    {
        $tone = Tone::effective_tone();
        $strict = (bool) get_option('ai_ebot_strict_grounding', true);
        $parts = [];
        if ($tone !== '') {
            $parts[] = $tone;
        }
        $parts[] = $strict
            ? __(
                'Factual policy: Ground answers in retrieved store content when it is relevant; do not invent product or policy details that are not supported by context.',
                'wp-ai-ebot'
            )
            : __(
                'Factual policy: Strict grounding is disabled for this site — you may use general knowledge where helpful, while still preferring retrieved store content for product specifics.',
                'wp-ai-ebot'
            );

        $text = trim(implode("\n\n", array_filter($parts)));
        if ($text === '') {
            $text = __('Assistant behavior for this storefront (no extra instructions configured).', 'wp-ai-ebot');
        }

        return [
            'external_id' => 'assistant:behavior',
            'source_type' => 'custom',
            'source_id' => '0',
            'url' => home_url('/'),
            'title' => __('Assistant behavior', 'wp-ai-ebot'),
            'text' => $text,
            'metadata' => [
                'kind' => 'assistant_behavior',
                'strict_grounding' => $strict,
            ],
        ];
    }

    /**
     * Assistant tab: save tone options and push assistant:behavior to the AI index.
     */
    public function ajax_assistant_save_index(): void
    {
        if (! check_ajax_referer('ai_ebot_assistant_index', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }

        $settings = Settings::instance();

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $preset_raw = isset($_POST[Tone::OPT_PRESET]) ? (string) wp_unslash($_POST[Tone::OPT_PRESET]) : 'custom';
        update_option(Tone::OPT_PRESET, $settings->sanitize_tone_preset($preset_raw));

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $tone_raw = isset($_POST['ai_ebot_tone']) ? (string) wp_unslash($_POST['ai_ebot_tone']) : '';
        update_option('ai_ebot_tone', sanitize_textarea_field($tone_raw));

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $strict = isset($_POST['ai_ebot_strict_grounding']) && (string) wp_unslash($_POST['ai_ebot_strict_grounding']) === '1';
        update_option('ai_ebot_strict_grounding', $strict);

        if (! $this->should_sync()) {
            wp_send_json_success(
                [
                    'indexed' => false,
                    'message' => __('Settings saved. Connect AI Ebot on Overview to sync behavior to the index.', 'wp-ai-ebot'),
                ]
            );

            return;
        }

        $item = $this->build_assistant_behavior_item();
        $result = (new Server_Client())->ingest([
            'items' => [$item],
            'delete_external_ids' => [],
        ]);
        Status::record_ingest_result($result['ok'], $result['body'], ['assistant_behavior' => 1]);

        if (! $result['ok']) {
            wp_send_json_error(
                [
                    'message' => __(
                        'Settings were saved, but the AI service did not accept the behavior update. Check Overview → Status for the last sync error.',
                        'wp-ai-ebot'
                    ),
                ],
                502
            );

            return;
        }

        wp_send_json_success(
            [
                'indexed' => true,
                'message' => __('Settings saved and assistant behavior sent to the AI index.', 'wp-ai-ebot'),
            ]
        );
    }

    private function should_sync(): bool
    {
        return class_exists('WooCommerce') && (new Server_Client())->is_configured();
    }

    /**
     * Knowledge tab: save page ID list, remove dropped pages from index, then stepped ingest for newly added pages.
     */
    public function ajax_knowledge_pages_index(): void
    {
        if (! check_ajax_referer('ai_ebot_knowledge_pages', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected or WooCommerce is inactive. Complete setup on Overview.', 'wp-ai-ebot'),
                ],
                400
            );
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $phase = isset($_POST['phase']) ? sanitize_key((string) wp_unslash($_POST['phase'])) : '';
        if ($phase === 'init') {
            $this->ajax_knowledge_pages_index_init();

            return;
        }
        if ($phase === 'step') {
            $this->ajax_knowledge_pages_index_step();

            return;
        }

        wp_send_json_error(['message' => __('Invalid request.', 'wp-ai-ebot')], 400);
    }

    private function knowledge_pages_index_transient_key(): string
    {
        return 'ai_ebot_k_idx_' . get_current_user_id();
    }

    private function ajax_knowledge_pages_index_init(): void
    {
        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $new_raw = isset($_POST['page_ids_csv']) ? (string) wp_unslash($_POST['page_ids_csv']) : '';
        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $prev_raw = isset($_POST['previous_csv']) ? (string) wp_unslash($_POST['previous_csv']) : '';

        $settings = Settings::instance();
        $new_csv = $settings->sanitize_page_ids_csv($new_raw);
        $prev_csv = $settings->sanitize_page_ids_csv($prev_raw);

        $old_ids = self::parse_page_ids_csv_string($prev_csv);
        $new_ids = self::parse_page_ids_csv_string($new_csv);

        update_option('ai_ebot_sync_page_ids_csv', $new_csv);

        $removed = array_values(array_diff($old_ids, $new_ids));
        $to_add = array_values(array_diff($new_ids, $old_ids));

        $client = new Server_Client();
        if ($removed !== []) {
            $delete_external_ids = [];
            foreach ($removed as $rid) {
                $delete_external_ids[] = 'page:' . (int) $rid;
            }
            $result = $client->ingest([
                'items' => [],
                'delete_external_ids' => $delete_external_ids,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'knowledge_page_deletes' => count($delete_external_ids),
            ]);
            if (! $result['ok']) {
                wp_send_json_error(
                    ['message' => __('Could not remove deselected pages from the AI index.', 'wp-ai-ebot')],
                    502
                );

                return;
            }
        }

        $queue = [];
        foreach ($to_add as $pid) {
            $post = get_post((int) $pid);
            if ($post && $post->post_type === 'page' && $post->post_status === 'publish') {
                $queue[] = (int) $pid;
            }
        }

        if ($queue === []) {
            $msg = __('List saved.', 'wp-ai-ebot');
            if ($removed !== []) {
                $msg .= ' ' . sprintf(
                    /* translators: %d: number of pages removed from AI index */
                    _n('%d page removed from the AI index.', '%d pages removed from the AI index.', count($removed), 'wp-ai-ebot'),
                    count($removed)
                );
            }
            if ($to_add !== []) {
                $msg .= ' ' . __('New selections must be published pages before they can be indexed.', 'wp-ai-ebot');
            } else {
                $msg .= ' ' . __('No new pages to index.', 'wp-ai-ebot');
            }
            wp_send_json_success(
                [
                    'finished' => true,
                    'done' => 0,
                    'total' => 0,
                    'removed' => count($removed),
                    'message' => trim($msg),
                ]
            );

            return;
        }

        delete_transient($this->knowledge_pages_index_transient_key());
        set_transient(
            $this->knowledge_pages_index_transient_key(),
            [
                'queue' => $queue,
                'indexed' => 0,
                'total' => count($queue),
            ],
            15 * MINUTE_IN_SECONDS
        );

        wp_send_json_success(
            [
                'finished' => false,
                'done' => 0,
                'total' => count($queue),
                'removed' => count($removed),
                'message' => '',
            ]
        );
    }

    private function ajax_knowledge_pages_index_step(): void
    {
        $key = $this->knowledge_pages_index_transient_key();
        $state = get_transient($key);
        if (! is_array($state) || ! isset($state['queue']) || ! is_array($state['queue'])) {
            wp_send_json_error(
                ['message' => __('Indexing session expired. Click Save and index again.', 'wp-ai-ebot')],
                400
            );

            return;
        }

        $batch = (int) apply_filters('ai_ebot_knowledge_pages_ingest_batch', 2);
        $batch = max(1, min(8, $batch));

        $queue = $state['queue'];
        $slice = array_splice($queue, 0, $batch);
        $items = [];
        foreach ($slice as $pid) {
            $p = $this->build_page_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        if ($items !== []) {
            $result = (new Server_Client())->ingest([
                'items' => $items,
                'delete_external_ids' => [],
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'knowledge_pages' => count($items),
            ]);
            if (! $result['ok']) {
                array_unshift($queue, ...$slice);
                set_transient(
                    $key,
                    [
                        'queue' => $queue,
                        'indexed' => (int) ($state['indexed'] ?? 0),
                        'total' => (int) ($state['total'] ?? count($queue)),
                    ],
                    15 * MINUTE_IN_SECONDS
                );
                wp_send_json_error(
                    ['message' => __('The AI service rejected this batch. Check Overview → Status for the last sync error.', 'wp-ai-ebot')],
                    502
                );

                return;
            }
        }

        $indexed = (int) ($state['indexed'] ?? 0) + count($slice);
        $total = (int) ($state['total'] ?? $indexed);

        if ($queue === []) {
            delete_transient($key);
            wp_send_json_success(
                [
                    'finished' => true,
                    'done' => $indexed,
                    'total' => $total,
                    'message' => __('Finished indexing pages.', 'wp-ai-ebot'),
                ]
            );

            return;
        }

        set_transient(
            $key,
            [
                'queue' => $queue,
                'indexed' => $indexed,
                'total' => $total,
            ],
            15 * MINUTE_IN_SECONDS
        );

        wp_send_json_success(
            [
                'finished' => false,
                'done' => $indexed,
                'total' => $total,
                'message' => '',
            ]
        );
    }

    /**
     * @return list<int>
     */
    private static function parse_page_ids_csv_string(string $csv): array
    {
        $csv = trim($csv);
        if ($csv === '') {
            return [];
        }
        $parts = array_filter(array_map('absint', explode(',', $csv)));

        return array_values(array_unique($parts));
    }

    public function can_sync(): bool
    {
        return $this->should_sync();
    }

    /**
     * Scope for background / UI progress: **AI index list** count (not whole catalog).
     *
     * @return array{total: int, published: int, capped: bool}
     */
    public function get_curated_reindex_scope(): array
    {
        $curated = Catalog_Index_Tab::get_curated_product_ids();
        $published = Status::published_product_count();

        return [
            'total' => count($curated),
            'published' => $published,
            'capped' => false,
        ];
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

        $cats = [];
        if (taxonomy_exists('product_cat')) {
            $c = wc_get_product_terms($product_id, 'product_cat', ['fields' => 'names']);
            if (is_array($c)) {
                $cats = array_values(array_unique(array_filter(array_map('strval', $c))));
            }
        }
        // Brands: support common taxonomies (product_brand) and brand attribute taxonomy (pa_brand).
        $brands = [];
        $brandTax = taxonomy_exists('product_brand') ? 'product_brand' : (taxonomy_exists('pa_brand') ? 'pa_brand' : '');
        if ($brandTax !== '') {
            $b = wc_get_product_terms($product_id, $brandTax, ['fields' => 'names']);
            if (is_array($b)) {
                $brands = array_values(array_unique(array_filter(array_map('strval', $b))));
            }
        }
        $price_text = $this->plain_text($product->get_price_html());
        $stock_text = $product->is_in_stock() ? 'In stock' : 'Out of stock';

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
                'price_text' => $price_text,
                'stock_text' => $stock_text,
                'categories' => $cats,
                'brands' => $brands,
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

    /**
     * Product index tab: curated send (init/step) or remove from index.
     */
    public function ajax_catalog_index(): void
    {
        if (! check_ajax_referer('ai_ebot_catalog_index', 'nonce', false)) {
            wp_send_json_error(['message' => __('Invalid security token.', 'wp-ai-ebot')], 403);
        }
        if (! current_user_can('manage_options')) {
            wp_send_json_error(['message' => __('Forbidden.', 'wp-ai-ebot')], 403);
        }
        if (! class_exists('WooCommerce')) {
            wp_send_json_error(['message' => __('WooCommerce is required.', 'wp-ai-ebot')], 400);
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $sub = isset($_POST['sub_action']) ? sanitize_key((string) wp_unslash($_POST['sub_action'])) : '';

        if ($sub === 'send_init') {
            $this->ajax_catalog_send_init();

            return;
        }
        if ($sub === 'send_step') {
            $this->ajax_catalog_send_step();

            return;
        }
        if ($sub === 'remove') {
            $this->ajax_catalog_remove();

            return;
        }
        if ($sub === 'remove_all') {
            $this->ajax_catalog_remove_all();

            return;
        }

        wp_send_json_error(['message' => __('Invalid request.', 'wp-ai-ebot')], 400);
    }

    private function catalog_ingest_transient_key(): string
    {
        return 'ai_ebot_cating_' . get_current_user_id();
    }

    /**
     * @return int|null null if unknown; 0 = unlimited
     */
    private function catalog_max_indexed_for_plan(): ?int
    {
        $snap = Status::fetch_billing_snapshot();
        if (! is_array($snap) || ! array_key_exists('max_indexed_products', $snap)) {
            return null;
        }

        return (int) $snap['max_indexed_products'];
    }

    private function ajax_catalog_send_init(): void
    {
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected. Complete setup on Overview.', 'wp-ai-ebot'),
                ],
                400
            );

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $raw_ids = isset($_POST['product_ids']) ? (string) wp_unslash($_POST['product_ids']) : '';
        $add_candidates = array_filter(array_map('absint', explode(',', $raw_ids)));

        $curated = Catalog_Index_Tab::get_curated_product_ids();
        $curated_set = array_fill_keys($curated, true);

        $to_add = [];
        foreach ($add_candidates as $pid) {
            if ($pid <= 0 || isset($curated_set[$pid])) {
                continue;
            }
            $post = get_post($pid);
            if (! $post || $post->post_type !== 'product' || $post->post_status !== 'publish') {
                continue;
            }
            $to_add[] = $pid;
        }
        $to_add = array_values(array_unique($to_add));

        if ($to_add === []) {
            wp_send_json_success(
                [
                    'finished' => true,
                    'total' => 0,
                    'message' => __('Nothing new to add (already in the list or not a published product).', 'wp-ai-ebot'),
                ]
            );

            return;
        }

        $max = $this->catalog_max_indexed_for_plan();
        $curated_count = count($curated);
        $truncated = false;

        if ($max !== null && $max > 0) {
            $slots = $max - $curated_count;
            if ($slots <= 0) {
                wp_send_json_error(
                    [
                        'message' => __(
                            'Your plan’s product index limit is reached. Remove products from the AI list or upgrade your plan.',
                            'wp-ai-ebot'
                        ),
                    ],
                    400
                );

                return;
            }
            if (count($to_add) > $slots) {
                $to_add = array_slice($to_add, 0, $slots);
                $truncated = true;
            }
        }

        $new_curated = array_values(array_unique(array_merge($curated, $to_add)));

        delete_transient($this->catalog_ingest_transient_key());
        set_transient(
            $this->catalog_ingest_transient_key(),
            [
                'queue' => $to_add,
                'merged_curated' => $new_curated,
                'indexed' => 0,
                'total' => count($to_add),
                'truncated' => $truncated,
            ],
            15 * MINUTE_IN_SECONDS
        );

        wp_send_json_success(
            [
                'finished' => false,
                'total' => count($to_add),
                'truncated' => $truncated,
                'notice' => $truncated
                    ? __('Some selected products were skipped because of your plan limit.', 'wp-ai-ebot')
                    : '',
            ]
        );
    }

    private function ajax_catalog_send_step(): void
    {
        if (! $this->should_sync()) {
            wp_send_json_error(['message' => __('Not connected.', 'wp-ai-ebot')], 400);

            return;
        }

        $key = $this->catalog_ingest_transient_key();
        $state = get_transient($key);
        if (! is_array($state) || empty($state['queue']) || ! is_array($state['queue'])) {
            wp_send_json_error(['message' => __('Indexing session expired. Try Send to AI again.', 'wp-ai-ebot')], 400);

            return;
        }

        $batch = (int) apply_filters('ai_ebot_curated_product_ingest_batch', 2);
        $batch = max(1, min(8, $batch));

        $queue = $state['queue'];
        $slice = array_splice($queue, 0, $batch);
        $items = [];
        foreach ($slice as $pid) {
            $p = $this->build_product_payload((int) $pid);
            if ($p !== null) {
                $items[] = $p;
            }
        }

        if ($items !== []) {
            $result = (new Server_Client())->ingest([
                'items' => $items,
                'delete_external_ids' => [],
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'curated_products' => count($items),
            ]);
            if (! $result['ok']) {
                if ($slice !== []) {
                    array_unshift($queue, ...$slice);
                }
                set_transient(
                    $key,
                    [
                        'queue' => $queue,
                        'merged_curated' => $state['merged_curated'] ?? [],
                        'indexed' => (int) ($state['indexed'] ?? 0),
                        'total' => (int) ($state['total'] ?? count($queue)),
                        'truncated' => ! empty($state['truncated']),
                    ],
                    15 * MINUTE_IN_SECONDS
                );
                wp_send_json_error(
                    ['message' => __('The AI service rejected this batch. Check Overview → Status.', 'wp-ai-ebot')],
                    502
                );

                return;
            }
        }

        $indexed = (int) ($state['indexed'] ?? 0) + count($slice);
        $total = (int) ($state['total'] ?? $indexed);

        if ($queue === []) {
            delete_transient($key);
            if (isset($state['merged_curated']) && is_array($state['merged_curated'])) {
                Catalog_Index_Tab::save_curated_csv($state['merged_curated']);
            }
            wp_send_json_success(
                [
                    'finished' => true,
                    'done' => $indexed,
                    'total' => $total,
                    'truncated' => ! empty($state['truncated']),
                    'message' => __('Products sent to the AI index.', 'wp-ai-ebot'),
                ]
            );

            return;
        }

        set_transient(
            $key,
            [
                'queue' => $queue,
                'merged_curated' => $state['merged_curated'] ?? [],
                'indexed' => $indexed,
                'total' => $total,
                'truncated' => ! empty($state['truncated']),
            ],
            15 * MINUTE_IN_SECONDS
        );

        wp_send_json_success(
            [
                'finished' => false,
                'done' => $indexed,
                'total' => $total,
            ]
        );
    }

    private function ajax_catalog_remove(): void
    {
        if (! $this->should_sync()) {
            wp_send_json_error(
                [
                    'code' => 'not_configured',
                    'message' => __('AI Ebot is not connected.', 'wp-ai-ebot'),
                ],
                400
            );

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Missing
        $raw_ids = isset($_POST['product_ids']) ? (string) wp_unslash($_POST['product_ids']) : '';
        $remove = array_values(array_unique(array_filter(array_map('absint', explode(',', $raw_ids)))));
        if ($remove === []) {
            wp_send_json_success(['message' => __('Nothing selected.', 'wp-ai-ebot')]);

            return;
        }

        $curated_int = array_values(array_map('intval', Catalog_Index_Tab::get_curated_product_ids()));
        $remove_int = array_values(
            array_unique(array_filter(array_map('intval', $remove), static fn (int $id): bool => $id > 0))
        );
        /** @var list<int> */
        $to_purge = array_values(array_intersect($curated_int, $remove_int));
        $new = array_values(array_diff($curated_int, $remove_int));
        Catalog_Index_Tab::save_curated_csv($new);

        $delete_external_ids = array_map(
            static fn (int $pid): string => 'product:' . $pid,
            $to_purge
        );

        if ($delete_external_ids !== []) {
            $result = (new Server_Client())->ingest([
                'items' => [],
                'delete_external_ids' => $delete_external_ids,
            ]);
            Status::record_ingest_result($result['ok'], $result['body'], [
                'curated_product_deletes' => count($delete_external_ids),
            ]);
            if (! $result['ok']) {
                Catalog_Index_Tab::save_curated_csv($curated_int);
                wp_send_json_error(['message' => __('Could not remove products from the AI index. List was not changed.', 'wp-ai-ebot')], 502);

                return;
            }
        }

        wp_send_json_success(
            [
                'message' => __('Removed from the list and from the AI index.', 'wp-ai-ebot'),
                'curated_count' => count($new),
            ]
        );
    }
}
