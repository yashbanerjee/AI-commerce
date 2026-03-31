<?php

/**
 * Fired when the plugin is uninstalled (deleted).
 *
 * @package AI_Ebot
 */

declare(strict_types=1);

if (! defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

/**
 * Remove options, transients, and chat tables for the current site (blog).
 */
function ai_ebot_uninstall_single_site(): void
{
    global $wpdb;

    $options = [
        'ai_ebot_site_secret',
        'ai_ebot_server_api_key',
        'ai_ebot_cloud_api_key',
        'ai_ebot_tenant_id',
        'ai_ebot_tone',
        'ai_ebot_tone_preset',
        'ai_ebot_strict_grounding',
        'ai_ebot_sync_page_ids_csv',
        'ai_ebot_curated_product_ids_csv',
        'ai_ebot_custom_chunks',
        'ai_ebot_db_version',
        'ai_ebot_chat_title',
        'ai_ebot_chat_accent',
        'ai_ebot_last_ingest_at',
        'ai_ebot_last_ingest_ok',
        'ai_ebot_last_ingest_error',
        'ai_ebot_products_indexed',
        'ai_ebot_last_full_reindex_at',
        'ai_ebot_bg_reindex',
    ];

    foreach ($options as $opt) {
        delete_option($opt);
    }

    $transients = [
        'ai_ebot_heartbeat_sent',
        'ai_ebot_connect_err',
        'ai_ebot_activation_register_status',
        'ai_ebot_bg_reindex_lock',
        'ai_ebot_bg_reindex_last_ok',
    ];

    foreach ($transients as $t) {
        delete_transient($t);
    }

    // Billing snapshot cache keys like _transient_ai_ebot_billing_v1_* (underscores escaped for SQL LIKE).
    // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name from $wpdb->options
    $wpdb->query(
        $wpdb->prepare(
            "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
            $wpdb->esc_like('_transient_ai_ebot') . '%',
            $wpdb->esc_like('_transient_timeout_ai_ebot') . '%'
        )
    );
    // phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

    $sessions = $wpdb->prefix . 'ai_ebot_chat_sessions';
    $messages = $wpdb->prefix . 'ai_ebot_chat_messages';
    // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- prefixed table names
    $wpdb->query("DROP TABLE IF EXISTS `{$messages}`");
    $wpdb->query("DROP TABLE IF EXISTS `{$sessions}`");
    // phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
}

if (is_multisite()) {
    $sites = get_sites(['number' => 0]);
    foreach ($sites as $site) {
        switch_to_blog((int) $site->blog_id);
        ai_ebot_uninstall_single_site();
        restore_current_blog();
    }
} else {
    ai_ebot_uninstall_single_site();
}
