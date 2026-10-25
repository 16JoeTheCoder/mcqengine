import sansUrl from '../../assets/fonts/space-grotesk-latin-wght-normal.woff2?url';
import monoUrl from '../../assets/fonts/jetbrains-mono-latin-500-normal.woff2?url';

/** @font-face rules with the app's fonts inlined, so exported images look the same offline. */
export async function embeddedFontCss(): Promise<string> {
  const embed = async (url: string, family: string, weight: string) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');font-weight:${weight}}`;
  };
  try {
    return (await Promise.all([embed(sansUrl, 'Space Grotesk', '300 700'), embed(monoUrl, 'JetBrains Mono', '500')])).join('');
  } catch {
    return '';
  }
}

/** Draws an SVG string to a PNG of the given pixel size. */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
