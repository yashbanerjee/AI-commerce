=== AI Ebot for WooCommerce ===
Contributors: aiebot
Tags: woocommerce, chat, assistant, ecommerce, ai
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.3.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds a storefront AI chat for WooCommerce that uses your own AI Ebot-compatible hosted API for answers, product context, and indexing.

== Description ==

**AI Ebot for WooCommerce** connects your site to an **external AI Ebot API service** (Software as a Service). The plugin does not bundle large language models; it registers your store, syncs catalog text for retrieval, and proxies chat requests so API keys stay on the server.

**You need:**

* WooCommerce
* A reachable AI Ebot API base URL (the plugin ships a default host; override with `AI_EBOT_SERVER_BASE_URL` or the legacy `AI_EBOT_CLOUD_BASE_URL` in `wp-config.php` if you use another API)
* To complete **Connection** in wp-admin so the site receives a Site ID and service key

**What the service does (high level):**

* Stores embeddings and catalog chunks for search-backed replies
* Processes chat messages to generate assistant answers
* May enforce usage limits according to your operator’s billing setup

**Important:** Functionality depends on that third-party service. Obtain **terms of use**, **privacy policy**, and support contacts **from your AI Ebot service operator** before going live. This plugin assists integration; it does not replace your legal obligations as a site owner.

**Data overview**

* **Sent to the API:** Site URL, site display name, software versions (WordPress, WooCommerce, plugin), product and page text you choose to sync, chat messages submitted through the widget (via WordPress REST), and occasional **admin heartbeat** metadata (site name and versions, at most about once per day while wp-admin is used) to help the operator run the service.
* **Stored on your WordPress site:** Chat sessions and messages in custom database tables for continuity and for the optional Chat sessions screen in wp-admin. Logged-in customers may have sessions tied to their user ID; guests may have sessions with a hashed IP for abuse reduction.

Use the **Tools → Export Personal Data** and **Erase Personal Data** flows for WordPress users linked to chat sessions. Guest-only sessions are not tied to an email address and may require manual cleanup if your policy requires it.

== Installation ==

1. Upload the plugin files to `/wp-content/plugins/wp-ai-ebot` or install through the WordPress plugins screen.
2. Activate the plugin through the **Plugins** menu.
3. Define your AI Ebot API base URL (see FAQ) if the default is not correct for your environment.
4. Open **AI Ebot** in the admin menu, go to **Connection**, and connect your site.
5. Run a full reindex from **Overview** when prompted so products are available to the assistant.
6. Add the shortcode `[ai_ebot_chat]` or the **AI Ebot Chat** block to a page, or use your theme’s block/widget areas.

== Frequently Asked Questions ==

= Does this plugin work without the internet? =

No. Registration, indexing, chat, and admin heartbeat require HTTPS requests to your configured AI Ebot API.

= Where do I set the API URL? =

Use the `AI_EBOT_SERVER_BASE_URL` constant in `wp-config.php` (or the legacy `AI_EBOT_CLOUD_BASE_URL`) to override the bundled default API host. For local development, point it at your API (for example `http://host.docker.internal:8787` in Docker, or `http://127.0.0.1:8787` on the host).

= Is my store “fully GDPR / privacy compliant” if I use this plugin? =

No plugin can guarantee legal compliance for your site or jurisdiction. This plugin **helps** you connect to a service and **documents** some data flows. You remain responsible for notices, consents, contracts, and data subject requests. Work with your AI Ebot operator’s documentation and qualified counsel as needed. (See the [WordPress.org compliance disclaimer guidance](https://developer.wordpress.org/plugins/wordpress-org/compliance-disclaimers/).)

= What happens if I uninstall? =

If you delete the plugin and `uninstall.php` runs, plugin options and local chat tables are removed from the database. Data already held **on the AI Ebot service** is controlled by that operator’s retention policy, not this plugin.

= How do I reindex a large catalog without keeping the browser open? =

On **Overview**, use **Reindex in background (WP-Cron)**. Progress is updated via scheduled events; ensure WP-Cron runs (normal site traffic or a server cron hitting `wp-cron.php`). How many products can be indexed may depend on your tier on the AI Ebot service.

= How many tags can I use in readme.txt on WordPress.org? =

The directory allows up to five tags; this readme uses five. Do not add competitor names as tags.

== Screenshots ==

1. AI Ebot Overview tab with status and reindex controls.
2. Connection tab showing service health and registration.
3. Appearance settings for chat heading and accent color.
4. Storefront chat widget with assistant reply and suggestion chips.

*(Screenshot image files are not bundled in the plugin zip. Add `screenshot-1.png` … `screenshot-4.png` to the WordPress.org SVN `assets` folder — see `wordpress-org/ASSETS.md`.)*

== Changelog ==

= 0.3.1 =
* Wire privacy hooks at bootstrap; multisite-aware `uninstall.php`; suggested privacy policy text registers once per load.

= 0.3.0 =
* WordPress.org alignment: readme, privacy exporter/eraser for logged-in chat users, uninstall cleanup, and directory asset documentation.

= Earlier releases =
* See git history or your distribution notes for changes before 0.3.0.

== Upgrade Notice ==

= 0.3.1 =
Privacy tools active on all requests; uninstall cleans every site on multisite. Review your AI Ebot operator’s terms after updating.
