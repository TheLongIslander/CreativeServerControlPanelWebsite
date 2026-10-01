(function serverTileHalo(global) {
    'use strict';
    const padding = 40;
    const escape = value => String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[char]);

    function isPreferred() {
        const { userAgent = '', vendor = '' } = global.navigator || {};
        return vendor === 'Apple Computer, Inc.' && /AppleWebKit\//.test(userAgent)
            && /Safari\//.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/.test(userAgent);
    }

    function loadImage(source, signal) {
        return new Promise((resolve, reject) => {
            const image = new global.Image();
            const cleanup = () => {
                image.onload = image.onerror = null;
                signal.removeEventListener('abort', abort);
            };
            const abort = () => {
                cleanup();
                image.removeAttribute('src');
                reject(new Error('Halo render cancelled'));
            };
            image.onload = () => { cleanup(); resolve(image); };
            image.onerror = () => { cleanup(); reject(new Error('Halo image unavailable')); };
            if (signal.aborted) return abort();
            signal.addEventListener('abort', abort, { once: true });
            image.src = source;
        });
    }

    function create(visual, onReady) {
        if (typeof global.Path2D !== 'function') return null;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const foreground = document.createElement('canvas');
        const foregroundContext = foreground.getContext('2d');
        const foregroundArt = document.createElement('canvas');
        const artworkContext = foregroundArt.getContext('2d');
        const mask = document.createElement('canvas');
        const maskContext = mask.getContext('2d', { willReadFrequently: true });
        const buffers = [canvas, foreground, foregroundArt, mask];
        if (!context || !foregroundContext || !artworkContext || !maskContext) {
            for (const buffer of buffers) buffer.width = buffer.height = 1;
            return null;
        }
        canvas.className = 'server-tile-halo';
        foreground.className = 'server-tile-foreground';
        for (const surface of [canvas, foreground]) {
            surface.setAttribute('aria-hidden', 'true');
            surface.style.visibility = 'hidden';
        }
        mask.width = 167;
        mask.height = 255;
        visual.append(canvas, foreground);
        let enabled = false;
        let disposed = false;
        let generation = 0;
        let snapshot = null;
        let key = null;
        let renderedKey = null;
        let timer = null;
        let renderAbort = null;
        let artwork = null;
        let latestPath = null;
        let paintedPath = null;

        function cancel() {
            generation++;
            if (timer !== null) global.clearTimeout(timer);
            timer = null;
            renderAbort?.abort();
            renderAbort = null;
        }
        function hide() {
            canvas.style.visibility = 'hidden';
            foreground.style.visibility = 'hidden';
            onReady(false);
        }
        function show() {
            canvas.style.visibility = foreground.style.visibility = 'visible';
            onReady(true);
        }
        function paintArtwork(target, painter, image, input, scale, maximum = Infinity) {
            const { width, height } = input;
            target.width = Math.max(1, Math.min(maximum, Math.ceil(width * scale)));
            target.height = Math.max(1, Math.min(maximum, Math.ceil(height * scale)));
            painter.scale(target.width / width, target.height / height);
            if (!image) {
                // Match the SVG's objectBoundingBox gradient on tall artwork.
                painter.save();
                painter.scale(width, height);
                const fill = painter.createLinearGradient(0, 0, 1, 1);
                fill.addColorStop(0, input.tint);
                fill.addColorStop(1, input.depth);
                painter.fillStyle = fill;
                painter.fillRect(0, 0, 1, 1);
                painter.restore();
            } else if (input.contained) {
                painter.fillStyle = input.imageBackground;
                painter.fillRect(0, 0, width, height);
            }
            if (image) {
                const fit = (input.contained ? Math.min : Math.max)(width / image.naturalWidth, height / image.naturalHeight);
                const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
                if (input.contained) painter.globalCompositeOperation = 'lighten';
                painter.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
            } else {
                painter.fillStyle = input.initialColor;
                painter.font = `700 100px ${input.fontFamily || 'sans-serif'}`;
                painter.textAlign = 'center';
                painter.fillText(input.label, width / 2, input.initialY ?? 154);
            }
        }
        function paintForeground(path) {
            if (path === paintedPath) return;
            maskContext.clearRect(0, 0, 167, 255);
            maskContext.save();
            try {
                maskContext.scale(.5, .5);
                maskContext.shadowColor = 'white';
                maskContext.shadowBlur = 11;
                maskContext.shadowOffsetX = 500;
                maskContext.translate(-1000, 0);
                maskContext.fillStyle = 'white';
                // Cast only the blurred shadow into this small mask. The sharp
                // source path stays outside it; artwork keeps its Retina pixels.
                maskContext.fill(new global.Path2D(path));
            } finally {
                maskContext.restore();
            }
            const pixels = maskContext.getImageData(0, 0, 167, 255);
            for (let index = 3; index < pixels.data.length; index += 4) {
                pixels.data[index] = 1.025 * pixels.data[index] - .0125 * 255;
            }
            maskContext.putImageData(pixels, 0, 0);
            foregroundContext.clearRect(0, 0, foreground.width, foreground.height);
            foregroundContext.drawImage(foregroundArt, 0, 0);
            foregroundContext.globalCompositeOperation = 'destination-in';
            try {
                foregroundContext.drawImage(mask, 0, 0, foreground.width, foreground.height);
            } finally {
                foregroundContext.globalCompositeOperation = 'source-over';
            }
            paintedPath = path;
        }
        function discardArtwork() {
            artwork?.controller.abort();
            artwork = null;
        }
        function getArtwork(source) {
            if (!source) return Promise.resolve(null);
            if (artwork?.source === source) return artwork.promise;
            discardArtwork();
            const url = new URL(source, global.location.href);
            // Current thumbnails are same-origin and use the normal image cookie
            // credentials. External artwork keeps the existing SVG renderer.
            if (url.origin !== global.location.origin) return Promise.reject(new Error('Uncacheable artwork origin'));
            const controller = new global.AbortController();
            artwork = { source, controller, promise: loadImage(url.href, controller.signal) };
            return artwork.promise;
        }
        async function render(version, input, cacheKey) {
            const controller = new global.AbortController();
            renderAbort = controller;
            const current = () => !disposed && enabled && generation === version;
            let art = null;
            let raster = null;
            try {
                const image = await getArtwork(input.source);
                if (!current()) return;
                const { width, height } = input;
                // The independent halo remains a small, cached raster.
                const scale = Math.min(1, 768 / (width + 2 * padding), 768 / (height + 2 * padding));
                art = document.createElement('canvas');
                const painter = art.getContext('2d');
                if (!painter) throw new Error('Canvas unavailable');
                paintArtwork(art, painter, image, input, scale);
                const embeddedArt = art.toDataURL('image/png');
                art.width = art.height = 1;
                // Standalone SVG images cannot fetch external artwork or use the
                // page's defs. Embed pixels and local refs, then flatten the result
                // once; no SVG or CSS filter remains on the displayed canvas.
                const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 80}" height="${height + 80}" viewBox="-40 -40 ${width + 80} ${height + 80}">
                    <defs>
                        <filter id="feather" filterUnits="userSpaceOnUse" x="0" y="0" width="334" height="510" color-interpolation-filters="sRGB">
                            <feGaussianBlur stdDeviation="11"/><feComponentTransfer><feFuncA type="linear" slope="1.025" intercept="-0.0125"/></feComponentTransfer>
                        </filter>
                        <mask id="edge" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" mask-type="alpha">
                            <g transform="scale(${width / 334} ${height / 510})"><path d="${escape(input.path)}" fill="white" filter="url(#feather)"/></g>
                        </mask>
                        <filter id="glow" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${width + 80}" height="${height + 80}" color-interpolation-filters="sRGB">
                            <feGaussianBlur stdDeviation="14"/><feColorMatrix type="saturate" values="1.45"/>
                            <feComponentTransfer><feFuncA type="linear" slope=".65"/></feComponentTransfer>
                        </filter>
                    </defs>
                    <g filter="url(#glow)"><image width="${width}" height="${height}" href="${escape(embeddedArt)}" mask="url(#edge)"/></g>
                </svg>`;
                raster = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, controller.signal);
                if (!current()) { raster.removeAttribute('src'); return; }
                // Do not replace completed artwork until the new halo is ready:
                // an interrupted resize can still return to the previous cache.
                renderedKey = null;
                paintedPath = null;
                paintArtwork(foregroundArt, artworkContext, image, input,
                    Math.min(input.pixelRatio, 1536 / width, 1536 / height), 1536);
                foreground.width = foregroundArt.width;
                foreground.height = foregroundArt.height;
                paintForeground(latestPath || input.path);
                canvas.width = Math.max(1, Math.ceil((width + 80) * scale));
                canvas.height = Math.max(1, Math.ceil((height + 80) * scale));
                context.drawImage(raster, 0, 0, canvas.width, canvas.height);
                raster.removeAttribute('src');
                renderedKey = cacheKey;
                show();
            } catch (_) {
                // Keep the working SVG effect if image loading/rasterization is
                // unavailable. Never publish pixels from an obsolete request.
                if (current()) hide();
            } finally {
                if (art) art.width = art.height = 1;
                raster?.removeAttribute('src');
                if (renderAbort === controller) renderAbort = null;
            }
        }
        function schedule() {
            if (!enabled || disposed || !snapshot) return;
            if (key === renderedKey) {
                try {
                    paintForeground(latestPath || snapshot.path);
                    show();
                } catch (_) {
                    renderedKey = null;
                    hide();
                }
                return;
            }
            cancel();
            const version = generation;
            // Collapse initial sizing/artwork and bursts of responsive resizes.
            timer = global.setTimeout(() => {
                timer = null;
                render(version, snapshot, key);
            }, 80);
        }
        return {
            update(next) {
                if (disposed) return;
                const normalized = { ...next, width: Math.max(1, Math.round(next.width)), height: Math.max(1, Math.round(next.height)),
                    pixelRatio: Math.min(2, Math.max(.1, Number(global.devicePixelRatio) || 1)) };
                const nextKey = JSON.stringify(normalized);
                if (nextKey === key) return;
                cancel();
                if (snapshot?.source !== normalized.source) discardArtwork();
                snapshot = normalized;
                key = nextKey;
                hide();
                schedule();
            },
            setPath(path) {
                if (disposed || latestPath === path) return;
                latestPath = path;
                if (!enabled || key !== renderedKey || !renderedKey) return;
                try {
                    paintForeground(path);
                } catch (_) {
                    renderedKey = null;
                    hide();
                }
            },
            setEnabled(value) {
                if (disposed || enabled === value) return;
                enabled = value;
                if (enabled) schedule();
                else { cancel(); discardArtwork(); hide(); }
            },
            destroy() {
                if (disposed) return;
                disposed = true;
                cancel();
                discardArtwork();
                canvas.remove();
                foreground.remove();
                for (const buffer of buffers) buffer.width = buffer.height = 1;
            }
        };
    }
    global.ServerTileHalo = { isPreferred, create };
})(window);
