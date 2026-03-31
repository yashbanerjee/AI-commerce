<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

use AI_Ebot\Server_Client;

/**
 * Lists products currently stored in the AI Ebot vector index (from the service API).
 */
final class Indexed_Products_Tab
{
    private const PER_PAGE = 50;

    public static function render_section(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        $client = new Server_Client();
        if (! $client->is_configured()) {
            echo '<p class="description">' . esc_html__(
                'Connect AI Ebot on the Overview tab to load indexed products from the service.',
                'wp-ai-ebot'
            ) . '</p>';

            return;
        }

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $paged = isset($_GET['ipp']) ? max(1, (int) $_GET['ipp']) : 1;
        $offset = ($paged - 1) * self::PER_PAGE;

        $result = $client->get(
            '/v1/tenant/indexed-products',
            45,
            true,
            [
                'limit' => self::PER_PAGE,
                'offset' => $offset,
            ]
        );

        if (! $result['ok']) {
            $code = (int) ($result['code'] ?? 0);
            echo '<p>' . esc_html__('Could not load indexed products from the AI Ebot service.', 'wp-ai-ebot');
            if ($code > 0) {
                echo ' ';
                printf(
                    /* translators: %d: HTTP status code */
                    esc_html__('(HTTP %d)', 'wp-ai-ebot'),
                    $code
                );
            }
            echo '</p>';

            return;
        }

        $body = $result['body'];
        if (! is_array($body)) {
            echo '<p>' . esc_html__('Invalid response from the AI Ebot service.', 'wp-ai-ebot') . '</p>';

            return;
        }

        $total = isset($body['total']) ? (int) $body['total'] : 0;
        $rows = isset($body['products']) && is_array($body['products']) ? $body['products'] : [];
        $total_pages = (int) ceil(max(0, $total) / self::PER_PAGE);
        if ($total_pages < 1) {
            $total_pages = 1;
        }

        ?>
        <h3 class="title" style="margin-top:0;"><?php esc_html_e('Indexed products', 'wp-ai-ebot'); ?></h3>
        <p class="description" style="max-width:56rem;">
            <?php
            esc_html_e(
                'These are the products currently stored in the AI search index on the service (distinct items with embeddings). This can differ from your live WooCommerce catalog if the index is capped by plan or not yet fully reindexed.',
                'wp-ai-ebot'
            );
            ?>
        </p>
        <p class="description">
            <?php
            printf(
                /* translators: %d: total count */
                esc_html__('Total in index: %d', 'wp-ai-ebot'),
                $total
            );
            ?>
        </p>

        <?php if ($rows === []) : ?>
            <p><?php esc_html_e('No products in the index yet. Add products on the Product index tab and use “Reindex listed products”.', 'wp-ai-ebot'); ?></p>
        <?php else : ?>
        <table class="widefat striped" style="max-width:72rem;">
            <thead>
                <tr>
                    <th scope="col"><?php esc_html_e('Product', 'wp-ai-ebot'); ?></th>
                    <th scope="col"><?php esc_html_e('SKU', 'wp-ai-ebot'); ?></th>
                    <th scope="col"><?php esc_html_e('Storefront', 'wp-ai-ebot'); ?></th>
                    <th scope="col"><?php esc_html_e('Edit in WordPress', 'wp-ai-ebot'); ?></th>
                </tr>
            </thead>
            <tbody>
                <?php
                foreach ($rows as $raw) {
                    if (! is_array($raw)) {
                        continue;
                    }
                    $title = isset($raw['title']) ? (string) $raw['title'] : '';
                    $ext = isset($raw['external_id']) ? (string) $raw['external_id'] : '';
                    $url = isset($raw['url']) ? (string) $raw['url'] : '';
                    $sku = isset($raw['sku']) && $raw['sku'] !== null ? (string) $raw['sku'] : '';
                    $pid = 0;
                    if ($ext !== '' && preg_match('/^product:(\d+)$/', $ext, $m)) {
                        $pid = (int) $m[1];
                    }
                    $edit = ($pid > 0) ? get_edit_post_link($pid, '') : '';
                    ?>
                <tr>
                    <td><strong><?php echo esc_html($title !== '' ? $title : $ext); ?></strong></td>
                    <td><?php echo $sku !== '' ? esc_html($sku) : '<span class="description">—</span>'; ?></td>
                    <td>
                        <?php
                        if ($url !== '' && wp_http_validate_url($url)) {
                            echo '<a href="' . esc_url($url) . '" target="_blank" rel="noopener noreferrer">' . esc_html__('View', 'wp-ai-ebot') . '</a>';
                        } else {
                            echo '<span class="description">—</span>';
                        }
                        ?>
                    </td>
                    <td>
                        <?php
                        if ($edit !== '') {
                            echo '<a href="' . esc_url($edit) . '">' . esc_html__('Edit', 'wp-ai-ebot') . '</a>';
                        } else {
                            echo '<span class="description">—</span>';
                        }
                        ?>
                    </td>
                </tr>
                <?php } ?>
            </tbody>
        </table>

        <?php if ($total_pages > 1) : ?>
            <div class="tablenav" style="margin-top:1rem;">
                <div class="tablenav-pages">
                    <span class="displaying-num">
                        <?php
                        printf(
                            /* translators: %d: number of items */
                            esc_html(_n('%d item', '%d items', $total, 'wp-ai-ebot')),
                            $total
                        );
                        ?>
                    </span>
                    <?php
                    echo paginate_links(
                        [
                            'base' => add_query_arg('ipp', '%#%', self::pagination_base()),
                            'format' => '',
                            'prev_text' => '&laquo;',
                            'next_text' => '&raquo;',
                            'total' => $total_pages,
                            'current' => $paged,
                        ]
                    );
                    ?>
                </div>
            </div>
        <?php endif; ?>
        <?php endif; ?>
        <?php
    }

    private static function pagination_base(): string
    {
        $u = add_query_arg(
            [
                'page' => 'ai-ebot',
                'tab' => 'knowledge',
            ],
            admin_url('admin.php')
        );
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['ipa'])) {
            $u = add_query_arg('ipa', max(1, (int) $_GET['ipa']), $u);
        }

        return $u;
    }
}
