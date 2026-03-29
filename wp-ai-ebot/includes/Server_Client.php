<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * HTTP client for the AI Ebot server API (registration, ingest, chat proxy server-side).
 */
final class Server_Client
{
    private string $base_url;
    private string $api_key;
    private string $tenant_id;

    public function __construct(?string $base_url = null, ?string $api_key = null, ?string $tenant_id = null)
    {
        $resolved = $base_url !== null && $base_url !== ''
            ? $base_url
            : Config::server_base_url();
        $this->base_url = rtrim((string) $resolved, '/');
        $this->api_key = (string) ($api_key ?? Config::stored_service_api_key());
        $this->tenant_id = (string) ($tenant_id ?? get_option('ai_ebot_tenant_id', ''));
    }

    public function is_configured(): bool
    {
        return $this->base_url !== '' && $this->api_key !== '' && $this->tenant_id !== '';
    }

    /**
     * GET /health on the service base URL (no authentication).
     *
     * @return array{ok: bool, code: int}
     */
    public function fetch_service_health(): array
    {
        $base = rtrim($this->base_url !== '' ? $this->base_url : Config::server_base_url(), '/');
        if ($base === '') {
            return ['ok' => false, 'code' => 0];
        }

        $url = $base . '/health';
        $response = wp_remote_get(
            $url,
            [
                'timeout' => 8,
                'headers' => [
                    'Accept' => 'application/json',
                ],
            ]
        );

        if (is_wp_error($response)) {
            return ['ok' => false, 'code' => 0];
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        if ($code < 200 || $code >= 300) {
            return ['ok' => false, 'code' => $code];
        }

        $raw = (string) wp_remote_retrieve_body($response);
        $decoded = json_decode($raw, true);
        if (is_array($decoded) && array_key_exists('ok', $decoded)) {
            return ['ok' => (bool) $decoded['ok'], 'code' => $code];
        }

        return ['ok' => true, 'code' => $code];
    }

    /**
     * @param array<string, mixed> $body
     * @param array<string, string> $extra_headers
     * @return array{ok: bool, code: int, body: mixed, raw: string}
     */
    public function post(string $path, array $body, int $timeout = 60, bool $with_auth = true, array $extra_headers = []): array
    {
        $url = $this->base_url . $path;
        $headers = array_merge(
            [
                'Content-Type' => 'application/json',
            ],
            $extra_headers
        );
        if ($with_auth) {
            $headers['X-Tenant-Id'] = $this->tenant_id;
            $headers['Authorization'] = 'Bearer ' . $this->api_key;
        }

        $args = [
            'timeout' => $timeout,
            'headers' => $headers,
            'body' => wp_json_encode($body),
        ];

        $response = wp_remote_post($url, $args);
        if (is_wp_error($response)) {
            return [
                'ok' => false,
                'code' => 0,
                'body' => $response->get_error_message(),
                'raw' => '',
            ];
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $raw = (string) wp_remote_retrieve_body($response);
        $decoded = json_decode($raw, true);

        return [
            'ok' => $code >= 200 && $code < 300,
            'code' => $code,
            'body' => $decoded !== null ? $decoded : $raw,
            'raw' => $raw,
        ];
    }

    /**
     * Authenticated GET (e.g. tenant billing).
     *
     * @return array{ok: bool, code: int, body: mixed, raw: string}
     */
    public function get(string $path, int $timeout = 15, bool $with_auth = true): array
    {
        $url = $this->base_url . $path;
        $headers = [
            'Accept' => 'application/json',
        ];
        if ($with_auth) {
            $headers['X-Tenant-Id'] = $this->tenant_id;
            $headers['Authorization'] = 'Bearer ' . $this->api_key;
        }

        $response = wp_remote_get(
            $url,
            [
                'timeout' => $timeout,
                'headers' => $headers,
            ]
        );

        if (is_wp_error($response)) {
            return [
                'ok' => false,
                'code' => 0,
                'body' => $response->get_error_message(),
                'raw' => '',
            ];
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $raw = (string) wp_remote_retrieve_body($response);
        $decoded = json_decode($raw, true);

        return [
            'ok' => $code >= 200 && $code < 300,
            'code' => $code,
            'body' => $decoded !== null ? $decoded : $raw,
            'raw' => $raw,
        ];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{ok: bool, code: int, body: mixed}
     */
    public function register_site(array $payload): array
    {
        $r = $this->post('/v1/register', $payload, 30, false);
        return ['ok' => $r['ok'], 'code' => $r['code'], 'body' => $r['body']];
    }

    /**
     * @param array<string, mixed> $batch
     * @return array{ok: bool, code: int, body: mixed}
     */
    public function ingest(array $batch): array
    {
        /** Ingest runs embeddings server-side; allow hosts to raise cap (30–600s). */
        $timeout = (int) apply_filters('ai_ebot_ingest_request_timeout', 300);
        $timeout = max(30, min(600, $timeout));
        $r = $this->post('/v1/ingest', $batch, $timeout);
        return ['ok' => $r['ok'], 'code' => $r['code'], 'body' => $r['body']];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{ok: bool, code: int, body: mixed}
     */
    public function chat(array $payload): array
    {
        $r = $this->post('/v1/chat', $payload, 90);
        return ['ok' => $r['ok'], 'code' => $r['code'], 'body' => $r['body']];
    }

    /**
     * @param array<string, string> $metadata site_name, plugin_version, wp_version, optional wc_version
     * @return array{ok: bool, code: int, body: mixed}
     */
    public function heartbeat(array $metadata): array
    {
        $r = $this->post('/v1/heartbeat', $metadata, 15);
        return ['ok' => $r['ok'], 'code' => $r['code'], 'body' => $r['body']];
    }
}
