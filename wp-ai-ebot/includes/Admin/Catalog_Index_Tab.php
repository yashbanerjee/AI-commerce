<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

use AI_Ebot\Server_Client;
use AI_Ebot\Status;

/**
 * Manual product selection for AI indexing (plan-capped).
 */
final class Catalog_Index_Tab
{
    public const OPT_CURATED = 'ai_ebot_curated_product_ids_csv';

    /** @var positive-int */
    public const PER_PAGE = 25;

    public static function render(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        if (! Status::is_woocommerce_active()) {
            echo '<p class="description">' . esc_html__(
                'WooCommerce is required to manage product indexing.',
                'wp-ai-ebot'
            ) . '</p>';

            return;
        }

        $curated = self::get_curated_product_ids();
        $curated_set = array_fill_keys($curated, true);

        $paged = self::current_paged();
        $search = self::current_search();

        $q = new \WP_Query([
            'post_type' => 'product',
            'post_status' => 'publish',
            'posts_per_page' => self::PER_PAGE,
            'paged' => $paged,
            's' => $search,
            'orderby' => 'title',
            'order' => 'ASC',
            'no_found_rows' => false,
        ]);

        $billing = Status::fetch_billing_snapshot();
        $max_indexed = null;
        if (is_array($billing) && array_key_exists('max_indexed_products', $billing)) {
            $max_indexed = (int) $billing['max_indexed_products'];
        }
        $api_indexed = is_array($billing) ? (int) ($billing['indexed_product_count'] ?? 0) : null;

        $cap_label = $max_indexed === null
            ? __('—', 'wp-ai-ebot')
            : ($max_indexed <= 0 ? __('Unlimited', 'wp-ai-ebot') : (string) $max_indexed);
        $curated_count = count($curated);
        $slots = null;
        if ($max_indexed !== null && $max_indexed > 0) {
            $slots = max(0, $max_indexed - $curated_count);
        }

        $base_url = Settings::admin_tab_url('catalog-index');

        ?>
        <div class="ai-ebot-catalog-index" id="ai-ebot-catalog-index-wrap">
            <h2 class="title"><?php esc_html_e('Product index', 'wp-ai-ebot'); ?></h2>
            <p class="description" style="max-width:52rem;">
                <?php esc_html_e('Choose which published products are sent to the AI search index. Your plan limits how many distinct products can be stored; the count below includes only products in your curated list.', 'wp-ai-ebot'); ?>
            </p>

            <div class="ai-ebot-catalog-index__metrics" style="margin:1rem 0;">
                <?php
                printf(
                    /* translators: 1: number of products in curated list, 2: plan cap or "Unlimited"/"—" */
                    esc_html__('Curated for AI index: %1$s / %2$s', 'wp-ai-ebot'),
                    '<strong id="ai-ebot-ci-count">' . esc_html((string) $curated_count) . '</strong>',
                    '<strong id="ai-ebot-ci-cap">' . esc_html($cap_label) . '</strong>'
                );
                if ($api_indexed !== null) {
                    echo ' ';
                    printf(
                        /* translators: %d: distinct products the API reports as indexed */
                        esc_html__('(API reports %d distinct indexed products.)', 'wp-ai-ebot'),
                        $api_indexed
                    );
                }
                ?>
                <?php if ($max_indexed !== null && $max_indexed > 0 && $slots !== null) : ?>
                    <span class="description" id="ai-ebot-ci-slots-line">
                        <?php
                        printf(
                            /* translators: %d: remaining slots under plan for this list */
                            esc_html__('You can add up to %d more product(s) to this list.', 'wp-ai-ebot'),
                            $slots
                        );
                        ?>
                    </span>
                <?php endif; ?>
            </div>

            <?php if (! (new Server_Client())->is_configured()) : ?>
                <div class="notice notice-warning inline"><p><?php esc_html_e('Connect AI Ebot on Overview before sending products to the index.', 'wp-ai-ebot'); ?></p></div>
            <?php endif; ?>

            <div class="ai-ebot-catalog-index__layout">
                <div class="ai-ebot-catalog-index__col ai-ebot-catalog-index__col--left">
                    <h3><?php esc_html_e('Store catalog (published)', 'wp-ai-ebot'); ?></h3>
                    <form method="get" action="<?php echo esc_url(admin_url('admin.php')); ?>" class="ai-ebot-catalog-index__search" style="margin-bottom:0.75rem;">
                        <input type="hidden" name="page" value="ai-ebot" />
                        <input type="hidden" name="tab" value="catalog-index" />
                        <input type="search" name="ci_s" value="<?php echo esc_attr($search); ?>" placeholder="<?php esc_attr_e('Search products…', 'wp-ai-ebot'); ?>" />
                        <?php submit_button(__('Search', 'wp-ai-ebot'), 'secondary', 'submit', false, ['style' => 'vertical-align:middle;margin-left:4px;']); ?>
                    </form>

                    <div class="ai-ebot-catalog-index__table-wrap">
                        <table class="widefat striped">
                            <thead>
                                <tr>
                                    <th class="check-column"><input type="checkbox" id="ai-ebot-ci-check-all-left" /></th>
                                    <th><?php esc_html_e('Product', 'wp-ai-ebot'); ?></th>
                                    <th><?php esc_html_e('ID', 'wp-ai-ebot'); ?></th>
                                </tr>
                            </thead>
                            <tbody>
                                <?php
                                if (! $q->have_posts()) {
                                    echo '<tr><td colspan="3">' . esc_html__('No products found.', 'wp-ai-ebot') . '</td></tr>';
                                }
                                while ($q->have_posts()) {
                                    $q->the_post();
                                    $pid = (int) get_the_ID();
                                    $on_right = isset($curated_set[$pid]);
                                    $disabled = $on_right;
                                    ?>
                                    <tr class="<?php echo $disabled ? 'ai-ebot-ci-row--inactive' : ''; ?>" data-product-id="<?php echo esc_attr((string) $pid); ?>">
                                        <th scope="row" class="check-column">
                                            <?php if (! $disabled) : ?>
                                                <input type="checkbox" class="ai-ebot-ci-left-cb" value="<?php echo esc_attr((string) $pid); ?>" />
                                            <?php else : ?>
                                                <span class="dashicons dashicons-yes-alt" style="color:#007017;" title="<?php echo esc_attr__('In AI index list', 'wp-ai-ebot'); ?>"></span>
                                            <?php endif; ?>
                                        </th>
                                        <td><?php echo esc_html(get_the_title()); ?></td>
                                        <td><code><?php echo esc_html((string) $pid); ?></code></td>
                                    </tr>
                                    <?php
                                }
                                wp_reset_postdata();
                                ?>
                            </tbody>
                        </table>
                    </div>
                    <?php
                    if ($q->max_num_pages > 1) {
                        echo '<div class="tablenav"><div class="tablenav-pages">';
                        echo paginate_links(
                            [
                                'base' => add_query_arg(
                                    [
                                        'page' => 'ai-ebot',
                                        'tab' => 'catalog-index',
                                        'ci_s' => $search,
                                        'ci_paged' => '%#%',
                                    ],
                                    admin_url('admin.php')
                                ),
                                'format' => '',
                                'prev_text' => '&laquo;',
                                'next_text' => '&raquo;',
                                'total' => $q->max_num_pages,
                                'current' => $paged,
                            ]
                        );
                        echo '</div></div>';
                    }
                    ?>
                </div>

                <div class="ai-ebot-catalog-index__col ai-ebot-catalog-index__col--actions">
                    <button type="button" class="button button-primary" id="ai-ebot-ci-send" <?php echo (new Server_Client())->is_configured() ? '' : 'disabled'; ?>>
                        <?php esc_html_e('Send to AI', 'wp-ai-ebot'); ?>
                    </button>
                    <button type="button" class="button" id="ai-ebot-ci-remove" <?php echo (new Server_Client())->is_configured() ? '' : 'disabled'; ?>>
                        <?php esc_html_e('Remove from AI', 'wp-ai-ebot'); ?>
                    </button>
                    <button type="button" class="button" id="ai-ebot-ci-sync-structure" <?php echo (new Server_Client())->is_configured() ? '' : 'disabled'; ?>>
                        <?php esc_html_e('Sync store structure', 'wp-ai-ebot'); ?>
                    </button>
                    <p class="description" id="ai-ebot-ci-action-status" style="max-width:11rem;margin-top:0.75rem;" hidden aria-live="polite"></p>
                    <div id="ai-ebot-ci-progress" class="ai-ebot-knowledge-index-progress" style="max-width:11rem;margin-top:0.5rem;" hidden>
                        <div class="ai-ebot-knowledge-index-progress__track" aria-hidden="true">
                            <div class="ai-ebot-knowledge-index-progress__fill" style="width:0;"></div>
                        </div>
                    </div>
                </div>

                <div class="ai-ebot-catalog-index__col ai-ebot-catalog-index__col--right">
                    <h3><?php esc_html_e('AI index list', 'wp-ai-ebot'); ?></h3>
                    <?php
                    $ci_configured = (new Server_Client())->is_configured();
                    $ci_disable_bulk = ! $ci_configured || $curated_count === 0;
                    $ci_toolbar_lock = $ci_disable_bulk ? ' disabled="disabled" data-ai-ebot-ci-toolbar-locked="1"' : '';
                    ?>
                    <div class="ai-ebot-ci-reindex-toolbar" style="margin:0.5rem 0 0.75rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
                        <button type="button" class="button button-secondary" id="ai-ebot-ci-reindex-btn"<?php echo $ci_toolbar_lock; ?>>
                            <?php esc_html_e('Reindex listed products', 'wp-ai-ebot'); ?>
                        </button>
                        <button type="button" class="button ai-ebot-button-danger" id="ai-ebot-ci-remove-all-btn"<?php echo $ci_toolbar_lock; ?>>
                            <?php esc_html_e('Remove all from AI', 'wp-ai-ebot'); ?>
                        </button>
                    </div>

                    <div id="ai-ebot-ci-reindex-progress" class="ai-ebot-reindex-progress" style="max-width:36rem;" hidden>
                        <div class="ai-ebot-reindex-progress__track" aria-hidden="true">
                            <div class="ai-ebot-reindex-progress__fill" style="width:0;"></div>
                        </div>
                        <p class="ai-ebot-reindex-progress__label" id="ai-ebot-ci-reindex-progress-label"></p>
                    </div>

                    <div id="ai-ebot-ci-reindex-success" class="ai-ebot-reindex-success" style="max-width:36rem;" hidden>
                        <span class="dashicons dashicons-yes-alt" aria-hidden="true"></span>
                        <span id="ai-ebot-ci-reindex-success-text"></span>
                    </div>

                    <div id="ai-ebot-ci-reindex-error" class="ai-ebot-reindex-error" style="max-width:36rem;" role="alert" hidden></div>
                    <div class="ai-ebot-catalog-index__table-wrap">
                        <table class="widefat striped" id="ai-ebot-ci-right-table">
                            <thead>
                                <tr>
                                    <th class="check-column"><input type="checkbox" id="ai-ebot-ci-check-all-right" /></th>
                                    <th><?php esc_html_e('Product', 'wp-ai-ebot'); ?></th>
                                    <th><?php esc_html_e('ID', 'wp-ai-ebot'); ?></th>
                                </tr>
                            </thead>
                            <tbody id="ai-ebot-ci-right-body">
                                <?php
                                if ($curated === []) {
                                    echo '<tr id="ai-ebot-ci-right-empty"><td colspan="3"><em>' . esc_html__('No products in the list yet. Select rows on the left and click “Send to AI”.', 'wp-ai-ebot') . '</em></td></tr>';
                                } else {
                                    foreach ($curated as $pid) {
                                        self::render_right_row((int) $pid);
                                    }
                                }
                                ?>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <input type="hidden" id="ai_ebot_curated_csv_mirror" value="<?php echo esc_attr(implode(',', $curated)); ?>" />
        </div>
        <?php
    }

    /**
     * @return list<int>
     */
    public static function get_curated_product_ids(): array
    {
        $csv = trim((string) get_option(self::OPT_CURATED, ''));
        if ($csv === '') {
            return [];
        }
        $parts = array_filter(array_map('absint', explode(',', $csv)));

        return array_values(array_unique($parts));
    }

    /**
     * @param list<int> $ids
     */
    public static function save_curated_csv(array $ids): void
    {
        $parts = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        update_option(self::OPT_CURATED, implode(',', $parts));
    }

    private static function current_paged(): int
    {
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        return isset($_GET['ci_paged']) ? max(1, (int) $_GET['ci_paged']) : 1;
    }

    private static function current_search(): string
    {
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (! isset($_GET['ci_s'])) {
            return '';
        }

        return sanitize_text_field(wp_unslash((string) $_GET['ci_s']));
    }

    private static function render_right_row(int $pid): void
    {
        $title = get_the_title($pid);
        if ($title === '') {
            $title = sprintf(
                /* translators: %d: product ID */
                __('Product #%d (missing)', 'wp-ai-ebot'),
                $pid
            );
        }
        ?>
        <tr data-product-id="<?php echo esc_attr((string) $pid); ?>">
            <th scope="row" class="check-column">
                <input type="checkbox" class="ai-ebot-ci-right-cb" value="<?php echo esc_attr((string) $pid); ?>" />
            </th>
            <td><?php echo esc_html($title); ?></td>
            <td><code><?php echo esc_html((string) $pid); ?></code></td>
        </tr>
        <?php
    }
}
