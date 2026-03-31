<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Dashboard status: readiness and indexed product counts.
 */
final class Status
{
    public const OPT_LAST_INGEST_AT = 'ai_ebot_last_ingest_at';
    public const OPT_LAST_INGEST_OK = 'ai_ebot_last_ingest_ok';
    public const OPT_LAST_INGEST_ERROR = 'ai_ebot_last_ingest_error';
    public const OPT_PRODUCTS_INDEXED = 'ai_ebot_products_indexed';
    public const OPT_LAST_FULL_REINDEX_AT = 'ai_ebot_last_full_reindex_at';

    /**
     * Published products in WooCommerce (catalog size).
     */
    public static function published_product_count(): int
    {
        $c = wp_count_posts('product');
        if (! $c || ! isset($c->publish)) {
            return 0;
        }

        return (int) $c->publish;
    }

    /**
     * Products included in the last successful full reindex.
     */
    public static function indexed_product_count(): int
    {
        return (int) get_option(self::OPT_PRODUCTS_INDEXED, 0);
    }

    public static function is_woocommerce_active(): bool
    {
        return class_exists('WooCommerce');
    }

    public static function is_server_configured(): bool
    {
        return (new Server_Client())->is_configured();
    }

    /**
     * Tenant ID and service API key saved after registration (issued by the server).
     */
    public static function has_registered_credentials(): bool
    {
        return (string) get_option('ai_ebot_tenant_id', '') !== ''
            && Config::stored_service_api_key() !== '';
    }

    public static function tenant_id_display(): string
    {
        $id = (string) get_option('ai_ebot_tenant_id', '');

        return $id !== '' ? $id : '—';
    }

    /**
     * @return 'ready'|'setup'|'sync_needed'|'error'
     */
    public static function chatbot_state(): string
    {
        if (! self::is_woocommerce_active() || ! self::has_registered_credentials()) {
            return 'setup';
        }
        $lastAt = (int) get_option(self::OPT_LAST_INGEST_AT, 0);
        $lastOk = get_option(self::OPT_LAST_INGEST_OK);
        if ($lastAt > 0 && (string) $lastOk === '0') {
            return 'error';
        }
        if ((int) get_option(self::OPT_LAST_FULL_REINDEX_AT, 0) === 0) {
            return 'sync_needed';
        }

        return 'ready';
    }

    /**
     * @param array{full_reindex?: bool, product_count?: int} $context
     */
    public static function record_ingest_result(bool $ok, $body, array $context = []): void
    {
        $now = time();
        update_option(self::OPT_LAST_INGEST_AT, $now);
        update_option(self::OPT_LAST_INGEST_OK, $ok ? '1' : '0');

        if (! $ok) {
            $err = is_string($body) ? $body : '';
            if (is_array($body) && isset($body['error'])) {
                $err = (string) $body['error'];
            }
            if ($err === '') {
                $err = __('Ingest request failed.', 'wp-ai-ebot');
            }
            if (stripos($err, 'timed out') !== false || stripos($err, 'curl error 28') !== false) {
                $err .= ' ' . __(
                    'The API waits until embeddings finish before it replies, so large syncs used to hit WordPress’s HTTP limit. Reindex now runs in batches; also confirm your AI Ebot base URL is reachable from this server (Docker/network/firewall).',
                    'wp-ai-ebot'
                );
            }
            update_option(self::OPT_LAST_INGEST_ERROR, $err);
            return;
        }

        delete_option(self::OPT_LAST_INGEST_ERROR);

        $tid = (string) get_option('ai_ebot_tenant_id', '');
        if ($tid !== '') {
            self::invalidate_billing_cache($tid);
        }

        if (is_array($body) && isset($body['indexed_product_count'])) {
            update_option(self::OPT_PRODUCTS_INDEXED, max(0, (int) $body['indexed_product_count']));
        }

        if (! empty($context['full_reindex'])) {
            if (
                isset($context['product_count'])
                && (! is_array($body) || ! isset($body['indexed_product_count']))
            ) {
                update_option(self::OPT_PRODUCTS_INDEXED, max(0, (int) $context['product_count']));
            }
            update_option(self::OPT_LAST_FULL_REINDEX_AT, $now);
        }
    }

    public static function last_ingest_error_message(): string
    {
        return (string) get_option(self::OPT_LAST_INGEST_ERROR, '');
    }

    public static function last_full_reindex_human(): string
    {
        $t = (int) get_option(self::OPT_LAST_FULL_REINDEX_AT, 0);
        if ($t <= 0) {
            return '—';
        }

        return wp_date(
            get_option('date_format') . ' ' . get_option('time_format'),
            $t
        );
    }

    /**
     * Human-readable reason when chatbot_state is "setup".
     */
    public static function setup_message(): string
    {
        if (! self::is_woocommerce_active()) {
            return __('Activate WooCommerce to use AI Ebot.', 'wp-ai-ebot');
        }
        if (! self::has_registered_credentials()) {
            return __('Use Overview → Connect to AI Ebot to register this site. Your Site ID and service access are created automatically.', 'wp-ai-ebot');
        }

        return '';
    }

    /**
     * Cached GET /v1/tenant/billing for the Status screen (usage, plan, upgrade URLs).
     *
     * @return array<string, mixed>|null Decoded JSON or null if unavailable.
     */
    public static function fetch_billing_snapshot(): ?array
    {
        $client = new Server_Client();
        if (! $client->is_configured()) {
            return null;
        }

        $ttl = (int) apply_filters('ai_ebot_billing_snapshot_cache_ttl', 90);
        $ttl = max(0, min(600, $ttl));

        if ($ttl > 0) {
            $tid = (string) get_option('ai_ebot_tenant_id', '');
            $cache_key = 'ai_ebot_billing_v1_' . md5($tid);
            $cached = get_transient($cache_key);
            if (is_array($cached)) {
                return $cached;
            }
        }

        $r = $client->get('/v1/tenant/billing', 15);
        if (! $r['ok'] || ! is_array($r['body'])) {
            return null;
        }

        if ($ttl > 0 && isset($cache_key)) {
            set_transient($cache_key, $r['body'], $ttl);
        }

        return $r['body'];
    }

    /**
     * Drop billing cache for a tenant id (call before replacing credentials).
     */
    public static function invalidate_billing_cache(string $tenant_id): void
    {
        if ($tenant_id === '') {
            return;
        }
        delete_transient('ai_ebot_billing_v1_' . md5($tenant_id));
    }
}
