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
- Player Center behavior and safe rendering: `public/playerCenter.js`
- Player Center flat/glass component layer: `public/playerCenter.css` (loaded after the active global theme and chat layer)
- Shared control-panel pane/menu motion and desktop coexistence: `public/windowMotion.css`
  (loaded after the Chat and Player Center component layers)
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

### 5) Control panel Player Center
The lower-right launcher and panel keep this selector contract:
```html
<button id="player-center-toggle" aria-controls="player-center-panel" aria-expanded="false">
  <span class="player-center-toggle-dot" aria-hidden="true"></span>
  <span>Players</span>
  <span id="player-center-toggle-count" class="hidden">0</span>
</button>
<div id="player-center-shell" class="hidden" aria-hidden="true">
  <div class="player-center-backdrop" data-close-player-center="true"></div>
  <section id="player-center-panel" role="dialog" aria-labelledby="player-center-title" tabindex="-1">
    <!-- header, navigation, roster sidebar, and detail view -->
  </section>
</div>
```
Load `playerCenter.css` after the active global stylesheet and `playerCenter.js` before
`script.js`, which supplies authenticated boot and shared WebSocket events.

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

#### Glass-only lighting and motion boundary

- Shared pane/menu entry and exit motion is owned by `public/windowMotion.css` and applies to
  both Glass and Classic. Cursor-follow lighting, depth, shadow displacement, skew, scale,
  filter changes, and progress deformation are a separate system and are Glass-only.
- The pointer engine may activate any button, `compact`, `surface`, `input-shell`, or progress
  profile only while `body[data-ui-theme="glass"]`, `(hover: hover) and (pointer: fine)`, and
  `prefers-reduced-motion: no-preference` all match. Classic, coarse/touch, disabled, and
  reduced-motion states must not receive `.is-lit` or non-default pointer variables.
- Theme changes, pointer-capability changes, reduced-motion changes, pane close, scroll,
  visibility loss, and window blur must use the same reset path: remove `.is-lit`, restore
  every shared pointer variable to its neutral value, and clear progress lighting/bulge.
- `surface` is the restrained non-control profile: use it for non-input cards and rows that
  benefit from shallow depth. Direct inputs, text-selection regions, scrollers, charts, and form
  containers remain stable. `input-shell` is the narrow composite-control exception: its shell
  remains a stationary hitbox and sole border/focus owner while a cursor sheen, displaced shadow,
  and tiny decorative-icon movement provide feedback. Pressing or drag-selecting resets that
  motion. Nested buttons normally retain the `compact` profile. Wide sparse controls use the
  `anchored` profile: an immovable native control remains the sole hitbox/focus owner while one
  pointer-transparent inner visual layer receives directional sheen, shadow, tilt, scale, and
  translation. Never transform or filter the anchored control itself. Hover and active selectors
  must never restate or change control geometry such as width, minimum height, margin, padding,
  border width, or font metrics; interaction feedback cannot change the hitbox beneath the pointer.
- Reduced motion disables cursor-follow sheen, transform, filter, displaced shadow, and
  deformation in both JavaScript and CSS. Static hover colors and visible keyboard focus
  remain available.

### Border ownership and composite controls

- Every visible boundary has exactly one structural owner. A parent owns spacing; it must not
  redraw a coincident child border. Nested empty states inside an already bordered card use
  fill, spacing, or an inset highlight instead of another perimeter.
- A window owns its outer perimeter, radius, clipping, and elevation. Glass pseudo-elements
  may draw cursor sheen or an inset specular rim, but must not place a second border on the
  same perimeter. Header/sidebar separators remain owned by their respective layout regions.
- Composite controls have one border and one focus owner. The Player Center search shell owns
  both; its nested input stays borderless, radius-free, outline-free, and shadow-free in every
  theme and focus modality. Generic input selectors must explicitly exclude that nested input.
- Structural strokes use the component border tokens (`--pc-border*`, `--chat-border*`, or
  their page equivalent). Glass highlights are decorative inset light, not another structural
  stroke.

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
- Desktop Chat and Player Center may remain open together. Their combined body classes
  (`server-chat-open player-center-open`) activate a non-overlapping split layout; each
  pane keeps independent focus, expanded state, and Escape handling.
- Mobile chat fills `100vh`/`100dvh`, accounts for every safe-area inset, traps focus,
  marks background siblings inert, and leaves its toggle usable. Because Chat and Player
  Center are both full-screen modal dialogs at this breakpoint, opening one closes the
  other and a desktop-to-mobile resize resolves any dual-open state before inerting.
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

### Control panel Player Center

Player Center is a purple people-and-history surface, separate from the green chat
action. `#player-center-toggle` stays fixed in the lower-right safe-area position shown
in the control-panel composition. Desktop uses a non-modal panel above the launcher;
mobile uses the full viewport with backdrop, inert background siblings, focus trapping,
Escape close, and focus restoration.

Required shell selectors are `#player-center-toggle`, `#player-center-toggle-count`,
`#player-center-shell`, `#player-center-panel`, `#player-center-close`,
`#player-center-refresh`, `#player-center-nav`, `#player-center-search`,
`#player-center-player-list`, `#player-center-content`, and `#player-center-view`.

Behavior and visual contract:

- Live presence and server availability use concise visible text plus a state marker;
  color alone never communicates availability. Stale-roster recovery stays internal and
  must not create a prominent disclaimer card in the Players overview.
- The main Players view leads with the current online count. Source quality and identity-review
  diagnostics stay contextual rather than competing with live presence. The header status dot
  represents server process state only: green while the server is running and grey while offline
  or unknown; roster-source quality must not turn this dot yellow.
- After live presence, the overview prioritizes gameplay insights: combined UUID-backed playtime,
  the most-played UUID profile, and the latest usable activity evidence when available. These values
  must distinguish a complete roster from a partial loaded page, exclude name-only legacy scores,
  and render missing observations as unavailable rather than zero. Player-history and playtime-
  coverage counts remain available only as a small muted metadata row beneath the insight cards.
- World-file totals, backup-derived trends, and log-derived sessions retain source,
  observation time, quality, and coverage metadata in the API. Player-facing views use compact,
  source-aware labels instead of dumping backup-gap, snapshot-source, or recovery diagnostics.
- Playtime trends remain chronological from left to right but open on the newest snapshot. Preserve
  each player's latest-or-history scroll intent across roster-driven rerenders and pane resizing;
  never reset an actively explored chart every polling cycle. The heading exposes the latest date
  and shows a compact `Latest →` return control only after the user moves into older history. Keep
  all points, use compact visible tick dates with a two-digit year on every tick and full dates in
  accessible labels/tooltips, retain a keyboard-focusable native scroller, and use subtle edge
  fades when more history exists offscreen.
- Session state is explicit: only a roster-matched `active` session receives the green `Live`
  treatment. A normal departure reads `Left`, a runtime boundary reads `Ended when server stopped`
  or `Ended when server restarted`, and incomplete historical evidence reads `End time unavailable`
  with neutral styling. Missing `endedAt` alone must never be rendered as online.
- UUID-backed players use their current Minecraft face in every avatar size. Faces load lazily from
  the authenticated same-origin avatar route and preserve the purple initials tile as the immediate
  and failure fallback. Keep the nearest-neighbor pixel rendering, rounded clipping, and existing
  flat/glass border and lighting behavior; never resolve an avatar by a recyclable player name.
  Keep empty states plain; missing data is never silently converted to zero.
- Cache/import time never appears as player activity. Exact gameplay events and validated legacy
  Bukkit `lastPlayed` evidence use `Last seen`; file modification evidence uses `Estimated last
  active` plus copy/transfer/restore caveat text. A recovered Bukkit `firstPlayed` date may repair an
  incomplete advancement history, but the UI must still describe coverage honestly.
- The launcher and compact internal buttons preserve the shared pointer variables. Flat,
  reduced-motion, disabled, touch, and coarse-pointer modes remain transform-stable.
- Summary cards, empty/status cards, and history rows use the shared restrained `surface`
  profile for cursor-positioned light and shallow depth in Glass mode only. Player Center
  scrollers clear active surface effects before content moves. Roster buttons and the profile's
  `All players` control use the `anchored` profile: the outer native button remains stationary and
  owns layout, pointer targeting, keyboard focus, and activation; its single
  `.player-center-pointer-visual` child is pointer-inert and receives the Glass-only light and
  restrained motion. Roster thumbnails may add a second, very small Glass-only response (up to
  `1.035` scale with sub-pixel translation/tilt and local sheen), but activation must be measured
  by a stationary, pointer-inert sensor owned by the outer button. Never use the transformed avatar
  itself as a hover boundary. Forms, charts, text-selection regions, and the search input itself
  remain stationary.
- On desktop, Player Center can coexist with Chat in the shared split layout without either
  pane covering the other. On mobile it remains mutually exclusive with Chat so there is
  exactly one `aria-modal` focus trap and one inert-background owner.
- Opening or closing Chat must not change Player Center typography. Prepare the Player Center's
  final split width and internal columns while it is still hidden, size responsive internals from
  the pane container, and reveal it with opacity plus translation but no text-scaling transform.
  Font family, computed font sizes, and line heights remain invariant between solo and split views.
- Player Center uses the control panel's normal `Arial, sans-serif` typography throughout.
  `Pixelify Sans` remains a Server Chat terminal accent and must not be applied to the
  Player Center launcher, headings, controls, avatars, statistics, or status copy. Mobile
  text inputs stay at `16px` or larger so focusing them cannot trigger Safari viewport zoom.
- In glass mode the Player Center window, header, sidebar, and cards remain visibly translucent:
  use layered specular gradients, an illuminated inner rim, Safari-compatible
  `-webkit-backdrop-filter`, and blur/saturation without compounding child layers into an opaque
  sheet. Flat mode remains opaque. Light and system-light glass use translucent white surfaces.
- The composite player search control draws one restrained purple focus ring on its outer shell;
  the nested input must not add a second outline. In Glass mode on a fine pointer, the dedicated
  `input-shell` profile may add cursor-positioned sheen and shadow plus tiny search-icon motion,
  but it must never transform the shell or input, replace the focus ring, or animate during text
  selection. Trend counter resets render as compact baseline points with accessible reset text,
  never as a badge wider than its chart column.
- Player names, statistics, advancement text, API errors, and external identity candidates
  are created with `textContent`/safe DOM APIs. No remote Player Center string uses
  `innerHTML`.
- NameMC results are displayed and stored only as time-stamped, unverified external candidates; they
  do not receive linked, verified, or access-authorizing styling. Copy must warn that Minecraft names
  can be reassigned and that a current holder may be a different person.
- Name-only scoreboard evidence uses explicit `Legacy name only` styling. It must remain visually
  separate from UUID profiles whenever ownership is recycled, ambiguous, or not proven for that time.
- Historical aliases may be searchable only after local UUID-bearing verification. Trend attribution
  requires an exact same-snapshot UUID/name observation; the UI must not imply continuous ownership
  across gaps between two sightings.
- Cache-only, allowlist-only, access-only, and authentication-handshake-only identities stay out of
  the main player count. A suppressed same-name legacy row remains disclosed as separate identity
  review evidence and never transfers scores to the UUID row.
- `public/playerCenter.css` owns scoped `--pc-*` semantic tokens and must cover glass/flat,
  explicit light/dark, system fallback, safe areas, reduced motion, and mobile layout.
- The validation matrix adds UUID/name-only identities, zero/many online players,
  current/recent/stale roster revisions, trend gaps/resets, linking unavailable/challenge/
  linked states, access pending/applied/drifted/expired/failed states, and keyboard-only use.

### Shared popup and utility-pane motion

`public/windowMotion.css` owns entry/exit motion for the Account dropdown, Server
Management dropdown, Server Chat, and Player Center. The motion contract is shared by
glass and flat themes:

- Entry uses opacity plus a short origin-aware translate/scale over `240ms` with
  `cubic-bezier(0.16, 1, 0.3, 1)`; Chat originates bottom-left, Player Center bottom-right,
  Server Management top-left, and Account top-right. The dual-pane Player Center entrance
  uses translation without scale so its text is rasterized at its final size throughout.
- Exit is restrained to `160ms`. Component-specific `.hidden` selectors keep each surface
  rendered but non-interactive until its exit completes, using delayed `visibility` rather
  than a JavaScript timer.
- Animate only `opacity` and `transform`; never animate `backdrop-filter`, layout dimensions,
  or the pointer-lighting custom properties.
- Mobile full-screen panes use near-unity scale so the transition never exposes page edges.
- `prefers-reduced-motion: reduce` disables all shared popup transitions immediately.
- Any new popup added to this shared motion layer must preserve its existing ARIA state,
  focus restoration, safe-area behavior, and `.hidden` semantics.

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
