import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { EnumSelect, ErrorText, Field, fmtMoney, Modal } from '../ui';
import { useBranches } from './Leads';

export const COURSE_LEVELS = ['A1', 'A1.1', 'A1.2', 'A2', 'A2.1', 'A2.2', 'B1', 'B1.1', 'B1.2', 'B2', 'B2.1', 'B2.2', 'C1', 'C2'];
export const COURSE_FORMATS = ['group', 'individual', 'mini_group', 'online'];

export interface Course {
  id: string;
  name: string;
  level: string;
  format: string;
  academicHours: number;
  textbook: string | null;
  price: string;
  isActive: boolean;
  _count?: { groups: number };
}

export interface Room {
  id: string;
  name: string;
  capacity: number;
  isOnline: boolean;
  branchId: string;
  branch?: { id: string; name: string };
}

export const useCourses = (all = false) =>
  useQuery({ queryKey: ['courses', all], queryFn: () => api<Course[]>(`/courses${all ? '?all=1' : ''}`) });

export const useRooms = (branchId?: string) =>
  useQuery({ queryKey: ['rooms', branchId], queryFn: () => api<Room[]>(`/rooms${qs({ branchId })}`) });

// ───────────── Курсы ─────────────

export function CoursesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const courses = useCourses(true);
  const [edit, setEdit] = useState<Partial<Course> | null>(null);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('courses')}</h1>
        {can('groups.create') && (
          <button className="primary" onClick={() => setEdit({ format: 'group', level: 'A1.1', academicHours: 48, isActive: true })}>
            + {t('newCourse')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('level')}</th>
              <th>{t('format')}</th>
              <th>{t('academicHours')}</th>
              <th>{t('textbook')}</th>
              <th>{t('price')}</th>
              <th>{t('groups')}</th>
            </tr>
          </thead>
          <tbody>
            {courses.data?.map((c) => (
              <tr key={c.id} className="click" onClick={() => can('groups.update') && setEdit(c)}>
                <td>
                  {c.name} {!c.isActive && <span className="badge">{t('inactive')}</span>}
                </td>
                <td>{c.level}</td>
                <td>{t(`fmt.${c.format}`)}</td>
                <td>{c.academicHours}</td>
                <td>{c.textbook ?? '—'}</td>
                <td>{fmtMoney(c.price)}</td>
                <td>{c._count?.groups ?? 0}</td>
              </tr>
            ))}
            {courses.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {edit && <CourseModal course={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function CourseModal({ course, onClose }: { course: Partial<Course>; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: course.name ?? '',
    level: course.level ?? 'A1.1',
    format: course.format ?? 'group',
    academicHours: course.academicHours ?? 48,
    textbook: course.textbook ?? '',
    price: course.price ? Number(course.price) : 0,
    isActive: course.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () =>
      api(course.id ? `/courses/${course.id}` : '/courses', {
        method: course.id ? 'PATCH' : 'POST',
        body: { ...f, textbook: f.textbook || undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['courses'] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Modal title={course.id ? course.name! : t('newCourse')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('name')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label={t('level')}>
            <EnumSelect value={f.level} onChange={(v) => setF({ ...f, level: v! })} options={COURSE_LEVELS} empty={false} />
          </Field>
          <Field label={t('format')}>
            <EnumSelect value={f.format} onChange={(v) => setF({ ...f, format: v! })} options={COURSE_FORMATS} prefix="fmt" empty={false} />
          </Field>
          <Field label={t('academicHours')}>
            <input type="number" min={1} required value={f.academicHours} onChange={(e) => setF({ ...f, academicHours: Number(e.target.value) })} />
          </Field>
          <Field label={`${t('price')}, сом`}>
            <input type="number" min={0} required value={f.price} onChange={(e) => setF({ ...f, price: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label={t('textbook')}>
          <input value={f.textbook} onChange={(e) => setF({ ...f, textbook: e.target.value })} />
        </Field>
        <label className="row" style={{ color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          {t('active')}
        </label>
        <ErrorText error={save.error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={save.isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────── Кабинеты ─────────────

export function RoomsPage() {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const branches = useBranches();
  const [branchId, setBranchId] = useState<string>();
  const rooms = useRooms(branchId);
  const [edit, setEdit] = useState<Partial<Room> | null>(null);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('rooms')}</h1>
        {!activeRole?.branchId && (
          <select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value || undefined)}>
            <option value="">{t('allBranches')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <button className="primary" onClick={() => setEdit({ capacity: 10, isOnline: false, branchId: branchId ?? activeRole?.branchId ?? branches.data?.[0]?.id })}>
          + {t('newRoom')}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('branch')}</th>
              <th>{t('capacity')}</th>
              <th>{t('online')}</th>
            </tr>
          </thead>
          <tbody>
            {rooms.data?.map((r) => (
              <tr key={r.id} className="click" onClick={() => setEdit(r)}>
                <td>{r.name}</td>
                <td>{r.branch?.name}</td>
                <td>{r.capacity}</td>
                <td>{r.isOnline ? t('yes') : t('no')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <RoomModal room={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function RoomModal({ room, onClose }: { room: Partial<Room>; onClose: () => void }) {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const branches = useBranches();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: room.name ?? '',
    capacity: room.capacity ?? 10,
    isOnline: room.isOnline ?? false,
    branchId: room.branchId ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      room.id
        ? api(`/rooms/${room.id}`, { method: 'PATCH', body: { name: f.name, capacity: f.capacity, isOnline: f.isOnline } })
        : api('/rooms', { method: 'POST', body: f }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rooms'] });
      onClose();
    },
  });
  return (
    <Modal title={room.id ? room.name! : t('newRoom')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('name')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {!room.id && !activeRole?.branchId && (
          <Field label={t('branch')}>
            <select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('capacity')}>
          <input type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} />
        </Field>
        <label className="row" style={{ color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.isOnline} onChange={(e) => setF({ ...f, isOnline: e.target.checked })} />
          {t('online')}
        </label>
        <ErrorText error={save.error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={save.isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
