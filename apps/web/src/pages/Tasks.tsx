import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorText, fmtDate, fmtPhone } from '../ui';

interface Task {
  id: string;
  title: string;
  dueAt: string;
  doneAt: string | null;
  lead: { id: string; firstName: string; lastName: string | null; phone: string | null } | null;
  assignee: { firstName: string; lastName: string };
}

export function TasksPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [done, setDone] = useState(false);
  const tasks = useQuery({
    queryKey: ['tasks', all, done],
    queryFn: () => api<Task[]>(`/tasks${qs({ all: all ? '1' : undefined, done: done ? '1' : undefined })}`),
  });
  const toggle = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}/done`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('tasks')}</h1>
        {can('leads.read_all') && (
          <div className="seg">
            <button className={!all ? 'on' : ''} onClick={() => setAll(false)}>
              Мои
            </button>
            <button className={all ? 'on' : ''} onClick={() => setAll(true)}>
              Все
            </button>
          </div>
        )}
        <div className="seg">
          <button className={!done ? 'on' : ''} onClick={() => setDone(false)}>
            Открытые
          </button>
          <button className={done ? 'on' : ''} onClick={() => setDone(true)}>
            {t('done')}
          </button>
        </div>
      </div>
      <ErrorText error={tasks.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>Задача</th>
              <th>Клиент</th>
              <th>{t('phone')}</th>
              {all && <th>Исполнитель</th>}
              <th>{t('dueAt')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data?.map((tk) => {
              const overdue = !tk.doneAt && new Date(tk.dueAt) < new Date();
              return (
                <tr key={tk.id}>
                  <td style={{ width: 30 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={!!tk.doneAt} onChange={() => toggle.mutate(tk.id)} />
                  </td>
                  <td>{tk.title}</td>
                  <td>
                    {tk.lead ? (
                      <Link to={`/leads/${tk.lead.id}`}>
                        {tk.lead.firstName} {tk.lead.lastName}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{tk.lead?.phone ? <a href={`tel:+${tk.lead.phone}`}>{fmtPhone(tk.lead.phone)}</a> : '—'}</td>
                  {all && (
                    <td>
                      {tk.assignee.firstName} {tk.assignee.lastName}
                    </td>
                  )}
                  <td className={overdue ? 'neg' : 'muted'}>
                    {fmtDate(tk.dueAt)} {overdue && `· ${t('overdue')}`}
                  </td>
                </tr>
              );
            })}
            {tasks.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
