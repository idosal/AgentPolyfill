import {
    allocateImageId, getPngDimensions, renderImage, truncateToWidth,
    type ImageDimensions, type ImageProtocol, type TuiMouseEvent, type TuiMouseEventResult
} from '@earendil-works/pi-tui';

type Grid = { cols: number; rows: number };
type Cell = [string, string, string];
type PointerInput = { kind: 'pointer'; type: 'down' | 'up' | 'move'; fine: { x: number; y: number }; button?: 'left' | 'middle' | 'right' }
    | { kind: 'wheel'; by: number };

function color(hex: string, code: number) {
    return /^#[a-f0-9]{6}$/i.test(hex)
        ? '\x1b[' + code + ';2;' + hex.slice(1).match(/../g)!.map(x => parseInt(x, 16)).join(';') + 'm' : '';
}

/** Map terminal-local input back to the grid of the last frame actually drawn. */
export class AppSurface {
    private cells = ['Opening MCP App…'];
    private picture?: { png: string; dimensions: ImageDimensions };
    private frame?: Grid;
    private drawn?: { box: Grid; scaleX: number; scaleY: number };
    private imageLines?: { width: number; height: number; lines: string[] };
    private held?: 'left' | 'middle' | 'right';
    private readonly imageId?: number;
    private readonly protocol: ImageProtocol | null;
    private readonly send: (event: PointerInput) => void;
    constructor(protocol: ImageProtocol | null, send: (event: PointerInput) => void) {
        this.protocol = protocol;
        this.send = send;
        if (protocol === 'kitty') this.imageId = allocateImageId();
    }
    setImage(png: string, grid: Grid) {
        const dimensions = getPngDimensions(png);
        if (!dimensions) return;
        this.picture = { png, dimensions };
        this.frame = grid;
        this.invalidate();
    }
    setCells(frame: Cell[][], cols: number) {
        this.cells = frame.map(line => line.map(([text, fg, bg]) =>
            color(fg, 38) + color(bg, 48) + text.replace(/[\x00-\x1f\x7f-\x9f]/g, '') + '\x1b[0m').join(''));
        this.frame = { cols, rows: frame.length };
    }
    invalidate() { this.imageLines = undefined; }

    render(width: number, height: number): string[] {
        if (this.picture && this.protocol && this.frame) {
            if (this.imageLines?.width === width && this.imageLines.height === height) return this.imageLines.lines;
            const image = renderImage(this.picture.png, this.picture.dimensions, {
                maxWidthCells: Math.max(1, width - 2), maxHeightCells: height, moveCursor: false, imageId: this.imageId
            });
            if (image) {
                this.drawn = { box: { cols: image.columns, rows: image.rows },
                    scaleX: this.frame.cols / image.columns, scaleY: this.frame.rows / image.rows };
                // Pi reserves every image row. iTerm2 draws from the last reserved row.
                const lines: string[] = Array(image.rows).fill('');
                if (this.protocol === 'iterm2') {
                    const up = image.rows > 1 ? '\x1b[' + (image.rows - 1) + 'A' : '';
                    lines[image.rows - 1] = up + image.sequence;
                } else lines[0] = image.sequence;
                this.imageLines = { width, height, lines };
                return lines;
            }
        }
        // Character cells are clipped, never scaled.
        this.drawn = this.frame && { box: { cols: Math.min(width, this.frame.cols), rows: Math.min(height, this.frame.rows) },
            scaleX: 1, scaleY: 1 };
        return this.cells.slice(0, height).map(line => truncateToWidth(line, width));
    }
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (!this.drawn) return;
        const { box, scaleX, scaleY } = this.drawn;
        const inside = event.x >= 0 && event.x < box.cols && event.y >= 0 && event.y < box.rows;
        if (!inside && !(this.held && (event.type === 'drag' || event.type === 'release'))) return;
        const fine = {
            x: (event.x + 0.5) * scaleX,
            y: (event.y + 0.5) * scaleY
        };
        const move = () => this.send({ kind: 'pointer', type: 'move', fine, button: this.held });
        switch (event.type) {
            case 'press':
                if (event.button === 'none' || this.held) return;
                this.held = event.button;
                this.send({ kind: 'pointer', type: 'down', fine, button: this.held });
                return { capture: true, render: false };
            case 'release':
                if (!this.held) return;
                this.send({ kind: 'pointer', type: 'up', fine, button: this.held });
                this.held = undefined;
                break;
            case 'move': case 'drag':
                move();
                break;
            case 'wheel':
                move();
                if (event.wheelDelta) this.send({ kind: 'wheel', by: Math.sign(event.wheelDelta) });
                break;
            case 'click':
                // The browser synthesizes its click from the preceding press and release.
                break;
        }
        return { handled: true, render: false };
    }
}
