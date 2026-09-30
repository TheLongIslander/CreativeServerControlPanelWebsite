(function serverTileAura(global) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
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
        if (!record.contour.isInteracting()) return;
        record.contour.resetInteraction();
        record.path.setAttribute('d', record.contour.path(record.elapsed));
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
                (pointer.x - rect.left) * 334 / rect.width,
                (pointer.y - rect.top) * 510 / rect.height
            );
        }
    }
    function schedule() {
        if (canAnimate() && visibleRecords().length) {
            if (frame === null) frame = global.requestAnimationFrame(tick);
        } else {
            if (frame !== null) global.cancelAnimationFrame(frame);
            frame = null;
            lastFrame = null;
            resetInteractions();
        }
    }
    function tick(now) {
        frame = null;
        const active = visibleRecords();
        if (!canAnimate() || !active.length) { lastFrame = null; return; }
        updatePointer(active);
        // Slow ambient motion uses 15fps; only a pulled or settling edge gets
        // 30fps. Keep at most one SVG repaint per display frame in either case.
        if (lastFrame === null) lastFrame = now;
        const delta = Math.min(now - lastFrame, 100) / 1000;
        lastFrame = now;
        let next = null;
        let mostOverdue = 0;
        for (const record of active) {
            record.elapsed += delta;
            record.sincePaint += delta;
            record.contour.advance(delta);
            const interval = record.contour.isInteracting() ? interactionInterval : contourInterval;
            const overdue = record.sincePaint / interval;
            if (overdue >= 1 && overdue > mostOverdue) {
                next = record;
                mostOverdue = overdue;
            }
        }
        if (next) {
            next.path.setAttribute('d', next.contour.path(next.elapsed));
            next.sincePaint = 0;
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
        global.addEventListener('resize', resetInteractions);
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
        const path = svg('path', { d: contour.path(0), fill: 'white', filter: paint('feather') });
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
        const surface = svg('svg', {
            class: 'server-tile-aura', viewBox: '0 0 334 510', preserveAspectRatio: 'none',
            'aria-hidden': 'true', focusable: 'false'
        }, [defs, svg('g', { filter: paint('glow') }, [maskedArt()])]);
        function fit() {
            const width = visual.clientWidth || 334;
            const height = visual.clientHeight || 510;
            surface.setAttribute('viewBox', `0 0 ${width} ${height}`);
            // Resize the mask independently; artwork retains its chosen aspect fit.
            outline.setAttribute('transform', `scale(${width / 334} ${height / 510})`);
            for (const node of [background, image, mask]) {
                node.setAttribute('width', width);
                node.setAttribute('height', height);
            }
            initial.setAttribute('x', width / 2);
            glow.setAttribute('width', width + 80);
            glow.setAttribute('height', height + 80);
            // Re-evaluate a stationary pointer after responsive layout changes.
            if (pointer) pointerDirty = true;
        }
        visual.append(surface);
        visual.classList.add('has-live-aura');
        const record = { visual, surface, contour, path, visible: !intersection, resize: fit, elapsed: 0, sincePaint: 0 };
        records.add(record);
        fit();
        resize?.observe(visual);
        intersection?.observe(visual);
        schedule();
        // createTile mounts synchronously after create(); IO normally reports that mount.
        if (!intersection) global.queueMicrotask?.(schedule);
        let source;
        return {
            setArtwork(url, label) {
                const letter = label.slice(0, 1).toUpperCase();
                if (initial.textContent !== letter) initial.textContent = letter;
                if (url === source) return;
                source = url;
                background.setAttribute('fill', url && contained ? imageBackground : paint('fallback'));
                background.setAttribute('visibility', url && !contained ? 'hidden' : 'visible');
                initial.setAttribute('visibility', url ? 'hidden' : 'visible');
                if (url) image.setAttribute('href', url);
                else image.removeAttribute('href');
            },
            destroy() {
                record.contour.resetInteraction();
                intersection?.unobserve(visual);
                resize?.unobserve(visual);
                records.delete(record);
                surface.remove();
                visual.classList.remove('has-live-aura');
                schedule();
            }
        };
    }
    global.ServerTileAura = { create };
})(window);
