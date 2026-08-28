# UI Style Guide: Classic vs Glass

This guide is the implementation contract for the current design philosophy.
It is written for future people to implement new pages without guessing.

## Design Philosophy
- Every UI surface must support two visual modes:
`flat` (Classic) and `glass`.
- Color scheme is a separate axis:
`system`, `light`, `dark`.
- Theme switching must never break layout, interaction, or readability.
- Shared UI behavior lives in one place (`public/appearance.js`), not duplicated per page.
- Page-level CSS can specialize visuals, but must keep shared contracts (IDs, classes, state vars).

## Scope
- Applies to all frontend pages in `public/`.
- Applies to shared/global theme files and page-specific style layers.
- Applies to account dropdown, appearance controls, progress systems, modals, and admin tables.

## Source Of Truth (File Ownership)
- Global glass/base theme: `public/style.css`
- Global flat theme: `public/style.flat.css`
- Shared appearance state + account menu wiring: `public/appearance.js`
- Control panel behavior + glass backup progress engine: `public/script.js`
- Server chat behavior and reconciliation: `public/serverChat.js`
- Server chat flat/glass component layer: `public/chat.css` (loaded after the active global theme)
- SFTP page style + glass/flat progress skinning: `public/styleSFTP.css`
- SFTP page behavior + progress wrapper lifecycle: `public/sftp.js`
- Admin/account page style system: `public/styleAdmin.css`
- Maintenance page style system: `public/styleMaintenance.css`
- Appearance API contract: `backend/routes/auth.js`
- Appearance persistence schema/setter: `backend/db/users.js`

## Appearance Data Contract
- `uiTheme`: `glass` or `flat`
- `colorScheme`: `system`, `light`, or `dark`
- Returned by `GET /me` (`backend/routes/auth.js`).
- Saved by `POST /appearance` (`backend/routes/auth.js`).
- Stored in:
`users.ui_theme` and `users.color_scheme` (`backend/db/users.js`).

### API validation rules
- Theme must be one of `glass|flat`.
- Color scheme must be one of `system|light|dark`.
- Invalid values return `400` from `/appearance`.

## Required HTML Contract

### 1) Theme stylesheet link
Every themed page must include:
```html
<link id="theme-stylesheet" rel="stylesheet" href="style.css">
```

### 2) Shared account dropdown + appearance panel
This structure is required because `public/appearance.js` is selector-driven:
```html
<div class="account-container">
  <button id="account-button">Account</button>
  <div id="account-dropdown" class="account-dropdown hidden">
    <button id="manage-account-button">Manage Account</button>
    <button id="admin-management-button" class="hidden">Admin Management</button>
    <button id="appearance-button">Appearance</button>
    <div id="appearance-panel" class="appearance-panel hidden">
      <div class="appearance-row">
        <span>Classic</span>
        <label class="switch">
          <input type="checkbox" id="appearance-classic-toggle">
          <span class="slider"></span>
        </label>
      </div>
      <div class="appearance-label">Color Mode</div>
      <label class="appearance-option">
        <input type="radio" name="appearance-color" value="system">System
      </label>
      <label class="appearance-option">
        <input type="radio" name="appearance-color" value="light">Light
      </label>
      <label class="appearance-option">
        <input type="radio" name="appearance-color" value="dark">Dark
      </label>
    </div>
    <button id="logout-button">Logout</button>
  </div>
</div>
```

### 3) Control panel backup progress markup
Required on `index.html`-style pages that use `public/script.js` progress engine:
```html
<div id="progress-area">
  <div id="progress-container">
    <div id="progress-bar"></div>
  </div>
  <div id="progress-percentage">0%</div>
</div>
```

### 4) Control panel server management dropdown
The control panel header uses a left-side management dropdown instead of a standalone backup-browser button:
```html
<div class="server-management-container">
  <button id="server-management-button" type="button" aria-haspopup="true" aria-expanded="false">Server Management</button>
  <div id="server-management-dropdown" class="server-management-dropdown hidden" role="menu" aria-hidden="true">
    <button id="sftp-button" class="sftp-button" type="button" role="menuitem">Server Backups Browser</button>
    <button id="server-info-button" type="button" role="menuitem">Server Info</button>
    <button id="server-version-button" type="button" role="menuitem">Server Version</button>
  </div>
</div>
```

## Required JS Boot Pattern

### Standard boot flow
```js
document.addEventListener('DOMContentLoaded', async () => {
  const user = await loadCurrentUser();
  if (!user) return;

  if (window.Appearance && typeof window.Appearance.init === 'function') {
    window.Appearance.init({ user, options: {/* page options */} });
  }

  // page-specific setup after appearance init
});
```

### `Appearance.init` options contract
- `adminOnly: true`
For admin pages only; non-admin users are redirected.
- `showManageAccountButton: false`
Used on account page so “Manage Account” is not shown inside itself.
- `showAdminButton`
Optional visibility control for admin shortcut button.
- `showAppearanceMenu`
Optional visibility control for appearance panel entry.

### Rules
- Do not duplicate account dropdown toggling logic in page scripts.
- Do not duplicate theme switching logic in page scripts.
- Always initialize appearance after `/me` resolves user data.

## Switch / Toggle Contract (Critical)
- Appearance switch dragging depends on CSS vars:
`--drag` and `--glass`.
- Dragging logic and pointer capture are implemented in `public/appearance.js`.
- Any switch redesign must preserve these selectors and vars:
`.switch`, `.switch .slider`, `.switch .slider::before`, `.switch .slider::after`.

Reference behavior from `public/appearance.js`:
```js
switchEl.style.setProperty('--drag', classicToggle.checked ? '1' : '0');
switchEl.style.setProperty('--glass', value.toFixed(2));
```

Reference glass overlay behavior from `public/style.css`:
```css
body[data-ui-theme="glass"] .switch .slider::after {
  opacity: calc(0.05 + 0.9 * var(--glass, 0));
}
```

## Theming Rules

### Flat mode (`uiTheme="flat"`)
- No dependency on blur/backdrop.
- Opaque or near-opaque surfaces.
- Clear borders and shadows.
- Must remain readable in both light and dark color schemes.

### Glass mode (`uiTheme="glass"`)
- Use `body[data-ui-theme="glass"]` selector overrides.
- Allow layered gradients + sheen + blur.
- Keep text contrast high on translucent surfaces.
- Maintain a fallback path in flat mode.

### Color-scheme behavior
- Explicit user override:
`body[data-color-scheme="light"]` and `body[data-color-scheme="dark"]`.
- System fallback:
`@media (prefers-color-scheme: ...)`.
- Existing pattern on SFTP/Admin pages:
`body[data-ui-theme="glass"]:not([data-color-scheme])` under light media query.

## Component Standards

### Account dropdown + appearance panel
- Required selectors:
`.account-dropdown`, `.appearance-panel`, `.appearance-row`, `.appearance-option`, `.switch`.
- Required behavior:
dropdown opens/closes via account button, closes on outside click, appearance panel closes with dropdown.
- Keep button width consistent (`~180px`) in dropdown for layout rhythm.

### Control panel server management dropdown
- Required selectors:
`.server-management-container`, `#server-management-button`, `.server-management-dropdown`, `#sftp-button`, `#server-info-button`, `#server-version-button`.
- Required behavior:
dropdown opens/closes via Server Management, closes on outside click and Escape, and closes when Account opens.
- `Server Backups Browser` keeps the existing blue backup-browser color.
- `Server Info` opens the read-only server info modal and remains available while server actions are locked.
- `Server Version` opens the advanced version selector and must remain available even when no update button is visible, except while server controls are locked.
- Keep dropdown button width consistent with account dropdown rhythm (`~180px`).

### Buttons + pointer lighting
- Non-control-panel pages use pointer lighting from `public/appearance.js` with `.is-lit`.
- Control panel has its own lighting system in `public/script.js` that also handles progress lighting.
- Preserve these CSS vars for any custom button:
`--mx`, `--my`, `--pop`, `--tx`, `--ty`, `--sx`, `--sy`, `--skx`, `--sky`, `--scale`.

### Math Behavior: Cursor Physics + Lighting
This section captures the exact motion/lighting math so it is reproducible.

- Source references:
`public/appearance.js` (`setupButtonLighting`),
`public/script.js` (`setupPointerLighting`, `progressHalfHeight`, `startProgressAnimation`),
`public/sftp.js` (`attachProgressPointer`, `progressHalfHeight`).

- Pointer normalization (buttons and progress):
```js
nx = (x - width / 2) / (width / 2)
ny = (y - height / 2) / (height / 2)
dist = min(sqrt(nx*nx + ny*ny), 1)
lightPop = max(0, 1 - dist)
```

- Button transform physics (non-control-panel from `appearance.js`):
```js
pop = lightPop
tx = nx * 14 * pop
ty = ny * 14 * pop
sx = -nx * 20 * pop
sy = -ny * 20 * pop
skx = ny * 3 * pop
sky = -nx * 3 * pop
scale = 1 + (1.03 - 1) * pop
```
These values are written into CSS vars and consumed by button styles for motion, shadow offset, and sheen.

- Control panel button/progress weighting (`script.js`):
```js
pop = isProgress ? lightPop * 0.55 : lightPop
```
Progress has reduced transform pop to avoid aggressive wobble, while still receiving lighting and bulge.

- Progress bulge geometry (both control panel and SFTP):
```js
bump = (amp * strength) * exp(-(dx*dx) / (2*sigma*sigma))
halfHeight = capsuleHalfHeight(x, width, radius) + bump
```
Current constants in both engines:
`viewW=1000`, `viewH=20`, `amp=4.5`, `sigma=90`, `hoverStrength=0.7`.

- Progress cursor-to-track mapping:
```js
trackCx = (clampedTrackX / elementWidth) * viewW
strength = clamp(inputStrength, 0, 0.7)
```
This keeps deformation stable regardless of rendered pixel width.

- Lighting intensity (progress):
```js
intensity = lightPop * 0.8
```
This intensity drives `--light` and radial gloss opacity in CSS (`.progress-lit`, `.sftp-progress-*gloss`).

- Progress easing toward target value (`script.js`):
```js
next = abs(diff) < 0.05 ? target : current + diff * 0.18
```
This smoothing constant (`0.18`) is intentional and should not be changed without retuning visual response.

### Modals
- Keep selector contract stable:
`.modal`, `.modal-backdrop`, `.modal-content`, `.modal-actions`, `.modal-message`.
- Mode overrides must preserve input readability.

### Control panel server info modal
- Required selectors:
`#server-info-modal`, `.server-info-modal-content`, `#server-info-status`, `#server-info-body`, `#server-info-overview`, `#server-info-era-tabs`, `#server-info-gallery-content`, `#server-info-full-link`, `#server-info-image-viewer`, `#server-info-lore-content`, `#server-info-mods-section`, `#server-info-mod-filter`, `#server-info-mod-list`.
- Required behavior:
opens from `#server-info-button`, fetches `GET /server-info`, closes on backdrop, close button, and Escape.
- Gallery behavior:
era tabs change screenshot groups, thumbnails choose the active screenshot, the thumbnail rail scrolls vertically when it exceeds the stage height, hidden thumbnails are hinted by scroll-linked blurred top/bottom edge flows rather than covering visible thumbnails, Prev/Next and left/right arrow keys advance within the active group, and `Full Resolution` points to the original asset while the stage uses optimized derivatives when available.
- Thumbnail overflow tuning:
keep the blurred edge flows aligned to the rail width and tune the transition through `--server-info-thumb-flow-top-height`, `--server-info-thumb-flow-bottom-height`, and `--server-info-thumb-flow-feather`; the visible thumbnails and blurred clone should overlap through the same feather distance so there is no sharp normal-to-blur cutoff.
- Image inspection:
clicking the active stage image opens `#server-info-image-viewer`; mouse wheel zooms, dragging pans while zoomed, and the toolbar provides zoom/reset/close controls.
- Overview behavior:
the `Current Mods` fact card jumps to `#server-info-mods-section` and focuses the mod filter.
- Data contract:
server facts, lore sections, display-safe mod metadata, and screenshot groups are returned by `backend/routes/serverInfo.js` through `backend/services/serverInfoService.js`.

### Control panel server chat

The chat panel is a themed terminal component, not a regular modal. Its source files are
`public/serverChat.js` and `public/chat.css`; the latter must load after the active
`style.css`/`style.flat.css` link so its scoped rules can neutralize global button and
mobile-button rules without duplicating both themes.

Required action-stack selectors:
`#corner-action-stack`, `#update-server`, `#server-chat-toggle`, and
`#server-chat-unread-badge`. The Update button remains the same DOM node and ID, but is
positioned statically inside the fixed corner stack. A hidden Update button leaves no gap.

Required shell selectors:
`#server-chat-shell`, `.server-chat-backdrop`, `#server-chat-panel`,
`.server-chat-header`, `#server-chat-close`, `#server-chat-connection-status`,
`#server-chat-session-meta`, `.server-chat-toolbar`, `#server-chat-history-status`,
`#server-chat-filters`, `#server-chat-admin-controls`, `#server-chat-messages`,
`#server-chat-new-messages`, `#server-chat-form`, `#server-chat-input`,
`#server-chat-send`, `#server-chat-input-meter`, and `#server-chat-send-status`.

Behavior contract:

- Desktop chat is a non-modal panel at z-index 40; the corner stack is 41, regular
  modals remain 50+, and the screenshot viewer remains 80.
- Mobile chat fills `100vh`/`100dvh`, accounts for every safe-area inset, traps focus,
  marks background siblings inert, and leaves its toggle usable.
- The shell uses `server-chat-open`/`server-chat-mobile-open`; it is intentionally not
  included in the existing `modal-open` synchronization.
- The composer and admin setting are disabled in markup and stay disabled until an
  authoritative capability/settings snapshot is loaded. Disconnection disables only
  sending; cached history stays readable.
- Chat-driven strings are inserted with `textContent`. Never render message, actor,
  health, session, or diagnostic fields with `innerHTML`.
- Message filters use `aria-pressed`; at least one of Chat or Activity remains enabled.
- The unread badge is hidden at zero and capped visually at `500+`; the full unread
  count and lossless history synchronization are not capped.
- `role="log"`, connection/history/send live regions, Escape, focus restoration, a
  keyboard-accessible new-message button, and visible focus rings are required.
- Internal chat buttons use `data-pointer-profile="compact"` to opt into the shared
  `public/script.js` cursor math at half-scale movement. `public/chat.css` consumes the
  standard physics variables only in glass mode with a fine hover pointer; flat mode,
  coarse/touch pointers, disabled controls, and reduced-motion transforms remain static.
- Rendered `.server-chat-message` rows use `data-pointer-profile="surface"` with a
  deliberately restrained profile: 72% lighting response, 3.5px translation, 8px
  shadow offset, 0.65deg skew, and 1.008 maximum scale. This provides shallow cursor
  depth without applying button-strength motion or suggesting that rows are clickable.
  The delegated engine skips surface motion for touch/coarse pointers, reduced motion,
  and mouse-button drags, and clears the active row whenever the message log scrolls.
- Controls marked `data-no-pointer-lighting` remain an explicit escape hatch from the
  control-panel cursor engine. The log scroller, diagnostics content, checkbox, and
  composer input remain stable so selection, scrolling, and form interaction do not
  inherit surface movement.
- `#server-chat-new-messages` composes its required `translateX(-50%)` centering with
  the pointer transform in glass mode; never replace that centering transform outright.

Terminal visual contract:

- Use the bundled `Pixelify Sans` OFL web font for terminal headings and compact
  controls, with a system monospace stack for long message text.
- Core semantic colors are exposed as `--chat-*` custom properties: panel, toolbar,
  row, border, text, muted, accent, warning, error, and shadow.
- Connection states are `live`, `connecting`, `catching-up`, `read-only`, `degraded`,
  `disconnected`, and `unavailable`. Do not rely on color alone; every state also has
  visible status text.
- Panel-origin rows receive a visual badge derived from `origin`; user text can never
  create the badge. Join/advancement, leave, and death activities use distinct but
  accessible text tones.
- Meter warning and error styles apply before submission, while the server remains the
  validation authority. Never add HTML `maxlength`, which counts UTF-16 code units.

The chat validation matrix includes all six appearance combinations, every connection
and health state, read-only/admin states, zero/normal/`500+` unread badges, both filter
choices, long bidirectional text, loading/empty/error/history states, desktop/mobile
breakpoints, safe areas, reduced motion, keyboard-only use, and live theme switching
while the panel is open.
- Asset contract:
source screenshots live under `assets/server-info/<era>/`; additional subfolders are discovered after the curated eras, and root-level screenshots appear in an `Unsorted` group. Optimized WebP derivatives live under `assets/server-info/_generated/display/<era>/` and `assets/server-info/_generated/thumbs/<era>/`. The endpoint falls back to originals if derivatives are absent.

### Control panel backup progress
- Engine file: `public/script.js`.
- Visual contract uses injected SVG classes:
`.progress-visual`, `.progress-track-outline`, `.progress-track-fill`, `.progress-track-spec`, `.progress-track-gloss`, `.progress-fill`, `.progress-fill-spec`, `.progress-fill-gloss`.
- Flat fallback requirement:
`public/style.flat.css` must keep native bar visible and hide `.progress-visual`.
- JS state fields on `#progress-container` (must not be renamed if you reuse code):
`_progressVisual`, `_progressTarget`, `_progressCurrent`, `_progressValue`, `_progressAnimFrame`, `_progressAnimating`.

### SFTP upload + download progress
- Engine file: `public/sftp.js`.
- Style file: `public/styleSFTP.css`.
- Progress runs in two render paths:
flat native `<progress>` and glass wrapper `.glass-progress`.
- Lifecycle methods:
`ensureGlassProgress`, `updateGlassProgressValue`, `teardownGlassProgress`, `syncProgressMode`.
- Theme sync is automatic through MutationObserver watching:
`body[data-ui-theme]` and `#theme-stylesheet[href]`.
- Download zip phase label contract:
`.zip-progress-label` text pattern:
`Retrieving 42%` or `Compressing 91%`.

### Admin/account components
- `public/styleAdmin.css` owns these major component contracts:
`.table-wrapper`, `.audit-filters`, `.filter-group`, `.actions-panel`, `.user-toggle`, `.login-history-link`, `.never-value`, `.temp-password-row`, `.copy-button`, `.protected-tag`.
- Expand-row behavior:
`.user-toggle.expanded .chevron` rotates chevron.
- Copy feedback behavior from `public/admin.js`:
`button.dataset.state = 'Copied'` or `'Failed'` controls transient visual state.

### Maintenance page
- Markup file: `public/maintenance.html`.
- Style file: `public/styleMaintenance.css`.
- Uses animated `.card`, `.spark`, `.gear`, `.badge` system.
- Theme variables now support both `data-ui-theme` and `data-color-scheme` for future shared runtime toggling.

## Page-Specific Implementation Recipes

### A) New control panel-like page
1. Include `style.css` via `#theme-stylesheet`.
2. Include shared account dropdown markup.
3. Include `appearance.js` before page JS.
4. Use standard boot flow and call `Appearance.init({ user })`.
5. If page has progress, use control panel markup and class contracts above.
6. Provide flat fallback in `style.flat.css`.

### B) New SFTP-like page
1. Include `#theme-stylesheet` and page stylesheet (`styleSFTP.css`-like).
2. Keep shared account dropdown markup unchanged.
3. Initialize `Appearance` before page-specific progress setup.
4. If using `<progress>`, implement both:
native flat + `.glass-progress` wrapper path.
5. Add MutationObserver sync for theme changes if wrappers are dynamic.

### C) New admin/account page
1. Include `#theme-stylesheet` plus `styleAdmin.css`.
2. Use shared account dropdown markup.
3. Initialize with:
`Appearance.init({ user, options: { adminOnly: true } })` on admin pages.
4. Keep table/action selectors stable so visual system remains consistent.
5. Support empty/error states with `.empty-state`.

## Copy-Paste Starter Snippets

### Minimal themed page shell
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link id="theme-stylesheet" rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="styleAdmin.css">
  <title>New Page</title>
</head>
<body>
  <!-- account dropdown markup here -->
  <main></main>
  <script src="appearance.js"></script>
  <script src="new-page.js"></script>
</body>
</html>
```

### Minimal page bootstrap (`new-page.js`)
```js
async function loadCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.href = '/';
    return null;
  }
  const res = await fetch('/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    localStorage.removeItem('token');
    window.location.href = '/';
    return null;
  }
  return res.json();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await loadCurrentUser();
  if (!user) return;
  window.Appearance?.init({ user });
});
```

### Minimal component CSS pattern (flat + glass + scheme)
```css
.my-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}

body[data-ui-theme="glass"] .my-card {
  background: rgba(12, 18, 22, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(12px) saturate(130%);
}

body[data-ui-theme="glass"][data-color-scheme="light"] .my-card {
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(21, 65, 41, 0.18);
}
```

## Validation Matrix (Required Before Merge)
- Theme matrix:
`flat/system`, `flat/light`, `flat/dark`, `glass/system`, `glass/light`, `glass/dark`.
- Interaction states:
default, hover, active, disabled, focused.
- Panel states:
hidden/open dropdown, hidden/open appearance panel.
- Async states:
loading, empty, error, success (especially progress and admin tables).
- Responsive:
desktop and mobile breakpoints.

## Do / Don’t

Do:
- Keep IDs/classes stable when used by `public/appearance.js`.
- Provide both flat and glass visual paths for every new UI block.
- Keep contrast and readability as first priority in glass mode.
- Use CSS variables and existing tokens before introducing new ad-hoc colors.
- Reuse existing component patterns from `styleSFTP.css` and `styleAdmin.css` when page type matches.

Don’t:
- Re-implement account dropdown logic in each page script.
- Rename core selectors without updating all dependent JS.
- Build glass-only components without flat fallback.
- Depend exclusively on `backdrop-filter` for contrast.
- Hardcode styles inline in HTML for themed components.
