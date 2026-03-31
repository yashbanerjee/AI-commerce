<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

use AI_Ebot\Server_Client;
use AI_Ebot\Config;
use AI_Ebot\Status;
use AI_Ebot\Telemetry;
use AI_Ebot\Tone;

/**
 * Admin settings, registration, custom chunks, reindex.
 */
final class Settings
{
    private const OPTION_GROUP = 'ai_ebot_settings';

    /** @var list<string> */
    private const SETTINGS_TABS = ['overview', 'catalog-index', 'assistant', 'appearance', 'knowledge', 'sessions'];

    private const TAB_DEFAULT = 'overview';

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
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('admin_post_ai_ebot_save_connection', [$this, 'handle_save_connection']);
        add_action('admin_notices', [$this, 'admin_notices']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin_assets']);
    }

    public function enqueue_admin_assets(string $hook_suffix): void
    {
        if ($hook_suffix !== 'toplevel_page_ai-ebot') {
            return;
        }

        wp_enqueue_style(
            'ai-ebot-admin',
            AI_EBOT_PLUGIN_URL . 'public/css/admin.css',
            [],
            AI_EBOT_VERSION
        );

        wp_enqueue_script(
            'ai-ebot-admin',
            AI_EBOT_PLUGIN_URL . 'public/js/admin.js',
            [],
            AI_EBOT_VERSION,
            true
        );

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $tab = isset($_GET['tab']) ? sanitize_key((string) wp_unslash($_GET['tab'])) : 'overview';
        if ($tab === 'knowledge') {
            wp_enqueue_script(
                'ai-ebot-knowledge-pages',
                AI_EBOT_PLUGIN_URL . 'public/js/knowledge-pages.js',
                [],
                AI_EBOT_VERSION,
                true
            );
            wp_localize_script(
                'ai-ebot-knowledge-pages',
                'aiEbotKnowledgePages',
                [
                    'ajaxUrl' => admin_url('admin-ajax.php'),
                    'nonce' => wp_create_nonce('ai_ebot_knowledge_pages'),
                    'i18n' => [
                        'saving' => __('Saving list…', 'wp-ai-ebot'),
                        /* translators: 1: pages indexed so far, 2: total pages in this run */
                        'indexingProgress' => __('%1$d of %2$d pages sent to the AI index…', 'wp-ai-ebot'),
                        'success' => __('Done.', 'wp-ai-ebot'),
                        'errorGeneric' => __('Something went wrong.', 'wp-ai-ebot'),
                    ],
                ]
            );
        }

        if ($tab === 'catalog-index') {
            wp_enqueue_script(
                'ai-ebot-catalog-index',
                AI_EBOT_PLUGIN_URL . 'public/js/catalog-index.js',
                [],
                AI_EBOT_VERSION,
                true
            );
            wp_localize_script(
                'ai-ebot-catalog-index',
                'aiEbotCatalogIndex',
                [
                    'ajaxUrl' => admin_url('admin-ajax.php'),
                    'nonce' => wp_create_nonce('ai_ebot_catalog_index'),
                    'curatedReindexNonce' => wp_create_nonce('ai_ebot_curated_reindex'),
                    'storeStructureNonce' => wp_create_nonce('ai_ebot_store_structure_sync'),
                    'i18n' => [
                        'sending' => __('Sending to AI index…', 'wp-ai-ebot'),
                        'indexingProgress' => __('%1$d of %2$d products sent…', 'wp-ai-ebot'),
                        'removing' => __('Removing from AI index…', 'wp-ai-ebot'),
                        'successSend' => __('Products updated.', 'wp-ai-ebot'),
                        'successRemove' => __('Removed from the list.', 'wp-ai-ebot'),
                        'errorGeneric' => __('Something went wrong.', 'wp-ai-ebot'),
                        'noneSelected' => __('Select at least one product.', 'wp-ai-ebot'),
                        'reindexing' => __('Indexing…', 'wp-ai-ebot'),
                        'reindexProgress' => __('%1$d of %2$d listed products sent…', 'wp-ai-ebot'),
                        'reindexOrphanProgress' => __('Cleaning old catalog products from AI index (%1$d of %2$d)…', 'wp-ai-ebot'),
                        'reindexComplete' => __('Reindex of listed products complete.', 'wp-ai-ebot'),
                        'reindexError' => __('Reindex failed.', 'wp-ai-ebot'),
                        'storeStructureWorking' => __('Syncing store structure…', 'wp-ai-ebot'),
                        'storeStructureDone' => __('Store structure synced.', 'wp-ai-ebot'),
                        'removeAllConfirm' => __(
                            'Remove every product in this list from the AI product index and clear the list? Other indexed content on the service (pages, assistant, custom knowledge) is not removed.',
                            'wp-ai-ebot'
                        ),
                        'removeAllWorking' => __('Removing all listed products from the AI index…', 'wp-ai-ebot'),
                    ],
                ]
            );
        }

        if ($tab === 'assistant') {
            wp_enqueue_script(
                'ai-ebot-assistant-index',
                AI_EBOT_PLUGIN_URL . 'public/js/assistant-index.js',
                [],
                AI_EBOT_VERSION,
                true
            );
            wp_localize_script(
                'ai-ebot-assistant-index',
                'aiEbotAssistantIndex',
                [
                    'ajaxUrl' => admin_url('admin-ajax.php'),
                    'nonce' => wp_create_nonce('ai_ebot_assistant_index'),
                    'presetName' => Tone::OPT_PRESET,
                    'i18n' => [
                        'saving' => __('Saving and indexing…', 'wp-ai-ebot'),
                        'success' => __('Done.', 'wp-ai-ebot'),
                        'errorGeneric' => __('Something went wrong.', 'wp-ai-ebot'),
                    ],
                ]
            );
        }

        wp_localize_script(
            'ai-ebot-admin',
            'aiEbotAdmin',
            [
                'ajaxUrl' => admin_url('admin-ajax.php'),
                'clearVectorIndexNonce' => wp_create_nonce('ai_ebot_clear_vector_index'),
                'i18n' => [
                    'clearIndexConfirm' => __(
                        'This removes every chunk for this site on the AI Ebot service (products, pages, assistant text, etc.), clears the Product index list, and stops any background reindex. Continue?',
                        'wp-ai-ebot'
                    ),
                    'clearIndexWorking' => __('Clearing AI index…', 'wp-ai-ebot'),
                    'clearIndexDone' => __('AI index cleared. Use the Product index tab when you are ready to send products again.', 'wp-ai-ebot'),
                    'clearIndexError' => __('Could not clear the AI index.', 'wp-ai-ebot'),
                ],
                'indexStatusStrings' => [
                    /* translators: 1: sent so far, 2: total published (during live reindex) */
                    'syncLive' => __('%1$d of %2$d products sent so far…', 'wp-ai-ebot'),
                    /* translators: 1: indexed count, 2: published count */
                    'catalogSynced' => __('%1$d of %2$d published products included in the last full reindex.', 'wp-ai-ebot'),
                    'catalogPending' => __('No successful full reindex yet.', 'wp-ai-ebot'),
                    /* translators: %d: published product count */
                    'catalogPublishedOnly' => __('Published products in catalog: %d.', 'wp-ai-ebot'),
                    'reindexNever' => '—',
                    'syncSucceeded' => __('Succeeded', 'wp-ai-ebot'),
                    'syncFailed' => __('Failed', 'wp-ai-ebot'),
                    'hintNewProducts' => __('Counts can differ after catalog changes. Use “Reindex listed products” on the Product index tab to refresh.', 'wp-ai-ebot'),
                ],
            ]
        );
    }

    public function menu(): void
    {
        add_menu_page(
            __('AI Ebot', 'wp-ai-ebot'),
            __('AI Ebot', 'wp-ai-ebot'),
            'manage_options',
            'ai-ebot',
            [$this, 'render_page'],
            'dashicons-format-chat',
            58
        );
    }

    public function register_settings(): void
    {
        // Service API key (ai_ebot_server_api_key) and ai_ebot_tenant_id are set only by run_server_registration() — do not
        // register_setting them: same option_group is saved from other forms and could clear hidden options.
        register_setting(self::OPTION_GROUP, 'ai_ebot_tone_preset', [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_tone_preset'],
            'default' => 'custom',
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_tone', [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_textarea_field',
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_strict_grounding', [
            'type' => 'boolean',
            'default' => true,
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_sync_page_ids_csv', [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_page_ids_csv'],
        ]);
        register_setting(self::OPTION_GROUP, Catalog_Index_Tab::OPT_CURATED, [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_page_ids_csv'],
            'default' => '',
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_custom_chunks', [
            'type' => 'array',
            'sanitize_callback' => [$this, 'sanitize_custom_chunks'],
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_chat_title', [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => '',
        ]);
        register_setting(self::OPTION_GROUP, 'ai_ebot_chat_accent', [
            'type' => 'string',
            'sanitize_callback' => [self::class, 'sanitize_chat_accent_hex'],
            'default' => '#0b57d0',
        ]);
    }

    /**
     * @param mixed $value
     */
    public static function sanitize_chat_accent_hex($value): string
    {
        if (! is_string($value)) {
            return '#0b57d0';
        }
        $c = sanitize_hex_color($value);

        return $c !== '' ? $c : '#0b57d0';
    }

    /**
     * @param mixed $value
     */
    public function sanitize_tone_preset($value): string
    {
        $v = is_string($value) ? sanitize_key($value) : 'custom';

        return array_key_exists($v, Tone::preset_labels()) ? $v : 'custom';
    }

    public static function option_group(): string
    {
        return self::OPTION_GROUP;
    }

    /**
     * Connection form uses admin-post (not options.php) to avoid Settings API sanitize fatals on some hosts.
     */
    public function handle_save_connection(): void
    {
        if (! current_user_can('manage_options')) {
            wp_die(esc_html__('Forbidden.', 'wp-ai-ebot'));
        }
        check_admin_referer('ai_ebot_save_connection');

        if (! Config::has_server_endpoint()) {
            wp_safe_redirect(self::admin_tab_url('overview', ['ai_ebot_msg' => 'no_server_url']));
            exit;
        }

        try {
            self::run_server_registration();
        } catch (\Throwable $e) {
            if (defined('WP_DEBUG') && WP_DEBUG) {
                // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                error_log('AI Ebot: server registration failed — ' . $e->getMessage());
            }
            set_transient(
                'ai_ebot_connect_err',
                wp_strip_all_tags($e->getMessage()),
                120
            );
            wp_safe_redirect(self::admin_tab_url('overview', ['ai_ebot_msg' => 'connect_failed']));
            exit;
        }

        wp_safe_redirect(self::admin_tab_url('overview', ['ai_ebot_msg' => 'connected']));
        exit;
    }

    /**
     * @param array<string, string> $query Extra query args (e.g. ai_ebot_msg).
     */
    public static function admin_tab_url(string $tab, array $query = []): string
    {
        $args = array_merge(
            [
                'page' => 'ai-ebot',
                'tab' => $tab,
            ],
            $query
        );

        return add_query_arg($args, admin_url('admin.php'));
    }

    private static function current_tab(): string
    {
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $tab = isset($_GET['tab']) ? sanitize_key((string) wp_unslash($_GET['tab'])) : self::TAB_DEFAULT;

        return in_array($tab, self::SETTINGS_TABS, true) ? $tab : self::TAB_DEFAULT;
    }

    /**
     * Calls vendor /v1/register; stores tenant id and service API key from response.
     *
     * @throws \RuntimeException When the request fails or the response does not include credentials.
     */
    public static function run_server_registration(): void
    {
        delete_option('ai_ebot_openai_api_key');

        if (! Config::has_server_endpoint()) {
            throw new \RuntimeException(__('Service URL is not configured.', 'wp-ai-ebot'));
        }

        $site_secret = (string) get_option('ai_ebot_site_secret', '');
        if ($site_secret === '') {
            throw new \RuntimeException(__('Site secret is missing. Deactivate and reactivate the plugin.', 'wp-ai-ebot'));
        }

        $existing_key = Config::stored_service_api_key();
        $client = new Server_Client(null, $existing_key, (string) get_option('ai_ebot_tenant_id', ''));
        $payload = array_merge(
            [
                'site_url' => home_url('/'),
                'site_secret' => $site_secret,
            ],
            Telemetry::site_metadata()
        );

        $result = $client->register_site($payload);
        $body = $result['body'];

        if (! $result['ok']) {
            $detail = self::format_register_error_body($body, (int) $result['code']);
            throw new \RuntimeException(
                sprintf(
                    /* translators: 1: HTTP status code or 0, 2: error detail */
                    __('Could not register with AI Ebot (HTTP %1$d). %2$s', 'wp-ai-ebot'),
                    (int) $result['code'],
                    $detail
                )
            );
        }

        if (! is_array($body)) {
            throw new \RuntimeException(__('Invalid JSON from registration.', 'wp-ai-ebot'));
        }

        $tid = isset($body['tenant_id']) ? sanitize_text_field((string) $body['tenant_id']) : '';
        $ak = isset($body['api_key']) ? sanitize_text_field((string) $body['api_key']) : '';
        if ($tid === '' || $ak === '') {
            throw new \RuntimeException(
                __('The service did not return a Site ID or service key. Check AI_EBOT_SERVER_BASE_URL.', 'wp-ai-ebot')
            );
        }

        Status::invalidate_billing_cache((string) get_option('ai_ebot_tenant_id', ''));
        update_option('ai_ebot_tenant_id', $tid);
        update_option(Config::OPT_SERVER_API_KEY, $ak);
        delete_option('ai_ebot_cloud_api_key');
    }

    /**
     * @param mixed $body
     */
    private static function format_register_error_body($body, int $code): string
    {
        if (is_string($body) && $body !== '') {
            return $body;
        }
        if (is_array($body) && isset($body['error']) && is_string($body['error'])) {
            return $body['error'];
        }
        if ($code === 0) {
            return __('Network error — is the AI Ebot service running and reachable?', 'wp-ai-ebot');
        }

        return __('Unexpected response.', 'wp-ai-ebot');
    }

    /**
     * @param array<string, mixed>|null $billing From GET /v1/tenant/billing.
     */
    private static function billing_tier_label(?array $billing): string
    {
        if ($billing === null) {
            return __('Unable to load (try refreshing this page).', 'wp-ai-ebot');
        }
        $slug = isset($billing['billing_plan_slug']) && is_string($billing['billing_plan_slug'])
            ? $billing['billing_plan_slug']
            : '';
        $sub = isset($billing['subscription_status']) && is_string($billing['subscription_status'])
            ? strtolower($billing['subscription_status'])
            : '';
        $paid = in_array($sub, ['active', 'trialing'], true);
        if ($slug !== '' && $paid) {
            $map = [
                'starter' => __('Starter', 'wp-ai-ebot'),
                'growth' => __('Growth', 'wp-ai-ebot'),
                'pro' => __('Pro', 'wp-ai-ebot'),
            ];
            $key = strtolower($slug);

            return $map[$key] ?? ucwords(str_replace(['_', '-'], ' ', $key));
        }

        return __('Free', 'wp-ai-ebot');
    }

    /**
     * @return array{pages: int, chunks: int}
     */
    private static function knowledge_extra_counts(): array
    {
        $csv = trim((string) get_option('ai_ebot_sync_page_ids_csv', ''));
        $pages = 0;
        if ($csv !== '') {
            foreach (explode(',', $csv) as $p) {
                if ((int) trim($p) > 0) {
                    $pages++;
                }
            }
        }
        $custom = get_option('ai_ebot_custom_chunks', []);
        $chunks = 0;
        if (is_array($custom)) {
            foreach ($custom as $row) {
                if (is_array($row) && trim((string) ($row['body'] ?? '')) !== '') {
                    $chunks++;
                }
            }
        }

        return ['pages' => $pages, 'chunks' => $chunks];
    }

    /**
     * @param mixed $value
     */
    public function sanitize_page_ids_csv($value): string
    {
        $s = is_string($value) ? $value : '';
        $parts = array_filter(array_map('absint', explode(',', $s)));

        return implode(',', $parts);
    }

    /**
     * @return array<int, int>
     */
    public static function get_sync_page_ids(): array
    {
        $csv = (string) get_option('ai_ebot_sync_page_ids_csv', '');
        $parts = array_filter(array_map('absint', explode(',', $csv)));

        return array_values(array_unique($parts));
    }

    /**
     * @param mixed $value
     * @return array<int, array{title: string, body: string}>
     */
    public function sanitize_custom_chunks($value): array
    {
        if (! is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $row) {
            if (! is_array($row)) {
                continue;
            }
            $body = isset($row['body']) ? sanitize_textarea_field((string) $row['body']) : '';
            if ($body === '') {
                continue;
            }
            $out[] = [
                'title' => isset($row['title']) ? sanitize_text_field((string) $row['title']) : '',
                'body' => $body,
            ];
        }

        return $out;
    }

    public function admin_notices(): void
    {
        if (current_user_can('manage_options')) {
            self::maybe_show_activation_register_notice();
        }

        if (! isset($_GET['ai_ebot_msg'])) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
            return;
        }
        $msg = sanitize_text_field(wp_unslash((string) $_GET['ai_ebot_msg'])); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if ($msg === 'reindexed') {
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__('Reindex queued or completed on the service.', 'wp-ai-ebot') . '</p></div>';
        }
        if ($msg === 'not_configured') {
            echo '<div class="notice notice-warning is-dismissible"><p>' . esc_html__('Connect to AI Ebot on the Overview tab first.', 'wp-ai-ebot') . '</p></div>';
        }
        if ($msg === 'reindex_failed') {
            echo '<div class="notice notice-error is-dismissible"><p>' . esc_html__('Reindex failed — check Status for the last sync error, then try again.', 'wp-ai-ebot') . '</p></div>';
        }
        if ($msg === 'connected') {
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__('Connected. Your Site ID and service access are updated.', 'wp-ai-ebot') . '</p></div>';
        }
        if ($msg === 'connect_failed') {
            $err = get_transient('ai_ebot_connect_err');
            delete_transient('ai_ebot_connect_err');
            $extra = is_string($err) && $err !== '' ? ' ' . esc_html($err) : '';
            echo '<div class="notice notice-error is-dismissible"><p>' . esc_html__('Could not complete registration with the AI service.', 'wp-ai-ebot') . esc_html($extra) . '</p></div>';
        }
        if ($msg === 'no_server_url') {
            echo '<div class="notice notice-error is-dismissible"><p>' . esc_html__('Service URL is not set. Define AI_EBOT_SERVER_BASE_URL in wp-config.php (or legacy AI_EBOT_CLOUD_BASE_URL) or ask your host.', 'wp-ai-ebot') . '</p></div>';
        }
    }

    /**
     * After activation: show whether automatic link to the API succeeded (see Registration::on_activation).
     */
    private static function maybe_show_activation_register_notice(): void
    {
        $st = get_transient(\AI_Ebot\Registration::TRANSIENT_STATUS);
        if ($st === false) {
            return;
        }
        delete_transient(\AI_Ebot\Registration::TRANSIENT_STATUS);

        if ($st === 'success') {
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__(
                'AI Ebot: this site is linked to the service. If this URL was already registered, your existing account was reused; otherwise a new one was created. Check Overview for your Site ID.',
                'wp-ai-ebot'
            ) . '</p></div>';

            return;
        }

        if ($st === 'no_endpoint') {
            echo '<div class="notice notice-warning is-dismissible"><p>' . esc_html__(
                'AI Ebot: no API base URL is configured. Set AI_EBOT_SERVER_BASE_URL in wp-config.php (or use the default from the plugin), then use Overview → Connect to AI Ebot.',
                'wp-ai-ebot'
            ) . '</p></div>';

            return;
        }

        if ($st === 'failed') {
            $err = get_transient('ai_ebot_connect_err');
            delete_transient('ai_ebot_connect_err');
            $extra = is_string($err) && $err !== '' ? ' ' . esc_html($err) : '';
            echo '<div class="notice notice-warning is-dismissible"><p>' . esc_html__(
                'AI Ebot: automatic registration did not complete.',
                'wp-ai-ebot'
            ) . $extra . ' ';
            echo esc_html__(
                'Open AI Ebot → Overview and use “Connect to AI Ebot” (for example if this site URL was registered before with a different site secret).',
                'wp-ai-ebot'
            );
            echo '</p></div>';
        }
    }

    public function render_page(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['tab'])) {
            $legacy_tab = sanitize_key((string) wp_unslash($_GET['tab']));
            if ($legacy_tab === 'connection' || $legacy_tab === 'indexed') {
                $args = [
                    'page' => 'ai-ebot',
                    'tab' => $legacy_tab === 'connection' ? 'overview' : 'knowledge',
                ];
                // phpcs:ignore WordPress.Security.NonceVerification.Recommended
                if (isset($_GET['ai_ebot_msg'])) {
                    $args['ai_ebot_msg'] = sanitize_text_field(wp_unslash((string) $_GET['ai_ebot_msg']));
                }
                if ($legacy_tab === 'indexed' && isset($_GET['paged'])) {
                    $args['ipp'] = max(1, (int) $_GET['paged']);
                }
                wp_safe_redirect(add_query_arg($args, admin_url('admin.php')));
                exit;
            }
        }

        $state = Status::chatbot_state();
        $catalog = Status::published_product_count();
        $indexed = Status::indexed_product_count();
        $tab = self::current_tab();
        $billing_snap = null;
        $svc_health = ['ok' => false, 'code' => 0];
        $extra_src = ['pages' => 0, 'chunks' => 0];
        $tone_raw = '';
        if ($tab === 'overview') {
            $billing_snap = Status::fetch_billing_snapshot();
            $svc_health = Config::has_server_endpoint()
                ? (new Server_Client())->fetch_service_health()
                : ['ok' => false, 'code' => 0];
            $extra_src = self::knowledge_extra_counts();
            $tone_raw = trim(Tone::effective_tone());
        }
        $tone_preview = '';
        if ($tone_raw !== '') {
            $one_line = preg_replace('/\s+/u', ' ', $tone_raw);
            if (function_exists('mb_substr')) {
                $tone_preview = (mb_strlen($one_line) > 120)
                    ? mb_substr($one_line, 0, 120) . '…'
                    : $one_line;
            } else {
                $tone_preview = (strlen($one_line) > 120)
                    ? substr($one_line, 0, 120) . '…'
                    : $one_line;
            }
        }

        ?>
        <div class="wrap">
            <h1><?php esc_html_e('AI Ebot', 'wp-ai-ebot'); ?></h1>

            <h2 class="nav-tab-wrapper wp-clearfix" style="margin-bottom:1rem;">
                <a href="<?php echo esc_url(self::admin_tab_url('overview')); ?>" class="nav-tab <?php echo $tab === 'overview' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Overview', 'wp-ai-ebot'); ?></a>
                <a href="<?php echo esc_url(self::admin_tab_url('catalog-index')); ?>" class="nav-tab <?php echo $tab === 'catalog-index' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Product index', 'wp-ai-ebot'); ?></a>
                <a href="<?php echo esc_url(self::admin_tab_url('assistant')); ?>" class="nav-tab <?php echo $tab === 'assistant' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Assistant', 'wp-ai-ebot'); ?></a>
                <a href="<?php echo esc_url(self::admin_tab_url('appearance')); ?>" class="nav-tab <?php echo $tab === 'appearance' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Appearance', 'wp-ai-ebot'); ?></a>
                <a href="<?php echo esc_url(self::admin_tab_url('knowledge')); ?>" class="nav-tab <?php echo $tab === 'knowledge' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Knowledge & index', 'wp-ai-ebot'); ?></a>
                <a href="<?php echo esc_url(self::admin_tab_url('sessions')); ?>" class="nav-tab <?php echo $tab === 'sessions' ? 'nav-tab-active' : ''; ?>"><?php esc_html_e('Chat sessions', 'wp-ai-ebot'); ?></a>
            </h2>

            <?php if ($tab === 'catalog-index') : ?>
                <?php Catalog_Index_Tab::render(); ?>
            <?php endif; ?>

            <?php if ($tab === 'overview') : ?>
            <p class="description" style="max-width:56rem;">
                <?php
                echo wp_kses(
                    sprintf(
                        /* translators: %s: link to the Chat sessions tab */
                        __('Browse saved storefront conversations on the %s tab.', 'wp-ai-ebot'),
                        '<a href="' . esc_url(self::admin_tab_url('sessions')) . '">' . esc_html__('Chat sessions', 'wp-ai-ebot') . '</a>'
                    ),
                    [
                        'a' => [
                            'href' => true,
                        ],
                    ]
                );
                ?>
            </p>

            <h2 class="title"><?php esc_html_e('Frontend shortcode', 'wp-ai-ebot'); ?></h2>
            <p><code>[ai_ebot_chat title="<?php echo esc_attr(__('Ask us', 'wp-ai-ebot')); ?>"]</code></p>

            <?php self::render_overview_metric_cards($billing_snap, $catalog); ?>
            <h2 class="title"><?php esc_html_e('Status', 'wp-ai-ebot'); ?></h2>
            <table class="widefat striped" style="max-width: 56rem;">
                <thead>
                    <tr>
                        <th scope="col"><?php esc_html_e('Item', 'wp-ai-ebot'); ?></th>
                        <th scope="col"><?php esc_html_e('Details', 'wp-ai-ebot'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong><?php esc_html_e('AI Ebot service', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if (Config::has_server_endpoint()) {
                                echo '<p class="description" style="margin:0 0 0.35rem 0;"><code style="font-size:12px;">' . esc_html(Config::server_base_url()) . '</code></p>';
                            }
                            if (! Config::has_server_endpoint()) {
                                echo '<span style="color:#787c82;">' . esc_html__(
                                    'AI Ebot service URL is not configured for this site.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                            } elseif (! Status::has_registered_credentials()) {
                                if (! empty($svc_health['ok'])) {
                                    echo '<span style="color:#996800;">' . esc_html__(
                                        'Reachable — this site is not registered yet.',
                                        'wp-ai-ebot'
                                    ) . '</span>';
                                } else {
                                    $code = (int) ($svc_health['code'] ?? 0);
                                    printf(
                                        '<span style="color:#b32d2e;">%s</span>',
                                        esc_html(
                                            sprintf(
                                                /* translators: %d: HTTP status or 0 for network error */
                                                __('Cannot reach the AI Ebot service (HTTP %d). Check the service URL and network access.', 'wp-ai-ebot'),
                                                $code
                                            )
                                        )
                                    );
                                }
                                echo '<p class="description">' . esc_html__(
                                    'Complete registration using the Connect button in this table.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                            } elseif (! empty($svc_health['ok'])) {
                                echo '<span style="color:#007017;">' . esc_html__(
                                    'Connected — credentials are stored and the service responded successfully.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                            } else {
                                $code = (int) ($svc_health['code'] ?? 0);
                                echo '<span style="color:#b32d2e;">' . esc_html__(
                                    'Credentials are saved, but the service did not respond to a health check.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                                echo ' ';
                                printf(
                                    '<span class="description">%s</span>',
                                    esc_html(
                                        sprintf(
                                            /* translators: %d: HTTP status code */
                                            __('Last check returned HTTP %d.', 'wp-ai-ebot'),
                                            $code
                                        )
                                    )
                                );
                                if ($code === 502) {
                                    echo '<p class="description">';
                                    esc_html_e(
                                        'HTTP 502 usually means the API is not accepting traffic on the host/port your platform expects. On Railway, confirm the service uses the provided PORT, the Node process listens on 0.0.0.0 (default for this server), deploy logs show the app started, and DATABASE_URL and other required env vars are set.',
                                        'wp-ai-ebot'
                                    );
                                    echo '</p>';
                                }
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Site ID', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <code style="font-size:13px;"><?php echo esc_html(Status::tenant_id_display()); ?></code>
                            <p class="description"><?php esc_html_e('Created automatically when you register this site with AI Ebot.', 'wp-ai-ebot'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Connect to AI Ebot', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if (! Config::has_server_endpoint()) {
                                echo '<p class="description" style="margin:0;">' . esc_html__(
                                    'Set AI_EBOT_SERVER_BASE_URL in wp-config.php (or legacy AI_EBOT_CLOUD_BASE_URL), or ask your host, then reload this page.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                            } elseif (! Status::has_registered_credentials()) {
                                echo '<p style="margin:0 0 0.75rem 0;">' . esc_html__(
                                    'Link this site to receive a Site ID and service key. On activation, the plugin tries this automatically; use the button if that step did not complete.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                                if (empty($svc_health['ok'])) {
                                    echo '<p class="description" style="margin:0 0 0.75rem 0;">' . esc_html__(
                                        'The service did not respond to a health check — you can still try to connect if the URL is correct.',
                                        'wp-ai-ebot'
                                    ) . '</p>';
                                }
                                ?>
                                <button type="submit" class="button button-primary" form="ai-ebot-register-form">
                                    <?php esc_html_e('Connect to AI Ebot', 'wp-ai-ebot'); ?>
                                </button>
                                <?php
                            } else {
                                echo '<p class="description" style="margin:0;">' . esc_html__(
                                    'Your site is registered. You can refresh registration below after a backup restore or URL change.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Bot health', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            $indexed_n = (int) $indexed;
                            if (! Config::has_server_endpoint() || ! Status::has_registered_credentials()) {
                                echo '<span style="color:#787c82;font-weight:600;">' . esc_html__('Offline', 'wp-ai-ebot') . '</span>';
                                echo '<br /><span class="description">' . esc_html(wp_strip_all_tags(Status::setup_message())) . '</span>';
                            } elseif ($state === 'error') {
                                echo '<span style="color:#b32d2e;font-weight:600;">' . esc_html__('Offline', 'wp-ai-ebot') . '</span>';
                                echo '<br /><span class="description">' . esc_html__(
                                    'The last content sync to the AI service did not succeed.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                                $err = Status::last_ingest_error_message();
                                if ($err !== '') {
                                    echo '<br /><code style="font-size:12px;">' . esc_html($err) . '</code>';
                                }
                            } else {
                                echo '<span style="color:#007017;font-weight:600;">' . esc_html__('Online', 'wp-ai-ebot') . '</span>';
                                echo ' — ';
                                printf(
                                    /* translators: %d: number of products counted in the AI knowledge index */
                                    esc_html__('With %d Product Knowledge', 'wp-ai-ebot'),
                                    $indexed_n
                                );
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Plan', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if (! Status::has_registered_credentials()) {
                                echo '<span class="description">' . esc_html('—') . '</span>';
                                echo '<p class="description">' . esc_html__(
                                    'Your subscription tier appears here after you connect.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                            } else {
                                echo esc_html(self::billing_tier_label($billing_snap));
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Available chats', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if (! Status::has_registered_credentials()) {
                                echo '<span class="description">' . esc_html('—') . '</span>';
                                echo '<p class="description">' . esc_html__(
                                    'Monthly chat allowance is shown after you connect.',
                                    'wp-ai-ebot'
                                ) . '</p>';
                            } elseif (! is_array($billing_snap)) {
                                echo '<span style="color:#787c82;">' . esc_html__(
                                    'Could not load usage from the service. Refresh this page or try again shortly.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                            } else {
                                $used = (int) ($billing_snap['used_chats_this_month'] ?? 0);
                                $quota = (int) ($billing_snap['monthly_chat_quota'] ?? 0);
                                $remaining = max(0, $quota - $used);
                                printf(
                                    /* translators: 1: chats used this UTC month, 2: monthly quota, 3: remaining */
                                    esc_html__('%1$d of %2$d chats used this month (%3$d remaining).', 'wp-ai-ebot'),
                                    $used,
                                    $quota,
                                    $remaining
                                );
                                if (array_key_exists('monthly_chat_quota_override', $billing_snap) && $billing_snap['monthly_chat_quota_override'] !== null) {
                                    echo '<p class="description">' . esc_html__(
                                        'Your host set a custom monthly limit for this site.',
                                        'wp-ai-ebot'
                                    ) . '</p>';
                                }
                                $upgrade_href = '';
                                if (isset($billing_snap['upgrade_urls']) && is_array($billing_snap['upgrade_urls'])) {
                                    $cand = $billing_snap['upgrade_urls']['default'] ?? '';
                                    if (is_string($cand) && $cand !== '' && wp_http_validate_url($cand)) {
                                        $upgrade_href = $cand;
                                    }
                                }
                                echo '<p class="description" style="margin-top:0.5em;">';
                                if ($upgrade_href !== '') {
                                    echo '<a href="' . esc_url($upgrade_href) . '" class="button button-small" target="_blank" rel="noopener noreferrer">';
                                    echo '<span class="dashicons dashicons-external" style="font-size:16px;width:18px;height:18px;vertical-align:text-bottom;margin-right:2px;" aria-hidden="true"></span>';
                                    esc_html_e('Upgrade plan', 'wp-ai-ebot');
                                    echo '<span class="screen-reader-text"> ' . esc_html__('(opens in a new tab)', 'wp-ai-ebot') . '</span>';
                                    echo '</a>';
                                } elseif (! empty($billing_snap['stripe_checkout_enabled'])) {
                                    esc_html_e('Higher limits may be available — ask your AI Ebot host for a checkout or upgrade link.', 'wp-ai-ebot');
                                } else {
                                    esc_html_e('Contact your AI Ebot host if you need a higher monthly chat limit.', 'wp-ai-ebot');
                                }
                                echo '</p>';
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Total indexed products', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if ((int) get_option(Status::OPT_LAST_FULL_REINDEX_AT, 0) > 0) {
                                printf(
                                    /* translators: %d: products included in last successful full reindex */
                                    esc_html__('%d products indexed in the last full reindex.', 'wp-ai-ebot'),
                                    (int) $indexed
                                );
                                echo ' ';
                                printf(
                                    /* translators: %d: published products in WooCommerce catalog */
                                    esc_html__('%d published in your catalog.', 'wp-ai-ebot'),
                                    (int) $catalog
                                );
                                echo '<br /><span class="description">' . esc_html(
                                    sprintf(
                                        /* translators: %s: formatted datetime */
                                        __('Last full reindex: %s', 'wp-ai-ebot'),
                                        Status::last_full_reindex_human()
                                    )
                                ) . '</span>';
                            } else {
                                echo esc_html__('No product reindex recorded yet — run “Reindex listed products” on the Product index tab after you add items to the AI index list.', 'wp-ai-ebot');
                                echo ' ';
                                printf(
                                    /* translators: %d: published product count */
                                    esc_html__('Published products in catalog: %d.', 'wp-ai-ebot'),
                                    (int) $catalog
                                );
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Additional instructions', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if ($tone_preview === '') {
                                echo '<span class="description">' . esc_html__(
                                    'None — add tone and instructions under Assistant.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                                echo ' ';
                                echo wp_kses(
                                    sprintf(
                                        /* translators: %s: link */
                                        __('(%s)', 'wp-ai-ebot'),
                                        '<a href="' . esc_url(self::admin_tab_url('assistant')) . '">' . esc_html__('Open Assistant', 'wp-ai-ebot') . '</a>'
                                    ),
                                    [
                                        'a' => [
                                            'href' => true,
                                        ],
                                    ]
                                );
                            } else {
                                echo esc_html($tone_preview);
                                echo '<p class="description">';
                                echo wp_kses(
                                    sprintf(
                                        /* translators: %s: link */
                                        __('Edit under %s.', 'wp-ai-ebot'),
                                        '<a href="' . esc_url(self::admin_tab_url('assistant')) . '">' . esc_html__('Assistant → Tone preset & instructions', 'wp-ai-ebot') . '</a>'
                                    ),
                                    [
                                        'a' => [
                                            'href' => true,
                                        ],
                                    ]
                                );
                                echo '</p>';
                            }
                            ?>
                        </td>
                    </tr>
                    <tr>
                        <td><strong><?php esc_html_e('Additional sources', 'wp-ai-ebot'); ?></strong></td>
                        <td>
                            <?php
                            if ($extra_src['pages'] === 0 && $extra_src['chunks'] === 0) {
                                echo '<span class="description">' . esc_html__(
                                    'Nothing extra — add pages or custom knowledge under Knowledge & index.',
                                    'wp-ai-ebot'
                                ) . '</span>';
                                echo ' ';
                                echo wp_kses(
                                    sprintf(
                                        /* translators: %s: link */
                                        __('(%s)', 'wp-ai-ebot'),
                                        '<a href="' . esc_url(self::admin_tab_url('knowledge')) . '">' . esc_html__('Open Knowledge & index', 'wp-ai-ebot') . '</a>'
                                    ),
                                    [
                                        'a' => [
                                            'href' => true,
                                        ],
                                    ]
                                );
                            } else {
                                printf(
                                    /* translators: 1: number of extra page IDs, 2: number of custom chunks */
                                    esc_html__('Extra pages synced: %1$d · Custom knowledge entries: %2$d', 'wp-ai-ebot'),
                                    (int) $extra_src['pages'],
                                    (int) $extra_src['chunks']
                                );
                                echo '<p class="description">';
                                echo wp_kses(
                                    sprintf(
                                        /* translators: %s: link */
                                        __('Manage under %s.', 'wp-ai-ebot'),
                                        '<a href="' . esc_url(self::admin_tab_url('knowledge')) . '">' . esc_html__('Knowledge & index', 'wp-ai-ebot') . '</a>'
                                    ),
                                    [
                                        'a' => [
                                            'href' => true,
                                        ],
                                    ]
                                );
                                echo '</p>';
                            }
                            ?>
                        </td>
                    </tr>
                </tbody>
            </table>

            <div id="ai-ebot-register" class="ai-ebot-register-card" style="max-width:56rem;margin-top:1.5rem;">
                <h2 class="title"><?php esc_html_e('Registration & privacy', 'wp-ai-ebot'); ?></h2>
                <p class="description"><?php esc_html_e('Service usage: AI Ebot records aggregate usage (for example chat and indexing counts), your site URL and display name, and software versions (WordPress, WooCommerce, this plugin) to operate the service. Chat message content is processed to generate replies and is not stored for analytics.', 'wp-ai-ebot'); ?></p>
                <form id="ai-ebot-register-form" method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <?php wp_nonce_field('ai_ebot_save_connection'); ?>
                    <input type="hidden" name="action" value="ai_ebot_save_connection" />
                </form>
                <?php if (Status::has_registered_credentials()) : ?>
                    <p class="description"><?php esc_html_e('Your site is already registered. Use the button below again if you need to refresh registration (for example after restoring a backup).', 'wp-ai-ebot'); ?></p>
                    <p class="submit">
                        <button type="submit" class="button button-primary" form="ai-ebot-register-form"><?php esc_html_e('Connect to AI Ebot', 'wp-ai-ebot'); ?></button>
                    </p>
                <?php endif; ?>
            </div>

            <div class="ai-ebot-reindex-card" style="margin-top:2em;max-width:56rem;">
                <h2 class="title"><?php esc_html_e('Index maintenance', 'wp-ai-ebot'); ?></h2>
                <p class="description"><?php esc_html_e('Refresh product embeddings from the Product index tab. Use the control below only to wipe every chunk for this site on the AI service (including pages and assistant text).', 'wp-ai-ebot'); ?></p>

                <div class="ai-ebot-clear-index" style="margin-top:0;">
                    <p class="description" style="margin-top:0;">
                        <?php esc_html_e('Testing or migrating? Clear every stored chunk for this site on the AI service.', 'wp-ai-ebot'); ?>
                    </p>
                    <p class="submit" style="margin:0;">
                        <button type="button" class="button" id="ai-ebot-clear-vector-index-btn">
                            <?php esc_html_e('Clear all chunks on AI Ebot (this site only)', 'wp-ai-ebot'); ?>
                        </button>
                    </p>
                    <p class="description" id="ai-ebot-clear-vector-index-status" style="margin-bottom:0;" hidden aria-live="polite"></p>
                </div>

                <?php self::render_product_index_status_card((int) $indexed, (int) $catalog); ?>
            </div>

            <?php endif; ?>

            <?php if ($tab === 'assistant') : ?>
            <form method="post" action="" id="ai-ebot-assistant-form" style="margin-top:0;">
                <h2 class="title"><?php esc_html_e('Assistant behavior', 'wp-ai-ebot'); ?></h2>
                <p class="description" style="max-width:56rem;">
                    <?php esc_html_e('Saving sends your tone, instructions, and grounding preference to WordPress and updates the “assistant behavior” chunk in the AI search index so shoppers get consistent guidance.', 'wp-ai-ebot'); ?>
                </p>
                <table class="form-table">
                    <tr>
                        <th scope="row"><?php esc_html_e('Tone preset', 'wp-ai-ebot'); ?></th>
                        <td>
                            <fieldset>
                                <?php
                                $preset_val = sanitize_key((string) get_option(Tone::OPT_PRESET, 'custom'));
                                if (! array_key_exists($preset_val, Tone::preset_labels())) {
                                    $preset_val = 'custom';
                                }
                                foreach (Tone::preset_labels() as $slug => $label) {
                                    ?>
                                    <label style="display:block;margin:0.25rem 0;">
                                        <input type="radio" name="<?php echo esc_attr(Tone::OPT_PRESET); ?>" value="<?php echo esc_attr($slug); ?>" <?php checked($preset_val, $slug); ?> />
                                        <?php echo esc_html($label); ?>
                                    </label>
                                    <?php
                                }
                                ?>
                            </fieldset>
                            <p class="description"><?php esc_html_e('Choose a base style. “Custom” uses only the instructions below; other presets add their own guidance and can include your additional text.', 'wp-ai-ebot'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="ai_ebot_tone"><?php esc_html_e('Additional instructions', 'wp-ai-ebot'); ?></label></th>
                        <td>
                            <textarea name="ai_ebot_tone" id="ai_ebot_tone" rows="6" class="large-text"><?php echo esc_textarea((string) get_option('ai_ebot_tone', '')); ?></textarea>
                            <p class="description"><?php esc_html_e('Store policies, shipping rules, what to avoid, brand voice, or any extra rules. For non-custom presets, this text is appended after the preset.', 'wp-ai-ebot'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th><?php esc_html_e('Strict grounding', 'wp-ai-ebot'); ?></th>
                        <td>
                            <label>
                                <input type="checkbox" name="ai_ebot_strict_grounding" value="1" <?php checked((bool) get_option('ai_ebot_strict_grounding', true)); ?> />
                                <?php esc_html_e('Only use retrieved sources for factual claims.', 'wp-ai-ebot'); ?>
                            </label>
                        </td>
                    </tr>
                </table>
                <p class="submit">
                    <button type="button" class="button button-primary" id="ai-ebot-assistant-save-index">
                        <?php esc_html_e('Save behavior and index', 'wp-ai-ebot'); ?>
                    </button>
                </p>
                <div id="ai-ebot-assistant-index-status" class="ai-ebot-knowledge-index-status" hidden aria-live="polite">
                    <p class="ai-ebot-knowledge-index-status__text" id="ai-ebot-assistant-index-status-text"></p>
                    <div id="ai-ebot-assistant-index-progress" class="ai-ebot-knowledge-index-progress" hidden>
                        <div class="ai-ebot-knowledge-index-progress__track" aria-hidden="true">
                            <div class="ai-ebot-knowledge-index-progress__fill" style="width:40%;"></div>
                        </div>
                    </div>
                </div>
            </form>
            <?php endif; ?>

            <?php if ($tab === 'appearance') : ?>
            <form method="post" action="options.php" style="margin-top:0;">
                <?php settings_fields(self::OPTION_GROUP); ?>
                <h2 class="title"><?php esc_html_e('Storefront chat', 'wp-ai-ebot'); ?></h2>
                <p class="description" style="max-width:56rem;">
                    <?php esc_html_e('These settings apply to the chat widget (shortcode and block). You can still override the title per shortcode with the title attribute.', 'wp-ai-ebot'); ?>
                </p>
                <table class="form-table">
                    <tr>
                        <th scope="row"><label for="ai_ebot_chat_title"><?php esc_html_e('Chat heading', 'wp-ai-ebot'); ?></label></th>
                        <td>
                            <input type="text" name="ai_ebot_chat_title" id="ai_ebot_chat_title" class="regular-text" value="<?php echo esc_attr((string) get_option('ai_ebot_chat_title', '')); ?>" placeholder="<?php echo esc_attr(__('Store assistant', 'wp-ai-ebot')); ?>" />
                            <p class="description"><?php esc_html_e('Shown at the top of the chat box (for example “Ask us” or your store name).', 'wp-ai-ebot'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="ai_ebot_chat_accent"><?php esc_html_e('Theme color', 'wp-ai-ebot'); ?></label></th>
                        <td>
                            <input type="text" name="ai_ebot_chat_accent" id="ai_ebot_chat_accent" class="regular-text" value="<?php echo esc_attr((string) get_option('ai_ebot_chat_accent', '#0b57d0')); ?>" pattern="^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$" />
                            <input type="color" id="ai_ebot_chat_accent_picker" value="<?php echo esc_attr((string) get_option('ai_ebot_chat_accent', '#0b57d0')); ?>" aria-label="<?php esc_attr_e('Pick accent color', 'wp-ai-ebot'); ?>" />
                            <p class="description"><?php esc_html_e('Accent for links, buttons, suggestion chips, and highlights in the chat.', 'wp-ai-ebot'); ?></p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(__('Save appearance', 'wp-ai-ebot')); ?>
            </form>
            <script>
            (function () {
                var hex = document.getElementById('ai_ebot_chat_accent');
                var pick = document.getElementById('ai_ebot_chat_accent_picker');
                if (!hex || !pick) return;
                function norm(s) {
                    s = (s || '').trim();
                    if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
                        return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
                    }
                    return /^#[0-9A-Fa-f]{6}$/.test(s) ? s : '#0b57d0';
                }
                pick.addEventListener('input', function () {
                    hex.value = pick.value;
                });
                hex.addEventListener('input', function () {
                    pick.value = norm(hex.value);
                });
                pick.value = norm(hex.value);
            })();
            </script>
            <?php endif; ?>

            <?php if ($tab === 'knowledge') : ?>
                <?php Knowledge_Tab::render(); ?>
            <?php endif; ?>

            <?php if ($tab === 'sessions') : ?>
                <?php Chat_Sessions_Page::render_tab(); ?>
            <?php endif; ?>

        </div>
        <?php
    }

    /**
     * Dashboard-style metrics above the Status table (Overview tab).
     *
     * @param array<string, mixed>|null $billing From GET /v1/tenant/billing, or null if unavailable.
     * @param int                         $published_wc_products Published WooCommerce product count (for context).
     */
    private static function render_overview_metric_cards(?array $billing, int $published_wc_products = 0): void
    {
        $registered = Status::has_registered_credentials();
        $billing_ok = is_array($billing);

        if (! $registered) {
            $chats_value = '—';
            $chats_hint = __('Connect this site to see chat usage and limits.', 'wp-ai-ebot');
            $products_value = '—';
            $products_hint = __('Connect to see how many products are embedded on the API versus your plan limit.', 'wp-ai-ebot');
            $tier_value = '—';
            $tier_hint = __('Your subscription tier appears after you connect.', 'wp-ai-ebot');
        } elseif (! $billing_ok) {
            $chats_value = '—';
            $chats_hint = __('Could not load usage. Refresh this page or try again shortly.', 'wp-ai-ebot');
            $products_value = '—';
            $products_hint = __('Could not load index limits. Refresh this page or try again shortly.', 'wp-ai-ebot');
            $tier_value = self::billing_tier_label(null);
            $tier_hint = '';
        } else {
            $used = (int) ($billing['used_chats_this_month'] ?? 0);
            $quota = (int) ($billing['monthly_chat_quota'] ?? 0);
            $chats_value = sprintf(
                /* translators: 1: chats used this UTC month, 2: monthly chat quota */
                __('%1$s / %2$s', 'wp-ai-ebot'),
                number_format_i18n($used),
                number_format_i18n($quota)
            );
            $chats_hint = __('Used this month (UTC) · monthly limit', 'wp-ai-ebot');

            $idx = (int) ($billing['indexed_product_count'] ?? 0);
            $max = (int) ($billing['max_indexed_products'] ?? 0);
            $max_label = $max === 0
                ? __('Unlimited', 'wp-ai-ebot')
                : number_format_i18n($max);
            $products_value = sprintf(
                /* translators: 1: distinct products embedded on the API for chat retrieval, 2: plan maximum (number or "Unlimited") */
                __('%1$s / %2$s', 'wp-ai-ebot'),
                number_format_i18n($idx),
                $max_label
            );
            $products_hint = __('Distinct products embedded for AI search/chat · your plan cap (not your WooCommerce catalog size).', 'wp-ai-ebot');
            if (Status::is_woocommerce_active()) {
                $products_hint .= ' ' . sprintf(
                    /* translators: %s: formatted number of published products in WooCommerce */
                    __('WooCommerce published: %s.', 'wp-ai-ebot'),
                    number_format_i18n(max(0, $published_wc_products))
                );
            }

            $tier_value = self::billing_tier_label($billing);
            $tier_hint = '';
        }
        ?>
        <div class="ai-ebot-overview-metrics" role="region" aria-label="<?php esc_attr_e('Usage overview', 'wp-ai-ebot'); ?>">
            <div class="ai-ebot-metric-card">
                <div class="ai-ebot-metric-card__label"><?php esc_html_e('Chats', 'wp-ai-ebot'); ?></div>
                <div class="ai-ebot-metric-card__value"><?php echo esc_html($chats_value); ?></div>
                <p class="ai-ebot-metric-card__hint"><?php echo esc_html($chats_hint); ?></p>
            </div>
            <div class="ai-ebot-metric-card">
                <div class="ai-ebot-metric-card__label"><?php esc_html_e('Products in AI index', 'wp-ai-ebot'); ?></div>
                <div class="ai-ebot-metric-card__value"><?php echo esc_html($products_value); ?></div>
                <p class="ai-ebot-metric-card__hint"><?php echo esc_html($products_hint); ?></p>
            </div>
            <div class="ai-ebot-metric-card">
                <div class="ai-ebot-metric-card__label"><?php esc_html_e('Subscription tier', 'wp-ai-ebot'); ?></div>
                <div class="ai-ebot-metric-card__value"><?php echo esc_html($tier_value); ?></div>
                <?php if ($tier_hint !== '') : ?>
                    <p class="ai-ebot-metric-card__hint"><?php echo esc_html($tier_hint); ?></p>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }

    /**
     * Product vs index summary shown under the Reindex button (Overview).
     *
     * @param int $indexed Products included in the last successful full reindex
     * @param int $catalog Published WooCommerce product count
     */
    private static function render_product_index_status_card(int $indexed, int $catalog): void
    {
        $full_at = (int) get_option(Status::OPT_LAST_FULL_REINDEX_AT, 0);
        $last_ingest_at = (int) get_option(Status::OPT_LAST_INGEST_AT, 0);
        $ingest_ok = get_option(Status::OPT_LAST_INGEST_OK);
        $df = (string) get_option('date_format') . ' ' . (string) get_option('time_format');

        ob_start();
        if ($full_at > 0) {
            printf(
                /* translators: 1: indexed product count, 2: published product count */
                esc_html__('%1$d of %2$d published products included in the last full reindex.', 'wp-ai-ebot'),
                $indexed,
                $catalog
            );
        } else {
            esc_html_e('No successful full reindex yet.', 'wp-ai-ebot');
            if ($catalog > 0) {
                echo ' ';
                printf(
                    /* translators: %d: published product count */
                    esc_html__('Published products in catalog: %d.', 'wp-ai-ebot'),
                    $catalog
                );
            }
        }
        $catalog_line = ob_get_clean();

        $sync_class = 'ai-ebot-index-status__value ai-ebot-index-status__sync';
        ob_start();
        if ($last_ingest_at <= 0) {
            esc_html_e('—', 'wp-ai-ebot');
        } else {
            $ok = (string) $ingest_ok === '1';
            $sync_class .= $ok ? ' is-ok' : ' is-bad';
            echo esc_html($ok ? __('Succeeded', 'wp-ai-ebot') : __('Failed', 'wp-ai-ebot'));
            echo ' — ';
            echo esc_html(wp_date($df, $last_ingest_at));
        }
        $sync_line = ob_get_clean();

        $show_hint = $full_at > 0 && $indexed < $catalog;
        ?>
        <div id="ai-ebot-index-status" class="ai-ebot-index-status" aria-live="polite">
            <h3 class="title"><?php esc_html_e('Product index status', 'wp-ai-ebot'); ?></h3>
            <ul class="ai-ebot-index-status__list">
                <li>
                    <span class="ai-ebot-index-status__label"><?php esc_html_e('Catalog sync', 'wp-ai-ebot'); ?></span>
                    <span class="ai-ebot-index-status__value" id="ai-ebot-index-catalog-line"><?php echo $catalog_line; ?></span>
                </li>
                <li>
                    <span class="ai-ebot-index-status__label"><?php esc_html_e('Last full reindex', 'wp-ai-ebot'); ?></span>
                    <span class="ai-ebot-index-status__value" id="ai-ebot-index-reindex-at"><?php echo $full_at > 0 ? esc_html(Status::last_full_reindex_human()) : esc_html('—'); ?></span>
                </li>
                <li>
                    <span class="ai-ebot-index-status__label"><?php esc_html_e('Last service sync', 'wp-ai-ebot'); ?></span>
                    <span id="ai-ebot-index-last-sync" class="<?php echo esc_attr($sync_class); ?>"><?php echo $sync_line; ?></span>
                </li>
            </ul>
            <p class="description ai-ebot-index-status__hint" id="ai-ebot-index-hint" <?php echo $show_hint ? '' : 'hidden'; ?>>
                <?php esc_html_e('Counts can differ after catalog changes. Use “Reindex listed products” on the Product index tab to refresh.', 'wp-ai-ebot'); ?>
            </p>
        </div>
        <?php
    }
}
