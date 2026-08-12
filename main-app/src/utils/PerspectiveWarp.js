/**
 * PerspectiveWarp.js
 * 
 * Pure JavaScript perspective correction engine.
 * Computes a 3x3 homography matrix from 4 point correspondences and applies
 * inverse-mapping with bilinear interpolation to produce a corrected image.
 * 
 * No external dependencies.
 */

/**
 * Solve an NxN linear system Ax = b using Gaussian elimination with partial pivoting.
 * Modifies A and b in place. Returns the solution vector x.
 * 
 * @param {number[][]} A - NxN coefficient matrix
 * @param {number[]} b - N-element right-hand side vector
 * @returns {number[]} Solution vector x
 */
function solveLinearSystem(A, b) {
    const n = A.length;

    // Forward elimination with partial pivoting
    for (let col = 0; col < n; col++) {
        // Find pivot
        let maxVal = Math.abs(A[col][col]);
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(A[row][col]) > maxVal) {
                maxVal = Math.abs(A[row][col]);
                maxRow = row;
            }
        }

        // Swap rows in A and b
        if (maxRow !== col) {
            [A[col], A[maxRow]] = [A[maxRow], A[col]];
            [b[col], b[maxRow]] = [b[maxRow], b[col]];
        }

        // Eliminate below
        for (let row = col + 1; row < n; row++) {
            const factor = A[row][col] / A[col][col];
            for (let j = col; j < n; j++) {
                A[row][j] -= factor * A[col][j];
            }
            b[row] -= factor * b[col];
        }
    }

    // Back substitution
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = b[i];
        for (let j = i + 1; j < n; j++) {
            x[i] -= A[i][j] * x[j];
        }
        x[i] /= A[i][i];
    }

    return x;
}

/**
 * Compute the 3x3 homography matrix that maps srcPoints to dstPoints.
 * 
 * The homography H maps a source point (x, y) to destination (x', y'):
 *   w * x' = H[0]*x + H[1]*y + H[2]
 *   w * y' = H[3]*x + H[4]*y + H[5]
 *       w  = H[6]*x + H[7]*y + 1
 * 
 * @param {Array<{x: number, y: number}>} srcPoints - 4 source corner points [TL, TR, BR, BL]
 * @param {Array<{x: number, y: number}>} dstPoints - 4 destination corner points [TL, TR, BR, BL]
 * @returns {Float64Array} 9-element array representing the 3x3 homography matrix (row-major)
 */
export function computeHomography(srcPoints, dstPoints) {
    // Build 8x8 system: Ah = b
    // For each point pair (x,y) -> (x',y'):
    //   x' = (h0*x + h1*y + h2) / (h6*x + h7*y + 1)
    //   y' = (h3*x + h4*y + h5) / (h6*x + h7*y + 1)
    // Rearranging:
    //   h0*x + h1*y + h2 - h6*x*x' - h7*y*x' = x'
    //   h3*x + h4*y + h5 - h6*x*y' - h7*y*y' = y'

    const A = [];
    const b = [];

    for (let i = 0; i < 4; i++) {
        const sx = srcPoints[i].x;
        const sy = srcPoints[i].y;
        const dx = dstPoints[i].x;
        const dy = dstPoints[i].y;

        A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
        b.push(dx);

        A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
        b.push(dy);
    }

    const h = solveLinearSystem(A, b);

    // Return as 3x3 matrix in row-major order: [h0..h7, 1]
    return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0]);
}

/**
 * Apply bilinear interpolation to sample a pixel from source image data.
 * 
 * @param {Uint8ClampedArray} srcData - Source image pixel data (RGBA)
 * @param {number} srcW - Source image width
 * @param {number} srcH - Source image height
 * @param {number} x - Sub-pixel x coordinate in source
 * @param {number} y - Sub-pixel y coordinate in source
 * @returns {number[]} [R, G, B, A] interpolated pixel values
 */
function bilinearSample(srcData, srcW, srcH, x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, srcW - 1);
    const y1 = Math.min(y0 + 1, srcH - 1);

    const dx = x - x0;
    const dy = y - y0;

    const w00 = (1 - dx) * (1 - dy);
    const w10 = dx * (1 - dy);
    const w01 = (1 - dx) * dy;
    const w11 = dx * dy;

    const i00 = (y0 * srcW + x0) * 4;
    const i10 = (y0 * srcW + x1) * 4;
    const i01 = (y1 * srcW + x0) * 4;
    const i11 = (y1 * srcW + x1) * 4;

    return [
        srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11,
        srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11,
        srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11,
        srcData[i00 + 3] * w00 + srcData[i10 + 3] * w10 + srcData[i01 + 3] * w01 + srcData[i11 + 3] * w11,
    ];
}

/**
 * Warp a source canvas using the given 4 corner points to produce a
 * perspective-corrected rectangular output.
 * 
 * @param {HTMLCanvasElement|HTMLImageElement} source - The source image or canvas
 * @param {Array<{x: number, y: number}>} corners - 4 corner points on the source [TL, TR, BR, BL]
 * @param {number} [outputWidth] - Output width (auto-calculated if omitted)
 * @param {number} [outputHeight] - Output height (auto-calculated if omitted)
 * @returns {HTMLCanvasElement} A new canvas containing the warped image
 */
export function warpPerspective(source, corners, outputWidth, outputHeight) {
    // Draw source onto a canvas to get pixel data
    const srcCanvas = document.createElement('canvas');
    const srcCtx = srcCanvas.getContext('2d');

    if (source instanceof HTMLCanvasElement) {
        srcCanvas.width = source.width;
        srcCanvas.height = source.height;
        srcCtx.drawImage(source, 0, 0);
    } else {
        // HTMLImageElement
        srcCanvas.width = source.naturalWidth || source.width;
        srcCanvas.height = source.naturalHeight || source.height;
        srcCtx.drawImage(source, 0, 0);
    }

    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    const srcImageData = srcCtx.getImageData(0, 0, srcW, srcH);
    const srcData = srcImageData.data;

    // Calculate output dimensions from corner distances if not provided
    if (!outputWidth || !outputHeight) {
        const widthTop = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
        const widthBottom = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
        const heightLeft = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
        const heightRight = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);

        outputWidth = outputWidth || Math.round(Math.max(widthTop, widthBottom));
        outputHeight = outputHeight || Math.round(Math.max(heightLeft, heightRight));
    }

    // Clamp output dimensions to reasonable bounds
    const MAX_DIM = 2000;
    outputWidth = Math.min(outputWidth, MAX_DIM);
    outputHeight = Math.min(outputHeight, MAX_DIM);

    // Destination corners: a perfect rectangle
    const dstCorners = [
        { x: 0, y: 0 },                          // TL
        { x: outputWidth - 1, y: 0 },             // TR
        { x: outputWidth - 1, y: outputHeight - 1 }, // BR
        { x: 0, y: outputHeight - 1 }             // BL
    ];

    // Compute homography: maps destination → source (inverse mapping)
    // For each output pixel, we find the corresponding source pixel
    const H = computeHomography(dstCorners, corners);

    // Create output canvas
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outputWidth;
    outCanvas.height = outputHeight;
    const outCtx = outCanvas.getContext('2d');
    const outImageData = outCtx.createImageData(outputWidth, outputHeight);
    const outData = outImageData.data;

    // Inverse-map each output pixel to source coordinates
    for (let dy = 0; dy < outputHeight; dy++) {
        for (let dx = 0; dx < outputWidth; dx++) {
            // Apply homography: H maps (dx, dy) → (sx, sy) in source
            const w = H[6] * dx + H[7] * dy + H[8];
            const sx = (H[0] * dx + H[1] * dy + H[2]) / w;
            const sy = (H[3] * dx + H[4] * dy + H[5]) / w;

            const outIdx = (dy * outputWidth + dx) * 4;

            // Bounds check
            if (sx >= 0 && sx < srcW - 1 && sy >= 0 && sy < srcH - 1) {
                const [r, g, b, a] = bilinearSample(srcData, srcW, srcH, sx, sy);
                outData[outIdx] = r;
                outData[outIdx + 1] = g;
                outData[outIdx + 2] = b;
                outData[outIdx + 3] = a;
            }
            // else: leave as transparent black (default)
        }
    }

    outCtx.putImageData(outImageData, 0, 0);
    return outCanvas;
}

/**
 * Convenience: convert a canvas to a JPEG Blob.
 * 
 * @param {HTMLCanvasElement} canvas 
 * @param {number} quality - JPEG quality 0-1 (default 0.75)
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, quality = 0.75) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    });
}

/**
 * Load an image file (File or Blob) into an HTMLImageElement.
 * 
 * @param {File|Blob} file 
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(e);
        };
        img.src = url;
    });
}

/**
 * Scale an image down if it exceeds maxDimension, preserving aspect ratio.
 * Returns a canvas with the (possibly scaled) image.
 * 
 * @param {HTMLImageElement} img 
 * @param {number} maxDimension - Max width or height (default 1200)
 * @returns {HTMLCanvasElement}
 */
export function scaleImage(img, maxDimension = 1200) {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;

    if (w > maxDimension || h > maxDimension) {
        const ratio = Math.min(maxDimension / w, maxDimension / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
}
