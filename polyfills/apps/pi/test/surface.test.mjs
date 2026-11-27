import assert from 'node:assert/strict';
import test from 'node:test';
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { AppSurface } from '../surface.ts';

const event = (type, x, y, button = 'left') => ({ type, x, y, button });

test('maps mouse input against the image placement last drawn in the terminal', t => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, images: 'kitty' });
    t.after(() => setCapabilities(capabilities));
    const events = [];
    const surface = new AppSurface('kitty', e => events.push(e));
    // getPngDimensions reads the IHDR, the terminal performs the actual decoding.
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(720, 16);
    png.writeUInt32BE(300, 20);
    surface.setImage(png.toString('base64'), { cols: 90, rows: 20 });
    const lines = surface.render(44, 12);
    const cols = Number(/,c=(\d+)/.exec(lines[0])[1]);
    const rows = lines.length;
    // An incoming frame changes the transform only after Pi draws it.
    surface.setImage(png.toString('base64'), { cols: 180, rows: 40 });
    assert.equal(surface.handleMouse(event('press', 0, rows)), undefined);
    assert.equal(surface.handleMouse(event('press', 1, 2)).capture, true);
    assert.deepEqual(events[0], { kind: 'pointer', type: 'down', button: 'left',
        fine: { x: 1.5 * (90 / cols), y: 2.5 * (20 / rows) } });
    surface.handleMouse(event('drag', -1, rows));
    surface.handleMouse(event('release', -1, rows));
    surface.handleMouse(event('click', 1, 2));
    assert.deepEqual(events.map(e => e.type), ['down', 'move', 'up']);
    assert.equal(surface.handleMouse(event('drag', -1, rows)), undefined);
});

test('routes a wheel at its cell and leaves the clipped area and footer to Pi', () => {
    const events = [];
    const surface = new AppSurface(null, e => events.push(e));
    surface.setCells(Array.from({length:4}, () => [['x', '', '']]), 7);
    surface.render(5, 2);
    assert.equal(surface.handleMouse(event('press', 5, 1)), undefined);
    assert.equal(surface.handleMouse(event('wheel', 0, 2)), undefined);
    surface.handleMouse({ ...event('wheel', 4, 1, 'none'), wheelDelta: -3 });
    assert.deepEqual(events, [
        { kind: 'pointer', type: 'move', button: undefined, fine: {x:4.5, y:1.5} },
        { kind: 'wheel', by: -1 },
    ]);
});

test('cell rows preserve default colours and clip wide text by terminal columns', () => {
    const surface = new AppSurface(null, () => {});
    surface.setCells([[['A', '#ff0000', '#000000'], ['B', '#ff0000', ''], ['界', '', '']]], 4);
    const [full] = surface.render(4, 1);
    assert.equal(stripTerminalSequences(full), 'AB界');
    assert.match(full, /49mB/);
    assert.match(full, /39m界/);
    assert.equal((full.match(/38;2/g) ?? []).length, 1);
    assert.ok(visibleWidth(surface.render(3, 1)[0]) <= 3);
});
