// Runs in the trusted Chromium page. Decode a bounded, in-memory bitmap and
// strip ancillary metadata. Pi receives the same static image the person reviews.
export async function reviewImage({data, mimeType}) {
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType) ||
        typeof data !== 'string' || data.length > 4_000_000) throw Error('Unsupported or oversized app image.');
    const binary = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([binary], {type:mimeType}));
    try {
        const scale = Math.min(1, 768 / Math.max(bitmap.width,bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.round(bitmap.width * scale));
        canvas.height = Math.max(1,Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
        const png = canvas.toDataURL('image/png').split(',')[1];
        const cols = Math.min(64, Math.max(1,Math.round(32 * canvas.width / canvas.height)));
        const rows = Math.min(16, Math.max(1,Math.round(cols * canvas.height / canvas.width / 2)));
        canvas.width = cols;
        canvas.height = rows;
        ctx.fillStyle = '#333';
        ctx.fillRect(0,0,cols,rows);
        ctx.drawImage(bitmap,0,0,cols,rows);
        const pixels = ctx.getImageData(0,0,cols,rows).data;
        const cells = Array.from({length:rows}, (_, y) => Array.from({length:cols}, (_, x) => {
            const i = 4 * (y * cols + x);
            const rgb = '#' + Array.from(pixels.slice(i,i+3), n => n.toString(16).padStart(2,'0')).join('');
            return [' ',rgb,rgb];
        }));
        return {type:'image', mimeType:'image/png', data:png, cells};
    } finally { bitmap.close(); }
}
