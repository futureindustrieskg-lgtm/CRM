import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  teacherId?: string | null;
  roomId?: string | null;
  /** Активные студенты, которые будут на занятии. */
  studentIds: string[];
}

export interface Conflict {
  type: 'teacher' | 'room' | 'student';
  /** Начало проверяемого занятия. */
  at: Date;
  lessonId: string;
  groupId: string;
  groupName: string;
  startsAt: Date;
  endsAt: Date;
  /** Кто занят: преподаватель, кабинет или студенты. */
  detail: string;
}

/** Контроль конфликтов расписания (ТЗ 3.3): преподаватель, кабинет или студент заняты в это время. */
@Injectable()
export class ConflictService {
  constructor(private prisma: PrismaService) {}

  async find(slots: Slot[], excludeLessonIds: string[] = []): Promise<Conflict[]> {
    if (!slots.length) return [];
    const teacherIds = [...new Set(slots.map((s) => s.teacherId).filter(Boolean))] as string[];
    const roomIds = [...new Set(slots.map((s) => s.roomId).filter(Boolean))] as string[];
    const studentIds = [...new Set(slots.flatMap((s) => s.studentIds))];

    // Онлайн-«кабинет» вмещает несколько занятий одновременно.
    const physicalRooms = roomIds.length
      ? (await this.prisma.room.findMany({ where: { id: { in: roomIds }, isOnline: false }, select: { id: true } })).map(
          (r) => r.id,
        )
      : [];

    const or = [
      ...(teacherIds.length ? [{ teacherId: { in: teacherIds } }] : []),
      ...(physicalRooms.length ? [{ roomId: { in: physicalRooms } }] : []),
      ...(studentIds.length
        ? [{ group: { students: { some: { studentId: { in: studentIds }, leftAt: null, waitlist: false } } } }]
        : []),
    ];
    if (!or.length) return [];

    const min = new Date(Math.min(...slots.map((s) => s.startsAt.getTime())));
    const max = new Date(Math.max(...slots.map((s) => s.endsAt.getTime())));
    const busy = await this.prisma.lesson.findMany({
      where: {
        status: { not: 'cancelled' },
        id: excludeLessonIds.length ? { notIn: excludeLessonIds } : undefined,
        startsAt: { lt: max },
        endsAt: { gt: min },
        OR: or,
      },
      include: {
        teacher: { select: { firstName: true, lastName: true } },
        room: { select: { name: true } },
        group: {
          select: {
            id: true,
            name: true,
            students: {
              where: { studentId: { in: studentIds }, leftAt: null, waitlist: false },
              select: { student: { select: { id: true, firstName: true, lastName: true } } },
            },
          },
        },
      },
      orderBy: { startsAt: 'asc' },
    });

    const out: Conflict[] = [];
    for (const s of slots) {
      for (const l of busy) {
        if (!(l.startsAt < s.endsAt && l.endsAt > s.startsAt)) continue;
        const base = { at: s.startsAt, lessonId: l.id, groupId: l.group.id, groupName: l.group.name, startsAt: l.startsAt, endsAt: l.endsAt };
        if (s.teacherId && l.teacherId === s.teacherId) {
          out.push({ ...base, type: 'teacher', detail: `${l.teacher?.firstName ?? ''} ${l.teacher?.lastName ?? ''}`.trim() });
        }
        if (s.roomId && l.roomId === s.roomId && physicalRooms.includes(s.roomId)) {
          out.push({ ...base, type: 'room', detail: l.room?.name ?? '' });
        }
        const clash = l.group.students.filter((gs) => s.studentIds.includes(gs.student.id));
        if (clash.length) {
          out.push({
            ...base,
            type: 'student',
            detail: clash.map((gs) => `${gs.student.firstName} ${gs.student.lastName}`).join(', '),
          });
        }
      }
    }
    return out;
  }
}
