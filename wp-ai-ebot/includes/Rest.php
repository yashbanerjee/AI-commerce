<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * WordPress REST API: chat proxy (keeps server API key server-side).
 */
final class Rest
{
    private const NS = 'ai-ebot/v1';

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
        add_action('rest_api_init', [$this, 'register_routes']);
        /** After {@see rest_cookie_check_errors} (priority 99): bootstrap must work without a prior X-WP-Nonce for logged-in users. */
        add_filter('rest_authentication_errors', [$this, 'maybe_allow_bootstrap_without_rest_cookie_nonce'], 100);
    }

    /**
     * Logged-in visitors send session cookies; WordPress then requires X-WP-Nonce on REST requests.
     * Bootstrap exists to *issue* that nonce, so we clear cookie-nonce failures for GET bootstrap only.
     *
     * @param bool|\WP_Error|null|mixed $errors
     * @return bool|\WP_Error|null|mixed
     */
    public function maybe_allow_bootstrap_without_rest_cookie_nonce($errors)
    {
        if ($errors === true || $errors === null || $errors === false) {
            return $errors;
        }
        if (! $errors instanceof \WP_Error) {
            return $errors;
        }
        if (! self::is_rest_bootstrap_get_request()) {
            return $errors;
        }
        $code = $errors->get_error_code();
        if ($code === 'rest_cookie_invalid_nonce') {
            return true;
        }
        if ($code === 'rest_forbidden') {
            $msg = strtolower($errors->get_error_message());
            if (strpos($msg, 'cookie') !== false || strpos($msg, 'nonce') !== false) {
                return true;
            }
        }

        return $errors;
    }

    private static function is_rest_bootstrap_get_request(): bool
    {
        $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string) $_SERVER['REQUEST_METHOD']) : '';
        if ($method !== 'GET' && $method !== 'HEAD') {
            return false;
        }
        $uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
        if (strpos($uri, 'ai-ebot/v1/bootstrap') !== false) {
            return true;
        }
        // Plain permalinks: ?rest_route=/ai-ebot/v1/bootstrap
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['rest_route']) && is_string($_GET['rest_route'])) {
            $rr = trim($_GET['rest_route'], '/');
            if ($rr === 'ai-ebot/v1/bootstrap') {
                return true;
            }
        }

        return false;
    }

    public function register_routes(): void
    {
        register_rest_route(self::NS, '/bootstrap', [
            'methods' => 'GET',
            'callback' => [$this, 'handle_bootstrap'],
            'permission_callback' => '__return_true',
        ]);

        register_rest_route(self::NS, '/chat', [
            'methods' => 'POST',
            'callback' => [$this, 'handle_chat'],
            'permission_callback' => [$this, 'verify_chat_nonce'],
            'args' => [
                'message' => [
                    'required' => true,
                    'type' => 'string',
                    'sanitize_callback' => 'sanitize_text_field',
                ],
                'session_id' => [
                    'required' => false,
                    'type' => 'string',
                    'sanitize_callback' => 'sanitize_text_field',
                ],
                'history' => [
                    'required' => false,
                    'type' => 'array',
                    'default' => [],
                ],
            ],
        ]);

        register_rest_route(self::NS, '/chat/session/(?P<public_id>[0-9a-fA-F-]{36})/messages', [
            'methods' => 'GET',
            'callback' => [$this, 'handle_session_messages'],
            'permission_callback' => [$this, 'verify_chat_nonce'],
        ]);
    }

    /**
     * Fresh REST nonce + URLs for the current visitor (fixes full-page cache serving a logged-in user’s nonce to guests).
     */
    public function handle_bootstrap(\WP_REST_Request $_request): \WP_REST_Response
    {
        nocache_headers();
        if (! headers_sent()) {
            header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            header('Pragma: no-cache');
        }

        return rest_ensure_response(
            [
                'rest_url' => rest_url('ai-ebot/v1/chat'),
                'nonce' => wp_create_nonce('wp_rest'),
            ]
        );
    }

    /**
     * Allow chat for visitors with valid REST nonce (localized on frontend).
     */
    public function verify_chat_nonce(): bool
    {
        $nonce = isset($_SERVER['HTTP_X_WP_NONCE'])
            ? sanitize_text_field(wp_unslash((string) $_SERVER['HTTP_X_WP_NONCE']))
            : '';
        if ($nonce === '') {
            return false;
        }

        return (bool) wp_verify_nonce($nonce, 'wp_rest');
    }

    /**
     * @param \WP_REST_Request $request
     * @return \WP_REST_Response|\WP_Error
     */
    public function handle_chat(\WP_REST_Request $request)
    {
        $client = new Server_Client();
        if (! $client->is_configured()) {
            return new \WP_Error(
                'ai_ebot_not_configured',
                __('AI Ebot is not connected. Complete setup on the Overview tab.', 'wp-ai-ebot'),
                ['status' => 503]
            );
        }

        $message = (string) $request->get_param('message');
        if (trim($message) === '') {
            return new \WP_Error('ai_ebot_empty', __('Message is empty.', 'wp-ai-ebot'), ['status' => 400]);
        }

        $remote = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash = $remote !== '' ? hash('sha256', $remote . wp_salt('auth')) : null;
        $wp_user_id = is_user_logged_in() ? (int) get_current_user_id() : null;

        $public_session = sanitize_text_field((string) $request->get_param('session_id'));

        $preset = sanitize_key((string) get_option(Tone::OPT_PRESET, 'custom'));
        $allowed_presets = array_keys(Tone::preset_labels());
        if (! in_array($preset, $allowed_presets, true)) {
            $preset = 'custom';
        }
        $tone_notes = trim((string) get_option('ai_ebot_tone', ''));
        if ($tone_notes !== '' && function_exists('mb_substr')) {
            $tone_notes = mb_substr($tone_notes, 0, 500);
        } elseif ($tone_notes !== '') {
            $tone_notes = substr($tone_notes, 0, 500);
        }

        $history = $request->get_param('history');
        if (! is_array($history)) {
            $history = [];
        }

        $payload = [
            'message' => $message,
            /** Compact style selector + optional notes (avoids sending long preset boilerplate on every chat). */
            'tone_preset' => $preset,
            'tone_notes' => $tone_notes,
            'strict_grounding' => (bool) get_option('ai_ebot_strict_grounding', true),
            'session_id' => $public_session,
            'wp_user_id' => $wp_user_id,
            'ip_hash' => $ip_hash,
            'history' => $history,
        ];
        if (Status::is_woocommerce_active()) {
            $payload['published_products'] = Status::published_product_count();
            $catalog = Catalog_Context::build_for_chat();
            if ($catalog !== '') {
                $payload['catalog_context'] = $catalog;
            }
        }

        $result = $client->chat($payload);
        if (! $result['ok']) {
            $body = $result['body'];
            $err = is_array($body) && isset($body['error'])
                ? (string) $body['error']
                : __('Service request failed.', 'wp-ai-ebot');
            $http = (int) $result['code'];
            if ($http <= 0) {
                $http = 502;
            }
            $data = ['status' => $http];
            if (is_array($body)) {
                if (isset($body['code'])) {
                    $data['code'] = (string) $body['code'];
                }
                if (isset($body['upgrade_url'])) {
                    $data['upgrade_url'] = (string) $body['upgrade_url'];
                }
                if (isset($body['used_chats_this_month'])) {
                    $data['used_chats_this_month'] = (int) $body['used_chats_this_month'];
                }
                if (isset($body['monthly_chat_quota'])) {
                    $data['monthly_chat_quota'] = (int) $body['monthly_chat_quota'];
                }
            }

            return new \WP_Error('ai_ebot_server', $err, $data);
        }

        return rest_ensure_response($result['body']);
    }

    /**
     * Return stored messages for a session so returning visitors can see prior turns.
     *
     * @param \WP_REST_Request $request
     * @return \WP_REST_Response|\WP_Error
     */
    public function handle_session_messages(\WP_REST_Request $request)
    {
        $client = new Server_Client();
        if (! $client->is_configured()) {
            return new \WP_Error(
                'ai_ebot_not_configured',
                __('AI Ebot is not connected. Complete setup on the Overview tab.', 'wp-ai-ebot'),
                ['status' => 503]
            );
        }

        $public_id = (string) $request->get_param('public_id');
        if (! Chat_Store::is_valid_public_id($public_id)) {
            return new \WP_Error(
                'ai_ebot_invalid_session',
                __('Invalid session id.', 'wp-ai-ebot'),
                ['status' => 400]
            );
        }

        $viewer = is_user_logged_in() ? (int) get_current_user_id() : 0;
        $path = '/v1/chat/session/' . rawurlencode($public_id) . '/messages';
        $result = $client->get($path, 30, true, ['viewer_wp_user_id' => $viewer]);

        if (! $result['ok']) {
            $code = (int) $result['code'];
            if ($code === 404) {
                return new \WP_Error(
                    'ai_ebot_session_not_found',
                    __('Chat session not found.', 'wp-ai-ebot'),
                    ['status' => 404]
                );
            }
            if ($code === 403) {
                return new \WP_Error(
                    'ai_ebot_session_forbidden',
                    __('You cannot load this chat history.', 'wp-ai-ebot'),
                    ['status' => 403]
                );
            }

            return new \WP_Error(
                'ai_ebot_server',
                __('Could not load chat history.', 'wp-ai-ebot'),
                ['status' => $code >= 400 && $code < 600 ? $code : 502]
            );
        }

        $body = $result['body'];
        if (! is_array($body)) {
            return new \WP_Error(
                'ai_ebot_server',
                __('Invalid response from AI Ebot service.', 'wp-ai-ebot'),
                ['status' => 502]
            );
        }

        $sid = isset($body['session_id']) ? (string) $body['session_id'] : $public_id;
        $messages = isset($body['messages']) && is_array($body['messages']) ? $body['messages'] : [];

        return rest_ensure_response(
            [
                'session_id' => $sid,
                'messages' => $messages,
            ]
        );
    }
}
