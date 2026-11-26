/**
 * Перенос данных для пилота: студенты и лиды из Excel / CSV.
 * Шаги: файл → сопоставление колонок → проверка (без записи) → импорт → отчёт с причинами пропусков.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, openFile, uploadTo } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorText, Field } from '../ui';
import { useBranches } from './Leads';

type Entity = 'students' | 'leads';
interface Sheet {
  name: string;
  headers: string[];
  rows: string[][];
  truncated: boolean;
  mapping: Record<Entity, Record<string, number>>;
}
interface RunResult {
  total: number;
  ok: number;
  duplicates: number;
  errors: number;
  dryRun: boolean;
  results: { row: number; status: 'ok' | 'duplicate' | 'error'; message?: string }[];
}

const REQUIRED: Record<Entity, string[][]> = {
  // Достаточно одного из вариантов: ФИО или фамилия + имя.
  students: [['fullName'], ['lastName', 'firstName']],
  leads: [['fullName'], ['firstName']],
};

export function ImportPage() {
  const { t } = useI18n();
  const { can, activeRole } = useAuth();
  const branches = useBranches();
  const fields = useQuery({ queryKey: ['import-fields'], queryFn: () => api<Record<Entity, string[]>>('/import/fields') });
  const [entity, setEntity] = useState<Entity>(can('students.create') ? 'students' : 'leads');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [branchId, setBranchId] = useState('');
  const [check, setCheck] = useState<RunResult | null>(null);
  const [done, setDone] = useState<RunResult | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const sheet = sheets?.[sheetIdx];
  const parse = useMutation({
    mutationFn: (f: File) => uploadTo<Sheet[]>('/import/parse', f, f.name),
    onSuccess: (s) => {
      setSheets(s);
      setSheetIdx(0);
      setMapping(s[0]?.mapping[entity] ?? {});
      setCheck(null);
      setDone(null);
    },
  });

  // Строки файла → объекты { поле CRM: значение } по сопоставлению.
  const rows = useMemo(
    () => (sheet ? sheet.rows.map((r) => Object.fromEntries(Object.entries(mapping).map(([field, col]) => [field, r[col] ?? '']))) : []),
    [sheet, mapping],
  );
  const mappedOk = REQUIRED[entity].some((set) => set.every((f) => f in mapping));
  const needBranch = !activeRole?.branchId;

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api<RunResult>(`/import/${entity}`, { method: 'POST', body: { rows, dryRun, branchId: branchId || undefined } }),
    onSuccess: (r) => (r.dryRun ? setCheck(r) : setDone(r)),
  });

  const changeEntity = (e: Entity) => {
    setEntity(e);
    setMapping(sheet?.mapping[e] ?? {});
    setCheck(null);
    setDone(null);
  };
  const setField = (field: string, col: string) => {
    const next = { ...mapping };
    if (col === '') delete next[field];
    else next[field] = Number(col);
    setMapping(next);
    setCheck(null);
  };
  const report = (r: RunResult) => r.results.filter((x) => x.status !== 'ok');
  const downloadReport = (r: RunResult) => {
    const lines = [['Строка', 'Результат', 'Причина'], ...report(r).map((x) => [String(x.row), t(`imp.${x.status}`), x.message ?? ''])];
    const csv = '﻿' + lines.map((l) => l.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'Отчёт импорта.csv';
    a.click();
  };

  return (
    <>
      <h1>{t('importTitle')}</h1>
      <p className="muted">{t('importHint')}</p>

      <div className="card" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label={t('importWhat')}>
            <div className="seg">
              {(['students', 'leads'] as Entity[])
                .filter((e) => can(e === 'students' ? 'students.create' : 'leads.create'))
                .map((e) => (
                  <button key={e} type="button" className={entity === e ? 'on' : ''} onClick={() => changeEntity(e)}>
                    {t(e)}
                  </button>
                ))}
            </div>
          </Field>
          <button type="button" onClick={() => openFile(`/import/template/${entity}`, entity === 'students' ? 'Шаблон студенты.xlsx' : 'Шаблон лиды.xlsx').catch(setErr)}>
            ⬇ {t('importTemplate')}
          </button>
        </div>
        <Field label={t('importFile')}>
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parse.mutate(f);
              e.target.value = '';
            }}
          />
        </Field>
        {parse.isPending && <div className="muted">{t('loading')}</div>}
        <ErrorText error={parse.error ?? err} />
      </div>

      {sheet && (
        <div className="card" style={{ maxWidth: 900 }}>
          <div className="row">
            {sheets!.length > 1 && (
              <Field label={t('importSheet')}>
                <select
                  value={sheetIdx}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    setSheetIdx(i);
                    setMapping(sheets![i].mapping[entity]);
                    setCheck(null);
                  }}
                >
                  {sheets!.map((s, i) => (
                    <option key={i} value={i}>
                      {s.name} ({s.rows.length})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {needBranch && (
              <Field label={t('branch') + ' *'}>
                <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">—</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <p className="muted">
            {t('importRows')}: {sheet.rows.length}
            {sheet.truncated && ` · ${t('importTruncated')}`}
          </p>

          <h3>{t('importMapping')}</h3>
          <div className="grid2">
            {fields.data?.[entity].map((f) => (
              <Field key={f} label={t(`imp.f.${f}`)}>
                <select value={mapping[f] ?? ''} onChange={(e) => setField(f, e.target.value)}>
                  <option value="">— {t('importSkip')} —</option>
                  {sheet.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          {!mappedOk && <div className="error">{t(entity === 'students' ? 'importNeedNames' : 'importNeedName')}</div>}

          <h3>{t('importPreview')}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {Object.keys(mapping).map((f) => (
                    <th key={f}>{t(`imp.f.${f}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {Object.keys(mapping).map((f) => (
                      <td key={f}>{r[f]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ErrorText error={run.error} />
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" disabled={!mappedOk || run.isPending || (needBranch && !branchId)} onClick={() => run.mutate(true)}>
              {t('importCheck')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!check || !check.ok || run.isPending || !!done}
              onClick={() => {
                if (window.confirm(t('importConfirm').replace('{n}', String(check!.ok)))) run.mutate(false);
              }}
            >
              {t('importRun')} {check ? `(${check.ok})` : ''}
            </button>
          </div>
        </div>
      )}

      {(done ?? check) && (
        <ResultCard r={(done ?? check)!} onDownload={downloadReport} />
      )}
    </>
  );
}

function ResultCard({ r, onDownload }: { r: RunResult; onDownload: (r: RunResult) => void }) {
  const { t } = useI18n();
  const bad = r.results.filter((x) => x.status !== 'ok');
  return (
    <div className="card" style={{ maxWidth: 900 }}>
      <h3>{r.dryRun ? t('importChecked') : t('importDone')}</h3>
      <div className="row">
        <span className="badge">
          {r.dryRun ? t('importWillCreate') : t('importCreated')}: {r.ok}
        </span>
        <span className="badge">
          {t('imp.duplicate')}: {r.duplicates}
        </span>
        <span className="badge">
          {t('imp.error')}: {r.errors}
        </span>
        {bad.length > 0 && (
          <button type="button" className="small" onClick={() => onDownload(r)}>
            ⬇ {t('importReport')}
          </button>
        )}
      </div>
      {bad.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto', marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>{t('importRow')}</th>
                <th>{t('status')}</th>
                <th>{t('importReason')}</th>
              </tr>
            </thead>
            <tbody>
              {bad.slice(0, 300).map((x) => (
                <tr key={x.row}>
                  <td>{x.row}</td>
                  <td>{t(`imp.${x.status}`)}</td>
                  <td>{x.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
