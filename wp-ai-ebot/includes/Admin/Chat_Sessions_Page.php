<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

use AI_Ebot\Chat_Store;

/**
 * Customer chat sessions UI (embedded under AI Ebot → Chat sessions tab).
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
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $paged = isset($_GET['paged']) ? max(1, (int) $_GET['paged']) : 1;
        $offset = ($paged - 1) * self::PER_PAGE;
        $total = Chat_Store::count_sessions();
        $rows = Chat_Store::list_sessions($offset, self::PER_PAGE);
        $total_pages = (int) ceil(max(1, $total) / self::PER_PAGE);

        ?>
        <h2 class="title"><?php esc_html_e('Chat sessions', 'wp-ai-ebot'); ?></h2>
        <p class="description"><?php esc_html_e('Conversations from the storefront chat widget (saved after each successful reply).', 'wp-ai-ebot'); ?></p>
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
                        $uid = isset($row->user_id) ? (int) $row->user_id : 0;
                        $mc = isset($row->message_count) ? (int) $row->message_count : 0;
                        $pub = (string) $row->public_id;
                        $detail_url = self::sessions_base_url(['session' => $pub]);
                        ?>
                        <tr>
                            <td><?php echo esc_html(self::fmt_time((string) $row->updated_at)); ?></td>
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
        $session = Chat_Store::find_by_public_id($public_id);
        if ($session === null) {
            echo '<p>' . esc_html__('Session not found.', 'wp-ai-ebot') . '</p>';

            return;
        }

        $list_url = self::sessions_base_url();
        $messages = Chat_Store::get_messages((int) $session->id);
        $uid = isset($session->user_id) ? (int) $session->user_id : 0;

        ?>
        <p><a href="<?php echo esc_url($list_url); ?>">&larr; <?php esc_html_e('All chat sessions', 'wp-ai-ebot'); ?></a></p>
        <h2 class="title"><?php esc_html_e('Chat session', 'wp-ai-ebot'); ?></h2>
        <p class="description">
            <strong><?php esc_html_e('Session ID:', 'wp-ai-ebot'); ?></strong>
            <code><?php echo esc_html($public_id); ?></code>
            &nbsp;·&nbsp;
            <strong><?php esc_html_e('Started:', 'wp-ai-ebot'); ?></strong>
            <?php echo esc_html(self::fmt_time((string) $session->created_at)); ?>
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
                    $is_user = ($m->role ?? '') === 'user';
                    $align = $is_user ? 'right' : 'left';
                    $bg = $is_user ? '#e8f0fe' : '#f0f2f5';
                    ?>
                    <div style="text-align:<?php echo esc_attr($align); ?>;margin-bottom:0.75rem;">
                        <div style="display:inline-block;max-width:95%;text-align:left;padding:0.5rem 0.75rem;border-radius:10px;background:<?php echo esc_attr($bg); ?>;font-size:13px;">
                            <div style="font-size:10px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">
                                <?php echo $is_user ? esc_html__('Customer', 'wp-ai-ebot') : esc_html__('Assistant', 'wp-ai-ebot'); ?>
                                · <?php echo esc_html(self::fmt_time((string) $m->created_at)); ?>
                            </div>
                            <div style="white-space:pre-wrap;word-break:break-word;"><?php echo esc_html((string) $m->content); ?></div>
                        </div>
                    </div>
                <?php endforeach; ?>
            <?php endif; ?>
        </div>
        <?php
    }

    private static function fmt_time(string $mysql): string
    {
        $fmt = (string) get_option('date_format') . ' ' . (string) get_option('time_format');
        $out = mysql2date($fmt, $mysql, true);

        return $out !== '' && $out !== false ? (string) $out : $mysql;
    }
}
