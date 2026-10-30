import { useEffect, useState } from 'preact/hooks';
import * as store from '../lib/data/db';
import { downloadBlob } from '../lib/data/files';
import { cardData, cardSvg, type CardData } from '../lib/share/card';
import { toast } from '../lib/app-state';
import { Button, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';
import lockup from '../../brand/tab-lockup-light.svg?raw';
import { embeddedFontCss, svgToPng } from '../lib/share/fonts';

export function ShareCardDialog({ packId, exam, onClose }: { packId: string; exam: string; onClose: () => void }) {
  const [data, setData] = useState<CardData | null | 'none'>(null);
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    let url = '';
    void (async () => {
      const c = cardData(exam, await store.getSessions(packId));
      if (!c) return setData('none');
      setData(c);
      const blob = await svgToPng(cardSvg(c, lockup, await embeddedFontCss()), 2400, 1350);
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
