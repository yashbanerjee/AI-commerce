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
        Chat_Store::maybe_install();

        $client = new Server_Client();
        if (! $client->is_configured()) {
            return new \WP_Error(
                'ai_ebot_not_configured',
                __('AI Ebot is not connected. Complete setup under Connection.', 'wp-ai-ebot'),
                ['status' => 503]
            );
        }

        $message = (string) $request->get_param('message');
        if (trim($message) === '') {
            return new \WP_Error('ai_ebot_empty', __('Message is empty.', 'wp-ai-ebot'), ['status' => 400]);
        }

        $remote = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash = $remote !== '' ? hash('sha256', $remote . wp_salt('auth')) : null;
        $wp_user_id = is_user_logged_in() ? get_current_user_id() : null;

        $public_session = sanitize_text_field((string) $request->get_param('session_id'));
        $session_row = ($public_session !== '' && Chat_Store::is_valid_public_id($public_session))
            ? Chat_Store::find_by_public_id($public_session)
            : null;

        if ($session_row === null) {
            $created = Chat_Store::create_session($wp_user_id, $ip_hash);
            $session_db_id = $created['id'];
            $public_session = $created['public_id'];
        } else {
            $session_db_id = (int) $session_row->id;
            $public_session = (string) $session_row->public_id;
        }

        $tone = get_option('ai_ebot_tone', '');
        $history = $request->get_param('history');
        if (! is_array($history)) {
            $history = [];
        }

        $payload = [
            'message' => $message,
            'tone' => is_string($tone) ? $tone : '',
            'history' => $history,
            'strict_grounding' => (bool) get_option('ai_ebot_strict_grounding', true),
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

        $body = $result['body'];
        if (is_array($body)) {
            $answer = isset($body['answer']) ? (string) $body['answer'] : '';
            Chat_Store::append_message($session_db_id, 'user', $message);
            Chat_Store::append_message($session_db_id, 'assistant', $answer);
            $body['session_id'] = $public_session;
        }

        return rest_ensure_response($body);
    }

    /**
     * Return stored messages for a session so returning visitors can see prior turns.
     *
     * @param \WP_REST_Request $request
     * @return \WP_REST_Response|\WP_Error
     */
    public function handle_session_messages(\WP_REST_Request $request)
    {
        Chat_Store::maybe_install();

        $public_id = (string) $request->get_param('public_id');
        if (! Chat_Store::is_valid_public_id($public_id)) {
            return new \WP_Error(
                'ai_ebot_invalid_session',
                __('Invalid session id.', 'wp-ai-ebot'),
                ['status' => 400]
            );
        }

        $session = Chat_Store::find_by_public_id($public_id);
        if ($session === null) {
            return new \WP_Error(
                'ai_ebot_session_not_found',
                __('Chat session not found.', 'wp-ai-ebot'),
                ['status' => 404]
            );
        }

        $owner_id = isset($session->user_id) ? (int) $session->user_id : 0;
        if ($owner_id > 0) {
            if (! is_user_logged_in() || (int) get_current_user_id() !== $owner_id) {
                return new \WP_Error(
                    'ai_ebot_session_forbidden',
                    __('You cannot load this chat history.', 'wp-ai-ebot'),
                    ['status' => 403]
                );
            }
        }

        $rows = Chat_Store::get_messages((int) $session->id, 500);
        $messages = [];
        foreach ($rows as $row) {
            $role = $row->role === 'assistant' ? 'assistant' : 'user';
            $messages[] = [
                'role' => $role,
                'content' => (string) $row->content,
            ];
        }

        return rest_ensure_response(
            [
                'session_id' => $public_id,
                'messages' => $messages,
            ]
        );
    }
}
