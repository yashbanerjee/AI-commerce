<?php

declare(strict_types=1);

namespace AI_Ebot\Admin;

/**
 * Knowledge & index tab: page picker, custom chunks, indexed content previews.
 */
final class Knowledge_Tab
{
    public static function render(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        $custom = get_option('ai_ebot_custom_chunks', []);
        if (! is_array($custom)) {
            $custom = [];
        }

        $csv = trim((string) get_option('ai_ebot_sync_page_ids_csv', ''));
        $ids = $csv !== '' ? array_filter(array_map('absint', explode(',', $csv))) : [];
        $ids = array_values(array_unique($ids));

        self::render_pages_form($ids);
        self::render_custom_chunks_form($custom);
        echo '<hr style="margin:2.5rem 0;" />';
        Indexed_Products_Tab::render_section();
        Indexed_Pages_Tab::render_section();
    }

    /**
     * @param list<int> $selected_ids
     */
    private static function render_pages_form(array $selected_ids): void
    {
        $all_pages = get_pages(
            [
                'sort_column' => 'post_title',
                'sort_order' => 'ASC',
                'post_status' => 'publish',
            ]
        );

        $titles = [];
        foreach ($all_pages as $p) {
            $titles[(string) (int) $p->ID] = $p->post_title;
        }

        $csv_attr = esc_attr(implode(',', $selected_ids));
        ?>
        <div id="ai-ebot-knowledge-pages-wrap" data-previous-csv="<?php echo $csv_attr; ?>">
        <form method="post" action="" style="margin-top:0;" id="ai-ebot-knowledge-pages-form">
            <h2 class="title"><?php esc_html_e('Pages to sync', 'wp-ai-ebot'); ?></h2>
            <p class="description" style="max-width:56rem;">
                <?php esc_html_e('Choose pages to include in the AI index (for example About, FAQ, policies). Click Save and index to update the list and send only new pages to the service. Removing a page here also removes it from the index.', 'wp-ai-ebot'); ?>
            </p>

            <input type="hidden" id="ai_ebot_sync_page_ids_csv" value="<?php echo $csv_attr; ?>" />

            <p style="max-width:40rem;">
                <label for="ai_ebot_page_add_select" class="screen-reader-text"><?php esc_html_e('Add a page', 'wp-ai-ebot'); ?></label>
                <select id="ai_ebot_page_add_select" style="max-width:100%;">
                    <option value=""><?php esc_html_e('— Search or select a page to add —', 'wp-ai-ebot'); ?></option>
                    <?php
                    foreach ($all_pages as $p) {
                        $pid = (int) $p->ID;
                        echo '<option value="' . esc_attr((string) $pid) . '" data-title="' . esc_attr($p->post_title) . '">';
                        echo esc_html($p->post_title) . ' (ID ' . $pid . ')';
                        echo '</option>';
                    }
                    ?>
                </select>
            </p>

            <p>
                <button type="button" class="button" id="ai_ebot_page_add_btn"><?php esc_html_e('Add page', 'wp-ai-ebot'); ?></button>
            </p>

            <h3 class="title" style="font-size:14px;margin-top:1.5rem;"><?php esc_html_e('Selected pages', 'wp-ai-ebot'); ?></h3>
            <ul id="ai_ebot_selected_pages" class="ai-ebot-selected-pages" style="list-style:disc;margin-left:1.25rem;max-width:56rem;">
                <?php
                if ($selected_ids === []) {
                    echo '<li class="ai-ebot-no-pages"><em>' . esc_html__('None yet. Add pages using the list above.', 'wp-ai-ebot') . '</em></li>';
                } else {
                    foreach ($selected_ids as $pid) {
                        $pid = (int) $pid;
                        if ($pid <= 0) {
                            continue;
                        }
                        $t = isset($titles[(string) $pid]) ? $titles[(string) $pid] : sprintf(/* translators: %d: page ID */ __('Page ID %d', 'wp-ai-ebot'), $pid);
                        self::render_page_list_item($pid, $t);
                    }
                }
                ?>
            </ul>

            <p class="submit" style="margin-top:1rem;">
                <button type="button" class="button button-primary" id="ai-ebot-save-index-pages">
                    <?php esc_html_e('Save and index', 'wp-ai-ebot'); ?>
                </button>
            </p>

            <div id="ai-ebot-knowledge-index-status" class="ai-ebot-knowledge-index-status" hidden aria-live="polite">
                <p class="ai-ebot-knowledge-index-status__text" id="ai-ebot-knowledge-index-status-text"></p>
                <div id="ai-ebot-knowledge-index-progress" class="ai-ebot-knowledge-index-progress" hidden>
                    <div class="ai-ebot-knowledge-index-progress__track" aria-hidden="true">
                        <div class="ai-ebot-knowledge-index-progress__fill"></div>
                    </div>
                </div>
            </div>
        </form>
        </div>

        <script>
        (function () {
            var hidden = document.getElementById('ai_ebot_sync_page_ids_csv');
            var listEl = document.getElementById('ai_ebot_selected_pages');
            var select = document.getElementById('ai_ebot_page_add_select');
            var addBtn = document.getElementById('ai_ebot_page_add_btn');
            if (!hidden || !listEl || !select || !addBtn) return;

            function parseIds() {
                var s = hidden.value.trim();
                if (!s) return [];
                return s.split(',').map(function (x) { return parseInt(x, 10); }).filter(function (n) { return n > 0; });
            }

            function setIds(ids) {
                var uniq = [];
                ids.forEach(function (id) {
                    if (uniq.indexOf(id) === -1) uniq.push(id);
                });
                hidden.value = uniq.join(',');
            }

            function removePid(pid) {
                var ids = parseIds().filter(function (id) { return id !== pid; });
                setIds(ids);
                var li = listEl.querySelector('[data-page-id="' + pid + '"]');
                if (li) li.remove();
                if (!listEl.querySelector('li[data-page-id]')) {
                    var empty = listEl.querySelector('.ai-ebot-no-pages');
                    if (!empty) {
                        empty = document.createElement('li');
                        empty.className = 'ai-ebot-no-pages';
                        empty.innerHTML = '<em><?php echo esc_js(__('None yet. Add pages using the list above.', 'wp-ai-ebot')); ?></em>';
                        listEl.appendChild(empty);
                    }
                }
            }

            addBtn.addEventListener('click', function () {
                var opt = select.options[select.selectedIndex];
                var pid = parseInt(opt.value, 10);
                if (!pid) return;
                var title = opt.getAttribute('data-title') || opt.text;
                var ids = parseIds();
                if (ids.indexOf(pid) !== -1) return;
                ids.push(pid);
                setIds(ids);
                var empty = listEl.querySelector('.ai-ebot-no-pages');
                if (empty) empty.remove();
                var li = document.createElement('li');
                li.setAttribute('data-page-id', String(pid));
                li.innerHTML = '<span class="ai-ebot-page-title"></span> ' +
                    '<button type="button" class="button-link ai-ebot-remove-page" aria-label="<?php echo esc_js(__('Remove', 'wp-ai-ebot')); ?>"><?php echo esc_js(__('Remove', 'wp-ai-ebot')); ?></button>';
                li.querySelector('.ai-ebot-page-title').textContent = title + ' (ID ' + pid + ')';
                li.querySelector('.ai-ebot-remove-page').addEventListener('click', function () { removePid(pid); });
                listEl.appendChild(li);
                select.selectedIndex = 0;
            });

            listEl.querySelectorAll('.ai-ebot-remove-page').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var li = btn.closest('li[data-page-id]');
                    if (!li) return;
                    removePid(parseInt(li.getAttribute('data-page-id'), 10));
                });
            });

        })();
        </script>
        <?php
    }

    /**
     * @param array<int, array{title: string, body: string}> $custom
     */
    private static function render_custom_chunks_form(array $custom): void
    {
        ?>
        <form method="post" action="options.php" style="margin-top:2em;">
            <?php settings_fields(Settings::option_group()); ?>
            <h2 class="title"><?php esc_html_e('Custom knowledge', 'wp-ai-ebot'); ?></h2>
            <div id="ai-ebot-chunks">
                <?php
                $rows = array_merge($custom, [['title' => '', 'body' => '']]);
                foreach ($rows as $i => $row) {
                    $t = isset($row['title']) ? (string) $row['title'] : '';
                    $b = isset($row['body']) ? (string) $row['body'] : '';
                    ?>
                    <div class="ai-ebot-chunk" style="margin-bottom:1em;padding:1em;border:1px solid #ccd0d4;">
                        <p><label><?php esc_html_e('Title', 'wp-ai-ebot'); ?> <input type="text" name="ai_ebot_custom_chunks[<?php echo esc_attr((string) $i); ?>][title]" value="<?php echo esc_attr($t); ?>" class="regular-text" /></label></p>
                        <p><label><?php esc_html_e('Content', 'wp-ai-ebot'); ?><br />
                        <textarea name="ai_ebot_custom_chunks[<?php echo esc_attr((string) $i); ?>][body]" rows="4" class="large-text"><?php echo esc_textarea($b); ?></textarea></label></p>
                    </div>
                    <?php
                }
                ?>
            </div>
            <?php submit_button(__('Save custom chunks', 'wp-ai-ebot')); ?>
        </form>
        <?php
    }

    private static function render_page_list_item(int $pid, string $title): void
    {
        ?>
        <li data-page-id="<?php echo esc_attr((string) $pid); ?>">
            <span class="ai-ebot-page-title"><?php echo esc_html($title); ?> (ID <?php echo esc_html((string) $pid); ?>)</span>
            <button type="button" class="button-link ai-ebot-remove-page" aria-label="<?php esc_attr_e('Remove', 'wp-ai-ebot'); ?>"><?php esc_html_e('Remove', 'wp-ai-ebot'); ?></button>
        </li>
        <?php
    }
}
