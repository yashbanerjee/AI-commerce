<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * AI Ebot server (API) base URL — not shown in wp-admin; override for production.
 */
final class Config
{
    /**
     * Default production API (Railway). Override for local dev with AI_EBOT_SERVER_BASE_URL in wp-config
     * (or legacy AI_EBOT_CLOUD_BASE_URL), e.g. http://host.docker.internal:8787 or http://127.0.0.1:8787.
     * Filters: ai_ebot_server_base_url, ai_ebot_cloud_base_url.
     */
    private const DEFAULT_SERVER_BASE_URL = 'https://ai-commerce-production.up.railway.app';

    public const OPT_SERVER_API_KEY = 'ai_ebot_server_api_key';

    /** @deprecated Use OPT_SERVER_API_KEY; still read for migration. */
    private const LEGACY_OPT_CLOUD_API_KEY = 'ai_ebot_cloud_api_key';

    /**
     * Copies legacy option ai_ebot_cloud_api_key → ai_ebot_server_api_key once.
     */
    public static function maybe_migrate_legacy_options(): void
    {
        $current = (string) get_option(self::OPT_SERVER_API_KEY, '');
        $legacy = (string) get_option(self::LEGACY_OPT_CLOUD_API_KEY, '');
        if ($current === '' && $legacy !== '') {
            update_option(self::OPT_SERVER_API_KEY, $legacy);
        }
    }

    public static function server_base_url(): string
    {
        $base = self::DEFAULT_SERVER_BASE_URL;
        if (defined('AI_EBOT_SERVER_BASE_URL') && is_string(AI_EBOT_SERVER_BASE_URL) && AI_EBOT_SERVER_BASE_URL !== '') {
            $base = AI_EBOT_SERVER_BASE_URL;
        } elseif (defined('AI_EBOT_CLOUD_BASE_URL') && is_string(AI_EBOT_CLOUD_BASE_URL) && AI_EBOT_CLOUD_BASE_URL !== '') {
            $base = AI_EBOT_CLOUD_BASE_URL;
        }
        $url = (string) apply_filters('ai_ebot_cloud_base_url', $base);
        $url = (string) apply_filters('ai_ebot_server_base_url', $url);

        return rtrim($url, '/');
    }

    public static function has_server_endpoint(): bool
    {
        return self::server_base_url() !== '';
    }

    /**
     * Service API key from registration (Bearer token for /v1/*).
     */
    public static function stored_service_api_key(): string
    {
        $k = (string) get_option(self::OPT_SERVER_API_KEY, '');
        if ($k !== '') {
            return $k;
        }

        return (string) get_option(self::LEGACY_OPT_CLOUD_API_KEY, '');
    }
}
