(function (global) {
    'use strict';

    const HIGHLIGHT_NAME = 'glass-text-effects-active';
    const EXCLUDED = 'button, [role="button"], input, textarea, select, option, [contenteditable]:not([contenteditable="false"]), [hidden], [inert], [aria-hidden="true"], svg, canvas, [data-no-pointer-lighting], [data-no-text-effects], .overview-title-visual, .glass-text-effects-overlay';
    const SIMPLE_TEXT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]*$/u;
    const FONT_PROPERTIES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'textTransform', 'color'];
    const MAX_GLYPHS = 16;
    let initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;
        if (!global.CSS?.highlights || typeof global.Highlight !== 'function' ||
            typeof global.Intl?.Segmenter !== 'function' || !document.createRange ||
            !global.matchMedia || !global.requestAnimationFrame) return;

        const finePointer = global.matchMedia('(hover: hover) and (pointer: fine)');
        const reducedMotion = global.matchMedia('(prefers-reduced-motion: reduce)');
        const segmenter = new global.Intl.Segmenter(undefined, { granularity: 'grapheme' });
        let overlay = null;
        let active = null;
        let frame = 0;
        let pressed = false;
        let pointer = { x: 0, y: 0 };
        let settleUntil = 0;

        const allowed = () => document.body?.dataset.uiTheme === 'glass' && finePointer.matches &&
            !reducedMotion.matches && !document.hidden && !pressed &&
            (!global.getSelection || global.getSelection()?.isCollapsed);

        function reset() {
            if (frame) global.cancelAnimationFrame(frame);
            frame = 0;
            observer.disconnect();
            global.CSS.highlights.delete(HIGHLIGHT_NAME);
            overlay?.remove();
            overlay = null;
            active = null;
        }

        function usable(node) {
            const parent = node?.parentElement;
            return node?.nodeType === 3 && parent && node.isConnected && node.data.trim() && !parent.closest(EXCLUDED);
        }

        function rectNear(rect, x, y, margin = 0) {
            return rect.width > 0 && rect.height > 0 && x >= rect.left - margin && x <= rect.right + margin &&
                y >= rect.top - margin && y <= rect.bottom + margin;
        }

        function sourceAtPoint(x, y) {
            let node;
            let offset;
            if (document.caretPositionFromPoint) {
                const caret = document.caretPositionFromPoint(x, y);
                node = caret?.offsetNode;
                offset = caret?.offset;
            } else if (document.caretRangeFromPoint) {
                const caret = document.caretRangeFromPoint(x, y);
                node = caret?.startContainer;
                offset = caret?.startOffset;
            }
            const hit = document.elementFromPoint(x, y);
            if (!hit || hit.closest(EXCLUDED)) return null;
            if (usable(node) && (hit.contains(node) || node.parentElement.contains(hit))) return { node, offset };

            // Pointer-transparent card visuals can be skipped by the caret API. Search only the
            // actual hit subtree, with a hard bound; never walk the page's complete text content.
            const walker = document.createTreeWalker(hit, 4);
            for (let count = 0; count < 40 && (node = walker.nextNode()); count += 1) {
                if (!usable(node)) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                if (!Array.from(range.getClientRects()).some(rect => rectNear(rect, x, y, 2))) continue;
                let low = 0;
                let high = node.data.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    range.setStart(node, middle);
                    range.setEnd(node, Math.min(middle + 1, node.data.length));
                    const rect = range.getBoundingClientRect();
                    if (y >= rect.bottom || (y >= rect.top && x > (rect.left + rect.right) / 2)) low = middle + 1;
                    else high = middle;
                }
                return { node, offset: low };
            }
            return null;
        }

        function prepareSource(node) {
            // Safari can paint anonymous flex-item text twice when a custom highlight is applied.
            // One inline wrapper fixes that without splitting/replacing the original Text node.
            const parent = node.parentElement;
            if (['flex', 'inline-flex'].includes(global.getComputedStyle(parent).display)) {
                const wrapper = document.createElement('span');
                wrapper.className = 'glass-text-effects-source';
                parent.insertBefore(wrapper, node);
                wrapper.appendChild(node);
            }
        }

        function segmentsNear(node, offset) {
            let start = Math.max(0, offset - 96);
            if (start && /[\uDC00-\uDFFF]/.test(node.data[start])) start -= 1;
            const text = node.data.slice(start, Math.min(node.data.length, offset + 96));
            // Cursive/contextually shaped scripts stay intact. Their static raised finish remains.
            if (!SIMPLE_TEXT.test(text)) return [];
            const segments = Array.from(segmenter.segment(text), item => ({
                text: item.segment, start: start + item.index, end: start + item.index + item.segment.length
            }));
            // Keep common Latin ligatures together so glyph shaping is preserved while hovering.
            const joined = [];
            for (let index = 0; index < segments.length; index += 1) {
                const rest = segments.slice(index, index + 3).map(item => item.text).join('');
                const ligature = /^(ffi|ffl|ff|fi|fl)/.exec(rest)?.[0];
                if (ligature) {
                    joined.push({ text: ligature, start: segments[index].start, end: segments[index + ligature.length - 1].end });
                    index += ligature.length - 1;
                } else joined.push(segments[index]);
            }
            return joined.filter(item => item.text.trim()).sort((a, b) =>
                Math.abs((a.start + a.end) / 2 - offset) - Math.abs((b.start + b.end) / 2 - offset)
            ).slice(0, MAX_GLYPHS);
        }

        function sourceGeometry(parent) {
            let matrix = [1, 0, 0, 1];
            let opacity = 1;
            const clip = { left: 0, top: 0, right: global.innerWidth, bottom: global.innerHeight };
            for (let element = parent; element && element !== document.documentElement; element = element.parentElement) {
                const style = global.getComputedStyle(element);
                opacity *= Number(style.opacity || 1);
                const clipsX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
                const clipsY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
                if (clipsX || clipsY) {
                    const rect = element.getBoundingClientRect();
                    if (clipsX) {
                        clip.left = Math.max(clip.left, rect.left);
                        clip.right = Math.min(clip.right, rect.right);
                    }
                    if (clipsY) {
                        clip.top = Math.max(clip.top, rect.top);
                        clip.bottom = Math.min(clip.bottom, rect.bottom);
                    }
                }
                const transform = style.transform;
                if (!transform || transform === 'none') continue;
                const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
                const [a, b, c, d] = transform.startsWith('matrix3d') ? [values[0], values[1], values[4], values[5]] : values;
                if (![a, b, c, d].every(Number.isFinite)) continue;
                const [ma, mb, mc, md] = matrix;
                matrix = [a * ma + c * mb, b * ma + d * mb, a * mc + c * md, b * mc + d * md];
            }
            return { matrix, clip, opacity };
        }

        function render() {
            frame = 0;
            if (!active || !allowed() || !usable(active.node) || active.node.data !== active.text) return reset();
            const style = global.getComputedStyle(active.node.parentElement);
            if (style.visibility !== 'visible' || style.display === 'none') return reset();
            const fontSize = parseFloat(style.fontSize) || 16;
            const radius = Math.min(100, Math.max(32, fontSize * 2.6));
            const { matrix, clip, opacity } = sourceGeometry(active.node.parentElement);
            const [a, b, c, d] = matrix;
            const determinant = Math.abs(a * d) - Math.abs(b * c);
            if (Math.abs(determinant) < 0.01) return reset();
            const visible = [];
            for (const entry of active.glyphs) {
                const rect = entry.range.getBoundingClientRect();
                const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
                const dx = pointer.x - (rect.left + rect.right) / 2;
                const dy = pointer.y - (rect.top + rect.bottom) / 2;
                const proximity = Math.max(0, 1 - Math.hypot(dx / radius, dy / Math.max(rect.height * 1.35, 16)));
                const pop = proximity * proximity * (3 - 2 * proximity);
                if (!rect.width || !rect.height || !opacity || pop < 0.015 ||
                    rect.left < clip.left || rect.right > clip.right || rect.top < clip.top || rect.bottom > clip.bottom ||
                    !hit || !(hit.contains(active.node) || active.node.parentElement.contains(hit))) {
                    entry.glyph.hidden = true;
                    continue;
                }
                // Reconstruct the pre-transform text rectangle, then copy ancestor scale/skew.
                // The overlay remains aligned even while its card's separate physics settle.
                const width = (Math.abs(d) * rect.width - Math.abs(c) * rect.height) / determinant;
                const height = (Math.abs(a) * rect.height - Math.abs(b) * rect.width) / determinant;
                if (!(width > 0 && height > 0)) {
                    entry.glyph.hidden = true;
                    continue;
                }
                const glyph = entry.glyph;
                glyph.hidden = false;
                glyph.style.opacity = opacity;
                for (const property of FONT_PROPERTIES) glyph.style[property] = style[property];
                glyph.style.left = `${rect.left - Math.min(0, a * width, c * height, a * width + c * height)}px`;
                glyph.style.top = `${rect.top - Math.min(0, b * width, d * height, b * width + d * height)}px`;
                glyph.style.width = `${width}px`;
                glyph.style.height = `${height}px`;
                glyph.style.lineHeight = `${height}px`;
                glyph.style.setProperty('--text-source-transform', `matrix(${a},${b},${c},${d},0,0)`);
                glyph.style.setProperty('--text-pop', pop.toFixed(4));
                glyph.style.setProperty('--text-tx', `${(dx / radius * fontSize * 0.045 * pop).toFixed(3)}px`);
                glyph.style.setProperty('--text-ty', `${(-fontSize * 0.055 * pop).toFixed(3)}px`);
                glyph.style.setProperty('--text-sx', `${(-dx / radius * fontSize * 0.065 * pop).toFixed(3)}px`);
                glyph.style.setProperty('--text-sy', `${(fontSize * 0.035 * pop).toFixed(3)}px`);
                glyph.style.setProperty('--text-scale', (1 + 0.07 * pop).toFixed(4));
                visible.push(entry.range);
            }
            if (!visible.length) return reset();
            global.CSS.highlights.set(HIGHLIGHT_NAME, new global.Highlight(...visible));
            if (performance.now() < settleUntil) frame = global.requestAnimationFrame(render);
        }

        const observer = new MutationObserver(records => {
            if (!active) return;
            // A newly shown sibling menu/dialog can occlude the source without changing any of
            // its ancestors. Recheck bounded active glyphs for all non-decoration mutations.
            const relevant = records.some(record => !overlay?.contains(record.target));
            if (relevant) {
                settleUntil = performance.now() + 500;
                if (!frame) frame = global.requestAnimationFrame(render);
            }
        });

        function update(event) {
            if (event.pointerType !== 'mouse' || event.buttons || !allowed()) return reset();
            pointer = { x: event.clientX, y: event.clientY };
            const source = sourceAtPoint(pointer.x, pointer.y);
            if (!source) return reset();
            const style = global.getComputedStyle(source.node.parentElement);
            if (style.direction === 'rtl' || !['none', 'uppercase', 'lowercase'].includes(style.textTransform)) return reset();
            const segments = segmentsNear(source.node, source.offset);
            if (!segments.length) return reset();
            if (!active || active.node !== source.node || active.text !== source.node.data) {
                reset();
                prepareSource(source.node);
                overlay = document.createElement('div');
                overlay.className = 'glass-text-effects-overlay';
                overlay.setAttribute('aria-hidden', 'true');
                document.body.appendChild(overlay);
                active = { node: source.node, text: source.node.data, glyphs: [] };
                observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-ui-theme', 'data-color-scheme',
                        'data-no-text-effects', 'data-no-pointer-lighting'] });
            }
            const previous = new Map(active.glyphs.map(entry => [entry.start, entry]));
            active.glyphs = segments.map(segment => {
                let entry = previous.get(segment.start);
                if (entry) previous.delete(segment.start);
                else {
                    const range = document.createRange();
                    range.setStart(source.node, segment.start);
                    range.setEnd(source.node, segment.end);
                    const glyph = document.createElement('span');
                    glyph.className = 'glass-text-effect-glyph';
                    glyph.dataset.text = segment.text;
                    glyph.hidden = true; // Reveal only after its position is measured in render().
                    overlay.appendChild(glyph);
                    entry = { range, glyph, start: segment.start };
                }
                return entry;
            });
            previous.forEach(entry => entry.glyph.remove());
            settleUntil = performance.now() + 500;
            if (!frame) frame = global.requestAnimationFrame(render);
        }

        document.addEventListener('pointermove', update, { passive: true });
        document.addEventListener('pointerdown', () => { pressed = true; reset(); }, { passive: true });
        document.addEventListener('pointerup', () => { pressed = false; }, { passive: true });
        document.addEventListener('pointercancel', () => { pressed = false; reset(); });
        document.addEventListener('pointerleave', reset);
        document.addEventListener('selectstart', reset);
        document.addEventListener('selectionchange', () => { if (!global.getSelection()?.isCollapsed) reset(); });
        document.addEventListener('dragstart', reset);
        document.addEventListener('scroll', reset, { passive: true, capture: true });
        document.addEventListener('visibilitychange', reset);
        document.addEventListener('ui-pointer-lighting-reset', reset);
        global.addEventListener('resize', reset);
        global.addEventListener('blur', () => { pressed = false; reset(); });
        global.addEventListener('pagehide', reset);
        finePointer.addEventListener('change', reset);
        reducedMotion.addEventListener('change', reset);
        // Keep the reset path available when appearance settings change before CSS has settled.
        new MutationObserver(reset).observe(document.body, { attributes: true,
            attributeFilter: ['data-ui-theme', 'data-color-scheme'] });
    }

    global.TextEffects = { init };
})(window);
