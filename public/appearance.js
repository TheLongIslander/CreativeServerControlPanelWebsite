(function() {
    const STYLE_VERSION = '20260402-17';

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
            accountButton.addEventListener('click', (event) => {
                event.stopPropagation();
                dropdown.classList.toggle('hidden');
                if (dropdown.classList.contains('hidden') && appearancePanel) {
                    appearancePanel.classList.add('hidden');
                }
            });
        }

        document.addEventListener('click', () => {
            if (dropdown && !dropdown.classList.contains('hidden')) {
                dropdown.classList.add('hidden');
                if (appearancePanel) {
                    appearancePanel.classList.add('hidden');
                }
            }
        });

        if (dropdown) {
            dropdown.addEventListener('click', (event) => {
                event.stopPropagation();
            });
        }

        if (logoutButton) {
            logoutButton.addEventListener('click', () => {
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

        const updateTarget = (event) => {
            const el = document.elementFromPoint(event.clientX, event.clientY);
            const target = el ? el.closest('button') : null;

            if (currentTarget && currentTarget !== target) {
                resetTarget(currentTarget);
            }

            if (!target) {
                currentTarget = null;
                return;
            }

            const rect = target.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                return;
            }
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const nx = (x - rect.width / 2) / (rect.width / 2);
            const ny = (y - rect.height / 2) / (rect.height / 2);
            const dist = Math.min(Math.sqrt(nx * nx + ny * ny), 1);
            const lightPop = Math.max(0, 1 - dist);
            const pop = lightPop;
            const translateMax = 14;
            const shadowMax = 20;
            const skewMax = 3;
            const scaleMax = 1.03;
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
            currentTarget = target;
        };

        const clearTarget = () => {
            if (currentTarget) {
                resetTarget(currentTarget);
                currentTarget = null;
            }
        };

        document.addEventListener('pointermove', updateTarget);
        document.addEventListener('pointerdown', updateTarget);
        document.addEventListener('pointerleave', clearTarget);

        lightingInitialized = true;
    }

    function init({ user, options } = {}) {
        applyAppearanceSettings({
            uiTheme: user && user.uiTheme ? user.uiTheme : 'glass',
            colorScheme: user && user.colorScheme ? user.colorScheme : 'system'
        });
        setupAccountMenu(user, options);
        setupButtonLighting();
    }

    window.Appearance = {
        init
    };
})();
