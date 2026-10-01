/*
 * Paste this file into DevTools on the server overview in Dynamic Tile mode.
 * Keep the tab visible and repeat the same real mouse movement for each run:
 *   await DynamicTileProbe.measure({ durationMs: 10000 })
 *   DynamicTileProbe.setMode('no-glow')
 *   await DynamicTileProbe.measure({ durationMs: 10000 })
 * Modes: full, freeze-contour, no-glow, no-feather, no-backdrop, no-transform.
 *   DynamicTileProbe.restore() // restore effects; retain the probe
 *   DynamicTileProbe.dispose() // restore effects and remove the probe
 * rAF cadence is callback timing, NOT presented FPS. Path counts are DOM writes,
 * NOT displayed frames. Compare modes on the same browser, viewport and tiles.
 */
(function installDynamicTileProbe() {
    'use strict';
    if ('DynamicTileProbe' in window) throw new Error('DynamicTileProbe already exists; dispose it before reinstalling.');

    const pathSelector = 'svg.server-tile-aura defs mask > g > path';
    const modes = ['full', 'freeze-contour', 'no-glow', 'no-feather', 'no-backdrop', 'no-transform'];
    let mode = 'full';
    let undo = [];
    let measurement = null;
    let disposed = false;

    function assertInstalled() {
        if (disposed) throw new Error('This probe has been disposed.');
    }
    function restoreEffects() {
        for (const revert of undo.reverse()) revert();
        undo = [];
        mode = 'full';
    }
    function removeAttribute(node, name) {
        const value = node.getAttribute(name);
        const present = node.hasAttribute(name);
        undo.push(() => present ? node.setAttribute(name, value) : node.removeAttribute(name));
        node.removeAttribute(name);
    }
    function injectStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).append(style);
        undo.push(() => style.remove());
    }
    function visible(node) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return node.getClientRects().length > 0 && style.display !== 'none'
            && style.visibility === 'visible' && rect.width > 0 && rect.height > 0
            && rect.bottom > 0 && rect.right > 0
            && rect.top < innerHeight && rect.left < innerWidth;
    }
    function scene() {
        const tiles = [...document.querySelectorAll('.server-tile')];
        const surfaces = [...document.querySelectorAll('svg.server-tile-aura')];
        const foregrounds = [...document.querySelectorAll('canvas.server-tile-foreground')];
        return {
            tileCount: tiles.length,
            visibleTileCount: tiles.filter(visible).length,
            visibleAuraCount: surfaces.filter(surface => {
                const foreground = surface.parentElement.querySelector('canvas.server-tile-foreground');
                return visible(surface) || (foreground && visible(foreground));
            }).length,
            auraRenderers: surfaces.map(surface => surface.dataset.auraRenderer || 'svg'),
            foregroundRenderers: surfaces.map(surface => surface.dataset.auraForeground || 'svg'),
            canvasForegroundCount: foregrounds.length,
            visibleCanvasForegroundCount: foregrounds.filter(visible).length,
            canvasForegroundResolution: foregrounds.map(canvas => ({
                width: canvas.width,
                height: canvas.height,
                cssWidth: canvas.clientWidth,
                cssHeight: canvas.clientHeight
            })),
            cachedHaloCount: document.querySelectorAll('.server-tile-halo').length,
            auraMaskPathCount: document.querySelectorAll(pathSelector).length,
            dpr: devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight },
            visibility: document.visibilityState,
            theme: document.body.dataset.uiTheme,
            tileStyle: document.body.dataset.serverTileStyle,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
        };
    }
    function statistics(values) {
        if (!values.length) return { samples: 0 };
        const ordered = [...values].sort((a, b) => a - b);
        const percentile = fraction => ordered[Math.ceil(fraction * ordered.length) - 1];
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const median = (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
        return {
            samples: values.length,
            meanMs: mean,
            medianMs: median,
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
            maxMs: ordered[ordered.length - 1],
            estimatedCallbackHzFromMedian: 1000 / median,
            averageCallbackHz: 1000 / mean,
            intervalsOver25Ms: values.filter(value => value > 25).length,
            intervalsOver50Ms: values.filter(value => value > 50).length
        };
    }
    function setMode(nextMode) {
        assertInstalled();
        if (!modes.includes(nextMode)) throw new Error(`Unknown mode. Use: ${modes.join(', ')}.`);
        if (measurement) throw new Error('Finish the current measurement before changing mode, or call restore().');
        restoreEffects();
        try {
            if (nextMode === 'freeze-contour') {
                for (const path of document.querySelectorAll(pathSelector)) {
                    const descriptor = Object.getOwnPropertyDescriptor(path, 'setAttribute');
                    const original = path.setAttribute;
                    Object.defineProperty(path, 'setAttribute', {
                        configurable: true,
                        writable: true,
                        value: function setAttribute(name, value) {
                            if (String(name) === 'd') return undefined;
                            return Reflect.apply(original, this, arguments);
                        }
                    });
                    undo.push(() => {
                        if (descriptor) Object.defineProperty(path, 'setAttribute', descriptor);
                        else delete path.setAttribute;
                    });
                }
            } else if (nextMode === 'no-glow') {
                // Safari's outer glow is a cached canvas; other browsers use SVG.
                injectStyle('body.server-overview .server-tile-halo { visibility: hidden !important; }');
                for (const surface of document.querySelectorAll('svg.server-tile-aura')) {
                    // create() appends defs and an outer, glow-filtered g.
                    const outerGroup = [...surface.children].find(node => node.localName === 'g' && node.hasAttribute('filter'));
                    if (outerGroup) removeAttribute(outerGroup, 'filter');
                }
            } else if (nextMode === 'no-feather') {
                // Show the matching SVG artwork without its feathered mask.
                // Removing this temporary style restores Safari's canvas renderer.
                injectStyle(`body.server-overview .server-tile-foreground { visibility: hidden !important; }
                    body.server-overview svg.server-tile-aura { display: block !important; }`);
                for (const path of document.querySelectorAll(pathSelector)) removeAttribute(path, 'filter');
            } else if (nextMode === 'no-backdrop') {
                injectStyle(`body.server-overview .server-tile-info,
                    body.server-overview .server-tile-power,
                    body.server-overview .server-slot-popup {
                    -webkit-backdrop-filter: none !important;
                    backdrop-filter: none !important;
                }`);
            } else if (nextMode === 'no-transform') {
                injectStyle(`body.server-overview .server-tile-visual,
                    body.server-overview .server-tile-info,
                    body.server-overview .server-tile-power,
                    body.server-overview .server-tile-power-icon {
                    transform: none !important;
                }`);
            }
            mode = nextMode;
        } catch (error) {
            restoreEffects();
            throw error;
        }
        return { mode, scene: scene(), note: 'Reapply the mode if tiles are added or replaced before measuring.' };
    }
    function measure({ durationMs = 10000 } = {}) {
        assertInstalled();
        if (measurement) throw new Error('A measurement is already running.');
        if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 120000) {
            throw new Error('durationMs must be between 1000 and 120000.');
        }
        const startScene = scene();
        const started = performance.now();
        const runMode = mode;
        const intervals = [];
        const transitions = [];
        const paths = new Map();
        let lastTimestamp = null;
        let raf = null;
        let timer = null;
        let finished = false;

        function pathRecord(path) {
            if (!paths.has(path)) {
                const tile = path.closest('.server-tile');
                paths.set(path, {
                    serverId: tile?.dataset.serverId || null,
                    name: tile?.querySelector('h2')?.textContent?.trim() || null,
                    auraId: path.closest('mask')?.id || null,
                    visibleAtFirstObservation: tile ? visible(tile) : false,
                    pathMutationCount: 0
                });
            }
            return paths.get(path);
        }
        document.querySelectorAll(pathSelector).forEach(pathRecord);
        function countMutations(records) {
            for (const record of records) {
                if (record.target.matches(pathSelector)) pathRecord(record.target).pathMutationCount++;
            }
        }
        const observer = new MutationObserver(countMutations);
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['d'] });
        function onVisibility() {
            transitions.push({ elapsedMs: performance.now() - started, state: document.visibilityState });
            lastTimestamp = null;
        }
        document.addEventListener('visibilitychange', onVisibility);
        function sample(timestamp) {
            if (!document.hidden) {
                if (lastTimestamp !== null) intervals.push(timestamp - lastTimestamp);
                lastTimestamp = timestamp;
            } else lastTimestamp = null;
            raf = requestAnimationFrame(sample);
        }
        return new Promise(resolve => {
            function finish(reason = 'completed') {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                cancelAnimationFrame(raf);
                countMutations(observer.takeRecords());
                observer.disconnect();
                document.removeEventListener('visibilitychange', onVisibility);
                const elapsedMs = performance.now() - started;
                measurement = null;
                resolve({
                    mode: runMode,
                    reason,
                    requestedDurationMs: durationMs,
                    elapsedMs,
                    userAgent: navigator.userAgent,
                    sceneAtStart: startScene,
                    sceneAtEnd: scene(),
                    visibilityTransitions: transitions,
                    rafCadence: statistics(intervals),
                    tiles: [...paths.values()].map(record => ({
                        ...record,
                        pathMutationsPerSecond: record.pathMutationCount * 1000 / elapsedMs
                    })),
                    notes: [
                        'rAF timing measures callback cadence, not presented FPS or the physical refresh rate.',
                        'rAF intervals exclude periods crossing a visibility transition; path rates use wall time.',
                        'Path counts are d-attribute mutation records, not paints or presented frames.',
                        'freeze-contour keeps physics and lighting running but blocks d assignments.',
                        'no-feather uses the SVG foreground without feathering and retains the cached halo.',
                        'Use the same tile set and mouse movement; added tiles need the mode reapplied.'
                    ]
                });
            }
            measurement = { finish };
            raf = requestAnimationFrame(sample);
            timer = setTimeout(finish, durationMs);
        });
    }
    const api = {
        measure,
        setMode,
        get mode() { return mode; },
        restore() {
            assertInstalled();
            measurement?.finish('restored');
            restoreEffects();
            return { mode };
        },
        dispose() {
            if (disposed) return;
            measurement?.finish('disposed');
            restoreEffects();
            disposed = true;
            if (window.DynamicTileProbe === api) delete window.DynamicTileProbe;
        }
    };
    window.DynamicTileProbe = api;
    console.info('DynamicTileProbe installed. Run await DynamicTileProbe.measure(); use setMode() for an A/B comparison and dispose() to remove.');
})();
