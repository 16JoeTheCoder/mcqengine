import { useEffect, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { downloadBlob } from '../lib/data/files';
import { cardData, cardSvg, type CardData } from '../lib/share/card';
import { toast } from '../lib/app-state';
import { Button, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';
import lockup from '../../brand/tab-lockup-light.svg?raw';
import sansUrl from '../assets/fonts/space-grotesk-latin-wght-normal.woff2?url';
import monoUrl from '../assets/fonts/jetbrains-mono-latin-500-normal.woff2?url';

async function fontCss(): Promise<string> {
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

/** Renders the card SVG to a 2x PNG. Fonts are embedded so the image matches the app offline. */
async function toPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1350;
    canvas.getContext('2d')!.drawImage(img, 0, 0, 2400, 1350);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ShareCardDialog({ packId, exam, onClose }: { packId: string; exam: string; onClose: () => void }) {
  const [data, setData] = useState<CardData | null | 'none'>(null);
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    let url = '';
    void (async () => {
      const c = cardData(exam, await store.getSessions(packId));
      if (!c) return setData('none');
      setData(c);
      const blob = await toPng(cardSvg(c, lockup, await fontCss()));
      url = URL.createObjectURL(blob);
      setPng({ blob, url });
    })().catch(() => toast('Could not draw the card.'));
    return () => url && URL.revokeObjectURL(url);
  }, [packId, exam]);

  const name = `dmc-${exam.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.png`;
  const share = async () => {
    if (!png) return;
    const file = new File([png.blob], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My DMC results' });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    downloadBlob(png.blob, name);
    toast(`Saved ${name}.`);
  };

  return (
    <Modal title="Result card" size="wide" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={() => void share()} disabled={!png}><Icon name="download" size={18} /> {typeof navigator.share === 'function' ? 'Share' : 'Download'}</Button>
      </>
    }>
      {data === 'none' ? (
        <p class="muted">The card needs three complete exam sessions (full papers or random). Partial sessions never count.</p>
      ) : png ? (
        <img class="share-preview" src={png.url} alt={data ? `Result card: ${Math.round(data.avg * 100)}% average over the last three exam sessions of ${exam}` : 'Result card'} />
      ) : (
        <div class="skel" style={{ aspectRatio: '16 / 9' }} aria-busy="true" />
      )}
      <p class="small subtle" style={{ marginTop: 'var(--space-3)' }}>Average of your last three complete exam sessions, with their marks, range and time. Made on this device; nothing is uploaded.</p>
    </Modal>
  );
}
