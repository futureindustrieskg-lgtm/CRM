import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorText, fmtMoney } from '../ui';

interface Summary {
  funnel: { stageId: string; name: string; color: string; count: number }[];
  newLeadsToday: number;
  newLeadsMonth: number;
  conversionMonth: number;
  activeStudents: number;
  debtors: number;
  overdueTasks: number;
  revenueMonth: number | null;
}

export function DashboardPage() {
  const { t } = useI18n();
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Summary>('/dashboard') });
  const d = q.data;
  const max = Math.max(1, ...(d?.funnel.map((f) => f.count) ?? [1]));

  return (
    <>
      <h1>
        {t('dashboard')} · {me?.firstName}
      </h1>
      <ErrorText error={q.error} />
      {d && (
        <>
          <div className="stats">
            {can('leads.read') && (
              <>
                <Stat label={t('newLeadsToday')} value={d.newLeadsToday} />
                <Stat label={t('newLeadsMonth')} value={d.newLeadsMonth} />
                <Stat label={t('conversion')} value={`${d.conversionMonth}%`} />
              </>
            )}
            {can('students.read') && (
              <>
                <Stat label={t('activeStudents')} value={d.activeStudents} />
                <Stat label={t('debtors')} value={d.debtors} danger={d.debtors > 0} />
              </>
            )}
            {d.revenueMonth !== null && <Stat label={t('revenueMonth')} value={fmtMoney(d.revenueMonth)} />}
            <Stat label={t('overdueTasks')} value={d.overdueTasks} danger={d.overdueTasks > 0} />
          </div>
          {can('leads.read') && (
            <div className="card">
              <h2>{t('funnel')}</h2>
              {d.funnel.map((f) => (
                <div key={f.stageId} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
                  <div style={{ width: 170, flexShrink: 0 }} className="muted">
                    {f.name}
                  </div>
                  <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 6, height: 22 }}>
                    <div
                      style={{
                        width: `${(f.count / max) * 100}%`,
                        minWidth: f.count ? 4 : 0,
                        background: f.color,
                        height: '100%',
                        borderRadius: 6,
                      }}
                    />
                  </div>
                  <div style={{ width: 32, textAlign: 'right', fontWeight: 600 }}>{f.count}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="card stat">
      <div className={`v ${danger ? 'neg' : ''}`}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}
