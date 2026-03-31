<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Main plugin bootstrap.
 */
final class Plugin
{
    private static ?self $instance = null;

    public static function instance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    public function init(): void
    {
        Config::maybe_migrate_legacy_options();
        Privacy::init();
        Telemetry::init();
        Catalog_Context::init();

        if (is_admin()) {
            Admin\Settings::instance()->init();
            Admin\Chat_Sessions_Page::init();
        }

        Sync::instance()->init();
        Background_Reindex::init();
        Rest::instance()->init();
        Shortcode::instance()->init();
        Block::register();
    }
}
