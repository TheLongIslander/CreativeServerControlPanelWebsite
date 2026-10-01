(function serverTileContour(global, factory) {
    'use strict';
    const contour = factory();
    if (typeof module === 'object' && module.exports) module.exports = contour;
    else global.ServerTileContour = contour;
})(typeof window !== 'undefined' ? window : globalThis, function contourFactory() {
    'use strict';
    const width = 334;
    const height = 510;
    const inset = 46;
    const radius = 36;
    const pointCount = 80;
    const turn = Math.PI * 2;
    const horizontal = width - 2 * (inset + radius);
    const vertical = height - 2 * (inset + radius);
    const corner = Math.PI * radius / 2;
    const perimeter = 2 * (horizontal + vertical) + 4 * corner;

    function edgePoint(distance) {
        const lengths = [horizontal, corner, vertical, corner, horizontal, corner, vertical, corner];
        let segment = 0;
        while (segment < lengths.length - 1 && distance >= lengths[segment]) distance -= lengths[segment++];
        if (segment === 0) return { x: inset + radius + distance, y: inset, nx: 0, ny: -1 };
        if (segment === 2) return { x: width - inset, y: inset + radius + distance, nx: 1, ny: 0 };
        if (segment === 4) return { x: width - inset - radius - distance, y: height - inset, nx: 0, ny: 1 };
        if (segment === 6) return { x: inset, y: height - inset - radius - distance, nx: -1, ny: 0 };
        const index = (segment - 1) / 2;
        const angle = -Math.PI / 2 + index * Math.PI / 2 + distance / radius;
        const centerX = index < 2 ? width - inset - radius : inset + radius;
        const centerY = index === 0 || index === 3 ? inset + radius : height - inset - radius;
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        return { x: centerX + radius * nx, y: centerY + radius * ny, nx, ny };
    }

    const baseline = Array.from({ length: pointCount }, (_, index) => edgePoint(index * perimeter / pointCount));

    function nearestEdge(x, y) {
        let nearest = null;
        function consider(distance) {
            const point = edgePoint(distance);
            const separation = Math.hypot(x - point.x, y - point.y);
            if (!nearest || separation < nearest.separation) {
                nearest = { distance, separation, offset: (x - point.x) * point.nx + (y - point.y) * point.ny };
            }
        }
        const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
        consider(clamp(x - inset - radius, horizontal));
        consider(horizontal + corner + clamp(y - inset - radius, vertical));
        consider(horizontal + 2 * corner + vertical + clamp(width - inset - radius - x, horizontal));
        consider(2 * horizontal + 3 * corner + vertical + clamp(height - inset - radius - y, vertical));
        for (let index = 0; index < 4; index++) {
            const centerX = index < 2 ? width - inset - radius : inset + radius;
            const centerY = index === 0 || index === 3 ? inset + radius : height - inset - radius;
            const startAngle = -Math.PI / 2 + index * Math.PI / 2;
            const angle = Math.atan2(y - centerY, x - centerX);
            // Unwrap around this corner's midpoint before clamping to its arc.
            const relative = Math.atan2(Math.sin(angle - startAngle - Math.PI / 4), Math.cos(angle - startAngle - Math.PI / 4)) + Math.PI / 4;
            const start = index === 0 ? horizontal : index === 1 ? horizontal + corner + vertical :
                index === 2 ? 2 * horizontal + 2 * corner + vertical : 2 * horizontal + 3 * corner + 2 * vertical;
            consider(start + clamp(relative, Math.PI / 2) * radius);
        }
        return nearest;
    }

    function create(random = Math.random) {
        // Long, shallow waves keep the outline calm. Counter-moving phases still
        // change its shape locally, without small ripples or a shared breathing motion.
        const weights = [3, 2, 1];
        const waves = [2, 3, 4].map((mode, index) => ({
            mode,
            weight: weights[index] * (.8 + random() * .4),
            phase: random() * turn,
            speed: (.18 + random() * .18) * (index % 2 ? -1 : 1),
            envelopePhase: random() * turn,
            envelopeSpeed: .05 + random() * .09
        }));
        const weightSum = waves.reduce((sum, wave) => sum + wave.weight, 0);
        for (const wave of waves) wave.amplitude = 6 * wave.weight / weightSum;

        const displacement = new Float64Array(pointCount);
        const velocity = new Float64Array(pointCount);
        const target = new Float64Array(pointCount);
        const acceleration = new Float64Array(pointCount);
        const spacing = perimeter / pointCount;
        const tension = (280 / spacing) ** 2;
        let held = false;
        let moving = false;

        function setPointer(x, y) {
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                releasePointer();
                return false;
            }
            const nearest = nearestEdge(x, y);
            if (nearest.separation > 65) {
                releasePointer();
                return false;
            }
            held = true;
            // A broad pull slides continuously around the perimeter, including
            // the rounded corners. Saturation leaves room for the feather blur.
            const pull = 18 * Math.tanh(nearest.offset / 24);
            for (let index = 0; index < pointCount; index++) {
                const difference = Math.abs(index * spacing - nearest.distance);
                const distance = Math.min(difference, perimeter - difference);
                target[index] = pull * Math.exp(-.5 * (distance / 65) ** 2);
            }
            return true;
        }

        function releasePointer() {
            held = false;
        }

        function resetInteraction() {
            held = false;
            moving = false;
            displacement.fill(0);
            velocity.fill(0);
            target.fill(0);
        }

        function advance(deltaSeconds) {
            if ((!held && !moving) || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
            // Short, bounded substeps keep a dropped frame from injecting energy.
            const duration = Math.min(deltaSeconds, .1);
            const steps = Math.ceil(duration * 120);
            const dt = duration / steps;
            const spring = held ? 180 : 18;
            const damping = held ? 24 : 3.8;
            for (let step = 0; step < steps; step++) {
                for (let index = 0; index < pointCount; index++) {
                    const previous = displacement[(index + pointCount - 1) % pointCount];
                    const next = displacement[(index + 1) % pointCount];
                    acceleration[index] = tension * (previous - 2 * displacement[index] + next) +
                        spring * ((held ? target[index] : 0) - displacement[index]) - damping * velocity[index];
                }
                for (let index = 0; index < pointCount; index++) {
                    velocity[index] += acceleration[index] * dt;
                    displacement[index] += velocity[index] * dt;
                    if (Math.abs(displacement[index]) > 18) {
                        displacement[index] = Math.sign(displacement[index]) * 18;
                        if (velocity[index] * displacement[index] > 0) velocity[index] = 0;
                    }
                }
            }
            moving = displacement.some(value => Math.abs(value) > .025) || velocity.some(value => Math.abs(value) > .08);
            if (!held && !moving) resetInteraction();
        }

        function sample(timeSeconds) {
            const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
            const current = waves.map(wave => ({
                mode: wave.mode,
                phase: wave.phase + wave.speed * time,
                amplitude: wave.amplitude * (.78 + .22 * Math.sin(wave.envelopePhase + wave.envelopeSpeed * time))
            }));
            const offsets = baseline.map((_, index) => current.reduce((sum, wave) =>
                sum + wave.amplitude * Math.sin(turn * wave.mode * index / pointCount + wave.phase), 0));
            // Integer spatial modes already have zero mean. Remove rounding
            // residue explicitly so there is no shared expansion/contraction.
            const mean = offsets.reduce((sum, offset) => sum + offset, 0) / pointCount;
            return baseline.map((point, index) => ({
                x: point.x + point.nx * (offsets[index] - mean + displacement[index]),
                y: point.y + point.ny * (offsets[index] - mean + displacement[index])
            }));
        }

        function path(timeSeconds) {
            const points = sample(timeSeconds);
            const coordinates = point => `${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
            let data = `M ${coordinates(points[0])}`;
            // A cyclic Catmull–Rom spline preserves the same tangent on both
            // sides of the closing seam and rounds every local change in shape.
            for (let index = 0; index < pointCount; index++) {
                const previous = points[(index + pointCount - 1) % pointCount];
                const start = points[index];
                const end = points[(index + 1) % pointCount];
                const next = points[(index + 2) % pointCount];
                const first = { x: start.x + (end.x - previous.x) / 6, y: start.y + (end.y - previous.y) / 6 };
                const second = { x: end.x - (next.x - start.x) / 6, y: end.y - (next.y - start.y) / 6 };
                data += ` C ${coordinates(first)} ${coordinates(second)} ${coordinates(end)}`;
            }
            return `${data} Z`;
        }

        return { sample, path, setPointer, releasePointer, resetInteraction, advance, isInteracting: () => held || moving };
    }

    return { create, bounds: Object.freeze({ width, height, inset }) };
});
