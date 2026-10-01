(function serverTileAura(global) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const bounds = global.ServerTileContour.bounds;
    const bodyWidth = bounds.width - 2 * bounds.inset;
    const bodyHeight = bounds.height - 2 * bounds.inset;
    const contourInterval = 1 / 15;
    const interactionInterval = 1 / 30;
    const records = new Set();
    let sequence = 0;
    let frame = null;
    let lastFrame = null;
    let suspended = false;
    let initialized = false;
    let motion;
    let finePointer;
    let intersection;
    let resize;
    let pointer = null;
    let pointerDirty = false;
    let interactionStreak = 0;

    function svg(tag, attributes = {}, children = []) {
        const node = document.createElementNS(NS, tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        node.append(...children);
        return node;
    }
    function canAnimate() {
        return !suspended && !document.hidden && !motion.matches
            && document.body.dataset.uiTheme === 'glass' && document.body.dataset.serverTileStyle !== 'still';
    }
    function visibleRecords() {
        return [...records].filter(record => record.visible && record.visual.isConnected);
    }
    function resetRecord(record) {
        record.nextPaint = null;
        record.paintInterval = null;
        record.sincePaint = 0;
        if (!record.contour.isInteracting()) return;
        record.contour.resetInteraction();
        record.paint(record.contour.path(record.elapsed));
    }
    function resetInteractions() {
        pointer = null;
        pointerDirty = false;
        for (const record of records) resetRecord(record);
    }
    function releasePointer() {
        pointer = null;
        pointerDirty = false;
        for (const record of records) record.contour.releasePointer();
    }
    function updatePointer(active) {
        if (!pointerDirty) return;
        pointerDirty = false;
        if (!pointer || !finePointer.matches) return;
        // Measure the stationary hitbox, not the visual that follows the mouse.
        // Read all rectangles before changing any SVG path or lighting styles.
        for (const record of active) {
            const sensor = record.visual.parentElement || record.visual;
            const rect = sensor.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                record.contour.releasePointer();
                continue;
            }
            record.contour.setPointer(
                bounds.inset + (pointer.x - rect.left) * bodyWidth / rect.width,
                bounds.inset + (pointer.y - rect.top) * bodyHeight / rect.height
            );
        }
    }
    function schedule() {
        for (const record of records) record.updateHalo?.();
        if (canAnimate() && visibleRecords().length) {
            if (frame === null) frame = global.requestAnimationFrame(tick);
        } else {
            if (frame !== null) global.cancelAnimationFrame(frame);
            frame = null;
            lastFrame = null;
            interactionStreak = 0;
            resetInteractions();
        }
    }
    function tick(now) {
        frame = null;
        const active = visibleRecords();
        if (!canAnimate() || !active.length) { lastFrame = null; return; }
        updatePointer(active);
        // Preserve deadline phase across callbacks: discarding a few milliseconds
        // after every paint turns a 30Hz target into ~20Hz on a 60Hz display.
        // Long stalls start a fresh schedule instead of accumulating catch-up work.
        const gap = lastFrame === null ? 0 : Math.max(0, now - lastFrame);
        if (gap > 100) {
            for (const record of active) {
                record.nextPaint = null;
                record.paintInterval = null;
                record.sincePaint = 0;
            }
            interactionStreak = 0;
        }
        const delta = gap > 100 ? 0 : gap / 1000;
        lastFrame = now;
        let interacting = null;
        let ambient = null;
        for (const record of active) {
            record.elapsed += delta;
            record.sincePaint += delta;
            record.contour.advance(delta);
            const isInteracting = record.contour.isInteracting();
            const interval = isInteracting ? interactionInterval : contourInterval;
            if (record.nextPaint == null) record.nextPaint = record.elapsed - delta + interval;
            else if (record.paintInterval !== interval) {
                // An entering or settling interaction adopts its faster cadence
                // from the last paint, without carrying ambient scheduling debt.
                record.nextPaint = record.elapsed - record.sincePaint + interval;
            }
            record.paintInterval = interval;
            // Tolerate numerical rounding at exact 60/120Hz boundaries.
            if (record.elapsed + 1e-6 < record.nextPaint) continue;
            if (isInteracting) {
                if (!interacting || record.sincePaint > interacting.sincePaint) interacting = record;
            } else if (!ambient || record.sincePaint > ambient.sincePaint) {
                ambient = record;
            }
        }
        // At most one SVG repaint per callback. Interactions receive first choice,
        // but reserve every third opportunity for ambient work under overload.
        // Oldest-painted selection shares each class fairly, including settling edges.
        const next = interacting && (!ambient || interactionStreak < 2) ? interacting : ambient;
        if (next) {
            next.paint(next.contour.path(next.elapsed));
            const interval = next.paintInterval;
            // Preserve one pending deadline so jitter can recover its phase even
            // when nominal demand fills every callback. Drop older periods under
            // sustained overload: no tile can accumulate more than one paint owed.
            const skipped = Math.floor(Math.max(0, next.elapsed + 1e-6 - next.nextPaint) / interval);
            next.nextPaint += Math.max(1, skipped) * interval;
            next.sincePaint = 0;
            interactionStreak = next === interacting ? Math.min(2, interactionStreak + 1) : 0;
        }
        frame = global.requestAnimationFrame(tick);
    }
    function initialize() {
        if (initialized) return;
        initialized = true;
        motion = global.matchMedia('(prefers-reduced-motion: reduce)');
        finePointer = global.matchMedia('(hover: hover) and (pointer: fine)');
        finePointer.addEventListener('change', resetInteractions);
        motion.addEventListener('change', schedule);
        document.addEventListener('visibilitychange', schedule);
        new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-ui-theme', 'data-server-tile-style'] });
        global.addEventListener('pagehide', () => { suspended = true; schedule(); });
        global.addEventListener('pageshow', () => { suspended = false; schedule(); });
        document.addEventListener('pointermove', event => {
            if (!canAnimate() || !finePointer.matches || event.pointerType !== 'mouse' || event.buttons) {
                releasePointer();
                return;
            }
            // Pointer events only store the latest sample; geometry and spring
            // work share the existing animation loop, even on high-polling mice.
            pointer = { x: event.clientX, y: event.clientY };
            pointerDirty = true;
        }, { passive: true });
        document.addEventListener('pointerleave', releasePointer);
        document.addEventListener('pointerdown', releasePointer, { passive: true });
        document.addEventListener('pointercancel', resetInteractions);
        document.addEventListener('scroll', resetInteractions, { capture: true, passive: true });
        document.addEventListener('ui-pointer-lighting-reset', resetInteractions);
        global.addEventListener('resize', () => {
            resetInteractions();
            // A display-density change can resize canvas backing stores even
            // when the tile's CSS dimensions (and ResizeObserver) stay unchanged.
            for (const record of records) record.resize();
        });
        global.addEventListener('blur', resetInteractions);
        if (global.IntersectionObserver) {
            intersection = new global.IntersectionObserver(entries => {
                for (const entry of entries) {
                    const record = [...records].find(item => item.visual === entry.target);
                    if (record) {
                        record.visible = entry.isIntersecting;
                        if (!record.visible) resetRecord(record);
                    }
                }
                schedule();
            });
        }
        if (global.ResizeObserver) {
            resize = new global.ResizeObserver(entries => {
                for (const entry of entries) {
                    const record = [...records].find(item => item.visual === entry.target);
                    record?.resize();
                }
            });
        }
    }
    function create(visual, { imageFit = 'cover', imageBackground = '#101215' } = {}) {
        initialize();
        const id = `server-aura-${++sequence}`;
        // The overview has <base href="/">; qualify SVG references to this document.
        const reference = suffix => `${global.location.href.split('#')[0]}#${id}-${suffix}`;
        const paint = suffix => `url(${JSON.stringify(reference(suffix))})`;
        const contour = global.ServerTileContour.create();
        const restingPath = contour.path(0);
        const path = svg('path', { d: restingPath, fill: 'white', filter: paint('feather') });
        const initial = svg('text', { class: 'server-tile-aura-initial', x: 167, y: 154, 'text-anchor': 'middle', fill: '#c3faf3', 'font-size': 100, 'font-weight': 700 });
        const contained = imageFit === 'contain';
        const image = svg('image', { width: 334, height: 510, preserveAspectRatio: contained ? 'xMidYMid meet' : 'xMidYMid slice' });
        // Blend the dark artwork backdrop into its letterbox fill without adding
        // another blur/filter pass or a visible rectangular image boundary.
        if (contained) image.setAttribute('style', 'mix-blend-mode: lighten');
        const background = svg('rect', { width: 334, height: 510, fill: paint('fallback') });
        const art = svg('g', { id: `${id}-art` }, [
            background, initial, image
        ]);
        const outline = svg('g', {}, [path]);
        const mask = svg('mask', { id: `${id}-mask`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 334, height: 510, 'mask-type': 'alpha' }, [outline]);
        const glow = svg('filter', { id: `${id}-glow`, x: -40, y: -40, width: 414, height: 590, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, [
            svg('feGaussianBlur', { stdDeviation: 14 }),
            svg('feColorMatrix', { type: 'saturate', values: 1.45 }),
            svg('feComponentTransfer', {}, [svg('feFuncA', { type: 'linear', slope: .65 })]),
            // Reuse the masked source for the crisp image instead of masking a second copy.
            svg('feMerge', {}, [svg('feMergeNode'), svg('feMergeNode', { in: 'SourceGraphic' })])
        ]);
        const defs = svg('defs', {}, [
            svg('linearGradient', { id: `${id}-fallback`, x2: '100%', y2: '100%' }, [
                svg('stop', { class: 'server-tile-aura-tint', offset: '0', 'stop-color': '#287f83' }),
                svg('stop', { class: 'server-tile-aura-depth', offset: '1', 'stop-color': '#102b43' })
            ]),
            svg('filter', { id: `${id}-feather`, x: 0, y: 0, width: 334, height: 510, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, [
                svg('feGaussianBlur', { stdDeviation: 11 }),
                svg('feComponentTransfer', {}, [svg('feFuncA', { type: 'linear', slope: 1.025, intercept: -0.0125 })])
            ]),
            glow, mask, art
        ]);
        const maskedArt = () => svg('g', { mask: paint('mask') }, [svg('use', { href: reference('art') })]);
        const foreground = svg('g', { filter: paint('glow') }, [maskedArt()]);
        const surface = svg('svg', {
            class: 'server-tile-aura', viewBox: '0 0 334 510', preserveAspectRatio: 'none',
            'aria-hidden': 'true', focusable: 'false'
        }, [defs, foreground]);
        let source;
        let letter = '';
        let halo = null;
        let artworkWidth;
        let artworkHeight;
        let initialY;
        function paintContour(data) {
            path.setAttribute('d', data);
            // Both renderers follow the same scheduled contour. Reading back d
            // also keeps the diagnostic's frozen-path mode consistent on Safari.
            halo?.setPath?.(path.getAttribute('d'));
        }
        function refreshHalo() {
            if (!halo) return;
            const enabled = !suspended && !document.hidden && record.visible && visual.isConnected
                && document.body.dataset.uiTheme === 'glass' && document.body.dataset.serverTileStyle !== 'still';
            halo.setEnabled(enabled);
            if (!enabled) return;
            const stops = defs.children[0].children;
            halo.update({
                width: artworkWidth, height: artworkHeight,
                path: restingPath, source, label: letter, initialY, contained, imageBackground,
                tint: global.getComputedStyle(stops[0]).stopColor,
                depth: global.getComputedStyle(stops[1]).stopColor,
                initialColor: global.getComputedStyle(initial).fill,
                fontFamily: global.getComputedStyle(initial).fontFamily
            });
        }
        function fit() {
            const slotWidth = visual.clientWidth || bounds.width;
            const slotHeight = visual.clientHeight || bounds.height;
            // The contour's inset reserves space for feathering and deformation.
            // Enlarge only the artwork so its visible body fills the Still tile's
            // footprint; layout, controls and pointer hitboxes keep their size.
            const width = artworkWidth = slotWidth * bounds.width / bodyWidth;
            const height = artworkHeight = slotHeight * bounds.height / bodyHeight;
            const left = (slotWidth - width) / 2;
            const top = (slotHeight - height) / 2;
            visual.style.setProperty('--tile-art-width', `${width}px`);
            visual.style.setProperty('--tile-art-height', `${height}px`);
            visual.style.setProperty('--tile-art-left', `${left}px`);
            visual.style.setProperty('--tile-art-top', `${top}px`);
            surface.setAttribute('viewBox', `0 0 ${width} ${height}`);
            // Resize the mask independently; artwork retains its chosen aspect fit.
            outline.setAttribute('transform', `scale(${width / 334} ${height / 510})`);
            for (const node of [background, image, mask]) {
                node.setAttribute('width', width);
                node.setAttribute('height', height);
            }
            initial.setAttribute('x', width / 2);
            initialY = 154 - top;
            initial.setAttribute('y', initialY);
            glow.setAttribute('width', width + 80);
            glow.setAttribute('height', height + 80);
            // Re-evaluate a stationary pointer after responsive layout changes.
            if (pointer) pointerDirty = true;
            refreshHalo();
        }
        visual.append(surface);
        visual.classList.add('has-live-aura');
        if (global.ServerTileHalo?.isPreferred()) {
            halo = global.ServerTileHalo.create(visual, ready => {
                if (ready) foreground.removeAttribute('filter');
                else foreground.setAttribute('filter', paint('glow'));
                const cachedForeground = ready && !!halo?.setPath;
                surface.style.display = cachedForeground ? 'none' : '';
                surface.dataset.auraForeground = cachedForeground ? 'canvas' : 'svg';
                surface.dataset.auraRenderer = ready ? 'cached-halo' : 'svg';
            });
        }
        const record = { visual, surface, contour, path, paint: paintContour, visible: !intersection, resize: fit, updateHalo: refreshHalo, elapsed: 0, sincePaint: 0 };
        records.add(record);
        fit();
        paintContour(restingPath);
        resize?.observe(visual);
        intersection?.observe(visual);
        schedule();
        // createTile mounts synchronously after create(); IO normally reports that mount.
        if (!intersection) global.queueMicrotask?.(schedule);
        return {
            setArtwork(url, label) {
                letter = label.slice(0, 1).toUpperCase();
                if (initial.textContent !== letter) initial.textContent = letter;
                if (url === source) { refreshHalo(); return; }
                source = url;
                background.setAttribute('fill', url && contained ? imageBackground : paint('fallback'));
                background.setAttribute('visibility', url && !contained ? 'hidden' : 'visible');
                initial.setAttribute('visibility', url ? 'hidden' : 'visible');
                if (url) image.setAttribute('href', url);
                else image.removeAttribute('href');
                refreshHalo();
            },
            refreshAppearance: refreshHalo,
            destroy() {
                halo?.destroy();
                record.contour.resetInteraction();
                intersection?.unobserve(visual);
                resize?.unobserve(visual);
                records.delete(record);
                surface.remove();
                visual.classList.remove('has-live-aura');
                for (const property of ['width', 'height', 'left', 'top']) visual.style.removeProperty(`--tile-art-${property}`);
                schedule();
            }
        };
    }
    global.ServerTileAura = { create };
})(window);
