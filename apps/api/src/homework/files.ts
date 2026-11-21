import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join, resolve } from 'path';
import { Ctx, Public, RequestContext } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

export const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads'));
mkdirSync(UPLOAD_DIR, { recursive: true });

export const MAX_FILE_MB = 20;
/** Разрешённые типы: фото тетради, документы, аудио (ответы Sprechen, аудирование). */
const ALLOWED = [
  /^image\/(jpeg|png|webp|heic|heif|gif)$/,
  /^audio\//,
  /^application\/pdf$/,
  /^application\/msword$/,
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
  /^text\/plain$/,
];

/** Роли «клиентов»: им доступны только свои файлы и файлы своих заданий. */
const CLIENT_ROLES = ['student', 'parent'];

@Injectable()
export class FilesService {
  constructor(private prisma: PrismaService) {}

  /** Привязать загруженные пользователем файлы к объекту (ДЗ, сдаче, вопросу теста). */
  async attach(
    ownerId: string,
    fileIds: string[] | undefined,
    target: { homeworkId?: string; submissionId?: string; questionId?: string; isFeedback?: boolean },
    staff = false,
  ) {
    if (!fileIds?.length) return;
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: fileIds } } });
    if (files.length !== fileIds.length) throw new BadRequestException('Файл не найден');
    if (files.some((f) => (!staff && f.ownerId !== ownerId) || f.homeworkId || f.submissionId || (f.questionId && f.questionId !== target.questionId))) {
      throw new BadRequestException('Файл уже прикреплён или загружен другим пользователем');
    }
    await this.prisma.storedFile.updateMany({ where: { id: { in: fileIds } }, data: target });
  }

  async canRead(ctx: RequestContext, id: string) {
    const f = await this.prisma.storedFile.findUnique({
      where: { id },
      include: {
        homework: { select: { groupId: true, studentId: true } },
        submission: { select: { student: { select: { userId: true } } } },
      },
    });
    if (!f) throw new NotFoundException('Файл не найден');
    if (!CLIENT_ROLES.includes(ctx.roleCode) || f.ownerId === ctx.userId) return f;
    if (f.submission?.student.userId === ctx.userId) return f;
    if (f.homework) {
      const student = await this.prisma.student.findFirst({ where: { userId: ctx.userId } });
      const member =
        student &&
        (!f.homework.studentId || f.homework.studentId === student.id) &&
        (await this.prisma.groupStudent.findFirst({ where: { groupId: f.homework.groupId, studentId: student.id, leftAt: null } }));
      if (member) return f;
    }
    throw new ForbiddenException('Нет доступа к файлу');
  }
}

function send(res: Response, f: { path: string; mime: string; name: string }) {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(join(UPLOAD_DIR, f.path));
}

@ApiTags('files')
@ApiBearerAuth()
@Controller()
export class FilesController {
  constructor(private prisma: PrismaService, private files: FilesService) {}

  /** Загрузка файла (до 20 МБ): фото, PDF, Word, аудио. Возвращает id для прикрепления. */
  @Post('files')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
      }),
      limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) =>
        ALLOWED.some((re) => re.test(file.mimetype))
          ? cb(null, true)
          : cb(new BadRequestException(`Недопустимый тип файла: ${file.mimetype}`), false),
    }),
  )
  async upload(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Файл не передан');
    // Имя из multipart приходит в latin1 — восстанавливаем UTF-8 (кириллица в названиях).
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
    return this.prisma.storedFile.create({
      data: { ownerId: ctx.userId, name, mime: file.mimetype, size: file.size, path: file.filename },
      select: { id: true, name: true, mime: true, size: true },
    });
  }

  @Get('files/:id')
  async download(@Ctx() ctx: RequestContext, @Param('id') id: string, @Res() res: Response) {
    send(res, await this.files.canRead(ctx, id));
  }

  /** Медиа вопроса теста для прохождения по ссылке: доступ по токену попытки. */
  @Public()
  @Get('public/files/:id')
  async publicFile(@Param('id') id: string, @Query('a') token: string, @Res() res: Response) {
    const f = await this.prisma.storedFile.findUnique({ where: { id }, include: { question: { select: { testId: true } } } });
    const attempt = token ? await this.prisma.testAttempt.findUnique({ where: { token } }) : null;
    if (!f?.question || !attempt || attempt.testId !== f.question.testId) throw new NotFoundException('Файл не найден');
    send(res, f);
  }
}
