<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

use AI_Ebot\Chat_Store;
use AI_Ebot\Server_Client;

/**
 * Customer chat sessions UI (embedded under AI Ebot → Chat sessions tab); data from the AI Ebot API.
 */
final class Chat_Sessions_Page
{
    private const PER_PAGE = 25;

    public static function init(): void
    {
        add_action('admin_init', [self::class, 'redirect_legacy_submenu']);
    }

    /**
     * Old submenu URL → main settings tab.
     */
    public static function redirect_legacy_submenu(): void
    {
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (! isset($_GET['page']) || $_GET['page'] !== 'ai-ebot-chat-sessions') {
            return;
        }
        if (! current_user_can('manage_options')) {
            return;
        }
        $args = [
            'page' => 'ai-ebot',
            'tab' => 'sessions',
        ];
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['session'])) {
            $args['session'] = sanitize_text_field(wp_unslash((string) $_GET['session']));
        }
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['paged'])) {
            $args['paged'] = max(1, (int) $_GET['paged']);
        }
        wp_safe_redirect(add_query_arg($args, admin_url('admin.php')));
        exit;
    }

    /**
     * Renders list or detail inside the settings screen (no extra wrap).
     */
    public static function render_tab(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $session_public = isset($_GET['session']) ? sanitize_text_field(wp_unslash((string) $_GET['session'])) : '';
        if ($session_public !== '' && Chat_Store::is_valid_public_id($session_public)) {
            self::render_detail($session_public);

            return;
        }

        self::render_list();
    }

    private static function sessions_base_url(array $extra = []): string
    {
        return add_query_arg(
            array_merge(['page' => 'ai-ebot', 'tab' => 'sessions'], $extra),
            admin_url('admin.php')
        );
    }

    private static function render_list(): void
    {
        $client = new Server_Client();
        if (! $client->is_configured()) {
            echo '<p class="description">' . esc_html__(
                'Connect AI Ebot on the Overview tab to load chat sessions from the service.',
                'wp-ai-ebot'
            ) . '</p>';

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $paged = isset($_GET['paged']) ? max(1, (int) $_GET['paged']) : 1;
        $offset = ($paged - 1) * self::PER_PAGE;

        $result = $client->get(
            '/v1/tenant/chat-sessions',
            30,
            true,
            [
                'limit' => self::PER_PAGE,
                'offset' => $offset,
            ]
        );

        if (! $result['ok']) {
            echo '<p>' . esc_html__('Could not load sessions from the AI Ebot service.', 'wp-ai-ebot') . '</p>';

            return;
        }

        $body = $result['body'];
        if (! is_array($body)) {
            echo '<p>' . esc_html__('Invalid response from the AI Ebot service.', 'wp-ai-ebot') . '</p>';

            return;
        }

        $total = isset($body['total']) ? (int) $body['total'] : 0;
        $rows = isset($body['sessions']) && is_array($body['sessions']) ? $body['sessions'] : [];
        $total_pages = (int) ceil(max(1, $total) / self::PER_PAGE);

        ?>
        <h2 class="title"><?php esc_html_e('Chat sessions', 'wp-ai-ebot'); ?></h2>
        <p class="description"><?php esc_html_e('Conversations from the storefront widget, stored on your AI Ebot service.', 'wp-ai-ebot'); ?></p>
        <?php if ($total === 0) : ?>
            <p><?php esc_html_e('No sessions yet.', 'wp-ai-ebot'); ?></p>
        <?php else : ?>
            <table class="widefat striped" style="max-width: 960px;">
                <thead>
                    <tr>
                        <th><?php esc_html_e('Last activity', 'wp-ai-ebot'); ?></th>
                        <th><?php esc_html_e('Visitor', 'wp-ai-ebot'); ?></th>
                        <th><?php esc_html_e('Messages', 'wp-ai-ebot'); ?></th>
                        <th><?php esc_html_e('Session ID', 'wp-ai-ebot'); ?></th>
                        <th><?php esc_html_e('Actions', 'wp-ai-ebot'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($rows as $row) : ?>
                        <?php
                        if (! is_array($row)) {
                            continue;
                        }
                        $uid = isset($row['shopper_wp_user_id']) && $row['shopper_wp_user_id'] !== null
                            ? (int) $row['shopper_wp_user_id']
                            : 0;
                        $mc = isset($row['message_count']) ? (int) $row['message_count'] : 0;
                        $pub = isset($row['public_id']) ? (string) $row['public_id'] : '';
                        if ($pub === '') {
                            continue;
                        }
                        $updated_at = isset($row['updated_at']) ? (string) $row['updated_at'] : '';
                        $detail_url = self::sessions_base_url(['session' => $pub]);
                        ?>
                        <tr>
                            <td><?php echo esc_html(self::fmt_iso_time($updated_at)); ?></td>
                            <td>
                                <?php
                                if ($uid > 0) {
                                    $u = get_userdata($uid);
                                    echo $u ? esc_html($u->display_name . ' (#' . $uid . ')') : esc_html('#' . $uid);
                                } else {
                                    esc_html_e('Guest', 'wp-ai-ebot');
                                }
                                ?>
                            </td>
                            <td><?php echo esc_html((string) $mc); ?></td>
                            <td><code style="font-size:11px;"><?php echo esc_html($pub); ?></code></td>
                            <td><a href="<?php echo esc_url($detail_url); ?>"><?php esc_html_e('View', 'wp-ai-ebot'); ?></a></td>
                        </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
            <?php
            if ($total_pages > 1) {
                $list_page_url = self::sessions_base_url();
                $base = add_query_arg('paged', '%#%', $list_page_url);
                echo '<div class="tablenav"><div class="tablenav-pages">';
                echo paginate_links(
                    [
                        'base' => $base,
                        'format' => '',
                        'prev_text' => '&laquo;',
                        'next_text' => '&raquo;',
                        'total' => $total_pages,
                        'current' => $paged,
                    ]
                );
                echo '</div></div>';
            }
            ?>
        <?php endif; ?>
        <?php
    }

    private static function render_detail(string $public_id): void
    {
        $client = new Server_Client();
        if (! $client->is_configured()) {
            echo '<p class="description">' . esc_html__(
                'Connect AI Ebot on the Overview tab to load this session.',
                'wp-ai-ebot'
            ) . '</p>';

            return;
        }

        $path = '/v1/tenant/chat-sessions/' . rawurlencode($public_id) . '/messages';
        $result = $client->get($path, 45, true);

        if (! $result['ok']) {
            if ((int) $result['code'] === 404) {
                echo '<p>' . esc_html__('Session not found.', 'wp-ai-ebot') . '</p>';
            } else {
                echo '<p>' . esc_html__('Could not load this session from the AI Ebot service.', 'wp-ai-ebot') . '</p>';
            }

            return;
        }

        $body = $result['body'];
        if (! is_array($body)) {
            echo '<p>' . esc_html__('Invalid response from the AI Ebot service.', 'wp-ai-ebot') . '</p>';

            return;
        }

        $messages = isset($body['messages']) && is_array($body['messages']) ? $body['messages'] : [];
        $uid = isset($body['shopper_wp_user_id']) && $body['shopper_wp_user_id'] !== null
            ? (int) $body['shopper_wp_user_id']
            : 0;
        $created_at = isset($body['created_at']) ? (string) $body['created_at'] : '';

        $list_url = self::sessions_base_url();

        ?>
        <p><a href="<?php echo esc_url($list_url); ?>">&larr; <?php esc_html_e('All chat sessions', 'wp-ai-ebot'); ?></a></p>
        <h2 class="title"><?php esc_html_e('Chat session', 'wp-ai-ebot'); ?></h2>
        <p class="description">
            <strong><?php esc_html_e('Session ID:', 'wp-ai-ebot'); ?></strong>
            <code><?php echo esc_html($public_id); ?></code>
            &nbsp;·&nbsp;
            <strong><?php esc_html_e('Started:', 'wp-ai-ebot'); ?></strong>
            <?php echo esc_html(self::fmt_iso_time($created_at)); ?>
            &nbsp;·&nbsp;
            <strong><?php esc_html_e('Visitor:', 'wp-ai-ebot'); ?></strong>
            <?php
            if ($uid > 0) {
                $u = get_userdata($uid);
                echo $u ? esc_html($u->display_name . ' (#' . $uid . ')') : esc_html('#' . $uid);
            } else {
                esc_html_e('Guest', 'wp-ai-ebot');
            }
            ?>
        </p>
        <div style="max-width:720px;margin-top:1.5rem;padding:1rem;background:#fff;border:1px solid #c3c4c7;border-radius:4px;">
            <?php if ($messages === []) : ?>
                <p><?php esc_html_e('No messages stored.', 'wp-ai-ebot'); ?></p>
            <?php else : ?>
                <?php foreach ($messages as $m) : ?>
                    <?php
                    if (! is_array($m)) {
                        continue;
                    }
                    $role = isset($m['role']) ? (string) $m['role'] : '';
                    $is_user = $role === 'user';
                    $align = $is_user ? 'right' : 'left';
                    $bg = $is_user ? '#e8f0fe' : '#f0f2f5';
                    $content = isset($m['content']) ? (string) $m['content'] : '';
                    $ts = isset($m['created_at']) ? (string) $m['created_at'] : '';
                    ?>
                    <div style="text-align:<?php echo esc_attr($align); ?>;margin-bottom:0.75rem;">
                        <div style="display:inline-block;max-width:95%;text-align:left;padding:0.5rem 0.75rem;border-radius:10px;background:<?php echo esc_attr($bg); ?>;font-size:13px;">
                            <div style="font-size:10px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">
                                <?php echo $is_user ? esc_html__('Customer', 'wp-ai-ebot') : esc_html__('Assistant', 'wp-ai-ebot'); ?>
                                · <?php echo esc_html(self::fmt_iso_time($ts)); ?>
                            </div>
                            <div style="white-space:pre-wrap;word-break:break-word;"><?php echo esc_html($content); ?></div>
                        </div>
                    </div>
                <?php endforeach; ?>
            <?php endif; ?>
        </div>
        <?php
    }

    private static function fmt_iso_time(string $iso): string
    {
        if ($iso === '') {
            return '—';
        }
        $ts = strtotime($iso);
        if ($ts === false) {
            return $iso;
        }
        $fmt = (string) get_option('date_format') . ' ' . (string) get_option('time_format');

        return wp_date($fmt, $ts);
    }
}
