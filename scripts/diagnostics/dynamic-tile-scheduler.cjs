#!/usr/bin/env node
'use strict';

// Reuse the DOM/observer/rAF test harness without registering its tests. The
// production aura and contour sources are loaded unchanged by that harness.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const repository = path.resolve(__dirname, '../..');
const testFile = path.join(repository, 'test/frontendServerTileAura.test.js');
const testSource = fs.readFileSync(testFile, 'utf8');
const delimiter = "\ntest('aura updates the actual contour while artwork and tile geometry stay fixed',";
const boundary = testSource.indexOf(delimiter);
if (boundary < 0 || !testSource.slice(0, boundary).includes('function harness(')) {
    throw new Error('Aura test harness structure changed; update the diagnostic extraction boundary.');
}
const harnessModule = { exports: {} };
new Function('require', 'module', `${testSource.slice(0, boundary)}\nmodule.exports = harness;`)(
    createRequire(testFile), harnessModule
);
const harness = harnessModule.exports;

const warmupMs = 2000;
const measurementMs = 10000;
const timestampJitterMs = 0.6;

function measure(displayRate, jittered, tileCount, activeCount) {
    const h = harness();
    const tiles = Array.from({ length: tileCount }, (_, index) => h.create({
        rect: { left: index * 450, top: 0, width: 334, height: 510 }
    }));
    for (const tile of tiles) h.intersect(tile.visual, true);
    // Hold only tile zero near its right edge. Other tiles remain out of range.
    if (activeCount) h.pointer(314, 255);
    h.frame(0);
    for (const tile of tiles) tile.path.writes.length = 0;

    const counts = tiles.map(() => 0);
    let seed = 123456789;
    function random() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    }
    const finalFrame = displayRate * (warmupMs + measurementMs) / 1000 + 1;
    for (let frame = 1; frame <= finalFrame; frame++) {
        const now = frame * 1000 / displayRate +
            (jittered ? (random() * 2 - 1) * timestampJitterMs : 0);
        h.frame(now);
        tiles.forEach((tile, index) => {
            if (now > warmupMs && now <= warmupMs + measurementMs) {
                counts[index] += tile.path.writes.length;
            }
            // Discard diagnostic traces to avoid retaining generated path strings.
            tile.path.writes.length = 0;
            tile.contour.pathTimes.length = 0;
            tile.contour.advances.length = 0;
        });
    }
    tiles.forEach((tile, index) => {
        if (tile.contour.model.isInteracting() !== (activeCount === 1 && index === 0)) {
            throw new Error(`Unexpected interaction state for tile ${index}.`);
        }
    });
    return counts;
}

console.log('Synthetic scheduler diagnostic: no browser, painting, filters, or GPU work.');
console.log('Current production code; 2s warmup + 10s measurement per scenario.');
console.log('Jitter: seeded +/-0.6ms timestamps. Active tile is first in each list.');
console.log('rAF Hz | timestamps | tiles | active | path writes in 10s | updates/s per tile');
for (const displayRate of [60, 120]) {
    for (const jittered of [false, true]) {
        for (const activeCount of [0, 1]) {
            for (const tileCount of [2, 3, 4]) {
                const counts = measure(displayRate, jittered, tileCount, activeCount);
                const rates = counts.map(count => (count * 1000 / measurementMs).toFixed(1));
                console.log([
                    String(displayRate).padStart(6),
                    (jittered ? 'jittered' : 'exact').padEnd(10),
                    String(tileCount).padStart(5),
                    String(activeCount).padStart(6),
                    counts.join(', ').padEnd(18),
                    rates.join(', ')
                ].join(' | '));
            }
        }
    }
}
