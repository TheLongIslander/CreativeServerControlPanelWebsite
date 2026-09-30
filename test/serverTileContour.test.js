const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const contour = require('../public/serverTileContour');

function random(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

function curves(path) {
    const values = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    let start = { x: values[0], y: values[1] };
    const result = [];
    for (let index = 2; index < values.length; index += 6) {
        const first = { x: values[index], y: values[index + 1] };
        const second = { x: values[index + 2], y: values[index + 3] };
        const end = { x: values[index + 4], y: values[index + 5] };
        result.push([start, first, second, end]);
        start = end;
    }
    return result;
}

test('contours are independently seeded, stable at a given time, and exposed in browsers', () => {
    const first = contour.create(random(7));
    const same = contour.create(random(7));
    const other = contour.create(random(8));
    assert.equal(first.path(5), same.path(5));
    assert.equal(first.path(5), first.path(5));
    assert.notEqual(first.path(5), other.path(5));
    const window = {};
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/serverTileContour'), 'utf8'), { window });
    assert.equal(typeof window.ServerTileContour.create, 'function');
});

test('every side evolves locally instead of scaling or moving as one shape', () => {
    const shape = contour.create(random(93));
    const frames = [0, 2, 5, 9, 15, 24].map(time => shape.sample(time));
    const sides = [
        { axis: 'y', matches: point => point.y < 65 && point.x > 90 && point.x < 245 },
        { axis: 'x', matches: point => point.x > 270 && point.y > 100 && point.y < 410 },
        { axis: 'y', matches: point => point.y > 445 && point.x > 90 && point.x < 245 },
        { axis: 'x', matches: point => point.x < 65 && point.y > 100 && point.y < 410 }
    ];
    for (const { axis, matches } of sides) {
        const indices = frames[0].flatMap((point, index) => matches(point) ? [index] : []);
        assert.ok(indices.length >= 5);
        for (const index of indices) {
            const positions = frames.map(frame => frame[index][axis]);
            assert.ok(Math.max(...positions) - Math.min(...positions) > 1, 'every sampled region still changes with the gentler contour');
        }
        const motion = indices.map(index => frames[2][index][axis] - frames[0][index][axis]);
        // Broad waves can move a short edge in one direction while its contour
        // still changes; requiring opposing motion here would force small ripples.
        assert.ok(Math.max(...motion) - Math.min(...motion) > 1,
            'regions on the same side evolve by different amounts');
    }
});

test('swells migrate along an edge instead of staying anchored to a breathing silhouette', () => {
    const shape = contour.create(random(221));
    const frames = [0, 3, 6, 9, 12, 15].map(time => shape.sample(time));
    const edge = frames[0].flatMap((point, index) => point.x > 270 && point.y > 90 && point.y < 420 ? [index] : []);
    const peakLocations = frames.map(frame => edge.reduce((best, index) => frame[index].x > frame[best].x ? index : best, edge[0]));
    assert.ok(new Set(peakLocations).size >= 4, 'the strongest swell moves to different parts of the edge');
});

test('contours have no collective expansion and keep bounded local displacement', () => {
    const shape = contour.create(random(71));
    for (let time = 0; time < 120; time += 2.7) {
        // Signed distance to the unperturbed rounded rectangle measures how far
        // each sample moved along its normal, independently of the wave formula.
        const distances = shape.sample(time).map(point => {
            const x = Math.abs(point.x - 167) - 85;
            const y = Math.abs(point.y - 255) - 173;
            return Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - 36;
        });
        assert.ok(distances.every(distance => Math.abs(distance) <= 6));
        for (let index = 0; index < distances.length; index++) {
            const previous = distances[(index + distances.length - 1) % distances.length];
            const next = distances[(index + 1) % distances.length];
            assert.ok(Math.abs(next - distances[index]) < 1.8, 'neighboring offsets change gradually');
            assert.ok(Math.abs(previous - 2 * distances[index] + next) < .5, 'the contour cannot form short, sharp notches');
        }
        const mean = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
        assert.ok(Math.abs(mean) < 1e-12, 'local swells never add a common outward/inward motion');
    }
});

test('closed curves stay within the feather margin and keep a smooth closing seam', () => {
    for (let seed = 1; seed <= 12; seed++) {
        const shape = contour.create(random(seed));
        for (let time = 0; time < 120; time += 7.3) {
            const path = shape.path(time);
            assert.match(path, /^M .* Z$/);
            assert.ok(!/NaN|Infinity/.test(path));
            const segments = curves(path);
            assert.equal(segments.length, 80);
            assert.deepEqual(segments.at(-1)[3], segments[0][0]);
            for (const axis of ['x', 'y']) {
                const incoming = segments[0][0][axis] - segments.at(-1)[2][axis];
                const outgoing = segments[0][1][axis] - segments[0][0][axis];
                assert.ok(Math.abs(incoming - outgoing) < .002, 'closing tangents match');
            }
            for (const segment of segments) {
                for (let step = 0; step <= 8; step++) {
                    const t = step / 8;
                    const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
                    const x = segment.reduce((sum, point, index) => sum + point.x * weights[index], 0);
                    const y = segment.reduce((sum, point, index) => sum + point.y * weights[index], 0);
                    assert.ok(x >= 27 && x <= 334 - 27 && y >= 27 && y <= 510 - 27, 'clear margin prevents clipped blur tails');
                }
            }
        }
    }
});

function advance(shape, duration, step = 1 / 120) {
    for (let elapsed = 0; elapsed < duration - 1e-9; elapsed += step) shape.advance(Math.min(step, duration - elapsed));
}

function interaction(shape, reference, time = 0) {
    const original = reference.sample(time);
    return shape.sample(time).map((point, index) => ({
        x: point.x - original[index].x,
        y: point.y - original[index].y,
        magnitude: Math.hypot(point.x - original[index].x, point.y - original[index].y)
    }));
}

test('a nearby pointer pulls one broad region toward it without moving the opposite edge', () => {
    for (const [x, y, axis, direction, opposite] of [
        [334, 255, 'x', 1, point => point.x < 70],
        [0, 255, 'x', -1, point => point.x > 265],
        [167, 0, 'y', -1, point => point.y > 445],
        [167, 510, 'y', 1, point => point.y < 65]
    ]) {
        const shape = contour.create(random(19));
        const reference = contour.create(random(19));
        assert.equal(shape.setPointer(x, y), true);
        assert.equal(shape.isInteracting(), true);
        assert.equal(shape.path(0), reference.path(0), 'pointer input only sets targets; physics advances on frames');
        advance(shape, .8);
        const offsets = interaction(shape, reference);
        const strongest = offsets.reduce((best, offset, index) => offset.magnitude > offsets[best].magnitude ? index : best, 0);
        assert.ok(offsets[strongest][axis] * direction > 14, 'the stretch follows the pointer normal');
        assert.ok(offsets.filter(offset => offset.magnitude > 4).length >= 9, 'the pull remains broad and smooth');
        for (const [index, point] of reference.sample(0).entries()) {
            if (opposite(point)) assert.ok(offsets[index].magnitude < .02, 'no collective tile expansion');
        }
    }
});

test('the pull follows along an edge and also responds to a pointer inside it', () => {
    const shape = contour.create(random(9));
    const reference = contour.create(random(9));
    shape.setPointer(326, 150);
    advance(shape, .7);
    const peakY = () => {
        const offsets = interaction(shape, reference);
        const index = offsets.reduce((best, offset, index) => offset.x > offsets[best].x ? index : best, 0);
        return reference.sample(0)[index].y;
    };
    assert.ok(Math.abs(peakY() - 150) < 20);
    shape.setPointer(326, 350);
    advance(shape, .7);
    assert.ok(Math.abs(peakY() - 350) < 20, 'the peak follows the pointer rather than staying anchored');
    shape.setPointer(250, 255);
    advance(shape, .7);
    assert.ok(Math.min(...interaction(shape, reference).map(offset => offset.x)) < -13, 'inside proximity pulls inward');
});

test('tracking is continuous across rounded corners and the closed contour seam', () => {
    const reference = contour.create(random(31));
    let previous = null;
    // Includes the top-right arc and both line/arc junctions.
    for (let degrees = -94; degrees <= 4; degrees += 2) {
        const angle = degrees * Math.PI / 180;
        const shape = contour.create(random(31));
        shape.setPointer(252 + 76 * Math.cos(angle), 82 + 76 * Math.sin(angle));
        advance(shape, .65);
        const current = interaction(shape, reference);
        if (previous) {
            assert.ok(current.every((offset, index) => Math.hypot(offset.x - previous[index].x, offset.y - previous[index].y) < .6),
                'crossing a point or corner boundary never makes the swell jump');
        }
        previous = current;
    }
    const left = contour.create(random(31));
    const right = contour.create(random(31));
    left.setPointer(81.5, 0);
    right.setPointer(82.5, 0);
    advance(left, .65);
    advance(right, .65);
    const before = left.sample(0);
    assert.ok(right.sample(0).every((point, index) => Math.hypot(point.x - before[index].x, point.y - before[index].y) < .3),
        'the closed seam has the same continuous response');
});

test('release sends a ripple along the edge, recoils, and settles exactly to the idle contour', () => {
    const shape = contour.create(random(33));
    const reference = contour.create(random(33));
    shape.setPointer(350, 255);
    advance(shape, .8);
    const stretched = interaction(shape, reference);
    const peak = stretched.reduce((best, offset, index) => offset.x > stretched[best].x ? index : best, 0);
    assert.ok(stretched[peak].x > 15, 'stretch is still stored at the outer capture boundary');
    assert.equal(shape.setPointer(355, 255), false, 'moving too far releases the edge');
    assert.equal(shape.isInteracting(), true, 'release keeps the ripple animation alive');
    advance(shape, .35);
    const traveling = interaction(shape, reference);
    assert.ok(traveling[peak - 10].x > stretched[peak - 10].x + .7, 'energy travels away from the original pull');
    assert.ok(Math.abs(traveling[peak].x) < stretched[peak].x / 3, 'the original peak relaxes while its neighbors ripple');
    advance(shape, .25);
    assert.ok(interaction(shape, reference)[peak].x < -2, 'the released edge rebounds past its resting position');
    advance(shape, 5);
    assert.equal(shape.isInteracting(), false);
    assert.equal(shape.path(12), reference.path(12), 'settling restores the existing idle waves exactly');
});

test('elastic physics stays bounded under quick pointer changes and uneven frame timing', () => {
    const shape = contour.create(random(44));
    const reference = contour.create(random(44));
    const pointerRandom = random(145);
    for (let frame = 0; frame < 800; frame++) {
        const angle = pointerRandom() * Math.PI * 2;
        shape.setPointer(167 + 165 * Math.cos(angle), 255 + 250 * Math.sin(angle));
        shape.advance(frame % 53 === 0 ? 10 : [1 / 144, 1 / 60, 1 / 30][frame % 3]);
        const offsets = interaction(shape, reference);
        assert.ok(offsets.every(offset => Number.isFinite(offset.magnitude) && offset.magnitude <= 18.000001));
        for (const point of shape.sample(0)) {
            assert.ok(point.x > 21 && point.x < 313 && point.y > 21 && point.y < 489, 'stretch leaves a feather margin');
        }
    }
    const fast = contour.create(random(44));
    const slow = contour.create(random(44));
    fast.setPointer(334, 200);
    slow.setPointer(334, 200);
    advance(fast, .7, 1 / 120);
    advance(slow, .7, 1 / 30);
    fast.releasePointer();
    slow.releasePointer();
    advance(fast, .9, 1 / 120);
    advance(slow, .9, 1 / 30);
    const fastPoints = fast.sample(0);
    assert.ok(slow.sample(0).every((point, index) => Math.hypot(point.x - fastPoints[index].x, point.y - fastPoints[index].y) < .001),
        'substeps preserve the same physical motion at different display rates');
});

test('reset clears held and released motion, while invalid input never corrupts the path', () => {
    const shape = contour.create(random(51));
    const reference = contour.create(random(51));
    assert.equal(shape.setPointer(167, 255), false, 'the tile center is outside the capture band');
    assert.equal(shape.isInteracting(), false);
    shape.setPointer(0, 200);
    advance(shape, .5);
    assert.notEqual(shape.path(0), reference.path(0));
    assert.equal(shape.setPointer(NaN, 30), false);
    shape.advance(NaN);
    shape.advance(Infinity);
    shape.advance(-1);
    assert.ok(!/NaN|Infinity/.test(shape.path(0)));
    shape.resetInteraction();
    assert.equal(shape.isInteracting(), false);
    shape.advance(.1);
    assert.equal(shape.path(4), reference.path(4));
    shape.setPointer(334, 300);
    advance(shape, .4);
    shape.releasePointer();
    assert.equal(shape.isInteracting(), true);
    shape.resetInteraction();
    assert.equal(shape.path(4), reference.path(4));
});
