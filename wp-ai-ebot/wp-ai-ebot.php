<?php
/**
 * Plugin Name:       AI Ebot for WooCommerce
 * Description:       Storefront AI chat for WooCommerce via an AI Ebot-compatible API service. Requires external registration; does not guarantee legal compliance.
 * Version:           0.3.1
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            AI Ebot
 * License:           GPL-2.0-or-later
 * Text Domain:       wp-ai-ebot
 *
 * @package AI_Ebot
 */

declare(strict_types=1);

if (! defined('ABSPATH')) {
    exit;
}

define('AI_EBOT_VERSION', '0.3.1');
define('AI_EBOT_PLUGIN_FILE', __FILE__);
define('AI_EBOT_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('AI_EBOT_PLUGIN_URL', plugin_dir_url(__FILE__));

require_once AI_EBOT_PLUGIN_DIR . 'includes/autoload.php';

add_action('plugins_loaded', static function (): void {
    \AI_Ebot\Plugin::instance()->init();
});

register_activation_hook(__FILE__, static function (): void {
    if (! get_option('ai_ebot_site_secret')) {
        update_option('ai_ebot_site_secret', wp_generate_password(32, false, false));
    }
    \AI_Ebot\Chat_Store::activate();
    \AI_Ebot\Registration::on_activation();
});
