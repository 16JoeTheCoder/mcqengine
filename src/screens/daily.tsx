import { useEffect, useState } from 'preact/hooks';
import { createSession, dailyPlan } from '../lib/engine/session';
import { dayDiff } from '../lib/engine/mistakes';
import { bump, dataVersion, href, navigate, toast, useStore } from '../lib/app-state';
import type { Pack, SessionSummary } from '../lib/types';
import { Button, Skeleton } from '../ui/kit';
import { Icon } from '../ui/icons';

export interface DailyRow {
  pack: Pack;
  due: number;
  size: number;
  doneToday: boolean;
}

/** Daily 10 state for each pack that has a mistakes bank. */
export function useDaily(packs: Pack[] | null, sessions: SessionSummary[]): DailyRow[] | null {
  const v = useStore(dataVersion);
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  useEffect(() => {
    if (!packs) return;
    let live = true;
    void Promise.all(
      packs.map(async (pack) => {
        const plan = await dailyPlan(pack);
        const doneToday = sessions.some((s) => s.packId === pack.id && s.type === 'daily' && s.endedAt && dayDiff(s.endedAt, Date.now()) === 0);
        return { pack, ...plan, doneToday };
      }),
    ).then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, [packs, sessions, v]);
  return rows;
}

export async function startDaily(pack: Pack) {
  try {
    const { summary } = await createSession({ pack, type: 'daily', mode: 'practice' });
    bump();
    navigate(href.session(summary.id));
  } catch (e) {
    toast((e as Error).message || 'Could not start Daily 10.');
  }
}

/**
 * Daily 10: the clearest action when questions are due, and calm when none are. `accent` makes the
 * start button the view's one orange point; callers pass it only when nothing else is orange.
 */
export function DailyPanel({ rows, accent }: { rows: DailyRow[] | null; accent: boolean }) {
  if (!rows) return <Skeleton h={120} />;
  const due = rows.filter((r) => r.due > 0).sort((a, b) => b.due - a.due);
  if (!due.length)
    return (
      <section class="jy-panel daily daily--calm" aria-labelledby="daily-h">
        <div class="row">
          <span class="jy-badge jy-badge--ok">{rows.some((r) => r.doneToday) ? 'Done for today' : 'Nothing due'}</span>
        </div>
        <h2 id="daily-h" class="h3">Daily 10</h2>
        <p class="small muted">
          {rows.some((r) => r.doneToday)
            ? 'Today’s review is finished. Mistakes come back 1, 3, 7 and 14 days after you last saw them.'
            : 'No mistakes are due today. Wrong or unsure answers come back here 1, 3, 7 and 14 days after you last saw them.'}
        </p>
      </section>
    );
  return (
    <section class="jy-panel daily" aria-labelledby="daily-h">
      <span class="label">Daily 10 · ten minutes</span>
      <h2 id="daily-h" class="daily-title">
        <span class="num">{due.reduce((a, r) => a + r.due, 0)}</span> <span class="light">mistake{due.reduce((a, r) => a + r.due, 0) === 1 ? '' : 's'} due today</span>
      </h2>
      <div class="stack-s">
        {due.map((r, i) => (
          <div class="row daily-row" key={r.pack.id}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{r.pack.title}</b> <span class="small muted">· {r.size} of {r.due} fit in ten minutes</span>
            </span>
            <Button variant={accent && i === 0 ? 'accent' : 'primary'} onClick={() => void startDaily(r.pack)}>
              <Icon name="play" size={16} /> Start Daily 10
            </Button>
          </div>
        ))}
      </div>
      <p class="small subtle">Instant feedback. Two sure, correct answers in a row clear a mistake, even on the same day.</p>
    </section>
  );
}
