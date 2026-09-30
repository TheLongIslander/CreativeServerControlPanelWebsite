(function() {
    const STYLE_VERSION = '20260505-10';

    let appearanceState = {
        uiTheme: 'glass',
        colorScheme: 'system'
    };

    function setThemeStylesheet(uiTheme) {
        const link = document.getElementById('theme-stylesheet');
        if (!link) {
            return;
        }
        const href = uiTheme === 'flat'
            ? `style.flat.css?v=${STYLE_VERSION}`
            : `style.css?v=${STYLE_VERSION}`;
        if (!link.getAttribute('href') || link.getAttribute('href') !== href) {
            link.setAttribute('href', href);
        }
        document.body.setAttribute('data-ui-theme', uiTheme);
    }

    function applyColorScheme(colorScheme) {
        if (colorScheme === 'system') {
            document.body.removeAttribute('data-color-scheme');
            return;
        }
        document.body.setAttribute('data-color-scheme', colorScheme);
    }

    async function saveAppearanceSettings(settings) {
        const token = localStorage.getItem('token');
        if (!token) {
            return;
        }
        try {
            await fetch('/appearance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(settings)
            });
        } catch (err) {
            console.error('Failed to save appearance settings:', err);
        }
    }

    function applyAppearanceSettings(settings, { persist = false } = {}) {
        appearanceState = {
            uiTheme: settings.uiTheme || 'glass',
            colorScheme: settings.colorScheme || 'system'
        };
        setThemeStylesheet(appearanceState.uiTheme);
        applyColorScheme(appearanceState.colorScheme);

        const classicToggle = document.getElementById('appearance-classic-toggle');
        if (classicToggle) {
            classicToggle.checked = appearanceState.uiTheme === 'flat';
            const switchEl = classicToggle.closest('.switch');
            if (switchEl) {
                switchEl.style.setProperty('--drag', classicToggle.checked ? '1' : '0');
                switchEl.style.setProperty('--glass', '0');
            }
        }

        const radios = document.querySelectorAll('input[name="appearance-color"]');
        radios.forEach((radio) => {
            radio.checked = radio.value === appearanceState.colorScheme;
        });

        if (persist) {
            saveAppearanceSettings(appearanceState);
        }
    }

    function setupAppearanceControls() {
        const appearanceButton = document.getElementById('appearance-button');
        const appearancePanel = document.getElementById('appearance-panel');
        const classicToggle = document.getElementById('appearance-classic-toggle');
        const colorRadios = document.querySelectorAll('input[name="appearance-color"]');

        let suppressAppearanceChange = false;

        if (appearanceButton && appearancePanel) {
            appearanceButton.addEventListener('click', (event) => {
                event.preventDefault();
                appearancePanel.classList.toggle('hidden');
            });
        }

        if (classicToggle) {
            classicToggle.addEventListener('change', () => {
                if (suppressAppearanceChange) {
                    return;
                }
                const uiTheme = classicToggle.checked ? 'flat' : 'glass';
                const switchEl = classicToggle.closest('.switch');
                if (switchEl) {
                    switchEl.style.setProperty('--drag', classicToggle.checked ? '1' : '0');
                }
                applyAppearanceSettings({
                    uiTheme,
                    colorScheme: appearanceState.colorScheme
                }, { persist: true });
            });
        }

        if (classicToggle) {
            const switchEl = classicToggle.closest('.switch');
            const sliderEl = switchEl ? switchEl.querySelector('.slider') : null;
            if (switchEl && sliderEl) {
                let dragging = false;
                let startX = 0;
                let startChecked = classicToggle.checked;

                const setGlass = (value) => {
                    switchEl.style.setProperty('--glass', value.toFixed(2));
                };

                const setDrag = (clientX) => {
                    const rect = switchEl.getBoundingClientRect();
                    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
                    const drag = x / rect.width;
                    switchEl.style.setProperty('--drag', drag);
                    if (dragging) {
                        classicToggle.checked = drag >= 0.5;
                    }
                };

                sliderEl.addEventListener('pointerdown', (event) => {
                    event.preventDefault();
                    startX = event.clientX;
                    startChecked = classicToggle.checked;
                    dragging = false;
                    switchEl.classList.add('dragging');
                    sliderEl.setPointerCapture(event.pointerId);
                    setGlass(1);
                });

                sliderEl.addEventListener('pointermove', (event) => {
                    if (!sliderEl.hasPointerCapture(event.pointerId)) {
                        return;
                    }
                    if (!dragging && Math.abs(event.clientX - startX) > 1) {
                        dragging = true;
                    }
                    setDrag(event.clientX);
                });

                const endDrag = (event) => {
                    if (!sliderEl.hasPointerCapture(event.pointerId)) {
                        return;
                    }
                    sliderEl.releasePointerCapture(event.pointerId);
                    switchEl.classList.remove('dragging');

                    suppressAppearanceChange = true;
                    if (dragging) {
                        switchEl.style.setProperty('--drag', classicToggle.checked ? '1' : '0');
                    } else {
                        classicToggle.checked = !startChecked;
                        switchEl.style.setProperty('--drag', classicToggle.checked ? '1' : '0');
                    }
                    applyAppearanceSettings({
                        uiTheme: classicToggle.checked ? 'flat' : 'glass',
                        colorScheme: appearanceState.colorScheme
                    }, { persist: true });
                    setTimeout(() => {
                        suppressAppearanceChange = false;
                    }, 0);

                    setGlass(0);
                    dragging = false;
                };

                sliderEl.addEventListener('pointerup', endDrag);
                sliderEl.addEventListener('pointercancel', endDrag);
                sliderEl.addEventListener('click', (event) => {
                    event.preventDefault();
                });
            }
        }

        colorRadios.forEach((radio) => {
            radio.addEventListener('change', () => {
                if (!radio.checked) {
                    return;
                }
                applyAppearanceSettings({
                    uiTheme: appearanceState.uiTheme,
                    colorScheme: radio.value
                }, { persist: true });
            });
        });
    }

    function setupAccountMenu(user, options = {}) {
        const settings = {
            showAdminButton: true,
            showManageAccountButton: true,
            showAppearanceMenu: true,
            adminOnly: false,
            ...options
        };

        if (settings.adminOnly && (!user || user.role !== 'admin')) {
            window.location.href = '/index.html';
            return;
        }

        const accountButton = document.getElementById('account-button');
        const dropdown = document.getElementById('account-dropdown');
        const adminButton = document.getElementById('admin-management-button');
        const manageButton = document.getElementById('manage-account-button');
        const logoutButton = document.getElementById('logout-button');
        const appearanceButton = document.getElementById('appearance-button');
        const appearancePanel = document.getElementById('appearance-panel');

        if (user && accountButton) {
            accountButton.dataset.username = user.username || '';
        }

        if (adminButton) {
            if (settings.showAdminButton && user && user.role === 'admin') {
                adminButton.classList.remove('hidden');
                adminButton.addEventListener('click', () => {
                    window.location.href = '/admin.html';
                });
            } else {
                adminButton.classList.add('hidden');
            }
        }

        if (manageButton) {
            if (settings.showManageAccountButton) {
                manageButton.classList.remove('hidden');
                manageButton.addEventListener('click', () => {
                    window.location.href = '/account.html';
                });
            } else {
                manageButton.classList.add('hidden');
            }
        }

        if (appearanceButton) {
            if (settings.showAppearanceMenu) {
                appearanceButton.classList.remove('hidden');
            } else {
                appearanceButton.classList.add('hidden');
            }
        }

        if (appearancePanel) {
            appearancePanel.classList.add('hidden');
        }

        if (accountButton && dropdown) {
            const setAccountMenuOpen = (open) => {
                dropdown.classList.toggle('hidden', !open);
                dropdown.setAttribute('aria-hidden', open ? 'false' : 'true');
                accountButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (!open && appearancePanel) {
                    appearancePanel.classList.add('hidden');
                }
            };

            setAccountMenuOpen(false);
            accountButton.addEventListener('click', (event) => {
                event.stopPropagation();
                setAccountMenuOpen(dropdown.classList.contains('hidden'));
            });

            document.addEventListener('click', () => {
                if (!dropdown.classList.contains('hidden')) {
                    setAccountMenuOpen(false);
                }
            });
        }

        if (dropdown) {
            dropdown.addEventListener('click', (event) => {
                event.stopPropagation();
            });
        }

        if (logoutButton) {
            logoutButton.addEventListener('click', () => {
                if (window.ServerContext) window.ServerContext.clearAll();
                else {
                    try { Object.keys(sessionStorage).filter(key => key.startsWith('server-tab:')).forEach(key => sessionStorage.removeItem(key)); } catch (_) {}
                }
                if (typeof logout === 'function') {
                    logout();
                } else {
                    localStorage.removeItem('token');
                    window.location.href = '/';
                }
            });
        }

        if (settings.showAppearanceMenu) {
            setupAppearanceControls();
        }
    }

    let lightingInitialized = false;

    function setupButtonLighting() {
        if (lightingInitialized) {
            return;
        }
        if (document.body.classList.contains('control-panel')) {
            return;
        }

        const pointerTargetSelector = [
            'button:not([data-no-pointer-lighting])',
            '.path-input-shell',
            '[data-pointer-profile="compact"]',
            '[data-pointer-profile="surface"]',
            '[data-pointer-profile="input-shell"]',
            '[data-pointer-profile="anchored"]'
        ].join(', ');
        const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
        const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        const pointerEffectsEnabled = () => (
            document.body.dataset.uiTheme === 'glass'
            && finePointerQuery.matches
            && !reducedMotionQuery.matches
        );
        const profiles = {
            button: { light: 1, translate: 14, shadow: 20, skew: 3, scale: 1.03 },
            compact: { light: 1, translate: 7, shadow: 11, skew: 1.75, scale: 1.018 },
            surface: { light: 0.72, translate: 3.5, shadow: 8, skew: 0.65, scale: 1.008 },
            letter: { light: 1, translate: 3, shadow: 4, skew: 1, scale: 1.07 },
            'input-shell': { light: 0.55, translate: 2, shadow: 5, skew: 0, scale: 1.012 },
            anchored: { light: 0.78, translate: 3.5, shadow: 8, skew: 0.65, scale: 1.008 }
        };
        const isAvailable = (target, decorativeWithin = null) => (
            target.isConnected
            && !target.matches(':disabled, [aria-disabled="true"]')
            && !target.closest('[data-no-pointer-lighting], .hidden, [hidden], [inert]')
            // Decorative glyphs share one accessible heading label. Their local
            // aria-hidden wrapper is intentional; hidden panes still block effects.
            && (!target.closest('[aria-hidden="true"]') || (
                decorativeWithin && decorativeWithin.contains(target.closest('[aria-hidden="true"]'))
            ))
            && target.getClientRects().length > 0
            && window.getComputedStyle(target).visibility === 'visible'
        );

        const resetTarget = (target) => {
            if (!target) {
                return;
            }
            target.classList.remove('is-lit');
            target.style.setProperty('--mx', '50%');
            target.style.setProperty('--my', '20%');
            target.style.setProperty('--pop', '0');
            target.style.setProperty('--tx', '0px');
            target.style.setProperty('--ty', '0px');
            target.style.setProperty('--sx', '0px');
            target.style.setProperty('--sy', '0px');
            target.style.setProperty('--skx', '0deg');
            target.style.setProperty('--sky', '0deg');
            target.style.setProperty('--scale', '1');
        };

        let currentTarget = null;
        const activeNestedVisuals = new Map();

        const clearNestedVisuals = () => {
            activeNestedVisuals.forEach(resetTarget);
            activeNestedVisuals.clear();
        };

        const clearTarget = () => {
            clearNestedVisuals();
            if (currentTarget) {
                resetTarget(currentTarget);
                currentTarget = null;
            }
        };

        const applyPointerLighting = (target, event, rect, profile, width = rect.width, height = rect.height, falloffRadius = null) => {
            // A nested sensor moves with its parent, but its visual must use local
            // coordinates and must never feed its own transform back into measurement.
            const x = (event.clientX - rect.left) * width / rect.width;
            const y = (event.clientY - rect.top) * height / rect.height;
            const nx = (x - width / 2) / (falloffRadius || width / 2);
            const ny = (y - height / 2) / (falloffRadius || height / 2);
            const dist = Math.min(Math.sqrt(nx * nx + ny * ny), 1);
            const lightPop = falloffRadius
                ? (1 - dist) * (1 - dist) * (1 + 2 * dist)
                : Math.max(0, 1 - dist);
            const pop = lightPop * profile.light;
            const translateMax = profile.translate;
            const shadowMax = profile.shadow;
            const skewMax = profile.skew;
            const scaleMax = profile.scale;
            const tx = nx * translateMax * pop;
            const ty = ny * translateMax * pop;
            const sx = -nx * shadowMax * pop;
            const sy = -ny * shadowMax * pop;
            const skx = (ny * skewMax * pop).toFixed(2);
            const sky = (-nx * skewMax * pop).toFixed(2);
            const scale = (1 + (scaleMax - 1) * pop).toFixed(3);

            target.style.setProperty('--mx', `${x}px`);
            target.style.setProperty('--my', `${y}px`);
            target.style.setProperty('--pop', pop.toFixed(3));
            target.style.setProperty('--tx', `${tx.toFixed(2)}px`);
            target.style.setProperty('--ty', `${ty.toFixed(2)}px`);
            target.style.setProperty('--sx', `${sx.toFixed(2)}px`);
            target.style.setProperty('--sy', `${sy.toFixed(2)}px`);
            target.style.setProperty('--skx', `${skx}deg`);
            target.style.setProperty('--sky', `${sky}deg`);
            target.style.setProperty('--scale', scale);
            target.classList.add('is-lit');
        };

        const updateNestedVisuals = (target, event) => {
            const nextVisuals = new Map();
            if (event.buttons === 0) {
                target.querySelectorAll('[data-pointer-sensor="surface"], [data-pointer-sensor="letter"]').forEach((sensor) => {
                    const isLetter = sensor.dataset.pointerSensor === 'letter';
                    const decorativeWithin = isLetter ? target : null;
                    const visual = sensor.querySelector('[data-pointer-visual]');
                    if (!visual || !isAvailable(sensor, decorativeWithin) || !isAvailable(visual, decorativeWithin)) return;
                    const rect = sensor.getBoundingClientRect();
                    if (!rect.width || !rect.height) return;
                    const width = sensor.clientWidth || rect.width;
                    const height = sensor.clientHeight || rect.height;
                    const radius = isLetter ? parseFloat(window.getComputedStyle(sensor).fontSize) || height : null;
                    if (isLetter) {
                        const dx = (event.clientX - rect.left) * width / rect.width - width / 2;
                        const dy = (event.clientY - rect.top) * height / rect.height - height / 2;
                        if (Math.hypot(dx, dy) >= radius) return;
                    } else if (event.clientX < rect.left || event.clientX > rect.left + rect.width
                        || event.clientY < rect.top || event.clientY > rect.top + rect.height) return;
                    applyPointerLighting(visual, event, rect, isLetter ? profiles.letter : profiles.surface,
                        width, height, radius);
                    nextVisuals.set(sensor, visual);
                });
            }
            activeNestedVisuals.forEach((visual, sensor) => {
                if (nextVisuals.get(sensor) !== visual) resetTarget(visual);
            });
            activeNestedVisuals.clear();
            nextVisuals.forEach((visual, sensor) => activeNestedVisuals.set(sensor, visual));
        };

        const updateTarget = (event) => {
            if (!pointerEffectsEnabled() || document.hidden || event.pointerType !== 'mouse') {
                clearTarget();
                return;
            }
            const el = document.elementFromPoint(event.clientX, event.clientY);
            const target = el ? el.closest(pointerTargetSelector) : null;

            if (currentTarget && currentTarget !== target) {
                clearTarget();
            }

            if (!target || !isAvailable(target)) {
                clearTarget();
                return;
            }

            const profileName = target.dataset.pointerProfile
                || (target.classList.contains('path-input-shell') ? 'input-shell' : 'button');
            if ((profileName === 'surface' || profileName === 'input-shell') && event.buttons !== 0) {
                clearTarget();
                return;
            }
            const profile = profiles[profileName] || profiles.button;

            const rect = target.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                clearTarget();
                return;
            }
            applyPointerLighting(target, event, rect, profile);
            currentTarget = target;
            updateNestedVisuals(target, event);
        };

        document.addEventListener('pointermove', updateTarget);
        document.addEventListener('pointerdown', updateTarget);
        document.addEventListener('pointerup', (event) => {
            if (event.pointerType !== 'mouse') {
                clearTarget();
            }
        });
        document.addEventListener('pointercancel', clearTarget);
        document.addEventListener('pointerleave', clearTarget);
        document.addEventListener('ui-pointer-lighting-reset', clearTarget);
        document.addEventListener('scroll', clearTarget, { capture: true, passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) clearTarget();
        });
        window.addEventListener('blur', clearTarget);
        window.addEventListener('pagehide', clearTarget);
        [finePointerQuery, reducedMotionQuery].forEach((query) => {
            if (typeof query.addEventListener === 'function') {
                query.addEventListener('change', clearTarget);
            } else {
                query.addListener(clearTarget);
            }
        });

        // Menus and cards can disappear without a pointer event. Only reset an active
        // target when its context changes; ordinary live text updates keep it steady.
        const contextObserver = new MutationObserver((records) => {
            if (!currentTarget) return;
            const themeChanged = records.some((record) => (
                record.target === document.body && record.attributeName === 'data-ui-theme'
            ));
            if (themeChanged || !pointerEffectsEnabled() || !isAvailable(currentTarget)) {
                clearTarget();
                return;
            }
            activeNestedVisuals.forEach((visual, sensor) => {
                const decorativeWithin = sensor.dataset.pointerSensor === 'letter' ? currentTarget : null;
                if (!currentTarget.contains(sensor) || !sensor.contains(visual)
                    || !isAvailable(sensor, decorativeWithin) || !isAvailable(visual, decorativeWithin)) {
                    resetTarget(visual);
                    activeNestedVisuals.delete(sensor);
                }
            });
        });
        contextObserver.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-ui-theme', 'class', 'style', 'hidden', 'inert', 'aria-hidden', 'disabled', 'aria-disabled']
        });

        lightingInitialized = true;
    }

    function init({ user, options } = {}) {
        applyAppearanceSettings({
            uiTheme: user && user.uiTheme ? user.uiTheme : 'glass',
            colorScheme: user && user.colorScheme ? user.colorScheme : 'system'
        });
        setupAccountMenu(user, options);
        setupButtonLighting();
        // Text shares one lazy engine on every page, including the control panel
        // whose buttons and progress bars have their own pointer handler.
        window.TextEffects?.init();
    }

    window.Appearance = {
        init
    };
})();
