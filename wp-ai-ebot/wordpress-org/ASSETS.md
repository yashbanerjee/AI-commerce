# WordPress.org Plugin Directory assets

These files live in the SVN **`assets`** directory (sibling of `trunk`), **not** inside the plugin zip. See [How Your Plugin Assets Work](https://developer.wordpress.org/plugins/wordpress-org/plugin-assets/).

## Required / recommended files

| File | Size | Notes |
|------|------|--------|
| `banner-772x250.png` | 772×250 | Standard banner; avoid small text. |
| `banner-1544x500.png` | 1544×500 | Optional HiDPI banner. |
| `icon-128x128.png` | 128×128 | Required-style icon for listings. |
| `icon-256x256.png` | 256×256 | Larger icon. |
| `icon.svg` | vector | Optional; provide PNG fallbacks if used. |
| `screenshot-1.png` … | flexible | Match the **Screenshots** section in `readme.txt` (one caption line per file, in order). |

## Checklist before submit

1. Banners: readable at thumbnail scale; no misleading “official WooCommerce” wording ([Guideline 17](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/)).
2. Icons: simple mark; works on light and dark backgrounds if possible.
3. Screenshots: real wp-admin / storefront captures; no fake analytics or competitor logos.
4. `readme.txt` screenshot lines (`1. …`, `2. …`) align with `screenshot-N.png` filenames and order.

## Contributors slug

Set `Contributors:` in `readme.txt` to your WordPress.org username so Gravatar and profile links resolve.
