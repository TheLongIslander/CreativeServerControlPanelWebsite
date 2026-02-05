# UI Style Guide: Classic vs Glass

This guide documents the two supported UI modes and the standards each component must follow. It is written for humans and future AI sessions to keep the visual system consistent across all pages.

## Scope
- Applies to all frontend pages in `public/`.
- Two modes must exist for every styled element: `Classic` (flat) and `Glass` (liquid/glossy).
- Modes are user preferences stored per account and applied sitewide.

## Where The Modes Live (References)
- Glass styles: `public/style.css`
- Classic/flat styles: `public/style.flat.css`
- Mode wiring + persistence: `public/script.js`
- Theme stylesheet switcher: `public/index.html` (`<link id="theme-stylesheet">`)
- Server persistence:
  - `backend/db/users.js` (columns + setters)
  - `backend/routes/auth.js` (GET `/me`, POST `/appearance`)

## Core Rules
- Every new component must have a Classic and a Glass version.
- Mode switching must not break layout or interaction.
- If a component uses `body[data-ui-theme="glass"]` overrides, a flat default must exist.
- Component state (hover/active/disabled) must be clear in both modes.

## Theme State + Persistence (References)
- `appearanceState` in `public/script.js`:
  - `uiTheme`: `glass` or `flat`
  - `colorScheme`: `system` / `light` / `dark`
- The server stores per-user appearance and returns it from `/me`.
- The client applies preferences on load and saves updates to `/appearance`.

Example (JS – apply theme):
```js
// public/script.js
applyAppearanceSettings({ uiTheme: 'glass', colorScheme: 'system' }, { persist: true });
```

## Classic (Flat) Standards
Use `public/style.flat.css` and keep visuals clean and readable:
- Solid, opaque backgrounds.
- Minimal or no blur.
- Low to moderate shadow depth.
- Clear, standard gradients only when needed for depth (avoid heavy gloss).
- Buttons: clean pill shapes, crisp borders, minimal inner highlights.
- Panels: solid background, light border, subtle drop shadow.
- Controls: standard toggles, no refraction effects.

## Glass Standards
Use `public/style.css` with `body[data-ui-theme="glass"]` overrides:
- Translucent surfaces with layered gradients.
- Soft inner sheen (top-left highlight).
- Backdrop blur + saturation (where supported).
- Subtle noise/texture is optional; avoid heavy grain.
- Stronger depth cues: inner shadows + ambient outer shadow.
- Text/labels must remain crisp and readable against translucency.

## Component Standards (With References + Examples)

### Buttons
**Classic**
- Solid background color.
- Simple highlight or subtle shadow.

**Glass**
- Multi-layer gradient (sheen + base + shadow).
- Inner highlight on top edge.
- Slight glow/ambient shadow.

**References**
- Glass button styling: `public/style.css` (button rules)
- Classic button styling: `public/style.flat.css`

### Account Dropdown (Pane)
**Classic**
- Solid panel background.
- Light border and subtle shadow.

**Glass**
- Translucent panel with layered gradients.
- Backdrop blur + saturation.
- Inner sheen overlay on the panel.
- Keep buttons inside fully opaque and readable.

**References**
- Dropdown base: `public/style.css` `.account-dropdown`
- Glass overrides: `public/style.css` `body[data-ui-theme="glass"] .account-dropdown`

### Appearance Panel (Inside Dropdown)
**Classic**
- Solid, light background.
- Clear dividers and readable text.

**Glass**
- Same glass panel treatment as the dropdown:
  - translucent background, blur, inner sheen.
  - light border + soft shadows.
  - glassy accent colors for inputs.

**References**
- `public/style.css` `.appearance-panel` and glass overrides

### Toggles / Switches
**Classic**
- Flat pill track.
- Solid white knob.

**Glass**
- Track uses layered gradients.
- Knob has glass overlay (`--glass`) during drag.
- Drag position tracked by `--drag`.
- Green fill fades based on `--drag`, not only checked state.

**References**
- `public/style.css` `.switch` and glass overrides
- `public/script.js` toggle drag logic (`--drag`, `--glass`)

Example (CSS – glass toggle):
```css
body[data-ui-theme="glass"] .switch .slider::after {
  /* glass bulb overlay */
  opacity: calc(0.05 + 0.9 * var(--glass, 0));
}
```

### Progress Bar
**Classic**
- Simple bar with solid fill.
- Minimal border.

**Glass**
- SVG-based, layered strokes:
  - Track outline + fill + highlight + gloss.
  - Fill overlay + specular highlights.
  - Cursor lighting uses radial gradient variables.
  - Bulge deformation follows cursor (X-only for geometry).
- Hover/cursor effects should feel soft, not harsh.

**References**
- SVG + bulge logic: `public/script.js` (progress bulge + lighting)
- Glass styling: `public/style.css` (progress SVG layers)
- Classic fallback: `public/style.flat.css` (shows `#progress-bar`)

### Modals
**Classic**
- Opaque content card.
- Standard backdrop darkening.

**Glass**
- Translucent content card with blur + sheen.
- Backdrop blur + saturation.
- Inputs inside should match glass panel styling.

**References**
- Base modal styling: `public/style.css` `.modal-content`
- Glass overrides: `public/style.css` `body[data-ui-theme="glass"] .modal-content`

## Color Scheme Handling
Color scheme is orthogonal to Glass/Classic:
- `body[data-color-scheme="dark"]`
- `body[data-color-scheme="light"]`
- `system` means no override (default OS)

When adding new components, include:
- Base styles (system)
- Dark override (if needed)
- Light override (if needed)

## Required Markup Snippets

### Theme Stylesheet Link
Add to every page head:
```html
<link id="theme-stylesheet" rel="stylesheet" href="style.css">
```

### Account Dropdown + Appearance Panel
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
        <input type="radio" name="appearance-color" value="system">
        System
      </label>
      <label class="appearance-option">
        <input type="radio" name="appearance-color" value="light">
        Light
      </label>
      <label class="appearance-option">
        <input type="radio" name="appearance-color" value="dark">
        Dark
      </label>
    </div>
    <button id="logout-button">Logout</button>
  </div>
</div>
```

### Progress Bar Container
```html
<div id="progress-area">
  <div id="progress-container">
    <div id="progress-bar"></div>
  </div>
  <div id="progress-percentage">0%</div>
</div>
```

## Do / Don’t Checklist

Do:
- Implement every component in both Classic and Glass modes.
- Use `body[data-ui-theme="glass"]` overrides for glass styling.
- Keep contrast high enough for readability in glass mode.
- Add light/dark overrides when needed for contrast.

Don’t:
- Hardcode colors in HTML (keep in CSS only).
- Add new UI without a Classic fallback.
- Rely on `backdrop-filter` without a solid fallback layer.
- Overuse blur; prioritize legibility.

## Implementation Checklist For New Pages
1. Use `public/script.js` to load user preferences and apply `uiTheme` + `colorScheme`.
2. Include `<link id="theme-stylesheet">` in the page head.
3. Style components in both `public/style.css` and `public/style.flat.css`.
4. Test Classic and Glass mode:
   - Hover
   - Active/pressed
   - Disabled states
   - Light/dark color schemes
5. If you add new interactive elements:
   - Respect `appearanceState`
   - Ensure transitions don’t break on theme toggle.

## Notes For Future Expansions
- Do not remove the dual-mode requirement; every element must have a Classic and Glass styling path.
- Keep glass effects readable; avoid overpowering blur or low contrast.
- When in doubt, follow existing glass patterns in `public/style.css`.
